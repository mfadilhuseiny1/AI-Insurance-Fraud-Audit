"""Oracle Database (python-oracledb, thin mode: no Oracle Client install needed).

Browsing is service → schema (owner) → table; schemas are the users owning readable tables or
views, minus Oracle-maintained ones. Row counts are the optimizer statistics (ALL_TABLES.NUM_ROWS).
DATE columns hold a time too, so they are timestamps. Row limits use FETCH FIRST (12c+).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import oracledb

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates, number_type

# LOBs as str / bytes instead of LOB handles
oracledb.defaults.fetch_lobs = False


class OracleConnector(SqlConnector):
    statement_timeout_s = 60

    def limit(self, select: str, n: int) -> str:
        return f"{select} FETCH FIRST {int(n)} ROWS ONLY"

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        # %s → :1, :2 … (positional binds). Date-times are bound as ISO text read back with
        # TO_TIMESTAMP(_TZ): the driver binds datetime as DATE, which drops fractional seconds (a
        # cursor bound at 08:12:08 would skip a row at 08:12:08.498 and re-read it next run).
        parts = sql.split("%s")
        out = parts[0]
        values = list(params) if params else []
        for i, part in enumerate(parts[1:], start=1):
            v = values[i - 1] if i - 1 < len(values) else None
            if isinstance(v, datetime):
                if v.tzinfo is not None:
                    values[i - 1] = v.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")
                    out += f"TO_TIMESTAMP_TZ(:{i}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF6TZH:TZM')" + part
                else:
                    values[i - 1] = v.strftime("%Y-%m-%dT%H:%M:%S.%f")
                    out += f"TO_TIMESTAMP(:{i}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF6')" + part
            else:
                out += f":{i}" + part
        return out, values if params else params

    def bind_rows(self, cur: Any, rows: list[tuple]) -> None:
        """Bind date-time columns of an executemany as TIMESTAMP (WITH TIME ZONE), not DATE."""
        sizes: list[Any] = []
        for i in range(len(rows[0]) if rows else 0):
            v = next((r[i] for r in rows if r[i] is not None), None)
            sizes.append((oracledb.DB_TYPE_TIMESTAMP_TZ if v.tzinfo else oracledb.DB_TYPE_TIMESTAMP) if isinstance(v, datetime) else None)
        if any(sizes):
            cur.setinputsizes(*sizes)

    def _connect(self, database: str) -> Any:
        c = self.config
        conn = oracledb.connect(
            user=c["user"],
            password=self.secrets.get("password") or "",
            host=c["host"],
            port=int(c.get("port") or 1521),
            service_name=database or c["service_name"],
            protocol="tcps" if c.get("ssl") else "tcp",
            tcp_connect_timeout=10,
        )
        conn.call_timeout = int(self.statement_timeout_s * 1000)
        with conn.cursor() as cur:
            cur.execute("ALTER SESSION SET TIME_ZONE = 'UTC'")
        return conn

    def _stream_cursor(self, conn: Any) -> Any:
        cur = conn.cursor()
        cur.arraysize = 5000
        cur.prefetchrows = 5000
        return cur

    def test_connection(self) -> dict:
        self.query("SELECT 1 FROM dual", action="Connected, but could not run a query")
        return {"version": f"Oracle {self.conn().version}"}

    def list_databases(self) -> list[str]:
        return [self.config["service_name"]]

    def list_schemas(self, database: str) -> list[str]:
        rows = self.query(
            "SELECT username FROM all_users WHERE oracle_maintained = 'N'"
            " AND username IN (SELECT owner FROM all_objects WHERE object_type IN ('TABLE', 'VIEW')) ORDER BY username",
            database=database,
            action="Could not list schemas",
        )
        # a user with no tables of their own still sees their schema
        return [r[0] for r in rows] or [str(self.config.get("user", "")).upper()]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        pattern = f"%{search.lower()}%"
        rows = self.query(
            """
            SELECT t.table_name, 'table', t.num_rows, c.comments
            FROM all_tables t
            LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
            WHERE t.owner = %s AND LOWER(t.table_name) LIKE %s AND t.nested = 'NO' AND t.secondary = 'N'
            UNION ALL
            SELECT v.view_name, 'view', NULL, c.comments
            FROM all_views v
            LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
            WHERE v.owner = %s AND LOWER(v.view_name) LIKE %s
            ORDER BY 1
            """,
            (schema, pattern, schema, pattern),
            database=database,
            action="Could not list tables",
        )
        return [{"name": r[0], "kind": r[1], "rows": None if r[2] is None else int(r[2]), "comment": r[3]} for r in rows]

    def list_foreign_keys(self, database: str, schema: str) -> list[dict]:
        from .base import group_foreign_keys

        rows = self.query(
            "SELECT c.table_name, c.constraint_name, cc.column_name, r.table_name, rc.column_name"
            " FROM all_constraints c"
            " JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name"
            " JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name"
            " JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position"
            " WHERE c.constraint_type = 'R' AND c.owner = %s AND r.owner = %s ORDER BY 1, 2, cc.position",
            (schema, schema),
            database=database,
            action="Could not read the foreign keys",
        )
        return group_foreign_keys(rows)

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            """
            SELECT c.column_name, c.data_type, c.nullable, c.data_precision, c.data_scale, c.data_length, cc.comments, c.identity_column
            FROM all_tab_columns c
            LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
            WHERE c.owner = %s AND c.table_name = %s
            ORDER BY c.column_id
            """,
            (schema, table),
            database=database,
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns = []
        for name, data_type, nullable, precision, scale, length, comment, identity in rows:
            dt = (data_type or "").upper()
            if dt == "NUMBER":
                kind = number_type(precision, scale)
                shown = f"NUMBER({precision if precision is not None else '*'},{scale})" if scale is not None else "NUMBER"
            elif dt == "DATE" or dt.startswith("TIMESTAMP"):
                kind, shown = "Timestamp", dt
            elif dt in ("FLOAT", "BINARY_DOUBLE", "BINARY_FLOAT"):
                kind, shown = "Double", dt
            elif dt in ("BLOB", "RAW", "LONG RAW"):
                kind, shown = "Binary", dt
            else:
                kind = column_type(dt.lower(), precision, scale) if dt in ("INTEGER",) else "String"
                shown = f"{dt}({length})" if dt in ("VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR") and length else dt
            columns.append(
                {
                    "name": name,
                    "db_type": shown,
                    "type": kind,
                    "nullable": nullable == "Y",
                    "comment": comment,
                    "identity": identity == "YES",
                    "scale": scale,
                    "tz": "TIME ZONE" in dt,
                }
            )
        pk = [
            r[0]
            for r in self.query(
                "SELECT cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name"
                " WHERE c.owner = %s AND c.table_name = %s AND c.constraint_type = 'P' ORDER BY cc.position",
                (schema, table),
                database=database,
                action="Could not read the primary key",
            )
        ]
        cursor_candidates(columns, pk)
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": pk, "rows": listed.get("rows"), "comment": listed.get("comment")}
