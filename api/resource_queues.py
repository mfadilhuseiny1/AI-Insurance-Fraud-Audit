"""Resource queues (Resource Management; palantir.com/docs/foundry/resource-management/resource-queues).

A queue bundles Projects and caps the vCPUs their jobs use at once. Projects in no queue use the Default queue. A job
asks its Project's queue for the vCPUs of its compute profile before it runs (a lease): it starts when the queue has
room and every job that asked before it in the same queue has started (first come, first served), else it waits —
"waiting in the Project's resource queue". A job asking for more than the whole limit starts once the queue is empty.
Leases end when the job ends; a lease whose holder stops renewing it (a crashed runner) expires after its TTL, and a
lease held by an API process that is gone (same machine, the process no longer runs) is dropped at once.

Jobs that take leases: Pipeline Builder batch jobs (the web runner, through /api/resource-queues/leases), Code
Repositories transform builds (in process), SQL definition rebuilds, Connected flows, Pipeline Builder streaming jobs
(for as long as they run: taken when the job is dispatched, renewed by its progress reports, released when it stops,
fails or is replaced — pipeline_runtime.py), streaming syncs (while running — streaming.py) and Data Connection syncs
and exports (for each run — datasources.py, exports.py). A job identity (a `holder`, e.g. one streaming sync) holds at
most one lease: asking again replaces the old one.

Queues live in data/resource-queues/queues.json. Leases live in PostgreSQL (table resource_queue_leases), so every
API process sharing the database sees and respects the same queue; every change runs under one advisory lock. Without
PostgreSQL they are kept in memory.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db

router = APIRouter(prefix="/api/resource-queues")
DIR = Path("data/resource-queues")
DEFAULT_ID = "default"
DEFAULT_LIMIT = 32
# a lease renewed over the API (the web runner's jobs, streaming jobs' progress reports) expires after this long unrenewed
LEASE_TTL_S = 300
# a lease held inside an API process: renewed by the process's heartbeat
PROCESS_TTL_S = 60
HEARTBEAT_S = 10.0
POLL_S = 2.0
_lock = threading.RLock()
_cond = threading.Condition(_lock)
# without PostgreSQL: lease id → {id, seq, queue, vcpus, label, kind, project_id, holder, owner, user, asked_at, granted_at, renewed, ttl_s}
_mem: dict[str, dict] = {}
_mem_seq = [0]
# leases this process holds and renews (its heartbeat)
_mine: set[str] = set()
_ready = [False, False]  # schema created, heartbeat started
_ADVISORY = 0x52514C45  # one lock for every change to the leases, across processes

COLS = ("id", "seq", "queue", "vcpus", "label", "kind", "project_id", "holder", "owner", "user", "asked_at", "granted_at", "renewed", "ttl_s")
_SQL = {c: ("username" if c == "user" else c) for c in COLS}
SCHEMA = """
CREATE TABLE IF NOT EXISTS resource_queue_leases (
    id          text PRIMARY KEY,
    seq         bigint NOT NULL,
    queue       text NOT NULL,
    vcpus       integer NOT NULL,
    label       text NOT NULL DEFAULT '',
    kind        text NOT NULL,
    project_id  text,
    holder      text,
    owner       text,
    username    text,
    asked_at    text NOT NULL,
    granted_at  text,
    renewed     double precision NOT NULL,
    ttl_s       integer NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS resource_queue_lease_seq;
CREATE UNIQUE INDEX IF NOT EXISTS resource_queue_leases_holder ON resource_queue_leases (holder) WHERE holder IS NOT NULL;
"""


def _owner_id() -> str:
    """host:pid:start time of this process (a pid reused by another process is not mistaken for it)."""
    try:
        import psutil

        started = int(psutil.Process(os.getpid()).create_time())
    except Exception:  # noqa: BLE001
        started = 0
    return f"{socket.gethostname()}:{os.getpid()}:{started}"


OWNER = _owner_id()

def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "resource-queues"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load() -> dict:
    p = DIR / "queues.json"
    d = json.loads(p.read_text("utf-8")) if p.exists() else {}
    d.setdefault("queues", [])
    if not any(q["id"] == DEFAULT_ID for q in d["queues"]):
        d["queues"].insert(0, {"id": DEFAULT_ID, "name": "Default", "description": "Projects that are in no other queue", "vcpu_limit": DEFAULT_LIMIT,
                               "project_ids": [], "created_at": _now()})
    return d


def _save(d: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    p = DIR / "queues.json"
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(d, indent=1), "utf-8")
    tmp.replace(p)


def profile_vcpus(profile: Optional[str]) -> int:
    """vCPUs of a batch compute profile: the driver plus the minimum executors (resource_usage.BATCH)."""
    import resource_usage

    (dc, _), n, (ec, _) = resource_usage.BATCH.get(str(profile or "xs"), resource_usage.BATCH["xs"])
    return max(1, int(round(dc + n * ec)))


def streaming_vcpus(profile: Optional[str]) -> int:
    """vCPUs of a streaming profile: the job manager plus one task manager per unit of parallelism (resource_usage.STREAMING)."""
    import resource_usage

    (jc, _), (tc, _), par = resource_usage.STREAMING.get(str(profile or "xs"), resource_usage.STREAMING["xs"])
    return max(1, int(round(jc + tc * par)))


# a Data Connection sync or export run: one agent worker
SYNC_VCPUS = 1


def project_of(item_id: Optional[str]) -> Optional[str]:
    """The Project holding a Files item (or the item itself when it is a Project)."""
    if not item_id:
        return None
    try:
        path = db.drive_path(item_id)
    except Exception:  # noqa: BLE001
        return None
    # the path runs from the top-level item down: a Project is always at the top
    top = db.drive_get(path[0]["id"]) if path else None
    return top["id"] if top and top.get("kind") == "project" else None


def queue_for(project_id: Optional[str]) -> dict:
    """The queue that lists the Project, else its space's queue (governance_model.py), else the Default queue."""
    d = _load()
    if project_id:
        for q in d["queues"]:
            if project_id in (q.get("project_ids") or []):
                return q
        try:
            import governance_model

            sq = governance_model.setting_for(project_id, "resource_queue")
        except Exception:  # noqa: BLE001
            sq = None
        hit = next((q for q in d["queues"] if q["id"] == sq), None) if sq else None
        if hit:
            return hit
    return next(q for q in d["queues"] if q["id"] == DEFAULT_ID)


# ------------------------------------------------------------------------------------------------
# leases: one store for every API process (PostgreSQL), changed under one advisory lock
# ------------------------------------------------------------------------------------------------


class _Session:
    """Every lease (expired ones dropped, waiters granted where they now fit) for one locked block."""

    def __init__(self, leases: dict[str, dict], now: float, conn=None):
        self.leases, self.now, self.conn = leases, now, conn

    def next_seq(self) -> int:
        if self.conn is None:
            _mem_seq[0] += 1
            return _mem_seq[0]
        return int(self.conn.execute("SELECT nextval('resource_queue_lease_seq')").fetchone()[0])


def _ensure_schema() -> None:
    if not _ready[0]:
        with db._connect() as conn:
            conn.execute(SCHEMA)
        _ready[0] = True


@contextmanager
def _session():
    with _lock:
        if not db.enabled():
            s = _Session(_mem, time.time())
            _expire(s)
            _grant_all(s)
            yield s
            return
        _ensure_schema()
        with db._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (_ADVISORY,))
            # the database's clock: every process measures expiry the same way
            now = float(conn.execute("SELECT extract(epoch FROM clock_timestamp())").fetchone()[0])
            rows = conn.execute(f"SELECT {', '.join(_SQL[c] for c in COLS)} FROM resource_queue_leases").fetchall()
            before = {r[0]: dict(zip(COLS, r)) for r in rows}
            s = _Session({k: dict(v) for k, v in before.items()}, now, conn)
            _expire(s)
            _grant_all(s)
            yield s
            gone = [k for k in before if k not in s.leases]
            if gone:
                conn.execute("DELETE FROM resource_queue_leases WHERE id = ANY(%s)", (gone,))
            for lid, x in s.leases.items():
                old = before.get(lid)
                if old is None:
                    conn.execute(f"INSERT INTO resource_queue_leases ({', '.join(_SQL[c] for c in COLS)}) VALUES ({', '.join(['%s'] * len(COLS))})",
                                 tuple(x.get(c) for c in COLS))
                    continue
                changed = [c for c in COLS if c != "id" and x.get(c) != old.get(c)]
                if changed:
                    conn.execute(f"UPDATE resource_queue_leases SET {', '.join(_SQL[c] + ' = %s' for c in changed)} WHERE id = %s",
                                 (*[x.get(c) for c in changed], lid))


def _owner_alive(owner: Optional[str], seen: dict[str, bool]) -> bool:
    """Whether the API process holding a lease still runs (only processes on this machine can be checked; leases of
    other machines' processes expire by their TTL)."""
    if not owner:
        return True
    if owner in seen:
        return seen[owner]
    host, _, rest = owner.partition(":")
    pid_s, _, started_s = rest.partition(":")
    alive = True
    if host == socket.gethostname() and owner != OWNER:
        try:
            import psutil

            try:
                started = int(psutil.Process(int(pid_s)).create_time())
                alive = not started_s or int(started_s) == 0 or abs(started - int(started_s)) <= 1
            except psutil.NoSuchProcess:
                alive = False
        except Exception:  # noqa: BLE001 - cannot tell: the TTL decides
            alive = True
    seen[owner] = alive
    return alive


def _expire(s: _Session) -> None:
    seen: dict[str, bool] = {}
    for lid in [k for k, v in s.leases.items() if v["renewed"] + v["ttl_s"] < s.now or not _owner_alive(v.get("owner"), seen)]:
        s.leases.pop(lid, None)
        _mine.discard(lid)


def _try_grant(lease: dict, s: _Session) -> bool:
    """Grant a waiting lease when the queue has room and nothing asked before it is still waiting."""
    if lease.get("granted_at"):
        return True
    # the Project's queue now (a Project moved to another queue takes its waiting jobs along)
    q = queue_for(lease["project_id"])
    lease["queue"] = q["id"]
    same = [x for x in s.leases.values() if x["queue"] == q["id"]]
    used = sum(x["vcpus"] for x in same if x.get("granted_at"))
    earlier = [x for x in same if not x.get("granted_at") and x["seq"] < lease["seq"]]
    if earlier:
        return False
    if used + lease["vcpus"] <= q["vcpu_limit"] or used == 0:
        lease["granted_at"] = _now()
        return True
    return False


def _grant_all(s: _Session) -> None:
    """The waiters, first come first served, that fit now (after a release, an expiry or a changed limit)."""
    for x in sorted(s.leases.values(), key=lambda v: v["seq"]):
        if not x.get("granted_at"):
            _try_grant(x, s)


def ask(project_id: Optional[str], vcpus: int, label: str, kind: str, holder: Optional[str] = None, owner: Optional[str] = None,
        ttl_s: int = LEASE_TTL_S) -> dict:
    """Ask for room. `holder` names the job (one lease each: an older lease of the same holder is replaced); `owner` is
    the API process that renews it (in-process jobs), else it is renewed by polling."""
    with _session() as s:
        if holder:
            for lid in [k for k, v in s.leases.items() if v.get("holder") == holder]:
                s.leases.pop(lid, None)
                _mine.discard(lid)
        lease = {"id": uuid.uuid4().hex[:12], "seq": s.next_seq(), "queue": queue_for(project_id)["id"], "vcpus": max(1, int(vcpus)), "label": label[:200],
                 "kind": kind, "project_id": project_id, "holder": holder, "owner": owner, "user": (auth.current() or {}).get("username"),
                 "asked_at": _now(), "granted_at": None, "renewed": s.now, "ttl_s": int(ttl_s)}
        s.leases[lease["id"]] = lease
        _try_grant(lease, s)
        out = _public(lease, s)
        _cond.notify_all()
    return out


def poll(lease_id: str) -> dict:
    with _session() as s:
        lease = s.leases.get(lease_id)
        if not lease:
            raise HTTPException(404, "the lease expired or was released")
        lease["renewed"] = s.now
        _try_grant(lease, s)
        return _public(lease, s)


def renew(lease_id: Optional[str]) -> bool:
    """Keep a lease alive (a running job's report); False when it is gone."""
    if not lease_id:
        return False
    try:
        poll(lease_id)
        return True
    except HTTPException:
        return False


def detach(lease_id: str, ttl_s: int = LEASE_TTL_S) -> None:
    """Hand an in-process lease to a job that renews it itself (a streaming job's reports): this process stops renewing it."""
    _mine.discard(lease_id)
    with _session() as s:
        lease = s.leases.get(lease_id)
        if lease:
            lease.update(owner=None, ttl_s=int(ttl_s), renewed=s.now)


def release(lease_id: Optional[str]) -> None:
    if not lease_id:
        return
    _mine.discard(lease_id)
    with _session() as s:
        s.leases.pop(lease_id, None)
        # the next waiters may start now
        _grant_all(s)
        _cond.notify_all()


def held(lease_id: Optional[str]) -> bool:
    with _session() as s:
        return bool(lease_id and lease_id in s.leases)


def _public(lease: dict, s: _Session) -> dict:
    q = next((x for x in _load()["queues"] if x["id"] == lease["queue"]), {"name": lease["queue"], "vcpu_limit": 0})
    same = [x for x in s.leases.values() if x["queue"] == lease["queue"]]
    ahead = len([x for x in same if not x.get("granted_at") and x["seq"] < lease["seq"]])
    used = sum(x["vcpus"] for x in same if x.get("granted_at"))
    return {"id": lease["id"], "granted": bool(lease.get("granted_at")), "queue": lease["queue"], "queue_name": q["name"], "vcpu_limit": q["vcpu_limit"],
            "vcpus": lease["vcpus"], "in_use": used, "ahead": ahead}


def _heartbeat() -> None:
    """Renew the leases this process holds; one this process no longer has (replaced, or expired while the process
    stalled) is forgotten."""
    while True:
        time.sleep(HEARTBEAT_S)
        if not _mine:
            continue
        try:
            with _session() as s:
                for lid in list(_mine):
                    lease = s.leases.get(lid)
                    if lease:
                        lease["renewed"] = s.now
                    else:
                        _mine.discard(lid)
        except Exception:  # noqa: BLE001 - the database is away: retried at the next beat (leases live PROCESS_TTL_S)
            pass


def _start_heartbeat() -> None:
    with _lock:
        if not _ready[1]:
            _ready[1] = True
            threading.Thread(target=_heartbeat, daemon=True, name="resource-queue-heartbeat").start()


def acquire(item_id: Optional[str], vcpus: int, label: str, kind: str, on_wait: Optional[Callable[[dict], None]] = None,
            cancelled: Optional[Callable[[], bool]] = None, timeout_s: float = 6 * 3600, *, holder: Optional[str] = None,
            project_id: Optional[str] = None) -> Optional[str]:
    """Block until the job may run (in process); returns the lease id to release. None when cancelled. The lease is
    renewed by this process's heartbeat until released (or handed over with detach). `on_wait` hears of each change
    while the job waits (queue name, jobs ahead, vCPUs in use)."""
    _start_heartbeat()
    lease = ask(project_id if project_id is not None else project_of(item_id), vcpus, label, kind, holder=holder, owner=OWNER, ttl_s=PROCESS_TTL_S)
    _mine.add(lease["id"])
    told = None
    deadline = time.monotonic() + timeout_s
    while not lease["granted"]:
        if on_wait and told != (lease["ahead"], lease["in_use"]):
            on_wait(lease)
            told = (lease["ahead"], lease["in_use"])
        if cancelled and cancelled():
            release(lease["id"])
            return None
        if time.monotonic() > deadline:
            release(lease["id"])
            raise RuntimeError(f"waited more than {int(timeout_s)} s in the resource queue {lease['queue_name']}")
        with _cond:
            _cond.wait(POLL_S)
        lease = poll(lease["id"])
    return lease["id"]


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


class QueueIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=1000)
    vcpu_limit: int = Field(ge=1, le=100_000)
    project_ids: list[str] = Field(default_factory=list, max_length=1000)


def _require_admin() -> None:
    p = auth.current()
    if auth.enabled() and p is not None and not p.get("service") and p.get("role") != "admin":
        raise HTTPException(403, "only administrators manage resource queues")


def _describe(q: dict) -> dict:
    with _session() as s:
        leases = [dict(x) for x in s.leases.values() if x["queue"] == q["id"]]
    names = {}
    for pid in q.get("project_ids") or []:
        it = db.drive_get(pid)
        names[pid] = it["name"] if it else pid
    running = sorted((x for x in leases if x.get("granted_at")), key=lambda x: x["seq"])
    waiting = sorted((x for x in leases if not x.get("granted_at")), key=lambda x: x["seq"])
    strip = lambda x: {k: x.get(k) for k in ("id", "vcpus", "label", "kind", "asked_at", "granted_at", "user", "project_id", "holder")}  # noqa: E731
    return {**q, "projects": [{"id": k, "name": v} for k, v in names.items()], "in_use": sum(x["vcpus"] for x in running),
            "running": [strip(x) for x in running], "waiting": [strip(x) for x in waiting]}


@router.get("")
def list_queues() -> list[dict]:
    return [_describe(q) for q in _load()["queues"]]


@router.post("")
def create_queue(req: QueueIn) -> dict:
    _require_admin()
    with _lock:
        d = _load()
        q = {"id": "rq-" + uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description.strip(), "vcpu_limit": req.vcpu_limit,
             "project_ids": [], "created_at": _now()}
        d["queues"].append(q)
        _assign(d, q, req.project_ids)
        _save(d)
    return _describe(q)


def _assign(d: dict, q: dict, project_ids: list[str]) -> None:
    """A Project belongs to one queue: assigning it here takes it out of the others."""
    for pid in project_ids:
        it = db.drive_get(pid)
        if not it or it.get("kind") != "project":
            raise HTTPException(400, f"{pid} is not a Project")
    if q["id"] == DEFAULT_ID:
        q["project_ids"] = []
        return
    for other in d["queues"]:
        if other is not q:
            other["project_ids"] = [p for p in other.get("project_ids") or [] if p not in project_ids]
    q["project_ids"] = list(dict.fromkeys(project_ids))


@router.put("/{queue_id}")
def update_queue(queue_id: str, req: QueueIn) -> dict:
    _require_admin()
    with _cond:
        d = _load()
        q = next((x for x in d["queues"] if x["id"] == queue_id), None)
        if not q:
            raise HTTPException(404, "no such queue")
        q.update(name=req.name.strip(), description=req.description.strip(), vcpu_limit=req.vcpu_limit)
        _assign(d, q, req.project_ids)
        _save(d)
        # waiters that fit the new limit start now (a session grants them)
        with _session():
            pass
        _cond.notify_all()
    return _describe(q)


@router.delete("/{queue_id}")
def delete_queue(queue_id: str) -> dict:
    _require_admin()
    if queue_id == DEFAULT_ID:
        raise HTTPException(400, "the Default queue cannot be deleted")
    with _lock:
        d = _load()
        d["queues"] = [x for x in d["queues"] if x["id"] != queue_id]
        _save(d)
    return {"deleted": queue_id}


@router.get("/project/{item_id}")
def project_queue(item_id: str) -> dict:
    """The queue a Project (or an item in it) gets its compute from (Compass → Resource queues)."""
    return _describe(queue_for(project_of(item_id)))


class LeaseIn(BaseModel):
    item_id: Optional[str] = None
    vcpus: Optional[int] = None
    profile: Optional[str] = None
    label: str = ""
    kind: str = "pipeline"


@router.post("/leases")
def lease(req: LeaseIn) -> dict:
    """Ask for room for a job (the web runner's Pipeline Builder jobs); poll it until granted, then release it."""
    return ask(project_of(req.item_id), req.vcpus or profile_vcpus(req.profile), req.label, req.kind)


@router.post("/leases/{lease_id}/poll")
def poll_lease(lease_id: str) -> dict:
    return poll(lease_id)


@router.delete("/leases/{lease_id}")
def release_lease(lease_id: str) -> dict:
    release(lease_id)
    return {"released": lease_id}
