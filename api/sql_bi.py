"""Connectivity: SQL & BI (Analytics doc 11) — read-only SQL over datasets and Ontology objects for BI tools.

A PostgreSQL wire-protocol endpoint (the role of Foundry SQL Server): standard PostgreSQL ODBC / JDBC drivers and the
PostgreSQL connectors of Power BI, Tableau, Excel, Qlik Sense or Report Builder connect to it with any user name
and a personal API token (bsai_pat_…) as the password; queries run as the token's owner (Files permissions and
markings for datasets, object security for objects). With sign-in off (development) any password is accepted.

- Tables: a Parquet dataset in Files is "<Project>"."<folder>/<name>" (also "/Project/folder/name" as one quoted
  identifier, Foundry's ANSI style); object types are "ontology"."<api name>". Data loads when a query names it.
- SQL is DuckDB's (close to PostgreSQL / ANSI); pg_catalog and information_schema answer the drivers' catalog
  queries. Read-only: statements that write are refused; SET / BEGIN / COMMIT … are accepted and ignored.
- Protocol: simple and extended query (Parse / Bind / Describe / Execute / Sync), text and binary results (Npgsql,
  used by Power BI, asks for binary). No TLS: the endpoint listens on 127.0.0.1 unless BLUESANDAI_SQL_HOST says
  otherwise; BLUESANDAI_SQL_PORT (default 5433, "off" disables it).
- REST: POST /api/sql-bi/query (JSON or CSV) for tools without a driver (Power Query's Web connector, scripts).
- Branch (Foundry's connection parameter): datasets are read from that branch, falling back to master when a dataset
  has no such branch — set at connect (`options=-c branch=<name>`), in a session (`SET branch = '<name>'`) or as
  "branch" in the REST body. Branch copies (`_branches/…`) are not listed as tables of their own.
- Results stream: the wire protocol reads DuckDB's result in record batches as the client takes rows (simple query,
  Execute with a fetch size, or SQL cursors: DECLARE … CURSOR FOR, FETCH n / ALL, CLOSE), so there is no row limit
  there; the REST endpoint returns at most 1,000,000 rows. One open result per session: a new statement ends it.
- Dialect: DuckDB SQL by default; Foundry's Spark SQL with `options=-c dialect=spark`, `SET dialect = 'spark'` or
  "dialect" in REST — translated to DuckDB with sqlglot (`/path` in backticks names a dataset).
- OAuth: a Developer Console application's access token is accepted as the password too; its session sees only the
  object types in the application's scopes (no datasets: applications are not scoped to datasets).
- TLS: with BLUESANDAI_SQL_TLS_CERT and BLUESANDAI_SQL_TLS_KEY (PEM files) the endpoint answers SSLRequest and
  encrypts the session (sslmode=require / verify-full); BLUESANDAI_SQL_TLS_REQUIRED=1 refuses unencrypted sessions.
- Cancellation: the protocol's CancelRequest (the drivers' Cancel button / statement timeout) interrupts the
  session's running query (SQLSTATE 57014); REST queries take a timeout and can be listed and cancelled by id.

Mounted by server.py under /api/sql-bi; startup() opens the port.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
import os
import re
import secrets
import socketserver
import ssl
import struct
import threading
import types
import uuid
from decimal import Decimal
from typing import Any, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth

log = logging.getLogger("sql_bi")
router = APIRouter(prefix="/api/sql-bi")
MAX_ROWS = 1_000_000
PG_EPOCH = dt.date(2000, 1, 1)
PG_EPOCH_TS = dt.datetime(2000, 1, 1)
STATE: dict[str, Any] = {"server": None, "port": None, "host": None, "error": None, "connections": 0, "queries": 0}
_schema_cache: dict[tuple, pa.Schema] = {}
_lock = threading.Lock()
# running queries by id, and protocol sessions by (process id, secret key) for CancelRequest
_RUNNING: dict[str, "Engine"] = {}
_KEYS: dict[tuple[int, int], "Engine"] = {}
_pids = iter(range(1000, 1 << 30))
# the TLS context when a certificate is configured (startup), and whether sessions must use it
_TLS: dict[str, Any] = {"context": None, "required": False}
WRITE_RE = re.compile(r"^\s*(insert|update|delete|merge|create|drop|alter|truncate|copy|attach|detach|install|load|export|import|pragma|call|checkpoint|vacuum|grant|revoke|use)\b", re.I)
NOOP_RE = re.compile(r"^\s*(set|reset|begin|start\s+transaction|commit|end|rollback|abort|discard|deallocate|close|unlisten|listen|savepoint|release)\b", re.I)


class SqlError(Exception):
    def __init__(self, message: str, code: str = "42000") -> None:
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------ catalog and engine


def _ident(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def catalog() -> list[dict]:
    """The tables the current user can query: datasets ({schema, table, item}) and object types; an application's OAuth
    token: the object types in its scopes only."""
    import db
    import drive
    import pipeline_datasets

    out = []
    app = _app_resources()
    if db.enabled() and app is None:
        items = auth.visible(db.drive_query("content_type = %s AND trashed_at IS NULL", (pipeline_datasets.PARQUET,), order="updated_at DESC", limit=1000))
        seen = set()
        for it in items:
            path = [p["name"] for p in drive._with_path(it).get("path") or []]
            if "_branches" in path:
                continue  # a branch's copy: read through the Branch setting
            schema = path[0] if path else "Files"
            table = "/".join([*path[1:], it["name"].removesuffix(".parquet")])
            if (schema.lower(), table.lower()) in seen:
                continue
            seen.add((schema.lower(), table.lower()))
            out.append({"kind": "dataset", "schema": schema, "table": table, "item": it, "path": "/" + "/".join([*path, it["name"].removesuffix(".parquet")])})
    try:
        import ontology

        taken: set[str] = set()
        for t in auth.visible_resources("object_type", ontology._all("object-types")):
            if app is not None and t["id"] not in (app.get("object_types") or []):
                continue
            # API names repeat across ontologies: the oldest type keeps the name, the others add their ID
            name = t["api_name"] if t["api_name"].lower() not in taken else f"{t['api_name']}_{t['id']}"
            taken.add(name.lower())
            out.append({"kind": "object_type", "schema": "ontology", "table": name, "type": t})
    except Exception:  # noqa: BLE001 — the Ontology is optional for SQL clients
        pass
    return out


def _dataset_schema(it: dict) -> pa.Schema:
    import drive
    import pyarrow.parquet as pq

    key = (it["id"], str(it.get("updated_at")))
    with _lock:
        if key in _schema_cache:
            return _schema_cache[key]
    schema = pq.ParquetFile(io.BytesIO(drive.read_bytes(it))).schema_arrow
    with _lock:
        _schema_cache[key] = schema
    return schema


def _object_table(t: dict) -> pa.Table:
    import workshop

    cols, _types, rows = workshop._object_rows(t["id"])
    data = [{"__primary_key": r.get("__pk"), **{c: _plain(r.get(c)) for c in cols}} for r in rows]
    try:
        return pa.Table.from_pylist(data) if data else pa.table({"__primary_key": pa.array([], pa.string()), **{c: pa.array([], pa.string()) for c in cols}})
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        return pa.Table.from_pylist([{k: None if v is None else str(v) for k, v in r.items()} for r in data])


def _plain(v: Any) -> Any:
    return v if v is None or isinstance(v, (str, int, float, bool)) else json.dumps(v, default=str)


class Engine:
    """One client session: a DuckDB connection with empty placeholder tables until a query names them."""

    def __init__(self, principal: Optional[dict], branch: Optional[str] = None, dialect: Optional[str] = None) -> None:
        import duckdb

        self.principal = principal
        self.stream: Optional["ResultStream"] = None
        self.cursors: dict[str, "ResultStream"] = {}
        self.dialect = "spark" if str(dialect or "").lower() == "spark" else "duckdb"
        self.branch = branch if branch and branch != "master" else None
        self.id = uuid.uuid4().hex[:12]
        self.current: Optional[dict] = None
        self.cancelled = False
        self.con = duckdb.connect(config={"enable_external_access": False})
        self.tables: dict[tuple[str, str], dict] = {}
        self.loaded: set[tuple[str, str]] = set()
        with self.as_user():
            entries = catalog()
        for e in entries:
            self.con.execute(f"CREATE SCHEMA IF NOT EXISTS {_ident(e['schema'])}")
            key = (e["schema"].lower(), e["table"].lower())
            self.tables[key] = e
            try:
                with self.as_user():
                    schema = _dataset_schema(e["item"]) if e["kind"] == "dataset" else None
                if schema is None:
                    t = e["type"]
                    cols = ["__primary_key"] + [p["api_name"] for p in t["properties"]]
                    ddl = ", ".join(f"{_ident(c)} VARCHAR" for c in cols)
                else:
                    empty = pa.Table.from_batches([], schema=schema)
                    self.con.register("__empty", empty)
                    self.con.execute(f"CREATE TABLE {_ident(e['schema'])}.{_ident(e['table'])} AS SELECT * FROM __empty LIMIT 0")
                    self.con.unregister("__empty")
                    continue
                self.con.execute(f"CREATE TABLE {_ident(e['schema'])}.{_ident(e['table'])} ({ddl})")
            except Exception as ex:  # noqa: BLE001 — an unreadable dataset is left out of the catalog
                log.info("sql: skipping %s: %s", e.get("path") or e["table"], ex)
                self.tables.pop(key, None)

        # pg_attribute lists DuckDB's own type IDs: drivers join them to pg_type, so map them to PostgreSQL's OIDs
        self.con.execute(
            "CREATE TEMP VIEW __pg_attribute AS SELECT * REPLACE (CASE atttypid WHEN 10 THEN 16 WHEN 11 THEN 21 WHEN 12 THEN 21 WHEN 13 THEN 23 "
            "WHEN 14 THEN 20 WHEN 15 THEN 1082 WHEN 16 THEN 1083 WHEN 19 THEN 1114 WHEN 32 THEN 1184 WHEN 22 THEN 700 WHEN 23 THEN 701 "
            "WHEN 21 THEN 701 WHEN 26 THEN 17 ELSE 1043 END AS atttypid) FROM pg_catalog.pg_attribute")

    def as_user(self):
        import contextlib

        @contextlib.contextmanager
        def ctx():
            token = auth._principal.set(self.principal)
            try:
                yield
            finally:
                auth._principal.reset(token)

        return ctx()

    def _rewrite(self, sql: str) -> str:
        # Foundry's ANSI style: a whole path as one quoted identifier
        def path(m: re.Match) -> str:
            p = m.group(1).replace('""', '"')
            parts = [x for x in p.split("/") if x]
            if len(parts) < 2:
                return m.group(0)
            return f"{_ident(parts[0])}.{_ident('/'.join(parts[1:]))}"

        sql = re.sub(r'"(/(?:[^"]|"")+)"', path, sql)
        # Spark style: backticks
        return re.sub(r"`(/[^`]+)`", lambda m: path(re.match(r'"(.*)"', '"' + m.group(1) + '"')), sql)

    def _referenced(self, sql: str) -> list[tuple[str, str]]:
        low = sql.lower()
        # the name as a whole identifier (bare or quoted), not inside another word
        return [key for key, e in self.tables.items() if re.search(r"(?<![\w/])" + re.escape(e["table"].lower()) + r"(?![\w/])", low)]

    def _audit(self, sql: str, keys: list[tuple[str, str]], rows: Optional[int], error: Optional[str] = None) -> None:
        """One audit.3 line per statement that reads data: the datasets and object types it loaded (BI tools over the
        wire protocol and the HTTP endpoint alike)."""
        if not keys:
            return
        import audit3

        ds = [{"type": "dataset", "id": self.tables[k]["item"]["id"], "name": self.tables[k].get("path")} for k in keys if self.tables[k]["kind"] == "dataset"]
        ots = [{"type": "object-type", "id": self.tables[k]["type"]["id"], "name": self.tables[k]["type"].get("api_name")} for k in keys if self.tables[k]["kind"] == "object_type"]
        req = {"sqlQuery": sql[:4000], "dialect": self.dialect, "branch": self.branch or "master", "connectionId": self.id}
        if ds:
            req["loadedResources"] = ds
        if ots:
            req.update(ontologyDataLoadContext={"source": "sql-bi"}, requestedOntologyDataResources=ots)
        with self.as_user():
            audit3.emit("SQL_BI_QUERY", (["dataLoad"] if ds else []) + (["ontologyDataLoad"] if ots else []), req,
                        {"rowCount": rows, **({"loadedOntologyDataResources": ots} if ots else {}), **({"error": error[:500]} if error else {})},
                        result="ERROR" if error else "SUCCESS", product="sql-bi")

    def _load_referenced(self, sql: str) -> None:
        for key in self._referenced(sql):
            e = self.tables[key]
            if key in self.loaded:
                continue
            with self.as_user():
                if e["kind"] == "dataset":
                    import drive
                    import pyarrow.parquet as pq

                    t = pq.ParquetFile(io.BytesIO(drive.read_bytes(drive._item(self._branch_item(e["item"]))))).read()
                else:
                    t = _object_table(e["type"])
            name = f"__t{len(self.loaded)}"
            self.con.register(name, t)
            self.con.execute(f"DROP TABLE IF EXISTS {_ident(e['schema'])}.{_ident(e['table'])}")
            self.con.execute(f"CREATE TABLE {_ident(e['schema'])}.{_ident(e['table'])} AS SELECT * FROM {name}")
            self.con.unregister(name)
            self.loaded.add(key)

    def _branch_item(self, item: dict) -> str:
        """The dataset's item on the session's branch, else master's (the fallback)."""
        if not self.branch:
            return item["id"]
        import dataset_preview

        try:
            return next((b["item_id"] for b in dataset_preview.branches(item) if b["branch"] in (self.branch, self.branch.replace("/", "-"))), item["id"])
        except Exception:  # noqa: BLE001 — no branch information: master
            return item["id"]

    def set_branch(self, branch: Optional[str]) -> None:
        """Switch branches: datasets already loaded are read again on their next use."""
        branch = branch if branch and branch != "master" else None
        if branch != self.branch:
            self.branch = branch
            self.loaded = {k for k in self.loaded if self.tables.get(k, {}).get("kind") != "dataset"}

    def statements(self, sql: str) -> list[str]:
        try:
            return [s.query.strip() for s in self.con.extract_statements(sql) if s.query.strip()]
        except Exception:  # noqa: BLE001 — let execution report the syntax error
            return [sql.strip()] if sql.strip() else []

    def run(self, sql: str, params: Optional[list] = None, stream: bool = False) -> tuple[Any, str]:
        """(result table or None, command tag)."""
        STATE["queries"] += 1
        s = sql.strip().rstrip(";").strip()
        if not s:
            return None, "EMPTY"
        # SQL cursors (psql, psycopg's named cursors): a streamed result read with FETCH
        m = re.match(r"^\s*declare\s+\"?(\w+)\"?\s+(?:binary\s+)?(?:(?:no\s+)?scroll\s+)?cursor\s+(?:with(?:out)?\s+hold\s+)?for\s+(.+)$", s, re.I | re.S)
        if m:
            st, _ = self.run(m.group(2), params, stream=True)
            if not isinstance(st, ResultStream):
                raise SqlError("a cursor needs a query", "42601")
            self.cursors[m.group(1).lower()] = st
            return None, "DECLARE CURSOR"
        # FETCH [FORWARD] n | ALL FROM c, or FETCH [NEXT] FROM c (one row)
        m = re.match(r"^\s*fetch\s+(?:forward\s+)?(\d+|all)\s+(?:from|in)\s+\"?(\w+)\"?\s*$", s, re.I) or re.match(r"^\s*fetch\s+(?:next\s+)?()(?:from|in)\s+\"?(\w+)\"?\s*$", s, re.I)
        if m:
            count, name = m.group(1) or "1", m.group(2)
            st = self.cursors.get(name.lower())
            if st is None:
                raise SqlError(f'cursor "{name}" does not exist', "34000")
            want = 0 if (count or "1").lower() == "all" else int(count or 1)
            parts = []
            got = 0
            while not want or got < want:
                chunk = st.take(want - got if want else 0)
                if chunk is None:
                    break
                parts.append(chunk)
                got += chunk.num_rows
            t = pa.concat_tables(parts) if parts else pa.Table.from_batches([], schema=st.schema)
            return t, f"FETCH {t.num_rows}"
        m = re.match(r"^\s*close\s+\"?(\w+)\"?\s*$", s, re.I)
        if m and m.group(1).lower() in self.cursors:
            self.cursors.pop(m.group(1).lower()).close()
            return None, "CLOSE CURSOR"
        m = re.match(r"^\s*set\s+(?:session\s+)?branch\s*(?:=|to)\s*'?([^';]*?)'?\s*$", s, re.I)
        if m:
            self.set_branch(m.group(1).strip() or None)
            return None, "SET"
        m = re.match(r"^\s*show\s+branch\s*$", s, re.I)
        if m:
            return pa.table({"branch": [self.branch or "master"]}), "SHOW"
        m = re.match(r"^\s*set\s+(?:session\s+)?dialect\s*(?:=|to)\s*'?(\w+)'?\s*$", s, re.I)
        if m:
            if m.group(1).lower() not in ("spark", "duckdb"):
                raise SqlError("the dialect is spark or duckdb", "22023")
            self.dialect = m.group(1).lower()
            return None, "SET"
        if re.match(r"^\s*show\s+dialect\s*$", s, re.I):
            return pa.table({"dialect": [self.dialect]}), "SHOW"
        if NOOP_RE.match(s):
            word = s.split()[0].upper()
            return None, {"START": "BEGIN", "END": "COMMIT", "ABORT": "ROLLBACK"}.get(word, word)
        m = re.match(r"^\s*show\s+(\w+)", s, re.I)
        if m and not re.match(r"^\s*show\s+(tables|all|databases)", s, re.I):
            val = {"transaction_isolation": "read committed", "server_version": "14.0", "server_encoding": "UTF8", "client_encoding": "UTF8",
                   "standard_conforming_strings": "on", "datestyle": "ISO, MDY", "timezone": "UTC", "search_path": '"$user", public',
                   "max_identifier_length": "63", "integer_datetimes": "on"}.get(m.group(1).lower(), "")
            return pa.table({m.group(1).lower(): [val]}), "SHOW"
        if WRITE_RE.match(s):
            raise SqlError("this SQL endpoint is read-only", "25006")
        if self.dialect == "spark":
            import sqlglot

            try:
                s = sqlglot.transpile(s, read="spark", write="duckdb")[0]
            except sqlglot.errors.ParseError as e:
                raise SqlError(f"Spark SQL: {str(e).splitlines()[0][:500]}", "42601") from None
        s = self._rewrite(s)
        s = re.sub(r"::regclass\b", "::VARCHAR", s, flags=re.I)
        s = re.sub(r"(?<![\w.])(?:pg_catalog\.)?pg_attribute\b", "__pg_attribute", s, flags=re.I)
        self._load_referenced(s)
        keys = self._referenced(s)
        if self.stream is not None:
            self.stream.close()  # a new statement ends an open result on this connection
        self.cancelled = False
        self.current = {"sql": sql[:2000], "started": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
        _RUNNING[self.id] = self
        streaming = False
        try:
            res = self.con.execute(s, params or [])
            if res.description is None:
                return None, "OK"
            if stream:
                streaming = True
                self.stream = ResultStream(self, res.fetch_record_batch(STREAM_BATCH))
                self._audit(sql, keys, None)
                return self.stream, "SELECT"
            t = res.arrow()
            t = t.read_all() if hasattr(t, "read_all") else t
        except Exception as e:  # noqa: BLE001 — DuckDB errors become SQL errors
            streaming = False
            err = _sql_error(self, e)
            self._audit(sql, keys, None, str(err))
            raise err from None
        finally:
            if not streaming:
                _RUNNING.pop(self.id, None)
                self.current = None
        if t.num_rows > MAX_ROWS:
            t = t.slice(0, MAX_ROWS)
        self._audit(sql, keys, t.num_rows)
        return t, f"SELECT {t.num_rows}"


STREAM_BATCH = 50_000


def _sql_error(eng: "Engine", e: Exception) -> "SqlError":
    if eng.cancelled or "interrupt" in str(e).lower():
        return SqlError("canceling statement due to user request", "57014")
    return SqlError(str(e).split("\n")[0][:1000])


class ResultStream:
    """A query's rows read from DuckDB in record batches as the client takes them (no row limit); the query counts
    as running (cancellable) until its rows are read or another statement starts."""

    def __init__(self, eng: "Engine", reader) -> None:
        self.eng, self.reader, self.schema = eng, reader, reader.schema
        self.buf: Optional[pa.Table] = None
        self.taken = 0
        self.done = False

    def take(self, n: int = 0) -> Optional[pa.Table]:
        """Up to n rows (0: the next batch), or None at the end."""
        if self.done:
            return None
        while self.buf is None or self.buf.num_rows == 0:
            try:
                batch = self.reader.read_next_batch()
            except StopIteration:
                self.close()
                return None
            except Exception as e:  # noqa: BLE001 — a cancelled or failed read
                self.close()
                raise _sql_error(self.eng, e) from None
            self.buf = pa.Table.from_batches([batch])
        k = self.buf.num_rows if n <= 0 else min(n, self.buf.num_rows)
        out, self.buf = self.buf.slice(0, k), self.buf.slice(k)
        self.taken += k
        return out

    def close(self) -> None:
        if not self.done:
            self.done = True
            _RUNNING.pop(self.eng.id, None)
            self.eng.current = None
            if self.eng.stream is self:
                self.eng.stream = None


def cancel(eng: "Engine") -> bool:
    """Interrupt the engine's running query (from another thread); False when nothing runs."""
    if eng.current is None:
        return False
    eng.cancelled = True
    eng.con.interrupt()
    return True


def _app_resources() -> Optional[dict]:
    """The calling application's resources when the session signed in with an OAuth token, else None."""
    scope = str((auth.current() or {}).get("scope") or "")
    if not scope.startswith("oauth:"):
        return None
    import developer_console

    return developer_console.app_resources(scope[6:])


def principal_for_password(password: str) -> tuple[bool, Optional[dict]]:
    if not auth.enabled():
        return True, None
    req = types.SimpleNamespace(headers={"authorization": f"Bearer {password}"}, cookies={}, method="GET", state=types.SimpleNamespace())
    try:
        p = auth._principal_for(req)
    except Exception:  # noqa: BLE001
        p = None
    # personal API tokens, and applications' OAuth access tokens (limited to their object types in catalog())
    if not p or not (p.get("scope", "full") == "full" or str(p.get("scope")).startswith("oauth:")):
        return False, None
    return True, p


# ------------------------------------------------------------------ value encoding


def _oid(t: pa.DataType) -> int:
    if pa.types.is_boolean(t):
        return 16
    if pa.types.is_int8(t) or pa.types.is_int16(t) or pa.types.is_uint8(t):
        return 21
    if pa.types.is_int32(t) or pa.types.is_uint16(t):
        return 23
    if pa.types.is_integer(t):
        return 20
    if pa.types.is_float32(t):
        return 700
    if pa.types.is_floating(t) or pa.types.is_decimal(t):
        return 701
    if pa.types.is_date(t):
        return 1082
    if pa.types.is_timestamp(t):
        return 1184 if t.tz else 1114
    if pa.types.is_binary(t) or pa.types.is_large_binary(t):
        return 17
    return 25


def _text(v: Any) -> bytes:
    if isinstance(v, bool):
        return b"t" if v else b"f"
    if isinstance(v, dt.datetime):
        return v.isoformat(sep=" ").encode()
    if isinstance(v, (dt.date, dt.time)):
        return v.isoformat().encode()
    if isinstance(v, (bytes, bytearray)):
        return b"\\x" + bytes(v).hex().encode()
    if isinstance(v, (list, dict)):
        return json.dumps(v, default=str).encode()
    if isinstance(v, Decimal):
        return format(v, "f").encode()
    return str(v).encode()


def _binary(v: Any, oid: int) -> bytes:
    if oid == 16:
        return b"\x01" if v else b"\x00"
    if oid == 21:
        return struct.pack("!h", int(v))
    if oid == 23:
        return struct.pack("!i", int(v))
    if oid == 20:
        return struct.pack("!q", int(v))
    if oid == 700:
        return struct.pack("!f", float(v))
    if oid == 701:
        return struct.pack("!d", float(v))
    if oid == 1082:
        return struct.pack("!i", (v - PG_EPOCH).days)
    if oid in (1114, 1184):
        if v.tzinfo:
            v = v.astimezone(dt.timezone.utc).replace(tzinfo=None)
        delta = v - PG_EPOCH_TS
        return struct.pack("!q", (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds)
    if oid == 17:
        return bytes(v)
    return _text(v)


def _decode_param(data: Optional[bytes], fmt: int, oid: int) -> Any:
    if data is None:
        return None
    if fmt == 0:
        s = data.decode("utf-8")
        if oid in (21, 23, 20):
            return int(s)
        if oid in (700, 701, 1700):
            return float(s)
        if oid == 16:
            return s.lower() in ("t", "true", "1", "on", "yes")
        return s
    if oid == 16:
        return data != b"\x00"
    if oid == 21:
        return struct.unpack("!h", data)[0]
    if oid == 23:
        return struct.unpack("!i", data)[0]
    if oid == 20:
        return struct.unpack("!q", data)[0]
    if oid == 700:
        return struct.unpack("!f", data)[0]
    if oid == 701:
        return struct.unpack("!d", data)[0]
    if oid == 1082:
        return PG_EPOCH + dt.timedelta(days=struct.unpack("!i", data)[0])
    if oid in (1114, 1184):
        return PG_EPOCH_TS + dt.timedelta(microseconds=struct.unpack("!q", data)[0])
    return data.decode("utf-8", "replace")


# ------------------------------------------------------------------ wire protocol


class PgHandler(socketserver.BaseRequestHandler):
    def setup(self) -> None:
        self.buf = b""
        self.engine: Optional[Engine] = None
        self.stmts: dict[str, dict] = {}
        self.portals: dict[str, dict] = {}
        self.skip_to_sync = False

    # -- io
    def _recv(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.request.recv(65536)
            if not chunk:
                raise ConnectionError("client closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, kind: bytes, payload: bytes = b"") -> None:
        self.request.sendall(kind + struct.pack("!i", len(payload) + 4) + payload)

    @staticmethod
    def _cstr(s: str) -> bytes:
        return s.encode("utf-8") + b"\x00"

    def _error(self, message: str, code: str = "42000") -> None:
        self._send(b"E", b"SERROR\x00" + b"VERROR\x00" + b"C" + self._cstr(code) + b"M" + self._cstr(message) + b"\x00")

    def _ready(self) -> None:
        self._send(b"Z", b"I")

    def _row_description(self, t: pa.Table, formats: list[int]) -> None:
        cols = []
        for i, f in enumerate(t.schema):
            fmt = formats[0] if len(formats) == 1 else (formats[i] if i < len(formats) else 0)
            cols.append(self._cstr(f.name) + struct.pack("!ihihih", 0, 0, _oid(f.type), -1, -1, fmt))
        self._send(b"T", struct.pack("!h", len(cols)) + b"".join(cols))

    def _data_rows(self, t: pa.Table, formats: list[int], start: int = 0, limit: int = 0) -> int:
        oids = [_oid(f.type) for f in t.schema]
        end = t.num_rows if not limit else min(t.num_rows, start + limit)
        out = []
        for batch in t.slice(start, end - start).to_batches(max_chunksize=2000):
            cols = [c.to_pylist() for c in batch.columns]
            for r in range(batch.num_rows):
                parts = [struct.pack("!h", len(cols))]
                for i, col in enumerate(cols):
                    v = col[r]
                    if v is None:
                        parts.append(struct.pack("!i", -1))
                        continue
                    fmt = formats[0] if len(formats) == 1 else (formats[i] if i < len(formats) else 0)
                    b = _binary(v, oids[i]) if fmt == 1 else _text(v)
                    parts.append(struct.pack("!i", len(b)) + b)
                out.append(b"D" + struct.pack("!i", sum(len(p) for p in parts) + 4) + b"".join(parts))
                if len(out) >= 500:
                    self.request.sendall(b"".join(out))
                    out = []
        if out:
            self.request.sendall(b"".join(out))
        return end - start

    # -- session
    def handle(self) -> None:
        STATE["connections"] += 1
        try:
            if not self._startup():
                return
            while True:
                kind = self._recv(1)
                (length,) = struct.unpack("!i", self._recv(4))
                body = self._recv(length - 4)
                if kind == b"X":
                    return
                if self.skip_to_sync and kind != b"S":
                    continue
                try:
                    self._dispatch(kind, body)
                except SqlError as e:
                    self._error(str(e), e.code)
                    if kind == b"Q":
                        self._ready()
                    else:
                        self.skip_to_sync = True
                except Exception as e:  # noqa: BLE001 — reported to the client, the session continues
                    log.exception("sql: %s", e)
                    self._error(f"internal error: {e}", "XX000")
                    if kind == b"Q":
                        self._ready()
                    else:
                        self.skip_to_sync = True
        except (ConnectionError, OSError):
            return
        finally:
            STATE["connections"] -= 1
            _KEYS.pop(getattr(self, "key", None), None)
            if self.engine:
                try:
                    self.engine.con.close()
                except Exception:  # noqa: BLE001
                    pass

    def _startup(self) -> bool:
        while True:
            (length,) = struct.unpack("!i", self._recv(4))
            body = self._recv(length - 4)
            (code,) = struct.unpack("!i", body[:4])
            if code == 80877103 and _TLS["context"] and not getattr(self, "tls", False):  # SSLRequest: encrypt from here on
                self.request.sendall(b"S")
                self.request = _TLS["context"].wrap_socket(self.request, server_side=True)
                self.buf = b""
                self.tls = True
                continue
            if code in (80877103, 80877104):  # SSLRequest without a certificate / GSSENCRequest: not supported
                self.request.sendall(b"N")
                continue
            if code == 80877102:  # CancelRequest (on a new connection): process id and secret key of the session
                pid, key = struct.unpack("!ii", body[4:12])
                eng = _KEYS.get((pid, key))
                if eng:
                    cancel(eng)
                return False
            break
        if _TLS["required"] and not getattr(self, "tls", False):
            self._error("this endpoint requires TLS: connect with sslmode=require", "28000")
            return False
        parts = body[4:].split(b"\x00")
        params = {parts[i].decode(): parts[i + 1].decode() for i in range(0, len(parts) - 1, 2) if parts[i]}
        self._send(b"R", struct.pack("!i", 3))  # cleartext password
        kind = self._recv(1)
        (length,) = struct.unpack("!i", self._recv(4))
        pw = self._recv(length - 4).rstrip(b"\x00").decode("utf-8", "replace")
        if kind != b"p":
            return False
        ok, principal = principal_for_password(pw)
        if not ok:
            self._error("authentication failed: use a personal API token (Account > API tokens) as the password", "28P01")
            return False
        try:
            # Branch: "-c branch=<name>" in the startup options (libpq / JDBC `options`), or a "branch" parameter
            opt = re.search(r"(?:^|\s)-c\s*branch=(\S+)", params.get("options", "")) or re.search(r"(?:^|\s)--branch=(\S+)", params.get("options", ""))
            dia = re.search(r"(?:^|\s)-c\s*dialect=(\w+)", params.get("options", ""))
            self.engine = Engine(principal, params.get("branch") or (opt.group(1) if opt else None), dia.group(1) if dia else None)
        except Exception as e:  # noqa: BLE001
            self._error(f"could not open the catalog: {e}", "XX000")
            return False
        self._send(b"R", struct.pack("!i", 0))
        for k, v in (("server_version", "14.0 (BluesandAI SQL)"), ("server_encoding", "UTF8"), ("client_encoding", "UTF8"), ("DateStyle", "ISO, MDY"),
                     ("TimeZone", "UTC"), ("integer_datetimes", "on"), ("standard_conforming_strings", "on"), ("application_name", params.get("application_name", "")),
                     ("is_superuser", "off"), ("session_authorization", params.get("user", "")), ("IntervalStyle", "postgres")):
            self._send(b"S", self._cstr(k) + self._cstr(v))
        self.key = (next(_pids), secrets.randbits(31))
        _KEYS[self.key] = self.engine
        self._send(b"K", struct.pack("!ii", *self.key))
        self._ready()
        return True

    def _dispatch(self, kind: bytes, body: bytes) -> None:
        eng = self.engine
        assert eng is not None
        if kind == b"Q":
            sql = body.rstrip(b"\x00").decode("utf-8")
            stmts = eng.statements(sql)
            if not stmts:
                self._send(b"I")
            for s in stmts:
                t, tag = eng.run(s, stream=True)
                if isinstance(t, ResultStream):
                    self._row_description(t, [0])
                    n = self._send_stream(t, [0])
                    tag = f"SELECT {n}"
                elif t is not None:
                    self._row_description(t, [0])
                    n = self._data_rows(t, [0])
                    tag = f"SELECT {n}" if tag.startswith("SELECT") else tag
                self._send(b"C", self._cstr(tag))
            self._ready()
        elif kind == b"P":
            name, rest = body.split(b"\x00", 1)
            query, rest = rest.split(b"\x00", 1)
            (n,) = struct.unpack("!h", rest[:2])
            oids = list(struct.unpack(f"!{n}i", rest[2:2 + 4 * n])) if n else []
            self.stmts[name.decode()] = {"sql": query.decode("utf-8"), "oids": oids}
            self._send(b"1")
        elif kind == b"B":
            portal, rest = body.split(b"\x00", 1)
            stmt, rest = rest.split(b"\x00", 1)
            st = self.stmts.get(stmt.decode())
            if st is None:
                raise SqlError(f"unknown prepared statement {stmt.decode()!r}", "26000")
            pos = 0
            (nf,) = struct.unpack("!h", rest[pos:pos + 2])
            pos += 2
            pfmts = list(struct.unpack(f"!{nf}h", rest[pos:pos + 2 * nf]))
            pos += 2 * nf
            (np_,) = struct.unpack("!h", rest[pos:pos + 2])
            pos += 2
            values = []
            for i in range(np_):
                (ln,) = struct.unpack("!i", rest[pos:pos + 4])
                pos += 4
                data = None if ln == -1 else rest[pos:pos + ln]
                pos += max(ln, 0)
                fmt = pfmts[0] if len(pfmts) == 1 else (pfmts[i] if i < len(pfmts) else 0)
                values.append(_decode_param(data, fmt, st["oids"][i] if i < len(st["oids"]) else 0))
            (nr,) = struct.unpack("!h", rest[pos:pos + 2])
            pos += 2
            rfmts = list(struct.unpack(f"!{nr}h", rest[pos:pos + 2 * nr]))
            self.portals[portal.decode()] = {"sql": st["sql"], "params": values, "formats": rfmts or [0], "result": None, "offset": 0}
            self._send(b"2")
        elif kind == b"D":
            what, name = body[:1], body[1:].rstrip(b"\x00").decode()
            if what == b"S":
                st = self.stmts.get(name)
                if st is None:
                    raise SqlError(f"unknown prepared statement {name!r}", "26000")
                n = len(set(re.findall(r"\$(\d+)", st["sql"])))
                oids = (st["oids"] + [0] * n)[:n]
                self._send(b"t", struct.pack("!h", n) + b"".join(struct.pack("!i", o or 25) for o in oids))
                t, _ = self._shape(st["sql"], [None] * n)
                if t is None:
                    self._send(b"n")
                else:
                    self._row_description(t, [0])
            else:
                p = self.portals.get(name)
                if p is None and name.lower() in eng.cursors:
                    # a SQL cursor (DECLARE) is a portal too: drivers describe it before FETCH
                    self._row_description(eng.cursors[name.lower()], [0])
                    return
                if p is None:
                    raise SqlError(f"unknown portal {name!r}", "34000")
                self._execute_portal(p)
                if p["result"] is None:
                    self._send(b"n")
                else:
                    self._row_description(p["result"], p["formats"])
        elif kind == b"E":
            name, rest = body.split(b"\x00", 1)
            (max_rows,) = struct.unpack("!i", rest[:4])
            p = self.portals.get(name.decode())
            if p is None:
                raise SqlError("unknown portal", "34000")
            self._execute_portal(p)
            if p["result"] is None:
                self._send(b"C", self._cstr(p["tag"]))
                return
            if isinstance(p["result"], ResultStream):
                sent = self._send_stream(p["result"], p["formats"], max_rows)
                p["offset"] += sent
                more = bool(max_rows) and not p["result"].done
            else:
                sent = self._data_rows(p["result"], p["formats"], p["offset"], max_rows)
                p["offset"] += sent
                more = bool(max_rows) and p["offset"] < p["result"].num_rows
            if more:
                self._send(b"s")
            else:
                self._send(b"C", self._cstr(f"SELECT {p['offset']}" if p["tag"].startswith("SELECT") else p["tag"]))
        elif kind == b"S":
            self.skip_to_sync = False
            self._ready()
        elif kind == b"C":
            what, name = body[:1], body[1:].rstrip(b"\x00").decode()
            (self.stmts if what == b"S" else self.portals).pop(name, None)
            self._send(b"3")
        elif kind == b"H":
            pass
        else:
            raise SqlError(f"unsupported message {kind!r}", "0A000")

    def _shape(self, sql: str, params: list) -> tuple[Optional[pa.Table], str]:
        """A statement's result columns without its rows (Describe of a prepared statement)."""
        s = sql.strip().rstrip(";")
        if NOOP_RE.match(s) or not s:
            return None, "OK"
        if re.match(r"^\s*(select|with|values|table|from|show|describe|summarize)\b", s, re.I) and not re.match(r"^\s*show\b", s, re.I):
            t, tag = self.engine.run(f"SELECT * FROM ({s}) AS __q LIMIT 0", params)
            return t, tag
        return self.engine.run(s, params)

    def _send_stream(self, st: "ResultStream", formats: list[int], limit: int = 0) -> int:
        """Send up to `limit` rows (0: all) of a streamed result, batch by batch."""
        sent = 0
        while not limit or sent < limit:
            chunk = st.take(limit - sent if limit else 0)
            if chunk is None:
                break
            sent += self._data_rows(chunk, formats)
        return sent

    def _execute_portal(self, p: dict) -> None:
        if p.get("done"):
            return
        stmts = self.engine.statements(p["sql"]) or [""]
        t, tag = None, "EMPTY"
        for i, s in enumerate(stmts):
            t, tag = self.engine.run(s, p["params"] if "$" in s else None, stream=i == len(stmts) - 1)
        p.update(result=t, tag=tag if tag != "EMPTY" else "SELECT 0", done=True)


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def startup() -> None:
    """Open the PostgreSQL wire-protocol port (BLUESANDAI_SQL_PORT, default 5433; "off" disables it)."""
    port = os.environ.get("BLUESANDAI_SQL_PORT", "5433")
    host = os.environ.get("BLUESANDAI_SQL_HOST", "127.0.0.1")
    if port.lower() in ("off", "false", "no", "disabled"):  # "0": any free port
        STATE["error"] = "disabled (BLUESANDAI_SQL_PORT=off)"
        return
    cert, key = os.environ.get("BLUESANDAI_SQL_TLS_CERT"), os.environ.get("BLUESANDAI_SQL_TLS_KEY")
    if cert and key:
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(cert, key)
            _TLS["context"] = ctx
        except (OSError, ssl.SSLError) as e:
            log.warning("sql endpoint: TLS certificate not loaded: %s", e)
    _TLS["required"] = bool(_TLS["context"]) and os.environ.get("BLUESANDAI_SQL_TLS_REQUIRED", "").lower() in ("1", "true", "yes")
    try:
        srv = _Server((host, int(port)), PgHandler)
    except OSError as e:
        STATE["error"] = f"port {port} is not available: {e}"
        log.warning("sql endpoint: %s", STATE["error"])
        return
    threading.Thread(target=srv.serve_forever, name="sql-bi", daemon=True).start()
    STATE.update(server=srv, port=srv.server_address[1], host=host, error=None)
    log.info("SQL endpoint (PostgreSQL protocol) on %s:%s", host, STATE["port"])


# ------------------------------------------------------------------ REST


@router.get("/info")
def info() -> dict:
    """What a BI tool needs to connect, and the tables this user can query."""
    tables = []
    for e in catalog():
        tables.append({"schema": e["schema"], "table": e["table"], "kind": e["kind"], **({"path": e["path"]} if e.get("path") else {})})
    me = auth.current() or {}
    return {"enabled": STATE["server"] is not None, "host": STATE["host"], "port": STATE["port"], "database": "foundry", "error": STATE["error"],
            "user": me.get("username") or "any", "auth": auth.enabled(), "tls": bool(_TLS["context"]), "tls_required": _TLS["required"], "connections": STATE["connections"], "queries": STATE["queries"], "tables": tables}


class QueryIn(BaseModel):
    sql: str = Field(min_length=1, max_length=200_000)
    format: str = "json"
    limit: int = Field(10_000, ge=1, le=MAX_ROWS)
    # the client's id for the query (DELETE /queries/{id} cancels it); seconds before it is cancelled
    query_id: Optional[str] = Field(None, max_length=64)
    timeout_seconds: Optional[float] = Field(None, gt=0, le=3600)
    # datasets from this branch (falling back to master)
    branch: Optional[str] = Field(None, max_length=200)
    # "spark" (Foundry's Spark SQL, translated) or "duckdb" (the default)
    dialect: Optional[str] = Field(None, max_length=20)


def _owner(eng: "Engine") -> str:
    return (eng.principal or {}).get("username") or "local"


@router.post("/query")
def query(req: QueryIn) -> Any:
    """Run one read-only query (the REST connector): JSON {columns, rows} or CSV."""
    if req.query_id and req.query_id in _RUNNING:
        raise HTTPException(409, f"query {req.query_id} is already running")
    eng = Engine(auth.current(), req.branch, req.dialect)
    if req.query_id:
        eng.id = req.query_id
    timer = threading.Timer(req.timeout_seconds, cancel, (eng,)) if req.timeout_seconds else None
    try:
        stmts = eng.statements(req.sql)
        if len(stmts) != 1:
            raise HTTPException(400, "send exactly one statement")
        if timer:
            timer.start()
        t, tag = eng.run(stmts[0])
    except SqlError as e:
        if e.code == "57014":
            timed_out = bool(timer) and not timer.is_alive()
            raise HTTPException(408 if timed_out else 409, "the query was cancelled" + (" (timeout)" if timed_out else "")) from None
        raise HTTPException(400, str(e)) from None
    finally:
        if timer:
            timer.cancel()
        eng.con.close()
    if t is None:
        return {"columns": [], "rows": [], "tag": tag}
    t = t.slice(0, req.limit)
    if req.format == "csv":
        import pyarrow.csv as pcsv

        buf = io.BytesIO()
        pcsv.write_csv(t, buf)
        return Response(buf.getvalue(), media_type="text/csv")
    return {"columns": [{"name": f.name, "type": str(f.type)} for f in t.schema], "rows": json.loads(json.dumps(t.to_pylist(), default=str)), "tag": tag}


def _mine(eng: "Engine") -> bool:
    me = auth.current() or {}
    return not auth.enabled() or me.get("role") == "admin" or _owner(eng) == me.get("username")


@router.get("/queries")
def running_queries() -> list[dict]:
    """Queries running now (REST and protocol sessions): your own, or everyone's for an admin."""
    return [{"id": e.id, "user": _owner(e), **(e.current or {})} for e in list(_RUNNING.values()) if e.current and _mine(e)]


@router.delete("/queries/{query_id}")
def cancel_query(query_id: str) -> dict:
    eng = _RUNNING.get(query_id)
    if not eng or not _mine(eng):
        raise HTTPException(404, "no such running query")
    return {"cancelled": cancel(eng)}

