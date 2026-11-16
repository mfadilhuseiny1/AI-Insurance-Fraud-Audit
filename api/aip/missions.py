"""AIP missions: long fraud work (hours, many tasks) run by the orchestrator, serial workers and validators, with a thin
deterministic layer of human gates around it (plan doc: "Missions", "Human in the loop").

    goal → the orchestrator drafts milestones, tasks (each owned by a domain agent) and a validation contract
         → a person approves the plan and its budget (gate; who may approve depends on the amount)
         → tasks run one at a time, each in a fresh context (an AIP run) that reads the mission state and the handoffs
           so far and ends with a structured handoff
         → after each milestone a validator checks the contract's assertions against the data
         → the mission pauses at 80% of its budget and stops at 100% (gates); a person extends, waives a failed check
           (with a reason) or stops it. Every gate decision is logged with who and when.

The mission's files live in <data>/aip/missions/<id>/: mission.json (goal, plan, budget, gates, status), tasks.json,
validation-contract.json, handoffs.jsonl, log.jsonl (gate decisions). The runs are ordinary AIP runs (aip/runs.py).

    POST /api/aip/missions                       {goal}            → mission (status planning)
    GET  /api/aip/missions                       the caller's missions
    GET  /api/aip/missions/{id}                  mission, tasks, contract, handoffs, validations, runs, log
    POST /api/aip/missions/{id}/approve          {budget_usd?}     gate: start
    POST /api/aip/missions/{id}/extend           {usd, reason}     gate: more budget
    POST /api/aip/missions/{id}/waive            {assertion, reason} gate: accept a failed check
    POST /api/aip/missions/{id}/pause | resume | stop
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from aip import runs as aip_runs

router = APIRouter(prefix="/api/aip/missions")
log = logging.getLogger("aip.missions")

# measured on itb-agentic (golden set and first runs, 2026-10-22): the cost of one step of each kind, USD
EST_TASK_USD = 0.012
EST_VALIDATION_USD = 0.008
EST_PLAN_USD = 0.006
CAP_FACTOR = 1.5
PAUSE_AT = 0.8
MIN_STEP_USD = 0.002  # less budget left than this cannot pay for one model call of a step: pause instead of starting it
# who may approve a mission's cap (USD) — placeholders until BPJS sets them (plan doc, "Mission budget")
APPROVAL = [(2.0, "auditor"), (20.0, "team_lead"), (float("inf"), "branch_head")]
_lock = threading.Lock()
_threads: dict[str, threading.Thread] = {}


def _dir() -> Path:
    d = aip_runs._dir().parent / "missions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load(mid: str) -> dict:
    if not re.fullmatch(r"mis-[0-9a-f]{10}", mid):  # an id names a folder: nothing else reaches the filesystem
        raise HTTPException(404, "mission not found")
    try:
        return json.loads((_dir() / mid / "mission.json").read_text("utf-8"))
    except (OSError, ValueError):
        raise HTTPException(404, "mission not found") from None


def _save(m: dict) -> None:
    aip_runs._write(_dir() / m["id"] / "mission.json", m)


def _log(m: dict, who: str, what: str, detail: str = "") -> None:
    with (_dir() / m["id"] / "log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": _now(), "who": who, "what": what, "detail": detail}, ensure_ascii=False) + "\n")


def _read_jsonl(path: Path) -> list[dict]:
    try:
        return [json.loads(x) for x in path.read_text("utf-8").splitlines() if x.strip()]
    except OSError:
        return []


def _settle(m: dict) -> dict:
    """A mission planning or running without its loop (the API, or the script that ran it, stopped) never moves on.
    An interrupted plan fails (create the mission again); an interrupted execution pauses with its running task back
    to pending, so a person resumes it: a restart never spends on its own."""
    import psutil

    th = _threads.get(m["id"])
    host = m.get("host_pid")
    if m.get("status") not in ("planning", "running") or (th and th.is_alive()) or (host and host != os.getpid() and psutil.pid_exists(host)):
        return m
    with _lock:
        m = _load(m["id"])
        if m["status"] == "planning":
            m.update(status="failed", error="planning was interrupted (the API stopped): create the mission again")
        elif m["status"] == "running":
            m["status"] = "paused"
            tasks = json.loads((_dir() / m["id"] / "tasks.json").read_text("utf-8"))
            for t in tasks:
                if t["status"] == "running":
                    t["status"] = "pending"
            aip_runs._write(_dir() / m["id"] / "tasks.json", tasks)
        else:
            return m
        _save(m)
        _log(m, "system", "interrupted", "its loop stopped (an API restart or an error) while " + ("planning" if m["status"] == "failed" else "running: resume to continue"))
    return m


def _mine(mid: str) -> dict:
    m = _load(mid)
    p = aip_runs._principal()
    if m["user_id"] != p.get("id") and p.get("role") != "admin":
        raise HTTPException(404, "mission not found")
    return _settle(m)


def estimate(tasks: list[dict], milestones: int) -> float:
    """The plan's cost, from measured averages: deterministic, never the model's guess."""
    return round(EST_PLAN_USD + EST_TASK_USD * len(tasks) + EST_VALIDATION_USD * milestones, 4)


def approver_for(cap: float) -> str:
    return next(who for limit, who in APPROVAL if cap <= limit)


def _check_approver(p: dict, cap: float) -> None:
    """The deterministic gate on a mission's cap, the same for approving and for extending: an auditor up to the first
    threshold, above it that role (placeholder roles) or an administrator."""
    need = approver_for(cap)
    if need != "auditor" and p.get("role") != "admin" and need not in (p.get("aip_roles") or []):
        raise HTTPException(403, f"a cap of ${cap:.2f} needs approval by {need.replace('_', ' ')}")


# ------------------------------------------------------------------------------------------------
# the mission's run loop (a thread in the API, acting for the mission's owner)
# ------------------------------------------------------------------------------------------------


def _as_owner(m: dict) -> None:
    import auth

    p = auth.principal_of(m["user_id"]) if m["user_id"] not in (None, "local") else None
    auth._principal.set(p)


class _Base:
    """What runs.start reads from a request: the API address the runtime calls (fixed when the mission was made)."""
    def __init__(self, url: str):
        self.internal_api = url.rstrip("/")


def _wait_run(run_id: str) -> dict:
    while run_id in aip_runs._live:
        time.sleep(1)
    return aip_runs._rec(run_id)


def _spent(m: dict) -> float:
    total = 0.0
    for rid in m.get("runs") or []:
        try:
            total += float(aip_runs._rec(rid).get("spent_usd") or 0)
        except HTTPException:
            pass
    return round(total, 6)


def _start_run(m: dict, kind: str, payload: dict) -> dict:
    remaining = max(0.0, m["budget_usd"] - _spent(m)) if m.get("budget_usd") else None
    rec = aip_runs.start(kind, {**payload, "mission": {"id": m["id"], "goal": m["goal"]}}, _Base(m["api"]), budget_usd=remaining, mission_id=m["id"])
    with _lock:
        cur = _load(m["id"])
        cur.setdefault("runs", []).append(rec["id"])
        _save(cur)
    m.setdefault("runs", []).append(rec["id"])
    return rec


def _plan_loop(mid: str) -> None:
    m = _load(mid)
    _as_owner(m)
    try:
        rec = _start_run(m, "mission_plan", {"q": m["goal"]})
        run = _wait_run(rec["id"])
        plan = next((e.get("plan") for e in aip_runs._events(rec["id"]) if e.get("type") == "mission_plan"), None)
        with _lock:
            m = _load(mid)
            if not plan:
                m["status"] = "failed"
                m["error"] = f"the plan run {rec['id']} ended {run['status']} without a plan"
            else:
                tasks = [{"id": f"t{i + 1}", "milestone": t.get("milestone") or "M1", "agent": t["agent"], "title": t.get("title") or t["instruction"][:80],
                          "instruction": t["instruction"], "skill": str(t.get("skill") or "")[:60], "status": "pending", "run": None}
                         for i, t in enumerate(plan.get("tasks") or [])][:12]
                milestones = list(dict.fromkeys(t["milestone"] for t in tasks))
                m["plan"] = {"summary": plan.get("summary", ""), "milestones": [{"id": x, "title": (plan.get("milestones") or {}).get(x, x)} for x in milestones]}
                m["estimate_usd"] = estimate(tasks, len(milestones))
                m["proposed_cap_usd"] = round(m["estimate_usd"] * CAP_FACTOR, 4)
                m["approver"] = approver_for(m["proposed_cap_usd"])
                m["status"] = "awaiting_approval"
                aip_runs._write(_dir() / mid / "tasks.json", tasks)
                aip_runs._write(_dir() / mid / "validation-contract.json", [{"id": f"a{i + 1}", "text": a, "status": "open"}
                                                                            for i, a in enumerate(plan.get("contract") or [])][:12])
            m["spent_usd"] = _spent(m)
            _save(m)
    except Exception as e:  # noqa: BLE001
        with _lock:
            m = _load(mid)
            m["status"], m["error"] = "failed", str(e)[:500]
            _save(m)


def _execute_loop(mid: str) -> None:
    """The mission's work; an unexpected error pauses it for a person, with the error in its log (not a silent stop)."""
    try:
        _execute(mid)
    except Exception as e:  # noqa: BLE001
        log.exception("AIP mission %s stopped on an error", mid)
        with _lock:
            m = _load(mid)
            if m["status"] != "running":
                return
            m.update(status="paused", error=f"{type(e).__name__}: {e}"[:500])
            tasks = json.loads((_dir() / mid / "tasks.json").read_text("utf-8"))
            for t in tasks:
                if t["status"] == "running":
                    t["status"] = "pending"
            aip_runs._write(_dir() / mid / "tasks.json", tasks)
            _save(m)
            _log(m, "system", "error", f"{type(e).__name__}: {e}"[:300] + " — paused: resume to continue")


def _budget_refused(run_id: str) -> bool:
    """The run stopped because its budget could not pay for a call (aip/gateway.py: "run budget reached")."""
    return any(e.get("type") == "error" and "budget" in str(e.get("message", "")).lower() for e in aip_runs._events(run_id))


def _pause_for_budget(mid: str, why: str) -> None:
    with _lock:
        m = _load(mid)
        if m["status"] == "running":
            m["status"] = "paused_budget"
            _save(m)
            _log(m, "system", "budget pause", why)


def next_step(tasks: list[dict], validated: set[str]) -> tuple[Optional[str], Optional[dict]]:
    """(a milestone to validate, or the next task): a milestone whose tasks are all done is validated before the next
    task, also when its validation was cut short earlier (a budget pause, a restart)."""
    order = list(dict.fromkeys(t["milestone"] for t in tasks))
    ms = next((x for x in order if x not in validated and all(t["status"] in ("completed", "failed") for t in tasks if t["milestone"] == x)), None)
    return (ms, None) if ms else (None, next((t for t in tasks if t["status"] == "pending"), None))


def _execute(mid: str) -> None:
    m = _load(mid)
    _as_owner(m)
    d = _dir() / mid
    while True:
        with _lock:
            m = _load(mid)
            if m["status"] != "running":
                return
            spent = _spent(m)
            m["spent_usd"] = spent
            if spent >= m["budget_usd"]:
                m["status"] = "stopped_budget"
                _log(m, "system", "hard stop", f"spent ${spent:.4f} of ${m['budget_usd']:.2f}")
                _save(m)
                return
            if spent >= PAUSE_AT * m["budget_usd"] and m.get("pause_acknowledged_cap") != m["budget_usd"]:
                m["status"] = "paused_budget"
                _log(m, "system", "budget pause", f"spent ${spent:.4f} = {100 * spent / m['budget_usd']:.0f}% of ${m['budget_usd']:.2f}")
                _save(m)
                return
            tasks = json.loads((d / "tasks.json").read_text("utf-8"))
            ms, nxt = next_step(tasks, {v["milestone"] for v in _read_jsonl(d / "validations.jsonl")})
            _save(m)
        left = m["budget_usd"] - spent
        if ms is None and nxt is None:
            with _lock:
                m = _load(mid)
                m["status"] = "completed"
                m["finished_at"] = _now()
                contract = json.loads((d / "validation-contract.json").read_text("utf-8"))
                ok = sum(a["status"] in ("passed", "waived") for a in contract)
                _log(m, "system", "mission completed", f"contract {ok}/{len(contract)} passed or waived, spent ${_spent(m):.4f} of ${m['budget_usd']:.2f}")
                _save(m)
            return
        if left < MIN_STEP_USD:
            _pause_for_budget(mid, f"${left:.4f} left cannot pay for the next step")
            return
        contract = json.loads((d / "validation-contract.json").read_text("utf-8"))
        if ms:
            # the milestone's tasks are done: validate the contract against what the milestone found
            vrec = _start_run(m, "mission_validate", {"q": m["goal"], "milestone": ms, "contract": contract,
                                                      "handoffs": [h for h in _read_jsonl(d / "handoffs.jsonl")]})
            vrun = _wait_run(vrec["id"])
            if vrun["status"] == "cancelled":
                return  # stopped by a person: the validation runs again on resume
            if _budget_refused(vrec["id"]):
                _pause_for_budget(mid, f"the validation of {ms} needs more than the ${left:.4f} left")
                return
            verdict = next((e for e in aip_runs._events(vrec["id"]) if e.get("type") == "verdict"), None)
            with (d / "validations.jsonl").open("a", encoding="utf-8") as f:  # recorded even without a verdict, or it would run forever
                f.write(json.dumps({"milestone": ms, "run": vrec["id"], "t": _now(), "checks": (verdict or {}).get("checks") or [],
                                    "passed": (verdict or {}).get("passed", 0), "total": (verdict or {}).get("total", 0),
                                    **({} if verdict else {"error": f"the validation run ended {vrun['status']} without a verdict"})},
                                   ensure_ascii=False) + "\n")
            by_id = {c.get("id"): c for c in (verdict or {}).get("checks") or []}
            for a in contract:
                c = by_id.get(a["id"])
                if c and a["status"] != "waived":
                    a["status"] = "passed" if c.get("ok") else "failed"
                    a["evidence"] = c.get("bukti")
            aip_runs._write(d / "validation-contract.json", contract)
            continue
        handoffs = _read_jsonl(d / "handoffs.jsonl")
        nxt["status"] = "running"
        aip_runs._write(d / "tasks.json", tasks)
        rec = _start_run(m, "mission_task", {"q": nxt["instruction"], "task": nxt, "handoffs": handoffs[-6:], "contract": contract})
        nxt["run"] = rec["id"]
        aip_runs._write(d / "tasks.json", tasks)
        run = _wait_run(rec["id"])
        handoff = next((e.get("handoff") for e in aip_runs._events(rec["id"]) if e.get("type") == "handoff"), None)
        tasks = json.loads((d / "tasks.json").read_text("utf-8"))
        t = next(x for x in tasks if x["id"] == nxt["id"])
        refused = not handoff and _budget_refused(rec["id"])
        # stopped by a person, or the budget could not pay for it: the task waits and runs again on resume / extension
        t["status"] = "pending" if run["status"] == "cancelled" or refused else "completed" if run["status"] == "succeeded" and handoff else "failed"
        aip_runs._write(d / "tasks.json", tasks)
        if handoff:
            with (d / "handoffs.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps({"task": t["id"], "agent": t["agent"], "run": rec["id"], "t": _now(), **handoff}, ensure_ascii=False) + "\n")
        if refused:
            _pause_for_budget(mid, f"task {t['id']} needs more than the ${left:.4f} left")
            return


def _spawn(mid: str, target) -> None:
    with _lock:
        m = _load(mid)
        m["host_pid"] = os.getpid()  # the process whose thread runs the mission (_settle)
        _save(m)
    th = threading.Thread(target=target, args=(mid,), name=f"aip-mission-{mid}", daemon=True)
    _threads[mid] = th
    th.start()


# ------------------------------------------------------------------------------------------------
# routes: the gates
# ------------------------------------------------------------------------------------------------


class MissionIn(BaseModel):
    goal: str = Field(min_length=10, max_length=2000)


class ApproveIn(BaseModel):
    budget_usd: Optional[float] = Field(None, gt=0, le=70)


class ExtendIn(BaseModel):
    usd: float = Field(gt=0, le=20)
    reason: str = Field(min_length=3, max_length=500)


class WaiveIn(BaseModel):
    assertion: str
    reason: str = Field(min_length=3, max_length=500)


@router.post("")
def create(body: MissionIn, request: Request) -> dict:
    p = aip_runs._principal()
    mid = "mis-" + uuid.uuid4().hex[:10]
    (_dir() / mid).mkdir(parents=True)
    m = {"id": mid, "goal": body.goal.strip(), "user_id": p.get("id"), "username": p.get("username"), "status": "planning", "created_at": _now(),
         "api": aip_runs.internal_api(request), "budget_usd": None, "runs": [], "spent_usd": 0.0}
    _save(m)
    _log(m, p.get("username", ""), "mission created", body.goal[:200])
    _spawn(mid, _plan_loop)
    return m


@router.get("")
def list_missions() -> list[dict]:
    p = aip_runs._principal()
    out = []
    for d in sorted(_dir().iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            m = json.loads((d / "mission.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if m.get("user_id") == p.get("id"):
            m = _settle(m)
            out.append({k: m.get(k) for k in ("id", "goal", "status", "created_at", "budget_usd", "spent_usd", "estimate_usd")})
    return out[:50]


@router.get("/{mid}")
def get(mid: str) -> dict:
    m = _mine(mid)
    d = _dir() / mid
    m["spent_usd"] = _spent(m)

    def j(name: str, default: Any) -> Any:
        try:
            return json.loads((d / name).read_text("utf-8"))
        except (OSError, ValueError):
            return default

    runs = []
    for rid in m.get("runs") or []:
        try:
            r = aip_runs._rec(rid)
            runs.append({k: r.get(k) for k in ("id", "kind", "status", "created_at", "finished_at", "spent_usd", "agents_usage", "q")})
        except HTTPException:
            pass
    return {"mission": m, "tasks": j("tasks.json", []), "contract": j("validation-contract.json", []), "handoffs": _read_jsonl(d / "handoffs.jsonl"),
            "validations": _read_jsonl(d / "validations.jsonl"), "runs": runs, "log": _read_jsonl(d / "log.jsonl")}


@router.post("/{mid}/approve")
def approve(mid: str, body: ApproveIn) -> dict:
    m = _mine(mid)
    if m["status"] != "awaiting_approval":
        raise HTTPException(409, f"the mission is {m['status']}, not awaiting approval")
    cap = round(body.budget_usd or m["proposed_cap_usd"], 4)
    p = aip_runs._principal()
    _check_approver(p, cap)
    m.update({"budget_usd": cap, "status": "running", "approved_by": p.get("username"), "approved_at": _now()})
    _save(m)
    _log(m, p.get("username", ""), "plan approved", f"cap ${cap:.2f} (estimate ${m.get('estimate_usd', 0):.4f})")
    _spawn(mid, _execute_loop)
    return m


@router.post("/{mid}/extend")
def extend(mid: str, body: ExtendIn) -> dict:
    m = _mine(mid)
    if m["status"] not in ("running", "paused", "paused_budget", "stopped_budget"):
        raise HTTPException(409, f"the budget of a mission that is {m['status']} cannot be extended")
    p = aip_runs._principal()
    new_cap = round((m.get("budget_usd") or 0) + body.usd, 4)
    _check_approver(p, new_cap)
    m["budget_usd"] = new_cap
    # the 80% pause comes again for the new cap, unless the spend is already past it (then extending was the decision)
    m["pause_acknowledged_cap"] = new_cap if _spent(m) >= PAUSE_AT * new_cap else None
    restart = m["status"] in ("paused_budget", "stopped_budget")
    if restart:
        m["status"] = "running"
    _save(m)  # before the loop starts: it reads the mission's status from disk
    _log(m, p.get("username", ""), "budget extended", f"+${body.usd:.2f} → ${new_cap:.2f}: {body.reason}")
    if restart:
        _spawn(mid, _execute_loop)
    return _load(mid)


@router.post("/{mid}/waive")
def waive(mid: str, body: WaiveIn) -> dict:
    m = _mine(mid)
    d = _dir() / mid
    contract = json.loads((d / "validation-contract.json").read_text("utf-8"))
    a = next((x for x in contract if x["id"] == body.assertion), None)
    if not a:
        raise HTTPException(404, "assertion not found")
    if a["status"] not in ("failed", "open"):
        raise HTTPException(409, f"only a failed or open check can be waived; {a['id']} is {a['status']}")
    a.update({"status": "waived", "waived_by": aip_runs._principal().get("username"), "waiver_reason": body.reason, "waived_at": _now()})
    aip_runs._write(d / "validation-contract.json", contract)
    _log(m, a["waived_by"], "check waived", f"{a['id']}: {body.reason}")
    return a


@router.post("/{mid}/{action}")
def control(mid: str, action: str) -> dict:
    m = _mine(mid)
    who = aip_runs._principal().get("username", "")
    if action == "pause" and m["status"] == "running":
        m["status"] = "paused"
    elif action == "resume" and m["status"] in ("paused", "paused_budget"):
        m["status"] = "running"
        m["pause_acknowledged_cap"] = m["budget_usd"]  # resuming past the 80% pause is itself the person's decision
        _save(m)
        _log(m, who, action)
        _spawn(mid, _execute_loop)
        return _load(mid)
    elif action == "stop" and m["status"] not in ("completed", "stopped"):
        m["status"] = "stopped"
        # stop spending now: the task or validation running for this mission ends too
        for rid, live in list(aip_runs._live.items()):
            if live["rec"].get("mission_id") == mid and live["proc"].poll() is None:
                live["rec"]["status"] = "cancelled"
                live["proc"].kill()
    else:
        raise HTTPException(409, f"cannot {action} a mission that is {m['status']}")
    _save(m)
    _log(m, who, action)
    return m
