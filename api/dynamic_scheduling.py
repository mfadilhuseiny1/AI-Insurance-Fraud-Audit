"""Dynamic Scheduling, modelled on Palantir's Dynamic Scheduling: allocate schedule objects to resources in time.

A board (the Scheduling Gantt chart's configuration) pairs a Schedule object type — with a foreign key to the
resource, a start and an end timestamp, optionally a fixed-duration boolean — with a Resource object type (the rows),
and names the save handler: a modify action whose optional parameters have the same ids as those three properties.
Users drag pucks (schedule objects) in time and between rows; each change runs the save handler. Changes are staged
in an Ontology scenario (ontology_scenarios.py) until "Submit changes" merges them through an Apply scenario action,
or they are discarded.

Validation rules (HARD or SOFT) are evaluated on every change: built-in ones — no overlapping pucks on a row, within
working hours, at most n pucks per row per day, a schedule property must match a resource property — or a Python
function taking `scheduleObjectPrimaryKeys` and returning [{result, scheduleObjectPrimaryKey, details}]
(result true / false / null when not relevant). Suggestions rate, for a selected puck, each row's free slots in the
timeline (1: fits and passes the hard rules, -1: breaks a hard rule); the search function places unassigned pucks in
the earliest slot that passes the hard rules (and as many soft rules as possible). Inline metrics: per row the
utilization of the timeline, per day the number of pucks. The calendar view lists pucks by day.

Several resource object types: `extra_resources` name further foreign keys of the schedule object, each to another
resource object type (a task needs a crew and a vehicle). Each is a section of rows; a puck sits on its row in every
section, a drag onto a row sets that section's foreign key, and the per-row rules (no overlap, at most n per day,
property match with a `dimension`) look at every section. Rows are keyed by `key`: the primary key in the first
section, "<foreign key property>:<primary key>" in the others.

Puck styling layers: `style_layers`, top first — a condition on a schedule property (=, !=, >, <, contains, empty,
not_empty) or on the puck's rule violations, and a color; the first enabled layer that matches colors the puck.

Search functions (`/recommend`, the Gantt widget's right-click menus): on a row at a time, the schedule objects that
fit there; on a puck, its best free slots; or a function returning Dynamic Scheduling's ISearchResult. A move with
`exact` restores a recorded state (the widgets' change log undo): times as given, nothing snapped.

Program Scheduling (the Workshop widget, `/program/*`): no board — layers of schedule objects (any object type with a
date or timestamp start, and an end unless they are events), each a standard, background or event puck type, grouped
into hierarchical rows by properties with roll-ups (earliest start, latest end, count, late, progress) on the group
rows. Standard pucks may depend on others of their layer (an array property of primary keys): a dependency is broken
when a task starts before its predecessor ends. A drag is planned first (`/program/plan`: warn, block, or push the
later tasks along the chain), then saved through the layer's save handler action (`/program/save`; parameters with
the start / end property ids), directly or in a scenario. Pending edits (not saved yet) are laid over the data.

Records are JSON files under data/ontology/scheduling/. Mounted by server.py under /api/scheduling.
"""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
from ontology import _lock, _now

router = APIRouter(prefix="/api/scheduling")
RULE_KINDS = ("no_overlap", "within_hours", "max_per_day", "property_match", "function")
MAX_SUGGEST_ROWS = 200


def configure() -> None:
    (ontology.DIR / "scheduling").mkdir(parents=True, exist_ok=True)


def _ts(v: Any) -> Optional[datetime]:
    if v in (None, ""):
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# boards
# ------------------------------------------------------------------------------------------------


class Rule(BaseModel):
    id: str = Field(default_factory=lambda: f"r-{uuid.uuid4().hex[:6]}")
    name: str
    constraint: Literal["HARD", "SOFT"] = "HARD"
    kind: Literal["no_overlap", "within_hours", "max_per_day", "property_match", "function"] = "no_overlap"
    start_hour: Optional[int] = Field(None, ge=0, le=23)
    end_hour: Optional[int] = Field(None, ge=1, le=24)
    max: Optional[int] = Field(None, ge=1)
    schedule_property: Optional[str] = None
    resource_property: Optional[str] = None
    function_id: Optional[str] = None
    # property_match: the section it compares with (an extra resource's foreign key property; default the first)
    dimension: Optional[str] = None
    enabled: bool = True


class ExtraResource(BaseModel):
    object_type_id: str
    resource_property: str  # the schedule object's foreign key to it
    label: str = ""


class StyleLayer(BaseModel):
    id: str = Field(default_factory=lambda: f"l-{uuid.uuid4().hex[:6]}")
    name: str = Field(min_length=1, max_length=120)
    # "violation": the puck breaks a rule (value HARD / SOFT, or empty for any); the others compare `property`
    operator: Literal["=", "!=", ">", "<", "contains", "empty", "not_empty", "violation"] = "="
    property: Optional[str] = None
    value: Any = None
    color: str = Field("#38bdf8", pattern=r"^#[0-9a-fA-F]{6}$")
    enabled: bool = True


class BoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    schedule_object_type_id: str
    resource_object_type_id: str
    resource_property: str
    start_property: str
    end_property: str
    fixed_duration_property: Optional[str] = None
    label_property: Optional[str] = None
    color_property: Optional[str] = None
    save_action_id: str
    merge_action_id: Optional[str] = None
    timeline_start: str
    timeline_end: str
    snap_minutes: int = Field(30, ge=1, le=1440)
    rules: list[Rule] = []
    row_properties: list[str] = []
    extra_resources: list[ExtraResource] = []
    style_layers: list[StyleLayer] = []


def _check(b: dict) -> None:
    st = ontology._object_type(b["schedule_object_type_id"])
    rt = ontology._object_type(b["resource_object_type_id"])
    props = {p["api_name"]: p for p in st["properties"]}
    for k in ("resource_property", "start_property", "end_property"):
        if b[k] not in props:
            raise HTTPException(400, f"{st['display_name']} has no property {b[k]}")
    for k in ("start_property", "end_property"):
        if props[b[k]]["type"] != "timestamp":
            raise HTTPException(400, f"{b[k]} must be a timestamp property")
    act = ontology._get("action-types", b["save_action_id"], "action type")
    if act.get("object_type_id") != st["id"]:
        raise HTTPException(400, "the save handler must be an action on the schedule object type")
    params = {p["id"] for p in act.get("parameters") or []}
    missing = [b[k] for k in ("resource_property", "start_property", "end_property") if b[k] not in params]
    if missing:
        raise HTTPException(400, f"the save handler needs parameters with the property ids {', '.join(missing)}")
    if not _ts(b["timeline_start"]) or not _ts(b["timeline_end"]) or _ts(b["timeline_end"]) <= _ts(b["timeline_start"]):
        raise HTTPException(400, "the timeline needs a start before its end")
    rprops_of = {b["resource_property"]: {p["api_name"] for p in rt["properties"]}}
    for x in b.get("extra_resources") or []:
        xt = ontology._object_type(x["object_type_id"])
        if x["resource_property"] not in props or x["resource_property"] in rprops_of:
            raise HTTPException(400, f"{xt['display_name']}: its foreign key must be another property of {st['display_name']}")
        if x["resource_property"] not in params:
            raise HTTPException(400, f"the save handler needs a parameter with the property id {x['resource_property']}")
        rprops_of[x["resource_property"]] = {p["api_name"] for p in xt["properties"]}
    for layer in b.get("style_layers") or []:
        if layer["operator"] != "violation" and layer.get("property") not in props:
            raise HTTPException(400, f"layer {layer['name']}: pick a property of {st['display_name']}")
    for r in b["rules"]:
        rprops = rprops_of.get(r.get("dimension") or b["resource_property"])
        if rprops is None:
            raise HTTPException(400, f"{r['name']}: the board has no resource section {r.get('dimension')}")
        if r["kind"] == "within_hours" and (r.get("start_hour") is None or r.get("end_hour") is None):
            raise HTTPException(400, f"{r['name']}: give the working hours")
        if r["kind"] == "max_per_day" and not r.get("max"):
            raise HTTPException(400, f"{r['name']}: give the maximum per day")
        if r["kind"] == "property_match" and (r.get("schedule_property") not in props or r.get("resource_property") not in rprops):
            raise HTTPException(400, f"{r['name']}: pick a schedule property and a resource property")
        if r["kind"] == "function" and not r.get("function_id"):
            raise HTTPException(400, f"{r['name']}: pick the rule function")


def _board(bid: str) -> dict:
    return ontology._get("scheduling", bid, "scheduling board")


@router.get("/boards")
def list_boards() -> list[dict]:
    return sorted(ontology._all("scheduling"), key=lambda b: b.get("updated_at", ""), reverse=True)


@router.post("/boards")
def create_board(req: BoardIn) -> dict:
    b = {"id": f"sched-{uuid.uuid4().hex[:12]}", **req.model_dump(), "owner": auth.actor_id() or "local", "created_at": _now()}
    _check(b)
    with _lock:
        return ontology._put("scheduling", b)


@router.get("/boards/{bid}")
def get_board(bid: str) -> dict:
    return _board(bid)


@router.put("/boards/{bid}")
def save_board(bid: str, req: BoardIn) -> dict:
    with _lock:
        b = _board(bid)
        b.update(req.model_dump())
        _check(b)
        return ontology._put("scheduling", b)


# ------------------------------------------------------------------------------------------------
# data, rules and metrics
# ------------------------------------------------------------------------------------------------


def _in(scenario_id: Optional[str]):
    import contextlib

    if not scenario_id:
        return contextlib.nullcontext()
    import ontology_scenarios

    return ontology_scenarios.active(scenario_id)


def _load(b: dict) -> tuple[list[dict], list[dict]]:
    st = ontology._object_type(b["schedule_object_type_id"])
    rt = ontology._object_type(b["resource_object_type_id"])
    rows = [{**ontology._public_object(rt, pk, o), "key": pk, "dimension": b["resource_property"], "section": rt["display_name"]}
            for pk, o in ontology._objects(rt["id"]).items() if ontology._can_see(rt, o)]
    rows.sort(key=lambda r: r["title"])
    extras = b.get("extra_resources") or []
    for x in extras:
        xt = ontology._object_type(x["object_type_id"])
        more = [{**ontology._public_object(xt, pk, o), "key": f"{x['resource_property']}:{pk}", "dimension": x["resource_property"], "section": x.get("label") or xt["display_name"]}
                for pk, o in ontology._objects(xt["id"]).items() if ontology._can_see(xt, o)]
        rows += sorted(more, key=lambda r: r["title"])
    pucks = []
    for pk, o in ontology._objects(st["id"]).items():
        if not ontology._can_see(st, o):
            continue
        pub = ontology._public_object(st, pk, o)
        p = pub["properties"]
        s, e = _ts(p.get(b["start_property"])), _ts(p.get(b["end_property"]))
        pucks.append({"id": pk, "title": str(p.get(b["label_property"]) if b.get("label_property") and p.get(b["label_property"]) else pub["title"]),
                      "resource": None if p.get(b["resource_property"]) in (None, "") else str(p.get(b["resource_property"])),
                      "resources": {x["resource_property"]: None if p.get(x["resource_property"]) in (None, "") else str(p.get(x["resource_property"])) for x in extras},
                      "start": _iso(s) if s else None, "end": _iso(e) if e else None,
                      "fixed": bool(p.get(b["fixed_duration_property"])) if b.get("fixed_duration_property") else False,
                      "color": p.get(b["color_property"]) if b.get("color_property") else None, "properties": p})
    return rows, pucks


def _row_keys(p: dict) -> list[str]:
    """The rows a puck sits on, in every section."""
    return ([p["resource"]] if p.get("resource") else []) + [f"{k}:{v}" for k, v in (p.get("resources") or {}).items() if v]


def _on_row(p: dict, row: dict, primary: str) -> dict:
    """The puck moved to a row (of any section)."""
    if row["dimension"] == primary:
        return {**p, "resource": row["primary_key"]}
    return {**p, "resources": {**(p.get("resources") or {}), row["dimension"]: row["primary_key"]}}


def _layer_matches(layer: dict, p: dict) -> bool:
    op = layer["operator"]
    if op == "violation":
        return any(not layer.get("value") or v["constraint"] == layer["value"] for v in p.get("violations") or [])
    a, c = p["properties"].get(layer.get("property")), layer.get("value")
    if op == "empty":
        return a in (None, "", [])
    if op == "not_empty":
        return a not in (None, "", [])
    if a is None:
        return op == "!="
    if op in (">", "<"):
        try:
            x, y = float(a), float(c)
        except (TypeError, ValueError):
            x, y = str(a), str(c)
        return x > y if op == ">" else x < y
    if op == "contains":
        return str(c).lower() in ([str(i).lower() for i in a] if isinstance(a, list) else str(a).lower())
    same = (a is c) if isinstance(a, bool) and isinstance(c, bool) else str(a).lower() == str(c).lower()
    return same if op == "=" else not same


def _overlap(a: dict, c: dict) -> bool:
    return _ts(a["start"]) < _ts(c["end"]) and _ts(c["start"]) < _ts(a["end"])


def evaluate_rules(b: dict, rows: list[dict], pucks: list[dict]) -> dict[str, list[dict]]:
    """Per puck: the rules it breaks ({rule, name, constraint, details})."""
    res: dict[str, list[dict]] = defaultdict(list)
    placed = [p for p in pucks if p["resource"] and p["start"] and p["end"]]
    by_row: dict[str, list[dict]] = defaultdict(list)
    for p in pucks:
        if p["start"] and p["end"]:
            for key in _row_keys(p):
                by_row[key].append(p)
    rows_by = {r.get("key", r["primary_key"]): r for r in rows}
    for rule in b.get("rules") or []:
        if not rule.get("enabled", True):
            continue
        fail = lambda pid, detail: res[pid].append({"rule": rule["id"], "name": rule["name"], "constraint": rule["constraint"], "details": detail})  # noqa: E731
        k = rule["kind"]
        if k == "no_overlap":
            for ps in by_row.values():
                ps.sort(key=lambda p: p["start"])
                for i, p in enumerate(ps):
                    for q in ps[i + 1:]:
                        if _ts(q["start"]) >= _ts(p["end"]):
                            break
                        fail(p["id"], f"overlaps {q['title']}")
                        fail(q["id"], f"overlaps {p['title']}")
        elif k == "within_hours":
            for p in placed:
                s, e = _ts(p["start"]), _ts(p["end"])
                end_limit = s.replace(hour=0, minute=0, second=0) + timedelta(hours=rule["end_hour"])
                if s.hour < rule["start_hour"] or e > end_limit:
                    fail(p["id"], f"outside {rule['start_hour']:02d}:00–{rule['end_hour']:02d}:00")
        elif k == "max_per_day":
            for row, ps in by_row.items():
                per_day: dict[str, list[dict]] = defaultdict(list)
                for p in ps:
                    per_day[p["start"][:10]].append(p)
                for day, items in per_day.items():
                    if len(items) > rule["max"]:
                        for p in items:
                            fail(p["id"], f"{len(items)} on {day} (at most {rule['max']})")
        elif k == "property_match":
            dim = rule.get("dimension") or b["resource_property"]
            for p in pucks:
                pk = p["resource"] if dim == b["resource_property"] else (p.get("resources") or {}).get(dim)
                r = rows_by.get(pk if dim == b["resource_property"] else f"{dim}:{pk}") if pk else None
                if r is None:
                    continue
                a, c = p["properties"].get(rule["schedule_property"]), r["properties"].get(rule["resource_property"])
                ok = a in (None, "") or (str(a) in [str(x) for x in c] if isinstance(c, list) else str(a) == str(c))
                if not ok:
                    fail(p["id"], f"{rule['schedule_property']} {a} ≠ {rule['resource_property']} {c}")
        elif k == "function":
            run = ontology.MODEL_HOOKS.get("run_function")
            if not run:
                continue
            out = run(rule["function_id"], None, {"scheduleObjectPrimaryKeys": [p["id"] for p in pucks]}, {"resource": f"scheduling:{b['id']}"})
            if not out.get("ok"):
                for p in pucks:
                    fail(p["id"], f"the rule function failed: {out.get('error')}")
                continue
            for item in out.get("value") or []:
                if item.get("result") is False:
                    det = "; ".join(d.get("description", "") for d in item.get("details") or []) or rule["name"]
                    fail(str(item.get("scheduleObjectPrimaryKey")), det)
    return res


def metrics(b: dict, rows: list[dict], pucks: list[dict]) -> dict:
    t0, t1 = _ts(b["timeline_start"]), _ts(b["timeline_end"])
    span = (t1 - t0).total_seconds() or 1
    util = {}
    for r in rows:
        key = r.get("key", r["primary_key"])
        secs = sum(max(0.0, (min(_ts(p["end"]), t1) - max(_ts(p["start"]), t0)).total_seconds())
                   for p in pucks if p["start"] and p["end"] and key in _row_keys(p))
        util[key] = round(secs / span * 100, 1)
    per_day: dict[str, int] = defaultdict(int)
    for p in pucks:
        if p["start"] and p["resource"]:
            per_day[p["start"][:10]] += 1
    return {"row_utilization": util, "per_day": dict(sorted(per_day.items()))}


@router.get("/boards/{bid}/data")
def data(bid: str, scenario_id: Optional[str] = None) -> dict:
    b = _board(bid)
    with _in(scenario_id), _lock:
        rows, pucks = _load(b)
        violations = evaluate_rules(b, rows, pucks)
    layers = [x for x in b.get("style_layers") or [] if x.get("enabled", True)]
    for p in pucks:
        p["violations"] = violations.get(p["id"], [])
        hit = next((x for x in layers if _layer_matches(x, p)), None)
        p["style"] = {"layer": hit["id"], "name": hit["name"], "color": hit["color"]} if hit else None
    return {"board": b, "rows": rows, "pucks": pucks, "unassigned": [p["id"] for p in pucks if not p["resource"] or not p["start"]],
            "metrics": metrics(b, rows, pucks), "hard_violations": sum(1 for p in pucks if any(v["constraint"] == "HARD" for v in p["violations"]))}


class MoveIn(BaseModel):
    primary_key: str
    resource: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    scenario_id: Optional[str] = None
    # the section `resource` is for: an extra resource's foreign key property (default the first section)
    dimension: Optional[str] = None
    # restore a recorded state (undo in the Workshop widgets' change log): start / end are taken as given, empty ones
    # cleared, nothing snapped and the duration not kept
    exact: bool = False


def _snap(d: datetime, minutes: int) -> datetime:
    epoch = int(d.timestamp())
    step = minutes * 60
    return datetime.fromtimestamp(round(epoch / step) * step, tz=timezone.utc)


@router.post("/boards/{bid}/move")
def move(bid: str, req: MoveIn) -> dict:
    """Run the save handler for one puck (in the scenario when given); start / end snap to the board's interval."""
    b = _board(bid)
    dim = req.dimension or b["resource_property"]
    extras = [x["resource_property"] for x in b.get("extra_resources") or []]
    if dim != b["resource_property"] and dim not in extras:
        raise HTTPException(400, f"the board has no resource section {dim}")
    with _in(req.scenario_id):
        with _lock:
            _, pucks = _load(b)
        cur = next((p for p in pucks if p["id"] == req.primary_key), None)
        if not cur:
            raise HTTPException(404, "schedule object not found")
        if req.exact:
            start, end = _ts(req.start), _ts(req.end)
            if (req.start and not start) or (req.end and not end):
                raise HTTPException(400, "start and end must be timestamps")
        else:
            start = _ts(req.start) if req.start else _ts(cur["start"])
            end = _ts(req.end) if req.end else _ts(cur["end"])
            if req.start and not req.end and cur["start"] and cur["end"]:
                end = start + (_ts(cur["end"]) - _ts(cur["start"]))
            if cur["fixed"] and req.end and req.start and cur["start"] and cur["end"] and (end - start) != (_ts(cur["end"]) - _ts(cur["start"])):
                raise HTTPException(400, f"{cur['title']} has a fixed duration")
            if start:
                start = _snap(start, b["snap_minutes"])
            if end:
                end = _snap(end, b["snap_minutes"])
        if start and end and end <= start:
            raise HTTPException(400, "the end must be after the start")
        params = {"object": req.primary_key, b["resource_property"]: cur["resource"], **{k: cur["resources"].get(k) for k in extras},
                  b["start_property"]: _iso(start) if start else None, b["end_property"]: _iso(end) if end else None}
        if req.resource is not None:
            # a restored "no resource" is null again, not an empty string
            params[dim] = None if req.exact and req.resource == "" else req.resource
        if req.scenario_id:
            import ontology_scenarios

            ontology_scenarios.apply_in_scenario(req.scenario_id, b["save_action_id"], ontology_scenarios.ApplyIn(parameters=params))
        else:
            ontology.apply_action(b["save_action_id"], ontology.ApplyAction(parameters=params))
    return data(bid, req.scenario_id)


class SuggestIn(BaseModel):
    primary_key: str
    scenario_id: Optional[str] = None


def _candidates(b: dict, rows: list[dict], pucks: list[dict], puck: dict) -> list[dict]:
    """Every row's candidate slots for a puck (keeping its duration), rated by the rules they would break."""
    t0, t1 = _ts(b["timeline_start"]), _ts(b["timeline_end"])
    dur = (_ts(puck["end"]) - _ts(puck["start"])) if puck["start"] and puck["end"] else timedelta(hours=2)
    step = timedelta(minutes=max(b["snap_minutes"], 30))
    out = []
    for r in rows[:MAX_SUGGEST_ROWS]:
        t = t0
        while t + dur <= t1:
            trial = [{**_on_row(p, r, b["resource_property"]), "start": _iso(t), "end": _iso(t + dur)} if p["id"] == puck["id"] else p for p in pucks]
            v = evaluate_rules(b, rows, trial).get(puck["id"], [])
            hard = [x for x in v if x["constraint"] == "HARD"]
            soft = [x for x in v if x["constraint"] == "SOFT"]
            rating = -1.0 if hard else 1.0 - 0.5 * min(2, len(soft))
            out.append({"row": r.get("key", r["primary_key"]), "start": _iso(t), "end": _iso(t + dur), "rating": rating, "breaks": [x["name"] for x in v]})
            t += step
    return out


@router.post("/boards/{bid}/suggest")
def suggest(bid: str, req: SuggestIn) -> dict:
    """Suggestion slots for a puck: per row, merged slots with a rating from -1 (breaks a hard rule) to 1."""
    b = _board(bid)
    with _in(req.scenario_id), _lock:
        rows, pucks = _load(b)
        puck = next((p for p in pucks if p["id"] == req.primary_key), None)
        if not puck:
            raise HTTPException(404, "schedule object not found")
        cands = _candidates(b, rows, pucks, puck)
    merged: dict[str, list[dict]] = defaultdict(list)
    for c in cands:
        slots = merged[c["row"]]
        if slots and slots[-1]["rating"] == c["rating"] and slots[-1]["end_start"] == c["start"]:
            slots[-1]["end_start"] = (_ts(c["start"]) + timedelta(minutes=max(b["snap_minutes"], 30))).isoformat()
            slots[-1]["last_end"] = c["end"]
        else:
            slots.append({"start": c["start"], "last_end": c["end"], "rating": c["rating"], "breaks": c["breaks"],
                          "end_start": (_ts(c["start"]) + timedelta(minutes=max(b["snap_minutes"], 30))).isoformat()})
    return {"primary_key": req.primary_key, "slots": {row: [{"start": s["start"], "end": s["last_end"], "rating": s["rating"], "breaks": s["breaks"]} for s in ss]
                                                      for row, ss in merged.items()}}


class SearchIn(BaseModel):
    scenario_id: Optional[str] = None
    apply: bool = False
    primary_keys: Optional[list[str]] = None


@router.post("/boards/{bid}/search")
def search(bid: str, req: SearchIn) -> dict:
    """Place unassigned pucks (or the given ones) in the earliest slot that passes the hard rules, fewest soft breaks."""
    b = _board(bid)
    placements = []
    with _in(req.scenario_id), _lock:
        rows, pucks = _load(b)
        first = [r for r in rows if r["dimension"] == b["resource_property"]]  # the search fills the first section
        todo = [p for p in pucks if (req.primary_keys and p["id"] in req.primary_keys) or (not req.primary_keys and (not p["resource"] or not p["start"]))]
        for puck in todo:
            cands = [c for c in _candidates(b, first, pucks, puck) if c["rating"] > -1]
            if not cands:
                placements.append({"primary_key": puck["id"], "placed": False})
                continue
            best = max(cands, key=lambda c: (c["rating"], -_ts(c["start"]).timestamp()))
            placements.append({"primary_key": puck["id"], "placed": True, **best})
            pucks = [{**p, "resource": best["row"], "start": best["start"], "end": best["end"]} if p["id"] == puck["id"] else p for p in pucks]
    if req.apply:
        for pl in placements:
            if pl["placed"]:
                move(bid, MoveIn(primary_key=pl["primary_key"], resource=pl["row"], start=pl["start"], end=pl["end"], scenario_id=req.scenario_id))
    return {"placements": placements, "applied": req.apply}


# ------------------------------------------------------------------------------------------------
# search functions (recommendations from a right-click in the Scheduling Gantt widget)
# ------------------------------------------------------------------------------------------------


class RecommendIn(BaseModel):
    # "row": right-click on an empty spot of a row (the row and the time are the inputs); "puck": right-click on a puck
    kind: Literal["row", "puck"]
    row: Optional[str] = None  # the row's key
    time: Optional[str] = None
    primary_key: Optional[str] = None
    scenario_id: Optional[str] = None
    # a function returning an ISearchResult ({rowGroup: {title, containerIds, highlights}, sourcePuckIds, error}),
    # called with {rowId, selectedTime} or {puck}; none: the built-in search
    function_id: Optional[str] = None
    limit: int = Field(12, ge=1, le=100)


def _ms(d: datetime) -> int:
    return int(d.timestamp() * 1000)


def _row_key_of(by_key: dict, b: dict, rid: Any) -> Optional[str]:
    """A row id a function returned: a row key, or a resource's primary key (first section, then the others)."""
    rid = str(rid)
    if rid in by_key:
        return rid
    for x in b.get("extra_resources") or []:
        if f"{x['resource_property']}:{rid}" in by_key:
            return f"{x['resource_property']}:{rid}"
    return None


def _normalize_result(value: Any, b: dict, by_key: dict, pucks: list[dict], source: list[str]) -> dict:
    """A search function's ISearchResult, checked: unknown rows and pucks are dropped, domains made integers."""
    if not isinstance(value, dict):
        return {"rowGroup": None, "sourcePuckIds": source, "error": "the search function did not return an ISearchResult object"}
    out: dict[str, Any] = {"rowGroup": None, "sourcePuckIds": [str(x) for x in value.get("sourcePuckIds") or source], "error": value.get("error") or None}
    g = value.get("rowGroup")
    if isinstance(g, dict):
        known = {p["id"] for p in pucks}
        rows = [k for k in (_row_key_of(by_key, b, r) for r in g.get("containerIds") or []) if k]
        highlights = []
        for h in g.get("highlights") or []:
            if not isinstance(h, dict) or str(h.get("type", "")).upper() not in ("SLOT", "PUCK"):
                continue
            item: dict[str, Any] = {"type": str(h["type"]).upper(), "comment": h.get("comment")}
            dom = h.get("domain")
            if isinstance(dom, dict):
                try:
                    item["domain"] = {"start": int(dom["start"]), "end": int(dom["end"])}
                except (KeyError, TypeError, ValueError):
                    pass
            if h.get("containerId") is not None:
                item["containerId"] = _row_key_of(by_key, b, h["containerId"])
            if item["type"] == "PUCK":
                pk = str(h.get("schedulableObjectPrimaryKey") or "")
                if pk not in known:
                    continue
                item["schedulableObjectPrimaryKey"] = pk
                item["schedulableObjectTypeId"] = b["schedule_object_type_id"]
            elif "domain" not in item or not item.get("containerId"):
                continue
            highlights.append(item)
        out["rowGroup"] = {"title": str(g.get("title") or "Search results"), "containerIds": list(dict.fromkeys(rows)), "highlights": highlights}
    return out


@router.post("/boards/{bid}/recommend")
def recommend(bid: str, req: RecommendIn) -> dict:
    """Run a search function. Built in: on a row at a time, the schedule objects that could go there (keeping their
    duration) without breaking a hard rule, unscheduled ones first; on a puck, the best free slots for it on every row.
    The result is an ISearchResult (Dynamic Scheduling's search function interface); nothing is changed."""
    b = _board(bid)
    with _in(req.scenario_id), _lock:
        rows, pucks = _load(b)
        by_key = {r["key"]: r for r in rows}
        row = puck = at = None
        if req.kind == "row":
            row = by_key.get(str(req.row))
            if not row:
                raise HTTPException(404, "row not found")
            at = _ts(req.time)
            if not at:
                raise HTTPException(400, "give the time that was clicked")
        else:
            puck = next((p for p in pucks if p["id"] == req.primary_key), None)
            if not puck:
                raise HTTPException(404, "schedule object not found")
        source = [puck["id"]] if puck else []
        if req.function_id:
            run = ontology.MODEL_HOOKS.get("run_function")
            if not run:
                raise HTTPException(400, "functions are not available")
            inputs = {"rowId": row["primary_key"], "selectedTime": _iso(at)} if row else {"puck": puck["id"]}
            res = run(req.function_id, None, inputs, {"resource": f"scheduling:{bid}"})
            if not res.get("ok"):
                return {"rowGroup": None, "sourcePuckIds": source, "error": f"the search function failed: {res.get('error')}"}
            return _normalize_result(res.get("value"), b, by_key, pucks, source)
        if row:
            at = _snap(at, b["snap_minutes"])
            found = []
            for p in pucks:
                if row["key"] in _row_keys(p) and p["start"] and p["end"] and _ts(p["start"]) <= at < _ts(p["end"]):
                    continue  # already there
                dur = (_ts(p["end"]) - _ts(p["start"])) if p["start"] and p["end"] else timedelta(hours=2)
                trial = [{**_on_row(q, row, b["resource_property"]), "start": _iso(at), "end": _iso(at + dur)} if q["id"] == p["id"] else q for q in pucks]
                v = evaluate_rules(b, rows, trial).get(p["id"], [])
                if any(x["constraint"] == "HARD" for x in v):
                    continue
                unscheduled = not p["resource"] or not p["start"]
                found.append((0 if unscheduled else 1, len(v), p["title"], p, v, dur))
            found.sort(key=lambda f: f[:3])
            highlights = [{"type": "PUCK", "schedulableObjectPrimaryKey": p["id"], "schedulableObjectTypeId": b["schedule_object_type_id"],
                           "containerId": row["key"], "domain": {"start": _ms(at), "end": _ms(at + dur)},
                           "comment": ("unscheduled · " if un == 0 else "") + ("fits every rule" if not v else "breaks " + ", ".join(x["name"] for x in v))}
                          for un, _, _, p, v, dur in found[:req.limit]]
            homes = [k for h in highlights for k in _row_keys(next(p for p in pucks if p["id"] == h["schedulableObjectPrimaryKey"]))]
            title = f"Fits {row['title']} at {at:%d %b %H:%M} UTC"
            return {"rowGroup": {"title": title, "containerIds": list(dict.fromkeys([row["key"], *homes])), "highlights": highlights}, "sourcePuckIds": [], "error": None}
        cands = [c for c in _candidates(b, rows, pucks, puck) if c["rating"] > -1 and not (c["row"] in _row_keys(puck) and c["start"] == puck["start"])]
        cands.sort(key=lambda c: (-c["rating"], c["start"], c["row"]))
        highlights = [{"type": "SLOT", "containerId": c["row"], "domain": {"start": _ms(_ts(c["start"])), "end": _ms(_ts(c["end"]))},
                       "comment": "fits every rule" if not c["breaks"] else "breaks " + ", ".join(c["breaks"])} for c in cands[:req.limit]]
        return {"rowGroup": {"title": f"Slots for {puck['title']}", "containerIds": list(dict.fromkeys(h["containerId"] for h in highlights)), "highlights": highlights},
                "sourcePuckIds": source, "error": None if highlights else "no slot passes the hard rules"}


@router.post("/boards/{bid}/session")
def start_session(bid: str) -> dict:
    """A scenario that stages the board's changes until they are submitted."""
    import ontology_scenarios

    b = _board(bid)
    sc = ontology_scenarios.create_scenario(ontology_scenarios.ScenarioIn(name=f"{b['name']} · {datetime.now(timezone.utc):%d %b %H:%M}",
                                                                           description=f"Staged changes of the scheduling board {b['name']}"))
    return sc


class SubmitIn(BaseModel):
    scenario_id: str


@router.post("/boards/{bid}/submit")
def submit(bid: str, req: SubmitIn) -> dict:
    """Submit changes: merge the staged scenario into the Ontology through the board's merge action."""
    import ontology_scenarios

    b = _board(bid)
    with _in(req.scenario_id), _lock:
        rows, pucks = _load(b)
        hard = [p["id"] for p in pucks if any(v["constraint"] == "HARD" for v in evaluate_rules(b, rows, pucks).get(p["id"], []))]
    if hard:
        raise HTTPException(400, f"{len(hard)} schedule objects break hard rules: fix them before submitting")
    mid = b.get("merge_action_id")
    if not mid:
        a = ontology_scenarios.create_merge_action(ontology_scenarios.MergeActionIn(display_name=f"Submit schedule: {b['name']}", object_type_ids=[b["schedule_object_type_id"]]))
        mid = a["id"]
        with _lock:
            rec = _board(bid)
            rec["merge_action_id"] = mid
            ontology._put("scheduling", rec)
    return ontology_scenarios.merge(req.scenario_id, ontology_scenarios.MergeIn(action_type_id=mid))


# ------------------------------------------------------------------------------------------------
# Program Scheduling: layers of schedule objects as hierarchical rows, dependencies, roll-ups
# ------------------------------------------------------------------------------------------------

MAX_PROGRAM_ITEMS = 5000
NO_VALUE = "(no value)"


class ProgramLayer(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = ""
    object_type_id: str
    # standard: a bar (draggable, dependencies); background: a shaded period (read-only); event: a point in time
    puck_type: Literal["standard", "background", "event"] = "standard"
    start_property: str
    end_property: Optional[str] = None
    # an array (or comma-separated string) property: the primary keys, in this layer, of the tasks this one waits for
    dependency_property: Optional[str] = None
    label_property: Optional[str] = None
    # a number: 0–1, or 0–100 (read as a percentage)
    progress_property: Optional[str] = None
    save_action_id: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    # dynamic color: the first enabled rule that matches (the board's style layer conditions)
    color_rules: list[StyleLayer] = []
    # the layer's object set: these primary keys (an object set variable) and / or object set filters (filter variables)
    primary_keys: Optional[list[str]] = None
    filter_sets: list[dict] = []


class ProgramGrouping(BaseModel):
    property: str
    descending: bool = False


class ProgramEdit(BaseModel):
    layer: str
    primary_key: str
    start: Optional[str] = None
    end: Optional[str] = None


class ProgramIn(BaseModel):
    layers: list[ProgramLayer] = Field(min_length=1, max_length=12)
    grouping: list[ProgramGrouping] = Field([], max_length=6)
    # pending edits (moved in the widget, not saved yet), laid over the stored times
    edits: list[ProgramEdit] = Field([], max_length=2000)
    scenario_id: Optional[str] = None


def _prog_type(layer: ProgramLayer) -> tuple[dict, dict]:
    t = ontology._object_type(layer.object_type_id)
    props = {p["api_name"]: p for p in t["properties"]}
    name = layer.name or layer.id
    for k in ("start_property", "end_property", "dependency_property", "label_property", "progress_property"):
        v = getattr(layer, k)
        if v and v not in props:
            raise HTTPException(400, f"layer {name}: {t['display_name']} has no property {v}")
    for k in ("start_property", "end_property"):
        v = getattr(layer, k)
        if v and props[v]["type"] not in ("date", "timestamp"):
            raise HTTPException(400, f"layer {name}: {v} must be a date or timestamp property")
    if layer.puck_type != "event" and not layer.end_property:
        raise HTTPException(400, f"layer {name}: choose the end time property")
    for r in layer.color_rules:
        if r.operator != "violation" and r.property not in props:
            raise HTTPException(400, f"layer {name}: color rule {r.name} needs a property of {t['display_name']}")
    return t, props


def _prog_time(v: Any, ptype: Optional[str], end: bool = False) -> Optional[datetime]:
    """A stored value as an instant; a date is that day's start (an end date: the next day's, the day included)."""
    d = _ts(v)
    if d and ptype == "date":
        d = d.replace(hour=0, minute=0, second=0, microsecond=0)
        if end:
            d += timedelta(days=1)
    return d


def _prog_value(d: Optional[datetime], ptype: Optional[str], end: bool = False) -> Optional[str]:
    """An instant as the value a date or timestamp property stores (an end date is the last day included)."""
    if d is None:
        return None
    if ptype == "date":
        return (d - timedelta(seconds=1) if end else d).astimezone(timezone.utc).date().isoformat()
    return _iso(d)


def _deps(v: Any) -> list[str]:
    if v in (None, ""):
        return []
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("["):
            try:
                v = json.loads(s)
            except ValueError:
                v = s.strip("[]").split(",")
        else:
            v = s.split(",")
    if not isinstance(v, list):
        v = [v]
    return list(dict.fromkeys(str(x).strip().strip('"') for x in v if str(x).strip()))


def _progress(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, x / 100 if x > 1 else x))


def _prog_keys(layer: ProgramLayer, scenario_id: Optional[str]) -> tuple[Optional[set[str]], Optional[str]]:
    """The primary keys of the layer's object set (None: every object of the type) and a warning when cut."""
    keys = {str(k) for k in layer.primary_keys} if layer.primary_keys is not None else None
    if not layer.filter_sets:
        return keys, None
    import workshop

    q = workshop.Query.model_validate({"source": {"kind": "object_type", "id": layer.object_type_id}, "filter_sets": layer.filter_sets,
                                       "limit": workshop.MAX_RESULT_ROWS, "scenario_id": scenario_id})
    res = workshop.query(q)
    found = {str(r.get("__pk")) for r in res.get("rows") or []}
    warn = f"layer {layer.name or layer.id}: only the first {len(found)} of {res['total']} objects of its object set" if res["total"] > len(found) else None
    return (found if keys is None else keys & found), warn


def _prog_load(req: ProgramIn) -> tuple[list[dict], list[dict], list[str]]:
    """The items of every layer (pending edits laid over), the layers' descriptions and warnings."""
    ids = [x.id for x in req.layers]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "every layer needs its own id")
    sets = {x.id: _prog_keys(x, req.scenario_id) for x in req.layers}
    edits = {(e.layer, e.primary_key): e for e in req.edits}
    items: list[dict] = []
    layers: list[dict] = []
    warnings = [w for _, w in sets.values() if w]
    with _in(req.scenario_id), _lock:
        for layer in req.layers:
            t, props = _prog_type(layer)
            keys = sets[layer.id][0]
            stype = props[layer.start_property]["type"]
            etype = props[layer.end_property]["type"] if layer.end_property else None
            layers.append({"id": layer.id, "name": layer.name or t["display_name"], "kind": layer.puck_type, "object_type_id": t["id"], "object_type": t["display_name"],
                           "start_type": stype, "end_type": etype, "editable": layer.puck_type != "background" and bool(layer.save_action_id),
                           "dependency_property": layer.dependency_property})
            n = 0
            for pk, o in ontology._objects(t["id"]).items():
                if keys is not None and pk not in keys:
                    continue
                if not ontology._can_see(t, o):
                    continue
                if n >= MAX_PROGRAM_ITEMS:
                    warnings.append(f"layer {layer.name or layer.id}: only the first {MAX_PROGRAM_ITEMS} objects are shown")
                    break
                n += 1
                pub = ontology._public_object(t, pk, o)
                p = pub["properties"]
                s = _prog_time(p.get(layer.start_property), stype)
                e = _prog_time(p.get(layer.end_property), etype, True) if layer.end_property and layer.puck_type != "event" else None
                ed = edits.get((layer.id, pk))
                if ed and layer.puck_type != "background":
                    s = _ts(ed.start) or s
                    e = (_ts(ed.end) or e) if layer.puck_type != "event" else None
                label = p.get(layer.label_property) if layer.label_property else None
                item = {"key": f"{layer.id}:{pk}", "layer": layer.id, "id": pk, "object_type_id": t["id"], "kind": layer.puck_type,
                        "title": str(label) if label not in (None, "") else pub["title"],
                        "start": _iso(s) if s else None, "end": _iso(e) if e else None, "edited": bool(ed) and layer.puck_type != "background",
                        "deps": _deps(p.get(layer.dependency_property)) if layer.dependency_property and layer.puck_type == "standard" else [],
                        "progress": _progress(p.get(layer.progress_property)) if layer.progress_property else None,
                        "properties": p, "violations": [], "color": layer.color}
                items.append(item)
    items.sort(key=lambda i: (i["start"] is None, i["start"] or "", i["title"]))
    return items, layers, warnings


def _prog_check(items: list[dict]) -> list[dict]:
    """Dependencies: the links (from the predecessor to the task waiting for it) and, on the items, the broken ones —
    a task starting before its predecessor ends, a predecessor that is not shown, a cycle."""
    by = {(i["layer"], i["id"]): i for i in items}
    for i in items:
        i["violations"] = []
        i["dependents"] = []
    links = []
    for b in items:
        if b["kind"] != "standard":
            continue
        for dep in b["deps"]:
            a = by.get((b["layer"], dep))
            if a is b:
                continue
            if not a or a["kind"] != "standard":
                b["violations"].append({"kind": "missing", "other": dep, "details": f"waits for {dep}, which is not shown"})
                continue
            ok = not (a["end"] and b["start"]) or _ts(b["start"]) >= _ts(a["end"])
            links.append({"from": a["key"], "to": b["key"], "ok": ok})
            a["dependents"].append(b["key"])
            if not ok:
                b["violations"].append({"kind": "predecessor", "other": a["key"], "details": f"starts before {a['title']} ends"})
                a["violations"].append({"kind": "successor", "other": b["key"], "details": f"{b['title']} starts before this ends"})
    # Kahn's algorithm: what is left lies on (or after) a cycle
    keyed = {i["key"]: i for i in items}
    indeg = {i["key"]: 0 for i in items}
    for x in links:
        indeg[x["to"]] += 1
    queue = [k for k, n in indeg.items() if n == 0]
    while queue:
        k = queue.pop()
        for d in keyed[k]["dependents"]:
            indeg[d] -= 1
            if indeg[d] == 0:
                queue.append(d)
    for k, n in indeg.items():
        if n > 0:
            keyed[k]["violations"].append({"kind": "cycle", "other": None, "details": "on or after a dependency cycle"})
    return links


def _label(v: Any) -> str:
    if v in (None, "", []):
        return NO_VALUE
    return ", ".join(map(str, v)) if isinstance(v, list) else str(v)


def _secs(i: dict) -> float:
    return (_ts(i["end"]) - _ts(i["start"])).total_seconds() if i["start"] and i["end"] else 0.0


def _prog_groups(req: ProgramIn, items: list[dict]) -> tuple[list[dict], list[str]]:
    """The group rows (nested by the grouping properties, each with its roll-up) and the items outside any group."""
    root: dict = {"children": {}, "items": []}
    for it in items:
        if it["kind"] != "standard":
            continue
        node, path = root, []
        for g in req.grouping:
            label = _label(it["properties"].get(g.property))
            path.append(label)
            node = node["children"].setdefault(label, {"key": json.dumps(path, ensure_ascii=False), "label": label, "property": g.property,
                                                       "depth": len(path) - 1, "children": {}, "items": []})
        node["items"].append(it)
        it["group"] = node.get("key")
    # background and event pucks sit in the deepest group whose values they share (else across every row)
    for it in items:
        if it["kind"] == "standard":
            continue
        node, scope = root, None
        for g in req.grouping:
            if g.property not in it["properties"]:
                break
            node = node["children"].get(_label(it["properties"].get(g.property)))
            if node is None:
                break
            scope = node["key"]
        it["group"] = scope

    def order(labels: list[str], desc: bool) -> list[str]:
        vals = [x for x in labels if x != NO_VALUE]
        try:
            vals.sort(key=float, reverse=desc)
        except ValueError:
            vals.sort(key=str.lower, reverse=desc)
        return vals + ([NO_VALUE] if NO_VALUE in labels else [])

    def finish(node: dict, depth: int) -> tuple[dict, list[dict]]:
        kids, under = [], list(node["items"])
        desc = req.grouping[depth].descending if depth < len(req.grouping) else False
        for label in order(list(node["children"]), desc):
            child, below = finish(node["children"][label], depth + 1)
            kids.append(child)
            under += below
        starts = [i["start"] for i in under if i["start"]]
        ends = [i["end"] or i["start"] for i in under if i["start"]]
        timed = [i for i in under if i["progress"] is not None]
        weight = sum(_secs(i) for i in timed)
        progress = (sum(i["progress"] * _secs(i) for i in timed) / weight if weight else sum(i["progress"] for i in timed) / len(timed)) if timed else None
        out = {k: node[k] for k in ("key", "label", "property", "depth") if k in node}
        out.update({"children": kids, "items": [i["key"] for i in node["items"]], "count": len(under),
                    "start": min(starts, key=lambda s: _ts(s)) if starts else None, "end": max(ends, key=lambda s: _ts(s)) if ends else None,
                    "late": sum(1 for i in under if any(v["kind"] in ("predecessor", "successor", "cycle") for v in i["violations"])),
                    "edited": sum(1 for i in under if i["edited"]), "progress": round(progress, 4) if progress is not None else None})
        return out, under

    top, _ = finish(root, 0)
    return top["children"], top["items"]


@router.post("/program/data")
def program_data(req: ProgramIn) -> dict:
    """What the Program Scheduling widget draws: items (pending edits laid over), dependency links with the broken
    ones marked on the items, and the group rows with their roll-ups."""
    items, layers, warnings = _prog_load(req)
    links = _prog_check(items)
    # dynamic colors: the first enabled rule of the layer that matches (a "violation" rule: a broken dependency)
    rules = {x.id: [r.model_dump() for r in x.color_rules if r.enabled] for x in req.layers}
    for i in items:
        broken = [{**v, "constraint": "HARD"} for v in i["violations"] if v["kind"] != "missing"]
        hit = next((r for r in rules[i["layer"]] if _layer_matches(r, {**i, "violations": broken})), None)
        if hit:
            i["color"] = hit["color"]
    groups, loose = _prog_groups(req, items)
    for g in req.grouping:
        if not any(g.property in i["properties"] for i in items if i["kind"] == "standard") and items:
            warnings.append(f"no standard puck has the grouping property {g.property}")
    return {"layers": layers, "items": items, "links": links, "groups": groups, "root_items": loose, "warnings": warnings,
            "late": sum(1 for i in items if any(v["kind"] in ("predecessor", "successor", "cycle") for v in i["violations"])),
            "edited": sum(1 for i in items if i["edited"])}


class ProgramPlanIn(ProgramIn):
    layer: str
    primary_key: str
    start: Optional[str] = None
    end: Optional[str] = None
    # warn: the move is kept and broken dependencies are reported; block: a move breaking a dependency is refused;
    # push: the tasks waiting for it (and theirs) move later as far as needed, a start before a predecessor's end is refused
    mode: Literal["warn", "block", "push"] = "warn"


@router.post("/program/plan")
def program_plan(req: ProgramPlanIn) -> dict:
    """Plan a drag (move or resize): the changes it makes (with push, the later tasks too) and the dependencies it
    breaks; nothing is written."""
    layer = next((x for x in req.layers if x.id == req.layer), None)
    if not layer:
        raise HTTPException(400, f"no layer {req.layer}")
    if layer.puck_type == "background":
        raise HTTPException(400, "background pucks are read-only")
    items, _, _ = _prog_load(req)
    cur = next((i for i in items if i["layer"] == req.layer and i["id"] == req.primary_key), None)
    if not cur:
        raise HTTPException(404, "schedule object not found")
    start = _ts(req.start) if req.start else _ts(cur["start"])
    if not start or (req.start and not _ts(req.start)) or (req.end and not _ts(req.end)):
        raise HTTPException(400, "give the start (and end) as timestamps")
    end = None
    if layer.puck_type != "event":
        end = _ts(req.end) if req.end else (start + (_ts(cur["end"]) - _ts(cur["start"])) if cur["start"] and cur["end"] else None)
        if not end or end <= start:
            raise HTTPException(400, "the end must be after the start")
    changes: dict[str, tuple[datetime, Optional[datetime]]] = {cur["key"]: (start, end)}
    by_key = {i["key"]: i for i in items}
    _prog_check(items)
    if req.mode == "push" and layer.puck_type == "standard":
        queue, steps = [cur["key"]], 0
        while queue:
            steps += 1
            if steps > 4 * len(items) + 10:
                raise HTTPException(400, "the tasks after it form a dependency cycle: nothing can be pushed")
            a = queue.pop(0)
            a_end = changes[a][1]
            for bk in by_key[a]["dependents"]:
                b = by_key[bk]
                bs, be = changes.get(bk) or (_ts(b["start"]), _ts(b["end"]))
                if bs is None or a_end is None or bs >= a_end:
                    continue
                shift = a_end - bs
                changes[bk] = (bs + shift, be + shift if be else None)
                queue.append(bk)
    trial = [{**i, "start": _iso(changes[i["key"]][0]), "end": _iso(changes[i["key"]][1]) if changes[i["key"]][1] else None} if i["key"] in changes else i for i in items]
    _prog_check(trial)
    tby = {i["key"]: i for i in trial}
    conflicts = [{"key": k, "title": tby[k]["title"], **v} for k in changes for v in tby[k]["violations"] if v["kind"] in ("predecessor", "successor", "cycle")]
    refused = None
    if req.mode == "block" and conflicts:
        refused = f"Refused: {conflicts[0]['title']} {conflicts[0]['details']}" + (f" (and {len(conflicts) - 1} more)" if len(conflicts) > 1 else "")
    elif req.mode == "push":
        early = [c for c in conflicts if c["key"] == cur["key"] and c["kind"] == "predecessor"]
        if early:
            refused = f"Refused: {cur['title']} {early[0]['details']} (push moves only the tasks after it)"
    out = [] if refused else [{"layer": by_key[k]["layer"], "primary_key": by_key[k]["id"], "title": by_key[k]["title"], "key": k,
                               "before": {"start": by_key[k]["start"], "end": by_key[k]["end"]},
                               "after": {"start": _iso(s), "end": _iso(e) if e else None}} for k, (s, e) in changes.items()]
    return {"changes": out, "conflicts": [] if refused else conflicts, "refused": refused}


class ProgramSaveIn(BaseModel):
    layers: list[ProgramLayer] = Field(min_length=1, max_length=12)
    edits: list[ProgramEdit] = Field(min_length=1, max_length=500)
    scenario_id: Optional[str] = None


@router.post("/program/save")
def program_save(req: ProgramSaveIn) -> dict:
    """Save edits through each layer's save handler action (an action on the layer's object type whose parameters have
    the start / end property ids; the dependency property's parameter, if any, keeps its value), in the scenario when
    given. Every edit is checked before any is applied."""
    by = {x.id: x for x in req.layers}
    plan = []
    with _in(req.scenario_id), _lock:
        for e in req.edits:
            layer = by.get(e.layer)
            if not layer:
                raise HTTPException(400, f"no layer {e.layer}")
            name = layer.name or layer.id
            if layer.puck_type == "background":
                raise HTTPException(400, f"layer {name}: background pucks are read-only")
            if not layer.save_action_id:
                raise HTTPException(400, f"layer {name} has no save handler action")
            t, props = _prog_type(layer)
            act = ontology._get("action-types", layer.save_action_id, "action type")
            if act.get("object_type_id") != t["id"]:
                raise HTTPException(400, f"layer {name}: the save handler must be an action on {t['display_name']}")
            params = {p["id"]: p for p in act.get("parameters") or []}
            wanted = [layer.start_property] + ([layer.end_property] if layer.end_property and layer.puck_type != "event" else [])
            missing = [k for k in wanted if k not in params]
            if missing:
                raise HTTPException(400, f"layer {name}: the save handler needs parameters with the property ids {', '.join(missing)}")
            o = ontology._objects(t["id"]).get(e.primary_key)
            if o is None or not ontology._can_see(t, o):
                raise HTTPException(404, f"{e.primary_key} not found in {t['display_name']}")
            s, en = _ts(e.start), _ts(e.end)
            if not s or (e.end and not en) or (en and en <= s):
                raise HTTPException(400, f"{e.primary_key}: give a start, and an end after it")
            obj_param = next((p["id"] for p in params.values() if p.get("type") == "object"), "object")
            values = {obj_param: e.primary_key, layer.start_property: _prog_value(s, props[layer.start_property]["type"])}
            if layer.end_property and layer.puck_type != "event" and en:
                values[layer.end_property] = _prog_value(en, props[layer.end_property]["type"], True)
            dep = layer.dependency_property
            if dep and dep in params:
                values[dep] = o.get("properties", {}).get(dep)
            plan.append((layer.save_action_id, values))
    with _in(req.scenario_id):
        for action_id, values in plan:
            if req.scenario_id:
                import ontology_scenarios

                ontology_scenarios.apply_in_scenario(req.scenario_id, action_id, ontology_scenarios.ApplyIn(parameters=values))
            else:
                ontology.apply_action(action_id, ontology.ApplyAction(parameters=values))
    return {"saved": len(plan), "scenario_id": req.scenario_id}
