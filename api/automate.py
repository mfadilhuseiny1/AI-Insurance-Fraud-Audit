"""Automate (Application Building → Automate): the automation engine behind /api/ontology/automations.

ontology.py keeps the automation records and routes; this module evaluates conditions, runs effects and keeps
history. An automation is {condition, effects, settings}:
- conditions: time (every N minutes, or cron expressions with a time zone; several schedules allowed); object set
  conditions on an object type narrowed by filters — objects added to the set, removed from it (deleted or no longer
  matching), modified in it (optionally only when given properties change), threshold crossed (a property's test
  turns true), run on all objects (on a schedule); automation dependencies (another automation completed, optionally
  only when it succeeded); time series conditions stay in ts_alerting.py.
- condition settings: allow cycles (react to this automation's own edits), skip peering events, evaluation frequency
  (live, or scheduled: events are collected and the effects run every N minutes — a digest), dropped objects (at most N
  objects per execution), queued (sequential) or parallel executions.
- effects (one or more, in order): action, AIP Logic, function, notification (recipients: users and groups, or a
  property holding a user; content with {{object.property}} templates; grouping: once for all objects, once per
  group of a property's value, once per object). Each effect has automatic retries (attempts, backoff) and an optional
  fallback effect (an action or a notification that receives {{error.message}}).
- function-generated object sets (a published function returning an ObjectSet of the condition's type; the filters
  narrow it) and function-backed threshold logic (a function returning a boolean): both are evaluated on a schedule
  (poll_minutes), against the membership / value seen at the previous evaluation;
- effect execution modes for action, Logic and function effects: once per object, once for all objects, once per
  batch (batch_size) or once per group (group_by properties); the group reaches the effect as {{objects.set}} /
  {{objects.primary_keys}} or an objects input;
- notification content from a function (returning a Notification, or None to skip; a Recipient input and the
  condition's objects), and attachments: Notepad documents, Notepad templates generated with the condition's objects,
  and Contour analyses, rendered to PDF (or an inline image) with headless Chrome and attached to the email;
- settings: expiration (the automation pauses itself), administrators (who may edit), owner (effects run as the owner),
  per-user muting of notifications, muting for everyone (by hand, optionally until a time, or auto-mute: when every
  effect failed in at least 80% of the last 30 executions).
Every execution is a run (with each effect's status, attempts and edits); history records the events around it
(triggered, effect failed, retried, fallback, paused, expired, edited). Failed runs can be retried by hand, and manual
executions run on chosen objects or the whole object set.
"""

from __future__ import annotations

import contextvars
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

log = logging.getLogger("bluesandai.automate")
router = APIRouter(prefix="/api/automate", tags=["automate"])
OBJECT_KINDS = ("objects_added", "objects_removed", "objects_modified", "threshold", "run_on_all")
KINDS = ("schedule", "automation_completed", *OBJECT_KINDS)
EFFECTS = ("action", "logic", "function", "notification", "none")
OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "contains", "is_empty", "not_empty")
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="automate")
_seq_locks: dict[str, threading.Lock] = {}
_batch: dict[str, list[dict]] = {}
_batch_lock = threading.Lock()
_last_tick: dict[str, datetime] = {}
_depth: contextvars.ContextVar[int] = contextvars.ContextVar("automate_depth", default=0)


def _o():
    import ontology

    return ontology


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: Optional[datetime] = None) -> str:
    return (d or _now()).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# records
# ------------------------------------------------------------------------------------------------


def normalize(rec: dict) -> dict:
    """effects (a list) is the source of truth; effect stays as the first one for older readers."""
    effects = rec.get("effects")
    if not isinstance(effects, list) or not effects:
        effects = [rec.get("effect") or {"kind": "none"}]
    rec["effects"] = effects
    rec["effect"] = effects[0]
    s = rec.setdefault("settings", {})
    s.setdefault("administrators", [])
    s.setdefault("expires_at", None)
    s.setdefault("execution", "parallel")
    rec.setdefault("muted_by", [])
    return rec


def _filter_ok(f: dict, props: dict) -> bool:
    v = props.get(f.get("property"))
    op, target = f.get("op") or "eq", f.get("value")
    if op == "is_empty":
        return v in (None, "", [])
    if op == "not_empty":
        return v not in (None, "", [])
    if op == "contains":
        return str(target or "").lower() in str(v or "").lower()
    try:
        a, b = float(v), float(target)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        a, b = str(v), str(target)  # type: ignore[assignment]
        if v is None:
            return op == "neq"
    return {"eq": a == b, "neq": a != b, "gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}.get(op, False)  # type: ignore[operator]


def _derived_specs(c: dict) -> list:
    import ontology_search

    return [ontology_search.DerivedProperty(**d) for d in c.get("derived") or []]


def with_derived(c: dict, pk: Any, props: Optional[dict]) -> Optional[dict]:
    """The object's properties plus the condition's derived properties (aggregates over its linked objects, computed
    from its current links), so filters and thresholds can use them."""
    if props is None or not c.get("derived"):
        return props
    import ontology_search

    t = _o()._object_type(c["object_type_id"])
    rows = [{"primary_key": str(pk), "properties": dict(props)}]
    ontology_search.apply_derived(t, rows, _derived_specs(c))
    return rows[0]["properties"]


def rows_with_derived(c: dict, rows: dict) -> dict[str, dict]:
    """{primary key: properties} of stored objects, with the condition's derived properties (one pass)."""
    out = {pk: dict(r.get("properties") or {}) for pk, r in rows.items()}
    if not c.get("derived") or not out:
        return out
    import ontology_search

    t = _o()._object_type(c["object_type_id"])
    lst = [{"primary_key": pk, "properties": props} for pk, props in out.items()]
    ontology_search.apply_derived(t, lst, _derived_specs(c))
    return {x["primary_key"]: x["properties"] for x in lst}


def in_set(c: dict, props: Optional[dict]) -> bool:
    if props is None:
        return False
    return all(_filter_ok(f, props) for f in c.get("filters") or [])


# ------------------------------------------------------------------------------------------------
# function-generated object sets and function-backed logic
# ------------------------------------------------------------------------------------------------


def fn_value(spec: dict, inputs: dict) -> Any:
    """Run a published function ({function_id, version}) with inputs: its value, or an error."""
    res = _o()._hook("run_function", spec["function_id"], spec.get("version"), inputs)
    if not res or not res.get("ok"):
        raise RuntimeError(str((res or {}).get("error") or "the function failed"))
    return res.get("value")


def member_pks(v: Any, tid: str) -> list[str]:
    """The primary keys of a function's ObjectSet (or object list) value, of the condition's object type."""
    if isinstance(v, dict) and isinstance(v.get("__object_set__"), dict):
        v = v["__object_set__"]
    if isinstance(v, dict) and "primary_keys" in v:
        if v.get("object_type_id") and v["object_type_id"] != tid:
            raise RuntimeError("the function returned an object set of another object type")
        return [str(x) for x in v.get("primary_keys") or []]
    if isinstance(v, list):
        out = []
        for x in v:
            x = x.get("__object__", x) if isinstance(x, dict) else x
            if isinstance(x, dict):
                if x.get("object_type_id") and x["object_type_id"] != tid:
                    raise RuntimeError("the function returned objects of another object type")
                out.append(str(x.get("primary_key")))
            else:
                out.append(str(x))
        return out
    raise RuntimeError("the function did not return an object set")


def polled(c: dict) -> bool:
    """Function-generated sets and function-backed thresholds are evaluated on a schedule, not on each edit."""
    return (c.get("object_source") or {}).get("kind") == "function" or bool((c.get("threshold") or {}).get("function"))


def set_members(c: dict, source: Optional[dict] = None) -> dict[str, dict]:
    """The condition's object set now, {primary key: properties with derived properties}: a function-generated set (or
    `source`, a manual execution's function) narrowed by the filters, else the filters on the object type."""
    o = _o()
    rows = o._objects(c["object_type_id"])
    src = source or c.get("object_source") or {}
    if src.get("kind") == "function":
        keep = set(member_pks(fn_value(src, dict(src.get("inputs") or {})), c["object_type_id"]))
        rows = {pk: r for pk, r in rows.items() if str(pk) in keep}
    return {pk: props for pk, props in rows_with_derived(c, rows).items() if in_set(c, props)}


def _object_set_value(c: dict, pks: list[str]) -> dict:
    return {"object_type_id": c.get("object_type_id"), "primary_keys": [str(x) for x in pks]}


def check(rec: dict) -> None:
    """Validate a (non time series) automation."""
    o = _o()
    normalize(rec)
    c = rec["condition"]
    k = c.get("kind")
    if k not in KINDS:
        raise HTTPException(400, "pick a condition")
    th_fn = (c.get("threshold") or {}).get("function") if k == "threshold" else None
    if th_fn:
        if not th_fn.get("function_id"):
            raise HTTPException(400, "function-backed logic: pick the function returning a boolean")
        o._hook("check_function_ref", th_fn["function_id"], th_fn.get("version"))
    src = c.get("object_source") or {}
    if src.get("kind") == "function":
        if k not in OBJECT_KINDS:
            raise HTTPException(400, "a function-generated object set belongs to an object set condition")
        if not src.get("function_id"):
            raise HTTPException(400, "function-generated object set: pick the function returning the object set")
        o._hook("check_function_ref", src["function_id"], src.get("version"))
    if polled(c) and int(c.get("poll_minutes") or 5) < 1:
        raise HTTPException(400, "function-backed conditions are evaluated every N minutes (N ≥ 1)")
    if k in OBJECT_KINDS and not (th_fn and not c.get("object_type_id")):
        t = o._object_type(c.get("object_type_id") or "")
        names = {p["api_name"] for p in t["properties"]}
        if c.get("derived"):
            import ontology_search

            try:
                specs = _derived_specs(c)
            except Exception as e:  # noqa: BLE001 — a malformed definition
                raise HTTPException(400, f"derived property: {e}") from None
            ontology_search.derived_definitions(t, specs)
            names |= {s.api_name for s in specs}
        for f in c.get("filters") or []:
            if f.get("property") not in names or (f.get("op") or "eq") not in OPS:
                raise HTTPException(400, f"filter on an unknown property or operator: {f.get('property')} {f.get('op')}")
        if k == "threshold" and not th_fn:
            th = c.get("threshold") or {}
            if th.get("property") not in names or (th.get("op") or "gt") not in OPS:
                raise HTTPException(400, "a threshold needs a property and an operator")
        for p in c.get("properties") or []:
            if p not in names:
                raise HTTPException(400, f"unknown property {p}")
    if k in ("schedule", "run_on_all"):
        crons = [x for x in c.get("cron") or [] if str(x).strip()]
        if crons:
            for x in crons:
                parse_cron(x)
            if c.get("timezone"):
                _tz(c["timezone"])
        elif int(c.get("every_minutes") or 0) < 1:
            raise HTTPException(400, "a schedule runs every N minutes (N ≥ 1) or on cron expressions")
    if k == "automation_completed":
        dep = c.get("automation_id")
        if not dep or dep == rec.get("id"):
            raise HTTPException(400, "pick another automation to depend on")
        o._automation(dep)
    b = c.get("batch") or {}
    if b.get("mode") == "scheduled" and int(b.get("every_minutes") or 0) < 1:
        raise HTTPException(400, "scheduled evaluation runs every N minutes (N ≥ 1)")
    for i, e in enumerate(rec["effects"]):
        _check_effect(e, c, f"effect {i + 1}")
        fb = e.get("fallback")
        if fb:
            if fb.get("kind") not in ("action", "notification"):
                raise HTTPException(400, f"effect {i + 1}: a fallback is an action or a notification")
            _check_effect(fb, c, f"effect {i + 1} fallback")
    exp = (rec.get("settings") or {}).get("expires_at")
    if exp:
        try:
            datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "expiration is a date and time") from None


def _check_effect(e: dict, c: dict, where: str) -> None:
    o = _o()
    k = e.get("kind")
    if k not in EFFECTS:
        raise HTTPException(400, f"{where}: pick an effect")
    if k == "logic":
        fn = o._logic(e.get("logic_id") or "")
        if c.get("kind") in OBJECT_KINDS and e.get("object_input"):
            inp = next((i for i in fn["inputs"] if i["name"] == e["object_input"]), None)
            if not inp or inp["type"] != "object":
                raise HTTPException(400, f"{where}: pick the Logic input that receives the object")
    elif k == "action":
        o._action_type(e.get("action_type_id") or "")
    elif k == "function":
        if not e.get("function_id"):
            raise HTTPException(400, f"{where}: pick the function to run")
        o._hook("check_function_ref", e["function_id"], e.get("version"))
    elif k == "notification":
        cf = e.get("content") or {}
        if cf.get("kind") == "function":
            if not cf.get("function_id"):
                raise HTTPException(400, f"{where}: pick the function generating the notification")
            o._hook("check_function_ref", cf["function_id"], cf.get("version"))
        for at in e.get("attachments") or []:
            if at.get("kind") not in ("notepad", "notepad_template", "contour") or not at.get("item_id"):
                raise HTTPException(400, f"{where}: an attachment is a Notepad document, a Notepad template or a Contour analysis")
        r = e.get("recipients") or {}
        if not (r.get("principals") or r.get("property")):
            raise HTTPException(400, f"{where}: add recipients (users, groups or a property holding a user)")
        if not str(e.get("subject") or "").strip() and (e.get("content") or {}).get("kind") != "function":
            raise HTTPException(400, f"{where}: a notification needs a subject")
        g = e.get("grouping") or "per_object"
        if g not in ("once", "per_group", "per_object"):
            raise HTTPException(400, f"{where}: grouping is once, per_group or per_object")
        if g == "per_group" and not e.get("group_by"):
            raise HTTPException(400, f"{where}: pick the property to group objects by")
    if k in ("action", "logic", "function"):
        mode = e.get("execution_mode") or "per_object"
        if mode not in ("per_object", "once", "per_batch", "per_group"):
            raise HTTPException(400, f"{where}: the execution mode is per_object, once, per_batch or per_group")
        if mode == "per_batch" and int(e.get("batch_size") or 0) < 1:
            raise HTTPException(400, f"{where}: a batch size of at least 1")
        if mode == "per_group" and not e.get("group_by"):
            raise HTTPException(400, f"{where}: pick the properties to group objects by")
    r = e.get("retries") or {}
    if int(r.get("max") or 0) > 10:
        raise HTTPException(400, f"{where}: at most 10 retries")


# ------------------------------------------------------------------------------------------------
# cron
# ------------------------------------------------------------------------------------------------


def _field(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
        else:
            a = b = int(part)
        if a < lo or b > hi or a > b or step < 1:
            raise ValueError(spec)
        out |= set(range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> tuple:
    parts = str(expr).split()
    if len(parts) != 5:
        raise HTTPException(400, f"a cron expression has 5 fields (minute hour day month weekday): {expr!r}")
    try:
        mi, h, dom, mon, dow = (_field(p, lo, hi) for p, (lo, hi) in zip(parts, [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]))
    except ValueError:
        raise HTTPException(400, f"cannot read the cron expression {expr!r}") from None
    if 7 in dow:
        dow = (dow - {7}) | {0}
    return mi, h, dom, mon, dow, parts[2] == "*", parts[4] == "*"


def _tz(name: Optional[str]):
    if not name:
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:  # noqa: BLE001
        raise HTTPException(400, f"unknown time zone {name!r}") from None


def cron_matches(expr: str, at: datetime, tz: Optional[str] = None) -> bool:
    mi, h, dom, mon, dow, any_dom, any_dow = parse_cron(expr)
    t = at.astimezone(_tz(tz))
    wd = (t.weekday() + 1) % 7
    day = (t.day in dom or wd in dow) if not any_dom and not any_dow else (t.day in dom and wd in dow)
    return t.minute in mi and t.hour in h and t.month in mon and day


def next_runs(c: dict, n: int = 5) -> list[str]:
    out = []
    t = _now().replace(second=0, microsecond=0) + timedelta(minutes=1)
    crons = [x for x in c.get("cron") or [] if str(x).strip()]
    if not crons:
        every = int(c.get("every_minutes") or 60)
        return [_iso(t + timedelta(minutes=every * i)) for i in range(n)]
    for _ in range(60 * 24 * 60):
        if any(cron_matches(x, t, c.get("timezone")) for x in crons):
            out.append(_iso(t))
            if len(out) >= n:
                break
        t += timedelta(minutes=1)
    return out


# ------------------------------------------------------------------------------------------------
# condition evaluation
# ------------------------------------------------------------------------------------------------


def _active(a: dict) -> bool:
    if not a.get("enabled"):
        return False
    exp = (a.get("settings") or {}).get("expires_at")
    if exp:
        try:
            if datetime.fromisoformat(str(exp).replace("Z", "+00:00")) <= _now():
                return False
        except ValueError:
            pass
    return True


def matches(c: dict, ev: dict) -> bool:
    """Does an edit event {kind: created|modified|deleted, object_type_id, pk, before, after} meet an object set condition?"""
    k = c.get("kind")
    if c.get("object_type_id") != ev["object_type_id"]:
        return False
    before, after = with_derived(c, ev.get("pk"), ev.get("before")), with_derived(c, ev.get("pk"), ev.get("after"))
    was, now = in_set(c, before), in_set(c, after)
    if k == "objects_added":
        return now and (ev["kind"] == "created" or not was)
    if k == "objects_removed":
        return was and (ev["kind"] == "deleted" or not now)
    if k == "objects_modified":
        if not (ev["kind"] == "modified" and was and now):
            return False
        props = c.get("properties") or []
        return not props or any((before or {}).get(p) != (after or {}).get(p) for p in props)
    if k == "threshold":
        th = c.get("threshold") or {}
        test = {"property": th.get("property"), "op": th.get("op") or "gt", "value": th.get("value")}
        hit_before = before is not None and _filter_ok(test, before)
        return now and after is not None and _filter_ok(test, after) and not hit_before
    return False


def fire(events: list[dict], source: Optional[str], depth: int) -> None:
    """Edit events from ontology.apply_edits → the automations they trigger (live, or into a scheduled batch)."""
    if not events:
        return
    o = _o()
    peering = bool(source and str(source).startswith("peering:"))
    for a in o._all("automations"):
        normalize(a)
        c = a.get("condition") or {}
        if not _active(a) or c.get("kind") not in ("objects_added", "objects_removed", "objects_modified", "threshold") or polled(c):
            continue
        if a["id"] == source and not c.get("allow_cycles"):
            continue
        if peering and c.get("skip_peering_events"):
            continue
        hits = [ev for ev in events if matches(c, ev)]
        if not hits:
            continue
        objs = [{"primary_key": ev["pk"], "properties": ev.get("after") or ev.get("before") or {}, "event": ev["kind"]} for ev in hits]
        if (c.get("batch") or {}).get("mode") == "scheduled":
            with _batch_lock:
                _batch.setdefault(a["id"], []).extend(objs)
            continue
        _submit(a, objs, c["kind"], depth + 1)


def _submit(a: dict, objs: Optional[list[dict]], trigger: str, depth: int) -> None:
    def job() -> None:
        try:
            execute(a, objs, trigger, depth)
        except Exception:  # noqa: BLE001
            log.exception("automation %s failed", a["id"])

    _pool.submit(job)


# ------------------------------------------------------------------------------------------------
# execution
# ------------------------------------------------------------------------------------------------


def _owner(a: dict) -> Optional[dict]:
    uid = a.get("owner") or a.get("created_by")
    if not uid or not str(uid).startswith("u-"):
        return None
    try:
        u = auth._user(uid)
    except HTTPException:
        return None
    if u.get("disabled"):
        return None
    return {**auth._public_user(u), "markings": auth.user_markings(u), "service": False}


def _owner_blocked(a: dict, who: Optional[dict], tid: Optional[str] = None) -> Optional[str]:
    """Why the automation cannot run as its owner now (None: it can). Sign-in on: the owner must exist and be active,
    and see the object type its condition watches (its markings and ontology roles) — checked as the owner."""
    if not auth.enabled():
        return None
    uid = a.get("owner") or a.get("created_by")
    if who is None:
        import run_as

        try:
            run_as.owner_principal(uid if uid and str(uid).startswith("u-") else None, "the automation")
        except run_as.OwnerUnavailable as e:
            return str(e)
        return "the automation's owner cannot be acted for: an editor must take it over (edit and save it)"
    if tid:
        token = auth._principal.set(who)
        try:
            _o()._object_type(tid)
        except HTTPException as e:
            name = (auth.user_label(who.get("id")) or {}).get("display_name") or who.get("username") or "its owner"
            return f"the automation's owner {name} can no longer see the object type it watches ({e.detail})"
        finally:
            auth._principal.reset(token)
    return None


def _evaluate_as_owner(a: dict, fn: Any, *args: Any) -> Any:
    """Evaluate a condition (its object set, a function) with the owner's access ("automation evaluation uses the
    permissions of the owner"); RuntimeError when it cannot run as the owner."""
    who = _owner(a)
    c = a.get("condition") or {}
    blocked = _owner_blocked(a, who, c.get("object_type_id"))
    if blocked:
        raise RuntimeError(blocked)
    token = auth._principal.set(who) if who else None
    try:
        return fn(*args)
    finally:
        if token is not None:
            auth._principal.reset(token)


def history(aid: str, kind: str, detail: str = "", **extra: Any) -> None:
    o = _o()
    p = o.DIR / "runs" / f"{aid}.history.json"
    with o._lock:
        h = o._read(p, [])
        h.insert(0, {"at": _iso(), "kind": kind, "detail": detail[:1000], **extra})
        o._write(p, h[:1000])


def get_history(aid: str) -> list[dict]:
    o = _o()
    return o._read(o.DIR / "runs" / f"{aid}.history.json", [])


def _public(tid: str, pk: str) -> Optional[dict]:
    o = _o()
    try:
        t = o._object_type(tid)
        key, obj = o._find(t, pk)
        return o._public_object(t, key, obj)
    except HTTPException:
        return None


def _owner_saw_deleted(tid: str, pk: str, props: dict) -> Optional[dict]:
    """A deleted object (no longer stored) the current principal could see in its last state: that state as the
    principal sees it (property security policies applied), marked deleted; None when it is still stored or the
    principal could not see it (no leak of objects the owner never saw)."""
    o = _o()
    try:
        t = o._object_type(tid)
    except HTTPException:
        return None
    last = {"properties": dict(props or {})}
    if pk in o._objects(tid) or not o._can_see(t, last):
        return None
    try:
        out = o._public_object(t, pk, last)
    except Exception:  # noqa: BLE001 - derived values of a deleted object may not resolve: the stored ones then
        out = o._public_object({**t, "properties": [p for p in t["properties"] if not (p.get("derived") or p.get("reducers"))]}, pk, last)
    return {**out, "deleted": True}


def execute(a: dict, objs: Optional[list[dict]], trigger: str, depth: int, only_effects: Optional[list[int]] = None) -> dict:
    """One execution: every effect (or the chosen ones) on the objects (None for time conditions), with retries and fallbacks."""
    normalize(a)
    o = _o()
    c = a["condition"]
    started = time.monotonic()
    tid = c.get("alert_object_type_id") if c.get("kind") == "time_series" else c.get("object_type_id")
    max_objs = int(c.get("max_objects") or 0)
    dropped = 0
    if objs is not None and max_objs and len(objs) > max_objs:
        dropped = len(objs) - max_objs
        objs = objs[:max_objs]
    pks = [str(x["primary_key"]) for x in objs] if objs is not None else None
    run: dict[str, Any] = {"id": o._new_id("run"), "at": _iso(), "trigger": trigger, "primary_key": pks[0] if pks and len(pks) == 1 else None,
                           "primary_keys": pks, "status": "succeeded", "error": None, "edits": 0, "effects": [], "dropped": dropped}
    # muted for everyone: the condition still evaluates and the execution is recorded, but no effect runs (manual
    # executions still do); a mute with an end time lifts itself
    m = a.get("muted")
    if m and m.get("until"):
        try:
            if datetime.fromisoformat(str(m["until"]).replace("Z", "+00:00")) <= _now():
                _set_muted(a["id"], None, "the mute period ended")
                m = None
        except ValueError:
            pass
    if m and trigger != "manual":
        run.update(status="muted", ms=0)
        o._record_run(a["id"], run)
        return run
    # effects run on behalf of the owner (Foundry: "an action will no longer run if the associated user account is
    # disabled or deleted"): never as the system when sign-in is on
    who = _owner(a)
    blocked = _owner_blocked(a, who, tid)
    if blocked:
        run.update(status="failed", error=f"did not run: {blocked}", ms=0, owner=a.get("owner") or a.get("created_by"))
        o._record_run(a["id"], run)
        history(a["id"], "execution_failed", run["error"], run_id=run["id"])
        return run
    token = auth._principal.set(who) if who else None
    lock = _seq_locks.setdefault(a["id"], threading.Lock()) if (a.get("settings") or {}).get("execution") == "sequential" else None
    if lock:
        lock.acquire()
    try:
        full = [p for p in (_public(tid, pk) for pk in pks) if p] if pks is not None and tid else []
        # deleted objects (objects_removed by a deletion) no longer exist: judged by their last state as the owner
        # (control properties, security policies) and handed to the effects with their last known values
        # ({{object.x}} templates, recipients by property), "deleted": true; ones the owner could not see are left out
        stored = {f["primary_key"] for f in full}
        gone = [g for g in (_owner_saw_deleted(tid, str(x["primary_key"]), x.get("properties") or {})
                            for x in objs if x.get("event") == "deleted" and str(x["primary_key"]) not in stored) if g] if pks is not None and tid else []
        gone = list({g["primary_key"]: g for g in gone}.values())
        full = full + gone
        if gone:
            run["deleted"] = [g["primary_key"] for g in gone]
        if pks is not None and tid and len(full) < len(pks):
            # objects the owner cannot see (control properties, security policies): left out, and said so
            run["hidden"] = len(pks) - len(full)
            run["primary_keys"] = [x["primary_key"] for x in full]
            run["primary_key"] = run["primary_keys"][0] if len(run["primary_keys"]) == 1 else None
            history(a["id"], "objects_hidden", f"{run['hidden']} of {len(pks)} objects are not visible to the automation's owner: left out",
                    run_id=run["id"])
            if not full:
                run.update(status="skipped", error=f"none of the {len(pks)} objects is visible to the automation's owner")
        for i, e in enumerate(a["effects"] if not (pks and not full and tid) else []):
            if only_effects is not None and i not in only_effects:
                continue
            res = _run_effect(a, e, full if pks is not None else None, depth, run)
            run["effects"].append(res)
            run["edits"] += res.get("edits", 0)
            if res.get("logic_run_id"):
                run["logic_run_id"] = res["logic_run_id"]
            if res["status"] == "failed":
                run["status"] = "failed"
                run["error"] = res.get("error")
                if not e.get("continue_on_failure"):
                    break
        if not a["effects"] or all(r["status"] == "skipped" for r in run["effects"]):
            run["status"] = "skipped" if a["effects"] and a["effects"][0].get("kind") == "none" else run["status"]
    finally:
        if lock:
            lock.release()
        if token is not None:
            auth._principal.reset(token)
    run["ms"] = int((time.monotonic() - started) * 1000)
    o._record_run(a["id"], run)
    if (a.get("settings") or {}).get("auto_mute") and run["status"] == "failed":
        _auto_mute(a)
    if dropped:
        history(a["id"], "objects_dropped", f"{dropped} objects over the limit of {max_objs} were dropped", run_id=run["id"])
    if run["status"] == "failed":
        history(a["id"], "execution_failed", run.get("error") or "", run_id=run["id"])
    # automation dependencies
    if depth < o.MAX_DEPTH:
        for d in o._all("automations"):
            dc = d.get("condition") or {}
            if dc.get("kind") == "automation_completed" and dc.get("automation_id") == a["id"] and _active(d):
                if run["status"] == "succeeded" or not dc.get("only_success"):
                    _submit(normalize(d), objs if dc.get("pass_objects") else None, f"after {a['name']}", depth + 1)
    return run


def _set_muted(aid: str, muted: Optional[dict], detail: str, by: str = "system") -> None:
    o = _o()
    with o._lock:
        cur = o._automation(aid)
        cur["muted"] = muted
        o._put("automations", cur)
    history(aid, "muted" if muted else "unmuted", detail, by=by)


def _auto_mute(a: dict) -> None:
    """Auto-mute: every effect failed in at least 80% of the last 30 executions (10 at least, to judge)."""
    o = _o()
    runs = [r for r in o._read(o.DIR / "runs" / f"{a['id']}.json", []) if r.get("status") != "muted"][:30]
    if len(runs) < 10:
        return
    bad = sum(1 for r in runs if r.get("effects") and all(x.get("status") == "failed" for x in r["effects"]))
    if bad / len(runs) >= 0.8 and not o._automation(a["id"]).get("muted"):
        _set_muted(a["id"], {"by": "system", "at": _iso(), "reason": f"every effect failed in {bad} of the last {len(runs)} executions"},
                   f"auto-muted: every effect failed in {bad} of the last {len(runs)} executions")


def _run_effect(a: dict, e: dict, objs: Optional[list[dict]], depth: int, run: dict) -> dict:
    retries = e.get("retries") or {}
    attempts = max(1, int(retries.get("max") or 0) + 1)
    backoff = float(retries.get("backoff_seconds") or 2)
    out: dict[str, Any] = {"kind": e.get("kind"), "status": "succeeded", "attempts": 0, "edits": 0, "error": None}
    for n in range(attempts):
        out["attempts"] = n + 1
        try:
            out.update(_effect_once(a, e, objs, depth, run))
            out["status"], out["error"] = out.get("status") if out.get("status") == "skipped" else "succeeded", None
            break
        except Exception as ex:  # noqa: BLE001
            out["status"], out["error"] = "failed", str(getattr(ex, "detail", None) or ex)[:500]
            if n + 1 < attempts:
                history(a["id"], "effect_retried", f"{e.get('kind')}: {out['error']} (attempt {n + 1} of {attempts})", run_id=run["id"])
                time.sleep(min(60.0, backoff * (2 ** n)))
    if out["status"] == "failed" and e.get("fallback"):
        try:
            fb = _effect_once(a, e["fallback"], objs, depth, run, error=out["error"])
            out["fallback"] = {"kind": e["fallback"].get("kind"), "status": "succeeded", **{k: v for k, v in fb.items() if k != "status"}}
            history(a["id"], "fallback_ran", f"{e['fallback'].get('kind')} after: {out['error']}", run_id=run["id"])
        except Exception as ex:  # noqa: BLE001
            out["fallback"] = {"kind": e["fallback"].get("kind"), "status": "failed", "error": str(getattr(ex, "detail", None) or ex)[:500]}
    return out


def _ctx(obj: Optional[dict], objs: Optional[list[dict]], error: Optional[str]):
    o = _o()
    ctx = o._Ctx()
    ctx.vars["object"] = obj
    pks = [str(x["primary_key"]) for x in objs or []]
    tid = next((x.get("object_type_id") for x in objs or [] if x.get("object_type_id")), None)
    ctx.vars["objects"] = {"count": len(objs or []), "titles": ", ".join(str(x.get("title") or x["primary_key"]) for x in (objs or [])[:50]),
                           "primary_keys": pks, "set": {"object_type_id": tid, "primary_keys": pks}}
    ctx.vars["error"] = {"message": error or ""}
    ctx.vars["now"] = _iso()
    return ctx


def _effect_once(a: dict, e: dict, objs: Optional[list[dict]], depth: int, run: dict, error: Optional[str] = None) -> dict:
    o = _o()
    k = e.get("kind")
    targets: list[Optional[dict]] = list(objs) if objs is not None else [None]
    if k == "none":
        return {"status": "skipped"}
    if k == "notification":
        return _notify(a, e, objs, error)
    edits = 0
    logic_run = None
    groups = _groups(e, objs, targets)
    for obj, group in groups:
        pks = [str(x["primary_key"]) for x in group or []]
        if k == "logic":
            inputs = dict(e.get("inputs") or {})
            if obj and e.get("object_input") and len(group or []) <= 1:
                inputs[e["object_input"]] = obj["primary_key"]
            if group and e.get("objects_input"):
                inputs[e["objects_input"]] = pks
            res = o.run_logic(e["logic_id"], inputs, bool(e.get("apply_edits", True)), source=a["id"], depth=depth,
                              trigger={"automation_id": a["id"], "automation": a["name"]})
            if res.get("status") == "failed":
                raise RuntimeError(res.get("error") or "the Logic function failed")
            edits += len(res.get("applied") or [])
            logic_run = res.get("id")
        elif k == "action":
            ctx = _ctx(obj, group if group is not None else objs, error)
            values = {pid: _value(ctx, x) for pid, x in (e.get("parameters") or {}).items()}
            edits += len(o.run_action(o._action_type(e["action_type_id"]), values, a["id"], depth))
        elif k == "function":
            inputs = dict(e.get("inputs") or {})
            if obj and e.get("object_input") and len(group or []) <= 1:
                inputs[e["object_input"]] = {"object_type_id": obj["object_type_id"], "primary_key": obj["primary_key"]}
            if group and e.get("objects_input"):
                info = o._hook("function_info", e["function_id"], e.get("version")) or {}
                typ = next((i["type"] for i in info.get("inputs") or [] if i["name"] == e["objects_input"]), "")
                inputs[e["objects_input"]] = ([{"object_type_id": x["object_type_id"], "primary_key": x["primary_key"]} for x in group]
                                              if str(typ).startswith("array<") else {"object_type_id": group[0].get("object_type_id"), "primary_keys": pks})
            res = o._hook("run_function", e["function_id"], e.get("version"), inputs)
            if not res or not res.get("ok"):
                raise RuntimeError((res or {}).get("error") or "the function failed")
    return {"edits": edits, "executions": len(groups), **({"logic_run_id": logic_run} if logic_run else {})}


def _groups(e: dict, objs: Optional[list[dict]], targets: list[Optional[dict]]) -> list[tuple[Optional[dict], Optional[list[dict]]]]:
    """The executions of an action / Logic / function effect: (the first object, the objects) for each — once per
    object, once for all, once per batch of batch_size, or once per group of the group_by properties' values."""
    mode = e.get("execution_mode") or "per_object"
    if objs is None:
        return [(None, None)]
    if not objs:
        return []
    if mode == "once":
        return [(objs[0], objs)]
    if mode == "per_batch":
        n = max(1, int(e.get("batch_size") or 100))
        return [(objs[i], objs[i:i + n]) for i in range(0, len(objs), n)]
    if mode == "per_group":
        keys = e.get("group_by") or []
        keys = [keys] if isinstance(keys, str) else keys
        by: dict[str, list[dict]] = {}
        for x in objs:
            by.setdefault(repr([(x.get("properties") or {}).get(k) for k in keys]), []).append(x)
        return [(g[0], g) for g in by.values()]
    return [(x, [x]) for x in targets]


def _value(ctx: Any, x: Any) -> Any:
    if isinstance(x, str) and "{{" in x:
        m = re.fullmatch(r"\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}", x.strip())
        return ctx.lookup(m.group(1)) if m else ctx.template(x)
    return ctx.expr(x)


def _recipients(e: dict, objs: list[dict]) -> set[str]:
    r = e.get("recipients") or {}
    out: set[str] = set()
    groups = {g["id"]: g for g in auth._groups()}
    users = auth._users()
    for p in r.get("principals") or []:
        kind, _, pid = str(p).partition(":")
        if kind == "user":
            out.add(pid)
        elif kind == "group" and pid in groups:
            out |= auth.group_members(groups[pid])
    if r.get("property"):
        for obj in objs:
            v = str((obj.get("properties") or {}).get(r["property"]) or "").strip()
            if not v:
                continue
            u = next((u for u in users if v in (u["id"], u.get("username"), u.get("email"))), None)
            if u:
                out.add(u["id"])
    return out


def _notify(a: dict, e: dict, objs: Optional[list[dict]], error: Optional[str]) -> dict:
    import notify

    objs = objs or []
    grouping = e.get("grouping") or ("per_object" if objs else "once")
    if not objs:
        batches: list[tuple[Optional[dict], list[dict]]] = [(None, [])]
    elif grouping == "once":
        batches = [(objs[0], objs)]
    elif grouping == "per_group":
        by: dict[str, list[dict]] = {}
        for x in objs:
            by.setdefault(str((x.get("properties") or {}).get(e.get("group_by")) or ""), []).append(x)
        batches = [(g[0], g) for g in by.values()]
    else:
        batches = [(x, [x]) for x in objs]
    sent, skipped, muted = 0, 0, set(a.get("muted_by") or [])
    cf = e.get("content") if (e.get("content") or {}).get("kind") == "function" else None
    files = 0
    for first, group in batches:
        ctx = _ctx(first, group, error)
        ctx.vars["group"] = {"value": (first or {}).get("properties", {}).get(e.get("group_by")) if first else None, "count": len(group)}
        subject, body = ctx.template(e.get("subject") or ""), ctx.template(e.get("body") or "")
        if len(group) > 1 and not e.get("body"):
            body = "\n".join(f"- {x.get('title') or x['primary_key']}" for x in group[:200])
        link = f"/ontology/objects/{first['object_type_id']}/{first['primary_key']}" if first and len(group) == 1 and not first.get("deleted") else f"/automate/{a['id']}"
        recipients = [u for u in _recipients(e, group if group else []) if u not in muted]
        # attachments: rendered once per message group (templates take the group's objects), only for email
        atts, att_links = _attachments(a, e, first, group) if recipients and e.get("attachments") and e.get("email") else ([], [])
        files += len(atts)
        for uid in recipients:
            web_s, web_b, mail_s, mail_b, web_link = subject, body, subject, body, link
            if cf:
                v = _content_value(cf, uid, first, group)
                if v is None:
                    skipped += 1
                    continue
                pn, em = v.get("platform_notification") or {}, v.get("email_notification") or {}
                web_s, web_b = str(pn.get("heading") or em.get("subject") or subject), str(pn.get("content") or em.get("body") or body)
                mail_s, mail_b = str(em.get("subject") or web_s), str(em.get("body") or web_b)
                links = [x for x in pn.get("links") or [] if isinstance(x, dict) and str(x.get("url") or "").startswith("/")]
                if links:
                    web_link = links[0]["url"]
            extra = "".join(f"\n\nAttachment: {u}" for u in att_links)
            notify.deliver(uid, web_s, web_b + extra, link=web_link, link_label="Open", source=f"automation:{a['id']}", email=False)
            if e.get("email"):
                html = None
                inline = [x for x in atts if len(x) > 3 and x[3]]
                if inline:
                    import mailer

                    html = mailer.html_message(mail_s, [mail_b], ("Open", auth.web_url() + web_link)).replace(
                        "</body>", "".join(f'<p><img src="cid:{x[3]}" alt="{x[0]}" style="max-width:100%"></p>' for x in inline) + "</body>")
                notify.deliver(uid, mail_s, mail_b, link=web_link, link_label="Open", source=f"automation:{a['id']}", web=False, email=True, html=html, attachments=atts or None)
            sent += 1
    return {"notified": sent, "messages": len(batches), **({"skipped": skipped} if cf else {}), **({"attachments": files} if files else {})}


def _content_value(cf: dict, uid: str, first: Optional[dict], group: list[dict]) -> Optional[dict]:
    """A function-generated notification for one recipient: a Notification (dict), or None to skip."""
    o = _o()
    inputs = dict(cf.get("inputs") or {})
    info = o._hook("function_info", cf["function_id"], cf.get("version")) or {}
    types = {i["name"]: str(i["type"]) for i in info.get("inputs") or []}
    if cf.get("recipient_input"):
        inputs[cf["recipient_input"]] = {"id": uid, "kind": "user"} if types.get(cf["recipient_input"]) == "principal" else uid
    if cf.get("objects_input") and group:
        t = types.get(cf["objects_input"], "")
        inputs[cf["objects_input"]] = ([{"object_type_id": x["object_type_id"], "primary_key": x["primary_key"]} for x in group] if t.startswith("array<")
                                       else {"object_type_id": group[0].get("object_type_id"), "primary_keys": [str(x["primary_key"]) for x in group]})
    if cf.get("object_input") and first:
        inputs[cf["object_input"]] = {"object_type_id": first["object_type_id"], "primary_key": first["primary_key"]}
    v = fn_value(cf, inputs)
    if v is None:
        return None
    if not isinstance(v, dict):
        raise RuntimeError("a notification function returns a Notification (or None)")
    return v


def _attachments(a: dict, e: dict, first: Optional[dict], group: list[dict]) -> tuple[list, list[str]]:
    """The notification's attachments as (file name, bytes, mime type[, content id]): Notepad documents, Notepad
    templates generated with the objects ({{objects}} → their primary keys, {{object}} → the first one's), and Contour
    analyses, rendered as the automation's owner; and the links of generated documents."""
    import report_render

    out, links = [], []
    owner = a.get("owner") or a.get("created_by")
    for i, at in enumerate(e.get("attachments") or []):
        kind, item = at["kind"], at["item_id"]
        name = re.sub(r"[^\w .()-]+", "_", str(at.get("file_name") or "attachment")).strip() or "attachment"
        if kind == "notepad_template":
            import notepad

            def val(v: Any) -> Any:
                if v == "{{objects}}":
                    return [str(x["primary_key"]) for x in group]
                if v == "{{object}}":
                    return str(first["primary_key"]) if first else None
                return v

            inputs = {k: val(v) for k, v in (at.get("inputs") or {}).items()}
            doc = notepad.generate(item, notepad.GenerateRequest(inputs=inputs, version=at.get("version"), name=f"{name} {_iso()[:16].replace('T', ' ')}"))
            item = doc.get("id") or (doc.get("item") or {}).get("id")
            links.append(f"/notepad/{item}")
        path = f"/analytics/{item}?embed=1" if kind == "contour" else f"/notepad/{item}?embed=1"
        inline = bool(at.get("inline"))
        data = report_render.render(path, "png" if inline else "pdf", user_id=owner, wait_s=5.0)
        out.append((f"{name}.png", data, "image/png", f"att{i}") if inline else (f"{name}.pdf", data, "application/pdf"))
    return out, links


# ------------------------------------------------------------------------------------------------
# the scheduler: time conditions, run on all objects, scheduled evaluation batches, expiration
# ------------------------------------------------------------------------------------------------


def _due(a: dict, c: dict, now: datetime) -> bool:
    crons = [x for x in c.get("cron") or [] if str(x).strip()]
    if crons:
        minute = now.replace(second=0, microsecond=0)
        if _last_tick.get(a["id"]) == minute:
            return False
        if any(cron_matches(x, minute, c.get("timezone")) for x in crons):
            _last_tick[a["id"]] = minute
            return True
        return False
    o = _o()
    if a["id"] not in _last_tick:
        runs = o._read(o.DIR / "runs" / f"{a['id']}.json", [])
        at = next((r["at"] for r in runs if r.get("trigger") in ("schedule", "run_on_all")), None)
        _last_tick[a["id"]] = datetime.fromisoformat(at) if at else datetime.min.replace(tzinfo=timezone.utc)
    if _last_tick[a["id"]] + timedelta(minutes=int(c.get("every_minutes") or 60)) <= now:
        _last_tick[a["id"]] = now
        return True
    return False


def tick() -> None:
    o = _o()
    now = _now()
    for a in o._all("automations"):
        normalize(a)
        c = a.get("condition") or {}
        exp = (a.get("settings") or {}).get("expires_at")
        if a.get("enabled") and exp:
            try:
                if datetime.fromisoformat(str(exp).replace("Z", "+00:00")) <= now:
                    with o._lock:
                        cur = o._automation(a["id"])
                        cur["enabled"] = False
                        cur["expired"] = True
                        o._put("automations", cur)
                    history(a["id"], "expired", f"expired at {exp}: paused")
                    continue
            except ValueError:
                pass
        if not _active(a):
            continue
        k = c.get("kind")
        if k == "schedule" and _due(a, c, now):
            _submit(a, None, "schedule", 1)
        elif k == "run_on_all" and _due(a, c, now):
            def all_job(a: dict = a, c: dict = c) -> None:
                try:
                    objs = [{"primary_key": pk, "properties": props} for pk, props in _evaluate_as_owner(a, set_members, c).items()]
                except Exception as ex:  # noqa: BLE001 - the function failed: recorded, tried at the next run
                    history(a["id"], "evaluation_failed", str(getattr(ex, "detail", None) or ex))
                    _record_failed(a, "run_on_all", f"evaluation failed: {getattr(ex, 'detail', None) or ex}")
                    return
                execute(a, objs, "run_on_all", 1)

            _pool.submit(all_job)
        elif k in OBJECT_KINDS and polled(c):
            key = f"poll:{a['id']}"
            last = _last_tick.get(key)
            if last is None or last + timedelta(minutes=int(c.get("poll_minutes") or 5)) <= now:
                _last_tick[key] = now
                _pool.submit(poll, a)
        b = c.get("batch") or {}
        if b.get("mode") == "scheduled" and k in OBJECT_KINDS:
            key = f"batch:{a['id']}"
            last = _last_tick.get(key)
            if last is None:
                _last_tick[key] = now
            elif last + timedelta(minutes=int(b.get("every_minutes") or 60)) <= now:
                _last_tick[key] = now
                with _batch_lock:
                    objs = _batch.pop(a["id"], [])
                if objs:
                    seen: dict[str, dict] = {}
                    for x in objs:
                        seen[str(x["primary_key"])] = x
                    _submit(a, list(seen.values()), "scheduled evaluation", 1)


def _record_failed(a: dict, trigger: str, error: str) -> None:
    """A run that failed before any effect (its condition could not be evaluated as the owner), in the run list."""
    o = _o()
    last = next(iter(o._read(o.DIR / "runs" / f"{a['id']}.json", [])), None)
    if last and last.get("status") == "failed" and last.get("error") == error[:1000] and last.get("trigger") == trigger:
        return  # the same failure as the last evaluation: recorded once, not every poll
    o._record_run(a["id"], {"id": o._new_id("run"), "at": _iso(), "trigger": trigger, "primary_key": None, "primary_keys": None,
                            "status": "failed", "error": error[:1000], "edits": 0, "effects": [], "dropped": 0, "ms": 0})


def _poll_path(aid: str):
    return _o().DIR / "runs" / f"{aid}.poll.json"


def poll(a: dict) -> dict:
    """One evaluation of a function-backed condition against the previous one, as the automation's owner (a failure to
    run as them is recorded as a failed run). A function-generated set: objects that entered it, left it, changed in
    it or crossed the threshold; a function-backed threshold: its boolean changed (the effects run on every change,
    in either direction). The first evaluation only records the state."""
    try:
        return _evaluate_as_owner(a, _poll, a)
    except RuntimeError as ex:  # the owner cannot be acted for (_poll records its own evaluation failures)
        history(a["id"], "evaluation_failed", str(ex)[:500])
        _record_failed(a, f"{(a.get('condition') or {}).get('kind')} (function-generated set)", f"evaluation failed: {ex}")
        return {"error": str(ex)}


def _poll(a: dict) -> dict:
    o = _o()
    c = a.get("condition") or {}
    k = c.get("kind")
    path = _poll_path(a["id"])
    prev = o._read(path, None)
    import json as _json

    # an edited condition starts again from a fresh baseline
    sig = _json.dumps({k: c.get(k) for k in ("kind", "object_type_id", "object_source", "filters", "derived", "threshold", "properties")}, sort_keys=True, default=str)
    if prev is not None and prev.get("sig") != sig:
        prev = None
    try:
        th_fn = (c.get("threshold") or {}).get("function") if k == "threshold" else None
        if th_fn:
            inputs = dict(th_fn.get("inputs") or {})
            if th_fn.get("objects_input") and c.get("object_type_id"):
                inputs[th_fn["objects_input"]] = _object_set_value(c, list(set_members(c)))
            v = fn_value(th_fn, inputs)
            if not isinstance(v, bool):
                raise RuntimeError("function-backed logic returns a boolean")
            state = {"value": v, "at": _iso(), "sig": sig}
            o._write(path, state)
            if prev is None or "value" not in prev:
                history(a["id"], "evaluated", f"first evaluation: {v}")
                return {"baseline": True, "value": v}
            if prev["value"] == v:
                return {"changed": False, "value": v}
            history(a["id"], "threshold_crossed", f"{prev['value']} → {v}")
            if v or not th_fn.get("only_when_true"):
                execute(a, None, f"threshold crossed ({str(v).lower()})", 1)
            return {"changed": True, "value": v}
        now = set_members(c)
    except Exception as ex:  # noqa: BLE001 - recorded; the next evaluation tries again
        history(a["id"], "evaluation_failed", str(ex)[:500])
        return {"error": str(ex)}
    cur = {str(pk): props for pk, props in now.items()}
    o._write(path, {"members": cur if len(cur) <= 20000 else {pk: {} for pk in cur}, "at": _iso(), "sig": sig})
    if prev is None or "members" not in prev:
        history(a["id"], "evaluated", f"first evaluation: {len(cur)} objects in the set")
        return {"baseline": True, "members": len(cur)}
    before = prev["members"]
    hits: list[dict] = []
    if k == "objects_added":
        hits = [{"primary_key": pk, "properties": p, "event": "added"} for pk, p in cur.items() if pk not in before]
    elif k == "objects_removed":
        hits = [{"primary_key": pk, "properties": p, "event": "removed"} for pk, p in before.items() if pk not in cur]
    elif k == "objects_modified":
        props = c.get("properties") or []
        hits = [{"primary_key": pk, "properties": p, "event": "modified"} for pk, p in cur.items() if pk in before
                and (any(before[pk].get(x) != p.get(x) for x in props) if props else before[pk] != p)]
    elif k == "threshold":
        th = c.get("threshold") or {}
        test = {"property": th.get("property"), "op": th.get("op") or "gt", "value": th.get("value")}
        hits = [{"primary_key": pk, "properties": p, "event": "threshold"} for pk, p in cur.items()
                if _filter_ok(test, p) and not (pk in before and _filter_ok(test, before[pk]))]
    if hits:
        execute(a, hits, f"{k} (function-generated set)", 1)
    return {"members": len(cur), "hits": len(hits)}


def scheduler() -> None:
    while True:
        time.sleep(15)
        try:
            tick()
        except Exception:  # noqa: BLE001
            log.exception("automate: scheduler")


# ------------------------------------------------------------------------------------------------
# routes beyond ontology.py's (history, retries, manual executions, muting, schedules)
# ------------------------------------------------------------------------------------------------


def can_edit(a: dict) -> bool:
    admins = (a.get("settings") or {}).get("administrators") or []
    me = auth.current() or {}
    if not admins or not auth.enabled() or me.get("role") == "admin":
        return True
    mine = {f"user:{me.get('id')}"} | {f"group:{g}" for g in me.get("groups") or []}
    return bool(mine & set(admins)) or a.get("owner") == me.get("id") or a.get("created_by") == me.get("id")


@router.get("/automations/{aid}/history")
def history_route(aid: str) -> list[dict]:
    _o()._automation(aid)
    return get_history(aid)


class ManualIn(BaseModel):
    primary_keys: list[str] = Field(default_factory=list, max_length=5000)
    all_objects: bool = False
    effects: Optional[list[int]] = None
    # the object set to run on: a function-generated one ({kind: "function", function_id, version, inputs}) instead of
    # the condition's
    object_source: Optional[dict] = None
    # split the objects into executions of at most batch_size objects, parallelism of them at a time
    batch_size: Optional[int] = Field(None, ge=1, le=100_000)
    parallelism: int = Field(1, ge=1, le=8)


@router.post("/automations/{aid}/execute")
def manual(aid: str, req: ManualIn) -> dict:
    """Run the effects now on chosen objects, on every object of the set, or (time conditions) once."""
    o = _o()
    a = normalize(o._automation(aid))
    if not can_edit(a):
        raise HTTPException(403, "only the automation's administrators run it by hand")
    c = a["condition"]
    objs: Optional[list[dict]] = None
    if c.get("kind") in OBJECT_KINDS and c.get("object_type_id"):
        if req.all_objects or req.object_source:
            try:
                members = set_members(c, req.object_source)
            except RuntimeError as e:
                raise HTTPException(400, f"the object set: {e}") from None
            objs = [{"primary_key": pk, "properties": props} for pk, props in members.items()]
        elif req.primary_keys:
            objs = [{"primary_key": pk, "properties": {}} for pk in req.primary_keys]
        else:
            raise HTTPException(400, "pick objects, or run on every object of the set")
    history(aid, "manual_execution", f"{len(objs) if objs is not None else 'no'} objects" + (f" in batches of {req.batch_size}" if req.batch_size and objs else ""),
            by=(auth.current() or {}).get("id"))
    if not req.batch_size or objs is None or len(objs) <= req.batch_size:
        return execute(a, objs, "manual", 0, req.effects)
    # batches: each is its own execution (random order, like Foundry), parallelism at a time
    import random

    objs = random.sample(objs, len(objs))
    parts = [objs[i:i + req.batch_size] for i in range(0, len(objs), req.batch_size)]
    who = auth.current()

    def one(part: list[dict]) -> dict:
        token = auth._principal.set(who) if who else None
        try:
            return execute(a, part, "manual", 0, req.effects)
        finally:
            if token is not None:
                auth._principal.reset(token)

    with ThreadPoolExecutor(max_workers=req.parallelism, thread_name_prefix="automate-manual") as pool:
        runs = list(pool.map(one, parts))
    failed = [r for r in runs if r["status"] == "failed"]
    return {"status": "failed" if failed else "succeeded", "batches": len(parts), "runs": [{k: r[k] for k in ("id", "status", "edits", "error")} | {"objects": len(r.get("primary_keys") or [])} for r in runs],
            "edits": sum(r["edits"] for r in runs), "error": failed[0]["error"] if failed else None}


@router.post("/automations/{aid}/runs/{run_id}/retry")
def retry(aid: str, run_id: str) -> dict:
    """Run a failed execution again: the same objects, the effects from the one that failed."""
    o = _o()
    a = normalize(o._automation(aid))
    if not can_edit(a):
        raise HTTPException(403, "only the automation's administrators retry it")
    runs = o._read(o.DIR / "runs" / f"{aid}.json", [])
    r = next((x for x in runs if x["id"] == run_id), None)
    if not r:
        raise HTTPException(404, "run not found")
    if r.get("status") != "failed":
        raise HTTPException(400, "only failed runs are retried")
    failed_at = next((i for i, e in enumerate(r.get("effects") or []) if e.get("status") == "failed"), 0)
    pks = r.get("primary_keys") or ([r["primary_key"]] if r.get("primary_key") else None)
    objs = [{"primary_key": pk, "properties": {}} for pk in pks] if pks else None
    history(aid, "manual_retry", f"retry of {run_id}", by=(auth.current() or {}).get("id"))
    return execute(a, objs, f"retry of {run_id}", 0, list(range(failed_at, len(a["effects"]))))


class MuteIn(BaseModel):
    muted: bool


@router.post("/automations/{aid}/mute")
def mute(aid: str, req: MuteIn) -> dict:
    """Mute (or unmute) this automation's notifications for yourself."""
    o = _o()
    me = (auth.current() or {}).get("id") or "local"
    with o._lock:
        a = normalize(o._automation(aid))
        cur = set(a.get("muted_by") or [])
        cur = cur | {me} if req.muted else cur - {me}
        a["muted_by"] = sorted(cur)
        o._put("automations", a)
    history(aid, "muted" if req.muted else "unmuted", by=me)
    return {"muted": req.muted}


class MuteAllIn(BaseModel):
    muted: bool
    # an end time: the automation unmutes itself then
    until: Optional[str] = None


@router.post("/automations/{aid}/mute-all")
def mute_all(aid: str, req: MuteAllIn) -> dict:
    """Mute the automation for everyone (no effect runs; conditions still evaluate), or unmute it (editors)."""
    o = _o()
    a = normalize(o._automation(aid))
    if not can_edit(a):
        raise HTTPException(403, "only the automation's administrators mute it for everyone")
    if req.until:
        try:
            datetime.fromisoformat(req.until.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "until is a date and time") from None
    me = (auth.current() or {}).get("id") or "local"
    _set_muted(aid, {"by": me, "at": _iso(), "until": req.until} if req.muted else None, f"until {req.until}" if req.muted and req.until else "", by=me)
    return {"muted": o._automation(aid).get("muted")}


@router.post("/automations/{aid}/evaluate")
def evaluate_now(aid: str) -> dict:
    """Evaluate a function-backed condition now (instead of waiting for its schedule)."""
    o = _o()
    a = normalize(o._automation(aid))
    if not can_edit(a):
        raise HTTPException(403, "only the automation's administrators evaluate it by hand")
    if not polled(a.get("condition") or {}):
        raise HTTPException(400, "only function-backed conditions are evaluated on demand")
    return poll(a)


class ScheduleIn(BaseModel):
    condition: dict


@router.post("/schedule-preview")
def schedule_preview(req: ScheduleIn) -> dict:
    """The next times a time condition would run."""
    c = req.condition
    for x in c.get("cron") or []:
        if str(x).strip():
            parse_cron(x)
    return {"next": next_runs(c, 6)}


@router.post("/automations/{aid}/count")
def count(aid: str) -> dict:
    """How many objects are in the condition's object set now."""
    o = _o()
    a = o._automation(aid)
    c = a.get("condition") or {}
    if c.get("kind") not in OBJECT_KINDS or not c.get("object_type_id"):
        return {"count": None}
    rows = o._objects(c["object_type_id"])
    try:
        return {"count": len(set_members(c)), "total": len(rows)}
    except RuntimeError as e:
        return {"count": None, "total": len(rows), "error": str(e)}
