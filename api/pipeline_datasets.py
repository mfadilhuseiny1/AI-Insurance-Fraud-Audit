"""Pipeline Builder in the Files tab: a pipeline is a `.pipeline` file (its JSON definition, with the
datasets added to it) in a Drive folder; deploying a pipeline output writes it as a Parquet file into
a Drive folder (the output's location, else the pipeline's), and pipelines can read Parquet files
from the Drive back as input data.

The browser runs the pipeline and sends the output's rows here; this module only converts between
the pipeline's column types and Parquet (pyarrow) and stores the file through drive.py.

Mounted by server.py under /api/pipeline.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import threading
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import auth
import dataset_versions
import db
import drive
import storage

router = APIRouter(prefix="/api/pipeline")
log = logging.getLogger("bluesandai.pipeline_datasets")

PARQUET = "application/vnd.apache.parquet"
PIPELINE = "application/vnd.bluesandai.pipeline+json"
PIPELINE_EXT = ".pipeline"
# a deployed output is sent as JSON rows; past this many it should be split or filtered first
MAX_ROWS = 2_000_000

# pipeline column type → Parquet type
ARROW: dict[str, pa.DataType] = {
    "String": pa.string(),
    "Boolean": pa.bool_(),
    "Byte": pa.int8(),
    "Short": pa.int16(),
    "Integer": pa.int32(),
    "Long": pa.int64(),
    "Float": pa.float32(),
    "Double": pa.float64(),
    "Decimal": pa.decimal128(38, 18),
    "Date": pa.date32(),
    "Timestamp": pa.timestamp("us", tz="UTC"),
    "Binary": pa.binary(),
}


class Column(BaseModel):
    name: str
    type: str


class DeployRequest(BaseModel):
    name: str
    # folder to create the file in (None = top level); ignored when item_id is still a live file
    parent_id: Optional[str] = None
    # the file a previous deploy of this output created: what the write mode replaces, merges with or adds to
    item_id: Optional[str] = None
    # Pipeline Builder's output write modes (the caller resolves Default to snapshot or append);
    # alwaysAppend is append
    mode: Literal[
        "snapshot", "append", "alwaysAppend", "snapshotReplace", "snapshotReplaceRemove",
        "changelog", "appendNewRows", "directChangelog", "snapshotNewRows",
    ] = "snapshot"
    # the keyed modes: the primary key, the post-filtering column, the direct changelog's columns
    primary_key: list[str] = []
    post_filter: Optional[str] = None
    changelog_timestamp: Optional[str] = None
    changelog_deleted: Optional[str] = None
    # replay from the start of the input data: the previous output is ignored (the result is a SNAPSHOT)
    reset: bool = False
    # "iceberg": a Foundry Iceberg table output (the folder's Project must have Iceberg storage)
    format: Literal["dataset", "iceberg"] = "dataset"
    columns: list[Column]
    rows: list[dict[str, Any]]
    # the pipeline and output writing it, recorded for Data Lineage (lineage.py)
    pipeline_id: Optional[str] = None
    output_id: Optional[str] = None
    output_name: Optional[str] = None


def _value(v: Any, kind: str) -> Any:
    """A JSON cell as the Python value pyarrow expects for the column type."""
    if v is None:
        return None
    if kind == "Date":
        return date.fromisoformat(str(v)[:10])
    if kind == "Timestamp":
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(timezone.utc)
    if kind == "Binary":
        return base64.b64decode(str(v))
    if kind == "Decimal":
        try:
            return Decimal(str(v)).quantize(Decimal(1).scaleb(-18))
        except InvalidOperation:
            return None
    return v


def _to_arrow(columns: list[Column], rows: list[dict[str, Any]]) -> pa.Table:
    names = [c.name for c in columns]
    if len(set(names)) != len(names):
        raise HTTPException(400, "column names must be unique")
    arrays, fields = [], []
    for c in columns:
        t = ARROW.get(c.type)
        if t is None:
            raise HTTPException(400, f'unknown column type "{c.type}" for "{c.name}"')
        try:
            arrays.append(pa.array([_value(r.get(c.name), c.type) for r in rows], type=t))
        except (ValueError, TypeError, pa.ArrowException) as e:
            raise HTTPException(400, f'column "{c.name}" ({c.type}): {e}') from e
        fields.append(pa.field(c.name, t))
    return pa.Table.from_arrays(arrays, schema=pa.schema(fields))


def _parquet_bytes(table: pa.Table) -> bytes:
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="snappy")
    return buf.getvalue()


def _replace_content(item: dict, data: bytes, content_type: str = PARQUET) -> None:
    """New contents for an existing Drive file (same id, so links and shares keep working)."""
    if item["stored_in"] == "s3":
        storage.put_fileobj(f"drive/{item['id']}", io.BytesIO(data), content_type)
    else:
        # flushed to the disk before the metadata says it changed: a power cut after a write without it left the file
        # its new size but zeros (2026-10-27, five silver datasets)
        with open(drive.LOCAL_DIR / item["id"], "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    db.drive_update(item["id"], drive._now(), size_bytes=len(data), content_type=content_type)


def _live_file(item_id: Optional[str]) -> Optional[dict]:
    """The file a previous deploy wrote, unless it was deleted or trashed since."""
    if not item_id:
        return None
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or item["kind"] != "file":
        return None
    return item


# ------------------------------------------------------------------------------------------------
# outputs marked before they are written: never a moment with their rows readable without their inputs' markings
# ------------------------------------------------------------------------------------------------


def output_sources(pipeline_id: Optional[str]) -> list[str]:
    """What a pipeline's output inherits its markings from: the pipeline and the Files items it reads."""
    return [pipeline_id, *_pipeline_input_items(pipeline_id)] if pipeline_id else []


def output_markings(sources: list[str]) -> set[str]:
    marks: set[str] = set()
    for src in sources:
        marks |= auth.effective_markings(src)
    return marks


def check_output_constraints(existing: Optional[dict], parent_id: Optional[str], marks: set[str], what: str = "deploy") -> None:
    """Project constraints, before writing: the markings the output would carry (its own and its folder's, and what it
    inherits from the pipeline and its inputs). 409 when they violate its Project's constraints."""
    target = existing["id"] if existing else parent_id
    if not target:
        return
    own = set(auth._item_row(existing["id"])[0]) if existing else set()
    why = auth.constraint_violation(target, marks | own | auth.file_markings(target))
    if why:
        raise HTTPException(409, f"{why}: the {what} is refused before writing")


def widen_before_write(item_id: str, marks: set[str]) -> None:
    """Before an existing output's contents are replaced: it gains the markings of what the new contents are built from
    (it keeps the ones it inherited so far until the write is done; narrowed after, by auth.propagate)."""
    cur = set(auth._item_row(item_id)[1])
    if not marks <= cur:
        auth._set_item(item_id, inherited=sorted(cur | marks))


def store_marked(parent_id: Optional[str], name: str, data: bytes, content_type: str, marks: set[str]) -> dict:
    """A new output file created already carrying `marks` (inherited): the markings record is written under a fresh,
    unused item id first, then the file is stored under that id (drive._store takes the id), so no reader ever finds
    it in Files, or reads its contents, without them. Without markings: as drive.save_bytes."""
    if not marks:
        return drive.save_bytes(parent_id, name, data, content_type)
    folder = drive._folder_id(parent_id)  # the folder's checks (as drive.save_bytes) before any markings record
    while True:
        item_id = uuid.uuid4().hex[:16]
        if not db.drive_get(item_id) and auth._item_row(item_id) == ([], []):
            break
    auth._set_item(item_id, inherited=sorted(marks))
    try:
        item = drive._public(drive._store(folder, drive._clean_name(name), io.BytesIO(data), len(data), content_type, item_id=item_id))
    except BaseException:
        if not db.drive_get(item_id):
            auth._set_item(item_id, inherited=[])  # nothing was created: no markings record for an id nobody holds
        raise
    if item["id"] != item_id:
        # drive._store refused the id (taken meanwhile) and stored the contents under another one, unmarked: remove it
        # at once rather than leave it readable, and fail the write
        auth._set_item(item_id, inherited=[])
        drive._delete_contents(db.drive_delete(item["id"], drive._now()))
        raise HTTPException(500, "the output could not be created under its marked id: nothing was written")
    return item


# write modes that output a SNAPSHOT transaction; the others APPEND
SNAPSHOT_MODES = {"snapshot", "snapshotReplace", "snapshotReplaceRemove", "snapshotNewRows"}
KEYED_MODES = {"snapshotReplace", "snapshotReplaceRemove", "changelog", "appendNewRows", "directChangelog", "snapshotNewRows"}
CHANGELOG_TS, CHANGELOG_DELETED = "_changelog_timestamp", "_is_deleted"


def _cell_key(v: Any) -> str:
    return json.dumps(v, default=str, sort_keys=True)


def _keys(table: pa.Table, cols: list[str]) -> list[tuple]:
    """The primary key of each row (JSON text per column, so any cell type compares)."""
    data = [table.column(c).to_pylist() for c in cols]
    return [tuple(_cell_key(v) for v in row) for row in zip(*data)] if data else []


def _take(table: pa.Table, idx: list[int]) -> pa.Table:
    return table.take(pa.array(idx, type=pa.int64()))


def _one_per_key(table: pa.Table, keys: list[tuple]) -> pa.Table:
    """One row per key (the last one), in their order."""
    last = {k: i for i, k in enumerate(keys)}
    return _take(table, sorted(last.values()))


def apply_write_mode(req: DeployRequest, new: pa.Table, old: Optional[pa.Table], now: datetime) -> pa.Table:
    """What the output holds after this deploy, given its previous contents (None: none, or reset)."""
    mode = "append" if req.mode == "alwaysAppend" else req.mode
    pk = req.primary_key
    if mode in KEYED_MODES:
        if not pk:
            raise HTTPException(400, f"the {mode} write mode needs a primary key")
        for c in pk:
            if c not in new.column_names:
                raise HTTPException(400, f'the primary key column "{c}" is not in the output')
    if mode == "changelog":
        if CHANGELOG_TS in new.column_names or CHANGELOG_DELETED in new.column_names:
            raise HTTPException(400, f'the changelog write mode adds "{CHANGELOG_TS}" and "{CHANGELOG_DELETED}" — rename those output columns')
        new = new.append_column(pa.field(CHANGELOG_TS, ARROW["Timestamp"]), pa.array([now] * new.num_rows, type=ARROW["Timestamp"]))
        new = new.append_column(pa.field(CHANGELOG_DELETED, pa.bool_()), pa.array([False] * new.num_rows, type=pa.bool_()))
    if mode == "directChangelog":
        for label, c in (("timestamp", req.changelog_timestamp), ("deletion", req.changelog_deleted)):
            if not c or c not in new.column_names:
                raise HTTPException(400, f"the direct changelog write mode needs its {label} column in the output")
        if new.schema.field(req.changelog_deleted).type != pa.bool_():
            raise HTTPException(400, f'the deletion column "{req.changelog_deleted}" must be Boolean')
    if mode == "snapshotReplaceRemove":
        if not req.post_filter or req.post_filter not in new.column_names:
            raise HTTPException(400, "snapshot replace and remove needs its post-filtering column in the output")
        if new.schema.field(req.post_filter).type != pa.bool_():
            raise HTTPException(400, f'the post-filtering column "{req.post_filter}" must be Boolean')
    if mode in KEYED_MODES and mode != "changelog" and mode != "directChangelog":
        for c in pk:
            if new.column(c).null_count:
                raise HTTPException(400, f'the primary key column "{c}" has nulls')

    if old is not None and mode != "snapshot" and old.schema != new.schema:
        raise HTTPException(
            409,
            f"the {mode} write mode needs the same columns and types as the deployed dataset — "
            "deploy with Replay from start of input data to change them",
        )
    if mode == "snapshot":
        return new
    if old is None:
        old = new.slice(0, 0)

    if mode in ("append", "directChangelog"):
        return pa.concat_tables([old, new])
    new_keys = _keys(new, pk)
    old_keys = _keys(old, pk)
    if mode == "snapshotReplace":
        kept = set(new_keys)
        return pa.concat_tables([_take(old, [i for i, k in enumerate(old_keys) if k not in kept]), _one_per_key(new, new_keys)])
    if mode == "snapshotReplaceRemove":
        # every key in the new data leaves the old data; only its TRUE rows are stored
        flags = new.column(req.post_filter).to_pylist()
        stored_idx = [i for i, f in enumerate(flags) if f is True]
        stored = _take(new, stored_idx)
        kept = set(new_keys)
        return pa.concat_tables([
            _take(old, [i for i, k in enumerate(old_keys) if k not in kept]),
            _one_per_key(stored, [new_keys[i] for i in stored_idx]),
        ])
    if mode == "appendNewRows":
        seen = set(old_keys)
        last: dict[tuple, int] = {}
        for i, k in enumerate(new_keys):
            if k not in seen:
                last[k] = i
        return pa.concat_tables([old, _take(new, sorted(last.values()))])
    if mode == "snapshotNewRows":
        seen = set(old_keys)
        return _take(new, [i for i, k in enumerate(new_keys) if k not in seen])
    if mode == "changelog":
        # a change: a key not seen yet, or a row that differs from the key's latest version
        values = [c for c in new.column_names if c not in (CHANGELOG_TS, CHANGELOG_DELETED)]
        latest: dict[tuple, str] = {}
        for k, row in zip(old_keys, old.select(values).to_pylist()):
            latest[k] = _cell_key(row)
        changed: dict[tuple, int] = {}
        for i, (k, row) in enumerate(zip(new_keys, new.select(values).to_pylist())):
            if latest.get(k) != _cell_key(row):
                changed[k] = i
        return pa.concat_tables([old, _take(new, sorted(changed.values()))])
    raise HTTPException(400, f"unknown write mode {req.mode}")


def _build_identity(request: Optional[Request], op: str, existing: Optional[dict], parent_id: Optional[str] = None, label: Optional[str] = None,
                    more: Optional[list] = None) -> None:
    """The build runner calling for a build (pipeline_runtime.enforce_build_identity): a write into the dataset it
    replaces (or the folder it creates it in), a read of a dataset, as the build's identity; `more`: further checks."""
    if request is None:
        return
    import pipeline_runtime

    if existing:
        pipeline_runtime.enforce_build_identity(request, op, "item", existing["id"], label, more)
    else:
        pipeline_runtime.enforce_build_identity(request, op, "folder", parent_id, label, more)


def _check_deploy_target(item_id: Optional[str], pipeline_id: Optional[str] = None) -> None:
    """Writing over an existing dataset needs its markings and the Editor role on its Project (the build runner,
    with the service token, passes); a deploy recorded for a pipeline needs Editor on that pipeline. A new file's
    folder is checked where it is created (drive.save_bytes)."""
    import auth

    existing = _live_file(item_id)
    if existing:
        auth.check_item(existing, "editor")
    if pipeline_id:
        auth.check_item_id(pipeline_id, "editor")
        # the output inherits the markings of the pipeline's inputs: a user deploys only from inputs they can read
        p = auth.current()
        if auth.enabled() and p is not None and not p.get("service"):
            for iid in _pipeline_input_items(pipeline_id):
                if not auth.can_access(iid):
                    name = (db.drive_get(iid) or {}).get("name") or iid
                    raise HTTPException(403, f"You cannot read the input {name} of this pipeline: its outputs are deployed with your access",
                                        headers=auth.access_header("marking", markings=sorted(auth.effective_markings(iid))))


@router.post("/datasets/deploy")
def deploy(req: DeployRequest, request: Request = None) -> dict:  # type: ignore[assignment]
    drive._require_db()
    if len(req.rows) > MAX_ROWS:
        raise HTTPException(413, f"{len(req.rows):,} rows — deploy at most {MAX_ROWS:,} at a time")
    _check_deploy_target(req.item_id, req.pipeline_id)
    if request is not None and request.headers.get("x-bsai-build"):
        # the output carries its inputs' data: the build's identity must still read them (as a user deploying must)
        _build_identity(request, "write", _live_file(req.item_id), req.parent_id, req.output_name or req.name,
                        [("read", "item", iid, None) for iid in dict.fromkeys(_pipeline_input_items(req.pipeline_id))] if req.pipeline_id else None)
    new = _to_arrow(req.columns, req.rows)
    if req.format == "iceberg":
        return _deploy_iceberg(req, new)
    existing = _live_file(req.item_id)
    old = None
    if existing and not req.reset and req.mode != "snapshot":
        old = pq.read_table(io.BytesIO(drive.read_bytes(existing)))
    table = apply_write_mode(req, new, old, datetime.now(timezone.utc))
    transaction = "SNAPSHOT" if req.reset or req.mode in SNAPSHOT_MODES else "APPEND"
    # rows the transaction holds: an APPEND adds to the previous rows
    written = table.num_rows - (old.num_rows if old is not None and transaction == "APPEND" else 0)
    # an empty write is aborted (no file written, no transaction) when the dataset's policy says so
    if existing and dataset_versions.abort_if_empty(existing["id"], written, {"kind": "pipeline", "id": req.pipeline_id,
                                                                            "name": req.output_name or req.name, "mode": req.mode}):
        current = pq.ParquetFile(io.BytesIO(drive.read_bytes(existing))).metadata
        return {"item": drive._with_path(drive._item(existing["id"])), "rows": current.num_rows, "columns": current.num_columns,
                "transaction": "ABORTED", "written": 0, "aborted": True}
    item = commit_output(existing, req.parent_id, req.name, _parquet_bytes(table), table.num_rows, req.pipeline_id, req.output_id,
                         req.output_name or req.name, req.mode, transaction, written)
    return {"item": drive._with_path(item), "rows": table.num_rows, "columns": table.num_columns,
            "transaction": transaction, "written": written}


def commit_output(existing: Optional[dict], parent_id: Optional[str], name: str, data: bytes, rows: int, pipeline_id: Optional[str],
                  output_id: Optional[str], output_name: str, mode: str, transaction: str, written: int) -> dict:
    """Write a pipeline output's Parquet bytes into Files (over `existing`, else as a new file named `name`): markings,
    lineage record and dataset version as a deploy. Also the DuckDB local engine's write (pipeline_duckdb.py)."""
    sources = output_sources(pipeline_id)
    # the markings the output inherits from the pipeline and its inputs: checked against the Project's constraints and
    # set BEFORE the rows are written (a new file is created already marked; an existing one gains them before the
    # replace), so no reader ever sees the new rows without them
    marks = output_markings(sources)
    if pipeline_id:
        check_output_constraints(existing, parent_id, marks)
    if existing:
        widen_before_write(existing["id"], marks)
        _replace_content(existing, data)
        item = drive._item(existing["id"])
    else:
        name = name.strip()
        if not name.lower().endswith(".parquet"):
            name += ".parquet"
        item = drive._item(store_marked(parent_id, name, data, PARQUET, marks)["id"])
    if pipeline_id:
        # markings propagate down the lineage: narrowed to exactly those of the pipeline and its inputs (a marking an
        # input lost since stays until its old rows are replaced, i.e. until now)
        try:
            auth.propagate(item["id"], sources)
        except Exception:  # noqa: BLE001 - never fails the deploy
            log.exception("marking propagation failed for %s", item["id"])
        record_deploy(item["id"], {"pipeline_id": pipeline_id, "output_id": output_id, "output": output_name,
                                   "at": drive._now(), "rows": rows, "mode": mode,
                                   "transaction": transaction, "written": written})
    # kept for the dataset's history and rollback in Data Lineage
    dataset_versions.record(item["id"], data, "deploy", {"kind": "pipeline", "id": pipeline_id, "name": output_name,
                                                         "mode": mode, "transaction": transaction, "written": written})
    return item


def _deploy_iceberg(req: DeployRequest, new: pa.Table) -> dict:
    """A pipeline output written to a Foundry Iceberg table: a snapshot write replaces the rows (one overwrite
    snapshot, the schema follows the output), append adds an append snapshot, the keyed modes merge with the
    table's rows. The table inherits the markings of the pipeline and its inputs, recorded on the snapshot: checked
    against the Project's constraints before anything is written (409), and a new table is created already carrying
    them (an existing one gains them in the commit, before its new rows are visible)."""
    import iceberg_catalog as ic
    import iceberg_write

    with ic.http_errors():
        marks = output_markings(output_sources(req.pipeline_id))
        existing = db.drive_get(req.item_id) if req.item_id else None
        folder_id = None
        if not (existing and ic.is_table(existing) and not existing.get("trashed_at")):
            # the table at folder/name (as iceberg_catalog.ensure_table), created below when missing
            folder_id = drive._folder_id(req.parent_id)
            name = req.name.strip()
            existing = next((c for c in db.drive_list(folder_id) if c["name"] == name), None)
            if existing and not ic.is_table(existing):
                raise ic.bad_request(f'"{name}" already exists and is not an Iceberg table')
        if req.pipeline_id:
            check_output_constraints(existing, folder_id, marks)
        # a new table exists only under an id already carrying the markings, so no reader ever finds it without them
        item = existing or ic.create_table(folder_id, name, markings=sorted(marks))
        ic.table_item(item["id"], need="editor")
        extra = {"foundry.markings": ",".join(sorted(marks))} if marks else {}
        writer = {"kind": "pipeline", "label": f"Pipeline Builder · {req.output_name or req.name}"}
        tbl = ic.server_table(item["id"], writer=writer, snapshot_extra=extra)
        if tbl.metadata.format_version >= 3:
            raise ic.bad_request("format version 3 Iceberg tables cannot be written by Pipeline Builder yet (PyIceberg writes v2)")
        empty = not tbl.schema().fields and not tbl.metadata.snapshots
        old = None if empty or req.reset or req.mode == "snapshot" else tbl.scan().to_arrow()
        mode = "append" if req.mode == "alwaysAppend" else req.mode
        if old is not None and mode != "snapshot":
            old = old.select(new.column_names) if set(new.column_names) <= set(old.column_names) else old
        if mode == "append" and old is not None and not req.reset:
            tbl = iceberg_write.evolve_to(tbl, new.schema)
            tbl.append(iceberg_write.prepare(tbl, new))
            transaction, written, total = "APPEND", new.num_rows, old.num_rows + new.num_rows
        else:
            table = apply_write_mode(req, new, old.cast(new.schema) if old is not None and old.schema != new.schema else old,
                                     datetime.now(timezone.utc))
            iceberg_write.replace_contents(tbl, table)
            transaction, written, total = "SNAPSHOT", table.num_rows, table.num_rows
    if req.pipeline_id:
        record_deploy(item["id"], {"pipeline_id": req.pipeline_id, "output_id": req.output_id, "output": req.output_name or req.name, "at": drive._now(),
                                   "rows": total, "mode": req.mode, "transaction": transaction, "written": written, "format": "iceberg"})
    return {"item": drive._with_path(drive._item(item["id"])), "rows": total, "columns": new.num_columns, "transaction": transaction,
            "written": written, "format": "iceberg"}


DEPLOYS_KEPT = 50
_deploys_lock = threading.Lock()


def _deploys_path() -> Path:
    return drive.LOCAL_DIR.parent / "lineage" / "deploys.json"


def record_deploy(item_id: str, rec: dict) -> None:
    """Which pipeline wrote a dataset, and when: dataset item id -> recent deploys, newest first."""
    path = _deploys_path()
    with _deploys_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(path.read_text("utf-8"))
        except (FileNotFoundError, ValueError):
            data = {}
        data[item_id] = [rec, *data.get(item_id, [])][:DEPLOYS_KEPT]
        tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
        tmp.write_text(json.dumps(data), "utf-8")
        tmp.replace(path)


def deploys() -> dict[str, list[dict]]:
    try:
        return json.loads(_deploys_path().read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _column_type(t: pa.DataType) -> str:
    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_int8(t) or pa.types.is_uint8(t):
        return "Byte"
    if pa.types.is_int16(t) or pa.types.is_uint16(t):
        return "Short"
    if pa.types.is_int32(t):
        return "Integer"
    if pa.types.is_integer(t):
        return "Long"
    if pa.types.is_float32(t) or pa.types.is_float16(t):
        return "Float"
    if pa.types.is_floating(t):
        return "Double"
    if pa.types.is_decimal(t):
        return "Decimal"
    if pa.types.is_date(t):
        return "Date"
    if pa.types.is_timestamp(t):
        return "Timestamp"
    if pa.types.is_binary(t) or pa.types.is_large_binary(t) or pa.types.is_fixed_size_binary(t):
        return "Binary"
    return "String"


def _cell(v: Any, kind: str) -> Any:
    """A Parquet value as the pipeline holds it (JSON)."""
    if v is None:
        return None
    if kind == "Date":
        return v.isoformat()
    if kind == "Timestamp":
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if kind == "Binary":
        return base64.b64encode(v).decode()
    if kind == "Decimal":
        return float(v)
    if kind == "Long" and not -(2**53) <= v <= 2**53:
        # beyond what JavaScript holds exactly
        return float(v)
    if kind == "String" and not isinstance(v, str):
        # lists, structs and maps as JSON text
        return json.dumps(v, default=str)
    return v


@router.get("/datasets/{item_id}/table")
def read_table(item_id: str, limit: Optional[int] = None, request: Request = None) -> dict:  # type: ignore[assignment]
    """A Parquet file of the Drive (or an Iceberg table, rows in append order) as columns and rows for a pipeline
    input; with `limit`, only the first rows (the Files tab preview), plus total_rows."""
    drive._require_db()
    item = drive._item(item_id)
    _build_identity(request, "read", item)
    if item["kind"] != "file":
        raise HTTPException(400, "not a file")
    import iceberg_catalog

    if iceberg_catalog.is_table(item):
        with iceberg_catalog.http_errors():
            table = iceberg_catalog.ordered_rows(item_id, limit=limit)
            total = iceberg_catalog.describe(item)["records"] if limit is not None else table.num_rows
        return {**table_payload(table, item["name"]), "total_rows": total}
    try:
        f = pq.ParquetFile(io.BytesIO(drive.read_bytes(item)))
        if limit is None:
            table = f.read()
        else:
            batches = []
            for batch in f.iter_batches(batch_size=max(1, min(limit, 10_000))):
                batches.append(batch)
                if sum(b.num_rows for b in batches) >= limit:
                    break
            table = pa.Table.from_batches(batches, schema=f.schema_arrow).slice(0, max(0, limit))
    except (pa.ArrowException, OSError) as e:
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet file: {e}') from e
    return {**table_payload(table, item["name"]), "total_rows": f.metadata.num_rows}


def table_payload(table: pa.Table, name: str) -> dict:
    """An Arrow table as the pipeline's {columns (pipeline types), rows (JSON cells), name}."""
    if table.num_rows > MAX_ROWS:
        raise HTTPException(413, f"{table.num_rows:,} rows — pipelines in the browser read at most {MAX_ROWS:,}")
    kinds = [_column_type(f.type) for f in table.schema]
    names = table.column_names
    columns = [{"name": n, "type": k} for n, k in zip(names, kinds)]
    # column descriptions and typeclasses written by code transforms live in the Parquet field metadata
    for c, f in zip(columns, table.schema):
        md = f.metadata or {}
        if b"description" in md:
            c["description"] = md[b"description"].decode("utf-8", "replace")
        if b"typeclasses" in md:
            try:
                c["typeclasses"] = json.loads(md[b"typeclasses"])
            except ValueError:
                pass
    data = [table.column(i).to_pylist() for i in range(table.num_columns)]
    rows = [{n: _cell(data[i][r], kinds[i]) for i, n in enumerate(names)} for r in range(table.num_rows)]
    return {"columns": columns, "rows": rows, "name": name}


# ------------------------------------------------------------------------------------------------
# pipeline files
# ------------------------------------------------------------------------------------------------


class NewPipelineFile(BaseModel):
    name: str
    # where the pipeline's own folder is created; the default Datapipeline folder when missing
    parent_id: Optional[str] = None
    content: dict[str, Any]


class PipelineFileChange(BaseModel):
    content: dict[str, Any]
    # renames the file (the extension is added)
    name: Optional[str] = None
    # the file's updated_at when the editor read it: a save over a newer version is refused (409), so an editor open
    # since before someone else saved never silently overwrites that save. Scripts that rewrite the file leave it out.
    base_updated_at: Optional[str] = None


def _same_version(a: Any, b: Any) -> bool:
    """Two updated_at values (datetime or ISO text, any offset) as the same instant, to the second."""
    from datetime import datetime

    def at(v: Any) -> Optional[datetime]:
        if isinstance(v, datetime):
            return v
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None

    x, y = at(a), at(b)
    if x is None or y is None:
        return False
    try:
        return abs((x - y).total_seconds()) < 1
    except TypeError:  # one without an offset: not comparable, so not refused
        return True


def _pipeline_name(name: str) -> str:
    name = name.strip()
    return name if name.lower().endswith(PIPELINE_EXT) else name + PIPELINE_EXT


def _pipeline_input_items(pipeline_id: str) -> list[str]:
    """Files items a pipeline reads: datasets, media folders and the datasets of Data Connection syncs."""
    try:
        content = json.loads(drive.read_bytes(db.drive_get(pipeline_id)))
    except Exception:  # noqa: BLE001
        return []
    return content_input_items(content)


def content_input_items(content: dict) -> list[str]:
    """Files items the datasets of a pipeline's content read."""
    out: list[str] = []
    for d in (content.get("datasets") or {}).values():
        out += _ref_items((d or {}).get("ref") or {})
    return out


def _ref_items(ref: dict) -> list[str]:
    """The Files item(s) behind a dataset reference: a dataset, a media folder or a Data Connection sync's dataset."""
    if not isinstance(ref, dict):
        return []
    if ref.get("kind") == "drive" and ref.get("itemId"):
        return [ref["itemId"]]
    if ref.get("kind") == "media" and ref.get("folderId"):
        return [ref["folderId"]]
    if ref.get("kind") == "datasource" and ref.get("id"):
        try:
            import datasources

            item_id = (datasources._source_row(ref["id"]).get("state") or {}).get("item_id")
            return [item_id] if item_id else []
        except Exception:  # noqa: BLE001
            return []
    return []


def _restricted_refs(content: Any) -> dict[str, bool]:
    """Every dataset reference in a pipeline's content (main, branches, saved versions) whose Files items the caller
    cannot read: {reference as JSON: True}. Empty with sign-in off and for the system (the build runner)."""
    import auth

    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return {}
    out: dict[str, bool] = {}
    seen: dict[str, bool] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ref = node.get("ref")
            if isinstance(ref, dict) and "rows" in node:
                key = json.dumps(ref, sort_keys=True, default=str)
                if key not in seen:
                    seen[key] = any(not auth.can_access(i) for i in _ref_items(ref))
                if seen[key]:
                    out[key] = True
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(content)
    return out


def _ref_rows(content: Any, restricted: dict[str, bool], replace: Optional[dict[str, list]] = None) -> dict[str, list]:
    """The rows an input added from Files keeps in the pipeline file (a copy of the dataset, for the editor's
    previews) are the dataset's data: for the references in `restricted`, set them to `replace`'s rows (or none, and
    mark the input restricted) in place; returns the rows found per reference."""
    found: dict[str, list] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ref = node.get("ref")
            if isinstance(ref, dict) and "rows" in node:
                key = json.dumps(ref, sort_keys=True, default=str)
                found.setdefault(key, node.get("rows") or [])
                if key in restricted:
                    if replace is None:
                        node["rows"] = []
                        node["restricted"] = True
                    else:
                        node["rows"] = replace.get(key) or []
                        node.pop("restricted", None)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(content)
    return found


def _pipeline_item(item_id: str) -> dict:
    item = drive._item(item_id)
    if item["kind"] != "file" or not item["name"].lower().endswith(PIPELINE_EXT):
        raise HTTPException(400, f'"{item["name"]}" is not a pipeline')
    return item


@router.get("/files")
def list_pipelines(tests: bool = True) -> list[dict]:
    """Every pipeline file in the Files tab (not in the trash), newest first, with its location and a `test` flag
    (test_space.py: "(test)" in its name or a folder above it). tests=false leaves the test pipelines out."""
    drive._require_db()
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND lower(d.name) LIKE %s", (f"%{PIPELINE_EXT}",), limit=5000)
    import auth
    import test_space

    out = []
    for i in auth.visible(items):
        x = drive._with_path(i)
        x["test"] = test_space.is_test_item(x)
        if tests or not x["test"]:
            out.append(x)
    return out


@router.get("/default-folder")
def default_folder() -> dict:
    """My Project / Datapipeline, where new pipelines get their folder by default."""
    drive._require_db()
    return drive._with_path(drive._item(drive.default_folder("pipelines")))


@router.post("/files")
def create_pipeline(req: NewPipelineFile) -> dict:
    """A folder for the pipeline (named after it) with the .pipeline file inside; deployed datasets go there too."""
    drive._require_db()
    parent = drive._folder_id(req.parent_id) if req.parent_id else drive.default_folder("pipelines")
    auth.check_item_id(parent, "editor")
    folder_name = drive._clean_name(drive.BAD_NAME.sub("_", req.name.strip() or "Pipeline"))
    folder_id = drive._insert_container(parent, "folder", drive._free_name(parent, folder_name))
    data = json.dumps(req.content).encode()
    item = drive.save_bytes(folder_id, _pipeline_name(folder_name), data, PIPELINE)
    return drive._with_path(drive._item(item["id"]))


@router.get("/files/{item_id}")
def read_pipeline(item_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    drive._require_db()
    item = _pipeline_item(item_id)
    if request is not None:
        # the runner reading the pipeline it builds: as the build's identity
        import pipeline_runtime

        pipeline_runtime.enforce_build_identity(request, "read", "pipeline", item["id"])
    try:
        content = json.loads(drive.read_bytes(item))
    except (ValueError, OSError) as e:
        raise HTTPException(400, f'"{item["name"]}" could not be read: {e}') from e
    # markings: the copy of an input's rows kept in the file is that input's data — left out for a caller who cannot
    # read the input (the input shows as restricted; builds read the live input with their own checks)
    restricted = _restricted_refs(content)
    if restricted:
        _ref_rows(content, restricted)
    return {"item": drive._with_path(item), "content": content}


@router.put("/files/{item_id}")
def save_pipeline(item_id: str, req: PipelineFileChange) -> dict:
    drive._require_db()
    item = _pipeline_item(item_id)
    # saving logic, schedules and settings needs the Editor role on the pipeline's Project
    auth.check_item(item, "editor")
    if item.get("trashed_at"):
        raise HTTPException(409, "the pipeline is in the trash — restore it to keep editing")
    if req.base_updated_at and not _same_version(req.base_updated_at, item.get("updated_at")):
        raise HTTPException(409, "this pipeline was saved somewhere else after you opened it — reload the page to get the latest version "
                                 "(saving from here would overwrite that save)")
    if isinstance(req.content, dict):
        # schedules: Editors of their scoped Projects add, change and delete them; the last one to change one owns it
        import pipeline_schedules

        try:
            old = json.loads(drive.read_bytes(item))
        except (ValueError, OSError):
            old = {}
        pipeline_schedules.on_save(item_id, old if isinstance(old, dict) else {}, req.content)
        # inputs the caller cannot read came without their rows (read_pipeline): keep the rows the file holds
        restricted = _restricted_refs(req.content)
        if restricted:
            _ref_rows(req.content, restricted, replace=_ref_rows(old, {}))
    _replace_content(item, json.dumps(req.content).encode(), PIPELINE)
    new_name = req.name.strip() if req.name else ""
    if new_name and _pipeline_name(new_name) != item["name"]:
        old = item["name"][: -len(PIPELINE_EXT)]
        drive.update_item(item_id, drive.ItemChange(name=_pipeline_name(new_name)))
        # the pipeline's own folder follows the rename (not a default folder, nor one named otherwise)
        folder = db.drive_get(item["parent_id"]) if item["parent_id"] else None
        if folder and not folder.get("system") and folder["name"] == old and not db.drive_name_taken(folder["parent_id"], new_name):
            drive.update_item(folder["id"], drive.ItemChange(name=new_name))
    return drive._with_path(drive._item(item_id))


# dataset maintenance (retention policies, projections) shares this router's /api/pipeline prefix
import dataset_projections  # noqa: E402
import dataset_retention  # noqa: E402

router.include_router(dataset_retention.router)
router.include_router(dataset_projections.router)
