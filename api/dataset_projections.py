"""Dataset projections: optimized copies of a dataset for faster reads, like Foundry's dataset projections.

A projection is stored and updated independently from the dataset (the canonical data is never changed) and
supports one query pattern:

  filter  a Parquet copy sorted by an ordered list of columns, written in small row groups with min/max
          statistics. Equality or range filters on a PREFIX of the columns only read the row groups whose
          statistics can match (row-group pruning), instead of the whole dataset.
  join    the same sorted copy plus a SQLite hash index {key of the columns -> (row group, offset)}, so a
          lookup by an exact key (all the columns, as for a join or a primary-key lookup) reads only the row
          groups that hold the key.

Every new transaction of the dataset (dataset_versions.record) rebuilds its projections in the background
("compaction": one copy, however many transactions). Status: building | up_to_date (built from the current
transaction) | stale (built from an older one) | failed (e.g. a projected column is gone: projections do not
support schema evolution). A stale projection is not used for reads: our transactions are full copies, so
there is nothing to combine it with; reads fall back to the dataset until the rebuild finishes.

Keys in the join index compare as text: dates/timestamps as ISO 8601, integral floats as integers.

Files: data/lineage/projections/<item id>/ (index.json, <projection id>.parquet, <projection id>.sqlite).
API (mounted under /api/pipeline by pipeline_datasets.py):
  GET    /datasets/{id}/projections                list with status and size
  POST   /datasets/{id}/projections                {name?, kind: filter|join, columns: [...]}
  DELETE /datasets/{id}/projections/{pid}
  POST   /datasets/{id}/projections/{pid}/build    rebuild now
  POST   /datasets/{id}/projections/{pid}/query    {eq: {col: value}, range: {col: {gt|gte|lt|lte: value}}, limit}
  POST   /datasets/{id}/query                      same body; picks the best up-to-date projection itself
"""

from __future__ import annotations

import base64
import io
import json
import logging
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import dataset_versions

log = logging.getLogger(__name__)
router = APIRouter()

ROW_GROUP = 4096  # rows per row group: smaller = finer pruning, larger = less overhead
MAX_LIMIT = 1000
_lock = threading.RLock()
_building: dict[str, bool] = {}  # "<item>/<projection>" -> rebuild requested while building


def _root() -> Path:
    return dataset_versions.DIR.parent / "projections"


def _folder(item_id: str) -> Path:
    if not item_id.isalnum():
        raise ValueError("bad dataset id")
    return _root() / item_id


def _load(item_id: str) -> list[dict]:
    try:
        return json.loads((_folder(item_id) / "index.json").read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return []


def _store(item_id: str, projs: list[dict]) -> None:
    f = _folder(item_id)
    f.mkdir(parents=True, exist_ok=True)
    tmp = f / f"index.{uuid.uuid4().hex[:8]}.tmp"  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(projs, ensure_ascii=False), "utf-8")
    tmp.replace(f / "index.json")


def _update(item_id: str, pid: str, **fields: Any) -> Optional[dict]:
    with _lock:
        projs = _load(item_id)
        p = next((p for p in projs if p["id"] == pid), None)
        if p is None:
            return None
        p.update(fields)
        _store(item_id, projs)
        return p


# ---------------------------------------------------------------- the dataset's current data

def _current(item_id: str) -> tuple[Optional[str], Optional[bytes]]:
    """(version key, Parquet bytes) of the dataset's current view: its newest transaction's copy, else the
    live Drive file (datasets written before transactions were kept)."""
    tx = dataset_versions.current(item_id)
    if tx and tx.get("kept"):
        data = dataset_versions.data(item_id, tx["id"])
        if data is not None:
            return tx["id"], data
    try:
        import db
        import drive
        item = db.drive_get(item_id)
        if item and item["kind"] == "file" and not item.get("trashed_at"):
            return (tx["id"] if tx else f"live-{item.get('updated_at')}-{item.get('size_bytes')}"), drive.read_bytes(item)
    except Exception:  # noqa: BLE001
        pass
    return (tx["id"] if tx else None), None


def _version(item_id: str) -> Optional[str]:
    tx = dataset_versions.current(item_id)
    if tx:
        return tx["id"]
    try:
        import db
        item = db.drive_get(item_id)
        return f"live-{item.get('updated_at')}-{item.get('size_bytes')}" if item else None
    except Exception:  # noqa: BLE001
        return None


def _status(p: dict, version: Optional[str]) -> str:
    if p.get("building"):
        return "building"
    if p.get("error"):
        return "failed"
    if not p.get("built_from"):
        return "stale"
    return "up_to_date" if p["built_from"] == version else "stale"


def projections(item_id: str) -> list[dict]:
    version = _version(item_id)
    return [{**p, "status": _status(p, version), "current_version": version} for p in _load(item_id)]


# ---------------------------------------------------------------- build

def _key(v: Any) -> str:
    if v is None:
        return "\x00"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    return str(v)


def _row_key(values: list[Any]) -> str:
    return "\x1f".join(_key(v) for v in values)


def build(item_id: str, pid: str) -> Optional[dict]:
    """(Re)build one projection from the dataset's current data. Runs in the caller's thread."""
    p = next((p for p in _load(item_id) if p["id"] == pid), None)
    if p is None:
        return None
    _update(item_id, pid, building=True)
    started = time.monotonic()
    folder = _folder(item_id)
    try:
        version, data = _current(item_id)
        if data is None:
            raise ValueError("the dataset has no readable data")
        table = pq.read_table(io.BytesIO(data))
        missing = [c for c in p["columns"] if c not in table.column_names]
        if missing:
            raise ValueError(f"column(s) {', '.join(missing)} no longer exist (projections do not support schema evolution)")
        table = table.sort_by([(c, "ascending") for c in p["columns"]])
        tmp = folder / f"{pid}.parquet.tmp"
        pq.write_table(table, tmp, row_group_size=ROW_GROUP, compression="snappy", write_statistics=True)
        tmp.replace(folder / f"{pid}.parquet")
        size = (folder / f"{pid}.parquet").stat().st_size
        if p["kind"] == "join":
            tmp_db = folder / f"{pid}.sqlite.tmp"
            tmp_db.unlink(missing_ok=True)
            con = sqlite3.connect(tmp_db)
            try:
                con.execute("CREATE TABLE idx (k TEXT NOT NULL, rg INTEGER NOT NULL, off INTEGER NOT NULL)")
                cols = [table.column(c).to_pylist() for c in p["columns"]]
                rows = ((_row_key([c[i] for c in cols]), i // ROW_GROUP, i % ROW_GROUP) for i in range(table.num_rows))
                con.executemany("INSERT INTO idx VALUES (?, ?, ?)", rows)
                con.execute("CREATE INDEX idx_k ON idx (k)")
                con.commit()
            finally:
                con.close()
            tmp_db.replace(folder / f"{pid}.sqlite")
            size += (folder / f"{pid}.sqlite").stat().st_size
        return _update(item_id, pid, building=False, error=None, built_from=version, rows=table.num_rows, size=size,
                       row_groups=pq.ParquetFile(folder / f"{pid}.parquet").num_row_groups,
                       built_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       build_ms=round((time.monotonic() - started) * 1000))
    except Exception as e:  # noqa: BLE001
        log.warning("projection %s/%s failed: %s", item_id, pid, e)
        return _update(item_id, pid, building=False, error=str(e))


def _build_async(item_id: str, pid: str) -> None:
    """Rebuild in a background thread; a request during a build queues one more build afterwards."""
    key = f"{item_id}/{pid}"
    with _lock:
        if key in _building:
            _building[key] = True
            return
        _building[key] = False

    def run() -> None:
        while True:
            build(item_id, pid)
            with _lock:
                if not _building.get(key):
                    _building.pop(key, None)
                    return
                _building[key] = False

    threading.Thread(target=run, name=f"projection-{pid}", daemon=True).start()


def on_transaction(item_id: str, tx_id: str) -> None:
    """Called by dataset_versions.record after every new transaction: rebuild the dataset's projections."""
    for p in _load(item_id):
        _build_async(item_id, p["id"])


def refresh_all() -> int:
    """Rebuild every stale or interrupted projection (startup and the periodic retention run)."""
    n = 0
    root = _root()
    if not root.exists():
        return 0
    for d in root.iterdir():
        if not d.is_dir() or not d.name.isalnum():
            continue
        for p in projections(d.name):
            if p["status"] in ("stale", "building") and f"{d.name}/{p['id']}" not in _building:
                if p.get("building"):
                    _update(d.name, p["id"], building=False)
                _build_async(d.name, p["id"])
                n += 1
    return n


# ---------------------------------------------------------------- query

def _scalar(v: Any, typ: pa.DataType) -> pa.Scalar:
    """A JSON value as a scalar of the column's type."""
    if v is None:
        return pa.scalar(None, typ)
    try:
        return pa.scalar(v).cast(typ)
    except (pa.ArrowException, ValueError, TypeError):
        pass
    if isinstance(v, str) and (pa.types.is_timestamp(typ) or pa.types.is_date(typ)):
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if pa.types.is_date(typ):
            return pa.scalar(d.date(), typ)
        if typ.tz and d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        if not typ.tz and d.tzinfo is not None:
            d = d.astimezone(timezone.utc).replace(tzinfo=None)
        return pa.scalar(d, typ)
    raise HTTPException(400, f"{v!r} is not a valid {typ} value")


OPS = {"eq": pc.equal, "gt": pc.greater, "gte": pc.greater_equal, "lt": pc.less, "lte": pc.less_equal}


def _predicates(schema: pa.Schema, eq: dict[str, Any], rng: dict[str, dict[str, Any]]) -> list[tuple[str, str, pa.Scalar]]:
    preds = []
    for col, v in eq.items():
        if col not in schema.names:
            raise HTTPException(400, f"unknown column {col}")
        preds.append((col, "eq", _scalar(v, schema.field(col).type)))
    for col, bounds in rng.items():
        if col not in schema.names:
            raise HTTPException(400, f"unknown column {col}")
        for op, v in bounds.items():
            if op not in OPS or op == "eq":
                raise HTTPException(400, f"unknown range operator {op} (gt, gte, lt, lte)")
            preds.append((col, op, _scalar(v, schema.field(col).type)))
    return preds


def _filter(table: pa.Table, preds: list[tuple[str, str, pa.Scalar]]) -> pa.Table:
    if not preds:
        return table
    mask = None
    for col, op, s in preds:
        m = pc.is_null(table[col]) if s.as_py() is None and op == "eq" else OPS[op](table[col], s)
        mask = m if mask is None else pc.and_(mask, m)
    return table.filter(pc.fill_null(mask, False))


def _may_match(stats: Any, op: str, v: Any) -> bool:
    """Whether a row group with these min/max statistics can hold a row matching `col op v`."""
    if stats is None or not stats.has_min_max or v is None:
        return True
    try:
        lo, hi = stats.min, stats.max
        return {"eq": lo <= v <= hi, "gt": hi > v, "gte": hi >= v, "lt": lo < v, "lte": lo <= v}[op]
    except Exception:  # noqa: BLE001 - values that do not compare (e.g. mixed tz): read the row group
        return True


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    if isinstance(v, float) and v != v:
        return None
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


def _payload(table: pa.Table, limit: int) -> dict:
    out = table.slice(0, limit)
    return {"columns": [{"name": f.name, "type": str(f.type)} for f in table.schema],
            "rows": [{k: _jsonable(v) for k, v in r.items()} for r in out.to_pylist()],
            "matched": table.num_rows}


def _query_projection(item_id: str, p: dict, eq: dict, rng: dict, limit: int) -> dict:
    folder = _folder(item_id)
    f = pq.ParquetFile(folder / f"{p['id']}.parquet")
    schema = f.schema_arrow
    preds = _predicates(schema, eq, rng)
    total = f.num_row_groups
    if p["kind"] == "join" and not rng and set(eq) == set(p["columns"]):
        con = sqlite3.connect(folder / f"{p['id']}.sqlite")
        try:
            key = _row_key([_scalar(eq[c], schema.field(c).type).as_py() for c in p["columns"]])
            hits = con.execute("SELECT rg, off FROM idx WHERE k = ? ORDER BY rg, off", (key,)).fetchall()
        finally:
            con.close()
        groups = sorted({rg for rg, _ in hits})
        parts = []
        for rg in groups:
            t = f.read_row_group(rg)
            parts.append(t.take([off for g, off in hits if g == rg]))
        table = pa.concat_tables(parts) if parts else schema.empty_table()
        return {**_payload(_filter(table, preds), limit), "source": "projection", "method": "hash index",
                "row_groups_read": len(groups), "row_groups": total}
    idx = {name: i for i, name in enumerate(schema.names)}
    groups = []
    for rg in range(total):
        md = f.metadata.row_group(rg)
        if all(_may_match(md.column(idx[col]).statistics, op, s.as_py()) for col, op, s in preds):
            groups.append(rg)
    table = f.read_row_groups(groups) if groups else schema.empty_table()
    return {**_payload(_filter(table, preds), limit), "source": "projection", "method": "row-group pruning",
            "row_groups_read": len(groups), "row_groups": total}


def _query_dataset(item_id: str, eq: dict, rng: dict, limit: int) -> dict:
    _, data = _current(item_id)
    if data is None:
        raise HTTPException(404, "the dataset has no readable data")
    table = pq.read_table(io.BytesIO(data))
    return {**_payload(_filter(table, _predicates(table.schema, eq, rng)), limit), "source": "dataset", "method": "full scan"}


def _usable(p: dict, eq: dict, rng: dict) -> int:
    """How well a projection serves a query: 0 = not at all. Join: exact key on all its columns. Filter:
    a filter on a prefix of its columns (the longer, the better)."""
    if p["status"] != "up_to_date":
        return 0
    if p["kind"] == "join" and not rng and set(eq) == set(p["columns"]):
        return 1000
    n = 0
    for c in p["columns"]:
        if c in eq:
            n += 1
            continue
        if c in rng:
            n += 1
        break
    return n


def query(item_id: str, eq: dict, rng: dict, limit: int = 100, pid: Optional[str] = None) -> dict:
    """Rows of the dataset matching the filters, read through a projection when one serves the query."""
    started = time.monotonic()
    limit = max(1, min(limit, MAX_LIMIT))
    projs = projections(item_id)
    if pid is not None:
        p = next((p for p in projs if p["id"] == pid), None)
        if p is None:
            raise HTTPException(404, "projection not found")
        candidates = [p] if p["status"] == "up_to_date" else []
        reason = None if candidates else f"projection is {p['status']}"
    else:
        ranked = sorted(((_usable(p, eq, rng), p) for p in projs), key=lambda x: -x[0])
        candidates = [p for score, p in ranked if score > 0][:1]
        reason = None if candidates else "no up-to-date projection serves this filter"
    res = None
    if candidates:
        try:
            res = {**_query_projection(item_id, candidates[0], eq, rng, limit), "projection": candidates[0]["id"]}
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001 - e.g. files removed: the dataset still answers
            reason = f"projection unreadable: {e}"
    if res is None:
        res = {**_query_dataset(item_id, eq, rng, limit), "fallback_reason": reason}
    res["ms"] = round((time.monotonic() - started) * 1000, 2)
    return res


# ---------------------------------------------------------------- API

class NewProjection(BaseModel):
    name: Optional[str] = None
    kind: Literal["filter", "join"] = "filter"
    columns: list[str] = Field(min_length=1, max_length=8)


class Query(BaseModel):
    eq: dict[str, Any] = {}
    range: dict[str, dict[str, Any]] = {}
    limit: int = 100


def _check(item_id: str) -> None:
    if not item_id.isalnum():
        raise HTTPException(400, "bad dataset id")


@router.get("/datasets/{item_id}/projections")
def list_projections(item_id: str) -> list[dict]:
    _check(item_id)
    return projections(item_id)


@router.post("/datasets/{item_id}/projections")
def create_projection(item_id: str, req: NewProjection) -> dict:
    _check(item_id)
    _, data = _current(item_id)
    if data is None:
        raise HTTPException(404, "the dataset has no readable data")
    try:
        names = pq.ParquetFile(io.BytesIO(data)).schema_arrow.names
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"not a readable Parquet dataset: {e}") from e
    missing = [c for c in req.columns if c not in names]
    if missing or len(set(req.columns)) != len(req.columns):
        raise HTTPException(400, f"unknown or repeated column(s): {', '.join(missing) or 'repeated'}")
    p = {"id": uuid.uuid4().hex[:10], "name": (req.name or "").strip() or f"{req.kind}: {', '.join(req.columns)}",
         "kind": req.kind, "columns": req.columns, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
         "built_from": None, "size": 0, "rows": None, "error": None, "building": True}
    with _lock:
        _folder(item_id).mkdir(parents=True, exist_ok=True)
        _store(item_id, [*_load(item_id), p])
    _build_async(item_id, p["id"])
    return next(x for x in projections(item_id) if x["id"] == p["id"])


@router.delete("/datasets/{item_id}/projections/{pid}")
def delete_projection(item_id: str, pid: str) -> dict:
    _check(item_id)
    if not pid.isalnum():
        raise HTTPException(400, "bad projection id")
    with _lock:
        projs = _load(item_id)
        if not any(p["id"] == pid for p in projs):
            raise HTTPException(404, "projection not found")
        _store(item_id, [p for p in projs if p["id"] != pid])
    for suffix in (".parquet", ".sqlite", ".parquet.tmp", ".sqlite.tmp"):
        (_folder(item_id) / f"{pid}{suffix}").unlink(missing_ok=True)
    return {"ok": True}


@router.post("/datasets/{item_id}/projections/{pid}/build")
def rebuild_projection(item_id: str, pid: str) -> dict:
    _check(item_id)
    if not any(p["id"] == pid for p in _load(item_id)):
        raise HTTPException(404, "projection not found")
    _update(item_id, pid, building=True)
    _build_async(item_id, pid)
    return next(x for x in projections(item_id) if x["id"] == pid)


@router.post("/datasets/{item_id}/projections/{pid}/query")
def query_projection(item_id: str, pid: str, req: Query) -> dict:
    _check(item_id)
    return query(item_id, req.eq, req.range, req.limit, pid)


@router.post("/datasets/{item_id}/query")
def query_dataset(item_id: str, req: Query) -> dict:
    _check(item_id)
    return query(item_id, req.eq, req.range, req.limit)


def remove_dataset(item_id: str) -> None:
    """Drop every projection of a dataset (e.g. when it is deleted for good)."""
    shutil.rmtree(_folder(item_id), ignore_errors=True)
