"""Object Monitors [Sunset], modelled on Palantir's Object Monitors (superseded by Automate).

A monitor (RID ri.object-sentinel.main.monitor.<uuid>) watches an input — a saved Object Explorer exploration or a
search of one object type — with a condition:
- event conditions: objects added to or removed from the input (newly created, or changed to match its filters), or a
  metric (count, or sum / avg / min / max of a property) increasing or decreasing; an optional threshold
  sub-condition must hold too (e.g. "the count increased and is now above 10");
- threshold conditions: a metric compared with a value, a true / false status over time — activity is recorded when
  it crosses in either direction;
- function-backed conditions: a Python function taking the input's objects and returning true / false (threshold).

Evaluation: realtime when the input's filters are on its own objects (also on Search Around steps; not linked filters) and the
condition is objects added or removed — evaluated as soon as objects of the input type are edited — otherwise on a
schedule (every 5 to 1440 minutes). The input is read (and a condition function run) as the monitor's owner — the
user who created or last saved it (run_as.py) — never as the system: when the owner is deleted, deactivated or can no
longer see an object type the input reads, the evaluation does not run and the reason is recorded on the monitor.
Each subscriber is evaluated as themselves (their markings and object
security: they hear only about objects they can see, actions run with their permissions) and gets in-platform (and
optionally email) notifications and can
have an action applied to each added object. Activity is kept six months; a monitor expires at most three months
ahead and can be extended.

Migration to Automate (the section at the end): a dry run computes the equivalent automation and lists what does
not translate; migrating creates it through Automate's own create function, links monitor and automation both ways
and pauses the monitor (a migrated monitor is never evaluated and cannot be edited); undo deletes the automation and
resumes the monitor while the automation is as the migration created it. Monitors Automate cannot express exactly
are refused with the reason.

Records are JSON files under data/ontology/object-monitors/. Mounted by server.py under /api/object-monitors.
"""

from __future__ import annotations

import contextlib
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import run_as
from ontology import _lock, _now

router = APIRouter(prefix="/api/object-monitors")
RETENTION = timedelta(days=183)
MAX_EXPIRY = timedelta(days=92)
# every filter the search evaluates on the input type's own objects (an edit re-runs the whole search); "linked"
# filters read another type, so those inputs stay scheduled
REALTIME_OPS = ("eq", "neq", "in", "between", "gt", "gte", "lt", "lte", "is_null", "not_null", "contains", "starts_with", "regex", "wildcard",
                "any_word", "phrase", "within", "geo")


def configure() -> None:
    (ontology.DIR / "object-monitors").mkdir(parents=True, exist_ok=True)
    import ontology_edits

    if _on_edits not in ontology_edits.LISTENERS:
        ontology_edits.LISTENERS.append(_on_edits)


def startup() -> None:
    threading.Thread(target=_loop, daemon=True, name="object-monitors").start()


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------------------------------------
# model
# ------------------------------------------------------------------------------------------------


class Metric(BaseModel):
    metric: Literal["count", "sum", "avg", "min", "max"] = "count"
    property: Optional[str] = None


class Threshold(BaseModel):
    metric: Metric = Metric()
    op: Literal["gt", "gte", "lt", "lte", "eq"] = "gt"
    value: float = 0


class Condition(BaseModel):
    kind: Literal["objects_added", "objects_removed", "metric_increased", "metric_decreased", "threshold", "function"]
    metric: Metric = Metric()
    threshold: Optional[Threshold] = None  # the threshold (kind threshold) or a sub-condition (events)
    function_id: Optional[str] = None


class Subscriber(BaseModel):
    user: str
    notify: bool = True
    email: bool = False
    # applied to each added object: {action_type_id, object_parameter, parameters}
    action: Optional[dict] = None


class MonitorIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    exploration_id: Optional[str] = None
    search: Optional[dict] = None  # a SearchIn spec (object_type_id, filters, q, search_around)
    condition: Condition
    subscribers: list[Subscriber] = []
    every_minutes: int = Field(60, ge=5, le=1440)
    expires_at: Optional[str] = None
    enabled: bool = True


def _spec(m: dict) -> dict:
    if m.get("exploration_id"):
        e = ontology._read(ontology._path("explorations", m["exploration_id"]))
        if not e:
            raise HTTPException(400, "the input exploration was deleted")
        return e["spec"]
    if not m.get("search") or not m["search"].get("object_type_id"):
        raise HTTPException(400, "pick a saved exploration or an object type to monitor")
    return m["search"]


def _types_involved(spec: dict) -> set[str]:
    """The object types an input reads: the start type and every type a Search Around step reaches."""
    import ontology_model as om

    out = {spec.get("object_type_id")}
    for st in spec.get("search_around") or []:
        lt = ontology._read(ontology._path("link-types", st.get("link_type_id") or ""))
        if lt:
            out.add(om.side_of(lt, st.get("direction") or "forward")[1]["object_type_id"])
    return {t for t in out if t}


def realtime_ok(m: dict) -> bool:
    """Inputs of exact-match / range / null filters, also along Search Around steps (an edit to any type on the path
    re-evaluates; links kept in join tables are not edits and wait for the schedule)."""
    spec = _spec(m)
    if spec.get("interface_id") or spec.get("semantic") or spec.get("with_properties"):
        return False
    filters = list(spec.get("filters") or []) + [f for st in spec.get("search_around") or [] for f in st.get("filters") or []]
    if any(f.get("op") not in REALTIME_OPS for f in filters):
        return False
    return m["condition"]["kind"] in ("objects_added", "objects_removed")


def _check(m: dict) -> None:
    import ontology_explorer as ox

    spec = _spec(m)
    ox.run_search(ox.SearchIn(**{**spec, "limit": 1}))
    c = m["condition"]
    if c["kind"] == "threshold" and not c.get("threshold"):
        raise HTTPException(400, "a threshold condition needs the threshold")
    if c["kind"] == "function" and not c.get("function_id"):
        raise HTTPException(400, "pick the condition function")
    exp = datetime.fromisoformat(m["expires_at"])
    if exp > _now_dt() + MAX_EXPIRY + timedelta(minutes=5):
        raise HTTPException(400, "a monitor expires at most three months ahead")
    for s in m["subscribers"]:
        if s.get("action"):
            ontology._get("action-types", s["action"].get("action_type_id", ""), "action type")


def _monitor(mid: str) -> dict:
    return ontology._get("object-monitors", mid, "object monitor")


def _public(m: dict) -> dict:
    out = {k: v for k, v in m.items() if k not in ("state",)}
    out["realtime"] = realtime_ok(m) if (m.get("exploration_id") or m.get("search")) else False
    out["expired"] = datetime.fromisoformat(m["expires_at"]) < _now_dt()
    out["status"] = (m.get("state") or {}).get("status")
    out["last_evaluated_at"] = (m.get("state") or {}).get("at")
    out["last_value"] = (m.get("state") or {}).get("value")
    # why the last evaluation did not run (the owner is gone or lost access), None when it ran
    out["blocked"] = (m.get("state") or {}).get("blocked")
    if out.get("activity"):
        out["activity"] = _narrow_activity(m, out["activity"])
    mig = _migration(m)
    if mig:
        out["migration"] = {**{k: v for k, v in mig.items() if k != "fingerprint"},
                            "automation_exists": ontology._path("automations", mig["automation_id"]).exists()}
        out["migrated_to"] = mig["automation_id"]
    else:
        out.pop("migration", None)
    return out


def _migration(m: dict) -> Optional[dict]:
    """The monitor's migration to Automate ({automation_id, at, by, was_enabled, fingerprint}), or None. Monitors
    migrated before the migration was recorded only carry migrated_to."""
    mig = m.get("migration")
    if mig and mig.get("automation_id"):
        return mig
    if m.get("migrated_to"):
        return {"automation_id": m["migrated_to"], "legacy": True, "was_enabled": True}
    return None


def _editable(m: dict) -> None:
    if _migration(m):
        raise HTTPException(409, "this monitor was migrated to Automate: edit the automation, or undo the migration first")


def _signed_in_caller() -> Optional[dict]:
    """The caller when sign-in limits what they see (None: sign-in off, the system or a service)."""
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return None
    return p


def _caller_sees(m: dict) -> bool:
    """Sign-in on: a monitor is shown to its owner and to callers who can see every object type its input reads (a
    monitor whose input can no longer be read hides nothing and is shown)."""
    p = _signed_in_caller()
    if p is None or m.get("owner") == p.get("id"):
        return True
    try:
        types = _types_involved(_spec(m))
    except HTTPException:
        return True
    try:
        for tid in types:
            ontology._object_type(tid)
    except HTTPException:
        return False
    return True


def _narrow_activity(m: dict, acts: list[dict]) -> list[dict]:
    """Activity as the caller may see it: the added / removed objects narrowed to those they can see (the activity
    was recorded with the owner's access, which may be wider)."""
    if _signed_in_caller() is None:
        return acts
    out = []
    for a in acts:
        if a.get("objects"):
            try:
                seen = _visible(m, list(a["objects"]))
            except HTTPException:
                seen = []
            a = {**a, "objects": seen, "count": len(seen)}
        out.append(a)
    return out


@router.get("")
def list_monitors() -> list[dict]:
    return [_public({**m, "activity": (m.get("activity") or [])[-5:]}) for m in sorted(ontology._all("object-monitors"), key=lambda m: m.get("updated_at", ""), reverse=True)
            if _caller_sees(m)]


@router.post("")
def create_monitor(req: MonitorIn) -> dict:
    m = {"id": f"mon-{uuid.uuid4().hex[:12]}", "rid": f"ri.object-sentinel.main.monitor.{uuid.uuid4()}", **req.model_dump(), "owner": _who(),
         "created_at": _now(), "activity": [], "state": None}
    m["expires_at"] = req.expires_at or (_now_dt() + MAX_EXPIRY).isoformat(timespec="seconds")
    if not m["subscribers"]:
        m["subscribers"] = [{"user": _who(), "notify": True, "email": False, "action": None}]
    for sub in m["subscribers"]:
        if sub["user"] == "me":
            sub["user"] = _who()
    _check(m)
    with _lock:
        ontology._put("object-monitors", m)
    evaluate(m["id"], baseline=True)
    return _public(_monitor(m["id"]))


def _seen_monitor(mid: str) -> dict:
    """The monitor when the caller may see it (_caller_sees), else 404."""
    m = _monitor(mid)
    if not _caller_sees(m):
        raise HTTPException(404, "object monitor not found")
    return m


@router.get("/{mid}")
def get_monitor(mid: str) -> dict:
    return _public(_seen_monitor(mid))


@router.put("/{mid}")
def save_monitor(mid: str, req: MonitorIn) -> dict:
    with _lock:
        m = _seen_monitor(mid)
        _editable(m)
        expires = m["expires_at"]
        m.update(req.model_dump())
        m["expires_at"] = req.expires_at or expires  # left out: the current expiry stays
        if auth.actor_id():
            # whoever saves it takes it over: it is evaluated with their access from now on (run_as.py)
            m["owner"] = auth.actor_id()
        _check(m)
        m["state"] = None
        ontology._put("object-monitors", m)
    evaluate(mid, baseline=True)
    return _public(_monitor(mid))


@router.delete("/{mid}")
def delete_monitor(mid: str) -> dict:
    with _lock:
        _seen_monitor(mid)
        ontology._path("object-monitors", mid).unlink(missing_ok=True)
    return {"deleted": mid}


class ExtendIn(BaseModel):
    days: int = Field(92, ge=1, le=92)


@router.post("/{mid}/extend")
def extend(mid: str, req: ExtendIn) -> dict:
    with _lock:
        m = _monitor(mid)
        _editable(m)
        m["expires_at"] = (_now_dt() + timedelta(days=req.days)).isoformat(timespec="seconds")
        ontology._put("object-monitors", m)
    return _public(m)


class SubscribeIn(BaseModel):
    notify: bool = True
    email: bool = False
    action: Optional[dict] = None


@router.post("/{mid}/subscribe")
def subscribe(mid: str, req: SubscribeIn) -> dict:
    with _lock:
        m = _monitor(mid)
        _editable(m)
        me = _who()
        m["subscribers"] = [s for s in m["subscribers"] if s["user"] != me] + [{"user": me, **req.model_dump()}]
        _check(m)
        ontology._put("object-monitors", m)
    return _public(m)


@router.delete("/{mid}/subscribe")
def unsubscribe(mid: str) -> dict:
    with _lock:
        m = _monitor(mid)
        _editable(m)
        m["subscribers"] = [s for s in m["subscribers"] if s["user"] != _who()]
        ontology._put("object-monitors", m)
    return _public(m)


# ------------------------------------------------------------------------------------------------
# evaluation
# ------------------------------------------------------------------------------------------------


def _metric(rows: list[dict], metric: dict) -> Optional[float]:
    if metric.get("metric", "count") == "count":
        return float(len(rows))
    nums = []
    for r in rows:
        try:
            nums.append(float(r["properties"].get(metric.get("property"))))
        except (TypeError, ValueError):
            pass
    if not nums:
        return None
    k = metric["metric"]
    return sum(nums) if k == "sum" else sum(nums) / len(nums) if k == "avg" else min(nums) if k == "min" else max(nums)


def _holds(th: dict, rows: list[dict]) -> tuple[bool, Optional[float]]:
    v = _metric(rows, th.get("metric") or {"metric": "count"})
    if v is None:
        return False, None
    x = float(th["value"])
    return {"gt": v > x, "gte": v >= x, "lt": v < x, "lte": v <= x, "eq": v == x}[th["op"]], v


_eval_locks: dict[str, threading.Lock] = {}
_eval_locks_guard = threading.Lock()


def evaluate(mid: str, baseline: bool = False, trigger: str = "scheduled") -> dict:
    """Evaluate a monitor now; returns the activity recorded (none on the baseline run). One evaluation of a monitor
    at a time: its own action's edits start realtime evaluations while it delivers, and those must see the state it
    records, not the one before (or the same added objects are reported and acted on again)."""
    with _eval_lock(mid):
        return _evaluate(mid, baseline, trigger)


def _eval_lock(mid: str) -> threading.Lock:
    with _eval_locks_guard:
        return _eval_locks.setdefault(mid, threading.Lock())


def _evaluate(mid: str, baseline: bool, trigger: str, resuming: bool = False) -> dict:
    """resuming: the baseline an undone migration records while the monitor is still marked migrated and paused."""
    with _lock:
        m = _monitor(mid)
        if _migration(m) and not resuming:
            # the automation fires in its place: the two never both evaluate
            return {"skipped": "migrated to Automate"}
        if not resuming and (not m.get("enabled", True) or datetime.fromisoformat(m["expires_at"]) < _now_dt()):
            return {"skipped": "disabled or expired"}
    # the input is read as the owner (their markings, ontology roles, object security), never as the system
    owner, blocked = _owner_access(m)
    if blocked:
        return _record_blocked(mid, blocked, trigger)
    with _acting(owner):
        return _evaluate_as_owner(mid, m, baseline, trigger)


def _acting(principal: Optional[dict]):
    return run_as.acting_as(principal) if auth.enabled() else contextlib.nullcontext()


def _owner_access(m: dict) -> tuple[Optional[dict], Optional[str]]:
    """(the owner's principal, None) when the monitor can be evaluated as its owner, else (None, the reason). Sign-in
    off: (None, None) — there are no users and nothing limits the evaluation."""
    if not auth.enabled():
        return None, None
    try:
        p = run_as.owner_principal(m.get("owner"), "the monitor")
    except run_as.OwnerUnavailable as e:
        return None, f"did not run: {e}"
    try:
        types = _types_involved(_spec(m))
    except HTTPException as e:
        return None, f"did not run: {e.detail}"
    with run_as.acting_as(p):
        for tid in sorted(types):
            try:
                ontology._object_type(tid)
            except HTTPException as e:
                return None, (f"did not run: the monitor's owner {run_as.who(p.get('id'))} can no longer see an object type its input reads "
                              f"({e.detail}): an editor who can must save it again (it then runs as them)")
    return p, None


def _record_blocked(mid: str, reason: str, trigger: str) -> dict:
    """The evaluation did not run: the reason is kept on the state (members untouched, so nothing is reported as
    added or removed when access comes back) and recorded once as an error in the activity."""
    with _lock:
        m = _monitor(mid)
        st = dict(m.get("state") or {})
        st.update(at=_now(), trigger=trigger, blocked=reason)
        m["state"] = st
        acts = m.get("activity") or []
        if not (acts and acts[-1].get("kind") == "error" and acts[-1].get("detail") == reason):
            cutoff = (_now_dt() - RETENTION).isoformat()
            m["activity"] = [a for a in acts if a["at"] >= cutoff] + [{"at": _now(), "trigger": trigger, "kind": "error", "detail": reason}]
        ontology._put("object-monitors", m)
    return {"activity": None, "skipped": reason, "blocked": reason}


def _evaluate_as_owner(mid: str, m: dict, baseline: bool, trigger: str) -> dict:
    import ontology_explorer as ox

    with _lock:
        rows = ox.run_search(ox.SearchIn(**{**_spec(m), "limit": 1}))["rows"]
    c = m["condition"]
    state = m.get("state") or {}
    members = sorted(r["primary_key"] for r in rows)
    value = _metric(rows, c.get("metric") or {"metric": "count"})
    status = None
    activity: Optional[dict] = None
    if c["kind"] == "threshold":
        status, value = _holds(c["threshold"], rows)
    elif c["kind"] == "function":
        run = ontology.MODEL_HOOKS.get("run_function")
        res = run(c["function_id"], None, {"objects": [{"object_type_id": r["object_type_id"], "primary_key": r["primary_key"]} for r in rows]}, {"resource": f"monitor:{mid}"}) if run else {"ok": False, "error": "functions are not available"}
        status = bool(res.get("value")) if res.get("ok") else None
        if not res.get("ok"):
            activity = {"kind": "error", "detail": f"the condition function failed: {res.get('error')}"}
    # a state without members was never evaluated (only blocked): this run is the baseline
    if not baseline and state.get("members") is not None and activity is None:
        prev = set(state.get("members") or [])
        sub_ok = True
        if c.get("threshold") and c["kind"] not in ("threshold", "function"):
            sub_ok, _ = _holds(c["threshold"], rows)
        if c["kind"] == "objects_added":
            added = [pk for pk in members if pk not in prev]
            if added and sub_ok:
                activity = {"kind": "objects_added", "objects": added[:500], "count": len(added)}
        elif c["kind"] == "objects_removed":
            # objects the owner can no longer see did not leave the input: they are only out of the owner's view
            # (and are never named); deleted ones did leave it
            gone = _visible_removed(m, [pk for pk in prev if pk not in set(members)])
            if gone and sub_ok:
                activity = {"kind": "objects_removed", "objects": gone[:500], "count": len(gone)}
        elif c["kind"] in ("metric_increased", "metric_decreased"):
            before = state.get("value")
            if before is not None and value is not None and sub_ok and ((value > before) if c["kind"] == "metric_increased" else (value < before)):
                activity = {"kind": c["kind"], "from": before, "to": value}
        elif status is not None and state.get("status") is not None and status != state.get("status"):
            activity = {"kind": "threshold_crossed", "status": status, "value": value}
    effects = []
    if activity and activity["kind"] != "error":
        effects = _deliver(m, activity, rows)
        activity["effects"] = effects
    with _lock:
        m = _monitor(mid)
        m["state"] = {"at": _now(), "members": members, "value": value, "status": status, "trigger": trigger}
        if activity:
            cutoff = (_now_dt() - RETENTION).isoformat()
            m["activity"] = [a for a in (m.get("activity") or []) if a["at"] >= cutoff] + [{"at": _now(), "trigger": trigger, **activity}]
        ontology._put("object-monitors", m)
    return {"activity": activity, "value": value, "status": status, "members": len(members)}


def _as_subscriber(user: str):
    """The subscriber as the request principal (their markings and groups), or None when they no longer exist or
    are deactivated. Without sign-in every subscriber sees everything."""
    import contextlib

    if not auth.enabled():
        return contextlib.nullcontext(True)
    principal = auth.principal_of(user)
    if principal is None:
        return None

    @contextlib.contextmanager
    def ctx():
        token = auth._principal.set(principal)
        try:
            yield True
        finally:
            auth._principal.reset(token)

    return ctx()


def _input_type(m: dict) -> dict:
    """The object type of the input's objects (checked for the current principal: 403 / 404 when they cannot see it)."""
    import ontology_model as om

    spec = _spec(m)
    tid = spec["object_type_id"]
    for st in spec.get("search_around") or []:
        # the input's objects are of the type its last Search Around step reaches
        lt = ontology._get("link-types", st.get("link_type_id") or "", "link type")
        tid = om.side_of(lt, st.get("direction") or "forward")[1]["object_type_id"]
    return ontology._object_type(tid)


def _visible(m: dict, pks: list[str]) -> list[str]:
    """The objects among pks the current principal can see."""
    t = _input_type(m)
    objs = ontology._objects(t["id"])
    return [pk for pk in pks if pk in objs and ontology._can_see(t, objs[pk])]


def _visible_removed(m: dict, pks: list[str]) -> list[str]:
    """Removed objects the current principal may hear about: deleted ones (they can see the type), and existing ones
    they can see. Sign-in off: all of them."""
    if not auth.enabled():
        return pks
    t = _input_type(m)
    objs = ontology._objects(t["id"])
    return [pk for pk in pks if pk not in objs or ontology._can_see(t, objs[pk])]


def _deliver(m: dict, activity: dict, rows: list[dict]) -> list[dict]:
    """Notify each subscriber and run their action as that subscriber: added / removed objects narrowed to the ones
    they can see (nothing is sent when they see none), metrics recomputed from the objects they can see, actions
    applied with their permissions."""
    import notify
    import ontology_explorer as ox

    by_pk = {r["primary_key"]: r for r in rows}
    out = []
    for s in m["subscribers"]:
        ctx = _as_subscriber(s["user"])
        if ctx is None:
            out.append({"user": s["user"], "skipped": "the user no longer exists or is deactivated"})
            continue
        with ctx:
            mine = dict(activity)
            try:
                if activity["kind"] in ("objects_added", "objects_removed"):
                    # removed objects may be gone: deleted ones count when they see the type, existing ones when they see them
                    seen = _visible(m, activity["objects"]) if activity["kind"] == "objects_added" else _visible_removed(m, activity["objects"])
                elif activity["kind"] in ("threshold_crossed", "metric_increased", "metric_decreased"):
                    with _lock:
                        their_rows = ox.run_search(ox.SearchIn(**{**_spec(m), "limit": 1}))["rows"]
            except HTTPException as e:
                # a subscriber who lost access to the input hears nothing (and the others still do)
                out.append({"user": s["user"], "skipped": f"they can no longer read the monitor's input ({e.detail})"})
                continue
            if activity["kind"] in ("objects_added", "objects_removed"):
                if not seen:
                    out.append({"user": s["user"], "skipped": "none of the objects are visible to them"})
                    continue
                mine.update(objects=seen, count=len(seen))
            elif activity["kind"] in ("threshold_crossed", "metric_increased", "metric_decreased"):
                metric = (m["condition"].get("threshold") or {}).get("metric") or m["condition"].get("metric") or {"metric": "count"}
                their = _metric(their_rows, metric)
                if activity["kind"] == "threshold_crossed":
                    mine["value"] = their
                else:
                    mine["to"] = their
            if mine["kind"] == "objects_added":
                what = f"{mine['count']} object{'s' if mine['count'] != 1 else ''} added: " + ", ".join(by_pk[pk]["title"] for pk in mine["objects"][:5] if pk in by_pk)
            elif mine["kind"] == "objects_removed":
                what = f"{mine['count']} object{'s' if mine['count'] != 1 else ''} left the input"
            elif mine["kind"] == "threshold_crossed":
                what = f"the condition is now {'met' if mine['status'] else 'no longer met'} (value {mine['value']})"
            else:
                what = f"the metric went from {mine['from']} to {mine['to']}"
            if s.get("notify", True):
                r = notify.deliver(s["user"], f"Monitor: {m['name']}", what, link="/object-monitors", link_label="Open monitor", source="object-monitors", email=bool(s.get("email")))
                out.append({"user": s["user"], "notification": r, "objects": mine.get("count")})
            act = s.get("action")
            if act and mine["kind"] == "objects_added":
                done = failed = 0
                errors: list[str] = []
                for pk in mine["objects"][:100]:
                    try:
                        params = {**(act.get("parameters") or {}), act.get("object_parameter") or "object": pk}
                        ontology.apply_action(act["action_type_id"], ontology.ApplyAction(parameters=params))
                        done += 1
                    except HTTPException as e:
                        failed += 1
                        errors.append(str(e.detail))
                out.append({"user": s["user"], "action": act["action_type_id"], "applied": done, "failed": failed, **({"error": errors[0]} if errors else {})})
    return out


def _on_edits(records: list[dict], who: str, now: str) -> None:
    """Realtime evaluation: monitors on an edited object type that qualify are evaluated right away."""
    types = {r["object_type_id"] for r in records}
    for m in ontology._all("object-monitors"):
        try:
            if m.get("enabled", True) and not _migration(m) and types & _types_involved(_spec(m)) and realtime_ok(m):
                threading.Thread(target=evaluate, args=(m["id"], False, "realtime"), daemon=True).start()
        except HTTPException:
            continue


def _loop() -> None:
    while True:
        time.sleep(60)
        for m in ontology._all("object-monitors"):
            last = (m.get("state") or {}).get("at")
            if last and (_now_dt() - datetime.fromisoformat(last)).total_seconds() < m.get("every_minutes", 60) * 60:
                continue
            try:
                evaluate(m["id"])
            except Exception:  # noqa: BLE001 - a broken input is retried at the next tick
                continue


@router.post("/{mid}/evaluate")
def evaluate_now(mid: str) -> dict:
    """Evaluate now — as the monitor's owner, like the schedule (the caller only starts it)."""
    _seen_monitor(mid)
    return evaluate(mid, trigger="manual")


# ------------------------------------------------------------------------------------------------
# migration to Automate
# ------------------------------------------------------------------------------------------------
#
# What Automate (automate.py) can express exactly is translated; everything else is refused with its reason:
# - input: one object type narrowed by filters on its own plain scalar properties (eq, neq, gt, gte, lt, lte,
#   contains on strings, is_null, not_null; `in` with one value; `between` as two filters) → the condition's
#   object_type_id + filters. Keyword search, Search Around, interfaces, semantic search, derived properties, linked,
#   text-analysis, array and geo filters have no Automate filter that evaluates the same way;
# - objects added / removed (realtime) → objects_added / objects_removed, live evaluation, allow_cycles (a monitor
#   reacts to every edit, its own action's too);
# - threshold and function-backed conditions → only with a published function the migrator names (an ObjectSet of the
#   input type → boolean): Automate's function-backed threshold logic, evaluated every every_minutes, effects in both
#   directions. Automate here has no aggregate (count / sum / avg / min / max) threshold of its own, and it hands a
#   condition function an object set where a monitor hands it a list of objects;
# - metric increased / decreased, and a threshold sub-condition on an event → no Automate counterpart here;
# - subscribers with notify → notification effects (recipients user:<id>, one message for all objects; an effect with
#   email for the subscribers who asked for email, one without for the others); subscriber actions → action effects
#   once per added object, which run as the automation's owner — so only when the subscriber is the migrating user
#   (or sign-in is off); expiry → settings.expires_at;
# - evaluation as each subscriber (object types with object / property security, mandatory controls, markings or
#   additional datasources) and datasource-backed types (a sync is not an edit: Automate never sees those objects)
#   are refused.

MIGRATION_OPS = {"eq": "eq", "neq": "neq", "gt": "gt", "gte": "gte", "lt": "lt", "lte": "lte", "contains": "contains", "is_null": "is_empty", "not_null": "not_empty"}
MIGRATION_SCALARS = ("string", "integer", "long", "short", "byte", "double", "float", "decimal", "boolean", "date", "timestamp")
_migrate_lock = threading.Lock()


class ConditionFunction(BaseModel):
    """A published function standing for a threshold / function-backed condition in Automate: it receives the input
    as an ObjectSet (objects_input; found when the function has exactly one object set input) and returns a boolean."""
    function_id: str
    version: Optional[str] = None
    objects_input: Optional[str] = None
    inputs: dict = {}


class MigrateIn(BaseModel):
    condition_function: Optional[ConditionFunction] = None


class MigrateAllIn(BaseModel):
    # only these monitors (all of them when omitted); dry_run reports what would happen without creating anything
    ids: Optional[list[str]] = None
    dry_run: bool = False


def _filter_value_ok(p: dict, v) -> Optional[str]:
    """Why a filter value compares differently in Automate than in the monitor's search (None when it does not)."""
    if v is None or isinstance(v, (list, dict)):
        return "a comparison with an empty or structured value"
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return "a comparison with NaN or infinity"
    if isinstance(v, str) and v.strip().lower().lstrip("+-") in ("nan", "inf", "infinity"):
        return "a comparison with NaN or infinity"
    if (p["type"] == "boolean") != isinstance(v, bool):
        return "a boolean compared with a value that is not a boolean (or the reverse)"
    return None


def _translate_filters(t: dict, filters: list[dict], no) -> list[dict]:
    props = {p["api_name"]: p for p in t["properties"]}
    out: list[dict] = []
    for f in filters:
        name, op, v = f.get("property"), f.get("op") or "eq", f.get("value")
        label = f"filter {name} {op}"
        if name == "__link":
            no(label, "a linked-object filter reads another object type: an Automate object set filters on the type's own properties")
            continue
        if name == "__title":
            no(label, "a filter on the object title: Automate filters on stored properties")
            continue
        p = props.get(name)
        if p is None:
            no(label, f"{t['display_name']} has no property {name}")
            continue
        if p.get("derived") or p.get("reducers") or p.get("array") or p["type"] not in MIGRATION_SCALARS:
            no(label, f"{name} is a {'derived' if p.get('derived') else 'reduced' if p.get('reducers') else 'array' if p.get('array') else p['type']} property: "
                      "Automate compares the stored value as one number or string, the monitor's search does not")
            continue
        if op == "in":
            vals = v if isinstance(v, list) else [v]
            if len(vals) != 1:
                no(label, "one of several values: Automate's filters are all ANDed, there is no OR")
                continue
            op, v = "eq", vals[0]
        if op == "between":
            lo, hi = (v[0] if len(v) > 0 else None, v[1] if len(v) > 1 else None) if isinstance(v, list) else (None, None)
            bounds = [(o, x) for o, x in (("gte", lo), ("lte", hi)) if x not in (None, "")]
            bad = next((why for _o, x in bounds if (why := _filter_value_ok(p, x))), None)
            if not bounds or bad:
                no(label, bad or "a range without bounds")
                continue
            out += [{"property": name, "op": o, "value": x} for o, x in bounds]
            continue
        if op not in MIGRATION_OPS:
            no(label, f"Automate has no \"{op}\" filter (its operators: equals, not equals, greater / less than, contains, is empty, is not empty)")
            continue
        if op in ("is_null", "not_null"):
            out.append({"property": name, "op": MIGRATION_OPS[op]})
            continue
        if op == "contains":
            if p["type"] != "string" or not isinstance(v, str) or not v:
                no(label, "\"contains\" translates only for a non-empty text on a string property")
                continue
        else:
            why = _filter_value_ok(p, v)
            if why:
                no(label, f"{why}: Automate would compare it differently")
                continue
        out.append({"property": name, "op": MIGRATION_OPS[op], "value": v})
    return out


def _text(s: str) -> str:
    """Literal text in an Automate template (no {{variables}} of the monitor's own)."""
    return str(s).replace("{{", "{ {").replace("}}", "} }")


def plan(m: dict, fn: Optional[dict] = None) -> dict:
    """The dry run of a migration: the Automate automation equivalent to the monitor, what was translated into
    what, what does not translate (any entry refuses the migration) and notes (differences in wording or bookkeeping
    that do not change when the effects fire or who they reach)."""
    import automate
    import ontology_explorer as ox

    blockers: list[dict] = []
    notes: list[str] = []
    mapped: list[dict] = []

    def no(feature: str, reason: str) -> None:
        blockers.append({"feature": feature, "reason": reason})

    def yes(monitor: str, automation: str) -> None:
        mapped.append({"monitor": monitor, "automate": automation})

    def result(automation: Optional[dict] = None) -> dict:
        return {"monitor": {"id": m["id"], "name": m["name"], "kind": m["condition"]["kind"]}, "translates": not blockers,
                "automation": automation if not blockers else None, "translated": mapped, "untranslatable": blockers, "notes": notes}

    c = m["condition"]
    kind = c["kind"]
    if datetime.fromisoformat(m["expires_at"]) < _now_dt():
        no("expiry", "the monitor has expired: extend it first (an automation created expired would pause itself at once)")
    # ---- the input → object_type_id + filters
    try:
        spec = _spec(m)
        if spec.get("interface_id"):
            raise HTTPException(400, "the input is an interface: an Automate object set is one object type")
        t = ontology._object_type(spec.get("object_type_id") or "")
    except HTTPException as e:
        no("input", str(e.detail))
        return result()
    if spec.get("semantic"):
        no("input: semantic search", "Automate's object sets are filters on properties: there is no ranked / nearest-neighbour set")
    if str(spec.get("q") or "").strip():
        no("input: keyword search", "Automate's object sets filter on single properties: there is no keyword search across the searchable properties")
    if spec.get("search_around"):
        no("input: Search Around", "the input's objects are reached through links: an Automate object set is one object type narrowed by filters on its own properties")
    if spec.get("with_properties"):
        no("input: derived properties", "they change when linked objects change, which the monitor sees on its schedule; a live Automate condition re-evaluates only when the object itself is edited")
    filters = _translate_filters(t, [dict(f) for f in spec.get("filters") or []], no)
    if t.get("backing_dataset"):
        no("input: datasource-backed object type", f"{t['display_name']} is synced from a dataset: the monitor's scheduled evaluation also sees objects that arrive or change "
           "with a sync, but a sync is not an edit and Automate's conditions react to edits only")
    restricted = [w for w, on in (("object or property security policies", bool(t.get("security"))),
                                  ("mandatory control properties", any(p.get("mandatory_control") for p in t["properties"])),
                                  ("additional datasources", bool(t.get("additional_datasources"))),
                                  ("markings", bool(auth.resource_effective("object_type", t["id"])))) if on]
    if restricted:
        no("evaluation as each subscriber", f"{t['display_name']} has {', '.join(restricted)}: the monitor evaluates as each subscriber (they hear only about objects "
           "they can see, metrics come from their view); an automation evaluates once and sends every recipient the same")
    if m.get("exploration_id"):
        notes.append("The input is a saved exploration: its filters are copied as they are now; later edits to the exploration do not reach the automation.")
    yes(f"input: {t['display_name']}" + (f" with {len(spec.get('filters') or [])} filter(s)" if spec.get("filters") else ""),
        f"object set: {t['display_name']}" + (f" with {len(filters)} filter(s)" if filters else ""))
    cond: dict = {"object_type_id": t["id"], "filters": filters}
    # ---- the condition
    th_fn: Optional[dict] = None
    if kind in ("objects_added", "objects_removed"):
        if c.get("threshold"):
            no("threshold sub-condition", "\"and the metric is over / under a value\" has no Automate counterpart: its object set conditions fire on each object, without an aggregate check")
        try:
            realtime = realtime_ok(m)
        except HTTPException:
            realtime = False
        if not realtime and not blockers:
            no("scheduled evaluation", "the monitor compares the input between scheduled evaluations; Automate's live evaluation reacts to each edit")
        cond.update(kind=kind, allow_cycles=True)
        yes("objects added to the input" if kind == "objects_added" else "objects removed from the input", f"condition: {kind.replace('_', ' ')} (live evaluation)")
        yes("realtime evaluation on every edit, the monitor's own action's too", "live evaluation with \"allow cycles\"")
        notes.append(f"The monitor also re-checks its input every {m.get('every_minutes', 60)} minutes, which catches objects written without an edit; "
                     "Automate reacts to edits only (this object type is not datasource-backed, so edits are how its objects change).")
        if fn:
            no("condition function", "a condition function belongs to a threshold or function-backed monitor")
    elif kind in ("metric_increased", "metric_decreased"):
        no(KIND_NAMES[kind], "Automate here has no \"metric changed\" condition (it is sunset in Automate too): nothing fires when an aggregate goes up or down between evaluations")
    else:  # threshold | function
        what = (f"{(c.get('threshold') or {}).get('metric', {}).get('metric', 'count')} {(c.get('threshold') or {}).get('op')} {(c.get('threshold') or {}).get('value')}"
                if kind == "threshold" else f"function {c.get('function_id')}")
        if not fn:
            if kind == "threshold":
                no("threshold on an aggregate metric", f"Automate's own threshold tests one object's property, not the input's {what.split(' ')[0]}: it needs function-backed logic — "
                   "migrate with a published function that takes the input as an ObjectSet and returns the comparison (condition_function)")
            else:
                no("function-backed condition", "the monitor hands its function a list of objects; Automate hands a condition function an object set ({object_type_id, primary_keys}), "
                   "which a list-typed input does not accept — migrate with a published function that takes an ObjectSet (condition_function)")
        else:
            th_fn = _condition_function(t, fn, no)
            if th_fn:
                cond.update(kind="threshold", threshold={"function": th_fn}, poll_minutes=int(m.get("every_minutes", 60)))
                yes(f"{KIND_NAMES[kind].lower()} ({what}), activity when it crosses in either direction",
                    f"condition: threshold crossed, function-backed logic ({th_fn['function_id']}), effects in both directions")
                yes(f"scheduled evaluation every {m.get('every_minutes', 60)} minutes", f"evaluated every {m.get('every_minutes', 60)} minutes")
                notes.append("The function is taken as the monitor's condition: it is checked against the monitor's status on the current data only.")
    # ---- subscribers → effects
    effects: list[dict] = []
    subs = list(m.get("subscribers") or [])
    known = []
    for s in subs:
        if auth.enabled() and auth.principal_of(s["user"]) is None:
            notes.append(f"Subscriber {s['user']} no longer exists or is deactivated: left out (the monitor skips them too).")
        else:
            known.append(s)
    body = {"objects_added": "Objects added ({{objects.count}}): {{objects.titles}}",
            "objects_removed": "Objects left the input. Still existing: {{objects.count}} {{objects.titles}}"}.get(
                kind, "The condition changed (met or no longer met): the automation's history shows the direction.")
    for email in (False, True):
        who = [s["user"] for s in known if s.get("notify", True) and bool(s.get("email")) == email]
        if who:
            effects.append({"kind": "notification", "recipients": {"principals": [f"user:{u}" for u in who]}, "subject": _text(f"Monitor: {m['name']}"), "body": body,
                            "grouping": "once", "email": email, "continue_on_failure": True})
            yes(f"notify {', '.join(who)}" + (" (in-platform and email)" if email else " (in-platform)"),
                f"notification effect to {', '.join('user:' + u for u in who)}, one message for all objects" + (", with email" if email else ""))
    if effects:
        notes.append("Notification wording differs: the automation's message links to the object or the automation, not to Object Monitors"
                     + {"objects_added": ".", "objects_removed": "; deleted objects are not counted or named in it (Automate drops objects that no longer exist from an execution)."}.get(
                         kind, ", and cannot say which way the condition crossed or the metric's value."))
    me = auth.actor_id()
    for s in known:
        act = s.get("action")
        if not act:
            continue
        if kind != "objects_added":
            notes.append(f"{s['user']}'s action is not migrated: a monitor applies actions to added objects only, so it never ran for this condition.")
            continue
        if auth.enabled() and s["user"] != me:
            no(f"action run as {s['user']}", f"the monitor applies the action with {s['user']}'s permissions; an automation's effects all run as its owner — you, the user migrating it. "
               f"{s['user']} has to migrate this monitor (or the action has to go)")
            continue
        params = {k: {"value": v} for k, v in (act.get("parameters") or {}).items()}
        params[act.get("object_parameter") or "object"] = "{{object.primaryKey}}"
        effects.append({"kind": "action", "action_type_id": act.get("action_type_id"), "parameters": params, "execution_mode": "per_object", "continue_on_failure": True})
        yes(f"apply {act.get('action_type_id')} to each added object as {s['user']}", f"action effect, once per object, run as the owner ({me or 'sign-in is off'})")
        notes.append("Actions: the monitor applies an action to at most 100 added objects per evaluation and goes on after one fails; "
                     "the automation applies it to every added object and stops that effect at the first failure (the execution is recorded as failed and can be retried).")
    if not effects:
        effects = [{"kind": "none"}]
        yes("no subscriber to notify and no action", "no effect: executions are only recorded")
    yes(f"expires {m['expires_at']}", "settings: expiration (the automation pauses itself)")
    if not m.get("enabled", True):
        notes.append("The monitor is disabled: the automation is created paused.")
    if blockers:
        return result()
    automation = {
        "name": m["name"],
        "description": _text(f"Migrated from the object monitor \"{m['name']}\" ({m['rid']}). {m.get('description') or ''}".strip())[:2000],
        "enabled": bool(m.get("enabled", True)),
        "condition": cond,
        "effects": effects,
        "settings": {"expires_at": m["expires_at"], "migrated_from": {"kind": "object-monitor", "id": m["id"], "rid": m["rid"], "name": m["name"]}},
    }
    # ---- the proof on the current data: the same object set, and (function-backed) the same status
    try:
        rows = ox.run_search(ox.SearchIn(**{**spec, "limit": 1}))["rows"]
        theirs = {str(r["primary_key"]) for r in rows}
        ours = {str(pk) for pk in automate.set_members(cond)}
        if theirs != ours:
            diff = sorted(theirs ^ ours)[:5]
            no("input", f"on the current data the automation's object set ({len(ours)} objects) is not the monitor's input ({len(theirs)}): they differ on {', '.join(diff)}")
        elif th_fn:
            if kind == "threshold":
                status: Optional[bool] = _holds(c["threshold"], rows)[0]
            else:
                run = ontology.MODEL_HOOKS.get("run_function")
                res = run(c["function_id"], None, {"objects": [{"object_type_id": r["object_type_id"], "primary_key": r["primary_key"]} for r in rows]}, {"resource": f"monitor:{m['id']}"}) if run else {}
                status = bool(res.get("value")) if res.get("ok") else None
            inputs = dict(th_fn.get("inputs") or {})
            inputs[th_fn["objects_input"]] = {"object_type_id": t["id"], "primary_keys": sorted(ours)}
            value = automate.fn_value(th_fn, inputs)
            if not isinstance(value, bool):
                no("condition function", "it did not return a boolean")
            elif status is None:
                no("condition function", "the monitor's own condition could not be evaluated now, so the function cannot be checked against it")
            elif value != status:
                no("condition function", f"on the current data it returns {value} while the monitor's condition is {status}: it is not the same condition")
    except HTTPException as e:
        no("input", str(e.detail))
    except Exception as e:  # noqa: BLE001 - a failing function is a reason, not a crash
        no("condition function", f"it failed: {e}")
    return result(automation)


KIND_NAMES = {"objects_added": "Objects added", "objects_removed": "Objects removed", "metric_increased": "Metric increased", "metric_decreased": "Metric decreased",
              "threshold": "Threshold", "function": "Function-backed condition"}


def _condition_function(t: dict, fn: dict, no) -> Optional[dict]:
    """The Automate function-backed threshold logic for a named function, or None with the reasons recorded."""
    try:
        ontology._hook("check_function_ref", fn["function_id"], fn.get("version"))
        info = ontology._hook("function_info", fn["function_id"], fn.get("version")) or {}
    except HTTPException as e:
        no("condition function", str(e.detail))
        return None
    if not info:
        no("condition function", "functions are not available")
        return None
    if str(info.get("output")) != "boolean":
        no("condition function", f"it returns {info.get('output')}: function-backed logic returns a boolean")
        return None
    sets = [i for i in info.get("inputs") or [] if str(i.get("type")).startswith("object_set:")]
    name = fn.get("objects_input") or (sets[0]["name"] if len(sets) == 1 else None)
    inp = next((i for i in sets if i["name"] == name), None)
    if not inp:
        no("condition function", "pick its ObjectSet input that receives the monitor's input (it has none, or several)")
        return None
    if str(inp["type"])[len("object_set:"):] not in (t.get("api_name"), t["id"]):
        no("condition function", f"its input {name} is an {inp['type']}, the monitor's input is {t.get('api_name') or t['id']}")
        return None
    return {"function_id": fn["function_id"], "version": fn.get("version"), "inputs": dict(fn.get("inputs") or {}), "objects_input": name}


def _fingerprint(a: dict) -> str:
    """What an undo compares: the automation's definition (not its enabled / muted state or its runs)."""
    import copy
    import hashlib
    import json

    import automate

    n = automate.normalize(copy.deepcopy(a))
    return hashlib.sha256(json.dumps({k: n.get(k) for k in ("name", "description", "condition", "effects", "settings")}, sort_keys=True, default=str).encode()).hexdigest()


@router.post("/migrate-all")
def migrate_all(req: MigrateAllIn) -> dict:
    """Migrate every monitor that translates (or only `ids`); one result per monitor: migrated (with the automation),
    refused (with the reasons), already_migrated, or failed. dry_run reports would_migrate instead of migrating."""
    results = []
    for m in sorted(ontology._all("object-monitors"), key=lambda x: x.get("name", "")):
        if req.ids is not None and m["id"] not in req.ids:
            continue
        row: dict = {"id": m["id"], "name": m["name"], "kind": m["condition"]["kind"]}
        mig = _migration(m)
        if mig:
            results.append({**row, "status": "already_migrated", "automation_id": mig["automation_id"]})
            continue
        try:
            p = plan(m)
            if not p["translates"]:
                results.append({**row, "status": "refused", "untranslatable": p["untranslatable"]})
            elif req.dry_run:
                results.append({**row, "status": "would_migrate", "notes": p["notes"]})
            else:
                done = _migrate(m["id"], None)
                results.append({**row, "status": "migrated", "automation_id": done["automation"]["id"], "notes": p["notes"]})
        except HTTPException as e:
            results.append({**row, "status": "failed", "error": str(e.detail)})
    missing = [i for i in req.ids or [] if i not in {r["id"] for r in results}]
    return {"results": results, "unknown": missing, "dry_run": req.dry_run, **{k: sum(1 for r in results if r["status"] == k) for k in ("migrated", "would_migrate", "refused", "already_migrated", "failed")}}


@router.post("/{mid}/migrate/dry-run")
def migrate_dry_run(mid: str, req: MigrateIn = MigrateIn()) -> dict:
    """The automation a migration would create, what was translated, and what does not translate and why. Changes nothing."""
    m = _monitor(mid)
    out = plan(m, req.condition_function.model_dump() if req.condition_function else None)
    mig = _migration(m)
    if mig:
        out["migrated"] = _public(m)["migration"]
    return out


def _migrate(mid: str, fn: Optional[dict]) -> dict:
    import automate

    with _migrate_lock:
        m = _monitor(mid)
        if _migration(m):
            raise HTTPException(409, f"this monitor was already migrated to Automate (automation {_migration(m)['automation_id']}): undo that migration first")
        p = plan(m, fn)
        if not p["translates"]:
            raise HTTPException(400, "this monitor does not translate to Automate — " + "; ".join(f"{b['feature']}: {b['reason']}" for b in p["untranslatable"]))
        body = p["automation"]
        with _lock:
            # the monitor stops first, then the automation starts: the two never both fire
            m = _monitor(mid)
            was_enabled = bool(m.get("enabled", True))
            m["enabled"] = False
            ontology._put("object-monitors", m)
            try:
                auto = ontology.create_automation(ontology.AutomationIn(**body))
            except Exception:
                m["enabled"] = was_enabled
                ontology._put("object-monitors", m)
                raise
            m["migration"] = {"automation_id": auto["id"], "automation_name": auto["name"], "at": _now(), "by": _who(), "was_enabled": was_enabled,
                              "condition_function": fn, "fingerprint": _fingerprint(ontology._automation(auto["id"]))}
            m["migrated_to"] = auto["id"]
            ontology._put("object-monitors", m)
        automate.history(auto["id"], "migrated", f"created from the object monitor \"{m['name']}\" ({m['rid']})", by=_who())
        return {"automation": auto, "monitor": _public(m), "translated": p["translated"], "notes": p["notes"]}


@router.post("/{mid}/migrate")
def migrate_to_automate(mid: str, req: MigrateIn = MigrateIn()) -> dict:
    """Create the equivalent automation through Automate's own create function (its validation applies), link the two
    and pause the monitor. Refused with the reasons when the monitor does not translate, and when it was migrated already."""
    return _migrate(mid, req.condition_function.model_dump() if req.condition_function else None)


@router.post("/{mid}/migrate/undo")
def undo_migration(mid: str) -> dict:
    """Delete the automation the migration created and resume the monitor (from a fresh baseline: what happened
    meanwhile was the automation's to report). Refused when the automation was edited since — deleting it would
    discard those edits; delete or keep it yourself, then undo."""
    with _migrate_lock:
        m = _monitor(mid)
        mig = _migration(m)
        if not mig:
            raise HTTPException(409, "this monitor was not migrated to Automate")
        aid = mig["automation_id"]
        try:
            auto: Optional[dict] = ontology._automation(aid)
        except HTTPException:
            auto = None
        if auto is not None and mig.get("fingerprint") and _fingerprint(auto) != mig["fingerprint"]:
            raise HTTPException(409, f"the automation \"{auto.get('name')}\" was edited after the migration: undoing would discard those edits. "
                                     "Delete the automation in Automate (or keep it and delete this monitor), then undo.")
        with _lock:
            # the automation goes first, then the monitor resumes
            if auto is not None:
                ontology.delete_automation(aid)
        with _eval_lock(mid):
            # the fresh baseline is recorded while the monitor is still marked migrated, and only then is it resumed:
            # a resumed monitor never sits without a state (a scheduler would evaluate it at once, possibly in another
            # process, and two writers would lose each other's activity)
            _evaluate(mid, True, "resumed", resuming=True)
            with _lock:
                m = _monitor(mid)
                m["enabled"] = bool(mig.get("was_enabled", True))
                m.pop("migration", None)
                m.pop("migrated_to", None)
                ontology._put("object-monitors", m)
    return {"monitor": _public(_monitor(mid)), "automation_deleted": aid if auto is not None else None,
            "note": None if auto is not None else "the automation was already deleted: only the monitor was resumed"}


