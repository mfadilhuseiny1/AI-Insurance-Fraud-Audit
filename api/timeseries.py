"""Time series and geotemporal series syncs: where Pipeline Builder's time series and geotemporal outputs land,
following Foundry's stream monitoring guide ("Configuring output monitors": time series and geotemporal
series are the data formats output monitors watch). Its own store (data/timeseries/timeseries.sqlite):

Time series syncs
  A pipeline output of kind "time series sync" writes (series id, timestamp, value) points here — the
  Time Series DB — on every batch build and, in a streaming pipeline, for every micro-batch. The Time
  Series Catalog (/time-series) lists the syncs, their series and points.

Geotemporal series syncs
  An output of kind "geotemporal series sync" sends observations (series id, timestamp, latitude,
  longitude, extra properties). Observations without a series id, a timestamp or a valid position are
  kept in the sync's errors (as Foundry's errors dataset) instead. The Map app (/map) plots the tracks.

Output monitors (Data Health → Monitoring views, streaming.py)
  `points_written` on a time series sync and `geotemporal_observations_sent` on a geotemporal sync:
  points / observations written in the last 5 or 30 minutes at or below the threshold. Counts per
  minute are kept in `writes` (also the monitor's metrics). `Geotemporal observations sent` counts what
  this ingest sent, not what a downstream reader processed.

Each sync keeps up to BLUESANDAI_TS_MAX_POINTS points or observations (default 1,000,000); older ones
are dropped first. A batch build that snapshots its output replaces the sync's points.

Syncs made in the Time Series Catalog (Palantir's "Time series syncs": New time series sync)
  Backed by a Files dataset (Parquet): its series ID, timestamp (Timestamp, or Long in seconds / milliseconds /
  microseconds / nanoseconds) and value (number or text: a categorical series) columns are mapped, previewed and
  built into the Time Series DB. Advanced settings: build when the input dataset updates (default on; checked every
  minute), optimized sync builds (series IDs need not be unique across syncs), index view dataset inputs, overwrite
  the series of other syncs (those syncs fail and should be trashed), Spark profiles. A sync inherits the markings
  of its input dataset ("timeseries_sync:<id>"); a pipeline's sync those of its backing dataset. Syncs a pipeline
  writes keep the pipeline's mapping (a deploy overrides edits made here).

Demo data (timeseries_demo.py): POST /api/timeseries/demo creates live demo syncs (ships in Jakarta Bay, trucks in
Jakarta, vessel speeds and port sensors) and output monitors; DELETE /api/timeseries/demo removes them.

Mounted by server.py under /api/timeseries.
"""

from __future__ import annotations

import io
import json
import logging
import math
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/timeseries")
log = logging.getLogger("bluesandai.timeseries")
SYNC_RID = "ri.time-series-catalog.main.sync."
TS_UNITS = {"SECONDS": 1000, "MILLISECONDS": 1, "MICROSECONDS": 1e-3, "NANOSECONDS": 1e-6}
REBUILD_TICK = 60  # seconds between checks for updated input datasets

DB_PATH: Optional[Path] = None
_lock = threading.RLock()
MAX_POINTS = int(os.environ.get("BLUESANDAI_TS_MAX_POINTS") or 1_000_000)
MAX_ERRORS = 10_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS syncs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, natural_key TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS points (sync_id TEXT NOT NULL, series_id TEXT NOT NULL, ts TEXT NOT NULL, value REAL, value_text TEXT);
CREATE INDEX IF NOT EXISTS points_series ON points (sync_id, series_id, ts);
CREATE TABLE IF NOT EXISTS observations (sync_id TEXT NOT NULL, series_id TEXT NOT NULL, ts TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    props TEXT);
CREATE INDEX IF NOT EXISTS observations_series ON observations (sync_id, series_id, ts);
CREATE INDEX IF NOT EXISTS observations_ts ON observations (sync_id, ts);
CREATE TABLE IF NOT EXISTS errors (sync_id TEXT NOT NULL, at TEXT NOT NULL, error TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS errors_sync ON errors (sync_id, at);
CREATE TABLE IF NOT EXISTS writes (sync_id TEXT NOT NULL, minute TEXT NOT NULL, points INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
    PRIMARY KEY (sync_id, minute));
CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, resource TEXT NOT NULL, queries INTEGER DEFAULT 0, points INTEGER DEFAULT 0,
    compute REAL DEFAULT 0, PRIMARY KEY (day, resource));
CREATE TABLE IF NOT EXISTS catalog_marks (user_id TEXT NOT NULL, kind TEXT NOT NULL, rid TEXT NOT NULL, favorite INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0, last_viewed TEXT, PRIMARY KEY (user_id, kind, rid));
"""

KIND_LABEL = {"timeseries": "Time series sync", "geotemporal": "Geotemporal series sync"}


def configure(data_dir: Path) -> None:
    global DB_PATH
    folder = data_dir / "timeseries"
    folder.mkdir(parents=True, exist_ok=True)
    DB_PATH = folder / "timeseries.sqlite"
    with _db() as con:
        con.executescript(SCHEMA)


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    if DB_PATH is None:
        raise HTTPException(503, "Time series are not configured")
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="milliseconds")


def _minute(t: Optional[datetime] = None) -> str:
    return (t or _now()).strftime("%Y-%m-%dT%H:%M")


def timestamp(v: Any) -> Optional[str]:
    """A point's time as an ISO UTC string (sortable as text): ISO strings, dates, or epoch seconds / milliseconds."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            return None
        secs = v / 1000 if abs(v) >= 1e11 else v
        try:
            return _iso(datetime.fromtimestamp(secs, timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(v, datetime):
        t = v
    elif isinstance(v, date):
        t = datetime(v.year, v.month, v.day)
    else:
        s = str(v).strip()
        try:
            return timestamp(float(s)) if s.replace(".", "", 1).lstrip("-").isdigit() else timestamp(datetime.fromisoformat(s.replace("Z", "+00:00")))
        except ValueError:
            return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return _iso(t.astimezone(timezone.utc))


def _number(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# --------------------------------------------------------------------------------------------
# syncs
# --------------------------------------------------------------------------------------------


class SyncIn(BaseModel):
    kind: Literal["timeseries", "geotemporal"]
    name: str
    pipeline_id: str = ""
    pipeline_name: str = ""
    output_id: str = ""
    # batch builds or a streaming job
    mode: Literal["batch", "streaming"] = "batch"
    # the output's column mapping (series id, timestamp, value / latitude, longitude, properties)
    mapping: dict[str, Any] = Field(default_factory=dict)
    backing_dataset: Optional[str] = None
    stream_id: Optional[str] = None


def _sync(sync_id: str) -> dict:
    sync_id = sync_id[len(SYNC_RID):] if sync_id.startswith(SYNC_RID) else sync_id
    with _db() as con:
        row = con.execute("SELECT record FROM syncs WHERE id = ?", (sync_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Time series sync not found")
    rec = json.loads(row[0])
    rec.setdefault("rid", SYNC_RID + rec["id"])
    rec.setdefault("source", "demo" if rec.get("pipeline_id") == "demo" else "pipeline" if rec.get("pipeline_id") else "catalog")
    return rec


def sync_id_of(ref: str) -> str:
    """A sync id from its id or RID (ri.time-series-catalog.main.sync.<id>)."""
    ref = str(ref or "").strip()
    return ref[len(SYNC_RID):] if ref.startswith(SYNC_RID) else ref


def check_sync(sync_id: str) -> dict:
    """The sync, when the caller holds its markings (inherited from its input dataset)."""
    import auth

    rec = _sync(sync_id)
    auth.check_resource("timeseries_sync", rec["id"])
    return rec


def _as_build(request: Optional[Request], op: str, rec: Optional[dict]) -> None:
    """The build runner reading or writing a sync for a build (X-Bsai-Build): as the build's identity — the sync's
    markings (inherited from its dataset) and, for a pipeline's sync, Editor on the pipeline to write it; refused with
    the reason."""
    import build_calls

    if rec is None or build_calls.build_of(request) is None:
        return
    pid = rec.get("pipeline_id")
    build_calls.enforce(request, (op, "resource:timeseries_sync", rec["id"], None),
                        ("write", "pipeline", pid, None) if op == "write" and pid and pid != "demo" else None)


def _inherit_markings(rec: dict, keep: bool = False) -> None:
    """A sync inherits every marking of its input dataset (a catalog sync) or backing dataset (a pipeline's). Called
    before a new sync's record is inserted, so it is never listed or read unmarked; `keep` adds to the markings it
    inherited so far (before its record changes; narrowed by a call without it after)."""
    item = rec.get("dataset_id") or rec.get("backing_dataset")
    if not item:
        return
    try:
        import auth

        rid = f"timeseries_sync:{rec['id']}"
        marks = set(auth.effective_markings(item)) | (set(auth._item_row(rid)[1]) if keep else set())
        auth._set_item(rid, inherited=sorted(marks))
    except Exception:  # noqa: BLE001 - sign-in off / no auth store: nothing to inherit
        pass


def _save(rec: dict) -> None:
    with _lock, _db() as con:
        con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), rec["id"]))


def resource_name(sync_id: str) -> str:
    try:
        return _sync(sync_id)["name"]
    except HTTPException:
        return "(deleted sync)"


def kind_of(sync_id: str) -> str:
    return _sync(sync_id)["kind"]


@router.post("/syncs/register")
def register(req: SyncIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Create or update the sync of a pipeline output (one per pipeline, output and output name: a branch or a run
    setup writes its own); writes then go to /syncs/{id}/write."""
    natural = json.dumps([req.kind, req.pipeline_id, req.output_id, req.name.strip()]) if req.pipeline_id else json.dumps([req.kind, uuid.uuid4().hex])
    import build_calls

    if build_calls.build_of(request) is not None:
        # a build registering its output's sync: an Editor of the pipeline, holding the markings of the dataset the
        # sync inherits from and of the sync it updates
        with _db() as con:
            row = con.execute("SELECT record FROM syncs WHERE natural_key = ?", (natural,)).fetchone()
        build_calls.enforce(request, ("write", "pipeline", req.pipeline_id, None) if req.pipeline_id else None,
                            ("read", "item", req.backing_dataset, None) if req.backing_dataset else None,
                            ("write", "resource:timeseries_sync", json.loads(row[0])["id"], None) if row else None)
    with _lock, _db() as con:
        row = con.execute("SELECT record FROM syncs WHERE natural_key = ?", (natural,)).fetchone()
        if row:
            rec = json.loads(row[0])
            rec.update({k: v for k, v in req.model_dump().items() if v not in (None, "")}, updated_at=_iso())
            _inherit_markings(rec, keep=True)  # a new backing dataset's markings before the record points at it
            con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), rec["id"]))
        else:
            rec = {"id": ("ts-" if req.kind == "timeseries" else "geo-") + uuid.uuid4().hex[:10], **req.model_dump(), "name": req.name.strip() or KIND_LABEL[req.kind],
                   "created_at": _iso(), "updated_at": _iso(), "points_total": 0, "errors_total": 0, "last_write_at": None}
            _inherit_markings(rec)  # marked before the record exists: never listed or read unmarked
            con.execute("INSERT INTO syncs (id, kind, natural_key, record) VALUES (?, ?, ?, ?)", (rec["id"], req.kind, natural, json.dumps(rec)))
    rec.setdefault("rid", SYNC_RID + rec["id"])
    _inherit_markings(rec)
    return rec


def _stats(con: sqlite3.Connection, rec: dict) -> dict:
    table = "points" if rec["kind"] == "timeseries" else "observations"
    n, series, first, last = con.execute(f"SELECT COUNT(*), COUNT(DISTINCT series_id), MIN(ts), MAX(ts) FROM {table} WHERE sync_id = ?", (rec["id"],)).fetchone()
    since = _minute(_now() - timedelta(minutes=5))
    (recent,) = con.execute("SELECT COALESCE(SUM(points), 0) FROM writes WHERE sync_id = ? AND minute >= ?", (rec["id"], since)).fetchone()
    (errors,) = con.execute("SELECT COUNT(*) FROM errors WHERE sync_id = ?", (rec["id"],)).fetchone()
    return {**rec, "kind_label": KIND_LABEL[rec["kind"]], "stored": n, "series": series, "first_ts": first, "last_ts": last, "written_5m": recent, "errors": errors}


def all_syncs(kind: Optional[str] = None) -> list[dict]:
    with _db() as con:
        q = "SELECT record FROM syncs" + (" WHERE kind = ?" if kind else "")
        recs = [json.loads(r) for (r,) in con.execute(q, (kind,) if kind else ()).fetchall()]
    for r in recs:
        r.setdefault("rid", SYNC_RID + r["id"])
        r.setdefault("source", "demo" if r.get("pipeline_id") == "demo" else "pipeline" if r.get("pipeline_id") else "catalog")
    return recs


@router.get("/syncs")
def list_syncs(kind: Optional[Literal["timeseries", "geotemporal"]] = None, request: Request = None) -> list[dict]:  # type: ignore[assignment]
    import auth

    import build_calls

    recs = auth.visible_resources("timeseries_sync", all_syncs(kind))
    if build_calls.build_of(request) is not None:
        recs = [r for r in recs if build_calls.allowed(request, ("read", "resource:timeseries_sync", r["id"], None))]
    with _db() as con:
        out = [_stats(con, r) for r in recs]
    return sorted(out, key=lambda r: r.get("last_write_at") or r["created_at"], reverse=True)


@router.get("/syncs/{sync_id}")
def get_sync(sync_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    with _db() as con:
        return _stats(con, rec)


@router.delete("/syncs/{sync_id}")
def delete_sync(sync_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    rec = check_sync(sync_id)
    _as_build(request, "write", rec)
    sync_id = rec["id"]
    with _lock, _db() as con:
        for t in ("points", "observations", "errors", "writes"):
            con.execute(f"DELETE FROM {t} WHERE sync_id = ?", (sync_id,))
        con.execute("DELETE FROM syncs WHERE id = ?", (sync_id,))
    return {"deleted": sync_id}


# --------------------------------------------------------------------------------------------
# writes
# --------------------------------------------------------------------------------------------


class WriteIn(BaseModel):
    # time series: {series_id, timestamp, value}; geotemporal: {series_id, timestamp, latitude, longitude, ...properties}
    rows: list[dict[str, Any]] = Field(default_factory=list)
    # replace what the sync holds (a batch build that snapshots its output)
    snapshot: bool = False


def _point(r: dict) -> tuple[Optional[tuple], Optional[str]]:
    sid, ts = r.get("series_id"), timestamp(r.get("timestamp"))
    if sid is None or str(sid) == "":
        return None, "no series id"
    if ts is None:
        return None, f"timestamp {r.get('timestamp')!r} is not a time"
    v = r.get("value")
    num = _number(v)
    text = None if v is None or num is not None else (json.dumps(v) if isinstance(v, (dict, list)) else str(v))
    return (str(sid), ts, num, text), None


def _observation(r: dict) -> tuple[Optional[tuple], Optional[str]]:
    sid, ts = r.get("series_id"), timestamp(r.get("timestamp"))
    lat, lon = _number(r.get("latitude")), _number(r.get("longitude"))
    if sid is None or str(sid) == "":
        return None, "no series id"
    if ts is None:
        return None, f"timestamp {r.get('timestamp')!r} is not a time"
    if lat is None or lon is None:
        return None, "no latitude / longitude"
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, f"position ({lat}, {lon}) is out of range"
    props = {k: v for k, v in r.items() if k not in ("series_id", "timestamp", "latitude", "longitude")}
    return (str(sid), ts, lat, lon, json.dumps(props, default=str) if props else None), None


def write(sync_id: str, rows: list[dict], snapshot: bool = False) -> dict:
    """Write points (time series) or send observations (geotemporal); invalid rows go to the sync's errors."""
    rec = _sync(sync_id)
    geo = rec["kind"] == "geotemporal"
    good, bad = [], []
    for r in rows:
        v, err = (_observation if geo else _point)(r)
        if v is None:
            bad.append((err, r))
        else:
            good.append(v)
    at = _iso()
    table = "observations" if geo else "points"
    with _lock, _db() as con:
        if snapshot:
            con.execute(f"DELETE FROM {table} WHERE sync_id = ?", (sync_id,))
        if geo:
            con.executemany("INSERT INTO observations (sync_id, series_id, ts, lat, lon, props) VALUES (?, ?, ?, ?, ?, ?)", [(sync_id, *g) for g in good])
        else:
            con.executemany("INSERT INTO points (sync_id, series_id, ts, value, value_text) VALUES (?, ?, ?, ?, ?)", [(sync_id, *g) for g in good])
        if bad:
            con.executemany("INSERT INTO errors (sync_id, at, error, record) VALUES (?, ?, ?, ?)", [(sync_id, at, e, json.dumps(r, default=str)) for e, r in bad])
        # a write of nothing still counts as a write (the monitor sees 0 for that minute, not a gap)
        con.execute("INSERT INTO writes (sync_id, minute, points, errors) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (sync_id, minute) DO UPDATE SET points = points + excluded.points, errors = errors + excluded.errors",
                    (sync_id, _minute(), len(good), len(bad)))
        (n,) = con.execute(f"SELECT COUNT(*) FROM {table} WHERE sync_id = ?", (sync_id,)).fetchone()
        if n > MAX_POINTS:
            con.execute(f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE sync_id = ? ORDER BY ts LIMIT ?)", (sync_id, n - MAX_POINTS))
        (ne,) = con.execute("SELECT COUNT(*) FROM errors WHERE sync_id = ?", (sync_id,)).fetchone()
        if ne > MAX_ERRORS:
            con.execute("DELETE FROM errors WHERE rowid IN (SELECT rowid FROM errors WHERE sync_id = ? ORDER BY at LIMIT ?)", (sync_id, ne - MAX_ERRORS))
        con.execute("DELETE FROM writes WHERE sync_id = ? AND minute < ?", (sync_id, _minute(_now() - timedelta(days=7))))
        rec = json.loads(con.execute("SELECT record FROM syncs WHERE id = ?", (sync_id,)).fetchone()[0])
        rec.update(points_total=(rec.get("points_total") or 0) + len(good), errors_total=(rec.get("errors_total") or 0) + len(bad), last_write_at=at)
        con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), sync_id))
    return {"written": len(good), "errors": len(bad), "error_samples": [e for e, _ in bad[:5]]}


@router.post("/syncs/{sync_id}/write")
def write_rows(sync_id: str, req: WriteIn, request: Request = None) -> dict:  # type: ignore[assignment]
    _as_build(request, "write", _sync(sync_id))
    return write(sync_id, req.rows, req.snapshot)


def written(sync_id: str, minutes: int) -> int:
    """Points / observations written in the last `minutes` (output monitors)."""
    _sync(sync_id)
    with _db() as con:
        (n,) = con.execute("SELECT COALESCE(SUM(points), 0) FROM writes WHERE sync_id = ? AND minute >= ?", (sync_id, _minute(_now() - timedelta(minutes=minutes)))).fetchone()
    return int(n)


@router.get("/syncs/{sync_id}/metrics")
def metrics(sync_id: str, minutes: int = 120, request: Request = None) -> list[dict]:  # type: ignore[assignment]
    """Points (or observations) written and rows rejected, per minute."""
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    sync_id = rec["id"]
    since = _minute(_now() - timedelta(minutes=max(5, min(minutes, 7 * 24 * 60))))
    with _db() as con:
        rows = con.execute("SELECT minute, points, errors FROM writes WHERE sync_id = ? AND minute >= ? ORDER BY minute", (sync_id, since)).fetchall()
    return [{"minute": m, "points": p, "errors": e} for m, p, e in rows]


# --------------------------------------------------------------------------------------------
# reads: Time Series Catalog and Map
# --------------------------------------------------------------------------------------------


@router.get("/syncs/{sync_id}/series")
def list_series(sync_id: str, q: str = "", limit: int = 500, request: Request = None) -> list[dict]:  # type: ignore[assignment]
    """The series of a sync: points, first and last time, and the latest value (time series) or position."""
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    sync_id = rec["id"]
    like = f"%{q}%"
    with _db() as con:
        if rec["kind"] == "timeseries":
            rows = con.execute(
                "SELECT series_id, COUNT(*), MIN(ts), MAX(ts), MIN(value), MAX(value), AVG(value) FROM points WHERE sync_id = ? AND series_id LIKE ? "
                "GROUP BY series_id ORDER BY series_id LIMIT ?", (sync_id, like, max(1, min(limit, 5000)))).fetchall()
            out = []
            for sid, n, first, last, lo, hi, avg in rows:
                v = con.execute("SELECT value, value_text FROM points WHERE sync_id = ? AND series_id = ? ORDER BY ts DESC LIMIT 1", (sync_id, sid)).fetchone()
                out.append({"series_id": sid, "points": n, "first_ts": first, "last_ts": last, "min": lo, "max": hi, "avg": avg,
                            "last_value": v[0] if v and v[0] is not None else (v[1] if v else None)})
            return out
        rows = con.execute("SELECT series_id, COUNT(*), MIN(ts), MAX(ts) FROM observations WHERE sync_id = ? AND series_id LIKE ? GROUP BY series_id ORDER BY series_id LIMIT ?",
                           (sync_id, like, max(1, min(limit, 5000)))).fetchall()
        out = []
        for sid, n, first, last in rows:
            lat, lon = con.execute("SELECT lat, lon FROM observations WHERE sync_id = ? AND series_id = ? ORDER BY ts DESC LIMIT 1", (sync_id, sid)).fetchone()
            out.append({"series_id": sid, "observations": n, "first_ts": first, "last_ts": last, "latitude": lat, "longitude": lon})
        return out


@router.get("/syncs/{sync_id}/series/{series_id}/points")
def series_points(sync_id: str, series_id: str, start: Optional[str] = None, end: Optional[str] = None, buckets: int = 500,
                  request: Request = None) -> dict:  # type: ignore[assignment]
    """Points of one series in [start, end]; more than `buckets` points are summarized per time bucket (avg, min, max)."""
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    sync_id = rec["id"]
    if rec["kind"] != "timeseries":
        raise HTTPException(400, "Not a time series sync")
    cond, args = "sync_id = ? AND series_id = ?", [sync_id, series_id]
    if start and timestamp(start):
        cond += " AND ts >= ?"
        args.append(timestamp(start))
    if end and timestamp(end):
        cond += " AND ts <= ?"
        args.append(timestamp(end))
    with _db() as con:
        rows = con.execute(f"SELECT ts, value, value_text FROM points WHERE {cond} ORDER BY ts LIMIT 200000", args).fetchall()
    buckets = max(10, min(buckets, 5000))
    if len(rows) <= buckets:
        return {"series_id": series_id, "total": len(rows), "bucketed": False,
                "points": [{"t": t, "value": v if v is not None else vt} for t, v, vt in rows]}
    t0 = datetime.fromisoformat(rows[0][0]).timestamp()
    t1 = datetime.fromisoformat(rows[-1][0]).timestamp()
    width = max((t1 - t0) / buckets, 1e-3)
    acc: dict[int, list[float]] = {}
    for t, v, _ in rows:
        if v is None:
            continue
        b = min(int((datetime.fromisoformat(t).timestamp() - t0) / width), buckets - 1)
        acc.setdefault(b, []).append(v)
    pts = [{"t": _iso(datetime.fromtimestamp(t0 + (b + 0.5) * width, timezone.utc)), "value": sum(vs) / len(vs), "min": min(vs), "max": max(vs), "n": len(vs)}
           for b, vs in sorted(acc.items())]
    return {"series_id": series_id, "total": len(rows), "bucketed": True, "points": pts}


@router.get("/syncs/{sync_id}/observations")
def observations(sync_id: str, start: Optional[str] = None, end: Optional[str] = None, series: Optional[str] = None, limit: int = 20000,
                 request: Request = None) -> dict:  # type: ignore[assignment]
    """Observations in [start, end] (optionally one series), oldest first: the tracks the Map draws."""
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    sync_id = rec["id"]
    if rec["kind"] != "geotemporal":
        raise HTTPException(400, "Not a geotemporal series sync")
    cond, args = "sync_id = ?", [sync_id]
    if series:
        cond += " AND series_id = ?"
        args.append(series)
    if start and timestamp(start):
        cond += " AND ts >= ?"
        args.append(timestamp(start))
    if end and timestamp(end):
        cond += " AND ts <= ?"
        args.append(timestamp(end))
    limit = max(1, min(limit, 200000))
    with _db() as con:
        (total,) = con.execute(f"SELECT COUNT(*) FROM observations WHERE {cond}", args).fetchone()
        # the newest `limit` observations, returned oldest first
        rows = con.execute(f"SELECT series_id, ts, lat, lon, props FROM (SELECT * FROM observations WHERE {cond} ORDER BY ts DESC LIMIT ?) ORDER BY ts",
                           [*args, limit]).fetchall()
    return {"total": total, "truncated": total > len(rows),
            "observations": [{"series_id": s, "t": t, "latitude": la, "longitude": lo, "properties": json.loads(p) if p else {}} for s, t, la, lo, p in rows]}


@router.get("/syncs/{sync_id}/errors")
def list_errors(sync_id: str, limit: int = 200, request: Request = None) -> list[dict]:  # type: ignore[assignment]
    """Rows the sync rejected (no series id, no time, no or invalid position), newest first."""
    rec = check_sync(sync_id)
    _as_build(request, "read", rec)
    sync_id = rec["id"]
    with _db() as con:
        rows = con.execute("SELECT at, error, record FROM errors WHERE sync_id = ? ORDER BY at DESC LIMIT ?", (sync_id, max(1, min(limit, 5000)))).fetchall()
    return [{"at": a, "error": e, "record": json.loads(r)} for a, e, r in rows]


# --------------------------------------------------------------------------------------------
# series reads (time series properties, derived series, FoundryTS)
# --------------------------------------------------------------------------------------------


def _ms(ts: str) -> int:
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


def read_points(sync_id: str, series_id: str, start_ms: Optional[int] = None, end_ms: Optional[int] = None) -> list[tuple[int, Any]]:
    """(epoch ms, value) of one series, oldest first; numbers as floats, categorical values as text."""
    cond, args = "sync_id = ? AND series_id = ?", [sync_id, series_id]
    if start_ms is not None:
        cond += " AND ts >= ?"
        args.append(_iso(datetime.fromtimestamp(start_ms / 1000, timezone.utc)))
    if end_ms is not None:
        cond += " AND ts <= ?"
        args.append(_iso(datetime.fromtimestamp(end_ms / 1000, timezone.utc)))
    with _db() as con:
        rows = con.execute(f"SELECT ts, value, value_text FROM points WHERE {cond} ORDER BY ts", args).fetchall()
    return [(_ms(t), v if v is not None else vt) for t, v, vt in rows]


def syncs_holding(series_id: str, sync_ids: Optional[list[str]] = None) -> list[str]:
    """The time series syncs (of `sync_ids`, or all) that hold points of a series."""
    with _db() as con:
        if sync_ids:
            marks = ",".join("?" * len(sync_ids))
            rows = con.execute(f"SELECT DISTINCT sync_id FROM points WHERE series_id = ? AND sync_id IN ({marks})", (series_id, *sync_ids)).fetchall()
        else:
            rows = con.execute("SELECT DISTINCT sync_id FROM points WHERE series_id = ?", (series_id,)).fetchall()
    found = {r[0] for r in rows}
    return [s for s in (sync_ids or sorted(found)) if s in found]


def series_ids(sync_id: str) -> set[str]:
    with _db() as con:
        return {r[0] for r in con.execute("SELECT DISTINCT series_id FROM points WHERE sync_id = ?", (sync_id,)).fetchall()}


def series_extent(sync_id: str, series_id: str) -> tuple[Optional[str], Optional[str], int]:
    with _db() as con:
        lo, hi, n = con.execute("SELECT MIN(ts), MAX(ts), COUNT(*) FROM points WHERE sync_id = ? AND series_id = ?", (sync_id, series_id)).fetchone()
    return lo, hi, int(n or 0)


# --------------------------------------------------------------------------------------------
# syncs made in the Time Series Catalog from a dataset
# --------------------------------------------------------------------------------------------


class Mapping(BaseModel):
    series_id: str
    timestamp: str
    value: str
    # a Long timestamp column: SECONDS | MILLISECONDS | MICROSECONDS | NANOSECONDS
    timestamp_unit: Optional[Literal["SECONDS", "MILLISECONDS", "MICROSECONDS", "NANOSECONDS"]] = None
    ingestion_time: Optional[str] = None


class SyncSettings(BaseModel):
    schedule_on_update: bool = True
    optimized: bool = True
    index_view_inputs: bool = False
    # syncs whose intersecting series this sync replaces (they fail and should be trashed)
    overwrite_syncs: list[str] = Field(default_factory=list)
    spark_profiles: list[str] = Field(default_factory=list)


class CatalogSyncIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: str
    mapping: Mapping
    settings: SyncSettings = Field(default_factory=SyncSettings)
    description: str = ""
    build: bool = True


class CatalogSyncPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    mapping: Optional[Mapping] = None
    settings: Optional[SyncSettings] = None


def _dataset_table(dataset_id: str, columns: Optional[list[str]] = None):
    import pyarrow.parquet as pq

    import drive

    item = drive._item(dataset_id)
    try:
        pf = pq.ParquetFile(io.BytesIO(drive.read_bytes(item)))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    names = pf.schema_arrow.names
    missing = [c for c in columns or [] if c not in names]
    if missing:
        raise HTTPException(400, f'the dataset has no column {", ".join(missing)}')
    return item, pf.read(columns=columns) if columns else pf.read()


def dataset_columns(dataset_id: str) -> dict:
    import pyarrow.parquet as pq

    import drive
    import pipeline_datasets

    item = drive._item(dataset_id)
    try:
        schema = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).schema_arrow
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    return {"id": item["id"], "name": item["name"], "updated_at": str(item.get("updated_at")),
            "columns": [{"name": f.name, "type": pipeline_datasets._column_type(f.type)} for f in schema]}


def _row_time(v: Any, unit: Optional[str]) -> Optional[str]:
    if isinstance(v, (int, float)) and not isinstance(v, bool) and unit:
        ms = v * TS_UNITS[unit]
        try:
            return _iso(datetime.fromtimestamp(ms / 1000, timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    return timestamp(v)


def _mapped_rows(dataset_id: str, m: Mapping, limit: Optional[int] = None) -> tuple[dict, list[dict], list[str]]:
    item, table = _dataset_table(dataset_id, list(dict.fromkeys([m.series_id, m.timestamp, m.value])))
    if limit:
        table = table.slice(0, limit)
    problems: list[str] = []
    ts_type = str(table.schema.field(m.timestamp).type)
    if ts_type.startswith(("int", "uint")) and not m.timestamp_unit:
        problems.append(f"{m.timestamp} is a Long column: pick its unit (seconds, milliseconds, microseconds or nanoseconds)")
    rows = [{"series_id": r[m.series_id], "timestamp": _row_time(r[m.timestamp], m.timestamp_unit), "value": r[m.value]} for r in table.to_pylist()]
    return item, rows, problems


@router.get("/datasets")
def list_datasets() -> list[dict]:
    """Datasets (Parquet files in Files) a sync or a time series object type can be backed by."""
    import workshop

    return [{"id": d["id"], "name": d["name"], "path": [p["name"] for p in d.get("path") or []], "updated_at": str(d.get("updated_at"))}
            for d in workshop.datasets()]


@router.get("/datasets/{dataset_id}/columns")
def get_dataset_columns(dataset_id: str) -> dict:
    return dataset_columns(dataset_id)


class PreviewIn(BaseModel):
    dataset_id: str
    mapping: Mapping


@router.post("/syncs/preview")
def preview_sync(req: PreviewIn) -> dict:
    """The first rows as the sync would index them, with the series found and the rows it would reject."""
    _item, rows, problems = _mapped_rows(req.dataset_id, req.mapping, 5000)
    good, bad = [], []
    for r in rows:
        v, err = _point(r)
        (bad if v is None else good).append((err, r) if v is None else v)
    series = sorted({g[0] for g in good})
    return {"problems": problems, "rows_read": len(rows), "points": [{"series_id": g[0], "timestamp": g[1], "value": g[2] if g[2] is not None else g[3]} for g in good[:50]],
            "series": series[:200], "series_count": len(series), "rejected": len(bad), "rejected_samples": [{"error": e, "row": r} for e, r in bad[:10]],
            "categorical": any(g[3] is not None for g in good)}


@router.post("/syncs")
def create_catalog_sync(req: CatalogSyncIn) -> dict:
    """New time series sync (Time Series Catalog): a dataset's columns mapped to series ID, timestamp and value."""
    import drive

    drive._item(req.dataset_id)
    for other in req.settings.overwrite_syncs:
        check_sync(other)
    sid = "ts-" + uuid.uuid4().hex[:10]
    rec = {"id": sid, "rid": SYNC_RID + sid, "kind": "timeseries", "source": "catalog", "name": req.name.strip(), "description": req.description.strip(),
           "pipeline_id": "", "pipeline_name": "", "output_id": "", "mode": "batch", "dataset_id": req.dataset_id,
           "mapping": req.mapping.model_dump(), "settings": req.settings.model_dump(), "backing_dataset": None, "stream_id": None,
           "created_at": _iso(), "updated_at": _iso(), "points_total": 0, "errors_total": 0, "last_write_at": None, "last_build": None,
           "status": "new", "created_by": _actor()}
    _inherit_markings(rec)  # marked before the record exists: never listed or read unmarked
    with _lock, _db() as con:
        con.execute("INSERT INTO syncs (id, kind, natural_key, record) VALUES (?, ?, ?, ?)", (sid, "timeseries", json.dumps(["timeseries", "catalog", sid]), json.dumps(rec)))
    if req.build:
        return build_sync(sid)
    return get_sync(sid)


@router.patch("/syncs/{sync_id}")
def update_catalog_sync(sync_id: str, req: CatalogSyncPatch) -> dict:
    """Update sync: name, column mapping and advanced settings. A pipeline's sync keeps the pipeline's mapping."""
    rec = check_sync(sync_id)
    changes = req.model_dump(exclude_unset=True)
    if rec.get("source") != "catalog" and ("mapping" in changes or "settings" in changes):
        raise HTTPException(400, "this sync is written by a pipeline: change its mapping in Pipeline Builder (a deploy would override it)")
    for other in (req.settings.overwrite_syncs if req.settings else []):
        if sync_id_of(other) == rec["id"]:
            raise HTTPException(400, "a sync cannot overwrite itself")
        check_sync(other)
    for k, v in changes.items():
        if v is not None:
            rec[k] = v.strip() if isinstance(v, str) else v
    rec["updated_at"] = _iso()
    _save(rec)
    return get_sync(rec["id"])


@router.post("/syncs/{sync_id}/build")
def build_sync(sync_id: str) -> dict:
    """Index the input dataset into the Time Series DB (a snapshot: the sync's points are replaced)."""
    rec = check_sync(sync_id)
    if rec.get("source") != "catalog":
        raise HTTPException(400, "this sync is built by its pipeline")
    return _build(rec)


def _build(rec: dict) -> dict:
    started = time.monotonic()
    m = Mapping(**rec["mapping"])
    run: dict[str, Any] = {"at": _iso(), "status": "succeeded"}
    try:
        item, rows, problems = _mapped_rows(rec["dataset_id"], m)
        if problems:
            raise HTTPException(400, "; ".join(problems))
        res = write(rec["id"], rows, snapshot=True)
        run.update(rows=len(rows), written=res["written"], errors=res["errors"], dataset_updated_at=str(item.get("updated_at")))
        overwritten = []
        for other in (rec.get("settings") or {}).get("overwrite_syncs") or []:
            oid = sync_id_of(other)
            mine = series_ids(rec["id"])
            with _lock, _db() as con:
                n = 0
                for sid in mine:
                    n += con.execute("DELETE FROM points WHERE sync_id = ? AND series_id = ?", (oid, sid)).rowcount
                orow = con.execute("SELECT record FROM syncs WHERE id = ?", (oid,)).fetchone()
                if orow:
                    o = json.loads(orow[0])
                    o.update(status="failed", error=f"Overwritten by the sync {rec['name']} ({rec['id']}): trash this sync")
                    con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(o), oid))
            overwritten.append({"sync_id": oid, "points_removed": n})
        if overwritten:
            run["overwritten"] = overwritten
    except HTTPException as e:
        run.update(status="failed", error=str(e.detail))
    except Exception as e:  # noqa: BLE001
        run.update(status="failed", error=str(e)[:500])
    run["ms"] = int((time.monotonic() - started) * 1000)
    rec = _sync(rec["id"])
    rec["last_build"] = run
    rec["builds"] = [run, *(rec.get("builds") or [])][:20]
    rec["status"] = run["status"]
    rec["error"] = run.get("error")
    _save(rec)
    _inherit_markings(rec)
    with _db() as con:
        return _stats(con, rec)


def _rebuild_loop() -> None:
    """Schedule sync runs on input dataset update: rebuild a catalog sync when its dataset changed since its build."""
    import db

    while True:
        time.sleep(REBUILD_TICK)
        try:
            if DB_PATH is None or not db.enabled():
                continue
            for rec in all_syncs("timeseries"):
                if rec.get("source") != "catalog" or not (rec.get("settings") or {}).get("schedule_on_update", True):
                    continue
                item = db.drive_get(rec.get("dataset_id") or "")
                if not item or item.get("trashed_at"):
                    continue
                built = (rec.get("last_build") or {}).get("dataset_updated_at")
                if built != str(item.get("updated_at")):
                    log.info("rebuilding time series sync %s: its dataset changed", rec["id"])
                    _build(rec)
        except Exception:  # noqa: BLE001
            log.exception("time series sync rebuild check failed")


def startup() -> None:
    threading.Thread(target=_rebuild_loop, daemon=True, name="ts-sync-rebuild").start()


def _actor() -> Optional[str]:
    try:
        import auth

        return auth.actor_id()
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------------------------
# query compute usage ("Time series query compute usage": 4 compute-seconds per query + points / 25,000)
# --------------------------------------------------------------------------------------------


def record_usage(resource: str, points: int, queries: int = 1) -> float:
    """Meter queries against the resource that ran them (a Quiver analysis, a Workshop module, a code repository …)."""
    compute = queries * 4.0 + points / 25_000
    if DB_PATH is None:
        return compute
    day = _now().strftime("%Y-%m-%d")
    with _lock, _db() as con:
        con.execute("INSERT INTO usage (day, resource, queries, points, compute) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, resource) DO UPDATE SET "
                    "queries = queries + excluded.queries, points = points + excluded.points, compute = compute + excluded.compute",
                    (day, resource or "other", queries, int(points), compute))
    return compute


def usage_rows(days: int = 30) -> list[dict]:
    since = (_now() - timedelta(days=max(1, min(days, 366)))).strftime("%Y-%m-%d")
    with _db() as con:
        rows = con.execute("SELECT day, resource, queries, points, compute FROM usage WHERE day >= ? ORDER BY day", (since,)).fetchall()
    return [{"day": d, "resource": r, "queries": q, "points": p, "compute_seconds": round(c, 3)} for d, r, q, p, c in rows]


# --------------------------------------------------------------------------------------------
# Time Series Catalog home: recently viewed, favorites, most viewed
# --------------------------------------------------------------------------------------------


def mark_viewed(kind: str, rid: str) -> None:
    uid = _actor() or "local"
    with _lock, _db() as con:
        con.execute("INSERT INTO catalog_marks (user_id, kind, rid, views, last_viewed) VALUES (?, ?, ?, 1, ?) ON CONFLICT (user_id, kind, rid) DO UPDATE SET "
                    "views = views + 1, last_viewed = excluded.last_viewed", (uid, kind, rid, _iso()))


def set_favorite(kind: str, rid: str, favorite: bool) -> None:
    uid = _actor() or "local"
    with _lock, _db() as con:
        con.execute("INSERT INTO catalog_marks (user_id, kind, rid, favorite) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, kind, rid) DO UPDATE SET "
                    "favorite = excluded.favorite", (uid, kind, rid, 1 if favorite else 0))


def marks() -> list[dict]:
    uid = _actor() or "local"
    with _db() as con:
        rows = con.execute("SELECT kind, rid, favorite, views, last_viewed FROM catalog_marks WHERE user_id = ?", (uid,)).fetchall()
    return [{"kind": k, "rid": r, "favorite": bool(f), "views": v or 0, "last_viewed": lv} for k, r, f, v, lv in rows]
