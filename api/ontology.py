"""Ontology Manager, AIP Logic and Automate, modelled on the Palantir Foundry apps of the same names.

Ontology Manager: object types (display name, API name, typed properties, a primary key and a title
property), their objects, and action types that create, modify or delete objects of one type. A media
property holds the id of a file in the Files tab (uploads go to My Project / Ontology).

AIP Logic: a function is a list of inputs (objects, text, numbers, media) and blocks run in order. Each
block reads inputs and earlier blocks through variables ("inputPdf.PDF", "joinArray") and produces a
value: Extract text from PDF (one string per page), Join array, Text template, Use LLM, and Apply action,
which produces ontology edits instead of a value. A preview run returns every block's output and the
edits without applying them; "Run and apply" (and Automate) writes the edits.

Automate: when objects of a type are added or modified, or on a schedule, run a Logic function (the
object bound to one of its inputs) or apply an action. Effects run in the background; each run is kept
with its outcome. Edits an automation makes never trigger that same automation again.

Time series (ts_ontology.py, ts_derived.py, ts_alerting.py): a "timeseries" property is a time series property (TSP)
whose value is a series ID, a qualified series ID or a derived series; an object type's `time_series` record holds
the TSPs' syncs, units and interpolation, the default TSP, the sensor object type configuration and geospatial
tracks. Automate's "time_series" condition is time series alerting. A property's `type_class`
("timeseries:start_time", …) marks what an alert object type's properties hold.

Properties carry the Ontology metadata of Foundry's property editor: a base type (the scalar types, geopoint, geoshape,
struct with fields and main fields, vector, attachment, marking, cipher; any of them as an array), status (with
deprecation details), visibility, required (optionally allowing empty arrays), edit-only, mandatory control, value
formatting, conditional formatting, render hints, type classes, a value type, a shared property, reducers and a
derived-from-linked-objects source. Object types add aliases, groups, visibility, the `promoted` and `example`
statuses, the ontology they belong to and the interfaces they implement. Statuses guard destructive changes: an
active (or promoted) object type cannot be deleted or have its API name or primary key changed, and active properties
cannot be removed. Link types, interfaces, shared properties, value types, ontologies, branches and proposals,
Object Explorer and Object Views live in ontology_model.py, which plugs into the hooks in MODEL_HOOKS.

Records are JSON files under data/ontology/. Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

import auth
import drive
import geo
import knowledge
import ontology_live
import ontology_store
import pipeline_ai

log = logging.getLogger("bluesandai.ontology")
router = APIRouter(prefix="/api/ontology")

PROPERTY_TYPES = ("string", "integer", "double", "boolean", "date", "timestamp", "media", "string_array", "timeseries",
                  "long", "short", "byte", "float", "decimal", "geopoint", "geoshape", "struct", "vector", "attachment",
                  "marking", "cipher", "geotemporal_series_reference")
# geopoint: "lat,lon" (or a geohash); geoshape: GeoJSON geometry; geotemporal series reference (GTSR): a series id of the
# geotemporal series sync named on the property (`sync_id`) — geo.py checks the values, geospatial.py searches them
GEO_TYPES = ("geopoint", "geoshape")
GTSR = "geotemporal_series_reference"
PK_TYPES = ("string", "integer", "long", "short", "byte")
# base types that cannot be the title key (arrays of them neither)
NOT_TITLE = ("timeseries", "media", "struct", "vector", "attachment", "geoshape", "marking", GTSR)
# struct fields: no nesting, no arrays
STRUCT_FIELD_TYPES = ("string", "integer", "long", "short", "byte", "double", "float", "decimal", "boolean", "date", "timestamp", "geopoint")
# limited support: not usable in action types
NO_ACTION_TYPES = ("byte", "float", "short")
INT_RANGE = {"integer": 2**31, "long": 2**63, "short": 2**15, "byte": 2**7}
MAX_VECTOR = 2048
STATUSES = ("experimental", "active", "deprecated", "example")
RENDER_HINTS = ("disable_formatting", "identifier", "keywords", "long_text", "low_cardinality", "selectable", "sortable",
                "searchable", "leading_wildcards", "regex_queries")
REDUCER_TYPES = ("string", "integer", "long", "short", "byte", "double", "float", "decimal", "boolean", "date", "timestamp", "struct")
ACTION_KINDS = ("create", "modify", "delete")
BLOCK_TYPES = ("extract_pdf_text", "join_array", "text_template", "use_llm", "apply_action", "semantic_search")
INPUT_TYPES = ("object", "string", "integer", "double", "boolean", "media")
LLM_OUTPUTS = {
    "string": None,
    "string_array": {"type": "array", "items": {"type": "string"}},
    "integer": {"type": "integer"},
    "double": {"type": "number"},
    "boolean": {"type": "boolean"},
}
DEFAULT_LLM = "vertex/deepseek-ai/deepseek-v4.1-flash-maas"  # open model on Vertex AI (aip/models.py)
MAX_OCR_PAGES = 50
RUNS_KEPT = 100
# an automation's edits may set off other automations, but only this many levels deep
MAX_DEPTH = 3
SCHEDULE_TICK = 30  # seconds
IDENT = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
# API names applications and SDKs reserve (object types and properties may not use them)
RESERVED_API_NAMES = {"ontology", "object", "property", "link", "relation", "rid", "primarykey", "typeid", "ontologyobject"}


def check_api_name(name: str, what: str) -> None:
    if not IDENT.match(name or "") or len(name) > 100:
        raise HTTPException(400, f'"{name}" is not a valid {what} API name (1–100 letters, digits and _; starting with a letter)')
    if name.lower() in RESERVED_API_NAMES:
        raise HTTPException(400, f'"{name}" is a reserved API name: choose another {what} API name')
VAR = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}")

DIR: Path = Path()
_env: Callable[[str], str] = lambda key: ""
_lock = threading.RLock()
_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="automate")
_FOLDERS = ("object-types", "action-types", "objects", "logic", "automations", "runs", "agents", "agent-sessions", "ts-jobs", "insight-workbooks")
# set by ts_alerting.py: checks a "time_series" automation condition, runs one now, and summarizes its evaluation job
TS_HOOKS: dict[str, Callable[..., Any]] = {}
# set by ontology_model.py: guard(kind, id, op, old, new) for protection, roles and branches; check_type(rec);
# derive(t, pk, props) -> derived and reduced values; edits(written); query(kind, type ids, objects); value_type(id, value, label)
MODEL_HOOKS: dict[str, Callable[..., Any]] = {}
# the Ontology scenario a request works in (ontology_scenarios.py): reads see main with the scenario's edits on top
# (scenario_objects / scenario_links hooks) and edits are written to the scenario instead of main (scenario_write)
SCENARIO: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("ontology_scenario", default=None)


def _hook(name: str, *args: Any) -> Any:
    fn = MODEL_HOOKS.get(name)
    return fn(*args) if fn else None


def configure(data_dir: Path, env: Callable[[str], str]) -> None:
    global DIR, _env
    DIR = data_dir / "ontology"
    _env = env
    for name in _FOLDERS:
        (DIR / name).mkdir(parents=True, exist_ok=True)
    ontology_store.configure(DIR / "objects", env)


def startup() -> None:
    threading.Thread(target=_scheduler, daemon=True, name="automate-schedule").start()


# ------------------------------------------------------------------------------------------------
# storage
# ------------------------------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _path(folder: str, rec_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", rec_id):
        raise HTTPException(404, "not found")
    return DIR / folder / f"{rec_id}.json"


def _read(path: Path, default: Any = None) -> Any:
    # Windows: a read that meets another thread's os.replace of the same file is refused for a moment (seen 2026-10-23,
    # the AIP Nexus sync reading an object type while it was saved): tried again shortly before giving up
    for attempt in range(6):
        try:
            return json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            return default
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


_path_locks: dict[str, threading.Lock] = {}
_path_locks_guard = threading.Lock()


def _path_lock(path: Path) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(path))
    with _path_locks_guard:
        lk = _path_locks.get(key)
        if lk is None:
            lk = _path_locks[key] = threading.Lock()
        return lk


def _write(path: Path, data: Any) -> None:
    """Write JSON atomically: a temp file of its own (<name>.<random>.tmp, same folder) per write, fsynced, then renamed
    over the target. Writers of one path in this process take turns; across processes each rename replaces the whole
    file (last writer wins), so a reader never sees two writes mixed."""
    text = json.dumps(data, ensure_ascii=False, indent=1)
    # the bytes write_text produced (text mode turns "\n" into os.linesep; JSON strings never hold a raw newline)
    body = (text.replace("\n", os.linesep) if os.linesep != "\n" else text).encode("utf-8")
    with _path_lock(path):
        if path.parent == DIR / "links" and path.name.count(".") == 1 and path.suffix == ".json" and _SNAPSHOTS:
            _snapshot_before_link_write(path)  # join table links: pre-images for open function-run snapshots
        fd, name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            # Windows refuses the replace while another process (the API, a virus scanner) or a reader has the file
            # open: retry briefly
            for attempt in range(40):
                try:
                    os.replace(tmp, path)
                    return
                except PermissionError:
                    if attempt == 39:
                        raise
                    time.sleep(0.005 if attempt < 4 else 0.05)
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise


def load_objects(type_id: str) -> dict[str, dict]:
    """A type's objects as stored on main {primary key: object}: every reader of the object files goes through this
    (ontology_store.py: one JSON file, or shards for large types). No permission check, no scenario."""
    return ontology_store.load(type_id)


def save_objects(type_id: str, objs: dict[str, dict], changed: Optional[Any] = None) -> dict:
    """Store a type's whole object set; `changed` (primary keys added, modified or deleted) lets a sharded type write
    only those keys' shards."""
    if _SNAPSHOTS and not ontology_live.is_live(type_id):
        # pre-images for open function-run snapshots (a live type's objects are its dataset's rows: no pre-images)
        _snapshot_before_save(type_id, objs, changed)
    return ontology_store.save(type_id, objs, changed)


def object_count(type_id: str) -> int:
    return ontology_store.count(type_id)


def ensure_objects(type_id: str) -> None:
    """An empty object store for a type that has none yet (existing objects are left alone)."""
    ontology_store.ensure(type_id)


def objects_stat(type_id: str) -> Optional[dict]:
    """{format, mtime_ns, size} of the stored objects (None when there are none): changes when the objects change."""
    return ontology_store.stat(type_id)


def _get(folder: str, rec_id: str, what: str) -> dict:
    rec = _read(_path(folder, rec_id))
    if not rec:
        raise HTTPException(404, f"{what} not found")
    return rec


def _all(folder: str) -> list[dict]:
    out = [r for p in (DIR / folder).glob("*.json") if (r := _read(p))]
    return sorted(out, key=lambda r: r.get("created_at", ""))


def _put(folder: str, rec: dict) -> dict:
    rec["updated_at"] = _now()
    _write(_path(folder, rec["id"]), rec)
    return rec


def _api_name(text: str, upper: bool) -> str:
    words = re.findall(r"[A-Za-z0-9]+", text) or ["item"]
    name = "".join(w[:1].upper() + (w[1:].lower() if w.isupper() else w[1:]) for w in words)
    if not upper:
        name = name[:1].lower() + name[1:]
    return name if name[:1].isalpha() else ("X" if upper else "x") + name


# ------------------------------------------------------------------------------------------------
# object types
# ------------------------------------------------------------------------------------------------


class StructField(BaseModel):
    api_name: str = Field(max_length=100)
    display_name: str = Field("", max_length=200)
    type: str = "string"
    # main fields stand for the struct where a single value is expected (titles, interfaces, reducers)
    main: bool = False


class Property(BaseModel):
    api_name: str = Field(max_length=100)
    display_name: str = Field(max_length=200)
    type: str = "string"
    description: str = ""
    # what the property holds for an application, e.g. "timeseries:start_time" on an alert object type
    type_class: Optional[str] = Field(None, max_length=100)
    # an array of the base type (no null elements)
    array: Optional[bool] = None
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    # {reason, deadline, replaced_by} when deprecated
    deprecation: Optional[dict] = None
    visibility: Optional[Literal["prominent", "normal", "hidden"]] = None
    required: Optional[bool] = None
    allow_empty_array: Optional[bool] = None
    # not backed by a dataset column: only edits write it (kept when the backing data is re-imported)
    edit_only: Optional[bool] = None
    # a marking property whose markings a user needs to see the object
    mandatory_control: Optional[bool] = None
    # the values a mandatory control property may hold: marking ids, and organization ids (stored as "org:<id>")
    allowed_markings: Optional[list[str]] = None
    allowed_organizations: Optional[list[str]] = None
    # how keyword search reads the value: not_analyzed, not_indexed, whitespace, simple, standard, english
    analyzer: Optional[str] = None
    # media properties: the media sets (Files folders) its media items come from, and the one uploads go to
    media_sources: Optional[list[str]] = None
    upload_destination: Optional[str] = None
    value_type_id: Optional[str] = None
    shared_property_id: Optional[str] = None
    # {kind: number|date|user|resource, ...options}
    value_formatting: Optional[dict] = None
    # [{when: {kind: standard|always|math, property?, op, value?, value_property?, negate?, expression?}, style: {color, background, align}}]
    conditional_formatting: Optional[list[dict]] = None
    render_hints: Optional[list[str]] = None
    # ["kind:name", …]
    type_classes: Optional[list[str]] = None
    struct_fields: Optional[list[StructField]] = None
    vector_dimension: Optional[int] = Field(None, ge=1, le=MAX_VECTOR)
    # vector properties: the embedding model (queries are embedded with it) and the text property it embeds
    embedding_model: Optional[str] = Field(None, max_length=200)
    embedding_source: Optional[str] = Field(None, max_length=100)
    # for arrays: [{field?: struct field, order: asc|desc}] picks the one element shown where a single value is expected
    reducers: Optional[list[dict]] = None
    # {links: [{link_type_id, direction: forward|reverse}] (≤3 hops), aggregation: none|count|sum|avg|min|max|collect_list|collect_set|approximate_cardinality, property, limit}
    derived: Optional[dict] = None
    # Object Explorer / Object View inline edits: the action type that edits this property in place
    inline_edit_action_id: Optional[str] = None
    # geotemporal series reference: the geotemporal series sync whose series the values name
    sync_id: Optional[str] = None


def dump_property(p: Property) -> dict:
    """A property as stored: unset options left out."""
    d = p.model_dump(exclude_none=True)
    return {k: v for k, v in d.items() if v is not False and v != [] or k in ("api_name", "display_name", "type", "description")}


class ObjectTypeIn(BaseModel):
    # required to create; optional on PATCH
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    plural_name: Optional[str] = Field(None, max_length=200)
    api_name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    icon: Optional[str] = None
    # the icon's color (#rrggbb)
    color: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    status: Optional[Literal["experimental", "active", "deprecated", "example", "promoted"]] = None
    deprecation: Optional[dict] = None
    properties: Optional[list[Property]] = None
    primary_key: Optional[str] = None
    title_property: Optional[str] = None
    # with a string primary key: new objects without one get a random UUID
    generate_primary_key: Optional[bool] = None
    aliases: Optional[list[str]] = None
    groups: Optional[list[str]] = None
    visibility: Optional[Literal["prominent", "normal", "hidden"]] = None
    ontology_id: Optional[str] = None
    # [{interface_id, mapping: {interface property api name: local property api name}}]
    implements: Optional[list[dict]] = None
    # changes to main only through a branch proposal
    protected: Optional[bool] = None
    # with status "active": also make every property active
    apply_status_to_properties: Optional[bool] = None
    # only action types with action logs may edit objects of this type
    require_action_log: Optional[bool] = None


def _check_property(p: dict) -> None:
    name = p["api_name"]
    check_api_name(name, "property")
    if p["type"] not in PROPERTY_TYPES:
        raise HTTPException(400, f'unknown property type {p["type"]}')
    if p.get("array") and p["type"] in ("string_array", "timeseries", "vector"):
        raise HTTPException(400, f"{name}: {p['type']} properties cannot be arrays")
    if p["type"] == "struct":
        fields = p.get("struct_fields") or []
        if not fields:
            raise HTTPException(400, f"{name}: a struct property needs at least one field")
        fnames = [f["api_name"] for f in fields]
        if len(set(fnames)) != len(fnames) or not all(IDENT.match(f) for f in fnames):
            raise HTTPException(400, f"{name}: struct field API names must be valid and unique")
        bad = [f["api_name"] for f in fields if f["type"] not in STRUCT_FIELD_TYPES]
        if bad:
            raise HTTPException(400, f"{name}: struct fields cannot be nested structs, arrays or {', '.join(bad)}'s type")
    elif p.get("struct_fields"):
        raise HTTPException(400, f"{name}: only struct properties have fields")
    if p["type"] == "vector" and not p.get("vector_dimension"):
        raise HTTPException(400, f"{name}: set the vector dimension (at most {MAX_VECTOR})")
    if p.get("allow_empty_array") and not (p.get("required") and p.get("array")):
        raise HTTPException(400, f"{name}: only required array properties can allow empty arrays")
    if p.get("mandatory_control") and p["type"] != "marking":
        raise HTTPException(400, f"{name}: mandatory control properties have the marking base type")
    if p.get("mandatory_control"):
        if not (p.get("allowed_markings") or p.get("allowed_organizations")):
            raise HTTPException(400, f"{name}: a mandatory control property needs its allowed markings and / or allowed organizations")
        # mandatory controls are always required, and hidden unless made visible on purpose
        p["required"] = True
        p.setdefault("visibility", "hidden")
    elif p.get("allowed_markings") or p.get("allowed_organizations"):
        raise HTTPException(400, f"{name}: allowed markings and organizations belong to mandatory control properties")
    # the analyzers ontology_search knows (it imports this module, hence the import here)
    if p.get("analyzer") and p["analyzer"] not in __import__("ontology_search").ANALYZERS:
        raise HTTPException(400, f"{name}: unknown analyzer {p['analyzer']}")
    if (p.get("media_sources") or p.get("upload_destination")) and p["type"] != "media":
        raise HTTPException(400, f"{name}: media sources belong to media reference properties")
    if p.get("upload_destination") and p["upload_destination"] not in (p.get("media_sources") or []):
        raise HTTPException(400, f"{name}: the upload destination must be one of the media sources")
    if p.get("media_sources"):
        try:
            import media_sets

            bad = [s for s in p["media_sources"] if not media_sets.is_media_set(s)]
        except Exception:  # noqa: BLE001 - media sets unavailable: checked when values are written
            bad = []
        if bad:
            raise HTTPException(400, f"{name}: {bad[0]} is not a media set")
    if p.get("status") == "deprecated" and not (p.get("deprecation") or {}).get("reason"):
        raise HTTPException(400, f"{name}: say why the property is deprecated")
    for h in p.get("render_hints") or []:
        if h not in RENDER_HINTS:
            raise HTTPException(400, f"{name}: unknown render hint {h}")
    hints = set(p.get("render_hints") or [])
    if hints & {"low_cardinality", "leading_wildcards", "regex_queries"} and "searchable" not in hints:
        raise HTTPException(400, f"{name}: the low cardinality, leading wildcard and regex render hints need searchable too")
    for tc in p.get("type_classes") or []:
        if ":" not in tc or not tc.split(":", 1)[0] or not tc.split(":", 1)[1]:
            raise HTTPException(400, f'{name}: a type class is "kind:name", not {tc!r}')
    if p.get("reducers"):
        if not p.get("array"):
            raise HTTPException(400, f"{name}: reducers apply to array properties")
        if p["type"] not in REDUCER_TYPES:
            raise HTTPException(400, f"{name}: {p['type']} arrays cannot be reduced")
        fields = {f["api_name"] for f in p.get("struct_fields") or []}
        for r in p["reducers"]:
            if r.get("order", "desc") not in ("asc", "desc"):
                raise HTTPException(400, f"{name}: a reducer sorts asc or desc")
            if p["type"] == "struct" and r.get("field") not in fields:
                raise HTTPException(400, f"{name}: a struct array reducer sorts on one of its fields")
    vf = p.get("value_formatting")
    if vf and vf.get("kind") not in ("number", "date", "user", "resource"):
        raise HTTPException(400, f"{name}: value formatting is number, date, user or resource")


def _check_properties(props: list[dict], pk: str, title: str) -> None:
    names = [p["api_name"] for p in props]
    if not props:
        raise HTTPException(400, "an object type needs at least one property")
    if len(set(n.lower() for n in names)) != len(names):
        raise HTTPException(400, "property API names must be unique")
    for p in props:
        _check_property(p)
        if p["type"] == GTSR:
            if not p.get("sync_id"):
                raise HTTPException(400, f'{p["display_name"] or p["api_name"]}: choose the geotemporal series sync the references point to')
            import timeseries

            try:
                kind = timeseries.kind_of(p["sync_id"])
            except HTTPException:
                raise HTTPException(400, f'{p["display_name"] or p["api_name"]}: the geotemporal series sync was not found') from None
            if kind != "geotemporal":
                raise HTTPException(400, f'{p["display_name"] or p["api_name"]}: a time series sync is not a geotemporal series sync')
        elif "sync_id" in p:
            p.pop("sync_id")
    if sum(p["type"] == GTSR for p in props) > 1:
        raise HTTPException(400, "an object type can have at most one geotemporal series reference property")
    by = {p["api_name"]: p for p in props}
    if pk not in by:
        raise HTTPException(400, "the primary key must be one of the properties")
    if by[pk]["type"] not in PK_TYPES or by[pk].get("array") or by[pk].get("derived"):
        raise HTTPException(400, "the primary key must be a string or integer property (short, long and byte work, but are discouraged)")
    if title not in by:
        raise HTTPException(400, "the title property must be one of the properties")
    if by[title]["type"] in NOT_TITLE:
        raise HTTPException(400, f"a {by[title]['type']} property cannot be the title property")


def _object_type(type_id: str) -> dict:
    t = _get("object-types", type_id, "object type")
    # markings on the object type ("object_type:<id>") cover its objects, actions on them, agents and Workshop
    auth.check_resource("object_type", type_id)
    # ontology roles and organizations
    _hook("read", t)
    return t


def _type_summary(t: dict, counts: Optional[tuple[dict, dict]] = None) -> dict:
    """An object type with its object, action type and automation counts (`counts`: the action / automation counts by
    type, read once when listing every type)."""
    acts, autos = counts or _type_counts()
    return {**t, "object_count": object_count(t["id"]), "action_type_count": acts.get(t["id"], 0), "automation_count": autos.get(t["id"], 0)}


def _type_counts() -> tuple[dict, dict]:
    acts: dict[str, int] = {}
    autos: dict[str, int] = {}
    for a in _all("action-types"):
        acts[a.get("object_type_id")] = acts.get(a.get("object_type_id"), 0) + 1
    for a in _all("automations"):
        k = (a.get("condition") or {}).get("object_type_id")
        autos[k] = autos.get(k, 0) + 1
    return acts, autos


@router.get("/object-types")
def list_object_types() -> list[dict]:
    with _lock:
        types = auth.visible_resources("object_type", _all("object-types"))
        if "discoverable" in MODEL_HOOKS:
            types = [t for t in types if MODEL_HOOKS["discoverable"](t)]
        counts = _type_counts()
        return [_type_summary(t, counts) for t in types]


@router.post("/object-types")
def create_object_type(req: ObjectTypeIn) -> dict:
    if not req.display_name:
        raise HTTPException(400, "name the object type")
    with _lock:
        api_name = req.api_name or _api_name(req.display_name, True)
        check_api_name(api_name, "object type")
        if any(t["api_name"].lower() == api_name.lower() for t in _all("object-types")):
            raise HTTPException(409, f'an object type with the API name "{api_name}" already exists')
        props = [dump_property(p) for p in req.properties] if req.properties else [
            {"api_name": "id", "display_name": "ID", "type": "string", "description": ""}
        ]
        pk = req.primary_key or props[0]["api_name"]
        title = req.title_property or pk
        _check_properties(props, pk, title)
        status = req.status or "experimental"
        if status == "deprecated" and not (req.deprecation or {}).get("reason"):
            raise HTTPException(400, "say why the object type is deprecated")
        rec = {
            "id": _new_id("ot"),
            "api_name": api_name,
            "display_name": req.display_name.strip(),
            "plural_name": (req.plural_name or f"{req.display_name.strip()}s").strip(),
            "description": (req.description or "").strip(),
            "icon": req.icon or "cube",
            "color": req.color,
            "status": status,
            "properties": props,
            "primary_key": pk,
            "title_property": title,
            "generate_primary_key": req.generate_primary_key if req.generate_primary_key is not None else True,
            "aliases": [a.strip() for a in req.aliases or [] if a.strip()],
            "groups": req.groups or [],
            "visibility": "prominent" if status == "promoted" else req.visibility or "normal",
            "ontology_id": req.ontology_id or "default",
            "implements": req.implements or [],
            "protected": bool(req.protected),
            "created_at": _now(),
        }
        if req.deprecation:
            rec["deprecation"] = req.deprecation
        rec["origin_ontology_id"] = rec["ontology_id"]
        _cascade_status(rec, None, bool(req.apply_status_to_properties))
        _hook("check_type", rec)
        _hook("guard", "object_type", rec["id"], "create", None, rec)
        _put("object-types", rec)
        save_objects(rec["id"], {})
        return _type_summary(rec)


@router.get("/object-types/{type_id}")
def get_object_type(type_id: str) -> dict:
    with _lock:
        return _type_summary(_object_type(type_id))


@router.patch("/object-types/{type_id}")
def update_object_type(type_id: str, req: ObjectTypeIn) -> dict:
    with _lock:
        rec = _object_type(type_id)
        changes = req.model_dump(exclude_unset=True)
        if "api_name" in changes and changes["api_name"] != rec["api_name"]:
            check_api_name(changes["api_name"] or "", "object type")
            if any(t["api_name"].lower() == changes["api_name"].lower() and t["id"] != type_id for t in _all("object-types")):
                raise HTTPException(409, f'an object type with the API name "{changes["api_name"]}" already exists')
        if "primary_key" in changes and changes["primary_key"] != rec["primary_key"] and object_count(type_id):
            raise HTTPException(400, "the primary key cannot change once the object type has objects")
        old = json.loads(json.dumps(rec))
        locked = rec.get("status") in ("active", "promoted")
        if locked and "api_name" in changes and changes["api_name"] != rec["api_name"]:
            raise HTTPException(400, f"the API name of an {rec['status']} object type cannot change: make it experimental first")
        if locked and changes.get("primary_key") not in (None, rec["primary_key"]):
            raise HTTPException(400, f"the primary key of an {rec['status']} object type cannot change")
        cascade = bool(changes.pop("apply_status_to_properties", False))
        if "properties" in changes and changes["properties"] is not None:
            changes["properties"] = [dump_property(p) for p in req.properties or []]
            kept = {p["api_name"] for p in changes["properties"]}
            gone = [p["api_name"] for p in rec["properties"] if p["api_name"] not in kept and p.get("status") == "active"]
            if gone:
                raise HTTPException(400, f"active properties cannot be deleted: make {', '.join(gone)} experimental or deprecated first")
        for k, v in changes.items():
            if v is None:
                continue
            rec[k] = v.strip() if isinstance(v, str) else v
        if rec.get("status") == "deprecated" and not (rec.get("deprecation") or {}).get("reason"):
            raise HTTPException(400, "say why the object type is deprecated")
        if rec.get("status") != "deprecated":
            rec.pop("deprecation", None)
        if rec.get("status") == "promoted" and old.get("status") != "promoted":
            rec["visibility"] = "prominent"
        _check_properties(rec["properties"], rec["primary_key"], rec["title_property"])
        _hook("edits_schema", old, rec)
        if rec.get("security") and "security_schema" in MODEL_HOOKS:
            # secured object types: adding or removing properties needs an owner and keeps the policies valid
            MODEL_HOOKS["security_schema"](old, rec)
        _cascade_status(rec, old, cascade)
        retyped = _retype(old, rec)
        _hook("check_type", rec)
        _hook("guard", "object_type", type_id, "update", old, rec)
        _put("object-types", rec)
        if retyped is not None:
            save_objects(type_id, retyped)
        _hook("status_changed", rec, old)
        return _type_summary(rec)


def _retype(old: dict, new: dict) -> Optional[dict]:
    """When properties change base type, array-ness or struct fields, stored values must convert to the new schema:
    converts them (returned for writing) or refuses with the number of objects whose values do not fit."""
    before = {p["api_name"]: p for p in old["properties"]}
    changed = [p for p in new["properties"] if p["api_name"] in before and not p.get("derived")
               and (before[p["api_name"]]["type"], bool(before[p["api_name"]].get("array")), before[p["api_name"]].get("struct_fields"))
               != (p["type"], bool(p.get("array")), p.get("struct_fields"))]
    if not changed:
        return None
    objs = load_objects(new["id"])
    if not objs:
        return None
    for p in changed:
        bad = 0
        for o in objs.values():
            props = o.get("properties") or {}
            v = props.get(p["api_name"])
            if v is None:
                continue
            try:
                props[p["api_name"]] = coerce_property({**p, "value_type_id": None}, v, p["api_name"])
            except HTTPException:
                bad += 1
        if bad:
            was = before[p["api_name"]]
            raise HTTPException(400, f"IncompatibleFoundryFieldSchemaForPropertyType: {bad} object{'s' if bad > 1 else ''} hold {p['api_name']} values "
                                     f"({was['type']}{' array' if was.get('array') else ''}) that are not valid {p['type']}{' array' if p.get('array') else ''}")
    return objs


@router.get("/object-types/{type_id}/impact")
def object_type_impact(type_id: str) -> dict:
    """What deleting (or breaking) the object type touches: link types, action types, automations, interfaces,
    Workshop modules and the objects, with the properties that received edits."""
    with _lock:
        t = _object_type(type_id)
        links = [{"id": lt["id"], "display_name": lt["display_name"], "status": lt.get("status")} for lt in _all("link-types")
                 if type_id in (lt["source"]["object_type_id"], lt["target"]["object_type_id"])]
        acts = [{"id": a["id"], "display_name": a["display_name"]} for a in _all("action-types") if a.get("object_type_id") == type_id]
        autos = [{"id": a["id"], "name": a.get("name", a["id"])} for a in _all("automations") if (a.get("condition") or {}).get("object_type_id") == type_id]
        ifaces = [i["interface_id"] for i in t.get("implements") or []]
        modules = []
        try:
            import workshop

            for m in workshop.DIR.glob("*.json"):
                rec = _read(m) or {}
                if any(((w.get("config") or {}).get("source") or {}).get("id") == type_id for w in rec.get("widgets") or []):
                    modules.append({"id": rec.get("id"), "name": rec.get("name")})
        except Exception:  # noqa: BLE001
            pass
        n_objects = object_count(type_id)
        edited = edited_properties(type_id)
        return {"objects": n_objects, "link_types": links, "action_types": acts, "automations": autos, "interfaces": ifaces,
                "workshop_modules": modules, "edited_properties": edited, "backing_dataset": (t.get("backing_dataset") or {}).get("name")}


def edited_properties(type_id: str) -> list[str]:
    """Properties that ever received edits (actions, inline edits, imports through actions): re-indexing or changing
    their backing column may lose them unless they are edit-only."""
    out: set[str] = set()
    for e in _read(DIR / "edit-log" / f"{type_id}.json", []) or []:
        if e.get("op") == "modify":
            out.update(e.get("properties") or [])
    return sorted(out)


def _cascade_status(rec: dict, old: Optional[dict], to_properties: bool) -> None:
    """An object type's status flows to its properties: experimental, example and deprecated always, active on request."""
    status = rec.get("status")
    if old is not None and old.get("status") == status and not to_properties:
        return
    target = {"experimental": "experimental", "example": "example", "deprecated": "deprecated"}.get(status or "")
    if status in ("active", "promoted") and to_properties:
        target = "active"
    if not target:
        return
    for p in rec["properties"]:
        if target == "experimental" and p.get("status") in (None, "experimental", "deprecated"):
            continue
        p["status"] = target
        if target == "deprecated":
            p.setdefault("deprecation", {"reason": f"{rec['display_name']} is deprecated"})
        elif "deprecation" in p:
            p.pop("deprecation")


@router.delete("/object-types/{type_id}")
def delete_object_type(type_id: str) -> dict:
    """Deletes the object type, its objects, its action types and the automations watching it."""
    with _lock:
        t = _object_type(type_id)
        if t.get("status") in ("active", "promoted"):
            raise HTTPException(400, f"an {t['status']} object type cannot be deleted: make it experimental or deprecated first")
        _hook("guard", "object_type", type_id, "delete", t, None)
        for a in _all("action-types"):
            if a["object_type_id"] == type_id:
                _path("action-types", a["id"]).unlink(missing_ok=True)
        for a in _all("automations"):
            if a.get("condition", {}).get("object_type_id") == type_id:
                _path("automations", a["id"]).unlink(missing_ok=True)
                (DIR / "runs" / f"{a['id']}.json").unlink(missing_ok=True)
        ontology_store.delete(type_id)
        _path("object-types", type_id).unlink(missing_ok=True)
        _hook("deleted", "object_type", type_id)
        return {"deleted": type_id}


# ------------------------------------------------------------------------------------------------
# objects
# ------------------------------------------------------------------------------------------------


def _coerce(ptype: str, value: Any, label: str) -> Any:
    """A parameter or property value as stored for its type; "" and None are null."""
    if value is None or value == "":
        return None
    try:
        if ptype == "string":
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        if ptype == "timeseries":
            # a series ID, a qualified series ID or a derived series reference: JSON without spaces or newlines
            if isinstance(value, (dict, list)):
                return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
            text = str(value).strip()
            if text.startswith("{"):
                return json.dumps(json.loads(text), separators=(",", ":"), ensure_ascii=False)
            return text
        if ptype == "integer":
            if isinstance(value, bool):
                raise ValueError
            f = float(value)
            if not f.is_integer():
                raise ValueError
            return int(f)
        if ptype == "double":
            if isinstance(value, bool):
                raise ValueError
            return float(value)
        if ptype == "boolean":
            if isinstance(value, bool):
                return value
            if str(value).strip().lower() in ("true", "1", "yes"):
                return True
            if str(value).strip().lower() in ("false", "0", "no"):
                return False
            raise ValueError
        if ptype == "date":
            return date.fromisoformat(str(value)[:10]).isoformat()
        if ptype == "timestamp":
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
        if ptype == "media":
            ref = value.get("id") if isinstance(value, dict) else str(value)
            drive._item(pipeline_ai.parse_ref(ref)[0])
            return ref
        if ptype == "string_array":
            items = value if isinstance(value, list) else [value]
            return [str(v) for v in items if v is not None]
        if ptype in INT_RANGE:
            if isinstance(value, bool):
                raise ValueError
            f = float(value) if not isinstance(value, int) else value
            if isinstance(f, float) and not f.is_integer():
                raise ValueError
            n = int(f)
            if not -INT_RANGE[ptype] <= n < INT_RANGE[ptype]:
                raise ValueError
            return n
        if ptype == "float":
            if isinstance(value, bool):
                raise ValueError
            return float(value)
        if ptype == "decimal":
            # kept as text: no binary rounding
            if isinstance(value, bool):
                raise ValueError
            from decimal import Decimal, InvalidOperation
            try:
                d = Decimal(str(value).strip())
            except InvalidOperation:
                raise ValueError from None
            if not d.is_finite():
                raise ValueError
            return format(d, "f")
        if ptype == "geopoint":
            return geo.geopoint(value)
        if ptype == "geoshape":
            return geo.geoshape(value)
        if ptype == GTSR:
            # a series id; Pipeline Builder's "Create geotemporal series reference" writes {"seriesId", "integrationRid"}
            if isinstance(value, str) and value.strip().startswith("{"):
                value = json.loads(value)
            if isinstance(value, dict):
                value = value.get("seriesId") or value.get("series_id")
            sid = str(value).strip()
            if not 1 <= len(sid) <= 100:
                raise ValueError
            return sid
        if ptype in ("attachment",):
            ref = value.get("id") if isinstance(value, dict) else str(value)
            drive._item(pipeline_ai.parse_ref(ref)[0])
            return ref
        if ptype == "marking":
            text = str(value).strip()
            if not text:
                raise ValueError
            return text
        if ptype == "cipher":
            text = str(value)
            return text if text.startswith("CIPHER::") else "CIPHER::" + text
        if ptype == "vector":
            items = json.loads(value) if isinstance(value, str) else value
            if not isinstance(items, list) or not items or len(items) > MAX_VECTOR:
                raise ValueError
            return [float(x) for x in items]
    except geo.GeoError as e:
        raise HTTPException(400, f"{label}: {e}") from None
    except HTTPException:
        raise HTTPException(400, f"{label}: the media file was not found in Files") from None
    except (ValueError, TypeError):
        pass
    raise HTTPException(400, f"{label}: {str(value)[:60]!r} is not a valid {ptype.replace('_', ' ')}")


def coerce_property(prop: dict, value: Any, label: Optional[str] = None) -> Any:
    """A value for this property as stored: its base type, array, struct fields, vector dimension and value type."""
    label = label or prop.get("display_name") or prop["api_name"]
    if prop.get("array"):
        if value is None or value == "":
            return None
        items = json.loads(value) if isinstance(value, str) and value.strip().startswith("[") else value
        if not isinstance(items, list):
            items = [items]
        if any(v is None or v == "" for v in items):
            raise HTTPException(400, f"{label}: arrays cannot hold null elements")
        out = [coerce_property({**prop, "array": False, "value_type_id": None}, v, label) for v in items]
    elif prop["type"] == "struct":
        if value is None or value == "":
            return None
        raw = json.loads(value) if isinstance(value, str) else value
        if not isinstance(raw, dict):
            raise HTTPException(400, f"{label}: a struct is an object of its fields")
        fields = {f["api_name"]: f for f in prop.get("struct_fields") or []}
        extra = set(raw) - set(fields)
        if extra:
            raise HTTPException(400, f"{label}: unknown struct field {sorted(extra)[0]}")
        out = {k: _coerce(f["type"], raw.get(k), f"{label}.{k}") for k, f in fields.items()}
        if all(v is None for v in out.values()):
            out = None
    else:
        out = _coerce(prop["type"], value, label)
        if prop["type"] == "vector" and out is not None and prop.get("vector_dimension") and len(out) != prop["vector_dimension"]:
            raise HTTPException(400, f"{label}: the vector has {len(out)} dimensions, not {prop['vector_dimension']}")
    if out is not None and prop.get("value_type_id"):
        _hook("value_type", prop["value_type_id"], out, label)
    if out and prop["type"] == "media" and prop.get("media_sources"):
        _check_media_source(prop, out, label)
    if out and prop.get("mandatory_control") and (prop.get("allowed_markings") or prop.get("allowed_organizations")):
        allowed = set(prop.get("allowed_markings") or []) | {f"org:{o}" for o in prop.get("allowed_organizations") or []}
        bad = [v for v in (out if isinstance(out, list) else [out]) if v not in allowed]
        if bad:
            raise HTTPException(400, f"{label}: {bad[0]} is not one of the allowed markings / organizations of this mandatory control")
    return out


def _check_media_source(prop: dict, value: Any, label: str) -> None:
    """A media reference must point into one of the property's media sources."""
    try:
        import db

        if not db.enabled():
            return
    except Exception:  # noqa: BLE001
        return
    for v in value if isinstance(value, list) else [value]:
        item = db.drive_get(str(v).split("#")[0])
        if item and item.get("parent_id") not in prop["media_sources"]:
            raise HTTPException(400, f"{label}: the media item is not in one of the property's media sources")


def _empty(prop: dict, value: Any) -> bool:
    """A required property's value is missing (an empty array counts when the property does not allow it)."""
    if value is None or value == "":
        return True
    return isinstance(value, list) and not value and not prop.get("allow_empty_array")


def _can_see(t: dict, obj: dict) -> bool:
    """Mandatory control properties: the user needs every marking an object's control properties hold. An object
    security policy (ontology_security.py) must pass too."""
    if t.get("security") and "object_policy" in MODEL_HOOKS and not MODEL_HOOKS["object_policy"](t, obj):
        return False
    # mandatory controls of additional datasources secure only that datasource's properties (ontology_mdo.py)
    extra = {api for d in t.get("additional_datasources") or [] for api in d["columns"].values()}
    controls = [p["api_name"] for p in t["properties"] if p.get("mandatory_control") and p["api_name"] not in extra]
    if not controls:
        return True
    principal = auth.current()
    if principal is None or principal.get("service") or not auth.enabled():
        return True
    have = set(principal.get("markings") or set())
    return all(control_ok(obj.get("properties", {}).get(name), have) for name in controls)


def control_ok(value: Any, have: set) -> bool:
    """A mandatory control's value against a user's markings: every marking, and one of the organizations if any."""
    vals = set(value if isinstance(value, list) else [value] if value else [])
    orgs = {v for v in vals if str(v).startswith("org:")}
    return auth.satisfies(vals - orgs, have) and (not orgs or bool(orgs & have))


# consistent snapshots of a function run (functions_registry: header x-bluesandai-snapshot): one point in time for the
# whole run, in every API process that shares the data folder. functions_registry opens the snapshot when the run
# starts (snapshot_open) and closes it when the run ends (snapshot_close). The shared part lives in DIR/snapshots:
#   open/<sha1(id)[:32]>.<start>   one empty file per open snapshot (TTL from its mtime); <start> is the change log
#                                  position the snapshot starts at (one past the newest record when it was opened)
#   log/<seq:012d>.<o|l><sha1(type id)[:16]>.json
#                                  the change log: while any snapshot is open (in any process) every object save and
#                                  join table link write first appends the pre-images of what it changes (copy-on-write:
#                                  only the changed objects; a sharded type reads only their shards). seq is one past the
#                                  newest record, taken with an exclusive create, so a record made after another one
#                                  finished always sorts after it
# A type's first read in a run (in whichever process) is the live data with the pre-images of the records from the
# snapshot's start on put back (an object's first record wins: its state when the run started); that process then keeps
# it frozen for the rest of the run. Objects deleted since the start come back where they were: a delete record names
# each deleted object's predecessor in the type's order at the delete, and the deletes are undone newest first. Reads
# only: writes always start from the live data. A snapshot's close removes the records older than every open snapshot's
# start (the newest one is kept: it carries the counter; records younger than _LOG_KEEP_S stay, for a snapshot being
# opened right now).
SNAPSHOT: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("ontology_snapshot", default=None)
SNAPSHOT_TTL_S = 900
SNAPSHOT_MAX = 256
_ABSENT = object()  # pre-image of an object created after the snapshot started
_LOG_KEEP_S = 2.0


class _Snap:
    __slots__ = ("at", "start", "key", "own", "types", "links")

    def __init__(self, at: float, start: int, key: str, own: bool) -> None:
        self.at = at
        self.start = start  # change log position of the start
        self.key = key  # its name in the shared registry
        self.own = own  # opened by this process (else by another process sharing the data folder)
        self.types: dict[str, dict] = {}  # frozen object types (as of the start)
        self.links: dict[str, list] = {}  # frozen join table links

    @property
    def pre(self) -> dict[str, dict[str, Any]]:
        """type -> {primary key: object as at the start | _ABSENT}: the change log's pre-images of the types this
        process has not read with the snapshot yet."""
        out: dict[str, dict[str, Any]] = {}
        for _, kind, rec in _log_records(self.start, "o"):
            if rec.get("id") in self.types:
                continue
            p = out.setdefault(rec["id"], {})
            for k in rec.get("absent") or ():
                p.setdefault(k, _ABSENT)
            for k, o in (rec.get("pre") or {}).items():
                p.setdefault(k, o)
        return out

    @property
    def link_pre(self) -> dict[str, list]:
        """join table link type -> pairs as at the start, for the link types not read with the snapshot yet."""
        out: dict[str, list] = {}
        for _, kind, rec in _log_records(self.start, "l"):
            if rec.get("id") not in self.links:
                out.setdefault(rec["id"], rec.get("pairs") or [])
        return out


class _SnapTable(dict):
    """This process's snapshots {id: _Snap}; true while a snapshot is open in any process sharing the data folder
    (ontology_datasources checks it before a save, as save_objects does)."""

    def __bool__(self) -> bool:
        return bool(_open_starts())


_SNAPSHOTS: dict[str, _Snap] = _SnapTable()
_snap_lock = threading.Lock()
_log_lock = threading.Lock()
_log_cache: dict[str, dict] = {}  # change log file name -> its record (records never change once written)
_log_memo: dict[tuple, int] = {}  # (type id, primary key) -> seq of this process's newest record of it


def _snap_key(text: str, n: int = 32) -> str:
    import hashlib

    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()[:n]


_pid_alive: dict[int, tuple[float, bool]] = {}


def _host_tag() -> str:
    import socket

    return _snap_key(socket.gethostname(), 8)


def _owner_gone(pid: int, host: str) -> bool:
    """The process that opened a snapshot has ended (only known for processes on this machine; checked every 5 s)."""
    if host != _host_tag() or pid == os.getpid():
        return False
    now = time.monotonic()
    hit = _pid_alive.get(pid)
    if hit is None or now - hit[0] > 5.0:
        try:
            import psutil

            alive = psutil.pid_exists(pid)
        except Exception:  # noqa: BLE001 - psutil missing: rely on the TTL
            alive = True
        hit = _pid_alive[pid] = (now, alive)
    return not hit[1]


def _open_starts() -> dict[str, int]:
    """Open snapshots of every process: {registry key: start}; entries past the TTL, or whose process (on this machine)
    has ended, are removed."""
    try:
        it = os.scandir(DIR / "snapshots" / "open")
    except (FileNotFoundError, NotADirectoryError):
        return {}
    now = time.time()
    out: dict[str, int] = {}
    with it:
        for e in it:
            # <key>.<start>.<pid>.<host tag>
            parts = e.name.split(".")
            key = parts[0]
            try:
                st, age = int(parts[1]), now - e.stat().st_mtime
                pid = int(parts[2]) if len(parts) > 3 else 0
            except (ValueError, IndexError, OSError):
                continue
            if age > SNAPSHOT_TTL_S or (pid and _owner_gone(pid, parts[3])):
                try:
                    os.unlink(e.path)
                except OSError:
                    pass
                continue
            out[key] = max(st, out.get(key, st))
    if not out:
        _idle_gc()
    return out


_idle_gc_at = [0.0]


def _idle_gc() -> None:
    """No snapshot open: now and then (30 s) remove what the change log still holds (records that were too young at
    the last close, or of a snapshot whose process ended without closing it)."""
    now = time.monotonic()
    if now - _idle_gc_at[0] < 30.0:
        return
    _idle_gc_at[0] = now
    if len(_log_names()) > 1:
        _log_gc()


def _unregister(key: str) -> None:
    d = DIR / "snapshots" / "open"
    try:
        names = os.listdir(d)
    except FileNotFoundError:
        return
    for name in names:
        if name.partition(".")[0] == key:
            try:
                os.unlink(d / name)
            except OSError:
                pass


def _log_names() -> list[tuple[int, str]]:
    try:
        names = os.listdir(DIR / "snapshots" / "log")
    except FileNotFoundError:
        return []
    out = []
    for name in names:
        parts = name.split(".")
        if len(parts) == 3 and parts[2] == "json" and parts[0].isdigit():
            out.append((int(parts[0]), name))
    return out


def _log_max() -> int:
    return max((seq for seq, _ in _log_names()), default=0)


def _log_append(kind: str, ident: str, rec: dict) -> int:
    """Append a record to the shared change log (before the write it describes); returns its seq."""
    d = DIR / "snapshots" / "log"
    d.mkdir(parents=True, exist_ok=True)
    body = json.dumps({**rec, "kind": kind, "id": ident}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tag = kind + _snap_key(ident, 16)
    with _log_lock:
        seq = _log_max() + 1
        while True:
            p = d / f"{seq:012d}.{tag}.json"
            try:
                fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0))
            except FileExistsError:
                seq += 1
                continue
            break
        try:
            view = memoryview(body)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
    return seq


def _log_records(start: int, kind: Optional[str] = None, ident: Optional[str] = None) -> list[tuple[int, str, dict]]:
    """The change log's complete records from seq `start` on, oldest first: [(seq, kind, record)]. A record still being
    written is left out: its write has not happened yet, so the live data still shows what it would put back."""
    d = DIR / "snapshots" / "log"
    tag = (kind + _snap_key(ident, 16)) if kind and ident else None
    out = []
    for seq, name in _log_names():
        if seq < start:
            continue
        t = name.split(".")[1]
        if (tag and t != tag) or (kind and not t.startswith(kind)):
            continue
        rec = _log_cache.get(name)
        if rec is None:
            try:
                rec = json.loads((d / name).read_bytes())
            except (OSError, ValueError):
                continue
            if not isinstance(rec, dict) or "id" not in rec:
                continue
            if len(_log_cache) > 4096:
                _log_cache.clear()
            _log_cache[name] = rec
        if ident is not None and rec.get("id") != ident:
            continue
        out.append((seq, t[0], rec))
    out.sort(key=lambda r: r[0])
    return out


def _log_gc() -> None:
    """Remove the records no open snapshot needs (older than every open one's start; never the newest)."""
    starts = _open_starts()
    names = _log_names()
    if not names:
        return
    top = max(seq for seq, _ in names)
    floor = min(starts.values()) if starts else top + 1
    now = time.time()
    d = DIR / "snapshots" / "log"
    for seq, name in names:
        if seq >= floor or seq == top:
            continue
        try:
            if now - os.stat(d / name).st_mtime < _LOG_KEEP_S:
                continue
            os.unlink(d / name)
        except OSError:
            continue
        _log_cache.pop(name, None)


def snapshot_open(snap_id: str) -> None:
    """Start a snapshot now: every type read with it later (in any API process) sees its state as of this moment."""
    _snap(snap_id)
    _log_gc()  # (what earlier runs left: records younger than _LOG_KEEP_S at their close)


def snapshot_close(snap_id: Optional[str]) -> None:
    """The run ended: drop the snapshot's frozen types, unregister it and remove the change log no snapshot needs."""
    snap_id = str(snap_id or "")[:64]
    with _snap_lock:
        s = _SNAPSHOTS.pop(snap_id, None)
    _unregister(s.key if s else _snap_key(snap_id))
    _log_gc()
    if not _open_starts():
        with _snap_lock:
            _log_memo.clear()


def snapshot_info() -> dict:
    """Open snapshots of this process (for tests and diagnostics): {id: {types, pre_images, links, start, own}}."""
    with _snap_lock:
        snaps = list(_SNAPSHOTS.items())
    return {k: {"types": sorted(s.types), "pre_images": {t: len(p) for t, p in s.pre.items()}, "links": sorted(s.links) + sorted(s.link_pre),
                "start": s.start, "own": s.own} for k, s in snaps}


def _snap(snap_id: str) -> _Snap:
    """The open snapshot: this process's, or one another process opened (its start from the shared registry); a header
    naming an unknown one opens it at its first use (TTL and a cap bound the memory)."""
    now = time.monotonic()
    snap_id = str(snap_id)[:64]
    key = _snap_key(snap_id)
    with _snap_lock:
        s = _SNAPSHOTS.get(snap_id)
        if s is not None and s.own:
            return s
        starts = _open_starts()
        if s is not None:
            if s.key in starts:
                return s
            _SNAPSHOTS.pop(snap_id, None)  # its owner closed it
        drop = [k for k, v in _SNAPSHOTS.items() if now - v.at > SNAPSHOT_TTL_S or (not v.own and v.key not in starts)]
        while len(_SNAPSHOTS) - len(drop) >= SNAPSHOT_MAX:
            drop.append(min((k for k in _SNAPSHOTS if k not in drop), key=lambda k: _SNAPSHOTS[k].at))
        for k in drop:
            old = _SNAPSHOTS.pop(k, None)
            if old is not None and old.own:
                _unregister(old.key)
        if key in starts:
            s = _Snap(now, starts[key], key, False)
        else:
            start = _log_max() + 1
            d = DIR / "snapshots" / "open"
            d.mkdir(parents=True, exist_ok=True)
            (d / f"{key}.{start}.{os.getpid()}.{_host_tag()}").touch()
            s = _Snap(now, start, key, True)
        _SNAPSHOTS[snap_id] = s
        return s


def _rebuild(live: dict, first: dict, dels: dict) -> dict:
    """A type as at a snapshot's start: the live objects with the first pre-images put back; objects deleted since are
    put back after their predecessor, undoing the deletes newest first."""
    import copy

    dels = {k: v for k, v in dels.items() if first.get(k, _ABSENT) is not _ABSENT}
    if not dels:
        for pk, old in first.items():
            if old is _ABSENT:
                live.pop(pk, None)
            else:
                live[pk] = copy.deepcopy(old)  # (records are shared by every snapshot reading them)
        return live
    head: Any = object()
    nxt: dict[Any, Any] = {}
    tail = head
    for pk in live:
        if pk in dels or first.get(pk) is _ABSENT:
            continue
        nxt[tail] = pk
        tail = pk
    nxt[tail] = None
    for pk, (_, _, prev) in sorted(dels.items(), key=lambda kv: (-kv[1][0], kv[1][1])):
        after = head if prev is None else prev if prev in nxt else tail
        nxt[pk] = nxt[after]
        nxt[after] = pk
        if after is tail:
            tail = pk
    out: dict[str, dict] = {}
    pk = nxt[head]
    while pk is not None:
        old = first.get(pk, _ABSENT)
        out[pk] = live[pk] if old is _ABSENT else copy.deepcopy(old)
        pk = nxt[pk]
    for pk, old in first.items():
        if old is not _ABSENT and pk not in out:
            out[pk] = copy.deepcopy(old)  # (not expected: a change no record describes)
    return out


def _snapshot_objects(snap_id: str, type_id: str) -> dict[str, dict]:
    s = _snap(snap_id)
    with _snap_lock:
        if type_id in s.types:
            return s.types[type_id]
    # live first, the change log after: a write between the two has appended its record before it wrote
    live = load_objects(type_id)
    first: dict[str, Any] = {}
    dels: dict[str, tuple] = {}
    for seq, _, rec in _log_records(s.start, "o", type_id):
        for k in rec.get("absent") or ():
            first.setdefault(k, _ABSENT)
        for k, o in (rec.get("pre") or {}).items():
            first.setdefault(k, o)
        for i, (k, prev) in enumerate(rec.get("deleted") or ()):
            if k not in dels:
                dels[k] = (seq, i, prev)
    out = _rebuild(live, first, dels) if first else live
    with _snap_lock:
        if type_id in s.types:
            return s.types[type_id]
        s.types[type_id] = out
        return out


def _predecessors(type_id: str, deleted: list, stored: Optional[dict]) -> list:
    """[[primary key, the key before it in the type's order or None]] of the objects about to be deleted, in that order."""
    if not deleted:
        return []
    want = set(deleted)
    order: Any = None
    if stored is None:
        m = ontology_store._manifest(type_id)
        if m is not None:
            try:
                sm = ontology_store._seq_map(type_id, m)  # (a sharded type's order is its seq order)
                order = sorted(sm, key=sm.__getitem__)
            except (OSError, KeyError):
                order = None
        if order is None:
            order = load_objects(type_id)
    else:
        order = stored
    out, last = [], None
    for pk in order:
        if pk in want:
            out.append([pk, last])
        last = pk
    return out


def _snapshot_before_save(type_id: str, objs: dict, changed: Optional[Any]) -> None:
    """Copy-on-write: before a type's objects are written while any snapshot is open (in any process), append the
    changed objects' pre-images (and where deleted ones stood) to the shared change log."""
    starts = _open_starts()
    if not starts:
        return
    hi = max(starts.values())

    def todo(keys: Any) -> set:
        # a key this process recorded since the newest snapshot's start needs no new record (every open snapshot's
        # first record of it is at or before that one); a delete always records (where the object stood)
        with _snap_lock:
            return {k for k in keys if not (k in objs and _log_memo.get((type_id, k), -1) >= hi)}

    stored = None
    if changed is not None:
        keys = todo({str(k) for k in changed})
        if not keys:
            return
        # the store reads only these keys (a sharded type: only their shards)
        old = ontology_store.get_many(type_id, keys)
    else:
        # the whole set is written: compare it with the stored one
        stored = load_objects(type_id)
        keys = todo({pk for pk, o in stored.items() if objs.get(pk, _ABSENT) != o} | {pk for pk in objs if pk not in stored})
        if not keys:
            return
        old = {k: stored[k] for k in keys if k in stored}
    deleted = [k for k in keys if k in old and k not in objs]
    rec = {"pre": {k: old[k] for k in sorted(keys) if k in old}, "absent": sorted(k for k in keys if k not in old),
           "deleted": _predecessors(type_id, deleted, stored)}
    seq = _log_append("o", type_id, rec)
    with _snap_lock:
        if len(_log_memo) > 200_000:
            _log_memo.clear()
        for k in keys:
            if k in objs:
                _log_memo[(type_id, k)] = seq


def _snapshot_before_link_write(path: Path) -> None:
    """Copy-on-write of a join table link file (ontology._write, any module): its pairs as before this write."""
    starts = _open_starts()
    if not starts:
        return
    lt = path.name[:-5]
    with _snap_lock:
        if _log_memo.get(("\0links", lt), -1) >= max(starts.values()):
            return
    seq = _log_append("l", lt, {"pairs": _read(path, []) or []})
    with _snap_lock:
        _log_memo[("\0links", lt)] = seq


def _snapshot_links(snap_id: str, link_type_id: str) -> list:
    s = _snap(snap_id)
    with _snap_lock:
        if link_type_id in s.links:
            return s.links[link_type_id]
    live = _read(DIR / "links" / f"{link_type_id}.json", []) or []
    recs = _log_records(s.start, "l", link_type_id)
    pairs = (recs[0][2].get("pairs") or []) if recs else live
    with _snap_lock:
        if link_type_id not in s.links:
            s.links[link_type_id] = [list(p) for p in pairs]
        return s.links[link_type_id]


def stored_objects(type_id: str) -> dict[str, dict]:
    """An object type's objects as stored (no permission check), seen through the active scenario (and, in a
    function run with snapshots, as they were when the run started)."""
    snap = SNAPSHOT.get()
    objs = _snapshot_objects(snap, type_id) if snap else load_objects(type_id)
    sid = SCENARIO.get()
    if sid and "scenario_objects" in MODEL_HOOKS:
        objs = MODEL_HOOKS["scenario_objects"](sid, type_id, objs)
    return objs


def stored_links(link_type_id: str) -> list:
    """A join table link type's [source, target] pairs, seen through the active scenario (and the run's snapshot)."""
    snap = SNAPSHOT.get()
    pairs = _snapshot_links(snap, link_type_id) if snap else (_read(DIR / "links" / f"{link_type_id}.json", []) or [])
    sid = SCENARIO.get()
    if sid and "scenario_links" in MODEL_HOOKS:
        pairs = MODEL_HOOKS["scenario_links"](sid, link_type_id, pairs)
    return pairs


def _objects(type_id: str) -> dict[str, dict]:
    # every object read (listings, actions, Logic, Workshop widgets, agents) needs the object type's markings
    auth.check_resource("object_type", type_id)
    return stored_objects(type_id)


def _public_object(t: dict, pk: str, obj: dict) -> dict:
    props = obj.get("properties", {})
    reduced = None
    if any(p.get("derived") or p.get("reducers") for p in t["properties"]) and "derive" in MODEL_HOOKS:
        extra = dict(_hook("derive", t, pk, props) or {})
        reduced = extra.pop("__reduced", None)
        props = {**props, **extra}
    hidden = MODEL_HOOKS["property_policy"](t, obj) if t.get("security") and "property_policy" in MODEL_HOOKS else []
    if t.get("additional_datasources") and "mdo_hidden" in MODEL_HOOKS:
        # multi-datasource object types: properties of datasets the user cannot view read as null
        hidden = list(hidden) + MODEL_HOOKS["mdo_hidden"](t, obj)
    if hidden:
        # property security policies: values the user may not see read as null
        props = {k: (None if k in hidden else v) for k, v in props.items()}
    out = {
        "object_type_id": t["id"],
        "primary_key": pk,
        "title": str(props.get(t["title_property"]) if props.get(t["title_property"]) not in (None, "") else pk),
        "properties": props,
        "created_at": obj.get("created_at"),
        "updated_at": obj.get("updated_at"),
    }
    if reduced:
        # array properties with reducers: the element shown where one value is expected
        out["reduced"] = reduced
    if hidden:
        out["hidden_properties"] = sorted(hidden)
    if t.get("security") and "property_markings" in MODEL_HOOKS:
        # property security markings: informational, what each property's security policy requires
        marks = MODEL_HOOKS["property_markings"](t, obj)
        if marks:
            out["property_markings"] = marks
    return out


def _as_build(request: Optional[Request], op: str, kind: str, rid: str) -> None:
    """A call made for a build (service token + X-Bsai-Build): as the build's identity — the object type's markings
    and the ontology role (Viewer reads, Editor edits; applying an action: Viewer, as for a user); refused with the
    reason."""
    import build_calls

    build_calls.enforce(request, (op, kind, rid, None))


def _for_build(request: Optional[Request]) -> Any:
    """The rest of a call made for a build runs as the build's identity (build_calls.acting_for): its objects as that
    user sees them (object / property security policies, restricted views applied to the type, mandatory controls),
    an action under that user's permissions and submission criteria. Other calls: unchanged."""
    import build_calls

    return build_calls.acting_for(request)


def _find(t: dict, pk: Any) -> tuple[str, dict]:
    key = str(pk)
    obj = _objects(t["id"]).get(key)
    if obj is None or not _can_see(t, obj):
        raise HTTPException(404, f'{t["display_name"]} "{key}" not found')
    return key, obj


@router.get("/object-types/{type_id}/objects")
def list_objects(type_id: str, q: str = "", limit: int = 500, request: Request = None) -> dict:  # type: ignore[assignment]
    _as_build(request, "read", "object_type", type_id)
    with _for_build(request), _lock:
        t = _object_type(type_id)
        rows = [_public_object(t, pk, o) for pk, o in _objects(type_id).items() if _can_see(t, o)]
    _hook("query", "base", [type_id], len(rows))
    needle = q.strip().lower()
    if needle:
        rows = [r for r in rows if needle in r["title"].lower() or needle in r["primary_key"].lower()
                or any(needle in str(v).lower() for v in r["properties"].values())]
    rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return {"total": len(rows), "objects": rows[: max(1, min(limit, 5000))]}


@router.get("/object-types/{type_id}/objects/{pk}")
def get_object(type_id: str, pk: str, request: Request = None) -> dict:  # type: ignore[assignment]
    _as_build(request, "read", "object_type", type_id)
    with _for_build(request), _lock:
        t = _object_type(type_id)
        key, obj = _find(t, pk)
        return _public_object(t, key, obj)


@router.delete("/object-types/{type_id}/objects/{pk}")
def delete_object(type_id: str, pk: str, request: Request = None) -> dict:  # type: ignore[assignment]
    _as_build(request, "write", "object_type", type_id)
    with _for_build(request), _lock:
        t = _object_type(type_id)
        _find(t, pk)
        apply_edits([{"op": "delete", "object_type_id": type_id, "primary_key": pk}], source=None)
        return {"deleted": pk}


@router.get("/media-folder")
def media_folder(object_type_id: Optional[str] = None, property: Optional[str] = None) -> dict:
    """Where files uploaded for a media property go: its upload destination (or first media source), else
    My Project / Ontology."""
    if object_type_id and property:
        t = _object_type(object_type_id)
        p = next((x for x in t["properties"] if x["api_name"] == property), None)
        if p and (p.get("upload_destination") or p.get("media_sources")):
            return {"id": p.get("upload_destination") or p["media_sources"][0], "media_set": True}
    return {"id": drive.default_folder("ontology")}


# ------------------------------------------------------------------------------------------------
# edits
# ------------------------------------------------------------------------------------------------


def apply_edits(edits: list[dict], source: Optional[str], depth: int = 0) -> list[dict]:
    """Write ontology edits; returns the objects as written. Fires automations (except `source`)."""
    if SNAPSHOT.get() is None:
        return _apply_edits(edits, source, depth)
    # inside a function run's snapshot (a Logic run, a nested query): writes start from the live data, never a frozen copy
    token = SNAPSHOT.set(None)
    try:
        return _apply_edits(edits, source, depth)
    finally:
        SNAPSHOT.reset(token)


def _apply_edits(edits: list[dict], source: Optional[str], depth: int = 0) -> list[dict]:
    # edit events for automations: {kind: created | modified | deleted, object_type_id, pk, before, after} (automate.py)
    events: list[dict] = []
    written: list[dict] = []
    # what each edit changed, with the values before (ontology_edits.py keeps user edits apart from the datasource)
    records: list[dict] = []
    with _lock:
        by_type: dict[str, dict] = {}
        for e in edits:
            tid = e["object_type_id"]
            t = _object_type(tid)
            if tid not in by_type and not SCENARIO.get():
                _hook("edits_allowed", t)
            fresh = tid not in by_type
            objs = by_type.setdefault(tid, _objects(tid))
            if fresh and hasattr(objs, "prefetch"):
                # a live type: every object these edits touch read in one query, not one per edit
                objs.prefetch(str(x["primary_key"]) for x in edits if x["object_type_id"] == tid)
            pk = str(e["primary_key"])
            now = _now()
            if e["op"] == "delete":
                gone = objs.pop(pk, None)
                if gone is not None:
                    written.append({"op": "delete", "object_type_id": tid, "primary_key": pk})
                    records.append({"op": "delete", "object_type_id": tid, "primary_key": pk, "before": dict(gone.get("properties") or {}), "after": None, "changed": {}})
                    events.append({"kind": "deleted", "object_type_id": tid, "pk": pk, "before": dict(gone.get("properties") or {}), "after": None})
                continue
            if e["op"] == "create" and pk in objs:
                raise HTTPException(409, f'{t["display_name"]} "{pk}" already exists')
            if e["op"] == "modify" and pk not in objs:
                raise HTTPException(404, f'{t["display_name"]} "{pk}" not found')
            obj = objs.get(pk) or {"properties": {}, "created_at": now}
            before = dict(obj["properties"]) if pk in objs else None
            obj["properties"] = {**obj["properties"], **e.get("properties", {})}
            obj["properties"][t["primary_key"]] = int(pk) if _ptype(t, t["primary_key"]) == "integer" else pk
            obj["updated_at"] = now
            objs[pk] = obj
            records.append({"op": e["op"], "object_type_id": tid, "primary_key": pk, "before": before, "after": dict(obj["properties"]),
                            "changed": dict(obj["properties"]) if e["op"] == "create" else dict(e.get("properties", {}))})
            written.append({"op": e["op"], **_public_object(t, pk, obj)})
            events.append({"kind": "created" if e["op"] == "create" else "modified", "object_type_id": tid, "pk": pk, "before": before, "after": dict(obj["properties"])})
        sid = SCENARIO.get()
        if sid and "scenario_write" in MODEL_HOOKS:
            # a scenario is a sandbox: no edit history, indexing or automations on main
            MODEL_HOOKS["scenario_write"](sid, by_type, written)
            return written
        changed: dict[str, set] = {}
        for w in written:
            changed.setdefault(w["object_type_id"], set()).add(str(w["primary_key"]))
        for tid, objs in by_type.items():
            save_objects(tid, objs, changed.get(tid, set()))
        _hook("user_edits", records)
    _hook("edits", written)
    if depth < MAX_DEPTH:
        _fire(events, source, depth)
    return written


def _ptype(t: dict, api_name: str) -> Optional[str]:
    return next((p["type"] for p in t["properties"] if p["api_name"] == api_name), None)


# ------------------------------------------------------------------------------------------------
# action types
# ------------------------------------------------------------------------------------------------


class Parameter(BaseModel):
    # rule-based action types (ontology_actions.py) add description, visibility, default, allowed values, object
    # filters, overrides, object_type_id / interface_id and more
    model_config = ConfigDict(extra="allow")
    id: str = Field(max_length=100)
    display_name: str = Field(max_length=200)
    # a property type, or "object" (the object an action modifies or deletes)
    type: str
    required: bool = False
    # the property this parameter writes; None for the "object" parameter
    property: Optional[str] = None
    array: Optional[bool] = None
    # constrains the values further (Value Types)
    value_type_id: Optional[str] = None
    # "current_user": an empty value becomes the user applying the action
    prefill: Optional[Literal["current_user"]] = None
    type_classes: Optional[list[str]] = None


class ActionTypeIn(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    object_type_id: Optional[str] = None
    # "rules": a rule-based action type (rules, sections, submission criteria, side effects: ontology_actions.py)
    kind: Optional[Literal["create", "modify", "delete", "rules"]] = None
    description: Optional[str] = Field(None, max_length=2000)
    parameters: Optional[list[Parameter]] = None
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    # "actions:generate_uuid", "actions:prefill_current_user", "hubble-oe:hide-action", "actions:view_object_with_type"
    type_classes: Optional[list[str]] = None
    # an action on an interface (its rules create, modify or delete objects of implementing types)
    interface_id: Optional[str] = None
    rules: Optional[list[dict]] = None
    sections: Optional[list[dict]] = None
    submission_criteria: Optional[list[dict]] = None
    # {revertible, action_log: {enabled, object_type_id, summary, log_parameters}, isolation, batched_function}
    capabilities: Optional[dict] = None
    # {apply: ["everyone" | "user:<id>" | "group:<id>"], notification_permissions: "all" | "any"}
    permissions: Optional[dict] = None
    # {read_markings: [...], write_markings: [...]}
    authorizations: Optional[dict] = None
    # [{kind: "p95_ms" | "failures", threshold, window_minutes}]
    monitors: Optional[list[dict]] = None

RULE_FIELDS = ("interface_id", "rules", "sections", "submission_criteria", "capabilities", "permissions", "authorizations", "monitors")


def _default_parameters(t: dict, kind: str) -> list[dict]:
    params: list[dict] = []
    if kind in ("modify", "delete"):
        params.append({"id": "object", "display_name": t["display_name"], "type": "object", "required": True, "property": None})
    if kind == "delete":
        return params
    for p in t["properties"]:
        if kind == "modify" and p["api_name"] == t["primary_key"]:
            continue
        if p["type"] in NO_ACTION_TYPES or p.get("derived"):
            continue
        is_pk = p["api_name"] == t["primary_key"]
        params.append({
            "id": p["api_name"],
            "display_name": p["display_name"],
            "type": p["type"],
            "required": (is_pk and not (t.get("generate_primary_key") and p["type"] == "string")) or (kind == "create" and bool(p.get("required"))),
            "property": p["api_name"],
        })
    return params


def _check_parameters(t: dict, kind: str, params: list[dict]) -> None:
    ids = [p["id"] for p in params]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "parameter ids must be unique")
    by = {p["api_name"]: p for p in t["properties"]}
    for p in params:
        if not IDENT.match(p["id"]):
            raise HTTPException(400, f'"{p["id"]}" is not a valid parameter id')
        if p["type"] == "object":
            continue
        if p.get("property") not in by:
            raise HTTPException(400, f'parameter {p["id"]} must write one of {t["display_name"]}\'s properties')
        prop = by[p["property"]]
        if prop["type"] in NO_ACTION_TYPES:
            raise HTTPException(400, f'{prop["display_name"]} is a {prop["type"]} property: those cannot be used in action types (use integer or double)')
        if prop.get("derived"):
            raise HTTPException(400, f'{prop["display_name"]} is derived from linked objects: actions cannot write it')
        p["type"] = prop["type"]
        if prop.get("array"):
            p["array"] = True
        else:
            p.pop("array", None)
        # a parameter may narrow its values further with its own value type
        if p.get("value_type_id") and "value_type" in MODEL_HOOKS:
            _hook("value_type", p["value_type_id"], None, p["display_name"])
    if kind in ("modify", "delete") and not any(p["type"] == "object" for p in params):
        raise HTTPException(400, f"a {kind} action needs the object parameter")


def _action_type(action_id: str) -> dict:
    a = _get("action-types", action_id, "action type")
    # an action type changes objects of its object type: the same markings (interface actions have none)
    if a.get("object_type_id"):
        auth.check_resource("object_type", a["object_type_id"])
    return a


@router.get("/action-types")
def list_action_types(object_type_id: Optional[str] = None) -> list[dict]:
    with _lock:
        types = auth.visible_resources("object_type", _all("object-types"))
        visible = {t["id"] for t in types}
        # interface actions apply to every object type implementing the interface
        implemented = {i["interface_id"] for t in types if t["id"] == object_type_id for i in t.get("implements") or []}
        out = []
        for a in _all("action-types"):
            if a.get("object_type_id"):
                if a["object_type_id"] in visible and (not object_type_id or a["object_type_id"] == object_type_id):
                    out.append(a)
            elif not object_type_id or a.get("interface_id") in implemented:
                out.append(a)
        return out


@router.post("/action-types")
def create_action_type(req: ActionTypeIn) -> dict:
    if req.kind == "rules":
        if not req.object_type_id and not req.interface_id:
            raise HTTPException(400, "a rule-based action type acts on an object type or an interface")
        with _lock:
            t = _object_type(req.object_type_id) if req.object_type_id else None
            name = (req.display_name or "New action").strip()
            rec = {"id": _new_id("act"), "display_name": name, "api_name": _api_name(name, False), "object_type_id": t["id"] if t else None,
                   "kind": "rules", "description": (req.description or "").strip(),
                   "parameters": [p.model_dump(exclude_none=True) for p in req.parameters or []], "status": req.status or "experimental",
                   "type_classes": req.type_classes or [], "version": 1, "created_at": _now()}
            for k in RULE_FIELDS:
                v = getattr(req, k)
                rec[k] = v if v is not None else ({} if k in ("capabilities", "permissions", "authorizations") else None if k == "interface_id" else [])
            _hook("check_action", rec)
            _hook("guard", "action_type", rec["id"], "create", None, rec)
            return _put("action-types", rec)
    if not req.object_type_id or not req.kind:
        raise HTTPException(400, "an action type needs an object type and a kind")
    with _lock:
        t = _object_type(req.object_type_id)
        verb = {"create": "Create", "modify": "Edit", "delete": "Delete"}[req.kind]
        name = (req.display_name or f"{verb} {t['display_name']}").strip()
        params = [p.model_dump(exclude_none=True) for p in req.parameters] if req.parameters is not None else _default_parameters(t, req.kind)
        _check_parameters(t, req.kind, params)
        rec = {
            "id": _new_id("act"),
            "display_name": name,
            "api_name": _api_name(name, False),
            "object_type_id": t["id"],
            "kind": req.kind,
            "description": (req.description or "").strip(),
            "parameters": params,
            "status": req.status or "experimental",
            "type_classes": req.type_classes or [],
            "version": 1,
            "created_at": _now(),
        }
        for k in RULE_FIELDS:
            v = getattr(req, k)
            if v is not None and k not in ("rules", "interface_id"):
                rec[k] = v
        _hook("check_action", rec)
        _hook("guard", "action_type", rec["id"], "create", None, rec)
        return _put("action-types", rec)


@router.get("/action-types/{action_id}")
def get_action_type(action_id: str) -> dict:
    with _lock:
        return _action_type(action_id)


@router.patch("/action-types/{action_id}")
def update_action_type(action_id: str, req: ActionTypeIn) -> dict:
    with _lock:
        rec = _action_type(action_id)
        old = json.loads(json.dumps(rec))
        t = _object_type(rec["object_type_id"]) if rec.get("object_type_id") else None
        if req.display_name:
            rec["display_name"] = req.display_name.strip()
            if rec.get("status") != "active":
                rec["api_name"] = _api_name(rec["display_name"], False)
        if req.description is not None:
            rec["description"] = req.description.strip()
        if req.parameters is not None:
            params = [p.model_dump(exclude_none=True) for p in req.parameters]
            if rec["kind"] != "rules":
                _check_parameters(t, rec["kind"], params)
            rec["parameters"] = params
        if req.status is not None:
            rec["status"] = req.status
        if req.type_classes is not None:
            rec["type_classes"] = req.type_classes
        if req.kind == "rules" and rec["kind"] != "rules":
            # converting a create / modify / delete action type into a rule-based one
            rec["kind"] = "rules"
        for k in RULE_FIELDS:
            v = getattr(req, k)
            if v is not None and not (k in ("rules", "interface_id") and rec["kind"] != "rules"):
                rec[k] = v
        # every saved change makes a new action type version (recorded in action logs)
        rec["version"] = int(rec.get("version") or 1) + 1
        _hook("check_action", rec)
        _hook("guard", "action_type", action_id, "update", old, rec)
        return _put("action-types", rec)


@router.delete("/action-types/{action_id}")
def delete_action_type(action_id: str) -> dict:
    with _lock:
        a = _action_type(action_id)
        if a.get("status") == "active":
            raise HTTPException(400, "an active action type cannot be deleted: make it experimental or deprecated first")
        _hook("guard", "action_type", action_id, "delete", a, None)
        _path("action-types", action_id).unlink(missing_ok=True)
        return {"deleted": action_id}


def _has_class(rec: dict, name: str) -> bool:
    return any(tc.split(":", 1)[-1] == name for tc in rec.get("type_classes") or [])


def action_edits(action: dict, values: dict[str, Any]) -> list[dict]:
    """The edits an action makes with these parameter values (validated, nothing written)."""
    if action.get("kind") == "rules":
        return _hook("action_edits", action, values) or []
    t = _object_type(action["object_type_id"])
    props: dict[str, Any] = {}
    target: Optional[str] = None
    for p in action["parameters"]:
        raw = values.get(p["id"])
        if p["type"] == "object":
            if isinstance(raw, dict):
                raw = raw.get("primary_key")
            if raw in (None, ""):
                raise HTTPException(400, f'{p["display_name"]} is required')
            target, _ = _find(t, raw)
            continue
        prop = next((x for x in t["properties"] if x["api_name"] == p["property"]), None) or {"api_name": p["property"], "type": p["type"]}
        if raw in (None, "") and _has_class(action, "generate_uuid") and prop["type"] == "string" and p["property"] == t["primary_key"]:
            raw = str(uuid.uuid4())
        if raw in (None, "") and (p.get("prefill") == "current_user" or _has_class(p, "prefill_current_user")):
            raw = auth.actor_id() or (auth.current() or {}).get("username") or "local"
        value = coerce_property(prop, raw, p["display_name"])
        if value is not None and p.get("value_type_id"):
            _hook("value_type", p["value_type_id"], value, p["display_name"])
        if (p.get("required") or prop.get("required")) and _empty(prop, value) and (p["id"] in values or p.get("required")):
            raise HTTPException(400, f'{p["display_name"]} is required')
        if p["id"] in values or value is not None:
            props[p["property"]] = value
    if action["kind"] == "create":
        missing = [x["display_name"] for x in t["properties"] if x.get("required") and not x.get("derived")
                   and x["api_name"] != t["primary_key"] and _empty(x, props.get(x["api_name"]))]
        if missing:
            raise HTTPException(400, f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} required on every {t['display_name']}")
        pk = props.get(t["primary_key"])
        if pk is None:
            if not t.get("generate_primary_key") or _ptype(t, t["primary_key"]) != "string":
                raise HTTPException(400, f"{t['primary_key']} (the primary key) is required")
            pk = str(uuid.uuid4())
            props[t["primary_key"]] = pk
        return [{"op": "create", "object_type_id": t["id"], "primary_key": str(pk), "properties": props}]
    if action["kind"] == "modify":
        props.pop(t["primary_key"], None)
        return [{"op": "modify", "object_type_id": t["id"], "primary_key": target, "properties": props}]
    return [{"op": "delete", "object_type_id": t["id"], "primary_key": target}]


class ApplyAction(BaseModel):
    parameters: dict[str, Any] = {}


@router.post("/action-types/{action_id}/apply")
def apply_action(action_id: str, req: ApplyAction, request: Request = None) -> dict:  # type: ignore[assignment]
    with _lock:
        action = _action_type(action_id)
    _as_build(request, "write", "action_type", action_id)
    with _for_build(request):
        if "apply_action" in MODEL_HOOKS:
            # submission criteria, rules, side effects, logs, metrics and reverts (ontology_actions.py); for a build
            # as its user: their permissions, criteria and the objects they may see
            return MODEL_HOOKS["apply_action"](action, req.parameters)
        with _lock:
            edits = action_edits(action, req.parameters)
        _hook("query", "action", [action["object_type_id"]], len(edits))
        return {"edits": apply_edits(edits, source=None)}


def run_action(action: dict, values: dict[str, Any], source: Optional[str] = None, depth: int = 0) -> list[dict]:
    """Apply an action for an automation, agent or other caller; returns the edits written."""
    if "apply_action" in MODEL_HOOKS:
        return MODEL_HOOKS["apply_action"](action, values, source=source, depth=depth)["edits"]
    with _lock:
        edits = action_edits(action, values)
    return apply_edits(edits, source, depth)


# ------------------------------------------------------------------------------------------------
# AIP Logic
# ------------------------------------------------------------------------------------------------


class LogicIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    # [{name, type, object_type_id?, required}]
    inputs: Optional[list[dict]] = None
    # [{id, name, type, config}]
    blocks: Optional[list[dict]] = None
    # the block whose value the function returns; default the last
    output: Optional[str] = None


def _check_logic(rec: dict) -> None:
    names: set[str] = set()
    for i in rec["inputs"]:
        if not IDENT.match(i.get("name") or ""):
            raise HTTPException(400, f'input "{i.get("name")}" needs a variable name (letters, digits, _)')
        if i.get("type") not in INPUT_TYPES:
            raise HTTPException(400, f'input {i["name"]}: unknown type {i.get("type")}')
        if i["type"] == "object" and not i.get("object_type_id"):
            raise HTTPException(400, f'input {i["name"]}: pick an object type')
        if i["name"] in names:
            raise HTTPException(400, f'the name {i["name"]} is used twice')
        names.add(i["name"])
    for b in rec["blocks"]:
        if b.get("type") not in BLOCK_TYPES:
            raise HTTPException(400, f'unknown block type {b.get("type")}')
        if not IDENT.match(b.get("name") or ""):
            raise HTTPException(400, f'block "{b.get("name")}" needs a variable name (letters, digits, _)')
        if b["name"] in names:
            raise HTTPException(400, f'the name {b["name"]} is used twice')
        names.add(b["name"])
        b.setdefault("id", uuid.uuid4().hex[:8])
        b.setdefault("config", {})


def _logic(logic_id: str, need: str = "viewer") -> dict:
    """A Logic function the caller has the role `need` on (the roles of its ontology, as object types)."""
    rec = _get("logic", logic_id, "Logic function")
    _logic_role(rec, need)
    return rec


def _logic_role(rec: dict, need: str) -> None:
    import ontology_model

    ontology_model.require_role(rec.get("ontology_id"), need, rec, "edit this Logic function" if need != "viewer" else "use this Logic function")


def _logic_summary(rec: dict) -> dict:
    runs = _read(DIR / "runs" / f"{rec['id']}.json", [])
    return {**rec, "run_count": len(runs), "last_run": runs[0] if runs else None}


@router.get("/logic")
def list_logic() -> list[dict]:
    import ontology_model

    with _lock:
        return [_logic_summary(r) for r in _all("logic") if ontology_model.discoverable(r)]


@router.post("/logic")
def create_logic(req: LogicIn) -> dict:
    with _lock:
        rec = {
            "id": _new_id("logic"),
            "name": (req.name or "Untitled Logic").strip(),
            "description": (req.description or "").strip(),
            "inputs": req.inputs or [],
            "blocks": req.blocks or [],
            "output": req.output,
            "created_at": _now(),
            "created_by": auth.actor_id(),
        }
        _logic_role(rec, "editor")
        _check_logic(rec)
        return _logic_summary(_put("logic", rec))


@router.get("/logic/{logic_id}")
def get_logic(logic_id: str) -> dict:
    with _lock:
        return _logic_summary(_logic(logic_id))


@router.put("/logic/{logic_id}")
def save_logic(logic_id: str, req: LogicIn) -> dict:
    with _lock:
        rec = _logic(logic_id, "editor")
        for k, v in req.model_dump(exclude_unset=True).items():
            rec[k] = v.strip() if isinstance(v, str) else v
        _check_logic(rec)
        return _logic_summary(_put("logic", rec))


@router.delete("/logic/{logic_id}")
def delete_logic(logic_id: str) -> dict:
    with _lock:
        _logic(logic_id, "editor")
        _path("logic", logic_id).unlink(missing_ok=True)
        (DIR / "runs" / f"{logic_id}.json").unlink(missing_ok=True)
        return {"deleted": logic_id}


class _Ctx:
    def __init__(self) -> None:
        self.vars: dict[str, Any] = {}

    def lookup(self, path: str) -> Any:
        head, *rest = path.split(".")
        if head not in self.vars:
            raise ValueError(f'"{head}" is not an input or an earlier block')
        value = self.vars[head]
        for key in rest:
            if isinstance(value, dict) and "properties" in value and "primary_key" in value:
                value = value["primary_key"] if key == "primaryKey" else value["properties"].get(key)
            elif isinstance(value, dict):
                value = value.get(key)
            else:
                raise ValueError(f'"{path}": {key} is not a property')
        return value

    def expr(self, e: Any) -> Any:
        """{"var": "inputPdf.PDF"} reads a variable, {"value": x} is a literal; a bare value is literal."""
        if isinstance(e, dict) and "var" in e:
            return self.lookup(str(e["var"]))
        if isinstance(e, dict) and "value" in e:
            return e["value"]
        return e

    def template(self, text: str) -> str:
        def sub(m: re.Match) -> str:
            v = self.lookup(m.group(1))
            if isinstance(v, dict) and "properties" in v:
                v = v["properties"]
            return v if isinstance(v, str) else "" if v is None else json.dumps(v, ensure_ascii=False)

        return VAR.sub(sub, text or "")


def _media_id(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("id") or value.get("primary_key")
    if not value:
        raise ValueError("no media: the PDF value is empty")
    return str(value)


def _extract_pdf(ctx: _Ctx, cfg: dict) -> list[str]:
    ref = _media_id(ctx.expr(cfg.get("media")))
    item_id, only_page, _ = pipeline_ai.parse_ref(ref)
    item = drive._item(item_id)
    data = drive.read_bytes(item)
    if not (item["name"].lower().endswith(".pdf") or data[:4] == b"%PDF"):
        raise ValueError(f'{item["name"]} is not a PDF')
    total = pipeline_ai._pages(data)
    start = int(ctx.expr(cfg.get("start_page")) or only_page or 1)
    end = int(ctx.expr(cfg.get("end_page")) or only_page or total)
    start, end = max(1, start), min(total, end)
    if start > end:
        raise ValueError(f"no pages between {start} and {end} (the PDF has {total})")
    if cfg.get("method") == "ocr":
        end = min(end, start + MAX_OCR_PAGES - 1)
        return [pipeline_ai._ocr_image(pipeline_ai._render_pdf_page(data, n)) for n in range(start, end + 1)]
    return pipeline_ai._pdf_raw(data)[start - 1 : end]


def _run_block(ctx: _Ctx, b: dict, edits: list[dict]) -> Any:
    cfg = b.get("config") or {}
    kind = b["type"]
    if kind == "extract_pdf_text":
        try:
            return _extract_pdf(ctx, cfg)
        except Exception:
            if cfg.get("on_error") == "null":
                return None
            raise
    if kind == "join_array":
        arr = ctx.expr(cfg.get("array"))
        if arr is None:
            return None
        if not isinstance(arr, list):
            arr = [arr]
        sep = cfg.get("separator", "\n")
        sep = sep.encode().decode("unicode_escape") if "\\" in sep else sep
        return sep.join("" if v is None else str(v) for v in arr)
    if kind == "text_template":
        return ctx.template(cfg.get("template", ""))
    if kind == "semantic_search":
        # retrieval for ontology-augmented generation: the k most relevant objects, or their text joined as context
        import ontology_semantic

        t = _object_type(cfg.get("object_type_id") or "")
        query = ctx.expr(cfg.get("query"))
        if query in (None, ""):
            return [] if not cfg.get("text_property") else ""
        # semantic mode with a current ANN index reads only the top hits' records (rank_type / knn_fast)
        found, _ = ontology_semantic.rank_type(t, str(query), cfg.get("mode") or "semantic", int(cfg.get("k") or 5),
                                               cfg.get("vector_property"))
        if cfg.get("text_property"):
            return "\n\n".join(f"[{r['title']}] {r['properties'].get(cfg['text_property']) or ''}" for r in found)
        return [{k: v for k, v in r.items() if k != "ranks"} for r in found]
    if kind == "use_llm":
        output = cfg.get("output") or "string"
        if output not in LLM_OUTPUTS:
            raise ValueError(f"unknown output type {output}")
        prompt = ctx.template(cfg.get("prompt", ""))
        if not prompt.strip():
            raise ValueError("the prompt is empty")
        return pipeline_ai.chat(
            cfg.get("model") or DEFAULT_LLM,
            ctx.template(cfg.get("system", "")),
            prompt,
            LLM_OUTPUTS[output],
            float(cfg.get("temperature") or 0),
            int(cfg.get("max_tokens") or 4096),
        )
    if kind == "apply_action":
        action = _action_type(cfg.get("action_type_id") or "")
        values = {pid: ctx.expr(e) for pid, e in (cfg.get("parameters") or {}).items()}
        made = action_edits(action, values)
        edits.extend(made)
        return {"action": action["display_name"], "edits": made}
    raise ValueError(f"unknown block type {kind}")


def _input_value(i: dict, raw: Any) -> Any:
    if raw is None or raw == "":
        if i.get("required", True):
            raise HTTPException(400, f'input {i["name"]} is required')
        return None
    if i["type"] == "object":
        t = _object_type(i["object_type_id"])
        pk = raw.get("primary_key") if isinstance(raw, dict) else raw
        key, obj = _find(t, pk)
        return _public_object(t, key, obj)
    return _coerce(i["type"], raw, i["name"])


def run_logic(logic_id: str, inputs: dict[str, Any], apply: bool, source: Optional[str] = None,
              depth: int = 0, trigger: Optional[dict] = None, scenario: Optional[dict] = None) -> dict:
    """Run a Logic function; with `apply` its edits are written. The run is recorded."""
    rec = _logic(logic_id)
    started = time.monotonic()
    ctx = _Ctx()
    steps: list[dict] = []
    edits: list[dict] = []
    result: dict[str, Any] = {"status": "succeeded", "error": None}
    try:
        for i in rec["inputs"]:
            ctx.vars[i["name"]] = _input_value(i, inputs.get(i["name"]))
        for b in rec["blocks"]:
            t0 = time.monotonic()
            step = {"block_id": b["id"], "name": b["name"], "type": b["type"]}
            try:
                value = _run_block(ctx, b, edits)
            except HTTPException as e:
                step.update(error=str(e.detail), ms=int((time.monotonic() - t0) * 1000))
                steps.append(step)
                raise ValueError(f'{b["name"]}: {e.detail}') from None
            except Exception as e:  # noqa: BLE001
                step.update(error=str(e)[:500], ms=int((time.monotonic() - t0) * 1000))
                steps.append(step)
                raise ValueError(f'{b["name"]}: {str(e)[:500]}') from None
            ctx.vars[b["name"]] = value
            step.update(output=value, ms=int((time.monotonic() - t0) * 1000))
            steps.append(step)
        out_name = rec.get("output") or (rec["blocks"][-1]["name"] if rec["blocks"] else None)
        result["output"] = ctx.vars.get(out_name) if out_name else None
        result["applied"] = apply_edits(edits, source, depth) if apply and edits else []
    except HTTPException as e:
        result.update(status="failed", error=str(e.detail))
    except Exception as e:  # noqa: BLE001
        result.update(status="failed", error=str(e)[:500])
    result.update(
        id=_new_id("run"),
        logic_id=logic_id,
        at=_now(),
        ms=int((time.monotonic() - started) * 1000),
        apply=apply,
        inputs={k: (v["primary_key"] if isinstance(v, dict) and "primary_key" in v else v) for k, v in ctx.vars.items()
                if k in {i["name"] for i in rec["inputs"]}},
        steps=steps,
        edits=edits,
        trigger=trigger,
        scenario=scenario,
    )
    _record_run(logic_id, result)
    return result


def _record_run(key: str, run: dict) -> None:
    # outputs can be whole books: keep the stored copy small
    small = json.loads(json.dumps(run, ensure_ascii=False, default=str))
    for s in small.get("steps", []):
        out = s.get("output")
        if isinstance(out, str) and len(out) > 4000:
            s["output"] = out[:4000] + f"… ({len(out):,} characters)"
        elif isinstance(out, list) and len(json.dumps(out, default=str)) > 4000:
            s["output"] = [o[:1000] + "…" if isinstance(o, str) and len(o) > 1000 else o for o in out[:5]]
            s["truncated"] = len(out)
    if isinstance(small.get("output"), str) and len(small["output"]) > 4000:
        small["output"] = small["output"][:4000] + "…"
    with _lock:
        path = DIR / "runs" / f"{key}.json"
        runs = _read(path, [])
        _write(path, [small, *runs][:RUNS_KEPT])


class RunLogic(BaseModel):
    inputs: dict[str, Any] = {}
    apply: bool = False
    # run inside an Ontology scenario: reads see it and applied edits go to it, not to main
    scenario_id: Optional[str] = None


@router.post("/logic/{logic_id}/run")
def run_logic_route(logic_id: str, req: RunLogic) -> dict:
    if not req.scenario_id:
        return run_logic(logic_id, req.inputs, req.apply)
    import ontology_scenarios

    with ontology_scenarios.active(req.scenario_id) as sc:
        return run_logic(logic_id, req.inputs, req.apply, scenario={"id": sc["id"], "name": sc.get("name")})


@router.get("/logic/{logic_id}/runs")
def logic_runs(logic_id: str) -> list[dict]:
    _logic(logic_id)
    return _read(DIR / "runs" / f"{logic_id}.json", [])


@router.get("/models")
def models() -> list[dict]:
    return knowledge.models()


# ------------------------------------------------------------------------------------------------
# Automate
# ------------------------------------------------------------------------------------------------


class AutomationIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    enabled: Optional[bool] = None
    # {kind: objects_added | objects_modified | schedule, object_type_id?, every_minutes?}
    condition: Optional[dict] = None
    # {kind: logic, logic_id, object_input?, inputs?, apply_edits?} | {kind: action, action_type_id, parameters}
    effect: Optional[dict] = None
    # several effects run in order, each with retries and a fallback; settings: expiration, administrators,
    # execution (parallel | sequential) — automate.py
    effects: Optional[list[dict]] = None
    settings: Optional[dict] = None


def _check_automation(rec: dict) -> None:
    c, e = rec["condition"], rec["effect"]
    if c.get("kind") == "time_series":
        # time series alerting (ts_alerting.py): effects are optional and run on each new alert object
        TS_HOOKS["check"](rec)
        if e.get("kind") in (None, "", "none"):
            rec["effect"] = {"kind": "none"}
            return
        if e.get("kind") == "logic":
            fn = _logic(e.get("logic_id") or "")
            inp = next((i for i in fn["inputs"] if i["name"] == e.get("object_input")), None)
            if not inp or inp["type"] != "object" or inp.get("object_type_id") != c.get("alert_object_type_id"):
                raise HTTPException(400, "pick the Logic input that receives the alert object")
        elif e.get("kind") == "action":
            _action_type(e.get("action_type_id") or "")
        else:
            raise HTTPException(400, "pick an effect")
        return
    import automate

    automate.check(rec)


def _automation(auto_id: str) -> dict:
    return _get("automations", auto_id, "automation")


def _auto_summary(rec: dict) -> dict:
    runs = _read(DIR / "runs" / f"{rec['id']}.json", [])
    out = {**rec, "run_count": len(runs), "last_run": runs[0] if runs else None,
           "failed_runs": sum(1 for r in runs if r.get("status") == "failed")}
    if rec.get("condition", {}).get("kind") == "time_series" and "summary" in TS_HOOKS:
        out["time_series"] = TS_HOOKS["summary"](rec)
    return out


@router.get("/automations")
def list_automations() -> list[dict]:
    with _lock:
        return [_auto_summary(a) for a in _all("automations")]


@router.post("/automations")
def create_automation(req: AutomationIn) -> dict:
    with _lock:
        rec = {
            "id": _new_id("auto"),
            "name": (req.name or "Untitled automation").strip(),
            "description": (req.description or "").strip(),
            "enabled": True if req.enabled is None else req.enabled,
            "condition": req.condition or {},
            "effect": req.effect or {},
            "effects": req.effects or None,
            "settings": req.settings or {},
            "created_at": _now(),
            "created_by": (auth.current() or {}).get("id"),
            "owner": (auth.current() or {}).get("id"),
        }
        _check_automation(rec)
        return _auto_summary(_put("automations", rec))


@router.get("/automations/{auto_id}")
def get_automation(auto_id: str) -> dict:
    with _lock:
        return _auto_summary(_automation(auto_id))


@router.put("/automations/{auto_id}")
def save_automation(auto_id: str, req: AutomationIn) -> dict:
    with _lock:
        import automate

        rec = _automation(auto_id)
        if not automate.can_edit(rec):
            raise HTTPException(403, "only the automation's administrators edit it")
        changes = req.model_dump(exclude_unset=True)
        if "effect" in changes and "effects" not in changes and changes["effect"] is not None:
            # an older client edited the single effect: it replaces the first one
            rec["effects"] = [changes["effect"], *(rec.get("effects") or [])[1:]]
        for k, v in changes.items():
            if v is not None:
                rec[k] = v.strip() if isinstance(v, str) else v
        if "effects" in changes and changes["effects"]:
            rec["effect"] = changes["effects"][0]
        if changes.get("enabled") is True:
            rec.pop("expired", None)
        _check_automation(rec)
        if set(changes) - {"enabled"}:
            automate.history(auto_id, "edited", ", ".join(sorted(changes)), by=(auth.current() or {}).get("id"))
        elif "enabled" in changes:
            automate.history(auto_id, "resumed" if changes["enabled"] else "paused", by=(auth.current() or {}).get("id"))
        return _auto_summary(_put("automations", rec))


@router.delete("/automations/{auto_id}")
def delete_automation(auto_id: str) -> dict:
    with _lock:
        _automation(auto_id)
        _path("automations", auto_id).unlink(missing_ok=True)
        (DIR / "runs" / f"{auto_id}.json").unlink(missing_ok=True)
        return {"deleted": auto_id}


@router.get("/automations/{auto_id}/runs")
def automation_runs(auto_id: str) -> list[dict]:
    _automation(auto_id)
    return _read(DIR / "runs" / f"{auto_id}.json", [])


class RunAutomation(BaseModel):
    # object conditions: the object to run on
    primary_key: Optional[str] = None


@router.post("/automations/{auto_id}/run")
def run_automation_now(auto_id: str, req: RunAutomation) -> dict:
    """Run the effect now (on one object for object conditions), whether or not it is enabled."""
    rec = _automation(auto_id)
    if rec["condition"]["kind"] == "time_series":
        # evaluate the automation's alerting logic now (its evaluation job, this automation only)
        return TS_HOOKS["run"](rec)
    if rec["condition"]["kind"] != "schedule" and not req.primary_key:
        raise HTTPException(400, "pick the object to run on")
    return _execute(rec, req.primary_key, "manual", 0)


def _fire(events: list[dict], source: Optional[str], depth: int) -> None:
    import automate

    automate.fire(events, source, depth)


def _execute(rec: dict, pk: Optional[str], trigger: str, depth: int) -> dict:
    """One execution on one object (or none): automate.py runs every effect with retries and fallbacks."""
    import automate

    return automate.execute(rec, [{"primary_key": pk, "properties": {}}] if pk is not None else None, trigger, depth)


def _scheduler() -> None:
    import automate

    automate.scheduler()
