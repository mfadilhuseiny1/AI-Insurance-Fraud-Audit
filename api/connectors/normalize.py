"""Driver values → the pipeline's normalized forms: JSON cells for previews, Arrow for Parquet.

A connector's columns carry the pipeline type (`type`, one of base.COL_TYPES); every value of a
column is converted to that type here, so all databases produce the same batches.
"""

from __future__ import annotations

import base64
import json
import math
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import pyarrow as pa

ARROW: dict[str, pa.DataType] = {
    "String": pa.string(),
    "Boolean": pa.bool_(),
    "Byte": pa.int8(),
    "Short": pa.int16(),
    "Integer": pa.int32(),
    "Long": pa.int64(),
    "Float": pa.float32(),
    "Double": pa.float64(),
    "Decimal": pa.decimal128(38, 18),
    "Date": pa.date32(),
    "Timestamp": pa.timestamp("us", tz="UTC"),
    "Binary": pa.binary(),
}
_DECIMAL_STEP = Decimal(1).scaleb(-18)


def _text(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(v)).decode()
    if isinstance(v, (dict, list, tuple)):
        return json.dumps(v, default=str, ensure_ascii=False)
    if isinstance(v, datetime):
        return _utc(v).isoformat().replace("+00:00", "Z")
    if isinstance(v, (date, time, uuid.UUID, Decimal, timedelta)):
        return str(v)
    return str(v)


def _utc(v: datetime) -> datetime:
    """Naive date-times are taken as UTC (sessions run in UTC)."""
    return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)


def arrow_value(v: Any, kind: str) -> Any:
    """A driver value as the Python value pyarrow expects for the column type (None if it does not fit)."""
    if v is None:
        return None
    try:
        if kind == "String":
            return _text(v)
        if kind == "Boolean":
            return bool(v)
        if kind in ("Byte", "Short", "Integer", "Long"):
            return int(v)
        if kind in ("Float", "Double"):
            f = float(v)
            return f if math.isfinite(f) or kind == "Double" else None
        if kind == "Decimal":
            d = v if isinstance(v, Decimal) else Decimal(str(v))
            return d.quantize(_DECIMAL_STEP) if d.is_finite() else None
        if kind == "Date":
            return v.date() if isinstance(v, datetime) else v if isinstance(v, date) else date.fromisoformat(str(v)[:10])
        if kind == "Timestamp":
            if isinstance(v, datetime):
                return _utc(v)
            if isinstance(v, date):
                return datetime(v.year, v.month, v.day, tzinfo=timezone.utc)
            return _utc(datetime.fromisoformat(str(v).replace("Z", "+00:00")))
        if kind == "Binary":
            return bytes(v) if isinstance(v, (bytes, bytearray, memoryview)) else str(v).encode()
    except (ValueError, TypeError, InvalidOperation, OverflowError):
        return None
    return _text(v)


def arrow_schema(columns: list[dict]) -> pa.Schema:
    return pa.schema([pa.field(c["name"], ARROW[c["type"]]) for c in columns])


def arrow_batch(columns: list[dict], rows: list[tuple], schema: Optional[pa.Schema] = None) -> pa.Table:
    schema = schema or arrow_schema(columns)
    arrays = []
    for i, c in enumerate(columns):
        arrays.append(pa.array([arrow_value(r[i], c["type"]) for r in rows], type=ARROW[c["type"]]))
    return pa.Table.from_arrays(arrays, schema=schema)


def json_value(v: Any, kind: str) -> Any:
    """A driver value as a pipeline cell (what the browser shows and the pipeline evaluates)."""
    a = arrow_value(v, kind)
    if a is None:
        return None
    if kind == "Timestamp":
        return a.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if kind == "Date":
        return a.isoformat()
    if kind == "Decimal":
        return float(a)
    if kind == "Binary":
        return base64.b64encode(a).decode()
    if kind == "Long" and not -(2**53) <= a <= 2**53:
        return float(a)
    if kind in ("Float", "Double") and not math.isfinite(a):
        return None
    return a


def json_rows(columns: list[dict], rows: list[tuple]) -> list[dict]:
    return [{c["name"]: json_value(r[i], c["type"]) for i, c in enumerate(columns)} for r in rows]


# --------------------------------------------------------------------------------------------
# cursor values: stored as JSON between runs, bound as parameters
# --------------------------------------------------------------------------------------------


def cursor_dump(v: Any) -> Optional[dict]:
    """A cursor value as JSON, keeping what is needed to bind it back exactly."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return {"kind": "timestamp", "value": v.isoformat(), "tz": v.tzinfo is not None}
    if isinstance(v, date):
        return {"kind": "date", "value": v.isoformat()}
    if isinstance(v, Decimal):
        return {"kind": "decimal", "value": str(v)}
    if isinstance(v, bool):
        raise ValueError("a boolean cannot be a cursor")
    if isinstance(v, int):
        return {"kind": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"kind": "float", "value": repr(v)}
    if type(v).__name__ == "ObjectId":  # MongoDB _id: grows with insertion time
        return {"kind": "objectid", "value": str(v)}
    raise ValueError(f"unsupported cursor value {type(v).__name__}")


def cursor_load(d: Optional[dict]) -> Any:
    if not d:
        return None
    kind, value = d["kind"], d["value"]
    if kind == "timestamp":
        t = datetime.fromisoformat(value)
        if d.get("tz") and t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        if not d.get("tz") and t.tzinfo is not None:
            t = t.astimezone(timezone.utc).replace(tzinfo=None)
        return t
    if kind == "date":
        return date.fromisoformat(value)
    if kind == "decimal":
        return Decimal(value)
    if kind == "integer":
        return int(value)
    if kind == "objectid":
        from bson import ObjectId

        return ObjectId(value)
    return float(value)


def cursor_text(d: Optional[dict]) -> Optional[str]:
    """How a cursor value is shown."""
    if not d:
        return None
    if d["kind"] == "timestamp":
        t = datetime.fromisoformat(d["value"])
        return (t.astimezone(timezone.utc) if t.tzinfo else t).strftime("%Y-%m-%d %H:%M:%S") + (" UTC" if d.get("tz") else "")
    return d["value"]


def comparable(*values: Any) -> list[Any]:
    """Date-times made comparable: when naive and aware ones are mixed, naive ones are taken as UTC."""
    times = [v for v in values if isinstance(v, datetime)]
    if times and any(t.tzinfo for t in times) and not all(t.tzinfo for t in times):
        return [_utc(v) if isinstance(v, datetime) else v for v in values]
    return list(values)


def parse_start(text: str, column_type: str, tz_aware: bool) -> Any:
    """The user's "Start from" value as a cursor value of the column's type."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        if column_type == "ObjectId":
            from bson import ObjectId

            return ObjectId(text)
        if column_type == "Timestamp":
            t = datetime.fromisoformat(text.replace("Z", "+00:00").replace("/", "-"))
            if tz_aware:
                return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t
            return t.astimezone(timezone.utc).replace(tzinfo=None) if t.tzinfo else t
        if column_type == "Date":
            return date.fromisoformat(text[:10])
        if column_type == "Decimal":
            return Decimal(text)
        return int(text)
    except (ValueError, InvalidOperation) as e:
        raise ValueError(f'"{text}" is not a valid {column_type.lower()} for this column') from e
