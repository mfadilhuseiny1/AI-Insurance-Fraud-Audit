"""MongoDB (pymongo): collections as tables.

A database is the schema: browsing is database → collection. Columns are the top-level fields of
a bounded sample (SAMPLE_DOCS documents, never the whole collection); nested documents and arrays
become JSON text. Row counts use estimated_document_count (collection metadata, no scan).

Incremental cursors: `_id` when it holds ObjectIds (they grow with insertion time), or any date
or number field. Range reads are filtered, sorted, limited queries — an index on the cursor
field keeps them cheap.
"""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterator, Optional

import pymongo
from bson import Decimal128, ObjectId
from pymongo.errors import PyMongoError

from .base import ConnectorError, DatabaseConnector, cursor_candidates

SYSTEM_DATABASES = ("admin", "local", "config")
SAMPLE_DOCS = 500


def _kind(values: list[Any]) -> tuple[str, str]:
    """(pipeline type, BSON type shown) of a field from sampled values."""
    present = [v for v in values if v is not None]
    if not present:
        return "String", "null"
    kinds = {type(v) for v in present}
    if kinds == {bool}:
        return "Boolean", "bool"
    if kinds <= {int} and not any(isinstance(v, bool) for v in present):
        return ("Integer", "int") if all(-(2**31) <= v < 2**31 for v in present) else ("Long", "long")
    if kinds <= {int, float} and not any(isinstance(v, bool) for v in present):
        return "Double", "double"
    if kinds == {Decimal128}:
        return "Decimal", "decimal"
    if kinds == {datetime}:
        return "Timestamp", "date"
    if kinds == {ObjectId}:
        return "String", "objectId"
    if kinds <= {dict}:
        return "String", "object"
    if kinds <= {list}:
        return "String", "array"
    if kinds == {bytes}:
        return "Binary", "binData"
    if kinds == {str}:
        return "String", "string"
    return "String", "mixed"


def _plain(v: Any) -> Any:
    """BSON values the normalizer does not know → Python ones."""
    if isinstance(v, Decimal128):
        return v.to_decimal()
    if isinstance(v, ObjectId):
        return str(v)
    if isinstance(v, (dict, list)):
        return _jsonable(v)
    return v


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if isinstance(v, (ObjectId, Decimal128, Decimal)):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    return v


class MongoConnector(DatabaseConnector):
    statement_timeout_s = 60

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._client: Optional[pymongo.MongoClient] = None

    @property
    def client(self) -> pymongo.MongoClient:
        if self._client is None:
            try:
                self._client = pymongo.MongoClient(
                    self.secrets["uri"],
                    serverSelectionTimeoutMS=10_000,
                    connectTimeoutMS=10_000,
                    socketTimeoutMS=int(self.statement_timeout_s * 1000),
                    appname="bluesandai-connector",
                    # dates come back as UTC instants, like the cursors they are compared with
                    tz_aware=True,
                )
            except (PyMongoError, ValueError, KeyError) as e:
                raise self.error(e, "Could not connect") from None
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _do(self, fn: Any, action: str) -> Any:
        try:
            return fn()
        except ConnectorError:
            raise
        except (PyMongoError, ValueError, TypeError) as e:
            raise self.error(e, action) from None

    def _coll(self, database: str, table: str) -> Any:
        if table not in self._do(lambda: self.client[database].list_collection_names(), "Could not list collections"):
            raise ConnectorError(f'Collection "{database}.{table}" was not found or is not readable')
        return self.client[database][table]

    # -- discovery --

    def test_connection(self) -> dict:
        info = self._do(lambda: self.client.server_info(), "Could not connect")
        return {"version": f"MongoDB {info.get('version', '')}".strip()}

    def list_databases(self) -> list[str]:
        own = self.config.get("database") or ""
        try:
            names = [n for n in self.client.list_database_names() if n not in SYSTEM_DATABASES]
        except PyMongoError:
            # users without listDatabases see only their own database
            names = []
        if not names:
            default = self.client.get_default_database(default=None) if own == "" else None
            own = own or (default.name if default is not None else "")
        return names if not own or own in names else [own, *names]

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        db = self.client[database]
        flt = {"name": {"$regex": re.escape(search), "$options": "i"}} if search else {}
        infos = self._do(lambda: list(db.list_collections(filter=flt)), "Could not list collections")
        out = []
        for i in sorted(infos, key=lambda x: x["name"]):
            if i["name"].startswith("system."):
                continue
            view = i.get("type") == "view"
            rows = None
            if not view and len(out) < 300:
                try:
                    rows = db[i["name"]].estimated_document_count()
                except PyMongoError:
                    rows = None
            out.append({"name": i["name"], "kind": "view" if view else "table", "rows": rows, "comment": None})
        return out

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        coll = self._coll(database, table)
        docs = self._do(lambda: list(coll.find({}, limit=SAMPLE_DOCS)), "Could not sample the collection")
        names: list[str] = []
        for d in docs:
            for k in d:
                if k not in names:
                    names.append(k)
        if "_id" in names:
            names.remove("_id")
            names.insert(0, "_id")
        columns = []
        for n in names:
            values = [d.get(n) for d in docs]
            kind, shown = _kind(values)
            columns.append(
                {
                    "name": n,
                    "db_type": shown,
                    "type": kind,
                    "nullable": any(n not in d or d[n] is None for d in docs),
                    "comment": None,
                    "scale": 0 if kind in ("Integer", "Long") else None,
                    "tz": True,
                    # ObjectId cursors are bound as ObjectIds ("Start from" takes a 24-hex id)
                    "cursor_kind": "ObjectId" if shown == "objectId" else None,
                }
            )
        cursor_candidates(columns, [])
        for c in columns:
            if c["db_type"] == "objectId" and c["name"] == "_id":
                c["cursor"] = c["recommended"] = True
        rows = None
        try:
            rows = coll.estimated_document_count()
        except PyMongoError:
            pass
        return {"columns": columns, "primary_key": ["_id"] if "_id" in names else [], "rows": rows, "comment": f"Columns inferred from {len(docs)} sampled documents"}

    # -- reads --

    def _rows(self, docs: list[dict], names: list[str]) -> list[tuple]:
        # ObjectIds stay ObjectIds here: an _id cursor is stored and bound as one
        return [tuple(d.get(n) if isinstance(d.get(n), ObjectId) else _plain(d.get(n)) for n in names) for d in docs]

    def _cursor_field(self, database: str, schema: str, table: str, column: str) -> dict:
        col = next((c for c in self.get_table_schema(database, schema, table)["columns"] if c["name"] == column), None)
        if not col:
            raise ConnectorError(f'"{column}" is not a field of {table}')
        if not col["cursor"]:
            raise ConnectorError(f'"{column}" ({col["db_type"]}) cannot be a cursor: use _id, a date or a number field')
        return col

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        info = self.get_table_schema(database, schema, table)
        names = [c["name"] for c in info["columns"]]
        docs = self._do(lambda: list(self._coll(database, table).find({}, limit=max(1, min(limit, 1000)))), "Preview failed")
        # ids are shown as text in previews
        return info["columns"], [tuple(_plain(d.get(n)) for n in names) for d in docs]

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        self._cursor_field(database, schema, table, column)
        doc = self._do(
            lambda: self._coll(database, table).find_one({column: {"$ne": None}}, projection={column: 1}, sort=[(column, -1)]),
            "Could not read the cursor's current maximum",
        )
        return {"max": doc.get(column) if doc else None}

    def _range(self, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> dict:
        cond: dict[str, Any] = {"$lte": upper}
        if lower is not None:
            cond["$gte" if lower_inclusive else "$gt"] = lower
        return {column: cond}

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        self._cursor_field(database, schema, table, column)
        return self._do(lambda: self._coll(database, table).count_documents(self._range(column, lower, lower_inclusive, upper)), "Could not count the new rows")

    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        self._cursor_field(database, schema, table, column)
        names = columns or [c["name"] for c in self.get_table_schema(database, schema, table)["columns"]]
        cur = self._coll(database, table).find(self._range(column, lower, lower_inclusive, upper), sort=[(column, 1)])
        if limit:
            cur = cur.limit(limit)
        docs = self._do(lambda: list(cur), "Reading new rows failed")
        return self._rows(docs, names)

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        names = columns or [c["name"] for c in self.get_table_schema(database, schema, table)["columns"]]
        try:
            batch: list[dict] = []
            for d in self._coll(database, table).find({}, batch_size=min(batch_size, 10_000)):
                batch.append(d)
                if len(batch) >= batch_size:
                    yield [tuple(_plain(x.get(n)) for n in names) for x in batch]
                    batch = []
            if batch:
                yield [tuple(_plain(x.get(n)) for n in names) for x in batch]
        except ConnectorError:
            raise
        except PyMongoError as e:
            raise self.error(e, "Reading the collection failed") from None
