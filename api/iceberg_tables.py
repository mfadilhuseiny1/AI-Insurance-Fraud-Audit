"""The Iceberg pages: the Iceberg tables app (catalog browser, connecting clients, OAuth2 applications, Data
Connection syncs into Iceberg tables), an Iceberg table in Dataset Preview (preview, details with the metadata JSON,
Snapshots, schema versions, branches and tags, properties, History, main branch protection, markings) and Control
Panel → Iceberg table settings. Mounted by server.py under /api/iceberg-tables (maintenance is iceberg_maintenance.py).

Data Connection syncs into Iceberg (Palantir's "Syncing data to Iceberg tables" docs): from a PostgreSQL, SQL Server,
Oracle, Snowflake or custom JDBC connection, with the write modes
- overwrite: every row replaced (an overwrite snapshot),
- append: rows added (an append snapshot),
- update: rows matched on the primary key updated, new keys inserted (an overwrite snapshot of the affected files);
optionally incremental over a cursor column (only rows past the last value synced). Schema evolution is not supported:
a source whose columns changed fails the sync.
"""

from __future__ import annotations

import base64
import logging
import threading
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive
import iceberg_catalog as C
import iceberg_rest
import iceberg_write

log = logging.getLogger("bluesandai.iceberg_tables")
router = APIRouter(prefix="/api/iceberg-tables")
SYNC_KINDS = ("postgresql", "sqlserver", "oracle", "snowflake", "jdbc", "custom_jdbc", "custom-jdbc")
COLUMN_TYPES = ("string", "int", "bigint", "double", "float", "boolean", "date", "timestamp", "timestamp_ntz", "decimal(38,9)", "binary")
_sync_lock = threading.Lock()


def _err():
    return C.http_errors()


def _cell(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    if isinstance(v, dict):
        return {k: _cell(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_cell(x) for x in v]
    return v


def _branch_param(branch: Optional[str]) -> Optional[str]:
    return C.canonical_branch(branch)


# ------------------------------------------------------------------------------------------------
# tables
# ------------------------------------------------------------------------------------------------


def _summary(item: dict) -> dict:
    out = {"id": item["id"], "rid": C.rid(item["id"]), "name": item["name"], "path": C.namespace_of(item["id"]), "size": item["size_bytes"],
           "updated_at": item["updated_at"].isoformat() if hasattr(item["updated_at"], "isoformat") else str(item["updated_at"]),
           "created_at": item["created_at"].isoformat() if hasattr(item["created_at"], "isoformat") else str(item["created_at"])}
    try:
        md = C.raw(item["id"])
        head = md.refs.get("main")
        snap = md.snapshot_by_id(head.snapshot_id) if head else None
        p = snap.summary.additional_properties if snap and snap.summary else {}
        rec = C.record(item["id"])
        out.update(format_version=md.format_version, records=int(p.get("total-records") or 0), snapshots=len(md.snapshots),
                   branches=len([r for r in md.refs.values() if r.snapshot_ref_type.value == "branch"]), columns=len(md.schema().fields),
                   storage=C.bucket(rec.get("storage"))["name"], protected=bool(rec.get("protected")))
    except Exception:  # noqa: BLE001 - an unreadable table still lists
        out.update(error="the table's metadata could not be read")
    return out


@router.get("")
def list_tables(q: str = "") -> list[dict]:
    items = auth.visible(C.all_tables())
    if q:
        items = [i for i in items if q.lower() in i["name"].lower()]
    return [_summary(i) for i in items]


class NewColumn(BaseModel):
    name: str
    type: str = "string"
    required: bool = False


class NewTable(BaseModel):
    parent_id: Optional[str] = None
    name: str = Field(min_length=1, max_length=255)
    columns: list[NewColumn] = []
    format_version: Optional[int] = None
    partition_by: list[str] = []
    identifier_columns: list[str] = []
    properties: dict[str, str] = {}


@router.post("")
def create(req: NewTable) -> dict:
    from pyiceberg.partitioning import PartitionField, PartitionSpec
    from pyiceberg.schema import Schema
    from pyiceberg.transforms import IdentityTransform
    from pyiceberg.types import NestedField

    import iceberg_maintenance as M

    fields = []
    for i, c in enumerate(req.columns, start=1):
        if not c.name.strip():
            raise HTTPException(400, "a column has no name")
        with _err():
            fields.append(NestedField(i, c.name.strip(), M._type(c.type), required=c.required or c.name in req.identifier_columns))
    names = [f.name for f in fields]
    if len(set(names)) != len(names):
        raise HTTPException(400, "column names must be unique")
    ids = [fields[names.index(c)].field_id for c in req.identifier_columns if c in names]
    schema = Schema(*fields, identifier_field_ids=ids)
    spec = None
    if req.partition_by:
        pf = []
        for j, col in enumerate(req.partition_by):
            if col not in names:
                raise HTTPException(400, f"partition column {col} is not a column")
            pf.append(PartitionField(fields[names.index(col)].field_id, 1000 + j, IdentityTransform(), col))
        spec = PartitionSpec(*pf)
    props = dict(req.properties)
    if req.format_version:
        props["format-version"] = str(req.format_version)
    with _err():
        item = C.create_table(req.parent_id, req.name, schema, spec, None, props)
    return C.describe(item)


@router.get("/{item_id}")
def get_table(item_id: str, branch: Optional[str] = None) -> dict:
    with _err():
        item = C.table_item(item_id)
        d = C.describe(item, _branch_param(branch))
    d["path"] = C.namespace_of(item_id)
    d["can_edit"] = _can(item, "editor")
    d["can_own"] = _can(item, "owner")
    d["markings"] = sorted(auth.effective_markings(item_id))
    return d


def _can(item: dict, need: str) -> bool:
    try:
        auth.check_item(item, need)
        return True
    except HTTPException:
        return False


@router.get("/{item_id}/rows")
def rows(item_id: str, branch: Optional[str] = None, snapshot_id: Optional[str] = None, limit: int = 200, row_filter: Optional[str] = None) -> dict:
    with _err():
        C.table_item(item_id)
        try:
            data = C.scan_arrow(item_id, _branch_param(branch), int(snapshot_id) if snapshot_id else None, max(1, min(limit, 5000)),
                                row_filter or None)
        except (ValueError, TypeError) as e:
            raise C.bad_request(f"could not read the table: {e}") from None
    names = data.column_names
    cols = [data.column(i).to_pylist() for i in range(data.num_columns)]
    return {"columns": [{"name": f.name, "type": str(f.type).replace("large_", "")} for f in data.schema],
            "rows": [{n: _cell(cols[i][r]) for i, n in enumerate(names)} for r in range(data.num_rows)], "count": data.num_rows}


@router.get("/{item_id}/metadata")
def metadata(item_id: str, branch: Optional[str] = None) -> dict:
    """The table's Iceberg metadata JSON (Dataset Preview → Details)."""
    with _err():
        C.table_item(item_id)
        loc, md = C.load(item_id, _branch_param(branch))
    return {"metadata_location": loc, "metadata": C.metadata_json(md)}


@router.get("/{item_id}/snapshots")
def snapshots(item_id: str, branch: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None) -> dict:
    """The Snapshots tab: a branch's snapshots in a time range, newest first, and their trend points."""
    with _err():
        C.table_item(item_id)
        md = C.raw(item_id)
    snaps = C.snapshots(md, branch or "main")
    if since:
        snaps = [s for s in snaps if s["at"] >= since]
    if until:
        snaps = [s for s in snaps if s["at"] <= until]
    labels = auth.marking_labels() if auth.enabled() else {}
    for s in snaps:
        s["marking_names"] = [labels.get(m, m) for m in s["markings"]]
    trend = [{"at": s["at"], "total_size": s["total_size"], "total_records": s["total_records"], "total_files": s["total_files"],
              "schema_id": s["schema_id"], "operation": s["operation"]} for s in reversed(snaps)]
    return {"snapshots": snaps, "trend": trend, "branches": C.branches(md), "total": len(md.snapshots)}


@router.get("/{item_id}/schemas/{schema_id}")
def schema_version(item_id: str, schema_id: int) -> dict:
    with _err():
        C.table_item(item_id)
        return C.schema_diff(C.raw(item_id), schema_id)


@router.get("/{item_id}/history")
def history(item_id: str) -> list[dict]:
    """Jobs and clients that wrote the table (the History tab)."""
    with _err():
        C.table_item(item_id)
        return C.record(item_id).get("history") or []


class PropertiesIn(BaseModel):
    set: dict[str, str] = {}
    unset: list[str] = []


@router.put("/{item_id}/properties")
def set_properties(item_id: str, req: PropertiesIn) -> dict:
    from pyiceberg.table.update import RemovePropertiesUpdate, SetPropertiesUpdate

    with _err():
        C.table_item(item_id, need="editor")
        ups = []
        if req.set:
            ups.append(SetPropertiesUpdate(updates=req.set))
        if req.unset:
            ups.append(RemovePropertiesUpdate(removals=req.unset))
        if ups:
            C.commit(item_id, (), tuple(ups), writer={"kind": "user", "label": "Properties edited"})
    return get_table(item_id)


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: Literal["branch", "tag"] = "branch"
    snapshot_id: Optional[str] = None


@router.post("/{item_id}/branches")
def create_branch(item_id: str, req: BranchIn) -> dict:
    with _err():
        C.table_item(item_id, need="editor")
        tbl = C.server_table(item_id, writer={"kind": "user", "label": f"Created {req.type} {req.name}"})
        head = tbl.metadata.refs.get("main")
        sid = int(req.snapshot_id) if req.snapshot_id else (head.snapshot_id if head else None)
        if sid is None:
            raise C.bad_request("the table has no snapshot yet")
        if req.name in tbl.metadata.refs or req.name in ("main", "master"):
            raise C.bad_request(f"{req.name} already exists")
        ms = tbl.manage_snapshots()
        (ms.create_branch(sid, req.name) if req.type == "branch" else ms.create_tag(sid, req.name)).commit()
    return snapshots(item_id)


@router.delete("/{item_id}/branches/{name:path}")
def delete_branch(item_id: str, name: str) -> dict:
    """Delete a branch or tag; the schema protection of a deleted branch is lifted."""
    from pyiceberg.table.update import RemovePropertiesUpdate

    with _err():
        C.table_item(item_id, need="editor")
        if name in ("main", "master"):
            raise C.bad_request("the main branch cannot be deleted")
        tbl = C.server_table(item_id, writer={"kind": "user", "label": f"Deleted {name}"})
        ref = tbl.metadata.refs.get(name)
        if ref is not None:
            ms = tbl.manage_snapshots()
            (ms.remove_branch(name) if ref.snapshot_ref_type.value == "branch" else ms.remove_tag(name)).commit()
        keys = [k for k in C.raw(item_id).properties if k.startswith(f"foundry.branch.{name}.")]
        if keys:
            C.commit(item_id, (), (RemovePropertiesUpdate(removals=keys),), internal=True, writer={"kind": "user", "label": f"Deleted {name}"})
    return snapshots(item_id)


class RollbackIn(BaseModel):
    snapshot_id: str


@router.post("/{item_id}/rollback")
def rollback(item_id: str, req: RollbackIn) -> dict:
    with _err():
        C.table_item(item_id, need="editor")
        tbl = C.server_table(item_id, writer={"kind": "user", "label": f"Rolled back to {req.snapshot_id}"})
        tbl.manage_snapshots().rollback_to_snapshot(int(req.snapshot_id)).commit()
    return snapshots(item_id)


class SettingsIn(BaseModel):
    protected: Optional[bool] = None
    stop_propagating: Optional[list[str]] = None


@router.put("/{item_id}/access")
def table_settings(item_id: str, req: SettingsIn) -> dict:
    """Main branch protection and stop-propagating markings: the Owner role."""
    with _err():
        C.table_item(item_id, need="owner")
        with C.table_lock(item_id):
            rec = C.record(item_id)
            if req.protected is not None:
                rec["protected"] = req.protected
            if req.stop_propagating is not None:
                rec["stop_propagating"] = sorted(set(req.stop_propagating))
            C.save_record(rec)
        C.refresh_markings(item_id)
    return get_table(item_id)


@router.delete("/{item_id}")
def drop(item_id: str) -> dict:
    with _err():
        C.drop_table(item_id)
    return {"deleted": item_id}


# ------------------------------------------------------------------------------------------------
# connecting clients and OAuth2 applications
# ------------------------------------------------------------------------------------------------


@router.get("/tools/connect")
def connect_info() -> dict:
    import os

    base = os.environ.get("BLUESANDAI_PUBLIC_API_URL") or os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000")
    return {"uri": f"{base}/api/iceberg", "oauth2_server_uri": f"{base}/api/iceberg/v1/oauth/tokens", "default_namespace": "foundry",
            "spark_runtime": "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.9.2", "auth_enabled": auth.enabled()}


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] = ["api:iceberg-read", "api:iceberg-write"]


@router.get("/tools/oauth-clients")
def oauth_clients() -> list[dict]:
    return iceberg_rest.list_clients()


@router.post("/tools/oauth-clients")
def new_oauth_client(req: ClientIn) -> dict:
    with _err():
        return iceberg_rest.create_client(req.name, req.scopes)


@router.delete("/tools/oauth-clients/{client_id}")
def delete_oauth_client(client_id: str) -> dict:
    with _err():
        iceberg_rest.delete_client(client_id)
    return {"deleted": client_id}


# ------------------------------------------------------------------------------------------------
# Control Panel → Iceberg table settings
# ------------------------------------------------------------------------------------------------


def _public_settings(s: dict) -> dict:
    out = dict(s)
    out["buckets"] = [{k: v for k, v in b.items() if k != "secrets"} | {"has_credentials": bool(b.get("secrets"))} for b in s["buckets"]]
    out["storages"] = [{"id": b["id"], "name": b["name"], "provider": b["provider"]} for b in C.buckets()]
    for o in out["overrides"]:
        try:
            o["path"] = [p["name"] for p in db.drive_path(o["target_id"])]
        except Exception:  # noqa: BLE001
            o["path"] = []
    out["can_edit"] = not auth.enabled() or (auth.current() or {}).get("role") == "admin"
    return out


@router.get("/tools/settings")
def get_settings() -> dict:
    return _public_settings(C.settings())


class BucketIn(BaseModel):
    id: Optional[str] = None
    name: str = Field(min_length=1, max_length=120)
    provider: Literal["local", "s3", "abfs", "gcs"]
    uri: str = Field(min_length=1)
    fileio: dict[str, str] = {}
    credentials: Optional[dict[str, str]] = None
    access_delegation: Literal["none", "vended-credentials"] = "none"
    source_id: Optional[str] = None


class OverrideIn(BaseModel):
    target_id: str
    storage: Optional[str] = None
    cse: Optional[bool] = None


class SettingsPut(BaseModel):
    enabled: bool = True
    allow_all_projects: bool = True
    default_storage: str = "managed"
    cse: bool = False
    dr_lookback_days: float = Field(7, ge=0, le=365)
    buckets: list[BucketIn] = []
    overrides: list[OverrideIn] = []


@router.put("/tools/settings")
def put_settings(req: SettingsPut) -> dict:
    """Only Enrollment Administrators / Information Security Officers (administrators here). Changes apply to tables
    created afterwards; existing tables keep their storage and encryption."""
    auth.require_admin()
    cur = C.settings()
    old = {b["id"]: b for b in cur["buckets"]}
    buckets = []
    for b in req.buckets:
        bid = b.id or f"bucket-{uuid.uuid4().hex[:8]}"
        prev = old.get(bid) or {}
        rec = {"id": bid, "name": b.name.strip(), "provider": b.provider, "uri": b.uri.strip(), "fileio": b.fileio,
               "access_delegation": b.access_delegation, "source_id": b.source_id, "created_at": prev.get("created_at") or C._now()}
        if prev and prev.get("uri") and prev["uri"] != rec["uri"] and _bucket_used(bid):
            raise HTTPException(400, f'{b.name}: the base path of a storage location in use cannot change (existing tables would break)')
        if b.credentials:
            import secretbox

            rec["secrets"] = base64.b64encode(secretbox.seal({k: str(v) for k, v in b.credentials.items()})).decode()
        elif prev.get("secrets"):
            rec["secrets"] = prev["secrets"]
        if b.provider == "local":
            from pathlib import Path

            p = Path(rec["uri"].removeprefix("file://"))
            if not p.is_absolute():
                raise HTTPException(400, f"{b.name}: a local storage location needs an absolute directory")
            p.mkdir(parents=True, exist_ok=True)
        buckets.append(rec)
    ids = {"managed", *[b["id"] for b in buckets]}
    removed = [b for b in old if b not in ids and _bucket_used(b)]
    if removed:
        raise HTTPException(400, "a storage location that tables use cannot be removed")
    if req.default_storage not in ids:
        raise HTTPException(400, "the default storage is not a configured location")
    overrides = []
    for o in req.overrides:
        item = db.drive_get(o.target_id)
        if not item or item["kind"] not in ("project", "folder"):
            raise HTTPException(400, "an override must name a Project or folder (namespace)")
        if o.storage and o.storage not in ids:
            raise HTTPException(400, f"unknown storage {o.storage}")
        overrides.append({"target_id": o.target_id, "scope": "project" if item["kind"] == "project" else "namespace", "storage": o.storage,
                          "cse": o.cse, "name": item["name"]})
    s = {**cur, "enabled": req.enabled, "allow_all_projects": req.allow_all_projects, "default_storage": req.default_storage, "cse": req.cse,
         "dr_lookback_days": req.dr_lookback_days, "buckets": buckets, "overrides": overrides}
    C.save_settings(s)
    auth.audit("iceberg_settings_changed", None, f"{len(buckets)} storage locations, {len(overrides)} overrides")
    return _public_settings(s)


def _bucket_used(bucket_id: str) -> bool:
    return any(p.is_file() and C._json(p, {}).get("storage") == bucket_id for p in (C.DIR / "tables").glob("*.json"))


@router.get("/tools/resolve-storage")
def resolve_storage(folder_id: Optional[str] = None) -> dict:
    """What a new table in a folder would get (Iceberg enabled?, storage, client-side encryption, format version)."""
    r = C.resolve_storage(folder_id)
    return {"enabled": r["enabled"], "storage": {k: r["storage"][k] for k in ("id", "name", "provider")}, "cse": r["cse"],
            "format_version": 3 if r["cse"] else 2, "override": r["override"]}


# ------------------------------------------------------------------------------------------------
# Data Connection syncs into Iceberg tables
# ------------------------------------------------------------------------------------------------


def _syncs() -> list[dict]:
    return C._json(C.DIR / "syncs.json", [])


def _save_syncs(v: list[dict]) -> None:
    C._write(C.DIR / "syncs.json", v)


class SyncIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    connection_id: str
    database: str = ""
    schema_name: str = Field("", alias="schema")
    table: str
    columns: list[str] = []
    write_mode: Literal["overwrite", "append", "update"] = "overwrite"
    primary_key: list[str] = []
    cursor_column: Optional[str] = None
    initial_value: Optional[str] = None
    parent_id: Optional[str] = None
    output_name: Optional[str] = None
    batch_size: int = Field(10000, ge=100, le=200000)

    model_config = {"populate_by_name": True}


@router.get("/tools/syncs")
def list_syncs() -> list[dict]:
    out = []
    for s in _syncs():
        item = db.drive_get(s["table_id"]) if s.get("table_id") else None
        out.append({**s, "table_name": item["name"] if item else None, "table_path": C.namespace_of(item["id"]) if item else []})
    return out


@router.post("/tools/syncs")
def create_sync(req: SyncIn) -> dict:
    import datasources

    conn = datasources._connection_row(req.connection_id)
    if conn["kind"] not in SYNC_KINDS:
        raise HTTPException(400, "Iceberg syncs support Custom JDBC, Microsoft SQL Server, Oracle, PostgreSQL and Snowflake sources")
    if req.write_mode == "update" and not req.primary_key:
        raise HTTPException(400, "the update write mode needs a primary key column")
    with datasources._open(req.connection_id) as c:
        try:
            cols = c.get_table_schema(req.database, req.schema_name, req.table)["columns"]
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"cannot read the source table: {e}") from None
    names = [col["name"] for col in cols]
    chosen = req.columns or names
    missing = [x for x in [*chosen, *req.primary_key, *([req.cursor_column] if req.cursor_column else [])] if x not in names]
    if missing:
        raise HTTPException(400, f"columns not in the source table: {', '.join(missing)}")
    with _err():
        item = C.ensure_table(drive._folder_id(req.parent_id), (req.output_name or req.name).strip())
        C.table_item(item["id"], need="editor")
    s = {"id": f"isync-{uuid.uuid4().hex[:10]}", "name": req.name, "connection_id": req.connection_id, "connection": conn["name"], "kind": conn["kind"],
         "database": req.database, "schema": req.schema_name, "table": req.table, "columns": chosen,
         "column_types": {col["name"]: col["type"] for col in cols if col["name"] in chosen}, "write_mode": req.write_mode,
         "primary_key": req.primary_key, "cursor_column": req.cursor_column, "cursor": _initial_cursor(req, cols), "batch_size": req.batch_size,
         "all_columns": not req.columns, "table_id": item["id"], "created_by": auth.actor_id(), "created_at": C._now(), "runs": []}
    with _sync_lock:
        v = _syncs()
        v.append(s)
        _save_syncs(v)
    return s


def _initial_cursor(req: SyncIn, cols: list[dict]) -> Optional[dict]:
    """The cursor's starting value (rows after it are synced first), as the data sources store cursors."""
    from connectors import normalize as norm

    if not req.cursor_column or req.initial_value in (None, ""):
        return None
    col = next(c for c in cols if c["name"] == req.cursor_column)
    try:
        return norm.cursor_dump(norm.parse_start(req.initial_value, col["type"], bool(col.get("tz_aware"))))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"initial value: {e}") from None


@router.delete("/tools/syncs/{sync_id}")
def delete_sync(sync_id: str) -> dict:
    with _sync_lock:
        _save_syncs([s for s in _syncs() if s["id"] != sync_id])
    return {"deleted": sync_id}


@router.post("/tools/syncs/{sync_id}/run")
def run_sync(sync_id: str, wait: bool = False) -> dict:
    s = next((x for x in _syncs() if x["id"] == sync_id), None)
    if not s:
        raise HTTPException(404, "no such sync")
    with _err():
        C.table_item(s["table_id"], need="editor")
    run = {"id": f"irun-{uuid.uuid4().hex[:8]}", "status": "running", "started_at": C._now(), "finished_at": None, "rows": None, "error": None,
           "user": C._principal_label()}

    def go() -> None:
        started = time.monotonic()
        try:
            run.update(_execute(s), status="succeeded")
        except C.CatalogError as e:
            run.update(status="failed", error=e.message)
        except Exception as e:  # noqa: BLE001
            log.exception("Iceberg sync failed")
            run.update(status="failed", error=f"{type(e).__name__}: {e}"[:2000])
        run.update(finished_at=C._now(), seconds=round(time.monotonic() - started, 2))
        with _sync_lock:
            v = _syncs()
            for x in v:
                if x["id"] == sync_id:
                    x["runs"] = [run, *[r for r in x.get("runs", []) if r["id"] != run["id"]]][:30]
                    if run["status"] == "succeeded" and "cursor" in run:
                        x["cursor"] = run["cursor"]
            _save_syncs(v)

    with _sync_lock:
        v = _syncs()
        for x in v:
            if x["id"] == sync_id:
                x["runs"] = [run, *x.get("runs", [])][:30]
        _save_syncs(v)
    if wait:
        go()
    else:
        threading.Thread(target=go, daemon=True, name=f"iceberg-sync-{sync_id}").start()
    return run


def _execute(s: dict) -> dict:
    import pyarrow as pa

    import datasources
    from connectors import normalize as norm

    with datasources._open(s["connection_id"], extract=True) as c:
        cols = c.get_table_schema(s["database"], s["schema"], s["table"])["columns"]
        now_types = {col["name"]: col["type"] for col in cols}
        changed = [n for n in s["columns"] if n not in now_types or now_types[n] != s["column_types"].get(n)]
        if s.get("all_columns"):
            changed += [n for n in now_types if n not in s["columns"]]
        if changed:
            raise C.bad_request(f"the source table's schema changed ({', '.join(changed)}): schema evolution is not supported on Iceberg "
                                "syncs — create a new sync on the updated table")
        columns = [col for col in cols if col["name"] in s["columns"]]
        columns.sort(key=lambda col: s["columns"].index(col["name"]))
        batches = []
        upper = None
        if s.get("cursor_column"):
            column = s["cursor_column"]
            read = [col["name"] for col in columns] + ([column] if column not in s["columns"] else [])
            upper = c.get_incremental_metadata(s["database"], s["schema"], s["table"], column)["max"]
            lower = norm.cursor_load(s["cursor"]) if s.get("cursor") else None
            lower, upper = norm.comparable(lower, upper)
            if upper is not None and (lower is None or upper > lower):
                rows = c.read_range(s["database"], s["schema"], s["table"], read, column, lower, False, upper, None)
                batches.append([r[: len(columns)] for r in rows])
        else:
            for b in c.stream_table(s["database"], s["schema"], s["table"], [col["name"] for col in columns], s.get("batch_size") or 10000):
                batches.append(b)
    schema = norm.arrow_schema(columns)
    tables = [norm.arrow_batch(columns, b, schema) for b in batches if b]
    data = pa.concat_tables(tables) if tables else schema.empty_table()
    data = iceberg_write.supported_arrow(data)
    writer = {"kind": "sync", "label": f"Data Connection sync {s['name']} ({s['write_mode']})"}
    tbl = C.server_table(s["table_id"], writer=writer)
    if tbl.metadata.format_version >= 3:
        raise C.bad_request("format version 3 tables cannot be written by syncs yet (PyIceberg writes v2)")
    empty = not tbl.schema().fields and not tbl.metadata.snapshots
    if s["write_mode"] == "overwrite" or empty:
        if s["write_mode"] == "update" and s["primary_key"]:
            data = _dedupe(data, s["primary_key"])
        iceberg_write.replace_contents(tbl, data)
    elif s["write_mode"] == "append":
        if data.num_rows:
            tbl = iceberg_write.evolve_to(tbl, data.schema)
            tbl.append(iceberg_write.prepare(tbl, data))
    else:
        if data.num_rows:
            data = _dedupe(data, s["primary_key"])
            iceberg_write.upsert_rows(tbl, data, s["primary_key"])
    out: dict[str, Any] = {"rows": data.num_rows}
    if s.get("cursor_column") and upper is not None:
        out["cursor"] = norm.cursor_dump(upper)
    return out


def _dedupe(data, keys: list[str]):
    """One row per key (the last one): update syncs upsert by key."""
    import pyarrow as pa

    seen: dict[tuple, int] = {}
    cols = [data.column(k).to_pylist() for k in keys]
    for i in range(data.num_rows):
        seen[tuple(c[i] for c in cols)] = i
    return data.take(pa.array(sorted(seen.values()), type=pa.int64())) if len(seen) != data.num_rows else data


# ------------------------------------------------------------------------------------------------
# resource usage
# ------------------------------------------------------------------------------------------------


def usage(since: Optional[datetime] = None, days: Optional[int] = None) -> dict:
    """Iceberg storage (live data and delete files of main's latest snapshot, Foundry-managed storage only) and the
    compute of maintenance jobs and syncs, for Resource Management."""
    import iceberg_maintenance as M

    # a 1-vCPU container at Resource Management's rate (resource_usage.rate(1, 1))
    rate = 0.5
    tables = []
    total = 0
    for it in C.all_tables():
        try:
            rec = C.record(it["id"])
        except C.CatalogError:
            continue
        managed = C.bucket(rec.get("storage"))["provider"] == "managed"
        size = int(it.get("size_bytes") or 0)
        if managed:
            total += size
        cs = 0.0
        for j in M._state(it["id"])["jobs"]:
            if since and j.get("started_at") and j["started_at"] < since.isoformat():
                continue
            cs += float(j.get("seconds") or 0) * rate
        tables.append({"id": it["id"], "name": it["name"], "path": C.namespace_of(it["id"]), "bytes": size if managed else None,
                       "byob": not managed, "maintenance_compute_seconds": round(cs, 2)})
    sync_cs = 0.0
    for s in _syncs():
        for r in s.get("runs") or []:
            if since and r.get("started_at") and r["started_at"] < since.isoformat():
                continue
            sync_cs += float(r.get("seconds") or 0) * rate
    gb = total / 1024 ** 3
    if days is None:
        days = max(1, round((datetime.now(timezone.utc) - since).total_seconds() / 86400)) if since else 30
    # storage is measured over time: today's size held for the window (100 GB for a month = 100 gigabyte-months)
    return {"tables": sorted(tables, key=lambda t: -(t["bytes"] or 0)), "storage_bytes": total, "gigabytes": round(gb, 6),
            "gigabyte_months": round(gb * days / 30, 6), "days": days, "maintenance_compute_seconds": round(sum(t["maintenance_compute_seconds"] for t in tables), 2),
            "sync_compute_seconds": round(sync_cs, 2)}


@router.get("/tools/usage")
def usage_route(days: int = 30) -> dict:
    from datetime import timedelta

    days = max(1, min(days, 365))
    return usage(datetime.now(timezone.utc) - timedelta(days=days), days)


def configure(_data_dir: Any = None) -> None:
    pass
