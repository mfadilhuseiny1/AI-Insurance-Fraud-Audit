"""Streaming datasets in Dataset Preview (palantir.com/docs/foundry/dataset-preview/overview): a stream (streaming.py)
seen as a dataset.

- Archive: a stream's records are archived into a Parquet dataset in a Project (`PUT /streams/{id}/archive`), every
  N minutes while new records arrive (the stream monitor's 30 s loop) or on demand. Each run appends only the
  records above the last archived offset (an APPEND transaction; the offset and watermark are kept) and is
  rewritten in full only when the stream was reset, unarchived records were dropped, or the dataset changed
  outside the archive (the archive's history says why). Each archive is a transaction of the dataset (History,
  Compare, Time Travel and Health work on it). Dataset Preview opens the archive dataset in two views: Live (the
  stream's current records, updating) and Archive (the dataset).
  The archive loop runs as the archive's owner (who set it up; for archives set before owners were recorded, the
  owner of a streaming sync writing into the stream), never as the system (run_as.py): the owner must be active,
  see the stream (its markings, those of the syncs writing into it) and be an Editor of the archive's folder holding
  the archive dataset's markings; otherwise the run fails with the reason (kept as `blocked`) and writes nothing.
  The archive dataset keeps every marking its earlier transactions carried (they stay readable through Time Travel).
- Stream tab: the jobs that wrote the stream (streaming syncs, with their status changes and errors over a time
  period; the streaming pipeline that outputs to it, with its builds, checkpoint, lag and inputs' offsets).
- Metrics tab: per-minute charts (records ingested, throughput, lag, checkpoints, checkpoint failures and duration,
  utilization, dropped records; for pipeline outputs also records in and the time since the last checkpoint) with
  thresholds, and a Troubleshoot mode: steps to debug a stream outage, each pointing at the chart that shows it.
"""

from __future__ import annotations

import io
import json
import threading
from datetime import timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive
import marked_outputs
import streaming as S

router = APIRouter(prefix="/api/streaming")

SCHEMA = """
CREATE TABLE IF NOT EXISTS job_events (sync_id TEXT NOT NULL, stream_id TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS job_events_stream ON job_events (stream_id, at);
CREATE TABLE IF NOT EXISTS archives (stream_id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pipeline_metrics (stream_id TEXT NOT NULL, minute TEXT NOT NULL, records_in INTEGER DEFAULT 0,
    checkpoints INTEGER DEFAULT 0, lag INTEGER, cp_age INTEGER, running INTEGER DEFAULT 0, PRIMARY KEY (stream_id, minute));
CREATE TABLE IF NOT EXISTS pipeline_marks (stream_id TEXT PRIMARY KEY, record TEXT NOT NULL);
"""


def configure() -> None:
    with S._db() as con:
        con.executescript(SCHEMA)


def job_event(sync: dict, status: str, error: Optional[str]) -> None:
    """A sync's status change (streaming._set_status / _start): the Stream tab's job history."""
    try:
        with S._db() as con:
            con.execute("INSERT INTO job_events (sync_id, stream_id, at, status, error) VALUES (?, ?, ?, ?, ?)",
                        (sync["id"], sync.get("stream_id") or "", S._iso(), status, error))
    except Exception:  # noqa: BLE001 - history is best effort
        pass


# ------------------------------------------------------------------------------------------------
# archive
# ------------------------------------------------------------------------------------------------


def _archive(stream_id: str) -> Optional[dict]:
    with S._db() as con:
        row = con.execute("SELECT record FROM archives WHERE stream_id = ?", (stream_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _save_archive(rec: dict) -> None:
    with S._lock, S._db() as con:
        con.execute("INSERT OR REPLACE INTO archives (stream_id, record) VALUES (?, ?)", (rec["stream_id"], json.dumps(rec)))


class ArchiveIn(BaseModel):
    folder_id: str
    every_minutes: int = Field(5, ge=1, le=1440)
    name: Optional[str] = None


@router.put("/streams/{stream_id}/archive")
def set_archive(stream_id: str, req: ArchiveIn) -> dict:
    """Archive the stream into a dataset in this Project or folder (and run the first archive now)."""
    s = S._stream(stream_id)
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "archive into a Project or a folder")
    old = _archive(stream_id) or {}
    rec = {**old, "stream_id": stream_id, "folder_id": folder["id"], "every_minutes": req.every_minutes,
           "name": (req.name or old.get("name") or s["name"]).strip().removesuffix(".parquet"),
           "owner": auth.actor_id() or old.get("owner")}  # the archive loop runs as them (archive_due)
    rec.pop("blocked", None)
    if old.get("folder_id") and old["folder_id"] != folder["id"]:
        rec.pop("item_id", None)
        rec.pop("last_seq", None)
    _save_archive(rec)
    return run_archive(stream_id)


META = ("_seq", "_timestamp")
HISTORY_KEEP = 100
_archive_lock = threading.Lock()  # one archive run at a time: the monitor loop and Archive now never append the same records twice


def _columns(s: dict, records: list[dict], have: Optional[list[str]] = None) -> list[str]:
    """The archive's data columns: the stream schema's, else every record key (sorted, so an incremental run and a
    full rewrite give the same order)."""
    declared = [c["name"] for c in s.get("schema") or []]
    if declared:
        return declared
    return sorted({k for r in records for k in r if not k.startswith("_")} | {c for c in have or [] if c not in META})


def _to_table(rows: list[tuple], cols: list[str]) -> Any:
    """(seq, at, record JSON) rows → an Arrow table: the data columns, then _seq and _timestamp. Mixed types in a
    column make every column text (as the archive always did)."""
    import pyarrow as pa

    records = [json.loads(r) for _, _, r in rows]
    data: dict[str, list] = {c: [r.get(c) for r in records] for c in cols}
    data["_seq"] = [q for q, _, _ in rows]
    data["_timestamp"] = [a for _, a, _ in rows]
    try:
        return pa.table(data)
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        return pa.table({k: [None if v is None else str(v) for v in vs] for k, vs in data.items()})


def _parquet(table: Any) -> bytes:
    import pyarrow.parquet as pq

    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


def _append_table(old: Any, new: Any, cols: list[str]) -> Any:
    """The archived rows followed by the new ones, in the archive's column order; types are promoted (a column
    that was all empty takes the new rows' type, integers widen to doubles). Raises when they cannot be."""
    import pyarrow as pa

    order = [*cols, *META]
    def pad(t: Any) -> Any:
        for c in order:
            if c not in t.column_names:
                t = t.append_column(c, pa.nulls(t.num_rows))
        return t.select(order)

    old, new = pad(old), pad(new)
    if old.schema.equals(new.schema):
        return pa.concat_tables([old, new])
    return pa.concat_tables([old, new], promote_options="permissive")


def full_rewrite_table(stream_id: str) -> Any:
    """The archive as a full rewrite would write it now (every record of the current view): what tests compare the
    incrementally appended archive with."""
    s = S._stream(stream_id)
    with S._db() as con:
        rows = con.execute("SELECT seq, at, record FROM records WHERE stream_id = ? AND view_id = ? ORDER BY seq", (stream_id, s["view_id"])).fetchall()
    return _to_table(rows, _columns(s, [json.loads(r) for _, _, r in rows]))


@router.post("/streams/{stream_id}/archive/run")
def run_archive(stream_id: str) -> dict:
    """Archive the records added since the last run: an APPEND transaction of the new rows (records with an offset
    above the last archived one), the offset and the watermark (the newest archived record's time) stored. The
    archive is rewritten in full (a SNAPSHOT) only when it has to be, and its history says why: the first archive,
    the archive dataset deleted or moved, the stream reset (a new view), records not yet archived dropped from the
    stream, the archive dataset changed outside the archive (a rollback), or new rows whose types cannot be appended."""
    with _archive_lock:
        return _run_archive(stream_id)


def _run_archive(stream_id: str) -> dict:
    import pyarrow as pa
    import pyarrow.parquet as pq

    import dataset_versions
    import pipeline_datasets

    s = S._stream(stream_id)
    rec = _archive(stream_id)
    if not rec:
        raise HTTPException(400, "this stream has no archive: set one first")
    # whoever runs it (the archive's owner from the loop, the caller on demand) writes into the archive's folder:
    # an Editor there holding the folder's and the archive dataset's markings — checked before anything is written
    if rec.get("folder_id"):
        drive._item(rec["folder_id"], need="editor")
    view = s["view_id"]
    with S._db() as con:
        head, first, total = con.execute("SELECT MAX(seq), MIN(seq), COUNT(*) FROM records WHERE stream_id = ? AND view_id = ?", (stream_id, view)).fetchone()
    head, first = head or 0, first or 0
    last = rec.get("last_seq") or 0
    item = db.drive_get(rec["item_id"]) if rec.get("item_id") else None
    if item and item.get("trashed_at"):
        item = None
    if item:
        auth.check_item(item, "editor")  # its own markings (set by hand) and those its earlier transactions carry
    same_view = rec.get("view_id") == view
    # the archive carries the stream's markings (its own, its pipeline's, the streaming syncs writing into it) from
    # its first row: a new archive is marked under its fresh id before it is stored, an existing one is widened before
    # its rows are replaced (marked_outputs.py) and never narrowed — its earlier transactions, written under the
    # stream's markings of their time (e.g. before a reset narrowed them), stay readable through Time Travel
    marks = set(auth.resource_effective("stream", stream_id))
    if item:
        marks |= set(auth._item_row(item["id"])[1])
    if item and same_view and last == head:
        _own, inherited = auth._item_row(item["id"])
        if not marks <= set(inherited):
            auth._set_item(item["id"], inherited=sorted(set(inherited) | marks))  # an archive written before it was marked
        return status(stream_id)

    # append, unless a full rewrite is needed (the reason goes into the archive's history)
    reason = None
    old = None
    if not rec.get("item_id"):
        reason = "first archive"
    elif not item:
        reason = "the archive dataset was deleted or trashed: written again in full"
    elif not same_view:
        reason = f"the stream was reset (view {rec.get('view_id')} → {view}): the new view is written in full"
    elif head < last:
        reason = f"the stream's offsets went back ({last} archived, the stream ends at {head}): written in full"
    elif total and first > last + 1:
        reason = f"records {last + 1}–{first - 1} were dropped from the stream before they were archived: written in full"
    else:
        try:
            old = pq.read_table(io.BytesIO(drive.read_bytes(item)))
        except Exception as e:  # noqa: BLE001
            reason = f"the archive dataset could not be read ({e}): written in full"
        else:
            if old.num_rows != (rec.get("rows") or 0) or "_seq" not in old.column_names or \
                    (old.num_rows and str(old.column("_seq")[old.num_rows - 1].as_py()) != str(last)):
                reason = "the archive dataset was changed outside the archive (a rollback or an edit): written in full"
                old = None

    with S._db() as con:
        rows = con.execute("SELECT seq, at, record FROM records WHERE stream_id = ? AND view_id = ? AND seq > ? ORDER BY seq",
                           (stream_id, view, last if old is not None else 0)).fetchall()
    table = None
    if old is not None:
        cols = _columns(s, [json.loads(r) for _, _, r in rows], old.column_names)
        try:
            table = _append_table(old, _to_table(rows, cols), cols)
        except (pa.ArrowInvalid, pa.ArrowTypeError, pa.ArrowNotImplementedError) as e:
            reason = f"the new records' types do not match the archive's ({e}): written in full"
            with S._db() as con:
                rows = con.execute("SELECT seq, at, record FROM records WHERE stream_id = ? AND view_id = ? ORDER BY seq", (stream_id, view)).fetchall()
    if table is None:
        table = _to_table(rows, _columns(s, [json.loads(r) for _, _, r in rows]))
    body = _parquet(table)
    transaction = "APPEND" if reason is None else "SNAPSHOT"
    if item:
        marked_outputs.replace(item, body, pipeline_datasets.PARQUET, marks)
        item = db.drive_get(item["id"])
    else:
        item = marked_outputs.create(rec["folder_id"], f"{rec['name']}.parquet", body, pipeline_datasets.PARQUET, marks)
    new_last = rows[-1][0] if rows else (last if transaction == "APPEND" else 0)
    watermark = rows[-1][1] if rows else rec.get("watermark")
    run = {"at": S._iso(), "transaction": transaction, "written": len(rows), "rows": table.num_rows, "view_id": view,
           "from_offset": rows[0][0] if rows else None, "to_offset": new_last, "watermark": watermark}
    if reason:
        run["reason"] = reason
    source = {"kind": "stream", "id": stream_id, "name": s["name"], "view_id": view, "transaction": transaction, "written": len(rows),
              "offset": new_last, "watermark": watermark, **({"reason": reason} if reason else {})}
    tx = dataset_versions.record(item["id"], body, "build", source)
    run["transaction_id"] = tx.get("id")
    rec.update(item_id=item["id"], last_seq=new_last, view_id=view, last_at=run["at"], rows=table.num_rows, watermark=watermark,
               history=[run, *(rec.get("history") or [])][:HISTORY_KEEP])
    rec.pop("blocked", None)
    _save_archive(rec)
    return status(stream_id)


def _archive_owner(rec: dict) -> Optional[str]:
    """Who the archive loop acts as: the user who set the archive up; for an archive set before owners were recorded,
    the owner of the newest streaming sync writing into the stream that has one."""
    if rec.get("owner"):
        return rec["owner"]
    with S._db() as con:
        syncs = [json.loads(r) for (r,) in con.execute("SELECT record FROM syncs WHERE json_extract(record, '$.stream_id') = ?",
                                                        (rec["stream_id"],)).fetchall()]
    for x in sorted(syncs, key=lambda x: x.get("created_at") or "", reverse=True):
        if x.get("owner") not in (None, "", "local", "system"):
            return x["owner"]
    return None


def _set_blocked(stream_id: str, reason: Optional[str]) -> None:
    with _archive_lock:
        rec = _archive(stream_id)
        if not rec or (rec.get("blocked") or {}).get("reason") == reason or (reason is None and "blocked" not in rec):
            return
        if reason is None:
            rec.pop("blocked", None)
        else:
            rec["blocked"] = {"at": S._iso(), "reason": reason}
            S.log.warning("archiving stream %s: %s", stream_id, reason)
        _save_archive(rec)


def run_archive_as_owner(rec: dict) -> Optional[dict]:
    """One scheduled archive run, as the archive's owner (run_as.py; sign-in off: as before). When the owner is gone,
    deactivated or lost access to the stream, the archive's folder or dataset, nothing is written and the reason is
    kept on the archive (`blocked`) until a run succeeds or someone sets the archive again (they become its owner)."""
    import run_as

    uid = _archive_owner(rec)
    try:
        p = run_as.owner_principal(uid, "the stream archive")
    except run_as.OwnerUnavailable as e:
        _set_blocked(rec["stream_id"], f"did not run: {e}")
        return None
    try:
        with run_as.acting_as(p):
            out = run_archive(rec["stream_id"])
    except HTTPException as e:
        if e.status_code not in (403, 404):
            raise
        _set_blocked(rec["stream_id"], f"did not run: the stream archive's owner {run_as.who(uid)} may not write it: {e.detail}")
        return None
    _set_blocked(rec["stream_id"], None)
    return out


def archive_due() -> None:
    """Called from the stream monitor's loop: archive streams whose interval has passed and that have new records,
    each as its archive's owner (never as the system with sign-in on)."""
    with S._db() as con:
        recs = [json.loads(r) for (r,) in con.execute("SELECT record FROM archives").fetchall()]
    now = S._now()
    for rec in recs:
        last = rec.get("last_at")
        if last and S.datetime.fromisoformat(last) > now - timedelta(minutes=rec.get("every_minutes") or 5):
            continue
        try:
            run_archive_as_owner(rec)
        except Exception as e:  # noqa: BLE001
            S.log.warning("archiving stream %s failed: %s", rec["stream_id"], e)


@router.get("/streams/{stream_id}/archive")
def status(stream_id: str) -> dict:
    s = S._stream(stream_id)
    rec = _archive(stream_id)
    out: dict[str, Any] = {"stream": S._public_stream(s), "archive": rec}
    if rec and rec.get("item_id"):
        item = db.drive_get(rec["item_id"])
        out["archive"] = {**rec, "path": [p["name"] for p in db.drive_path(item["id"])[:-1]] if item else None, "missing": not item or bool(item.get("trashed_at"))}
    return out


@router.get("/streams/by-item/{item_id}")
def by_item(item_id: str) -> dict:
    """The stream a dataset archives (Dataset Preview shows it as a streaming dataset)."""
    drive._item(item_id, need="viewer")
    with S._db() as con:
        for (r,) in con.execute("SELECT record FROM archives").fetchall():
            rec = json.loads(r)
            if rec.get("item_id") == item_id:
                return status(rec["stream_id"])
    raise HTTPException(404, "this dataset does not archive a stream")


# ------------------------------------------------------------------------------------------------
# job metrics of streams written by streaming pipelines
# ------------------------------------------------------------------------------------------------
# A streaming pipeline (web/src/lib/server/runner.ts) reads its input streams from checkpointed offsets and
# pushes its results to one output stream per output; it saves {offsets, views} as the pipeline's
# `checkpoint[@branch]` state. Sampling that state (the stream monitor's 30 s loop, and every Metrics / Stream tab
# read) gives the job metrics streaming syncs report: records in (the checkpointed offsets' advance), records out
# (records written to the output stream), lag (records of the input streams not yet checkpointed), checkpoints
# (checkpoint changes seen: several within one sample count once), the time since the last checkpoint, and
# whether the job runs. Kept per minute, PIPELINE_KEEP_DAYS days.

PIPELINE_KEEP_DAYS = 7


def _origin(s: dict) -> Optional[dict]:
    o = s.get("origin") or {}
    return o if o.get("pipeline_id") else None


def _pipeline_inputs(pipeline_id: str) -> dict[str, dict]:
    """The pipeline's stream inputs: dataset id → {kind: stream | ingest, stream_id, name}."""
    item = db.drive_get(pipeline_id)
    if not item or item.get("trashed_at"):
        return {}
    try:
        content = json.loads(drive.read_bytes(item))
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for did, d in (content.get("datasets") or {}).items():
        ref = (d or {}).get("ref") or {}
        if ref.get("kind") in ("stream", "ingest") and ref.get("streamId"):
            out[did] = {"kind": ref["kind"], "stream_id": ref["streamId"], "name": d.get("name") or ref["streamId"]}
    return out


def _input_head(kind: str, stream_id: str) -> tuple[int, Optional[str]]:
    """An input stream's last offset (and its current view, for ingest streams)."""
    if kind == "ingest":
        try:
            s = S._stream(stream_id)
        except HTTPException:
            return 0, None
        with S._db() as con:
            (head,) = con.execute("SELECT MAX(seq) FROM records WHERE stream_id = ? AND view_id = ?", (stream_id, s["view_id"])).fetchone()
        return head or 0, s["view_id"]
    import pipeline_runtime

    with pipeline_runtime._db() as con:
        (head,) = con.execute("SELECT MAX(seq) FROM stream_records WHERE stream_id = ?", (stream_id,)).fetchone()
    return head or 0, None


def _pipeline_build(origin: dict) -> Optional[dict]:
    """The newest streaming build of the pipeline on the output's branch."""
    import pipeline_runtime

    branch = origin.get("branch") or "main"
    for b in pipeline_runtime._builds(origin["pipeline_id"], 30):
        if (b.get("branch") or "main") == branch and (b.get("streaming") or b.get("status") in ("queued", "running")):
            return b
    return None


def _pipeline_state(origin: dict) -> dict:
    import pipeline_runtime

    branch = origin.get("branch") or "main"
    suffix = "" if branch == "main" else f"@{branch}"
    cp = pipeline_runtime.get_state(origin["pipeline_id"], f"checkpoint{suffix}") or {}
    return {"offsets": cp.get("offsets") or pipeline_runtime.get_state(origin["pipeline_id"], f"offsets{suffix}") or {},
            "views": cp.get("views") or pipeline_runtime.get_state(origin["pipeline_id"], f"views{suffix}") or {}}


def sample_pipeline(s: dict) -> Optional[dict]:
    """Sample the job writing this pipeline output stream: its checkpoint, lag and status, added to this minute's
    row. Returns the job's current figures (None for a stream no pipeline writes)."""
    origin = _origin(s)
    if not origin:
        return None
    now = S._iso()
    state = _pipeline_state(origin)
    offsets, views = state["offsets"], state["views"]
    inputs = _pipeline_inputs(origin["pipeline_id"])
    lag, per_input = 0, []
    for did, inp in inputs.items():
        head, view = _input_head(inp["kind"], inp["stream_id"])
        done = int(offsets.get(did) or 0) if (view is None or views.get(did) in (None, view)) else 0
        lag += max(0, head - done)
        per_input.append({"id": inp["stream_id"], "name": inp["name"], "kind": inp["kind"], "offset": done, "head": head, "lag": max(0, head - done)})
    build = _pipeline_build(origin)
    running = bool(build and build.get("status") == "running")
    key = json.dumps({"o": offsets, "v": views}, sort_keys=True)
    with S._lock, S._db() as con:
        row = con.execute("SELECT record FROM pipeline_marks WHERE stream_id = ?", (s["id"],)).fetchone()
        mark = json.loads(row[0]) if row else None
        changed = bool(mark) and mark.get("key") != key
        records_in = 0
        if changed:
            prev_o, prev_v = mark.get("offsets") or {}, mark.get("views") or {}
            for did, off in offsets.items():
                before = int(prev_o.get(did) or 0) if prev_v.get(did) == views.get(did) else 0
                records_in += int(off or 0) - before if int(off or 0) >= before else int(off or 0)
        cp_at = now if changed else (mark or {}).get("cp_at")
        if not mark:
            # first sample: the checkpoint is as old as the running build's last progress, at best
            cp_at = (build or {}).get("updated_at") if offsets else None
        cp_age = int((S._now() - S.datetime.fromisoformat(cp_at)).total_seconds()) if cp_at else None
        con.execute("INSERT OR REPLACE INTO pipeline_marks (stream_id, record) VALUES (?, ?)",
                    (s["id"], json.dumps({"key": key, "offsets": offsets, "views": views, "cp_at": cp_at, "at": now})))
        minute = S._minute()
        con.execute(
            "INSERT INTO pipeline_metrics (stream_id, minute, records_in, checkpoints, lag, cp_age, running) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (stream_id, minute) DO UPDATE SET records_in = records_in + excluded.records_in, checkpoints = checkpoints + excluded.checkpoints, "
            "lag = excluded.lag, cp_age = excluded.cp_age, running = MAX(running, excluded.running)",
            (s["id"], minute, max(0, records_in), 1 if changed else 0, lag if inputs else None, cp_age, 1 if running else 0))
        con.execute("DELETE FROM pipeline_metrics WHERE stream_id = ? AND minute < ?", (s["id"], S._minute(S._now() - timedelta(days=PIPELINE_KEEP_DAYS))))
    out_rows = None
    if build:
        for job in build.get("jobs") or []:
            for o in job.get("outputs") or []:
                if o.get("id") == origin.get("output_id") or o.get("streamId") == s["id"]:
                    out_rows = o.get("rows")
    return {"pipeline_id": origin["pipeline_id"], "pipeline_name": origin.get("pipeline_name") or origin["pipeline_id"], "branch": origin.get("branch") or "main",
            "build_id": (build or {}).get("id"), "status": (build or {}).get("status") or "never run", "running": running,
            "started_at": (build or {}).get("started_at"), "error": (build or {}).get("error"), "last_checkpoint_at": cp_at, "checkpoint_age_s": cp_age,
            "lag": lag if inputs else None, "inputs": per_input, "records_out_build": out_rows,
            "records_in_total": sum(int(v or 0) for v in offsets.values())}


def sample_pipelines() -> None:
    """The stream monitor's loop: sample every stream a streaming pipeline writes."""
    with S._db() as con:
        streams = [json.loads(r) for (r,) in con.execute("SELECT record FROM streams").fetchall()]
    for s in streams:
        if _origin(s):
            try:
                sample_pipeline(s)
            except Exception as e:  # noqa: BLE001
                S.log.warning("sampling the pipeline job of stream %s failed: %s", s.get("id"), e)


def _pipeline_events(origin: dict, since: str) -> list[dict]:
    """The streaming builds' status history: started, then succeeded / failed / cancelled (newest first)."""
    import pipeline_runtime

    branch = origin.get("branch") or "main"
    out = []
    for b in pipeline_runtime._builds(origin["pipeline_id"], 100):
        if (b.get("branch") or "main") != branch or not (b.get("streaming") or b.get("status") in ("queued", "running")):
            continue
        if b.get("finished_at") and b["finished_at"] >= since:
            out.append({"at": b["finished_at"], "status": b.get("status"), "error": b.get("error"), "build_id": b["id"]})
        start = b.get("started_at") or b.get("created_at")
        if start and start >= since:
            out.append({"at": start, "status": "started" if b.get("started_at") else "queued", "error": None, "build_id": b["id"],
                        "trigger": b.get("trigger")})
    return sorted(out, key=lambda e: e["at"], reverse=True)[:500]


# ------------------------------------------------------------------------------------------------
# Stream tab: the jobs that wrote the stream
# ------------------------------------------------------------------------------------------------


def _writers(stream_id: str) -> list[dict]:
    with S._db() as con:
        rows = con.execute("SELECT record FROM syncs").fetchall()
    return [x for x in (json.loads(r) for (r,) in rows) if x.get("stream_id") == stream_id]


@router.get("/streams/{stream_id}/jobs")
def jobs(stream_id: str, hours: int = 24) -> dict:
    s = S._stream(stream_id)
    since = S._iso(S._now() - timedelta(hours=max(1, min(hours, 24 * 30))))
    with S._db() as con:
        events = con.execute("SELECT sync_id, at, status, error FROM job_events WHERE stream_id = ? AND at >= ? ORDER BY at DESC LIMIT 500",
                             (stream_id, since)).fetchall()
    syncs = []
    for x in _writers(stream_id):
        pub = S._public_sync(x)
        syncs.append({k: pub.get(k) for k in ("id", "name", "kind", "status", "desired", "error", "started_at", "last_checkpoint_at", "records_5m", "lag", "updated_at")}
                     | {"parallelism": (pub.get("settings") or {}).get("parallelism"),
                        "events": [{"at": a, "status": st, "error": err} for sid, a, st, err in events if sid == x["id"]]})
    origin = s.get("origin") or {}
    job = None
    if _origin(s):
        job = sample_pipeline(s)
        if job is not None:
            five = S._minute(S._now() - timedelta(minutes=5))
            with S._db() as con:
                (out5,) = con.execute("SELECT COUNT(*) FROM records WHERE stream_id = ? AND view_id = ? AND at >= ?", (stream_id, s["view_id"], S._iso(S._now() - timedelta(minutes=5)))).fetchone()
                (in5,) = con.execute("SELECT COALESCE(SUM(records_in), 0) FROM pipeline_metrics WHERE stream_id = ? AND minute >= ?", (stream_id, five)).fetchone()
            job.update(records_out_5m=out5, records_in_5m=in5, events=_pipeline_events(origin, since))
    return {"stream_id": stream_id, "since": since, "syncs": syncs,
            "pipeline": {"id": origin["pipeline_id"], "name": origin.get("pipeline_name") or origin["pipeline_id"]} if origin.get("pipeline_id") else None,
            "pipeline_job": job,
            "push": not syncs and not origin.get("pipeline_id")}


# ------------------------------------------------------------------------------------------------
# Metrics tab and Troubleshoot mode
# ------------------------------------------------------------------------------------------------

METRICS = [
    # key, label, unit, recommended for debugging, warning threshold (None: none), direction ("above" / "below")
    ("records", "Records ingested", "records / min", True, None, None),
    ("throughput", "Records per checkpoint", "records", False, None, None),
    ("lag", "Total lag", "records", True, 1000, "above"),
    ("checkpoints", "Checkpoints", "per min", False, None, None),
    ("cp_failures", "Checkpoint failures", "per min", True, 1, "above"),
    ("cp_ms_max", "Last checkpoint duration", "ms", True, 60000, "above"),
    ("utilization", "Utilization", "%", True, 90, "above"),
    ("dropped", "Dropped records", "records / min", False, 1, "above"),
    # streaming pipeline jobs (sampled from their checkpoints)
    ("records_in", "Records in (pipeline input)", "records / min", True, None, None),
    ("cp_age", "Time since last checkpoint", "s", True, 300, "above"),
]


@router.get("/streams/{stream_id}/metrics")
def metrics(stream_id: str, minutes: int = 60) -> dict:
    s = S._stream(stream_id)
    minutes = max(5, min(minutes, 24 * 60))
    start = S._now() - timedelta(minutes=minutes)
    since = S._minute(start)
    with S._db() as con:
        ingested = dict(con.execute("SELECT substr(at, 1, 16), COUNT(*) FROM records WHERE stream_id = ? AND view_id = ? AND at >= ? GROUP BY 1",
                                    (stream_id, s["view_id"], S._iso(start))).fetchall())
    writers = _writers(stream_id)
    pipe = _origin(s) is not None
    pmin: dict[str, tuple] = {}
    if pipe:
        sample_pipeline(s)
        with S._db() as con:
            pmin = {m: (ri, cps, lag, age, run) for m, ri, cps, lag, age, run in con.execute(
                "SELECT minute, records_in, checkpoints, lag, cp_age, running FROM pipeline_metrics WHERE stream_id = ? AND minute >= ?", (stream_id, since)).fetchall()}
    per: dict[str, dict[str, float]] = {}
    for w in writers:
        par = (S.compose(w.get("profiles", []), w.get("advanced")) or {}).get("parallelism") or 1
        for m in S.sync_metrics(w["id"], minutes):
            p = per.setdefault(m["minute"], {"checkpoints": 0, "cp_failures": 0, "cp_ms_max": 0, "busy_ms": 0, "dropped": 0, "lag": 0, "sync_records": 0, "par": 0})
            for k in ("checkpoints", "cp_failures", "dropped"):
                p[k] += m.get(k) or 0
            p["cp_ms_max"] = max(p["cp_ms_max"], m.get("cp_ms_max") or 0)
            p["busy_ms"] += m.get("busy_ms") or 0
            p["lag"] += m.get("lag") or 0
            p["sync_records"] += m.get("records") or 0
            p["par"] += par
    series = []
    t = S.datetime.fromisoformat(since + ":00+00:00")
    while S._minute(t) <= S._minute():
        k = S._minute(t)
        p = per.get(k, {})
        q = pmin.get(k)  # the pipeline job's sample of this minute (None: not sampled then)
        cps = (p.get("checkpoints") or 0) + (q[1] if q else 0)
        rec = ingested.get(k, 0)
        lag = (p.get("lag") if writers else None)
        if q and q[2] is not None:
            lag = (lag or 0) + q[2]
        series.append({"minute": k, "records": rec, "throughput": round(rec / cps, 1) if cps else None, "lag": lag,
                       "checkpoints": cps if (writers or q) else None, "cp_failures": p.get("cp_failures") if writers else None,
                       "cp_ms_max": p.get("cp_ms_max") if writers else None,
                       "utilization": round(100 * p["busy_ms"] / (60000 * p["par"]), 1) if p.get("par") else (0 if writers else None),
                       "dropped": p.get("dropped") if writers else None,
                       "records_in": q[0] if q else (0 if pipe else None), "cp_age": q[3] if q else None})
        t += timedelta(minutes=1)
    keys = {"records_in", "cp_age"} if pipe else set()
    return {"metrics": [{"key": k, "label": lab, "unit": u, "recommended": r, "threshold": th, "direction": d}
                        for k, lab, u, r, th, d in METRICS if k not in ("records_in", "cp_age") or k in keys],
            "series": series, "jobs": len(writers) + (1 if pipe else 0), "pipeline": pipe}


@router.get("/streams/{stream_id}/troubleshoot")
def troubleshoot(stream_id: str) -> dict:
    """Troubleshoot and Debug mode: the steps to debug a stream outage, in order, each with its finding and the
    metric chart that shows it."""
    s = S._public_stream(S._stream(stream_id))
    j = jobs(stream_id, 24)
    m = metrics(stream_id, 30)["series"]
    last15 = m[-15:]
    steps = []

    def step(key: str, title: str, state: str, detail: str, metric: Optional[str] = None) -> None:
        steps.append({"key": key, "title": title, "state": state, "detail": detail, "metric": metric})

    running = [x for x in j["syncs"] if x["status"] == "running"]
    pj = j.get("pipeline_job")
    if pj:
        if pj["running"]:
            step("writer", "Is a job writing to the stream?", "pass", f"the streaming pipeline {pj['pipeline_name']} runs on {pj['branch']} (build {pj['build_id']})")
        else:
            step("writer", "Is a job writing to the stream?", "fail" if pj["status"] == "failed" else "warn",
                 f"the streaming pipeline {pj['pipeline_name']} is not running: its last build is {pj['status']}" + (f" ({pj['error']})" if pj.get("error") else "") + ". Deploy or restart it from Pipeline Builder.")
    elif j["push"]:
        step("writer", "Is a job writing to the stream?", "info", "No sync or pipeline writes to this stream: records arrive by push (the stream proxy URL).")
    elif not running:
        failed = [x for x in j["syncs"] if x["status"] in ("failed", "retrying")]
        step("writer", "Is a job writing to the stream?", "fail" if failed or j["syncs"] else "warn",
             f"{len(j['syncs'])} sync(s) write to it; none is running" + (f": {failed[0]['name']} {failed[0]['status']} ({failed[0].get('error') or 'no error message'})" if failed else "") + ". Start it from the Stream tab.")
    else:
        step("writer", "Is a job writing to the stream?", "pass", f"{len(running)} running: {', '.join(x['name'] for x in running)}")
    age = None
    if s.get("last_record_at"):
        age = (S._now() - S.datetime.fromisoformat(s["last_record_at"])).total_seconds()
    recent = sum(x["records"] for x in last15)
    step("ingest", "Are records arriving?", "pass" if recent else "fail",
         f"{recent} records in the last 15 minutes" + (f"; the last one {int(age // 60)} min ago" if age is not None else "; no records yet"), "records")
    if j["syncs"]:
        fails = sum(x.get("cp_failures") or 0 for x in last15)
        cps = sum(x.get("checkpoints") or 0 for x in last15)
        step("checkpoints", "Are checkpoints succeeding?", "fail" if fails else "pass" if cps else "warn",
             f"{fails} failed checkpoints in 15 minutes" if fails else f"{cps} checkpoints in 15 minutes" if cps else "no checkpoint in 15 minutes", "cp_failures" if fails else "checkpoints")
        lags = [x["lag"] for x in last15 if x.get("lag") is not None]
        growing = len(lags) >= 3 and lags[-1] > lags[0] and lags[-1] > 0
        step("lag", "Is the job keeping up?", "warn" if growing else "pass", f"lag grew from {lags[0]} to {lags[-1]}" if growing else f"lag {lags[-1] if lags else 0}", "lag")
        util = max([x.get("utilization") or 0 for x in last15] + [0])
        step("utilization", "Does the job have enough capacity?", "warn" if util >= 90 else "pass",
             f"peak utilization {util}%" + (": use a larger streaming profile (more parallelism)" if util >= 90 else ""), "utilization")
        dropped = sum(x.get("dropped") or 0 for x in last15)
        step("dropped", "Are records dropped?", "warn" if dropped else "pass", f"{dropped} records dropped (bad records or schema mismatches)" if dropped else "none dropped", "dropped")
    if pj:
        rin = sum(x.get("records_in") or 0 for x in last15)
        lag = pj.get("lag") or 0
        step("pipeline_in", "Is the pipeline reading its inputs?", "pass" if rin or not lag else "fail",
             f"{rin} input records checkpointed in 15 minutes; {lag} not yet read" + "".join(f"; {i['name']}: offset {i['offset']} of {i['head']}" for i in pj.get("inputs") or []), "records_in")
        age = pj.get("checkpoint_age_s")
        step("pipeline_checkpoint", "Is the pipeline checkpointing?", "pass" if age is not None and (age < 300 or not lag) else "warn",
             f"last checkpoint {age} s ago" if age is not None else "no checkpoint yet", "cp_age")
        lags = [x["lag"] for x in last15 if x.get("lag") is not None]
        growing = len(lags) >= 3 and lags[-1] > lags[0] and lags[-1] > 0
        step("pipeline_lag", "Is the pipeline keeping up?", "warn" if growing else "pass",
             f"lag grew from {lags[0]} to {lags[-1]}: a larger streaming profile or a bigger batch" if growing else f"lag {lag}", "lag")
    return {"steps": steps, "healthy": all(x["state"] in ("pass", "info") for x in steps)}
