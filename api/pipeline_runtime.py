"""Pipeline Builder runtime: builds, schedules, incremental state, virtual tables, output writers and streams.

A build is a record here (SQLite in data/pipeline/runtime.sqlite). Deploying (or a schedule firing)
queues a build and hands it to the runner in the web server (POST {WEB_URL}/api/pipeline-runner), which
runs the same pipeline engine as the browser: it reads the pipeline file and live inputs through this
API, evaluates each job, checks expectations and writes outputs with the endpoints below, reporting
progress back with PATCH /builds/{id}.

Schedules live in the pipeline files; a thread here reads them (re-reading a file only when it changed)
and pipeline_schedules.py evaluates their triggers, queues their builds and keeps their run history.
Every build records what it starts from (logic version and hash, input versions, output signatures),
so schedules can skip outputs that are up to date and builds can be compared.

Mounted by server.py under /api/pipeline.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import re
import logging
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq
import requests
from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import connectors
import db
from connectors.base import SqlConnector
import drive
import pipeline_datasets as pdata
import run_as as acting

log = logging.getLogger("bluesandai.pipeline_runtime")
router = APIRouter(prefix="/api/pipeline")

_env: Callable[[str], str] = lambda key: ""
DB_PATH: Path = Path()
_lock = threading.Lock()
_stop = threading.Event()
MAX_ROWS = pdata.MAX_ROWS


def configure(data_dir: Path, env: Callable[[str], str]) -> None:
    global _env, DB_PATH
    _env = env
    folder = data_dir / "pipeline"
    folder.mkdir(parents=True, exist_ok=True)
    DB_PATH = folder / "runtime.sqlite"
    with _db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS builds (
                id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
                created_at TEXT NOT NULL, finished_at TEXT, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS builds_pipeline ON builds (pipeline_id, created_at);
            CREATE TABLE IF NOT EXISTS state (pipeline_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (pipeline_id, key));
            CREATE TABLE IF NOT EXISTS stream_records (stream_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (stream_id, seq));
            CREATE TABLE IF NOT EXISTS streams (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            """
        )
    import pipeline_schedules

    pipeline_schedules.configure()


def _db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def web_url() -> str:
    return (_env("BLUESANDAI_WEB_URL") or "http://127.0.0.1:8888").rstrip("/")


# ------------------------------------------------------------------------------------------------
# builds
# ------------------------------------------------------------------------------------------------


def _save_build(rec: dict) -> dict:
    rec["updated_at"] = _now()
    lease = rec.get("queue_lease")
    if lease and rec["status"] in ("succeeded", "failed", "cancelled"):
        # a streaming job that stopped, failed or was given up on frees its room in the resource queue
        rec["queue_lease"] = None
        rec.setdefault("queue_lease_released", lease)
    with _lock, _db() as con:
        con.execute(
            "INSERT OR REPLACE INTO builds (id, pipeline_id, status, trigger, created_at, finished_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (rec["id"], rec["pipeline_id"], rec["status"], rec["trigger"], rec["created_at"], rec.get("finished_at"), json.dumps(rec, ensure_ascii=False)),
        )
    if lease and rec["status"] in ("succeeded", "failed", "cancelled"):
        import resource_queues

        _renewed.pop(lease, None)
        try:
            resource_queues.release(lease)
        except Exception:  # noqa: BLE001 - the lease then expires by itself
            log.exception("could not release the resource queue lease of build %s", rec["id"])
    return rec


def _build(build_id: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM builds WHERE id = ?", (build_id,)).fetchone()
    if not row:
        raise HTTPException(404, "build not found")
    return json.loads(row[0])


def _builds(pipeline_id: Optional[str] = None, limit: int = 50, status: Optional[str] = None) -> list[dict]:
    where, params = [], []
    if pipeline_id:
        where.append("pipeline_id = ?")
        params.append(pipeline_id)
    if status:
        where.append("status = ?")
        params.append(status)
    sql = "SELECT record FROM builds" + (f" WHERE {' AND '.join(where)}" if where else "") + " ORDER BY created_at DESC LIMIT ?"
    with _db() as con:
        return [json.loads(r[0]) for r in con.execute(sql, (*params, limit)).fetchall()]


class NewBuild(BaseModel):
    pipeline_id: str
    branch: str = "main"
    # outputs to build; empty = every output
    outputs: list[str] = []
    trigger: str = "manual"
    schedule_id: Optional[str] = None
    # "single" | "withUpstream" | "downstream" | "between" (schedules); manual deploys build what they name
    target: str = "single"
    # replay from the start of the input data: incremental inputs are read in full and outputs reset
    replay: bool = False
    # parameter values (by name) over the pipeline's defaults
    parameters: dict[str, Any] = {}
    # a schedule's parallel run setup {id, name}: its outputs are written as "name [setup]"
    run_setup: Optional[dict] = None
    # build an earlier saved version of the logic (vc.versions id) instead of the branch's latest
    version_id: Optional[str] = None
    # schedules: the run this build belongs to, its retry settings, and the attempt
    schedule_run: Optional[str] = None
    schedule_cfg: Optional[dict] = None
    attempt: int = 1
    retry_of: Optional[str] = None
    # a rerun of an earlier build (same outputs, maybe another logic version)
    rerun_of: Optional[str] = None
    # schedules: the build scope ("project" / "user") and the user a user-scoped schedule runs as (its owner); a build
    # a user starts runs as them (queue_build sets it from the request, whatever is sent)
    scope: Optional[str] = None
    run_as: Optional[str] = None
    # Project-scoped schedules: whose markings the build reads and writes with (the schedule's owner), and the Projects
    # it may write in (its Project roles come from these)
    markings_of: Optional[str] = None
    scope_projects: list[str] = []


def _identity_fields(req: NewBuild) -> dict:
    """Who the build runs as (see "the identity a build runs as" below). A build queued while a user's request is
    handled — Build / Deploy, a rerun — runs as that user, whatever the request says; a schedule's build as its
    schedule decided (its owner, or its Projects with its owner's markings); a build the platform queues by itself
    (demos, sign-in off) as the system."""
    if auth.enabled() and req.schedule_id is None:
        actor = auth.actor_id()
        if actor:
            return {"run_as": actor, "scope": None, "markings_of": None, "scope_projects": [], "run_as_name": acting.who(actor)}
    out = {"run_as": req.run_as, "scope": req.scope, "markings_of": req.markings_of, "scope_projects": list(req.scope_projects or [])}
    if auth.enabled() and (req.run_as or req.markings_of):
        out["run_as_name"] = acting.who(req.run_as or req.markings_of)
    return out


def queue_build(req: NewBuild) -> dict:
    item = drive._item(req.pipeline_id)
    rec = {
        "id": "build-" + uuid.uuid4().hex[:12],
        "pipeline_id": req.pipeline_id,
        "pipeline_name": item["name"].removesuffix(pdata.PIPELINE_EXT),
        "branch": req.branch,
        "outputs": req.outputs,
        "trigger": req.trigger,
        "schedule_id": req.schedule_id,
        "target": req.target,
        "replay": req.replay,
        "parameters": req.parameters,
        "run_setup": req.run_setup,
        "version_id": req.version_id,
        "schedule_run": req.schedule_run,
        "schedule_cfg": req.schedule_cfg,
        "attempt": req.attempt,
        "retry_of": req.retry_of,
        "rerun_of": req.rerun_of,
        **_identity_fields(req),
        "status": "queued",
        "created_at": _now(),
        "started_at": None,
        "finished_at": None,
        "jobs": [],
        "logs": [{"at": _now(), "level": "info", "msg": f"Queued ({req.trigger}){' · replay from start of input data' if req.replay else ''}"}],
        "validation": [],
        "cancel": False,
    }
    rec.update(_build_inputs(item, req))
    if rec.get("pipeline_type") == "streaming":
        # the room the job asks of its Project's resource queue (_stream_lease)
        rec["streaming_profile"] = _streaming_profile(item, req)
    # one at a time, so two streaming deploys (or restarts) queued together still see each other
    with _queue_lock:
        if rec.get("pipeline_type") == "streaming":
            _replace_streaming(rec)
        _save_build(rec)
    threading.Thread(target=_dispatch, args=(rec["id"],), daemon=True, name=f"build-{rec['id']}").start()
    return rec


# a deploy waits this long for the streaming job it replaces to stop
REPLACE_WAIT_S = 90
_queue_lock = threading.Lock()


def _replace_streaming(rec: dict) -> None:
    """A deploy of a streaming pipeline replaces its running job (same branch and run setup): one job per pipeline
    reads the input streams from the checkpoint. The old job is asked to stop; the new one is dispatched once it
    has stopped and saved its checkpoint (see _dispatch)."""
    setup = (rec.get("run_setup") or {}).get("id")
    old = [b for b in _builds(rec["pipeline_id"], 50)
           if b["status"] in ("queued", "running") and (b.get("branch") or "main") == (rec["branch"] or "main") and (b.get("run_setup") or {}).get("id") == setup]
    for b in old:
        b["cancel"] = True
        b["logs"].append({"at": _now(), "level": "warn", "msg": f"Replaced by a new deploy ({rec['id']}): stopping at the next checkpoint"})
        if b["status"] == "queued":
            b.update(status="cancelled", finished_at=_now())
        _save_build(b)
    running = [b["id"] for b in old if b["status"] == "running"]
    if running:
        rec["replaces"] = running
        rec["logs"].append({"at": _now(), "level": "info", "msg": f"Replaces the running streaming job {', '.join(running)}: starts when it has stopped"})


def _streaming_profile(item: dict, req: NewBuild) -> str:
    """The streaming profile of the branch being deployed (Build settings → streaming profile; default xs)."""
    import pipeline_schedules

    try:
        content = pipeline_schedules.branch_content(json.loads(drive.read_bytes(item)), req.branch, req.version_id)
        return str(((content.get("buildSettings") or {}).get("streamingProfile")) or "xs")
    except Exception:  # noqa: BLE001
        return "xs"


def _stream_lease(build_id: str) -> bool:
    """A streaming job holds room in its Project's resource queue for as long as it runs (resource_queues.py): it waits
    here, still queued, until the queue has room (the build shows the queue and the jobs ahead); once granted the lease
    is renewed by the job's progress reports (patch_build) and released when the build stops, fails or is replaced
    (_save_build). One lease per pipeline, branch and run setup. False when the build was cancelled or failed."""
    import resource_queues as rq

    rec = _build(build_id)
    vcpus = rq.streaming_vcpus(rec.get("streaming_profile"))
    holder = f"stream:{rec['pipeline_id']}:{rec.get('branch') or 'main'}:{(rec.get('run_setup') or {}).get('id') or ''}"
    label = f"{rec.get('pipeline_name') or rec['pipeline_id']} · streaming{'' if (rec.get('branch') or 'main') == 'main' else ' @' + rec['branch']}"
    waited = time.monotonic()

    def on_wait(lease: dict) -> None:
        r = _build(build_id)
        if r["status"] != "queued":
            return
        r["queue"] = {"name": lease["queue_name"], "ahead": lease["ahead"], "in_use": lease["in_use"], "vcpu_limit": lease["vcpu_limit"], "vcpus": lease["vcpus"]}
        r["logs"].append({"at": _now(), "level": "info", "msg": f"Waiting in the Project's resource queue {lease['queue_name']} ({lease['in_use']}/{lease['vcpu_limit']} vCPUs in use, "
                                                               f"{lease['ahead']} job{'' if lease['ahead'] == 1 else 's'} ahead; this streaming job needs {lease['vcpus']})"})
        _save_build(r)

    def cancelled() -> bool:
        r = _build(build_id)
        return r["status"] != "queued" or bool(r.get("cancel"))

    try:
        lease_id = rq.acquire(rec["pipeline_id"], vcpus, label, "stream", on_wait, cancelled, holder=holder)
    except Exception as e:  # noqa: BLE001
        r = _build(build_id)
        if r["status"] == "queued":
            r.update(status="failed", finished_at=_now(), failure_type="immediate", error=f"Resource queue: {getattr(e, 'detail', e)}")
            r["logs"].append({"at": _now(), "level": "error", "msg": r["error"]})
            _save_build(r)
        return False
    if lease_id is None:
        return False
    # from now on the job's reports renew it: the lease outlives this process if the job keeps running
    rq.detach(lease_id, LEASE_TTL_S)
    r = _build(build_id)
    if r["status"] != "queued" or r.get("cancel"):
        rq.release(lease_id)
        return False
    r["queue_lease"] = lease_id
    if r.get("queue"):
        r["queue"]["waited_s"] = round(time.monotonic() - waited, 1)
        r["logs"].append({"at": _now(), "level": "info", "msg": f"Started after {r['queue']['waited_s']} s in the resource queue {r['queue']['name']}"})
    _save_build(r)
    return True


# a streaming job's lease lives this long without a report (the watchdog fails a silent job after 180 s and releases it)
LEASE_TTL_S = 300
# renewed at most this often by the job's reports
LEASE_RENEW_S = 30.0
_renewed: dict[str, float] = {}


def _build_inputs(item: dict, req: NewBuild) -> dict:
    """What the build starts from, for up-to-date checks and comparing builds: the logic version and its hash,
    each input's version, and each output's signature (its inputs' versions and logic)."""
    import pipeline_schedules

    try:
        content = pipeline_schedules.branch_content(json.loads(drive.read_bytes(item)), req.branch, req.version_id)
    except Exception:  # noqa: BLE001
        return {}
    versions = [v for v in ((content.get("vc") or {}).get("versions") or []) if v.get("branch") == (req.branch or "main")]
    chosen = next((v for v in versions if v.get("id") == req.version_id), None) if req.version_id else max(versions, key=lambda v: v.get("at") or "", default=None)
    sigs = pipeline_schedules.output_signatures(content, req.parameters)
    inputs: dict[str, dict] = {}
    for d_id, d in (content.get("datasets") or {}).items():
        if isinstance(d, dict):
            v = next((s["inputs"][d_id] for s in sigs.values() if d_id in s["inputs"]), None)
            inputs[d_id] = {"name": d.get("name"), "kind": (d.get("ref") or {}).get("kind") or "manual", "version": v if v is not None else (_ref_version(d["ref"]) if d.get("ref") else None)}
    return {
        "pipeline_type": content.get("type") or "batch",
        "logic_hash": _logic_hash(content),
        "logic_version": {"id": chosen.get("id"), "at": chosen.get("at"), "message": chosen.get("message"), "author": chosen.get("author")} if chosen else None,
        "input_versions": inputs,
        "output_sigs": sigs,
    }


# how long a build handed to a slow runner may stay queued before it counts as not started
RUNNER_START_WAIT_S = 180


def _fail_unstarted(build_id: str) -> None:
    rec = _build(build_id)
    if rec["status"] == "queued":
        rec.update(status="failed", finished_at=_now(), error=f"The build runner at {web_url()} did not start the build within {RUNNER_START_WAIT_S}s")
        rec["logs"].append({"at": _now(), "level": "error", "msg": rec["error"]})
        _save_build(rec)


def _dispatch(build_id: str) -> None:
    """Hands the build to the runner in the web server; the runner reports back with PATCH /builds/{id}. A
    streaming deploy first waits for the job it replaces to stop, so the two never read the same records."""
    replaces = _build(build_id).get("replaces") or []
    deadline = time.time() + REPLACE_WAIT_S
    while replaces and time.time() < deadline:
        if all(_build(b)["status"] not in ("queued", "running") for b in replaces):
            break
        time.sleep(1)
    else:
        if replaces:
            rec = _build(build_id)
            rec["logs"].append({"at": _now(), "level": "warn", "msg": f"The replaced job did not stop within {REPLACE_WAIT_S}s: starting anyway"})
            _save_build(rec)
    if _build(build_id)["status"] != "queued":
        return  # cancelled while it waited
    blocked = identity_block(_build(build_id))
    if blocked:
        # the user it runs as is gone, deactivated or no longer reads the pipeline: never handed to the runner
        rec = _build(build_id)
        rec.update(status="failed", finished_at=_now(), failure_type="immediate", error=f"Did not start: {blocked}")
        rec["logs"].append({"at": _now(), "level": "error", "msg": rec["error"]})
        _save_build(rec)
        _finished(rec)
        return
    if _build(build_id).get("pipeline_type") == "streaming" and not _stream_lease(build_id):
        return  # cancelled while waiting in the resource queue
    try:
        import auth

        # the runner calls this API back with the service token
        r = requests.post(f"{web_url()}/api/pipeline-runner", json={"buildId": build_id, "token": auth.SERVICE_TOKEN}, timeout=30)
        if r.status_code >= 300:
            raise RuntimeError(f"runner answered {r.status_code}: {r.text[:300]}")
    except requests.ReadTimeout:
        # the runner got the request but answered slowly (e.g. its route compiling): it may well be running the build,
        # which it reports itself; fail only if it never does
        rec = _build(build_id)
        rec["logs"].append({"at": _now(), "level": "warn", "msg": f"The build runner at {web_url()} is slow to answer: waiting for it to start the build"})
        _save_build(rec)
        threading.Timer(RUNNER_START_WAIT_S, _fail_unstarted, args=(build_id,)).start()
    except Exception as e:  # noqa: BLE001
        rec = _build(build_id)
        if rec["status"] == "queued":
            rec.update(status="failed", finished_at=_now(), error=f"Could not start the build runner at {web_url()}: {e}")
            rec["logs"].append({"at": _now(), "level": "error", "msg": rec["error"]})
            _save_build(rec)


@router.post("/builds")
def create_build(req: NewBuild) -> dict:
    drive._require_db()
    # building writes the pipeline's outputs: Editors of its Project
    auth.check_item_id(req.pipeline_id, "editor")
    check_starter(req.pipeline_id, req.branch, req.outputs, req.version_id)
    p = auth.current()
    if auth.enabled() and not (p and p.get("service")):
        # a clicked build runs as the user who clicked: no schedule identity, owner or scope can be claimed here
        req = req.model_copy(update={"schedule_id": None, "schedule_run": None, "schedule_cfg": None, "retry_of": None,
                                     "run_as": None, "scope": None, "markings_of": None, "scope_projects": []})
    return queue_build(req)


def check_starter(pipeline_id: str, branch: str = "main", outputs: Optional[list[str]] = None, version_id: Optional[str] = None,
                  raw: Optional[dict] = None) -> None:
    """A build started by a user: the runner reads the inputs and writes the outputs for the user (the build runs as
    them, checked again at every read and write), so the user must be able to read every input and change every
    folder the outputs are written to (Editor) — refused here, before it starts (403). Schedules check their owner
    or their Projects when they run; whoever creates, changes, turns on or runs one is checked here too. `raw`: the
    pipeline file's content while it is being saved (default: as stored)."""
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return
    import pipeline_schedules

    try:
        raw = raw if raw is not None else json.loads(drive.read_bytes(drive._item(pipeline_id)))
        content = pipeline_schedules.branch_content(raw, branch or "main", version_id)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - an unreadable file fails in the runner with its own message
        return
    for iid in dict.fromkeys(pdata.content_input_items(content) + pdata.content_input_items(raw)):
        if not auth.can_access(iid):
            name = (db.drive_get(iid) or {}).get("name") or iid
            raise HTTPException(403, f"You cannot read the input {name}: a build reads its inputs with your access",
                                headers=auth.access_header("marking", markings=sorted(auth.effective_markings(iid))))
    # old pipeline streams read as inputs: their home's rules (see "streams")
    for d in list((content.get("datasets") or {}).values()) + list((raw.get("datasets") or {}).values()):
        ref = (d or {}).get("ref") or {}
        if isinstance(ref, dict) and ref.get("kind") == "stream" and ref.get("streamId"):
            try:
                s = _stream(str(ref["streamId"]))
            except HTTPException:
                continue  # a deleted stream fails in the runner with its own message
            if _stream_access(s, p) == "none":
                raise HTTPException(403, f"You cannot read the stream input {(d or {}).get('name') or 'of the pipeline'}: a build reads its inputs with your access")
    wanted = set(outputs or [])
    for o in content.get("outputs") or []:
        if wanted and o.get("id") not in wanted:
            continue
        folder = pipeline_schedules._output_folder(content, o)
        if folder:
            try:
                auth.check_item_id(folder, "editor")
            except HTTPException as e:
                raise HTTPException(403, f"The output {o.get('name') or o.get('id')} is written where you cannot write: {e.detail}") from None


def _check_build(rec: dict, need: str = "viewer") -> dict:
    """A build is seen (and acted on) with its pipeline: the pipeline's markings and a role on its Project."""
    auth.check_item_id(rec.get("pipeline_id"), need)
    return rec


@router.get("/builds")
def list_builds(pipeline_id: Optional[str] = None, limit: int = 50, status: Optional[str] = None) -> list[dict]:
    return [b for b in _builds(pipeline_id, max(1, min(limit, 500)), status) if auth.can_access(b.get("pipeline_id"))]


@router.get("/builds/{build_id}")
def get_build(build_id: str) -> dict:
    return _check_build(_build(build_id))


class BuildPatch(BaseModel):
    status: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    jobs: Optional[list[dict]] = None
    logs: Optional[list[dict]] = None
    validation: Optional[list[dict]] = None
    error: Optional[str] = None
    summary: Optional[dict] = None
    # a streaming job (runs until stopped)
    streaming: Optional[bool] = None
    # why a failed build failed: immediate (validation, never ran), transient (network, retried) or persistent
    failure_type: Optional[str] = None
    # input pre-conditions checked before the jobs ran
    preconditions: Optional[list[dict]] = None


# a streaming job that failed on a transient error is restarted (from its checkpoint) up to this many times
# in a row; a job that ran for 10 minutes resets the count
MAX_AUTO_RESTARTS = 5


def _restart_streaming(rec: dict, reason: str, delay: float = 0) -> None:
    """Queue the same streaming job again; it resumes from its checkpointed offsets and state."""
    started = rec.get("started_at") or rec["created_at"]
    try:
        ran = (datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()
    except ValueError:
        ran = 0
    count = 0 if ran >= 600 else int(rec.get("auto_restarts") or 0)
    if count >= MAX_AUTO_RESTARTS:
        rec["logs"].append({"at": _now(), "level": "error", "msg": f"Not restarted: {count} automatic restarts in a row failed"})
        _save_build(rec)
        return

    def go() -> None:
        try:
            # the restarted job runs as the one it replaces (its user, or its schedule's Projects and owner's markings)
            new = queue_build(NewBuild(pipeline_id=rec["pipeline_id"], branch=rec.get("branch") or "main", outputs=rec.get("outputs") or [], trigger=f"auto-restart ({reason})", schedule_id=rec.get("schedule_id"), target=rec.get("target") or "single",
                                       run_as=rec.get("run_as"), scope=rec.get("scope"), markings_of=rec.get("markings_of"), scope_projects=rec.get("scope_projects") or []))
            new["auto_restarts"] = count + 1
            new["restart_of"] = rec["id"]
            _save_build(new)
            log.info("restarted streaming build %s as %s (%s)", rec["id"], new["id"], reason)
        except Exception:  # noqa: BLE001
            log.exception("could not restart streaming build %s", rec["id"])

    rec["logs"].append({"at": _now(), "level": "warn", "msg": f"Restarting the streaming job{f' in {int(delay)}s' if delay else ''} ({reason})"})
    _save_build(rec)
    if delay:
        threading.Timer(delay, go).start()
    else:
        go()


@router.patch("/builds/{build_id}")
def patch_build(build_id: str, req: BuildPatch) -> dict:
    # the runner reports progress with the API's service token; users cancel (POST …/cancel) and never write records
    p = auth.current()
    if auth.enabled() and not (p and p.get("service")):
        raise HTTPException(403, "Only the build runner updates build records")
    rec = _build(build_id)
    was = rec["status"]
    for k, v in req.model_dump(exclude_none=True).items():
        if k == "logs":
            rec["logs"] = (rec.get("logs") or []) + v
        else:
            rec[k] = v
    rec = _save_build(rec)
    lease = rec.get("queue_lease")
    if lease and rec["status"] in ("queued", "running") and time.monotonic() - _renewed.get(lease, 0) >= LEASE_RENEW_S:
        # a running streaming job's reports keep its room in the resource queue
        import resource_queues

        _renewed[lease] = time.monotonic()
        try:
            resource_queues.renew(lease)
        except Exception:  # noqa: BLE001
            log.exception("could not renew the resource queue lease of build %s", build_id)
    if was != rec["status"] and rec["status"] in ("succeeded", "failed", "cancelled"):
        import pipeline_schedules

        try:
            pipeline_schedules.on_build_finished(rec)
        except Exception:  # noqa: BLE001
            log.exception("schedule bookkeeping for build %s failed", build_id)
    if was != "failed" and rec["status"] == "failed" and rec.get("streaming") and rec.get("failure_type") == "transient" and not rec.get("cancel"):
        _restart_streaming(rec, "transient failure", delay=30)
    return rec


@router.post("/builds/{build_id}/cancel")
def cancel_build(build_id: str) -> dict:
    rec = _build(build_id)
    auth.check_item_id(rec.get("pipeline_id"), "editor")
    if rec["status"] in ("queued", "running"):
        rec["cancel"] = True
        rec["logs"].append({"at": _now(), "level": "warn", "msg": "Cancel requested"})
        if rec["status"] == "queued":
            rec.update(status="cancelled", finished_at=_now())
        _save_build(rec)
    return rec


def _finished(rec: dict) -> None:
    """Schedule bookkeeping (retries, failure counts) of a build that ended here rather than in the runner."""
    import pipeline_schedules

    try:
        pipeline_schedules.on_build_finished(rec)
    except Exception:  # noqa: BLE001
        log.exception("schedule bookkeeping for build %s failed", rec["id"])


# ------------------------------------------------------------------------------------------------
# the identity a build runs as
# ------------------------------------------------------------------------------------------------
# The runner calls this API with the service token, which no marking or Project role limits. A build acts for someone,
# though: the user who clicked Build (or Deploy, or Rerun), a user-scoped schedule's owner, or — for a Project-scoped
# schedule — its Projects (where it may write) with its owner's markings (what it may read and write). That identity is
# kept on the build (run_as / scope, markings_of, scope_projects) and checked DURING the build, against the user's
# markings and Project roles as they are at that moment: the runner asks POST /builds/{id}/access before every input
# read and output write (each batch of a streaming job), and sends the header X-Bsai-Build: <build id> with every
# call it makes for the build, so this API's own pipeline endpoints (dataset reads and deploys, output writers, virtual
# tables, external pipelines, stream records) check the build's identity too. A build whose user lost a marking, a
# role, was deactivated or deleted fails on its next read or write, with the reason. Builds the platform queues by
# itself (demos) and every build with sign-in off run as the system, as before. Old pipeline streams follow their home
# (see "streams" below): Viewer reads, Editor writes.

BUILD_HEADER = "x-bsai-build"
ACCESS_KINDS = ("item", "folder", "pipeline", "datasource", "stream", "ingest", "connection")


def _build_mode(rec: dict) -> str:
    if rec.get("scope") == "project":
        return "project"
    return "user" if rec.get("run_as") else "system"


def _identity(rec: dict) -> tuple[str, Optional[dict], str]:
    """(mode, principal, display name) of the build's identity, the principal as it is now; raises
    acting.OwnerUnavailable when a build that runs as a user cannot (the user is gone or deactivated)."""
    mode = _build_mode(rec)
    if mode == "system":
        return mode, None, ""
    uid = rec.get("run_as") if mode == "user" else rec.get("markings_of")
    who = acting.who(uid) if uid else ""
    p = auth.principal_of(uid) if uid and uid not in ("local", "system") else None
    if mode == "user" and p is None:
        status = (auth.user_label(uid) or {}).get("status", "deleted")
        starter = "the schedule's owner" if rec.get("schedule_id") else "the user who started the build"
        raise acting.OwnerUnavailable(f"{starter} {who} is {status}: the build does not run without them")
    return mode, p, who


def _what(op: str, kind: str, label: Optional[str]) -> str:
    if kind == "pipeline":
        return "the pipeline"
    if op == "read":
        return f'the input "{label}"' if label else "an input of the pipeline"
    return f'the output "{label}"' if label else "an output of the pipeline"


def _targets(kind: str, rid: Optional[str]) -> list[dict]:
    """What a read or write touches: [{need: markings, project, item | stream}]; [] when it does not exist (the
    read or write itself then fails)."""
    if kind in ("item", "folder", "pipeline"):
        if not rid:
            # the top level of Files (a folder target only)
            return [{"need": set(), "project": None, "item": None}] if kind == "folder" else []
        try:
            it = db.drive_get(rid)
        except Exception:  # noqa: BLE001
            it = None
        return [{"need": auth.effective_markings(rid), "project": auth.project_of(rid), "item": rid}] if it else []
    if kind == "datasource" and rid:
        import datasources

        try:
            row = datasources._source_row(rid)
            ids = list(datasources._view(row)) + [x for x in ((row.get("state") or {}).get("item_id"), row.get("folder_id")) if x]
        except Exception:  # noqa: BLE001 - a missing source (or no database): the read itself fails
            return []
        return [t for i in dict.fromkeys(ids) for t in _targets("item", i)]
    if kind == "stream" and rid:
        try:
            s = _stream(rid)
        except HTTPException:
            return []
        home = _stream_home(s)
        need = set(auth.effective_markings(auth.resource_id(STREAM_KIND, s["id"]))) | (auth.effective_markings(home) if home else set())
        return [{"need": need, "project": auth.project_of(home) if home else None, "stream": s}]
    if kind in ("ingest", "connection") and rid:
        res = "stream" if kind == "ingest" else "connection"
        return [{"need": auth.resource_effective(res, rid), "project": auth.resource_project(res, rid), "resource": res}]
    return []


def _plural(names: list[str]) -> str:
    return f"marking{'s' if len(names) > 1 else ''} {', '.join(names)}"


def build_denies(rec: dict, op: str, kind: str, rid: Optional[str], label: Optional[str] = None,
                 ident: Optional[tuple[str, Optional[dict], str]] = None) -> Optional[str]:
    """Why the build may not do this read ("read") or write ("write") now, as the identity it runs as; None: it may.
    `ident`: the build's _identity, when the caller checks many things at once."""
    if not auth.enabled():
        return None
    if rec.get("status") not in ("queued", "running"):
        return f"the build is {rec.get('status')}: it no longer reads or writes data"
    try:
        mode, p, who = ident or _identity(rec)
    except acting.OwnerUnavailable as e:
        return str(e)
    if mode == "system":
        return None
    what = _what(op, kind, label)
    for t in _targets(kind, rid):
        need = t["need"]
        if mode == "project":
            if need and p is None:
                owner = rec.get("markings_of")
                if not owner:
                    return f"{what} is marked and the schedule has no owner whose markings the build can run with: an Editor holding the markings must save it"
                status = (auth.user_label(owner) or {}).get("status", "deleted")
                return f"{what} is marked and the schedule's owner {who} is {status}: an Editor holding the markings must take it over (edit and save it)"
            missing = auth.missing_markings(need, p.get("markings")) if need and p else set()
            if missing:
                return f"the build runs with the markings of the schedule's owner {who}, who no longer holds the {_plural(auth._marking_names(sorted(missing)))} that {what} carries"
            if op == "write" and kind != "pipeline" and not ("resource" in t and t["project"] is None):
                # Project roles come from the schedule's scope: it writes only inside its Projects (an ingest stream or
                # connection outside Projects: its markings alone, as for any user)
                import pipeline_schedules as ps

                allowed = set(rec.get("scope_projects") or [])
                proj = t["project"]
                if not ((proj in allowed) if allowed else proj is None):
                    names = ", ".join(ps._project_name(x) for x in allowed) or "the top level of Files"
                    return f"{what} is written in {ps._project_name(proj)}, outside the schedule's Projects ({names})"
            continue
        missing = auth.missing_markings(need, p.get("markings")) if need else set()
        if missing:
            return f"the build runs as {who}, who no longer holds the {_plural(auth._marking_names(sorted(missing)))} that {what} carries"
        if "stream" in t:
            acc = _stream_access(t["stream"], p)
            ok = acc != "none" if op == "read" else acc == "edit"
        elif "resource" in t:
            ok = not t["project"] or auth._rank(auth.role_for(t["project"], p)) >= auth._rank("viewer" if op == "read" else "editor")
        elif t["item"] is None:
            ok = True  # the top level of Files, as for a user's own build (check_starter)
        else:
            ok = auth.can_access(t["item"], p) if op == "read" else auth.has_operation(t["item"], "edit", p)
        if not ok:
            proj = t["project"]
            if op == "read":
                return (f"the build runs as {who}, who has no role that reads {what} (Viewer on {_project_label(proj)})" if proj
                        else f"the build runs as {who}, who cannot read {what}")
            return (f"the build runs as {who}, who is not an Editor of {_project_label(proj)}, where {what} is written" if proj
                    else f"the build runs as {who}, who cannot write {what}")
    return None


def _project_label(project_id: Optional[str]) -> str:
    try:
        return (db.drive_get(project_id) or {}).get("name") or "its Project"
    except Exception:  # noqa: BLE001
        return "its Project"


def identity_block(rec: dict) -> Optional[str]:
    """Why a queued build cannot start as its identity (gone, deactivated, cannot read the pipeline); None: it can."""
    if not auth.enabled() or _build_mode(rec) == "system":
        return None
    return build_denies({**rec, "status": "queued"}, "read", "pipeline", rec.get("pipeline_id"))


class AccessCheck(BaseModel):
    op: Literal["read", "write"]
    kind: Literal["item", "folder", "pipeline", "datasource", "stream", "ingest", "connection"]
    id: Optional[str] = Field(None, max_length=200)
    # the input's or output's name in the pipeline, for the reason
    label: Optional[str] = Field(None, max_length=300)


class AccessChecks(BaseModel):
    checks: list[AccessCheck] = Field(default_factory=list, max_length=500)


@router.post("/builds/{build_id}/access")
def build_access(build_id: str, req: AccessChecks) -> dict:
    """The runner, before reading inputs or writing outputs: may the build's identity do it now? 403 with the reason
    when it may not (the runner then fails the build with it)."""
    p = auth.current()
    if auth.enabled() and not (p and p.get("service")):
        raise HTTPException(403, "Only the build runner checks a build's access")
    rec = _build(build_id)
    _deny_any(rec, [(c.op, c.kind, c.id, c.label) for c in req.checks])
    return {"ok": True, "mode": _build_mode(rec), "run_as": rec.get("run_as") or rec.get("markings_of")}


def _deny_any(rec: dict, checks: list[tuple[str, str, Optional[str], Optional[str]]]) -> None:
    """403 with the reason of the first check the build's identity fails."""
    if not checks or not auth.enabled():
        return
    try:
        ident = _identity(rec)
    except acting.OwnerUnavailable as e:
        raise HTTPException(403, str(e)[:1].upper() + str(e)[1:]) from None
    for op, kind, rid, label in checks:
        why = build_denies(rec, op, kind, rid, label, ident)
        if why:
            raise HTTPException(403, why[:1].upper() + why[1:])


def enforce_build_identity(request: Optional[Request], op: str, kind: str, rid: Optional[str], label: Optional[str] = None,
                           more: Optional[list[tuple[str, str, Optional[str], Optional[str]]]] = None) -> None:
    """In this API's pipeline endpoints: a call the runner makes for a build (service token + X-Bsai-Build) is checked
    against the build's identity (403 with the reason); `more`: further (op, kind, id, label) checks of the same call.
    Users' own calls are checked as themselves already; the service token without the header (the platform's own
    jobs) is the system, as before."""
    if request is None or not auth.enabled():
        return
    build_id = request.headers.get(BUILD_HEADER)
    p = auth.current()
    if not build_id or not (p and p.get("service")):
        return
    try:
        rec = _build(build_id)
    except HTTPException:
        raise HTTPException(403, "The build this call is made for does not exist") from None
    _deny_any(rec, [(op, kind, rid, label), *(more or [])])


# ------------------------------------------------------------------------------------------------
# per-pipeline state: incremental watermarks, output deploy status, schedule bookkeeping
# ------------------------------------------------------------------------------------------------


def get_state(pipeline_id: str, key: str, default: Any = None) -> Any:
    with _db() as con:
        row = con.execute("SELECT value FROM state WHERE pipeline_id = ? AND key = ?", (pipeline_id, key)).fetchone()
    return json.loads(row[0]) if row else default


def set_state(pipeline_id: str, key: str, value: Any) -> None:
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO state (pipeline_id, key, value) VALUES (?, ?, ?)", (pipeline_id, key, json.dumps(value, ensure_ascii=False)))


@router.get("/state/{pipeline_id}")
def get_pipeline_state(pipeline_id: str) -> dict:
    # incremental watermarks, outputs' items, checkpoints: seen with the pipeline (markings, a role on its Project)
    auth.check_item_id(pipeline_id, "viewer")
    return read_state(pipeline_id)


def read_state(pipeline_id: str) -> dict:
    with _db() as con:
        rows = con.execute("SELECT key, value FROM state WHERE pipeline_id = ?", (pipeline_id,)).fetchall()
    return {k: json.loads(v) for k, v in rows}


class StatePut(BaseModel):
    values: dict[str, Any]


@router.put("/state/{pipeline_id}")
def write_state(pipeline_id: str, req: StatePut) -> dict:
    auth.check_item_id(pipeline_id, "editor")
    for k, v in req.values.items():
        set_state(pipeline_id, k, v)
    return read_state(pipeline_id)


@router.delete("/state/{pipeline_id}/{key}")
def delete_state(pipeline_id: str, key: str) -> dict:
    auth.check_item_id(pipeline_id, "editor")
    with _lock, _db() as con:
        con.execute("DELETE FROM state WHERE pipeline_id = ? AND key = ?", (pipeline_id, key))
    return {"deleted": key}


# ------------------------------------------------------------------------------------------------
# virtual tables: full reads and writes through the database connections
# ------------------------------------------------------------------------------------------------


def _connector(conn_id: str, writable: bool = False) -> connectors.DatabaseConnector:
    import datasources

    return datasources._open(conn_id, writable=writable)


@router.get("/virtual/read")
def virtual_read(connection_id: str, database: str, schema: str, table: str, limit: int = MAX_ROWS, request: Request = None) -> dict:  # type: ignore[assignment]
    """Every row of a table (up to the limit), typed as the pipeline's columns."""
    import connectors.normalize as norm

    enforce_build_identity(request, "read", "connection", connection_id, table)
    with _connector(connection_id) as c:
        info = c.get_table_schema(database, schema, table)
        cols = info["columns"]
        names = [col["name"] for col in cols]
        rows: list[tuple] = []
        for batch in c.stream_table(database, schema, table, names, 5000):
            rows.extend(batch)
            if len(rows) >= limit:
                rows = rows[:limit]
                break
        return {"columns": [{"name": col["name"], "type": col["type"]} for col in cols], "rows": norm.json_rows(cols, rows)}


_SQL_TYPES = {
    "String": "TEXT",
    "Boolean": "BOOLEAN",
    "Byte": "SMALLINT",
    "Short": "SMALLINT",
    "Integer": "INTEGER",
    "Long": "BIGINT",
    "Float": "REAL",
    "Double": "DOUBLE PRECISION",
    "Decimal": "DECIMAL(38, 18)",
    "Date": "DATE",
    "Timestamp": "TIMESTAMP",
    "Binary": "TEXT",
}


class VirtualWrite(BaseModel):
    connection_id: str
    database: str = ""
    schema_name: str = Field("", alias="schema")
    table: str
    mode: str = "snapshot"
    columns: list[pdata.Column]
    rows: list[dict[str, Any]]

    model_config = {"populate_by_name": True}


@router.post("/virtual/write")
def virtual_write(req: VirtualWrite, request: Request = None) -> dict:  # type: ignore[assignment]
    """Writes rows to a table of a SQL database: created if missing; snapshot replaces its rows, append adds."""
    # writing through a connection changes its source: Editor on the connection's Project (the runner: its build's
    # identity)
    auth.check_resource("connection", req.connection_id, "editor")
    enforce_build_identity(request, "write", "connection", req.connection_id, req.table)
    with _connector(req.connection_id, writable=True) as c:
        if not isinstance(c, SqlConnector):
            raise HTTPException(400, "virtual table outputs need a SQL database connection")
        database = req.database or c.config.get("database") or ""
        schema = req.schema_name or ("public" if c.__class__.__name__.lower().startswith("postgres") else "")
        ref = (f"{c.ident(schema)}." if schema else "") + c.ident(req.table)
        if c.qualify_database and database:
            ref = f"{c.ident(database)}.{ref}"
        cols = ", ".join(f"{c.ident(col.name)} {_SQL_TYPES.get(col.type, 'TEXT')}" for col in req.columns)
        conn = c.conn(database)
        cur = conn.cursor()
        try:
            try:
                cur.execute(f"CREATE TABLE IF NOT EXISTS {ref} ({cols})")
            except Exception:  # noqa: BLE001 — dialects without IF NOT EXISTS: the table may exist
                conn.rollback()
            if req.mode == "snapshot":
                cur.execute(f"DELETE FROM {ref}")
            names = [col.name for col in req.columns]
            insert = f"INSERT INTO {ref} ({', '.join(c.ident(n) for n in names)}) VALUES ({', '.join(['%s'] * len(names))})"
            sql, _ = c.prepare(insert, ())
            values = [tuple(_db_value(r.get(n), col.type) for n, col in zip(names, req.columns)) for r in req.rows]
            for i in range(0, len(values), 1000):
                cur.executemany(sql, values[i : i + 1000])
            conn.commit()
        except Exception as e:  # noqa: BLE001
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise HTTPException(400, f"writing {req.table} failed: {e}") from e
        finally:
            cur.close()
    return {"rows": len(req.rows), "table": f"{database}.{schema}.{req.table}".strip(".")}


class ExternalRun(BaseModel):
    """An external pipeline's output: the SELECT compiled by web/src/lib/externalSql.ts, run in the source."""
    pipeline_id: str
    connection_id: str
    database: str = ""
    schema_name: str = Field("", alias="schema")
    table: str = Field(min_length=1, max_length=500)
    mode: Literal["snapshot", "append"] = "snapshot"
    sql: str = Field(min_length=1, max_length=2_000_000)
    # build settings → Default compute profile
    profile: Optional[Literal["serverless", "classic", "warehouse"]] = None
    cluster_id: Optional[str] = Field(None, max_length=200)
    warehouse: Optional[str] = Field(None, max_length=255)

    model_config = {"populate_by_name": True}


@router.post("/external/run")
def external_run(req: ExternalRun, request: Request = None) -> dict:  # type: ignore[assignment]
    """Pushes an external pipeline's output down to Databricks or Snowflake (Palantir's "External pipelines"): the
    statement runs in the warehouse as CREATE OR REPLACE TABLE … AS (snapshot) or INSERT INTO … (append, created the
    first time); no rows pass through this server. Runs for Editors of the pipeline (and the build runner)."""
    import auth

    drive._require_db()
    auth.check_item_id(req.pipeline_id, "editor")
    enforce_build_identity(request, "write", "pipeline", req.pipeline_id)
    enforce_build_identity(request, "write", "connection", req.connection_id, req.table)
    content = json.loads(drive.read_bytes(pdata._pipeline_item(req.pipeline_id)))
    ext = content.get("external") or {}
    if content.get("compute") != "external" or ext.get("connectionId") != req.connection_id:
        raise HTTPException(400, "the pipeline is not an external pipeline of this source")
    statement = req.sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(with|select)\b", statement):
        raise HTTPException(400, "an external pipeline output is a single WITH … SELECT statement")
    with _connector(req.connection_id, writable=True) as c:
        kind = c.__class__.__name__.lower()
        if "databricks" not in kind and "snowflake" not in kind:
            raise HTTPException(400, "external pipelines run on Databricks or Snowflake sources")
        if "databricks" in kind and req.profile == "classic" and req.cluster_id:
            # a classic (all-purpose) cluster instead of the source's SQL warehouse: its Thrift path
            org = str(c.config.get("org_id") or "0")
            c.config = {**c.config, "http_path": f"sql/protocolv1/o/{org}/{req.cluster_id.strip()}"}
        database = req.database or c.config.get("catalog") or c.config.get("database") or ""
        ref = ".".join(c.ident(x) for x in (database if c.qualify_database else "", req.schema_name, req.table) if x)
        try:
            if "snowflake" in kind and req.warehouse:
                c.query(f"USE WAREHOUSE {c.ident(req.warehouse.strip())}", action="Could not use the warehouse")
            exists = True
            try:
                c.get_table_schema(database, req.schema_name, req.table)
            except Exception:  # noqa: BLE001 — the first build creates the table
                exists = False
            verb = f"INSERT INTO {ref}\n" if req.mode == "append" and exists else f"CREATE OR REPLACE TABLE {ref} AS\n"
            c.query(verb + statement, action=f"{'Appending to' if verb.startswith('INSERT') else 'Creating'} {req.table} failed")
            try:
                c.conn(database).commit()
            except Exception:  # noqa: BLE001 — autocommit sessions
                pass
            rows: Optional[int] = None
            columns: Optional[int] = None
            try:
                (count,) = c.query(f"SELECT COUNT(*) FROM {ref}", action="Counting rows failed")[0]
                rows = int(count)
                columns = len(c.get_table_schema(database, req.schema_name, req.table)["columns"])
            except Exception:  # noqa: BLE001 — written; the counts are informative
                pass
        except connectors.ConnectorError as e:
            raise HTTPException(400, str(e)) from None
    return {"rows": rows, "columns": columns, "table": ".".join(x for x in (database, req.schema_name, req.table) if x),
            "statement": verb.strip().split("\n")[0]}


class ExternalCheck(BaseModel):
    """Expectations of an external output, as one SELECT of counts (externalSql.compileExpectations)."""
    pipeline_id: str
    connection_id: str
    sql: str = Field(min_length=1, max_length=2_000_000)
    profile: Optional[Literal["serverless", "classic", "warehouse"]] = None
    cluster_id: Optional[str] = Field(None, max_length=200)
    warehouse: Optional[str] = Field(None, max_length=255)


@router.post("/external/check")
def external_check(req: ExternalCheck, request: Request = None) -> dict:  # type: ignore[assignment]
    """Run an external output's expectation counts in Databricks or Snowflake before it is written: the values of
    the one row, in SELECT order. Read-only; no rows of the output leave the source."""
    import auth

    drive._require_db()
    auth.check_item_id(req.pipeline_id, "editor")
    enforce_build_identity(request, "read", "pipeline", req.pipeline_id)
    enforce_build_identity(request, "read", "connection", req.connection_id)
    content = json.loads(drive.read_bytes(pdata._pipeline_item(req.pipeline_id)))
    if content.get("compute") != "external" or (content.get("external") or {}).get("connectionId") != req.connection_id:
        raise HTTPException(400, "the pipeline is not an external pipeline of this source")
    statement = req.sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(with|select)\b", statement) or ";" in statement:
        raise HTTPException(400, "an expectation check is a single WITH … SELECT statement")
    with _connector(req.connection_id) as c:
        kind = c.__class__.__name__.lower()
        if "databricks" not in kind and "snowflake" not in kind:
            raise HTTPException(400, "external pipelines run on Databricks or Snowflake sources")
        if "databricks" in kind and req.profile == "classic" and req.cluster_id:
            org = str(c.config.get("org_id") or "0")
            c.config = {**c.config, "http_path": f"sql/protocolv1/o/{org}/{req.cluster_id.strip()}"}
        try:
            if "snowflake" in kind and req.warehouse:
                c.query(f"USE WAREHOUSE {c.ident(req.warehouse.strip())}", action="Could not use the warehouse")
            rows = c.query(statement, action="Checking the expectations failed")
        except connectors.ConnectorError as e:
            raise HTTPException(400, str(e)) from None
    return {"values": [int(v) if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()) else v for v in (rows[0] if rows else [])]}


def _db_value(v: Any, kind: str) -> Any:
    if v is None:
        return None
    if kind == "Timestamp":
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if kind == "Date":
        return str(v)[:10]
    return v


# ------------------------------------------------------------------------------------------------
# output writers: files in other formats, definitions next to datasets, media sets
# ------------------------------------------------------------------------------------------------


class FileWrite(BaseModel):
    name: str
    parent_id: Optional[str] = None
    item_id: Optional[str] = None
    format: str  # csv | json | jsonl | txt | parquet
    columns: list[pdata.Column]
    rows: list[dict[str, Any]]
    text_column: Optional[str] = None


CONTENT_TYPES = {"csv": "text/csv", "json": "application/json", "jsonl": "application/x-ndjson", "txt": "text/plain", "parquet": pdata.PARQUET}


def _file_bytes(req: FileWrite) -> bytes:
    names = [c.name for c in req.columns]
    if req.format == "parquet":
        return pdata._parquet_bytes(pdata._to_arrow(req.columns, req.rows))
    if req.format == "csv":
        import csv

        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(names)
        for r in req.rows:
            w.writerow(["" if r.get(n) is None else r.get(n) for n in names])
        return buf.getvalue().encode("utf-8")
    if req.format == "json":
        return json.dumps([{n: r.get(n) for n in names} for r in req.rows], ensure_ascii=False, indent=1).encode("utf-8")
    if req.format == "jsonl":
        return "\n".join(json.dumps({n: r.get(n) for n in names}, ensure_ascii=False) for r in req.rows).encode("utf-8")
    if req.format == "txt":
        col = req.text_column or (names[0] if names else "")
        return "\n".join("" if r.get(col) is None else str(r.get(col)) for r in req.rows).encode("utf-8")
    raise HTTPException(400, f"unknown format {req.format}")


def _output_build(request: Optional[Request]) -> dict:
    """The build an output writer (outputs/file, outputs/definition, outputs/media) writes for. Pipeline Builder
    outputs are created and replaced by builds only (docs: outputs are created once you deploy your first pipeline
    build), and an output carries the markings of the build's pipeline and inputs — a write that is not part of a
    build would have nothing to inherit them from, so it is refused (403): the call must carry X-Bsai-Build naming a
    queued or running build and, with sign-in on, come from the build runner (its service token)."""
    build_id = request.headers.get(BUILD_HEADER) if request is not None else None
    if not build_id:
        raise HTTPException(403, "Pipeline outputs are written by builds only: deploy the pipeline to build this output")
    if auth.enabled():
        p = auth.current()
        if not (p and p.get("service")):
            raise HTTPException(403, "Only the build runner writes pipeline outputs: deploy the pipeline to build this output")
    try:
        rec = _build(build_id)
    except HTTPException:
        raise HTTPException(403, "The build this call is made for does not exist") from None
    if rec.get("status") not in ("queued", "running"):
        raise HTTPException(403, f"The build is {rec.get('status')}: it no longer writes outputs")
    return rec


def _build_sources(request: Optional[Request]) -> list[str]:
    """What an output the runner writes for a build (X-Bsai-Build) inherits its markings from: the build's pipeline and
    the Files items it reads (as a dataset output deployed for the pipeline does). 403 for a call that is not part of a
    build (_output_build)."""
    return pdata.output_sources(_output_build(request).get("pipeline_id"))


def _propagate_after(item_id: str, sources: list[str]) -> None:
    """After the write: the output's inherited markings narrowed to exactly those of its sources (lineage noted)."""
    if not sources:
        return
    try:
        auth.propagate(item_id, sources)
    except Exception:  # noqa: BLE001 - never fails the write (the markings stay applied)
        log.exception("marking propagation failed for %s", item_id)


def _insert_marked_folder(parent_id: Optional[str], name: str, marks: set[str]) -> str:
    """A new folder (as drive._insert_container) created already carrying `marks` (inherited): the markings record
    is written under a fresh, unused id first, then the folder is added under that id."""
    if not marks:
        return drive._insert_container(parent_id, "folder", name)
    while True:
        folder_id = uuid.uuid4().hex[:16]
        if not db.drive_get(folder_id) and auth._item_row(folder_id) == ([], []):
            break
    auth._set_item(folder_id, inherited=sorted(marks))
    now = drive._now()
    try:
        db.drive_insert({"id": folder_id, "parent_id": parent_id, "kind": "folder", "name": name, "size_bytes": 0, "content_type": None,
                         "stored_in": None, "created_at": now, "updated_at": now, "system": None})
    except BaseException:
        if not db.drive_get(folder_id):
            auth._set_item(folder_id, inherited=[])
        raise
    return folder_id


def _write_file(name: str, parent_id: Optional[str], item_id: Optional[str], data: bytes, content_type: str, request: Optional[Request] = None) -> dict:
    # only a build writes an output (403 otherwise); the markings it inherits from the build's pipeline and inputs are
    # checked against the Project's constraints and set BEFORE the contents are written (a new file is created already
    # marked, an existing one gains them first)
    sources = _build_sources(request)
    existing = pdata._live_file(item_id)
    # the runner writing for a build: as the build's identity, into the file it replaces or the folder it creates it in,
    # still reading the pipeline's inputs whose data the output carries (as a dataset deploy for a build)
    enforce_build_identity(request, "write", "item" if existing else "folder", existing["id"] if existing else parent_id, name,
                           [("read", "item", iid, None) for iid in dict.fromkeys(sources[1:])])
    if existing:
        # overwriting a file: its markings and Editor on its Project (the runner's service token passes)
        auth.check_item(existing, "editor")
    marks = pdata.output_markings(sources)
    if sources:
        pdata.check_output_constraints(existing, parent_id, marks, "output write")
    if existing:
        pdata.widen_before_write(existing["id"], marks)
        pdata._replace_content(existing, data, content_type)
        item = drive._item(existing["id"])
    else:
        item = drive._item(pdata.store_marked(parent_id, name, data, content_type, marks)["id"])
    _propagate_after(item["id"], sources)
    return drive._with_path(item)


@router.post("/outputs/file")
def write_file_output(req: FileWrite, request: Request = None) -> dict:  # type: ignore[assignment]
    drive._require_db()
    name = req.name if req.name.lower().endswith(f".{req.format}") else f"{req.name}.{req.format}"
    item = _write_file(name, req.parent_id, req.item_id, _file_bytes(req), CONTENT_TYPES.get(req.format, "application/octet-stream"), request)
    return {"item": item, "rows": len(req.rows)}


class DefinitionWrite(BaseModel):
    name: str
    parent_id: Optional[str] = None
    item_id: Optional[str] = None
    definition: dict[str, Any]


@router.post("/outputs/definition")
def write_definition(req: DefinitionWrite, request: Request = None) -> dict:  # type: ignore[assignment]
    """The JSON definition of an Ontology output (object type, link type, time series / geotemporal sync)."""
    drive._require_db()
    data = json.dumps(req.definition, ensure_ascii=False, indent=1).encode("utf-8")
    return {"item": _write_file(req.name, req.parent_id, req.item_id, data, "application/json", request)}


class MediaWrite(BaseModel):
    name: str
    parent_id: Optional[str] = None
    folder_id: Optional[str] = None
    items: list[dict[str, Optional[str]]]  # {ref, name}


@router.post("/outputs/media")
def write_media_set(req: MediaWrite, request: Request = None) -> dict:  # type: ignore[assignment]
    """A media set output: the referenced media written into a media set through its own registration path and
    transaction policy (docs: Media sets "Transaction policies", "Path deduplication").

    Every item is copied to a temporary file and checked by the media set: path and size limits, its schema /
    allowed formats, the media type by content; an additional input format is converted to the primary one. A
    transactional media set (the default for a new output) gets one transaction per build: the build's items are
    staged in it, the items of an earlier build that this one no longer writes are staged as deletions (a redeploy
    replaces the set's content; they stay in the path history as "deleted"), and it is committed only when every
    item was written — an item that does not fit, or cannot be read, aborts it and the media set is unchanged. A
    transactionless media set only adds or overwrites (as the docs say for builds): every item is checked before
    the first one is written."""
    import media_sets

    drive._require_db()
    build_sources = _build_sources(request)  # only a build writes an output (403 otherwise)
    for it in req.items:
        if "#" in (it.get("ref") or ""):
            raise HTTPException(400, "transformed media references (page / rotate) are not valid media set outputs — use the original reference")
    folder = db.drive_get(req.folder_id) if req.folder_id else None
    live = folder and not folder.get("trashed_at")
    # the media it copies and the pipeline's inputs are the build's input data: read as the build's identity too
    enforce_build_identity(request, "write", "item" if live else "folder", folder["id"] if live else req.parent_id, req.name,
                           [("read", "item", ref, None) for ref in dict.fromkeys([*build_sources[1:], *(it.get("ref") or "" for it in req.items)]) if ref])
    # the media set inherits the markings of the build's pipeline and inputs (and of the media it copies): set on its
    # folder BEFORE any item is written into it (a new folder is created already marked, an existing one gains them
    # first; narrowed after a transactional build replaced the set's content)
    sources = list(dict.fromkeys([*build_sources, *(it.get("ref") or "" for it in req.items if it.get("ref"))]))
    marks = pdata.output_markings(sources)
    before: Optional[list[str]] = None
    if sources:
        pdata.check_output_constraints(folder if live else None, req.parent_id, marks, "media set write")
    if not folder or folder.get("trashed_at"):
        folder_id = _insert_marked_folder(req.parent_id, drive._free_name(req.parent_id, drive._clean_name(req.name or "Media set")), marks)
    else:
        folder_id = folder["id"]
        drive._item(folder_id, need="editor")
        before = auth._item_row(folder_id)[1]
        pdata.widen_before_write(folder_id, marks)
    drive._item(folder_id, need="editor")
    s = media_sets.get(folder_id)
    if not s:
        # the output folder becomes a media set updated by a build pipeline (Media sets app; no manual deletes)
        media_sets.note_built(folder_id, "pipeline")
        s = media_sets.get(folder_id)
    if s.get("virtual"):
        raise HTTPException(400, "a virtual media set reads its items from its source: choose another media set as the output")
    tx_id: Optional[str] = None
    committed = False
    temps: list[Path] = []
    pending: list[tuple[str, Path]] = []  # transactionless: (path, checked file), written once every item was checked
    paths: set[str] = set()  # the media set paths this build writes
    deleted: list[str] = []
    wrote = [0]
    current = ""

    def fail(err: Exception) -> HTTPException:
        detail = str(err.detail if isinstance(err, HTTPException) else err) or type(err).__name__
        what = "transaction aborted, the media set is unchanged" if tx_id else f"{wrote[0]} item(s) written before it stay" if wrote[0] else "nothing was written"
        code = err.status_code if isinstance(err, HTTPException) and err.status_code in (403, 404) else 400
        return HTTPException(code, f"The media set output was not written ({what}): {current + ': ' if current else ''}{detail}")

    try:
        if s["transaction_policy"] == "transactional":
            try:
                tx_id = media_sets.open_transaction(folder_id)["id"]  # one transaction per build
            except HTTPException as e:
                raise HTTPException(e.status_code, f"The media set output cannot be written: {e.detail}") from None
        for it in req.items:
            current = (it.get("name") or it.get("ref") or "").strip()
            src = drive._item(it.get("ref") or "")
            current = (it.get("name") or src["name"] or "").strip()
            tmp = media_sets.DIR / "incoming" / uuid.uuid4().hex
            tmp.parent.mkdir(parents=True, exist_ok=True)
            temps.append(tmp)
            drive.copy_content(src, tmp)
            path, _conv = media_sets.check_file(s, current, tmp)  # path / size limits, formats, media type by content
            if tx_id:
                media_sets.stage_file(folder_id, tx_id, current, tmp)  # moved into the transaction (converted if needed)
            else:
                pending.append((current, tmp))
            paths.add(media_sets.target_path(s, path))
        current = ""
        if tx_id:
            # a redeploy replaces the set's content: what an earlier build wrote and this one does not is deleted
            keep = {drive._clean_name(p.replace("/", "_")) for p in paths}
            for child in db.drive_list(folder_id):
                if child["kind"] == "file" and not child.get("trashed_at") and child["name"] not in keep:
                    media_sets.stage_delete(folder_id, tx_id, child["name"])
                    deleted.append(child["name"])
            media_sets.commit_transaction(folder_id, tx_id)
            committed = True
            media_sets._touch(folder_id, replaced=True)
        else:
            for path, tmp in pending:  # transactionless: builds only add or overwrite
                current = path
                media_sets.put_item_file(folder_id, path, tmp)
                wrote[0] += 1
            current = ""
    except HTTPException as e:
        if not current and e.status_code in (403, 404, 409):
            raise
        raise fail(e) from None
    except Exception as e:  # noqa: BLE001 - a media item that cannot be read fails the build like a refused one
        raise fail(e) from None
    finally:
        if tx_id and not committed:
            try:  # nothing of a failed build becomes visible
                media_sets.abort_transaction(folder_id, tx_id)
            except HTTPException:
                pass
        if before is not None and not committed and not wrote[0]:
            auth._set_item(folder_id, inherited=before)  # nothing was written: the set keeps the markings it had
        for tmp in temps:
            tmp.unlink(missing_ok=True)
    if committed:
        # a transactional build replaced the set's content: narrowed to exactly the markings of what it was built from
        # (a transactionless set keeps the earlier builds' items, so it keeps their markings too)
        _propagate_after(folder_id, sources)
    media_sets.note_built(folder_id, "pipeline")
    return {"item": drive._with_path(drive._item(folder_id)), "rows": len(paths), "transaction_id": tx_id, "deleted": len(deleted)}


# ------------------------------------------------------------------------------------------------
# input freshness (for "when data has been updated" schedules)
# ------------------------------------------------------------------------------------------------


def _ref_version(ref: dict) -> Optional[str]:
    kind = ref.get("kind")
    try:
        if kind == "drive":
            item = db.drive_get(ref["itemId"])
            return item and str(item.get("updated_at"))
        if kind == "media":
            items = db.drive_query("d.parent_id = %s AND d.trashed_at IS NULL", (ref.get("folderId"),), limit=5000) if ref.get("folderId") else []
            return str(max((str(i.get("updated_at")) for i in items), default="")) + f":{len(items)}"
        if kind == "datasource":
            import datasources

            row = datasources._source_row(ref["id"])
            return str(row.get("updated_at")) + str((row.get("state") or {}).get("rows_total"))
        if kind == "stream":
            with _db() as con:
                r = con.execute("SELECT MAX(seq) FROM stream_records WHERE stream_id = ?", (ref["streamId"],)).fetchone()
            return str(r[0])
        if kind == "ingest":
            import streaming

            s = streaming._public_stream(streaming._stream(ref["streamId"]))
            return f"{s['view_id']}:{s['records']}:{s['last_record_at']}"
    except Exception:  # noqa: BLE001
        return None
    return None


@router.post("/inputs/versions")
def input_versions(refs: list[dict]) -> list[Optional[str]]:
    # a reference the caller cannot read has no version for them (None, as for a missing input)
    return [_ref_version(r) if all(auth.can_access(i) for i in pdata._ref_items(r)) else None for r in refs]


# ------------------------------------------------------------------------------------------------
# streams (streaming pipelines): push records with curl, read them back in order
# ------------------------------------------------------------------------------------------------


class NewStream(BaseModel):
    name: str
    schema_: list[pdata.Column] = Field(default_factory=list, alias="schema")
    throughput: str = "normal"
    # the Files folder (or Project) the stream belongs to: its markings and Project roles apply. Without one the
    # stream is its creator's (and administrators')
    parent_id: Optional[str] = None

    model_config = {"populate_by_name": True}


# Access to these streams (sign-in on). A stream lives in a Files item, its "home": the folder it was created in
# (parent_id), or for a stream written by a pipeline (runtime state "stream:<output>") that pipeline. The home's
# rules apply as in Files: its markings, its Project role (Viewer reads the records, Editor pushes, sees the push token
# and deletes), and for an item outside Projects its creator. A stream without a home is its creator's; one without
# a home and a creator (streams made before 2026-10-14) is administrators' only. Markings applied to the stream itself
# (PUT /api/auth/items/pipeline_stream:<id>/markings) are needed too. A stream the caller cannot read is "not found"
# (404) everywhere — listed nowhere — as Files hides what one cannot discover; a reader who may not change it gets 403.
# Machine clients push with the stream's token alone (Authorization: Bearer <token> or X-Stream-Token). The build runner
# reading a stream input or pushing a streaming job's output is checked as its build's identity by these same rules
# (enforce_build_identity, and its checks before every read and write). The system (sign-in off) and the platform's
# own callers (listeners.py calls these functions directly, without a request) are not checked here.
STREAM_KIND = "pipeline_stream"


def _stream(stream_id: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM streams WHERE id = ?", (stream_id,)).fetchone()
    if not row:
        raise HTTPException(404, "stream not found")
    return json.loads(row[0])


def _stream_home(s: dict) -> Optional[str]:
    """The Files item a stream lives in (see above), when it still exists; None otherwise."""
    home = s.get("item_id")
    if not home:
        with _db() as con:
            row = con.execute("SELECT pipeline_id FROM state WHERE key LIKE 'stream:%' AND value = ? LIMIT 1", (json.dumps(s["id"]),)).fetchone()
        home = row[0] if row else None
    if not home:
        return None
    try:
        item = db.drive_get(home)
    except Exception:  # noqa: BLE001 - no database: nothing to inherit from
        item = None
    # a deleted or trashed home grants nothing: the creator / administrator rule applies
    return home if item and not item.get("trashed_at") else None


def _stream_project(stream_id: str) -> Optional[str]:
    """The Project of a stream's home (auth's resource hook: changing the stream's own markings needs its Owner)."""
    home = _stream_home(_stream(stream_id))
    return auth.project_of(home) if home else None


auth.RESOURCE_PROJECT_HOOKS[STREAM_KIND] = _stream_project


def _stream_access(s: dict, p: Optional[dict]) -> str:
    """What a principal may do with a stream: "edit" (push, see the token, delete), "read" (records) or "none"."""
    if not auth.enabled() or p is None or p.get("service"):
        return "edit"
    if auth.missing_markings(auth.effective_markings(auth.resource_id(STREAM_KIND, s["id"])), p.get("markings")):
        return "none"
    home = _stream_home(s)
    if home:
        if not auth.can_access(home, p):
            return "none"
        return "edit" if auth.has_operation(home, "edit", p) else "read"
    if p.get("role") == "admin" or (s.get("created_by") and s["created_by"] == p.get("id")):
        return "edit"
    return "none"


def _caller(request: Optional[Request]) -> Optional[dict]:
    """The principal of an HTTP call; 401 for an anonymous one with sign-in on (only a token push may be anonymous)."""
    p = auth.current()
    if request is not None and auth.enabled() and p is None:
        raise HTTPException(401, "Sign in to use BluesandAI")
    return p


def _stream_for(stream_id: str, request: Optional[Request], need: str = "read") -> tuple[dict, str]:
    """The stream and the caller's access, or 404 (cannot read it) / 403 (may read, not change)."""
    s = _stream(stream_id)
    if request is None:
        return s, "edit"
    acc = _stream_access(s, _caller(request))
    if acc == "none":
        raise HTTPException(404, "stream not found")
    if need == "edit" and acc != "edit":
        home = _stream_home(s)
        if home:
            auth.check_item_id(home, "editor")  # 403 naming the role (and the Project, for "Request access")
        raise HTTPException(403, "You need the Editor role on this stream's Project to change it")
    return s, acc


def _public_stream(s: dict, acc: str, counts: bool = True, token: bool = True) -> dict:
    """A stream as a caller sees it: the push token only for those who may push (and never in listings)."""
    out = {k: v for k, v in s.items() if k != "token"}
    home = _stream_home(s)
    out.update(item_id=home, project_id=auth.project_of(home) if home else None, can_push=acc == "edit")
    if acc == "edit" and token:
        out["token"] = s.get("token")
    if counts:
        with _db() as con:
            n = con.execute("SELECT COUNT(*), MAX(at) FROM stream_records WHERE stream_id = ?", (s["id"],)).fetchone()
        out["records"], out["last_record_at"] = n[0], n[1]
    return out


@router.post("/streams")
def create_stream(req: NewStream, request: Request = None) -> dict:  # type: ignore[assignment]
    p = _caller(request) if request is not None else auth.current()
    parent = (req.parent_id or "").strip() or None
    if parent:
        try:
            item = db.drive_get(parent)
        except Exception:  # noqa: BLE001
            item = None
        if not item or item.get("trashed_at") or item.get("kind") not in ("folder", "project"):
            raise HTTPException(404, "folder not found")
        auth.check_item_id(parent, "editor")
    user = p if p and not p.get("service") and p.get("id") not in (None, "local") else None
    rec = {
        "id": "stream-" + uuid.uuid4().hex[:10],
        "name": req.name.strip() or "Stream",
        "schema": [c.model_dump() for c in req.schema_],
        "throughput": req.throughput,
        "created_at": _now(),
        "token": "sk_" + uuid.uuid4().hex,
        "item_id": parent,
        "created_by": user and user.get("id"),
        "created_by_name": user and user.get("username"),
    }
    with _lock, _db() as con:
        con.execute("INSERT INTO streams (id, record) VALUES (?, ?)", (rec["id"], json.dumps(rec)))
    return {**_public_stream(rec, "edit", counts=False), "records": 0, "last_record_at": None}


@router.get("/streams")
def list_streams(request: Request = None) -> list[dict]:  # type: ignore[assignment]
    p = _caller(request) if request is not None else auth.current()
    with _db() as con:
        rows = con.execute("SELECT record FROM streams").fetchall()
    out = []
    for (r,) in rows:
        s = json.loads(r)
        acc = _stream_access(s, p)
        if acc != "none":
            out.append(_public_stream(s, acc, token=False))
    return sorted(out, key=lambda s: s["created_at"], reverse=True)


@router.get("/streams/{stream_id}")
def get_stream(stream_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    s, acc = _stream_for(stream_id, request)
    return _public_stream(s, acc)


def _coerce_record(rec: dict, schema: list[dict]) -> dict:
    if not schema:
        return rec
    out = {}
    for col in schema:
        v = rec.get(col["name"])
        if v is not None and col["type"] in ("Integer", "Long", "Short", "Byte"):
            v = int(v)
        elif v is not None and col["type"] in ("Double", "Float", "Decimal"):
            v = float(v)
        elif v is not None and col["type"] == "Boolean":
            v = v if isinstance(v, bool) else str(v).lower() in ("true", "1")
        elif v is not None and col["type"] == "String":
            v = str(v)
        out[col["name"]] = v
    return out


def _push_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    bearer = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
    return bearer or request.headers.get("x-stream-token", "").strip()


def _check_push(stream_id: str, request: Optional[Request]) -> dict:
    """A push needs the stream's push token, or a caller who may push (Editor on its home, its creator, an
    administrator, the system; anyone with sign-in off)."""
    if request is None:
        return _stream(stream_id)
    anonymous = auth.enabled() and auth.current() is None
    try:
        s = _stream(stream_id)
    except HTTPException:
        if anonymous:
            # an anonymous caller learns nothing about which streams exist
            raise HTTPException(401, "Push with the stream's token: Authorization: Bearer <token>") from None
        raise
    # the runner pushing a streaming job's output for a build: as the build's identity (Editor on the stream's home)
    enforce_build_identity(request, "write", "stream", stream_id)
    token = _push_token(request)
    if token and s.get("token") and hmac.compare_digest(token.encode(), str(s["token"]).encode()):
        return s
    if anonymous:
        # an anonymous push (the token-only push path): the token is the only credential
        raise HTTPException(401, "Push with the stream's token: Authorization: Bearer <token>")
    return _stream_for(stream_id, request, "edit")[0]


@router.post("/streams/{stream_id}/records")
def push_records(stream_id: str, body: Any = Body(...), request: Request = None) -> dict:  # type: ignore[assignment]
    """Push one record ({"value": {...}}, a bare object) or a list of them, as Foundry stream pushes look."""
    s = _check_push(stream_id, request)
    records = body if isinstance(body, list) else [body]
    with _lock, _db() as con:
        seq = (con.execute("SELECT MAX(seq) FROM stream_records WHERE stream_id = ?", (stream_id,)).fetchone()[0] or 0)
        for r in records:
            if isinstance(r, dict) and set(r) == {"value"} and isinstance(r["value"], dict):
                r = r["value"]
            if not isinstance(r, dict):
                raise HTTPException(400, "records are JSON objects")
            seq += 1
            con.execute("INSERT INTO stream_records (stream_id, seq, at, record) VALUES (?, ?, ?, ?)", (stream_id, seq, _now(), json.dumps(_coerce_record(r, s["schema"]))))
    return {"pushed": len(records), "last_seq": seq}


@router.post("/stream-push/{stream_id}")
def push_with_token(stream_id: str, body: Any = Body(...), request: Request = None) -> dict:  # type: ignore[assignment]
    """The machine clients' push: as POST /streams/{id}/records, for a client that has only the stream's token. A
    path of its own so that it alone can be open to calls without a session (auth.PUBLIC)."""
    return push_records(stream_id, body, request)


@router.get("/streams/{stream_id}/records")
def read_records(stream_id: str, after: int = 0, limit: int = 1000, request: Request = None) -> dict:  # type: ignore[assignment]
    s = _stream_for(stream_id, request)[0]
    # the runner reading a pipeline input for a build: as the build's identity (the stream's home: Viewer reads)
    enforce_build_identity(request, "read", "stream", stream_id)
    with _db() as con:
        rows = con.execute(
            "SELECT seq, at, record FROM stream_records WHERE stream_id = ? AND seq > ? ORDER BY seq LIMIT ?", (stream_id, after, max(1, min(limit, 100_000)))
        ).fetchall()
    recs = [{**json.loads(r), "_seq": seq, "_at": at} for seq, at, r in rows]
    columns = s["schema"] or ([{"name": k, "type": "String"} for k in recs[0] if not k.startswith("_")] if recs else [])
    return {"columns": columns, "rows": [{c["name"]: r.get(c["name"]) for c in columns} for r in recs], "seqs": [r["_seq"] for r in recs], "last_seq": recs[-1]["_seq"] if recs else after}


@router.delete("/streams/{stream_id}")
def delete_stream(stream_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    if request is not None:
        _stream_for(stream_id, request, "edit")
    with _lock, _db() as con:
        con.execute("DELETE FROM streams WHERE id = ?", (stream_id,))
        con.execute("DELETE FROM stream_records WHERE stream_id = ?", (stream_id,))
    return {"deleted": stream_id}


# ------------------------------------------------------------------------------------------------
# schedules
# ------------------------------------------------------------------------------------------------


def _field_matches(expr: str, value: int, lo: int, hi: int) -> bool:
    for part in expr.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
            if step != 1:
                end = hi
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


def cron_matches(cron: str, at: datetime) -> bool:
    """Five-field cron (minute hour day-of-month month day-of-week, 0 = Sunday) at a minute."""
    f = cron.split()
    if len(f) != 5:
        return False
    dow = (at.weekday() + 1) % 7
    try:
        return (
            _field_matches(f[0], at.minute, 0, 59)
            and _field_matches(f[1], at.hour, 0, 23)
            and _field_matches(f[2], at.day, 1, 31)
            and _field_matches(f[3], at.month, 1, 12)
            and (_field_matches(f[4], dow, 0, 6) or (dow == 0 and _field_matches(f[4], 7, 0, 7)))
        )
    except ValueError:
        return False


def next_runs(cron: str, tz: str, count: int = 5) -> list[str]:
    zone = ZoneInfo(tz or "UTC")
    t = datetime.now(zone).replace(second=0, microsecond=0) + timedelta(minutes=1)
    out = []
    for _ in range(60 * 24 * 366):
        if cron_matches(cron, t):
            out.append(t.isoformat())
            if len(out) >= count:
                break
        t += timedelta(minutes=1)
    return out


@router.get("/schedules/next")
def schedule_preview(cron: str, timezone_name: str = "UTC") -> dict:
    """The next times a cron expression fires (the schedule editor shows them)."""
    try:
        ZoneInfo(timezone_name or "UTC")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"unknown time zone {timezone_name}") from e
    return {"next": next_runs(cron, timezone_name)}


_file_cache: dict[str, tuple[str, dict]] = {}


def _pipeline_content(item: dict) -> Optional[dict]:
    key = str(item.get("updated_at"))
    hit = _file_cache.get(item["id"])
    if hit and hit[0] == key:
        return hit[1]
    try:
        content = json.loads(drive.read_bytes(item))
    except Exception:  # noqa: BLE001
        return None
    _file_cache[item["id"]] = (key, content)
    return content


def _logic_hash(content: dict) -> str:
    nodes = [{k: v for k, v in n.items() if k not in ("x", "y", "color", "folder", "description")} for n in content.get("nodes", [])]
    outputs = [{k: v for k, v in o.items() if k not in ("x", "y", "deployed")} for o in content.get("outputs", [])]
    return hashlib.sha1(json.dumps([nodes, outputs, content.get("parameters"), content.get("functions"), content.get("subgraphs")], sort_keys=True, default=str).encode()).hexdigest()


def _watchdog() -> None:
    """A running streaming job reports at least every 10 seconds; one silent for 3 minutes lost its runner
    (the web server restarted): it is marked failed (transient) and restarted from its checkpoint."""
    for b in _builds(limit=200, status="running"):
        if not b.get("streaming"):
            continue
        try:
            silent = (datetime.now(timezone.utc) - datetime.fromisoformat(b.get("updated_at") or b["created_at"])).total_seconds()
        except ValueError:
            continue
        if silent > 180:
            b.update(status="failed", finished_at=_now(), failure_type="transient", error="The streaming job stopped reporting (its runner restarted)")
            b["logs"].append({"at": _now(), "level": "error", "msg": b["error"]})
            _save_build(b)
            _restart_streaming(b, "runner lost")


def _scheduler() -> None:
    import pipeline_schedules

    while not _stop.wait(20):
        try:
            pipeline_schedules.tick()
        except Exception:  # noqa: BLE001
            log.exception("pipeline scheduler tick failed")
        try:
            _watchdog()
        except Exception:  # noqa: BLE001
            log.exception("streaming watchdog failed")


def startup() -> None:
    # builds interrupted by an API restart cannot be resumed by the runner: batch builds are marked failed,
    # streaming jobs restart from their checkpoint
    restarted: set[tuple] = set()
    # newest first: of several streaming jobs of a pipeline (branch, run setup), only the newest restarts
    for b in _builds(limit=200):
        if b["status"] in ("queued", "running"):
            streaming = bool(b.get("streaming")) and not b.get("cancel")
            b.update(status="failed", finished_at=_now(), failure_type="transient", error="Interrupted by an API restart" + ("" if streaming else " — deploy again"))
            _save_build(b)
            key = (b["pipeline_id"], b.get("branch") or "main", (b.get("run_setup") or {}).get("id"))
            if streaming and key not in restarted:
                restarted.add(key)
                _restart_streaming(b, "API restarted", delay=15)
    threading.Thread(target=_scheduler, daemon=True, name="pipeline-scheduler").start()


# ------------------------------------------------------------------------------------------------
# landing page: what each pipeline is and how its last build went
# ------------------------------------------------------------------------------------------------


@router.get("/summaries")
def pipeline_summaries() -> list[dict]:
    """Type, backend and size of every pipeline (files re-read only when they changed), with its latest build."""
    drive._require_db()
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND lower(d.name) LIKE %s", (f"%{pdata.PIPELINE_EXT}",), limit=1000)
    latest: dict[str, dict] = {}
    with _db() as con:
        for (rec,) in con.execute("SELECT record FROM builds ORDER BY created_at DESC LIMIT 2000").fetchall():
            b = json.loads(rec)
            latest.setdefault(b["pipeline_id"], b)
    out = []
    for item in items:
        # listed like the pipeline list (markings, a role on its Project); its builds only for those who read it
        if not auth.can_discover(item["id"]):
            continue
        reads = auth.can_access(item["id"])
        c = (_pipeline_content(item) or {}) if reads else {}
        b = latest.get(item["id"]) if reads else None
        vc = c.get("vc") or {}
        out.append(
            {
                "id": item["id"],
                "type": c.get("type", "batch"),
                "compute": c.get("compute", "standard"),
                "external": (c.get("external") or {}).get("kind"),
                "nodes": len(c.get("nodes") or []),
                "outputs": len(c.get("outputs") or []),
                "schedules": len([s for s in (c.get("schedules") or []) if s.get("enabled")]),
                "branches": len([x for x in (vc.get("branches") or {}).values() if not x.get("archived")]) + 1,
                "openProposals": len([p for p in (vc.get("proposals") or []) if p.get("status") == "open"]),
                "description": (c.get("meta") or {}).get("description"),
                "lastBuild": {"id": b["id"], "status": b["status"], "at": b.get("finished_at") or b["created_at"], "trigger": b["trigger"]} if b else None,
                "streaming": bool(b and c.get("type") == "streaming" and b["status"] in ("queued", "running")),
            }
        )
    return out

