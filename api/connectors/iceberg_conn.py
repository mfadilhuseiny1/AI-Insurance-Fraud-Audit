"""External Iceberg catalogs: virtual Iceberg tables.

Any catalog speaking the Apache Iceberg REST catalog protocol — Apache Polaris, Snowflake Open Catalog / Horizon,
Databricks Unity Catalog (/api/2.1/unity-catalog/iceberg-rest), AWS Glue (glue.<region>.amazonaws.com/iceberg, with
SigV4), Nessie, Lakekeeper, Gravitino, or another platform's catalog — through PyIceberg. Its tables stay in the
external storage, managed by the external catalog: browsing, previews, virtual-table reads (Pipeline Builder, SQL)
and syncs read them where they are.

Browsing: the database is the catalog's warehouse, schemas are its namespaces (nested ones joined with "."), tables
are its tables. Reads push column selection and the incremental cursor range down as an Iceberg row filter, so only
the matching data files are read. Storage credentials are vended by the catalog (X-Iceberg-Access-Delegation:
vended-credentials) or given in the connection (S3 keys, ADLS / GCS settings as PyIceberg properties).
"""

from __future__ import annotations

from typing import Any, Iterator, Optional

import pyarrow as pa
import pyarrow.compute as pc

from .base import ConnectorError, DatabaseConnector, cursor_candidates
from .files_conn import arrow_kind
from .records import convert

MAX_NAMESPACE_DEPTH = 4
ROW_ESTIMATE_TABLES = 50


class IcebergRestConnector(DatabaseConnector):
    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._catalog: Any = None
        self._tables: dict[str, Any] = {}

    # -- the catalog --

    def properties(self) -> dict[str, str]:
        c, s = self.config, self.secrets
        props: dict[str, str] = {"type": "rest", "uri": str(c.get("uri") or "").rstrip("/")}
        if c.get("warehouse"):
            props["warehouse"] = str(c["warehouse"])
        auth = c.get("auth_type") or "Bearer token"
        if auth == "Bearer token" and s.get("token"):
            props["token"] = s["token"]
        elif auth == "OAuth 2.0 client credentials":
            props["credential"] = f"{c.get('client_id') or ''}:{s.get('client_secret') or ''}"
            if c.get("scope"):
                props["scope"] = str(c["scope"])
            if c.get("oauth2_server_uri"):
                props["oauth2-server-uri"] = str(c["oauth2_server_uri"])
        elif auth == "AWS SigV4":
            props.update({"rest.sigv4-enabled": "true", "rest.signing-region": str(c.get("region") or "us-east-1"),
                          "rest.signing-name": str(c.get("signing_name") or "glue")})
            if c.get("access_key_id"):
                props.update({"rest.access-key-id": str(c["access_key_id"]), "rest.secret-access-key": s.get("secret_access_key") or ""})
        if c.get("vended_credentials", True):
            props["header.X-Iceberg-Access-Delegation"] = "vended-credentials"
        if c.get("access_key_id"):
            props.update({"s3.access-key-id": str(c["access_key_id"]), "s3.secret-access-key": s.get("secret_access_key") or ""})
            if s.get("session_token"):
                props["s3.session-token"] = s["session_token"]
        if c.get("region"):
            props["s3.region"] = str(c["region"])
        if c.get("s3_endpoint"):
            props["s3.endpoint"] = str(c["s3_endpoint"])
        for line in str(c.get("properties") or "").splitlines():
            k, sep, v = line.partition("=")
            if sep and k.strip() and not k.strip().startswith("#"):
                props[k.strip()] = v.strip()
        return props

    def catalog(self) -> Any:
        if self._catalog is None:
            if not self.config.get("uri"):
                raise ConnectorError("Enter the catalog URI")
            try:
                from pyiceberg.catalog import load_catalog
            except ImportError:
                raise ConnectorError("PyIceberg is not installed on this server") from None
            try:
                self._catalog = load_catalog(str(self.config.get("name") or "external"), **self.properties())
            except Exception as e:  # noqa: BLE001
                raise self.error(e, "Could not connect to the Iceberg catalog") from None
        return self._catalog

    def _ns(self, schema: str) -> tuple[str, ...]:
        return tuple(p for p in str(schema or "").split(".") if p)

    def _table(self, schema: str, table: str) -> Any:
        key = f"{schema}.{table}"
        if key not in self._tables:
            try:
                self._tables[key] = self.catalog().load_table((*self._ns(schema), table))
            except Exception as e:  # noqa: BLE001
                raise self.error(e, f"Could not load {key}") from None
        return self._tables[key]

    # -- discovery --

    def test_connection(self) -> dict:
        try:
            spaces = self.catalog().list_namespaces()
        except ConnectorError:
            raise
        except Exception as e:  # noqa: BLE001
            raise self.error(e, "Could not list the catalog's namespaces") from None
        return {"version": f"Iceberg REST catalog · {len(spaces)} namespace{'s' if len(spaces) != 1 else ''}"}

    def list_databases(self) -> list[str]:
        return [str(self.config.get("warehouse") or "catalog")]

    def list_schemas(self, database: str) -> list[str]:
        out: list[str] = []

        def walk(parent: tuple[str, ...], depth: int) -> None:
            try:
                children = self.catalog().list_namespaces(parent) if parent else self.catalog().list_namespaces()
            except Exception as e:  # noqa: BLE001
                if not parent:
                    raise self.error(e, "Could not list the catalog's namespaces") from None
                return
            for ns in children:
                ns = tuple(ns)
                if ns == parent or len(ns) <= len(parent):
                    continue
                out.append(".".join(ns))
                if depth < MAX_NAMESPACE_DEPTH:
                    walk(ns, depth + 1)

        walk((), 1)
        return sorted(set(out))

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        try:
            ids = self.catalog().list_tables(self._ns(schema))
        except Exception as e:  # noqa: BLE001
            raise self.error(e, f"Could not list the tables of {schema}") from None
        names = sorted(i[-1] for i in ids if not search or search.lower() in i[-1].lower())
        out = []
        for n in names:
            rows = comment = None
            if len(names) <= ROW_ESTIMATE_TABLES:
                try:
                    t = self._table(schema, n)
                    rows, comment = self._rows(t), t.properties.get("comment")
                except ConnectorError:
                    pass
            out.append({"name": n, "kind": "table", "rows": rows, "comment": comment})
        return out

    @staticmethod
    def _rows(t: Any) -> Optional[int]:
        snap = t.current_snapshot()
        if not snap or not snap.summary:
            return 0 if not snap else None
        v = snap.summary.additional_properties.get("total-records") if hasattr(snap.summary, "additional_properties") else None
        try:
            return int(v) if v is not None else None
        except ValueError:
            return None

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        t = self._table(schema, table)
        ischema = t.schema()
        arrow = ischema.as_arrow()
        docs = {f.name: f.doc for f in ischema.fields}
        cols = []
        for f in arrow:
            kind = arrow_kind(f.type)
            cols.append({"name": f.name, "db_type": str(ischema.find_field(f.name).field_type), "type": kind, "nullable": f.nullable,
                         "comment": docs.get(f.name), "scale": 0 if kind in ("Integer", "Long", "Short", "Byte") else (f.type.scale if pa.types.is_decimal(f.type) else None),
                         "precision": f.type.precision if pa.types.is_decimal(f.type) else None, "tz": bool(getattr(f.type, "tz", None))})
        pk = [ischema.find_column_name(i) for i in ischema.identifier_field_ids]
        cursor_candidates(cols, pk)
        return {"columns": cols, "primary_key": pk, "rows": self._rows(t), "comment": t.properties.get("comment"),
                "format_version": t.metadata.format_version, "location": t.location()}

    # -- reads --

    def _scan(self, schema: str, table: str, columns: Optional[list[str]] = None, row_filter: Any = None, limit: Optional[int] = None) -> Any:
        t = self._table(schema, table)
        kw: dict[str, Any] = {}
        if columns:
            kw["selected_fields"] = tuple(columns)
        if row_filter is not None:
            kw["row_filter"] = row_filter
        if limit is not None:
            kw["limit"] = limit
        return t.scan(**kw)

    def _arrow(self, scan: Any, action: str) -> pa.Table:
        try:
            return scan.to_arrow()
        except ConnectorError:
            raise
        except Exception as e:  # noqa: BLE001
            raise self.error(e, action) from None

    def _tuples(self, tbl: pa.Table, kinds: list[str]) -> list[tuple]:
        cols = [tbl.column(i).to_pylist() for i in range(tbl.num_columns)]
        return [tuple(convert(v, k) for v, k in zip(vals, kinds)) for vals in zip(*cols)] if cols else []

    def _kinds(self, database: str, schema: str, table: str, columns: list[str]) -> tuple[list[dict], list[str]]:
        info = {c["name"]: c for c in self.get_table_schema(database, schema, table)["columns"]}
        names = columns or list(info)
        missing = [n for n in names if n not in info]
        if missing:
            raise ConnectorError(f"Columns not in {table}: {', '.join(missing)}")
        return [info[n] for n in names], [info[n]["type"] for n in names]

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        cols, kinds = self._kinds(database, schema, table, [])
        tbl = self._arrow(self._scan(schema, table, limit=limit), f"Reading {table} failed")
        return cols, self._tuples(tbl.select([c["name"] for c in cols]), kinds)

    def _range(self, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> Any:
        from pyiceberg.expressions import AlwaysTrue, And, GreaterThan, GreaterThanOrEqual, LessThanOrEqual, NotNull

        expr: Any = NotNull(column)
        if lower is not None:
            expr = And(expr, GreaterThanOrEqual(column, lower) if lower_inclusive else GreaterThan(column, lower))
        if upper is not None:
            expr = And(expr, LessThanOrEqual(column, upper))
        return expr if expr is not None else AlwaysTrue()

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        tbl = self._arrow(self._scan(schema, table, [column]), f"Reading {column} failed")
        if tbl.num_rows == 0:
            return {"max": None}
        (col,), (kind,) = self._kinds(database, schema, table, [column])
        return {"max": convert(pc.max(tbl.column(0)).as_py(), kind)}

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        return self._arrow(self._scan(schema, table, [column], self._range(column, lower, lower_inclusive, upper)), "Counting failed").num_rows

    def read_range(self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any,
                   limit: Optional[int]) -> list[tuple]:
        cols, kinds = self._kinds(database, schema, table, columns)
        names = [c["name"] for c in cols]
        read = names if column in names else [*names, column]
        tbl = self._arrow(self._scan(schema, table, read, self._range(column, lower, lower_inclusive, upper)), f"Reading {table} failed")
        tbl = tbl.sort_by([(column, "ascending")])
        if limit is not None:
            tbl = tbl.slice(0, limit)
        return self._tuples(tbl.select(names), kinds)

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        cols, kinds = self._kinds(database, schema, table, columns)
        names = [c["name"] for c in cols]
        try:
            reader = self._scan(schema, table, names).to_arrow_batch_reader()
            pending: list[tuple] = []
            for batch in reader:
                pending.extend(self._tuples(pa.Table.from_batches([batch]).select(names), kinds))
                while len(pending) >= batch_size:
                    yield pending[:batch_size]
                    pending = pending[batch_size:]
            if pending:
                yield pending
        except ConnectorError:
            raise
        except Exception as e:  # noqa: BLE001
            raise self.error(e, "Reading the table failed") from None

    # -- virtual table outputs (virtual_tables.py) --

    def read_arrow(self, database: str, schema: str, table: str) -> pa.Table:
        return self._arrow(self._scan(schema, table), f"Reading {table} failed")

    def write_arrow(self, schema: str, table: str, data: pa.Table) -> None:
        """Replace the table's rows with `data` in one snapshot (created, with its namespace, when missing; a changed
        schema is evolved by name first)."""
        cat = self.catalog()
        ns = self._ns(schema)
        try:
            if ns not in [tuple(x) for x in cat.list_namespaces(ns[:-1] or ())]:
                cat.create_namespace(ns)
        except Exception:  # noqa: BLE001 - it may exist, or listing a parent may not be allowed
            pass
        ident = (*ns, table)
        try:
            if cat.table_exists(ident):
                t = cat.load_table(ident)
                with t.update_schema() as upd:
                    upd.union_by_name(data.schema)
                t = cat.load_table(ident)
                t.overwrite(data.cast(t.schema().as_arrow()) if data.num_rows else data)
            else:
                t = cat.create_table(ident, schema=data.schema)
                t.append(data)
        except Exception as e:  # noqa: BLE001
            raise self.error(e, f"Writing {schema}.{table} failed") from None
        self._tables.pop(f"{schema}.{table}", None)
