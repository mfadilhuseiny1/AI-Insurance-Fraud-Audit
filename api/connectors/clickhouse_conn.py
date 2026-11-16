"""ClickHouse (clickhouse-connect over HTTP/HTTPS).

A database is the schema: browsing is database → table. Row counts come from system.tables
(exact for MergeTree tables, free to read). Values are bound client-side by the driver (escaped
literals); date-times are bound as UTC and the session runs in UTC. Snapshots stream row blocks.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

import clickhouse_connect

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates

SYSTEM_DATABASES = ("system", "information_schema", "INFORMATION_SCHEMA")

# ClickHouse type → pipeline type (after unwrapping Nullable / LowCardinality)
SIMPLE = {
    "Bool": "Boolean",
    "Int8": "Byte",
    "UInt8": "Short",
    "Int16": "Short",
    "UInt16": "Integer",
    "Int32": "Integer",
    "UInt32": "Long",
    "Int64": "Long",
    "UInt64": "Decimal",
    "Float32": "Float",
    "Float64": "Double",
    "Date": "Date",
    "Date32": "Date",
}


def unwrap(t: str) -> tuple[str, bool]:
    nullable = False
    while True:
        m = re.fullmatch(r"(Nullable|LowCardinality)\((.*)\)", t)
        if not m:
            return t, nullable
        nullable = nullable or m.group(1) == "Nullable"
        t = m.group(2)


def clickhouse_type(t: str) -> str:
    base, _ = unwrap(t)
    if base in SIMPLE:
        return SIMPLE[base]
    if base.startswith(("DateTime", "DateTime64")):
        return "Timestamp"
    m = re.fullmatch(r"Decimal(?:32|64|128|256)?\((\d+)(?:,\s*(\d+))?\)", base)
    if m:
        p, s = int(m.group(1)), int(m.group(2) or 0)
        return column_type("decimal", p, s)
    return "String"


def _bind(v: Any) -> Any:
    if isinstance(v, datetime) and v.tzinfo is not None:
        return v.astimezone(timezone.utc).replace(tzinfo=None)
    return v


def _aware(v: Any) -> Any:
    """The session runs in UTC: date-times come back as UTC instants."""
    if isinstance(v, datetime) and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v


class ClickHouseConnector(SqlConnector):
    statement_timeout_s = 60
    shared_connection = True

    def quote(self, ident: str) -> str:
        return "`" + ident.replace("\\", "\\\\").replace("`", "\\`") + "`"

    def _connect(self, database: str) -> Any:
        c = self.config
        return clickhouse_connect.get_client(
            host=c["host"],
            port=int(c.get("port") or (8443 if c.get("ssl") else 8123)),
            username=c["user"],
            password=self.secrets.get("password") or "",
            database=c.get("database") or None,
            secure=bool(c.get("ssl")),
            connect_timeout=10,
            send_receive_timeout=max(60, int(self.statement_timeout_s) + 30),
            settings={"max_execution_time": int(self.statement_timeout_s), "session_timezone": "UTC"},
        )

    def query(self, sql: str, params: tuple = (), database: Optional[str] = None, action: str = "Query failed") -> list[tuple]:
        client = self.conn()
        try:
            rows = client.query(sql, parameters=[_bind(p) for p in params] if params else None).result_rows
            return [tuple(_aware(v) for v in r) for r in rows]
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, action) from None

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        ref, cols = self._columns(database, schema, table, columns or None)
        select = ", ".join(self.ident(c["name"]) for c in cols)
        client = self.conn()
        try:
            with client.query_row_block_stream(f"SELECT {select} FROM {ref}", settings={"max_block_size": batch_size}) as stream:
                pending: list[tuple] = []
                for block in stream:
                    pending.extend(tuple(_aware(v) for v in r) for r in block)
                    while len(pending) >= batch_size:
                        yield pending[:batch_size]
                        pending = pending[batch_size:]
                if pending:
                    yield pending
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, "Reading the table failed") from None

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT version()", action="Connected, but could not run a query")
        return {"version": f"ClickHouse {row[0]}"}

    def list_databases(self) -> list[str]:
        rows = self.query("SELECT name FROM system.databases ORDER BY name", action="Could not list databases")
        return [r[0] for r in rows if r[0] not in SYSTEM_DATABASES]

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        rows = self.query(
            "SELECT name, engine, total_rows, comment FROM system.tables WHERE database = %s AND NOT is_temporary"
            " AND positionCaseInsensitive(name, %s) > 0 ORDER BY name LIMIT 5000",
            (schema or database, search),
            action="Could not list tables",
        )
        return [
            {"name": r[0], "kind": "view" if "View" in (r[1] or "") else "table", "rows": None if r[2] is None else int(r[2]), "comment": r[3] or None}
            for r in rows
        ]

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            "SELECT name, type, comment, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE database = %s AND table = %s ORDER BY position",
            (schema or database, table),
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns, pk = [], []
        for name, t, comment, in_pk, in_sort in rows:
            base, nullable = unwrap(t)
            kind = clickhouse_type(t)
            columns.append(
                {
                    "name": name,
                    "db_type": t,
                    "type": kind,
                    "nullable": nullable,
                    "comment": comment or None,
                    "scale": 0 if kind in ("Byte", "Short", "Integer", "Long") or base == "UInt64" else None,
                    "tz": base.startswith("DateTime"),
                }
            )
            if in_pk:
                pk.append(name)
            # the sorting key's leading time column is the natural cursor of a MergeTree table
            if in_sort and kind == "Timestamp":
                columns[-1]["identity"] = True
        cursor_candidates(columns, pk)
        listed = next((x for x in self.list_tables(database, schema, table) if x["name"] == table), {})
        return {"columns": columns, "primary_key": pk, "rows": listed.get("rows"), "comment": listed.get("comment")}
