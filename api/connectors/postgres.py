"""PostgreSQL, and the databases speaking its protocol: TimescaleDB and Amazon Redshift.

Sessions are read-only (BEGIN READ ONLY), in UTC, with a statement timeout. Row counts are the
planner's estimates (pg_class.reltuples, summed over partitions and TimescaleDB chunks), so
browsing never scans a table. Snapshots stream through a server-side cursor.
"""

from __future__ import annotations

from typing import Any

import psycopg

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates


class PostgresConnector(SqlConnector):
    hidden_schemas = ("information_schema", "timescaledb_information", "timescaledb_experimental")
    default_port = 5432
    # Redshift: no pg_inherits / relispartition, and a smaller catalog
    redshift = False
    statement_timeout_s = 60

    def _connect(self, database: str) -> Any:
        c = self.config
        # a private link (network.py): libpq resolves names itself, so it gets the endpoint's address;
        # the host name is still used for TLS
        import network

        routed = network.route_address(c["host"])
        conn = psycopg.connect(
            **({"hostaddr": routed} if routed else {}),
            host=c["host"],
            port=c.get("port") or self.default_port,
            dbname=database or c.get("database") or "postgres",
            user=c["user"],
            password=self.secrets.get("password") or None,
            sslmode="require" if c.get("ssl") else "prefer",
            connect_timeout=10,
            application_name="bluesandai-connector",
        )
        conn.read_only = not self.writable
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = {int(self.statement_timeout_s * 1000)}")
            cur.execute("SET TIME ZONE 'UTC'")
        conn.commit()
        return conn

    def test_connection(self) -> dict:
        (row,) = self.query("SELECT version()", action="Connected, but could not run a query")
        return {"version": row[0].split(",")[0]}

    def _stream_cursor(self, conn: Any) -> Any:
        cur = conn.cursor(name="bluesandai_extract")
        cur.itersize = 10_000
        return cur

    # -- catalog --

    def list_databases(self) -> list[str]:
        try:
            rows = self.query(
                "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn"
                " AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
                action="Could not list databases",
            )
            names = [r[0] for r in rows if r[0] not in ("rdsadmin", "padb_harvest")]
        except ConnectorError:
            names = []
        own = self.config.get("database") or "postgres"
        return names if own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        if self.redshift:
            return super().list_schemas(database)
        rows = self.query(
            "SELECT nspname FROM pg_namespace WHERE has_schema_privilege(nspname, 'USAGE') ORDER BY nspname",
            database=database,
            action="Could not list schemas",
        )
        return [
            r[0]
            for r in rows
            if not r[0].startswith(("pg_", "_timescaledb")) and r[0] not in self.hidden_schemas
        ]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        if self.redshift:
            return super().list_tables(database, schema, search)
        rows = self.query(
            """
            SELECT c.relname,
                   CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END,
                   CASE WHEN c.relkind IN ('v') THEN NULL
                        WHEN c.reltuples < 0 AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid) THEN NULL
                        ELSE (GREATEST(c.reltuples, 0) + COALESCE((
                            SELECT SUM(GREATEST(k.reltuples, 0)) FROM pg_inherits i JOIN pg_class k ON k.oid = i.inhrelid
                            WHERE i.inhparent = c.oid), 0))::bigint END,
                   obj_description(c.oid, 'pg_class')
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
              AND has_table_privilege(c.oid, 'SELECT')
              AND (%s = '' OR c.relname ILIKE %s)
            ORDER BY c.relname
            LIMIT 5000
            """,
            (schema, search, f"%{search}%"),
            database=database,
            action="Could not list tables",
        )
        return [{"name": r[0], "kind": r[1], "rows": r[2], "comment": r[3]} for r in rows]

    def list_foreign_keys(self, database: str, schema: str) -> list[dict]:
        if self.redshift:
            return super().list_foreign_keys(database, schema)
        from .base import group_foreign_keys

        rows = self.query(
            "SELECT c.conrelid::regclass::text, c.conname, a.attname, f.relname, fa.attname"
            " FROM pg_constraint c"
            " JOIN pg_namespace n ON n.oid = c.connamespace"
            " JOIN pg_class f ON f.oid = c.confrelid"
            " JOIN pg_namespace fn ON fn.oid = f.relnamespace"
            " CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(col, refcol, pos)"
            " JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col"
            " JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.refcol"
            " WHERE c.contype = 'f' AND n.nspname = %s AND fn.nspname = %s ORDER BY 1, 2, k.pos",
            (schema, schema),
            database=database,
            action="Could not read the foreign keys",
        )
        # regclass text is schema-qualified (and quoted) outside the search path
        def bare(name: str) -> str:
            name = name.split(".")[-1]
            return name[1:-1].replace('""', '"') if name.startswith('"') else name

        return group_foreign_keys([(bare(r[0]), r[1], r[2], r[3], r[4]) for r in rows])

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        if self.redshift:
            return super().get_table_schema(database, schema, table)
        rel = self.query(
            "SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relname = %s",
            (schema, table),
            database=database,
            action="Could not find the table",
        )
        if not rel:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        oid = rel[0][0]
        rows = self.query(
            """
            SELECT a.attname, format_type(a.atttypid, a.atttypmod), t.typname, a.atttypmod, NOT a.attnotnull,
                   col_description(a.attrelid, a.attnum),
                   a.attidentity IN ('a', 'd') OR position('nextval(' in COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) = 1
            FROM pg_attribute a
            JOIN pg_type t ON t.oid = a.atttypid
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """,
            (oid,),
            database=database,
            action="Could not read the table's columns",
        )
        columns = []
        for name, shown, typname, typmod, nullable, comment, identity in rows:
            precision = scale = None
            if typname == "numeric" and typmod >= 4:
                precision, scale = ((typmod - 4) >> 16) & 0xFFFF, (typmod - 4) & 0xFFFF
            kind = "String" if typname.startswith("_") else column_type(typname, precision, scale)
            columns.append(
                {"name": name, "db_type": shown, "type": kind, "nullable": nullable, "comment": comment, "identity": bool(identity), "scale": scale}
            )
        pk = [
            r[0]
            for r in self.query(
                "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
                " WHERE i.indrelid = %s AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)",
                (oid,),
                database=database,
                action="Could not read the primary key",
            )
        ]
        cursor_candidates(columns, pk)
        listed = next((t for t in self.list_tables(database, schema, table) if t["name"] == table), {})
        return {"columns": columns, "primary_key": pk, "rows": listed.get("rows"), "comment": listed.get("comment")}


class TimescaleConnector(PostgresConnector):
    pass


class RedshiftConnector(PostgresConnector):
    redshift = True
    default_port = 5439

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        tables = super().list_tables(database, schema, search)
        # svv_table_info has row estimates for the tables the user can see
        try:
            counts = dict(
                self.query(
                    'SELECT "table", tbl_rows FROM svv_table_info WHERE "schema" = %s', (schema,), database=database, action="Could not read table sizes"
                )
            )
            for t in tables:
                t["rows"] = int(counts[t["name"]]) if counts.get(t["name"]) is not None else None
        except ConnectorError:
            pass
        return tables
