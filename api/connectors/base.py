"""The database connector abstraction.

`DatabaseConnector` is what the data source API talks to: discovery (databases, schemas, tables,
columns), bounded previews and batched extraction. A connector type is described by a
`ConnectorSpec` (its connection form, group and capabilities) so the UI renders any connector from
the same metadata, and a new database is one module plus one registry entry.

`SqlConnector` implements the interface for relational databases on top of a DB-API driver;
dialects override the catalog queries, identifier quoting and row limiting.

Safety rules every connector follows:
  * identifiers (database, schema, table, column) are only used after they were found in the
    database's own catalog, and are quoted with the dialect's rules;
  * values (cursors, limits, search text) are always bound parameters;
  * reads are bounded: previews use LIMIT, extraction streams in batches with keyset predicates;
  * sessions are read-only where the database supports it;
  * credentials never appear in errors or logs (`ConnectorError` scrubs them).
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

# --------------------------------------------------------------------------------------------
# connector metadata
# --------------------------------------------------------------------------------------------


@dataclass
class Field:
    """One input of a connection form."""

    name: str
    label: str
    kind: str = "text"  # text | number | password | bool | textarea | select
    required: bool = True
    default: Any = None
    placeholder: str = ""
    help: str = ""
    # kept encrypted, never sent back to the browser
    secret: bool = False
    options: list[str] = field(default_factory=list)

    def public(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


@dataclass
class OAuthApp:
    """An OAuth 2.0 authorization code sign-in (connector_oauth.py): the form's client ID and
    secret are sent to the provider, and the token it returns fills `token_field`."""

    authorize_url: Callable[[dict], str]
    token_url: Callable[[dict], str]
    scope: str = ""
    # a form field whose value is the scope (overrides `scope` when filled)
    scope_field: str = ""
    client_auth: str = "body"  # body | basic | auto (basic when a client secret is given)
    pkce: bool = True
    # extra authorize parameters (e.g. access_type=offline)
    extra: dict = field(default_factory=dict)
    token_field: str = "refresh_token"
    # the form fields holding the client ID (config) and secret (secret)
    client_id_field: str = "client_id"
    client_secret_field: str = "client_secret"


@dataclass
class ConnectorSpec:
    id: str
    name: str
    group: str  # sql | warehouse | timeseries | nosql | storage | apps | erp | sap
    description: str
    fields: list[Field]
    # builds a connector from the form values (None: not available yet)
    factory: Optional[Callable[[dict, dict], "DatabaseConnector"]] = None
    unavailable: str = ""
    # a database contains schemas (PostgreSQL, SQL Server) or is itself the schema (MySQL)
    schemas: bool = True
    # the (host, port) a connection reaches, for egress checks (None: from host / url fields)
    endpoint: Optional[Callable[[dict], tuple[Optional[str], Optional[int]]]] = None
    # reference from the connector catalog (catalog.json): what the connector can do and
    # needs, with each capability's release status and whether this server supports it
    docs_url: str = ""
    beta: bool = False
    capabilities: list[dict] = field(default_factory=list)
    properties: list[dict] = field(default_factory=list)
    networking: list[dict] = field(default_factory=list)
    # OAuth 2.0 sign-in in the connection form
    oauth: Optional[OAuthApp] = None
    # table exports (exports.py) are offered for SQL connectors unless the database cannot take
    # plain INSERTs in a transaction (Hive, Phoenix, read-only services)
    exports: bool = True
    # how table exports write: "table" (SQL INSERTs), "records" (an application's write API), None
    export_kind: Optional[str] = None

    @property
    def available(self) -> bool:
        return self.factory is not None

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "group": self.group,
            "description": self.description,
            "fields": [f.public() for f in self.fields],
            "available": self.available,
            "unavailable": self.unavailable,
            "schemas": self.schemas,
            "docs_url": self.docs_url,
            "beta": self.beta,
            "capabilities": self.capabilities,
            "properties": self.properties,
            "networking": self.networking,
            "oauth": {"token_field": self.oauth.token_field, "client_id_field": self.oauth.client_id_field} if self.oauth else None,
            "export_kind": self.export_kind,
        }

    def split(self, values: dict) -> tuple[dict, dict]:
        """Form values → (config, secrets), validated and typed."""
        config, secrets = {}, {}
        for f in self.fields:
            v = values.get(f.name, f.default)
            if isinstance(v, str):
                v = v.strip() if not f.secret else v
            if f.kind == "number" and v not in (None, ""):
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    raise ConnectorError(f"{f.label} must be a number") from None
                if f.name == "port" and not 0 < v < 65536:
                    raise ConnectorError("Port must be between 1 and 65535")
            if f.kind == "bool":
                v = bool(v)
            if f.kind == "select" and v not in (None, "") and f.options and v not in f.options:
                raise ConnectorError(f"{f.label} must be one of {', '.join(f.options)}")
            if f.name == "host" and isinstance(v, str) and v and not re.fullmatch(r"[A-Za-z0-9._:\-\[\]]+", v):
                raise ConnectorError("Host must be a host name or IP address")
            (secrets if f.secret else config)[f.name] = v
        return config, secrets

    def missing(self, config: dict, secrets: dict) -> list[str]:
        values = {**config, **secrets}
        return [f.label for f in self.fields if f.required and f.kind != "bool" and values.get(f.name) in (None, "")]


# common form pieces
def host_fields(port: int, database_label: str = "Database", database_required: bool = True, ssl: bool = True) -> list[Field]:
    fields = [
        Field("host", "Host", placeholder="db.example.com"),
        Field("port", "Port", "number", default=port),
        Field("database", database_label, required=database_required),
        Field("user", "Username"),
        Field("password", "Password", "password", secret=True, required=False),
    ]
    if ssl:
        fields.append(Field("ssl", "SSL", "bool", required=False, default=True, help="Encrypt the connection (required by most cloud databases)"))
    return fields


# --------------------------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------------------------


class ConnectorError(Exception):
    """A user-facing error: what failed, without credentials."""


def scrub(message: str, secrets: dict) -> str:
    for v in secrets.values():
        if isinstance(v, str) and len(v) >= 3:
            message = message.replace(v, "••••")
    return re.sub(r"(password|pwd|token|secret)=\S+", r"\1=••••", message, flags=re.I)


# --------------------------------------------------------------------------------------------
# types: database types → the pipeline's column types
# --------------------------------------------------------------------------------------------

COL_TYPES = ("String", "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Decimal", "Date", "Timestamp", "Binary")
INTEGER_TYPES = ("Byte", "Short", "Integer", "Long")


def column_type(db_type: str, precision: Optional[int] = None, scale: Optional[int] = None) -> str:
    """The pipeline type for a database type name (lowercase, without modifiers)."""
    t = db_type.lower().strip()
    t = re.sub(r"\(.*", "", t).replace("unsigned", "").strip()
    if t in ("bool", "boolean", "bit"):
        return "Boolean"
    if t in ("tinyint", "int1"):
        return "Byte"
    if t in ("smallint", "int2", "smallserial", "year"):
        return "Short"
    if t in ("int", "integer", "int4", "serial", "mediumint"):
        return "Integer"
    if t in ("bigint", "int8", "bigserial"):
        return "Long"
    if t in ("real", "float4"):
        return "Float"
    if t in ("double precision", "double", "float8", "float", "binary_double", "binary_float"):
        return "Double"
    if t in ("numeric", "decimal", "number", "money", "smallmoney"):
        # Parquet holds decimal(38, 18): unbounded or wider decimals are kept as doubles
        if precision is not None and scale is not None and 0 <= scale <= 18 and precision - scale <= 20:
            return "Decimal"
        return "Double"
    if t == "date":
        return "Date"
    if t.startswith("timestamp") or t in ("datetime", "datetime2", "smalldatetime", "datetimeoffset", "timestamptz"):
        return "Timestamp"
    if t in ("bytea", "blob", "longblob", "mediumblob", "tinyblob", "binary", "varbinary", "image", "raw"):
        return "Binary"
    return "String"


def number_type(precision: Optional[int], scale: Optional[int]) -> str:
    """NUMBER(p, s) of Oracle / Snowflake: whole numbers become integers, the rest decimals or doubles."""
    if scale == 0:
        return "Integer" if precision is not None and precision <= 9 else "Long"
    return column_type("numeric", precision, scale)


# names that suggest a column only grows (good incremental cursors)
CURSOR_NAME = re.compile(r"(^|_)(ts|time|timestamp|date|datetime|created|updated|modified|inserted|ingested|event|logged|recorded|seq|sequence|id)($|_|at$)|_at$|_on$|_time$|_ts$|_date$", re.I)


def cursor_candidates(columns: list[dict], primary_key: list[str]) -> None:
    """Mark columns usable as an incremental cursor, and recommend the likely ones (in place)."""
    for c in columns:
        usable = c["type"] in ("Timestamp", "Date", *INTEGER_TYPES) or (c["type"] == "Decimal" and c.get("scale") == 0)
        c["cursor"] = usable
        recommended = False
        if usable:
            if c["type"] in ("Timestamp", "Date"):
                recommended = True
            elif c.get("identity") or (c["name"] in primary_key and len(primary_key) == 1) or CURSOR_NAME.search(c["name"]):
                recommended = True
        c["recommended"] = recommended


# --------------------------------------------------------------------------------------------
# the connector interface
# --------------------------------------------------------------------------------------------


class DatabaseConnector(ABC):
    """One open connection (or client) to an external database. Use as a context manager."""

    spec: ConnectorSpec

    def __init__(self, config: dict, secrets: dict):
        self.config = config
        self.secrets = secrets

    def __enter__(self) -> "DatabaseConnector":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:  # noqa: B027 - optional
        pass

    def error(self, e: BaseException, action: str) -> ConnectorError:
        return ConnectorError(f"{action}: {scrub(str(e).strip() or type(e).__name__, self.secrets)}")

    # -- discovery --

    @abstractmethod
    def test_connection(self) -> dict:
        """Connect and return {"version": ...}; raises ConnectorError."""

    @abstractmethod
    def list_databases(self) -> list[str]: ...

    @abstractmethod
    def list_schemas(self, database: str) -> list[str]: ...

    @abstractmethod
    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        """[{name, kind: table|view, rows (estimate or None), comment}] without reading the tables."""

    @abstractmethod
    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        """{columns: [{name, db_type, type, nullable, comment, cursor, recommended}], primary_key, rows, comment}"""

    def get_row_count(self, database: str, schema: str, table: str) -> Optional[int]:
        """An estimate from the catalog (never a full count)."""
        return self.get_table_schema(database, schema, table).get("rows")

    # -- reads --

    @abstractmethod
    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        """At most `limit` rows: (columns, rows)."""

    @abstractmethod
    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        """{"max": the column's current maximum} — the upper bound of the next batch."""

    @abstractmethod
    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        """Rows with lower <(=) column <= upper (no lower bound when lower is None)."""

    @abstractmethod
    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        """Rows in the cursor range, ordered by the cursor, at most `limit` (None: all)."""

    @abstractmethod
    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        """The whole table (a snapshot) in batches, streamed by the server."""

    def list_foreign_keys(self, database: str, schema: str) -> list[dict]:
        """Foreign keys between the schema's tables: [{table, name, columns, ref_table, ref_columns}]
        (empty for databases without them)."""
        return []


# --------------------------------------------------------------------------------------------
# relational databases over DB-API
# --------------------------------------------------------------------------------------------

PREVIEW_TIMEOUT_S = 60


class SqlConnector(DatabaseConnector):
    """Shared implementation for SQL databases; dialects provide connections and catalog queries.

    All three bundled drivers (psycopg, PyMySQL, pymssql) use %s placeholders.
    """

    # system schemas / databases hidden from browsing
    hidden_schemas: tuple[str, ...] = ("information_schema",)

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._conns: dict[str, Any] = {}

    # sessions are read-only unless opened for writing (exports, virtual table outputs)
    writable = False

    def begin_write(self, conn: Any) -> None:
        """Start an explicit transaction on a writable connection (dialects in autocommit mode)."""

    def bind_rows(self, cur: Any, rows: list[tuple]) -> None:
        """Before an executemany: declare bind types the driver would get wrong (dialect hook)."""

    # -- dialect hooks --

    @abstractmethod
    def _connect(self, database: str) -> Any: ...

    def quote(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def limit(self, select: str, n: int) -> str:
        """`select` ends with its ORDER BY (if any); add the row limit."""
        return f"{select} LIMIT {int(n)}"

    def _stream_cursor(self, conn: Any) -> Any:
        """A cursor that fetches from the server in pieces."""
        return conn.cursor()

    def prepare(self, sql: str, params: tuple) -> tuple[str, Any]:
        """SQL written with %s placeholders → the driver's parameter style."""
        return sql, params

    # one connection reaches every database (warehouses with fully qualified names)
    shared_connection = False

    # -- plumbing --

    def conn(self, database: Optional[str] = None) -> Any:
        database = "" if self.shared_connection else (database or self.config.get("database") or "")
        if database not in self._conns:
            try:
                self._conns[database] = self._connect(database)
            except ConnectorError:
                raise
            except Exception as e:  # driver errors
                raise self.error(e, "Could not connect") from None
        return self._conns[database]

    def close(self) -> None:
        for c in self._conns.values():
            try:
                c.close()
            except Exception:
                pass
        self._conns.clear()

    def query(self, sql: str, params: tuple = (), database: Optional[str] = None, action: str = "Query failed") -> list[tuple]:
        conn = self.conn(database)
        try:
            cur = conn.cursor()
            try:
                # no parameters: the drivers then leave the SQL text as it is
                sql, bound = self.prepare(sql, params)
                cur.execute(sql, bound or None)
                return cur.fetchall() if cur.description else []
            finally:
                cur.close()
        except ConnectorError:
            raise
        except Exception as e:
            self._reset(conn)
            raise self.error(e, action) from None

    def _reset(self, conn: Any) -> None:
        """After an error, leave the connection usable (end an aborted transaction)."""
        try:
            conn.rollback()
        except Exception:
            pass

    def ident(self, name: str) -> str:
        if not name or "\x00" in name or "%" in name:
            raise ConnectorError(f'Unsupported name "{name}"')
        return self.quote(name)

    # qualify table names with the database (catalog / project) too
    qualify_database = False

    def table_ref(self, database: str, schema: str, table: str) -> str:
        """Quoted name of a table that exists in the catalog (validated, never raw input)."""
        if not any(t["name"] == table for t in self.list_tables(database, schema, table)):
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        ref = f"{self.ident(schema)}.{self.ident(table)}"
        return f"{self.ident(database)}.{ref}" if self.qualify_database else ref

    def _columns(self, database: str, schema: str, table: str, wanted: Optional[list[str]] = None) -> tuple[str, list[dict]]:
        info = self.get_table_schema(database, schema, table)
        cols = info["columns"]
        if wanted:
            known = {c["name"]: c for c in cols}
            missing = [w for w in wanted if w not in known]
            if missing:
                raise ConnectorError(f"Columns not in the table: {', '.join(missing)}")
            cols = [known[w] for w in wanted]
        return self.table_ref(database, schema, table), cols

    def _cursor_column(self, database: str, schema: str, table: str, column: str) -> tuple[str, str]:
        ref, cols = self._columns(database, schema, table, [column])
        if not cols[0]["cursor"]:
            raise ConnectorError(f'"{column}" ({cols[0]["db_type"]}) cannot be an incremental cursor: use a timestamp, date or integer column')
        return ref, self.ident(column)

    # -- interface --

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        ref, cols = self._columns(database, schema, table)
        select = ", ".join(self.ident(c["name"]) for c in cols)
        rows = self.query(self.limit(f"SELECT {select} FROM {ref}", max(1, min(limit, 1000))), database=database, action="Preview failed")
        return cols, rows

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        ref, col = self._cursor_column(database, schema, table, column)
        (row,) = self.query(f"SELECT MAX({col}) FROM {ref}", database=database, action="Could not read the cursor's current maximum")
        return {"max": row[0]}

    def _range_where(self, col: str, lower: Any, lower_inclusive: bool, upper: Any) -> tuple[str, tuple]:
        where, params = [f"{col} <= %s"], [upper]
        if lower is not None:
            where.insert(0, f"{col} {'>=' if lower_inclusive else '>'} %s")
            params.insert(0, lower)
        return " AND ".join(where), tuple(params)

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        ref, col = self._cursor_column(database, schema, table, column)
        where, params = self._range_where(col, lower, lower_inclusive, upper)
        (row,) = self.query(f"SELECT COUNT(*) FROM {ref} WHERE {where}", params, database=database, action="Could not count the new rows")
        return int(row[0])

    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        ref, col = self._cursor_column(database, schema, table, column)
        _, cols = self._columns(database, schema, table, columns or None)
        select = ", ".join(self.ident(c["name"]) for c in cols)
        where, params = self._range_where(col, lower, lower_inclusive, upper)
        sql = f"SELECT {select} FROM {ref} WHERE {where} ORDER BY {col}"
        return self.query(self.limit(sql, limit) if limit else sql, params, database=database, action="Reading new rows failed")

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        ref, cols = self._columns(database, schema, table, columns or None)
        select = ", ".join(self.ident(c["name"]) for c in cols)
        conn = self.conn(database)
        cur = self._stream_cursor(conn)
        try:
            cur.execute(self.prepare(f"SELECT {select} FROM {ref}", ())[0])
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                yield list(rows)
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, "Reading the table failed") from None
        finally:
            try:
                cur.close()
            except Exception:
                pass

    # -- information_schema defaults (portable; dialects override with richer catalogs) --

    def list_schemas(self, database: str) -> list[str]:
        rows = self.query(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name", database=database, action="Could not list schemas"
        )
        return [r[0] for r in rows if r[0].lower() not in self.hidden_schemas and not r[0].lower().startswith("pg_")]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        rows = self.query(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = %s"
            " AND (%s = '' OR LOWER(table_name) LIKE %s) ORDER BY table_name",
            (schema, search, f"%{search.lower()}%"),
            database=database,
            action="Could not list tables",
        )
        return [{"name": r[0], "kind": "view" if "VIEW" in (r[1] or "").upper() else "table", "rows": None, "comment": None} for r in rows]

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        rows = self.query(
            "SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns"
            " WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
            (schema, table),
            database=database,
            action="Could not read the table's columns",
        )
        if not rows:
            raise ConnectorError(f'Table "{schema}.{table}" was not found or is not readable')
        columns = [
            {"name": r[0], "db_type": r[1], "type": column_type(r[1], r[3], r[4]), "nullable": r[2] == "YES", "comment": None, "scale": r[4]}
            for r in rows
        ]
        pk = self._primary_key(database, schema, table)
        cursor_candidates(columns, pk)
        return {"columns": columns, "primary_key": pk, "rows": None, "comment": None}

    def list_foreign_keys(self, database: str, schema: str) -> list[dict]:
        """Standard information_schema: referential constraints paired column by column."""
        try:
            rows = self.query(
                "SELECT k.table_name, k.constraint_name, k.column_name, u.table_name, u.column_name"
                " FROM information_schema.referential_constraints r"
                " JOIN information_schema.key_column_usage k ON k.constraint_schema = r.constraint_schema AND k.constraint_name = r.constraint_name"
                " JOIN information_schema.key_column_usage u ON u.constraint_schema = r.unique_constraint_schema"
                " AND u.constraint_name = r.unique_constraint_name AND u.ordinal_position = k.position_in_unique_constraint"
                " WHERE k.table_schema = %s AND u.table_schema = %s ORDER BY k.table_name, k.constraint_name, k.ordinal_position",
                (schema, schema),
                database=database,
                action="Could not read the foreign keys",
            )
        except ConnectorError:
            return []
        return group_foreign_keys(rows)

    def _primary_key(self, database: str, schema: str, table: str) -> list[str]:
        rows = self.query(
            "SELECT k.column_name FROM information_schema.table_constraints c"
            " JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name"
            " AND k.table_schema = c.table_schema AND k.table_name = c.table_name"
            " WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = %s AND c.table_name = %s ORDER BY k.ordinal_position",
            (schema, table),
            database=database,
            action="Could not read the primary key",
        )
        return [r[0] for r in rows]

def group_foreign_keys(rows: list[tuple]) -> list[dict]:
    """(table, constraint, column, ref_table, ref_column[, ref_schema]) rows in column order → one
    entry per foreign key: {table, name, columns, ref_table, ref_columns}."""
    out: dict[tuple, dict] = {}
    for r in rows:
        key = (r[0], r[1])
        fk = out.setdefault(key, {"table": r[0], "name": r[1], "columns": [], "ref_table": r[3], "ref_columns": []})
        fk["columns"].append(r[2])
        fk["ref_columns"].append(r[4])
    return list(out.values())
