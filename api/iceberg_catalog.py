"""Foundry Iceberg tables (Palantir's "Iceberg tables" docs): the catalog behind the Iceberg REST catalog
(iceberg_rest.py), the Iceberg pages of Dataset Preview, Control Panel and the Iceberg app (iceberg_tables.py),
maintenance (iceberg_maintenance.py) and `transforms.tables` in Python transforms (code_tables.py).

A managed Iceberg table is a Files item (kind file, content type ICEBERG) whose contents are a small descriptor;
the table itself is Iceberg metadata and data files at the table's storage location:
- Foundry-managed storage: data/iceberg/warehouse/<item id>/ (metadata/ and data/);
- bring-your-own-bucket (BYOB) storage locations configured in Control Panel (a local directory, or an s3:// /
  abfss:// / gs:// URI with its FileIO properties), base path `foundry-iceberg` unless the URI has one.
The table's pointer to its current metadata file, and its Foundry settings, are in data/iceberg/tables/<id>.json.
Its RID is `ri.tables.main.table.<item id>`. Namespaces are Files paths: `Project.Folder` is /Project/Folder.

Foundry behaviour on top of the Iceberg REST catalog spec:
- branch isolation: with a branch (a Foundry build on a branch, or the X-PLTR-Branch header) reads and writes are
  scoped to that branch; its current schema, default partition spec and sort order live in the table properties
  `foundry.branch.<branch>.{schema-id,spec-id,sort-order-id}` and leave `main` unchanged. Iceberg's `main` is
  Foundry's `master`. A branch without its own snapshot reads main (as Foundry branches fall back).
- all-or-nothing jobs: a build's commits are staged (the job sees its own writes, others do not) and swapped in
  together when the job succeeds; inputs are pinned to the metadata they had when the job first read them
  (repeatable reads, multi-table snapshot isolation). A table changed by someone else meanwhile (a compaction)
  fails the commit, and the build retries.
- table properties: Foundry defaults (30-day snapshot age, one previous metadata version, object storage paths)
  and properties users cannot edit (foundry.*, encryption.*, write paths...); format version 2, or 3 with
  client-side encryption; unsupported column types (time, nanosecond timestamps, geo, variant) are refused.
- snapshots carry who wrote them (foundry.user), the job (foundry.job) and the markings the job's inputs had
  (foundry.markings): a table's inherited markings are those of every retained snapshot until it is expired. A
  snapshot that keeps or rewrites its parent's rows (append, delete, replace / compaction, an overwrite leaving some
  of the parent's files) also records its parent's markings, so expiring the marked snapshot does not unmark rows
  still in the table; only a full replacement does not depend on its parent. A commit's markings are added to the
  table before the new metadata becomes visible, and the table is narrowed to its snapshots' markings after.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import HTTPException

import auth
import db
import drive
import iceberg_eqdeletes
import iceberg_write

# equality delete files are read (planned and applied) by every PyIceberg scan in this process
iceberg_eqdeletes.hook()

log = logging.getLogger("bluesandai.iceberg")

ICEBERG = "application/vnd.apache.iceberg+json"
RID_PREFIX = "ri.tables.main.table."
RID_NAMESPACE = ("ri", "tables", "main", "table")
MAIN = "main"
DIR: Path = Path()
_lock = threading.RLock()
_table_locks: dict[str, threading.RLock] = {}

# properties Foundry sets on new tables (they win over the Iceberg spec's defaults)
DEFAULT_PROPERTIES = {
    "history.expire.max-snapshot-age-ms": "2592000000",
    "write.metadata.delete-after-commit.enabled": "false",
    "write.metadata.previous-versions-max": "1",
    "write.object-storage.enabled": "true",
    "write.object-storage.partitioned-paths": "false",
}
# properties users cannot set or remove (prefixes end with a dot)
LOCKED_PROPERTIES = (
    "foundry.branch.", "foundry.rid", "foundry.table-version", "encryption.", "write.metadata.delete-after-commit.enabled",
    "write.object-storage.enabled", "write.object-storage.partitioned-paths", "write.data.path", "write.folder-storage.path",
    "write.location-provider.impl", "write.metadata.path", "write.object-storage.path",
)
# column types Foundry does not support, per format version
UNSUPPORTED_TYPES = {2: ("time",), 3: ("geography", "geometry", "time", "timestamp_ns", "timestamptz_ns", "unknown", "variant")}
SNAPSHOT_TO_TRANSACTION = {"append": ["APPEND"], "overwrite": ["UPDATE", "SNAPSHOT"], "delete": ["DELETE"], "replace": []}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "iceberg"
    for sub in ("tables", "warehouse"):
        (DIR / sub).mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _write(path: Path, data: Any) -> None:
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), "utf-8")
    for attempt in range(100):
        try:
            tmp.replace(path)
            return
        except PermissionError:  # Windows: a reader has the file open right now; it closes it at once
            if attempt == 99:
                with contextlib.suppress(OSError):
                    tmp.unlink()
                raise
            time.sleep(0.01)


class CatalogError(Exception):
    """An Iceberg REST error: (HTTP status, error type, message)."""

    def __init__(self, status: int, kind: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.message = message


def no_table(name: str) -> CatalogError:
    return CatalogError(404, "NoSuchTableException", f"Table does not exist: {name}")


def no_namespace(name: str) -> CatalogError:
    return CatalogError(404, "NoSuchNamespaceException", f"Namespace does not exist: {name}")


def forbidden(message: str) -> CatalogError:
    return CatalogError(403, "ForbiddenException", message)


def bad_request(message: str) -> CatalogError:
    return CatalogError(400, "BadRequestException", message)


def conflict(message: str) -> CatalogError:
    return CatalogError(409, "CommitFailedException", message)


@contextlib.contextmanager
def http_errors() -> Iterator[None]:
    """CatalogErrors as HTTPExceptions (for the routers that are not the REST catalog)."""
    try:
        yield
    except CatalogError as e:
        raise HTTPException(e.status, e.message) from None


# ------------------------------------------------------------------------------------------------
# settings (Control Panel → Iceberg table settings)
# ------------------------------------------------------------------------------------------------

MANAGED = {"id": "managed", "name": "Foundry-managed storage", "provider": "managed"}


def default_settings() -> dict:
    return {
        "enabled": True,
        "allow_all_projects": True,
        "default_storage": "managed",
        "cse": False,
        "buckets": [],
        "overrides": [],
        # Foundry keeps files of expired snapshots and orphan files this long (disaster recovery lookback)
        "dr_lookback_days": 7,
    }


def settings() -> dict:
    return {**default_settings(), **_json(DIR / "settings.json", {})}


def save_settings(s: dict) -> dict:
    with _lock:
        _write(DIR / "settings.json", s)
    return s


def buckets() -> list[dict]:
    return [MANAGED, *settings()["buckets"]]


def bucket(bucket_id: Optional[str]) -> dict:
    return next((b for b in buckets() if b["id"] == bucket_id), MANAGED)


def resolve_storage(folder_id: Optional[str]) -> dict:
    """The Iceberg settings for a new table in a folder: {enabled, storage (bucket), cse, override (or None)} — the
    most specific namespace (folder) or project override, else the enrollment defaults."""
    s = settings()
    chain = [p["id"] for p in db.drive_path(folder_id)] if folder_id else []
    override = None
    for fid in reversed(chain):
        override = next((o for o in s["overrides"] if o.get("target_id") == fid), None)
        if override:
            break
    enabled = bool(s["enabled"]) and (bool(override) or bool(s["allow_all_projects"]))
    storage = (override or {}).get("storage") or s["default_storage"]
    cse = (override or {}).get("cse")
    cse = bool(s["cse"] if cse is None else cse)
    b = bucket(storage)
    if b["provider"] == "gcs" and b["id"] == "managed":
        cse = True
    return {"enabled": enabled, "storage": b, "cse": cse, "override": override}


def _base_uri(b: dict) -> str:
    if b["provider"] == "managed":
        return (DIR / "warehouse").resolve().as_uri()
    uri = (b.get("uri") or "").rstrip("/")
    if b["provider"] == "local":
        p = Path(uri.removeprefix("file://"))
        return p.resolve().as_uri()
    # a bucket URI without a base path gets Foundry's default one
    if re.fullmatch(r"[a-z0-9]+://[^/]+", uri):
        uri += "/foundry-iceberg"
    return uri


def fileio_properties(b: dict) -> dict:
    """FileIO properties of a storage location (credentials are decrypted from the settings)."""
    props = dict(b.get("fileio") or {})
    if b.get("secrets"):
        try:
            import base64

            import secretbox

            props.update(secretbox.unseal(base64.b64decode(b["secrets"])))
        except Exception:  # noqa: BLE001 - unreadable secrets: the location's own access applies
            log.warning("could not read the credentials of Iceberg storage %s", b.get("id"))
    return props


# ------------------------------------------------------------------------------------------------
# tables: Files items + pointer records
# ------------------------------------------------------------------------------------------------


def rid(item_id: str) -> str:
    return RID_PREFIX + item_id


def is_table(item: Optional[dict]) -> bool:
    return bool(item) and item["kind"] == "file" and item.get("content_type") == ICEBERG


def _rec_path(item_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id):
        raise no_table(item_id)
    return DIR / "tables" / f"{item_id}.json"


def record(item_id: str) -> dict:
    rec = _json(_rec_path(item_id), None)
    if rec is None:
        raise no_table(rid(item_id))
    return rec


def save_record(rec: dict) -> None:
    with _lock:
        _write(_rec_path(rec["id"]), rec)


def table_lock(item_id: str) -> threading.RLock:
    with _lock:
        return _table_locks.setdefault(item_id, threading.RLock())


def table_item(item_id: str, need: str = "viewer") -> dict:
    """The table's Files item, checking the caller's markings and Project role."""
    item = db.drive_get(item_id) if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id or "") else None
    if not is_table(item) or item.get("trashed_at"):
        raise no_table(rid(item_id))
    try:
        auth.check_item(item, need)
    except HTTPException as e:
        raise forbidden(str(e.detail)) from None
    return item


def all_tables() -> list[dict]:
    return db.drive_query("d.kind = 'file' AND d.content_type = %s AND d.trashed_at IS NULL", (ICEBERG,), limit=5000)


def _folder_by_names(names: list[str]) -> Optional[dict]:
    parent: Optional[str] = None
    found = None
    for n in names:
        found = next((c for c in db.drive_list(parent) if c["kind"] in ("project", "folder") and c["name"] == n), None)
        if not found:
            return None
        parent = found["id"]
    return found


def namespace_folder(namespace: tuple[str, ...] | list[str]) -> Optional[dict]:
    """The folder a namespace names (None: the root)."""
    ns = [n for n in namespace if n != ""]
    if not ns or list(ns) == ["foundry"]:
        return None
    f = _folder_by_names(list(ns))
    if not f:
        raise no_namespace(".".join(ns))
    return f


def namespace_of(item_id: str) -> list[str]:
    return [p["name"] for p in db.drive_path(item_id)[:-1]]


def resolve(namespace: tuple[str, ...] | list[str], name: str) -> dict:
    """A table by identifier: `ri.tables.main.table.<id>` (as a name, or split into a namespace by dotted
    identifiers), a Files path (`/Project/Folder/table`, as Spark passes back-ticked paths), or namespace + name."""
    ns = [n for n in namespace if n != ""]
    if tuple(ns) == RID_NAMESPACE:
        return table_item(name)
    if name.startswith(RID_PREFIX):
        return table_item(name[len(RID_PREFIX):])
    if name.startswith("/"):
        parts = [p for p in name.split("/") if p]
        if not parts:
            raise no_table(name)
        folder = _folder_by_names(parts[:-1]) if len(parts) > 1 else None
        if len(parts) > 1 and not folder:
            raise no_table(name)
        ns, name = parts[:-1], parts[-1]
    else:
        try:
            folder = namespace_folder(ns)
        except CatalogError:
            # clients look up `table.snapshots` as a table first: a missing namespace is a missing table
            raise no_table(".".join([*ns, name])) from None
    child = next((c for c in db.drive_list(folder["id"] if folder else None) if c["name"] == name and is_table(c)), None)
    if not child:
        raise no_table(".".join([*ns, name]))
    return table_item(child["id"])


# ------------------------------------------------------------------------------------------------
# metadata files
# ------------------------------------------------------------------------------------------------

_md_cache: dict[str, Any] = {}


_windows_paths_patched = False


def _patch_windows_paths() -> None:
    """PyIceberg's PyArrowFileIO reads file:///D:/warehouse/... as the path /D:/warehouse/..., which Windows refuses:
    a file URI with a drive letter becomes the drive path."""
    global _windows_paths_patched
    if _windows_paths_patched or os.name != "nt":
        return
    from pyiceberg.io.pyarrow import PyArrowFileIO

    original = PyArrowFileIO.parse_location

    def parse_location(location: str, properties=None):  # noqa: ANN001, ANN202
        m = re.match(r"^file:/{1,3}([A-Za-z]:[/\\].*)$", location or "")
        if m:
            return "file", "", m.group(1)
        return original(location, properties) if properties is not None else original(location)

    PyArrowFileIO.parse_location = staticmethod(parse_location)
    _windows_paths_patched = True


def file_io(item_id: str, location: Optional[str] = None):
    from pyiceberg.io import load_file_io

    _patch_windows_paths()
    rec = record(item_id)
    return load_file_io(fileio_properties(bucket(rec.get("storage"))), location or rec.get("location"))


def read_metadata(item_id: str, location: str):
    """Table metadata at a location (metadata files never change, so they are cached)."""
    from pyiceberg.serializers import FromInputFile

    hit = _md_cache.get(location)
    if hit is not None:
        return hit
    md = FromInputFile.table_metadata(file_io(item_id, location).new_input(location))
    if len(_md_cache) > 500:
        _md_cache.clear()
    _md_cache[location] = md
    return md


def _metadata_version(location: str) -> int:
    m = re.search(r"/(\d+)-[0-9a-f-]+\.metadata\.json$", location)
    return int(m.group(1)) if m else 0


def _dump(md) -> str:
    """Metadata as JSON (pyiceberg models format version 3 but refuses to serialize it; the base model can)."""
    from pyiceberg.typedef import IcebergBaseModel

    text = IcebergBaseModel.model_dump_json(md)
    if md.format_version >= 3 and getattr(md, "next_row_id", None) is None:
        d = json.loads(text)
        d["next-row-id"] = 0
        text = json.dumps(d)
    return text


def write_metadata(item_id: str, md, previous: Optional[str]) -> str:
    version = _metadata_version(previous) + 1 if previous else 0
    loc = f"{md.location}/metadata/{version:05d}-{uuid.uuid4()}.metadata.json"
    with file_io(item_id, loc).new_output(loc).create(overwrite=True) as f:
        f.write(_dump(md).encode("utf-8"))
    _md_cache[loc] = md
    return loc


# ------------------------------------------------------------------------------------------------
# job transactions (Foundry builds): staged commits, pinned reads
# ------------------------------------------------------------------------------------------------

_jobs: dict[str, dict] = {}


def begin_job(job_id: str, branch: Optional[str] = None, label: str = "", markings: Optional[list[str]] = None,
              producer: Optional[dict] = None, outputs: Optional[list[str]] = None, user_id: Optional[str] = None) -> None:
    """Start a build's transaction. `producer` (the transform writing the outputs) may write to branch-protected
    outputs on main; `markings` are recorded on the snapshots the job writes; only `user_id` (the user the build runs
    as) may stage writes in it over the REST catalog."""
    with _lock:
        _jobs[job_id] = {"id": job_id, "branch": canonical_branch(branch), "label": label, "markings": sorted(markings or []),
                         "producer": producer, "outputs": list(outputs or []), "pinned": {}, "staged": {}, "started_at": _now(),
                         "user_id": user_id}


def job(job_id: Optional[str]) -> Optional[dict]:
    if not job_id:
        return None
    with _lock:
        j = _jobs.get(job_id)
    if j is None:
        raise bad_request(f"unknown or finished job {job_id}")
    p = auth.current()
    if j.get("user_id") and p is not None and not p.get("service") and p.get("id") != j["user_id"]:
        raise forbidden("this job runs as another user")
    return j


def commit_job(job_id: str) -> list[dict]:
    """Swap in every table the job wrote, all or nothing. Returns [{item_id, snapshots: [new snapshot ids]}]."""
    with _lock:
        j = _jobs.get(job_id)
    if j is None:
        return []
    staged = sorted(j["staged"].items())
    locks = [table_lock(tid) for tid, _ in staged]
    for lk in locks:
        lk.acquire()
    try:
        for tid, st in staged:
            cur = record(tid).get("metadata_location")
            if cur != st["base"]:
                raise conflict(f"{rid(tid)} was changed by another writer during the job (for example a maintenance task): "
                               "the job's writes were discarded and it should be retried")
        mds = {tid: read_metadata(tid, st["loc"]) for tid, st in staged}
        for tid, md in mds.items():
            _widen_markings(tid, md)  # every table, before any of the job's rows are visible; _after_commit narrows
        out = []
        for tid, st in staged:
            rec = record(tid)
            before = {s.snapshot_id for s in read_metadata(tid, st["base"]).snapshots} if st["base"] else set()
            md = mds[tid]
            rec["metadata_location"] = st["loc"]
            save_record(rec)
            new = [s.snapshot_id for s in md.snapshots if s.snapshot_id not in before]
            _after_commit(tid, md, {"kind": "job", "label": j["label"], "branch": j["branch"], "snapshots": new})
            out.append({"item_id": tid, "snapshots": new})
        return out
    finally:
        for lk in reversed(locks):
            lk.release()
        with _lock:
            _jobs.pop(job_id, None)


def abort_job(job_id: str) -> None:
    """Discard a job's staged writes (its files stay until orphan file removal)."""
    with _lock:
        _jobs.pop(job_id, None)


# ------------------------------------------------------------------------------------------------
# branches
# ------------------------------------------------------------------------------------------------


def canonical_branch(branch: Optional[str]) -> Optional[str]:
    """Foundry's master is Iceberg's main; None and main mean no branch isolation."""
    if not branch or branch in (MAIN, "master"):
        return None
    return branch


def branch_prop(branch: str, what: str) -> str:
    return f"foundry.branch.{branch}.{what}"


def branch_ids(md, branch: Optional[str]) -> tuple[int, int, int]:
    """(schema id, partition spec id, sort order id) a branch tracks (main's when it tracks none)."""
    if not branch:
        return md.current_schema_id, md.default_spec_id, md.default_sort_order_id
    p = md.properties
    return (int(p.get(branch_prop(branch, "schema-id"), md.current_schema_id)), int(p.get(branch_prop(branch, "spec-id"), md.default_spec_id)),
            int(p.get(branch_prop(branch, "sort-order-id"), md.default_sort_order_id)))


def branch_view(md, branch: Optional[str]):
    """The table as a client on `branch` sees it: the branch is `main` (main itself when the branch has no snapshot
    yet), with the branch's schema, partition spec and sort order."""
    branch = canonical_branch(branch)
    if not branch:
        return md
    refs = dict(md.refs)
    own = refs.get(branch)
    head = own or md.refs.get(MAIN)
    if head is not None:
        refs[MAIN] = head
    else:
        refs.pop(MAIN, None)
    schema_id, spec_id, sort_id = branch_ids(md, branch)
    return md.model_copy(update={"refs": refs, "current_snapshot_id": head.snapshot_id if head else None, "current_schema_id": schema_id,
                                 "default_spec_id": spec_id, "default_sort_order_id": sort_id})


def _schema_id_of(md, schema) -> int:
    for s in md.schemas:
        if s.fields == schema.fields and set(s.identifier_field_ids) == set(schema.identifier_field_ids):
            return s.schema_id
    return md.schemas[-1].schema_id


def _normalize(md, updates: tuple) -> tuple:
    """Schema / partition spec / sort order additions as Java's metadata builder treats them: an addition equal to an
    existing one reuses it, a new one gets a fresh id (clients may send ids that are taken, e.g. 0 when creating)."""
    from pyiceberg.table.update import (AddPartitionSpecUpdate, AddSchemaUpdate, AddSortOrderUpdate, SetCurrentSchemaUpdate,
                                        SetDefaultSortOrderUpdate, SetDefaultSpecUpdate)

    schemas = {s.schema_id: s for s in md.schemas}
    specs = {s.spec_id: s for s in md.partition_specs}
    orders = {o.order_id: o for o in md.sort_orders}
    last = {"schema": None, "spec": None, "sort": None}
    out = []
    for u in updates:
        if isinstance(u, AddSchemaUpdate):
            same = next((sid for sid, s in schemas.items() if s.fields == u.schema_.fields
                         and set(s.identifier_field_ids) == set(u.schema_.identifier_field_ids)), None)
            if same is not None:
                last["schema"] = same
                continue
            sid = u.schema_.schema_id if u.schema_.schema_id not in schemas else max(schemas) + 1
            sch = u.schema_.model_copy(update={"schema_id": sid})
            schemas[sid] = sch
            last["schema"] = sid
            out.append(u.model_copy(update={"schema_": sch}))
        elif isinstance(u, SetCurrentSchemaUpdate) and u.schema_id == -1 and last["schema"] is not None:
            out.append(SetCurrentSchemaUpdate(schema_id=last["schema"]))
        elif isinstance(u, AddPartitionSpecUpdate):
            same = next((sid for sid, s in specs.items() if list(s.fields) == list(u.spec.fields)), None)
            if same is not None:
                last["spec"] = same
                continue
            sid = u.spec.spec_id if u.spec.spec_id not in specs else max(specs) + 1
            spec = u.spec.model_copy(update={"spec_id": sid})
            specs[sid] = spec
            last["spec"] = sid
            out.append(u.model_copy(update={"spec": spec}))
        elif isinstance(u, SetDefaultSpecUpdate) and u.spec_id == -1 and last["spec"] is not None:
            out.append(SetDefaultSpecUpdate(spec_id=last["spec"]))
        elif isinstance(u, AddSortOrderUpdate):
            same = next((oid for oid, o in orders.items() if list(o.fields) == list(u.sort_order.fields)), None)
            if same is not None:
                last["sort"] = same
                continue
            oid = u.sort_order.order_id if u.sort_order.order_id not in orders else max(orders) + 1
            order = u.sort_order.model_copy(update={"order_id": oid})
            orders[oid] = order
            last["sort"] = oid
            out.append(u.model_copy(update={"sort_order": order}))
        elif isinstance(u, SetDefaultSortOrderUpdate) and u.sort_order_id == -1 and last["sort"] is not None:
            out.append(SetDefaultSortOrderUpdate(sort_order_id=last["sort"]))
        else:
            out.append(u)
    return tuple(out)


def _translate(md, branch: str, requirements: tuple, updates: tuple) -> tuple[tuple, tuple, dict]:
    """Requirements and updates a client on an isolated branch sent against branch_view(), as changes to the real
    metadata: refs to main go to the branch, current schema / spec / sort order changes become branch properties."""
    from pyiceberg.table.update import (AddPartitionSpecUpdate, AddSchemaUpdate, AddSortOrderUpdate, AssertCurrentSchemaId,
                                        AssertDefaultSortOrderId, AssertDefaultSpecId, AssertRefSnapshotId, SetCurrentSchemaUpdate,
                                        SetDefaultSortOrderUpdate, SetDefaultSpecUpdate, SetSnapshotRefUpdate, update_table_metadata)

    schema_id, spec_id, sort_id = branch_ids(md, branch)
    has_own = branch in md.refs
    reqs = []
    for r in requirements:
        if isinstance(r, AssertRefSnapshotId) and r.ref == MAIN:
            r = r.model_copy(update={"ref": branch if has_own else MAIN})
        elif isinstance(r, AssertCurrentSchemaId):
            if r.current_schema_id != schema_id:
                raise conflict(f"Requirement failed: current schema of branch {branch} changed: expected id {r.current_schema_id} != {schema_id}")
            continue
        elif isinstance(r, AssertDefaultSpecId):
            if r.default_spec_id != spec_id:
                raise conflict(f"Requirement failed: default partition spec of branch {branch} changed")
            continue
        elif isinstance(r, AssertDefaultSortOrderId):
            if r.default_sort_order_id != sort_id:
                raise conflict(f"Requirement failed: default sort order of branch {branch} changed")
            continue
        reqs.append(r)
    out = []
    props: dict[str, str] = {}
    tmp = md
    last = {"schema": None, "spec": None, "sort": None}
    for u in updates:
        if isinstance(u, (AddSchemaUpdate, AddPartitionSpecUpdate, AddSortOrderUpdate)):
            tmp = update_table_metadata(tmp, (u,))
            if isinstance(u, AddSchemaUpdate):
                last["schema"] = _schema_id_of(tmp, u.schema_)
            elif isinstance(u, AddPartitionSpecUpdate):
                last["spec"] = max(s.spec_id for s in tmp.partition_specs)
            else:
                last["sort"] = max(s.order_id for s in tmp.sort_orders)
            out.append(u)
        elif isinstance(u, SetCurrentSchemaUpdate):
            props[branch_prop(branch, "schema-id")] = str(last["schema"] if u.schema_id == -1 else u.schema_id)
        elif isinstance(u, SetDefaultSpecUpdate):
            props[branch_prop(branch, "spec-id")] = str(last["spec"] if u.spec_id == -1 else u.spec_id)
        elif isinstance(u, SetDefaultSortOrderUpdate):
            props[branch_prop(branch, "sort-order-id")] = str(last["sort"] if u.sort_order_id == -1 else u.sort_order_id)
        elif isinstance(u, SetSnapshotRefUpdate) and u.ref_name == MAIN:
            out.append(u.model_copy(update={"ref_name": branch}))
        else:
            out.append(u)
    return tuple(reqs), tuple(out), props


# ------------------------------------------------------------------------------------------------
# loading and committing
# ------------------------------------------------------------------------------------------------


def current_location(item_id: str, job_id: Optional[str] = None) -> Optional[str]:
    """The metadata a reader sees: the job's staged write, else what the job pinned, else the table's pointer."""
    j = job(job_id)
    if j is not None:
        with _lock:
            if item_id in j["staged"]:
                return j["staged"][item_id]["loc"]
            if item_id in j["pinned"]:
                return j["pinned"][item_id]
            loc = record(item_id).get("metadata_location")
            j["pinned"][item_id] = loc
            return loc
    return record(item_id).get("metadata_location")


def load(item_id: str, branch: Optional[str] = None, job_id: Optional[str] = None) -> tuple[str, Any]:
    """(metadata location, metadata as seen on the branch)."""
    if branch is None and job_id:
        branch = job(job_id)["branch"]
    loc = current_location(item_id, job_id)
    return loc, branch_view(read_metadata(item_id, loc), branch)


def raw(item_id: str, job_id: Optional[str] = None):
    loc = current_location(item_id, job_id)
    return read_metadata(item_id, loc)


def _check_types(schema, format_version: int) -> None:
    bad = UNSUPPORTED_TYPES.get(format_version, UNSUPPORTED_TYPES[3])

    def walk(t, path: str) -> None:
        name = str(t).split("(")[0].split("<")[0].strip().lower()
        if name in bad:
            raise bad_request(f'column "{path}" has type {t}, which Foundry does not support in format version {format_version}: '
                              + ("convert nanosecond timestamps to microseconds (timestamp_ns → timestamp, timestamptz_ns → timestamptz)"
                                 if "timestamp" in name else "convert it to a supported type first"))
        for f in getattr(t, "fields", None) or []:
            walk(f.field_type, f"{path}.{f.name}" if path else f.name)
        for attr in ("element_type", "key_type", "value_type"):
            if hasattr(t, attr):
                walk(getattr(t, attr), path)

    for f in schema.fields:
        walk(f.field_type, f.name)


def _upgraded(md, version: int):
    """Metadata at a higher format version (pyiceberg's own upgrade stops at 2)."""
    from pyiceberg.table.metadata import TableMetadataUtil

    if version > 3:
        raise bad_request("Foundry supports Iceberg format versions 2 and 3")
    d = json.loads(_dump(md))
    d["format-version"] = version
    if version >= 3:
        d.setdefault("next-row-id", 0)
    d["last-updated-ms"] = int(datetime.now(timezone.utc).timestamp() * 1000)
    return TableMetadataUtil.parse_obj(d)


def _check_properties(keys: list[str]) -> None:
    for k in keys:
        if k == "format-version":
            continue
        if any(k == p or (p.endswith(".") and k.startswith(p)) for p in LOCKED_PROPERTIES):
            raise forbidden(f'the table property "{k}" is managed by Foundry and cannot be changed')


def _principal_label() -> str:
    p = auth.current()
    if not p or p.get("service"):
        return "system"
    return p.get("username") or p.get("id") or "user"


def can_bypass_protection(item: dict) -> bool:
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return True
    return auth._rank(auth.role_for(auth.project_of(item["id"]), p)) >= auth._rank("owner")


def commit(item_id: str, requirements: tuple, updates: tuple, branch: Optional[str] = None, job_id: Optional[str] = None,
           snapshot_extra: Optional[dict] = None, internal: bool = False, writer: Optional[dict] = None) -> tuple[str, Any]:
    """Apply a client's commit (Iceberg REST updateTable): validates requirements, Foundry's property and type rules,
    main branch protection and branch isolation. In a job the result is staged. Returns (location, branch view).
    `writer`: {kind, label} recorded with the commit in the table's history (external clients when absent)."""
    from pyiceberg.table.update import (AddSchemaUpdate, AddSnapshotUpdate, RemovePropertiesUpdate, RemoveSnapshotRefUpdate,
                                        RemoveSnapshotsUpdate, SetPropertiesUpdate, SetSnapshotRefUpdate, UpgradeFormatVersionUpdate,
                                        update_table_metadata)

    j = job(job_id)
    if branch is None and j is not None:
        branch = j["branch"]
    branch = canonical_branch(branch)
    item = db.drive_get(item_id)
    with table_lock(item_id):
        base_loc = current_location(item_id, job_id)
        base = read_metadata(item_id, base_loc)
        rec = record(item_id)
        props: dict[str, str] = {}
        updates = _normalize(base, tuple(updates))
        if branch:
            requirements, updates, props = _translate(base, branch, tuple(requirements), tuple(updates))
        for r in requirements:
            try:
                r.validate(base)
            except Exception as e:  # noqa: BLE001 - CommitFailedException
                raise conflict(str(e)) from None
        fv = base.format_version
        out = []
        added_marks: dict[int, set[str]] = {}  # markings recorded on the snapshots this commit adds
        for u in updates:
            if isinstance(u, SetPropertiesUpdate):
                if not internal:
                    # clients echo properties back (Spark's create-or-replace): only changes are checked
                    _check_properties([k for k, v in u.updates.items() if base.properties.get(k) != v])
                upd = dict(u.updates)
                if "format-version" in upd:
                    want = int(upd.pop("format-version"))
                    if want < fv:
                        raise bad_request(f"cannot downgrade a format version {fv} table to version {want}")
                    if want > fv:
                        out.append(UpgradeFormatVersionUpdate(format_version=want))
                        fv = want
                if upd:
                    out.append(SetPropertiesUpdate(updates=upd))
                continue
            if isinstance(u, RemovePropertiesUpdate) and not internal:
                _check_properties([k for k in u.removals if k in base.properties])
            if isinstance(u, UpgradeFormatVersionUpdate):
                if u.format_version < fv:
                    raise bad_request(f"cannot downgrade a format version {fv} table to version {u.format_version}")
                fv = u.format_version
            if isinstance(u, AddSchemaUpdate):
                _check_types(u.schema_, fv)
            if isinstance(u, AddSnapshotUpdate):
                extra = {"foundry.user": _principal_label()}
                if j is not None:
                    extra["foundry.job"] = j["label"] or j["id"]
                    if j["markings"]:
                        extra["foundry.markings"] = ",".join(j["markings"])
                extra.update(snapshot_extra or {})
                s = u.snapshot
                own = _marks_of(s) | {m for m in str(extra.get("foundry.markings") or "").split(",") if m}
                if _keeps_parent_rows(s):
                    parent = added_marks.get(s.parent_snapshot_id)
                    if parent is None:
                        ps = base.snapshot_by_id(s.parent_snapshot_id)
                        parent = _marks_of(ps) if ps is not None else set()
                    own |= parent
                added_marks[s.snapshot_id] = own
                if own:
                    extra["foundry.markings"] = ",".join(sorted(own))
                summary = s.summary.model_copy(update={}) if s.summary else None
                if summary is not None:
                    from pyiceberg.table.snapshots import Summary

                    summary = Summary(s.summary.operation, **{**s.summary.additional_properties, **extra})
                u = AddSnapshotUpdate(snapshot=s.model_copy(update={"summary": summary}))
            out.append(u)
        if props:
            out.append(SetPropertiesUpdate(updates=props))
        writes_main = any(isinstance(u, (SetSnapshotRefUpdate, RemoveSnapshotRefUpdate)) and u.ref_name == MAIN for u in out) or \
            any(isinstance(u, RemoveSnapshotsUpdate) for u in out)
        if writes_main and rec.get("protected") and item and not internal:
            producer = (j or {}).get("producer")
            owning = producer and rec.get("producer") and producer.get("id") == rec["producer"].get("id")
            if not owning and not can_bypass_protection(item):
                raise forbidden(f"{item['name']} has main branch protection: changes outside its owning job need the Owner role "
                                "(iceberg:bypass-branch-protection)")
        try:
            ups = [u for u in out if isinstance(u, UpgradeFormatVersionUpdate)]
            start = base
            if ups and max(u.format_version for u in ups) > base.format_version:
                start = _upgraded(base, max(u.format_version for u in ups))
            out = [u for u in out if not isinstance(u, UpgradeFormatVersionUpdate)]
            new = update_table_metadata(start, tuple(out), metadata_location=base_loc)
        except CatalogError:
            raise
        except Exception as e:  # noqa: BLE001 - ValidationError, CommitFailedException
            raise conflict(f"commit failed: {e}") from None
        loc = write_metadata(item_id, new, base_loc)
        if j is not None:
            with _lock:
                st = j["staged"].get(item_id)
                j["staged"][item_id] = {"base": st["base"] if st else record(item_id).get("metadata_location"), "loc": loc}
        else:
            rec = record(item_id)
            if rec.get("metadata_location") != base_loc:
                raise conflict("the table changed while committing; retry")
            _widen_markings(item_id, new)  # before the new rows are visible; _after_commit narrows
            rec["metadata_location"] = loc
            save_record(rec)
            before = {s.snapshot_id for s in base.snapshots}
            _after_commit(item_id, new, {**(writer or {"kind": "external", "label": f"Iceberg client ({_principal_label()})"}),
                                         "branch": branch, "snapshots": [s.snapshot_id for s in new.snapshots if s.snapshot_id not in before]})
        return loc, branch_view(new, branch)


def _after_commit(item_id: str, md, entry: dict) -> None:
    """After a commit is visible: the Files item's size (live files on main), modified time, history and markings."""
    try:
        main = md.refs.get(MAIN)
        snap = md.snapshot_by_id(main.snapshot_id) if main else None
        size = int((snap.summary.additional_properties.get("total-files-size") if snap and snap.summary else 0) or 0)
        now = _now()
        db.drive_set(item_id, size_bytes=size, updated_at=now)
        rec = record(item_id)
        hist = rec.setdefault("history", [])
        hist.insert(0, {"at": now, "user": _principal_label(), **entry})
        del hist[200:]
        save_record(rec)
        refresh_markings(item_id, md)
    except Exception:  # noqa: BLE001 - never fails a commit that already happened
        log.exception("post-commit bookkeeping failed for %s", item_id)


def refresh_markings(item_id: str, md=None) -> list[str]:
    """Iceberg markings are table-scoped: the table inherits the markings recorded on every retained snapshot (on any
    branch), except those an owner stopped propagating. Under the table's lock: a refresh never sets markings read
    from metadata older than a commit that already widened them."""
    with table_lock(item_id):
        md = md or raw(item_id)
        marks = snapshot_markings(item_id, md)
        try:
            auth._set_item(item_id, inherited=sorted(marks))
        except Exception:  # noqa: BLE001 - markings store unavailable
            log.exception("could not set markings on %s", item_id)
        return sorted(marks)


def _marks_of(s) -> set[str]:
    """The markings recorded on one snapshot."""
    v = (s.summary.additional_properties.get("foundry.markings") if s is not None and s.summary else None) or ""
    return {m for m in str(v).split(",") if m}


def _keeps_parent_rows(s) -> bool:
    """Whether a new snapshot keeps or rewrites rows of its parent: every operation (append, delete, replace /
    compaction) but an overwrite that replaced all of the parent's data files — a full replacement, which does not
    depend on the parent (Foundry: the way to unmark a table is such a replacement, then expiring the marked snapshot)."""
    if s.parent_snapshot_id is None:
        return False
    if not s.summary or getattr(s.summary.operation, "value", s.summary.operation) != "overwrite":
        return True
    p = s.summary.additional_properties
    try:
        return int(p["total-data-files"]) > int(p.get("added-data-files") or 0)
    except (KeyError, TypeError, ValueError):  # no totals in the summary: assume it keeps rows
        return True


def snapshot_markings(item_id: str, md) -> set[str]:
    """The markings a table inherits from its metadata: those recorded on every retained snapshot, except those an
    owner stopped propagating."""
    rec = record(item_id)
    marks: set[str] = set()
    for s in md.snapshots:
        marks |= _marks_of(s)
    if not md.snapshots:
        # a table created already marked (create_table's `markings`) keeps them until its first snapshot records
        # them: a schema-only commit before the first rows (PyIceberg's update_schema) never unmarks it
        marks |= set(rec.get("create_markings") or [])
    return marks - set(rec.get("stop_propagating") or [])


def main_markings(item_id: str) -> set[str]:
    """The markings recorded on the main branch's current snapshot: those of the rows a writer reading the table gets."""
    md = raw(item_id)
    ref = md.refs.get(MAIN)
    return _marks_of(md.snapshot_by_id(ref.snapshot_id)) if ref else set()


def _widen_markings(item_id: str, md) -> None:
    """Before new metadata becomes visible: the table gains its snapshots' markings it does not carry yet (the refresh
    after the commit narrows it to exactly those), so no reader ever sees the new rows without them. Fails the commit
    when the markings store cannot be written."""
    marks = snapshot_markings(item_id, md)
    cur = set(auth._item_row(item_id)[1])
    if not marks <= cur:
        auth._set_item(item_id, inherited=sorted(cur | marks))


def reserve_marked_id(markings: list[str]) -> str:
    """A fresh, unused Files item id already carrying `markings` (inherited): store the new item under it
    (drive._store's item_id) so no reader ever finds it, or reads it, without them."""
    drive._require_db()
    while True:
        item_id = uuid.uuid4().hex[:16]
        if not db.drive_get(item_id) and auth._item_row(item_id) == ([], []):
            break
    auth._set_item(item_id, inherited=sorted(set(markings)))
    return item_id


def release_marked_id(item_id: str) -> None:
    """Drop the markings record of a reserved id when nothing was stored under it."""
    if not db.drive_get(item_id):
        auth._set_item(item_id, inherited=[])


def stored_under(item: dict, item_id: str) -> dict:
    """The item drive._store returned for a reserved id: when the id was refused (taken meanwhile) the contents went
    under another, unmarked id — removed at once, and the write fails."""
    if item["id"] == item_id:
        return item
    release_marked_id(item_id)
    drive._delete_contents(db.drive_delete(item["id"], _now()))
    raise HTTPException(500, "the output could not be created under its marked id: nothing was written")


# ------------------------------------------------------------------------------------------------
# creating and dropping tables
# ------------------------------------------------------------------------------------------------


def _descriptor(item_id: str, location: str) -> bytes:
    return json.dumps({"format": "iceberg", "rid": rid(item_id), "location": location}).encode()


def create_table(folder_id: Optional[str], name: str, schema=None, partition_spec=None, sort_order=None, properties: Optional[dict] = None,
                 branch: Optional[str] = None, location: Optional[str] = None, check: bool = True,
                 markings: Optional[list[str]] = None) -> dict:
    """Create a managed Iceberg table in a folder (the caller needs the Editor role there; the folder's Project must
    allow Iceberg). On an isolated branch the table exists on main with an empty schema and the branch owns the
    given one. `markings`: inherited markings the table carries from the moment it exists (a table created from
    marked inputs; its first snapshot records them). Returns the Files item."""
    from pyiceberg.partitioning import UNPARTITIONED_PARTITION_SPEC
    from pyiceberg.schema import Schema
    from pyiceberg.table.metadata import new_table_metadata
    from pyiceberg.table.sorting import UNSORTED_SORT_ORDER
    from pyiceberg.table.update import AddSchemaUpdate, SetPropertiesUpdate, update_table_metadata

    if check:
        try:
            drive._folder_id(folder_id)
        except HTTPException as e:
            raise forbidden(str(e.detail)) if e.status_code == 403 else no_namespace(folder_id or "") from None
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name:
        raise bad_request("a table name cannot be empty or contain / or \\")
    if any(c["name"] == name for c in db.drive_list(folder_id)):
        raise CatalogError(409, "AlreadyExistsException", f"Table already exists: {name}")
    st = resolve_storage(folder_id)
    if not st["enabled"]:
        raise forbidden("Iceberg tables are not enabled for this Project (Control Panel → Iceberg table settings)")
    schema = schema if schema is not None else Schema()
    props = {**DEFAULT_PROPERTIES, **{k: v for k, v in (properties or {}).items()}}
    _check_properties([k for k in (properties or {}) if k not in DEFAULT_PROPERTIES])
    props.setdefault("format-version", "3" if st["cse"] else "2")
    fv = int(props["format-version"])
    if fv not in (2, 3):
        raise bad_request("Foundry supports Iceberg format versions 2 and 3")
    _check_types(schema, fv)
    reserved = reserve_marked_id(markings) if markings else None
    try:
        item = drive._store(folder_id, name, __import__("io").BytesIO(b"{}"), 2, ICEBERG, item_id=reserved)
    except BaseException:
        if reserved:
            release_marked_id(reserved)
        raise
    if reserved:
        item = stored_under(item, reserved)
    item_id = item["id"]
    try:
        base = _base_uri(st["storage"])
        loc = (location or f"{base}/{item_id}").rstrip("/")
        props.update({"created-at": _now(), "foundry.rid": rid(item_id), "foundry.table-version": "1"})
        rec = {"id": item_id, "uuid": None, "storage": st["storage"]["id"], "cse": st["cse"], "location": loc, "created_at": _now(),
               "created_by": _principal_label(), "protected": False, "stop_propagating": [], "history": [], "metadata_location": None}
        if markings:
            rec["create_markings"] = sorted(set(markings))  # kept until the first snapshot records them (snapshot_markings)
        save_record(rec)
        branch = canonical_branch(branch)
        if branch:
            from pyiceberg.schema import assign_fresh_schema_ids

            md = new_table_metadata(Schema(), UNPARTITIONED_PARTITION_SPEC, UNSORTED_SORT_ORDER, loc, props)
            fresh = assign_fresh_schema_ids(schema).model_copy(update={"schema_id": 1})
            md = update_table_metadata(md, (AddSchemaUpdate(schema_=fresh),))
            md = update_table_metadata(md, (SetPropertiesUpdate(updates={branch_prop(branch, "schema-id"): "1"}),))
        else:
            md = new_table_metadata(schema, partition_spec or UNPARTITIONED_PARTITION_SPEC, sort_order or UNSORTED_SORT_ORDER, loc, props)
        mloc = write_metadata(item_id, md, None)
        rec.update(uuid=str(md.table_uuid), metadata_location=mloc)
        save_record(rec)
        content = _descriptor(item_id, loc)
        import pipeline_datasets

        pipeline_datasets._replace_content(db.drive_get(item_id), content, ICEBERG)
        db.drive_set(item_id, size_bytes=0)
    except Exception:
        with contextlib.suppress(Exception):
            _rec_path(item_id).unlink(missing_ok=True)
            db.drive_delete(item_id, _now())
            if reserved:
                release_marked_id(item_id)
        raise
    return db.drive_get(item_id)


def ensure_table(folder_id: Optional[str], name: str, branch: Optional[str] = None) -> dict:
    """The table at folder/name, created (empty schema) when missing — a transform's or pipeline's output."""
    existing = next((c for c in db.drive_list(folder_id) if c["name"] == name), None)
    if existing:
        if not is_table(existing):
            raise bad_request(f'"{name}" already exists and is not an Iceberg table')
        return existing
    return create_table(folder_id, name, branch=branch)


def drop_table(item_id: str) -> None:
    """Drop: the table moves to the Files trash (its files are kept: deferred deletion)."""
    item = table_item(item_id, need="editor")
    try:
        drive.trash(item["id"])
    except HTTPException as e:
        raise forbidden(str(e.detail)) from None


# ------------------------------------------------------------------------------------------------
# server-side PyIceberg tables (Pipeline Builder, syncs, maintenance, previews)
# ------------------------------------------------------------------------------------------------


def server_table(item_id: str, branch: Optional[str] = None, job_id: Optional[str] = None, writer: Optional[dict] = None,
                 snapshot_extra: Optional[dict] = None, internal: bool = False):
    """A pyiceberg Table on the branch whose writes commit through this catalog."""
    from pyiceberg.catalog import MetastoreCatalog
    from pyiceberg.table import CommitTableResponse, Table

    class Cat(MetastoreCatalog):
        def __init__(self) -> None:
            super().__init__("foundry")

        def load_table(self, identifier):  # noqa: ANN001, ANN201
            loc, md = load(item_id, branch, job_id)
            return Table((rid(item_id),), md, loc, file_io(item_id, loc), self)

        def commit_table(self, table, requirements, updates):  # noqa: ANN001, ANN201
            loc, md = commit(item_id, requirements, updates, branch, job_id, snapshot_extra=snapshot_extra, internal=internal, writer=writer)
            return CommitTableResponse(metadata=md, metadata_location=loc)

        def _unsupported(self, *_a, **_k):  # noqa: ANN202
            raise NotImplementedError

        create_namespace = create_table = drop_namespace = drop_table = drop_view = list_namespaces = list_tables = list_views = _unsupported
        load_namespace_properties = load_view = register_table = register_view = rename_table = update_namespace_properties = _unsupported
        view_exists = _unsupported

    return Cat().load_table(None)


evolve_to = iceberg_write.evolve_to
prepare = iceberg_write.prepare
replace_contents = iceberg_write.replace_contents
rewrite_files = iceberg_write.rewrite_files


# ------------------------------------------------------------------------------------------------
# describing tables
# ------------------------------------------------------------------------------------------------


def metadata_json(md) -> dict:
    return json.loads(_dump(md))


def schema_json(schema) -> dict:
    return json.loads(schema.model_dump_json())


def columns(schema) -> list[dict]:
    return [{"id": f.field_id, "name": f.name, "type": str(f.field_type), "required": f.required, "doc": f.doc} for f in schema.fields]


def ancestors(md, snapshot_id: Optional[int]) -> list[Any]:
    out = []
    seen = set()
    s = md.snapshot_by_id(snapshot_id) if snapshot_id is not None else None
    while s is not None and s.snapshot_id not in seen:
        out.append(s)
        seen.add(s.snapshot_id)
        s = md.snapshot_by_id(s.parent_snapshot_id) if s.parent_snapshot_id is not None else None
    return out


def _int(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def snapshot_info(md, s, prev_schema: Optional[int] = None) -> dict:
    p = dict(s.summary.additional_properties) if s.summary else {}
    op = s.summary.operation.value if s.summary else "append"
    branches = [n for n, r in md.refs.items() if r.snapshot_id == s.snapshot_id]
    return {
        "snapshot_id": str(s.snapshot_id), "parent_id": str(s.parent_snapshot_id) if s.parent_snapshot_id is not None else None,
        "timestamp_ms": s.timestamp_ms, "at": datetime.fromtimestamp(s.timestamp_ms / 1000, timezone.utc).isoformat(timespec="seconds"),
        "operation": op, "foundry_transactions": SNAPSHOT_TO_TRANSACTION.get(op, []), "schema_id": s.schema_id,
        "new_schema": prev_schema is not None and s.schema_id is not None and s.schema_id != prev_schema,
        "total_size": _int(p.get("total-files-size")), "total_records": _int(p.get("total-records")), "total_files": _int(p.get("total-data-files")),
        "total_delete_files": _int(p.get("total-delete-files")),
        "added_size": _int(p.get("added-files-size")), "removed_size": _int(p.get("removed-files-size")),
        "added_records": _int(p.get("added-records")), "deleted_records": _int(p.get("deleted-records")),
        "added_files": _int(p.get("added-data-files")), "deleted_files": _int(p.get("deleted-data-files")),
        "added_delete_files": _int(p.get("added-delete-files")) or _int(p.get("added-position-delete-files")),
        "user": p.get("foundry.user"), "job": p.get("foundry.job"), "markings": [m for m in (p.get("foundry.markings") or "").split(",") if m],
        "manifest_list": s.manifest_list, "refs": branches, "summary": p,
    }


def snapshots(md, branch: Optional[str] = None) -> list[dict]:
    """The snapshots of a branch (its ancestry), newest first; all snapshots when branch is "*"."""
    if branch == "*":
        chain = sorted(md.snapshots, key=lambda s: s.timestamp_ms, reverse=True)
    else:
        ref = md.refs.get(canonical_branch(branch) or MAIN)
        chain = ancestors(md, ref.snapshot_id) if ref else []
    out = []
    for i, s in enumerate(chain):
        nxt = chain[i + 1] if i + 1 < len(chain) else None
        out.append(snapshot_info(md, s, nxt.schema_id if nxt is not None else None))
    return out


def schema_diff(md, schema_id: int) -> dict:
    """A schema version and what changed from the previous version."""
    by = {s.schema_id: s for s in md.schemas}
    s = by.get(schema_id)
    if s is None:
        raise bad_request(f"no schema version {schema_id}")
    ids = sorted(by)
    prev = by.get(max((i for i in ids if i < schema_id), default=-1))
    cur = {f.field_id: f for f in s.fields}
    old = {f.field_id: f for f in prev.fields} if prev else {}
    changes = []
    for fid, f in cur.items():
        o = old.get(fid)
        if o is None:
            changes.append({"change": "added", "name": f.name, "type": str(f.field_type)})
        else:
            if o.name != f.name:
                changes.append({"change": "renamed", "name": f.name, "from": o.name})
            if str(o.field_type) != str(f.field_type):
                changes.append({"change": "type changed", "name": f.name, "type": str(f.field_type), "from": str(o.field_type)})
            if o.required != f.required:
                changes.append({"change": "nullability changed", "name": f.name, "required": f.required})
    for fid, o in old.items():
        if fid not in cur:
            changes.append({"change": "removed", "name": o.name, "type": str(o.field_type)})
    return {"schema_id": schema_id, "previous_id": prev.schema_id if prev else None, "columns": columns(s), "changes": changes,
            "identifier_fields": [f.name for f in s.fields if f.field_id in set(s.identifier_field_ids)]}


def branches(md) -> list[dict]:
    out = []
    for name, r in sorted(md.refs.items(), key=lambda kv: (kv[0] != MAIN, kv[0])):
        s = md.snapshot_by_id(r.snapshot_id)
        out.append({"name": name, "type": r.snapshot_ref_type.value, "snapshot_id": str(r.snapshot_id),
                    "at": datetime.fromtimestamp(s.timestamp_ms / 1000, timezone.utc).isoformat(timespec="seconds") if s else None,
                    "schema_id": branch_ids(md, canonical_branch(name))[0] if r.snapshot_ref_type.value == "branch" else s.schema_id if s else None,
                    "min_snapshots_to_keep": r.min_snapshots_to_keep, "max_snapshot_age_ms": r.max_snapshot_age_ms,
                    "max_ref_age_ms": r.max_ref_age_ms})
    # branches that track a schema but have no snapshot yet (a table created on a branch)
    for k in md.properties:
        m = re.fullmatch(r"foundry\.branch\.(.+)\.schema-id", k)
        if m and m.group(1) not in md.refs:
            out.append({"name": m.group(1), "type": "branch", "snapshot_id": None, "at": None, "schema_id": int(md.properties[k]),
                        "min_snapshots_to_keep": None, "max_snapshot_age_ms": None, "max_ref_age_ms": None})
    return out


def live_files(tbl, branch: str = MAIN) -> list[dict]:
    """The data and delete files of a branch's current snapshot."""
    r = tbl.metadata.refs.get(branch)
    if not r:
        return []
    out, seen = [], set()
    for t in tbl.scan(snapshot_id=r.snapshot_id).plan_files():
        out.append({"path": t.file.file_path, "records": t.file.record_count, "size": t.file.file_size_in_bytes, "content": "data"})
        for d in t.delete_files:
            if d.file_path in seen:  # a delete file (equality ones especially) applies to several data files
                continue
            seen.add(d.file_path)
            out.append({"path": d.file_path, "records": d.record_count, "size": d.file_size_in_bytes, "content": "deletes"})
    return out


def describe(item: dict, branch: Optional[str] = None) -> dict:
    """What the Iceberg pages show about a table."""
    rec = record(item["id"])
    loc, md = load(item["id"], branch)
    base = read_metadata(item["id"], loc)
    schema_id = md.current_schema_id
    schema = next((s for s in md.schemas if s.schema_id == schema_id), md.schema())
    head = md.refs.get(MAIN)
    snap = md.snapshot_by_id(head.snapshot_id) if head else None
    p = dict(snap.summary.additional_properties) if snap and snap.summary else {}
    b = bucket(rec.get("storage"))
    return {
        "id": item["id"], "rid": rid(item["id"]), "name": item["name"], "namespace": namespace_of(item["id"]),
        "identifier": ".".join([*namespace_of(item["id"]), item["name"]]), "uuid": str(md.table_uuid), "location": md.location,
        "metadata_location": loc, "format_version": md.format_version, "branch": canonical_branch(branch) or MAIN,
        "schema_id": schema_id, "columns": columns(schema), "identifier_fields": [f.name for f in schema.fields if f.field_id in set(schema.identifier_field_ids)],
        "partition_spec": json.loads(md.spec().model_dump_json()) if md.default_spec_id is not None else None,
        "sort_order": json.loads(md.sort_order().model_dump_json()) if md.default_sort_order_id is not None else None,
        "properties": dict(base.properties), "snapshot_count": len(base.snapshots), "current_snapshot_id": str(snap.snapshot_id) if snap else None,
        "records": _int(p.get("total-records")) or 0, "size": _int(p.get("total-files-size")) or 0, "files": _int(p.get("total-data-files")) or 0,
        "delete_files": _int(p.get("total-delete-files")) or 0,
        "storage": {"id": b["id"], "name": b["name"], "provider": b["provider"]}, "cse": bool(rec.get("cse")),
        "protected": bool(rec.get("protected")), "producer": rec.get("producer"), "stop_propagating": rec.get("stop_propagating") or [],
        "created_at": rec.get("created_at"), "created_by": rec.get("created_by"), "updated_at": str(item.get("updated_at")),
        "branches": branches(base), "merge_on_read": any(base.properties.get(f"write.{k}.mode") == "merge-on-read" for k in ("delete", "update", "merge")),
    }


def scan_arrow(item_id: str, branch: Optional[str] = None, snapshot_id: Optional[int] = None, limit: Optional[int] = None,
               row_filter: Any = None, job_id: Optional[str] = None):
    """Rows of a table (on a branch, or at a snapshot) as an Arrow table."""
    import pyarrow as pa

    tbl = server_table(item_id, branch, job_id)
    kw: dict = {}
    if snapshot_id is None:
        # the branch's current state, read with the branch's schema (a scan at a snapshot uses that snapshot's schema)
        if tbl.metadata.refs.get(MAIN) is None:
            return tbl.schema().as_arrow().empty_table() if tbl.schema().fields else pa.table({})
    else:
        kw["snapshot_id"] = snapshot_id
    if limit is not None:
        kw["limit"] = limit
    if row_filter is not None:
        kw["row_filter"] = row_filter
    return tbl.scan(**kw).to_arrow()



def ordered_rows(item_id: str, branch: Optional[str] = None, limit: Optional[int] = None):
    """The table's rows in the order they were appended (the oldest retained snapshot's rows, then each later append
    snapshot's), so readers that track a row-count watermark (Pipeline Builder's incremental inputs) see appends at
    the end. Histories with overwrites or deletes after the oldest retained snapshot are read as one scan."""
    import pyarrow as pa

    tbl = server_table(item_id, branch)
    ref = tbl.metadata.refs.get(MAIN)
    if ref is None:
        return tbl.schema().as_arrow().empty_table() if tbl.schema().fields else pa.table({})
    chain = list(reversed(ancestors(tbl.metadata, ref.snapshot_id)))
    later = chain[1:]
    if limit is not None or not later or any(s.summary and s.summary.operation.value not in ("append", "replace") for s in later):
        return tbl.scan(**({"limit": limit} if limit is not None else {})).to_arrow()
    parts = [tbl.scan(snapshot_id=chain[0].snapshot_id).to_arrow()]
    prev = chain[0].snapshot_id
    for s in later:
        if s.summary and s.summary.operation.value == "append":
            parts.append(tbl.incremental_append_scan(from_snapshot_id_exclusive=prev, to_snapshot_id_inclusive=s.snapshot_id).to_arrow())
        prev = s.snapshot_id
    target = tbl.schema().as_arrow()
    return pa.concat_tables([iceberg_write.prepare(tbl, p) if p.schema != target else p for p in parts], promote_options="permissive")
