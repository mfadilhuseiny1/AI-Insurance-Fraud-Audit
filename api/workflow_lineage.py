"""Workflow Lineage (Application Building → Workflow Lineage): the graph of the resources behind applications.

The index joins what the platform knows about each resource: object types (properties, links, interfaces they
implement, backing dataset), action types (the object type they edit, object parameters, function rules, submission
criteria), functions (object set inputs, edited types), AIP Logic (inputs, models of its LLM blocks, the actions it
applies), automations (the object type of their condition, the action / logic / function of their effect), Workshop
modules, Slate applications, custom widget sets and Developer Console applications (every resource their
configuration references), and language models. Edges run from a resource to the resources that use it.

Around the graph: node details (property provenance, links, submission criteria, rules, usages, code), color modes
(node type, ontology status, action rule, failure rate, monitoring status, last modified, project, out-of-date
functions, Workshop views, model usage, permissions of a user), "view as" permission checks and action submission
debugging, bulk changes (submission criteria from a source action, function upgrades in actions / automations /
Workshop modules, model replacement in AIP Logic, moving Files resources), and saved graphs (`.wlgraph` Files items:
node positions, text nodes, color groups, presentation frames).
"""

from __future__ import annotations

import copy
import io
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/workflow-lineage", tags=["workflow-lineage"])
WL_TYPE = "application/vnd.bluesandai.workflow-lineage+json"
DIR = Path("data/workflow_lineage")
_lock = threading.RLock()
KINDS = {
    "object_type": "Object type",
    "interface": "Interface",
    "action_type": "Action type",
    "function": "Function",
    "logic": "AIP Logic",
    "automation": "Automation",
    "workshop": "Workshop module",
    "slate": "Slate application",
    "widget_set": "Custom widget set",
    "osdk_app": "Developer Console application",
    "vertex": "Vertex graph",
    "notepad": "Notepad document",
    "machinery": "Machinery process",
    "language_model": "Language model",
}
ID_RE = re.compile(r"^(ot|if|act|fn|logic|auto|wsm|sl|ws|dca)-[0-9a-f]{6,}$")
PREFIX = {"ot": "object_type", "if": "interface", "act": "action_type", "fn": "function", "logic": "logic", "auto": "automation", "wsm": "workshop",
          "sl": "slate", "ws": "widget_set", "dca": "osdk_app"}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "workflow_lineage"
    (DIR / "graphs").mkdir(parents=True, exist_ok=True)
    (DIR / "usage").mkdir(parents=True, exist_ok=True)
    try:
        import pipeline_ai

        if record_model_usage not in pipeline_ai.USAGE_HOOKS:
            pipeline_ai.USAGE_HOOKS.append(record_model_usage)
    except (ImportError, AttributeError):
        pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _rd(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _wr(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


def _me() -> dict:
    return auth.current() or {"id": "local", "username": "local", "role": "admin", "groups": []}


def _ids(obj: Any, out: Optional[set] = None) -> set[str]:
    """Every resource id a configuration mentions (any depth)."""
    out = set() if out is None else out
    if isinstance(obj, dict):
        for v in obj.values():
            _ids(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _ids(v, out)
    elif isinstance(obj, str) and ID_RE.match(obj):
        out.add(obj)
    return out


def key_of(rid: str) -> Optional[str]:
    k = PREFIX.get(rid.split("-", 1)[0])
    return f"{k}:{rid}" if k else None


# ------------------------------------------------------------------------------------------------
# model usage (pipeline_ai.USAGE_HOOKS): requests, tokens and rate limits per model per day
# ------------------------------------------------------------------------------------------------


def record_model_usage(model: str, status: str, tokens: int = 0) -> None:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    p = DIR / "usage" / f"{day}.json"
    with _lock:
        d = _rd(p, {})
        m = d.setdefault(model, {"attempted": 0, "succeeded": 0, "rate_limited": 0, "tokens": 0})
        m["attempted"] += 1
        if status == "succeeded":
            m["succeeded"] += 1
            m["tokens"] += int(tokens or 0)
        elif status == "rate_limited":
            m["rate_limited"] += 1
        _wr(p, d)


def model_usage(days: int = 28) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(days):
        day = (datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d")
        for m, v in (_rd(DIR / "usage" / f"{day}.json", {}) or {}).items():
            o = out.setdefault(m, {"attempted": 0, "succeeded": 0, "rate_limited": 0, "tokens": 0, "by_day": []})
            for k in ("attempted", "succeeded", "rate_limited", "tokens"):
                o[k] += v.get(k, 0)
            o["by_day"].append({"day": day, **v})
    for o in out.values():
        o["by_day"].sort(key=lambda x: x["day"])
    return out


# ------------------------------------------------------------------------------------------------
# the index
# ------------------------------------------------------------------------------------------------


def _safe(f, default):
    try:
        return f()
    except Exception:  # noqa: BLE001 - one missing app must not break the graph
        return default


def _runs_file(rid: str) -> list:
    import ontology

    return ontology._read(ontology.DIR / "runs" / f"{rid}.json", []) or []


_cache: dict[str, tuple[float, dict]] = {}


def build_index(fresh: bool = False) -> dict:
    """The index for the caller, reused for 20 seconds (details and color modes ask for it often)."""
    who = str(_me().get("id"))
    hit = _cache.get(who)
    if hit and not fresh and time.monotonic() - hit[0] < 20:
        return hit[1]
    out = _build_index()
    _cache[who] = (time.monotonic(), out)
    return out


def _build_index() -> dict:
    """Nodes (the resources the caller can see) and edges (from a resource to what uses it)."""
    import ontology
    import ontology_actions

    nodes: dict[str, dict] = {}
    edges: dict[tuple, dict] = {}

    def node(kind: str, rid: str, name: str, **extra: Any) -> str:
        k = f"{kind}:{rid}"
        nodes[k] = {"key": k, "kind": kind, "id": rid, "name": name, **extra}
        return k

    def edge(a: Optional[str], b: Optional[str], kind: str, **extra: Any) -> None:
        if a and b and a != b:
            edges[(a, b, kind)] = {"from": a, "to": b, "kind": kind, **extra}

    types = ontology.list_object_types()
    api_to_type = {t["api_name"].lower(): t["id"] for t in types}
    for t in types:
        node("object_type", t["id"], t["display_name"], api_name=t["api_name"], status=t.get("status"), icon=t.get("icon"), color=t.get("color"),
             updated_at=t.get("updated_at"), properties=[p["api_name"] for p in t.get("properties") or []],
             property_names=[p.get("display_name") or p["api_name"] for p in t.get("properties") or []], ontology_id=t.get("ontology_id", "default"),
             backing=(t.get("backing_dataset") or {}).get("name"))
    import ontology_model

    for lt in _safe(ontology_model.list_link_types, []):
        s, d = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        if f"object_type:{s}" in nodes and f"object_type:{d}" in nodes:
            edge(f"object_type:{s}", f"object_type:{d}", "link", name=lt.get("display_name"), link_type_id=lt["id"], cardinality=lt.get("cardinality"))
    for i in _safe(ontology_model.list_interfaces, []):
        k = node("interface", i["id"], i.get("display_name") or i["api_name"], api_name=i.get("api_name"), status=i.get("status"), updated_at=i.get("updated_at"),
                 properties=[p["api_name"] for p in i.get("all_properties") or []])
        for impl in i.get("implemented_by") or []:
            edge(k, f"object_type:{impl['object_type_id']}", "implements")
        for parent in i.get("extends") or []:
            edge(f"interface:{parent}", k, "extends")

    funcs = _safe(lambda: __import__("functions_registry").all_functions(), [])
    # functions of the repositories the caller can see (markings, a role on the repository's Project) only
    seen_repos: dict[str, bool] = {}
    for f in funcs:
        if f.get("repo_id") not in seen_repos:
            seen_repos[f.get("repo_id")] = _repo_visible(f.get("repo_id"))
    funcs = [f for f in funcs if seen_repos.get(f.get("repo_id"))]
    fn_latest = {f["id"]: f["version"] for f in funcs}
    for f in funcs:
        k = node("function", f["id"], f.get("api_name") or f["name"], api_name=f.get("api_name"), version=f.get("version"), repo_id=f.get("repo_id"),
                 language=f.get("language") or f.get("source"), fkind=f.get("kind"), updated_at=f.get("released_at"))
        for inp in f.get("inputs") or []:
            ty = str(inp.get("type") or "")
            if ty.startswith(("object_set:", "object:")):
                tid = api_to_type.get(ty.split(":", 1)[1].lower())
                edge(f"object_type:{tid}" if tid else None, k, "input")
        for api in f.get("edits") or []:
            tid = api_to_type.get(str(api).lower())
            edge(f"object_type:{tid}" if tid else None, k, "edits")

    actions = ontology._all("action-types")
    visible_acts = {a["id"] for a in ontology.list_action_types()}
    for a in actions:
        if a["id"] not in visible_acts:
            continue
        rules = a.get("rules") or []
        rule_kinds = sorted({r.get("kind") for r in rules if r.get("kind")}) or [a.get("kind") or "modify"]
        runs = _safe(lambda a=a: ontology_actions._runs(a["id"]), {"runs": [], "alerts": []})
        k = node("action_type", a["id"], a["display_name"], api_name=a.get("api_name"), status=a.get("status"), updated_at=a.get("updated_at"),
                 rule=_rule_class(rule_kinds), rule_kinds=rule_kinds, criteria=len(a.get("submission_criteria") or []), ontology_id=a.get("ontology_id", "default"),
                 **_failure(runs.get("runs") or []), firing=sum(1 for x in runs.get("alerts") or [] if not x.get("resolved_at")), monitors=len(a.get("monitors") or []))
        edge(f"object_type:{a.get('object_type_id')}", k, "edits")
        if a.get("interface_id"):
            edge(f"interface:{a['interface_id']}", k, "edits")
        for r in rules:
            if r.get("kind") == "function" and r.get("function_id"):
                edge(f"function:{r['function_id']}", k, "function", version=r.get("version"), latest=fn_latest.get(r["function_id"]))
            if r.get("object_type_id"):
                edge(f"object_type:{r['object_type_id']}", k, "edits")
        for p in a.get("parameters") or []:
            if p.get("object_type_id"):
                edge(f"object_type:{p['object_type_id']}", k, "input")

    models = {m["id"]: m for m in _safe(lambda: __import__("knowledge").models(), [])}
    usage = model_usage()
    for mid, m in models.items():
        u = usage.get(mid, {})
        node("language_model", mid, m.get("label") or mid, vendor=m.get("vendor"), description=m.get("description"), available=m.get("available"),
             registered=mid.startswith("function:"), requests=u.get("attempted", 0), tokens=u.get("tokens", 0), rate_limited=u.get("rate_limited", 0))
    for lg in ontology.list_logic():
        runs = _runs_file(lg["id"])
        k = node("logic", lg["id"], lg["name"], updated_at=lg.get("updated_at"), runs=len(runs), **_failure(runs))
        for i in lg.get("inputs") or []:
            if i.get("object_type_id"):
                edge(f"object_type:{i['object_type_id']}", k, "input")
        for b in lg.get("blocks") or []:
            cfg = b.get("config") or {}
            if b.get("type") == "use_llm":
                mid = cfg.get("model") or ontology.DEFAULT_LLM
                if f"language_model:{mid}" not in nodes:
                    node("language_model", mid, mid, vendor=None, requests=usage.get(mid, {}).get("attempted", 0), tokens=usage.get(mid, {}).get("tokens", 0))
                edge(f"language_model:{mid}", k, "model")
            for rid in _ids(cfg):
                kk = key_of(rid)
                if kk and kk.startswith("action_type:"):
                    edge(k, kk, "applies")
                elif kk:
                    edge(kk, k, "input")

    for au in ontology.list_automations():
        runs = _safe(lambda au=au: ontology.automation_runs(au["id"]), [])
        cond, eff = au.get("condition") or {}, au.get("effect") or {}
        k = node("automation", au["id"], au["name"], enabled=au.get("enabled"), updated_at=au.get("updated_at"), condition=cond.get("kind"),
                 expires_at=au.get("expires_at"), runs=len(runs), **_failure(runs))
        for rid in _ids(cond):
            edge(key_of(rid), k, "condition")
        for rid in _ids(au.get("effects") or [eff]):  # every effect and its fallback
            kk = key_of(rid)
            if kk and kk.split(":")[0] in ("action_type", "logic", "function"):
                edge(k, kk, "effect", version=eff.get("version"), latest=fn_latest.get(eff.get("function_id") or ""))
        # the actions that write the property the condition watches trigger it
        prop = cond.get("property")
        if prop and cond.get("object_type_id"):
            for a in actions:
                if a.get("object_type_id") == cond["object_type_id"] and any(p.get("property") == prop for p in a.get("parameters") or []):
                    edge(f"action_type:{a['id']}", k, "triggers")

    import workshop

    views = _views()
    for m in _safe(workshop.list_modules, []):
        wk = views.get(m["id"], {})
        # modules are Files items (bulk move, use cases); the published version may trail the latest one (bulk publish)
        k = node("workshop", m["id"], m["name"], updated_at=m.get("updated_at"), widgets=len(m.get("widgets") or []),
                 views_4w=wk.get("total", 0), users_4w=wk.get("unique", 0), item_id=m.get("item_id"),
                 latest_version=m.get("latest_version"), published_version=m.get("published_version"))
        # widgets, and the module's own variables, derived properties and settings (navigation bar, commands)
        parts = [w.get("config") or {} for w in m.get("widgets") or []] + [{"variables": m.get("variables"), "derived": m.get("derived"), "settings": m.get("settings"), "overlays": m.get("overlays")}]
        for cfg in parts:
            for rid in _ids(cfg):
                kk = key_of(rid)
                if kk and kk.split(":")[0] in ("object_type", "action_type", "function", "logic", "widget_set", "interface"):
                    extra = {"version": cfg.get("function_version"), "latest": fn_latest.get(rid)} if kk.startswith("function:") else {}
                    edge(kk, k, "used_by", **extra)
    import slate

    for app in _safe(slate.list_apps, []):
        doc = _safe(lambda app=app: slate.get_app(app["id"])["document"], {})
        k = node("slate", app["id"], app["name"], updated_at=app.get("updated_at"), item_id=app.get("item_id"), public=app.get("type") == "public")
        for rid in _ids({x: doc.get(x) for x in ("objectSets", "objectContexts", "foundryFunctions", "events", "queries")}):
            kk = key_of(rid)
            if kk and kk.split(":")[0] in ("object_type", "action_type", "function", "logic"):
                edge(kk, k, "used_by")
    import custom_widgets

    for s in _safe(custom_widgets.list_sets, []):
        k = node("widget_set", s["id"], s["name"], updated_at=s.get("created_at"), item_id=s.get("item_id"), version=s.get("latest"))
        for rid in _ids(s.get("osdk") or {}):
            edge(key_of(rid), k, "osdk")
    import developer_console

    for app in _safe(developer_console.list_apps, []):
        k = node("osdk_app", app["id"], app["name"], updated_at=app.get("created_at"), item_id=app.get("item_id"), app_kind=app.get("kind"))
        for rid in _ids(app.get("resources") or {}):
            edge(key_of(rid), k, "osdk")
    # Vertex graphs, Machinery processes and Notepad documents that use Ontology resources
    used = ("object_type", "action_type", "function", "logic", "interface")

    def consumer(kind: str, rid: str, name: str, content: Any, **extra: Any) -> None:
        refs = [kk for kk in (key_of(r) for r in _ids(content)) if kk and kk.split(":")[0] in used]
        if not refs:
            return
        k = node(kind, rid, name, **extra)
        for kk in refs:
            edge(kk, k, "used_by")

    import vertex

    for g in _safe(vertex._graphs, []):
        consumer("vertex", g["id"], g.get("name") or g["id"], g, updated_at=g.get("updated_at"), graph_nodes=len(g.get("nodes") or []))
    import machinery

    for r in _safe(machinery._all, []):
        consumer("machinery", r["id"], r.get("name") or r["id"], r, updated_at=r.get("updated_at"), processes=len(r.get("processes") or []))
    import notepad

    for it in _safe(notepad.list_documents, [])[:300]:
        doc = _safe(lambda it=it: notepad._open(it["id"])[1], None)
        if doc:
            consumer("notepad", it["id"], re.sub(r"\.notepad$", "", it["name"]), {"blocks": doc.get("blocks"), "template": doc.get("template")}, updated_at=str(it.get("updated_at") or ""), item_id=it["id"], template=doc.get("template") is not None)
    out_edges = [e for e in edges.values() if e["from"] in nodes and e["to"] in nodes]
    for e in out_edges:
        if e.get("version") and e.get("latest") and str(e["version"]) != str(e["latest"]):
            e["out_of_date"] = True
            nodes[e["to"]]["out_of_date"] = True
    return {"nodes": list(nodes.values()), "edges": out_edges, "kinds": KINDS}


def _rule_class(kinds: list[str]) -> str:
    s = set(kinds)
    if "function" in s:
        return "function"
    objs = {k for k in s if k.endswith("object") or k in ("create", "modify", "delete")}
    tags = {("create" if "create" in k else "delete" if "delete" in k else "modify") for k in objs}
    return "combination" if len(tags) > 1 else (tags.pop() if tags else "other")


def _failure(runs: list[dict], days: int = 30) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    recent = [r for r in runs if str(r.get("at") or "") >= since]
    failed = sum(1 for r in recent if r.get("status") == "failed")
    return {"runs_30d": len(recent), "failed_30d": failed, "failure_rate": round(failed / len(recent), 3) if recent else None,
            "last_run_at": max((str(r.get("at")) for r in runs if r.get("at")), default=None)}


# ------------------------------------------------------------------------------------------------
# Workshop views (workshop.get_module calls note_view)
# ------------------------------------------------------------------------------------------------


def note_view(module_id: str) -> None:
    me = _me()
    line = json.dumps({"at": _now(), "module": module_id, "user": me.get("id")})
    with _lock:
        with open(DIR / "workshop_views.jsonl", "a", encoding="utf-8") as f:
            f.write(line + "\n")


def _view_rows(days: int = 28) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        with open(DIR / "workshop_views.jsonl", encoding="utf-8") as f:
            return [r for r in (json.loads(x) for x in f if x.strip()) if r["at"] >= since]
    except FileNotFoundError:
        return []


def _views() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in _view_rows():
        o = out.setdefault(r["module"], {"total": 0, "users": set()})
        o["total"] += 1
        o["users"].add(r["user"])
    return {k: {"total": v["total"], "unique": len(v["users"])} for k, v in out.items()}


@router.get("/usage/workshop")
def workshop_weekly(ids: str) -> dict:
    """Views per module per week over the past four weeks (total and unique users)."""
    want = set(ids.split(","))
    now = datetime.now(timezone.utc)
    weeks = [(now - timedelta(days=7 * (i + 1))).isoformat() for i in range(4)]
    out: dict[str, list] = {m: [{"week": i, "total": 0, "users": set()} for i in range(4)] for m in want}
    for r in _view_rows():
        if r["module"] not in want:
            continue
        i = next((i for i, w in enumerate(weeks) if r["at"] >= w), 3)
        out[r["module"]][i]["total"] += 1
        out[r["module"]][i]["users"].add(r["user"])
    return {m: [{"week_start": weeks[w["week"]][:10], "total": w["total"], "unique": len(w["users"])} for w in reversed(v)] for m, v in out.items()}


@router.get("/usage/models")
def models_usage(days: int = 28) -> dict:
    return model_usage(max(1, min(days, 90)))


# ------------------------------------------------------------------------------------------------
# routes: index, search, details
# ------------------------------------------------------------------------------------------------


@router.get("/index")
def index(fresh: bool = False) -> dict:
    return build_index(fresh)


@router.get("/search")
def search(q: str) -> list[dict]:
    """Resources by name, id / RID or API name, and object types with a property of that name."""
    ql = q.strip().lower()
    if not ql:
        return []
    out = []
    for n in build_index()["nodes"]:
        hay = f"{n['name']} {n['id']} {n.get('api_name') or ''}".lower()
        if ql in hay or (ql.startswith("ri.") and n["id"].split("-", 1)[-1] in ql):
            out.append({**n, "match": "name"})
        elif n["kind"] in ("object_type", "interface") and any(ql in p.lower() for p in (n.get("property_names") or []) + (n.get("properties") or [])):
            out.append({**n, "match": "property"})
    return out[:100]


@router.get("/folder/{folder_id}")
def folder_resources(folder_id: str) -> list[str]:
    """Node keys of every supported resource stored in a Files folder or Project (any depth)."""
    drive._item(folder_id, need="viewer")
    keys, stack = [], [folder_id]
    by_item = {n.get("item_id"): n["key"] for n in build_index()["nodes"] if n.get("item_id")}
    seen = set()
    while stack and len(seen) < 5000:
        fid = stack.pop()
        if fid in seen:
            continue
        seen.add(fid)
        for i in auth.visible(db.drive_query("parent_id = %s AND trashed_at IS NULL", (fid,), limit=2000)):
            if i["kind"] in ("folder", "project"):
                stack.append(i["id"])
            elif i["id"] in by_item:
                keys.append(by_item[i["id"]])
    return keys


def _prop_usage(type_id: str, idx: dict) -> dict[str, list[dict]]:
    """Property provenance: which actions, automations, Workshop widgets, Slate object sets, logic and links use each property."""
    import ontology
    import workshop

    t = ontology._object_type(type_id)
    use: dict[str, list[dict]] = {p["api_name"]: [] for p in t["properties"]}

    def add(prop: Optional[str], kind: str, rid: str, name: str, how: str) -> None:
        if prop in use and not any(x["id"] == rid and x["how"] == how for x in use[prop]):
            use[prop].append({"kind": kind, "id": rid, "name": name, "how": how})

    for a in ontology._all("action-types"):
        if a.get("object_type_id") != type_id:
            continue
        for p in a.get("parameters") or []:
            add(p.get("property"), "action_type", a["id"], a["display_name"], "edits")
        for r in a.get("rules") or []:
            for prop in (r.get("values") or {}):
                add(prop, "action_type", a["id"], a["display_name"], "edits")
        for prop in _props_in(a.get("submission_criteria") or [], use):
            add(prop, "action_type", a["id"], a["display_name"], "submission criteria")
    for au in ontology._all("automations"):
        c = au.get("condition") or {}
        if c.get("object_type_id") == type_id:
            for prop in _props_in(c, use):
                add(prop, "automation", au["id"], au["name"], "condition")
    for m in _safe(workshop.list_modules, []):
        for w in m.get("widgets") or []:
            cfg = w.get("config") or {}
            if type_id not in _ids(cfg):
                continue
            for prop in _props_in(cfg, use):
                add(prop, "workshop", m["id"], m["name"], f"{w.get('type')} widget{' ' + repr(w.get('title')) if w.get('title') else ''}")
    for lt in [e for e in idx["edges"] if e["kind"] == "link" and type_id in (e["from"].split(":")[1], e["to"].split(":")[1])]:
        import ontology_model

        rec = _safe(lambda lt=lt: ontology_model.get_link_type(lt["link_type_id"]), {}) or {}
        add(rec.get("foreign_key"), "link_type", lt["link_type_id"], lt.get("name") or "link", "foreign key")
    for n in idx["nodes"]:
        if n["kind"] == "slate":
            import slate

            doc = _safe(lambda n=n: slate.get_app(n["id"])["document"], {})
            for os_ in doc.get("objectSets") or []:
                if os_.get("object_type_id") == type_id:
                    for prop in _props_in(os_, use):
                        add(prop, "slate", n["id"], n["name"], f"object set {os_.get('name')}")
    return use


def _props_in(obj: Any, use: dict) -> set[str]:
    found: set[str] = set()

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and v in use and k in ("property", "column", "columns", "sort", "group_by", "label", "value_property", "title_property", "annotation_label", "annotation_box", "x", "y", "series", "properties"):
                    found.add(v)
                walk(v)
        elif isinstance(o, list):
            for v in o:
                if isinstance(v, str) and v in use:
                    found.add(v)
                walk(v)

    walk(obj)
    return found


@router.get("/node")
def node_details(key: str) -> dict:
    """What the selection details panel shows for one node."""
    import ontology
    import ontology_actions

    kind, _, rid = key.partition(":")
    idx = build_index()
    n = next((x for x in idx["nodes"] if x["key"] == key), None)
    if not n:
        raise HTTPException(404, "resource not found or not visible")
    names = {x["key"]: x["name"] for x in idx["nodes"]}
    ups = [{"key": e["from"], "name": names.get(e["from"]), "kind": e["kind"]} for e in idx["edges"] if e["to"] == key]
    downs = [{"key": e["to"], "name": names.get(e["to"]), "kind": e["kind"]} for e in idx["edges"] if e["from"] == key]
    out: dict[str, Any] = {"node": n, "upstream": ups, "downstream": downs, "href": _href(n)}
    if kind == "object_type":
        t = ontology.get_object_type(rid)
        use = _prop_usage(rid, idx)
        out["properties"] = [{"api_name": p["api_name"], "display_name": p.get("display_name"), "type": p.get("type"), "usages": use.get(p["api_name"], [])} for p in t["properties"]]
        out["primary_key"], out["title_property"] = t.get("primary_key"), t.get("title_property")
        out["links"] = [{"name": e.get("name"), "other": names.get(e["to"] if e["from"] == key else e["from"]), "key": e["to"] if e["from"] == key else e["from"],
                         "cardinality": e.get("cardinality")} for e in idx["edges"] if e["kind"] == "link" and key in (e["from"], e["to"])]
        out["backing_dataset"] = (t.get("backing_dataset") or {}).get("name")
        out["security"] = {"markings": t.get("markings") or [], "policies": len(t.get("property_policies") or t.get("policies") or [])}
        try:
            import workshop

            out["preview"] = workshop._object_rows(rid)[2][:5]
            for r in out["preview"]:
                r.pop("__pk", None)
        except Exception:  # noqa: BLE001
            out["preview"] = []
    elif kind == "action_type":
        a = ontology.get_action_type(rid)
        out["action"] = {k: a.get(k) for k in ("api_name", "kind", "object_type_id", "parameters", "rules", "submission_criteria", "permissions", "status", "monitors")}
        runs = _safe(lambda: ontology_actions._runs(rid), {"runs": []})["runs"]
        out["recent_runs"] = [{k: r.get(k) for k in ("at", "user", "status", "error", "ms")} for r in reversed(runs[-20:])]
        fn = next((r for r in a.get("rules") or [] if r.get("kind") == "function"), None)
        if fn:
            out["function_code"] = _function_code(fn.get("function_id"))
    elif kind == "function":
        import functions_registry

        f = _safe(lambda: functions_registry.get_function(rid), {})
        out["function"] = {k: f.get(k) for k in ("name", "api_name", "inputs", "output", "edits", "kind", "language", "version", "repo_id", "doc", "file", "line")}
        out["usages"] = _safe(lambda: functions_registry._usage(rid), [])
        out["code"] = _function_code(rid)
        out["metrics"] = _safe(lambda: {k: v for k, v in functions_registry._metrics(rid, 30).items() if k != "alerts"}, {})
    elif kind == "logic":
        lg = ontology.get_logic(rid)
        out["logic"] = {"inputs": lg.get("inputs"), "blocks": [{"name": b.get("name"), "type": b.get("type"), "model": (b.get("config") or {}).get("model")} for b in lg.get("blocks") or []],
                        "created_at": lg.get("created_at"), "description": lg.get("description")}
        out["recent_runs"] = [{k: r.get(k) for k in ("at", "status", "error", "ms")} for r in _runs_file(rid)[:20]]
    elif kind == "automation":
        au = ontology.get_automation(rid)
        out["automation"] = {k: au.get(k) for k in ("condition", "effect", "enabled", "description", "expires_at")}
        cond = au.get("condition") or {}
        out["condition_properties"] = sorted(_props_in(cond, {p: 1 for p in (next((x.get("properties") for x in idx["nodes"] if x["key"] == f"object_type:{cond.get('object_type_id')}"), None) or [])}))
        out["recent_runs"] = [{k: r.get(k) for k in ("at", "trigger", "primary_key", "status", "error")} for r in _safe(lambda: ontology.automation_runs(rid), [])[:20]]
    elif kind == "workshop":
        import workshop

        m = workshop.get_module(rid, count=False)
        ent: dict[str, list[dict]] = {}
        for w in m.get("widgets") or []:
            for r in _ids(w.get("config") or {}):
                kk = key_of(r)
                if kk:
                    ent.setdefault(kk, []).append({"widget": w["id"], "type": w.get("type"), "title": w.get("title")})
        out["widgets"] = [{"id": w["id"], "type": w.get("type"), "title": w.get("title"), "x": w.get("x"), "y": w.get("y"), "w": w.get("w"), "h": w.get("h"),
                           "uses": [k for k in (key_of(r) for r in _ids(w.get("config") or {})) if k]} for w in m.get("widgets") or []]
        out["entities"] = [{"key": k, "name": names.get(k, k), "widgets": v} for k, v in ent.items()]
    elif kind == "language_model":
        out["usage"] = model_usage().get(rid) or {"attempted": 0, "succeeded": 0, "rate_limited": 0, "tokens": 0, "by_day": []}
        out["used_by"] = downs
    elif kind == "interface":
        import ontology_model

        i = ontology_model.get_interface(rid)
        out["interface"] = {"properties": i.get("all_properties"), "implemented_by": i.get("implemented_by"), "extends": i.get("extends")}
    return out


def _repo_visible(repo_id: Optional[str]) -> bool:
    """Whether the caller can see a function's repository as /api/code-repos/{id} lets them (its markings and at least
    the Viewer role on its Project; SQL function repositories by their own rules)."""
    if not repo_id:
        return False
    try:
        import functions_registry

        return bool(functions_registry._visible_repo(repo_id))
    except Exception:  # noqa: BLE001 - a missing repository is not visible
        return False


def _function_code(fid: Optional[str]) -> Optional[dict]:
    if not fid:
        return None
    try:
        import functions_registry

        f = functions_registry.get_function(fid)
    except Exception:  # noqa: BLE001
        return None
    # the code is read from the function's repository: only for those who can see it
    if f.get("repo_id") and not _repo_visible(f["repo_id"]):
        return None
    if f.get("sql"):
        return {"language": "sql", "code": f["sql"], "file": f.get("file")}
    try:
        import code_repos

        # reading a Code Repository's files: its markings and the Viewer role on its Project (as /api/code-repos/{id})
        auth.check_resource("code_repo", f["repo_id"])
        text = code_repos._branch(code_repos._repo(f["repo_id"]), None)["files"].get(f.get("file") or "")
    except Exception:  # noqa: BLE001
        text = None
    if isinstance(text, (bytes, str)):
        lines = (text.decode("utf-8", "replace") if isinstance(text, bytes) else text).splitlines()
        start = max(0, int(f.get("line") or 1) - 1)
        return {"language": f.get("language") or "python", "code": "\n".join(lines[start:start + 40]), "file": f.get("file"), "line": f.get("line")}
    return {"language": f.get("language"), "code": None, "file": f.get("file"), "line": f.get("line")}


def _href(n: dict) -> Optional[str]:
    k, rid = n["kind"], n["id"]
    return {"object_type": f"/ontology/{rid}", "action_type": f"/ontology/actions/{rid}", "function": f"/functions?fn={rid}", "logic": f"/logic/{rid}",
            "automation": f"/automate/{rid}", "workshop": f"/workshop/{rid}", "slate": f"/slate/{rid}", "widget_set": "/custom-widgets",
            "osdk_app": "/developer-console", "interface": "/ontology", "language_model": "/models",
            "vertex": f"/vertex?id={rid}", "notepad": f"/notepad/{rid}", "machinery": f"/machinery?id={rid}"}.get(k)


# ------------------------------------------------------------------------------------------------
# organization and permissions color modes
# ------------------------------------------------------------------------------------------------


class KeysIn(BaseModel):
    keys: list[str] = Field(max_length=3000)
    user_id: Optional[str] = None


@router.post("/organization")
def organization(req: KeysIn) -> dict:
    """The Project and folder of each Files-backed node."""
    idx = {n["key"]: n for n in build_index()["nodes"]}
    out = {}
    for k in req.keys:
        n = idx.get(k)
        if not n or not n.get("item_id"):
            continue
        try:
            path = drive._with_path(drive._item(n["item_id"], need="viewer")).get("path") or []
        except HTTPException:
            continue
        if path:
            out[k] = {"project": path[0]["name"], "project_id": path[0]["id"], "folder": path[-1]["name"], "folder_id": path[-1]["id"]}
    return out


def _principal(user_id: str) -> dict:
    u = auth._user(user_id)
    return {**auth._public_user(u), "markings": auth.user_markings(u), "service": False}


@router.post("/permissions")
def permissions(req: KeysIn) -> dict:
    """What a user can do with each node: resource role (Files-backed) and ontology view / edit / data / execute."""
    import ontology
    import ontology_actions

    if not req.user_id:
        raise HTTPException(422, "choose a user")
    if req.user_id != _me().get("id"):
        auth.require_admin()
    who = _principal(req.user_id)
    idx = {n["key"]: n for n in build_index()["nodes"]}
    token = auth._principal.set(who)
    out: dict[str, dict] = {}
    try:
        visible_types = {t["id"] for t in ontology.list_object_types()}
        visible_acts = {a["id"]: a for a in ontology._all("action-types") if a["id"] in {x["id"] for x in ontology.list_action_types()}}
        for k in req.keys:
            n = idx.get(k)
            if not n:
                continue
            r: dict[str, Any] = {}
            if n.get("item_id"):
                r["resource"] = "none"
                for role in ("owner", "editor", "viewer"):
                    try:
                        drive._item(n["item_id"], need=role)
                        r["resource"] = role
                        break
                    except HTTPException:
                        continue
            if n["kind"] == "object_type":
                r["view_definition"] = n["id"] in visible_types
                r["edit_definition"] = r["view_definition"] and who.get("role") == "admin"
                r["view_data"] = r["view_definition"]
            elif n["kind"] == "action_type":
                a = visible_acts.get(n["id"])
                r["view_definition"] = a is not None
                r["edit_definition"] = a is not None and who.get("role") == "admin"
                ok = False
                if a is not None:
                    try:
                        ontology_actions._can_apply(a, who)
                        ok = True
                    except Exception:  # noqa: BLE001
                        ok = False
                r["execute"] = ok
            out[k] = r
    finally:
        auth._principal.reset(token)
    return out


@router.get("/users")
def users() -> list[dict]:
    auth.require_admin()
    return [{"id": u["id"], "name": u.get("display_name") or u.get("username"), "username": u.get("username")} for u in auth._users() if not u.get("disabled")]


class DebugIn(BaseModel):
    action_id: str
    user_id: str


@router.post("/debug-action")
def debug_action(req: DebugIn) -> dict:
    """Why a user can or cannot submit an action: visibility, apply permission, each submission criterion."""
    import ontology
    import ontology_actions

    if req.user_id != _me().get("id"):
        auth.require_admin()
    who = _principal(req.user_id)
    a = next((x for x in ontology._all("action-types") if x["id"] == req.action_id), None)
    if not a:
        raise HTTPException(404, "action type not found")
    token = auth._principal.set(who)
    try:
        sees = any(x["id"] == a["id"] for x in ontology.list_action_types())
        sees_type = any(t["id"] == a.get("object_type_id") for t in ontology.list_object_types()) if a.get("object_type_id") else True
    finally:
        auth._principal.reset(token)
    try:
        ontology_actions._can_apply(a, who)
        apply_ok, apply_msg = True, "Allowed by the action's apply permissions"
    except Exception as e:  # noqa: BLE001
        apply_ok, apply_msg = False, getattr(e, "detail", None) or str(e)
    criteria = []
    for c in a.get("submission_criteria") or []:
        needs_values = '"parameter"' in json.dumps(c)
        if needs_values:
            criteria.append({"message": c.get("failure_message"), "result": "depends on the parameter values", "ok": None, "criterion": c})
        else:
            ok = ontology_actions._test(c, {}, who)
            criteria.append({"message": c.get("failure_message"), "result": "satisfied" if ok else "not satisfied", "ok": ok, "criterion": c})
    can = sees and sees_type and apply_ok and all(x["ok"] is not False for x in criteria)
    return {"user": who.get("display_name") or who.get("username"), "can_submit": can,
            "checks": [{"name": "View the action type", "ok": sees}, {"name": "View the object type it edits", "ok": sees_type},
                       {"name": "Apply permission", "ok": apply_ok, "detail": apply_msg}],
            "criteria": criteria}


# ------------------------------------------------------------------------------------------------
# bulk changes
# ------------------------------------------------------------------------------------------------


class CriteriaIn(BaseModel):
    source: str
    targets: list[str] = Field(min_length=1, max_length=200)


@router.post("/bulk/submission-criteria")
def bulk_criteria(req: CriteriaIn) -> dict:
    """Copy a source action's submission criteria to other actions (directly on main)."""
    import ontology

    src = ontology.get_action_type(req.source)
    crit = src.get("submission_criteria") or []
    done, failed = [], []
    for t in req.targets:
        if t == req.source:
            continue
        try:
            ontology.update_action_type(t, ontology.ActionTypeIn(submission_criteria=copy.deepcopy(crit)))
            done.append(t)
        except HTTPException as e:
            failed.append({"id": t, "error": e.detail})
    _cache.clear()
    return {"updated": done, "failed": failed, "criteria": crit}


@router.post("/upgrades")
def upgrades(req: KeysIn) -> list[dict]:
    """Function-backed actions, automations and Workshop modules among the keys whose function is behind its latest release."""
    import functions_registry

    idx = build_index()
    keys = set(req.keys)
    out = []
    for e in idx["edges"]:
        if not e.get("out_of_date") or e["to"] not in keys:
            continue
        fid = e["from"].split(":", 1)[1]
        status = "upgradable"
        try:
            f, d, _ = functions_registry._function(fid)
            breaking = [b for v in functions_registry._versions(d, fid) if _vgt(v["version"], e["version"]) and _vgt(f["version"], v["version"], eq=True) for b in v["breaking"]]
            if breaking:
                status = "breaking"
        except HTTPException as ex:
            status, breaking = "error", [str(ex.detail)]
        out.append({"resource": e["to"], "function": e["from"], "from": e["version"], "to": e["latest"], "status": status, "breaking": breaking})
    return out


def _vgt(a: str, b: str, eq: bool = False) -> bool:
    def t(v: str) -> tuple:
        return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", str(v))[:3])

    return t(a) >= t(b) if eq else t(a) > t(b)


class UpgradeIn(BaseModel):
    items: list[dict] = Field(min_length=1, max_length=500)
    mode: str = Field("partial", pattern="^(partial|all_or_nothing)$")


@router.post("/upgrades/apply")
def apply_upgrades(req: UpgradeIn) -> dict:
    """Move function references to the chosen versions: action rules, automation effects, Workshop widgets."""
    import ontology
    import workshop

    items = req.items
    if req.mode == "all_or_nothing" and any(i.get("status") in ("breaking", "error") for i in items):
        return {"upgraded": [], "skipped": [i["resource"] for i in items], "reason": "a breaking change: nothing was upgraded (all or nothing)"}
    done, skipped = [], []
    errors: dict[str, str] = {}
    for i in items:
        if i.get("status") in ("breaking", "error"):
            skipped.append(i["resource"])
            continue
        kind, rid = i["resource"].split(":", 1)
        fid, to = i["function"].split(":", 1)[1], i["to"]
        try:
            import functions_registry

            # pointing a resource at a function version uses the function's repository: the caller must see it
            # (its markings, a role on its Project), as when the function is picked in the first place
            functions_registry._visible_function(fid)
            if kind == "action_type":
                a = ontology.get_action_type(rid)
                rules = [{**r, "version": to} if r.get("kind") == "function" and r.get("function_id") == fid else r for r in a.get("rules") or []]
                ontology.update_action_type(rid, ontology.ActionTypeIn(rules=rules))
            elif kind == "automation":
                au = ontology.get_automation(rid)
                eff = {**(au.get("effect") or {}), "version": to}
                ontology.save_automation(rid, ontology.AutomationIn(effect=eff))
            elif kind == "workshop":
                m = workshop.get_module(rid, count=False)
                ws = [{**w, "config": {**w["config"], "function_version": to}} if (w.get("config") or {}).get("function_id") == fid else w for w in m["widgets"]]
                workshop.save_module(rid, workshop.ModuleIn(widgets=ws))
            else:
                skipped.append(i["resource"])
                continue
            done.append(i["resource"])
        except Exception as e:  # noqa: BLE001
            skipped.append(i["resource"])
            i["error"] = getattr(e, "detail", None) or str(e)
            errors[i["resource"]] = str(i["error"])[:300]
    _cache.clear()
    # why each skipped resource was not upgraded (a function whose repository the caller cannot see, ...)
    return {"upgraded": done, "skipped": skipped, "errors": errors}


class ReplaceModelIn(BaseModel):
    source: str
    target: str
    logic_ids: list[str] = Field(min_length=1, max_length=200)


@router.post("/bulk/replace-model")
def replace_model(req: ReplaceModelIn) -> dict:
    """Swap the model of the LLM blocks in AIP Logic functions (Palantir-provided models only; skips what you cannot edit)."""
    import ontology

    if req.source.startswith("function:") or req.target.startswith("function:"):
        raise HTTPException(422, "model replacement is disabled for registered models")
    done, skipped = [], []
    for lid in req.logic_ids:
        try:
            lg = ontology.get_logic(lid)
            changed = False
            blocks = []
            for b in lg.get("blocks") or []:
                cfg = b.get("config") or {}
                if (cfg.get("model") or ontology.DEFAULT_LLM) == req.source and b.get("type") == "use_llm":
                    b = {**b, "config": {**cfg, "model": req.target}}
                    changed = True
                blocks.append(b)
            if changed:
                ontology.save_logic(lid, ontology.LogicIn(blocks=blocks))
                done.append(lid)
            else:
                skipped.append({"id": lid, "reason": "does not use the source model"})
        except HTTPException as e:
            skipped.append({"id": lid, "reason": e.detail})
    _cache.clear()
    return {"replaced": done, "skipped": skipped}


class PublishWorkshopIn(BaseModel):
    module_ids: list[str] = Field(min_length=1, max_length=500)
    dry_run: bool = True


@router.post("/bulk/publish-workshop")
def bulk_publish_workshop(req: PublishWorkshopIn) -> dict:
    """Publish the latest version of several Workshop modules (those whose published version trails it); modules you
    cannot edit, without a saved version or already up to date are skipped with the reason."""
    import workshop

    todo, skip = [], []
    for mid in dict.fromkeys(req.module_ids):
        try:
            m = workshop._module(mid, "editor")
        except HTTPException as e:
            skip.append({"id": mid, "reason": str(e.detail)})
            continue
        latest, pub = m.get("latest_version"), m.get("published_version")
        if not latest:
            skip.append({"id": mid, "name": m["name"], "reason": "no saved version"})
        elif pub == latest:
            skip.append({"id": mid, "name": m["name"], "reason": f"v{latest} is already published"})
        else:
            todo.append({"id": mid, "name": m["name"], "from": pub, "to": latest})
    if req.dry_run:
        return {"publish": todo, "skipped": skip}
    done = []
    for t in todo:
        try:
            workshop.publish(t["id"], workshop.PublishIn(version=t["to"]))
            done.append(t)
        except HTTPException as e:
            skip.append({"id": t["id"], "name": t["name"], "reason": str(e.detail)})
    _cache.clear()
    return {"published": done, "skipped": skip}


class MoveIn(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=500)
    folder_id: Optional[str] = None
    dry_run: bool = True


@router.post("/bulk/move")
def bulk_move(req: MoveIn) -> dict:
    """Move Files-backed resources to a Project or folder; others are skipped with the reason."""
    idx = {n["key"]: n for n in build_index()["nodes"]}
    move, skip = [], []
    for k in req.keys:
        n = idx.get(k)
        if not n:
            skip.append({"key": k, "reason": "not found"})
        elif not n.get("item_id"):
            skip.append({"key": k, "name": n["name"], "reason": f"{KINDS[n['kind']]}s are not stored in Files"})
        else:
            try:
                drive._item(n["item_id"], need="editor")
                move.append({"key": k, "name": n["name"], "item_id": n["item_id"]})
            except HTTPException:
                skip.append({"key": k, "name": n["name"], "reason": "you cannot edit it"})
    if req.dry_run or not req.folder_id:
        return {"move": move, "skipped": skip}
    moved = []
    for m in move:
        try:
            drive.update_item(m["item_id"], drive.ItemChange(move_to=req.folder_id))
            moved.append(m["key"])
        except HTTPException as e:
            skip.append({"key": m["key"], "name": m["name"], "reason": e.detail})
    return {"moved": moved, "skipped": skip}


# ------------------------------------------------------------------------------------------------
# saved graphs
# ------------------------------------------------------------------------------------------------


def _gpath(gid: str) -> Path:
    if not re.fullmatch(r"wl-[0-9a-f]{12}", gid):
        raise HTTPException(404, "graph not found")
    return DIR / "graphs" / f"{gid}.json"


def _graph(gid: str) -> dict:
    g = _rd(_gpath(gid))
    if not g:
        raise HTTPException(404, "graph not found")
    return g


class GraphIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    state: dict = Field(default_factory=dict)


@router.get("/graphs")
def list_graphs() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (WL_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"]: i for i in auth.visible(items)}
    out = []
    for p in (DIR / "graphs").glob("wl-*.json"):
        g = _rd(p)
        if g and g["item_id"] in visible:
            out.append({"id": g["id"], "name": visible[g["item_id"]]["name"].removesuffix(".wlgraph"), "nodes": len(g["state"].get("nodes") or []),
                        "frames": len(g["state"].get("frames") or []), "updated_at": g["updated_at"]})
    return sorted(out, key=lambda x: x["updated_at"], reverse=True)


@router.post("/graphs")
def create_graph(req: GraphIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "store the graph in a Project or a folder")
    with _lock:
        gid = f"wl-{uuid.uuid4().hex[:12]}"
        body = json.dumps({"workflow_lineage_graph_id": gid}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{req.name.strip()}.wlgraph"), io.BytesIO(body), len(body), WL_TYPE)
        g = {"id": gid, "item_id": item["id"], "name": req.name.strip(), "state": req.state, "created_at": _now(), "updated_at": _now(), "updated_by": _me().get("id")}
        _wr(_gpath(gid), g)
    return get_graph(gid)


@router.get("/graphs/{gid}")
def get_graph(gid: str) -> dict:
    g = _graph(gid)
    item = drive._item(g["item_id"], need="viewer")
    can = True
    try:
        drive._item(g["item_id"], need="editor")
    except HTTPException:
        can = False
    return {**g, "name": item["name"].removesuffix(".wlgraph"), "can_edit": can}


class SaveIn(BaseModel):
    state: dict


@router.put("/graphs/{gid}")
def save_graph(gid: str, req: SaveIn) -> dict:
    with _lock:
        g = _graph(gid)
        drive._item(g["item_id"], need="editor")
        if len(json.dumps(req.state)) > 5_000_000:
            raise HTTPException(413, "the graph is too large")
        g["state"] = req.state
        g["updated_at"] = _now()
        g["updated_by"] = _me().get("id")
        _wr(_gpath(gid), g)
    return get_graph(gid)


@router.delete("/graphs/{gid}")
def delete_graph(gid: str) -> dict:
    g = _graph(gid)
    drive.trash(drive._item(g["item_id"], need="editor")["id"])
    return {"trashed": gid}
