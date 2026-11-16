"""Databricks SQL warehouses (databricks-sql-connector).

Browsing is catalog → schema → table through the driver's metadata calls (Unity Catalog and the
legacy hive_metastore alike); queries use fully qualified, backtick-quoted names and native
named parameters. Row counts are not known without scanning, so they are left out.
"""

from __future__ import annotations

from typing import Any

from databricks import sql as dbsql

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates


def _get(row: Any, name: str) -> Any:
    try:
        return getattr(row, name)
    except AttributeError:
        return row.asDict().get(name) if hasattr(row, "asDict") else None


class DatabricksConnector(SqlConnector):
    shared_connection = True
    qualify_database = True
    statement_timeout_s = 60

    def quote(self, ident: str) -> str:
        return "`" + ident.replace("`", "``") + "`"

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        # %s → :p1, :p2 … (native named parameters)
        parts = sql.split("%s")
        out = parts[0]
        for i, part in enumerate(parts[1:], start=1):
            out += f":p{i}" + part
        return out, {f"p{i}": v for i, v in enumerate(params, start=1)} if params else params

    def _connect(self, database: str) -> Any:
        c = self.config
        host = c["server_hostname"].removeprefix("https://").rstrip("/")
        return dbsql.connect(
            server_hostname=host,
            http_path=c["http_path"],
            access_token=self.secrets.get("access_token"),
            catalog=c.get("catalog") or None,
            session_configuration={"STATEMENT_TIMEOUT": str(int(self.statement_timeout_s)), "TIMEZONE": "UTC"},
            user_agent_entry="bluesandai",
        )

    def _meta(self, fn: str, action: str, **kw: Any) -> list[Any]:
        conn = self.conn()
        try:
            with conn.cursor() as cur:
                getattr(cur, fn)(**kw)
                return cur.fetchall()
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, action) from None

    def test_connection(self) -> dict:
        try:
            (row,) = self.query("SELECT current_version().dbsql_version", action="Connected, but could not run a query")
            return {"version": f"Databricks SQL {row[0] or ''}".strip()}
        except ConnectorError:
            # all-purpose clusters have no DBSQL version
            self.query("SELECT 1", action="Connected, but could not run a query")
            return {"version": "Databricks"}

    def list_databases(self) -> list[str]:
        names = [_get(r, "TABLE_CAT") for r in self._meta("catalogs", "Could not list catalogs")]
        names = [n for n in names if n and n not in ("system", "samples")]
        own = self.config.get("catalog")
        return names if not own or own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        rows = self._meta("schemas", "Could not list schemas", catalog_name=database)
        return sorted(n for n in (_get(r, "TABLE_SCHEM") for r in rows) if n and n != "information_schema")

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        # every table of the schema; the search is applied here (pattern syntax differs between metastores)
        rows = self._meta("tables", "Could not list tables", catalog_name=database, schema_name=schema)
        out = []
        for r in rows:
            name = _get(r, "TABLE_NAME")
            if not name or (search and search.lower() not in name.lower()):
                continue
            out.append({"name": name, "kind": "view" if "VIEW" in (_get(r, "TABLE_TYPE") or "").upper() else "table", "rows": None, "comment": _get(r, "REMARKS") or None})
        return sorted(out, key=lambda t: t["name"])

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self._meta("columns", "Could not read the table's columns", catalog_name=database, schema_name=schema, table_name=table)
        rows = [r for r in rows if _get(r, "TABLE_NAME") == table]
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns = []
        for r in rows:
            shown = _get(r, "TYPE_NAME") or "STRING"
            base = shown.split("(")[0].split("<")[0].strip().lower()
            precision, scale = _get(r, "COLUMN_SIZE"), _get(r, "DECIMAL_DIGITS")
            kind = {"timestamp_ntz": "Timestamp", "long": "Long", "short": "Short", "byte": "Byte"}.get(base) or (
                "String" if base in ("array", "map", "struct", "variant", "interval") else column_type(base, precision, scale)
            )
            columns.append(
                {
                    "name": _get(r, "COLUMN_NAME"),
                    "db_type": shown,
                    "type": kind,
                    "nullable": _get(r, "NULLABLE") != 0,
                    "comment": _get(r, "REMARKS") or None,
                    "scale": scale,
                    "tz": base == "timestamp",
                }
            )
        cursor_candidates(columns, [])
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": [], "rows": None, "comment": listed.get("comment")}
