"""Connectors over record APIs (REST services, key-value and document stores): a shared base.

Sources without SQL hand back records (dicts). `RecordConnector` turns them into the connector
interface: columns are declared by the source (Airtable fields) or inferred from a bounded sample
(SAMPLE_RECORDS records); nested values become JSON text; ISO-8601 strings that are all dates or
date-times become Date / Timestamp columns, so they can be incremental cursors.

Table exports into an application (`exports_records`): `write_records` creates (or, with a key
field, upserts) records through the application's write API, `write_size` records per call, and
`writable_columns` names the fields a record may set.

Incremental reads: a source may push a cursor range down (`_range_records`); otherwise the range
is filtered here while the records stream past. A sync reads one cursor window in several
batches, so the window's sorted rows (from the sync's lower bound) are kept for the connector's
lifetime (up to CACHE_ROWS) instead of being fetched again for every batch.
"""

from __future__ import annotations

import json
import re
from abc import abstractmethod
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional

from .base import ConnectorError, DatabaseConnector, cursor_candidates

SAMPLE_RECORDS = 500
CACHE_ROWS = 500_000

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$")


def parse_datetime(v: str) -> datetime:
    s = v.strip().replace(" ", "T", 1).replace("Z", "+00:00")
    # Python takes at most 6 fractional digits
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    t = datetime.fromisoformat(s)
    return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t.astimezone(timezone.utc)


def infer_kind(values: list[Any]) -> tuple[str, str]:
    """(pipeline type, source type shown) of a field from sampled values."""
    present = [v for v in values if v is not None and v != ""]
    if not present:
        return "String", "null"
    if all(isinstance(v, bool) for v in present):
        return "Boolean", "boolean"
    if all(isinstance(v, (int, Decimal)) and not isinstance(v, bool) and (not isinstance(v, Decimal) or v == v.to_integral_value()) for v in present):
        ints = [int(v) for v in present]
        return ("Integer", "integer") if all(-(2**31) <= v < 2**31 for v in ints) else ("Long", "integer")
    if all(isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) for v in present):
        return "Double", "number"
    if all(isinstance(v, datetime) for v in present):
        return "Timestamp", "datetime"
    if all(isinstance(v, date) and not isinstance(v, datetime) for v in present):
        return "Date", "date"
    if all(isinstance(v, str) for v in present):
        if all(_DATE.match(v) for v in present):
            return "Date", "date string"
        if all(_DATETIME.match(v) for v in present):
            return "Timestamp", "datetime string"
        return "String", "string"
    if all(isinstance(v, dict) for v in present):
        return "String", "object"
    if all(isinstance(v, (list, set, tuple)) for v in present):
        return "String", "array"
    if all(isinstance(v, (bytes, bytearray)) for v in present):
        return "Binary", "binary"
    return "String", "mixed"


def jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [jsonable(x) for x in v]
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        import base64

        return base64.b64encode(bytes(v)).decode()
    return v


def convert(v: Any, kind: str) -> Any:
    """A record value as the column's type (None when it does not fit)."""
    if v is None or v == "":
        return None
    try:
        if kind in ("Integer", "Long", "Short", "Byte"):
            return int(v)
        if kind in ("Double", "Float"):
            return float(v)
        if kind == "Decimal":
            return v if isinstance(v, Decimal) else Decimal(str(v))
        if kind == "Boolean":
            return bool(v)
        if kind == "Timestamp":
            if isinstance(v, datetime):
                return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v
            return parse_datetime(str(v))
        if kind == "Date":
            if isinstance(v, datetime):
                return v.date()
            return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])
        if kind == "Binary":
            return bytes(v) if isinstance(v, (bytes, bytearray)) else str(v).encode()
    except (TypeError, ValueError, ArithmeticError):
        return None
    if isinstance(v, (dict, list, tuple, set, frozenset)):
        return json.dumps(jsonable(v), ensure_ascii=False, default=str)
    if isinstance(v, Decimal):
        return str(v)
    return v


def column(name: str, kind: str, shown: str, nullable: bool = True, comment: Optional[str] = None) -> dict:
    return {
        "name": name,
        "db_type": shown,
        "type": kind,
        "nullable": nullable,
        "comment": comment,
        "scale": 0 if kind in ("Integer", "Long") else None,
        # timestamps are UTC instants
        "tz": True,
    }


class RecordConnector(DatabaseConnector):
    """Subclasses list tables and stream records; this class does the rest."""

    statement_timeout_s = 60

    def __init__(self, config: dict, secrets: dict):
        super().__init__(config, secrets)
        self._schemas: dict[tuple, dict] = {}
        self._window: Optional[tuple[tuple, Any, bool, list[tuple]]] = None

    # -- what a source provides --

    @abstractmethod
    def _list_tables(self, database: str, search: str) -> list[dict]:
        """[{name, kind, rows, comment}]"""

    @abstractmethod
    def _records(self, database: str, table: str, limit: Optional[int] = None) -> Iterator[list[dict]]:
        """The table's records in batches (at most `limit` records when given)."""

    def _declared_columns(self, database: str, table: str) -> Optional[list[dict]]:
        """Columns the source declares (None: infer them from a sample)."""
        return None

    def _primary_key(self, database: str, table: str, columns: list[dict]) -> list[str]:
        return []

    def _range_records(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Optional[Iterator[list[dict]]]:
        """Records with lower <(=) column <= upper, filtered by the source (None: filter here)."""
        return None

    # -- writes (table exports) --

    # True when write_records is implemented
    exports_records = False

    def writable_columns(self, database: str, table: str) -> Optional[list[str]]:
        """The fields a new record may set (None: not known here; the application checks)."""
        return None

    def write_size(self, database: str, table: str) -> int:
        """Records per write_records call (one request to the application)."""
        return 1

    def write_records(self, database: str, table: str, records: list[dict], key: Optional[str] = None) -> None:
        """Create the records in the table, or with `key` create or update them by that field.
        Values are JSON values (dates as ISO-8601 text); fields left out are not set."""
        raise ConnectorError("This source does not take table exports")

    # -- discovery --

    def list_schemas(self, database: str) -> list[str]:
        return [database]

    def list_tables(self, database: str, schema: str, search: str = "") -> list[dict]:
        tables = self._list_tables(database, search)
        if search:
            tables = [t for t in tables if search.lower() in t["name"].lower()]
        return sorted(tables, key=lambda t: t["name"].lower())

    def _table(self, database: str, table: str) -> None:
        if not any(t["name"] == table for t in self._list_tables(database, table)):
            raise ConnectorError(f'"{table}" was not found or is not readable')

    def get_table_schema(self, database: str, schema: str, table: str) -> dict:
        return self._schema(database, table)

    def _schema(self, database: str, table: str) -> dict:
        key = (database, table)
        if key in self._schemas:
            return self._schemas[key]
        self._table(database, table)
        declared = self._declared_columns(database, table)
        comment = None
        if declared is not None:
            columns = declared
        else:
            sample: list[dict] = []
            for batch in self._records(database, table, SAMPLE_RECORDS):
                sample.extend(batch)
                if len(sample) >= SAMPLE_RECORDS:
                    break
            sample = sample[:SAMPLE_RECORDS]
            names: list[str] = []
            for r in sample:
                for k in r:
                    if k not in names:
                        names.append(k)
            columns = []
            for n in names:
                kind, shown = infer_kind([r.get(n) for r in sample])
                columns.append(column(n, kind, shown, any(r.get(n) is None for r in sample)))
            comment = f"Columns inferred from {len(sample)} sampled records"
        pk = self._primary_key(database, table, columns)
        cursor_candidates(columns, pk)
        info = {"columns": columns, "primary_key": pk, "rows": None, "comment": comment}
        self._schemas[key] = info
        return info

    # -- reads --

    def _cols(self, database: str, table: str, names: Optional[list[str]] = None) -> list[dict]:
        cols = self._schema(database, table)["columns"]
        if not names:
            return cols
        known = {c["name"]: c for c in cols}
        missing = [n for n in names if n not in known]
        if missing:
            raise ConnectorError(f"Columns not in {table}: {', '.join(missing)}")
        return [known[n] for n in names]

    def _row(self, record: dict, cols: list[dict]) -> tuple:
        return tuple(convert(record.get(c["name"]), c["type"]) for c in cols)

    def _cursor(self, database: str, table: str, name: str) -> dict:
        (col,) = self._cols(database, table, [name])
        if not col["cursor"]:
            raise ConnectorError(f'"{name}" ({col["db_type"]}) cannot be an incremental cursor: use a date, date-time or integer field')
        return col

    def _safe(self, fn: Any, action: str) -> Any:
        try:
            return fn()
        except ConnectorError:
            raise
        except Exception as e:  # source client errors
            raise self.error(e, action) from None

    def preview_rows(self, database: str, schema: str, table: str, limit: int = 100) -> tuple[list[dict], list[tuple]]:
        cols = self._cols(database, table)
        limit = max(1, min(limit, 1000))
        rows: list[tuple] = []

        def read() -> None:
            for batch in self._records(database, table, limit):
                rows.extend(self._row(r, cols) for r in batch)
                if len(rows) >= limit:
                    break

        self._safe(read, "Preview failed")
        return cols, rows[:limit]

    def _scan_range(self, database: str, table: str, col: dict, lower: Any, lower_inclusive: bool, upper: Any) -> Iterator[Any]:
        """(cursor value, record) pairs in the range."""
        name, kind = col["name"], col["type"]
        pushed = self._range_records(database, table, col, lower, lower_inclusive, upper)
        for batch in pushed if pushed is not None else self._records(database, table):
            for r in batch:
                v = convert(r.get(name), kind)
                if v is None or (upper is not None and v > upper):
                    continue
                if lower is not None and (v < lower or (v == lower and not lower_inclusive)):
                    continue
                yield v, r

    def get_incremental_metadata(self, database: str, schema: str, table: str, column: str) -> dict:
        col = self._cursor(database, table, column)

        def scan() -> Any:
            top = None
            for batch in self._records(database, table):
                for r in batch:
                    v = convert(r.get(column), col["type"])
                    if v is not None and (top is None or v > top):
                        top = v
            return top

        return {"max": self._safe(scan, "Could not read the cursor's current maximum")}

    def count_range(self, database: str, schema: str, table: str, column: str, lower: Any, lower_inclusive: bool, upper: Any) -> int:
        col = self._cursor(database, table, column)
        return self._safe(lambda: sum(1 for _ in self._scan_range(database, table, col, lower, lower_inclusive, upper)), "Could not count the new rows")

    def read_range(
        self, database: str, schema: str, table: str, columns: list[str], column: str, lower: Any, lower_inclusive: bool, upper: Any, limit: Optional[int]
    ) -> list[tuple]:
        col = self._cursor(database, table, column)
        cols = self._cols(database, table, columns or None)
        key = (database, table, column, upper)
        w = self._window
        if w and w[0] == key and (w[1] is None or (lower is not None and (lower > w[1] or (lower == w[1] and (w[2] or not lower_inclusive))))):
            window = w[3]
        else:
            # the records in [lower, upper], sorted by the cursor: later batches of the same sync
            # (with higher lower bounds) slice it; the lower bound is pushed down to the source
            pairs = self._safe(lambda: list(self._scan_range(database, table, col, lower, lower_inclusive, upper)), "Reading new rows failed")
            window = sorted(pairs, key=lambda p: p[0])
            self._window = (key, lower, lower_inclusive, window) if len(window) <= CACHE_ROWS else None
        out = []
        for v, r in window:
            if lower is not None and (v < lower or (v == lower and not lower_inclusive)):
                continue
            out.append(self._row(r, cols))
            if limit and len(out) >= limit:
                break
        return out

    def stream_table(self, database: str, schema: str, table: str, columns: list[str], batch_size: int) -> Iterator[list[tuple]]:
        cols = self._cols(database, table, columns or None)
        pending: list[tuple] = []
        try:
            for batch in self._records(database, table):
                pending.extend(self._row(r, cols) for r in batch)
                while len(pending) >= batch_size:
                    yield pending[:batch_size]
                    pending = pending[batch_size:]
            if pending:
                yield pending
        except ConnectorError:
            raise
        except Exception as e:
            raise self.error(e, "Reading the table failed") from None
