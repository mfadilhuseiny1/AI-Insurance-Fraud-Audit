"""Streaming, following Foundry's streaming resource guide ("07 Resource guides": Streaming, Flink
fundamentals, Reset stream, Stream monitoring, Streaming profiles). A separate app from Pipeline
Builder's device streams, with its own store (data/streaming/streaming.sqlite):

Ingest streams (Streaming app, /streaming)
  A stream holds records in order. Its current view (`view_id`) is part of the push URL; a reset
  clears the records, starts a new view and may change the schema, throughput and configuration.
  Downstream pipelines must replay after a reset; push clients must use the new view's URL.

Connect to data sources (Data Connection)
  * Streaming syncs pull from a streaming platform (streaming_sources.py: Kafka, Kinesis, SQS and
    SNS, Pub/Sub, AVEVA PI, MQTT, RabbitMQ, IBM MQ) into an ingest stream. A sync runs as a job
    of `parallelism` consumers (its streaming profile) that poll, write, then checkpoint; idle
    jobs still checkpoint every `checkpoint_interval_s`, as Flink jobs persist state. The job acts
    as the sync's owner (the user who created or last started it; run_as.py): with their markings,
    re-checked every 30 s and on every resume at startup — an owner who is gone, deactivated or lost
    a marking of the sync or its stream fails the job with the reason (never runs as the system).
  * Push-based ingestion: POST records to the stream proxy URL of the stream's view
    (/api/streaming/stream-proxy/streams/{id}/views/{view}/jsonRecords) with the stream's token.

Streaming profiles (Control Panel → Streaming profiles; picked in syncs and Pipeline Builder)
  Composable resource presets (parallelism, batch size, record size, buffers, checkpointing).
  A profile is used only when imported into the job's Project (a Project reference); selecting
  one imports it automatically, except restricted large profiles, which only Control Panel
  imports.

Stream monitoring (Data Health → Monitoring Views)
  Monitoring views group monitors and subscriptions. Monitors: records ingested (5 / 30 minutes,
  at or below a threshold) on streams or syncs, and on sync jobs checkpoint liveness, last
  checkpoint duration, checkpoint trigger failures, consecutive checkpoint failures, total lag,
  total throughput (records per checkpoint) and utilization. A view also holds dataset checks
  and schedule checks (health_checks.py). An evaluator checks every 30 s; firing and resolved
  alerts are kept and sent to the view's subscriptions (email over SMTP, PagerDuty Events API
  v2, webhook) for the severities they chose. Monitors that do not auto-resolve keep their
  alert open until it is resolved by hand. Output monitors (timeseries.py) watch what pipelines
  write into time series syncs (points written to the Time Series DB) and geotemporal series syncs
  (geotemporal observations sent), over 5 or 30 minutes. Each monitor is evaluated as its owner
  (who created or last saved it; else its view's creator), never as the system: an owner who is
  gone, deactivated or lost access to the resource leaves the monitor "blocked" with the reason
  (nothing measured, no alert, no notification) until someone who can see the resource saves it.
  A subscription acts for its owner (who created it; else the view's creator): it is sent nothing
  about a monitor its owner — or, for an email, a platform user with that address — cannot see
  (the reason is kept on the subscription as `skipped`); digests are re-checked when they go out.

Markings: a streaming sync (which holds the source connection) may be created marked; its stream
  carries the markings of every sync writing into it from the first record (inherited, worked out
  on every check), and each batch records them on the stream for good — until a reset clears the
  records, which narrows them back to the current syncs' markings. A stream's archive dataset
  (stream_datasets.py) carries the stream's markings before its rows are stored.

Mounted by server.py under /api/streaming.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets as pysecrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any, Iterator, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import streaming_sources as sources
import timeseries

log = logging.getLogger("bluesandai.streaming")
router = APIRouter(prefix="/api/streaming")

DB_PATH: Optional[Path] = None
_lock = threading.RLock()

COLUMN_TYPES = ("String", "Boolean", "Integer", "Long", "Double", "Decimal", "Date", "Timestamp")
THROUGHPUT = {"normal": {"partitions": 1, "records_per_second": 5_000}, "high": {"partitions": 3, "records_per_second": 50_000}}

# --------------------------------------------------------------------------------------------
# streaming profiles
# --------------------------------------------------------------------------------------------

DEFAULTS = {"parallelism": 1, "batch_records": 500, "max_record_bytes": 1_048_576, "buffer_records": 10_000, "checkpoint_interval_s": 60, "poll_timeout_s": 5}

PROFILES: dict[str, dict] = {
    "default": {"name": "Default", "description": "Cost-effective defaults for most streams.", "settings": {}, "restricted": False},
    "high-throughput": {"name": "High throughput", "description": "More parallel consumers and larger batches for very high throughput.",
                        "settings": {"parallelism": 4, "batch_records": 5_000}, "restricted": False},
    "large-records": {"name": "Large records", "description": "Records up to 10 MB, fetched in smaller batches.",
                      "settings": {"max_record_bytes": 10_485_760, "batch_records": 100}, "restricted": False},
    "large-state": {"name": "Large state", "description": "Larger buffers and less frequent checkpoints for jobs keeping much state.",
                    "settings": {"buffer_records": 100_000, "checkpoint_interval_s": 300}, "restricted": False},
    "extra-large": {"name": "Extra large (restricted)", "description": "8 consumers, 20 000-record batches. Only Control Panel can import it into a Project.",
                    "settings": {"parallelism": 8, "batch_records": 20_000, "buffer_records": 200_000}, "restricted": True},
}


def compose(profiles: list[str], advanced: Optional[dict] = None) -> dict:
    """Profiles combined (each setting takes the largest value), then Advanced overrides."""
    out = dict(DEFAULTS)
    for p in profiles or ["default"]:
        if p not in PROFILES:
            raise HTTPException(400, f'Unknown streaming profile "{p}"')
        for k, v in PROFILES[p]["settings"].items():
            out[k] = max(out[k], v)
    for k, v in (advanced or {}).items():
        if k in DEFAULTS and v not in (None, ""):
            out[k] = max(1, int(v))
    return out


# --------------------------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (stream_id TEXT NOT NULL, view_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (stream_id, view_id, seq));
CREATE INDEX IF NOT EXISTS records_at ON records (stream_id, view_id, at);
CREATE TABLE IF NOT EXISTS syncs (id TEXT PRIMARY KEY, record TEXT NOT NULL, secret BLOB, state TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS metrics (sync_id TEXT NOT NULL, minute TEXT NOT NULL, records INTEGER DEFAULT 0, bytes INTEGER DEFAULT 0,
    checkpoints INTEGER DEFAULT 0, cp_failures INTEGER DEFAULT 0, cp_ms_max INTEGER DEFAULT 0, busy_ms INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0,
    lag REAL, PRIMARY KEY (sync_id, minute));
CREATE TABLE IF NOT EXISTS profile_refs (profile TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (profile, project_id));
CREATE TABLE IF NOT EXISTS views (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, view_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, view_id TEXT NOT NULL, record TEXT NOT NULL, secret BLOB);
CREATE TABLE IF NOT EXISTS digest_queue (sub_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, view_id TEXT NOT NULL, record TEXT NOT NULL, fired_at TEXT NOT NULL, resolved_at TEXT);
"""


def configure(data_dir: Path) -> None:
    global DB_PATH
    folder = data_dir / "streaming"
    folder.mkdir(parents=True, exist_ok=True)
    DB_PATH = folder / "streaming.sqlite"
    with _db() as con:
        con.executescript(SCHEMA)


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    if DB_PATH is None:
        raise HTTPException(503, "Streaming is not configured")
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


def _get(table: str, rid: str, what: str) -> dict:
    with _db() as con:
        row = con.execute(f"SELECT record FROM {table} WHERE id = ?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, f"{what} not found")
    return json.loads(row[0])


def _put(table: str, rec: dict, extra: Optional[dict] = None) -> None:
    cols = {"id": rec["id"], "record": json.dumps(rec), **(extra or {})}
    with _lock, _db() as con:
        con.execute(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) "
            f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{k} = excluded.{k}' for k in cols if k != 'id')}",
            tuple(cols.values()),
        )


def _seal(values: dict) -> Optional[bytes]:
    import secretbox

    return secretbox.seal({k: v for k, v in values.items() if v}) if any(values.values()) else None


def _unseal(token: Optional[bytes]) -> dict:
    import secretbox

    return secretbox.unseal(token) if token else {}


# --------------------------------------------------------------------------------------------
# ingest streams
# --------------------------------------------------------------------------------------------


class ColumnIn(BaseModel):
    name: str
    type: str = "String"


class PrimaryKeyIn(BaseModel):
    # deduplication columns: the stream is a changelog, read by CDC-aware consumers as the latest row per key
    columns: list[str]
    # a Boolean column: when the latest row for a key has it true, the key is deleted from the current view
    deleted: Optional[str] = None


class KeysIn(BaseModel):
    # partition key columns: records with the same values keep their order
    partition: list[str] = Field(default_factory=list)
    primary: Optional[PrimaryKeyIn] = None


class StreamIn(BaseModel):
    name: str
    schema_: list[ColumnIn] = Field(default_factory=list, alias="schema")
    throughput: Literal["normal", "high"] = "normal"
    # Flink job / sink configuration values (key → value), kept with the stream
    configuration: dict[str, str] = Field(default_factory=dict)
    keys: Optional[KeysIn] = None
    # what writes the stream, e.g. {"kind": "pipeline", "pipeline_id": …, "output_id": …, "name": …}
    origin: Optional[dict[str, Any]] = None
    model_config = {"populate_by_name": True}


def _check_keys(keys: Optional[KeysIn], schema: list[dict]) -> dict:
    """Partition and primary keys (Foundry's includeInPartitioning / primaryKey schema metadata). Setting a
    primary key also sets its columns as partition keys, so the changelog of a key stays in order."""
    if keys is None:
        return {"partition": [], "primary": None}
    names = {c["name"] for c in schema}
    partition = [c.strip() for c in keys.partition if c.strip()]
    primary = None
    if keys.primary and keys.primary.columns:
        cols = [c.strip() for c in keys.primary.columns if c.strip()]
        primary = {"columns": cols, "deleted": (keys.primary.deleted or "").strip() or None}
        partition += [c for c in cols if c not in partition]
    for c in partition + ([primary["deleted"]] if primary and primary["deleted"] else []):
        if names and c not in names:
            raise HTTPException(400, f'Key column "{c}" is not in the schema')
    if len(set(partition)) != len(partition):
        raise HTTPException(400, "Partition key columns must be unique")
    return {"partition": partition, "primary": primary}


def _check_schema(cols: list[ColumnIn]) -> list[dict]:
    seen = set()
    out = []
    for c in cols:
        n = c.name.strip()
        if not n or n in seen:
            raise HTTPException(400, f'Column names must be unique and not empty ("{n}")')
        if c.type not in COLUMN_TYPES:
            raise HTTPException(400, f"Column type must be one of {', '.join(COLUMN_TYPES)}")
        seen.add(n)
        out.append({"name": n, "type": c.type})
    return out


def _stream(stream_id: str) -> dict:
    s = _get("streams", stream_id, "Stream")
    # markings on the stream (Files-style resource markings, "stream:<id>"); background work and pushes act as the system
    auth.check_resource("stream", stream_id)
    return s


# A stream carries the markings of the streaming syncs writing into it (the sync holds the source connection: its
# address and credentials, and its own markings): a sync's markings apply to its stream at once — when it is created
# marked, and from the moment someone marks it later — as inherited markings worked out on every check, so a reader
# without them never sees the stream or a record of it. Each batch a sync writes first records its markings on the
# stream for good (`_mark_stream`), so the records keep them after the sync is unmarked, retargeted or deleted.


def _syncs_into(stream_id: str) -> list[str]:
    with _db() as con:
        return [r for (r,) in con.execute("SELECT id FROM syncs WHERE json_extract(record, '$.stream_id') = ?", (stream_id,)).fetchall()]


def _sync_markings(sync_id: str) -> set[str]:
    return set(auth.effective_markings(auth.resource_id("stream_sync", sync_id)))


def _inherited_from_syncs(stream_id: str) -> set[str]:
    """RESOURCE_MARKING_HOOKS["stream"]: the markings of every streaming sync into the stream."""
    out: set[str] = set()
    for sid in _syncs_into(str(stream_id)):
        out |= _sync_markings(sid)
    return out


auth.RESOURCE_MARKING_HOOKS["stream"] = _inherited_from_syncs


def _mark_stream(stream_id: Optional[str], marks: set[str]) -> None:
    """Record `marks` on the stream as inherited markings (widened only: records written under them keep them)."""
    if not stream_id or not marks:
        return
    rid = auth.resource_id("stream", stream_id)
    _own, inherited = auth._item_row(rid)
    if not set(marks) <= set(inherited):
        auth._set_item(rid, inherited=sorted(set(inherited) | set(marks)))


def _narrow_after_reset(s: dict) -> None:
    """A reset clears every record: the markings recorded on the stream only because of records it held (batches of
    syncs since unmarked, retargeted or deleted) no longer protect any data — markings travel with the data they came
    from, and a SNAPSHOT-like replacement stops propagating what the old data carried. They narrow back to the
    current syncs' markings (which also still apply live, through the stream's inherited markings). Never narrower
    than a remaining record needs: nothing is narrowed when the new view already holds records (a sync wrote during
    the reset), nor for a pipeline's output stream (its markings come from the pipeline, auth.propagate). Markings
    applied by hand (its own) stay. The archive dataset keeps its earlier transactions' markings (stream_datasets)."""
    if (s.get("origin") or {}).get("pipeline_id"):
        return
    rid = auth.resource_id("stream", s["id"])
    keep: set[str] = set()
    for sid in _syncs_into(s["id"]):
        keep |= _sync_markings(sid)
    with _lock, _db() as con:  # appends take the same lock: no record lands between the check and the narrowing
        (n,) = con.execute("SELECT COUNT(*) FROM records WHERE stream_id = ? AND view_id = ?", (s["id"], s["view_id"])).fetchone()
        if n:
            return
        _own, inherited = auth._item_row(rid)
        if set(inherited) - keep:
            auth._set_item(rid, inherited=sorted(set(inherited) & keep))
    for r in list(_runners.values()):
        if r.sync.get("stream_id") == s["id"]:
            r.marked = set()  # its next batch records the sync's markings on the stream again


def _as_build(request: Optional[Request], op: str, stream_id: str) -> None:
    """The build runner reading an input stream or writing an output stream for a build (X-Bsai-Build): as the
    build's identity (the stream's markings, Viewer reads / Editor writes on its Project); refused with the reason."""
    import build_calls

    build_calls.enforce(request, (op, "ingest", stream_id, None))


def _public_stream(s: dict, counts: bool = True) -> dict:
    out = {k: v for k, v in s.items() if k != "token"}
    out.setdefault("keys", {"partition": [], "primary": None})
    if counts:
        with _db() as con:
            n, last = con.execute("SELECT COUNT(*), MAX(at) FROM records WHERE stream_id = ? AND view_id = ?", (s["id"], s["view_id"])).fetchone()
        out.update(records=n, last_record_at=last)
    out["push_path"] = f"/api/streaming/stream-proxy/streams/{s['id']}/views/{s['view_id']}/jsonRecords"
    return out


@router.get("/streams")
def list_streams() -> list[dict]:
    with _db() as con:
        rows = con.execute("SELECT record FROM streams").fetchall()
    visible = auth.visible_resources("stream", [json.loads(r) for (r,) in rows])
    return sorted((_public_stream(s) for s in visible), key=lambda s: s["created_at"], reverse=True)


@router.post("/streams")
def create_stream(req: StreamIn, request: Request = None) -> dict:  # type: ignore[assignment]
    return _create_stream(req, request)


def _create_stream(req: StreamIn, request: Optional[Request] = None, marks: Optional[set[str]] = None) -> dict:
    """A new stream; `marks` (a streaming sync's markings) are set on it under its fresh id before it is stored."""
    # a build creating its pipeline's output stream (X-Bsai-Build): an Editor of the pipeline, as the build's identity
    import build_calls

    if build_calls.build_of(request) is not None:
        pid = (req.origin or {}).get("pipeline_id")
        build_calls.enforce(request, ("write", "pipeline", pid, None) if pid else ("write", "folder", None, None))
    now = _iso()
    s = {
        "id": "stream-" + uuid.uuid4().hex[:12],
        "name": req.name.strip() or "Ingest stream",
        "schema": _check_schema(req.schema_),
        "throughput": req.throughput,
        "configuration": req.configuration,
        "keys": _check_keys(req.keys, _check_schema(req.schema_)),
        "origin": req.origin,
        "view_id": "view-" + uuid.uuid4().hex[:12],
        "views": [],
        "token": "stk_" + pysecrets.token_urlsafe(24),
        "created_at": now,
        "updated_at": now,
    }
    # a pipeline's output stream inherits the markings of the pipeline (and through it, of its inputs): set under its
    # fresh id before it is stored, so it is never listed or read unmarked
    if (req.origin or {}).get("pipeline_id"):
        auth.propagate(auth.resource_id("stream", s["id"]), [req.origin["pipeline_id"]])
    _mark_stream(s["id"], marks or set())
    _put("streams", s)
    return {**_public_stream(s), "token": s["token"]}


@router.get("/streams/{stream_id}")
def get_stream(stream_id: str, reveal_token: bool = False, request: Request = None) -> dict:  # type: ignore[assignment]
    s = _stream(stream_id)
    _as_build(request, "read", stream_id)
    out = _public_stream(s)
    if reveal_token:
        out["token"] = s["token"]
    with _db() as con:
        rows = con.execute("SELECT record FROM syncs").fetchall()
    out["syncs"] = [{"id": x["id"], "name": x["name"], "kind": x["kind"]} for x in (json.loads(r) for (r,) in rows) if x["stream_id"] == stream_id]
    return out


def _coerce(rec: dict, schema: list[dict]) -> dict:
    if not schema:
        return rec
    out = {}
    for col in schema:
        v = rec.get(col["name"])
        try:
            if v is None:
                pass
            elif col["type"] in ("Integer", "Long"):
                v = int(v)
            elif col["type"] in ("Double", "Decimal"):
                v = float(v)
            elif col["type"] == "Boolean":
                v = v if isinstance(v, bool) else str(v).lower() in ("true", "1", "yes")
            elif col["type"] == "String" and not isinstance(v, str):
                v = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
        except (TypeError, ValueError):
            raise HTTPException(400, f'"{col["name"]}" must be {col["type"]}: got {v!r}') from None
        out[col["name"]] = v
    # source metadata columns (_key, _timestamp, …) are kept alongside the schema
    out.update({k: v for k, v in rec.items() if k.startswith("_")})
    return out


def append(stream_id: str, records: list[dict], view_id: Optional[str] = None) -> int:
    """Append records to a stream's current view (or the given view, which must be current)."""
    s = _stream(stream_id)
    if view_id and view_id != s["view_id"]:
        raise HTTPException(409, f"View {view_id} was replaced by a stream reset: push to view {s['view_id']}")
    rows = [_coerce(r, s["schema"]) for r in records]
    at = _iso()
    with _lock, _db() as con:
        seq = con.execute("SELECT MAX(seq) FROM records WHERE stream_id = ? AND view_id = ?", (stream_id, s["view_id"])).fetchone()[0] or 0
        con.executemany(
            "INSERT INTO records (stream_id, view_id, seq, at, record) VALUES (?, ?, ?, ?, ?)",
            [(stream_id, s["view_id"], seq + i + 1, at, json.dumps(r, default=str)) for i, r in enumerate(rows)],
        )
    return seq + len(rows)


@router.post("/stream-proxy/streams/{stream_id}/views/{view_id}/jsonRecords")
def push(stream_id: str, view_id: str, body: Any = Body(...), authorization: str = Header("")) -> dict:
    """Push-based ingestion: one record ({"value": {...}} or a bare object) or a list of them."""
    s = _stream(stream_id)
    token = authorization.removeprefix("Bearer ").strip()
    if not pysecrets.compare_digest(token.encode(), s["token"].encode()):
        raise HTTPException(401, "Push with the stream's token: Authorization: Bearer <token>")
    items = body if isinstance(body, list) else [body]
    recs = []
    for r in items:
        if isinstance(r, dict) and set(r) == {"value"} and isinstance(r["value"], dict):
            r = r["value"]
        if not isinstance(r, dict):
            raise HTTPException(400, "Records are JSON objects")
        recs.append(r)
    last = append(stream_id, recs, view_id)
    return {"pushed": len(recs), "last_seq": last}


@router.put("/streams/{stream_id}/keys")
def set_keys(stream_id: str, req: KeysIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Set or remove the partition and primary keys (no reset needed: keys only change how consumers read)."""
    s = _stream(stream_id)
    _as_build(request, "write", stream_id)
    s["keys"] = _check_keys(req, s["schema"])
    s["updated_at"] = _iso()
    _put("streams", s)
    return _public_stream(s)


@router.post("/streams/{stream_id}/records")
def append_records(stream_id: str, records: list[dict] = Body(...), request: Request = None) -> dict:  # type: ignore[assignment]
    """Append records to the current view (pipeline output streams; clients push through the stream proxy)."""
    _as_build(request, "write", stream_id)
    items = [r["value"] if isinstance(r, dict) and set(r) == {"value"} and isinstance(r["value"], dict) else r for r in records]
    if any(not isinstance(r, dict) for r in items):
        raise HTTPException(400, "Records are JSON objects")
    return {"pushed": len(items), "last_seq": append(stream_id, items)}


def current_view(s: dict, recs: list[dict]) -> list[dict]:
    """CDC: the latest record per primary key, without keys whose latest record is deleted."""
    pk = (s.get("keys") or {}).get("primary")
    if not pk:
        return recs
    latest: dict[str, dict] = {}
    for r in recs:
        k = json.dumps([r.get(c) for c in pk["columns"]], default=str)
        latest.pop(k, None)
        latest[k] = r
    deleted = pk.get("deleted")
    return [r for r in latest.values() if not (deleted and str(r.get(deleted)).lower() in ("true", "1"))]


@router.get("/streams/{stream_id}/records")
def read_records(stream_id: str, after: int = 0, limit: int = 1000, view: Literal["changelog", "current"] = "changelog",
                 request: Request = None) -> dict:  # type: ignore[assignment]
    """The current view's records after a sequence number (the stream's live view). With view=current and a
    primary key, the deduplicated current view (latest record per key) instead of the changelog."""
    s = _stream(stream_id)
    _as_build(request, "read", stream_id)
    with _db() as con:
        if view == "current":
            rows = con.execute("SELECT seq, at, record FROM records WHERE stream_id = ? AND view_id = ? ORDER BY seq", (stream_id, s["view_id"])).fetchall()
        else:
            rows = con.execute(
                "SELECT seq, at, record FROM records WHERE stream_id = ? AND view_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (stream_id, s["view_id"], after, max(1, min(limit, 100_000))),
            ).fetchall()
    recs = [{**json.loads(r), "_seq": seq, "_at": at} for seq, at, r in rows]
    if view == "current":
        recs = current_view(s, recs)[-max(1, min(limit, 100_000)):]
    if s["schema"]:
        columns = list(s["schema"])
    else:
        names: list[str] = []
        for r in recs:
            names += [k for k in r if k not in names and not k.startswith("_")]
        columns = [{"name": n, "type": "String"} for n in names]
    meta = []
    for r in recs:
        meta += [k for k in r if k.startswith("_") and k not in ("_seq", "_at") and k not in meta]
    columns += [{"name": m, "type": "String"} for m in meta]
    return {
        "columns": columns,
        "rows": [{c["name"]: (r.get(c["name"]) if not isinstance(r.get(c["name"]), (dict, list)) else json.dumps(r.get(c["name"]))) for c in columns} for r in recs],
        "seqs": [r["_seq"] for r in recs],
        "last_seq": recs[-1]["_seq"] if recs else after,
        "view_id": s["view_id"],
    }


class ResetIn(BaseModel):
    schema_: Optional[list[ColumnIn]] = Field(None, alias="schema")
    throughput: Optional[Literal["normal", "high"]] = None
    configuration: Optional[dict[str, str]] = None
    model_config = {"populate_by_name": True}


@router.post("/streams/{stream_id}/reset")
def reset_stream(stream_id: str, req: ResetIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Clear the stream's records and start a new view, optionally with a new schema, throughput
    and configuration. Syncs into the stream restart (their checkpoints are kept) as their owners; one whose owner
    may no longer run it (e.g. lacks a marking on the stream) stays stopped, failed with the reason, and is listed in
    `not_restarted_syncs` — the reset itself is done. Recorded markings narrow back (_narrow_after_reset)."""
    s = _stream(stream_id)
    _as_build(request, "write", stream_id)
    old = s["view_id"]
    s["views"] = [*s.get("views", []), {"view_id": old, "replaced_at": _iso()}][-20:]
    s["view_id"] = "view-" + uuid.uuid4().hex[:12]
    if req.schema_ is not None:
        s["schema"] = _check_schema(req.schema_)
        # keys on columns the new schema dropped are dropped too
        names = {c["name"] for c in s["schema"]}
        k = s.get("keys") or {"partition": [], "primary": None}
        pk = k.get("primary")
        if pk and names and not (set(pk["columns"]) <= names):
            pk = None
        if pk and pk.get("deleted") and names and pk["deleted"] not in names:
            pk = {**pk, "deleted": None}
        s["keys"] = {"partition": [c for c in k.get("partition", []) if not names or c in names], "primary": pk}
    if req.throughput:
        s["throughput"] = req.throughput
    if req.configuration is not None:
        s["configuration"] = req.configuration
    s["updated_at"] = _iso()
    _put("streams", s)
    with _lock, _db() as con:
        con.execute("DELETE FROM records WHERE stream_id = ? AND view_id = ?", (stream_id, old))
    _narrow_after_reset(s)
    running = [sync_id for sync_id, r in list(_runners.items()) if r.sync["stream_id"] == stream_id]
    restarted, not_restarted = [], []
    for sync_id in running:
        _stop(sync_id)
        try:
            _start(sync_id)  # as its owner, who must still hold the sync's and the stream's markings
            restarted.append(sync_id)
        except OwnerBlocked as e:  # the reset is done: the sync stays stopped with the reason (as on startup)
            _set_status(sync_id, "failed", str(e.detail))
            not_restarted.append({"id": sync_id, "reason": str(e.detail)})
    return {**_public_stream(s), "previous_view_id": old, "restarted_syncs": restarted, "not_restarted_syncs": not_restarted}


@router.delete("/streams/{stream_id}")
def delete_stream(stream_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    _as_build(request, "write", stream_id)
    with _db() as con:
        users = [json.loads(r)["name"] for (r,) in con.execute("SELECT record FROM syncs").fetchall() if json.loads(r)["stream_id"] == stream_id]
    if users:
        raise HTTPException(409, f"Delete the streaming syncs into this stream first: {', '.join(users)}")
    with _lock, _db() as con:
        con.execute("DELETE FROM streams WHERE id = ?", (stream_id,))
        con.execute("DELETE FROM records WHERE stream_id = ?", (stream_id,))
    return {"deleted": stream_id}


# --------------------------------------------------------------------------------------------
# projects and profile references (Control Panel → Streaming profiles)
# --------------------------------------------------------------------------------------------


def projects() -> list[dict]:
    try:
        import db
        import drive

        drive.ensure_defaults()
        return [{"id": i["id"], "name": i["name"]} for i in db.drive_list(None) if i["kind"] == "project"]
    except Exception:
        return [{"id": "default", "name": "My Project"}]


def default_project() -> str:
    try:
        import db

        p = db.drive_by_system("project")
        if p:
            return p["id"]
    except Exception:
        pass
    return projects()[0]["id"]


def _refs() -> dict[str, list[str]]:
    with _db() as con:
        rows = con.execute("SELECT profile, project_id FROM profile_refs").fetchall()
    out: dict[str, list[str]] = {}
    for p, proj in rows:
        out.setdefault(p, []).append(proj)
    return out


def _import(profile: str, project_id: str) -> None:
    with _lock, _db() as con:
        con.execute("INSERT OR IGNORE INTO profile_refs (profile, project_id, created_at) VALUES (?, ?, ?)", (profile, project_id, _iso()))


def use_profiles(profiles: list[str], project_id: str, auto_import: bool = True) -> None:
    """Profiles must be Project references of the job's Project; the selector imports the
    unrestricted ones, restricted ones only Control Panel can import."""
    refs = _refs()
    for p in profiles or []:
        if p not in PROFILES:
            raise HTTPException(400, f'Unknown streaming profile "{p}"')
        if project_id in refs.get(p, []):
            continue
        if PROFILES[p]["restricted"] or not auto_import:
            raise HTTPException(
                403,
                f'Streaming profile "{PROFILES[p]["name"]}" is not imported into this Project. '
                + ("An enrollment resource administrator must import it in Control Panel → Streaming profiles." if PROFILES[p]["restricted"] else "Import it first."),
            )
        _import(p, project_id)


@router.get("/profiles")
def list_profiles() -> dict:
    refs = _refs()
    names = {p["id"]: p["name"] for p in projects()}
    return {
        "defaults": DEFAULTS,
        "profiles": [
            {"id": pid, **{k: v for k, v in p.items()}, "projects": [{"id": x, "name": names.get(x, x)} for x in refs.get(pid, [])]}
            for pid, p in PROFILES.items()
        ],
        "projects": projects(),
        "default_project": default_project(),
    }


class RefIn(BaseModel):
    project_id: str
    # Control Panel (enrollment resource administrators) may import restricted profiles
    control_panel: bool = False


@router.post("/profiles/{profile}/references")
def add_reference(profile: str, req: RefIn) -> dict:
    if profile not in PROFILES:
        raise HTTPException(404, "Unknown streaming profile")
    if PROFILES[profile]["restricted"] and not req.control_panel:
        raise HTTPException(403, "Restricted profiles are imported only from Control Panel by an enrollment resource administrator")
    if req.project_id not in {p["id"] for p in projects()}:
        raise HTTPException(404, "Project not found")
    _import(profile, req.project_id)
    return list_profiles()


@router.delete("/profiles/{profile}/references/{project_id}")
def remove_reference(profile: str, project_id: str) -> dict:
    """Removing a reference breaks streaming jobs of that Project that use the profile: they stop."""
    with _lock, _db() as con:
        con.execute("DELETE FROM profile_refs WHERE profile = ? AND project_id = ?", (profile, project_id))
    for sync_id, r in list(_runners.items()):
        if profile in r.sync.get("profiles", []) and r.sync.get("project_id") == project_id:
            _stop(sync_id)
            _set_status(sync_id, "failed", f'Streaming profile "{PROFILES[profile]["name"]}" was removed from the Project')
    return list_profiles()


class ProfileCheck(BaseModel):
    profiles: list[str]
    project_id: Optional[str] = None
    advanced: dict = Field(default_factory=dict)


@router.post("/profiles/resolve")
def resolve_profiles(req: ProfileCheck) -> dict:
    """For a streaming job (Pipeline Builder deploy, a sync): import the profiles into the Project
    and return the composed settings."""
    project = req.project_id or default_project()
    use_profiles(req.profiles, project)
    return {"project_id": project, "settings": compose(req.profiles, req.advanced)}


# --------------------------------------------------------------------------------------------
# streaming syncs (Data Connection → Set up a streaming sync)
# --------------------------------------------------------------------------------------------

SECRET_FIELDS = {"password", "secret_access_key", "session_token", "service_account", "access_token", "ca_pem"}
KINDS = list(sources.SOURCES)


class SyncIn(BaseModel):
    name: str
    kind: Literal["kafka", "kinesis", "sqs", "pubsub", "pi", "mqtt", "rabbitmq", "ibmmq"]
    config: dict[str, Any] = Field(default_factory=dict)
    stream_id: Optional[str] = None
    new_stream_name: Optional[str] = None
    profiles: list[str] = Field(default_factory=lambda: ["default"])
    advanced: dict = Field(default_factory=dict)
    project_id: Optional[str] = None
    start: bool = True
    # markings for the sync (its source connection): set before it exists, so it and its stream are marked from the
    # first record (the caller must hold them and be allowed to apply them)
    markings: list[str] = Field(default_factory=list)


def _split_secrets(config: dict) -> tuple[dict, dict]:
    pub = {k: v for k, v in config.items() if k not in SECRET_FIELDS}
    sec = {k: v for k, v in config.items() if k in SECRET_FIELDS and v}
    return pub, sec


def _sync_row(sync_id: str) -> tuple[dict, dict, dict]:
    with _db() as con:
        row = con.execute("SELECT record, secret, state FROM syncs WHERE id = ?", (sync_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Streaming sync not found")
    auth.check_resource("stream_sync", sync_id)
    return json.loads(row[0]), _unseal(row[1]), json.loads(row[2] or "{}")


def _save_state(sync_id: str, state: dict) -> None:
    with _lock, _db() as con:
        con.execute("UPDATE syncs SET state = ? WHERE id = ?", (json.dumps(state), sync_id))


def _set_status(sync_id: str, status: str, error: Optional[str] = None, **extra: Any) -> None:
    with _lock:
        rec, _, _ = _sync_row(sync_id)
        if rec.get("status") != status or (error and rec.get("error") != error):
            # the job history of Dataset Preview's Stream tab
            import stream_datasets

            stream_datasets.job_event(rec, status, error)
        rec.update(status=status, error=error, updated_at=_iso(), **extra)
        with _db() as con:
            con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), sync_id))


def _bump(sync_id: str, **add: Any) -> None:
    """Add to this minute's metrics (lag replaces, cp_ms_max keeps the largest)."""
    m = _minute()
    with _lock, _db() as con:
        con.execute("INSERT OR IGNORE INTO metrics (sync_id, minute) VALUES (?, ?)", (sync_id, m))
        sets, vals = [], []
        for k, v in add.items():
            if k == "lag":
                sets.append("lag = ?")
            elif k == "cp_ms_max":
                sets.append("cp_ms_max = MAX(cp_ms_max, ?)")
            else:
                sets.append(f"{k} = {k} + ?")
            vals.append(v)
        if sets:
            con.execute(f"UPDATE metrics SET {', '.join(sets)} WHERE sync_id = ? AND minute = ?", (*vals, sync_id, m))


OWNER_RECHECK_S = 30  # a running job re-reads its owner's markings this often


class OwnerBlocked(HTTPException):
    """The sync's job may not run as its owner (gone, deactivated, lost a marking): 403 with the reason."""

    def __init__(self, reason: str):
        super().__init__(403, reason)


def _owner_block(rec: dict, p: Optional[dict], who: str) -> Optional[str]:
    """Why the job may not act as `p`: it reads the sync's settings and writes its stream, so `p` must hold the
    markings of both (None: it may)."""
    if not auth.enabled() or p is None or p.get("service"):
        return None
    for kind, rid, what in (("stream_sync", rec["id"], "the streaming sync"), ("stream", rec.get("stream_id"), "its stream")):
        if not rid:
            continue
        missing = sorted(auth.missing_markings(auth.resource_effective(kind, rid), p.get("markings")))
        if missing:
            names = auth._marking_names(missing)
            return f"the marking{'s' if len(names) > 1 else ''} {', '.join(names)} on {what} {'are' if len(names) > 1 else 'is'} not held by {who}"
    return None


def _owner_principal(rec: dict) -> Optional[dict]:
    """The principal a sync's job acts as — its owner, with their current markings (None with sign-in off). Raises
    OwnerBlocked when the owner is missing, deleted, deactivated or lacks a marking of the sync or its stream."""
    import run_as

    try:
        p = run_as.owner_principal(rec.get("owner"), "the streaming sync")
    except run_as.OwnerUnavailable as e:
        raise OwnerBlocked(f"did not run: {e} (for a streaming sync: start it, which makes you its owner)") from None
    why = _owner_block(rec, p, f"the streaming sync's owner {run_as.who(rec.get('owner'))}")
    if why:
        raise OwnerBlocked(f"did not run: {why} (a user holding the markings must start it again: it then runs as them)")
    return p


class Runner:
    """One streaming sync job: `parallelism` consumer threads (poll → write → checkpoint), acting as the sync's owner."""

    def __init__(self, sync: dict, secrets: dict, principal: Optional[dict] = None):
        self.sync, self.secrets = sync, secrets
        self.principal = principal  # the owner (None: sign-in off); every thread acts as them
        self.marked: set[str] = set()  # the sync's markings last recorded on its stream
        self.checked = time.monotonic()
        self.settings = compose(sync.get("profiles", []), sync.get("advanced"))
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []
        # sources whose position lives in our state (one consumer) vs. consumer groups / queues
        n = self.settings["parallelism"] if sync["kind"] in ("kafka", "sqs", "pubsub", "rabbitmq") else 1
        for i in range(n):
            t = threading.Thread(target=self._run, args=(i,), daemon=True, name=f"streaming-{sync['id']}-{i}")
            self.threads.append(t)
        self.lease: Optional[str] = None
        self.queue_thread = threading.Thread(target=self._lease_then_run, daemon=True, name=f"streaming-{sync['id']}-queue")

    def start(self) -> None:
        self.queue_thread.start()

    def _lease_then_run(self) -> None:
        """Room in the Project's resource queue first (resource_queues.py: one vCPU per consumer, held while the sync
        runs, released when it stops); the sync shows "queued" with the queue while it waits."""
        import resource_queues

        auth._principal.set(self.principal)  # a new thread starts without one: the queue lease is the owner's
        sid = self.sync["id"]
        vcpus = len(self.threads)

        def on_wait(lease: dict) -> None:
            msg = (f"Waiting in the Project's resource queue {lease['queue_name']} ({lease['in_use']}/{lease['vcpu_limit']} vCPUs in use, "
                   f"{lease['ahead']} job{'' if lease['ahead'] == 1 else 's'} ahead; this sync needs {vcpus})")
            _set_status(sid, "queued", None, queue={"name": lease["queue_name"], "ahead": lease["ahead"], "in_use": lease["in_use"],
                                                    "vcpu_limit": lease["vcpu_limit"], "vcpus": vcpus, "message": msg})

        try:
            lease = resource_queues.acquire(None, vcpus, f"{self.sync['name']} · streaming sync", "stream_sync", on_wait, self.stop.is_set,
                                            holder=f"stream_sync:{sid}", project_id=self.sync.get("project_id") or None)
        except Exception as e:  # noqa: BLE001
            if not self.stop.is_set():
                _set_status(sid, "failed", f"Resource queue: {_msg(e)}")
            return
        if lease is None:
            return  # stopped while it waited
        self.lease = lease
        if self.stop.is_set():
            self.release()
            return
        try:
            _set_status(sid, "starting", None, queue=None)
        except Exception:  # noqa: BLE001 - the sync was deleted meanwhile
            self.release()
            return
        for t in self.threads:
            t.start()

    def release(self) -> None:
        import resource_queues

        lease, self.lease = self.lease, None
        resource_queues.release(lease)

    def _act(self) -> bool:
        """This thread acts as the sync's owner with their current markings. False when the owner may no longer run
        it: the job is halted and the sync fails with the reason (recorded by the platform)."""
        if not auth.enabled():
            auth._principal.set(None)
            return True
        try:
            p = _owner_principal(self.sync)
        except OwnerBlocked as e:
            self._halt("stopped: " + str(e.detail).removeprefix("did not run: "))
            return False
        auth._principal.set(p)
        return True

    def _mark_stream(self) -> None:
        """Before records are written: the stream keeps the sync's current markings for good (they already apply
        through the stream's inherited markings; recorded so the records keep them after the sync changes)."""
        marks = _sync_markings(self.sync["id"])
        if marks != self.marked:
            _mark_stream(self.sync["stream_id"], marks)
            self.marked = marks

    def _halt(self, reason: str) -> None:
        auth._principal.set(None)
        sid = self.sync["id"]
        self.stop.set()
        with _lock:
            mine = _runners.get(sid) is self
            if mine:
                _runners.pop(sid, None)
        if not mine:
            return  # stopped meanwhile, or another consumer halted it
        log.warning("streaming sync %s: %s", sid, reason)
        try:
            _set_status(sid, "failed", reason)
        except Exception:  # noqa: BLE001 - deleted meanwhile
            pass
        self.release()

    def _run(self, idx: int) -> None:
        sid = self.sync["id"]
        cfg = self.settings
        failures = 0
        while not self.stop.is_set():
            src = None
            if not self._act():
                return
            acted = time.monotonic()
            try:
                _, _, state = _sync_row(sid)
                src = sources.SOURCES[self.sync["kind"]](self.sync["config"], self.secrets, cfg, state)
                if idx == 0:
                    _set_status(sid, "running", None, started_at=_iso())
                last_cp = time.monotonic()
                last_lag = 0.0
                while not self.stop.is_set():
                    if time.monotonic() - acted >= OWNER_RECHECK_S:
                        if not self._act():
                            return  # the owner lost access: nothing more is read or written
                        acted = time.monotonic()
                    t0 = time.monotonic()
                    try:
                        msgs = src.poll(cfg["batch_records"], cfg["poll_timeout_s"])
                    except Exception as e:
                        self.sync["trigger_failures"] = self.sync.get("trigger_failures", 0) + 1
                        _set_status(sid, "retrying", f"Poll failed: {_msg(e)}", trigger_failures=self.sync["trigger_failures"])
                        raise
                    keep = [m for m in msgs if m.size <= cfg["max_record_bytes"]]
                    dropped = len(msgs) - len(keep)
                    if keep:
                        self._mark_stream()
                        append(self.sync["stream_id"], [m.record for m in keep])
                    due = time.monotonic() - last_cp >= cfg["checkpoint_interval_s"]
                    if msgs or due:
                        c0 = time.monotonic()
                        try:
                            src.checkpoint(msgs)
                            _save_state(sid, src.state)
                        except Exception as e:
                            _bump(sid, cp_failures=1)
                            self.sync["cp_failures_in_a_row"] = self.sync.get("cp_failures_in_a_row", 0) + 1
                            _set_status(sid, "retrying", f"Checkpoint failed: {_msg(e)}", cp_failures_in_a_row=self.sync["cp_failures_in_a_row"])
                            raise
                        ms = int((time.monotonic() - c0) * 1000)
                        last_cp = time.monotonic()
                        self.sync.update(cp_failures_in_a_row=0, trigger_failures=0)
                        _bump(sid, checkpoints=1, cp_ms_max=ms)
                        _set_status(sid, "running", None, last_checkpoint_at=_iso(), last_checkpoint_ms=ms, last_checkpoint_records=len(msgs),
                                    cp_failures_in_a_row=0, trigger_failures=0)
                    busy = int((time.monotonic() - t0) * 1000) if msgs else 0
                    _bump(sid, records=len(keep), bytes=sum(m.size for m in keep), dropped=dropped, busy_ms=busy)
                    if idx == 0 and time.monotonic() - last_lag > 30:
                        lag = src.lag()
                        if lag is not None:
                            _bump(sid, lag=lag)
                        last_lag = time.monotonic()
                    failures = 0
            except Exception as e:  # noqa: BLE001 - the job retries; the error is shown on the sync
                failures += 1
                if not self.stop.is_set():
                    log.warning("streaming sync %s: %s", sid, _msg(e))
                    try:
                        _set_status(sid, "retrying", _msg(e))
                    except Exception:
                        pass
                    self.stop.wait(min(60, 2 ** min(failures, 6)))
            finally:
                if src is not None:
                    src.close()


def _msg(e: BaseException) -> str:
    from connectors.base import scrub

    return scrub(f"{type(e).__name__}: {e}" if not isinstance(e, (sources.SourceError, HTTPException)) else str(getattr(e, "detail", e)), {})[:400]


_runners: dict[str, Runner] = {}


def _start(sync_id: str, take_over: bool = False) -> None:
    """Start the sync's job, acting as its owner. `take_over` (a user creating or starting it): the signed-in user
    becomes the owner. OwnerBlocked (403, the reason) when the owner may not run it: nothing is started."""
    with _lock:
        if sync_id in _runners:
            return
        rec, secrets, _ = _sync_row(sync_id)
        if take_over and auth.actor_id():
            rec["owner"] = auth.actor_id()
        principal = _owner_principal(rec)
        use_profiles(rec.get("profiles", []), rec.get("project_id") or default_project(), auto_import=False)
        r = Runner(rec, secrets, principal)
        _runners[sync_id] = r
        rec.update(desired="running", status="starting", error=None, updated_at=_iso())
        with _db() as con:
            con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), sync_id))
    import stream_datasets

    stream_datasets.job_event(rec, "starting", None)
    r.start()


def _stop(sync_id: str) -> None:
    with _lock:
        r = _runners.pop(sync_id, None)
    if r:
        r.stop.set()
        r.queue_thread.join(timeout=15)
        for t in r.threads:
            if t.ident is not None:  # never started when the sync was stopped while it waited in the resource queue
                t.join(timeout=15)
        r.release()


def _public_sync(rec: dict) -> dict:
    out = dict(rec)
    out["settings"] = compose(rec.get("profiles", []), rec.get("advanced"))
    with _db() as con:
        since = _minute(_now() - timedelta(minutes=5))
        n, lag = con.execute("SELECT SUM(records), (SELECT lag FROM metrics WHERE sync_id = ? AND lag IS NOT NULL ORDER BY minute DESC LIMIT 1) FROM metrics WHERE sync_id = ? AND minute >= ?",
                             (rec["id"], rec["id"], since)).fetchone()
    out["records_5m"], out["lag"] = n or 0, lag
    out["running"] = rec["id"] in _runners
    return out


@router.get("/syncs")
def list_syncs() -> list[dict]:
    with _db() as con:
        rows = con.execute("SELECT record FROM syncs").fetchall()
    visible = auth.visible_resources("stream_sync", [json.loads(r) for (r,) in rows])
    return sorted((_public_sync(s) for s in visible), key=lambda s: s["created_at"], reverse=True)


def _check_sync_markings(markings: list[str]) -> set[str]:
    """Markings a new sync is created with: known (400), the caller may apply them (403) and holds them — its job
    runs as them (403). Sign-in off: markings are not enforced, nothing is set."""
    marks = {m for m in markings if m}
    if not marks or not auth.enabled():
        return set()
    if marks - auth._known_markings():
        raise HTTPException(400, "Unknown marking")
    p = auth.current()
    auth.check_marking_change(auth.resource_id("stream_sync", "new"), marks, set(), p)
    if p is not None and not p.get("service"):
        missing = sorted(auth.missing_markings(marks, p.get("markings")))
        if missing:
            raise HTTPException(403, f"You do not hold the marking{'s' if len(missing) > 1 else ''} {', '.join(auth._marking_names(missing))}: "
                                     "the sync runs as you")
    return marks


@router.post("/syncs")
def create_sync(req: SyncIn) -> dict:
    project = req.project_id or default_project()
    use_profiles(req.profiles, project)  # the profile selector imports unrestricted profiles
    compose(req.profiles, req.advanced)
    marks = _check_sync_markings(req.markings)
    sync_id = "sync-" + uuid.uuid4().hex[:12]
    if marks:
        # the sync is marked under its fresh id before it exists; its stream carries the markings before it is stored
        auth._set_item(auth.resource_id("stream_sync", sync_id), own=sorted(marks))
    try:
        if req.stream_id:
            _stream(req.stream_id)
            stream_id = req.stream_id
            _mark_stream(stream_id, marks)
        else:
            stream_id = _create_stream(StreamIn(name=req.new_stream_name or req.name, schema=[]), None, marks)["id"]
    except BaseException:
        if marks:
            auth._set_item(auth.resource_id("stream_sync", sync_id), own=[], inherited=[])
        raise
    pub, sec = _split_secrets(req.config)
    now = _iso()
    rec = {
        "id": sync_id,
        "name": req.name.strip() or f"{req.kind} sync",
        "kind": req.kind,
        "config": pub,
        "secrets_set": sorted(sec),
        "stream_id": stream_id,
        "profiles": req.profiles or ["default"],
        "advanced": req.advanced,
        "project_id": project,
        "owner": auth.actor_id(),  # its job acts as them (the creator, then whoever starts it)
        "status": "stopped",
        "desired": "stopped",
        "created_at": now,
        "updated_at": now,
    }
    _put("syncs", rec, {"secret": _seal(sec), "state": "{}"})
    if req.start:
        _start(rec["id"], take_over=True)
    return _public_sync(_sync_row(rec["id"])[0])


@router.get("/syncs/{sync_id}")
def get_sync(sync_id: str) -> dict:
    rec, _, state = _sync_row(sync_id)
    return {**_public_sync(rec), "checkpoint": state}


@router.post("/syncs/{sync_id}/start")
def start_sync(sync_id: str) -> dict:
    _start(sync_id, take_over=True)  # starting it makes the user its owner (the job then acts as them)
    return get_sync(sync_id)


@router.post("/syncs/{sync_id}/stop")
def stop_sync(sync_id: str) -> dict:
    _stop(sync_id)
    rec, _, _ = _sync_row(sync_id)
    rec.update(desired="stopped", status="stopped", updated_at=_iso())
    with _lock, _db() as con:
        con.execute("UPDATE syncs SET record = ? WHERE id = ?", (json.dumps(rec), sync_id))
    import stream_datasets

    stream_datasets.job_event(rec, "stopped", None)
    return get_sync(sync_id)


@router.post("/syncs/{sync_id}/reset-checkpoint")
def reset_checkpoint(sync_id: str) -> dict:
    """Forget the stored position (Kinesis sequence numbers, PI times): read from the start setting."""
    running = sync_id in _runners
    _stop(sync_id)
    _save_state(sync_id, {})
    if running:
        _start(sync_id)
    return get_sync(sync_id)


@router.delete("/syncs/{sync_id}")
def delete_sync(sync_id: str) -> dict:
    try:
        rec, _, _ = _sync_row(sync_id)
    except HTTPException as e:
        if e.status_code != 404:
            raise
        rec = None
    _stop(sync_id)
    if rec:
        _mark_stream(rec.get("stream_id"), _sync_markings(sync_id))  # what it wrote stays marked without it
    with _lock, _db() as con:
        con.execute("DELETE FROM syncs WHERE id = ?", (sync_id,))
        con.execute("DELETE FROM metrics WHERE sync_id = ?", (sync_id,))
    return {"deleted": sync_id}


@router.get("/syncs/{sync_id}/metrics")
def sync_metrics(sync_id: str, minutes: int = 60) -> list[dict]:
    since = _minute(_now() - timedelta(minutes=max(1, min(minutes, 24 * 60))))
    with _db() as con:
        rows = con.execute("SELECT minute, records, bytes, checkpoints, cp_failures, cp_ms_max, busy_ms, dropped, lag FROM metrics WHERE sync_id = ? AND minute >= ? ORDER BY minute",
                           (sync_id, since)).fetchall()
    keys = ["minute", "records", "bytes", "checkpoints", "cp_failures", "cp_ms_max", "busy_ms", "dropped", "lag"]
    return [dict(zip(keys, r)) for r in rows]


# --------------------------------------------------------------------------------------------
# stream monitoring (Data Health → Monitoring Views)
# --------------------------------------------------------------------------------------------

RULES = {
    # rule: (resource types, unit, description)
    "records_ingested": (("stream", "sync"), "records", "Records ingested in the window at or below the threshold"),
    "checkpoint_liveness": (("sync",), "minutes", "No checkpoint for longer than the threshold"),
    "last_checkpoint_duration": (("sync",), "seconds", "Last checkpoint took longer than the threshold"),
    "checkpoint_trigger_failures": (("sync",), "failures", "Checkpoints failed to trigger this many times in a row"),
    "consecutive_checkpoint_failures": (("sync",), "failures", "Checkpoints failed this many times in a row"),
    "total_lag": (("sync",), "records / ms", "The job is behind its input by more than the threshold"),
    "total_throughput": (("sync",), "records per checkpoint", "Records per checkpoint below the threshold (or above the maximum)"),
    "utilization": (("sync",), "%", "Utilized capacity above the threshold"),
    # output monitors (timeseries.py): what a pipeline wrote into user-facing time series and geotemporal series
    "points_written": (("timeseries_sync",), "points", "Points written to the Time Series DB in the window at or below the threshold"),
    "geotemporal_observations_sent": (("geotemporal",), "observations", "Geotemporal observations sent in the window at or below the threshold"),
}
OUTPUT_RESOURCES = ("timeseries_sync", "geotemporal")
# dataset checks and schedule checks (health_checks.py) sit in the same monitoring views
import health_checks  # noqa: E402

RULES.update({k: ((v[0],), v[1], v[2]) for k, v in health_checks.CHECKS.items()})
SEVERITIES = ("low", "medium", "high", "critical")
PAGERDUTY_SEVERITY = {"low": "info", "medium": "warning", "high": "error", "critical": "critical"}


class ViewIn(BaseModel):
    name: str
    description: str = ""


class MonitorIn(BaseModel):
    name: str = ""
    # stream / sync monitors; dataset checks, schedule checks (resource id "pipeline id/schedule id") and
    # Data Connection sync checks (resource id "source:<id>" or "export:<id>")
    # output monitors: "timeseries_sync" (a time series sync) and "geotemporal" (a geotemporal series sync's observations)
    resource_type: Literal["stream", "sync", "dataset", "schedule", "dc_sync", "timeseries_sync", "geotemporal"]
    resource_id: str
    rule: str
    window_minutes: Literal[5, 30] = 5
    threshold: float = 0
    threshold_max: Optional[float] = None
    severity: Literal["low", "medium", "high", "critical"] = "medium"
    enabled: bool = True
    # check settings beyond the threshold: required columns, expected schema and mode, ignore empty transactions
    config: dict[str, Any] = Field(default_factory=dict)
    # resolve the alert when the check passes again; off: it stays open until resolved by hand
    auto_resolve: bool = True


class SubscriptionIn(BaseModel):
    kind: Literal["email", "pagerduty", "webhook"]
    name: str = ""
    target: str  # email address, PagerDuty integration (routing) key, or webhook URL
    severities: list[Literal["low", "medium", "high", "critical"]] = Field(default_factory=lambda: list(SEVERITIES))
    # immediate: one notification per alert; hourly / daily: alerts are collected and sent as one digest
    # (email and webhook; PagerDuty is always immediate)
    frequency: Literal["immediate", "hourly", "daily"] = "immediate"
    # daily digests go out at this hour in digest_timezone
    digest_hour: int = Field(8, ge=0, le=23)
    digest_timezone: str = "UTC"
    # also notify when an alert resolves
    notify_resolved: bool = True


class SubscriptionChange(BaseModel):
    name: Optional[str] = None
    severities: Optional[list[Literal["low", "medium", "high", "critical"]]] = None
    frequency: Optional[Literal["immediate", "hourly", "daily"]] = None
    digest_hour: Optional[int] = Field(None, ge=0, le=23)
    digest_timezone: Optional[str] = None
    notify_resolved: Optional[bool] = None


def _check_delivery(kind: str, frequency: str, tz: str) -> None:
    if kind == "pagerduty" and frequency != "immediate":
        raise HTTPException(400, "PagerDuty subscriptions are always immediate: PagerDuty groups incidents itself")
    try:
        ZoneInfo(tz or "UTC")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Unknown time zone {tz}") from e


def _rows(table: str, view_id: Optional[str] = None) -> list[dict]:
    with _db() as con:
        q = f"SELECT record FROM {table}" + (" WHERE view_id = ?" if view_id else "")
        return [json.loads(r) for (r,) in con.execute(q, (view_id,) if view_id else ()).fetchall()]


def _rows_by_id(table: str, rid: str) -> Optional[dict]:
    with _db() as con:
        row = con.execute(f"SELECT record FROM {table} WHERE id = ?", (rid,)).fetchone()
    return json.loads(row[0]) if row else None


@router.get("/monitoring/rules")
def rules() -> dict:
    return {"rules": [{"id": k, "resource_types": list(v[0]), "unit": v[1], "description": v[2]} for k, v in RULES.items()], "severities": list(SEVERITIES)}


@router.get("/monitoring/views")
def list_views() -> list[dict]:
    out = []
    for v in _rows("views"):
        mons = [m for m in _rows("monitors", v["id"]) if _monitor_visible(m)]
        out.append({**v, "monitors": len(mons), "firing": sum(1 for m in mons if m.get("state") == "firing")})
    return sorted(out, key=lambda v: v["created_at"])


@router.post("/monitoring/views")
def create_view(req: ViewIn) -> dict:
    v = {"id": "mv-" + uuid.uuid4().hex[:10], "name": req.name.strip() or "Monitoring view", "description": req.description, "created_at": _iso(),
         "owner": auth.actor_id()}  # monitors without an owner of their own are evaluated as them
    _put("views", v)
    return v


@router.get("/monitoring/views/{view_id}")
def get_view(view_id: str) -> dict:
    v = _get("views", view_id, "Monitoring view")
    subs = []
    with _db() as con:
        sub_rows = [json.loads(r) for (r,) in con.execute("SELECT record FROM subscriptions WHERE view_id = ?", (view_id,)).fetchall()]
        alerts = [json.loads(r) for (r,) in con.execute("SELECT record FROM alerts WHERE view_id = ? ORDER BY fired_at DESC LIMIT 200", (view_id,)).fetchall()]
    subs = [_public_sub(s) for s in sub_rows]
    mons = [m for m in _rows("monitors", view_id) if _monitor_visible(m)]
    shown = {m["id"] for m in mons}
    return {**v, "monitors": [_public_monitor(m) for m in mons], "subscriptions": subs,
            "alerts": [a for a in alerts if not a.get("monitor_id") or a["monitor_id"] in shown]}


def _monitor_visible(m: dict) -> bool:
    """Monitors of streams, syncs and datasets the caller lacks the markings of are left out of a view."""
    kind, rid = m.get("resource_type"), str(m.get("resource_id") or "")
    if kind == "stream":
        return bool(auth.visible_resources("stream", [{"id": rid}]))
    if kind == "sync":
        return bool(auth.visible_resources("stream_sync", [{"id": rid}]))
    if kind == "dataset":
        return auth.can_access(rid)
    return True


# A monitor is evaluated as its owner (the user who created or last saved it; else its view's creator) — never as the
# system with sign-in on (run_as.py): the owner must be active and still see the monitored resource (its markings and
# Project role). Otherwise the monitor is "blocked" with the reason: nothing is measured, no alert opens or resolves
# and no subscription is notified, until a user who can see the resource saves it again.
_RESOURCE_WHAT = {"stream": "the stream", "sync": "the streaming sync", "dataset": "the dataset", "schedule": "the schedule's pipeline",
                  "dc_sync": "the Data Connection sync", "timeseries_sync": "the time series sync", "geotemporal": "the geotemporal series sync"}


def _monitor_block(m: dict, who: str) -> Optional[str]:
    """Why the current principal may not evaluate the monitor (None: it may). Only access is checked: nothing is read."""
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return None
    import run_as

    kind, rid = m.get("resource_type"), str(m.get("resource_id") or "")
    what = _RESOURCE_WHAT.get(kind, "the monitored resource")
    try:
        if kind in ("stream", "sync"):
            res = "stream" if kind == "stream" else "stream_sync"
            auth.check_resource(res, rid)
            if not auth.visible_resources(res, [{"id": rid}]):
                return f"{who} has no role on the Project of {what}"
        elif kind in ("dataset", "schedule"):
            item = rid if kind == "dataset" else rid.split("/", 1)[0]
            if not auth.can_access(item, p):
                missing = run_as.missing_marking_names(item, p)
                return (f"{who} does not hold the marking{'s' if len(missing) > 1 else ''} {', '.join(missing)} of {what}" if missing
                        else f"{who} has no role that reads {what}")
        elif kind == "dc_sync":
            health_checks._visible_sync(rid)
        elif kind in OUTPUT_RESOURCES:
            timeseries.check_sync(rid)
    except HTTPException as e:
        if e.status_code == 404 and kind in ("stream", "sync"):
            return None  # deleted: the evaluation skips it as before
        return f"{who} cannot see {what} ({e.detail})"
    return None


def _monitor_principal(m: dict, views: dict[str, dict]) -> tuple[Optional[dict], str]:
    """(the principal a monitor is evaluated as, their label); run_as.OwnerUnavailable when there is none."""
    import run_as

    uid = m.get("owner") or (views.get(m.get("view_id")) or {}).get("owner")
    return run_as.owner_principal(uid, "the monitor"), f"the monitor's owner {run_as.who(uid)}"


def _take_monitor(m: dict) -> None:
    """A signed-in user saving a monitor becomes its owner: they must be able to see what it monitors (403)."""
    uid = auth.actor_id()
    if not uid:
        return
    why = _monitor_block(m, "you")
    if why:
        raise HTTPException(403, f"You cannot save this monitor (it is evaluated as you): {why}")
    m["owner"] = uid


@router.delete("/monitoring/views/{view_id}")
def delete_view(view_id: str) -> dict:
    with _lock, _db() as con:
        for t in ("views",):
            con.execute(f"DELETE FROM {t} WHERE id = ?", (view_id,))
        for t in ("monitors", "subscriptions", "alerts"):
            con.execute(f"DELETE FROM {t} WHERE view_id = ?", (view_id,))
    return {"deleted": view_id}


def _resource_name(kind: str, rid: str) -> str:
    if kind in ("dataset", "schedule", "dc_sync"):
        return health_checks.resource_name(kind, rid)
    if kind in OUTPUT_RESOURCES:
        return timeseries.resource_name(rid)
    try:
        return (_stream(rid) if kind == "stream" else _sync_row(rid)[0])["name"]
    except HTTPException:
        return f"(deleted {kind})"


def _public_monitor(m: dict) -> dict:
    return {**m, "resource_name": _resource_name(m["resource_type"], m["resource_id"])}


@router.post("/monitoring/views/{view_id}/monitors")
def create_monitor(view_id: str, req: MonitorIn) -> dict:
    _get("views", view_id, "Monitoring view")
    if req.rule not in RULES:
        raise HTTPException(400, f"Unknown monitoring rule {req.rule}")
    if req.resource_type not in RULES[req.rule][0]:
        raise HTTPException(400, f"The {req.rule} monitor is for {' and '.join(RULES[req.rule][0])} resources")
    if req.resource_type in ("dataset", "schedule", "dc_sync"):
        if _resource_name(req.resource_type, req.resource_id).startswith("(deleted"):
            raise HTTPException(404, f"{'Sync' if req.resource_type == 'dc_sync' else req.resource_type.capitalize()} not found")
    elif req.resource_type in OUTPUT_RESOURCES:
        want = "timeseries" if req.resource_type == "timeseries_sync" else "geotemporal"
        if timeseries.kind_of(req.resource_id) != want:
            raise HTTPException(400, "Pick a time series sync" if want == "timeseries" else "Pick a geotemporal series sync (its observations)")
    else:
        (_stream if req.resource_type == "stream" else _sync_row)(req.resource_id)
    m = {"id": "mon-" + uuid.uuid4().hex[:10], "view_id": view_id, **req.model_dump(), "state": "ok", "value": None, "checked_at": None, "created_at": _iso()}
    m["name"] = m["name"] or f"{req.rule.replace('_', ' ').capitalize()} · {_resource_name(req.resource_type, req.resource_id)}"
    _take_monitor(m)
    _put("monitors", m, {"view_id": view_id})
    return _public_monitor(m)


@router.put("/monitoring/monitors/{monitor_id}")
def update_monitor(monitor_id: str, req: MonitorIn) -> dict:
    m = _get("monitors", monitor_id, "Monitor")
    if not _monitor_visible(m):
        raise HTTPException(404, "Monitor not found")
    m.update(req.model_dump(exclude={"name"}), name=req.name or m["name"])
    _take_monitor(m)
    m.pop("blocked", None)  # evaluated as the saver from the next check
    _put("monitors", m, {"view_id": m["view_id"]})
    return _public_monitor(m)


@router.delete("/monitoring/monitors/{monitor_id}")
def delete_monitor(monitor_id: str) -> dict:
    found = _rows_by_id("monitors", monitor_id)
    if found and not _monitor_visible(found):
        raise HTTPException(404, "Monitor not found")
    with _lock, _db() as con:
        con.execute("DELETE FROM monitors WHERE id = ?", (monitor_id,))
    return {"deleted": monitor_id}


@router.post("/monitoring/views/{view_id}/subscriptions")
def create_subscription(view_id: str, req: SubscriptionIn) -> dict:
    _get("views", view_id, "Monitoring view")
    t = req.target.strip()
    if req.kind == "email" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", t):
        raise HTTPException(400, "Not an email address")
    if req.kind == "webhook" and not re.match(r"^https?://", t):
        raise HTTPException(400, "A webhook needs an http(s) URL")
    if req.kind == "pagerduty" and not re.fullmatch(r"[A-Za-z0-9]{20,64}", t):
        raise HTTPException(400, "Paste the PagerDuty integration key (Events API v2)")
    _check_delivery(req.kind, req.frequency, req.digest_timezone)
    s = {"id": "sub-" + uuid.uuid4().hex[:10], "view_id": view_id, "kind": req.kind, "name": req.name or req.kind, "severities": req.severities,
         "target": t if req.kind != "pagerduty" else "", "frequency": req.frequency, "digest_hour": req.digest_hour,
         "digest_timezone": req.digest_timezone or "UTC", "notify_resolved": req.notify_resolved, "last_digest_at": None, "created_at": _iso(),
         "owner": auth.actor_id()}  # it hears only of monitors its owner can see (_sub_block)
    _put("subscriptions", s, {"view_id": view_id, "secret": _seal({"key": t}) if req.kind == "pagerduty" else None})
    return _public_sub(s)


def _public_sub(s: dict) -> dict:
    with _db() as con:
        (queued,) = con.execute("SELECT COUNT(*) FROM digest_queue WHERE sub_id = ?", (s["id"],)).fetchone()
    return {"frequency": "immediate", "digest_hour": 8, "digest_timezone": "UTC", "notify_resolved": True, **s,
            "target": s["target"] if s["kind"] != "pagerduty" else "•••• (integration key)", "queued": queued, "next_digest_at": _next_digest(s)}


@router.put("/monitoring/subscriptions/{sub_id}")
def update_subscription(sub_id: str, req: SubscriptionChange) -> dict:
    """Change a subscription's severities and delivery (notification frequency); a switch to immediate sends
    what was waiting for the digest now."""
    s = _get("subscriptions", sub_id, "Subscription")
    with _db() as con:
        secret = con.execute("SELECT secret FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()[0]
    s.update({k: v for k, v in req.model_dump(exclude_none=True).items()})
    _check_delivery(s["kind"], s.get("frequency", "immediate"), s.get("digest_timezone", "UTC"))
    _put("subscriptions", s, {"view_id": s["view_id"], "secret": secret})
    if s.get("frequency", "immediate") == "immediate":
        send_digest(s, secret)
    return _public_sub(s)


@router.post("/monitoring/subscriptions/{sub_id}/send-digest")
def send_digest_now(sub_id: str) -> dict:
    s = _get("subscriptions", sub_id, "Subscription")
    with _db() as con:
        secret = con.execute("SELECT secret FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()[0]
    return {"sent": send_digest(s, secret)}


@router.delete("/monitoring/subscriptions/{sub_id}")
def delete_subscription(sub_id: str) -> dict:
    with _lock, _db() as con:
        con.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
        con.execute("DELETE FROM digest_queue WHERE sub_id = ?", (sub_id,))
    return {"deleted": sub_id}


@router.get("/monitoring/monitors/{monitor_id}/metrics")
def monitor_metrics(monitor_id: str, minutes: int = 120) -> dict:
    """The series behind a monitor (per minute) for its single target."""
    m = _get("monitors", monitor_id, "Monitor")
    if not _monitor_visible(m):
        raise HTTPException(404, "Monitor not found")
    since = _now() - timedelta(minutes=max(5, min(minutes, 24 * 60)))
    if m["resource_type"] in ("dataset", "schedule", "dc_sync"):
        metric = {"dataset": "rows per transaction", "schedule": "minutes per run", "dc_sync": "rows per run (failed runs 0)"}[m["resource_type"]]
        return {"metric": metric, "points": health_checks.history(m["resource_type"], m["resource_id"])}
    if m["resource_type"] in OUTPUT_RESOURCES:
        pts = [{"minute": r["minute"], "value": r["points"]} for r in timeseries.metrics(m["resource_id"], minutes)]
        return {"metric": "points written" if m["resource_type"] == "timeseries_sync" else "observations sent", "points": pts}
    if m["resource_type"] == "stream":
        s = _stream(m["resource_id"])
        with _db() as con:
            rows = con.execute("SELECT substr(at, 1, 16), COUNT(*) FROM records WHERE stream_id = ? AND view_id = ? AND at >= ? GROUP BY 1 ORDER BY 1",
                               (s["id"], s["view_id"], _iso(since))).fetchall()
        return {"metric": "records", "points": [{"minute": a, "value": b} for a, b in rows]}
    series = sync_metrics(m["resource_id"], minutes)
    key = {"records_ingested": "records", "last_checkpoint_duration": "cp_ms_max", "consecutive_checkpoint_failures": "cp_failures",
           "checkpoint_trigger_failures": "cp_failures", "checkpoint_liveness": "checkpoints", "total_lag": "lag", "total_throughput": "records",
           "utilization": "busy_ms"}[m["rule"]]
    pts = [{"minute": r["minute"], "value": r[key] if key != "busy_ms" else round(100 * (r["busy_ms"] or 0) / 60_000, 1)} for r in series]
    return {"metric": key if key != "busy_ms" else "utilization %", "points": pts}


def measure(m: dict) -> tuple[Optional[float], bool]:
    """(value, firing) of a monitor now."""
    rule, rid = m["rule"], m["resource_id"]
    window = timedelta(minutes=int(m.get("window_minutes") or 5))
    since = _now() - window
    thr = float(m.get("threshold") or 0)
    if m["resource_type"] in OUTPUT_RESOURCES:
        n = timeseries.written(rid, int(m.get("window_minutes") or 5))
        return float(n), n <= thr
    if m["resource_type"] == "stream":
        s = _stream(rid)
        with _db() as con:
            (n,) = con.execute("SELECT COUNT(*) FROM records WHERE stream_id = ? AND view_id = ? AND at >= ?", (rid, s["view_id"], _iso(since))).fetchone()
        return float(n), n <= thr
    rec, _, _ = _sync_row(rid)
    if rec.get("desired") != "running":
        return None, False  # a stopped sync is not monitored
    with _db() as con:
        r = con.execute("SELECT SUM(records), SUM(checkpoints), SUM(busy_ms), COUNT(*) FROM metrics WHERE sync_id = ? AND minute >= ?", (rid, _minute(since))).fetchone()
        lag = con.execute("SELECT lag FROM metrics WHERE sync_id = ? AND lag IS NOT NULL ORDER BY minute DESC LIMIT 1", (rid,)).fetchone()
    records, checkpoints, busy, minutes = (r[0] or 0), (r[1] or 0), (r[2] or 0), max(1, r[3] or 0)
    if rule == "records_ingested":
        return float(records), records <= thr
    if rule == "checkpoint_liveness":
        last = rec.get("last_checkpoint_at") or rec.get("started_at")
        age = (_now() - datetime.fromisoformat(last)).total_seconds() / 60 if last else float("inf")
        return round(age, 2), age > thr
    if rule == "last_checkpoint_duration":
        v = (rec.get("last_checkpoint_ms") or 0) / 1000
        return v, v > thr
    if rule == "checkpoint_trigger_failures":
        v = float(rec.get("trigger_failures") or 0)
        return v, v >= max(1, thr)
    if rule == "consecutive_checkpoint_failures":
        v = float(rec.get("cp_failures_in_a_row") or 0)
        return v, v >= max(1, thr)
    if rule == "total_lag":
        v = float(lag[0]) if lag and lag[0] is not None else 0.0
        return v, v > thr
    if rule == "total_throughput":
        v = records / checkpoints if checkpoints else 0.0
        hi = m.get("threshold_max")
        return round(v, 2), v < thr or (hi is not None and v > float(hi))
    if rule == "utilization":
        parallel = compose(rec.get("profiles", []), rec.get("advanced"))["parallelism"]
        v = 100 * busy / (minutes * 60_000 * (parallel if rec["kind"] in ("kafka", "sqs", "pubsub", "rabbitmq") else 1))
        return round(v, 1), v > thr
    return None, False


def evaluate() -> list[dict]:
    """Check every enabled monitor; open or resolve alerts and notify subscriptions."""
    import run_as

    changes = []
    views = {v["id"]: v for v in _rows("views")}
    for m in _rows("monitors"):
        if not m.get("enabled", True):
            continue
        message = None
        # as the monitor's owner: blocked with the reason (nothing measured, no alert, no notification) when they are
        # gone, deactivated or lost access to the resource
        try:
            principal, who = _monitor_principal(m, views)
            with run_as.acting_as(principal):
                blocked = _monitor_block(m, who)
        except run_as.OwnerUnavailable as e:
            principal, blocked = None, str(e)
        if blocked:
            reason = f"did not run: {blocked}"
            if m.get("blocked") != reason:
                m.update(blocked=reason, checked_at=_iso())
                log.warning("monitor %s: %s", m["id"], reason)
                _put("monitors", m, {"view_id": m["view_id"]})
            continue
        m.pop("blocked", None)
        try:
            with run_as.acting_as(principal):
                if m["resource_type"] in ("dataset", "schedule", "dc_sync"):
                    value, firing, message = health_checks.measure(m)
                else:
                    value, firing = measure(m)
        except HTTPException:
            continue  # its resource was deleted
        except Exception:  # noqa: BLE001 - one broken check does not stop the others
            log.exception("monitor %s failed", m["id"])
            continue
        was = m.get("state") == "firing"
        m.update(value=value, checked_at=_iso(), message=message)
        if was and not firing and not m.get("auto_resolve", True):
            # passing again, but the alert stays open until resolved by hand
            m["recovered"] = True
            _put("monitors", m, {"view_id": m["view_id"]})
            continue
        m.pop("recovered", None)
        if firing and not was:
            m["state"], m["since"] = "firing", _iso()
            alert = {"id": "al-" + uuid.uuid4().hex[:10], "monitor_id": m["id"], "view_id": m["view_id"], "monitor": m["name"], "rule": m["rule"],
                     "severity": m["severity"], "value": value, "threshold": m["threshold"], "state": "firing", "fired_at": _iso(), "resolved_at": None,
                     "resource": _resource_name(m["resource_type"], m["resource_id"]), "resource_type": m["resource_type"], "message": message}
            with _lock, _db() as con:
                con.execute("INSERT INTO alerts (id, monitor_id, view_id, record, fired_at) VALUES (?, ?, ?, ?, ?)",
                            (alert["id"], m["id"], m["view_id"], json.dumps(alert), alert["fired_at"]))
            m["alert_id"] = alert["id"]
            notify(alert, "trigger")
            changes.append(alert)
        elif not firing and was:
            m["state"] = "ok"
            if m.get("alert_id"):
                with _lock, _db() as con:
                    row = con.execute("SELECT record FROM alerts WHERE id = ?", (m["alert_id"],)).fetchone()
                    if row:
                        alert = {**json.loads(row[0]), "state": "resolved", "resolved_at": _iso(), "value": value}
                        con.execute("UPDATE alerts SET record = ?, resolved_at = ? WHERE id = ?", (json.dumps(alert), alert["resolved_at"], alert["id"]))
                        notify(alert, "resolve")
                        changes.append(alert)
        _put("monitors", m, {"view_id": m["view_id"]})
    return changes


@router.post("/monitoring/alerts/{alert_id}/resolve")
def resolve_alert(alert_id: str) -> dict:
    """Resolve an open alert by hand (monitors that do not auto-resolve); its monitor is OK again."""
    with _db() as con:
        row = con.execute("SELECT record FROM alerts WHERE id = ?", (alert_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Alert not found")
    alert = json.loads(row[0])
    mon = _alert_monitor(alert)
    if (mon is None and auth.enabled()) or (mon is not None and not _monitor_visible(mon)):
        raise HTTPException(404, "Alert not found")  # alerts of monitors the caller cannot see are not theirs to see
    if alert["state"] == "resolved":
        return alert
    alert.update(state="resolved", resolved_at=_iso(), resolved_by="hand")
    with _lock, _db() as con:
        con.execute("UPDATE alerts SET record = ?, resolved_at = ? WHERE id = ?", (json.dumps(alert), alert["resolved_at"], alert_id))
    try:
        m = _get("monitors", alert["monitor_id"], "Monitor")
        if m.get("alert_id") == alert_id:
            m.update(state="ok", alert_id=None)
            m.pop("recovered", None)
            _put("monitors", m, {"view_id": m["view_id"]})
    except HTTPException:
        pass
    notify(alert, "resolve")
    return alert


@router.post("/monitoring/evaluate")
def evaluate_now() -> dict:
    return {"changes": evaluate()}


# -- notifications --


def _post(url: str, body: dict) -> None:
    import httpx

    try:
        import network

        u = httpx.URL(url)
        network.check_egress(u.host, u.port or (443 if u.scheme == "https" else 80), "Alert notifications")
    except ImportError:
        pass
    httpx.post(url, json=body, timeout=15).raise_for_status()


def _email(to: str, subject: str, text: str) -> None:
    """Alert and digest emails go through mailer.py (Resend, or SMTP)."""
    import mailer

    if not mailer.send(to, subject, text):
        raise RuntimeError("email alerts need RESEND_API_KEY and RESEND_FROM (or BLUESANDAI_SMTP_HOST and _PORT, _USER, _PASSWORD, _FROM)")


PAGERDUTY_URL = "https://events.pagerduty.com/v2/enqueue"


def _summary(alert: dict) -> str:
    return f"[{alert['severity'].upper()}] {alert['monitor']} — {alert['resource']}: " + (
        alert["message"] if alert.get("message") else f"{alert['rule'].replace('_', ' ')} = {alert['value']} (threshold {alert['threshold']})")


def _next_digest(s: dict) -> Optional[str]:
    """When a digest subscription sends next (None for immediate ones)."""
    freq = s.get("frequency", "immediate")
    if freq == "immediate":
        return None
    last = datetime.fromisoformat(s["last_digest_at"]) if s.get("last_digest_at") else datetime.fromisoformat(s["created_at"])
    if freq == "hourly":
        return (last.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)).isoformat(timespec="seconds")
    zone = ZoneInfo(s.get("digest_timezone") or "UTC")
    local = last.astimezone(zone)
    nxt = local.replace(hour=int(s.get("digest_hour", 8)), minute=0, second=0, microsecond=0)
    if nxt <= local:
        nxt += timedelta(days=1)
    return nxt.astimezone(timezone.utc).isoformat(timespec="seconds")


def send_digest(s: dict, secret: Optional[bytes] = None) -> int:
    """Send the alerts waiting for a subscription's digest as one email or webhook call; returns how many."""
    with _db() as con:
        rows = con.execute("SELECT at, event FROM digest_queue WHERE sub_id = ? ORDER BY at", (s["id"],)).fetchall()
    # access is checked again when the digest goes out: alerts of monitors the subscription's owner (or an email
    # recipient who is a user) can no longer see are dropped from it
    events = [ev for ev in (json.loads(e) for _, e in rows) if not _sub_block(s, ev["alert"])]
    if events:
        fired = sum(1 for e in events if e["action"] == "trigger")
        resolved = len(events) - fired
        title = f"Data health digest: {fired} alert{'s' if fired != 1 else ''} fired, {resolved} resolved"
        lines = [f"{e['at'][:16].replace('T', ' ')} UTC  {'FIRED   ' if e['action'] == 'trigger' else 'RESOLVED'}  {_summary(e['alert'])}" for e in events]
        try:
            if s["kind"] == "webhook":
                _post(s["target"], {"event": "digest", "frequency": s.get("frequency"), "summary": title, "events": events})
            elif s["kind"] == "email":
                _email(s["target"], title, "\n".join(lines))
            else:  # PagerDuty is never batched: send each event
                for e in events:
                    _deliver(s, secret, e["alert"], e["action"])
        except Exception as e:  # noqa: BLE001 - kept queued for the next try
            log.warning("digest to %s failed: %s", s["kind"], e)
            return 0
    if rows:
        with _lock, _db() as con:
            con.execute("DELETE FROM digest_queue WHERE sub_id = ? AND at <= ?", (s["id"], rows[-1][0]))
    s["last_digest_at"] = _iso()
    _put("subscriptions", s, {"view_id": s["view_id"], "secret": secret})
    return len(events)


def flush_digests() -> None:
    """Send every digest that is due (called by the evaluator every 30 seconds)."""
    with _db() as con:
        subs = con.execute("SELECT record, secret FROM subscriptions").fetchall()
    now = _now()
    for raw, secret in subs:
        s = json.loads(raw)
        due = _next_digest(s)
        if due and datetime.fromisoformat(due) <= now:
            send_digest(s, secret)


def _deliver(s: dict, secret: Optional[bytes], alert: dict, action: str) -> None:
    summary = _summary(alert)
    if s["kind"] == "pagerduty":
        # PagerDuty Events API v2: the alert id deduplicates trigger and resolve
        body: dict[str, Any] = {"routing_key": _unseal(secret).get("key", ""), "event_action": action, "dedup_key": alert["id"]}
        if action == "trigger":
            body["payload"] = {"summary": summary[:1024], "source": "BluesandAI data health", "severity": PAGERDUTY_SEVERITY[alert["severity"]],
                               "component": alert["resource"], "custom_details": alert}
        _post(PAGERDUTY_URL, body)
    elif s["kind"] == "webhook":
        _post(s["target"], {"event": action, "alert": alert, "summary": summary})
    else:
        _email(s["target"], ("Resolved: " if action == "resolve" else "") + summary, json.dumps(alert, indent=2))


def _alert_monitor(alert: dict) -> Optional[dict]:
    return _rows_by_id("monitors", str(alert.get("monitor_id") or ""))


def _sub_block(s: dict, alert: dict, mon: Optional[dict] = None) -> Optional[str]:
    """Why a subscription may not hear of an alert (None: it may). With sign-in on a subscription (an email address,
    webhook or PagerDuty key outside the platform) acts for its owner — who created it, else its view's creator —:
    the owner must be active and see the monitored resource (as the monitor's own owner must, _monitor_block), and an
    email recipient who is a platform user must too. Sign-in off: everything is sent as before."""
    if not auth.enabled():
        return None
    import run_as

    mon = mon if mon is not None else _alert_monitor(alert)
    if mon is None:
        return "its monitor no longer exists"
    uid = s.get("owner") or (_rows_by_id("views", s["view_id"]) or {}).get("owner")
    try:
        p = run_as.owner_principal(uid, "the subscription")
    except run_as.OwnerUnavailable as e:
        return str(e).split(": ", 1)[0]  # "... has no owner it can run as" / "...'s owner X is deactivated"
    with run_as.acting_as(p):
        why = _monitor_block(mon, f"the subscription's owner {run_as.who(uid)}")
    if why:
        return why
    if s.get("kind") == "email":
        to = (s.get("target") or "").strip().lower()
        for u in auth._users():
            if to and (u.get("email") or "").strip().lower() == to and u["id"] != uid:
                rp = auth.principal_of(u["id"])
                if rp is None:
                    return f"its recipient {run_as.who(u['id'])} is deactivated"
                with run_as.acting_as(rp):
                    why = _monitor_block(mon, f"its recipient {run_as.who(u['id'])}")
                if why:
                    return why
    return None


def notify(alert: dict, action: Literal["trigger", "resolve"]) -> None:
    """Send an alert to the view's subscriptions: now, or queued for an hourly / daily digest."""
    with _db() as con:
        subs = con.execute("SELECT record, secret FROM subscriptions WHERE view_id = ?", (alert["view_id"],)).fetchall()
    mon = _alert_monitor(alert)
    for raw, secret in subs:
        s = json.loads(raw)
        if alert["severity"] not in s.get("severities", SEVERITIES):
            continue
        if action == "resolve" and not s.get("notify_resolved", True) and s["kind"] != "pagerduty":
            continue
        why = _sub_block(s, alert, mon)
        if why:
            # nothing about a monitor the subscription's owner (or its email recipient) cannot see leaves the platform
            log.info("alert %s not sent to subscription %s: %s", alert["id"], s["id"], why)
            s["skipped"] = {"at": _iso(), "alert_id": alert["id"], "reason": why}
            _put("subscriptions", s, {"view_id": s["view_id"], "secret": secret})
            continue
        if s.get("frequency", "immediate") != "immediate":
            with _lock, _db() as con:
                con.execute("INSERT INTO digest_queue (sub_id, at, event) VALUES (?, ?, ?)", (s["id"], _iso(), json.dumps({"at": _iso(), "action": action, "alert": alert})))
            continue
        try:
            _deliver(s, secret, alert, action)
        except Exception as e:  # noqa: BLE001 - one subscription's failure does not stop the others
            log.warning("alert notification to %s failed: %s", s["kind"], e)


# --------------------------------------------------------------------------------------------
# lifecycle
# --------------------------------------------------------------------------------------------

_evaluator_started = False


def _evaluator() -> None:
    while True:
        time.sleep(30)
        try:
            evaluate()
        except Exception:
            log.exception("stream monitoring evaluation failed")
        try:
            flush_digests()
        except Exception:
            log.exception("sending alert digests failed")
        try:
            # streams archived into datasets (stream_datasets.py)
            import stream_datasets

            stream_datasets.archive_due()
        except Exception:
            log.exception("archiving streams failed")
        try:
            # job metrics of streams written by streaming pipelines (stream_datasets.py)
            import stream_datasets

            stream_datasets.sample_pipelines()
        except Exception:
            log.exception("sampling streaming pipeline jobs failed")


def startup() -> None:
    """Resume syncs that were running, and start the monitor evaluator."""
    global _evaluator_started
    with _db() as con:
        rows = con.execute("SELECT record FROM syncs").fetchall()
    for (r,) in rows:
        rec = json.loads(r)
        if rec.get("desired") == "running":
            try:
                _start(rec["id"])
            except Exception as e:  # noqa: BLE001
                _set_status(rec["id"], "failed", _msg(e))
    if not _evaluator_started:
        _evaluator_started = True
        threading.Thread(target=_evaluator, daemon=True, name="stream-monitoring").start()
