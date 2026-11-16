"""Data sources: external databases ingested into the Files tab as Parquet datasets.

Concepts (kept apart on purpose):
  connection    how to reach a database (connectors/: PostgreSQL, MySQL, SQL Server…); secrets are
                encrypted (secretbox.py) and never returned
  data source   one table of a connection + the selected columns + how it is ingested
  run           one transaction on the source's dataset, as in Foundry:
                  SNAPSHOT  the run's file replaces the dataset view (snapshot mode, and a
                            re-sync of an incremental source)
                  APPEND    the run's file is added to the view; existing files are never
                            modified (incremental mode)
                The view (state.view) is the ordered list of Parquet files in My Project /
                Data Source / <source>. A run commits atomically: the new file and the new
                view + cursor are recorded together, and a failed run deletes what it wrote, so
                the view and the cursor never move on a failure.

Incremental (as Foundry's incremental JDBC syncs): each run reads rows with
`cursor > last value` — on the first run, `cursor > initial value` (every row when there is no
initial value) — up to the column's maximum when the run starts, in keyset batches.

Downstream, pipelines read the data source's Parquet like any other dataset; nothing here knows
about pipelines, ontologies or RAG.

Mounted by server.py under /api/datasources.
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import shutil
import socket
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field as PField

import connector_oauth
import connectors
import db
import file_transfers
import sap_tools
import drive
import pipeline_datasets
import secretbox
from connectors import ConnectorError
from connectors import normalize as norm
from connectors.base import scrub

log = logging.getLogger("bluesandai.datasources")
router = APIRouter(prefix="/api/datasources")
router.include_router(connector_oauth.router)
router.include_router(file_transfers.router)
router.include_router(sap_tools.router)

PARQUET = pipeline_datasets.PARQUET
PREVIEW_ROWS = 100
# incremental sources whose "cursor" is the delta link an OData service with change tracking hands out (SAP ODP)
DELTA_CURSOR = "!deltatoken"
# OData v4 delta sources created before this lack the ODQ_CHANGEMODE column: their next run adds it
CHANGEMODE_SINCE = datetime(2026, 10, 12, 14, 17, 29, tzinfo=timezone.utc)
# memory DuckDB may use while an upsert by key merges the dataset with a delta (past it, it spills to disk)
UPSERT_MEMORY = os.environ.get("BLUESANDAI_UPSERT_MEMORY", "256MB")
# seconds between scheduled runs
FREQUENCIES: dict[str, Optional[int]] = {"manual": None, "15m": 900, "hourly": 3600, "6h": 21600, "daily": 86400}
# extraction statements may run long (big batches on big tables); browsing stays at 60 s
EXTRACT_TIMEOUT_S = 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS db_connections (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    kind        text NOT NULL,
    config      jsonb NOT NULL,
    secret      bytea,
    version     text,
    tested_at   timestamptz,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS data_sources (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    connection_id  text NOT NULL REFERENCES db_connections(id),
    database_name  text NOT NULL,
    schema_name    text NOT NULL,
    table_name     text NOT NULL,
    columns        jsonb NOT NULL,
    mode           text NOT NULL,
    config         jsonb NOT NULL,
    state          jsonb NOT NULL DEFAULT '{}',
    folder_id      text,
    status         text NOT NULL DEFAULT 'idle',
    next_run_at    timestamptz,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS data_source_runs (
    id           text PRIMARY KEY,
    source_id    text NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    trigger      text NOT NULL,
    status       text NOT NULL,
    rows         bigint NOT NULL DEFAULT 0,
    cursor_from  jsonb,
    cursor_to    jsonb,
    item_id      text,
    error        text,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS data_source_runs_by_source ON data_source_runs (source_id, started_at DESC);
-- SNAPSHOT or APPEND
ALTER TABLE data_source_runs ADD COLUMN IF NOT EXISTS transaction_type text;
-- the run's wait in its Project's resource queue (queue_lease)
ALTER TABLE data_source_runs ADD COLUMN IF NOT EXISTS queue jsonb;
-- connection settings: exports to it (exports.py) and imports into code (Code Repositories)
ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS exports_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS code_imports boolean NOT NULL DEFAULT false;
-- the user who created or last saved the source: scheduled runs act as them (run_as.py, act_for)
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS owner text;
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v: Any) -> Any:
    return v.isoformat() if isinstance(v, datetime) else v


def _fail(e: ConnectorError | ValueError) -> HTTPException:
    return HTTPException(400, str(e))


# --------------------------------------------------------------------------------------------
# storage (PostgreSQL)
# --------------------------------------------------------------------------------------------


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        names = [d.name for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]


def _exec(sql: str, params: tuple = ()) -> None:
    with db._lock, db._connect() as conn:
        conn.execute(sql, params)


def startup() -> None:
    """Create the tables, settle runs a restart interrupted, start the scheduler."""
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(SCHEMA)
    now = _now()
    # the cursor was never advanced for these runs, so the next run reads their rows again
    _exec("UPDATE data_source_runs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = %s WHERE status = 'running'", (now,))
    _exec("UPDATE data_sources SET status = 'idle' WHERE status = 'running'")
    threading.Thread(target=_scheduler, daemon=True, name="datasource-scheduler").start()
    # datasets synced before syncs carried their connection's markings: never changed at startup — an administrator
    # runs the backfill (backfill_sync_markings.py / POST /sources/markings-backfill, a dry run first); until then every
    # run of a sync marks its own dataset before reading or writing anything


def _require() -> None:
    if not db.enabled():
        raise HTTPException(503, "Data sources need the PostgreSQL database (BLUESANDAI_DATABASE_URL)")


# --------------------------------------------------------------------------------------------
# connections
# --------------------------------------------------------------------------------------------


class ConnectionForm(BaseModel):
    kind: str
    name: str = PField(min_length=1, max_length=120)
    values: dict[str, Any] = {}


class ConnectionTest(BaseModel):
    kind: str
    values: dict[str, Any] = {}
    # editing a saved connection: blank secret fields keep the saved ones
    connection_id: Optional[str] = None


def _connection_row(conn_id: str) -> dict:
    rows = _rows("SELECT * FROM db_connections WHERE id = %s", (conn_id,))
    if not rows:
        raise HTTPException(404, "Connection not found")
    # markings on the connection: users without them cannot use it (background syncs run as the system)
    import auth

    auth.check_resource("connection", conn_id)
    return rows[0]


def _public_connection(row: dict) -> dict:
    spec = connectors.spec(row["kind"])
    secrets = secretbox.unseal(row.get("secret"))
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "kind_name": spec.name,
        "config": row["config"],
        # which secret fields hold a value (never the values)
        "secrets_set": sorted(k for k, v in secrets.items() if v),
        "version": row.get("version"),
        "exports_enabled": bool(row.get("exports_enabled")),
        "code_imports": bool(row.get("code_imports")),
        "tested_at": _iso(row.get("tested_at")),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


def _split(kind: str, values: dict, saved_secrets: Optional[dict] = None) -> tuple[dict, dict]:
    spec = connectors.spec(kind)
    config, secrets = spec.split(values)
    for k, v in (saved_secrets or {}).items():
        if not secrets.get(k):
            secrets[k] = v
    # a finished OAuth sign-in in the form → its token
    return config, connector_oauth.resolve(secrets)


def _egress(kind: str, config: dict) -> None:
    """Egress policies (network.py): refuse a destination no policy allows when enforcement is on."""
    import network

    host, port = _endpoint(kind, config)
    try:
        network.check_egress(host, port, "This connection")
    except network.EgressDenied as e:
        raise ConnectorError(str(e)) from None


def _test(kind: str, config: dict, secrets: dict) -> dict:
    _egress(kind, config)
    with connectors.open_connector(kind, config, secrets) as c:
        # a rotated refresh token lands in `secrets` (saved by the caller) and in a pending sign-in
        c.on_token_rotated = connector_oauth.rotated  # type: ignore[attr-defined]
        return c.test_connection()


def _save_rotated(conn_id: str, old: str, new: str) -> None:
    """A provider rotated a saved connection's refresh token: store the new one (the old one no
    longer works)."""
    with _rotate_lock:
        secrets = secretbox.unseal(_connection_row(conn_id).get("secret"))
        changed = {k: (new if v == old else v) for k, v in secrets.items()}
        if changed != secrets:
            _exec("UPDATE db_connections SET secret = %s WHERE id = %s", (secretbox.seal(changed), conn_id))


_rotate_lock = threading.Lock()


def _open(conn_id: str, extract: bool = False, writable: bool = False) -> connectors.DatabaseConnector:
    row = _connection_row(conn_id)
    _egress(row["kind"], row["config"])
    c = connectors.open_connector(row["kind"], row["config"], secretbox.unseal(row.get("secret")))
    c.on_token_rotated = lambda old, new: _save_rotated(conn_id, old, new)  # type: ignore[attr-defined]
    if writable:
        c.writable = True  # type: ignore[attr-defined]
    if extract and hasattr(c, "statement_timeout_s"):
        c.statement_timeout_s = EXTRACT_TIMEOUT_S  # type: ignore[attr-defined]
    return c


@router.get("/connectors")
def list_connectors() -> list[dict]:
    return [s.public() for s in connectors.SPECS]


@router.post("/connections/test")
def test_connection(req: ConnectionTest) -> dict:
    """Try the form's values without saving them."""
    _require()
    try:
        saved = secretbox.unseal(_connection_row(req.connection_id).get("secret")) if req.connection_id else None
        config, secrets = _split(req.kind, req.values, saved)
        return {"ok": True, **_test(req.kind, config, secrets)}
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None


@router.get("/connections")
def list_connections() -> list[dict]:
    _require()
    import auth

    return [_public_connection(r) for r in auth.visible_resources("connection", _rows("SELECT * FROM db_connections ORDER BY updated_at DESC"))]


@router.post("/connections")
def create_connection(req: ConnectionForm) -> dict:
    """Saved only after a successful connection test."""
    _require()
    try:
        config, secrets = _split(req.kind, req.values)
        version = _test(req.kind, config, secrets).get("version")
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None
    now = _now()
    conn_id = uuid.uuid4().hex[:16]
    _exec(
        "INSERT INTO db_connections (id, name, kind, config, secret, version, tested_at, created_at, updated_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (conn_id, req.name.strip(), req.kind, Jsonb(config), secretbox.seal(secrets), version, now, now, now),
    )
    return _public_connection(_connection_row(conn_id))


@router.put("/connections/{conn_id}")
def update_connection(conn_id: str, req: ConnectionForm) -> dict:
    _require()
    row = _connection_row(conn_id)
    if req.kind != row["kind"]:
        raise HTTPException(400, "The database type of a connection cannot change")
    try:
        config, secrets = _split(row["kind"], req.values, secretbox.unseal(row.get("secret")))
        version = _test(row["kind"], config, secrets).get("version")
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None
    now = _now()
    _exec(
        "UPDATE db_connections SET name = %s, config = %s, secret = %s, version = %s, tested_at = %s, updated_at = %s WHERE id = %s",
        (req.name.strip(), Jsonb(config), secretbox.seal(secrets), version, now, now, conn_id),
    )
    return _public_connection(_connection_row(conn_id))


class ConnectionSettings(BaseModel):
    exports_enabled: Optional[bool] = None
    code_imports: Optional[bool] = None


@router.put("/connections/{conn_id}/settings")
def connection_settings(conn_id: str, req: ConnectionSettings) -> dict:
    """Connection settings: enable exports to this source; allow it to be imported into code."""
    _require()
    _connection_row(conn_id)
    for k in ("exports_enabled", "code_imports"):
        v = getattr(req, k)
        if v is not None:
            _exec(f"UPDATE db_connections SET {k} = %s, updated_at = %s WHERE id = %s", (v, _now(), conn_id))
    return _public_connection(_connection_row(conn_id))


def _endpoint(kind: str, config: dict) -> tuple[Optional[str], Optional[int]]:
    """The host and port a connection reaches (None when the connector has none, e.g. BigQuery)."""
    spec = connectors.spec(kind)
    if spec.endpoint:
        return spec.endpoint(config)
    default_port = next((f.default for f in spec.fields if f.name == "port"), None)
    if config.get("host"):
        return str(config["host"]), int(config.get("port") or default_port or 0) or None
    if config.get("url"):
        from urllib.parse import urlparse

        u = urlparse(str(config["url"]))
        return u.hostname, u.port or (443 if u.scheme == "https" else 80)
    if config.get("account"):
        return f"{config['account']}.snowflakecomputing.com", 443
    if config.get("server_hostname"):
        return str(config["server_hostname"]), 443
    return None, None


@router.post("/connections/{conn_id}/diagnose")
def diagnose(conn_id: str) -> dict:
    """Troubleshooting, step by step: DNS resolution, a TCP connection to the port, then the
    connector's own test (authentication and a query). Each step reports its time and error."""
    _require()
    row = _connection_row(conn_id)
    host, port = _endpoint(row["kind"], row["config"])
    steps: list[dict] = []

    def step(name: str, fn: Callable[[], str]) -> bool:
        t = time.monotonic()
        try:
            detail = fn()
            steps.append({"step": name, "ok": True, "detail": detail, "ms": round((time.monotonic() - t) * 1000)})
            return True
        except Exception as e:  # noqa: BLE001
            msg = str(e) if isinstance(e, ConnectorError) else scrub(f"{type(e).__name__}: {e}", secretbox.unseal(row.get("secret")))
            steps.append({"step": name, "ok": False, "detail": msg[:500], "ms": round((time.monotonic() - t) * 1000)})
            return False

    ok = True
    if host:
        import network

        def egress() -> str:
            p = network.check_egress(host, port, "This connection")
            target = network.route_for(host)
            route = f"private link → {target}" if target else "direct"
            return f"{'Policy ' + repr(p['name']) if p else 'No policy (egress not enforced)'} · route: {route}"

        ok = step("Egress policy", egress)
    if host and ok:
        addrs: list[str] = []

        def dns() -> str:
            infos = socket.getaddrinfo(host, port or 0, proto=socket.IPPROTO_TCP)
            addrs.extend(sorted({i[4][0] for i in infos}))
            return f"{host} resolves to {', '.join(addrs[:4])}"

        ok = step("DNS resolution", dns)
        if ok and port:

            def tcp() -> str:
                with socket.create_connection((host, port), timeout=8):
                    return f"Connected to {host}:{port}"

            ok = step("Network connection", tcp)
    if ok:
        def connect() -> str:
            r = _test(row["kind"], row["config"], secretbox.unseal(row.get("secret")))
            return f"Authenticated{' · ' + str(r['version']) if r.get('version') else ''}"

        ok = step("Authentication and query", connect)
    hint = None
    failed = next((s for s in steps if not s["ok"]), None)
    if failed:
        hint = {
            "Egress policy": "Add an egress policy for this host and port (Data Connection → Network), or turn off egress enforcement.",
            "DNS resolution": "The host name does not resolve from this server: check the spelling, the private link endpoint (Data Connection → Network), or the DNS / VPN of the network the API runs in.",
            "Network connection": "The host resolves but the port does not accept connections: check the port, firewalls and the database's allowed IP addresses.",
            "Authentication and query": "The database is reachable: check the credentials, the database name, SSL and the user's permissions.",
        }[failed["step"]]
    return {"ok": failed is None, "host": host, "port": port, "steps": steps, "hint": hint}


@router.delete("/connections/{conn_id}")
def delete_connection(conn_id: str) -> dict:
    _require()
    _connection_row(conn_id)
    used = _rows("SELECT name FROM data_sources WHERE connection_id = %s", (conn_id,))
    if used:
        raise HTTPException(409, f"Used by data source{'s' if len(used) > 1 else ''} {', '.join(r['name'] for r in used)} — delete {'them' if len(used) > 1 else 'it'} first")
    try:
        exported = _rows("SELECT name FROM dc_exports WHERE connection_id = %s", (conn_id,))
    except Exception:  # noqa: BLE001 — exports not set up
        exported = []
    if exported:
        raise HTTPException(409, f"Used by export{'s' if len(exported) > 1 else ''} {', '.join(r['name'] for r in exported)} — delete {'them' if len(exported) > 1 else 'it'} first")
    _exec("DELETE FROM db_connections WHERE id = %s", (conn_id,))
    return {"deleted": conn_id}


# --------------------------------------------------------------------------------------------
# browsing and previews (bounded reads only)
# --------------------------------------------------------------------------------------------


def _browse(conn_id: str, fn: Any) -> Any:
    _require()
    try:
        with _open(conn_id) as c:
            return fn(c)
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None


@router.get("/connections/{conn_id}/databases")
def databases(conn_id: str) -> list[str]:
    return _browse(conn_id, lambda c: c.list_databases())


@router.get("/connections/{conn_id}/schemas")
def schemas(conn_id: str, database: str) -> list[str]:
    return _browse(conn_id, lambda c: c.list_schemas(database))


@router.get("/connections/{conn_id}/tables")
def tables(conn_id: str, database: str, schema: str, search: str = "") -> list[dict]:
    return _browse(conn_id, lambda c: c.list_tables(database, schema, search.strip()[:200]))


@router.get("/connections/{conn_id}/table")
def table_schema(conn_id: str, database: str, schema: str, table: str) -> dict:
    return _browse(conn_id, lambda c: c.get_table_schema(database, schema, table))


@router.get("/connections/{conn_id}/preview")
def preview(conn_id: str, database: str, schema: str, table: str, limit: int = PREVIEW_ROWS) -> dict:
    """The first rows of a table (LIMIT; never the whole table)."""

    def run(c: connectors.DatabaseConnector) -> dict:
        info = c.get_table_schema(database, schema, table)
        cols, rows = c.preview_rows(database, schema, table, max(1, min(limit, 1000)))
        return {"columns": info["columns"], "rows": norm.json_rows(cols, rows), "rows_estimate": info.get("rows"), "comment": info.get("comment"),
                "delta": bool(info.get("delta"))}

    return _browse(conn_id, run)


class IncrementalPreview(BaseModel):
    database: str
    schema_: str = PField(alias="schema")
    table: str
    cursor_column: str
    start_from: Optional[str] = None
    columns: Optional[list[str]] = None


def _batch_preview(c: connectors.DatabaseConnector, database: str, schema: str, table: str, column: str, columns: Optional[list[str]], lower: Any, inclusive: bool) -> dict:
    info = c.get_table_schema(database, schema, table)
    upper = c.get_incremental_metadata(database, schema, table, column)["max"]
    lower, upper = norm.comparable(lower, upper)
    chosen = [col for col in info["columns"] if not columns or col["name"] in columns]
    base = {"from": norm.cursor_text(norm.cursor_dump(lower)), "from_inclusive": inclusive, "to": norm.cursor_text(norm.cursor_dump(upper)), "columns": chosen}
    if upper is None or (lower is not None and (upper < lower or (upper == lower and not inclusive))):
        return {**base, "rows_found": 0, "rows": []}
    found = c.count_range(database, schema, table, column, lower, inclusive, upper)
    rows = c.read_range(database, schema, table, [col["name"] for col in chosen], column, lower, inclusive, upper, PREVIEW_ROWS)
    return {**base, "rows_found": found, "rows": norm.json_rows(chosen, rows)}


def _cursor_info(c: connectors.DatabaseConnector, database: str, schema: str, table: str, column: str) -> dict:
    info = c.get_table_schema(database, schema, table)
    col = next((x for x in info["columns"] if x["name"] == column), None)
    if not col:
        raise ConnectorError(f'"{column}" is not a column of {schema}.{table}')
    if not col["cursor"]:
        raise ConnectorError(f'"{column}" ({col["db_type"]}) cannot be a cursor: use a timestamp, date or integer column')
    return col


def _tz_aware(col: dict) -> bool:
    """Whether the cursor column holds instants (bound as aware date-times) rather than wall-clock times."""
    if "tz" in col:
        return bool(col["tz"])
    t = col["db_type"].lower()
    return any(k in t for k in ("with time zone", "timestamptz", "datetimeoffset", "timestamp_tz", "timestamp_ltz"))


@router.post("/connections/{conn_id}/incremental-preview")
def incremental_preview(conn_id: str, req: IncrementalPreview) -> dict:
    """The exact first batch an incremental source would ingest: after the initial value → current max."""

    def run(c: connectors.DatabaseConnector) -> dict:
        col = _cursor_info(c, req.database, req.schema_, req.table, req.cursor_column)
        lower = norm.parse_start(req.start_from or "", col.get("cursor_kind") or col["type"], _tz_aware(col))
        # the first run reads rows after the initial value (Foundry: `WHERE column > ?`)
        return _batch_preview(c, req.database, req.schema_, req.table, req.cursor_column, req.columns, lower, False)

    return _browse(conn_id, run)


# --------------------------------------------------------------------------------------------
# data sources
# --------------------------------------------------------------------------------------------


class IngestConfig(BaseModel):
    mode: Literal["snapshot", "incremental"]
    cursor_column: Optional[str] = None
    start_from: Optional[str] = None
    batch_size: int = PField(10_000, ge=500, le=200_000)
    frequency: Literal["manual", "15m", "hourly", "6h", "daily"] = "manual"
    snapshot_behavior: Literal["replace", "new"] = "replace"
    # timestamps without a time zone: "utc" (taken as UTC), "string", "long" (epoch milliseconds),
    # or an IANA zone they are wall-clock times in
    naive_timestamps: str = "utc"
    # runs longer than this are stopped and commit nothing (Foundry worker syncs stop at ~48 hours)
    max_duration_minutes: Optional[int] = PField(None, ge=1, le=2880)
    # a column type changed in the database: fail (default), or follow it (snapshot sources)
    allow_schema_changes: bool = False
    # delta-token sources: "log" (default) appends each delta's changes (rows with ODQ_CHANGEMODE);
    # "upsert" applies them by the entity set's key, so each run's dataset version holds the current rows
    delta_write: Literal["log", "upsert"] = "log"
    # upsert: keep the ODQ_CHANGEMODE column in the current rows (the last change of each key) or drop it
    keep_change_mode: bool = False


def _check_naive(v: str) -> str:
    if v in ("utc", "string", "long"):
        return v
    try:
        ZoneInfo(v)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(400, f'"{v}" is not a time zone (use utc, string, long or an IANA zone such as Asia/Jakarta)') from None
    return v


class NewSource(BaseModel):
    name: str = PField(min_length=1, max_length=120)
    connection_id: str
    database: str
    schema_: str = PField(alias="schema")
    table: str
    # None: every column
    columns: Optional[list[str]] = None
    config: IngestConfig
    run_now: bool = True


class SourceChange(BaseModel):
    name: Optional[str] = PField(None, min_length=1, max_length=120)
    frequency: Optional[Literal["manual", "15m", "hourly", "6h", "daily"]] = None
    snapshot_behavior: Optional[Literal["replace", "new"]] = None
    batch_size: Optional[int] = PField(None, ge=500, le=200_000)
    naive_timestamps: Optional[str] = None
    # 0 clears the limit
    max_duration_minutes: Optional[int] = PField(None, ge=0, le=2880)
    allow_schema_changes: Optional[bool] = None


def _source_row(source_id: str) -> dict:
    rows = _rows("SELECT * FROM data_sources WHERE id = %s", (source_id,))
    if not rows:
        raise HTTPException(404, "Data source not found")
    return rows[0]


def _public_run(r: dict) -> dict:
    return {
        "id": r["id"],
        "trigger": r["trigger"],
        "transaction": r.get("transaction_type"),
        "status": r["status"],
        "rows": r["rows"],
        # delta-token runs record text ("initial load" / "delta", "N changed rows …") instead of cursor values
        "from": r["cursor_from"] if isinstance(r.get("cursor_from"), str) else norm.cursor_text(r.get("cursor_from")),
        "to": r["cursor_to"] if isinstance(r.get("cursor_to"), str) else norm.cursor_text(r.get("cursor_to")),
        "item_id": r.get("item_id"),
        "error": r.get("error"),
        "started_at": _iso(r["started_at"]),
        "finished_at": _iso(r.get("finished_at")),
        # {name, waiting, ahead, in_use, vcpu_limit, message} while it waits in the resource queue; {name, waited_s} after
        "queue": r.get("queue"),
    }


def _public_source(row: dict, runs: Optional[list[dict]] = None) -> dict:
    conn = _rows("SELECT name, kind FROM db_connections WHERE id = %s", (row["connection_id"],))
    state = row["state"] or {}
    folder = None
    if row.get("folder_id"):
        f = db.drive_get(row["folder_id"])
        if f and not f.get("trashed_at"):
            # drive_path already ends with the folder itself
            folder = {"id": f["id"], "path": ["Files & Projects", *[p["name"] for p in db.drive_path(f["id"])]]}
    out = {
        "id": row["id"],
        "name": row["name"],
        "connection": {"id": row["connection_id"], "name": conn[0]["name"] if conn else "?", "kind": conn[0]["kind"] if conn else "?"},
        "database": row["database_name"],
        "schema": row["schema_name"],
        "table": row["table_name"],
        "columns": row["columns"],
        "mode": row["mode"],
        "config": row["config"],
        "state": {
            "last_cursor": norm.cursor_text(state.get("last_cursor")),
            "rows_total": state.get("rows_total", 0),
            "item_id": state.get("item_id"),
            # files in the current dataset view; a re-sync is pending (the next run is a SNAPSHOT)
            "view_files": len(_view(row)),
            "resync": bool(state.get("resync")),
            # delta-token upsert: the next run rewrites the current rows (the write mode or its columns changed)
            "compact": bool(state.get("compact")),
            # a change log gaining the ODQ_CHANGEMODE column: the next run rewrites it in the new schema
            "widen": bool(state.get("widen")),
        },
        "folder": folder,
        # scheduled runs act as this user (the one who created or last saved the source)
        "owner": owner_label(row.get("owner")),
        "status": row["status"],
        "next_run_at": _iso(row.get("next_run_at")),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }
    last = _rows("SELECT * FROM data_source_runs WHERE source_id = %s ORDER BY started_at DESC LIMIT %s", (row["id"], 20 if runs is None else 1))
    out["last_run"] = _public_run(last[0]) if last else None
    if runs is not None:
        out["runs"] = [_public_run(r) for r in last]
    return out


def _next_run(frequency: str, after: Optional[datetime] = None) -> Optional[datetime]:
    seconds = FREQUENCIES.get(frequency)
    return (after or _now()) + timedelta(seconds=seconds) if seconds else None


@router.get("/sources")
def list_sources() -> list[dict]:
    _require()
    import auth

    # a sync is seen through its connection: without the connection's markings it is not listed
    rows = auth.visible_resources("connection", _rows("SELECT * FROM data_sources ORDER BY updated_at DESC"), key="connection_id")
    return [_public_source(r) for r in rows]


def _check_source(row: dict) -> None:
    """403 when the caller lacks the markings (or Project) of the sync's connection."""
    import auth

    auth.check_resource("connection", row["connection_id"])


@router.get("/sources/{source_id}")
def get_source(source_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    _require()
    row = _source_row(source_id)
    _check_source(row)
    # the build runner reading a source for a build (X-Bsai-Build): as the build's identity
    import build_calls

    build_calls.enforce(request, ("read", "datasource", source_id, None))
    return _public_source(row, runs=[])


@router.post("/sources")
def create_source(req: NewSource) -> dict:
    _require()
    cfg = req.config
    _check_naive(cfg.naive_timestamps)
    try:
        with _open(req.connection_id) as c:
            info = c.get_table_schema(req.database, req.schema_, req.table)
            known = {col["name"]: col for col in info["columns"]}
            wanted = req.columns or list(known)
            missing = [w for w in wanted if w not in known]
            if missing:
                raise ConnectorError(f"Columns not in the table: {', '.join(missing)}")
            if not wanted:
                raise ConnectorError("Select at least one column")
            columns = [{"name": known[w]["name"], "type": known[w]["type"], "db_type": known[w]["db_type"]} for w in wanted]
            config: dict[str, Any] = cfg.model_dump()
            if cfg.mode == "incremental" and cfg.cursor_column == DELTA_CURSOR:
                if not getattr(c, "supports_delta", None) or not c.supports_delta(req.database, req.schema_, req.table):
                    raise ConnectorError("This table does not track changes: choose a cursor column (delta tokens need an OData service with change tracking, e.g. SAP ODP)")
                config.update(start_from=None, cursor_type="delta", start_inclusive=False, cursor_tz=False, cursor_in_output=True)
                if cfg.delta_write == "upsert":
                    config["delta_key"] = _upsert_key(info, wanted)
            elif cfg.mode == "incremental":
                if not cfg.cursor_column:
                    raise ConnectorError("Choose the incremental (cursor) column")
                col = _cursor_info(c, req.database, req.schema_, req.table, cfg.cursor_column)
                start = norm.parse_start(cfg.start_from or "", col.get("cursor_kind") or col["type"], _tz_aware(col))
                config["start_from"] = norm.cursor_dump(start)
                config["cursor_type"] = col["type"]
                # Foundry semantics: the first run reads `cursor > initial value`
                config["start_inclusive"] = False
                config["cursor_tz"] = _tz_aware(col)
                # the cursor is read with every batch, even when it is not an output column
                config["cursor_in_output"] = cfg.cursor_column in wanted
            else:
                config["cursor_column"] = None
                config["start_from"] = None
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None
    if config.get("cursor_column") != DELTA_CURSOR:
        config.update(delta_write="log", keep_change_mode=False)  # only delta-token sources upsert

    # its dataset will carry the connection's markings: a Project constraint they violate refuses the sync (409)
    _check_constraints({"connection_id": req.connection_id, "folder_id": None})
    name = req.name.strip()
    parent = drive.default_folder("sources")
    folder_id = drive._insert_container(parent, "folder", drive._free_name(parent, drive._clean_name(drive.BAD_NAME.sub("_", name))))
    now = _now()
    source_id = uuid.uuid4().hex[:16]
    _exec(
        "INSERT INTO data_sources (id, name, connection_id, database_name, schema_name, table_name, columns, mode, config, state,"
        " folder_id, status, next_run_at, created_at, updated_at, owner) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'idle', %s, %s, %s, %s)",
        (
            source_id, name, req.connection_id, req.database, req.schema_, req.table, Jsonb(columns), cfg.mode, Jsonb(config),
            Jsonb({"view": []}), folder_id, _next_run(cfg.frequency), now, now, _actor(),
        ),
    )
    if req.run_now:
        start_run(source_id, "first run")
    return get_source(source_id)


@router.put("/sources/{source_id}")
def update_source(source_id: str, req: SourceChange) -> dict:
    _require()
    row = _source_row(source_id)
    _check_take_over(row)
    config = dict(row["config"])
    if req.naive_timestamps is not None:
        _check_naive(req.naive_timestamps)
    for k in ("frequency", "snapshot_behavior", "batch_size", "naive_timestamps", "allow_schema_changes"):
        v = getattr(req, k)
        if v is not None:
            config[k] = v
    if req.max_duration_minutes is not None:
        config["max_duration_minutes"] = req.max_duration_minutes or None
    next_run = _next_run(config["frequency"]) if req.frequency is not None else row.get("next_run_at")
    _exec(
        "UPDATE data_sources SET name = %s, config = %s, next_run_at = %s, updated_at = %s, owner = COALESCE(%s, owner) WHERE id = %s",
        ((req.name or row["name"]).strip(), Jsonb(config), next_run, _now(), _actor(), source_id),
    )
    return get_source(source_id)


class ModeChange(BaseModel):
    mode: Literal["snapshot", "incremental"]
    # incremental: the cursor column (None: the recommended one) and the initial value (exclusive)
    cursor_column: Optional[str] = None
    start_from: Optional[str] = None


@router.put("/sources/{source_id}/mode")
def change_mode(source_id: str, req: ModeChange) -> dict:
    """Switch how a source is ingested. The next run is a SNAPSHOT that starts a new dataset view
    (every row, or every row after the initial value); incremental runs then APPEND new rows."""
    _require()
    row = _source_row(source_id)
    if row["status"] == "running":
        raise HTTPException(409, "A run is in progress — wait for it to finish")
    _check_take_over(row)
    config = dict(row["config"])
    state = dict(row["state"] or {})
    if req.mode == row["mode"] and (req.mode == "snapshot" or not req.cursor_column or req.cursor_column == config.get("cursor_column")):
        return get_source(source_id)
    try:
        with _open(row["connection_id"]) as c:
            if req.mode == "incremental":
                info = c.get_table_schema(row["database_name"], row["schema_name"], row["table_name"])
                usable = [col for col in info["columns"] if col.get("cursor")]
                # an update / insert time catches every new and changed row; an id only new rows
                ranked = sorted((col for col in usable if col.get("recommended")), key=lambda col: col["type"] not in ("Timestamp", "Date"))
                name = req.cursor_column or next((col["name"] for col in ranked), None)
                if not name:
                    if not usable:
                        raise ConnectorError(f"{row['table_name']} has no column that can be an incremental cursor (a timestamp, date or integer column)")
                    raise ConnectorError(
                        f"{row['table_name']} has no recommended cursor column — choose one ({', '.join(col['name'] for col in usable)}): "
                        "it must increase with every new or changed row"
                    )
                col = _cursor_info(c, row["database_name"], row["schema_name"], row["table_name"], name)
                start = norm.parse_start(req.start_from or "", col.get("cursor_kind") or col["type"], _tz_aware(col))
                config.update(
                    mode="incremental", cursor_column=name, start_from=norm.cursor_dump(start), cursor_type=col["type"],
                    start_inclusive=False, cursor_tz=_tz_aware(col), cursor_in_output=name in {x["name"] for x in row["columns"]},
                )
                # the next run re-syncs from the initial value as a SNAPSHOT (a new view); later runs append
                state["resync"] = True
            else:
                config.update(mode="snapshot", cursor_column=None, start_from=None)
                state.pop("resync", None)
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None
    state.pop("last_cursor", None)
    _exec("UPDATE data_sources SET mode = %s, config = %s, state = %s, updated_at = %s, owner = COALESCE(%s, owner) WHERE id = %s",
          (req.mode, Jsonb(config), Jsonb(state), _now(), _actor(), source_id))
    return get_source(source_id)


def _upsert_key(info: dict, columns: list[str]) -> list[str]:
    """The entity set's key for upserts: every key property and the change-mode column must be synced."""
    from connectors.odata import CHANGEMODE

    key = list(info.get("primary_key") or [])
    if not key:
        raise ConnectorError("Upsert by key needs an entity set with a key: this one has none (keep the change log)")
    missing = [k for k in key if k not in columns]
    if missing:
        raise ConnectorError(f"Upsert by key needs the key column{'s' if len(missing) > 1 else ''} {', '.join(missing)} in the synced columns")
    if CHANGEMODE not in columns:
        raise ConnectorError(f"Upsert by key needs the {CHANGEMODE} column in the synced columns (it marks deleted keys)")
    return key


class DeltaWrite(BaseModel):
    delta_write: Literal["log", "upsert"]
    keep_change_mode: Optional[bool] = None


@router.put("/sources/{source_id}/delta-write")
def change_delta_write(source_id: str, req: DeltaWrite) -> dict:
    """How a delta-token source writes its dataset. Log → upsert: the next run applies its changes to the
    whole change log so far (no new initial load) and writes the current rows. Upsert → log: later deltas
    append to the current rows, which already are a valid start of a change log when they keep the change-mode
    column; without it the next run is a new initial load (a re-sync), so the log has one schema."""
    _require()
    row = _source_row(source_id)
    if row["mode"] != "incremental" or row["config"].get("cursor_column") != DELTA_CURSOR:
        raise HTTPException(400, "Only delta-token sources (SAP ODP / OData change tracking) have a write mode")
    if row["status"] == "running":
        raise HTTPException(409, "A run is in progress — wait for it to finish")
    _check_take_over(row)
    config = dict(row["config"])
    state = dict(row["state"] or {})
    was = config.get("delta_write", "log")
    was_keep = bool(config.get("keep_change_mode"))
    keep = was_keep if req.keep_change_mode is None else req.keep_change_mode
    columns = None
    if req.delta_write == "upsert":
        try:
            with _open(row["connection_id"]) as c:
                info = c.get_table_schema(row["database_name"], row["schema_name"], row["table_name"])
                # a source without the change-mode column (v4 sources from before it, or synced without it)
                # gets it: upserts need it, and the files written so far read it as empty
                columns = _add_changemode(c, row, info)
                config["delta_key"] = _upsert_key(info, [col["name"] for col in columns or row["columns"]])
        except (ConnectorError, ValueError) as e:
            raise _fail(e) from None
        if columns is not None and state.get("delta_token") and _view(row) and not state.get("resync"):
            state["widen"] = True
        if (was != "upsert" or keep != was_keep) and state.get("delta_token"):
            state["compact"] = True  # the next run writes the current rows even when the service reports no change
    elif was == "upsert" and not was_keep and state.get("delta_token"):
        state["resync"] = True
    config.update(delta_write=req.delta_write, keep_change_mode=keep)
    _exec("UPDATE data_sources SET config = %s, state = %s, columns = %s, updated_at = %s, owner = COALESCE(%s, owner) WHERE id = %s",
          (Jsonb(config), Jsonb(state), Jsonb(columns or row["columns"]), _now(), _actor(), source_id))
    return get_source(source_id)


@router.delete("/sources/{source_id}")
def delete_source(source_id: str, delete_data: bool = False) -> dict:
    _require()
    row = _source_row(source_id)
    _check_source(row)
    if row["status"] == "running":
        raise HTTPException(409, "A run is in progress — wait for it to finish")
    _exec("DELETE FROM data_sources WHERE id = %s", (source_id,))
    if delete_data and row.get("folder_id") and db.drive_get(row["folder_id"]):
        drive.delete_tree(row["folder_id"])
    return {"deleted": source_id}


@router.post("/sources/{source_id}/reset")
def resync(source_id: str) -> dict:
    """Re-sync an incremental source from its initial value: the next run is a SNAPSHOT that
    replaces the dataset view (rather than appending everything again), and later runs append."""
    _require()
    row = _source_row(source_id)
    _check_source(row)
    if row["status"] == "running":
        raise HTTPException(409, "A run is in progress — wait for it to finish")
    state = dict(row["state"] or {})
    state["resync"] = True
    _exec("UPDATE data_sources SET state = %s, updated_at = %s WHERE id = %s", (Jsonb(state), _now(), source_id))
    return get_source(source_id)


@router.post("/sources/{source_id}/incremental-preview")
def source_incremental_preview(source_id: str) -> dict:
    """What the next run of an incremental source would read."""
    _require()
    row = _source_row(source_id)
    if row["mode"] != "incremental":
        raise HTTPException(400, "Not an incremental data source")
    if row["config"].get("cursor_column") == DELTA_CURSOR:
        raise HTTPException(400, "A delta-token source reads the changes the service reports: there is no cursor range to preview")
    lower, inclusive = _lower_bound(row)
    try:
        with _open(row["connection_id"]) as c:
            return _batch_preview(
                c, row["database_name"], row["schema_name"], row["table_name"], row["config"]["cursor_column"],
                [col["name"] for col in row["columns"]], lower, inclusive,
            )
    except (ConnectorError, ValueError) as e:
        raise _fail(e) from None


@router.get("/sources/{source_id}/table")
def source_table(source_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    """The ingested dataset as pipeline columns and rows (all parts of an incremental source)."""
    _require()
    row = _source_row(source_id)
    # a pipeline input read by the build runner (X-Bsai-Build): as the build's identity (the source's files and folder)
    import build_calls

    build_calls.enforce(request, ("read", "datasource", source_id, None))
    _check_source(row)
    files = [f for f in (db.drive_get(i) for i in _view(row)) if f and not f.get("trashed_at")]
    if not files:
        raise HTTPException(409, "Nothing ingested yet — run the data source first")
    # promote: a change log written before its source gained a column reads it as nulls
    table = pa.concat_tables([pq.read_table(io.BytesIO(drive.read_bytes(f))) for f in files], promote_options="default")
    return pipeline_datasets.table_payload(table, row["name"])


def _view(row: dict) -> list[str]:
    """The files of the current dataset view, oldest first (sources from before views: derived)."""
    state = row["state"] or {}
    if "view" in state:
        return list(state["view"])
    if row["mode"] == "incremental" and row.get("folder_id") and db.drive_get(row["folder_id"]):
        parts = sorted((f for f in drive.list_files(row["folder_id"]) if f["name"].startswith("part-")), key=lambda f: f["name"])
        return [f["id"] for f in parts]
    return [state["item_id"]] if state.get("item_id") else []


# --------------------------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------------------------

_running: set[str] = set()
_running_lock = threading.Lock()


@router.post("/sources/{source_id}/run")
def run_source(source_id: str) -> dict:
    _require()
    _check_source(_source_row(source_id))  # a sync is seen through its connection
    return start_run(source_id, "manual")


def start_run(source_id: str, trigger: str) -> dict:
    row = _source_row(source_id)
    if trigger != "schedule":
        # Run now: a Project constraint the marked dataset would violate answers 409 (a scheduled run fails instead)
        _check_constraints(row)
    with _running_lock:
        if source_id in _running or row["status"] == "running":
            raise HTTPException(409, "This data source is already running")
        _running.add(source_id)
    run_id = uuid.uuid4().hex[:16]
    now = _now()
    _exec("INSERT INTO data_source_runs (id, source_id, trigger, status, started_at) VALUES (%s, %s, %s, 'running', %s)", (run_id, source_id, trigger, now))
    _exec("UPDATE data_sources SET status = 'running', updated_at = %s WHERE id = %s", (now, source_id))
    import auth

    # a scheduled run acts as the source's owner; any other (Run now, a first run) as the user who started it
    threading.Thread(target=_execute, args=(source_id, run_id, auth.current(), trigger == "schedule"), daemon=True, name=f"datasource-{source_id}").start()
    return _public_run(_rows("SELECT * FROM data_source_runs WHERE id = %s", (run_id,))[0])


def _lower_bound(row: dict) -> tuple[Any, bool]:
    """Where the next incremental run starts: after the last cursor; on the first run (or a
    re-sync) after the initial value (sources created before Foundry semantics: at it)."""
    state = row["state"] or {}
    if state.get("last_cursor") and not state.get("resync"):
        return norm.cursor_load(state["last_cursor"]), False
    return norm.cursor_load(row["config"].get("start_from")), bool(row["config"].get("start_inclusive", True))


def _output_plan(row: dict) -> tuple[list[dict], dict[int, Callable[[Any], Any]]]:
    """The dataset's columns and per-column value conversions: timestamps without a time zone are
    kept as UTC (default), written as text or epoch milliseconds, or read as wall-clock times in a zone."""
    mode = row["config"].get("naive_timestamps") or "utc"
    columns = [dict(col) for col in row["columns"]]
    convert: dict[int, Callable[[Any], Any]] = {}
    if mode == "utc":
        return columns, convert
    zone = None if mode in ("string", "long") else ZoneInfo(mode)
    for i, col in enumerate(columns):
        if col["type"] != "Timestamp" or _tz_aware(col):
            continue
        if mode == "string":
            col["type"] = "String"
            convert[i] = lambda v: v.isoformat(sep=" ") if isinstance(v, datetime) else v
        elif mode == "long":
            col["type"] = "Long"
            convert[i] = lambda v: int(v.replace(tzinfo=timezone.utc).timestamp() * 1000) if isinstance(v, datetime) else v
        else:
            convert[i] = lambda v, z=zone: v.replace(tzinfo=z) if isinstance(v, datetime) and v.tzinfo is None else v
    return columns, convert


class _ParquetOut:
    """Batches → a temporary Parquet file with the source's fixed schema. A run past its deadline
    (maximum duration) stops at the next batch, and nothing is committed."""

    def __init__(self, columns: list[dict], convert: Optional[dict[int, Callable[[Any], Any]]] = None, max_minutes: Optional[int] = None):
        self.columns = columns
        self.convert = convert or {}
        self.max_minutes = max_minutes
        self.deadline = time.monotonic() + max_minutes * 60 if max_minutes else None
        self.schema = norm.arrow_schema(columns)
        fd, self.path = tempfile.mkstemp(suffix=".parquet", prefix="bluesandai-source-")
        os.close(fd)
        self.writer = pq.ParquetWriter(self.path, self.schema, compression="snappy")
        self.rows = 0

    def write(self, rows: list[tuple]) -> None:
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise ConnectorError(f"Stopped: the run exceeded its maximum duration of {self.max_minutes} minutes. Nothing was committed.")
        if rows:
            if self.convert:
                rows = [tuple(self.convert[i](v) if i in self.convert else v for i, v in enumerate(r)) for r in rows]
            self.writer.write_table(norm.arrow_batch(self.columns, rows, self.schema))
            self.rows += len(rows)

    def close(self) -> None:
        self.writer.close()

    def discard(self) -> None:
        try:
            self.writer.close()
        except Exception:
            pass
        try:
            os.unlink(self.path)
        except OSError:
            pass


# --------------------------------------------------------------------------------------------
# markings: the synced dataset carries its connection's markings (as Foundry: data synced from a marked source is
# marked), so a user who cannot see the connection cannot read — or find in Files — what was synced from it:
# - every file a run writes is created already marked (inherited markings) under a fresh id before its contents are
#   stored (marked_outputs.create_from), and the sync's folder carries them too (its files are not even listed);
# - the folder and the files of the current view gain the connection's markings before a run reads or writes
#   anything (also a run that then fails or finds nothing new: the idempotent check of every run), and again before a
#   new view is committed (a marking added to the connection during the run);
# - markings removed from the connection are taken off after a successful run (only those a run applied: the
#   markings recorded in state["marks"]); hand-set (own) markings are never touched;
# - a Project constraint (allowed / prohibited markings, maximum classification) the marked dataset would violate:
#   creating the sync and Run now answer 409, a scheduled run fails before it connects or writes (_constraint_block);
# - a marking added to a connection reaches its synced datasets at once (auth.set_item_markings calls
#   backfill_markings(connection_id=...)); taken off, it comes off at the sync's next successful run;
# - datasets synced before this: backfill_markings() (an administrator; a dry run first, never automatic).
# Sources themselves have no markings (they are seen through their connection).
# --------------------------------------------------------------------------------------------


def _dataset_marks(row: dict) -> set[str]:
    """The markings a sync's dataset carries: its connection's (own and inherited)."""
    import auth

    return set(auth.resource_effective("connection", row["connection_id"]))


def _widen(item_ids: list[Optional[str]], marks: set[str]) -> int:
    """Add `marks` to the inherited markings of these Files items (those that exist) lacking any; returns how many
    were changed. Never narrows, never checks Project constraints (protection first: a violation fails the next
    write, the data stays marked)."""
    import auth

    if not marks:
        return 0
    n = 0
    for i in dict.fromkeys(x for x in item_ids if x):
        own, inherited = auth._item_row(i)
        if marks <= set(inherited) or not db.drive_get(i):
            continue
        auth._set_item(i, inherited=sorted(set(inherited) | marks))
        n += 1
    return n


def _narrow(item_ids: list[Optional[str]], removed: set[str]) -> None:
    """Take markings a run applied, now off the connection, off these items' inherited markings."""
    import auth

    if not removed:
        return
    for i in dict.fromkeys(x for x in item_ids if x):
        own, inherited = auth._item_row(i)
        if set(inherited) & removed:
            auth._set_item(i, inherited=sorted(set(inherited) - removed))


def _live_folder(row: dict) -> Optional[str]:
    f = db.drive_get(row["folder_id"]) if row.get("folder_id") else None
    return f["id"] if f and not f.get("trashed_at") else None


def _constraint_block(row: dict, marks: Optional[set[str]] = None, view: Optional[list[str]] = None) -> Optional[str]:
    """Why the sync's dataset carrying its connection's markings would violate its Project's constraints (the folder
    and the files of the view with them, or — no folder yet — a new folder in the sources folder), or None."""
    import auth

    marks = _dataset_marks(row) if marks is None else marks
    if not marks:
        return None
    folder = _live_folder(row)
    if not folder:
        parent = drive.default_folder("sources")
        return auth.constraint_violation(parent, set(auth.effective_markings(parent)) | marks) if parent else None
    for i in dict.fromkeys([folder, *(_view(row) if view is None else view)]):
        if i and db.drive_get(i):
            why = auth.constraint_violation(i, set(auth.file_markings(i)) | marks)
            if why:
                return why
    return None


def _check_constraints(row: dict) -> None:
    """409 before anything is created, run or written when the marked dataset would violate a Project constraint."""
    why = _constraint_block(row)
    if why:
        raise HTTPException(409, f"The synced dataset would carry its connection's markings: {why}")


def _store_new(folder_id: str, name: str, path: str, row: Optional[dict] = None) -> dict:
    """Store a run's Parquet file in the sync's folder: with the connection's markings (`row`: the source) it is
    marked before its contents are stored, and the folder gains them first."""
    clean = drive._clean_name(drive.BAD_NAME.sub("_", name))
    marks = _dataset_marks(row) if row else set()
    with open(path, "rb") as f:
        if not marks:
            return drive._store(folder_id, clean, f, os.path.getsize(path), PARQUET)
        import marked_outputs

        _widen([folder_id], marks)
        return marked_outputs.create_from(folder_id, clean, f, os.path.getsize(path), PARQUET, marks)


def backfill_markings(dry_run: bool = True, connection_id: Optional[str] = None) -> dict:
    """Datasets synced before syncs carried their connection's markings: the folder and current view files of every
    source whose connection has markings gain them (idempotent; only adds; dry_run: report only). connection_id: only
    that connection's syncs (e.g. right after a marking is added to it). Every change is logged and audited. Returns a
    report."""
    import auth

    report: dict[str, Any] = {"dry_run": dry_run, "sources": [], "items": 0}
    sql, args = "SELECT * FROM data_sources ORDER BY created_at", ()
    if connection_id:
        sql, args = "SELECT * FROM data_sources WHERE connection_id = %s ORDER BY created_at", (connection_id,)
    for row in _rows(sql, args):
        marks = _dataset_marks(row)
        if not marks:
            continue
        lacking = []
        for i in dict.fromkeys(x for x in [_live_folder(row), *_view(row)] if x):
            if db.drive_get(i) and not marks <= set(auth._item_row(i)[1]):
                lacking.append(i)
        if not lacking:
            continue
        # a Project constraint the markings would violate is reported (the owner moves the sync's data or changes
        # the constraint); applying still marks the data — readable by fewer people, never by more
        report["sources"].append({"id": row["id"], "name": row["name"], "connection_id": row["connection_id"],
                                  "markings": sorted(marks), "items": lacking, "constraint": _constraint_block(row, marks)})
        report["items"] += len(lacking)
        if not dry_run:
            _widen(lacking, marks)
            _exec("UPDATE data_sources SET state = COALESCE(state, '{}'::jsonb) || %s WHERE id = %s",
                  (Jsonb({"marks": sorted(set((row["state"] or {}).get("marks") or []) | marks)}), row["id"]))
            detail = f"sync {row['id']} ({row['name']}): {', '.join(lacking)} gained {', '.join(sorted(marks))}"
            log.warning("sync markings backfill: %s", detail)
            auth.audit("sync_markings_backfill", None, detail)
    return report


@router.post("/sources/markings-backfill")
def run_markings_backfill(dry_run: bool = True, connection_id: Optional[str] = None) -> dict:
    """Administrators: the synced datasets that lack their connection's markings (dry_run: listed, nothing changed)."""
    import auth

    _require()
    auth.require_admin()
    return backfill_markings(dry_run=dry_run, connection_id=connection_id)


def _drop_files(ids: list[str]) -> None:
    """Delete files that are no longer in any view (best effort: a leftover file is harmless)."""
    for i in ids:
        try:
            if db.drive_get(i):
                drive._delete_contents(db.drive_delete(i, drive._now()))
        except Exception:
            log.exception("could not delete superseded file %s", i)


def _folder(row: dict) -> str:
    """The source's folder, recreated if it was deleted."""
    f = db.drive_get(row["folder_id"]) if row.get("folder_id") else None
    if f and not f.get("trashed_at"):
        return f["id"]
    parent = drive.default_folder("sources")
    folder_id = drive._insert_container(parent, "folder", drive._free_name(parent, drive._clean_name(drive.BAD_NAME.sub("_", row["name"]))))
    _exec("UPDATE data_sources SET folder_id = %s WHERE id = %s", (folder_id, row["id"]))
    return folder_id


def _snapshot(c: connectors.DatabaseConnector, row: dict, out: _ParquetOut) -> dict:
    """SNAPSHOT: the whole table into a new file (committed by _execute, which swaps the view)."""
    cfg = row["config"]
    for batch in c.stream_table(row["database_name"], row["schema_name"], row["table_name"], [col["name"] for col in row["columns"]], cfg["batch_size"]):
        out.write(batch)
    out.close()
    name = row["name"] if cfg.get("snapshot_behavior") != "new" else f"{row['name']} {_now().strftime('%Y-%m-%d %H-%M-%S')}"
    return _store_new(_folder(row), f"{name}.parquet", out.path, row)


def _delta(c: connectors.DatabaseConnector, row: dict, out: _ParquetOut, run_id: str) -> tuple[Optional[dict], Optional[str]]:
    """Delta tokens (OData change tracking, SAP ODP): the first run (or a re-sync) is the initial load, later runs
    append the changes since the stored delta link."""
    state = row["state"] or {}
    token = None if state.get("resync") else state.get("delta_token")
    holder: dict = {}
    names = [col["name"] for col in row["columns"]]
    for batch in c.read_delta(row["database_name"], row["schema_name"], row["table_name"], names, token, row["config"]["batch_size"], holder):  # type: ignore[attr-defined]
        out.write(batch)
    out.close()
    _exec("UPDATE data_source_runs SET cursor_from = %s, cursor_to = %s WHERE id = %s",
          (Jsonb("initial load" if not token else "delta"), Jsonb(f"{out.rows} changed rows" + (f", {holder.get('deleted')} deleted" if holder.get("deleted") else "")), run_id))
    if (out.rows == 0 and token) or row["config"].get("delta_write") == "upsert" or (token and state.get("widen")):
        # upsert: _upsert writes the current rows from out.path; widen: _rewrite_log the log in the new schema
        return None, holder.get("token")
    folder_id = _folder(row)
    if not token:
        return _store_new(folder_id, "part-00001.parquet", out.path, row), holder.get("token")
    n = len([f for f in drive.list_files(folder_id) if f["name"].startswith("part-")]) + 1
    return _store_new(folder_id, f"part-{n:05d}.parquet", out.path, row), holder.get("token")


@contextlib.contextmanager
def _local_paths(items: list[dict]) -> Iterator[list[str]]:
    """Local paths of stored files, to stream them: files kept on this machine are read in place, S3 objects
    are downloaded (streamed) into a temporary folder removed afterwards — nothing is read into memory."""
    tmp: Optional[str] = None
    paths: list[str] = []
    try:
        for f in items:
            drive.auth.check_item(f)  # as drive.read_bytes
            if f["stored_in"] == "s3":
                tmp = tmp or tempfile.mkdtemp(prefix="bluesandai-dataset-")
                path = os.path.join(tmp, f"{f['id']}.parquet")
                drive.storage.download_file(f"drive/{f['id']}", path)
            else:
                path = str(drive.LOCAL_DIR / f["id"])
            paths.append(path)
        yield paths
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def _view_files(row: dict) -> list[dict]:
    return [f for f in (db.drive_get(i) for i in _view(row)) if f and not f.get("trashed_at")]


def _write_merged(row: dict, out: _ParquetOut, merge: Callable[[list[str], str], int]) -> tuple[dict, int]:
    """The dataset so far plus this run's rows (out.path) merged by `merge(paths, target)` into one new file."""
    fd, path = tempfile.mkstemp(suffix=".parquet", prefix="bluesandai-upsert-")
    os.close(fd)
    try:
        with _local_paths(_view_files(row)) as parts:
            count = merge([*parts, out.path], path)
        return _store_new(_folder(row), f"{row['name']} {_now().strftime('%Y-%m-%d %H-%M-%S-%f')}.parquet", path, row), count
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _note_run(run_id: str, out: _ParquetOut, suffix: str) -> None:
    summary = _rows("SELECT cursor_to FROM data_source_runs WHERE id = %s", (run_id,))
    text = summary[0]["cursor_to"] if summary and isinstance(summary[0]["cursor_to"], str) else f"{out.rows} changed rows"
    _exec("UPDATE data_source_runs SET cursor_to = %s WHERE id = %s", (Jsonb(f"{text} {suffix}"), run_id))


def _upsert(row: dict, out: _ParquetOut, run_id: str, snapshot: bool, compact: bool) -> tuple[Optional[dict], int]:
    """Upsert by key (delta-token sources): the dataset so far (nothing on an initial load) plus the changes this
    run read (out.path), reduced to the current rows — the last image per key, deleted keys removed — written as
    one new file that replaces the view. Returns (the file or None when nothing changed, the current row count).
    Out of core: the files are streamed (DuckDB finds each key's last row with bounded memory, spilling to disk),
    never loaded whole."""
    from connectors.odata import CHANGEMODE, net_changes_files

    state = row["state"] or {}
    if not snapshot and out.rows == 0 and not compact:
        return None, int(state.get("rows_total") or 0)
    key = row["config"].get("delta_key") or []
    drop = () if row["config"].get("keep_change_mode") else (CHANGEMODE,)
    base = {**row, "state": {**state, "view": []}} if snapshot else row
    written, count = _write_merged(base, out, lambda paths, target: net_changes_files(
        paths, out.schema, key, target, drop=drop, memory_limit=UPSERT_MEMORY, temp_dir=tempfile.gettempdir()))
    _note_run(run_id, out, f"→ {count} current rows")
    return written, count


def _rewrite_log(row: dict, out: _ParquetOut, run_id: str) -> dict:
    """A change log whose source gained the ODQ_CHANGEMODE column (a v4 source from before the column): the
    log so far (its rows without a change mode) and this run's changes, streamed into one file in the new schema,
    so the dataset never mixes schemas."""
    from connectors.odata import concat_files

    written, count = _write_merged(row, out, lambda paths, target: concat_files(paths, out.schema, target))
    _note_run(run_id, out, f"(change log rewritten with the {_changemode()} column: {count} rows)")
    return written


def _changemode() -> str:
    from connectors.odata import CHANGEMODE

    return CHANGEMODE


def _add_changemode(c: connectors.DatabaseConnector, row: dict, info: Optional[dict] = None) -> Optional[list[dict]]:
    """The source's columns plus the entity set's ODQ_CHANGEMODE column when the source lacks it and the set
    offers it (OData v4 delta sources from before the column existed), else None."""
    cm = _changemode()
    if any(col["name"] == cm for col in row["columns"]):
        return None
    info = info or c.get_table_schema(row["database_name"], row["schema_name"], row["table_name"])
    live = next((col for col in info["columns"] if col["name"] == cm), None)
    if not live:
        return None
    return [*row["columns"], {"name": live["name"], "type": live["type"], "db_type": live["db_type"]}]


def _migrate_changemode(c: connectors.DatabaseConnector, row: dict) -> dict:
    """Delta sources created before v4 entity sets had an ODQ_CHANGEMODE column (2bef6af) get it on their next
    run: deletions are written from then on and upsert by key becomes possible, without re-creating the source.
    A change log already written is rewritten once in the new schema (state "widen", see _rewrite_log)."""
    created = row.get("created_at")
    if not created or created >= CHANGEMODE_SINCE or not getattr(c, "_synthetic_changemode", None):
        return row
    if not c._synthetic_changemode(row["database_name"], row["table_name"]):  # type: ignore[attr-defined]
        return row
    columns = _add_changemode(c, row)
    if columns is None:
        return row
    state = dict(row["state"] or {})
    if _view(row) and state.get("delta_token") and not state.get("resync"):
        state["widen"] = True
    _exec("UPDATE data_sources SET columns = %s, state = %s, updated_at = %s WHERE id = %s", (Jsonb(columns), Jsonb(state), _now(), row["id"]))
    log.info("data source %s: %s column added (source from before the column)", row["id"], _changemode())
    return {**row, "columns": columns, "state": state}


def _incremental(c: connectors.DatabaseConnector, row: dict, out: _ParquetOut, run_id: str) -> tuple[Optional[dict], Any, Any]:
    """Keyset batches over (lower, upper]: never OFFSET, never the whole table.

    Rows sharing the cursor value at a batch boundary are re-read in the next batch (the boundary
    is inclusive there), so ties are neither skipped nor duplicated.
    """
    cfg = row["config"]
    column = cfg["cursor_column"]
    names = [col["name"] for col in row["columns"]]
    read = names if cfg.get("cursor_in_output", True) else [*names, column]
    ci = read.index(column)
    lower, inclusive = _lower_bound(row)
    upper = c.get_incremental_metadata(row["database_name"], row["schema_name"], row["table_name"], column)["max"]
    lower, upper = norm.comparable(lower, upper)
    if (row["state"] or {}).get("resync") and upper is None:
        # a re-sync of an emptied table still starts a new (empty) view
        out.close()
        return _store_new(_folder(row), "part-00001.parquet", out.path, row), lower, None
    _exec("UPDATE data_source_runs SET cursor_from = %s, cursor_to = %s WHERE id = %s", (Jsonb(norm.cursor_dump(lower)), Jsonb(norm.cursor_dump(upper)), run_id))
    if upper is None or (lower is not None and (upper < lower or (upper == lower and not inclusive))):
        out.close()
        return None, lower, None  # nothing new
    batch = cfg["batch_size"]
    keep = (lambda r: r) if cfg.get("cursor_in_output", True) else (lambda r: r[:-1])
    lo, lo_inclusive = lower, inclusive
    while True:
        rows = c.read_range(row["database_name"], row["schema_name"], row["table_name"], read, column, lo, lo_inclusive, upper, batch)
        if len(rows) < batch:
            out.write([keep(r) for r in rows])
            break
        first, last = rows[0][ci], rows[-1][ci]
        if first == last:
            # a whole batch with one cursor value: take every row with that value at once
            rows = c.read_range(row["database_name"], row["schema_name"], row["table_name"], read, column, last, True, last, None)
            out.write([keep(r) for r in rows])
            lo, lo_inclusive = last, False
        else:
            out.write([keep(r) for r in rows if r[ci] != last])
            lo, lo_inclusive = last, True
        if lo == upper and not lo_inclusive:
            break
    out.close()
    resync = bool((row["state"] or {}).get("resync"))
    if out.rows == 0 and not resync:
        return None, lower, upper  # nothing new: no transaction
    folder_id = _folder(row)
    n = len([f for f in drive.list_files(folder_id) if f["name"].startswith("part-")]) + 1
    return _store_new(folder_id, f"part-{n:05d}.parquet", out.path, row), lower, upper


def _commit(row: dict, run_id: str, state: dict, rows: int, written: Optional[dict]) -> None:
    """Records the run's new view, cursor and status in one database transaction."""
    now = _now()
    with db._lock, db._connect() as conn:
        conn.execute(
            "UPDATE data_source_runs SET status = 'completed', rows = %s, item_id = %s, finished_at = %s WHERE id = %s",
            (rows, written["id"] if written else None, now, run_id),
        )
        conn.execute(
            "UPDATE data_sources SET state = %s, status = 'idle', next_run_at = %s, updated_at = %s WHERE id = %s",
            (Jsonb(state), _next_run(row["config"].get("frequency", "manual"), now), now, row["id"]),
        )


def _check_schema(c: connectors.DatabaseConnector, row: dict) -> dict:
    """Compares the table's columns with the source's: a removed column always fails the run; a
    changed type fails unless schema changes are allowed (snapshot sources), which then follow it."""
    info = c.get_table_schema(row["database_name"], row["schema_name"], row["table_name"])
    live = {col["name"]: col for col in info["columns"]}
    missing = [col["name"] for col in row["columns"] if col["name"] not in live]
    if missing:
        raise ConnectorError(f"Schema changed: {', '.join(missing)} no longer in {row['schema_name']}.{row['table_name']} — create a new data source for the new schema")
    changed = [(col, live[col["name"]]) for col in row["columns"] if live[col["name"]]["type"] != col["type"]]
    if not changed:
        return row
    what = ", ".join(f"{old['name']} is now {new['type']} ({new['db_type']}), was {old['type']}" for old, new in changed)
    if not row["config"].get("allow_schema_changes") or row["mode"] != "snapshot":
        advice = "turn on Allow schema changes" if row["mode"] == "snapshot" else "an incremental dataset cannot mix schemas: create a new data source (or re-sync after allowing changes on a snapshot source)"
        raise ConnectorError(f"Schema changed: {what} — {advice}")
    columns = [{"name": col["name"], "type": live[col["name"]]["type"], "db_type": live[col["name"]]["db_type"]} for col in row["columns"]]
    _exec("UPDATE data_sources SET columns = %s WHERE id = %s", (Jsonb(columns), row["id"]))
    log.info("data source %s: schema change followed: %s", row["id"], what)
    return {**row, "columns": columns}


# --------------------------------------------------------------------------------------------
# who a run acts as (run_as.py): a scheduled sync or export as its owner — the user who created or last saved it —
# anything else as the user who started it; never as the system with sign-in on
# --------------------------------------------------------------------------------------------


def _actor() -> Optional[str]:
    """The signed-in user saving a sync / export (its new owner); None keeps the owner (sign-in off, the system)."""
    import auth

    return auth.actor_id()


def owner_label(user_id: Optional[str]) -> Optional[dict]:
    if not user_id:
        return None
    import auth

    return auth.user_label(user_id)


def _marks(names: list[str]) -> str:
    return f"the marking{'s' if len(names) > 1 else ''} {', '.join(names)}"


def access_block(p: Optional[dict], who: str, connection_id: str, reads: list[tuple[Optional[str], str]],
                 writes: list[tuple[Optional[str], str]]) -> Optional[str]:
    """Why a sync or export may not run as `p` (None: it may). `p` must hold the markings of the connection and of every
    Files item it reads (`reads`: also a role that reads their Project) or writes (`writes`: the Editor role on their
    Project). Items are described, not named (the run record is read by everyone who sees the sync)."""
    import auth
    import run_as

    if not auth.enabled() or p is None or p.get("service"):
        return None
    missing = sorted(auth.missing_markings(auth.resource_effective("connection", connection_id), p.get("markings")))
    if missing:
        return f"{_marks(auth._marking_names(missing))} on its connection {'are' if len(missing) > 1 else 'is'} not held by {who}"
    for item_id, what in [*reads, *writes]:
        if not item_id:
            continue
        names = run_as.missing_marking_names(item_id, p)
        if names:
            return f"{_marks(names)} on {what} {'are' if len(names) > 1 else 'is'} not held by {who}"
        if not auth.outside_projects_allowed(item_id, p):
            return f"{what} is outside any Project and was not created by {who}"
    for item_id, what in reads:
        if item_id and not auth.can_access(item_id, p):
            return f"{who} has no role that reads {what} (Viewer on {auth._project_name(auth.project_of(item_id))})"
    for item_id, what in writes:
        project = auth.project_of(item_id) if item_id else None
        if project and auth._rank(auth.role_for(project, p)) < auth._rank("editor"):
            return f"{who} is not an Editor on {auth._project_name(project)}, where {what} is"
    return None


def _sync_block(row: dict, p: Optional[dict], who: str) -> Optional[str]:
    """A sync writes its dataset: the markings of the connection, the dataset's folder and files, Editor there."""
    f = db.drive_get(row["folder_id"]) if row.get("folder_id") else None
    folder = f["id"] if f and not f.get("trashed_at") else drive.default_folder("sources")
    return access_block(p, who, row["connection_id"], [], [(folder, "the sync's dataset folder"), *((i, "the synced dataset") for i in _view(row))])


def act_for(what: str, owner: Optional[str], caller: Optional[dict], scheduled: bool, block: Callable[[Optional[dict], str], Optional[str]]) -> Any:
    """Make this run thread act as the owner (a scheduled run) or the caller (any other run): a token for stop_acting.
    Raises ConnectorError("did not run: …") — before anything is read or written — when the owner is missing,
    deleted or deactivated, or `block(principal, who)` gives a reason (lost marking, no Editor role)."""
    import auth
    import run_as

    if scheduled:
        try:
            p = run_as.owner_principal(owner, f"the scheduled {what}")
        except run_as.OwnerUnavailable as e:
            raise ConnectorError(f"did not run: {e}") from None
        who = f"the {what}'s owner {run_as.who(owner)}"
    else:
        p = caller
        who = run_as.who(p.get("id")) if p and p.get("id") else "the user who started it"
    why = block(p, who)
    if why:
        raise ConnectorError(f"did not run: {why}" + (" (an Editor holding the markings must take it over: edit and save it)" if scheduled else ""))
    return auth._principal.set(p)


def stop_acting(token: Any) -> None:
    """Back to the thread's own principal (None: the system) after act_for."""
    if token is not None:
        import auth

        auth._principal.reset(token)


def _check_take_over(row: dict) -> None:
    """Saving a source makes the saver its owner (scheduled runs then act as them): they must be able to run it."""
    import auth

    why = _sync_block(row, auth.current(), "you")
    if why:
        raise HTTPException(403, f"You cannot save this sync (its scheduled runs would then run as you): {why}")


_queue_columns: set[str] = set()


def queue_lease(kind: str, holder: str, label: str, item_id: Optional[str], runs_table: str, run_id: str) -> Optional[str]:
    """A sync or export run's room in its Project's resource queue (resource_queues.py), taken before it connects and
    released when it ends (in its `finally`). While it waits the run stays "running" and its `queue` column says where
    it waits and how many jobs are ahead."""
    import resource_queues

    waited = time.monotonic()
    seen: list[dict] = []

    def record(value: Optional[dict]) -> None:
        if runs_table not in _queue_columns:
            _exec(f"ALTER TABLE {runs_table} ADD COLUMN IF NOT EXISTS queue jsonb")
            _queue_columns.add(runs_table)
        _exec(f"UPDATE {runs_table} SET queue = %s WHERE id = %s", (Jsonb(value) if value is not None else None, run_id))

    def on_wait(lease: dict) -> None:
        seen.append(lease)
        record({"name": lease["queue_name"], "waiting": True, "ahead": lease["ahead"], "in_use": lease["in_use"], "vcpu_limit": lease["vcpu_limit"],
                "vcpus": lease["vcpus"], "message": f"Waiting in the Project's resource queue {lease['queue_name']} ({lease['in_use']}/{lease['vcpu_limit']} vCPUs "
                                                    f"in use, {lease['ahead']} job{'' if lease['ahead'] == 1 else 's'} ahead)"})

    lease_id = resource_queues.acquire(item_id, resource_queues.SYNC_VCPUS, label, kind, on_wait, holder=holder)
    if seen:
        record({"name": seen[-1]["queue_name"], "waiting": False, "waited_s": round(time.monotonic() - waited, 1)})
    return lease_id


def _execute(source_id: str, run_id: str, caller: Optional[dict] = None, scheduled: bool = False) -> None:
    row = _source_row(source_id)
    out: Optional[_ParquetOut] = None
    secrets: dict = {}
    written: Optional[dict] = None  # the file this run stored, deleted again if the run fails
    lease: Optional[str] = None
    acting: Any = None  # while the run acts for its owner / the user who started it (reset before recording the end)
    try:
        # the dataset synced so far carries the connection's markings before anything else happens (datasets synced
        # before syncs were marked, a marking added to the connection since the last run); a Project constraint the
        # markings violate fails the run before it connects or writes (the data already there stays protected)
        why = _constraint_block(row)
        _widen([_live_folder(row), *_view(row)], _dataset_marks(row))
        if why:
            raise ConnectorError(f"did not run: the synced dataset would carry its connection's markings: {why}")
        # never as the system with sign-in on: the owner's (or the starter's) markings and Project role, checked
        # before the run takes a queue lease, connects or writes anything
        acting = act_for("sync", row.get("owner"), caller, scheduled, lambda p, who: _sync_block(row, p, who))
        lease = queue_lease("sync", f"datasource:{source_id}", f"{row['name']} · sync", row.get("folder_id"), "data_source_runs", run_id)
        conn_row = _connection_row(row["connection_id"])
        secrets = secretbox.unseal(conn_row.get("secret"))
        state = dict(row["state"] or {})
        delta = row["mode"] == "incremental" and row["config"].get("cursor_column") == DELTA_CURSOR
        # a delta source's first run is its initial load: a SNAPSHOT
        snapshot = row["mode"] == "snapshot" or bool(state.get("resync")) or (delta and not state.get("delta_token"))
        # delta-token upsert by key: each delta's version holds the current rows (an UPDATE of the dataset)
        upsert = delta and row["config"].get("delta_write") == "upsert"
        current_rows = 0
        txn = "SNAPSHOT" if snapshot else "UPDATE" if upsert else "APPEND"
        _exec("UPDATE data_source_runs SET transaction_type = %s WHERE id = %s", (txn, run_id))
        rewrote = False  # a change log rewritten in a widened schema (UPDATE)
        with _open(row["connection_id"], extract=True) as c:
            row = _check_schema(c, row)
            if delta:
                row = _migrate_changemode(c, row)
                state = {**state, **({"widen": True} if (row["state"] or {}).get("widen") else {})}
            # the output columns (an incremental cursor outside them is read, then dropped)
            columns, convert = _output_plan(row)
            out = _ParquetOut(columns, convert, row["config"].get("max_duration_minutes"))
            if row["mode"] == "snapshot":
                written, cursor_to = _snapshot(c, row, out), None
            elif delta:
                written, token = _delta(c, row, out, run_id)
                cursor_to = None
                if token:
                    state["delta_token"] = token
                widen = bool(state.get("widen")) and not snapshot
                if upsert:
                    written, current_rows = _upsert(row, out, run_id, snapshot, bool(state.get("compact")) or widen)
                    if written is None:
                        _exec("UPDATE data_source_runs SET transaction_type = NULL WHERE id = %s", (run_id,))
                elif widen:
                    written, rewrote = _rewrite_log(row, out, run_id), True
                    _exec("UPDATE data_source_runs SET transaction_type = 'UPDATE' WHERE id = %s", (run_id,))
            else:
                written, _, cursor_to = _incremental(c, row, out, run_id)

        # -- commit: the new view, cursor and run are recorded together --
        # (a source from before views derives its view from the folder, where this run's file already is)
        old_view = [i for i in _view(row) if not written or i != written["id"]]
        superseded: list[str] = []
        if written is None:
            view = old_view  # nothing new: the view is unchanged
        elif snapshot or upsert or rewrote:
            view = [written["id"]]
            # "keep previous snapshots" leaves old views' files in the folder as history
            superseded = [] if row["mode"] == "snapshot" and row["config"].get("snapshot_behavior") == "new" else old_view
        else:
            view = [*old_view, written["id"]]
        state["view"] = view
        state["item_id"] = view[-1] if view else None
        state["rows_total"] = current_rows if upsert else out.rows if snapshot else (state.get("rows_total") or 0) + out.rows
        if row["mode"] == "incremental" and delta:
            state.pop("resync", None)
            state.pop("compact", None)
            state.pop("widen", None)
        elif row["mode"] == "incremental":
            if cursor_to is not None:
                state["last_cursor"] = norm.cursor_dump(cursor_to)
            elif snapshot:
                state.pop("last_cursor", None)
            state.pop("resync", None)
        if written is not None and (snapshot or out.rows):
            # the sync's row count checks gate the transaction: one the run would fail leaves the previous
            # version current (an empty incremental run brings nothing new — it writes nothing, or only rewrites
            # the rows the dataset already holds — and is never stopped)
            import health_checks

            stop = health_checks.sync_gate(source_id, out.rows, state["rows_total"])
            if stop:
                raise ConnectorError(stop)
        # the new view is marked with the connection's current markings before it becomes current (one added during
        # the run reaches the files the run started with too); the markings applied are recorded
        fresh = _source_row(source_id)  # the folder may have been recreated by this run
        folder_now = _live_folder(fresh)
        marks = _dataset_marks(row)
        why = _constraint_block(fresh, marks, view)
        _widen([folder_now, *view], marks)
        if why:  # a marking added to the connection during the run: the new view is not committed
            raise ConnectorError(f"the synced dataset would carry its connection's markings: {why}")
        applied = set(state.get("marks") or [])
        if marks or applied:
            state["marks"] = sorted(marks)
        _commit(row, run_id, state, out.rows, written)
        written_now, written = written is not None, None  # committed
        # markings a run applied that the connection no longer has come off its dataset (after the commit)
        _narrow([folder_now, *view], applied - marks)
        # a replaced snapshot takes the canonical name once the old file is gone
        _drop_files([i for i in superseded if i not in view])
        if ((snapshot and row["mode"] == "snapshot" and row["config"].get("snapshot_behavior") != "new") or (upsert and written_now)) and view:
            try:
                drive.update_item(view[0], drive.ItemChange(name=f"{drive._clean_name(drive.BAD_NAME.sub('_', row['name']))}.parquet"))
            except Exception:
                pass
        log.info("data source %s: run %s committed %s with %d rows", source_id, run_id, txn, out.rows)
    except Exception as e:
        acting = stop_acting(acting)  # the failure is recorded by the platform
        if written is not None:
            # abort: the stored file never joined the view
            _drop_files([written["id"]])
        message = str(e) if isinstance(e, ConnectorError) else str(e.detail) if isinstance(e, HTTPException) else scrub(f"{type(e).__name__}: {e}", secrets)
        if not isinstance(e, ConnectorError):
            log.error("data source %s: run %s failed: %s", source_id, run_id, message)
        now = _now()
        try:
            _exec("UPDATE data_source_runs SET status = 'failed', error = %s, finished_at = %s WHERE id = %s", (message[:2000], now, run_id))
        except Exception:
            log.exception("data source %s: could not record the failed run", source_id)
        try:
            try:
                next_run = _next_run(row["config"].get("frequency", "manual"), now)
            except Exception:
                next_run = None
            # never left "running": the source can be run again
            _exec("UPDATE data_sources SET status = 'failed', next_run_at = %s, updated_at = %s WHERE id = %s", (next_run, now, source_id))
        except Exception:
            log.exception("data source %s: could not record the failed run", source_id)
    finally:
        stop_acting(acting)
        if lease:
            import resource_queues

            try:
                resource_queues.release(lease)
            except Exception:  # noqa: BLE001 - it then expires by itself
                log.exception("data source %s: could not release the resource queue lease", source_id)
        if out:
            out.discard()
        with _running_lock:
            _running.discard(source_id)
        # the sync's checks (status, freshness, row count) see the run now; subscribers hear of a change in the app
        try:
            import health_checks

            health_checks.evaluate_sync_checks(f"source:{source_id}")
        except Exception:
            log.exception("data source %s: sync checks failed", source_id)


def _scheduler() -> None:
    """Starts scheduled runs when they are due (checked every 30 seconds)."""
    while True:
        time.sleep(30)
        try:
            due = _rows("SELECT id FROM data_sources WHERE next_run_at IS NOT NULL AND next_run_at <= %s AND status <> 'running'", (_now(),))
            for r in due:
                try:
                    start_run(r["id"], "schedule")
                except HTTPException:
                    pass
        except Exception:
            log.exception("data source scheduler")

