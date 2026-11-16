"""Autopilot (Application Building → Autopilot): a control center over Automate workflows.

A workbench is a Files item (`<name>.autopilot`, application/vnd.bluesandai.autopilot+json) in a Project. It holds
object types and automations, and states: columns of the Kanban board, each an object type with a condition on a
property (status = "ditunda"). States are inferred from the object types' state-like properties and the values
automation effects write; builders add, reorder, rename, recolor them and choose the card properties.

Reads go through the Ontology's checks (objects through Workshop's rows: markings, object and property policies):
- board: objects per state (with the last change and who made it), live markers for automation runs in progress;
- dependency graph: states, automations, the actions and logic functions they run, Workshop modules whose buttons
  apply the same actions (human steps), with the transitions they cause and their recent activity;
- automation events: the runs of the workbench's automations (filter by status, automation, time), with retries;
- object timeline: an object's history from action runs (properties before and after) and automation runs,
  attributed to automations or people, with runtime, waiting time and agentic coverage;
- alerts: related automations not in the workbench, object types without edit history, automations never run,
  automations that failed in the last day; subscribers are notified (notify.deliver: inbox, optionally email) when
  an alert appears that was not there at their last check (background check every few minutes and after changes).
  The background check computes each subscriber's alerts as that subscriber (never as the system): a deleted or
  deactivated subscriber, or one who lost the workbench, is skipped with the reason; automations on object types
  they cannot see are neither named nor quoted;
- token usage: language-model tokens of AIP Logic runs and automation runs, counted as the model calls happen
  (pipeline_ai.USAGE_HOOKS) and shown per execution, per object and on logic nodes;
- graph layout: node positions dragged in the graph, saved with the workbench for everyone (editors) or for the
  viewer only; without one the graph lays nodes out in columns by kind.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/autopilot", tags=["autopilot"])
AP_TYPE = "application/vnd.bluesandai.autopilot+json"
DIR = Path("data/autopilot")
COLORS = ["#3b82f6", "#f59e0b", "#22c55e", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"]
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "autopilot"
    DIR.mkdir(parents=True, exist_ok=True)
    import pipeline_ai

    if _count_tokens not in pipeline_ai.USAGE_HOOKS:
        pipeline_ai.USAGE_HOOKS.append(_count_tokens)
    _start_alert_loop()


# ------------------------------------------------------------------------------------------------
# token usage: each model call adds its tokens to the AIP Logic run and the automation run it happens in
# ------------------------------------------------------------------------------------------------


def _count_tokens(model: str, status: str, tokens: int = 0) -> None:
    """A pipeline_ai usage hook. The call runs synchronously inside ontology.run_logic (whose `result` dict becomes the
    recorded Logic run) and, for automations, inside automate._effect_once (whose `run` dict becomes the recorded
    automation run): the innermost of each on this thread's stack gets the tokens, so a Logic run triggered by another
    one's edits keeps its own count."""
    if status != "succeeded" or not tokens:
        return
    import sys

    import automate
    import ontology

    targets = {getattr(ontology.run_logic, "__code__", None): "result", getattr(automate._effect_once, "__code__", None): "run"}
    seen: set = set()
    f = sys._getframe(1)
    while f is not None and len(seen) < 2:
        name = targets.get(f.f_code)
        if name and f.f_code not in seen:
            seen.add(f.f_code)
            rec = f.f_locals.get(name)
            if isinstance(rec, dict):
                rec["tokens"] = int(rec.get("tokens") or 0) + int(tokens)
                by = rec.setdefault("tokens_by_model", {})
                if isinstance(by, dict):
                    by[model] = int(by.get(model) or 0) + int(tokens)
        f = f.f_back


def _logic_ids(a: dict) -> list[str]:
    """The AIP Logic functions an automation's effects (and their fallbacks) run."""
    out: list[str] = []
    for e in (a.get("effects") or []) + [a.get("effect") or {}]:
        for x in (e, e.get("fallback") or {}):
            if x.get("kind") == "logic" and x.get("logic_id") and x["logic_id"] not in out:
                out.append(x["logic_id"])
    return out


def _logic_runs(lid: str, cache: dict) -> dict[str, dict]:
    if lid not in cache:
        import ontology

        try:
            cache[lid] = {r.get("id"): r for r in ontology.logic_runs(lid)}
        except HTTPException:
            cache[lid] = {}
    return cache[lid]


def _run_tokens(r: dict, a: dict, cache: dict) -> Optional[int]:
    """Tokens of an automation run: counted on the run itself, else the sum of the Logic runs it started."""
    if r.get("tokens"):
        return int(r["tokens"])
    ids = {r.get("logic_run_id")} | {e.get("logic_run_id") for e in r.get("effects") or [] if isinstance(e, dict)}
    ids.discard(None)
    if not ids:
        return None
    total = 0
    for lid in _logic_ids(a):
        total += sum(int((_logic_runs(lid, cache).get(i) or {}).get("tokens") or 0) for i in ids)
    return total or None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _path(wid: str) -> Path:
    if not re.fullmatch(r"ap-[0-9a-f]{12}", wid):
        raise HTTPException(404, "workbench not found")
    return DIR / f"{wid}.json"


def _read(wid: str) -> dict:
    try:
        return json.loads(_path(wid).read_text("utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "workbench not found") from None


def _write(w: dict) -> None:
    p = _path(w["id"])
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(w, ensure_ascii=False, indent=1), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


def _all() -> list[dict]:
    out = []
    for p in DIR.glob("ap-*.json") if DIR.exists() else []:
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _access(w: dict, need: str = "viewer") -> dict:
    return drive._item(w["item_id"], need=need)


def _automations() -> list[dict]:
    import ontology

    return ontology.list_automations()


def _action_types() -> dict[str, dict]:
    import ontology

    return {a["id"]: a for a in ontology.list_action_types()}


_names: dict[str, str] = {}


def _who(user: Any) -> Any:
    """A person's display name for a run's user id (automation:* and unknown ids stay as they are)."""
    u = str(user or "")
    if not u.startswith("u-"):
        return user
    if u not in _names:
        try:
            r = auth._user(u)
            _names[u] = r.get("display_name") or r.get("username") or u
        except HTTPException:
            return user
    return _names[u]


def _module_actions(m: dict) -> set[str]:
    """The action types a Workshop module's widgets, events and settings reference."""
    out: set[str] = set()

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                if k == "action_type_id" and isinstance(v, str) and v:
                    out.add(v)
                elif k == "action_type_ids" and isinstance(v, list):
                    out.update(i for i in v if isinstance(i, str) and i)
                else:
                    walk(v)
        elif isinstance(x, list):
            for i in x:
                walk(i)

    walk([w.get("config") for w in m.get("widgets") or []])
    walk(m.get("settings"))
    walk(m.get("overlays"))
    return out


def _rows(type_id: str) -> list[dict]:
    import workshop

    return workshop._object_rows(type_id)[2]


# ------------------------------------------------------------------------------------------------
# inference
# ------------------------------------------------------------------------------------------------


def _related_automations(type_ids: set[str]) -> list[dict]:
    """Automations whose condition watches one of these object types, or whose action edits one of them."""
    actions = _action_types()
    out = []
    for a in _automations():
        c, e = a.get("condition") or {}, a.get("effect") or {}
        at = actions.get(e.get("action_type_id") or "")
        if c.get("object_type_id") in type_ids or (at and at.get("object_type_id") in type_ids):
            out.append(a)
    return out


def infer_states(type_id: str, automations: list[dict]) -> list[dict]:
    """States of an object type: its state-like property (a string with a few values; status / state / stage names
    first) and the values its automations write, in workflow order (the most common first)."""
    import ontology

    t = ontology._object_type(type_id)
    rows = _rows(type_id)
    best, best_score, best_values = None, -1.0, []
    for p in t["properties"]:
        if p["type"] != "string" or p["api_name"] == t["primary_key"]:
            continue
        vals = Counter(str(r.get(p["api_name"])) for r in rows if r.get(p["api_name"]) not in (None, ""))
        if not 2 <= len(vals) <= 12:
            continue
        score = (3 if re.search(r"status|state|stage|tahap|keadaan|phase", p["api_name"], re.I) else 0) + min(sum(vals.values()) / max(len(rows), 1), 1)
        if score > best_score:
            best, best_score, best_values = p["api_name"], score, [v for v, _ in vals.most_common()]
    if not best:
        return []
    written = []
    for a in automations:
        for k, v in ((a.get("effect") or {}).get("parameters") or {}).items():
            if k == best and isinstance(v, str) and "{{" not in v and v not in best_values and v not in written:
                written.append(v)
    return [{"id": f"st-{uuid.uuid4().hex[:8]}", "name": v, "object_type_id": type_id, "property": best, "value": v, "color": COLORS[i % len(COLORS)],
             "icon": None, "card_properties": []} for i, v in enumerate(best_values + written)]


# ------------------------------------------------------------------------------------------------
# workbenches
# ------------------------------------------------------------------------------------------------


class WorkbenchIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    object_type_ids: list[str] = Field(default_factory=list)
    automation_ids: list[str] = Field(default_factory=list)
    include_related: bool = True


@router.get("/workbenches")
def list_workbenches() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (AP_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return [{k: w[k] for k in ("id", "name", "item_id", "object_type_ids", "automation_ids", "created_at", "updated_at")} | {"states": len(w["states"])}
            for w in _all() if w["item_id"] in visible]


@router.post("/workbenches")
def create_workbench(req: WorkbenchIn) -> dict:
    import ontology

    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "store the workbench in a Project or a folder")
    autos = {a["id"]: a for a in _automations()}
    types = list(dict.fromkeys(req.object_type_ids))
    actions = _action_types()
    for aid in req.automation_ids:
        a = autos.get(aid)
        if not a:
            raise HTTPException(404, f"no automation {aid}")
        c = a.get("condition") or {}
        at = actions.get((a.get("effect") or {}).get("action_type_id") or "")
        for t in (c.get("object_type_id"), at and at.get("object_type_id")):
            if t and t not in types:
                types.append(t)
    if not types:
        raise HTTPException(400, "pick object types or automations")
    for t in types:
        ontology._object_type(t)
    chosen = list(dict.fromkeys(req.automation_ids + ([a["id"] for a in _related_automations(set(types))] if req.include_related else [])))
    states = []
    for t in types:
        states += infer_states(t, [autos[x] for x in chosen if x in autos])
    with _lock:
        wid = "ap-" + uuid.uuid4().hex[:12]
        body = json.dumps({"autopilot_workbench_id": wid}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{req.name.strip()}.autopilot"), io.BytesIO(body), len(body), AP_TYPE)
        w = {"id": wid, "name": req.name.strip(), "item_id": item["id"], "object_type_ids": types, "automation_ids": chosen, "removed_nodes": [],
             "states": states, "created_at": _now(), "updated_at": _now()}
        _write(w)
    return get_workbench(wid)


def _me() -> Optional[str]:
    return (auth.current() or {}).get("id")


def _public(w: dict, alerts: list[dict]) -> dict:
    """The workbench as a viewer sees it: the shared layout and their own, the subscribers (without what each was
    last notified of)."""
    me = _me()
    layouts = w.get("layouts") or {}
    subs = w.get("subscribers") or []
    return {**{k: v for k, v in w.items() if k not in ("layouts", "alert_notified", "subscribers")}, "alerts": alerts,
            "layout": {"shared": layouts.get("shared") or None, "mine": (layouts.get("users") or {}).get(me) if me else None, "can_save_mine": bool(me)},
            "subscribers": [{"user_id": s["user_id"], "name": _who(s["user_id"]), "email": bool(s.get("email")), "me": bool(me) and s["user_id"] == me} for s in subs],
            "subscribed": any(s["user_id"] == me for s in subs) if me else False}


@router.get("/workbenches/{wid}")
def get_workbench(wid: str) -> dict:
    w = _read(wid)
    _access(w)
    alerts = _alerts(w)
    if w.get("subscribers"):
        _check_soon(wid)
    return _public(w, alerts)


class WorkbenchPut(BaseModel):
    name: Optional[str] = None
    automation_ids: Optional[list[str]] = None
    object_type_ids: Optional[list[str]] = None
    states: Optional[list[dict]] = None
    removed_nodes: Optional[list[str]] = None
    # who is notified when an alert appears: [{user_id, email}] (editors manage the list; anyone subscribes themselves)
    subscribers: Optional[list[dict]] = None


@router.put("/workbenches/{wid}")
def update_workbench(wid: str, req: WorkbenchPut) -> dict:
    with _lock:
        w = _read(wid)
        _access(w, "editor")
        for k, v in req.model_dump(exclude_none=True).items():
            if k == "states":
                for s in v:
                    if not s.get("name") or not s.get("object_type_id"):
                        raise HTTPException(422, "a state has a name and an object type")
                    s.setdefault("id", f"st-{uuid.uuid4().hex[:8]}")
            if k == "subscribers":
                v = _clean_subscribers(w, v)
            w[k] = v
        w["updated_at"] = _now()
        _write(w)
    if w.get("subscribers"):
        _check_soon(wid, force=True)
    return get_workbench(wid)


# ------------------------------------------------------------------------------------------------
# saved graph layouts
# ------------------------------------------------------------------------------------------------


class LayoutIn(BaseModel):
    # node id → {x, y} (the top-left corner of the node, in graph pixels)
    positions: dict[str, dict] = Field(default_factory=dict)
    scope: str = Field("mine", pattern="^(mine|shared)$")


def _clean_positions(p: dict[str, dict]) -> dict[str, dict]:
    if len(p) > 2000:
        raise HTTPException(422, "too many nodes")
    out = {}
    for nid, xy in p.items():
        try:
            x, y = float(xy["x"]), float(xy["y"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, f"node {nid}: a position is {{x, y}}") from None
        if not (-100000 <= x <= 100000 and -100000 <= y <= 100000):
            raise HTTPException(422, f"node {nid}: the position is out of range")
        out[str(nid)[:200]] = {"x": round(x, 1), "y": round(y, 1)}
    return out


@router.put("/workbenches/{wid}/layout")
def save_layout(wid: str, req: LayoutIn) -> dict:
    """Save the graph's node positions: for everyone (editors) or for the viewer only."""
    with _lock:
        w = _read(wid)
        _access(w, "editor" if req.scope == "shared" else "viewer")
        layouts = w.setdefault("layouts", {})
        pos = _clean_positions(req.positions)
        if req.scope == "shared":
            layouts["shared"] = pos
        else:
            me = _me()
            if not me:
                raise HTTPException(400, "sign in to save a layout of your own (or save it for everyone)")
            layouts.setdefault("users", {})[me] = pos
        _write(w)
    return get_workbench(wid)["layout"]


@router.delete("/workbenches/{wid}/layout")
def reset_layout(wid: str, scope: str = "mine") -> dict:
    """Back to the automatic layout (columns by kind): forget the viewer's own layout, or the shared one (editors)."""
    if scope not in ("mine", "shared"):
        raise HTTPException(422, "scope is mine or shared")
    with _lock:
        w = _read(wid)
        _access(w, "editor" if scope == "shared" else "viewer")
        layouts = w.setdefault("layouts", {})
        if scope == "shared":
            layouts.pop("shared", None)
        elif _me():
            (layouts.get("users") or {}).pop(_me(), None)
        _write(w)
    return get_workbench(wid)["layout"]


# ------------------------------------------------------------------------------------------------
# alert notifications
# ------------------------------------------------------------------------------------------------


def _clean_subscribers(w: dict, subs: list[dict]) -> list[dict]:
    old = {s["user_id"]: s for s in w.get("subscribers") or []}
    out: list[dict] = []
    for s in subs[:200]:
        uid = str((s or {}).get("user_id") or "")
        if not uid or any(x["user_id"] == uid for x in out):
            continue
        try:
            auth._user(uid)
        except HTTPException:
            raise HTTPException(404, f"no user {uid}") from None
        out.append({"user_id": uid, "email": bool(s.get("email")), "added_at": (old.get(uid) or {}).get("added_at") or _now()})
    # new subscribers are told about alerts that appear from now on, not the ones already showing
    notified = w.setdefault("alert_notified", {})
    for s in out:
        if s["user_id"] not in old:
            notified[s["user_id"]] = [a["key"] for a in _alerts(w)]
    for uid in list(notified):
        if uid not in {s["user_id"] for s in out}:
            notified.pop(uid)
    return out


class SubscribeIn(BaseModel):
    email: bool = False


@router.post("/workbenches/{wid}/subscribe")
def subscribe(wid: str, req: SubscribeIn) -> dict:
    """Be notified when an alert appears on this workbench (in the inbox; by email too when asked)."""
    me = _me()
    if not me:
        raise HTTPException(400, "sign in to subscribe")
    with _lock:
        w = _read(wid)
        _access(w)
        subs = [s for s in w.get("subscribers") or [] if s["user_id"] != me] + [{"user_id": me, "email": req.email}]
        w["subscribers"] = _clean_subscribers(w, subs)
        _write(w)
    return get_workbench(wid)


@router.delete("/workbenches/{wid}/subscribe")
def unsubscribe(wid: str) -> dict:
    me = _me()
    with _lock:
        w = _read(wid)
        _access(w)
        w["subscribers"] = [s for s in w.get("subscribers") or [] if s["user_id"] != me]
        (w.get("alert_notified") or {}).pop(me or "", None)
        _write(w)
    return get_workbench(wid)


_check_locks: dict[str, threading.Lock] = {}
_last_check: dict[str, float] = {}


def check_alerts(wid: str) -> list[dict]:
    """Notify each subscriber of the alerts that appeared since their last check (computed with their own access;
    a subscriber who lost access to the workbench is skipped). Alerts that cleared are forgotten, so one that comes
    back notifies again. Returns what was delivered, and the subscribers skipped ({user_id, skipped: the reason})."""
    import notify

    lock = _check_locks.setdefault(wid, threading.Lock())
    sent: list[dict] = []
    todo: list[tuple[dict, dict]] = []  # (subscriber, alert) to deliver once marked as seen
    # compute and mark-as-seen are atomic per workbench: across threads (lock) and across API processes sharing the
    # data directory (a lock file); the alerts are recorded as notified BEFORE delivering, so two checks running at the
    # same time can never both find the same alert new (a delivery that then fails is not retried)
    with lock, _xlock(wid):
        _last_check[wid] = time.monotonic()
        try:
            w = _read(wid)
        except HTTPException:
            return sent
        if not w.get("subscribers") or _trashed(w):
            return sent
        current: dict[str, list[str]] = {}
        for s in w["subscribers"]:
            uid = s["user_id"]
            principal = auth.principal_of(uid)
            if principal is None:
                # never computed as the system: a deleted or deactivated subscriber hears nothing
                sent.append({"user_id": uid, "skipped": f"{_who(uid)} is {(auth.user_label(uid) or {}).get('status', 'deleted')}"})
                continue
            token = auth._principal.set(principal)
            try:
                try:
                    _access(w)
                except HTTPException as e:
                    sent.append({"user_id": uid, "skipped": f"{_who(uid)} can no longer open the workbench ({e.detail})"})
                    continue
                alerts = _alerts(w)
                before = set((w.get("alert_notified") or {}).get(uid) or [])
                current[uid] = [a["key"] for a in alerts]
                todo += [(s, a) for a in alerts if a["key"] not in before]
            except Exception as e:  # noqa: BLE001 - one subscriber's failure does not stop the others
                sent.append({"user_id": uid, "skipped": f"the alerts could not be computed for them: {type(e).__name__}"})
                continue
            finally:
                auth._principal.reset(token)
        with _lock:
            w = _read(wid)
            notified = w.setdefault("alert_notified", {})
            subs = {s["user_id"] for s in w.get("subscribers") or []}
            changed = False
            for uid, keys in current.items():
                if notified.get(uid) != keys and uid in subs:
                    notified[uid] = keys
                    changed = True
            if changed:
                _write(w)
        todo = [(s, a) for s, a in todo if s["user_id"] in subs]
    for s, a in todo:
        try:
            r = notify.deliver(s["user_id"], f"Autopilot alert: {w['name']}", a["text"], link=f"/autopilot/{wid}", link_label="Open the workbench",
                               source=f"autopilot:{wid}", web=True, email=bool(s.get("email")))
        except Exception as e:  # noqa: BLE001
            r = {"web": False, "email": False, "error": str(e)[:200]}
        sent.append({"user_id": s["user_id"], "key": a["key"], **r})
    return sent


class _xlock:
    """A lock file next to the workbench (created exclusively): one alert check per workbench at a time across API
    processes. A lock older than STALE_S (a crashed process) is taken over; waiting gives up after WAIT_S."""

    STALE_S = 120
    WAIT_S = 60

    def __init__(self, wid: str) -> None:
        self.path = DIR / f"{wid}.alerts.lock"
        self.fd: Optional[int] = None

    def __enter__(self) -> "_xlock":
        deadline = time.monotonic() + self.WAIT_S
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, f"{os.getpid()} {time.time()}".encode())
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > self.STALE_S:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError(f"another process holds {self.path.name}") from None
                time.sleep(0.05)

    def __exit__(self, *exc: Any) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
            try:
                self.path.unlink()
            except OSError:
                pass


def _trashed(w: dict) -> bool:
    """The workbench's Files item is in the trash (or gone): no more notifications."""
    try:
        rows = db.drive_query("d.id = %s", (w["item_id"],), limit=1)
    except Exception:  # noqa: BLE001
        return False
    return bool(rows and rows[0].get("trashed_at")) or not rows


def _check_soon(wid: str, force: bool = False) -> None:
    """Check a subscribed workbench's alerts in the background (at most once a minute unless forced)."""
    if not force and time.monotonic() - _last_check.get(wid, -1e9) < 60:
        return
    _last_check[wid] = time.monotonic()
    threading.Thread(target=check_alerts, args=(wid,), name=f"autopilot-alerts-{wid}", daemon=True).start()


ALERT_CHECK_S = 300
_loop_started = False


def _start_alert_loop() -> None:
    global _loop_started
    if _loop_started:
        return
    _loop_started = True

    def loop() -> None:
        while True:
            time.sleep(ALERT_CHECK_S)
            for w in _all():
                if w.get("subscribers"):
                    try:
                        check_alerts(w["id"])
                    except Exception:  # noqa: BLE001
                        pass

    threading.Thread(target=loop, name="autopilot-alerts", daemon=True).start()


@router.post("/workbenches/{wid}/infer")
def reinfer(wid: str) -> dict:
    """Infer the states again from the data and the automations (replaces the states)."""
    autos = {a["id"]: a for a in _automations()}
    with _lock:
        w = _read(wid)
        _access(w, "editor")
        w["states"] = [s for t in w["object_type_ids"] for s in infer_states(t, [autos[x] for x in w["automation_ids"] if x in autos])]
        _write(w)
    return get_workbench(wid)


@router.delete("/workbenches/{wid}")
def delete_workbench(wid: str) -> dict:
    w = _read(wid)
    drive.trash(_access(w, "editor")["id"])
    return {"trashed": wid}


def _seen_automations(autos: list[dict]) -> list[dict]:
    """The automations whose object types (the one the condition watches, the one its action edits) the current
    principal can see: alerts name automations and quote their errors, and the background check computes them as each
    subscriber — someone without an object type's markings hears nothing about the automations on it. Sign-in off,
    the system and services: all of them."""
    import ontology

    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return autos
    actions = _action_types()
    seen: dict[str, bool] = {}

    def sees(tid: Optional[str]) -> bool:
        if not tid:
            return True
        if tid not in seen:
            try:
                ontology._object_type(tid)
                seen[tid] = True
            except HTTPException:
                seen[tid] = False
        return seen[tid]

    out = []
    for a in autos:
        at = actions.get(((a.get("effect") or {}).get("action_type_id")) or "")
        if sees((a.get("condition") or {}).get("object_type_id")) and sees(at.get("object_type_id") if at else None):
            out.append(a)
    return out


def _alerts(w: dict) -> list[dict]:
    import ontology
    import ontology_edits

    # each alert has a key that stays the same while the alert is the same one (notifications fire on new keys)
    out = []
    missing = [a for a in _seen_automations(_related_automations(set(w["object_type_ids"]))) if a["id"] not in w["automation_ids"]]
    if missing:
        out.append({"kind": "automations", "text": f"{len(missing)} related automation{'s' if len(missing) > 1 else ''} not in the workbench: " + ", ".join(a["name"] for a in missing[:5]),
                    "automation_ids": [a["id"] for a in missing], "key": "automations:" + ",".join(sorted(a["id"] for a in missing))})
    for tid in w["object_type_ids"]:
        try:
            t = ontology._object_type(tid)
        except HTTPException:
            continue
        if not ontology_edits.config(t)["history"]:
            out.append({"kind": "edit_history", "text": f"Edit history is off for {t['display_name']}: object timelines read action runs only (turn it on in Ontology Manager → Edits)", "object_type_id": tid,
                        "key": f"edit_history:{tid}"})
    autos = {a["id"]: a for a in _seen_automations(_automations())}
    never = [x for x in w["automation_ids"] if x in autos and not autos[x].get("run_count")]
    if never:
        out.append({"kind": "never_run", "text": "Never run (relationships are inferred from executions): " + ", ".join(autos[x]["name"] for x in never[:5]),
                    "automation_ids": never, "key": "never_run:" + ",".join(sorted(never))})
    if not w["states"]:
        out.append({"kind": "states", "text": "No states: add one per stage of the workflow (an object type and a property value)", "key": "states"})
    # automations that failed in the last day (one alert per automation while it keeps failing)
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    for x in w["automation_ids"]:
        if x not in autos or not autos[x].get("failed_runs"):
            continue
        failed = [r for r in _auto_runs(x) if r.get("status") == "failed" and (r.get("at") or "") >= since]
        if failed:
            last = max(failed, key=lambda r: r.get("at") or "")
            out.append({"kind": "failures", "text": f"{autos[x]['name']} failed {len(failed)} time{'s' if len(failed) > 1 else ''} in the last day"
                        + (f" (last: {str(last.get('error'))[:200]})" if last.get("error") else ""), "automation_ids": [x], "key": f"failures:{x}"})
    return out


# ------------------------------------------------------------------------------------------------
# the board
# ------------------------------------------------------------------------------------------------


def _match(row: dict, s: dict) -> bool:
    v = row.get(s.get("property") or "")
    op = s.get("op") or "eq"
    target = s.get("value")
    if op == "is_null":
        return v in (None, "")
    if op == "contains":
        return str(target or "").lower() in str(v or "").lower()
    return v is not None and str(v) == str(target)


def _last_changes(type_id: str) -> dict[str, dict]:
    """The last action edit of each object: when, which action, who (a person or an automation)."""
    import ontology_actions

    actions = _action_types()
    auto_by_action = {}
    for a in _automations():
        e = a.get("effect") or {}
        if e.get("action_type_id"):
            auto_by_action.setdefault(e["action_type_id"], []).append(a)
    out: dict[str, dict] = {}
    for aid, at in actions.items():
        if at.get("object_type_id") != type_id:
            continue
        for r in ontology_actions._runs(aid)["runs"]:
            if r.get("status") != "succeeded":
                continue
            for e in r.get("edited") or []:
                if e.get("object_type_id") != type_id:
                    continue
                pk = str(e.get("primary_key"))
                if pk not in out or r["at"] > out[pk]["at"]:
                    out[pk] = {"at": r["at"], "action": at["display_name"], "user": _who(r.get("user")), "automated": _by_automation(r, pk, auto_by_action.get(aid, []))}
    return out


def _by_automation(run: dict, pk: str, autos: list[dict]) -> Optional[str]:
    """The automation that applied this action run (each automation run claims the one action run on its object that is closest after its start)."""
    if str(run.get("user") or "").startswith("automation:"):
        return run["user"].split(":", 1)[1]
    for a in autos:
        if run.get("rid") in _claimed(a):
            return a["name"]
    return None


_claims: dict[str, tuple[tuple, set]] = {}


def _claimed(auto: dict) -> set:
    import ontology_actions

    aid = (auto.get("effect") or {}).get("action_type_id")
    if not aid:
        return set()
    aruns = _auto_runs(auto["id"])
    acts = ontology_actions._runs(aid)["runs"]
    key = (len(aruns), len(acts), aruns[0]["id"] if aruns else None, acts[-1]["rid"] if acts else None)
    hit = _claims.get(auto["id"])
    if hit and hit[0] == key:
        return hit[1]
    by_pk: dict[str, list[tuple[datetime, str]]] = {}
    for r in acts:
        if r.get("status") != "succeeded":
            continue
        try:
            t = datetime.fromisoformat(r["at"])
        except ValueError:
            continue
        for e in r.get("edited") or []:
            by_pk.setdefault(str(e.get("primary_key")), []).append((t, r["rid"]))
    claimed: set = set()
    for ar in sorted(aruns, key=lambda x: x["at"]):
        if ar.get("status") != "succeeded" or not ar.get("edits"):
            continue
        try:
            t0 = datetime.fromisoformat(ar["at"])
        except ValueError:
            continue
        window = (ar.get("ms") or 0) / 1000 + 2
        best = min(((abs((t - t0).total_seconds()), rid) for t, rid in by_pk.get(str(ar.get("primary_key")), []) if rid not in claimed and -1 <= (t - t0).total_seconds() <= window), default=None)
        if best:
            claimed.add(best[1])
    _claims[auto["id"]] = (key, claimed)
    return claimed


def _auto_runs(aid: str) -> list[dict]:
    import ontology

    try:
        return ontology.automation_runs(aid)
    except HTTPException:
        return []


@router.get("/workbenches/{wid}/board")
def board(wid: str, linked_to: Optional[str] = None) -> dict:
    """Objects per state. linked_to=<type>|<pk>: only that object and the objects linked to it."""
    import ontology

    w = _read(wid)
    _access(w)
    keep: Optional[set[tuple[str, str]]] = None
    if linked_to and "|" in linked_to:
        import ontology_model

        tid, pk = linked_to.split("|", 1)
        keep = {(tid, pk)}
        for lk in ontology_model.object_links(tid, pk, limit=500):
            keep |= {(lk["object_type_id"], o["primary_key"]) for o in lk["objects"]}
    live = {}
    for aid in w["automation_ids"]:
        for r in _auto_runs(aid)[:20]:
            if r.get("status") == "running":
                live[str(r.get("primary_key"))] = aid
    columns = []
    unassigned: dict[str, int] = {}
    by_type: dict[str, list[dict]] = {}
    changes: dict[str, dict[str, dict]] = {}
    for tid in w["object_type_ids"]:
        try:
            t = ontology._object_type(tid)
        except HTTPException:
            continue
        rows = _rows(tid)
        if keep is not None:
            rows = [r for r in rows if (tid, str(r["__pk"])) in keep]
        by_type[tid] = rows
        changes[tid] = _last_changes(tid)
        matched = set()
        for s in [x for x in w["states"] if x["object_type_id"] == tid]:
            seen = {k for r in rows[:50] for k, v in r.items() if v not in (None, "")}  # property policies blank what this viewer may not see
            shown = [p for p in t["properties"] if p["api_name"] in seen]
            props = [p for p in s.get("card_properties") or [] if p in seen] or [p["api_name"] for p in shown if p.get("visibility") == "prominent"][:3] or [p["api_name"] for p in shown if p["api_name"] != t["primary_key"]][:3]
            cards = []
            for r in rows:
                if _match(r, s):
                    pk = str(r["__pk"])
                    matched.add(pk)
                    cards.append({"pk": pk, "title": str(r.get(t.get("title_property") or t["primary_key"]) or pk), "properties": {p: r.get(p) for p in props},
                                  "last": changes[tid].get(pk), "live": pk in live})
            cards.sort(key=lambda c: (c["last"] or {}).get("at") or "", reverse=True)
            columns.append({**s, "object_type": t["display_name"], "count": len(cards), "cards": cards[:200]})
        unassigned[t["display_name"]] = len([r for r in rows if str(r["__pk"]) not in matched])
    order = {s["id"]: i for i, s in enumerate(w["states"])}
    columns.sort(key=lambda c: order.get(c["id"], 0))
    return {"columns": columns, "unassigned": unassigned, "live_automations": sorted(set(live.values()))}


class RetryIn(BaseModel):
    automation_id: str
    primary_keys: list[str] = Field(min_length=1, max_length=500)


@router.post("/workbenches/{wid}/retry")
def retry(wid: str, req: RetryIn) -> dict:
    """Run an automation now on objects (one, or every object of a state)."""
    import ontology

    w = _read(wid)
    _access(w, "editor")
    if req.automation_id not in w["automation_ids"]:
        raise HTTPException(400, "the automation is not in this workbench")
    out = []
    for pk in req.primary_keys:
        try:
            r = ontology.run_automation_now(req.automation_id, ontology.RunAutomation(primary_key=pk))
            out.append({"pk": pk, "status": r.get("status"), "error": r.get("error")})
        except HTTPException as e:
            out.append({"pk": pk, "status": "failed", "error": str(e.detail)})
    if w.get("subscribers"):
        _check_soon(wid, force=True)
    return {"runs": out, "succeeded": sum(1 for x in out if x["status"] == "succeeded")}


# ------------------------------------------------------------------------------------------------
# the dependency graph
# ------------------------------------------------------------------------------------------------


@router.get("/workbenches/{wid}/graph")
def graph(wid: str) -> dict:
    import ontology_actions
    import workshop

    w = _read(wid)
    _access(w)
    autos = {a["id"]: a for a in _automations()}
    actions = _action_types()
    nodes: list[dict] = []
    edges: list[dict] = []
    removed = set(w.get("removed_nodes") or [])

    def node(n: dict) -> None:
        if n["id"] not in removed and not any(x["id"] == n["id"] for x in nodes):
            nodes.append(n)

    import ontology

    logic_nodes: dict[str, dict] = {}
    states_by = {}
    for s in w["states"]:
        node({"id": s["id"], "kind": "state", "label": s["name"], "color": s.get("color"), "object_type_id": s["object_type_id"]})
        states_by.setdefault((s["object_type_id"], s.get("property"), str(s.get("value"))), s["id"])
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    for aid in w["automation_ids"]:
        a = autos.get(aid)
        if not a:
            continue
        runs = _auto_runs(aid)
        node({"id": aid, "kind": "automation", "label": a["name"], "enabled": a.get("enabled"), "runs": len(runs), "failed": a.get("failed_runs", 0),
              "live": any(r.get("status") == "running" for r in runs[:20]), "trigger": (a.get("condition") or {}).get("kind")})
        c = a.get("condition") or {}
        for s in w["states"]:
            if s["object_type_id"] == c.get("object_type_id"):
                edges.append({"from": s["id"], "to": aid, "kind": "triggers"})
        e = a.get("effect") or {}
        if e.get("action_type_id") and e["action_type_id"] in actions:
            at = actions[e["action_type_id"]]
            node({"id": at["id"], "kind": "action", "label": at["display_name"]})
            edges.append({"from": aid, "to": at["id"], "kind": "runs"})
            for k, v in (e.get("parameters") or {}).items():
                sid = states_by.get((at.get("object_type_id"), k, str(v)))
                if sid:
                    edges.append({"from": at["id"], "to": sid, "kind": "sets", "automated": True})
        for lid in _logic_ids(a):
            # AIP Logic effects: the function, with the runs and tokens its automations' executions used (7 days)
            if lid not in logic_nodes:
                try:
                    label = ontology._logic(lid)["name"]
                except (HTTPException, KeyError):
                    label = e.get("logic_name") or "AIP Logic"
                logic_nodes[lid] = {"id": lid, "kind": "logic", "label": label, "runs": 0, "tokens": 0}
                node(logic_nodes[lid])
            edges.append({"from": aid, "to": lid, "kind": "runs"})
        if e.get("fallback"):
            edges.append({"from": aid, "to": aid, "kind": "fallback"})
    cache: dict = {}
    for lid, n in logic_nodes.items():
        for r in _logic_runs(lid, cache).values():
            if (r.get("at") or "") >= since and ((r.get("trigger") or {}).get("automation_id") in w["automation_ids"]):
                n["runs"] += 1
                n["tokens"] += int(r.get("tokens") or 0)
        n["tokens"] = n["tokens"] or None
    # human steps: Workshop modules whose buttons apply actions on the workbench's object types
    types = set(w["object_type_ids"])
    try:
        mods = workshop.list_modules()
    except Exception:  # noqa: BLE001
        mods = []
    for m in mods:
        # every action a person can apply from the module: buttons, inline action forms, table / list actions, events of
        # button groups, selections, the navigation bar and commands
        used = _module_actions(m)
        for aid in used:
            at = actions.get(aid)
            if not at or at.get("object_type_id") not in types:
                continue
            node({"id": m["id"], "kind": "workshop", "label": m["name"]})
            node({"id": at["id"], "kind": "action", "label": at["display_name"]})
            edges.append({"from": m["id"], "to": at["id"], "kind": "human"})
    # transitions the actions caused recently (before → after of the state property), automated or by people
    mine = [a for a in _automations() if a["id"] in w["automation_ids"]]
    for n in [x for x in nodes if x["kind"] == "action"]:
        manual = automated = 0
        by = [a for a in mine if (a.get("effect") or {}).get("action_type_id") == n["id"]]
        for r in ontology_actions._runs(n["id"])["runs"]:
            if r["at"] < since or r.get("status") != "succeeded":
                continue
            if _by_automation(r, "", by):
                automated += 1
            else:
                manual += 1
            for ed in r.get("edited") or []:
                before = ((r.get("before") or {}).get(f"{ed['object_type_id']}|{ed['primary_key']}") or {}).get("properties") or {}
                for s in w["states"]:
                    if s["object_type_id"] == ed["object_type_id"] and str(before.get(s.get("property"))) == str(s.get("value")):
                        edges.append({"from": s["id"], "to": n["id"], "kind": "leaves"})
        n["manual_runs"], n["automated_runs"] = manual, automated
    dedup = {(e["from"], e["to"], e["kind"]): e for e in edges if any(x["id"] == e["from"] for x in nodes) and any(x["id"] == e["to"] for x in nodes)}
    return {"nodes": nodes, "edges": list(dedup.values())}


@router.get("/workbenches/{wid}/resources/{rid}/activity")
def activity(wid: str, rid: str) -> list[dict]:
    """Ontology writes of a resource on the graph (an action, or the action an automation runs)."""
    import ontology_actions

    w = _read(wid)
    _access(w)
    autos = {a["id"]: a for a in _automations()}
    aid = ((autos.get(rid) or {}).get("effect") or {}).get("action_type_id") or rid
    if aid not in _action_types():
        return []
    auto = autos.get(rid)
    out = []
    for r in reversed(ontology_actions._runs(aid)["runs"][-200:]):
        if auto and not any(_by_automation(r, str(e.get("primary_key")), [auto]) == auto["name"] for e in r.get("edited") or []):
            continue
        out.append({"at": r["at"], "user": _who(r.get("user")), "status": r.get("status"), "error": r.get("error"),
                    "edits": [{"op": e.get("op"), "object_type_id": e.get("object_type_id"), "primary_key": e.get("primary_key")} for e in r.get("edited") or []]})
    return out[:200]


# ------------------------------------------------------------------------------------------------
# automation events and object timelines
# ------------------------------------------------------------------------------------------------


@router.get("/workbenches/{wid}/events")
def events(wid: str, status: Optional[str] = None, automation_id: Optional[str] = None, hours: int = 24 * 7, primary_key: Optional[str] = None) -> dict:
    w = _read(wid)
    _access(w)
    autos = {a["id"]: a for a in _automations()}
    since = (datetime.now(timezone.utc) - timedelta(hours=max(1, hours))).isoformat()
    rows = []
    cache: dict = {}
    for aid in w["automation_ids"]:
        if automation_id and aid != automation_id or aid not in autos:
            continue
        for r in _auto_runs(aid):
            if r.get("at", "") < since or (status and r.get("status") != status) or (primary_key and str(r.get("primary_key")) != primary_key):
                continue
            rows.append({**{k: r.get(k) for k in ("id", "at", "trigger", "primary_key", "status", "error", "edits", "logic_run_id", "ms")}, "automation_id": aid, "automation": autos[aid]["name"],
                         "tokens": _run_tokens(r, autos[aid], cache)})
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    failing = Counter(str(r["primary_key"]) for r in rows if r["status"] == "failed" and r["primary_key"])
    return {"events": rows[:1000], "total": len(rows), "by_status": dict(Counter(r["status"] for r in rows)), "failing_objects": failing.most_common(20),
            "tokens": sum(r["tokens"] or 0 for r in rows) or None}


@router.get("/workbenches/{wid}/objects/{type_id}/{pk}/timeline")
def timeline(wid: str, type_id: str, pk: str) -> dict:
    """An object's history: action edits (properties before → after) and automation runs, attributed."""
    import ontology
    import ontology_actions

    w = _read(wid)
    _access(w)
    obj = ontology.get_object(type_id, pk)
    actions = _action_types()
    autos = _automations()
    auto_by_action: dict[str, list[dict]] = {}
    for a in autos:
        e = a.get("effect") or {}
        if e.get("action_type_id"):
            auto_by_action.setdefault(e["action_type_id"], []).append(a)
    hidden = set(obj.get("hidden_properties") or [])
    edits = []
    for aid, at in actions.items():
        if at.get("object_type_id") != type_id:
            continue
        for r in ontology_actions._runs(aid)["runs"]:
            for e in r.get("edited") or []:
                if e.get("object_type_id") != type_id or str(e.get("primary_key")) != str(pk):
                    continue
                before = ((r.get("before") or {}).get(f"{type_id}|{pk}") or {}).get("properties") or {}
                edits.append({"at": r["at"], "kind": "edit", "action": at["display_name"], "action_type_id": aid, "status": r.get("status"), "user": _who(r.get("user")),
                              "automation": _by_automation(r, str(pk), auto_by_action.get(aid, [])), "ms": r.get("ms"), "op": e.get("op"),
                              "before": {k: (None if k in hidden else v) for k, v in before.items()}})
    edits.sort(key=lambda x: x["at"])
    # after = the next edit's before, or the current object
    current = obj["properties"]
    for i, e in enumerate(edits):
        after = edits[i + 1]["before"] if i + 1 < len(edits) else current
        e["changes"] = {k: {"from": e["before"].get(k), "to": after.get(k)} for k in sorted(set(e["before"]) | set(after)) if e["before"].get(k) != after.get(k) and k not in hidden}
        del e["before"]
    runs = []
    cache: dict = {}
    for a in autos:
        for r in _auto_runs(a["id"]):
            if str(r.get("primary_key")) == str(pk) and (a.get("condition") or {}).get("object_type_id") == type_id or (str(r.get("primary_key")) == str(pk) and a["id"] in w["automation_ids"]):
                runs.append({"at": r["at"], "kind": "execution", "automation": a["name"], "automation_id": a["id"], "status": r.get("status"), "error": r.get("error"),
                             "ms": r.get("ms"), "logic_run_id": r.get("logic_run_id"), "tokens": _run_tokens(r, a, cache), "tokens_by_model": r.get("tokens_by_model")})
    items = sorted(edits + runs, key=lambda x: x["at"])
    automated = sum(1 for e in edits if e["automation"])
    first, last = (items[0]["at"], items[-1]["at"]) if items else (None, None)
    runtime = (datetime.fromisoformat(last) - datetime.fromisoformat(first)).total_seconds() if items else 0
    busy = sum((x.get("ms") or 0) for x in items) / 1000
    return {"object": {"title": obj["title"], "primary_key": obj["primary_key"], "properties": current}, "items": items,
            "summary": {"edits": len(edits), "executions": len(runs), "agentic_coverage": round(automated / len(edits), 2) if edits else None,
                        "runtime_s": runtime, "waiting_s": max(0.0, runtime - busy), "tokens": sum(int(x.get("tokens") or 0) for x in runs) or None,
                        "actors": sorted({e["automation"] or str(e["user"]) for e in edits})}}
