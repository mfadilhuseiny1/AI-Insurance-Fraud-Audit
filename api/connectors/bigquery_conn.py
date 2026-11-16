"""Google BigQuery (google-cloud-bigquery) with a service account key.

Browsing is project → dataset → table. Previews and snapshots of tables use the tabledata API
(list_rows), which is not billed; row counts come from the dataset's __TABLES__ metadata (a tiny
metadata query). Incremental reads and views are queries with named parameters; set "Maximum GB
billed" to cap what one query may scan.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterator, Optional

from google.api_core import exceptions as gexc
from google.cloud import bigquery
from google.oauth2 import service_account

from .base import ConnectorError, SqlConnector, column_type, cursor_candidates

TYPES = {
    "STRING": "String",
    "BYTES": "Binary",
    "INTEGER": "Long",
    "INT64": "Long",
    "FLOAT": "Double",
    "FLOAT64": "Double",
    "NUMERIC": "Decimal",
    "BIGNUMERIC": "Double",
    "BOOLEAN": "Boolean",
    "BOOL": "Boolean",
    "TIMESTAMP": "Timestamp",
    "DATETIME": "Timestamp",
    "DATE": "Date",
}


def _param(name: str, v: Any) -> bigquery.ScalarQueryParameter:
    if isinstance(v, bool):
        t = "BOOL"
    elif isinstance(v, int):
        t = "INT64"
    elif isinstance(v, float):
        t = "FLOAT64"
    elif isinstance(v, Decimal):
        t = "NUMERIC"
    elif isinstance(v, datetime):
        # aware: an instant (TIMESTAMP columns); naive: wall-clock (DATETIME columns)
        t = "TIMESTAMP" if v.tzinfo else "DATETIME"
    elif isinstance(v, date):
        t = "DATE"
    else:
        t, v = "STRING", str(v)
    return bigquery.ScalarQueryParameter(name, t, v)


class BigQueryConnector(SqlConnector):
    shared_connection = True
    qualify_database = True
    statement_timeout_s = 60

    def quote(self, ident: str) -> str:
        return "`" + ident.replace("\\", "\\\\").replace("`", "\\`") + "`"

    def _connect(self, database: str) -> Any:
        raw = self.secrets.get("service_account") or ""
        try:
            info = json.loads(raw)
            creds = service_account.Credentials.from_service_account_info(info)
        except (ValueError, KeyError) as e:
            raise ConnectorError(f"The service account key is not a valid JSON key file: {type(e).__name__}") from None
        return bigquery.Client(project=self.config["project_id"], credentials=creds, location=self.config.get("location") or None)

    @property
    def client(self) -> bigquery.Client:
        return self.conn()

    def _job_config(self, params: tuple) -> bigquery.QueryJobConfig:
        cfg = bigquery.QueryJobConfig(query_parameters=[_param(f"p{i}", v) for i, v in enumerate(params, start=1)], use_legacy_sql=False)
        gb = self.config.get("maximum_gb_billed")
        if gb:
            cfg.maximum_bytes_billed = int(float(gb) * 1024**3)
        return cfg

    def query(self, sql: str, params: tuple = (), database: Optional[str] = None, action: str = "Query failed") -> list[tuple]:
        parts = sql.split("%s")
        text = parts[0] + "".join(f"@p{i}" + p for i, p in enumerate(parts[1:], start=1))
        try:
            job = self.client.query(text, job_config=self._job_config(params), timeout=self.statement_timeout_s)
            return [tuple(r.values()) for r in job.result(timeout=self.statement_timeout_s)]
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, action) from None

    def _call(self, fn: Any, action: str) -> Any:
        try:
            return fn()
        except ConnectorError:
            raise
        except gexc.NotFound:
            raise ConnectorError(f"{action}: not found or not readable with this service account") from None
        except Exception as e:
            raise self.error(e, action) from None

    def test_connection(self) -> dict:
        self._call(lambda: list(self.client.list_datasets(max_results=1)), "Connected, but could not list datasets")
        return {"version": f"BigQuery · project {self.config['project_id']}"}

    def list_databases(self) -> list[str]:
        return [self.config["project_id"]]

    def list_schemas(self, database: str) -> list[str]:
        return sorted(d.dataset_id for d in self._call(lambda: list(self.client.list_datasets(project=database)), "Could not list datasets"))

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        items = self._call(lambda: list(self.client.list_tables(f"{database}.{schema}")), "Could not list tables")
        items = [t for t in items if not search or search.lower() in t.table_id.lower()]
        # row counts from the dataset's table metadata (free); views have none
        counts: dict[str, int] = {}
        try:
            for r in self.client.query(f"SELECT table_id, row_count FROM {self.ident(database)}.{self.ident(schema)}.__TABLES__").result(timeout=30):
                counts[r["table_id"]] = int(r["row_count"])
        except Exception:
            pass
        return [
            {"name": t.table_id, "kind": "view" if t.table_type in ("VIEW", "MATERIALIZED_VIEW") else "table", "rows": counts.get(t.table_id), "comment": None}
            for t in sorted(items, key=lambda t: t.table_id)
        ]

    def table_ref(self, database: str, schema: str, table: str) -> str:
        self._table(database, schema, table)
        return f"{self.ident(database)}.{self.ident(schema)}.{self.ident(table)}"

    def _table(self, database: str, schema: str, table: str) -> Any:
        return self._call(lambda: self.client.get_table(f"{database}.{schema}.{table}"), f'Table "{schema}.{table}"')

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        t = self._table(database, schema, table)
        columns = []
        for f in t.schema:
            repeated = f.mode == "REPEATED"
            kind = "String" if repeated or f.field_type in ("RECORD", "STRUCT", "JSON", "GEOGRAPHY", "INTERVAL", "TIME", "RANGE") else TYPES.get(f.field_type, "String")
            if f.field_type == "NUMERIC" and f.precision is not None:
                kind = column_type("numeric", f.precision, f.scale)
            columns.append(
                {
                    "name": f.name,
                    "db_type": f"ARRAY<{f.field_type}>" if repeated else f.field_type,
                    "type": kind,
                    "nullable": f.mode != "REQUIRED",
                    "comment": f.description,
                    "scale": 0 if kind == "Long" else None,
                    "tz": f.field_type == "TIMESTAMP",
                }
            )
        cursor_candidates(columns, [])
        return {"columns": columns, "primary_key": [], "rows": t.num_rows, "comment": t.description}

    def _rows(self, database: str, schema: str, table: str, columns: list[str], **kw: Any) -> Any:
        t = self._table(database, schema, table)
        fields = [f for f in t.schema if f.name in columns] if columns else None
        return self.client.list_rows(t, selected_fields=fields, **kw)

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        info = self.get_table_schema(database, schema, table)
        if self._table(database, schema, table).table_type != "TABLE":
            return super().preview_rows(database, schema, table, limit)  # views: a (billed) LIMIT query
        rows = self._call(lambda: list(self._rows(database, schema, table, [], max_results=max(1, min(limit, 1000)))), "Preview failed")
        return info["columns"], [tuple(r.values()) for r in rows]

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        if self._table(database, schema, table).table_type != "TABLE":
            # views have no tabledata: a query, read page by page
            ref, cols = self._columns(database, schema, table, columns or None)
            sql = f"SELECT {', '.join(self.ident(c['name']) for c in cols)} FROM {ref}"
            try:
                for page in self.client.query(sql, job_config=self._job_config(())).result(page_size=batch_size).pages:
                    rows = [tuple(r.values()) for r in page]
                    if rows:
                        yield rows
            except Exception as e:
                raise self.error(e, "Reading the view failed") from None
            return
        info = self.get_table_schema(database, schema, table)
        names = columns or [c["name"] for c in info["columns"]]
        try:
            pages = self._rows(database, schema, table, names, page_size=batch_size).pages
            for page in pages:
                rows = [tuple(r[n] for n in names) for r in page]
                if rows:
                    yield rows
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, "Reading the table failed") from None
