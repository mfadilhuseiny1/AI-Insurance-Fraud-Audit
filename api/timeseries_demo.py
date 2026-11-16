"""Demo data for the Time Series Catalog, the Map and output monitors (POST /api/timeseries/demo).

Creates the demo syncs with three hours of history:

* Vessel positions (demo) (geotemporal): AIS traffic in Jakarta Bay from ais_sim.py — container ships, a tanker
  and cargo ships at the Priok anchorage, tugs, the Kepulauan Seribu ferries on their timetables, night fishing
  boats and a patrol boat, as an AIS base station receives it. These run through a real streaming pipeline: the
  decoded messages are pushed into the ingest stream "AIS positions (demo)" and the streaming pipeline "AIS vessel
  tracking (demo)" (Pipeline Builder) drops messages without a fix, nulls heading 511, decodes the navigational
  status and ship type, adds the speed in km/h and sends the positions to its geotemporal series sync output.
  Without Files (or the right to create pipelines) the cleaned positions are written straight into the sync;
* Delivery trucks (demo) (geotemporal): trucks driving a loop through Jakarta;
* Vessel speed (demo) (time series): each ship's speed over ground in knots, by MMSI;
* Port sensors (demo) (time series): temperature, wave height and wind speed at the port.

Positions are a function of time (vessels follow their operating plans, trucks a loop), so history and the live
feed line up: while live, a thread sends the new AIS messages, positions and readings every 10 seconds (streaming syncs: the Map
refreshes on its own and the output monitors see points). A monitoring view "Output monitors (demo)" gets a Points
written monitor and Geotemporal observations sent monitors. DELETE /api/timeseries/demo removes all of it.

The Map shows the demo as a built-in map: it calls POST /api/timeseries/demo/ensure, which loads the demo when it
is missing, otherwise fills the gap since it last sent, keeps the streaming job running and the feed live.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

import ais_sim
import timeseries as ts

log = logging.getLogger("bluesandai.timeseries_demo")

DEMO_PIPELINE = "demo"
DEMO_NAME = "Demo project"
PIPELINE_NAME = "AIS vessel tracking (demo)"
STREAM_NAME = "AIS positions (demo)"
SYNC_NAMES = {"vessels": "Vessel positions (demo)", "trucks": "Delivery trucks (demo)", "speeds": "Vessel speed (demo)", "sensors": "Port sensors (demo)"}
MONITOR_VIEW = "Output monitors (demo)"
OLD_MONITOR_VIEWS = ("Demo · Output monitors",)
# bump when the demo changes shape: ensure() then rebuilds it
DEMO_VERSION = 2
AIS_SCHEMA = [{"name": n, "type": t} for n, t in [
    ("msg_type", "Integer"), ("mmsi", "String"), ("imo", "String"), ("callsign", "String"), ("vessel_name", "String"), ("ship_type", "Integer"),
    ("length_m", "Integer"), ("ts", "String"), ("lat", "Double"), ("lon", "Double"), ("sog", "Double"), ("cog", "Double"), ("heading", "Integer"),
    ("nav_status", "Integer"), ("destination", "String"), ("eta", "String"), ("draught", "Double")]]
VESSEL_PROPERTIES = ["vessel_name", "vessel_type", "nav_status_text", "sog", "cog", "heading", "speed_kmh", "destination", "eta", "draught", "imo", "callsign", "length_m"]
VESSEL_MAPPING = {"seriesId": "mmsi", "timestamp": "ts", "latitude": "lat", "longitude": "lon", "properties": VESSEL_PROPERTIES}
# the AIS base station's coverage: messages without a fix (91, 181) fall outside
COVERAGE = "-6.6, 105.9, -5.2, 107.7"
HISTORY_MINUTES = 180
HISTORY_STEP_S = 60
LIVE_STEP_S = 10
KEEP_HOURS = 24

# a delivery loop through Jakarta: Tanjung Priok, Kelapa Gading, Cawang, Blok M, Grogol, Kota
CITY_LOOP = [(-6.11, 106.88), (-6.16, 106.905), (-6.245, 106.87), (-6.244, 106.80), (-6.167, 106.79), (-6.135, 106.813), (-6.11, 106.88)]
# (series id, plate, start offset as a share of the loop): same cruise speed, so they stay spread around the loop
TRUCKS = [(f"TRUCK-{i + 1:02d}", f"B {9100 + i * 37} PRK", i / 5) for i in range(5)]
TRUCK_KMH = 28.0
SENSORS = [("priok.temperature_c", 29.0, 2.5), ("priok.wave_height_m", 0.9, 0.4), ("priok.wind_speed_kn", 11.0, 4.0)]

_live: dict = {"thread": None, "stop": None, "until": None}
_lock = threading.Lock()
# loading, ensuring and removing the demo one at a time (the Map ensures it on every open)
_ensure_lock = threading.Lock()


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return 6371 * math.hypot(dlat, dlon)


def _along(route: list[tuple[float, float]], dist_km: float, loop: bool) -> tuple[float, float, float]:
    """(lat, lon, heading) after dist_km along the route: a loop goes round, an open route back and forth."""
    legs = [(route[i], route[i + 1], _km(route[i], route[i + 1])) for i in range(len(route) - 1)]
    total = sum(l for _, _, l in legs) or 1
    d = dist_km % (total if loop else 2 * total)
    back = not loop and d > total
    if back:
        d = 2 * total - d
    for a, b, length in legs:
        if d <= length or (a, b, length) == legs[-1]:
            f = min(1.0, d / length) if length else 0
            lat, lon = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            src, dst = (b, a) if back else (a, b)
            heading = (math.degrees(math.atan2((dst[1] - src[1]) * math.cos(math.radians(lat)), dst[0] - src[0])) + 360) % 360
            return lat, lon, round(heading, 1)
        d -= length
    return route[-1][0], route[-1][1], 0.0


def _noise(*parts: object) -> float:
    """A deterministic value in [-1, 1) for the parts (the same time gives the same reading)."""
    h = hashlib.sha1("|".join(map(str, parts)).encode()).digest()
    return int.from_bytes(h[:4], "big") / 2**31 - 1


def _rows(t: datetime) -> dict[str, list[dict]]:
    """Truck positions and port sensor readings at t."""
    secs = t.timestamp()
    iso = t.isoformat(timespec="seconds")
    trucks, sensors = [], []
    total = sum(_km(CITY_LOOP[i], CITY_LOOP[i + 1]) for i in range(len(CITY_LOOP) - 1))
    for sid, plate, offset in TRUCKS:
        lat, lon, heading = _along(CITY_LOOP, (secs / 3600 * TRUCK_KMH) % total + offset * total, loop=True)
        trucks.append({"series_id": sid, "timestamp": iso, "latitude": round(lat, 6), "longitude": round(lon, 6), "plate": plate,
                       "speed_kmh": round(TRUCK_KMH * (1 + 0.25 * _noise(sid, int(secs) // 60)), 1), "heading": heading})
    day = (secs % 86400) / 86400
    for sid, base, amp in SENSORS:
        v = base + amp * math.sin(2 * math.pi * (day - 0.3)) + amp * 0.15 * _noise(sid, int(secs) // 10)
        sensors.append({"series_id": sid, "timestamp": iso, "value": round(v, 3)})
    return {"sensors": sensors, "trucks": trucks}




def _vessel_batches(msgs: list[dict], st: Optional[dict]) -> dict[str, list[dict]]:
    """AIS messages for the stream (with the pipeline) or as cleaned observations (without), and the vessel speeds."""
    clean = [c for c in (ais_sim.clean(m) for m in msgs) if c]
    speeds = [{"series_id": c["mmsi"], "timestamp": c["ts"], "value": c["sog"]} for c in clean]
    if st:
        return {"vessels": msgs, "speeds": speeds}
    obs = [{"series_id": c["mmsi"], "timestamp": c["ts"], "latitude": c["lat"], "longitude": c["lon"], **{k: c.get(k) for k in VESSEL_PROPERTIES}} for c in clean]
    return {"vessels": obs, "speeds": speeds}


# ------------------------------------------------------------------------------------------------
# the AIS ingest stream and the streaming pipeline (what they are: data/timeseries/demo.json)
# ------------------------------------------------------------------------------------------------


def _state_file() -> Path:
    if ts.DB_PATH is None:
        raise HTTPException(503, "Time series are not configured")
    return ts.DB_PATH.parent / "demo.json"


def _state() -> dict:
    try:
        return json.loads(_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _pipeline_content(stream_id: str, preview: list[dict]) -> tuple[dict, str]:
    """AIS positions (ingest stream) → Clean AIS (receiver coverage, heading 511, status and ship type decoded, km/h)
    → Vessel positions (demo), a geotemporal series sync output. Returns the content and the output's id."""
    now = datetime.now(timezone.utc).isoformat()
    ds_id, src_id, tf_id, out_id = _uid(), _uid(), _uid(), _uid()

    def val(v: object, typ: str = "String") -> dict:
        return {"kind": "value", "type": typ, "value": str(v)}

    def when(col: str, op: str, *vals: int) -> dict:
        cond = {"id": _uid(), "left": {"kind": "column", "column": col}, "op": op, "right": val(vals[0], "Integer")}
        if len(vals) > 1:
            cond["right2"] = val(vals[1], "Integer")
        return {"id": _uid(), "match": "all", "items": [cond]}

    def cases(items: list[tuple[dict, str]], otherwise: str) -> str:
        return json.dumps({"cases": [{"id": _uid(), "when": w, "then": val(text)} for w, text in items], "else": val(otherwise)})

    status = [(when("nav_status", "is equal to", code), text) for code, text in ais_sim.NAV_STATUS.items()]
    kinds = [(when("ship_type", "is equal to", 30), "Fishing"), (when("ship_type", "is equal to", 52), "Tug"), (when("ship_type", "is equal to", 55), "Law enforcement"),
             (when("ship_type", "is between", 60, 69), "Passenger"), (when("ship_type", "is between", 70, 79), "Cargo"), (when("ship_type", "is between", 80, 89), "Tanker")]
    steps = [
        # messages without a fix report latitude 91 / longitude 181: outside the receiver's coverage
        {"id": _uid(), "kind": "geo_bbox", "params": {"lat": "lat", "lon": "lon", "bbox": COVERAGE}},
        {"id": _uid(), "kind": "nullif", "params": {"column": "heading", "value": "511"}},
        {"id": _uid(), "kind": "case_when", "params": {"cases": cases(status, "Not defined"), "type": "String", "output": "nav_status_text"}},
        {"id": _uid(), "kind": "case_when", "params": {"cases": cases(kinds, "Other"), "type": "String", "output": "vessel_type"}},
        {"id": _uid(), "kind": "formula", "params": {"formula": "sog * 1.852", "output": "speed_kmh"}},
    ]
    content = {
        "type": "streaming",
        "createdAt": now,
        "updatedAt": now,
        "datasets": {ds_id: {"id": ds_id, "name": STREAM_NAME, "origin": f"Ingest stream {STREAM_NAME} (Streaming app)", "createdAt": now,
                             "columns": AIS_SCHEMA, "rows": preview, "ref": {"kind": "ingest", "streamId": stream_id}, "refreshedAt": now}},
        "nodes": [
            {"id": src_id, "kind": "source", "name": STREAM_NAME, "datasetId": ds_id, "x": 80, "y": 80},
            {"id": tf_id, "kind": "transform", "name": "Clean AIS", "input": src_id, "steps": steps, "x": 380, "y": 80},
        ],
        "outputs": [{"id": out_id, "name": SYNC_NAMES["vessels"], "node": tf_id, "kind": "geotemporal", "columns": None, "writeMode": "default", "geotemporal": VESSEL_MAPPING, "x": 680, "y": 80}],
        "legend": [],
        "buildSettings": {"streamingProfile": "xs", "consistency": "at-least-once", "maxDurationMinutes": None},
        "meta": {"description": "Demo: decoded AIS messages from a base station at Tanjung Priok arrive in an ingest stream. This streaming pipeline "
                                "keeps the messages with a fix (inside the receiver's coverage), nulls heading 511 (not available), decodes the "
                                "navigational status and ship type, adds the speed in km/h and sends the positions to a geotemporal series sync, "
                                "shown live on the Map."},
    }
    return content, out_id


def _create_pipeline(preview: list[dict]) -> Optional[dict]:
    """The AIS ingest stream and the streaming pipeline reading it. None when Files is unavailable or the user may
    not create pipelines: the vessel positions are then written straight into their sync."""
    import pipeline_datasets
    import streaming

    stream = streaming.create_stream(streaming.StreamIn(name=STREAM_NAME, schema=[streaming.ColumnIn(**c) for c in AIS_SCHEMA],
                                                        keys=streaming.KeysIn(partition=["mmsi"])))
    try:
        content, out_id = _pipeline_content(stream["id"], preview)
        item = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE_NAME, content=content))
    except Exception as e:  # noqa: BLE001
        log.info("demo: no streaming pipeline (%s); writing vessel positions straight into their sync", e)
        streaming.delete_stream(stream["id"])
        return None
    # the sync exists before the job's first write, so the monitors can watch it (the job's writes find it by
    # pipeline, output and name)
    sync = ts.register(ts.SyncIn(kind="geotemporal", name=SYNC_NAMES["vessels"], pipeline_id=item["id"], pipeline_name=PIPELINE_NAME, output_id=out_id,
                                 mode="streaming", mapping=VESSEL_MAPPING))
    st = {"version": DEMO_VERSION, "stream_id": stream["id"], "pipeline_id": item["id"], "folder_id": item.get("parent_id"), "output_id": out_id, "vessel_sync": sync["id"]}
    _state_file().write_text(json.dumps(st), encoding="utf-8")
    return st


def _pipeline_exists(st: dict) -> bool:
    import db

    try:
        item = db.drive_get(st["pipeline_id"])
        return bool(item and not item.get("trashed_at"))
    except Exception:  # noqa: BLE001
        return False


def _deploy(st: dict) -> None:
    """Start the streaming job unless it runs (an API restart restarts it from its checkpoint on its own)."""
    import pipeline_runtime as rt

    if not any(b["status"] in ("queued", "running") and not b.get("cancel") for b in rt._builds(st["pipeline_id"], 10)):
        rt.queue_build(rt.NewBuild(pipeline_id=st["pipeline_id"], trigger="demo"))


def _remove_pipeline(st: dict) -> None:
    """Stop the streaming job; delete the pipeline (its folder), its output stream and the AIS stream."""
    import drive
    import pipeline_runtime as rt
    import streaming

    pid = st.get("pipeline_id")
    if pid:
        for b in rt._builds(pid, 50):
            if b["status"] in ("queued", "running"):
                b["cancel"] = True
                b["logs"].append({"at": rt._now(), "level": "warn", "msg": "Cancel requested (demo removed)"})
                if b["status"] == "queued":
                    b.update(status="cancelled", finished_at=rt._now())
                rt._save_build(b)
        for sid in (rt.get_state(pid, f"istream:{st.get('output_id')}"), st.get("stream_id")):
            if sid:
                try:
                    streaming.delete_stream(sid)
                except HTTPException:
                    pass
        try:
            if st.get("folder_id"):
                drive.delete_tree(st["folder_id"])
            else:
                drive.delete_item(pid)
        except Exception:  # noqa: BLE001
            log.exception("demo: could not delete pipeline %s", pid)
    _state_file().unlink(missing_ok=True)


# ------------------------------------------------------------------------------------------------
# syncs, writes and the live feed
# ------------------------------------------------------------------------------------------------


def _register(st: Optional[dict]) -> dict[str, str]:
    specs = {
        "trucks": ("geotemporal", {"seriesId": "truck_id", "timestamp": "ts", "latitude": "lat", "longitude": "lon", "properties": ["plate", "speed_kmh", "heading"]}),
        "speeds": ("timeseries", {"seriesId": "mmsi", "timestamp": "ts", "value": "speed_kn"}),
        "sensors": ("timeseries", {"seriesId": "sensor", "timestamp": "ts", "value": "reading"}),
    }
    if not st:
        specs["vessels"] = ("geotemporal", VESSEL_MAPPING)
    ids = {k: ts.register(ts.SyncIn(kind=kind, name=SYNC_NAMES[k], pipeline_id=DEMO_PIPELINE, pipeline_name=DEMO_NAME, output_id=k, mode="streaming", mapping=m))["id"]
           for k, (kind, m) in specs.items()}
    if st:
        ids["vessels"] = st["vessel_sync"]
    return ids


def _send(ids: dict[str, str], st: Optional[dict], batches: dict[str, list[dict]], snapshot: bool = False) -> None:
    """Rows to their syncs; with the streaming pipeline, vessel positions go to its AIS ingest stream instead."""
    import streaming

    for k, rows in batches.items():
        if not rows:
            continue
        if k == "vessels" and st:
            streaming.append(st["stream_id"], rows)
        else:
            ts.write(ids[k], rows, snapshot=snapshot)


def _history(ids: dict[str, str], st: Optional[dict], start: datetime, end: datetime, snapshot: bool = False) -> None:
    """Trucks and sensors every minute from start (inclusive) to end (exclusive); every AIS message received then."""
    batches: dict[str, list[dict]] = {k: [] for k in ids}
    t = start
    while t < end:
        for k, rows in _rows(t).items():
            batches[k] += rows
        t += timedelta(seconds=HISTORY_STEP_S)
    for k, rows in _vessel_batches(ais_sim.messages(start.timestamp(), end.timestamp()), st).items():
        batches[k] += rows
    _send(ids, st, batches, snapshot=snapshot)


def _feed(ids: dict[str, str], st: Optional[dict], stop: threading.Event, since: datetime) -> None:
    """Every 10 s: the trucks and sensors now, and the AIS messages received since the last tick."""
    last = since
    while not stop.wait(LIVE_STEP_S):
        if _live["until"] and datetime.now(timezone.utc) > _live["until"]:
            break
        now = datetime.now(timezone.utc).replace(microsecond=0)
        try:
            _send(ids, st, {**_rows(now), **_vessel_batches(ais_sim.messages(last.timestamp(), now.timestamp()), st)})
        except HTTPException:
            break  # the demo was removed
        last = now


def _stop_live() -> None:
    with _lock:
        if _live["stop"]:
            _live["stop"].set()
        _live.update(thread=None, stop=None, until=None)


def _start_live(ids: dict[str, str], st: Optional[dict], minutes: int, since: datetime) -> None:
    _stop_live()
    stop = threading.Event()
    with _lock:
        _live.update(stop=stop, until=datetime.now(timezone.utc) + timedelta(minutes=minutes))
        _live["thread"] = threading.Thread(target=_feed, args=(ids, st, stop, since), name="timeseries-demo", daemon=True)
        _live["thread"].start()


def _demo_syncs() -> list[dict]:
    """The demo's syncs: written as the demo project, or by its pipeline (also a pipeline of an earlier version)."""
    pid = _state().get("pipeline_id")
    return [s for s in ts.list_syncs() if s.get("pipeline_id") == DEMO_PIPELINE or (pid and s.get("pipeline_id") == pid)]


def _trim(syncs: list[dict]) -> None:
    """Keep a day of demo data, so a demo that stays live does not grow without end."""
    import streaming

    then = datetime.now(timezone.utc) - timedelta(hours=KEEP_HOURS)
    cutoff = ts.timestamp(then)
    with ts._lock, ts._db() as con:
        for s in syncs:
            con.execute(f"DELETE FROM {'observations' if s['kind'] == 'geotemporal' else 'points'} WHERE sync_id = ? AND ts < ?", (s["id"], cutoff))
    stream_id = _state().get("stream_id")
    if stream_id:
        # the job reads after its offset, so records it processed long ago can go
        with streaming._lock, streaming._db() as con:
            con.execute("DELETE FROM records WHERE stream_id = ? AND at < ?", (stream_id, streaming._iso(then)))


def _delete_views() -> None:
    import streaming

    for v in streaming.list_views():
        if v["name"] in (MONITOR_VIEW, *OLD_MONITOR_VIEWS):
            streaming.delete_view(v["id"])


def _monitors(ids: dict[str, str]) -> str:
    import streaming

    _delete_views()
    view_id = streaming.create_view(streaming.ViewIn(name=MONITOR_VIEW, description="Output monitors on the demo time series and geotemporal syncs"))["id"]
    streaming.create_monitor(view_id, streaming.MonitorIn(resource_type="timeseries_sync", resource_id=ids["sensors"], rule="points_written", threshold=0, severity="high"))
    streaming.create_monitor(view_id, streaming.MonitorIn(resource_type="geotemporal", resource_id=ids["vessels"], rule="geotemporal_observations_sent", threshold=0, severity="high"))
    streaming.create_monitor(view_id, streaming.MonitorIn(resource_type="geotemporal", resource_id=ids["trucks"], rule="geotemporal_observations_sent", threshold=100,
                                                          window_minutes=30, severity="low"))
    return view_id


def _teardown() -> list[str]:
    _stop_live()
    removed = [ts.delete_sync(s["id"])["deleted"] for s in _demo_syncs()]
    st = _state()
    if st.get("pipeline_id"):
        _remove_pipeline(st)
    else:
        _state_file().unlink(missing_ok=True)
    return removed


# ------------------------------------------------------------------------------------------------
# endpoints
# ------------------------------------------------------------------------------------------------


class DemoIn(BaseModel):
    # keep sending live positions and readings for this long (0: history only)
    live_minutes: int = Field(60, ge=0, le=24 * 60)
    monitors: bool = True


def _load(req: DemoIn) -> dict:
    _teardown()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    # the pipeline's preview copy of the stream: the last half hour of messages
    st = _create_pipeline(ais_sim.messages((now - timedelta(minutes=30)).timestamp(), now.timestamp())[-300:])
    if not st:
        _state_file().write_text(json.dumps({"version": DEMO_VERSION}), encoding="utf-8")
    ids = _register(st)
    _history(ids, st, now - timedelta(minutes=HISTORY_MINUTES), now + timedelta(seconds=1), snapshot=True)
    since = now + timedelta(seconds=1)
    if st:
        _deploy(st)
    view_id = _monitors(ids) if req.monitors else None
    if req.live_minutes:
        _start_live(ids, st, req.live_minutes, since)
    return {"syncs": ids, "monitoring_view": view_id, **status()}


@ts.router.post("/demo")
def load(req: DemoIn) -> dict:
    """(Re)create the demo: the syncs with fresh history, the AIS stream and the streaming pipeline for the vessel
    positions, the demo monitoring view, and start the live feed."""
    with _ensure_lock:
        return _load(req)


@ts.router.post("/demo/ensure")
def ensure() -> dict:
    """The Map's built-in demo: load it when missing; otherwise fill the gap since it last sent, keep the streaming
    job running and the feed live for the next day."""
    with _ensure_lock:
        syncs = _demo_syncs()
        names = {s["name"]: s["id"] for s in syncs}
        meta = _state()
        st = meta if meta.get("pipeline_id") else None
        if meta.get("version") != DEMO_VERSION or any(n not in names for n in SYNC_NAMES.values()) or (st and not _pipeline_exists(st)):
            return _load(DemoIn(live_minutes=24 * 60))
        ids = {k: names[n] for k, n in SYNC_NAMES.items()}
        if st:
            _deploy(st)
        if not status()["live"]:
            _resume(syncs, ids, st)
        return {"syncs": ids, **status()}


def _resume(syncs: list[dict], ids: dict[str, str], st: Optional[dict]) -> None:
    """Fill in what was missed since the demo last sent (positions are a function of time, up to the history
    length), trim old data and keep the feed live for the next day."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    start = now - timedelta(minutes=HISTORY_MINUTES)
    last = max((s["last_write_at"] for s in syncs if s.get("last_write_at")), default=None)
    if last:
        start = max(start, datetime.fromisoformat(last).replace(microsecond=0) + timedelta(seconds=1))
    _history(ids, st, start, now)
    _trim(syncs)
    _start_live(ids, st, 24 * 60, since=now)


def startup() -> None:
    """After an API restart: a loaded demo resumes its feed (the streaming job restarts on its own, from its
    checkpoint, and reads what was filled in)."""

    def run() -> None:
        try:
            with _ensure_lock:
                syncs = _demo_syncs()
                names = {s["name"]: s["id"] for s in syncs}
                meta = _state()
                if meta.get("version") != DEMO_VERSION or any(n not in names for n in SYNC_NAMES.values()):
                    return  # not loaded, or outdated: the Map loads it
                _resume(syncs, {k: names[n] for k, n in SYNC_NAMES.items()}, meta if meta.get("pipeline_id") else None)
                log.info("demo: feed resumed")
        except Exception:  # noqa: BLE001
            log.exception("demo: could not resume the feed")

    threading.Thread(target=run, daemon=True, name="timeseries-demo-resume").start()


@ts.router.get("/demo")
def status() -> dict:
    until = _live["until"]
    live = bool(_live["thread"] and _live["thread"].is_alive() and until and until > datetime.now(timezone.utc))
    return {"loaded": bool(_demo_syncs()), "live": live, "live_until": until.isoformat() if live else None, "pipeline_id": _state().get("pipeline_id")}


@ts.router.delete("/demo")
def remove() -> dict:
    with _ensure_lock:
        removed = _teardown()
        try:
            _delete_views()
        except HTTPException:
            pass
    return {"removed": removed}


@ts.router.post("/demo/stop")
def stop_live() -> dict:
    _stop_live()
    return status()
