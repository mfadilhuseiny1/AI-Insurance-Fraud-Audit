"""Machinery, modelled on Palantir's Machinery: model, mine and monitor processes over Ontology objects.

A Machinery resource holds process containers. Each process follows one object type and one string state property:
its states (the property's values, with labels and positions), transitions between states, and the actions and
automations that cause them (input states before, output states after; an automation fires when an input state is
reached). Output states of rule-based actions that write a static value to the state property are found
automatically when an action is imported.

Process log: a log object type per process (Log ID, Process ID, Old state, New state, Timestamp, isLatest, Duration
in milliseconds since entering the old state, Path as a JSON list, Action type RID) linked to the process objects.
Machinery maintains it: entries come from an external changelog dataset in Files (processId, state, timestamp,
optional isDeleted) and from platform edits of the state property (ontology_edits.py records them as they happen;
earlier edits are taken from the edit history when it is on). Log objects are written by Machinery only.

Process mining (from the log, or the latest states when there is no log): states and transitions with how often
they occur, a transition filter keeping the most frequent ones up to x % of all transitions, excluded elements kept
on the resource, and an overlay against the definition: new (mined, not defined), existing, and defined but unused.

Monitoring: per state the current and historical count and the current and historical duration; per transition its
count and mean duration; the path explorer (paths and how many objects took each); the duration distribution of a
state, and of any graph selection (POST …/distribution: a histogram with percentiles whose bucket ranges filter the
output); conformance (objects whose paths use only defined states and transitions; deviations hidden unless asked);
and the output object set — objects currently in, or ever in, the selected states, or through selected transitions.

Subprocesses: a process with a parent ({process_id, link_type_id}) is nested in it — its objects are those linked to
the parent's objects through the link type (the subprocess object set), metrics and outputs can focus on the children
of parent objects in chosen parent states, and the hierarchy route gives the tree with child counts per parent state.
The Workshop widget narrows a process by selections elsewhere in the tree: ancestor_keys (every selecting ancestor's
objects: only what sits under them) and descendant_keys (a subprocess' selection carried up when focusing into a parent
process: only the objects those sit under). Metrics also count each action's entries (the widget's transition nodes).

Records are JSON files under data/ontology/machinery/. Mounted by server.py under /api/machinery.
"""

from __future__ import annotations

import json
import statistics
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _lock, _now, _read

router = APIRouter(prefix="/api/machinery")
START = "__start__"


def configure() -> None:
    (ontology.DIR / "machinery").mkdir(parents=True, exist_ok=True)
    import ontology_edits

    if _on_edits not in ontology_edits.LISTENERS:
        ontology_edits.LISTENERS.append(_on_edits)


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


def _ts(v: Any) -> Optional[datetime]:
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------------------------------------
# resources
# ------------------------------------------------------------------------------------------------


class ProcessIn(BaseModel):
    id: str = Field(default_factory=lambda: f"proc-{uuid.uuid4().hex[:8]}")
    name: str = Field(min_length=1, max_length=200)
    object_type_id: str
    state_property: str
    # [{id: state value, label, x, y}]
    states: list[dict] = []
    # [{from, to}] (from may be "__start__")
    transitions: list[dict] = []
    # [{action_type_id, inputs: [state], outputs: [state], automation: bool, automation_id?}]
    actions: list[dict] = []
    # {object_type_id, link_type_id, changelog_dataset_id?, from_edits: bool}
    log: Optional[dict] = None
    # mined elements never to accept: ["state", "a->b"]
    excluded: list[str] = []
    parent: Optional[dict] = None  # {process_id, link_type_id}


class MachineryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    processes: list[ProcessIn] = []
    auto_layout: bool = True


def _check(rec: dict) -> None:
    ids = set()
    for p in rec["processes"]:
        if p["id"] in ids:
            raise HTTPException(400, "process ids must be unique")
        ids.add(p["id"])
        t = ontology._object_type(p["object_type_id"])
        prop = next((x for x in t["properties"] if x["api_name"] == p["state_property"]), None)
        if not prop or prop["type"] != "string" or prop.get("array"):
            raise HTTPException(400, f"{p['name']}: the state property must be a string property of {t['display_name']}")
        states = {s["id"] for s in p["states"]}
        for tr in p["transitions"]:
            if (tr.get("from") not in states and tr.get("from") != START) or tr.get("to") not in states:
                raise HTTPException(400, f"{p['name']}: a transition {tr.get('from')} → {tr.get('to')} connects states the process does not have")
        for a in p["actions"]:
            ontology._get("action-types", a.get("action_type_id", ""), "action type")
            for s in (a.get("inputs") or []) + (a.get("outputs") or []):
                if s not in states:
                    raise HTTPException(400, f"{p['name']}: the action connects the unknown state {s}")
    by_id = {p["id"]: p for p in rec["processes"]}
    for p in rec["processes"]:
        par = p.get("parent")
        if not par:
            continue
        parent = by_id.get(par.get("process_id") or "")
        if not parent or parent["id"] == p["id"]:
            raise HTTPException(400, f"{p['name']}: the parent process is not in this resource")
        _parent_direction(parent, p, par.get("link_type_id") or "")
        seen, cur = {p["id"]}, parent
        while cur.get("parent"):
            if cur["id"] in seen:
                raise HTTPException(400, f"{p['name']}: the process hierarchy has a cycle")
            seen.add(cur["id"])
            cur = by_id.get(cur["parent"].get("process_id") or "") or {}


def _parent_direction(parent: dict, child: dict, link_type_id: str) -> tuple[dict, str]:
    """The link type from the parent's object type to the child's, and the direction to follow from the parent."""
    import ontology_model as om

    for lt, direction in om.links_of(parent["object_type_id"]):
        if lt["id"] == link_type_id and om.side_of(lt, direction)[1]["object_type_id"] == child["object_type_id"]:
            return lt, direction
    raise HTTPException(400, f"{child['name']}: the link type does not connect the parent's object type to this one")


def _scope(rec: dict, p: dict, parent_states: Optional[list[str]] = None, keys: Optional[set[str]] = None,
           ancestors: Optional[dict[str, set[str]]] = None, descendants: Optional[dict[str, set[str]]] = None) -> Optional[set[str]]:
    """A subprocess' object set: the objects linked to its parent's objects (themselves scoped by the parent's parent);
    with parent states, only the children of parent objects currently in those states. None: a root process.
    keys: an input object set for the root process (the Workshop widget's input) — the root covers only those objects,
    and its subprocesses the objects linked to them.
    ancestors: {process id: primary keys} — that process (an ancestor, or this one) covers only those of its objects, and
    the processes under it the objects linked to them (the Workshop widget: a parent tab's selection narrows a
    subprocess tab; every ancestor given narrows, not only the nearest).
    descendants: {process id: primary keys} — a subprocess' selection carried up (the widget's "focus into a parent
    process"): a process above it covers only the objects those are linked to, through every level in between."""
    own = (ancestors or {}).get(p["id"])
    up_keys = _above(rec, p, descendants)
    if up_keys is not None:
        own = up_keys if own is None else set(own) & up_keys
    par = p.get("parent")
    if not par:
        if own is None:
            return keys
        return set(own) if keys is None else set(own) & keys
    import ontology_model as om

    parent = next(x for x in rec["processes"] if x["id"] == par["process_id"])
    lt, direction = _parent_direction(parent, p, par["link_type_id"])
    cur = _current(parent)
    up = _scope(rec, parent, None, keys, ancestors, descendants)
    pks = {pk for pk, st in cur.items() if (up is None or pk in up) and (not parent_states or st in parent_states)}
    linked = om.linked_map(lt, direction, pks)
    out = {c for cs in linked.values() for c in cs}
    return out if own is None else out & set(own)


def _chain(rec: dict, p: dict) -> list[dict]:
    """The process and its ancestors, nearest first (a broken or cyclic parent ends the chain)."""
    by_id = {x["id"]: x for x in rec["processes"]}
    out, seen = [p], {p["id"]}
    while (par := out[-1].get("parent")) and (nxt := by_id.get(par.get("process_id") or "")) and nxt["id"] not in seen:
        out.append(nxt)
        seen.add(nxt["id"])
    return out


def _above(rec: dict, p: dict, descendants: Optional[dict[str, set[str]]]) -> Optional[set[str]]:
    """The objects of p that the given descendants' objects sit under (each descendant's keys followed up its link types
    to p, intersected over the descendants); None: no descendant of p given. A descendant equal to p is not one."""
    if not descendants:
        return None
    import ontology_model as om

    out: Optional[set[str]] = None
    for did, ks in descendants.items():
        d = next((x for x in rec["processes"] if x["id"] == did), None)
        if not d or d["id"] == p["id"]:
            continue
        chain = _chain(rec, d)
        if p["id"] not in {x["id"] for x in chain}:
            continue
        cur = set(ks)
        for child, parent in zip(chain, chain[1:]):
            lt, direction = _parent_direction(parent, child, child["parent"]["link_type_id"])
            back = "reverse" if direction == "forward" else "forward"
            cur = {x for xs in om.linked_map(lt, back, cur).values() for x in xs}
            if parent["id"] == p["id"]:
                break
        out = cur if out is None else out & cur
    return out


def _all() -> list[dict]:
    return ontology._all("machinery")


def _get(mid: str) -> dict:
    return ontology._get("machinery", mid, "Machinery resource")


@router.get("")
def list_resources() -> list[dict]:
    return [{"id": r["id"], "name": r["name"], "description": r.get("description", ""), "processes": len(r["processes"]), "updated_at": r.get("updated_at")}
            for r in sorted(_all(), key=lambda r: r.get("updated_at", ""), reverse=True)]


@router.post("")
def create_resource(req: MachineryIn) -> dict:
    rec = {"id": f"mach-{uuid.uuid4().hex[:12]}", **req.model_dump(), "owner": _who(), "created_at": _now()}
    _check(rec)
    with _lock:
        return ontology._put("machinery", rec)


@router.get("/{mid}")
def get_resource(mid: str) -> dict:
    return _get(mid)


@router.put("/{mid}")
def save_resource(mid: str, req: MachineryIn) -> dict:
    with _lock:
        rec = _get(mid)
        new = {**rec, **req.model_dump()}
        # the log setup is kept unless the process is gone
        old_logs = {p["id"]: p.get("log") for p in rec["processes"]}
        for p in new["processes"]:
            p["log"] = p.get("log") or old_logs.get(p["id"])
        _check(new)
        return ontology._put("machinery", new)


@router.delete("/{mid}")
def delete_resource(mid: str) -> dict:
    with _lock:
        _get(mid)
        ontology._path("machinery", mid).unlink(missing_ok=True)
    return {"deleted": mid}


def _process(rec: dict, pid: str) -> dict:
    p = next((x for x in rec["processes"] if x["id"] == pid), None)
    if not p:
        raise HTTPException(404, "process not found")
    return p


# ------------------------------------------------------------------------------------------------
# actions
# ------------------------------------------------------------------------------------------------


@router.get("/{mid}/processes/{pid}/actions")
def importable_actions(mid: str, pid: str) -> list[dict]:
    """Action types and automations on the process object type, with the output states their rules write."""
    p = _process(_get(mid), pid)
    out = []
    for a in ontology._all("action-types"):
        if a.get("object_type_id") != p["object_type_id"]:
            continue
        outputs = []
        for r in a.get("rules") or []:
            ref = (r.get("properties") or {}).get(p["state_property"])
            if r.get("kind") in ("modify_object", "create_object", "create_or_modify_object") and isinstance(ref, dict) and ref.get("kind") == "static":
                outputs.append(str(ref.get("value")))
        writes = any(x.get("property") == p["state_property"] for x in a.get("parameters") or []) or bool(outputs)
        if writes:
            out.append({"action_type_id": a["id"], "name": a["display_name"], "outputs": outputs, "automation": False})
    for au in ontology._all("automations"):
        eff = au.get("effect") or {}
        if (au.get("condition") or {}).get("object_type_id") == p["object_type_id"] and eff.get("action_type_id"):
            out.append({"action_type_id": eff["action_type_id"], "automation_id": au["id"], "name": au.get("name", "Automation"), "outputs": [], "automation": True})
    return out


# ------------------------------------------------------------------------------------------------
# process log
# ------------------------------------------------------------------------------------------------


LOG_PROPS = [("logId", "Log ID", "string"), ("processId", "Process ID", "string"), ("oldState", "Old state", "string"),
             ("newState", "New state", "string"), ("timestamp", "Timestamp", "timestamp"), ("isLatest", "Is latest", "boolean"),
             ("duration", "Duration (ms)", "long"), ("path", "Path", "string"), ("actionTypeRid", "Action type RID", "string")]


class LogSetupIn(BaseModel):
    changelog_dataset_id: Optional[str] = None
    from_edits: bool = True


@router.post("/{mid}/processes/{pid}/log")
def setup_log(mid: str, pid: str, req: LogSetupIn) -> dict:
    """Create (or reconfigure) the process's log object type and build it from its sources."""
    with _lock:
        rec = _get(mid)
        p = _process(rec, pid)
        t = ontology._object_type(p["object_type_id"])
        log = p.get("log") or {}
        if not log.get("object_type_id"):
            # one log object type per tracked property: reuse the one another process already keeps
            shared = next((q.get("log") for r in _all() for q in r["processes"] if q.get("log") and q["object_type_id"] == p["object_type_id"]
                           and q["state_property"] == p["state_property"]), None)
            if shared:
                log = {"object_type_id": shared["object_type_id"], "link_type_id": shared["link_type_id"]}
        lt_type = next((x for x in ontology._all("object-types") if x["id"] == log.get("object_type_id")), None)
    if not lt_type:
        name = f"{t['display_name'].replace(' (demo)', '').replace(' (test)', '')} {p['state_property']} log"
        suffix = " (demo)" if "(demo)" in t["display_name"] else " (test)" if "(test)" in t["display_name"] else ""
        lt_type = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=f"{name}{suffix}", api_name=f"{ontology._api_name(t['api_name'] + 'Log' + p['state_property'], True)[:90]}{uuid.uuid4().hex[:4]}",
            primary_key="logId", title_property="logId",
            description=f"Machinery process log: changes of {t['display_name']}.{p['state_property']}. Maintained by Machinery: do not edit it with actions.",
            properties=[ontology.Property(api_name=a, display_name=d, type=ty) for a, d, ty in LOG_PROPS]))
        link = om.create_link_type(om.LinkTypeIn(
            display_name=f"{t['display_name']} log", kind="foreign_key", cardinality="many_to_one", foreign_key="processId",
            source=om.LinkSide(object_type_id=lt_type["id"], display_name="Log entries", plural_display_name="Log entries"),
            target=om.LinkSide(object_type_id=t["id"], display_name=t["display_name"])))
        log = {"object_type_id": lt_type["id"], "link_type_id": link["id"]}
    if req.changelog_dataset_id:
        import ontology_datasources

        _, cols, _rows = ontology_datasources._read(req.changelog_dataset_id)
        names = {c["name"] for c in cols}
        missing = {"processId", "state", "timestamp"} - names
        if missing:
            raise HTTPException(400, f"the changelog dataset needs the columns processId, state and timestamp (missing {', '.join(sorted(missing))})")
    log.update({"changelog_dataset_id": req.changelog_dataset_id, "from_edits": req.from_edits})
    with _lock:
        rec = _get(mid)
        _process(rec, pid)["log"] = log
        ontology._put("machinery", rec)
    return {**log, **rebuild_log(mid, pid)}


def _entries_from_sources(p: dict) -> list[dict]:
    """State changes (processId, state, timestamp, action) from the changelog dataset and the edit history."""
    log = p.get("log") or {}
    out: list[dict] = []
    if log.get("changelog_dataset_id"):
        import ontology_datasources

        _, _, rows = ontology_datasources._read(log["changelog_dataset_id"])
        for r in rows:
            at = _ts(r.get("timestamp"))
            if r.get("processId") in (None, "") or at is None:
                continue
            out.append({"process": str(r["processId"]), "state": None if r.get("isDeleted") else (None if r.get("state") is None else str(r["state"])),
                        "at": at, "action": None, "deleted": bool(r.get("isDeleted"))})
    if log.get("from_edits"):
        import ontology_edits

        hist = _read(ontology_edits._history_path(p["object_type_id"]), {}) or {}
        for pk, entries in hist.items():
            for e in entries:
                ch = (e.get("changes") or {}).get(p["state_property"])
                if ch is None or e["op"] == "delete":
                    continue
                out.append({"process": str(pk), "state": ch[1], "at": _ts(e["at"]), "action": e.get("action"), "deleted": False})
    return out


def _compute(entries: list[dict]) -> dict[str, dict]:
    """Log objects from state changes: per process in time order, with old state, duration, path and isLatest."""
    by: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        by[e["process"]].append(e)
    objs: dict[str, dict] = {}
    for proc, es in by.items():
        es.sort(key=lambda e: e["at"])
        prev_state, prev_at, path = None, None, []
        rows = []
        for e in es:
            if e["deleted"] or e["state"] is None or e["state"] == prev_state:
                continue
            path.append(e["state"])
            rows.append({"oldState": prev_state, "newState": e["state"], "timestamp": e["at"].isoformat(timespec="seconds"),
                         "duration": int((e["at"] - prev_at).total_seconds() * 1000) if prev_at else None, "path": json.dumps(path),
                         "actionTypeRid": e.get("action")})
            prev_state, prev_at = e["state"], e["at"]
        for i, r in enumerate(rows):
            lid = f"{proc}#{i + 1}"
            objs[lid] = {"properties": {"logId": lid, "processId": proc, **r, "isLatest": i == len(rows) - 1}, "created_at": r["timestamp"], "updated_at": r["timestamp"]}
    return objs


def rebuild_log(mid: str, pid: str) -> dict:
    p = _process(_get(mid), pid)
    log = p.get("log")
    if not log:
        raise HTTPException(400, f"{p['name']} has no process log: set it up first")
    objs = _compute(_entries_from_sources(p))
    with _lock:
        ontology.save_objects(log["object_type_id"], objs)
    ontology._hook("indexed", log["object_type_id"], len(objs))
    return {"log_entries": len(objs), "processes": len({o["properties"]["processId"] for o in objs.values()})}


@router.post("/{mid}/processes/{pid}/log/rebuild")
def rebuild_route(mid: str, pid: str) -> dict:
    return rebuild_log(mid, pid)


def _on_edits(records: list[dict], who: str, now: str) -> None:
    """Live log entries: a platform edit that changes a process's state property appends to its log."""
    if ontology.SCENARIO.get():
        return
    # processes tracking the same property share one log object type (setup_log): each edit is logged in it once
    logged: set[tuple[str, int]] = set()
    for rec in _all():
        for p in rec["processes"]:
            log = p.get("log") or {}
            if not log.get("from_edits") or not log.get("object_type_id"):
                continue
            for i, r in enumerate(records):
                if r["object_type_id"] != p["object_type_id"] or r["op"] == "delete":
                    continue
                if p["state_property"] not in (r.get("changed") or {}):
                    continue
                old = (r.get("before") or {}).get(p["state_property"])
                new = (r.get("after") or {}).get(p["state_property"])
                if new is None or old == new:
                    continue
                if (log["object_type_id"], i) in logged:
                    continue
                logged.add((log["object_type_id"], i))
                objs = ontology.load_objects(log["object_type_id"])
                mine = sorted((o for o in objs.values() if o["properties"]["processId"] == str(r["primary_key"])), key=lambda o: o["properties"]["timestamp"])
                last = mine[-1]["properties"] if mine else None
                at = _ts(now)
                for o in mine:
                    o["properties"]["isLatest"] = False
                trail = (json.loads(last["path"]) if last else []) + [new]
                lid = f"{r['primary_key']}#{len(mine) + 1}"
                objs[lid] = {"properties": {"logId": lid, "processId": str(r["primary_key"]), "oldState": old, "newState": new, "timestamp": now,
                                            "duration": int((at - _ts(last["timestamp"])).total_seconds() * 1000) if last and at else None,
                                            "path": json.dumps(trail), "isLatest": True, "actionTypeRid": None}, "created_at": now, "updated_at": now}
                ontology.save_objects(log["object_type_id"], objs)


# ------------------------------------------------------------------------------------------------
# mining and monitoring
# ------------------------------------------------------------------------------------------------


def _log_rows(p: dict) -> list[dict]:
    log = p.get("log") or {}
    if not log.get("object_type_id"):
        return []
    return [o["properties"] for o in ontology.load_objects(log["object_type_id"]).values()]


def _current(p: dict) -> dict[str, Optional[str]]:
    """The objects in the process and their current state. An object whose state property is empty is not in the process
    (for example a device without the telemetry that gives it a state): it is neither counted nor a deviation."""
    t = ontology._object_type(p["object_type_id"])
    return {pk: st for pk, o in ontology._objects(t["id"]).items()
            if ontology._can_see(t, o) and (st := (o.get("properties") or {}).get(p["state_property"])) not in (None, "")}


class MineIn(BaseModel):
    source: Literal["log", "objects", "both"] = "both"
    elements: Literal["states", "transitions", "both"] = "both"
    keep_percent: float = Field(100, ge=1, le=100)


@router.post("/{mid}/processes/{pid}/mine")
def mine(mid: str, pid: str, req: MineIn) -> dict:
    """States and transitions as they occur in the data, filtered, against the process definition."""
    p = _process(_get(mid), pid)
    excluded = set(p.get("excluded") or [])
    states: Counter = Counter()
    trans: Counter = Counter()
    if req.source in ("log", "both"):
        for r in _log_rows(p):
            states[r["newState"]] += 1
            trans[(r.get("oldState") or START, r["newState"])] += 1
    if req.source in ("objects", "both") or not states:
        for v in _current(p).values():
            if v not in (None, "") and (req.source == "objects" or v not in states):
                states[v] += 1
    # transition filter: the most frequent transitions up to keep_percent of all occurrences
    total = sum(trans.values()) or 1
    kept, acc = [], 0
    for tr, n in trans.most_common():
        if acc / total * 100 >= req.keep_percent:
            break
        kept.append((tr, n))
        acc += n
    defined_states = {s["id"] for s in p["states"]}
    defined_trans = {(t["from"], t["to"]) for t in p["transitions"]}
    out_states = [{"id": s, "count": n, "status": "existing" if s in defined_states else "new"} for s, n in states.most_common()
                  if s not in excluded] if req.elements != "transitions" else []
    out_trans = [{"from": a, "to": b, "count": n, "status": "existing" if (a, b) in defined_trans else "new"} for (a, b), n in kept
                 if f"{a}->{b}" not in excluded and a not in excluded and b not in excluded] if req.elements != "states" else []
    unused_states = [s for s in defined_states if s not in states]
    unused_trans = [{"from": a, "to": b} for a, b in defined_trans if (a, b) not in trans]
    return {"states": out_states, "transitions": out_trans, "unused_states": unused_states, "unused_transitions": unused_trans,
            "transitions_total": sum(trans.values()), "transitions_kept": acc}


class AcceptIn(BaseModel):
    states: list[str] = []
    transitions: list[dict] = []
    exclude: list[str] = []


@router.post("/{mid}/processes/{pid}/mine/accept")
def accept(mid: str, pid: str, req: AcceptIn) -> dict:
    """Add mined states and transitions to the definition (and remember excluded elements)."""
    with _lock:
        rec = _get(mid)
        p = _process(rec, pid)
        have = {s["id"] for s in p["states"]}
        for s in req.states:
            if s not in have:
                p["states"].append({"id": s, "label": s})
                have.add(s)
        trans = {(t["from"], t["to"]) for t in p["transitions"]}
        for t in req.transitions:
            pair = (t["from"], t["to"])
            if pair not in trans and (pair[0] in have or pair[0] == START) and pair[1] in have:
                p["transitions"].append({"from": pair[0], "to": pair[1]})
                trans.add(pair)
        p["excluded"] = sorted(set(p.get("excluded") or []) | set(req.exclude))
        _check(rec)
        return ontology._put("machinery", rec)


def _paths(p: dict) -> dict[str, list[dict]]:
    by: dict[str, list[dict]] = defaultdict(list)
    for r in _log_rows(p):
        by[r["processId"]].append(r)
    for rs in by.values():
        rs.sort(key=lambda r: r["timestamp"])
    return by


@router.get("/{mid}/hierarchy")
def hierarchy(mid: str) -> list[dict]:
    """The process tree: each process with its parent, its object count and, for a subprocess, how many of its
    objects sit under each state of the parent."""
    rec = _get(mid)
    out = []
    for p in rec["processes"]:
        scope = _scope(rec, p)
        cur = {pk: st for pk, st in _current(p).items() if scope is None or pk in scope}
        row = {"id": p["id"], "name": p["name"], "parent": (p.get("parent") or {}).get("process_id"), "objects": len(cur),
               "children": [c["id"] for c in rec["processes"] if (c.get("parent") or {}).get("process_id") == p["id"]]}
        if p.get("parent"):
            parent = next(x for x in rec["processes"] if x["id"] == p["parent"]["process_id"])
            row["by_parent_state"] = {st["id"]: len((_scope(rec, p, [st["id"]]) or set()) & set(cur)) for st in parent["states"]}
        out.append(row)
    return out


@router.get("/{mid}/processes/{pid}/metrics")
def metrics(mid: str, pid: str, include_deviations: bool = False, parent_states: Optional[str] = None) -> dict:
    """Current / historical counts and durations per state, transitions, paths and conformance; a subprocess covers the
    objects linked to its parent's (parent_states: only under parent objects in those states, comma-separated)."""
    return _metrics(mid, pid, include_deviations, [x for x in (parent_states or "").split(",") if x], None)


class AggregateIn(BaseModel):
    """A property aggregate shown as a custom metric (the Workshop Machinery widget's custom metric views): over the
    objects currently in a state (for a transition: whose last transition it is) or ever in it (ever through it)."""
    id: str = Field(min_length=1, max_length=100)
    property: str = Field(min_length=1, max_length=200)
    fn: Literal["sum", "mean", "median", "min", "max", "count", "distinct"] = "sum"
    scope: Literal["current", "ever"] = "current"


class MetricsIn(BaseModel):
    include_deviations: bool = False
    parent_states: list[str] = []
    # an input object set for the root process (primary keys): the metrics cover only those objects
    keys: Optional[list[str]] = Field(None, max_length=200_000)
    aggregates: list[AggregateIn] = Field([], max_length=20)
    # a widget showing several processes sends every view's aggregates: one whose property this process' object type
    # lacks (or that needs a number) gives no values and is named under "invalid_aggregates" instead of a 400
    skip_invalid: bool = False
    # {ancestor process id: its primary keys}: only the objects under those (a parent tab's selection in the widget)
    ancestor_keys: Optional[dict[str, list[str]]] = None
    # {descendant process id: its primary keys}: only the objects those sit under (a subprocess' selection carried up
    # when the widget focuses into a parent process)
    descendant_keys: Optional[dict[str, list[str]]] = None


def _anc(v: Optional[dict[str, list[str]]], name: str = "ancestor_keys") -> Optional[dict[str, set[str]]]:
    if not v:
        return None
    if sum(len(x) for x in v.values()) > 200_000:
        raise HTTPException(400, f"{name}: at most 200,000 primary keys")
    return {k: set(x) for k, x in v.items()}


def _desc(v: Optional[dict[str, list[str]]]) -> Optional[dict[str, set[str]]]:
    return _anc(v, "descendant_keys")


@router.post("/{mid}/processes/{pid}/metrics")
def metrics_of(mid: str, pid: str, req: MetricsIn) -> dict:
    """The metrics over an input object set (the Workshop Machinery widget's input): the root process covers only the
    objects in `keys`, a subprocess the objects linked to them; with property aggregates per state and transition."""
    return _metrics(mid, pid, req.include_deviations, req.parent_states, None if req.keys is None else set(req.keys),
                    [a.model_dump() for a in req.aggregates], req.skip_invalid, _anc(req.ancestor_keys), _desc(req.descendant_keys))


NUMERIC = {"integer", "long", "short", "byte", "double", "float", "decimal"}


def _conforming(p: dict, by: dict[str, list[dict]], current: dict[str, Optional[str]]) -> set[str]:
    """Objects whose path uses only defined states and transitions (an object without a log: its state is defined)."""
    defined_states = {s["id"] for s in p["states"]}
    defined_trans = {(t["from"], t["to"]) for t in p["transitions"]}
    conforming = set()
    for proc, rs in by.items():
        ok = all(r["newState"] in defined_states and ((r.get("oldState") or START), r["newState"]) in defined_trans | {(START, r["newState"])} for r in rs)
        if ok:
            conforming.add(proc)
    for pk, st in current.items():
        if pk not in by and st in defined_states:
            conforming.add(pk)
    return conforming


def _aggregator(p: dict, aggregates: list[dict], invalid: Optional[dict[str, str]] = None):
    """A function (aggregate, objects) -> value over the visible objects' property values; checks the properties
    (a bad one: 400, or — given `invalid` — recorded there by aggregate id and valued None)."""
    t = ontology._object_type(p["object_type_id"])
    types = {x["api_name"]: x for x in t["properties"]}
    bad: dict[str, str] = {}
    for a in aggregates:
        prop = types.get(a["property"])
        if not prop:
            bad[a["id"]] = f"{t['display_name']} has no property {a['property']}"
        elif a["fn"] not in ("count", "distinct") and (prop["type"] not in NUMERIC or prop.get("array")):
            bad[a["id"]] = f"{a['fn']} needs a numeric property ({a['property']} is {prop['type']})"
    if bad and invalid is None:
        raise HTTPException(400, next(iter(bad.values())))
    if invalid is not None:
        invalid.update(bad)
    objs = {pk: o for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(t, o)} if len(bad) < len(aggregates) else {}

    def run(a: dict, members) -> Optional[float]:
        if a["id"] in bad:
            return None
        vals = [v for pk in members if pk in objs and (v := (objs[pk].get("properties") or {}).get(a["property"])) not in (None, "")]
        if a["fn"] == "count":
            return len(vals)
        if a["fn"] == "distinct":
            return len({json.dumps(v, sort_keys=True, default=str) for v in vals})
        nums = []
        for v in vals:
            try:
                nums.append(float(v))
            except (TypeError, ValueError):
                continue
        if not nums:
            return None
        if a["fn"] == "sum":
            return sum(nums)
        if a["fn"] == "mean":
            return sum(nums) / len(nums)
        if a["fn"] == "median":
            return statistics.median(nums)
        return min(nums) if a["fn"] == "min" else max(nums)

    return run


def _covers(a: dict) -> set[tuple]:
    """The state transitions an action stands for: each input state to each other output state."""
    return {(i, o) for i in a.get("inputs") or [] for o in a.get("outputs") or [] if i != o}


def _action_metrics(p: dict, by: dict[str, list[dict]], use: set[str]) -> list[dict]:
    """The Workshop widget's transition nodes: per action of the process (in order), the log entries it caused — those
    whose action type RID is the action's; an entry without a RID counts for every action that covers its transition
    (an input state to an output state) — with their objects, durations and the counts per input and output state."""
    names = {a["id"]: a.get("display_name") for a in ontology._all("action-types")} if p.get("actions") else {}
    defined = {(t["from"], t["to"]) for t in p["transitions"]}
    out = []
    for i, a in enumerate(p.get("actions") or []):
        cov = _covers(a)
        rows: list[tuple[str, dict]] = []
        for proc, rs in by.items():
            if proc not in use:
                continue
            for r in rs:
                tr = ((r.get("oldState") or START), r["newState"])
                rid = r.get("actionTypeRid")
                if (rid and rid == a.get("action_type_id")) or (not rid and tr in cov):
                    rows.append((proc, r))
        ds = [(r.get("duration") or 0) / 1000 for _, r in rows]
        tcount: Counter = Counter(((r.get("oldState") or START), r["newState"]) for _, r in rows)
        out.append({
            "index": i, "action_type_id": a.get("action_type_id"), "automation": bool(a.get("automation")),
            "name": names.get(a.get("action_type_id")) or a.get("action_type_id"),
            "inputs": list(a.get("inputs") or []), "outputs": list(a.get("outputs") or []),
            "count": len(rows), "objects": len({proc for proc, _ in rows}),
            "mean_duration_s": (sum(ds) / len(ds)) if ds else None, "median_duration_s": statistics.median(ds) if ds else None,
            "by_input": dict(Counter(r.get("oldState") or START for _, r in rows)), "by_output": dict(Counter(r["newState"] for _, r in rows)),
            # the transitions it stands for: defined ones it covers and every one its entries took
            "transitions": [{"from": f, "to": t, "count": tcount[(f, t)]} for f, t in sorted((cov & defined) | set(tcount), key=lambda x: (-tcount[x], x))],
        })
    return out


def _metrics(mid: str, pid: str, include_deviations: bool, parent_states: list[str], keys: Optional[set[str]],
             aggregates: Optional[list[dict]] = None, skip_invalid: bool = False, ancestors: Optional[dict[str, set[str]]] = None,
             descendants: Optional[dict[str, set[str]]] = None) -> dict:
    rec = _get(mid)
    p = _process(rec, pid)
    now = datetime.now(timezone.utc)
    defined_states = {s["id"] for s in p["states"]}
    defined_trans = {(t["from"], t["to"]) for t in p["transitions"]}
    scope = _scope(rec, p, parent_states or None, keys, ancestors, descendants)
    by = {k: v for k, v in _paths(p).items() if scope is None or k in scope}
    current = {k: v for k, v in _current(p).items() if scope is None or k in scope}
    conforming = _conforming(p, by, current)
    use = (set(current) | set(by)) if include_deviations else conforming
    hist_count: Counter = Counter()
    durations: dict[str, list[float]] = defaultdict(list)
    trans: dict[tuple, list[float]] = defaultdict(list)
    path_counts: Counter = Counter()
    entered: dict[str, datetime] = {}
    # distinct objects ever in a state / through a transition, and each object's last transition
    ever: dict[str, set] = defaultdict(set)
    through: dict[tuple, set] = defaultdict(set)
    last: dict[tuple, set] = defaultdict(set)
    for proc, rs in by.items():
        if proc not in use:
            continue
        for i, r in enumerate(rs):
            hist_count[r["newState"]] += 1
            tr = ((r.get("oldState") or START), r["newState"])
            trans[tr].append((r.get("duration") or 0) / 1000)
            ever[r["newState"]].add(proc)
            through[tr].add(proc)
            if i + 1 < len(rs):
                d = (_ts(rs[i + 1]["timestamp"]) - _ts(r["timestamp"])).total_seconds()
                durations[r["newState"]].append(d)
        if rs:
            path_counts[tuple(json.loads(rs[-1]["path"]))] += 1
            entered[proc] = _ts(rs[-1]["timestamp"])
            last[((rs[-1].get("oldState") or START), rs[-1]["newState"])].add(proc)
    cur_count: Counter = Counter()
    cur_dur: dict[str, list[float]] = defaultdict(list)
    members: dict[str, set] = defaultdict(set)
    for pk, st in current.items():
        if pk not in use or st in (None, ""):
            continue
        cur_count[st] += 1
        members[st].add(pk)
        ever[st].add(pk)
        if pk in entered:
            cur_dur[st].append((now - entered[pk]).total_seconds())
    mean = lambda xs: (sum(xs) / len(xs)) if xs else None  # noqa: E731
    median = lambda xs: statistics.median(xs) if xs else None  # noqa: E731
    states = sorted(set(defined_states) | set(cur_count) | set(hist_count))
    aggregates = aggregates or []
    invalid: Optional[dict[str, str]] = {} if skip_invalid else None
    agg = _aggregator(p, aggregates, invalid)
    n_cur = sum(cur_count.values())
    n_use = len(use & (set(current) | set(by)))
    share = lambda n, d: (n / d) if d else None  # noqa: E731
    return {
        "objects": len(current), "conforming": len(conforming & (set(current) | set(by))), "deviating": len((set(current) | set(by)) - conforming),
        "states": [{"id": s, "defined": s in defined_states, "current_count": cur_count[s], "historical_count": hist_count[s],
                    "current_duration_s": mean(cur_dur[s]), "historical_duration_s": mean(durations[s]),
                    # custom metric views: medians, distinct objects ever in the state, shares (0..1)
                    "median_current_duration_s": median(cur_dur[s]), "median_historical_duration_s": median(durations[s]),
                    "ever_count": len(ever[s]), "current_share": share(cur_count[s], n_cur), "historical_share": share(len(ever[s]), n_use),
                    **({"aggregates": {a["id"]: agg(a, members[s] if a["scope"] == "current" else ever[s]) for a in aggregates}} if aggregates else {})}
                   for s in states],
        "transitions": [{"from": a, "to": b, "count": len(ds), "mean_duration_s": mean(ds), "defined": (a, b) in defined_trans,
                         "median_duration_s": median(ds), "objects": len(through[(a, b)]), "share": share(len(through[(a, b)]), n_use),
                         **({"aggregates": {x["id"]: agg(x, last[(a, b)] if x["scope"] == "current" else through[(a, b)]) for x in aggregates}} if aggregates else {})}
                        for (a, b), ds in sorted(trans.items(), key=lambda kv: -len(kv[1]))],
        "paths": [{"path": list(path), "count": n} for path, n in path_counts.most_common(50)],
        "actions": _action_metrics(p, by, use),
        **({"invalid_aggregates": invalid} if invalid else {}),
    }


def _object_paths(by: dict[str, list[dict]], current: dict[str, Optional[str]]) -> dict[str, tuple[tuple, Optional[float]]]:
    """Each object's path (the states it entered, in order) and how long it took: from its first log entry to its
    last. An object in the process without log entries has the path of its current state alone (no duration)."""
    out: dict[str, tuple[tuple, Optional[float]]] = {}
    for proc, rs in by.items():
        if rs:
            out[proc] = (tuple(json.loads(rs[-1]["path"])), (_ts(rs[-1]["timestamp"]) - _ts(rs[0]["timestamp"])).total_seconds())
    for pk, st in current.items():
        if pk not in out and st not in (None, ""):
            out[pk] = ((st,), None)
    return out


class PathsIn(BaseModel):
    include_deviations: bool = False
    parent_states: list[str] = []
    keys: Optional[list[str]] = Field(None, max_length=200_000)
    limit: int = Field(100, ge=1, le=1000)
    ancestor_keys: Optional[dict[str, list[str]]] = None
    descendant_keys: Optional[dict[str, list[str]]] = None


@router.post("/{mid}/processes/{pid}/paths")
def path_explorer(mid: str, pid: str, req: PathsIn) -> dict:
    """The path explorer: the paths (variants) the objects in the process took, the most frequent first, with how many
    objects took each, their share and the time from the first state to the last (mean, median, min, max). Covers the
    objects now in the process (conforming ones unless deviations are included), as the output object set does."""
    rec = _get(mid)
    p = _process(rec, pid)
    scope = _scope(rec, p, req.parent_states or None, None if req.keys is None else set(req.keys), _anc(req.ancestor_keys), _desc(req.descendant_keys))
    by = {k: v for k, v in _paths(p).items() if scope is None or k in scope}
    current = {k: v for k, v in _current(p).items() if scope is None or k in scope}
    conforming = _conforming(p, by, current)
    paths = {pk: v for pk, v in _object_paths(by, current).items() if pk in current and (req.include_deviations or pk in conforming)}
    groups: dict[tuple, list] = defaultdict(list)
    for pk, (path, d) in paths.items():
        groups[path].append((pk, d))
    rows = []
    for path, xs in sorted(groups.items(), key=lambda kv: (-len(kv[1]), len(kv[0]), kv[0])):
        ds = [d for _, d in xs if d is not None]
        rows.append({"path": list(path), "count": len(xs), "share": len(xs) / len(paths), "conforming": all(pk in conforming for pk, _ in xs),
                     "logged": len(ds), "mean_duration_s": (sum(ds) / len(ds)) if ds else None, "median_duration_s": statistics.median(ds) if ds else None,
                     "min_duration_s": min(ds) if ds else None, "max_duration_s": max(ds) if ds else None})
    return {"objects": len(paths), "variants": len(rows), "paths": rows[: req.limit], "truncated": len(rows) > req.limit}


@router.get("/{mid}/processes/{pid}/durations")
def duration_distribution(mid: str, pid: str, state: str, buckets: int = 10) -> dict:
    """How long objects stayed in a state (historical stays), as a histogram in hours."""
    p = _process(_get(mid), pid)
    vals = []
    for rs in _paths(p).values():
        for i, r in enumerate(rs[:-1]):
            if r["newState"] == state:
                vals.append((_ts(rs[i + 1]["timestamp"]) - _ts(r["timestamp"])).total_seconds() / 3600)
    if not vals:
        return {"state": state, "buckets": [], "count": 0}
    lo, hi = min(vals), max(vals)
    n = max(1, min(buckets, 30))
    w = (hi - lo) / n if hi > lo else 1
    counts = [0] * n
    for v in vals:
        counts[min(n - 1, int((v - lo) / w)) if hi > lo else 0] += 1
    return {"state": state, "count": len(vals), "buckets": [{"from_h": lo + i * w, "to_h": lo + (i + 1) * w, "count": c} for i, c in enumerate(counts)]}


class OutputIn(BaseModel):
    states: list[str] = []
    mode: Literal["current", "ever"] = "current"
    transitions: list[dict] = []  # [{from, to}]: objects that went through any of them
    path: Optional[list[str]] = None
    # the path explorer's selection: objects that took any of these paths (as POST …/paths lists them)
    paths: list[list[str]] = Field([], max_length=1000)
    parent_states: list[str] = []  # a subprocess: only under parent objects in these states
    limit: int = Field(500, ge=1, le=5000)
    # transitions: objects that ever went through one of them, or only those whose last transition is one of them
    transition_mode: Literal["ever", "last"] = "ever"
    # an input object set for the root process (primary keys): only those objects (and, for a subprocess, their children)
    keys: Optional[list[str]] = Field(None, max_length=200_000)
    # the primary keys alone (up to 50,000) instead of the objects: what a Workshop object set variable holds
    keys_only: bool = False
    ancestor_keys: Optional[dict[str, list[str]]] = None
    descendant_keys: Optional[dict[str, list[str]]] = None
    # the duration distribution's selected buckets: objects with a duration (of the selection, as POST …/distribution
    # measures it) of at least min_s and less than max_s seconds (either bound may be left out)
    duration: Optional[dict[str, Optional[float]]] = None
    # the time current durations are measured up to (ISO; default now): the distribution's "now", so that the output
    # holds exactly the objects counted in the selected buckets
    now: Optional[str] = None


def _select(by: dict[str, list[dict]], current: dict[str, Optional[str]], states: list[str], mode: str,
            transitions: list[dict], transition_mode: str) -> set[str]:
    """The objects of a graph selection: in the states (currently / ever) and through the transitions (ever / last)."""
    keys: set[str] = set(current)
    if transitions and transition_mode == "last":
        want_last = {(t["from"], t["to"]) for t in transitions}
        keys &= {proc for proc, rs in by.items() if rs and ((rs[-1].get("oldState") or START), rs[-1]["newState"]) in want_last}
    if states:
        if mode == "current":
            keys &= {pk for pk, st in current.items() if st in states}
        else:
            ever = {proc for proc, rs in by.items() if any(r["newState"] in states for r in rs)}
            keys &= ever | {pk for pk, st in current.items() if st in states}
    if transitions and transition_mode == "ever":
        want = {(t["from"], t["to"]) for t in transitions}
        keys &= {proc for proc, rs in by.items() if any(((r.get("oldState") or START), r["newState"]) in want for r in rs)}
    return keys


def _measure(by: dict[str, list[dict]], current: dict[str, Optional[str]], keys: set[str], states: list[str], mode: str,
             transitions: list[dict], transition_mode: str, now: datetime) -> list[tuple[str, float]]:
    """The durations (object, seconds) of a selection's objects, as the duration distribution shows them:
    - nothing selected: each object's time from its first state to its last (as the path explorer measures it);
    - states, node selection "currently in": how long the objects now in them have been there (up to `now`; the
      metrics' current duration); "ever in": every completed stay in them (the metrics' historical duration);
    - transitions: the time from entering the transition's first state to entering its second, for every time an
      object went through one (edge selection "ever") or for its last transition only ("last"). A transition from the
      start has no duration.
    Both states and transitions selected: the durations of both."""
    out: list[tuple[str, float]] = []
    if not states and not transitions:
        for pk in sorted(keys):
            rs = by.get(pk)
            if rs:
                out.append((pk, (_ts(rs[-1]["timestamp"]) - _ts(rs[0]["timestamp"])).total_seconds()))
        return out
    want = {(t["from"], t["to"]) for t in transitions}
    for pk in sorted(keys):
        rs = by.get(pk) or []
        if states and mode == "current":
            if current.get(pk) in states and rs:
                out.append((pk, (now - _ts(rs[-1]["timestamp"])).total_seconds()))
        elif states:
            for i, r in enumerate(rs[:-1]):
                if r["newState"] in states:
                    out.append((pk, (_ts(rs[i + 1]["timestamp"]) - _ts(r["timestamp"])).total_seconds()))
        for r in (rs[-1:] if transition_mode == "last" else rs) if want else []:
            if ((r.get("oldState") or START), r["newState"]) in want and r.get("duration") is not None:
                out.append((pk, r["duration"] / 1000))
    return out


def _percentile(xs: list[float], q: float) -> float:
    """Linear interpolation between the closest ranks (xs sorted)."""
    pos = (len(xs) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def _edges(lo: float, hi: float, n: int) -> list[float]:
    """Bucket edges (n + 1 of them): equal widths from the smallest duration to the largest."""
    if hi <= lo:
        return [lo, lo + 1]
    w = (hi - lo) / n
    return [lo + i * w for i in range(n)] + [hi]


def _in_range(v: float, rng: dict) -> bool:
    lo, hi = rng.get("min_s"), rng.get("max_s")
    return (lo is None or v >= lo) and (hi is None or v < hi)


@router.post("/{mid}/processes/{pid}/output")
def output(mid: str, pid: str, req: OutputIn) -> dict:
    """The output object set for a selection: states (currently in / ever in), transitions or a path; with a duration
    range (the duration distribution's selected buckets), only the objects with a duration of the selection in it."""
    rec = _get(mid)
    p = _process(rec, pid)
    scope = _scope(rec, p, req.parent_states or None, None if req.keys is None else set(req.keys), _anc(req.ancestor_keys), _desc(req.descendant_keys))
    by = {k: v for k, v in _paths(p).items() if scope is None or k in scope}
    current = {k: v for k, v in _current(p).items() if scope is None or k in scope}
    keys = _select(by, current, req.states, req.mode, req.transitions, req.transition_mode)
    if req.duration is not None:  # a bucket range (no bounds: every object with a duration of the selection)
        now = _ts(req.now) or datetime.now(timezone.utc)
        keys = {pk for pk, v in _measure(by, current, keys, req.states, req.mode, req.transitions, req.transition_mode, now) if _in_range(v, req.duration)}
    if req.path:
        keys &= {proc for proc, rs in by.items() if rs and json.loads(rs[-1]["path"]) == req.path}
    if req.paths:
        want_paths = {tuple(x) for x in req.paths}
        keys &= {pk for pk, (path, _) in _object_paths(by, current).items() if path in want_paths}
    t = ontology._object_type(p["object_type_id"])
    objs = ontology._objects(t["id"])
    if req.keys_only:
        return {"object_type_id": t["id"], "total": len(keys), "keys": sorted(keys)[:50_000]}
    rows = [ontology._public_object(t, pk, objs[pk]) for pk in sorted(keys)[: req.limit] if pk in objs]
    return {"object_type_id": t["id"], "total": len(keys), "objects": rows}


class DistributionIn(BaseModel):
    """The duration distribution of the Workshop Machinery widget: the durations of the graph selection (as the output
    route selects its objects; see _measure for what is measured) as a histogram with percentiles."""
    states: list[str] = []
    mode: Literal["current", "ever"] = "current"
    transitions: list[dict] = []
    transition_mode: Literal["ever", "last"] = "ever"
    parent_states: list[str] = []
    keys: Optional[list[str]] = Field(None, max_length=200_000)
    ancestor_keys: Optional[dict[str, list[str]]] = None
    descendant_keys: Optional[dict[str, list[str]]] = None
    buckets: int = Field(20, ge=1, le=60)
    now: Optional[str] = None


PERCENTILES = [("p25", 0.25), ("p50", 0.5), ("p75", 0.75), ("p90", 0.9), ("p95", 0.95), ("p99", 0.99)]


@router.post("/{mid}/processes/{pid}/distribution")
def distribution(mid: str, pid: str, req: DistributionIn) -> dict:
    """The durations of a selection as a histogram (equal-width buckets in seconds from the smallest to the largest,
    each with its count of durations and of distinct objects; a bucket holds durations ≥ its start and < its end, the
    last also its end) with count, mean, min, max and percentiles (linear between the closest ranks). `now` is the time
    current durations were measured up to: POST …/output with the same selection, `now` and a bucket range as
    `duration` gives exactly the objects counted in those buckets."""
    rec = _get(mid)
    p = _process(rec, pid)
    now = _ts(req.now) or datetime.now(timezone.utc)
    scope = _scope(rec, p, req.parent_states or None, None if req.keys is None else set(req.keys), _anc(req.ancestor_keys), _desc(req.descendant_keys))
    by = {k: v for k, v in _paths(p).items() if scope is None or k in scope}
    current = {k: v for k, v in _current(p).items() if scope is None or k in scope}
    keys = _select(by, current, req.states, req.mode, req.transitions, req.transition_mode)
    vals = _measure(by, current, keys, req.states, req.mode, req.transitions, req.transition_mode, now)
    measure = ("process" if not req.states and not req.transitions else "transition" if not req.states
               else ("current_stay" if req.mode == "current" else "stay") + ("" if not req.transitions else "+transition"))
    base = {"measure": measure, "now": now.isoformat(), "selected_objects": len(keys), "count": len(vals),
            "objects": len({pk for pk, _ in vals})}
    if not vals:
        return {**base, "min_s": None, "max_s": None, "mean_s": None, "percentiles": {k: None for k, _ in PERCENTILES}, "edges": [], "buckets": []}
    xs = sorted(v for _, v in vals)
    edges = _edges(xs[0], xs[-1], req.buckets if xs[-1] > xs[0] else 1)
    n = len(edges) - 1
    counts = [0] * n
    objs: list[set] = [set() for _ in range(n)]
    import bisect

    for pk, v in vals:
        i = min(n - 1, max(0, bisect.bisect_right(edges, v, 0, n) - 1))
        counts[i] += 1
        objs[i].add(pk)
    return {**base, "min_s": xs[0], "max_s": xs[-1], "mean_s": sum(xs) / len(xs),
            "percentiles": {k: _percentile(xs, q) for k, q in PERCENTILES}, "edges": edges,
            "buckets": [{"from_s": edges[i], "to_s": edges[i + 1], "count": counts[i], "objects": len(objs[i])} for i in range(n)]}
