"""Snowflake (snowflake-connector-python).

Browsing is database → schema → table with fully qualified names, so one session reaches every
database. Sessions run in UTC with a statement timeout and a query tag; row counts come from
INFORMATION_SCHEMA.TABLES. Authentication: password, or key-pair (a PEM private key).
"""

from __future__ import annotations

from typing import Any

import snowflake.connector
from cryptography.hazmat.primitives import serialization

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates, number_type


class SnowflakeConnector(SqlConnector):
    shared_connection = True
    qualify_database = True
    statement_timeout_s = 60

    def _connect(self, database: str) -> Any:
        c = self.config
        auth: dict[str, Any] = {}
        key = (self.secrets.get("private_key") or "").strip()
        if key:
            try:
                pk = serialization.load_pem_private_key(key.encode(), password=None)
            except (ValueError, TypeError) as e:
                raise ConnectorError(f"The private key is not a valid unencrypted PEM key: {e}") from None
            auth["private_key"] = pk.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        elif self.secrets.get("password"):
            auth["password"] = self.secrets["password"]
        else:
            raise ConnectorError("Enter a password or a private key")
        return snowflake.connector.connect(
            account=c["account"],
            user=c["user"],
            warehouse=c["warehouse"],
            database=c.get("database") or None,
            role=c.get("role") or None,
            login_timeout=15,
            network_timeout=max(60, int(self.statement_timeout_s) + 30),
            application="bluesandai",
            session_parameters={
                "QUERY_TAG": "bluesandai-connector",
                "STATEMENT_TIMEOUT_IN_SECONDS": int(self.statement_timeout_s),
                "TIMEZONE": "UTC",
            },
            **auth,
        )

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT CURRENT_VERSION()", action="Connected, but could not run a query")
        return {"version": f"Snowflake {row[0]}"}

    def list_databases(self) -> list[str]:
        rows = self.query("SHOW TERSE DATABASES", action="Could not list databases")
        names = [r[1] for r in rows if r[1] not in ("SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA")]
        own = self.config.get("database")
        return names if not own or own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        self._known_database(database)
        rows = self.query(
            f"SELECT schema_name FROM {self.ident(database)}.information_schema.schemata WHERE schema_name <> 'INFORMATION_SCHEMA' ORDER BY schema_name",
            action="Could not list schemas",
        )
        return [r[0] for r in rows]

    def _known_database(self, database: str) -> None:
        if database not in self.list_databases():
            raise ConnectorError(f'Database "{database}" was not found or is not readable')

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        self._known_database(database)
        rows = self.query(
            f"SELECT table_name, table_type, row_count, comment FROM {self.ident(database)}.information_schema.tables"
            " WHERE table_schema = %s AND LOWER(table_name) LIKE %s ORDER BY table_name LIMIT 5000",
            (schema, f"%{search.lower()}%"),
            action="Could not list tables",
        )
        return [
            {"name": r[0], "kind": "view" if "VIEW" in (r[1] or "") else "table", "rows": None if r[2] is None else int(r[2]), "comment": r[3]}
            for r in rows
        ]

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        self._known_database(database)
        rows = self.query(
            f"SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale, comment, is_identity"
            f" FROM {self.ident(database)}.information_schema.columns WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
            (schema, table),
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns = []
        for name, data_type, nullable, precision, scale, comment, identity in rows:
            dt = (data_type or "").upper()
            if dt in ("NUMBER", "DECIMAL", "NUMERIC"):
                kind, shown = number_type(precision, scale), f"NUMBER({precision},{scale})"
            elif dt.startswith("TIMESTAMP"):
                kind, shown = "Timestamp", dt
            elif dt in ("VARIANT", "OBJECT", "ARRAY", "GEOGRAPHY", "GEOMETRY"):
                kind, shown = "String", dt
            else:
                kind, shown = column_type(dt.lower(), precision, scale), dt
            columns.append(
                {
                    "name": name,
                    "db_type": shown,
                    "type": kind,
                    "nullable": nullable == "YES",
                    "comment": comment,
                    "identity": identity == "YES",
                    "scale": scale,
                    "tz": dt in ("TIMESTAMP_TZ", "TIMESTAMP_LTZ"),
                }
            )
        cursor_candidates(columns, [])
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": [], "rows": listed.get("rows"), "comment": listed.get("comment")}
