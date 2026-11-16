"""Solution Designer (Application Building → Solution Designer): architecture diagrams of solutions on the platform.

A diagram is a Files item (`<name>.sdiagram`, application/vnd.bluesandai.solution-diagram+json) in a Project, whose
roles govern it (viewers open it read-only, editors change and export it). Its graph holds:
- nodes: component (a platform application or an external system from the catalog), resource (linked to a Files item,
  an object type, an interface or an action type, opened in its own application), concept (an abstract step that AIP
  Architect turns into an implementation pattern), object (a proposed object type from AIP Architect's data model),
  group (a container whose members move with it), text (annotations); each with a title, description, tags,
  background color, size, minimized display and z-order;
- edges with labels; settings (edge labels, validity, flow animation, mini-map, dots, pan mode, icons, AIP features).
Every save is a version (autosaves and manual saves; preview, restore as a new version). The diagram also keeps its
AIP Architect plan (wizard answers, workflow summary, walkthrough) and its AIP Critic conversation and implementation
plan. AIP features call language models through pipeline_ai.chat (JSON answers); importing a hand-drawn diagram uses
the model's vision input. Data Lineage graphs import as resource nodes. AIP Architect's implementation suggestions,
AIP Critic's answers and AIP Assist (a node's documentation card) also stream as server-sent events (`.../stream`):
"partial" events carry the answer parsed so far, "result" the same value the plain route returns (and saves).
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/solution-designer", tags=["solution-designer"])
SD_TYPE = "application/vnd.bluesandai.solution-diagram+json"
DIR = Path("data/solution_designer")
_lock = threading.RLock()

# ------------------------------------------------------------------------------------------------
# the component catalog (AIP Critic's sections are its categories)
# ------------------------------------------------------------------------------------------------

CATEGORIES = [
    ("external", "External Systems"),
    ("sourcing", "Data Sourcing"),
    ("processing", "Data Processing"),
    ("modeling", "Modeling"),
    ("ontology", "Ontology"),
    ("analytics", "Analytics"),
    ("apps", "Application Building"),
    ("platform", "Platform Management"),
    ("custom", "Custom Components"),
]
_C = [
    # id, name, category, icon, href, description
    ("ext-database", "Relational database", "external", "database", None, "An external SQL database (PostgreSQL, MySQL, SQL Server, Oracle) read through a Data Connection source."),
    ("ext-warehouse", "Data warehouse", "external", "database", None, "Snowflake, BigQuery, Redshift or Databricks tables synced or queried virtually."),
    ("ext-object-store", "Object storage", "external", "folder", None, "S3, Azure Blob or GCS buckets with files to ingest."),
    ("ext-erp", "ERP / CRM system", "external", "server", None, "SAP, Salesforce or another system of record with an API or connector."),
    ("ext-api", "REST API", "external", "plug", None, "An HTTP API polled by a source, called by webhooks or from functions."),
    ("ext-stream", "Message queue", "external", "wave", None, "Kafka, Kinesis or MQTT topics feeding streams."),
    ("ext-files", "Spreadsheets & documents", "external", "doc", None, "Excel, CSV, PDF or scanned documents provided by people."),
    ("ext-users", "External users", "external", "globe", None, "People outside the platform using a public application or portal."),
    ("data-connection", "Data Connection", "sourcing", "plug", "/sources", "Sources, syncs, virtual tables, exports and webhooks to external systems."),
    ("upload", "Manual upload", "sourcing", "folder", "/files", "Files uploaded into a Project as datasets or raw files."),
    ("parse", "Parse (document extraction)", "sourcing", "doc", "/parse", "OCR and structured extraction of PDFs and images into text, tables and fields."),
    ("streaming", "Streaming", "sourcing", "wave", "/streaming", "Low-latency streams with stream transforms."),
    ("media-sets", "Media Sets", "sourcing", "image", "/media-sets", "Collections of images, audio, video or documents with transformations."),
    ("forms", "Forms", "sourcing", "doc", "/forms", "User-submitted data captured through forms."),
    ("pipeline-builder", "Pipeline Builder", "processing", "pipeline", "/pipeline", "Point-and-click batch and streaming pipelines with LLM transforms and expectations."),
    ("code-repositories", "Code Repositories", "processing", "code", "/code-repositories", "Python, Java or SQL transforms with branches, checks and builds."),
    ("preparation", "Preparation", "processing", "transform", "/preparation", "Spreadsheet-style cleaning recipes for a dataset."),
    ("sql-studio", "SQL Studio", "processing", "database", "/sql-studio", "SQL worksheets and SQL-defined datasets."),
    ("dataset", "Dataset", "processing", "table", "/files", "A versioned table produced by a sync, an upload or a transform."),
    ("schedules", "Build Schedules", "processing", "clock", "/schedules", "Time- and event-based builds of datasets."),
    ("data-health", "Data Health", "processing", "bell", "/data-health", "Checks and monitors on datasets and pipelines."),
    ("model-studio", "Model Studio", "modeling", "cpu", "/model-studio", "No-code training of forecasting, classification and regression models."),
    ("model-integration", "Model Integration", "modeling", "layers", "/model-integration", "Models from code or containers, deployed for batch or live inference."),
    ("modeling-objectives", "Modeling Objectives", "modeling", "layers", "/modeling-objectives", "Evaluation, release and deployment of competing models for one problem."),
    ("aip-logic", "AIP Logic", "modeling", "logic", "/logic", "No-code LLM functions that read and write the Ontology."),
    ("aip-agents", "AIP Agent Studio", "modeling", "sparkle", "/agents", "Interactive agents with tools over the Ontology and documents."),
    ("functions", "Functions", "modeling", "code", "/functions", "TypeScript or Python functions on objects for logic, queries and edits."),
    ("dynamic-scheduling", "Dynamic Scheduling", "modeling", "clock", "/dynamic-scheduling", "Scheduling and optimization of resources against constraints."),
    ("object-type", "Object type", "ontology", "cube", "/ontology", "A business entity backed by a dataset, with properties, titles and security."),
    ("link-type", "Link type", "ontology", "link", "/ontology", "A relationship between object types (one-to-many, many-to-many)."),
    ("action-type", "Action type", "ontology", "edit", "/ontology", "A governed write to objects with parameters, rules, validation and side effects."),
    ("interface", "Interface", "ontology", "layers", "/ontology", "A shape shared by several object types."),
    ("ontology-manager", "Ontology Manager", "ontology", "cube", "/ontology", "Define and govern object types, links, actions and interfaces."),
    ("automate", "Automate", "ontology", "bolt", "/automate", "Automations: object, time or threshold conditions with action, logic and notification effects."),
    ("object-monitors", "Object Monitors", "ontology", "bell", "/object-monitors", "Alerts when objects meet a condition."),
    ("contour", "Contour", "analytics", "filter", "/analytics", "Point-and-click analysis paths and dashboards on datasets."),
    ("quiver", "Quiver", "analytics", "wave", "/quiver", "Object and time series analysis with dashboards."),
    ("notepad", "Notepad", "analytics", "doc", "/notepad", "Documents with live widgets from analyses and objects."),
    ("fusion", "Fusion", "analytics", "table", "/fusion", "Spreadsheets with live dataset lookups and writeback."),
    ("insight", "Insight", "analytics", "sparkle", "/insight", "Exploratory analysis of objects with charts."),
    ("vertex", "Vertex", "analytics", "graph", "/vertex", "Graphs of objects and their links, with simulations."),
    ("map", "Map", "analytics", "globe", "/map/new", "Geospatial layers of objects and datasets."),
    ("workshop", "Workshop", "apps", "device", "/workshop", "Operational applications on the Ontology: tables, forms, charts, actions."),
    ("slate", "Slate", "apps", "palette", "/slate", "Custom HTML / JavaScript applications with queries and functions."),
    ("osdk-app", "OSDK application", "apps", "keyboard", "/developer-console", "A custom web application on the Ontology SDK, registered in the Developer Console."),
    ("custom-widgets", "Custom widgets", "apps", "grid", "/custom-widgets", "JavaScript widgets embedded in Workshop."),
    ("carbon", "Carbon", "apps", "grid", "/carbon", "Curated workspaces of modules for operational users."),
    ("object-explorer", "Object Explorer", "apps", "search", "/object-explorer", "Search and explore objects; object views."),
    ("pilot", "Pilot", "apps", "sparkle", "/pilot", "Applications generated from prompts."),
    ("autopilot", "Autopilot", "apps", "grid", "/autopilot", "Observe automated workflows as states, graphs and timelines."),
    ("notifications", "Notifications", "apps", "bell", "/notifications", "Email and in-platform notifications to people."),
    ("control-panel", "Control Panel", "platform", "sliders", "/control-panel", "Enrollment settings, models, API keys and organizations."),
    ("security", "Security & Governance", "platform", "eye", "/security-governance", "Markings, roles, policies, sensitive data scanning and audit."),
    ("projects", "Projects & Files", "platform", "folder", "/files", "Projects that hold resources with their permissions."),
    ("lineage", "Data Lineage", "platform", "split", "/lineage", "The graph of datasets, pipelines and Ontology resources."),
    ("marketplace", "Marketplace", "platform", "download", None, "Package and install products of resources."),
    ("custom", "Custom component", "custom", "info", None, "Anything else in the solution."),
]
COMPONENTS = {c[0]: {"id": c[0], "name": c[1], "category": c[2], "icon": c[3], "href": c[4], "description": c[5]} for c in _C}
CONCEPTS = {
    "external_systems": ("External systems", "external"),
    "data_sourcing": ("Data sourcing", "sourcing"),
    "data_processing": ("Data processing", "processing"),
    "modeling": ("Modeling", "modeling"),
    "ontology": ("Ontology", "ontology"),
    "analytics": ("Analytics", "analytics"),
    "application_building": ("Application building", "apps"),
    "automation": ("Automation", "ontology"),
    "platform_management": ("Platform management", "platform"),
}
RESOURCE_KINDS = ("file", "object_type", "interface", "action_type")
NODE_KINDS = ("component", "resource", "concept", "object", "group", "text")


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "solution_designer"
    (DIR / "diagrams").mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    return auth.current() or {"id": "local", "username": "local", "role": "admin", "groups": []}


def _rd(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except FileNotFoundError:
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


def _path(did: str) -> Path:
    if not re.fullmatch(r"sd-[0-9a-f]{12}", did):
        raise HTTPException(404, "diagram not found")
    return DIR / "diagrams" / f"{did}.json"


def _get(did: str) -> dict:
    d = _rd(_path(did))
    if not d:
        raise HTTPException(404, "diagram not found")
    return d


def _all() -> list[dict]:
    return [d for p in (DIR / "diagrams").glob("sd-*.json") if (d := _rd(p))] if (DIR / "diagrams").exists() else []


def _access(d: dict, need: str = "viewer") -> dict:
    return drive._item(d["item_id"], need=need)


def _can(d: dict, need: str) -> bool:
    try:
        _access(d, need)
        return True
    except HTTPException:
        return False


def _nid() -> str:
    return "n-" + uuid.uuid4().hex[:8]


def empty_graph() -> dict:
    return {"nodes": [], "edges": [], "description": "",
            "settings": {"edge_labels": True, "edge_validity": True, "flow_animation": False, "minimap": False, "dots": True, "pan_mode": False, "icons": "color", "aip": True, "minimized": False}}


_CARDINALITIES = ("one-to-many", "many-to-many", "one-to-one")


def _check_graph(g: Any) -> dict:
    if not isinstance(g, dict):
        raise HTTPException(422, "a diagram graph is an object with nodes and edges")
    out = empty_graph()
    out["description"] = str(g.get("description") or "")[:20000]
    out["settings"] = {**out["settings"], **{k: v for k, v in (g.get("settings") or {}).items() if k in out["settings"]}}
    ids = set()
    for n in g.get("nodes") or []:
        if not isinstance(n, dict) or n.get("kind") not in NODE_KINDS or not n.get("id"):
            raise HTTPException(422, f"a node needs an id and a kind among {', '.join(NODE_KINDS)}")
        if n["id"] in ids:
            raise HTTPException(422, f"two nodes share the id {n['id']}")
        ids.add(n["id"])
        if n["kind"] == "component" and n.get("component") not in COMPONENTS:
            raise HTTPException(422, f"unknown component {n.get('component')!r}")
        if n["kind"] == "resource" and n.get("resource") and (n["resource"] or {}).get("kind") not in RESOURCE_KINDS:
            raise HTTPException(422, f"a resource node links a {', '.join(RESOURCE_KINDS)}")
        if n["kind"] == "concept" and n.get("concept") not in CONCEPTS:
            raise HTTPException(422, f"unknown concept {n.get('concept')!r}")
        try:
            x, y = float(n.get("x", 0)), float(n.get("y", 0))
        except (TypeError, ValueError):
            raise HTTPException(422, "node positions are numbers") from None
        out["nodes"].append({**n, "x": x, "y": y, "title": str(n.get("title") or "")[:300]})
    for n in out["nodes"]:
        if n.get("parent") and n["parent"] not in ids:
            n["parent"] = None
    seen = set()
    for e in g.get("edges") or []:
        if not isinstance(e, dict) or e.get("from") not in ids or e.get("to") not in ids:
            continue
        eid = e.get("id") or f"e-{uuid.uuid4().hex[:8]}"
        if eid in seen:
            continue
        seen.add(eid)
        edge = {"id": eid, "from": e["from"], "to": e["to"], "label": str(e.get("label") or "")[:300]}
        # a link type AIP Architect proposed (Generate data model), and the Ontology link type created from it
        p = e.get("proposed")
        if isinstance(p, dict) and p.get("cardinality") in _CARDINALITIES:
            edge["proposed"] = {"name": str(p.get("name") or "")[:200], "cardinality": p["cardinality"]}
        lt = e.get("link_type")
        if isinstance(lt, dict) and lt.get("id"):
            edge["link_type"] = {"id": str(lt["id"])[:100], "name": str(lt.get("name") or "")[:200]}
        out["edges"].append(edge)
    if len(out["nodes"]) > 2000:
        raise HTTPException(422, "a diagram holds at most 2000 nodes")
    return out


def _summary(d: dict) -> dict:
    try:
        item = db.drive_get(d["item_id"]) or {}
    except Exception:  # noqa: BLE001
        item = {}
    return {"id": d["id"], "rid": d["rid"], "item_id": d["item_id"], "name": (item.get("name") or d.get("name") or "").removesuffix(".sdiagram"),
            "folder_id": item.get("parent_id"), "version": d["version"], "nodes": len(d["graph"]["nodes"]), "edges": len(d["graph"]["edges"]),
            "created_at": d["created_at"], "updated_at": d["updated_at"], "created_by": d.get("created_by")}


# ------------------------------------------------------------------------------------------------
# layout
# ------------------------------------------------------------------------------------------------


def layout(nodes: list[dict], edges: list[dict], x0: float = 80, y0: float = 80, dx: float = 280, dy: float = 130) -> None:
    """Layers by longest path from the sources (left to right), stacked in each layer; groups are left in place."""
    ids = [n["id"] for n in nodes if n["kind"] not in ("group", "text") and not n.get("parent")]
    inc: dict[str, list[str]] = {i: [] for i in ids}
    for e in edges:
        if e["to"] in inc and e["from"] in inc:
            inc[e["to"]].append(e["from"])
    depth: dict[str, int] = {}

    def d(i: str, seen: frozenset = frozenset()) -> int:
        if i in depth:
            return depth[i]
        if i in seen:
            return 0
        depth[i] = v = max((d(p, seen | {i}) + 1 for p in inc[i]), default=0)
        return v

    rows: dict[int, int] = {}
    by = {n["id"]: n for n in nodes}
    for i in ids:
        k = d(i)
        r = rows.get(k, 0)
        rows[k] = r + 1
        by[i]["x"], by[i]["y"] = x0 + k * dx, y0 + r * dy


# ------------------------------------------------------------------------------------------------
# reference architecture library
# ------------------------------------------------------------------------------------------------

_REFS = [
    {"id": "ref-jkn-claims", "category": "Industry patterns", "name": "Healthcare claims audit (JKN)",
     "description": "Hospital claims from the insurer's database are matched against INA-CBG tariffs, scored for risk by AIP Logic, and reviewed by verifiers in Workshop; automations hold high-difference claims.",
     "chain": [("ext-database", "Claims database (BPJS)"), ("data-connection", "JDBC sync"), ("pipeline-builder", "Claim cleaning & tariff join"), ("object-type", "Klaim JKN"),
               ("aip-logic", "Risk scoring"), ("workshop", "Verification queue")],
     "extra": [(3, ("object-type", "Faskes"), "links"), (3, ("automate", "Hold high-difference claims"), "triggers"), (5, ("action-type", "Change verification status"), "applies")]},
    {"id": "ref-supply-forecast", "category": "Industry patterns", "name": "Demand forecasting with what-if",
     "description": "Historical sales and weather feed forecasting models; planners run what-if scenarios in a cockpit and publish plans.",
     "chain": [("ext-erp", "ERP sales & inventory"), ("data-connection", "Daily syncs"), ("code-repositories", "Feature engineering"), ("model-studio", "Demand forecast"),
               ("object-type", "SKU forecast"), ("workshop", "Simulation cockpit")],
     "extra": [(0, ("ext-api", "Weather API"), "feeds"), (4, ("quiver", "Forecast analysis"), "reads")]},
    {"id": "ref-batch", "category": "Technical patterns", "name": "Batch ingestion to the Ontology",
     "description": "An incremental sync lands raw data, a pipeline cleans it with expectations, and the output backs an object type, rebuilt on a schedule.",
     "chain": [("ext-warehouse", "Warehouse tables"), ("data-connection", "Incremental sync"), ("dataset", "Raw dataset"), ("pipeline-builder", "Clean & validate"), ("dataset", "Clean dataset"), ("object-type", "Business object")],
     "extra": [(3, ("schedules", "Hourly schedule"), "builds"), (4, ("data-health", "Freshness checks"), "monitors")]},
    {"id": "ref-stream", "category": "Technical patterns", "name": "Streaming alerts",
     "description": "Events stream in, are enriched with reference data, update objects in near real time and raise alerts.",
     "chain": [("ext-stream", "Sensor topic"), ("streaming", "Event stream"), ("pipeline-builder", "Streaming enrichment"), ("object-type", "Asset"), ("object-monitors", "Threshold alerts"), ("notifications", "On-call notifications")],
     "extra": []},
    {"id": "ref-osdk", "category": "Technical patterns", "name": "External application on the OSDK",
     "description": "A custom web application signs users in with OAuth, reads objects and applies actions through the generated SDK.",
     "chain": [("object-type", "Business object"), ("action-type", "Update action"), ("osdk-app", "Developer Console app"), ("ext-users", "Portal users")],
     "extra": [(2, ("functions", "Query functions"), "calls")]},
    {"id": "ref-docs", "category": "Workflow patterns", "name": "Documents to structured objects",
     "description": "Scanned documents are parsed and extracted with LLMs, reviewed by people, and become objects that workflows act on.",
     "chain": [("ext-files", "Scanned documents"), ("parse", "OCR & extraction"), ("pipeline-builder", "LLM field extraction"), ("object-type", "Document"), ("workshop", "Review & correct")],
     "extra": [(3, ("aip-agents", "Q&A agent"), "reads")]},
    {"id": "ref-hitl", "category": "Workflow patterns", "name": "Human-in-the-loop decisions",
     "description": "An automation proposes a decision with AIP Logic, a person approves or edits it in an inbox, and the action writes back.",
     "chain": [("object-type", "Case"), ("automate", "On new case"), ("aip-logic", "Draft decision"), ("workshop", "Approval inbox"), ("action-type", "Approve decision")],
     "extra": [(4, ("autopilot", "Workflow monitoring"), "observes")]},
]


def _ref_graph(r: dict) -> dict:
    nodes, edges = [], []
    for comp, title in r["chain"]:
        nodes.append({"id": _nid(), "kind": "component", "component": comp, "title": title, "description": "", "tags": []})
    for a, b in zip(nodes, nodes[1:]):
        edges.append({"id": f"e-{uuid.uuid4().hex[:8]}", "from": a["id"], "to": b["id"], "label": ""})
    for at, (comp, title), label in r["extra"]:
        n = {"id": _nid(), "kind": "component", "component": comp, "title": title, "description": "", "tags": []}
        nodes.append(n)
        src_first = COMPONENTS[comp]["category"] in ("external", "sourcing")
        edges.append({"id": f"e-{uuid.uuid4().hex[:8]}", "from": n["id"] if src_first else nodes[at]["id"], "to": nodes[at]["id"] if src_first else n["id"], "label": label})
    layout(nodes, edges)
    return {**empty_graph(), "nodes": nodes, "edges": edges, "description": r["description"]}


@router.get("/catalog")
def catalog() -> dict:
    return {"categories": [{"id": c, "name": n} for c, n in CATEGORIES], "components": list(COMPONENTS.values()),
            "concepts": [{"id": k, "name": v[0], "category": v[1]} for k, v in CONCEPTS.items()]}


@router.get("/references")
def references() -> list[dict]:
    return [{k: r[k] for k in ("id", "category", "name", "description")} | {"components": [c for c, _ in r["chain"]]} for r in _REFS]


@router.get("/references/{rid}")
def reference(rid: str) -> dict:
    r = next((x for x in _REFS if x["id"] == rid), None)
    if not r:
        raise HTTPException(404, "reference diagram not found")
    return {"id": r["id"], "name": r["name"], "graph": _ref_graph(r)}


@router.get("/models")
def models() -> list[dict]:
    import knowledge

    return [m for m in knowledge.models() if m.get("available")]


# ------------------------------------------------------------------------------------------------
# diagrams
# ------------------------------------------------------------------------------------------------


class DiagramIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    graph: Optional[dict] = None
    reference_id: Optional[str] = None


@router.get("/diagrams")
def list_diagrams() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (SD_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return sorted((_summary(d) | {"can_edit": _can(d, "editor")} for d in _all() if d["item_id"] in visible), key=lambda x: x["updated_at"], reverse=True)


@router.post("/diagrams")
def create_diagram(req: DiagramIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "store the diagram in a Project or a folder")
    graph = _check_graph(reference(req.reference_id)["graph"] if req.reference_id else req.graph or empty_graph())
    with _lock:
        hexid = uuid.uuid4().hex[:12]
        did = f"sd-{hexid}"
        body = json.dumps({"solution_diagram_id": did}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{req.name.strip()}.sdiagram"), io.BytesIO(body), len(body), SD_TYPE)
        d = {"id": did, "rid": f"ri.solution-designer.main.diagram.{hexid}", "item_id": item["id"], "name": req.name.strip(), "version": 1, "graph": graph,
             "saved_version": 1, "history": [{"version": 1, "at": _now(), "by": _me()["id"], "manual": True, "description": "Created", "graph": graph}],
             "architect": None, "critic": {"messages": [], "plan": None}, "created_by": _me()["id"], "created_at": _now(), "updated_at": _now()}
        _wr(_path(did), d)
    return get_diagram(did)


def _who(uid: Optional[str]) -> Optional[str]:
    if not uid or not str(uid).startswith("u-"):
        return uid
    try:
        u = auth._user(uid)
        return u.get("display_name") or u.get("username") or uid
    except HTTPException:
        return uid


@router.get("/diagrams/{did}")
def get_diagram(did: str, version: Optional[int] = None) -> dict:
    d = _get(did)
    _access(d)
    graph = d["graph"]
    if version:
        h = next((x for x in d["history"] if x["version"] == version), None)
        if not h:
            raise HTTPException(404, "version not found")
        graph = h["graph"]
    return {**_summary(d), "graph": graph, "previewing": version, "can_edit": _can(d, "editor"), "saved_version": d.get("saved_version"),
            "architect": d.get("architect"), "critic": d.get("critic") or {"messages": [], "plan": None},
            "versions": [{"version": h["version"], "at": h["at"], "by": _who(h.get("by")), "manual": h.get("manual", False), "description": h.get("description", ""),
                          "nodes": len(h["graph"]["nodes"])} for h in reversed(d["history"])][:100]}


class SaveIn(BaseModel):
    graph: dict
    base_version: int
    manual: bool = False
    description: str = Field("", max_length=500)
    name: Optional[str] = Field(None, max_length=200)


@router.put("/diagrams/{did}")
def save_diagram(did: str, req: SaveIn) -> dict:
    """Autosave (manual=false) or Save: either way a new version."""
    with _lock:
        d = _get(did)
        item = _access(d, "editor")
        if req.base_version != d["version"]:
            raise HTTPException(409, f"version {d['version']} was saved after you opened version {req.base_version}: reload")
        graph = _check_graph(req.graph)
        if req.name and req.name.strip() and req.name.strip() != d.get("name"):
            drive.update_item(item["id"], drive.ItemChange(name=f"{req.name.strip()}.sdiagram"))
            d["name"] = req.name.strip()
        d["version"] += 1
        d["graph"] = graph
        d["updated_at"] = _now()
        if req.manual:
            d["saved_version"] = d["version"]
        d["history"].append({"version": d["version"], "at": _now(), "by": _me()["id"], "manual": req.manual, "description": req.description, "graph": graph})
        # autosaves between manual saves are thinned to the last 50; manual saves are kept (up to 200)
        auto = [h for h in d["history"] if not h.get("manual")]
        drop = {h["version"] for h in auto[:-50]}
        d["history"] = [h for h in d["history"] if h["version"] not in drop][-200:]
        _wr(_path(did), d)
    return get_diagram(did)


@router.post("/diagrams/{did}/versions/{version}/restore")
def restore(did: str, version: int) -> dict:
    d = _get(did)
    h = next((x for x in d["history"] if x["version"] == version), None)
    if not h:
        raise HTTPException(404, "version not found")
    return save_diagram(did, SaveIn(graph=h["graph"], base_version=d["version"], manual=True, description=f"Restored version {version}"))


@router.delete("/diagrams/{did}")
def delete_diagram(did: str) -> dict:
    d = _get(did)
    drive.trash(_access(d, "editor")["id"])
    return {"trashed": did}


@router.get("/diagrams/{did}/export")
def export_json(did: str) -> Response:
    """The diagram as JSON (editors only, as in Solution Designer)."""
    d = _get(did)
    _access(d, "editor")
    body = json.dumps({"format": "bluesandai.solution-diagram", "version": 1, "name": d.get("name"), "graph": d["graph"]}, ensure_ascii=False, indent=1)
    name = re.sub(r"[^A-Za-z0-9 _-]", "_", d.get("name") or did)
    return Response(body, media_type="application/json", headers={"Content-Disposition": f'attachment; filename="{name}.json"'})


# ------------------------------------------------------------------------------------------------
# resources: pick, resolve (missing / no access), object traversal, Data Lineage import
# ------------------------------------------------------------------------------------------------


def _file_href(item: dict) -> str:
    ct = item.get("content_type") or ""
    if ct == "application/vnd.bluesandai.pipeline+json":
        return f"/pipeline/{item['id']}"
    if ct.endswith("parquet") or item["name"].endswith((".parquet", ".csv")):
        return f"/datasets/{item['id']}"
    return f"/files/{item.get('parent_id') or ''}"


@router.get("/resources")
def resources(kind: str, q: str = "") -> list[dict]:
    import ontology

    ql = q.strip().lower()
    out: list[dict] = []
    if kind == "file":
        like = f"%{ql}%"
        items = db.drive_query("kind = 'file' AND trashed_at IS NULL AND LOWER(name) LIKE %s", (like,), order="updated_at DESC", limit=200)
        for i in auth.visible(items)[:60]:
            out.append({"kind": "file", "id": i["id"], "name": i["name"], "subtitle": i.get("content_type") or "", "href": _file_href(i)})
    elif kind == "object_type":
        for t in ontology.list_object_types():
            if ql in t["display_name"].lower():
                out.append({"kind": "object_type", "id": t["id"], "name": t["display_name"], "subtitle": t.get("description") or "", "href": f"/ontology/{t['id']}"})
    elif kind == "interface":
        import ontology_model

        for i in ontology_model.list_interfaces():
            name = i.get("display_name") or i.get("api_name") or i["id"]
            if ql in name.lower():
                out.append({"kind": "interface", "id": i["id"], "name": name, "subtitle": i.get("description") or "", "href": "/ontology"})
    elif kind == "action_type":
        for a in ontology.list_action_types():
            if ql in a["display_name"].lower():
                out.append({"kind": "action_type", "id": a["id"], "name": a["display_name"], "subtitle": a.get("description") or "", "href": f"/ontology/actions/{a['id']}"})
    else:
        raise HTTPException(422, f"kind is one of {', '.join(RESOURCE_KINDS)}")
    return out[:60]


def _resolve_one(kind: str, rid: str) -> dict:
    import ontology

    try:
        if kind == "file":
            i = drive._item(rid, need="viewer")
            return {"ok": True, "name": i["name"], "href": _file_href(i)}
        if kind == "object_type":
            t = next((t for t in ontology.list_object_types() if t["id"] == rid), None)
            return {"ok": True, "name": t["display_name"], "href": f"/ontology/{rid}"} if t else {"ok": False, "reason": "missing or no access"}
        if kind == "interface":
            import ontology_model

            i = next((i for i in ontology_model.list_interfaces() if i["id"] == rid), None)
            return {"ok": True, "name": i.get("display_name") or i["id"], "href": "/ontology"} if i else {"ok": False, "reason": "missing or no access"}
        if kind == "action_type":
            a = next((a for a in ontology.list_action_types() if a["id"] == rid), None)
            return {"ok": True, "name": a["display_name"], "href": f"/ontology/actions/{rid}"} if a else {"ok": False, "reason": "missing or no access"}
    except HTTPException as e:
        return {"ok": False, "reason": "no access" if e.status_code == 403 else "missing"}
    return {"ok": False, "reason": "unknown kind"}


class ResolveIn(BaseModel):
    resources: list[dict] = Field(max_length=500)


@router.post("/resolve")
def resolve(req: ResolveIn) -> dict:
    """Linked resources' current names and links, or why they cannot be opened."""
    out = {}
    for r in req.resources:
        if r.get("kind") in RESOURCE_KINDS and r.get("id"):
            out[f"{r['kind']}:{r['id']}"] = _resolve_one(r["kind"], str(r["id"]))
    return out


@router.get("/object-traversal/{type_id}")
def object_traversal(type_id: str) -> list[dict]:
    """The link types of an object type and the object types on their other side."""
    import ontology
    import ontology_model

    names = {t["id"]: t["display_name"] for t in ontology.list_object_types()}
    if type_id not in names:
        raise HTTPException(404, "object type not found")
    out = []
    for lt in ontology_model.list_link_types(object_type_id=type_id):
        s, t = lt["source"]["object_type_id"], lt["target"]["object_type_id"]
        other = t if s == type_id else s
        if other not in names:
            continue
        side = lt["target"] if s == type_id else lt["source"]
        out.append({"link_type_id": lt["id"], "name": side.get("display_name") or lt.get("display_name") or lt.get("api_name") or lt["id"], "cardinality": lt.get("cardinality"),
                    "object_type_id": other, "object_type": names[other]})
    return out


_LINEAGE_COMPONENT = {"connection": "data-connection", "datasource": "data-connection", "dataset": "dataset", "manual": "upload", "virtual": "data-connection", "stream": "streaming",
                      "pipeline": "pipeline-builder", "transform": "code-repositories", "preparation": "preparation", "sql": "sql-studio", "object_type": "object-type",
                      "logic": "aip-logic", "automation": "automate", "agent": "aip-agents", "module": "workshop"}


@router.get("/lineage")
def lineage_import(root: Optional[str] = None, depth: int = 3, limit: int = 120) -> dict:
    """Data Lineage's graph (or the part within `depth` steps of `root`) as diagram nodes and edges."""
    import lineage

    g = lineage.graph()
    nodes = {n["id"]: n for n in g["nodes"]}
    keep = set(nodes)
    if root:
        if root not in nodes:
            raise HTTPException(404, "lineage node not found")
        keep, frontier = {root}, {root}
        for _ in range(max(1, min(depth, 8))):
            nxt = set()
            for e in g["edges"]:
                if e["from"] in frontier and e["to"] not in keep:
                    nxt.add(e["to"])
                if e["to"] in frontier and e["from"] not in keep:
                    nxt.add(e["from"])
            keep |= nxt
            frontier = nxt
    deg: dict[str, int] = {}
    for e in g["edges"]:
        if e["from"] in keep and e["to"] in keep:
            deg[e["from"]] = deg.get(e["from"], 0) + 1
            deg[e["to"]] = deg.get(e["to"], 0) + 1
    keep = set(sorted(keep, key=lambda i: (i != root, -deg.get(i, 0), i))[:limit])  # connected nodes first
    out_nodes, idmap = [], {}
    for nid in keep:
        n = nodes[nid]
        new = _nid()
        idmap[nid] = new
        res = None
        if n["kind"] == "dataset" and n.get("item_id"):
            res = {"kind": "file", "id": n["item_id"], "name": n["name"]}
        elif n["kind"] == "object_type":
            res = {"kind": "object_type", "id": nid.split(":", 1)[-1], "name": n["name"]}
        elif n["kind"] == "pipeline" and n.get("item_id"):
            res = {"kind": "file", "id": n["item_id"], "name": n["name"]}
        base = {"id": new, "title": n["name"], "description": n.get("subtitle") or "", "tags": ["lineage"], "lineage_id": nid, "href": n.get("link")}
        if res:
            out_nodes.append({**base, "kind": "resource", "resource": res, "component": _LINEAGE_COMPONENT.get(n["kind"])})
        else:
            out_nodes.append({**base, "kind": "component", "component": _LINEAGE_COMPONENT.get(n["kind"], "custom")})
    out_edges = [{"id": f"e-{uuid.uuid4().hex[:8]}", "from": idmap[e["from"]], "to": idmap[e["to"]], "label": ""} for e in g["edges"] if e["from"] in idmap and e["to"] in idmap]
    layout(out_nodes, out_edges)
    return {"nodes": out_nodes, "edges": out_edges, "lineage_nodes": [{"id": n["id"], "name": n["name"], "kind": n["kind"]} for n in g["nodes"]][:2000]}


class LineageFocusIn(BaseModel):
    resources: list[dict] = Field(default_factory=list, max_length=2000)
    lineage_ids: list[str] = Field(default_factory=list, max_length=2000)


# a linked resource's kind -> the Data Lineage node id prefixes it can appear under (files also match by item id)
_RESOURCE_LINEAGE = {"file": ("dataset", "pipeline", "preparation", "sql"), "object_type": ("object_type",), "action_type": ("action",)}


@router.post("/lineage/focus")
def lineage_focus(req: LineageFocusIn) -> dict:
    """"Open in Data Lineage": the Data Lineage node ids of a diagram's linked resources (and of nodes imported from
    Data Lineage), for `/lineage?nodes=...`. Resources the graph does not hold (interfaces, files that are neither
    datasets nor builds, or nodes hidden from the caller by markings) are counted as missing."""
    import lineage

    g = lineage.graph()
    present = {n["id"] for n in g["nodes"]}
    by_item: dict[str, list[str]] = {}
    for n in g["nodes"]:
        if n.get("item_id"):
            by_item.setdefault(str(n["item_id"]), []).append(n["id"])
    ids: list[str] = []
    missing: list[dict] = []

    def take(nid: str) -> None:
        if nid not in ids:
            ids.append(nid)

    for r in req.resources:
        kind, rid = str(r.get("kind") or ""), str(r.get("id") or "")
        hits = [f"{p}:{rid}" for p in _RESOURCE_LINEAGE.get(kind, ()) if f"{p}:{rid}" in present]
        if kind == "file":
            hits += [h for h in by_item.get(rid, []) if h not in hits]
        for h in hits:
            take(h)
        if not hits:
            missing.append({"kind": kind, "id": rid, "name": r.get("name")})
    for nid in req.lineage_ids:
        if nid in present:
            take(nid)
    return {"ids": ids, "missing": missing}


# ------------------------------------------------------------------------------------------------
# AIP: language model helpers
# ------------------------------------------------------------------------------------------------


def _llm(model: Optional[str], system: str, user: str, schema: dict, max_tokens: int = 6000, image: Optional[str] = None) -> Any:
    import ontology
    import pipeline_ai

    try:
        return pipeline_ai.chat(model or ontology.DEFAULT_LLM, pipeline_ai.with_platform(system), user, schema, 0.3, max_tokens, None, image)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the language model failed: {str(e)[:300]}") from None


def _catalog_text() -> str:
    by: dict[str, list[str]] = {}
    for c in COMPONENTS.values():
        by.setdefault(c["category"], []).append(f"{c['id']} ({c['name']}: {c['description']})")
    return "\n".join(f"{dict(CATEGORIES)[k]}:\n  " + "\n  ".join(v) for k, v in by.items())


def _section(n: dict) -> str:
    if n["kind"] == "component":
        return COMPONENTS.get(n.get("component") or "", {}).get("category", "custom")
    if n["kind"] == "concept":
        return CONCEPTS.get(n.get("concept") or "", ("", "custom"))[1]
    if n["kind"] in ("object",):
        return "ontology"
    if n["kind"] == "resource":
        k = (n.get("resource") or {}).get("kind")
        if k in ("object_type", "interface", "action_type"):
            return "ontology"
        return COMPONENTS.get(n.get("component") or "dataset", {}).get("category", "processing")
    return "custom"


def sections(graph: dict) -> list[dict]:
    """AIP Critic's organization of the diagram."""
    out = {k: [] for k, _ in CATEGORIES}
    for n in graph["nodes"]:
        if n["kind"] in ("group", "text"):
            continue
        out[_section(n)].append({"id": n["id"], "title": n.get("title") or COMPONENTS.get(n.get("component") or "", {}).get("name", n["kind"])})
    return [{"id": k, "name": name, "nodes": out[k]} for k, name in CATEGORIES if out[k]]


def describe(graph: dict) -> str:
    """The diagram as text for a model: nodes by section, then the connections, groups and notes."""
    title = {n["id"]: n.get("title") or n["kind"] for n in graph["nodes"]}
    lines = [f"Diagram description: {graph.get('description') or '(none)'}", "Nodes by section:"]
    for s in sections(graph):
        lines.append(f"- {s['name']}:")
        for x in s["nodes"]:
            n = next(n for n in graph["nodes"] if n["id"] == x["id"])
            what = COMPONENTS.get(n.get("component") or "", {}).get("name") if n["kind"] == "component" else (n.get("resource") or {}).get("kind") or n["kind"]
            extra = f" — {n['description'][:300]}" if n.get("description") else ""
            props = f" properties: {', '.join(p.get('name', '') for p in (n.get('proposed') or {}).get('properties') or [])}" if n["kind"] == "object" else ""
            lines.append(f"  - [{n['id']}] {x['title']} ({what}){extra}{props}")
    lines.append("Connections:")
    for e in graph["edges"]:
        lines.append(f"  - {title.get(e['from'])} -> {title.get(e['to'])}{f' ({e['label']})' if e.get('label') else ''}")
    groups = [n for n in graph["nodes"] if n["kind"] == "group"]
    for g in groups:
        members = [title[n["id"]] for n in graph["nodes"] if n.get("parent") == g["id"]]
        lines.append(f"Group {g.get('title') or 'group'}: {', '.join(members)}")
    notes = [n.get("title") or n.get("description") for n in graph["nodes"] if n["kind"] == "text"]
    if notes:
        lines.append("Notes: " + " | ".join(str(x)[:300] for x in notes if x))
    return "\n".join(lines)[:30000]


def _save_part(did: str, key: str, value: Any) -> None:
    with _lock:
        d = _get(did)
        d[key] = value
        _wr(_path(did), d)


# ------------------------------------------------------------------------------------------------
# streaming: the model's answer as server-sent events while it is written
# ------------------------------------------------------------------------------------------------


class _Cancelled(Exception):
    """The reader went away (the panel closed): the model call is abandoned and nothing is saved."""


_MISSING = object()
_FENCE = re.compile(r"^\s*```(?:json)?\s*")


def partial_json(text: str) -> Any:
    """The value of a JSON prefix as far as it goes: open strings, arrays and objects are closed; an unfinished number,
    literal or key is left out. None when nothing is readable yet."""
    n = len(text)
    pos = [0]

    def ws() -> None:
        while pos[0] < n and text[pos[0]] in " \t\r\n":
            pos[0] += 1

    def string() -> tuple[str, bool]:
        i = pos[0] + 1
        out: list[str] = []
        while i < n:
            ch = text[i]
            if ch == '"':
                pos[0] = i + 1
                return "".join(out), True
            if ch == "\\":
                if i + 1 >= n:
                    break
                esc = text[i + 1]
                if esc == "u":
                    if i + 6 > n:
                        break
                    try:
                        out.append(chr(int(text[i + 2:i + 6], 16)))
                    except ValueError:
                        out.append("?")
                    i += 6
                    continue
                out.append({"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}.get(esc, esc))
                i += 2
                continue
            out.append(ch)
            i += 1
        pos[0] = n
        return "".join(out), False

    def value() -> Any:
        ws()
        if pos[0] >= n:
            return _MISSING
        ch = text[pos[0]]
        if ch == '"':
            return string()[0]
        if ch in "{[":
            obj = ch == "{"
            out: Any = {} if obj else []
            pos[0] += 1
            while True:
                ws()
                if pos[0] >= n:
                    return out
                c = text[pos[0]]
                if c in "}]":
                    pos[0] += 1
                    return out
                if c == ",":
                    pos[0] += 1
                    continue
                if obj:
                    if c != '"':
                        pos[0] = n
                        return out
                    key, done = string()
                    ws()
                    if not done or pos[0] >= n or text[pos[0]] != ":":
                        pos[0] = n
                        return out
                    pos[0] += 1
                v = value()
                if v is _MISSING:
                    return out
                if obj:
                    out[key] = v
                else:
                    out.append(v)
        m = re.match(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null", text[pos[0]:])
        if not m or pos[0] + m.end() >= n:  # it may still grow ("12" of "123", "tru")
            pos[0] = n
            return _MISSING
        pos[0] += m.end()
        return json.loads(m.group(0))

    v = value()
    return None if v is _MISSING else v


def _partial_of(text: str, schema: Optional[dict]) -> Any:
    """What a reader can show of an answer being written: the text, or the JSON value parsed so far."""
    if schema is None:
        return text
    p = partial_json(_FENCE.sub("", text))
    return p.get("value") if isinstance(p, dict) else None


def _final(text: str, schema: Optional[dict]) -> Any:
    """A whole streamed answer read the way pipeline_ai.chat reads one."""
    if schema is None:
        return text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    value = json.loads(cleaned)["value"]
    if isinstance(value, str) and schema.get("type") == "object":
        try:
            value = json.loads(value)
        except ValueError:
            pass
    if schema.get("type") == "object" and not isinstance(value, dict):
        raise ValueError("the answer is not the JSON object asked for")
    return value


def _provider_stream(model: str, system: str, user: str, schema: Optional[dict], max_tokens: int, on_text: Any, cancel: threading.Event,
                     hold: dict) -> str:
    """One streamed call to the model's provider (Gemini streamGenerateContent or OpenRouter with stream=true), with
    the same request pipeline_ai.chat sends; on_text gets the answer so far after every piece. Returns the whole text."""
    import pipeline_ai
    import requests

    wrapped = {"type": "object", "properties": {"value": schema}, "required": ["value"]} if schema is not None else None
    gemini = model.startswith("gemini")
    if gemini:
        key = pipeline_ai._env("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set in .env.local")
        gen: dict[str, Any] = {"temperature": 0.3, "maxOutputTokens": max_tokens, "thinkingConfig": {"thinkingLevel": "low"}}
        if wrapped:
            gen["responseMimeType"] = "application/json"
            gen["responseSchema"] = pipeline_ai._gemini_schema(wrapped)
        body: dict[str, Any] = {"contents": [{"role": "user", "parts": [{"text": user}]}], "generationConfig": gen}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        url = pipeline_ai.GEMINI_URL.format(model=model).replace(":generateContent", ":streamGenerateContent") + "?alt=sse"
        headers = {"x-goog-api-key": key}
    else:
        key = pipeline_ai._env("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY is not set in .env.local")
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
        body = {"model": model, "messages": messages, "temperature": 0.3, "max_tokens": max_tokens, "stream": True}
        if wrapped:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "strict": False, "schema": wrapped}}
        if "qwen" in model:
            body["reasoning"] = {"enabled": False}
        url, headers = pipeline_ai.OPENROUTER_URL, {"Authorization": f"Bearer {key}"}
    parts: list[str] = []
    tokens = 0
    with requests.post(url, headers=headers, json=body, timeout=pipeline_ai.TIMEOUT, stream=True) as resp:
        hold["resp"] = resp
        if resp.status_code != 200:
            pipeline_ai._note_usage(model, "rate_limited" if resp.status_code == 429 else "failed")
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        for raw in resp.iter_lines():
            if cancel.is_set():
                raise _Cancelled()
            line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except ValueError:
                continue
            if gemini:
                cand = (ev.get("candidates") or [{}])[0]
                piece = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or [])
                tokens = (ev.get("usageMetadata") or {}).get("totalTokenCount") or tokens
            else:
                piece = (((ev.get("choices") or [{}])[0]).get("delta") or {}).get("content") or ""
                tokens = (ev.get("usage") or {}).get("total_tokens") or tokens
            if piece:
                parts.append(piece)
                on_text("".join(parts))
    pipeline_ai._note_usage(model, "succeeded", tokens)
    return "".join(parts)


def _llm_streamed(model: Optional[str], system: str, user: str, schema: Optional[dict], max_tokens: int, emit: Any, cancel: threading.Event,
                  hold: dict) -> Any:
    """_llm with the answer streamed as "partial" events. A provider's model streams; a registered model (function:…),
    a failed stream or an unreadable answer falls back to the plain call (with its retries) after a "reset" event."""
    import ontology

    model = model or ontology.DEFAULT_LLM
    last = [0.0]

    def on_text(text: str) -> None:
        now = time.monotonic()
        if now - last[0] >= 0.08:
            last[0] = now
            p = _partial_of(text, schema)
            if p is not None:
                emit("partial", p)

    if not model.startswith("function:"):
        try:
            return _final(_provider_stream(model, __import__("pipeline_ai").with_platform(system), user, schema, max_tokens, on_text, cancel, hold), schema)
        except _Cancelled:
            raise
        except Exception as e:  # noqa: BLE001 - the plain call retries and reports its own errors
            if cancel.is_set():
                raise _Cancelled() from None
            emit("reset", {"reason": str(e)[:300]})
    out = _llm(model, system, user, schema, max_tokens)
    if cancel.is_set():
        raise _Cancelled()
    return out


def _sse(request: Request, work: Any) -> StreamingResponse:
    """Run work(emit, cancel, hold) → result in a thread (with this request's user) and stream its events: partial…,
    then result (or error). When the reader disconnects the work is cancelled: the model call is closed, nothing saved."""
    import asyncio
    import contextvars
    import queue

    q: "queue.Queue" = queue.Queue()
    cancel = threading.Event()
    hold: dict = {}
    ctx = contextvars.copy_context()

    def run() -> None:
        try:
            q.put(("result", work(lambda kind, payload: q.put((kind, payload)), cancel, hold)))
        except _Cancelled:
            q.put(("cancelled", {}))
        except HTTPException as e:
            q.put(("error", {"status": e.status_code, "detail": e.detail}))
        except Exception as e:  # noqa: BLE001
            q.put(("error", {"status": 500, "detail": str(e)[:500]}))

    threading.Thread(target=ctx.run, args=(run,), daemon=True, name="sd-stream").start()

    async def events() -> Any:
        try:
            while True:
                try:
                    kind, payload = await asyncio.to_thread(q.get, True, 1.0)
                except queue.Empty:
                    if await request.is_disconnected():
                        return
                    yield ": waiting\n\n"
                    continue
                yield f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
                if kind in ("result", "error", "cancelled"):
                    return
        finally:
            if not cancel.is_set():
                cancel.set()
                try:
                    if hold.get("resp") is not None:
                        hold["resp"].close()  # unblocks the model call's read
                except Exception:  # noqa: BLE001
                    pass

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------------------------------------
# AIP Architect
# ------------------------------------------------------------------------------------------------

_STR = {"type": "string"}
_EDGES = {"type": "array", "items": {"type": "object", "properties": {"from": _STR, "to": _STR, "label": _STR}, "required": ["from", "to", "label"]}}


class WizardIn(BaseModel):
    artifact: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=3, max_length=8000)
    source: str = Field("existing", max_length=100)
    frequency: str = Field("", max_length=100)
    scale: str = Field("", max_length=100)
    data_properties: list[str] = Field(default_factory=list, max_length=10)
    code_level: str = Field("low", pattern="^(no|low|pro)$")
    model: Optional[str] = None
    replace: bool = True


ARCHITECT_SYSTEM = """You are AIP Architect, a solution architect for a data and operations platform with these components:
{catalog}
You plan workflows as graphs of abstract concept nodes before choosing components. Answer in the user's language."""


@router.post("/diagrams/{did}/architect/generate")
def architect_generate(did: str, req: WizardIn) -> dict:
    """The wizard's answers → a workflow graph of concept nodes (the plan is kept on the diagram)."""
    d = _get(did)
    _access(d, "editor")
    schema = {"type": "object", "properties": {
        "title": _STR,
        "concepts": {"type": "array", "items": {"type": "object", "properties": {"key": _STR, "concept": {"type": "string", "enum": list(CONCEPTS)}, "title": _STR, "description": _STR},
                                                "required": ["key", "concept", "title", "description"]}},
        "edges": _EDGES}, "required": ["title", "concepts", "edges"]}
    user = (f"End product: {req.artifact}\nWorkflow requirements: {req.summary}\nSource of data: {req.source}\nUpdate frequency: {req.frequency or 'unknown'}\n"
            f"Data scale: {req.scale or 'unknown'}\nSpecial data properties: {', '.join(req.data_properties) or 'none'}\nBuild style: {req.code_level} code\n\n"
            "Plan the workflow as 4 to 8 concept nodes (always one 'ontology' node; 'external_systems' only when data comes from outside) connected in the order data and "
            "decisions flow. Titles name the step in this workflow's terms (e.g. 'Claim ingestion', 'Risk scoring'), never a product name. Keys are short unique words; edges use the keys; labels say what flows. Each description says what this step must achieve for this workflow.")
    out = _llm(req.model, ARCHITECT_SYSTEM.format(catalog=_catalog_text()), user, schema)
    keys = {}
    nodes = []
    for c in out.get("concepts") or []:
        if c.get("concept") not in CONCEPTS:
            continue
        n = {"id": _nid(), "kind": "concept", "concept": c["concept"], "title": c.get("title") or CONCEPTS[c["concept"]][0], "description": c.get("description") or "", "tags": ["aip-architect"]}
        keys[c.get("key")] = n["id"]
        nodes.append(n)
    if not nodes:
        raise HTTPException(502, "the model did not return a workflow graph: try again or another model")
    edges = [{"id": f"e-{uuid.uuid4().hex[:8]}", "from": keys[e["from"]], "to": keys[e["to"]], "label": e.get("label") or ""} for e in out.get("edges") or [] if e.get("from") in keys and e.get("to") in keys]
    layout(nodes, edges, dx=320, dy=150)
    plan = {"wizard": req.model_dump(), "summary": req.summary, "title": out.get("title") or req.artifact, "model": req.model, "generated_at": _now(), "implemented": {}}
    _save_part(did, "architect", plan)
    return {"architect": plan, "nodes": nodes, "edges": edges}


class SummaryIn(BaseModel):
    summary: str = Field(min_length=3, max_length=8000)
    model: Optional[str] = None


@router.put("/diagrams/{did}/architect/summary")
def architect_summary(did: str, req: SummaryIn) -> dict:
    d = _get(did)
    _access(d, "editor")
    plan = d.get("architect") or {"wizard": None, "implemented": {}}
    plan["summary"] = req.summary
    if req.model:
        plan["model"] = req.model
    _save_part(did, "architect", plan)
    return plan


class ImplementIn(BaseModel):
    node_id: str
    graph: dict
    model: Optional[str] = None


@router.post("/diagrams/{did}/architect/implement")
def architect_implement(did: str, req: ImplementIn) -> dict:
    """Implementation patterns for a concept node, given the current diagram (with the user's changes)."""
    node, call = _implement_call(did, req)
    return _implement_result(node, _llm(*call))


@router.post("/diagrams/{did}/architect/implement/stream")
def architect_implement_stream(did: str, req: ImplementIn, request: Request) -> StreamingResponse:
    """The same as /implement, streamed: "partial" events carry the patterns as far as written (name, summary,
    rationale and trade-offs grow as the model explains them), "result" the patterns /implement returns."""
    node, call = _implement_call(did, req)  # 403 / 404 / 422 before the stream starts
    return _sse(request, lambda emit, cancel, hold: _implement_result(node, _llm_streamed(*call, emit, cancel, hold)))


def _implement_call(did: str, req: ImplementIn) -> tuple[dict, tuple]:
    d = _get(did)
    _access(d, "editor")
    graph = _check_graph(req.graph)
    node = next((n for n in graph["nodes"] if n["id"] == req.node_id and n["kind"] == "concept"), None)
    if not node:
        raise HTTPException(404, "concept node not found")
    plan = d.get("architect") or {}
    code = ((plan.get("wizard") or {}).get("code_level")) or "low"
    comp = {"type": "object", "properties": {"key": _STR, "component": {"type": "string", "enum": list(COMPONENTS)}, "title": _STR, "description": _STR}, "required": ["key", "component", "title", "description"]}
    schema = {"type": "object", "properties": {"patterns": {"type": "array", "items": {"type": "object", "properties": {
        "name": _STR, "summary": _STR, "rationale": _STR, "tradeoffs": _STR, "components": {"type": "array", "items": comp}, "edges": _EDGES,
        "entry": _STR, "exit": _STR}, "required": ["name", "summary", "rationale", "tradeoffs", "components", "edges", "entry", "exit"]}}}, "required": ["patterns"]}
    user = (f"Workflow summary: {plan.get('summary') or graph.get('description') or '(none)'}\nBuild style: {code} code\n\nCurrent diagram:\n{describe(graph)}\n\n"
            f"Suggest 2 or 3 implementation patterns for the concept node [{node['id']}] \"{node['title']}\" ({node['concept']}): {node.get('description')}.\n"
            "Each pattern lists 2 to 6 components from the catalog (by id) with titles specific to this workflow and what each does, the edges between them (by key), "
            "and `entry` / `exit`: the keys of the components that the incoming and outgoing connections of the concept node should attach to. Fit the build style; "
            "respect what is already in the diagram.")
    return node, (req.model or plan.get("model"), ARCHITECT_SYSTEM.format(catalog=_catalog_text()), user, schema, 8000)


def _implement_result(node: dict, out: Any) -> dict:
    pats = []
    for p in out.get("patterns") or []:
        comps = [c for c in p.get("components") or [] if c.get("component") in COMPONENTS]
        if not comps:
            continue
        keys = {c["key"] for c in comps}
        pats.append({**p, "components": comps, "edges": [e for e in p.get("edges") or [] if e.get("from") in keys and e.get("to") in keys],
                     "entry": p.get("entry") if p.get("entry") in keys else comps[0]["key"], "exit": p.get("exit") if p.get("exit") in keys else comps[-1]["key"]})
    if not pats:
        raise HTTPException(502, "the model returned no usable pattern: try again")
    return {"node_id": node["id"], "patterns": pats}


class ImplementedIn(BaseModel):
    node_id: str
    pattern: str = Field(max_length=300)


@router.post("/diagrams/{did}/architect/implemented")
def architect_implemented(did: str, req: ImplementedIn) -> dict:
    d = _get(did)
    _access(d, "editor")
    plan = d.get("architect") or {"implemented": {}}
    plan.setdefault("implemented", {})[req.node_id] = {"pattern": req.pattern, "at": _now()}
    _save_part(did, "architect", plan)
    return plan


class DataModelIn(BaseModel):
    node_id: str
    prompt: str = Field(min_length=3, max_length=6000)
    graph: dict
    model: Optional[str] = None


@router.post("/diagrams/{did}/architect/data-model")
def architect_data_model(did: str, req: DataModelIn) -> dict:
    """The Ontology node's "Generate data model": proposed object types with properties and link types."""
    import ontology

    d = _get(did)
    _access(d, "editor")
    graph = _check_graph(req.graph)
    plan = d.get("architect") or {}
    existing = [t["display_name"] for t in ontology.list_object_types()][:80]
    prop = {"type": "object", "properties": {"name": _STR, "dataType": {"type": "string", "enum": ["string", "integer", "double", "boolean", "date", "timestamp", "geopoint"]}, "description": _STR},
            "required": ["name", "dataType", "description"]}
    schema = {"type": "object", "properties": {
        "object_types": {"type": "array", "items": {"type": "object", "properties": {"key": _STR, "name": _STR, "description": _STR, "primary_key": _STR, "title_property": _STR,
                                                                                    "existing": {"type": "boolean"}, "properties": {"type": "array", "items": prop}},
                                                    "required": ["key", "name", "description", "primary_key", "title_property", "existing", "properties"]}},
        "links": {"type": "array", "items": {"type": "object", "properties": {"from": _STR, "to": _STR, "name": _STR, "cardinality": {"type": "string", "enum": ["one-to-many", "many-to-many", "one-to-one"]}},
                                             "required": ["from", "to", "name", "cardinality"]}}}, "required": ["object_types", "links"]}
    user = (f"Workflow summary: {plan.get('summary') or graph.get('description') or ''}\nDiagram:\n{describe(graph)}\n\nExisting object types in the Ontology: {', '.join(existing) or 'none'}\n\n"
            f"Data model request: {req.prompt}\n\nPropose 2 to 7 object types (snake_case property names, a primary key and a title property among them; set existing=true and "
            "reuse the exact name when an existing object type fits) and the link types between them (by key).")
    out = _llm(req.model or plan.get("model"), ARCHITECT_SYSTEM.format(catalog=_catalog_text()), user, schema, 8000)
    concept = next((n for n in graph["nodes"] if n["id"] == req.node_id), None)
    x0, y0 = (concept["x"], concept["y"] + 140) if concept else (80, 80)
    ids, nodes, edges = {}, [], []
    by_name = {t["display_name"].lower(): t for t in ontology.list_object_types()}
    for i, t in enumerate(out.get("object_types") or []):
        hit = by_name.get(str(t.get("name") or "").lower()) if t.get("existing") else None
        n = {"id": _nid(), "x": x0 + (i % 3) * 270, "y": y0 + (i // 3) * 170, "tags": ["aip-architect", "data-model"], "description": t.get("description") or ""}
        if hit:
            n |= {"kind": "resource", "title": hit["display_name"], "resource": {"kind": "object_type", "id": hit["id"], "name": hit["display_name"]}, "component": "object-type"}
        else:
            n |= {"kind": "object", "title": t.get("name") or "Object type", "proposed": {"primary_key": t.get("primary_key"), "title_property": t.get("title_property"), "properties": (t.get("properties") or [])[:40]}}
        ids[t.get("key")] = n["id"]
        nodes.append(n)
    for lk in out.get("links") or []:
        if lk.get("from") in ids and lk.get("to") in ids:
            edges.append({"id": f"e-{uuid.uuid4().hex[:8]}", "from": ids[lk["from"]], "to": ids[lk["to"]], "label": f"{lk.get('name') or ''} ({lk.get('cardinality')})",
                          **({"proposed": {"name": str(lk.get("name") or ""), "cardinality": lk["cardinality"]}} if lk.get("cardinality") in _CARDINALITIES else {})})
    if not nodes:
        raise HTTPException(502, "the model returned no object types: try again")
    return {"nodes": nodes, "edges": edges}


@router.get("/diagrams/{did}/architect/walkthrough")
def walkthrough(did: str) -> dict:
    """The build steps: the diagram's components and resources in dependency order, each with where to build it."""
    d = _get(did)
    _access(d)
    g = d["graph"]
    real = [n for n in g["nodes"] if n["kind"] in ("component", "resource", "object")]
    ids = {n["id"] for n in real}
    inc = {i: [e["from"] for e in g["edges"] if e["to"] == i and e["from"] in ids] for i in ids}
    order, seen = [], set()

    def visit(i: str, stack: frozenset = frozenset()) -> None:
        if i in seen or i in stack:
            return
        for p in inc[i]:
            visit(p, stack | {i})
        seen.add(i)
        order.append(i)

    for n in sorted(real, key=lambda n: (n["x"], n["y"])):
        visit(n["id"])
    by = {n["id"]: n for n in real}
    steps = []
    for i in order:
        n = by[i]
        c = COMPONENTS.get(n.get("component") or "") or {}
        if n["kind"] == "object":
            what, href, comp = "Create this object type (backing dataset, properties, primary key) in Ontology Manager.", "/ontology", "Ontology Manager"
        elif n["kind"] == "resource":
            res = n.get("resource") or {}
            what, href, comp = f"Already built: {res.get('name') or n['title']}. Check it fits this workflow.", n.get("href") or _resolve_one(res.get("kind"), res.get("id")).get("href") if res else None, c.get("name") or res.get("kind")
        else:
            if c.get("category") == "external":
                what, href = "An external system: agree on access (credentials, network egress) for the source that reads it.", "/sources"
            else:
                what, href = c.get("description") or "", c.get("href")
            comp = c.get("name")
        steps.append({"node_id": i, "title": n.get("title") or comp, "component": comp, "description": n.get("description") or "", "what": what, "href": href,
                      "after": [by[p].get("title") for p in inc[i]]})
    return {"summary": (d.get("architect") or {}).get("summary") or g.get("description") or "", "steps": steps}


# ------------------------------------------------------------------------------------------------
# AIP Critic
# ------------------------------------------------------------------------------------------------

CRITIC_SYSTEM = """You are AIP Critic, reviewing a solution architecture diagram for a data and operations platform with these components:
{catalog}
Ground every answer in the diagram's nodes and connections (name them). Point out gaps (missing sources, ontology pieces, security, monitoring,
writeback, scheduling), risks and alternatives, and say which platform components would address them. Be concrete and concise; use Markdown lists.
Answer in the user's language."""


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    graph: Optional[dict] = None
    model: Optional[str] = None
    focus_node: Optional[str] = None


@router.get("/diagrams/{did}/critic")
def critic_state(did: str) -> dict:
    d = _get(did)
    _access(d)
    return {**(d.get("critic") or {"messages": [], "plan": None}), "sections": sections(d["graph"]), "suggested": _suggested(d["graph"])}


def _suggested(graph: dict) -> list[str]:
    secs = {s["id"] for s in sections(graph)}
    out = ["What are the potential bottlenecks in this architecture?", "Are there any missing components to consider?"]
    if "processing" in secs:
        out.append("How should data quality issues be handled in this design?")
    if "ontology" in secs:
        out.append("Is the ontology model right for the applications that use it?")
    if "apps" in secs:
        out.append("How do people's decisions get written back?")
    if "external" in secs or "sourcing" in secs:
        out.append("How often should each source sync, and what if it fails?")
    return out[:5]


@router.post("/diagrams/{did}/critic/ask")
def critic_ask(did: str, req: AskIn) -> dict:
    graph, call = _critic_call(did, req)
    return _critic_save(did, req, graph, _llm(*call))


@router.post("/diagrams/{did}/critic/ask/stream")
def critic_ask_stream(did: str, req: AskIn, request: Request) -> StreamingResponse:
    """The same as /critic/ask, streamed: "partial" events carry {answer, follow_ups, node_ids} as far as written;
    "result" is the critic state /critic/ask returns, saved the same way. A cancelled answer is not saved."""
    graph, call = _critic_call(did, req)
    return _sse(request, lambda emit, cancel, hold: _critic_save(did, req, graph, _llm_streamed(*call, emit, cancel, hold)))


def _critic_call(did: str, req: AskIn) -> tuple[dict, tuple]:
    d = _get(did)
    _access(d)  # viewers may ask; the conversation is saved with the diagram
    graph = _check_graph(req.graph) if req.graph and _can(d, "editor") else d["graph"]
    critic = d.get("critic") or {"messages": [], "plan": None}
    history = critic["messages"][-12:]
    convo = "\n".join(f"{'User' if m['role'] == 'user' else 'AIP Critic'}: {m['text'][:3000]}" for m in history)
    focus = ""
    if req.focus_node:
        n = next((n for n in graph["nodes"] if n["id"] == req.focus_node), None)
        if n:
            focus = f"\nThe question is about the node [{n['id']}] {n.get('title')}."
    schema = {"type": "object", "properties": {"answer": _STR, "follow_ups": {"type": "array", "items": _STR}, "node_ids": {"type": "array", "items": _STR}}, "required": ["answer", "follow_ups", "node_ids"]}
    user = (f"Diagram:\n{describe(graph)}\n\nConversation so far:\n{convo or '(none)'}\n{focus}\nQuestion: {req.question}\n\n"
            "Answer it (Markdown). follow_ups: 2 or 3 drill-down questions. node_ids: the ids of the nodes your answer is about.")
    return graph, (req.model, CRITIC_SYSTEM.format(catalog=_catalog_text()), user, schema, 6000)


def _critic_save(did: str, req: AskIn, graph: dict, out: Any) -> dict:
    ids = {n["id"] for n in graph["nodes"]}
    me = _me()
    with _lock:
        d = _get(did)
        critic = d.get("critic") or {"messages": [], "plan": None}
        critic["messages"].append({"role": "user", "text": req.question, "at": _now(), "by": me.get("display_name") or me.get("username")})
        critic["messages"].append({"role": "assistant", "text": out.get("answer") or "", "at": _now(), "follow_ups": (out.get("follow_ups") or [])[:3],
                                   "node_ids": [i for i in out.get("node_ids") or [] if i in ids]})
        critic["messages"] = critic["messages"][-200:]
        d["critic"] = critic
        _wr(_path(did), d)
    return critic_state(did)


@router.delete("/diagrams/{did}/critic")
def critic_clear(did: str) -> dict:
    d = _get(did)
    _access(d, "editor")
    _save_part(did, "critic", {"messages": [], "plan": (d.get("critic") or {}).get("plan")})
    return critic_state(did)


# ------------------------------------------------------------------------------------------------
# AIP Assist: questions about the component on a node's documentation card
# ------------------------------------------------------------------------------------------------

ASSIST_SYSTEM = """You are AIP Assist in Solution Designer. A user is reading the documentation card of a node on an architecture diagram
and asks about the platform component it represents. The platform's components:
{catalog}
Answer from the component's documentation and from how this diagram uses the node: what the component does, how to set it up
for this node, what it needs from its neighbours, its limits and the alternatives in the catalog. Be concrete and short; use
Markdown. Answer in the user's language."""


class AssistTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    text: str = Field(max_length=8000)


class AssistIn(BaseModel):
    node_id: str = Field(min_length=1, max_length=100)
    question: str = Field(min_length=1, max_length=4000)
    # the dialog's earlier turns (the conversation is not saved with the diagram)
    history: list[AssistTurn] = Field(default_factory=list, max_length=20)
    graph: Optional[dict] = None
    model: Optional[str] = None


def _node_component(n: dict) -> Optional[dict]:
    """The catalog component a node's documentation card shows (as the editor picks it)."""
    cid = n.get("component") or {"object_type": "object-type", "action_type": "action-type", "interface": "interface"}.get((n.get("resource") or {}).get("kind") or "")
    return COMPONENTS.get(cid or "")


def _assist_call(did: str, req: AssistIn) -> tuple:
    d = _get(did)
    _access(d)  # viewers read documentation cards too
    graph = _check_graph(req.graph) if req.graph and _can(d, "editor") else d["graph"]
    n = next((x for x in graph["nodes"] if x["id"] == req.node_id), None)
    if not n:
        raise HTTPException(404, "node not found")
    comp = _node_component(n)
    if not comp or n["kind"] in ("group", "text"):
        raise HTTPException(422, "this node has no documentation card")
    title = {x["id"]: x.get("title") or x["kind"] for x in graph["nodes"]}
    ins = [title.get(e["from"]) for e in graph["edges"] if e["to"] == n["id"]]
    outs = [title.get(e["to"]) for e in graph["edges"] if e["from"] == n["id"]]
    res = n.get("resource") or {}
    doc = (f"Component: {comp['name']} ({dict(CATEGORIES)[comp['category']]})\nDocumentation: {comp['description']}\n"
           f"Where it is built: {comp['href'] or 'outside the platform'}")
    node = (f"Node: {n.get('title') or comp['name']}{f' — {n['description'][:1500]}' if n.get('description') else ''}\n"
            f"Linked resource: {res.get('name') or res.get('id') or 'none'}\nReceives from: {', '.join(x for x in ins if x) or 'nothing'}\n"
            f"Sends to: {', '.join(x for x in outs if x) or 'nothing'}")
    if n["kind"] == "object":
        node += f"\nProposed properties: {', '.join(p.get('name', '') for p in (n.get('proposed') or {}).get('properties') or [])}"
    convo = "\n".join(f"{'User' if t.role == 'user' else 'AIP Assist'}: {t.text[:3000]}" for t in req.history[-12:])
    user = (f"{doc}\n\n{node}\n\nThe whole diagram:\n{describe(graph)}\n\nConversation so far:\n{convo or '(none)'}\n\nQuestion: {req.question}")
    return comp, (req.model, ASSIST_SYSTEM.format(catalog=_catalog_text()), user, None, 3000)


def _assist_result(comp: dict, req: AssistIn, out: Any) -> dict:
    return {"node_id": req.node_id, "component": comp["id"], "question": req.question, "answer": str(out or "").strip()}


@router.post("/diagrams/{did}/assist")
def assist(did: str, req: AssistIn) -> dict:
    """AIP Assist on a node's documentation card: answers questions about the component it represents, in this diagram."""
    comp, call = _assist_call(did, req)
    return _assist_result(comp, req, _llm(*call))


@router.post("/diagrams/{did}/assist/stream")
def assist_stream(did: str, req: AssistIn, request: Request) -> StreamingResponse:
    """The same as /assist, streamed: "partial" events carry the answer's text so far, "result" what /assist returns."""
    comp, call = _assist_call(did, req)
    return _sse(request, lambda emit, cancel, hold: _assist_result(comp, req, _llm_streamed(*call, emit, cancel, hold)))


class PlanIn(BaseModel):
    graph: Optional[dict] = None
    model: Optional[str] = None


@router.post("/diagrams/{did}/critic/plan")
def critic_plan(did: str, req: PlanIn) -> dict:
    """A structured implementation plan: phases of tasks with dependencies, best practices and effort."""
    d = _get(did)
    _access(d, "editor")
    graph = _check_graph(req.graph) if req.graph else d["graph"]
    task = {"type": "object", "properties": {"title": _STR, "component": _STR, "detail": _STR, "node_ids": {"type": "array", "items": _STR}}, "required": ["title", "component", "detail", "node_ids"]}
    schema = {"type": "object", "properties": {"title": _STR, "overview": _STR, "phases": {"type": "array", "items": {"type": "object", "properties": {
        "name": _STR, "goal": _STR, "depends_on": {"type": "array", "items": _STR}, "effort": {"type": "string", "enum": ["small", "medium", "large"]}, "estimate": _STR,
        "tasks": {"type": "array", "items": task}, "best_practices": {"type": "array", "items": _STR}},
        "required": ["name", "goal", "depends_on", "effort", "estimate", "tasks", "best_practices"]}}, "risks": {"type": "array", "items": _STR}},
        "required": ["title", "overview", "phases", "risks"]}
    user = (f"Diagram:\n{describe(graph)}\n\nWrite the implementation plan for this architecture: 3 to 7 phases in build order (depends_on names earlier phases), each with "
            "concrete tasks naming the platform component and the diagram nodes (node_ids) they build, best practices, the effort and a rough estimate (e.g. '3–5 days'). "
            "Add the main risks. Write in the language of the diagram's description and the conversation so far.")
    out = _llm(req.model, CRITIC_SYSTEM.format(catalog=_catalog_text()), user, schema, 10000)
    if not out.get("phases"):
        raise HTTPException(502, "the model returned no plan: try again")
    me = _me()
    plan = {**out, "generated_at": _now(), "by": me.get("display_name") or me.get("username"), "version": d["version"]}
    with _lock:
        d = _get(did)
        critic = d.get("critic") or {"messages": []}
        critic["plan"] = plan
        d["critic"] = critic
        _wr(_path(did), d)
    return plan


@router.get("/diagrams/{did}/critic/plan.pdf")
def plan_pdf(did: str) -> Response:
    """The implementation plan printed by headless Chrome (report_render.py) as the requesting user."""
    import report_render

    d = _get(did)
    _access(d)
    if not (d.get("critic") or {}).get("plan"):
        raise HTTPException(404, "generate an implementation plan first")
    try:
        pdf = report_render.render(f"/solution-designer/{did}/plan?embed=1&print=1", "pdf", _me().get("id"))
    except report_render.RenderError as e:
        raise HTTPException(503, str(e)) from None
    name = re.sub(r"[^A-Za-z0-9 _-]", "_", d.get("name") or did)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name} - implementation plan.pdf"'})


# ------------------------------------------------------------------------------------------------
# import a hand-drawn or whiteboard diagram (vision)
# ------------------------------------------------------------------------------------------------


@router.post("/diagrams/{did}/import-image")
async def import_image(did: str, file: UploadFile = File(...), model: Optional[str] = None) -> dict:
    import base64

    d = _get(did)
    _access(d, "editor")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "images up to 15 MB")
    mime = file.content_type or "image/png"
    if not mime.startswith("image/"):
        raise HTTPException(415, "upload an image (PNG, JPEG, WebP)")
    schema = {"type": "object", "properties": {
        "nodes": {"type": "array", "items": {"type": "object", "properties": {"key": _STR, "title": _STR, "component": {"type": "string", "enum": list(COMPONENTS)}, "note": _STR, "group": _STR},
                                             "required": ["key", "title", "component", "note", "group"]}},
        "edges": _EDGES, "notes": {"type": "array", "items": _STR}}, "required": ["nodes", "edges", "notes"]}
    user = ("This image is a hand-drawn or whiteboard architecture diagram. Read every box and arrow. For each box give its text as the title, the closest catalog component "
            "(custom when nothing fits), any extra text as the note, and the label of the enclosing frame as the group (empty when none). Edges follow the arrows (by key) with "
            "their labels. notes: free-standing text on the board.")
    out = _llm(model, ARCHITECT_SYSTEM.format(catalog=_catalog_text()), user, schema, 8000, f"data:{mime};base64,{base64.b64encode(data).decode()}")
    keys, nodes, groups = {}, [], {}
    for n in out.get("nodes") or []:
        node = {"id": _nid(), "kind": "component", "component": n.get("component") if n.get("component") in COMPONENTS else "custom", "title": n.get("title") or "",
                "description": n.get("note") or "", "tags": ["from-image"]}
        keys[n.get("key")] = node["id"]
        nodes.append(node)
        if (n.get("group") or "").strip():
            groups.setdefault(n["group"].strip(), []).append(node)
    edges = [{"id": f"e-{uuid.uuid4().hex[:8]}", "from": keys[e["from"]], "to": keys[e["to"]], "label": e.get("label") or ""} for e in out.get("edges") or [] if e.get("from") in keys and e.get("to") in keys]
    if not nodes:
        raise HTTPException(502, "no boxes were read from the image")
    layout(nodes, edges)
    for title, members in groups.items():
        xs, ys = [m["x"] for m in members], [m["y"] for m in members]
        g = {"id": _nid(), "kind": "group", "title": title, "x": min(xs) - 30, "y": min(ys) - 50, "w": max(xs) - min(xs) + 280, "h": max(ys) - min(ys) + 160, "tags": []}
        for m in members:
            m["parent"] = g["id"]
        nodes.insert(0, g)
    y = max(n["y"] for n in nodes) + 160
    for i, t in enumerate(out.get("notes") or []):
        nodes.append({"id": _nid(), "kind": "text", "title": t, "x": 80 + i * 300, "y": y, "tags": ["from-image"]})
    return {"nodes": nodes, "edges": edges}


# ------------------------------------------------------------------------------------------------
# proposed object types → real object types
# ------------------------------------------------------------------------------------------------

_SD_TYPES = {"string": "string", "integer": "integer", "double": "double", "boolean": "boolean", "date": "date", "timestamp": "timestamp", "geopoint": "geopoint"}


def _api_name(text: str, upper: bool) -> str:
    """An API name from a proposed name: letters, digits and underscores, starting with a letter."""
    words = re.findall(r"[A-Za-z0-9]+", text or "")
    if not words:
        return "Property" if upper else "property"
    if upper:
        name = "".join(w[:1].upper() + w[1:] for w in words)
    else:
        name = words[0][:1].lower() + words[0][1:] + "".join(w[:1].upper() + w[1:] for w in words[1:])
    return name if name[0].isalpha() else ("T" if upper else "p") + name


class CreateTypeIn(BaseModel):
    base_version: int
    display_name: Optional[str] = Field(None, max_length=200)


@router.post("/diagrams/{did}/nodes/{nid}/create-object-type")
def create_object_type(did: str, nid: str, req: CreateTypeIn) -> dict:
    """Create the object type a proposed (AIP Architect) node describes — its properties, primary key and title — and
    turn the node into a resource node linked to it (a new diagram version)."""
    import ontology

    d = _get(did)
    _access(d, "editor")
    node = next((n for n in d["graph"]["nodes"] if n["id"] == nid), None)
    if not node or node["kind"] != "object":
        raise HTTPException(404, "no proposed object type with that id on this diagram")
    if req.base_version != d["version"]:
        raise HTTPException(409, f"version {d['version']} was saved after you opened version {req.base_version}: reload")
    prop = node.get("proposed") or {}
    props, seen = [], set()
    for p in prop.get("properties") or []:
        api = _api_name(str(p.get("name") or ""), False)
        if api in seen:
            continue
        seen.add(api)
        props.append(ontology.Property(api_name=api, display_name=str(p.get("name") or api)[:200], type=_SD_TYPES.get(str(p.get("dataType") or "string"), "string"),
                                       description=str(p.get("description") or "")[:2000]))
    pk = _api_name(str(prop.get("primary_key") or ""), False) if prop.get("primary_key") else None
    if not pk or pk not in seen:
        pk = pk or "id"
        if pk not in seen:
            props.insert(0, ontology.Property(api_name=pk, display_name=str(prop.get("primary_key") or "ID"), type="string"))
            seen.add(pk)
    title = _api_name(str(prop.get("title_property") or ""), False) if prop.get("title_property") else None
    title = title if title in seen else pk
    name = (req.display_name or node.get("title") or "Object type").strip()
    t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=name, api_name=_api_name(name, True), description=(node.get("description") or "")[:2000] or None,
                                                          properties=props, primary_key=pk, title_property=title))
    graph = json.loads(json.dumps(d["graph"]))
    for n in graph["nodes"]:
        if n["id"] == nid:
            n.pop("proposed", None)
            n.update(kind="resource", title=t["display_name"], component="object-type", resource={"kind": "object_type", "id": t["id"], "name": t["display_name"]})
    out = save_diagram(did, SaveIn(graph=graph, base_version=d["version"], manual=True, description=f"Created the object type {t['display_name']}"))
    return {"object_type": {"id": t["id"], "display_name": t["display_name"], "api_name": t["api_name"]}, "diagram": out}


class CreateLinkIn(BaseModel):
    base_version: int
    # "auto": a foreign key for one-to-one / one-to-many when a property holds the other side's primary key, a join
    # table for many-to-many; "join_table" forces a many-to-many join table
    kind: Literal["auto", "join_table"] = "auto"
    foreign_key: Optional[str] = Field(None, max_length=100)


_LABEL_CARD = re.compile(r"^(.*?)\s*\((one-to-many|many-to-many|one-to-one)\)\s*$")


def _proposed_link(edge: dict) -> Optional[dict]:
    """The link an edge proposes: its `proposed` field, else a "name (cardinality)" label of an older data model."""
    if edge.get("proposed"):
        return edge["proposed"]
    m = _LABEL_CARD.match(edge.get("label") or "")
    return {"name": m.group(1).strip(), "cardinality": m.group(2)} if m else None


def _fk_candidates(holder: dict, referenced: dict, own_pk_ok: bool) -> list[str]:
    """Properties of `holder` that can hold `referenced`'s primary key: named like it (the key's name, or
    "<object type>_id") and of a matching key type."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", str(s or "").lower())  # noqa: E731
    want = {norm(referenced["primary_key"]) if norm(referenced["primary_key"]) not in ("id", "key") else None,
            norm(referenced["api_name"]) + "id", norm(referenced["display_name"]) + "id", norm(referenced["api_name"]) + "key"} - {None}
    pk_type = next((p["type"] for p in referenced["properties"] if p["api_name"] == referenced["primary_key"]), "string")
    out = []
    for p in holder["properties"]:
        if p["api_name"] == holder["primary_key"] and not own_pk_ok:
            continue
        if norm(p["api_name"]) in want and not p.get("array") and p["type"] in ("string", "integer", "long", "short", "byte") and (p["type"] == "string") == (pk_type == "string"):
            out.append(p["api_name"])
    return out


@router.post("/diagrams/{did}/edges/{edge_id}/create-link-type")
def create_link_type(did: str, edge_id: str, req: CreateLinkIn) -> dict:
    """Create the Ontology link type an AIP Architect connection proposes between two object type nodes (both linked to
    object types, e.g. after "Create this object type"), and record it on the connection (a new diagram version).
    One-to-many A→B: a foreign key on B holding A's primary key (many-to-one from B); one-to-one: a foreign key on
    either side; many-to-many (or `kind="join_table"`): a join table."""
    import ontology
    import ontology_model

    d = _get(did)
    _access(d, "editor")
    if req.base_version != d["version"]:
        raise HTTPException(409, f"version {d['version']} was saved after you opened version {req.base_version}: reload")
    edge = next((e for e in d["graph"]["edges"] if e["id"] == edge_id), None)
    if not edge:
        raise HTTPException(404, "no connection with that id on this diagram")
    if edge.get("link_type"):
        raise HTTPException(409, f"this connection already created the link type {edge['link_type'].get('name') or edge['link_type']['id']}")
    prop = _proposed_link(edge)
    if not prop:
        raise HTTPException(400, "this connection is not a proposed link type (no one-to-one, one-to-many or many-to-many)")
    nodes = {n["id"]: n for n in d["graph"]["nodes"]}
    ends = []
    for nid in (edge["from"], edge["to"]):
        res = (nodes.get(nid) or {}).get("resource") or {}
        if res.get("kind") != "object_type":
            title = (nodes.get(nid) or {}).get("title") or nid
            raise HTTPException(400, f'"{title}" is not linked to an object type yet: create or link its object type first')
        ends.append(ontology.get_object_type(res["id"]))
    a, b = ends
    name = (prop.get("name") or "").strip()
    card = prop["cardinality"]
    kind, fk, source, target = "join_table", None, a, b
    if card != "many-to-many" and req.kind == "auto":
        pairs = [(b, a)] if card == "one-to-many" else [(b, a), (a, b)]
        for holder, ref in pairs:
            if req.foreign_key:
                cands = [req.foreign_key] if any(p["api_name"] == req.foreign_key for p in holder["properties"]) else []
            else:
                cands = _fk_candidates(holder, ref, card == "one-to-one")
            if cands:
                kind, fk, source, target = "foreign_key", cands[0], holder, ref
                break
        if kind != "foreign_key":
            raise HTTPException(400, f"no property of {b['display_name']} holds {a['display_name']}'s primary key ({a['primary_key']}): add one (for example "
                                f"{_api_name(a['api_name'] + ' id', False)}) to {b['display_name']}, or create the link as a many-to-many join table")
    body = ontology_model.LinkTypeIn(display_name=name or None, description=f"Proposed by AIP Architect in the Solution Designer diagram {d['name']}"[:2000],
                                     kind=kind, cardinality=("one_to_one" if card == "one-to-one" else "many_to_one") if kind == "foreign_key" else "many_to_many",
                                     source=ontology_model.LinkSide(object_type_id=source["id"]), target=ontology_model.LinkSide(object_type_id=target["id"]),
                                     foreign_key=fk)
    lt = ontology_model.create_link_type(body)
    graph = json.loads(json.dumps(d["graph"]))
    for e in graph["edges"]:
        if e["id"] == edge_id:
            e["link_type"] = {"id": lt["id"], "name": lt["display_name"]}
    out = save_diagram(did, SaveIn(graph=graph, base_version=d["version"], manual=True, description=f"Created the link type {lt['display_name']}"))
    return {"link_type": {"id": lt["id"], "display_name": lt["display_name"], "kind": lt["kind"], "cardinality": lt["cardinality"], "foreign_key": lt.get("foreign_key"),
                          "source": lt["source"]["object_type_id"], "target": lt["target"]["object_type_id"]}, "diagram": out}
