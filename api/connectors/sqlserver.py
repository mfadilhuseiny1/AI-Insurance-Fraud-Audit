"""Microsoft SQL Server and Azure SQL (pymssql / FreeTDS).

Row limits use TOP; identifiers are quoted with brackets. Connections ask for read-only intent;
row counts come from sys.partitions, so browsing never scans a table.
"""

from __future__ import annotations

from typing import Any

import pymssql

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates


class SqlServerConnector(SqlConnector):
    hidden_schemas = ("information_schema", "sys", "guest")
    statement_timeout_s = 60

    def quote(self, ident: str) -> str:
        return "[" + ident.replace("]", "]]") + "]"

    def limit(self, select: str, n: int) -> str:
        assert select.startswith("SELECT ")
        return f"SELECT TOP ({int(n)}) " + select[len("SELECT "):]

    def _connect(self, database: str) -> Any:
        c = self.config
        return pymssql.connect(
            server=c["host"],
            port=str(c.get("port") or 1433),
            user=c["user"],
            password=self.secrets.get("password") or "",
            database=database or c.get("database") or "",
            login_timeout=10,
            timeout=int(self.statement_timeout_s),
            appname="bluesandai-connector",
            encryption="require" if c.get("ssl") else "request",
            read_only=not self.writable,
            use_datetime2=True,
        )

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT @@VERSION", action="Connected, but could not run a query")
        return {"version": row[0].splitlines()[0].strip()}

    def list_databases(self) -> list[str]:
        rows = self.query(
            "SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name",
            action="Could not list databases",
        )
        names = [r[0] for r in rows]
        own = self.config.get("database")
        return names if not own or own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        rows = self.query(
            "SELECT DISTINCT s.name FROM sys.schemas s JOIN sys.objects o ON o.schema_id = s.schema_id"
            " WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name",
            database=database,
            action="Could not list schemas",
        )
        return [r[0] for r in rows if r[0].lower() not in self.hidden_schemas]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        rows = self.query(
            """
            SELECT o.name, CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END,
                   (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)),
                   CAST(ep.value AS nvarchar(4000))
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id = o.schema_id
            LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
            WHERE s.name = %s AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND (%s = '' OR LOWER(o.name) LIKE %s)
            ORDER BY o.name
            """,
            (schema, search, f"%{search.lower()}%"),
            database=database,
            action="Could not list tables",
        )
        return [{"name": r[0], "kind": r[1], "rows": None if r[1] == "view" or r[2] is None else int(r[2]), "comment": r[3]} for r in rows]

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            """
            SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH,
                   COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity')
            FROM INFORMATION_SCHEMA.COLUMNS c
            WHERE c.TABLE_SCHEMA = %s AND c.TABLE_NAME = %s
            ORDER BY c.ORDINAL_POSITION
            """,
            (schema, table),
            database=database,
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns = []
        for name, data_type, nullable, precision, scale, length, identity in rows:
            dt = data_type.lower()
            # SQL Server's "timestamp" is rowversion: a binary counter, not a time
            kind = "Binary" if dt in ("timestamp", "rowversion") else column_type(dt, precision, scale)
            shown = f"{data_type}({'max' if length == -1 else length})" if length else (f"{data_type}({precision},{scale})" if dt in ("decimal", "numeric") else data_type)
            columns.append(
                {"name": name, "db_type": shown, "type": kind, "nullable": nullable == "YES", "comment": None, "identity": identity == 1, "scale": scale}
            )
        pk = self._primary_key(database, schema, table)
        cursor_candidates(columns, pk)
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": pk, "rows": listed.get("rows"), "comment": listed.get("comment")}
