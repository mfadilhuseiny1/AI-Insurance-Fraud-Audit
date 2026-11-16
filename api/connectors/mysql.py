"""MySQL and MariaDB (PyMySQL).

In MySQL a database is the schema, so browsing is database → tables. Sessions are read-only, in
UTC, with a statement timeout; row counts come from information_schema.TABLES (InnoDB estimates).
Snapshots stream with an unbuffered cursor.
"""

from __future__ import annotations

from typing import Any

import pymysql
import pymysql.cursors

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates

SYSTEM_DATABASES = ("information_schema", "mysql", "performance_schema", "sys")


class MySqlConnector(SqlConnector):
    def begin_write(self, conn: Any) -> None:
        conn.begin()

    statement_timeout_s = 60

    def quote(self, ident: str) -> str:
        return "`" + ident.replace("`", "``") + "`"

    def _connect(self, database: str) -> Any:
        c = self.config
        conn = pymysql.connect(
            host=c["host"],
            port=int(c.get("port") or 3306),
            user=c["user"],
            password=self.secrets.get("password") or "",
            database=database or c.get("database") or None,
            charset="utf8mb4",
            connect_timeout=10,
            # TLS without certificate verification, like sslmode=require
            ssl={"check_hostname": False} if c.get("ssl") else None,
            autocommit=True,
        )
        with conn.cursor() as cur:
            if not self.writable:
                cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute("SET time_zone = '+00:00'")
            for timeout in (f"SET SESSION MAX_EXECUTION_TIME = {int(self.statement_timeout_s * 1000)}", f"SET SESSION max_statement_time = {int(self.statement_timeout_s)}"):
                try:
                    cur.execute(timeout)  # MySQL, then MariaDB
                    break
                except pymysql.MySQLError:
                    continue
        return conn

    def _stream_cursor(self, conn: Any) -> Any:
        return conn.cursor(pymysql.cursors.SSCursor)

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT VERSION()", action="Connected, but could not run a query")
        return {"version": f"{'MariaDB' if 'mariadb' in row[0].lower() else 'MySQL'} {row[0].split('-')[0]}"}

    def list_databases(self) -> list[str]:
        rows = self.query("SHOW DATABASES", action="Could not list databases")
        return [r[0] for r in rows if r[0].lower() not in SYSTEM_DATABASES]

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        rows = self.query(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES"
            " WHERE TABLE_SCHEMA = %s AND (%s = '' OR LOWER(TABLE_NAME) LIKE %s) ORDER BY TABLE_NAME LIMIT 5000",
            (schema or database, search, f"%{search.lower()}%"),
            database=database,
            action="Could not list tables",
        )
        return [
            {"name": r[0], "kind": "view" if "VIEW" in (r[1] or "") else "table", "rows": None if "VIEW" in (r[1] or "") else r[2], "comment": r[3] or None}
            for r in rows
        ]

    def list_foreign_keys(self, database: str, schema: str) -> list[dict]:
        from .base import group_foreign_keys

        rows = self.query(
            "SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME"
            " FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = %s AND REFERENCED_TABLE_SCHEMA = %s"
            " AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
            (schema or database, schema or database),
            database=database,
            action="Could not read the foreign keys",
        )
        return group_foreign_keys(rows)

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT, NUMERIC_PRECISION, NUMERIC_SCALE, COLUMN_KEY, EXTRA"
            " FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s ORDER BY ORDINAL_POSITION",
            (schema or database, table),
            database=database,
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns, pk = [], []
        for name, data_type, shown, nullable, comment, precision, scale, key, extra in rows:
            kind = "Boolean" if shown.lower().startswith("tinyint(1)") else column_type(data_type, precision, scale)
            if kind == "Byte" and "unsigned" in shown.lower():
                kind = "Short"
            columns.append(
                {
                    "name": name,
                    "db_type": shown,
                    "type": kind,
                    "nullable": nullable == "YES",
                    "comment": comment or None,
                    "identity": "auto_increment" in (extra or "").lower(),
                    "scale": scale,
                }
            )
            if key == "PRI":
                pk.append(name)
        cursor_candidates(columns, pk)
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": pk, "rows": listed.get("rows"), "comment": listed.get("comment")}
