"""Ontology design (Palantir's Ontology design docs: best practices, structural guidance, anti-patterns, validation).

* Design review: a linter over the ontology's object types, properties, link types, interfaces, action types and
  automations. Each finding names the anti-pattern or principle it violates (System Silos, The Kitchen Sink,
  Department Silos, The God Object, The Golden Hammer, Action Sprawl, The Time Machine, The Misnomer, Do not repeat
  yourself, Composition over deep hierarchies, normalization, documentation, links), the resource, why it matters
  and what to do. Findings can be dismissed with a reason (a pragmatic tradeoff); the design guidelines checklist
  is scored from the findings.
* Validation drills: task-based exercises built from real business questions (quiz-style game or timed
  drill-down; questions establish the situation, trace contributing factors or assess impact, with points).
  Sessions record each participant (builder, domain expert, new user, agent), the team, and per question whether
  they answered correctly, the time taken, whether they needed help, the path of object types and links, the
  terms searched and the symptoms observed. Results read like the doc's tables: success rate and median time per
  question and role, symptoms mapped to what to review, and people compared with agents. An agent run gives a
  language model the ontology's schema and lets it query the data step by step (searches with filters and links
  followed, aggregations; as the signed-in user, so it sees only what they may) until it answers; its path,
  searches and answer are recorded, and an answer matching the expected answer is judged correct. A "plan" run
  only plans a path from the schema.
* Team races (live drills): a judge starts a race with teams and an optional time limit; participants join (their
  browser then reports what they open in Object Explorer and object views: object types, links followed, searched
  terms), submit answers against the clock, and the judge marks them (an answer equal to the expected answer is
  marked correct automatically). The scoreboard counts each team's points; finishing the race turns every
  participant's answers, with their captured paths, times and searches, into drill sessions.
* Review history: each review of main or of a branch is snapshotted when its findings changed (score, counts,
  findings added and resolved since the previous snapshot); a branch's review lists the findings it introduces and
  resolves compared with main, and its snapshots carry the branch's proposal.
* Merge blocking (a setting, off by default): a proposal cannot merge while its branch introduces high-severity
  findings that main does not have (dismissing a finding lifts the block).

Stored in data/ontology/design/ (review.json: dismissals; history.json; drills/<id>.json).
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import re
import statistics
from collections import Counter, defaultdict
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
from ontology import _all, _lock, _new_id, _now, _read, _write

router = APIRouter(prefix="/api/ontology/design")

ANTI_PATTERNS = {
    "system_silos": "System Silos",
    "kitchen_sink": "The Kitchen Sink",
    "department_silos": "Department Silos",
    "god_object": "The God Object",
    "golden_hammer": "The Golden Hammer",
    "action_sprawl": "Action Sprawl",
    "time_machine": "The Time Machine",
    "misnomer": "The Misnomer",
    "dry": "Do not repeat yourself (rule of three)",
    "composition": "Composition over deep hierarchies",
    "normalization": "Normalization and derived properties",
    "documentation": "Document your decisions",
    "links": "Links and object-backed link types",
}

# the eight design guidelines and the findings that count against each
GUIDELINES = [
    ("model_reality", "Model reality, not systems", "Object types represent real-world entities, not source systems or departments.", ["system_silos", "department_silos"]),
    ("curate", "Curate intentionally", "Every property has clear business or technical value.", ["kitchen_sink", "normalization"]),
    ("collaborate", "Collaborate across teams", "Shared entities are modeled once, not per team.", ["department_silos", "dry"]),
    ("focused", "Keep object types focused", "Each object type represents one distinct entity.", ["god_object", "time_machine"]),
    ("right_tool", "Choose the right tool", "Action types for decisions, pipelines for transformations, automations for events.", ["golden_hammer", "action_sprawl"]),
    ("interfaces", "Use interfaces for abstraction", "Shared characteristics are modeled with interfaces, not wide, sparse types.", ["composition", "god_object", "dry"]),
    ("document", "Document your decisions", "Object types, properties and links have descriptions and clear names.", ["documentation", "misnomer", "links"]),
    ("validate", "Validate against real business questions", "Task-based drills confirm people and agents can navigate the ontology.", []),
]

GENERIC_TYPE_NAMES = {"data", "item", "items", "record", "records", "object", "objects", "entity", "entities", "thing", "things", "info",
                      "information", "misc", "general", "row", "rows", "table", "detail", "details", "stuff", "element", "node"}
GENERIC_PROPS = {"value", "type", "status", "date", "name", "quantity", "score", "amount", "number", "code", "flag", "data", "info", "count",
                 "category", "kind", "level", "time", "description2", "misc", "other"}
SYSTEM_WORDS = {"sap", "salesforce", "sfdc", "oracle", "workday", "servicenow", "netsuite", "dynamics", "legacy", "raw", "stg", "staging",
                "src", "source", "erp", "crm", "mes", "jira", "hubspot", "zendesk", "mainframe", "export", "import", "extract", "dump"}
DEPARTMENT_WORDS = {"sales", "finance", "marketing", "hr", "ops", "operations", "support", "engineering", "legal", "procurement", "logistics",
                    "accounting", "manufacturing", "quality", "maintenance", "service"}
ETL_PATTERNS = [r"^_", r"etl", r"ingest", r"load(ed)?_?(ts|time|date|at)$", r"batch_?id", r"source_?file", r"row_?(hash|num|number|id)$",
                r"^sys_", r"pipeline", r"checksum", r"^dw_", r"^meta_", r"_?partition", r"^__", r"record_?source", r"lineage", r"job_?id",
                r"run_?id", r"inserted_?(at|by|ts)", r"update_?ts$", r"^src_", r"kafka_(offset|partition)", r"_?file_?name$"]
TIME_MACHINE = re.compile(r"^(version|revision|rev|is_?current|is_?latest|current_?flag|is_?active_?version|snapshot_?(date|id)|valid_?(from|to)|effective_?(from|to)|superseded_?by|previous_?version)$", re.I)
ENCODED = re.compile(r"^(dt|str|int|n|txt|num|lng|dbl|bln|ts)[A-Z_]|[A-Za-z]+\d{2,}$|^(field|col|column|attr|attribute|var|x|tmp|temp|test)[_\d]*\w?$")
GENERIC_LINK = re.compile(r"^(related|relatedTo|relatedItems?|relations?|links?|link\d*|ref|reference|refs|assoc|association|connected|other|items?)\d*$", re.I)
COUNT_PROP = re.compile(r"^(num|number_?of|n|count_?of|total)[A-Z_]?\w*|\w*(Count|_count)$")
DATE_STYLES = {"suffix": re.compile(r"^[a-z]\w*Date$"), "prefix": re.compile(r"^dateOf[A-Z]\w*$"), "at": re.compile(r"^[a-z]\w*(At|_at)$"),
               "on": re.compile(r"^[a-z]\w*(On|_on)$"), "ts": re.compile(r"\w*(Timestamp|Ts|_ts)$")}

DIR = ontology.DIR
# the branch whose version of the ontology is reviewed (ontology_branches.view), or None for main
_BRANCH: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("design_branch", default=None)
HISTORY_KEPT = 500


def _res(folder: str) -> list[dict]:
    b = _BRANCH.get()
    if b is not None:
        import ontology_branches
        import ontology_model as om

        kind = next((k for k, v in om.FOLDER.items() if v == folder), None)
        if kind:
            return ontology_branches.view(b, kind)
    return _all(folder)


def configure() -> None:
    global DIR
    DIR = ontology.DIR / "design"
    (DIR / "drills").mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS["design_blocking"] = blocking_findings


def _settings() -> dict:
    return {"block_merge_on_high": False, **(_read(DIR / "settings.json", {}) or {})}


def blocking_findings(b: dict) -> list[dict]:
    """With merge blocking on: the high-severity findings the branch introduces (not on main, not dismissed)."""
    if not _settings()["block_merge_on_high"]:
        return []
    oid = b.get("ontology_id") or None
    main_ids = {f["id"] for f in _review(oid)["findings"] if not f["dismissed"]}
    token = _BRANCH.set(b)
    try:
        findings = _review(oid)["findings"]
    finally:
        _BRANCH.reset(token)
    return [{"id": f["id"], "label": _label(f), "anti_pattern": f["anti_pattern"]} for f in findings
            if f["severity"] == "high" and not f["dismissed"] and f["id"] not in main_ids]


def _words(name: str) -> list[str]:
    parts = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name or "")
    return [w.lower() for w in re.split(r"[^A-Za-z0-9]+", parts) if w]


def _fid(rule: str, *keys: str) -> str:
    return hashlib.sha1("|".join((rule, *keys)).encode()).hexdigest()[:12]


def _finding(rule: str, severity: str, kind: str, rid: str, name: str, message: str, suggestion: str, *keys: str, extra: Optional[dict] = None) -> dict:
    return {"id": _fid(rule, kind, rid, *keys), "rule": rule, "anti_pattern": ANTI_PATTERNS[rule], "severity": severity, "resource_kind": kind,
            "resource_id": rid, "resource_name": name, "message": message, "suggestion": suggestion, **(extra or {})}


def _visible_types(ontology_id: Optional[str]) -> list[dict]:
    out = []
    for t in _res("object-types"):
        if ontology_id and t.get("ontology_id", "default") != ontology_id:
            continue
        try:
            # an object type created on the branch has no markings on main yet
            if _BRANCH.get() is None or ontology._read(ontology._path("object-types", t["id"])):
                auth.check_resource("object_type", t["id"])
        except HTTPException:
            continue
        out.append(t)
    return out


def _null_rates(t: dict, sample: int = 2000) -> tuple[int, dict[str, float]]:
    """(objects sampled, share of objects where each property is empty)."""
    objs = list(ontology.load_objects(t["id"]).values())[:sample]
    if not objs:
        return 0, {}
    rates = {}
    for p in t["properties"]:
        if p.get("derived"):
            continue
        empty = sum(1 for o in objs if (o.get("properties") or {}).get(p["api_name"]) in (None, "", []))
        rates[p["api_name"]] = empty / len(objs)
    return len(objs), rates


def review(ontology_id: Optional[str] = None) -> list[dict]:
    types = _visible_types(ontology_id)
    tids = {t["id"] for t in types}
    links = [lt for lt in _res("link-types") if lt["source"]["object_type_id"] in tids or lt["target"]["object_type_id"] in tids]
    actions = [a for a in _res("action-types") if a.get("object_type_id") in tids]
    ifaces = [i for i in _res("interfaces") if not ontology_id or i.get("ontology_id", "default") == ontology_id]
    autos = [a for a in _res("automations")]
    out: list[dict] = []
    # ---------------------------------------------------------------- object types: names, documentation, size
    for t in types:
        name, api = t["display_name"], t["api_name"]
        words = _words(api)
        if name.strip().lower() in GENERIC_TYPE_NAMES or api.lower() in GENERIC_TYPE_NAMES:
            out.append(_finding("misnomer", "high", "object_type", t["id"], name, f"“{name}” is a generic name that a domain expert would not recognize as an entity.",
                                "Use a singular, concrete noun from the business (Product, WorkOrder, FlightSegment)."))
        elif len(words) == 1 and words[0].endswith("s") and not words[0].endswith("ss") and len(words[0]) > 3:
            out.append(_finding("misnomer", "low", "object_type", t["id"], name, f"“{name}” looks plural; object types name one entity.",
                                f"Rename to the singular (for example {name[:-1]}) and use the plural display name for lists."))
        sys_hits = [w for w in words if w in SYSTEM_WORDS]
        if sys_hits:
            out.append(_finding("system_silos", "high", "object_type", t["id"], name, f"The name mentions a source system or stage ({', '.join(sys_hits)}): the type likely mirrors a system, not a domain entity.",
                                "Merge the systems' data in a pipeline into one object type named for the real-world entity; keep the source as a property if needed."))
        dept_hits = [w for w in words if w in DEPARTMENT_WORDS]
        if dept_hits and len(words) > 1:
            out.append(_finding("department_silos", "medium", "object_type", t["id"], name, f"The name is qualified by a department ({', '.join(dept_hits)}).",
                                "Model the shared entity once; put department-specific data in properties or linked object types."))
        if not re.match(r"^[A-Z][A-Za-z0-9]*$", api):
            out.append(_finding("misnomer", "low", "object_type", t["id"], name, f"The API name “{api}” is not PascalCase.",
                                "Object type API names are PascalCase (WorkOrder); fix it while the type is experimental.", "case"))
        snake = [p["api_name"] for p in t["properties"] if not re.match(r"^[a-z][A-Za-z0-9]*$", p["api_name"])]
        if snake:
            out.append(_finding("misnomer", "low", "object_type", t["id"], name, f"{len(snake)} property API names are not camelCase ({', '.join(snake[:5])}).",
                                "Property API names are camelCase (lastInspectionDate); source column names belong in the dataset.", "case"))
        if not (t.get("description") or "").strip():
            out.append(_finding("documentation", "low", "object_type", t["id"], name, "The object type has no description.",
                                "Describe what one object represents, its source and its grain, so people and agents can pick the right starting point."))
        props = t["properties"]
        undocumented = [p for p in props if not (p.get("description") or "").strip() and p["api_name"] != t.get("primary_key")]
        if len(props) >= 4 and len(undocumented) / len(props) > 0.5:
            out.append(_finding("documentation", "low", "object_type", t["id"], name, f"{len(undocumented)} of {len(props)} properties have no description.",
                                "Document the properties whose meaning, unit or source is not self-evident."))
        # ------------------------------------------------------------ properties
        dates: dict[str, list[str]] = defaultdict(list)
        for p in props:
            pn = p["api_name"]
            if pn.lower() in GENERIC_PROPS and pn != t.get("title_property"):
                out.append(_finding("misnomer", "medium", "property", t["id"], f"{name}.{pn}", f"“{pn}” is a single generic word; its meaning depends on context.",
                                    "Qualify it (monetaryValue, quantityOnHand, riskScore, inspectionStatus).", pn))
            if ENCODED.search(pn):
                out.append(_finding("misnomer", "medium", "property", t["id"], f"{name}.{pn}", f"“{pn}” encodes type information or a source-system code.",
                                    "Use a concise, self-evident business name (lastInspectionDate rather than dtLastInspMod).", pn))
            if any(re.search(rx, pn, re.I) for rx in ETL_PATTERNS):
                out.append(_finding("kitchen_sink", "medium", "property", t["id"], f"{name}.{pn}", f"“{pn}” looks like ETL or technical metadata.",
                                    "Exclude pipeline metadata from the object type unless users need it; keep it in the dataset.", pn))
            if TIME_MACHINE.match(pn):
                out.append(_finding("time_machine", "high", "property", t["id"], f"{name}.{pn}", f"“{pn}” suggests historical versions are stored as separate objects.",
                                    "Keep one object per entity; link history or amendment objects, or use time series properties for changing values.", pn))
            if p.get("type") in ("date", "timestamp"):
                for style, rx in DATE_STYLES.items():
                    if rx.match(pn):
                        dates[style].append(pn)
                        break
            if COUNT_PROP.match(pn) and p.get("type") in ("integer", "long", "short") and not p.get("derived"):
                linked = [lt for lt in links if t["id"] in (lt["source"]["object_type_id"], lt["target"]["object_type_id"])]
                if linked:
                    out.append(_finding("normalization", "medium", "property", t["id"], f"{name}.{pn}", f"“{pn}” is a manually maintained count while {name} has link types.",
                                        "Compute it as a derived property (count over a link type) so it never goes stale.", pn))
        if len(dates) > 1:
            style_list = "; ".join(f"{k}: {', '.join(v)}" for k, v in dates.items())
            out.append(_finding("misnomer", "low", "object_type", t["id"], name, f"Date properties follow different conventions ({style_list}).",
                                "Follow one convention across the ontology (createdDate, updatedDate, effectiveDate).", "dates"))
        # ------------------------------------------------------------ the God Object
        n, rates = _null_rates(t)
        discriminator = next((p["api_name"] for p in props if p["api_name"].lower() in ("type", "kind", "category", "subtype", "record_type", "recordtype", "objecttype", "entitytype")), None)
        sparse = [k for k, r in rates.items() if r >= 0.6]
        if (len(props) >= 8 and n >= 10 and len(sparse) / max(1, len(rates)) >= 0.4) or len(props) > 80:
            msg = f"{len(sparse)} of {len(rates)} properties are empty on most objects" if sparse else f"{len(props)} properties"
            if discriminator:
                msg += f", and “{discriminator}” says what kind of {name} each object is"
            out.append(_finding("god_object", "high" if discriminator else "medium", "object_type", t["id"], name, f"{msg}: the type may represent several distinct entities.",
                                "Split it into distinct object types and model the shared characteristics with an interface.", extra={"sparse": sparse[:20]}))
        # ------------------------------------------------------------ Action Sprawl
        acts = [a for a in actions if a.get("object_type_id") == t["id"]]
        if len(acts) > 10:
            out.append(_finding("action_sprawl", "medium", "object_type", t["id"], name, f"{len(acts)} action types act on {name}.",
                                "Design actions around business operations that bundle related changes (Approve claim, Schedule inspection)."))
        for a in acts:
            n_props = 0
            if a.get("kind") == "modify":
                n_props = sum(1 for prm in a.get("parameters") or [] if prm.get("property"))
            elif a.get("kind") == "rules":
                n_props = sum(len(r.get("values") or r.get("properties") or {}) for r in a.get("rules") or [] if r.get("kind") == "modify_object")
            if re.match(r"^(set|update|change|edit)\s", a["display_name"], re.I) and n_props <= 1 and a.get("kind") in ("modify", "rules"):
                out.append(_finding("action_sprawl", "low", "action_type", a["id"], a["display_name"], f"“{a['display_name']}” changes a single property, CRUD-style.",
                                    "Fold it into the business operation it is part of, or use an inline edit on the property."))
    # ---------------------------------------------------------------- duplicated shapes: Department Silos / DRY
    sigs = {t["id"]: {(p["api_name"].lower(), p.get("type")) for p in t["properties"] if p["api_name"] != t.get("primary_key")} for t in types}
    impl = {t["id"]: {i["interface_id"] for i in t.get("implements") or []} for t in types}
    for i, a in enumerate(types):
        for b in types[i + 1:]:
            sa, sb = sigs[a["id"]], sigs[b["id"]]
            if len(sa) < 4 or len(sb) < 4:
                continue
            jac = len(sa & sb) / len(sa | sb)
            if jac >= 0.6 and not (impl[a["id"]] & impl[b["id"]]):
                rule = "department_silos" if jac >= 0.85 else "dry"
                out.append(_finding(rule, "high" if jac >= 0.85 else "medium", "object_type", a["id"], f"{a['display_name']} / {b['display_name']}",
                                    f"{a['display_name']} and {b['display_name']} share {round(jac * 100)}% of their properties.",
                                    "Model one shared object type (use properties or links for team-specific data), or an interface for what they truly share.",
                                    b["id"], extra={"related_id": b["id"]}))
    shared_cols: dict[tuple, list[str]] = defaultdict(list)
    for t in types:
        for p in t["properties"]:
            if not p.get("shared_property_id") and p["api_name"] != t.get("primary_key") and p["api_name"].lower() not in ("title", "name", "description"):
                shared_cols[(p["api_name"].lower(), p.get("type"))].append(t["id"])
    triples: dict[frozenset, list[str]] = defaultdict(list)
    for key, ts in shared_cols.items():
        if len(ts) >= 3:
            triples[frozenset(ts)].append(key[0])
    for ts, cols in triples.items():
        if len(cols) >= 3 and not set.intersection(*(impl[x] for x in ts)):
            names = ", ".join(t["display_name"] for t in types if t["id"] in ts)
            out.append(_finding("dry", "medium", "object_type", sorted(ts)[0], names, f"{len(ts)} object types repeat the properties {', '.join(sorted(cols)[:6])}.",
                                "You built it three times: define an interface (with shared properties) and have the types implement it.", *sorted(ts)))
    # ---------------------------------------------------------------- normalization: copied values across links
    by_id = {t["id"]: t for t in types}
    for lt in links:
        s, g = by_id.get(lt["source"]["object_type_id"]), by_id.get(lt["target"]["object_type_id"])
        if not s or not g or s["id"] == g["id"]:
            continue
        common = {p["api_name"] for p in s["properties"] if not p.get("derived")} & {p["api_name"] for p in g["properties"] if not p.get("derived")}
        common -= {s.get("primary_key"), g.get("primary_key"), lt.get("foreign_key"), "title", "name", "description", "status", "createdDate", "updatedDate"}
        common = {c for c in common if not c.lower().endswith("id")}
        if common:
            out.append(_finding("normalization", "low", "link_type", lt["id"], lt["display_name"], f"{s['display_name']} and {g['display_name']} both store {', '.join(sorted(common)[:5])}.",
                                "Store each fact once; derive it across the link (derived property) instead of copying it.", *sorted(common)))
    # ---------------------------------------------------------------- links
    for lt in links:
        for side in ("source", "target"):
            api = lt[side].get("api_name") or ""
            if GENERIC_LINK.match(api):
                out.append(_finding("links", "medium", "link_type", lt["id"], lt["display_name"], f"The link side “{api}” does not say what the relationship is.",
                                    "Name links by relationship from each side (department / employees).", side))
        if lt["source"].get("api_name") and lt["source"].get("api_name") == lt["target"].get("api_name"):
            out.append(_finding("links", "low", "link_type", lt["id"], lt["display_name"], "Both sides of the link have the same API name, so it cannot read naturally from each direction.",
                                "Name each side from its object's perspective (supervisor / directReports).", "same"))
    # ---------------------------------------------------------------- interfaces: deep hierarchies
    iface_by = {i["id"]: i for i in _res("interfaces")}

    def depth(i: dict, seen: frozenset = frozenset()) -> int:
        if i["id"] in seen:
            return 0
        parents = [iface_by[p] for p in i.get("extends") or [] if p in iface_by]
        return 1 + max((depth(p, seen | {i["id"]}) for p in parents), default=0)

    for i in ifaces:
        d = depth(i)
        if d > 3:
            out.append(_finding("composition", "medium", "interface", i["id"], i["display_name"], f"{i['display_name']} sits {d} levels deep in an extension chain.",
                                "Favor composing several small capability interfaces over deep single-inheritance chains."))
        if not (i.get("description") or "").strip():
            out.append(_finding("documentation", "low", "interface", i["id"], i["display_name"], "The interface has no description.", "Describe the shape or capability it stands for."))
    for t in types:
        w = _words(t["api_name"])
        if len(w) >= 2 and w[0].endswith("able") and len(t.get("implements") or []) == 0:
            out.append(_finding("composition", "low", "object_type", t["id"], t["display_name"], f"“{t['display_name']}” reads like a combination type ({w[0]} + {' '.join(w[1:])}).",
                                f"Model “{w[0]}” as a capability interface the entity type implements."))
    # ---------------------------------------------------------------- Golden Hammer: actions or functions doing pipeline work
    for a in autos:
        c, e = a.get("condition") or {}, a.get("effect") or {}
        if c.get("kind") == "schedule" and (c.get("every_minutes") or 999) <= 15 and e.get("kind") in ("action", "logic", "function"):
            out.append(_finding("golden_hammer", "medium", "automation", a["id"], a.get("name", a["id"]),
                                f"Runs an {e.get('kind')} every {c.get('every_minutes')} minutes on a schedule: that is data processing.",
                                "Use a batch or streaming pipeline for recurring transformations; keep automations for event-driven reactions."))
    return out


def _dismissed() -> dict:
    return _read(DIR / "review.json", {}) or {}


@router.get("/review")
def get_review(ontology_id: Optional[str] = None, branch_id: Optional[str] = None) -> dict:
    """The review of main, or of a branch (with the findings it introduces and resolves compared with main). Either
    is snapshotted into the history when its findings changed."""
    if not branch_id:
        out = _review(ontology_id)
        _snapshot(out, ontology_id, None)
        return {**out, "settings": _settings()}
    import ontology_branches

    with _lock:
        b = ontology_branches._branch(branch_id)
    main_ids = {f["id"] for f in _review(ontology_id)["findings"] if not f["dismissed"]}
    token = _BRANCH.set(b)
    try:
        out = _review(ontology_id)
    finally:
        _BRANCH.reset(token)
    active = {f["id"] for f in out["findings"] if not f["dismissed"]}
    for f in out["findings"]:
        f["new_on_branch"] = f["id"] not in main_ids
    out["vs_main"] = {"new": sorted(active - main_ids), "resolved": sorted(main_ids - active)}
    out["branch"] = {"id": b["id"], "name": b.get("name"), "proposal_id": (b.get("proposal") or {}).get("id")}
    _snapshot(out, ontology_id, b)
    return {**out, "settings": _settings()}


class SettingsIn(BaseModel):
    block_merge_on_high: bool


@router.put("/settings")
def put_settings(req: SettingsIn) -> dict:
    """Review settings (ontology owners): block merging proposals that introduce high-severity findings."""
    import ontology_model as om

    om.require_role(None, "owner", what="change the design review settings")
    with _lock:
        _write(DIR / "settings.json", {**_settings(), **req.model_dump()})
    return _settings()


def _label(f: dict) -> str:
    return f"{f['anti_pattern']}: {f['resource_name']}"


def _snapshot(out: dict, ontology_id: Optional[str], b: Optional[dict]) -> None:
    active = {f["id"]: f for f in out["findings"] if not f["dismissed"]}
    key = (ontology_id or None, b["id"] if b else None)
    with _lock:
        hist = _read(DIR / "history.json", []) or []
        prev = next((h for h in reversed(hist) if (h.get("ontology_id"), h.get("branch_id")) == key), None)
        if prev is not None and set(prev["ids"]) == set(active) and prev["score"] == out["score"]:
            return
        prev_ids = set(prev["ids"]) if prev else set()
        prev_labels = (prev or {}).get("labels") or {}
        sev = Counter(f["severity"] for f in active.values())
        hist.append({"at": _now(), "ontology_id": key[0], "branch_id": key[1], "branch_name": b.get("name") if b else None,
                     "proposal_id": (b.get("proposal") or {}).get("id") if b else None, "score": out["score"], "active": len(active),
                     "by_severity": {k: sev.get(k, 0) for k in ("high", "medium", "low")}, "ids": sorted(active),
                     "labels": {i: _label(f) for i, f in active.items()},
                     "added": [{"id": i, "label": _label(active[i])} for i in sorted(set(active) - prev_ids)] if prev else [],
                     "resolved": [{"id": i, "label": prev_labels.get(i, i)} for i in sorted(prev_ids - set(active))]})
        _write(DIR / "history.json", hist[-HISTORY_KEPT:])


@router.get("/review/history")
def review_history(ontology_id: Optional[str] = None, branch_id: Optional[str] = None, limit: int = 50) -> list[dict]:
    """Snapshots of the review (newest first) for main or one branch: score, counts, findings added and resolved."""
    hist = _read(DIR / "history.json", []) or []
    rows = [h for h in hist if h.get("ontology_id") == (ontology_id or None) and h.get("branch_id") == (branch_id or None)]
    return [{k: v for k, v in h.items() if k not in ("ids", "labels")} for h in reversed(rows[-max(1, min(limit, HISTORY_KEPT)):])]


def _review(ontology_id: Optional[str]) -> dict:
    with _lock:
        findings = review(ontology_id)
        dis = _dismissed()
    for f in findings:
        d = dis.get(f["id"])
        f["dismissed"] = d
    active = [f for f in findings if not f["dismissed"]]
    weight = {"high": 10, "medium": 4, "low": 1}
    n_types = max(1, len(_visible_types(ontology_id)))
    penalty = sum(weight[f["severity"]] for f in active)
    score = round(100 * 10 * n_types / (10 * n_types + penalty))
    drills = list_drills()
    guidelines = []
    for gid, title, desc, rules in GUIDELINES:
        hits = [f for f in active if f["rule"] in rules]
        if gid == "validate":
            ran = sum(d["sessions"] for d in drills)
            status = "pass" if ran else "todo"
            note = f"{ran} drill sessions recorded" if ran else "No validation drills yet"
        else:
            sev = {f["severity"] for f in hits}
            status = "fail" if "high" in sev else "warn" if hits else "pass"
            note = f"{len(hits)} findings" if hits else "No findings"
        guidelines.append({"id": gid, "title": title, "description": desc, "rules": rules, "status": status, "note": note})
    by_rule = Counter(f["rule"] for f in active)
    return {"score": score, "findings": findings, "guidelines": guidelines, "by_rule": by_rule, "anti_patterns": ANTI_PATTERNS,
            "checked": {"object_types": n_types, "at": _now()}}


class DismissIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


@router.post("/review/{fid}/dismiss")
def dismiss(fid: str, req: DismissIn) -> dict:
    with _lock:
        d = _dismissed()
        d[fid] = {"reason": req.reason.strip(), "by": (auth.current() or {}).get("username") or "local", "at": _now()}
        _write(DIR / "review.json", d)
        return d[fid]


@router.delete("/review/{fid}/dismiss")
def undismiss(fid: str) -> dict:
    with _lock:
        d = _dismissed()
        d.pop(fid, None)
        _write(DIR / "review.json", d)
        return {"restored": fid}


# ------------------------------------------------------------------------------------------------
# validation drills
# ------------------------------------------------------------------------------------------------

SYMPTOMS = {
    "no_start": ("Could not identify a starting object type", "Unclear names, insufficient aliases, too many visible types, or missing descriptions", "misnomer"),
    "different_types": ("Chose different object types for the same concept", "Duplicate, overlapping, or insufficiently differentiated concepts", "department_silos"),
    "cannot_traverse": ("Could not move between related concepts", "A missing, misnamed, incorrectly directed, or unavailable link", "links"),
    "manual_join": ("Exported data or built a manual join", "A meaningful relationship or reusable analytical concept the ontology does not represent", "links"),
    "inconsistent": ("Reasonable paths gave different answers", "Unclear levels of detail, or ambiguous identities, units, dates or aggregation logic", "misnomer"),
    "builders_only": ("Only builders or technical users succeeded", "Source-system terminology, hidden conventions, or insufficient documentation", "system_silos"),
    "slow": ("A reasonable path was consistently slow", "Query, indexing, data volume or modeling performance constraints", "normalization"),
    "no_path": ("No reasonable path could answer the question", "Missing data, a domain coverage gap, or an unsupported analytical operation", None),
}
ROLES = ("builder", "domain_expert", "new_user", "agent")


class QuestionIn(BaseModel):
    id: Optional[str] = None
    text: str = Field(min_length=1, max_length=2000)
    step: Literal["situation", "factors", "impact"] = "situation"
    points: int = Field(1, ge=1, le=100)
    expected_answer: str = Field("", max_length=2000)
    source: str = Field("", max_length=500)  # where the question came from (a leader's recurring ask, a report…)


class DrillIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    format: Literal["quiz", "drilldown"] = "quiz"
    time_limit_minutes: Optional[int] = Field(None, ge=1, le=600)
    allowed_apps: list[str] = ["Object Explorer", "Quiver"]
    questions: list[QuestionIn] = []
    ontology_id: Optional[str] = None


class AnswerIn(BaseModel):
    question_id: str
    correct: Optional[bool] = None
    seconds: Optional[int] = Field(None, ge=0)
    assisted: bool = False
    path: list[str] = []  # object types and links followed
    searched: list[str] = []  # terms the participant searched
    symptoms: list[str] = []
    expected: str = Field("", max_length=1000)  # what the participant expected to find when confused
    notes: str = Field("", max_length=4000)
    answer: str = Field("", max_length=4000)


class SessionIn(BaseModel):
    participant: str = Field(min_length=1, max_length=200)
    role: Literal["builder", "domain_expert", "new_user", "agent"] = "new_user"
    team: str = Field("", max_length=200)
    assisted_format: Literal["individual", "team"] = "individual"
    answers: list[AnswerIn] = []


def _drill_path(did: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", did):
        raise HTTPException(404, "drill not found")
    return DIR / "drills" / f"{did}.json"


def _drill(did: str) -> dict:
    d = _read(_drill_path(did))
    if not d:
        raise HTTPException(404, "drill not found")
    return d


def _questions(qs: list[QuestionIn]) -> list[dict]:
    out = []
    for q in qs:
        out.append({**q.model_dump(), "id": q.id or _new_id("q")})
    return out


def list_drills() -> list[dict]:
    out = []
    for p in sorted((DIR / "drills").glob("*.json")):
        d = _read(p) or {}
        if d:
            out.append({k: d[k] for k in ("id", "name", "description", "format", "created_at", "updated_at")} | {"questions": len(d["questions"]), "sessions": len(d["sessions"])})
    return sorted(out, key=lambda d: d["created_at"], reverse=True)


@router.get("/drills")
def drills_route() -> list[dict]:
    return list_drills()


@router.post("/drills")
def create_drill(req: DrillIn) -> dict:
    with _lock:
        d = {**req.model_dump(exclude={"questions"}), "id": _new_id("drill"), "questions": _questions(req.questions), "sessions": [],
             "created_by": (auth.current() or {}).get("username") or "local", "created_at": _now(), "updated_at": _now()}
        _write(_drill_path(d["id"]), d)
        return d


@router.get("/drills/{did}")
def get_drill(did: str) -> dict:
    d = _drill(did)
    return {**d, "results": results(d)}


@router.put("/drills/{did}")
def update_drill(did: str, req: DrillIn) -> dict:
    with _lock:
        d = _drill(did)
        d.update(req.model_dump(exclude={"questions"}), questions=_questions(req.questions), updated_at=_now())
        _write(_drill_path(did), d)
        return {**d, "results": results(d)}


@router.delete("/drills/{did}")
def delete_drill(did: str) -> dict:
    with _lock:
        _drill(did)
        _drill_path(did).unlink(missing_ok=True)
        return {"deleted": did}


def _check_answers(d: dict, answers: list[AnswerIn]) -> list[dict]:
    qids = {q["id"] for q in d["questions"]}
    out = []
    for a in answers:
        if a.question_id not in qids:
            raise HTTPException(400, f"unknown question {a.question_id}")
        bad = [s for s in a.symptoms if s not in SYMPTOMS]
        if bad:
            raise HTTPException(400, f"unknown symptom {bad[0]}")
        out.append(a.model_dump())
    return out


@router.post("/drills/{did}/sessions")
def add_session(did: str, req: SessionIn) -> dict:
    with _lock:
        d = _drill(did)
        s = {**req.model_dump(exclude={"answers"}), "id": _new_id("sess"), "answers": _check_answers(d, req.answers), "at": _now()}
        d["sessions"].append(s)
        d["updated_at"] = _now()
        _write(_drill_path(did), d)
        return {**d, "results": results(d)}


@router.put("/drills/{did}/sessions/{sid}")
def update_session(did: str, sid: str, req: SessionIn) -> dict:
    with _lock:
        d = _drill(did)
        s = next((x for x in d["sessions"] if x["id"] == sid), None)
        if not s:
            raise HTTPException(404, "session not found")
        s.update(req.model_dump(exclude={"answers"}), answers=_check_answers(d, req.answers))
        d["updated_at"] = _now()
        _write(_drill_path(did), d)
        return {**d, "results": results(d)}


@router.delete("/drills/{did}/sessions/{sid}")
def delete_session(did: str, sid: str) -> dict:
    with _lock:
        d = _drill(did)
        d["sessions"] = [x for x in d["sessions"] if x["id"] != sid]
        _write(_drill_path(did), d)
        return {**d, "results": results(d)}


# ------------------------------------------------------------------------------------------------
# team races: live drills with path capture
# ------------------------------------------------------------------------------------------------

RACES_KEPT = 20


class RaceIn(BaseModel):
    teams: list[str] = Field(default_factory=list, max_length=20)
    time_limit_minutes: Optional[int] = Field(None, ge=1, le=600)


class JoinIn(BaseModel):
    participant: str = Field(min_length=1, max_length=200)
    team: str = Field("", max_length=200)
    role: Literal["builder", "domain_expert", "new_user"] = "new_user"


class CaptureIn(BaseModel):
    drill_id: str
    race_id: str
    participant: str
    object_type_id: Optional[str] = None
    link_type_ids: list[str] = []
    q: str = Field("", max_length=500)
    primary_key: Optional[str] = None


class RaceAnswerIn(BaseModel):
    participant: str
    question_id: str
    answer: str = Field("", max_length=4000)


class JudgeIn(BaseModel):
    submission_id: str
    correct: Optional[bool] = None


def _norm(x: str) -> str:
    return re.sub(r"[\s.,;:!?'\"]+", " ", (x or "").lower()).strip()


def _race(d: dict, race_id: Optional[str] = None) -> dict:
    r = d.get("race")
    if not r or (race_id and r["id"] != race_id):
        raise HTTPException(404, "no race is running for this drill")
    return r


def _elapsed(r: dict) -> int:
    from datetime import datetime

    return max(0, int((datetime.fromisoformat(_now()) - datetime.fromisoformat(r["started_at"])).total_seconds()))


def _time_up(r: dict) -> bool:
    return bool(r.get("time_limit_minutes")) and _elapsed(r) >= r["time_limit_minutes"] * 60


def _race_view(d: dict) -> Optional[dict]:
    r = d.get("race")
    if not r:
        return None
    pts = {q["id"]: q["points"] for q in d["questions"]}
    teams: dict[str, dict] = {t: {"team": t, "points": 0, "correct": 0, "answers": 0} for t in r["teams"]}
    scored: set[tuple[str, str]] = set()
    for sub in r["submissions"]:
        row = teams.setdefault(sub["team"], {"team": sub["team"], "points": 0, "correct": 0, "answers": 0})
        row["answers"] += 1
        if sub["correct"] and (sub["team"], sub["question_id"]) not in scored:
            scored.add((sub["team"], sub["question_id"]))
            row["points"] += pts.get(sub["question_id"], 0)
            row["correct"] += 1
    limit = r.get("time_limit_minutes")
    return {**r, "elapsed_seconds": _elapsed(r), "remaining_seconds": max(0, limit * 60 - _elapsed(r)) if limit else None, "time_up": _time_up(r),
            "scoreboard": sorted(teams.values(), key=lambda x: (-x["points"], -x["correct"]))}


@router.get("/drills/{did}/race")
def get_race(did: str) -> dict:
    d = _drill(did)
    return {"race": _race_view(d), "past": d.get("races") or []}


@router.post("/drills/{did}/race")
def start_race(did: str, req: RaceIn) -> dict:
    with _lock:
        d = _drill(did)
        if d.get("race"):
            raise HTTPException(409, "a race is already running: finish it first")
        if not d["questions"]:
            raise HTTPException(400, "add questions before starting a race")
        d["race"] = {"id": _new_id("race"), "started_at": _now(), "started_by": (auth.current() or {}).get("username") or "local",
                     "time_limit_minutes": req.time_limit_minutes or d.get("time_limit_minutes"),
                     "teams": [t.strip() for t in req.teams if t.strip()], "participants": {}, "events": [], "submissions": []}
        _write(_drill_path(did), d)
        return {"race": _race_view(d)}


@router.post("/drills/{did}/race/join")
def join_race(did: str, req: JoinIn) -> dict:
    with _lock:
        d = _drill(did)
        r = _race(d)
        team = req.team.strip() or req.participant.strip()
        r["participants"][req.participant.strip()] = {"team": team, "role": req.role, "joined_at": _now()}
        if team not in r["teams"]:
            r["teams"].append(team)
        _write(_drill_path(did), d)
        return {"drill_id": did, "race_id": r["id"], "participant": req.participant.strip(), "team": team}


@router.post("/capture")
def capture(req: CaptureIn) -> dict:
    """What a joined participant opened: the object type (and links followed to reach it), the terms searched."""
    with _lock:
        d = _drill(req.drill_id)
        r = _race(d, req.race_id)
        if req.participant not in r["participants"] or _time_up(r):
            return {"captured": 0}
        names = {t["id"]: t["display_name"] for t in _all("object-types")}
        links = {lt["id"]: lt for lt in _all("link-types")}
        at = _now()
        evs = []
        if req.q.strip():
            evs.append({"kind": "search", "label": req.q.strip()})
        # the object type searched from (or viewed), then the links followed from it
        if req.object_type_id in names:
            evs.append({"kind": "object" if req.primary_key else "object_type", "label": names[req.object_type_id]})
        for lid in req.link_type_ids:
            lt = links.get(lid)
            if lt:
                evs.append({"kind": "link", "label": f"{lt.get('display_name') or lid}"})
        last = [e for e in r["events"] if e["participant"] == req.participant][-len(evs):] if evs else []
        # the same view reported twice in a row (a re-render, paging) is one step
        if evs and [(e["kind"], e["label"]) for e in last] == [(e["kind"], e["label"]) for e in evs]:
            return {"captured": 0}
        r["events"].extend({**e, "participant": req.participant, "at": at} for e in evs)
        r["events"] = r["events"][-5000:]
        _write(_drill_path(req.drill_id), d)
        return {"captured": len(evs)}


@router.post("/drills/{did}/race/answer")
def race_answer(did: str, req: RaceAnswerIn) -> dict:
    with _lock:
        d = _drill(did)
        r = _race(d)
        who = r["participants"].get(req.participant)
        if not who:
            raise HTTPException(400, "join the race first")
        if _time_up(r):
            raise HTTPException(400, "time is up")
        q = next((x for x in d["questions"] if x["id"] == req.question_id), None)
        if not q:
            raise HTTPException(400, f"unknown question {req.question_id}")
        mine = [x for x in r["submissions"] if x["participant"] == req.participant]
        since = mine[-1]["at"] if mine else who["joined_at"]
        evs = [e for e in r["events"] if e["participant"] == req.participant and e["at"] >= since]
        path: list[str] = []
        for e in evs:
            if e["kind"] in ("object_type", "object", "link") and (not path or path[-1] != e["label"]):
                path.append(e["label"])
        auto = bool(q.get("expected_answer")) and _norm(req.answer) == _norm(q["expected_answer"])
        prev_at = since if mine else r["started_at"]
        from datetime import datetime

        secs = int((datetime.fromisoformat(_now()) - datetime.fromisoformat(prev_at)).total_seconds())
        sub = {"id": _new_id("sub"), "participant": req.participant, "team": who["team"], "question_id": q["id"], "answer": req.answer,
               "at": _now(), "seconds": max(0, secs), "path": path[:30], "searched": sorted({e["label"] for e in evs if e["kind"] == "search"})[:20],
               "correct": True if auto else None, "judged_by": "auto" if auto else None}
        r["submissions"].append(sub)
        _write(_drill_path(did), d)
        return {"submission": sub, "race": _race_view(d)}


@router.post("/drills/{did}/race/judge")
def judge(did: str, req: JudgeIn) -> dict:
    with _lock:
        d = _drill(did)
        r = _race(d)
        sub = next((x for x in r["submissions"] if x["id"] == req.submission_id), None)
        if not sub:
            raise HTTPException(404, "submission not found")
        sub["correct"] = req.correct
        sub["judged_by"] = (auth.current() or {}).get("username") or "local"
        _write(_drill_path(did), d)
        return {"race": _race_view(d)}


@router.post("/drills/{did}/race/finish")
def finish_race(did: str) -> dict:
    """Every participant's answers (the latest per question) become a drill session with the captured paths."""
    with _lock:
        d = _drill(did)
        view = _race_view(d)
        r = _race(d)
        made = 0
        for name, who in r["participants"].items():
            latest: dict[str, dict] = {}
            for sub in r["submissions"]:
                if sub["participant"] == name:
                    latest[sub["question_id"]] = sub
            if not latest:
                continue
            answers = [{"question_id": qid, "correct": x["correct"], "seconds": x["seconds"], "assisted": False, "path": x["path"],
                        "searched": x["searched"], "symptoms": [], "expected": "", "notes": f"race {r['id']}", "answer": x["answer"]}
                       for qid, x in latest.items()]
            d["sessions"].append({"id": _new_id("sess"), "participant": name, "role": who["role"], "team": who["team"],
                                  "assisted_format": "team" if sum(1 for w in r["participants"].values() if w["team"] == who["team"]) > 1 else "individual",
                                  "answers": answers, "at": _now(), "race_id": r["id"]})
            made += 1
        d.setdefault("races", []).append({"id": r["id"], "started_at": r["started_at"], "finished_at": _now(), "teams": r["teams"],
                                          "participants": len(r["participants"]), "scoreboard": view["scoreboard"] if view else []})
        d["races"] = d["races"][-RACES_KEPT:]
        d.pop("race")
        d["updated_at"] = _now()
        _write(_drill_path(did), d)
        return {**d, "results": results(d), "sessions_created": made}


def _rate(xs: list[dict]) -> Optional[float]:
    judged = [a for a in xs if a.get("correct") is not None]
    return round(sum(1 for a in judged if a["correct"]) / len(judged), 2) if judged else None


def _median(xs: list[dict]) -> Optional[int]:
    t = [a["seconds"] for a in xs if a.get("seconds") is not None]
    return int(statistics.median(t)) if t else None


def results(d: dict) -> dict:
    per_q = []
    symptoms: Counter = Counter()
    for q in d["questions"]:
        ans = [(s, a) for s in d["sessions"] for a in s["answers"] if a["question_id"] == q["id"]]
        people = [a for s, a in ans if s["role"] != "agent"]
        agents = [a for s, a in ans if s["role"] == "agent"]
        by_role = {r: {"success": _rate([a for s, a in ans if s["role"] == r]), "median_seconds": _median([a for s, a in ans if s["role"] == r]),
                       "answers": sum(1 for s, _ in ans if s["role"] == r)} for r in ROLES}
        for _, a in ans:
            symptoms.update(a.get("symptoms") or [])
        ps, ag = _rate(people), _rate(agents)
        if ps is None or ag is None:
            compare = None
        elif ps >= 0.5 and ag >= 0.5:
            compare = ("both_succeed", "Confirm the model provides a discoverable, expressive path for this question.")
        elif ag >= 0.5:
            compare = ("ai_only", "Review human-facing names, aliases, descriptions, default views and visual hierarchy.")
        elif ps >= 0.5:
            compare = ("people_only", "Identify business logic or domain knowledge people supplied from experience that the ontology does not make explicit.")
        else:
            compare = ("both_struggle", "Look for missing data, links, semantics or reusable business logic.")
        paths = Counter(" → ".join(a["path"]) for _, a in ans if a.get("path"))
        per_q.append({"question_id": q["id"], "answers": len(ans), "success": _rate([a for _, a in ans]), "median_seconds": _median([a for _, a in ans]),
                      "assisted": sum(1 for _, a in ans if a.get("assisted")), "by_role": by_role,
                      "people_vs_agents": {"code": compare[0], "review": compare[1]} if compare else None,
                      "paths": [{"path": p, "count": c} for p, c in paths.most_common(5)],
                      "searched": [t for t, _ in Counter(t for _, a in ans for t in a.get("searched") or []).most_common(8)],
                      "expected": [a["expected"] for _, a in ans if a.get("expected")][:5]})
    teams: dict[str, int] = defaultdict(int)
    for s in d["sessions"]:
        for a in s["answers"]:
            if a.get("correct"):
                q = next((x for x in d["questions"] if x["id"] == a["question_id"]), None)
                teams[s.get("team") or s["participant"]] += q["points"] if q else 0
    return {"questions": per_q,
            "symptoms": [{"id": k, "label": SYMPTOMS[k][0], "review": SYMPTOMS[k][1], "rule": SYMPTOMS[k][2], "count": c,
                          "systemic": c >= 2} for k, c in symptoms.most_common()],
            "leaderboard": sorted(({"team": k, "points": v} for k, v in teams.items()), key=lambda x: -x["points"])}


@router.get("/symptoms")
def symptoms() -> list[dict]:
    return [{"id": k, "label": v[0], "review": v[1], "rule": v[2]} for k, v in SYMPTOMS.items()]


def _schema_text(ontology_id: Optional[str]) -> str:
    lines = []
    types = _visible_types(ontology_id)
    names = {t["id"]: t["display_name"] for t in types}
    for t in types:
        props = ", ".join(f"{p['api_name']} ({p.get('type')})" for p in t["properties"][:40])
        alias = f" aliases: {', '.join(t.get('aliases') or [])}." if t.get("aliases") else ""
        lines.append(f"- Object type {t['display_name']} [{t['api_name']}]: {t.get('description') or 'no description'}.{alias} Properties: {props}")
    for lt in _res("link-types"):
        s, g = lt["source"], lt["target"]
        if s["object_type_id"] in names and g["object_type_id"] in names:
            lines.append(f"- Link {names[s['object_type_id']]}.{g.get('api_name') or 'link'} → {names[g['object_type_id']]} (reverse {s.get('api_name') or 'link'}; {lt.get('cardinality')})")
    for i in _res("interfaces"):
        lines.append(f"- Interface {i['display_name']}: {', '.join(p['api_name'] for p in i.get('properties') or [])}")
    return "\n".join(lines)


class AgentRunIn(BaseModel):
    model: Optional[str] = None
    participant: str = "AI agent"
    # query: the agent queries the data until it answers; plan: it only plans a path from the schema
    mode: Literal["query", "plan"] = "query"
    max_steps: int = Field(8, ge=1, le=20)


AGENT_STEP = {"type": "object", "properties": {
    "thought": {"type": "string", "description": "one short sentence: what you look for next"},
    "action": {"type": "string", "enum": ["search", "aggregate", "function", "answer"]},
    "function": {"type": "string", "description": "action function: the name of a published function from the list; empty otherwise"},
    "function_inputs": {"type": "string", "description": "action function: its inputs as a JSON object (objects by primary key); empty otherwise"},
    "object_type": {"type": "string", "description": "API name of the object type to start from; empty for answer"},
    "q": {"type": "string", "description": "a few keywords to search, or an empty string for none"},
    "filters": {"type": "array", "description": "empty list for none", "items": {"type": "object", "properties": {
        "property": {"type": "string"}, "op": {"type": "string", "enum": ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is_null", "not_null"]},
        "value": {"type": "string", "description": "empty for is_null / not_null"}}, "required": ["property", "op", "value"]}},
    "links": {"type": "array", "items": {"type": "string"}, "description": "links to follow by API name, in order; empty list for none"},
    "metric": {"type": "string", "enum": ["count", "sum", "avg", "min", "max"]},
    "property": {"type": "string", "description": "the property summed / averaged; empty for count"},
    "group_by": {"type": "string", "description": "a property to group by, or empty"},
    "expression": {"type": "string", "description": "optional: an arithmetic formula over the result objects' properties computed for each object "
                   "as the column `derived` (e.g. tarif_rs - tarif_inacbg); filters, property and order can then use `derived`. Empty for none"},
    "order": {"type": "string", "enum": ["none", "asc", "desc"], "description": "sort the listed objects by `derived` (or by property)"},
    "answer": {"type": "string", "description": "the final answer for action answer, else empty"}},
    "required": ["thought", "action", "function", "function_inputs", "object_type", "q", "filters", "links", "metric", "property", "group_by", "expression",
                 "order", "answer"]}

AGENT_FUNCTIONS = 30


def _agent_functions() -> list[dict]:
    """Published functions the agent may call: no edits, the caller can see them (at most AGENT_FUNCTIONS)."""
    try:
        import functions_registry

        return [f for f in functions_registry.list_functions() if not f.get("edits") and f.get("output") != "edits"][:AGENT_FUNCTIONS]
    except Exception:  # noqa: BLE001 - functions not set up: the agent searches only
        return []


def _functions_text(fns: list[dict]) -> str:
    return "\n".join(f"- Function {f['name']}({', '.join(i['name'] + ': ' + str(i['type']) for i in f.get('inputs') or [])}) -> {f.get('output')}: {f.get('doc') or ''}"[:400]
                     for f in fns)


def _agent_function(step: dict, fns: list[dict]) -> dict:
    """Run a published function for the agent: an observation."""
    import functions_registry

    name = (step.get("function") or "").strip()
    f = next((x for x in fns if x["name"] == name or x.get("api_name") == name or x["id"] == name), None)
    if not f:
        return {"error": f"no function {name!r}; use a name from the function list"}
    try:
        inputs = json.loads(step.get("function_inputs") or "{}")
    except ValueError as e:
        return {"error": f"function_inputs is not JSON: {e}"}
    if not isinstance(inputs, dict):
        return {"error": "function_inputs must be a JSON object"}
    res = functions_registry.run_function(f["id"], None, inputs, {"resource": "ontology-design-agent"})
    if not res.get("ok"):
        return {"error": f"{f['name']} failed: {res.get('error')}"}
    return {"function": f["name"], "value": json.loads(json.dumps(res.get("value"), default=str))}

AGENT_DERIVED_ROWS = 50_000


def _value(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            return v
    return v


def _agent_step(step: dict, types: list[dict]) -> tuple[dict, list[str], Optional[str]]:
    """Run one search / aggregation for the agent: (an observation, the path it took, the term searched)."""
    import ontology_explorer as ox

    want = (step.get("object_type") or "").strip().lower()
    t = next((x for x in types if want in (x["api_name"].lower(), x["display_name"].lower(), x["id"].lower())), None)
    if not t:
        return {"error": f"no object type {step.get('object_type')!r}; use an API name from the schema"}, [], None
    path, cur, around = [t["display_name"]], t["id"], []
    for name in step.get("links") or []:
        n = name.strip().lower()
        hit = None
        for lt in _all("link-types"):
            s, g = lt["source"], lt["target"]
            if s["object_type_id"] == cur and n in ((g.get("api_name") or "").lower(), (lt.get("display_name") or "").lower(), lt["id"]):
                hit = (lt, "forward", g["object_type_id"])
            elif g["object_type_id"] == cur and n in ((s.get("api_name") or "").lower(), (lt.get("display_name") or "").lower(), lt["id"]):
                hit = (lt, "reverse", s["object_type_id"])
            if hit:
                break
        if not hit:
            return {"error": f"no link {name!r} from the current object type"}, path, None
        around.append(ox.SearchAround(link_type_id=hit[0]["id"], direction=hit[1]))
        path.append(hit[0].get("display_name") or hit[0]["id"])
        cur = hit[2]
    filters = [ox.Filter(property=f["property"], op=f.get("op") or "eq", value=_value(f.get("value"))) for f in step.get("filters") or [] if f.get("property")]
    if (step.get("expression") or "").strip() or any(f.property == "derived" for f in filters):
        return _derived_step(step, t, around, filters, path)
    agg = None
    if step["action"] == "aggregate":
        agg = ox.Aggregate(metric=step.get("metric") or "count", property=step.get("property") or None, group_by=step.get("group_by") or None)
    try:
        res = ox.search(ox.SearchIn(object_type_id=t["id"], q=step.get("q") or "", filters=filters, search_around=around, aggregate=agg,
                                    limit=10, histograms=False, resource="ontology-design-agent"))
    except HTTPException as e:
        return {"error": str(e.detail)}, path, step.get("q") or None
    obs: dict[str, Any] = {"result_type": res["result_type"]["display_name"], "total": res["total"]}
    if agg:
        obs["aggregation"] = res["aggregation"]
    else:
        obs["objects"] = [{"title": o.get("title"), **{k: v for k, v in list((o.get("properties") or {}).items())[:12] if not isinstance(v, (list, dict))}}
                          for o in res["objects"][:10]]
    return obs, path, step.get("q") or None


def _derived_step(step: dict, t: dict, around: list, filters: list, path: list[str]) -> tuple[dict, list[str], Optional[str]]:
    """A search whose objects get a computed column `derived` (a safe arithmetic expression over their properties),
    then filters on it, sorting, and an aggregation or the top objects."""
    import foundry_rules
    import ontology_explorer as ox

    expr = (step.get("expression") or "").strip()
    if not expr:
        return {"error": "a filter on `derived` needs an expression"}, path, None
    try:
        tree = foundry_rules.compile_expr(expr)
    except HTTPException as e:
        return {"error": f"the expression: {e.detail}"}, path, None
    plain = [f for f in filters if f.property != "derived"]
    on_derived = [f for f in filters if f.property == "derived"]
    try:
        r = ox.run_search(ox.SearchIn(object_type_id=t["id"], q=step.get("q") or "", filters=plain, search_around=around, limit=1, histograms=False))
    except HTTPException as e:
        return {"error": str(e.detail)}, path, step.get("q") or None
    rows = r["rows"][:AGENT_DERIVED_ROWS]
    out, failed = [], 0
    for o in rows:
        props = {k: v for k, v in (o.get("properties") or {}).items() if not isinstance(v, (list, dict))}
        try:
            d = foundry_rules.evaluate(tree, props)
        except Exception:  # noqa: BLE001 - an object the formula cannot compute (a missing value)
            d, failed = None, failed + 1
        out.append({"title": o.get("title"), **props, "derived": d})
    out = [x for x in out if all(ox._match(x.get("derived"), f) for f in on_derived)]
    key = step.get("property") or "derived"
    if step.get("order") in ("asc", "desc"):
        out.sort(key=lambda x: (x.get(key) is None, x.get(key) if isinstance(x.get(key), (int, float)) else str(x.get(key))), reverse=step["order"] == "desc")
        if step["order"] == "desc":
            out = [x for x in out if x.get(key) is not None] + [x for x in out if x.get(key) is None]
    obs: dict[str, Any] = {"result_type": r["type"]["display_name"], "total": len(out), "derived": expr, "not_computed": failed}
    if step["action"] == "aggregate":
        metric = step.get("metric") or "count"
        groups: dict[str, list] = {}
        for x in out:
            groups.setdefault(str(x.get(step["group_by"])) if step.get("group_by") else "all", []).append(x)
        agg = {}
        for g, xs in list(groups.items())[:50]:
            nums = [v for v in (x.get(key) for x in xs) if isinstance(v, (int, float)) and not isinstance(v, bool)]
            agg[g] = len(xs) if metric == "count" else (None if not nums else sum(nums) if metric == "sum" else sum(nums) / len(nums) if metric == "avg" else min(nums) if metric == "min" else max(nums))
        obs["aggregation"] = {"metric": metric, "property": key, "groups": agg}
    else:
        obs["objects"] = [{k: v for k, v in list(x.items())[:13]} | {"derived": x.get("derived")} for x in out[:10]]
    return obs, path, step.get("q") or None


def _numbers(x: str) -> list[float]:
    out = []
    for m in re.findall(r"-?\d[\d.,]*", x or ""):
        digits = m.replace(".", "").replace(",", "") if re.fullmatch(r"-?\d{1,3}([.,]\d{3})+", m) else m.replace(",", ".")
        try:
            out.append(float(digits))
        except ValueError:
            pass
    return out


def _judge(expected: str, answer: str) -> Optional[bool]:
    """Correct when the answer contains the expected answer (or its number); otherwise left for a person."""
    if not expected.strip() or not answer.strip():
        return None
    if _norm(expected) in _norm(answer):
        return True
    exp = _numbers(expected)
    if len(exp) == 1 and any(abs(n - exp[0]) <= max(0.5, abs(exp[0]) * 0.005) for n in _numbers(answer)):
        return True
    return None


def _agent_query(q: dict, schema: str, model: str, max_steps: int, types: list[dict], fns: Optional[list[dict]] = None) -> dict:
    import pipeline_ai

    transcript: list[str] = []
    path: list[str] = []
    searched: list[str] = []
    answer, steps = "", 0
    system = ("You answer business questions by querying an enterprise ontology. Each turn choose ONE action: search (an object type, "
              "optional keyword q, filters, links to follow), aggregate (the same plus metric / property / group_by), or answer once "
              "the observations support it. When a question needs a value computed per object (a difference, a ratio), give an "
              "expression: it becomes the column `derived` you can filter, sort (order) and aggregate on. Published functions "
              "(listed after the schema, if any) compute business logic: call one with action function, its name and its inputs as JSON. Use only object types, properties and links from the schema; never invent data.")
    while steps < max_steps:
        steps += 1
        history = "\n".join(transcript)[-12000:]
        fn_text = f"\n\nPublished functions:\n{_functions_text(fns)}" if fns else ""
        step = pipeline_ai.chat(model, system, f"Ontology schema:\n{schema}{fn_text}\n\nQuestion: {q['text']}\n\nSteps so far:\n{history or '(none)'}\n\n"
                                f"Step {steps} of at most {max_steps}: choose the next action.", AGENT_STEP, 0, 4096)
        if step.get("action") == "answer":
            answer = str(step.get("answer") or "")
            transcript.append(f"{steps}. answer: {answer}")
            break
        if step.get("action") == "function":
            obs, p, term = _agent_function(step, fns or []), ["function " + str(step.get("function") or "")], None
        else:
            obs, p, term = _agent_step(step, types)
        for x in p:
            if not path or path[-1] != x:
                path.append(x)
        if term:
            searched.append(term)
        transcript.append(f"{steps}. {step.get('thought', '')}\n   {json.dumps({k: v for k, v in step.items() if k != 'thought'}, ensure_ascii=False)}\n"
                          f"   observation: {json.dumps(obs, ensure_ascii=False, default=str)[:3000]}")
    return {"answer": answer, "path": path[:30], "searched": searched[:20], "steps": steps, "transcript": "\n".join(transcript)[-4000:]}


@router.post("/drills/{did}/agent-run")
def agent_run(did: str, req: AgentRunIn) -> dict:
    """Run every question through a language model with the ontology's schema. "query": the model queries the data
    (as the signed-in user) until it answers, and answers matching the expected answer are judged correct; "plan": it
    returns the path it would follow, the operation and the missing concepts, judged afterwards by a person."""
    import pipeline_ai

    d = _drill(did)
    schema = _schema_text(d.get("ontology_id"))
    model = req.model or ontology.DEFAULT_LLM
    answers = []
    types = _visible_types(d.get("ontology_id"))
    for q in d["questions"]:
        started = __import__("time").monotonic()
        if req.mode == "query":
            try:
                out = _agent_query(q, schema, model, req.max_steps, types, _agent_functions())
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001
                raise HTTPException(502, f"the language model failed: {e}") from e
            secs = int(__import__("time").monotonic() - started)
            sym = [] if out["answer"] else ["no_path"]
            answers.append({"question_id": q["id"], "correct": _judge(q.get("expected_answer") or "", out["answer"]), "seconds": secs, "assisted": False,
                            "path": out["path"], "searched": out["searched"], "symptoms": sym, "expected": "",
                            "notes": f"{out['steps']} steps\n{out['transcript']}"[:4000], "answer": out["answer"][:4000]})
            continue
        try:
            out = pipeline_ai.chat(model, "You navigate an enterprise ontology to answer business questions. Plan from the schema only; never invent object types or links.",
                                   f"Ontology schema:\n{schema}\n\nQuestion: {q['text']}\n\nPlan how to answer it.",
                                   {"type": "object", "properties": {
                                       "path": {"type": "array", "items": {"type": "string"}, "description": "object types and links in order"},
                                       "operation": {"type": "string"}, "answerable": {"type": "boolean"},
                                       "missing": {"type": "array", "items": {"type": "string"}, "description": "concepts or links the schema lacks"}},
                                    "required": ["path", "operation", "answerable", "missing"]}, 0, 1500)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"the language model failed: {e}") from e
        secs = int(__import__("time").monotonic() - started)
        sym = [] if out.get("answerable") else ["no_path"]
        if out.get("missing") and out.get("answerable"):
            sym.append("cannot_traverse")
        answers.append({"question_id": q["id"], "correct": None, "seconds": secs, "assisted": False, "path": [str(x) for x in out.get("path") or []][:20],
                        "searched": [], "symptoms": sym, "expected": "; ".join(out.get("missing") or [])[:1000], "notes": str(out.get("operation") or "")[:4000],
                        "answer": ""})
    with _lock:
        d = _drill(did)
        d["sessions"].append({"id": _new_id("sess"), "participant": req.participant, "role": "agent", "team": "", "assisted_format": "individual",
                              "answers": answers, "at": _now(), "model": model, "agent_mode": req.mode})
        d["updated_at"] = _now()
        _write(_drill_path(did), d)
        return {**d, "results": results(d)}
