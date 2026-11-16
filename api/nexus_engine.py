"""Semantic knowledge-graph engine behind the Intelligence Nexus pages in Vertex (grid_nexus, jkn_nexus).

A Domain is pure configuration: which live Object Types it covers (curated core types + name patterns), how they are
grouped and coloured, the curated semantic layer (definitions, property meanings, link terms, edge kinds, search
intents) and which registered ML models score which type. The engine reads everything else from the live platform:
object types, link types, actions, published functions (as Vertex associates them), the model registry, and objects as
the caller sees them (markings and object policies apply).

Honesty rules shared by every domain: an Object Type's own ontology description is the only VERIFIED definition;
everything curated in a Domain is returned with `source: "interpretation"`, and properties without a curated meaning
are flagged unverified rather than given an invented one. No relationship is invented: schema edges are live link
types, plus a domain's explicit property references (flagged `verified: False`).
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

EDGE_KINDS = ("physical_asset", "electrical_topology", "operational_dependency", "data_lineage", "logical")
DATA = Path(__file__).resolve().parent.parent / "data"


@dataclass
class ModelSpec:
    """Registered models of one project folder, associated with one object type (the type they score)."""

    project: str                 # the model's path[0] in the registry
    target: str                  # curated type name the models score
    main_prefix: str             # the deployed/main model's name prefix (others are benchmark/alternative candidates)
    state_file: Optional[str] = None  # data/<state_file> holding an experiment record for the main model
    state_key: str = "ml_experiment"
    main_term: str = "scores"
    other_term: str = "benchmarked on"
    note: str = ""               # one sentence for the inspector: how the association is known


@dataclass
class Domain:
    key: str
    name: str
    targets: list[str]
    extra_prefixes: tuple[str, ...] = ()
    contains: tuple[str, ...] = ()           # an extra type matches when its name contains one of these
    category: dict[str, str] = field(default_factory=dict)
    extra_category: Callable[[str], str] = lambda name: "Other"
    category_color: dict[str, str] = field(default_factory=dict)
    semantic: dict[str, dict[str, str]] = field(default_factory=dict)
    prop_meaning: dict[str, str] = field(default_factory=dict)
    edge_terms: dict[str, str] = field(default_factory=dict)
    edge_kind_rules: list[tuple[str, str]] = field(default_factory=list)
    intents: list[dict] = field(default_factory=list)
    models: list[ModelSpec] = field(default_factory=list)
    hierarchy_start: str = ""
    extra_edges: Optional[Callable[[dict[str, dict], list[dict]], list[dict]]] = None


# ------------------------------------------------------------------------------------------------
# resolving the live ontology
# ------------------------------------------------------------------------------------------------

def norm(name: str) -> str:
    return (name or "").removesuffix(" (demo)").strip().lower()


def _is_extra(d: Domain, display_name: str) -> bool:
    n = display_name or ""
    low = n.lower()
    if " log " in low or low.endswith(" log") or low.endswith(" log (demo)") or "manual" in low or "(test" in low or ", test)" in low:
        return False
    return any(n.startswith(p) for p in d.extra_prefixes) or any(c in n for c in d.contains)


def _excluded(display_name: str) -> bool:
    low = (display_name or "").lower()
    return " log " in low or low.endswith(" log") or low.endswith(" log (demo)") or "manual" in low or "(test" in low or ", test)" in low


def types(d: Domain) -> dict[str, dict]:
    """curated name → live object-type record: the domain's core types, every other type its patterns match, and —
    so a type created and linked to the domain joins it without any configuration — every type a link type connects
    to one of those (one hop; such a record carries `_joined_via`). Machinery log types and test/manual copies are
    excluded."""
    import ontology

    out: dict[str, dict] = {}
    all_types = ontology._all("object-types")
    for t in all_types:
        key = norm(t["display_name"])
        for want in d.targets:
            if key == norm(want):
                out[want] = t
        if _is_extra(d, t["display_name"]):
            out.setdefault(t["display_name"].removesuffix(" (demo)"), t)
    inside = {t["id"]: name for name, t in out.items()}
    by_id = {t["id"]: t for t in all_types}
    for lt in ontology._all("link-types"):
        a, b = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        for here, there in ((a, b), (b, a)):
            if here in inside and there not in inside and there in by_id and not _excluded(by_id[there]["display_name"]):
                t = by_id[there]
                name = t["display_name"].removesuffix(" (demo)")
                if name not in out:
                    out[name] = {**t, "_joined_via": inside[here]}
    return out


def ontology_signature() -> str:
    """Changes to object, link or action types (count and last write per folder): the schema cache is only valid while
    this stays the same, and the Nexus page polls it to pick up new types and relationships."""
    import os

    import ontology

    parts = []
    for folder in ("object-types", "link-types", "action-types"):
        n, m = 0, 0.0
        try:
            with os.scandir(ontology.DIR / folder) as it:
                for e in it:
                    if e.name.endswith(".json"):
                        n += 1
                        m = max(m, e.stat().st_mtime)
        except OSError:
            pass
        parts.append(f"{n}:{m:.3f}")
    return "|".join(parts)


def visible(t: dict) -> bool:
    import auth

    try:
        return any(x["id"] == t["id"] for x in auth.visible_resources("object_type", [t]))
    except Exception:  # noqa: BLE001 - visibility service unavailable: fall back to record access
        return True


def objects_as_caller(t: dict) -> dict[str, dict]:
    import ontology

    try:
        rec = ontology._object_type(t["id"])
        return {pk: o for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(rec, o)}
    except HTTPException:
        return {}


def functions_for(t: dict, fns: Optional[list[dict]] = None) -> list[dict]:
    """Published functions taking objects of this type — the association Vertex itself computes (vertex._fn_shape).
    fns: the registry's functions read once per schema (reading them per type costs seconds each)."""
    import ontology
    import vertex

    try:
        rec = ontology._object_type(t["id"])
        out = []
        for f in (fns if fns is not None else vertex._functions()):
            shape = vertex._fn_shape(f, rec)
            if shape:
                out.append({"id": f["id"], "name": f["name"], "doc": f.get("doc") or "", "version": f.get("version"), "output": f.get("output"), **shape})
        return sorted(out, key=lambda f: f["name"])
    except Exception:  # noqa: BLE001
        return []


def actions_for(tid: str) -> list[dict]:
    import ontology

    return [{"id": a["id"], "name": a["display_name"], "kind": a.get("kind"), "description": a.get("description") or ""}
            for a in ontology._all("action-types") if a.get("object_type_id") == tid and "(test" not in a["display_name"] and ", test)" not in a["display_name"]]


def edge_kind(d: Domain, link_name: str) -> str:
    for needle, kind in d.edge_kind_rules:
        if needle.lower() in (link_name or "").lower():
            return kind
    return "logical"


def edge_term(d: Domain, link_name: str) -> str:
    return d.edge_terms.get(link_name or "", "related to")


def node_semantic(d: Domain, t: dict, want: str) -> dict:
    sem = d.semantic.get(want)
    props = []
    for p in t.get("properties") or []:
        meaning = d.prop_meaning.get(p["api_name"])
        props.append({"api_name": p["api_name"], "display_name": p.get("display_name") or p["api_name"],
                      "type": p.get("type"), "ontology_description": p.get("description") or "",
                      "meaning": meaning, "meaning_source": "interpretation" if meaning else None,
                      "verified": bool(p.get("description"))})
    return {
        "verified_definition": t.get("description") or None,
        "verified_source": "ontology" if t.get("description") else None,
        "interpretation": ({"definition": sem["definition"], "business_context": sem["business_context"],
                            "operational_purpose": sem["operational_purpose"], "source": "interpretation"} if sem else None),
        "properties": props,
        "unverified_properties": [p["api_name"] for p in props if not p["verified"] and not p["meaning"]],
    }


def pseudo_semantic(definition: Optional[str], source: str = "registry") -> dict:
    return {"verified_definition": definition or None, "verified_source": source if definition else None,
            "interpretation": None, "properties": [], "unverified_properties": []}


def function_nodes(d: Domain, type_nodes: list[dict]) -> tuple[list[dict], list[dict]]:
    nodes, edges, seen = [], [], set()
    color = d.category_color.get("Functions", "#c084fc")
    for tn in type_nodes:
        for f in tn.get("functions") or []:
            if f["id"] in seen:
                continue
            seen.add(f["id"])
            nid = f"fn:{f['id']}"
            nodes.append({"id": nid, "node_kind": "function", "core": False, "name": f["name"], "display_name": f["name"],
                          "api_name": f["name"], "category": "Functions", "color": color,
                          "status": f.get("version"), "primary_key": None, "title_property": None, "object_count": None,
                          "visible": True, "property_count": 0, "backing_dataset": None,
                          "semantic": pseudo_semantic(f.get("doc")), "actions": [], "functions": [],
                          "doc": f.get("doc") or "", "output": f.get("output"), "version": f.get("version"),
                          "on_type_id": tn["id"], "on_type_name": tn["name"]})
            edges.append({"id": f"fnedge:{f['id']}", "name": f"{f['name']} (function)", "term": "runs on", "term_source": "interpretation",
                          "kind": "function_association", "edge_kind": "logical", "edge_kind_source": "interpretation",
                          "link_kind": "function", "cardinality": "many_to_one", "foreign_key": None,
                          "source": nid, "target": tn["id"], "source_name": f["name"], "target_name": tn["name"],
                          "source_api": f["name"], "target_api": tn["api_name"], "ontology_description": f.get("doc") or "", "verified": True})
    return nodes, edges


def model_nodes(d: Domain, tps: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """Registered models of the domain's projects, each associated with the type its spec says it scores; the main
    model carries the metrics of its recorded experiment (demo state), when one exists."""
    nodes, edges = [], []
    try:
        import model_assets

        registered = model_assets.list_models()
    except Exception:  # noqa: BLE001
        registered = []
    deployments: dict[str, Any] = {}
    try:
        import model_deployments

        for dep in model_deployments.list_deployments():
            deployments[(dep.get("name") or "").removesuffix(" (master)")] = dep.get("status")
    except Exception:  # noqa: BLE001
        pass
    color = d.category_color.get("ML models", "#facc15")
    for spec in d.models:
        target = tps.get(spec.target)
        exp: dict = {}
        if spec.state_file:
            try:
                exp = json.loads((DATA / spec.state_file).read_text(encoding="utf-8")).get(spec.state_key) or {}
            except Exception:  # noqa: BLE001
                exp = {}
        metrics = {k: rows[-1].get("value") for k, rows in (exp.get("metrics") or {}).items() if rows}
        for m in registered:
            if (m.get("path") or [""])[0] != spec.project:
                continue
            name = m.get("name") or m["id"]
            is_main = name.startswith(spec.main_prefix)
            nid = f"model:{m['id']}"
            nodes.append({"id": nid, "node_kind": "model", "core": False, "name": name, "display_name": name,
                          "api_name": name, "category": "ML models", "color": color,
                          "status": deployments.get(name), "primary_key": None, "title_property": None, "object_count": None,
                          "visible": True, "property_count": 0, "backing_dataset": None,
                          "semantic": pseudo_semantic(m.get("description") or (
                              f"Registered ML model '{name}' in the model registry ({spec.project}/{'/'.join((m.get('path') or [])[1:])}), latest version "
                              f"{m.get('latest')}, {m.get('versions')} registered versions" + (
                                  f"; deployed model of experiment {exp.get('name')}" if is_main and exp else
                                  "" if is_main else f"; alternative candidate for scoring {spec.target}")), "registry"),
                          "actions": [], "functions": [], "latest": m.get("latest"), "versions": m.get("versions"),
                          "deployment": deployments.get(name), "rid": m.get("rid"),
                          "metrics": metrics if is_main else {}, "experiment": exp.get("name") if is_main else None,
                          "model_project": spec.project, "model_target": spec.target, "association_note": spec.note})
            if target:
                edges.append({"id": f"modeledge:{m['id']}", "name": f"{name} → {spec.target} (ML scoring)",
                              "term": spec.main_term if is_main else spec.other_term,
                              "term_source": "interpretation", "kind": "model_association", "edge_kind": "logical", "edge_kind_source": "interpretation",
                              "link_kind": "model", "cardinality": "many_to_one", "foreign_key": None,
                              "source": nid, "target": target["id"], "source_name": name, "target_name": spec.target,
                              "source_api": name, "target_api": target["api_name"],
                              "ontology_description": f"Model registry ({spec.project}) + demo experiment metadata", "verified": True})
    return nodes, edges


def schema(d: Domain) -> dict:
    import ontology

    import vertex

    tps = types(d)
    by_id = {t["id"]: want for want, t in tps.items()}
    nodes, missing = [], [w for w in d.targets if w not in tps]
    try:
        fns = vertex._functions()
    except Exception:  # noqa: BLE001
        fns = []
    all_actions = []
    for want, t in tps.items():
        vis = visible(t)
        joined = t.get("_joined_via")
        category = d.category.get(want) or ("Linked into the Nexus" if joined else d.extra_category(want))
        acts = actions_for(t["id"])
        all_actions += [{**a, "on_type": want, "on_type_id": t["id"]} for a in acts]
        nodes.append({
            "id": t["id"], "node_kind": "object_type", "core": want in d.targets, "joined_via": joined,
            "name": want, "display_name": t["display_name"], "api_name": t["api_name"],
            "category": category, "color": d.category_color.get(category, "#2dd4bf" if joined else "#94a3b8"),
            "status": t.get("status"), "primary_key": t.get("primary_key"), "title_property": t.get("title_property"),
            "object_count": ontology.object_count(t["id"]) if vis else None, "visible": vis,
            "property_count": len(t.get("properties") or []),
            "backing_dataset": ({"dataset_id": (t.get("backing_dataset") or {}).get("dataset_id"),
                                 "name": (t.get("backing_dataset") or {}).get("name")} if t.get("backing_dataset") else None),
            "semantic": node_semantic(d, t, want),
            "actions": acts,
            "functions": functions_for(t, fns),
        })
    edges = []
    for lt in ontology._all("link-types"):
        s, tg = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        if s in by_id and tg in by_id:
            nm = lt.get("display_name") or ""
            edges.append({"id": lt["id"], "name": nm or lt["id"], "kind": "link_type",
                          "term": edge_term(d, nm), "term_source": "interpretation",
                          "edge_kind": edge_kind(d, nm), "edge_kind_source": "interpretation",
                          "link_kind": lt.get("kind"), "cardinality": lt.get("cardinality"), "foreign_key": lt.get("foreign_key"),
                          "source": s, "target": tg, "source_name": by_id[s], "target_name": by_id[tg],
                          "source_api": (lt.get("source") or {}).get("api_name"), "target_api": (lt.get("target") or {}).get("api_name"),
                          "ontology_description": lt.get("description") or "", "verified": True})
    if d.extra_edges:
        edges += d.extra_edges(tps, edges)
    fn_nodes, fn_edges = function_nodes(d, nodes)
    m_nodes, m_edges = model_nodes(d, tps)
    nodes = nodes + fn_nodes + m_nodes
    edges = edges + fn_edges + m_edges
    linked = {e["source"] for e in edges} | {e["target"] for e in edges}
    for n in nodes:
        n["isolated"] = n["id"] not in linked
        n["incoming"] = [e["id"] for e in edges if e["target"] == n["id"]]
        n["outgoing"] = [e["id"] for e in edges if e["source"] == n["id"]]
    type_nodes = [n for n in nodes if n["node_kind"] == "object_type"]
    return {"nodes": nodes, "edges": edges, "missing_types": missing, "actions_all": all_actions,
            "counts": {"object_types": len(type_nodes), "objects": sum(n["object_count"] or 0 for n in type_nodes),
                       "properties": sum(n["property_count"] for n in type_nodes), "relationships": len(edges),
                       "verified_relationships": sum(1 for e in edges if e["verified"]),
                       "property_references": sum(1 for e in edges if not e["verified"] and e["kind"] == "property_reference"),
                       "functions": len(fn_nodes), "models": len(m_nodes), "actions": len(all_actions)}}


# ------------------------------------------------------------------------------------------------
# instances
# ------------------------------------------------------------------------------------------------

def instance(t: dict, pk: str, obj: dict) -> dict:
    import ontology

    pub = ontology._public_object(ontology._object_type(t["id"]), pk, obj)
    props = {k: v for k, v in (pub.get("properties") or {}).items()
             if not isinstance(v, (list, dict)) or (isinstance(v, list) and len(v) < 20)}
    return {"id": f"{t['id']}|{pk}", "object_type_id": t["id"], "type_name": t["display_name"],
            "primary_key": str(pk), "title": pub.get("title") or str(pk), "properties": props}


def instances(type_id: str, q: str = "", limit: int = 60) -> dict:
    import ontology

    try:
        t = ontology._object_type(type_id)
    except HTTPException:
        return {"available": False, "alasan": "Object type tidak ditemukan.", "objects": []}
    rows = [instance(t, pk, o) for pk, o in sorted(objects_as_caller(t).items())]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in f"{r['primary_key']} {r['title']}".lower()]
    return {"available": True, "total": len(rows), "objects": rows[: max(1, min(limit, 300))]}


def neighbors(d: Domain, type_id: str, pk: str, hops: int = 1) -> dict:
    """Instance graph around one object following the live foreign-key link types, as the caller (1 or 2 hops)."""
    import ontology

    hops = 2 if hops == 2 else 1
    try:
        start_t = ontology._object_type(type_id)
    except HTTPException:
        return {"available": False, "alasan": "Object type tidak ditemukan.", "nodes": [], "edges": []}
    scope = {t["id"]: t for t in types(d).values()} | {type_id: start_t}
    cache: dict[str, dict] = {}

    def objs(tid: str) -> dict:
        if tid not in cache:
            cache[tid] = objects_as_caller(scope[tid]) if tid in scope else {}
        return cache[tid]

    links = [lt for lt in ontology._all("link-types")
             if lt["source"]["object_type_id"] in scope and lt["target"]["object_type_id"] in scope and lt.get("foreign_key")]
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def add(tid: str, key: str) -> Optional[dict]:
        o = objs(tid).get(key)
        if o is None:
            return None
        n = instance(scope[tid], key, o)
        nodes[n["id"]] = n
        return n

    if add(type_id, pk) is None:
        return {"available": False, "alasan": "Objek tidak ditemukan atau tidak terlihat oleh akun ini.", "nodes": [], "edges": []}
    frontier = [(type_id, pk)]
    for _ in range(hops):
        nxt = []
        for tid, key in frontier:
            for lt in links:
                s_id, t_id, fk = lt["source"]["object_type_id"], lt["target"]["object_type_id"], lt["foreign_key"]
                nm = lt.get("display_name") or ""
                if s_id == tid:  # this object points at its target
                    tv = ((objs(tid).get(key) or {}).get("properties") or {}).get(fk)
                    if tv not in (None, "") and add(t_id, str(tv)):
                        edges.append({"id": f"{lt['id']}|{key}|{tv}", "source": f"{tid}|{key}", "target": f"{t_id}|{tv}",
                                      "label": nm, "term": edge_term(d, nm), "edge_kind": edge_kind(d, nm), "verified": True})
                        nxt.append((t_id, str(tv)))
                if t_id == tid:  # objects pointing at this one
                    for spk, so in objs(s_id).items():
                        if str((so.get("properties") or {}).get(fk)) == key and add(s_id, spk):
                            edges.append({"id": f"{lt['id']}|{spk}|{key}", "source": f"{s_id}|{spk}", "target": f"{tid}|{key}",
                                          "label": nm, "term": edge_term(d, nm), "edge_kind": edge_kind(d, nm), "verified": True})
                            nxt.append((s_id, spk))
                    if len(nodes) > 300:
                        break
            if len(nodes) > 300:
                break
        frontier = list(dict.fromkeys(nxt))
        if len(nodes) > 300:
            break
    return {"available": True, "nodes": list(nodes.values())[:300], "edges": edges, "truncated": len(nodes) > 300, "hops": hops}


# ------------------------------------------------------------------------------------------------
# natural-language semantic search (deterministic, over the curated layer)
# ------------------------------------------------------------------------------------------------

def _paths(edges: list[dict], a: str, b: str) -> list[str]:
    adj: dict[str, list[tuple[str, str]]] = {}
    for e in edges:
        adj.setdefault(e["source"], []).append((e["target"], e["id"]))
        adj.setdefault(e["target"], []).append((e["source"], e["id"]))
    seen, queue = {a: []}, deque([a])
    while queue:
        cur = queue.popleft()
        if cur == b:
            return seen[cur]
        for nxt, eid in adj.get(cur, []):
            if nxt not in seen:
                seen[nxt] = seen[cur] + [eid]
                queue.append(nxt)
    return []


def search(d: Domain, q: str) -> dict:
    s = schema(d)
    q = (q or "").lower()
    by_name = {n["name"]: n for n in s["nodes"]}
    scored = sorted(((sum(1 for term in i["terms"] if term in q), i) for i in d.intents), key=lambda x: -x[0])
    matched, answers = [], []
    for hit, intent in scored[:2]:
        if not hit:
            continue
        answers.append({"text": intent["answer"], "source": "interpretation"})
        for name in intent["types"]:
            if name in by_name and by_name[name]["id"] not in matched:
                matched.append(by_name[name]["id"])
    if not matched:  # plain name/property search over verified ontology facts
        for n in s["nodes"]:
            hay = f"{n['name']} {n['api_name']} {' '.join(p['api_name'] for p in n['semantic']['properties'])}".lower()
            if any(w and w in hay for w in q.split()):
                matched.append(n["id"])
    for n in s["nodes"]:
        if n.get("node_kind") == "function" and n.get("on_type_id") in matched and n["id"] not in matched:
            matched.append(n["id"])
    for mid in {e["source"] for e in s["edges"] if e["kind"] == "model_association" and e["target"] in matched}:
        if mid not in matched:
            matched.append(mid)
    edge_ids = []
    for i, a in enumerate(matched):
        for b in matched[i + 1:]:
            edge_ids += _paths(s["edges"], a, b)
    return {"nodes": matched, "edges": list(dict.fromkeys(edge_ids)),
            "objects": [{"id": n["id"], "name": n["name"]} for n in s["nodes"] if n["id"] in matched],
            "answers": answers,
            "source_note": "Jawaban adalah interpretasi kurasi di atas relasi ontology terverifikasi; jalur mengikuti link type Nexus yang nyata."}


# ------------------------------------------------------------------------------------------------
# a router per domain
# ------------------------------------------------------------------------------------------------

class SearchIn(BaseModel):
    q: str


def make_router(d: Domain, prefix: str) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[d.key])

    cache: dict[str, tuple[float, str, dict]] = {}

    @router.get("/version")
    def get_version() -> dict:
        """Cheap: the ontology signature the page polls; a change means new or edited types, links or actions."""
        import auth

        auth.require_user()
        return {"signature": ontology_signature()}

    @router.get("/schema")
    def get_schema(refresh: bool = False) -> dict:
        import time

        import auth

        auth.require_user()
        # per account (what it sees differs); valid while the ontology is unchanged (5 minutes at most, for object
        # counts, functions and models, which do not touch the ontology folders)
        who = (auth.current() or {}).get("id") or "-"
        sig = ontology_signature()
        hit = cache.get(who)
        if hit and not refresh and hit[1] == sig and time.monotonic() - hit[0] < 300:
            return hit[2]
        out = schema(d)
        out.update(available=bool(out["nodes"]), name=d.name, hierarchy_start=d.hierarchy_start,
                   category_source="interpretation — presentation grouping, not an ontology fact", signature=sig)
        cache[who] = (time.monotonic(), sig, out)
        return out

    @router.get("/instances")
    def get_instances(type_id: str, q: str = "", limit: int = 60) -> dict:
        import auth

        auth.require_user()
        return instances(type_id, q, limit)

    @router.get("/neighbors")
    def get_neighbors(type_id: str, pk: str, hops: int = 1) -> dict:
        import auth

        auth.require_user()
        return neighbors(d, type_id, pk, hops)

    @router.post("/search")
    def post_search(req: SearchIn) -> dict:
        import auth

        auth.require_user()
        return search(d, req.q)

    return router
