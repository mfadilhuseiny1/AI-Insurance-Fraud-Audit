"""Vertex, modelled on Palantir's Vertex: system graphs of Ontology objects.

A graph is a set of objects (nodes) whose edges are the Ontology's links between them (every link type, both
directions, resolved live), plus how it is drawn: the layout (auto, hierarchy left-right / top-bottom, grid, circular,
radial, horizontal row, vertical column) with node positions, and layers — per object type a color, the label
property, size by a numeric property and conditional colors (property op value → color) — and edge styles per link
type. Graphs are saved and shared; a graph can be read-only.

Exploration: Search Around from selected nodes (each link type with how many objects it reaches), multi-step Search
Arounds with filters on each step (the starting set narrows to objects connected to what the filtered last step
reached), and the selection panel's properties. Graph templates turn an analysis into a resource with object
parameters, each with its saved Search Around steps, and the layers: running a template with objects generates a
new graph.

Events: objects of an event object type (a property with a `vertex:event_intent.<primary|success|warning|danger>`
type class) linked to the graph's nodes, placed on a timeline by their first date / timestamp property, filtered by
the time selection. Scenarios: a graph can be viewed in an Ontology scenario (ontology_scenarios.py), so nodes show
the scenario's values and the objects it changed.

System flow: transactional objects grouped into edges ("Group nodes into edge" / link merging) — an object type
linked to two node types becomes edges between the nodes it connects, labelled and sized by a count or a sum of a
property — and series: per object type, monthly counts or sums of linked objects by a date property (the series
panel; time series properties open in Quiver).

Records are JSON files under data/ontology/vertex/. Mounted by server.py under /api/vertex.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _lock, _now, _read

router = APIRouter(prefix="/api/vertex")

MAX_NODES = 2000
INTENTS = ("primary", "success", "warning", "danger")


def configure() -> None:
    (ontology.DIR / "vertex").mkdir(parents=True, exist_ok=True)
    (ontology.DIR / "vertex-styles").mkdir(parents=True, exist_ok=True)


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


@contextlib.contextmanager
def _in(scenario_id: Optional[str]):
    if not scenario_id:
        yield None
        return
    import ontology_scenarios

    with ontology_scenarios.active(scenario_id) as sc:
        yield sc


# ------------------------------------------------------------------------------------------------
# nodes and edges
# ------------------------------------------------------------------------------------------------


class NodeRef(BaseModel):
    object_type_id: str
    primary_key: str


def _key(tid: str, pk: Any) -> str:
    return f"{tid}|{pk}"


def edge_arrow(lt: dict) -> str:
    """Where a link type's edge arrows point, from its sides' Vertex type classes: "target" (the default), "source",
    "none" (vertex:link_undirectional on either side) or "both" (vertex:link_bidirectional); vertex:link_primary_direction
    on a side points the arrow at that side."""
    classes = [set((lt.get(side) or {}).get("type_classes") or []) for side in ("source", "target")]
    if any("vertex:link_undirectional" in c for c in classes):
        return "none"
    if any("vertex:link_bidirectional" in c for c in classes):
        return "both"
    if "vertex:link_primary_direction" in classes[0] and "vertex:link_primary_direction" not in classes[1]:
        return "source"
    return "target"


def resolve_nodes(refs: list[NodeRef]) -> tuple[list[dict], list[dict]]:
    """Node details and every Ontology link among the nodes."""
    by_type: dict[str, set[str]] = {}
    for r in refs[:MAX_NODES]:
        by_type.setdefault(r.object_type_id, set()).add(str(r.primary_key))
    nodes = []
    types = {}
    for tid, pks in by_type.items():
        try:
            t = ontology._object_type(tid)
        except HTTPException:
            continue
        types[tid] = t
        objs = ontology._objects(tid)
        for pk in sorted(pks):
            o = objs.get(pk)
            if o is None or not ontology._can_see(t, o):
                continue
            pub = ontology._public_object(t, pk, o)
            nodes.append({"id": _key(tid, pk), "object_type_id": tid, "object_type": t["display_name"], "primary_key": pk, "title": pub["title"],
                          "properties": {k: v for k, v in pub["properties"].items() if not isinstance(v, list) or len(v) < 50}})
    present = {n["id"] for n in nodes}
    edges = []
    for lt in ontology._all("link-types"):
        s_t, t_t = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        if s_t not in by_type or t_t not in by_type:
            continue
        for s, ts in om.linked_map(lt, "forward", by_type[s_t]).items():
            for t in ts:
                a, b = _key(s_t, s), _key(t_t, t)
                if a in present and b in present:
                    edges.append({"id": f"{lt['id']}|{s}|{t}", "source": a, "target": b, "link_type_id": lt["id"], "label": lt.get("display_name") or "", "arrow": edge_arrow(lt)})
    return nodes, edges


def _event_props(t: dict) -> Optional[dict]:
    """An event object type: its intent (a vertex:event_intent.<intent> type class), the property holding each
    object's own intent (type class vertex:event_intent, values primary / success / warning / danger) and the time."""
    intent = per_object = None
    for p in t["properties"]:
        for tc in (p.get("type_classes") or []) + ([p["type_class"]] if p.get("type_class") else []):
            if tc.startswith("vertex:event_intent."):
                intent = tc.rsplit(".", 1)[-1]
            elif tc == "vertex:event_intent":
                per_object = p["api_name"]
                intent = intent or "primary"
    for tc in t.get("type_classes") or []:
        if str(tc).startswith("vertex:event_intent."):
            intent = str(tc).rsplit(".", 1)[-1]
    if intent not in INTENTS:
        return None
    when = next((p["api_name"] for p in t["properties"] if p["type"] in ("timestamp", "date")), None)
    return {"intent": intent, "intent_property": per_object, "time_property": when}


def related_events(refs: list[NodeRef], start: Optional[str] = None, end: Optional[str] = None) -> list[dict]:
    by_type: dict[str, set[str]] = {}
    for r in refs:
        by_type.setdefault(r.object_type_id, set()).add(str(r.primary_key))
    out = []
    for tid, pks in by_type.items():
        for lt, direction in om.links_of(tid):
            other = om.side_of(lt, direction)[1]["object_type_id"]
            try:
                et = ontology._object_type(other)
            except HTTPException:
                continue
            ev = _event_props(et)
            if not ev:
                continue
            objs = ontology._objects(other)
            for src, targets in om.linked_map(lt, direction, pks).items():
                for pk in targets:
                    o = objs.get(pk)
                    if o is None or not ontology._can_see(et, o):
                        continue
                    pub = ontology._public_object(et, pk, o)
                    at = pub["properties"].get(ev["time_property"]) if ev["time_property"] else None
                    if (start and at and str(at) < start) or (end and at and str(at) > end):
                        continue
                    own = pub["properties"].get(ev["intent_property"]) if ev["intent_property"] else None
                    out.append({"id": _key(other, pk), "object_type_id": other, "object_type": et["display_name"], "primary_key": pk, "title": pub["title"],
                                "intent": own if own in INTENTS else ev["intent"], "at": at, "node": _key(tid, src), "link_type_id": lt["id"]})
    uniq = {(e["id"], e["node"]): e for e in out}
    return sorted(uniq.values(), key=lambda e: str(e["at"] or ""))


def _metric(objs: list[dict], spec: str) -> float:
    """count, or sum:<property> / avg:<property> / max:<property> over grouped objects."""
    if not spec or spec == "count":
        return float(len(objs))
    kind, _, prop = spec.partition(":")
    vals = []
    for o in objs:
        try:
            vals.append(float(o["properties"].get(prop)))
        except (TypeError, ValueError):
            continue
    if not vals:
        return 0.0
    return {"sum": sum(vals), "avg": sum(vals) / len(vals), "max": max(vals), "min": min(vals)}.get(kind, float(len(vals)))


def grouped_edges(refs: list[NodeRef], groups: list[dict]) -> list[dict]:
    """Edges made of transactional objects: each group's object type links two node types; every object of it that is
    linked to a node on both sides joins the edge between those nodes."""
    by_type: dict[str, set[str]] = {}
    for r in refs:
        by_type.setdefault(r.object_type_id, set()).add(str(r.primary_key))
    out = []
    for g in groups or []:
        tid = g.get("object_type_id")
        links = [x for x in (g.get("links") or []) if x][:2]
        if not tid or len(links) != 2:
            continue
        try:
            t = ontology._object_type(tid)
            lts = [ontology._get("link-types", x, "link type") for x in links]
        except HTTPException:
            continue
        ends: list[dict[str, str]] = []
        for lt in lts:
            # from the node side to the transactional objects
            node_side = "target" if lt["source"]["object_type_id"] == tid else "source"
            node_type = lt[node_side]["object_type_id"]
            direction = "reverse" if node_side == "target" else "forward"
            m: dict[str, str] = {}
            for node_pk, tx in om.linked_map(lt, direction, by_type.get(node_type) or set()).items():
                for x in tx:
                    m.setdefault(x, _key(node_type, node_pk))
            ends.append(m)
        objs = ontology._objects(tid)
        acc: dict[tuple[str, str], list[dict]] = {}
        for x, a in ends[0].items():
            b = ends[1].get(x)
            o = objs.get(x)
            if not b or o is None or not ontology._can_see(t, o):
                continue
            acc.setdefault((a, b), []).append(ontology._public_object(t, x, o))
        for (a, b), grouped in acc.items():
            value = _metric(grouped, g.get("label") or "count")
            width = _metric(grouped, g.get("width") or g.get("label") or "count")
            out.append({"id": f"group|{g.get('id') or tid}|{a}|{b}", "source": a, "target": b, "group_id": g.get("id") or tid, "object_type_id": tid,
                        "name": g.get("name") or t.get("plural_name") or t["display_name"], "count": len(grouped), "value": value, "width_value": width,
                        "objects": [{"primary_key": o["primary_key"], "title": o["title"]} for o in grouped[:100]]})
    return out


def _bucket(at: str, bucket: str) -> Optional[str]:
    from datetime import date, timedelta

    if len(at) < 7:
        return None
    if bucket == "month":
        return at[:7]
    if len(at) < 10:
        return None
    if bucket == "week":
        try:
            d = date.fromisoformat(at[:10])
        except ValueError:
            return None
        return (d - timedelta(days=d.weekday())).isoformat()
    return at[:10]


@router.post("/series")
def series(req: dict) -> dict:
    """The series panel: per selected node and configured series, counts (or sums) of its linked objects per day,
    week or month of a date property."""
    refs = [NodeRef(**n) for n in req.get("nodes") or []][:50]
    configs = req.get("series") or {}
    out: dict[str, list[dict]] = {}
    with _in(req.get("scenario_id")), _lock:
        for r in refs:
            cfgs = configs.get(r.object_type_id) or []
            cfgs = cfgs if isinstance(cfgs, list) else [cfgs]
            for i, cfg in enumerate(cfgs):
                if not cfg.get("link_type_id") or not cfg.get("date_property"):
                    continue
                try:
                    lt = ontology._get("link-types", cfg["link_type_id"], "link type")
                    _, reach = om.side_of(lt, cfg.get("direction") or "forward")
                    other = ontology._object_type(reach["object_type_id"])
                except HTTPException:
                    continue
                objs = ontology._objects(other["id"])
                buckets: dict[str, list[dict]] = {}
                for pk in om.linked_map(lt, cfg.get("direction") or "forward", {str(r.primary_key)}).get(str(r.primary_key), []):
                    o = objs.get(pk)
                    if o is None or not ontology._can_see(other, o):
                        continue
                    pub = ontology._public_object(other, pk, o)
                    k = _bucket(str(pub["properties"].get(cfg["date_property"]) or ""), cfg.get("bucket") or "month")
                    if k:
                        buckets.setdefault(k, []).append(pub)
                metric = cfg.get("metric") or "count"
                out.setdefault(_key(r.object_type_id, r.primary_key), []).append({
                    "label": cfg.get("label") or f"{metric} of {other['display_name']}", "metric": metric, "bucket": cfg.get("bucket") or "month",
                    "points": [{"at": k, "value": _metric(v, metric), "count": len(v)} for k, v in sorted(buckets.items())]})
    return {"series": out}


READOUT_MAX = 50
READOUT_STATS = ("last", "mean", "min", "max", "first")


class ReadoutsIn(BaseModel):
    nodes: list[NodeRef] = Field([], max_length=MAX_NODES)
    # object type id -> {property: time series property, stat: last | mean | min | max | first}
    readouts: dict[str, dict] = {}
    # the time window the statistic covers (a Workshop widget's time window / selected time); none: the whole series
    start: Optional[str] = None
    end: Optional[str] = None


@router.post("/readouts")
def readouts(req: ReadoutsIn) -> dict:
    """Time series readouts on nodes: a statistic of each node's time series property (the first 50 nodes), over the
    time window given (last: the value at its end)."""
    import ts_ontology

    out: dict[str, dict] = {}
    for n in [x for x in req.nodes if (req.readouts.get(x.object_type_id) or {}).get("property")][:READOUT_MAX]:
        cfg = req.readouts[n.object_type_id]
        stat = cfg.get("stat") if cfg.get("stat") in READOUT_STATS else "last"
        key = _key(n.object_type_id, n.primary_key)
        try:
            r = ts_ontology.object_series(n.object_type_id, n.primary_key, property=cfg["property"], start=req.start or None, end=req.end or None, buckets=10, resource="vertex")
        except HTTPException as e:
            out[key] = {"error": str(e.detail)}
            continue
        st = r.get("stats") or {}
        out[key] = {"value": st.get(stat), "stat": stat, "unit": r.get("unit"), "at": st.get("last_ts"), "points": st.get("points")}
    return out


class CompareIn(BaseModel):
    nodes: list[NodeRef] = Field([], max_length=MAX_NODES)
    scenario_id: str


@router.post("/compare")
def compare(req: CompareIn) -> dict:
    """What-if: the graph's objects in main and in a scenario — the properties that differ, and the objects the
    scenario created or deleted."""
    with _lock:
        base, _ = resolve_nodes(req.nodes)
        with _in(req.scenario_id):
            alt, _ = resolve_nodes(req.nodes)
    a = {n["id"]: n for n in base}
    b = {n["id"]: n for n in alt}
    rows = []
    for nid in sorted(set(a) | set(b)):
        x, y = a.get(nid), b.get(nid)
        if not x or not y:
            rows.append({"id": nid, "title": (x or y)["title"], "object_type": (x or y)["object_type"], "status": "created" if y else "deleted", "changes": []})
            continue
        changes = [{"property": k, "baseline": x["properties"].get(k), "scenario": y["properties"].get(k)}
                   for k in sorted(set(x["properties"]) | set(y["properties"])) if x["properties"].get(k) != y["properties"].get(k)]
        if changes:
            rows.append({"id": nid, "title": y["title"], "object_type": y["object_type"], "status": "modified", "changes": changes})
    return {"scenario_id": req.scenario_id, "objects": rows, "unchanged": len(set(a) & set(b)) - sum(1 for r in rows if r["status"] == "modified")}


@router.post("/resolve")
def resolve(req: dict) -> dict:
    """Nodes, edges and related events for a set of objects (optionally inside an Ontology scenario)."""
    refs = [NodeRef(**n) for n in req.get("nodes") or []]
    with _in(req.get("scenario_id")) as sc, _lock:
        nodes, edges = resolve_nodes(refs)
        groups = grouped_edges(refs, req.get("edge_groups") or [])
        events = related_events(refs, req.get("start"), req.get("end"))
        # edges a function-backed Search Around added (kept with the graph), between nodes still on it
        present = {n["id"] for n in nodes}
        have = {e["id"] for e in edges}
        for fe in (req.get("function_edges") or [])[:MAX_NODES * 2]:
            eid = f"fn|{fe.get('function_id')}|{fe.get('source')}|{fe.get('target')}"
            if fe.get("source") in present and fe.get("target") in present and eid not in have:
                have.add(eid)
                edges.append({"id": eid, "source": fe["source"], "target": fe["target"], "link_type_id": f"fn:{fe.get('function_id')}", "label": str(fe.get("label") or ""), "derived": True})
        changed = []
        if sc:
            import ontology_scenarios

            cur = _read(ontology_scenarios._path(sc["id"])) or {}
            changed = [_key(tid, pk) for tid, objs in (cur.get("objects") or {}).items() for pk in objs]
    return {"nodes": nodes, "edges": edges, "grouped_edges": groups, "events": events, "scenario_changed": changed}


# ------------------------------------------------------------------------------------------------
# functions: Search Arounds and derived properties backed by published functions
# ------------------------------------------------------------------------------------------------

FN_MAX_CALLS = 50


def _fn_shape(f: dict, t: dict) -> Optional[dict]:
    """How a published function takes objects of a type, if it can be run from a graph: exactly one input of the
    type (an object, an array of objects or an object set), no other required input, no edits.
    {param, mode: one | many | set, returns: objects | value}"""
    names = {t["api_name"], t["id"]}
    hits = []
    for i in f.get("inputs") or []:
        ty = str(i.get("type") or "")
        for prefix, mode in (("array<object:", "many"), ("object_set:", "set"), ("object:", "one")):
            if ty.startswith(prefix):
                if ty[len(prefix):].rstrip(">") in names:
                    hits.append((i["name"], mode))
                break
    out = str(f.get("output") or "")
    if len(hits) != 1 or f.get("edits") or out == "edits":
        return None
    if any(i.get("required", True) and i["name"] != hits[0][0] for i in f.get("inputs") or []):
        return None
    return {"param": hits[0][0], "mode": hits[0][1], "returns": "objects" if out.startswith(("object:", "array<object:", "object_set:")) else "value"}


def _functions() -> list[dict]:
    import functions_registry

    with functions_registry._lock:
        return [f for f in functions_registry.all_functions() if functions_registry._visible_repo(f["repo_id"])]


@router.get("/functions")
def functions_for(object_type_id: str) -> list[dict]:
    """The published functions that run from objects of a type: those returning objects are Search Arounds, the
    others derived properties."""
    t = ontology._object_type(object_type_id)
    out = []
    for f in _functions():
        shape = _fn_shape(f, t)
        if shape:
            out.append({"id": f["id"], "name": f["name"], "doc": f.get("doc") or "", "version": f.get("version"), "output": f.get("output"), **shape})
    return sorted(out, key=lambda f: f["name"])


def _run_for(function_id: str, version: Optional[str], t: dict, pks: list[str]) -> tuple[dict, list[tuple[Optional[str], Any]], list[str]]:
    """Run a function from objects of a type: per object (the first FN_MAX_CALLS), or once for all of them.
    Returns the function, [(starting primary key, or None for a call over all, value)] and the errors."""
    import functions_registry

    f = next((x for x in _functions() if x["id"] == function_id), None)
    shape = _fn_shape(f, t) if f else None
    if not f or not shape:
        raise HTTPException(400, f"that function does not take one {t['display_name']} input (an object, an array or an object set)")
    calls = [(pk, {shape["param"]: pk}) for pk in pks[:FN_MAX_CALLS]] if shape["mode"] == "one" else \
        [(None, {shape["param"]: pks if shape["mode"] == "many" else {"object_type_id": t["id"], "primary_keys": pks}})]
    values, errors = [], []
    for pk, inputs in calls:
        res = functions_registry.run_function(function_id, version, inputs, {"resource": "vertex"})
        if res.get("ok"):
            values.append((pk, res.get("value")))
        else:
            errors.append(f"{pk or 'all'}: {res.get('error')}")
    if shape["mode"] == "one" and len(pks) > FN_MAX_CALLS:
        errors.append(f"run for the first {FN_MAX_CALLS} of {len(pks)} objects (the function takes one object per call)")
    return {**f, **shape}, values, errors


def _objects_in(v: Any) -> list[tuple[str, str]]:
    """(object type id, primary key) for every object in a function's result."""
    if isinstance(v, dict) and "__object__" in v:
        return [(v["__object__"]["object_type_id"], str(v["__object__"]["primary_key"]))]
    if isinstance(v, dict) and "__object_set__" in v:
        return [(v["__object_set__"]["object_type_id"], str(x)) for x in v["__object_set__"].get("primary_keys") or []]
    if isinstance(v, list):
        return [x for item in v for x in _objects_in(item)]
    return []


class FunctionAroundIn(BaseModel):
    nodes: list[NodeRef] = Field(min_length=1, max_length=MAX_NODES)
    function_id: str
    version: Optional[str] = None
    scenario_id: Optional[str] = None


@router.post("/search-around/function")
def function_search_around(req: FunctionAroundIn) -> dict:
    """A function-backed Search Around: the objects a published function returns for the selected objects, with an
    edge from each starting object to what it returned (a call over all objects at once gives no edges)."""
    types = {r.object_type_id for r in req.nodes}
    if len(types) != 1:
        raise HTTPException(400, "start a Search Around from objects of one object type")
    with _in(req.scenario_id):
        t = ontology._object_type(next(iter(types)))
        f, values, errors = _run_for(req.function_id, req.version, t, sorted({str(r.primary_key) for r in req.nodes}))
        if f["returns"] != "objects":
            raise HTTPException(400, f"{f['name']} does not return objects: use it as a derived property")
        found: dict[tuple[str, str], None] = {}
        edges = []
        for pk, v in values:
            for tid, opk in _objects_in(v):
                found[(tid, opk)] = None
                if pk is not None and (tid, opk) != (t["id"], pk):
                    edges.append({"source": _key(t["id"], pk), "target": _key(tid, opk), "label": f["name"], "function_id": f["id"]})
        with _lock:
            # only objects the caller can see are added
            seen = {n["id"] for n in resolve_nodes([NodeRef(object_type_id=a, primary_key=b) for a, b in found])[0]}
    nodes = [{"object_type_id": a, "primary_key": b} for a, b in found if _key(a, b) in seen]
    if len(nodes) > MAX_NODES:
        raise HTTPException(400, f"{f['name']} returns {len(nodes):,} objects; a graph holds at most {MAX_NODES:,}")
    return {"function": f["name"], "nodes": nodes, "edges": [e for e in edges if e["target"] in seen], "errors": errors}


class DerivedIn(BaseModel):
    nodes: list[NodeRef] = Field([], max_length=MAX_NODES)
    # object type id -> [{name, function_id, version?}]
    derived: dict[str, list[dict]] = {}
    scenario_id: Optional[str] = None


def _plain_value(v: Any) -> Any:
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, dict) and "__object__" in v:
        return v["__object__"].get("title") or v["__object__"].get("primary_key")
    if isinstance(v, list):
        return ", ".join(str(_plain_value(x)) for x in v[:20])
    return json.dumps(v, ensure_ascii=False, default=str)[:200]


@router.post("/derived")
def derived(req: DerivedIn) -> dict:
    """Derived properties of nodes: a function's value per object, under the configured name. A function taking one
    object runs per node (the first FN_MAX_CALLS of a type); one taking an array or an object set runs once and
    returns a map from primary key to value."""
    by_type: dict[str, list[str]] = {}
    for n in req.nodes:
        by_type.setdefault(n.object_type_id, []).append(str(n.primary_key))
    values: dict[str, dict] = {}
    errors: list[str] = []
    with _in(req.scenario_id):
        for tid, specs in req.derived.items():
            if tid not in by_type:
                continue
            t = ontology._object_type(tid)
            for spec in specs[:5]:
                name = str(spec.get("name") or "").strip()
                if not name or not spec.get("function_id"):
                    continue
                try:
                    f, results, errs = _run_for(spec["function_id"], spec.get("version"), t, by_type[tid])
                except HTTPException as e:
                    errors.append(f"{name}: {e.detail}")
                    continue
                errors += [f"{name}: {e}" for e in errs]
                for pk, v in results:
                    if pk is not None:
                        values.setdefault(_key(tid, pk), {})[name] = _plain_value(v)
                    elif isinstance(v, dict):
                        for k, x in v.items():
                            values.setdefault(_key(tid, k), {})[name] = _plain_value(x)
                    else:
                        errors.append(f"{name}: {f['name']} runs over all objects at once and must return a map from primary key to value")
    return {"values": values, "errors": errors}


class AroundIn(BaseModel):
    nodes: list[NodeRef] = Field(min_length=1, max_length=MAX_NODES)
    scenario_id: Optional[str] = None


@router.post("/search-around/options")
def around_options(req: AroundIn) -> list[dict]:
    """The link types leading out of the selected nodes, with how many objects each reaches."""
    by_type: dict[str, set[str]] = {}
    for r in req.nodes:
        by_type.setdefault(r.object_type_id, set()).add(str(r.primary_key))
    out = []
    with _in(req.scenario_id), _lock:
        for tid, pks in by_type.items():
            for lt, direction in om.links_of(tid):
                start, reach = om.side_of(lt, direction)
                reached = {x for v in om.linked_map(lt, direction, pks).values() for x in v}
                try:
                    other = ontology._object_type(reach["object_type_id"])
                except HTTPException:
                    continue
                if link_merged(other) or relation_merged(lt, direction):
                    # an intermediary (vertex:link_merge, or link_merge_incoming / _outgoing on this relation): offer the
                    # objects beyond it, drawn with it as edges
                    for lt2, d2 in om.links_of(other["id"]):
                        if lt2["id"] == lt["id"]:
                            continue
                        far = ontology._read(ontology._path("object-types", om.side_of(lt2, d2)[1]["object_type_id"]))
                        if not far:
                            continue
                        beyond = {x for v in om.linked_map(lt2, d2, reached).values() for x in v}
                        out.append({"link_type_id": lt["id"], "direction": direction, "from_type_id": tid, "to_type_id": far["id"], "via": {
                            "object_type_id": other["id"], "object_type": other["display_name"], "link_type_id": lt2["id"], "direction": d2},
                            "label": f"{far.get('plural_name') or far['display_name']} via {other['display_name']}", "object_type": far["display_name"],
                            "count": len(beyond)})
                    continue
                out.append({"link_type_id": lt["id"], "direction": direction, "from_type_id": tid, "to_type_id": other["id"],
                            "label": reach.get("plural_display_name") or reach.get("display_name") or other["display_name"], "object_type": other["display_name"],
                            "count": len(reached)})
    return sorted(out, key=lambda o: -o["count"])


def link_merged(t: dict) -> bool:
    """An object type Vertex treats as an intermediary (vertex:link_merge on the type or one of its properties)."""
    return "vertex:link_merge" in (t.get("type_classes") or []) or any("vertex:link_merge" in (p.get("type_classes") or []) for p in t.get("properties") or [])


def relation_merged(lt: dict, direction: str) -> bool:
    """Whether a link type merges the object it reaches in this direction, for this relation only:
    vertex:link_merge_incoming merges its target (to) side, vertex:link_merge_outgoing its source (from) side. The type
    class sits on the link type or either of its sides."""
    classes = set(lt.get("type_classes") or []) | {c for side in ("source", "target") for c in (lt.get(side) or {}).get("type_classes") or []}
    return ("vertex:link_merge_incoming" in classes and direction == "forward") or ("vertex:link_merge_outgoing" in classes and direction == "reverse")


class Step(BaseModel):
    link_type_id: str
    direction: Literal["forward", "reverse"] = "forward"
    filters: list[dict] = []


class SearchAroundIn(BaseModel):
    nodes: list[NodeRef] = Field(min_length=1, max_length=MAX_NODES)
    steps: list[Step] = Field(min_length=1, max_length=5)
    scenario_id: Optional[str] = None
    # a page of the last step's objects (in primary key order): a few objects of a link reaching thousands
    limit: Optional[int] = Field(None, ge=1, le=MAX_NODES)
    offset: int = Field(0, ge=0)


def _visible(t: dict, objs: Any, keys: list[str], cap: Optional[int] = None) -> list[str]:
    """The keys the caller may see, in order, up to cap; a live type's objects are fetched in batches, not one by one."""
    out: list[str] = []
    for i in range(0, len(keys), 500):
        part = keys[i:i + 500]
        if hasattr(objs, "prefetch"):
            objs.prefetch(part)
        out += [x for x in part if x in objs and ontology._can_see(t, objs[x])]
        if cap and len(out) >= cap:
            return out[:cap]
    return out


@router.post("/search-around")
def search_around(req: SearchAroundIn) -> dict:
    """A multi-step Search Around: each step's objects (filtered), and the starting objects narrowed to those connected
    to the last step's result. With a limit, the last step keeps that many objects from offset; "reached" says how many
    it found in all."""
    import ontology_explorer as ox

    reached_all = 0
    with _in(req.scenario_id), _lock:
        types = {r.object_type_id for r in req.nodes}
        if len(types) != 1:
            raise HTTPException(400, "start a Search Around from objects of one object type")
        cur_type = next(iter(types))
        current = {str(r.primary_key) for r in req.nodes}
        layers = [{"object_type_id": cur_type, "primary_keys": sorted(current)}]
        parents: list[dict[str, list[str]]] = []
        for i, st in enumerate(req.steps):
            lt = ontology._get("link-types", st.link_type_id, "link type")
            start, reach = om.side_of(lt, st.direction)
            if start["object_type_id"] != cur_type:
                raise HTTPException(400, f"{lt.get('display_name')} does not start from the previous step's object type")
            m = om.linked_map(lt, st.direction, current)
            nxt_t = ontology._object_type(reach["object_type_id"])
            objs = ontology._objects(nxt_t["id"])
            cand = sorted({x for v in m.values() for x in v})
            paged = req.limit is not None and i == len(req.steps) - 1
            if paged and not st.filters:
                reached_all = len(cand)
                reached = _visible(nxt_t, objs, cand[req.offset:], req.limit)
            else:
                reached = _visible(nxt_t, objs, cand)
                if st.filters:
                    rows = [ontology._public_object(nxt_t, pk, objs[pk]) for pk in reached]
                    rows = ox._filter_rows(nxt_t, rows, [ox.Filter(**f) for f in st.filters])
                    reached = sorted(r["primary_key"] for r in rows)
                if paged:
                    reached_all = len(reached)
                    reached = reached[req.offset:req.offset + req.limit]
            keep = set(reached)
            parents.append({s: [x for x in ts if x in keep] for s, ts in m.items()})
            cur_type, current = nxt_t["id"], keep
            layers.append({"object_type_id": cur_type, "primary_keys": reached})
        # narrow every earlier layer to objects connected to the final result
        for i in range(len(parents) - 1, -1, -1):
            alive = set(layers[i + 1]["primary_keys"])
            layers[i]["primary_keys"] = sorted(s for s, ts in parents[i].items() if s in set(layers[i]["primary_keys"]) and any(t in alive for t in ts))
    total = sum(len(x["primary_keys"]) for x in layers)
    if total > MAX_NODES:
        raise HTTPException(400, f"the Search Around reaches {total:,} objects; a graph holds at most {MAX_NODES:,}: add filters")
    out = {"layers": layers, "nodes": [{"object_type_id": x["object_type_id"], "primary_key": pk} for x in layers for pk in x["primary_keys"]]}
    if req.limit is not None:
        out["reached"] = reached_all
    return out


# ------------------------------------------------------------------------------------------------
# graphs and templates
# ------------------------------------------------------------------------------------------------


class GraphIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    nodes: list[dict] = Field([], max_length=MAX_NODES)  # {object_type_id, primary_key, x?, y?}
    layout: str = "auto"
    layers: dict[str, dict] = {}  # object type id -> {color, label_property, size_property, rules: [{property, op, value, color}], hidden}
    edge_styles: dict[str, dict] = {}  # link type id -> {color, dashed, hidden}
    # transactional objects drawn as edges: [{id, name, object_type_id, links: [link type id, link type id], label, width}]
    edge_groups: list[dict] = Field([], max_length=20)
    # the series panel per object type: [{label, link_type_id, direction, date_property, metric, bucket: day|week|month}]
    series: dict[str, list] = {}
    # straight | curved | orthogonal
    line_type: str = "straight"
    # saved selections: [{id, name, nodes: [node ids "type|pk"]}]
    selections: list[dict] = Field([], max_length=100)
    # media layer: an image from Files under the graph {item_id, name, x, y, width, opacity}; layers may pin their
    # objects onto it with pixel-coordinate properties (layers[type].media_x / media_y)
    media: Optional[dict] = None
    # image annotations on the media layer: [{id, x, y, w, h, text, color}]
    annotations: list[dict] = Field([], max_length=200)
    # edges from function-backed Search Arounds: [{source, target, label, function_id}] (node ids "type|pk")
    function_edges: list[dict] = Field([], max_length=MAX_NODES * 2)
    time: Optional[dict] = None  # {start, end}
    scenario_id: Optional[str] = None
    read_only: bool = False
    # graph template: object parameters, each with Search Around steps run from the objects given
    template: Optional[dict] = None


def _graphs() -> list[dict]:
    return ontology._all("vertex")


def _graph(gid: str) -> dict:
    return ontology._get("vertex", gid, "graph")


def _check_template(tpl: Optional[dict]) -> None:
    if not tpl:
        return
    ids = set()
    for p in tpl.get("parameters") or []:
        if not p.get("id") or p["id"] in ids:
            raise HTTPException(400, "template parameters need unique ids")
        ids.add(p["id"])
        ontology._object_type(p.get("object_type_id") or "")
        for st in p.get("search_arounds") or []:
            for one in st.get("steps") or [st]:
                Step(**one)
    if not ids:
        raise HTTPException(400, "a template needs at least one object parameter")


@router.get("/graphs")
def list_graphs() -> list[dict]:
    return [{k: g.get(k) for k in ("id", "name", "description", "owner", "updated_at", "read_only")} | {"nodes": len(g.get("nodes") or []), "template": bool(g.get("template"))}
            # the object types a template takes (apps link an object to the templates that start from it)
            | {"template_types": [p.get("object_type_id") for p in (g.get("template") or {}).get("parameters") or []]}
            for g in sorted(_graphs(), key=lambda g: g.get("updated_at", ""), reverse=True)]


def _check_media(m: Optional[dict]) -> None:
    if not m:
        return
    import drive

    item = drive._item(str(m.get("item_id") or ""))
    if not str(item.get("content_type") or "").startswith("image/"):
        raise HTTPException(400, f"{item['name']} is not an image")
    if not isinstance(m.get("width"), (int, float)) or not 10 <= m["width"] <= 100_000:
        raise HTTPException(400, "give the media layer a width between 10 and 100,000")


@router.post("/graphs")
def create_graph(req: GraphIn) -> dict:
    _check_template(req.template)
    _check_media(req.media)
    rec = {"id": f"vtx-{uuid.uuid4().hex[:12]}", **req.model_dump(), "owner": _who(), "created_at": _now()}
    with _lock:
        return ontology._put("vertex", rec)


@router.get("/graphs/{gid}")
def get_graph(gid: str) -> dict:
    return _graph(gid)


@router.put("/graphs/{gid}")
def save_graph(gid: str, req: GraphIn) -> dict:
    with _lock:
        g = _graph(gid)
        if g.get("read_only") and req.read_only and g.get("owner") != _who():
            raise HTTPException(403, "this graph is read-only")
        _check_template(req.template)
        _check_media(req.media)
        g.update(req.model_dump())
        return ontology._put("vertex", g)


@router.delete("/graphs/{gid}")
def delete_graph(gid: str) -> dict:
    with _lock:
        g = _graph(gid)
        if g.get("read_only") and g.get("owner") != _who():
            raise HTTPException(403, "this graph is read-only")
        ontology._path("vertex", gid).unlink(missing_ok=True)
    return {"deleted": gid}


# ------------------------------------------------------------------ saved styles (shared across graphs)


class StyleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    layers: dict[str, dict] = {}
    edge_styles: dict[str, dict] = {}
    line_type: Optional[str] = None


@router.get("/styles")
def list_styles() -> list[dict]:
    return sorted(ontology._all("vertex-styles"), key=lambda s: s.get("name", "").lower())


@router.post("/styles")
def save_style(req: StyleIn) -> dict:
    """Save a graph's layer and edge styles under a name (a style with the same name is replaced)."""
    with _lock:
        old = next((s for s in ontology._all("vertex-styles") if s["name"].lower() == req.name.lower()), None)
        rec = {"id": old["id"] if old else f"vst-{uuid.uuid4().hex[:12]}", **req.model_dump(), "owner": _who()}
        return ontology._put("vertex-styles", rec)


@router.delete("/styles/{sid}")
def delete_style(sid: str) -> dict:
    with _lock:
        ontology._get("vertex-styles", sid, "style")
        ontology._path("vertex-styles", sid).unlink(missing_ok=True)
    return {"deleted": sid}


class RunTemplateIn(BaseModel):
    # parameter id -> primary keys
    parameters: dict[str, list[str]]
    name: Optional[str] = None
    save: bool = False


@router.post("/graphs/{gid}/run")
def run_template(gid: str, req: RunTemplateIn) -> dict:
    """Generate a graph from a template with these objects (and save it as a new graph if asked)."""
    g = _graph(gid)
    tpl = g.get("template")
    if not tpl:
        raise HTTPException(400, f"{g['name']} is not a graph template")
    nodes: list[dict] = []
    for p in tpl["parameters"]:
        pks = [str(x) for x in req.parameters.get(p["id"]) or []]
        if not pks:
            raise HTTPException(400, f"give objects for the parameter {p.get('name') or p['id']}")
        start = [NodeRef(object_type_id=p["object_type_id"], primary_key=pk) for pk in pks]
        nodes += [r.model_dump() for r in start]
        # each Search Around is one step, or a chain of steps ({"steps": [...]})
        for st in p.get("search_arounds") or []:
            res = search_around(SearchAroundIn(nodes=start, steps=[Step(**one) for one in st.get("steps") or [st]], scenario_id=g.get("scenario_id")))
            nodes += res["nodes"]
    seen, uniq = set(), []
    for n in nodes:
        k = _key(n["object_type_id"], n["primary_key"])
        if k not in seen:
            seen.add(k)
            uniq.append({"object_type_id": n["object_type_id"], "primary_key": str(n["primary_key"])})
    out = {"name": req.name or f"{g['name']} · {', '.join(v[0] for v in req.parameters.values() if v)}", "description": f"Generated from the template {g['name']}",
           "nodes": uniq, "layout": g.get("layout", "auto"), "layers": g.get("layers") or {}, "edge_styles": g.get("edge_styles") or {}, "time": g.get("time"),
           "edge_groups": g.get("edge_groups") or [], "series": g.get("series") or {}, "line_type": g.get("line_type") or "straight",
           "scenario_id": g.get("scenario_id"), "read_only": False, "template": None}
    if req.save:
        return create_graph(GraphIn(**out))
    return out
