"""Table exports: rows of a dataset inserted into a table of an external SQL database, as Data
Connection's table exports.

An export reads a dataset (dc_datasets: a Files Parquet dataset, a data source or a View) and
writes it to an existing table of a connection that has exports enabled. The export mode says what
each run writes:

  mirror                  the external table always matches the dataset: new rows of the view it
                          last exported are added; a new view (a SNAPSHOT) truncates, then exports it
  full                    the whole view, without truncating (duplicates rows on every run)
  full_truncate           truncate, then the whole view
  incremental             only rows not yet exported; a new view is exported in full (may duplicate)
  incremental_truncate    truncate, then only rows not yet exported (the table as a message queue)
  incremental_append_only only rows not yet exported; fails when the view was replaced (after the
                          first run), so nothing is ever exported twice

The external table must exist, with every dataset column present (same name, case-sensitive) and
a compatible type. A run writes in one database transaction: it commits all its rows or none. A run
with nothing new to export succeeds.

Exports carry the Data Connection sync checks (health_checks.py, resource "export:<id>"): each run
evaluates them when it ends, and a sync row count check is also checked against the rows a run is
about to write: a failing one stops the run before anything is written, its reason the run's error.

Exports into applications (Salesforce, HubSpot, Airtable, ActiveCampaign, Act! CRM, Adobe Commerce:
connectors with `exports_records`) create records through the application's write API, in the
batches it takes (connectors/rest.py `Write`). With a key field each record is created or updated
by that field (an upsert: a Salesforce external ID, a unique HubSpot property, an Airtable merge
field), so re-exported rows do not duplicate records. Applications cannot be truncated, so only
the full and incremental modes apply, and a run is not one transaction: batches written before a
failure stay written, and incremental modes continue after them on the next run. Dataset columns
must be fields a record can set (a unique case-insensitive match is accepted); empty values are
left out of the record.

Mounted by server.py under /api/exports.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import auth
import connectors
import datasources as ds
import db
import dc_datasets
import pipeline_datasets
from connectors import ConnectorError
from connectors.base import SqlConnector, scrub
from connectors.records import RecordConnector, jsonable

log = logging.getLogger("bluesandai.exports")
router = APIRouter(prefix="/api/exports")

MODES = ["mirror", "full", "full_truncate", "incremental", "incremental_truncate", "incremental_append_only"]
Mode = Literal["mirror", "full", "full_truncate", "incremental", "incremental_truncate", "incremental_append_only"]
# applications cannot be truncated
RECORD_MODES = ["full", "incremental", "incremental_append_only"]
BATCH = 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS dc_exports (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    connection_id  text NOT NULL REFERENCES db_connections(id),
    dataset        jsonb NOT NULL,
    database_name  text NOT NULL,
    schema_name    text NOT NULL,
    table_name     text NOT NULL,
    mode           text NOT NULL,
    frequency      text NOT NULL DEFAULT 'manual',
    state          jsonb NOT NULL DEFAULT '{}',
    status         text NOT NULL DEFAULT 'idle',
    next_run_at    timestamptz,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS dc_export_runs (
    id           text PRIMARY KEY,
    export_id    text NOT NULL REFERENCES dc_exports(id) ON DELETE CASCADE,
    trigger      text NOT NULL,
    status       text NOT NULL,
    rows         bigint NOT NULL DEFAULT 0,
    truncated    boolean NOT NULL DEFAULT false,
    detail       text,
    error        text,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS dc_export_runs_by_export ON dc_export_runs (export_id, started_at DESC);
ALTER TABLE dc_exports ADD COLUMN IF NOT EXISTS key_column text;
ALTER TABLE dc_export_runs ADD COLUMN IF NOT EXISTS queue jsonb;
-- the user who created or last saved the export: scheduled runs act as them (datasources.act_for)
ALTER TABLE dc_exports ADD COLUMN IF NOT EXISTS owner text;
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


def startup() -> None:
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(ds.SCHEMA)
        conn.execute(SCHEMA)
    now = _now()
    ds._exec("UPDATE dc_export_runs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = %s WHERE status = 'running'", (now,))
    ds._exec("UPDATE dc_exports SET status = 'idle' WHERE status = 'running'")
    threading.Thread(target=_scheduler, daemon=True, name="export-scheduler").start()


# --------------------------------------------------------------------------------------------
# exports
# --------------------------------------------------------------------------------------------


class ExportIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    connection_id: str
    dataset: dict
    database: str = ""
    schema_: str = Field("", alias="schema")
    table: str = Field(min_length=1)
    mode: Mode = "mirror"
    frequency: Literal["manual", "15m", "hourly", "6h", "daily"] = "manual"
    # exports into applications: create or update records by this dataset column (an upsert)
    key: Optional[str] = Field(None, max_length=200)

    model_config = {"populate_by_name": True}


class ExportChange(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    mode: Optional[Mode] = None
    frequency: Optional[Literal["manual", "15m", "hourly", "6h", "daily"]] = None


def _row(export_id: str) -> dict:
    rows = ds._rows("SELECT * FROM dc_exports WHERE id = %s", (export_id,))
    if not rows:
        raise HTTPException(404, "Export not found")
    return rows[0]


def _public_run(r: dict) -> dict:
    return {
        "id": r["id"],
        "trigger": r["trigger"],
        "status": r["status"],
        "rows": r["rows"],
        "truncated": r["truncated"],
        "detail": r.get("detail"),
        "error": r.get("error"),
        "started_at": _iso(r["started_at"]),
        "finished_at": _iso(r.get("finished_at")),
        # the run's wait in its Project's resource queue (datasources.queue_lease)
        "queue": r.get("queue"),
    }


def _public(row: dict, runs: bool = False) -> dict:
    conn = ds._rows("SELECT name, kind FROM db_connections WHERE id = %s", (row["connection_id"],))
    state = row["state"] or {}
    last = ds._rows("SELECT * FROM dc_export_runs WHERE export_id = %s ORDER BY started_at DESC LIMIT %s", (row["id"], 30 if runs else 1))
    out = {
        "id": row["id"],
        "name": row["name"],
        "connection": {"id": row["connection_id"], "name": conn[0]["name"] if conn else "?", "kind": conn[0]["kind"] if conn else "?", "export_kind": _export_kind(conn[0]["kind"]) if conn else None},
        "dataset": {**row["dataset"], **dc_datasets.describe(row["dataset"])},
        "database": row["database_name"],
        "schema": row["schema_name"],
        "table": row["table_name"],
        "mode": row["mode"],
        "key": row.get("key_column"),
        "frequency": row["frequency"],
        # scheduled runs act as this user (the one who created or last saved the export)
        "owner": ds.owner_label(row.get("owner")),
        "state": {"exported_rows": state.get("exported_rows", 0), "view_id": state.get("view_id"), "runs": state.get("runs", 0)},
        "status": row["status"],
        "next_run_at": _iso(row.get("next_run_at")),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "last_run": _public_run(last[0]) if last else None,
    }
    if runs:
        out["runs"] = [_public_run(r) for r in last]
    return out


def _export_kind(kind: str) -> Optional[str]:
    try:
        return connectors.spec(kind).export_kind
    except ConnectorError:
        return None


def _check_connection(conn_id: str) -> dict:
    row = ds._connection_row(conn_id)
    if not row.get("exports_enabled"):
        raise HTTPException(403, f'Exports to "{row["name"]}" are not enabled — turn on "Enable exports to this source" in its connection settings')
    return row


@router.get("")
def list_exports() -> list[dict]:
    ds._require()
    return [_public(r) for r in ds._rows("SELECT * FROM dc_exports ORDER BY updated_at DESC")]


@router.get("/{export_id}")
def get_export(export_id: str) -> dict:
    ds._require()
    return _public(_row(export_id), runs=True)


@router.post("")
def create_export(req: ExportIn) -> dict:
    ds._require()
    _check_connection(req.connection_id)
    dataset = dc_datasets.parse_ref(req.dataset)
    table, _, _ = dc_datasets.read(dataset)
    key = (req.key or "").strip() or None
    database = req.database
    try:
        with ds._open(req.connection_id) as c:
            if _is_records(c):
                database, _ = _record_target(c, req.database, req.table, table.schema, key, req.mode)
            elif key:
                raise ConnectorError("A key field is for exports into applications; SQL exports insert rows")
            else:
                _target(c, req.database, req.schema_, req.table, table.schema)
    except (ConnectorError, ValueError) as e:
        raise HTTPException(400, str(e)) from None
    now = _now()
    export_id = uuid.uuid4().hex[:16]
    ds._exec(
        "INSERT INTO dc_exports (id, name, connection_id, dataset, database_name, schema_name, table_name, mode, frequency, state, status,"
        " next_run_at, created_at, updated_at, key_column, owner) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'idle', %s, %s, %s, %s, %s)",
        (export_id, req.name.strip(), req.connection_id, Jsonb(dataset), database, req.schema_, req.table, req.mode, req.frequency, Jsonb({}),
         ds._next_run(req.frequency), now, now, key, ds._actor()),
    )
    return get_export(export_id)


@router.put("/{export_id}")
def update_export(export_id: str, req: ExportChange) -> dict:
    ds._require()
    row = _row(export_id)
    # saving makes the saver the owner (scheduled runs then act as them): they must be able to run it
    why = _export_block(row, auth.current(), "you")
    if why:
        raise HTTPException(403, f"You cannot save this export (its scheduled runs would then run as you): {why}")
    name = (req.name or row["name"]).strip()
    mode = req.mode or row["mode"]
    if req.mode and req.mode not in RECORD_MODES and connectors.spec(ds._connection_row(row["connection_id"])["kind"]).export_kind == "records":
        raise HTTPException(400, _truncate_message(connectors.spec(ds._connection_row(row["connection_id"])["kind"]).name))
    frequency = req.frequency or row["frequency"]
    next_run = ds._next_run(frequency) if req.frequency is not None else row.get("next_run_at")
    ds._exec("UPDATE dc_exports SET name = %s, mode = %s, frequency = %s, next_run_at = %s, updated_at = %s, owner = COALESCE(%s, owner) WHERE id = %s",
             (name, mode, frequency, next_run, _now(), ds._actor(), export_id))
    return get_export(export_id)


@router.delete("/{export_id}")
def delete_export(export_id: str) -> dict:
    ds._require()
    row = _row(export_id)
    if row["status"] == "running":
        raise HTTPException(409, "An export is running — wait for it to finish")
    ds._exec("DELETE FROM dc_exports WHERE id = %s", (export_id,))
    return {"deleted": export_id}


@router.post("/{export_id}/run")
def run_export(export_id: str) -> dict:
    ds._require()
    return start(export_id, "manual")


# --------------------------------------------------------------------------------------------
# the target table and the rows
# --------------------------------------------------------------------------------------------

# pipeline column type → the external column types it can be inserted into (pipeline types)
_COMPATIBLE = {
    "Byte": {"Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal"},
    "Short": {"Short", "Integer", "Long", "Float", "Double", "Decimal"},
    "Integer": {"Integer", "Long", "Float", "Double", "Decimal"},
    "Long": {"Long", "Float", "Double", "Decimal"},
    "Float": {"Float", "Double", "Decimal"},
    "Double": {"Double", "Float", "Decimal"},
    "Decimal": {"Decimal", "Double", "Float"},
    "String": {"String"},
    "Boolean": {"Boolean"},
    "Date": {"Date", "Timestamp"},
    "Timestamp": {"Timestamp"},
    "Binary": {"Binary"},
}


def _target(c: connectors.DatabaseConnector, database: str, schema: str, table: str, dataset_schema: pa.Schema) -> tuple[str, list[str]]:
    """The quoted table and the dataset's columns, after checking the table exists and matches."""
    if not isinstance(c, SqlConnector):
        raise ConnectorError("Table exports write to SQL databases and to applications with a write API (Salesforce, HubSpot, Airtable, …), not to this source")
    database = database or c.config.get("database") or ""
    ref = c.table_ref(database, schema, table)  # the table must already exist
    live = {col["name"]: col for col in c.get_table_schema(database, schema, table)["columns"]}
    problems = []
    names = []
    for f in dataset_schema:
        kind = pipeline_datasets._column_type(f.type)
        names.append(f.name)
        if f.name not in live:
            problems.append(f'"{f.name}" is not a column of {schema}.{table} (names are case-sensitive)')
        elif live[f.name]["type"] not in _COMPATIBLE.get(kind, {kind}):
            problems.append(f'"{f.name}" is {kind} in the dataset but {live[f.name]["db_type"]} in {schema}.{table}')
        if pa.types.is_nested(f.type):
            problems.append(f'"{f.name}" is an array, map or struct, which exports do not support')
    if problems:
        raise ConnectorError("The dataset does not match the external table: " + "; ".join(problems))
    return ref, names


def _is_records(c: connectors.DatabaseConnector) -> bool:
    return isinstance(c, RecordConnector) and c.exports_records


def _truncate_message(app: str) -> str:
    return (f"{app} cannot be truncated: choose \"Full dataset without truncation\" or an incremental mode "
            "(with a key field, re-exported rows update their records instead of duplicating them)")


def _record_target(c: RecordConnector, database: str, table: str, dataset_schema: pa.Schema, key: Optional[str], mode: str) -> tuple[str, list[tuple[str, str]]]:
    """(database, [(dataset column, record field)]) after checking the application's table takes them."""
    app = c.spec.name if hasattr(c, "spec") else "This application"
    if mode not in RECORD_MODES:
        raise ConnectorError(_truncate_message(app))
    database = database or next(iter(c.list_databases()), "")
    c._table(database, table)
    writable = c.writable_columns(database, table)
    pairs: list[tuple[str, str]] = []
    problems = []
    for f in dataset_schema:
        if pa.types.is_struct(f.type) or pa.types.is_map(f.type):
            problems.append(f'"{f.name}" is a map or struct, which exports do not support')
            continue
        target = f.name
        if writable is not None and f.name not in writable:
            same = [w for w in writable if w.lower() == f.name.lower()]
            if len(same) != 1:
                problems.append(f'"{f.name}" is not a field records of {table} can set')
                continue
            target = same[0]
        pairs.append((f.name, target))
    if key and key not in [s for s, _ in pairs]:
        problems.append(f'the key field "{key}" is not a column of the dataset')
    if problems:
        raise ConnectorError(f"The dataset does not match {app} {table}: " + "; ".join(problems))
    return database, pairs


def _write_records(c: RecordConnector, database: str, table: str, rows: pa.Table, pairs: list[tuple[str, str]], key: Optional[str], progress: dict) -> None:
    """Rows as records, in the batches the application takes; progress["written"] counts them."""
    size = max(1, c.write_size(database, table))
    target_key = next((t for s, t in pairs if s == key), None) if key else None
    for batch in rows.to_batches(max_chunksize=BATCH):
        records = [{t: jsonable(r[s]) for s, t in pairs if r[s] is not None} for r in batch.to_pylist()]
        for i in range(0, len(records), size):
            chunk = records[i : i + size]
            c.write_records(database, table, chunk, target_key)
            progress["written"] += len(chunk)


def _plan(mode: str, state: dict, view_id: str, total: int) -> tuple[bool, int, str]:
    """(truncate first, first row to export, what happens) for this run."""
    first_run = not state.get("runs")
    same_view = state.get("view_id") == view_id
    done = state.get("exported_rows", 0) if same_view else 0
    if mode == "full":
        return False, 0, "full dataset, no truncation"
    if mode == "full_truncate":
        return True, 0, "truncate, then full dataset"
    if mode == "mirror":
        if first_run or not same_view:
            return True, 0, "new dataset view (SNAPSHOT): truncate, then full view"
        return False, done, "rows appended to the view since the last export"
    if mode == "incremental_append_only" and not first_run and not same_view:
        raise ConnectorError("The dataset's view was replaced (a SNAPSHOT transaction) since the last export — this mode only exports APPEND transactions. Recreate the export to start over.")
    truncate = mode == "incremental_truncate"
    if not same_view:
        return truncate, 0, "new dataset view: every row" + (" (after truncating)" if truncate else "")
    return truncate, done, "rows not yet exported" + (" (after truncating)" if truncate else "")


def _py(v: Any) -> Any:
    if isinstance(v, Decimal):
        return v
    return v


# --------------------------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------------------------

_running: set[str] = set()
_lock = threading.Lock()


def start(export_id: str, trigger: str) -> dict:
    row = _row(export_id)
    with _lock:
        if export_id in _running or row["status"] == "running":
            raise HTTPException(409, "This export is already running")
        _running.add(export_id)
    run_id = uuid.uuid4().hex[:16]
    now = _now()
    ds._exec("INSERT INTO dc_export_runs (id, export_id, trigger, status, started_at) VALUES (%s, %s, %s, 'running', %s)", (run_id, export_id, trigger, now))
    ds._exec("UPDATE dc_exports SET status = 'running', updated_at = %s WHERE id = %s", (now, export_id))
    # a scheduled run acts as the export's owner; Run now as the user who clicked it
    threading.Thread(target=_execute, args=(export_id, run_id, auth.current(), trigger == "schedule"), daemon=True, name=f"export-{export_id}").start()
    return _public_run(ds._rows("SELECT * FROM dc_export_runs WHERE id = %s", (run_id,))[0])


def _dataset_item(ref: dict) -> Optional[str]:
    """The Files item whose Project's resource queue an export runs in: the dataset file, or the data source's folder."""
    try:
        if ref.get("kind") == "file":
            return ref.get("item_id")
        if ref.get("kind") == "source":
            return ds._source_row(ref["id"]).get("folder_id")
    except Exception:  # noqa: BLE001 - the Default queue
        pass
    return None


def execute_now(export_id: str, run_id: str, caller: Optional[dict] = None, scheduled: bool = False) -> None:
    """Runs synchronously (tests)."""
    _execute(export_id, run_id, caller, scheduled)


def _export_block(row: dict, p: Optional[dict], who: str) -> Optional[str]:
    """An export reads its dataset and writes to the connection: the markings of both, a role that reads the dataset
    and the Editor role on its Project."""
    ref = row["dataset"] or {}
    reads: list[tuple[Optional[str], str]] = []
    if ref.get("kind") == "source":
        try:
            src = ds._source_row(ref["id"])
        except HTTPException:
            src = None
        if src:
            reads = [(src.get("folder_id"), "the exported dataset"), *((i, "the exported dataset") for i in ds._view(src))]
    elif ref.get("item_id"):
        reads = [(ref["item_id"], "the exported dataset")]
    item = _dataset_item(ref)
    return ds.access_block(p, who, row["connection_id"], reads, [(item, "the exported dataset")] if item else [])


def _execute(export_id: str, run_id: str, caller: Optional[dict] = None, scheduled: bool = False) -> None:
    row = _row(export_id)
    secrets: dict = {}
    # exports into applications: records written so far (kept when a later batch fails)
    progress: dict = {"written": 0, "records": False}
    state: dict = dict(row["state"] or {})
    view_id: Optional[str] = None
    start_row = 0
    lease: Optional[str] = None
    acting: Any = None  # while the run acts for its owner / the user who started it
    try:
        # a scheduled export reads and writes with its owner's markings and Project role, never as the system:
        # checked before it takes a queue lease, reads the dataset or connects
        acting = ds.act_for("export", row.get("owner"), caller, scheduled, lambda p, who: _export_block(row, p, who))
        lease = ds.queue_lease("export", f"export:{export_id}", f"{row['name']} · export", _dataset_item(row["dataset"]), "dc_export_runs", run_id)
        conn_row = _check_connection(row["connection_id"])
        secrets = ds.secretbox.unseal(conn_row.get("secret"))
        table, view_id, _ = dc_datasets.read(row["dataset"])
        state = dict(row["state"] or {})
        truncate, start_row, detail = _plan(row["mode"], state, view_id, table.num_rows)
        rows_out = table.slice(start_row) if start_row else table
        if truncate or rows_out.num_rows:
            # the export's row count checks see the rows before anything is written (a run with nothing to
            # write is never stopped): a failing check stops the run with its reason
            import health_checks

            stop = health_checks.export_gate(export_id, rows_out.num_rows, table.num_rows)
            if stop:
                raise ConnectorError(stop)
        with ds._open(row["connection_id"], extract=True, writable=True) as c:
            if _is_records(c):
                assert isinstance(c, RecordConnector)
                database, pairs = _record_target(c, row["database_name"], row["table_name"], table.schema, row.get("key_column"), row["mode"])
                progress["records"] = True
                _write_records(c, database, row["table_name"], rows_out, pairs, row.get("key_column"), progress)
                if row.get("key_column"):
                    detail += f" · upserted by {row['key_column']}"
            else:
                ref, names = _target(c, row["database_name"], row["schema_name"], row["table_name"], table.schema)
                assert isinstance(c, SqlConnector)
            if not _is_records(c) and (truncate or rows_out.num_rows):
                conn = c.conn(row["database_name"] or c.config.get("database") or "")
                c.begin_write(conn)
                cur = conn.cursor()
                try:
                    if truncate:
                        # DELETE rather than TRUNCATE: it rolls back with the inserts in every dialect
                        cur.execute(f"DELETE FROM {ref}")
                    sql, _ = c.prepare(f"INSERT INTO {ref} ({', '.join(c.ident(n) for n in names)}) VALUES ({', '.join(['%s'] * len(names))})", ())
                    for batch in rows_out.to_batches(max_chunksize=BATCH):
                        cols = [batch.column(i).to_pylist() for i in range(batch.num_columns)]
                        values = [tuple(_py(col[r]) for col in cols) for r in range(batch.num_rows)]
                        c.bind_rows(cur, values)
                        cur.executemany(sql, values)
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:  # noqa: BLE001
                        pass
                    raise
                finally:
                    cur.close()
        state.update(view_id=view_id, exported_rows=table.num_rows, runs=state.get("runs", 0) + 1, at=_now().isoformat())
        now = _now()
        with db._lock, db._connect() as conn:
            conn.execute(
                "UPDATE dc_export_runs SET status = 'completed', rows = %s, truncated = %s, detail = %s, finished_at = %s WHERE id = %s",
                (rows_out.num_rows, truncate, detail if rows_out.num_rows or truncate else "nothing new to export", now, run_id),
            )
            conn.execute(
                "UPDATE dc_exports SET state = %s, status = 'idle', next_run_at = %s, updated_at = %s WHERE id = %s",
                (Jsonb(state), ds._next_run(row["frequency"], now), now, export_id),
            )
        log.info("export %s: run %s wrote %d rows (%s)", export_id, run_id, rows_out.num_rows, detail)
    except Exception as e:
        acting = ds.stop_acting(acting)  # the failure is recorded by the platform
        message = str(e.detail) if isinstance(e, HTTPException) else str(e) if isinstance(e, ConnectorError) else scrub(f"{type(e).__name__}: {e}", secrets)
        now = _now()
        written = progress["written"]
        try:
            if progress["records"] and written:
                # records already in the application stay there: incremental runs continue after them
                message += f" ({written} record{'s' if written != 1 else ''} were written before the failure"
                message += "; the next incremental run continues after them)" if row["mode"] != "full" else ")"
                state.update(view_id=view_id, exported_rows=start_row + written, runs=state.get("runs", 0) + 1, at=now.isoformat())
                ds._exec("UPDATE dc_exports SET state = %s WHERE id = %s", (Jsonb(state), export_id))
                ds._exec("UPDATE dc_export_runs SET rows = %s WHERE id = %s", (written, run_id))
            ds._exec("UPDATE dc_export_runs SET status = 'failed', error = %s, finished_at = %s WHERE id = %s", (message[:2000], now, run_id))
            ds._exec("UPDATE dc_exports SET status = 'failed', next_run_at = %s, updated_at = %s WHERE id = %s", (ds._next_run(row["frequency"], now), now, export_id))
        except Exception:
            log.exception("export %s: could not record the failed run", export_id)
    finally:
        ds.stop_acting(acting)
        if lease:
            import resource_queues

            try:
                resource_queues.release(lease)
            except Exception:  # noqa: BLE001 - it then expires by itself
                log.exception("export %s: could not release the resource queue lease", export_id)
        with _lock:
            _running.discard(export_id)
        # the export's checks (status, freshness, row count) see the run now; subscribers hear of a change in the app
        try:
            import health_checks

            health_checks.evaluate_sync_checks(f"export:{export_id}")
        except Exception:
            log.exception("export %s: sync checks failed", export_id)


def _scheduler() -> None:
    while True:
        time.sleep(30)
        try:
            for r in ds._rows("SELECT id FROM dc_exports WHERE next_run_at IS NOT NULL AND next_run_at <= %s AND status <> 'running'", (_now(),)):
                try:
                    start(r["id"], "schedule")
                except HTTPException:
                    pass
        except Exception:
            log.exception("export scheduler")
