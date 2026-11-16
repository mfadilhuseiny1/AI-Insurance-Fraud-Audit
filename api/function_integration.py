"""Function integration: business logic as functions, from a template or a description, into the apps.

* GET  /api/function-integration/templates?object_type_id=  — the business-logic templates (a derived value per object,
  a KPI query, a grouped summary, an action rule with a check, a risk score, an SLA due date, a top-N list, an alert
  condition, an AI summary), each with the code generated for the chosen Nexus object type and where it plugs in.
* POST /api/function-integration/generate  — AIP: a business rule in plain words → function code on the chosen object
  types (checked to parse and to declare @function).
* POST /api/function-integration/create    — a functions repository with that code (in a Project), committed and,
  optionally, published as a release so the apps can use it at once.
* GET  /api/function-integration/overview  — every published function with where it is used (action types,
  automations, Workshop modules, pipelines, Vertex, Slate… from the registry and Data Lineage) and its next step.

Repository code uses the platform's Python functions API (code_functions.py): functions.api, ontology_sdk.Client.
"""

from __future__ import annotations

import ast
import re
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology

router = APIRouter(prefix="/api/function-integration", tags=["function-integration"])

NUMERIC = {"double", "integer", "long", "float", "decimal", "short", "byte"}
DATES = {"date", "timestamp"}

# where a function plugs into the apps, by what it returns / does
USES = {
    "value": ["Workshop: a function-backed column or property", "Vertex: a derived value of a selected object", "Quiver / Notepad cards"],
    "query": ["Workshop: a metric card or variable", "Slate and external apps: the API gateway (API name)", "AIP Logic and Agents: a tool"],
    "chart": ["Workshop: a chart widget (function-backed)", "Quiver / Notepad charts"],
    "edit": ["Action types: a function rule (the check runs before the edit)", "Workshop: a button form", "Automate: an effect"],
    "scalar": ["Pipeline Builder: Use function, row by row", "Workshop: a computed variable", "Automate: a condition"],
    "objects": ["Workshop: an object list or table", "Vertex: a function-backed Search Around"],
    "condition": ["Automate: an automation condition", "Object monitors", "Workshop: a conditional format"],
    "ai": ["Workshop: an AI text panel", "AIP Logic and Agents"],
}


# properties that are not measures (years, coordinates, codes, ids) and those that are categories (good to group by)
NOT_MEASURE = re.compile(r"(^|_)(tahun|year|lat|lon|lng|latitude|longitude|x|y|kode|code|id|no|nomor|rank|urutan)(_|$)", re.I)
CATEGORY = re.compile(r"status|state|stage|tahap|jenis|kategori|category|kelas|class|tipe|type|segmen|segment|prioritas|priority|wilayah|region|area|level|band", re.I)


def _props(t: dict) -> tuple[list[str], list[str], list[str]]:
    """(measures, categories first then other text, dates) of an object type, for the templates."""
    props = t.get("properties") or []
    pk = t.get("primary_key")
    num = [p["api_name"] for p in props if p.get("type") in NUMERIC and p["api_name"] != pk]
    num = [n for n in num if not NOT_MEASURE.search(n)] + [n for n in num if NOT_MEASURE.search(n)]
    txt = [p["api_name"] for p in props if p.get("type") == "string" and p["api_name"] != pk]
    txt = [s for s in txt if CATEGORY.search(s)] + [s for s in txt if not CATEGORY.search(s)]
    dat = [p["api_name"] for p in props if p.get("type") in DATES]
    return num, txt, dat


def _snake(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", re.sub(r"(?<!^)(?=[A-Z])", "_", s).lower()).strip("_") or "obj"


def _header(t: dict) -> str:
    return (f'from functions.api import Boolean, Date, Double, Integer, String, UserFacingError, function\n'
            f'from ontology_sdk import Client\n'
            f'from ontology_sdk.ontology.objects import {t["api_name"]}\n\n\n'
            f'def _objects():\n    return Client().ontology.objects.{t["api_name"]}\n\n')


def templates(t: Optional[dict]) -> list[dict]:
    """The templates, with code for the object type `t` (a generic placeholder when none is chosen)."""
    T = t["api_name"] if t else "MyObject"
    v = _snake(T)
    num, txt, dat = _props(t) if t else (["value", "target"], ["status"], ["created"])
    a = num[0] if num else "value"
    b = num[1] if len(num) > 1 else a
    c = num[2] if len(num) > 2 else b
    s = txt[0] if txt else "status"
    d = dat[0] if dat else None
    head = _header({"api_name": T})
    out = [
        {"key": "derived_value", "name": "Derived value per object", "category": "Values & KPIs", "uses": USES["value"],
         "description": f"A value computed from an object's properties, e.g. {a} per {b}: a ratio, a margin, a utilisation.",
         "code": head + f'''@function
def {a}_per_{b}({v}: {T}) -> Double:
    """{a} divided by {b} for one {T} (0 when {b} is empty or zero)."""
    denominator = float({v}.{b} or 0)
    return round(float({v}.{a} or 0) / denominator, 4) if denominator else 0.0
'''},
        {"key": "kpi_query", "name": "KPI query (API name)", "category": "Values & KPIs", "uses": USES["query"],
         "description": f"An aggregate over all {T} objects, optionally filtered by {s}: callable from Workshop, Slate and the API gateway.",
         "code": head + f'''@function(api_name="total{a[:1].upper() + a[1:]}")
def total_{a}({s}: String = "") -> Double:
    """The sum of {a} over every {T} (only those whose {s} matches, when given)."""
    objects = _objects()
    if {s}:
        objects = objects.where({T}.object_type.{s} == {s})
    return float(objects.sum("{a}").compute() or 0)
'''},
        {"key": "grouped_summary", "name": "Grouped summary for a chart", "category": "Values & KPIs", "uses": USES["chart"],
         "description": f"{a} summed by {s}, as rows a chart or table widget can draw.",
         "code": head + f'''@function
def {a}_by_{s}() -> list[dict]:
    """The sum of {a} for each {s}, largest first."""
    totals: dict = {{}}
    for o in _objects().iterate():
        key = str(o.{s} or "(none)")
        totals[key] = totals.get(key, 0.0) + float(o.{a} or 0)
    return [{{"{s}": k, "{a}": round(x, 2)}} for k, x in sorted(totals.items(), key=lambda kv: -kv[1])]
'''},
        {"key": "action_rule", "name": "Action rule with a check", "category": "Rules & decisions", "uses": USES["edit"],
         "description": f"An edit an action applies only when a business rule holds: set {s} on a {T}, refused with a clear message otherwise.",
         "code": head + f'''@function(edits=[{T}])
def set_{s}_checked({v}: {T}, new_{s}: String, reason: String = ""):
    """Sets {s} to new_{s}. Refuses closing a {T} whose {a} is still above zero without a reason."""
    if new_{s}.lower() in ("closed", "done", "selesai") and float({v}.{a} or 0) > 0 and not reason.strip():
        raise UserFacingError(f"{T} {{{v}.{t['primary_key'] if t else 'id'}}}: {a} is {{{v}.{a}}} — give a reason to close it.")
    edits = Client().ontology.edits()
    edits.objects.{T}.edit({v}).{s} = new_{s}
    return edits.get_edits()
'''},
        {"key": "risk_score", "name": "Risk score (row by row)", "category": "Rules & decisions", "uses": USES["scalar"],
         "description": "A weighted, explainable score from plain numbers: usable on every row of a pipeline, or for one object.",
         "code": '''from functions.api import Double, String, function

WEIGHTS = {"a": 0.5, "b": 0.3, "c": 0.2}  # the business weights: tune them with the domain experts


@function
def risk_score(a: Double, b: Double, c: Double) -> Double:
    """0–100: each input normalised to 0–1 (capped), weighted and summed."""
    parts = {"a": min(max(a, 0.0), 1.0), "b": min(max(b, 0.0), 1.0), "c": min(max(c, 0.0), 1.0)}
    return round(100 * sum(WEIGHTS[k] * x for k, x in parts.items()), 1)


@function
def risk_band(score: Double) -> String:
    """The band a score falls in, for colours and rules."""
    return "high" if score >= 70 else "medium" if score >= 40 else "low"
'''},
        {"key": "sla_due", "name": "SLA due date", "category": "Rules & decisions", "uses": USES["scalar"],
         "description": "When something is due from its start date and priority: for work orders, tickets, findings.",
         "code": '''import datetime as dt

from functions.api import Date, Integer, String, function

SLA_DAYS = {"critical": 1, "high": 3, "medium": 7, "low": 14}


@function
def sla_due_date(start: Date, priority: String) -> Date:
    """The due date: start plus the SLA days of the priority (14 days when unknown)."""
    return start + dt.timedelta(days=SLA_DAYS.get((priority or "").lower(), 14))


@function
def days_overdue(start: Date, priority: String, today: Date) -> Integer:
    """Days past the due date (0 when not overdue)."""
    return max(0, (today - sla_due_date(start, priority)).days)
'''},
        {"key": "top_n", "name": "Top N objects", "category": "Lists", "uses": USES["objects"],
         "description": f"The {T} objects with the highest {a}: a ranked work list.",
         "code": head + f'''@function
def top_{v}_by_{a}(n: Integer = 10) -> list[{T}]:
    """The n {T} with the highest {a}."""
    return list(_objects().order_by("{a}", descending=True).take(n))
'''},
        {"key": "alert_condition", "name": "Alert condition", "category": "Lists", "uses": USES["condition"],
         "description": f"Whether a {T} needs attention: {a} above a threshold and {c} not handled.",
         "code": head + f'''THRESHOLD = 100.0  # the level that needs attention


@function
def needs_attention({v}: {T}) -> Boolean:
    """True when {a} is above the threshold."""
    return float({v}.{a} or 0) > THRESHOLD
'''},
        {"key": "ai_summary", "name": "AI summary of an object", "category": "AI", "uses": USES["ai"],
         "description": f"A short explanation of a {T} written by a language model from its properties.",
         "code": head.replace("from ontology_sdk import Client\n", "from functions.language_models import chat\nfrom ontology_sdk import Client\n") + f'''@function
def summarize_{v}({v}: {T}) -> String:
    """Three sentences on this {T}: what stands out and what to do next."""
    facts = "\\n".join(f"- {{k}}: {{getattr({v}, k, None)}}" for k in {[*num[:6], *txt[:4], *([d] if d else [])]!r})
    return chat(f"Explain this {T} for an operations manager in three sentences, then one recommended action.\\n{{facts}}",
                system="Be concrete and use only the facts given.")
'''},
    ]
    for x in out:
        x["object_type"] = T if x["key"] not in ("risk_score", "sla_due") else None
    return out


@router.get("/templates")
def list_templates(object_type_id: Optional[str] = None) -> dict:
    t = ontology._object_type(object_type_id) if object_type_id else None
    return {"object_type": {"id": t["id"], "api_name": t["api_name"], "display_name": t["display_name"]} if t else None, "templates": templates(t)}


def _check(code: str) -> list[str]:
    """The function names the code declares; raises 400 when it does not parse or declares none."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise HTTPException(400, f"the code does not parse: line {e.lineno}: {e.msg}") from None
    names = [n.name for n in tree.body if isinstance(n, ast.FunctionDef)
             and any((isinstance(d, ast.Name) and d.id == "function") or (isinstance(d, ast.Call) and getattr(d.func, "id", "") == "function") for d in n.decorator_list)]
    if not names:
        raise HTTPException(400, "the code declares no @function")
    return names


class GenerateIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    object_type_ids: list[str] = Field(default_factory=list, max_length=6)


API_GUIDE = """Python functions API of BluesandAI Hexa:
- from functions.api import function, String, Integer, Long, Double, Boolean, Date, Timestamp, UserFacingError
- @function (or @function(api_name="camelName") for a query callable by name; @function(edits=[Type]) for an edit an action applies)
- inputs and outputs are typed: Nexus objects (from ontology_sdk.ontology.objects import <Type>), scalars, list[...], list[dict] rows
- from ontology_sdk import Client; objs = Client().ontology.objects.<Type>
  objs.where(<Type>.object_type.<prop> == value), .get(pk), .iterate(), .take(n), .order_by("prop", descending=True), .count().compute(),
  .sum("prop").compute(), .avg("prop").compute(), .search_around("linkApiName")
- object properties are attributes: obj.<prop> (read-only); edits: e = Client().ontology.edits(); e.objects.<Type>.edit(obj).<prop> = v;
  e.objects.<Type>.create(pk, **props); return e.get_edits()
- raise UserFacingError("message") for a rule the user broke
- from functions.language_models import chat; chat(prompt, system=...) for AI text"""


@router.post("/generate")
def generate(req: GenerateIn) -> dict:
    """AIP: the code of functions implementing a business rule described in plain words."""
    import pipeline_ai

    types = [ontology._object_type(i) for i in req.object_type_ids]
    catalog = "\n".join(f"- {t['api_name']} ({t['display_name']}), primary key {t.get('primary_key')}: "
                        + ", ".join(f"{p['api_name']}:{p.get('type')}" for p in (t.get("properties") or [])[:60]) for t in types) or "(no object type chosen: use scalar inputs)"
    system = ("You write Python business-logic functions for the user's apps. Return one complete Python module: imports, small helpers, and "
              "one to four @function definitions with type hints and a one-line docstring each. Use only the API described and only the "
              "object types and properties listed (exact api names). Keep rules explicit and readable; put thresholds and weights in named constants.")
    schema = {"type": "object", "properties": {"code": {"type": "string"}, "explanation": {"type": "string"}}, "required": ["code", "explanation"]}
    out = pipeline_ai.chat(ontology.DEFAULT_LLM, pipeline_ai.with_platform(system), f"{API_GUIDE}\n\nObject types:\n{catalog}\n\nBusiness rule:\n{req.prompt}", schema, 0.2, 4096)
    code = re.sub(r"^```(?:python)?\s*|\s*```$", "", (out or {}).get("code", "").strip())
    return {"code": code, "explanation": (out or {}).get("explanation", ""), "functions": _check(code)}


class CreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    project_id: Optional[str] = None
    code: str = Field(min_length=10, max_length=200_000)
    module: str = Field("logic", pattern=r"^[a-z_][a-z0-9_]{0,40}$")
    description: str = Field("", max_length=2000)
    publish: bool = True
    version: str = "0.1.0"


@router.post("/create")
def create(req: CreateIn) -> dict:
    """A functions repository holding the code, committed, and (publish) released so the apps can use it."""
    import code_repos
    import functions_registry as fr

    # it writes and runs code (the release describes it in the runner): the Code execution setting applies, as on
    # /api/code-repos
    auth.require_code_author()
    names = _check(req.code)
    repo = code_repos.create_repo(code_repos.RepoIn(name=req.name, description=req.description or "Business logic functions", template="python",
                                                    project_id=req.project_id))
    pkg = re.sub(r"[^a-z0-9_]+", "_", req.name.lower()).strip("_") or "functions"
    pkg = pkg if pkg[0].isalpha() else f"f_{pkg}"
    files = dict(code_repos._branch(code_repos._repo(repo["id"]), None)["files"])
    files.update({f"python-functions/src/{pkg}/__init__.py": "", f"python-functions/src/{pkg}/{req.module}.py": req.code,
                  "README.md": f"# {req.name}\n\n{req.description or 'Business logic functions.'}\n\nFunctions: {', '.join(names)}. Publish a release (tag 1.0.0) to use a new version in the apps.\n"})
    code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
    commit = code_repos.commit(repo["id"], code_repos.CommitIn(message=f"Business logic: {', '.join(names)}"))
    out: dict[str, Any] = {"repo_id": repo["id"], "file": f"python-functions/src/{pkg}/{req.module}.py", "functions": names, "published": False}
    if req.publish:
        head = code_repos._branch(code_repos._repo(repo["id"]), None).get("head") or (commit or {}).get("id")
        try:
            rel = fr.publish(repo["id"], req.version, head)
            out.update(published=True, version=req.version, released=[{"id": f.get("id"), "name": f["name"], "kind": f.get("kind")} for f in rel.get("functions") or []])
        except HTTPException as e:
            out["publish_error"] = str(e.detail)
    return out


def _usage_index() -> dict[str, list[dict]]:
    """functions_registry._usage for every function at once: one pass over action types, automations and Workshop modules."""
    import ontology

    out: dict[str, list[dict]] = {}
    for a in ontology._all("action-types"):
        for r in a.get("rules") or []:
            if r.get("function_id"):
                out.setdefault(r["function_id"], []).append({"kind": "action_type", "id": a["id"], "name": a["display_name"], "version": r.get("version")})
    for a in ontology._all("automations"):
        eff = a.get("effect") or {}
        if eff.get("function_id"):
            out.setdefault(eff["function_id"], []).append({"kind": "automation", "id": a["id"], "name": a["name"], "version": eff.get("version")})
    try:
        import workshop

        for p in workshop.DIR.glob("*.json"):
            m = ontology._read(p) or {}
            for w in m.get("widgets") or []:
                c = w.get("config") or {}
                if c.get("function_id"):
                    out.setdefault(c["function_id"], []).append({"kind": "workshop", "id": m["id"], "name": m["name"], "version": c.get("function_version")})
    except Exception:  # noqa: BLE001
        pass
    return out


def _lineage_if_built() -> Optional[object]:
    """The caller's lineage graph when it is already built; otherwise start building it in the background (it can take
    minutes on a large platform) and answer without it: the next overview has it."""
    import contextvars
    import lineage

    key = (False, (auth.current() or {}).get("id"))
    hit = lineage._built.get(key)
    if hit and time.monotonic() - hit[0] < lineage.GRAPH_TTL:
        return hit[1]
    ctx = contextvars.copy_context()
    threading.Thread(target=lambda: ctx.run(lineage.cached_graph, False), daemon=True).start()
    return hit[1] if hit else None


@router.get("/overview")
def overview(tests: bool = False) -> dict:
    """Published functions with where each is used across the apps, and the next step. Functions of test repositories
    (a "(test)" name or Project) only with ?tests=1."""
    import functions_registry as fr
    import test_space

    repos: dict[str, Optional[dict]] = {}
    for f in fr.all_functions():
        if f["repo_id"] not in repos:
            repos[f["repo_id"]] = fr._visible_repo(f["repo_id"])
    test_repo = {rid: bool(r) and (test_space.is_test_name(r.get("name")) or test_space.is_test_id(r.get("project_id"))) for rid, r in repos.items()}
    rows = [f for f in fr.all_functions() if repos.get(f["repo_id"])]
    hidden = 0
    if not tests:
        shown = [f for f in rows if not test_repo.get(f["repo_id"])]
        hidden, rows = len(rows) - len(shown), shown
    consumers: dict[str, list[dict]] = {}
    g = None
    try:
        g = _lineage_if_built()
        if g is not None:
            names = g.nodes
            for e in g.edges.values():
                if e["from"].startswith("function:") and e["to"] in names:
                    n = names[e["to"]]
                    consumers.setdefault(e["from"][len("function:"):], []).append({"kind": n["kind"], "kind_label": n.get("kind_label"), "name": n["name"],
                                                                                   "link": n.get("link"), "id": n["id"]})
    except Exception:  # noqa: BLE001 - the lineage is a convenience here
        pass
    usage = _usage_index()
    out = []
    for f in rows:
        used = list(usage.get(f["id"], []))
        seen = {(u["kind"], u["name"]) for u in used}
        for c in consumers.get(f["id"], []):
            if (c["kind"], c["name"]) not in seen:
                used.append({"kind": c["kind"], "name": c["name"], "link": c.get("link"), "kind_label": c.get("kind_label")})
        if not tests:
            used = [u for u in used if not test_space.is_test_name(u.get("name"))]
        out.append({"id": f["id"], "name": f["name"], "kind": f.get("kind"), "version": f.get("version"), "api_name": f.get("api_name"),
                    "repo_id": f["repo_id"], "doc": (f.get("doc") or "").split("\n")[0], "signature": f.get("inputs"), "output": f.get("output"),
                    "used_by": used, "released_at": f.get("released_at")})
    out.sort(key=lambda r: r.get("released_at") or "", reverse=True)
    return {"functions": out, "uses": USES, "lineage": g is not None, "hidden_tests": hidden}
