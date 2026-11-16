"""Derived series, function-backed series and Quiver analyses (Palantir's time series docs: "Derived series",
"Create derived series", "Manage derived series", "Manually save derived series to the Ontology", "Derived series
permissions", "Function-backed time series"; Quiver's time series cards).

Derived series
  A saved calculation over time series (ts_engine.py cards), calculated when read — nothing is stored. Templated
  derived series are written against a root object type and run for any of its objects (their tsp cards read the
  root object or its linked sensors); single derived series name their objects. Each save of new logic is a
  version (0.0.1, 0.0.2, …). The bound object type — the root type or one of its sensor object types for a
  templated series, any time series object type for a single one — is the only object type the series resolves
  from, and cannot change.
  The logic's codex template RID (ri.codex-emu.main.template.<id>) is what a time series property holds to show
  the derived series: the RID alone follows the latest logic, {"templateRid":…,"templateVersion":"0.0.2"} pins a
  version. Manual saving: write that value into a TSP of the bound object type yourself. Automatic saving (sensor
  object types only): for a sensor name, a root object scope (all, a property filter or chosen objects; at most
  5,000) and a property mapping, Deploy creates, modifies and deletes the sensor objects through Create / Modify /
  Delete action types of the sensor object type; the Ontology status says whether they are up to date with the
  latest logic and the scope. Deleting the resource does not delete those objects (Delete from Ontology first).
  Creating or changing a derived series needs the bound object type's markings; reading one needs every TSP its
  logic reads.

Function-backed series
  A "function" card runs a Python @function from a code repository (its default branch's last commit, through
  code_runner.py) with the root object and parameters; what it returns (TimeSeries.serialize(df) or a DataFrame of
  timestamp / value) is a numeric series. Results are cached for 10 minutes.

Quiver analyses
  Cards (the same logic), plots that overlay series cards, a shared time range, parameters and a dashboard of chosen
  cards whose inputs an embedding Workshop module can set. Queries are metered against the analysis.

Records are JSON in data/timeseries/derived/ and data/timeseries/quiver/. Mounted under /api/timeseries.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import timeseries
import ts_engine as E
import ts_ontology as T

router = APIRouter(prefix="/api/timeseries")

DERIVED_RID = "ri.time-series-catalog.main.derived-series."
QUIVER_RID = "ri.quiver.main.analysis."
TEMPLATE_RID = T.TEMPLATE_RID
MAX_SCOPE = 5000
# derived series logic: Quiver's supported cards (no time series search, no numeric aggregation as output)
DERIVED_CARDS = tuple(c for c in E.CARD_TYPES if c != "search")
FUNCTION_CACHE_S = 600
DIR: Path = Path()
_lock = threading.RLock()
_fn_cache: dict[str, tuple[float, list]] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "timeseries"
    for sub in ("derived", "quiver", "vfunc"):
        (DIR / sub).mkdir(parents=True, exist_ok=True)


def _path(kind: str, rec_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", rec_id):
        raise HTTPException(404, "not found")
    return DIR / kind / f"{rec_id}.json"


def _all(kind: str) -> list[dict]:
    return sorted((r for p in (DIR / kind).glob("*.json") if (r := ontology._read(p))), key=lambda r: r.get("updated_at", ""), reverse=True)


# ------------------------------------------------------------------------------------------------
# derived series
# ------------------------------------------------------------------------------------------------


class Scope(BaseModel):
    kind: Literal["all", "filter", "objects"] = "all"
    property: Optional[str] = None
    value: Any = None
    primary_keys: list[str] = Field(default_factory=list)


class Actions(BaseModel):
    create: Optional[str] = None
    modify: Optional[str] = None
    delete: Optional[str] = None


class Saving(BaseModel):
    mode: Literal["manual", "automatic"] = "manual"
    sensor_name: str = ""
    scope: Scope = Field(default_factory=Scope)
    # values for the other properties of the sensor objects (strings or Booleans)
    property_mapping: dict[str, Any] = Field(default_factory=dict)
    actions: Actions = Field(default_factory=Actions)


class DerivedIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    type: Literal["templated", "single"] = "templated"
    root_object_type_id: Optional[str] = None
    bound_object_type_id: str
    logic: dict
    saving: Saving = Field(default_factory=Saving)
    folder: str = ""
    version_description: str = ""


class DerivedPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    logic: Optional[dict] = None
    version_description: str = ""
    folder: Optional[str] = None


def _template_id(template: str) -> str:
    t = str(template or "").strip()
    return t[len(TEMPLATE_RID):] if t.startswith(TEMPLATE_RID) else t


def _sensor_cfg(t: dict) -> Optional[dict]:
    return T._ts_cfg(t).get("sensor")


def _link_to(sensor_type: dict, root_type_id: str) -> list[dict]:
    return [link for link in ((_sensor_cfg(sensor_type) or {}).get("links") or []) if link["root_object_type_id"] == root_type_id]


def _check_logic(d: dict) -> None:
    try:
        E.check_logic(d["logic"], DERIVED_CARDS)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    cards = {c["id"]: c for c in d["logic"]["cards"]}
    out = d["logic"].get("output")
    if not out:
        raise HTTPException(400, "pick the output card (Set as output)")
    if cards[out]["type"] in E.SCALAR_CARDS:
        raise HTTPException(400, "the output must be a time series card")
    named = E.root_objects(d["logic"])
    if d["type"] == "templated" and named:
        raise HTTPException(400, "a templated derived series operates on a single root object: its cards cannot name other objects")
    if d["type"] == "single":
        for c in d["logic"]["cards"]:
            if c["type"] in ("tsp", "linked_agg", "param_object_property") and not ((c.get("config") or {}).get("object") or {}).get("primary_key"):
                raise HTTPException(400, f"card {c['id']}: a single derived series names the object of every time series property card")
    for c in d["logic"]["cards"]:
        if c["type"] == "derived" and _template_id((c.get("config") or {}).get("template")) == d.get("template_id"):
            raise HTTPException(400, "a derived series cannot use itself")


def _check_binding(d: dict) -> None:
    bound = T._t(d["bound_object_type_id"])
    if not [p for p in bound["properties"] if p["type"] == "timeseries"]:
        raise HTTPException(400, f"{bound['display_name']} is not a time series object type (it has no time series property)")
    if d["type"] == "templated":
        if not d.get("root_object_type_id"):
            raise HTTPException(400, "a templated derived series needs a root object type")
        root = T._t(d["root_object_type_id"])
        if bound["id"] != root["id"] and not _link_to(bound, root["id"]):
            raise HTTPException(400, f"the bound object type must be {root['display_name']} or one of its sensor object types")
    s = d["saving"]
    if s["mode"] == "automatic":
        if not _sensor_cfg(bound):
            raise HTTPException(400, "automatic Ontology saving is only supported for sensor object types")
        if ontology._ptype(bound, bound["primary_key"]) != "string":
            raise HTTPException(400, "automatic saving needs a sensor object type with a string primary key")
        if d["type"] == "templated" and len(_link_to(bound, d["root_object_type_id"])) != 1:
            raise HTTPException(400, "automatic saving of a templated derived series needs exactly one link between the root and the sensor object type")
        if not s.get("sensor_name", "").strip():
            raise HTTPException(400, "enter the sensor name the derived series is saved under")
        for kind in ("create", "modify", "delete"):
            aid = (s.get("actions") or {}).get(kind)
            if aid:
                _check_action(bound, kind, aid)
        if s["scope"]["kind"] == "objects" and len(s["scope"]["primary_keys"]) > MAX_SCOPE:
            raise HTTPException(400, f"the scope is limited to {MAX_SCOPE:,} objects")


def _check_action(bound: dict, kind: str, action_id: str) -> dict:
    """An action type usable for automatic saving: one rule of the right kind on the sensor object type."""
    a = ontology._action_type(action_id)
    if a["object_type_id"] != bound["id"] or a["kind"] != kind:
        raise HTTPException(400, f"pick a {kind} action type of {bound['display_name']} ({a['display_name']} is not one)")
    if kind == "create":
        written = {p.get("property") for p in a["parameters"] if p["type"] != "object"}
        cfg = T._ts_cfg(bound)
        need = {bound["primary_key"], cfg.get("default_property")}
        missing = [n for n in need if n and n not in written]
        if missing:
            raise HTTPException(400, f"{a['display_name']} must have a parameter for every property ({', '.join(missing)} missing)")
    return a


def _derived(rec_id: str) -> dict:
    d = ontology._read(_path("derived", rec_id))
    if not d:
        raise HTTPException(404, "derived series not found")
    # derived series follow their bound object type's markings
    auth.check_resource("object_type", d["bound_object_type_id"])
    return d


def by_template(template: str) -> dict:
    tid = _template_id(template)
    for d in _all("derived"):
        if d.get("template_id") == tid or d["id"] == tid:
            return d
    raise E.EngineError(f"no derived series has the template {template}")


def visible() -> list[dict]:
    ok = {t["id"] for t in auth.visible_resources("object_type", ontology._all("object-types"))}
    return [d for d in _all("derived") if d["bound_object_type_id"] in ok]


def _version(d: dict, version: Optional[str]) -> dict:
    if not version:
        return d["versions"][-1]
    v = next((v for v in d["versions"] if v["version"] == version), None)
    if not v:
        raise E.EngineError(f"{d['name']} has no version {version}")
    return v


def _summary(d: dict) -> dict:
    types = {t["id"]: t["display_name"] for t in ontology._all("object-types")}
    return {**{k: v for k, v in d.items() if k != "versions"}, "version": d["versions"][-1]["version"], "version_count": len(d["versions"]),
            "bound_object_type": types.get(d["bound_object_type_id"]), "root_object_type": types.get(d.get("root_object_type_id") or ""),
            "template_rid": TEMPLATE_RID + d["template_id"], "rid": DERIVED_RID + d["id"]}


def resolve(template: str, version: Optional[str], obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], depth: int,
            resolver: "T.Resolver") -> E.Series:
    """A derived series for an object: a templated series runs for the object's root (the object itself, or the root
    object a sensor links to); a single series names its own objects."""
    d = by_template(template)
    v = _version(d, version)
    root: Optional[dict] = None
    if d["type"] == "templated":
        if not obj:
            raise E.EngineError(f"{d['name']} is templated: it needs a {d.get('root_object_type_id')} object")
        if obj["object_type_id"] == d["root_object_type_id"]:
            root = obj
        elif obj["object_type_id"] == d["bound_object_type_id"]:
            t, _pk, props = resolver.obj(obj)
            link = _link_to(t, d["root_object_type_id"])
            if not link:
                raise E.EngineError(f"{t['display_name']} is not linked to the root object type of {d['name']}")
            root = {"object_type_id": d["root_object_type_id"], "primary_key": str(props.get(link[0]["foreign_key"]))}
        else:
            raise E.EngineError(f"{d['name']} can only be resolved from its bound object type")
    s, scanned = E.evaluate_series(v["logic"], resolver, root, rng[0], rng[1], depth=depth)
    resolver.extra_scanned = getattr(resolver, "extra_scanned", 0) + scanned
    return E.replace(s, label=d["name"])


@router.get("/derived")
def list_derived(type: Optional[str] = None, root_object_type_id: Optional[str] = None, bound_object_type_id: Optional[str] = None) -> list[dict]:  # noqa: A002
    out = [d for d in visible() if (not type or d["type"] == type) and (not root_object_type_id or d.get("root_object_type_id") == root_object_type_id)
           and (not bound_object_type_id or d["bound_object_type_id"] == bound_object_type_id)]
    return [_summary(d) for d in out]


@router.post("/derived")
def create_derived(req: DerivedIn) -> dict:
    d = req.model_dump()
    auth.check_resource("object_type", d["bound_object_type_id"])
    d["template_id"] = uuid.uuid4().hex
    _check_binding(d)
    _check_logic(d)
    now = ontology._now()
    rec = {"id": ontology._new_id("ds"), "name": d["name"].strip(), "description": d["description"].strip(), "type": d["type"],
           "root_object_type_id": d["root_object_type_id"] if d["type"] == "templated" else None, "bound_object_type_id": d["bound_object_type_id"],
           "template_id": d["template_id"], "folder": d["folder"], "saving": d["saving"], "deployed": None,
           "versions": [{"version": "0.0.1", "logic": d["logic"], "description": d["version_description"], "at": now, "by": auth.actor_id()}],
           "created_at": now, "updated_at": now, "created_by": auth.actor_id()}
    with _lock:
        ontology._write(_path("derived", rec["id"]), rec)
    return get_derived(rec["id"])


@router.get("/derived/{rec_id}")
def get_derived(rec_id: str) -> dict:
    d = _derived(rec_id)
    return {**_summary(d), "versions": d["versions"], "logic": d["versions"][-1]["logic"]}


@router.put("/derived/{rec_id}")
def update_derived(rec_id: str, req: DerivedPatch) -> dict:
    """Overview (title, description) and Logic: logic that changed is saved as a new version."""
    with _lock:
        d = _derived(rec_id)
        if req.name is not None:
            d["name"] = req.name.strip()
        if req.description is not None:
            d["description"] = req.description.strip()
        if req.folder is not None:
            d["folder"] = req.folder
        if req.logic is not None and json.dumps(req.logic, sort_keys=True) != json.dumps(d["versions"][-1]["logic"], sort_keys=True):
            _check_logic({**d, "logic": req.logic})
            n = int(d["versions"][-1]["version"].split(".")[-1]) + 1
            d["versions"].append({"version": f"0.0.{n}", "logic": req.logic, "description": req.version_description, "at": ontology._now(), "by": auth.actor_id()})
        d["updated_at"] = ontology._now()
        ontology._write(_path("derived", rec_id), d)
    return get_derived(rec_id)


@router.put("/derived/{rec_id}/ontology")
def save_ontology_options(rec_id: str, req: Saving) -> dict:
    """Ontology tab: saving mode, sensor name, root object scope, property mapping and action types (the bound object
    type stays). Changes take effect in the Ontology on Deploy."""
    with _lock:
        d = _derived(rec_id)
        d["saving"] = req.model_dump()
        _check_binding(d)
        d["updated_at"] = ontology._now()
        ontology._write(_path("derived", rec_id), d)
    return get_derived(rec_id)


@router.delete("/derived/{rec_id}")
def delete_derived(rec_id: str) -> dict:
    """Deletes the resource; sensor objects saved to the Ontology stay (Delete from Ontology first)."""
    d = _derived(rec_id)
    _path("derived", rec_id).unlink(missing_ok=True)
    return {"deleted": rec_id, "objects_left": len(_actual(d))}


class PreviewIn(BaseModel):
    logic: Optional[dict] = None
    root: Optional[T.ObjRef] = None
    start: Optional[str] = None
    end: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    buckets: int = 500
    version: Optional[str] = None


@router.post("/derived/{rec_id}/preview")
def preview_derived(rec_id: str, req: PreviewIn) -> dict:
    """Run the logic (unsaved edits, a version, or the latest) for the preview root object."""
    d = _derived(rec_id)
    logic = req.logic or _version(d, req.version)["logic"]
    start, end = T._range(req.start, req.end)
    try:
        res = E.run(logic, T.Resolver(), req.root.model_dump() if req.root else None, start, end, req.params, buckets=req.buckets)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    timeseries.record_usage(f"derived:{rec_id}", res["points_scanned"])
    timeseries.mark_viewed("derived", rec_id)
    return res


# -- automatic Ontology saving -----------------------------------------------------------------------


def _scope_roots(d: dict) -> list[str]:
    root_t = d["root_object_type_id"]
    objs = ontology._objects(root_t)
    sc = d["saving"]["scope"]
    if sc["kind"] == "objects":
        keys = [k for k in sc["primary_keys"] if k in objs]
    elif sc["kind"] == "filter" and sc.get("property"):
        keys = [k for k, o in objs.items() if str(o.get("properties", {}).get(sc["property"])) == str(sc.get("value"))]
    else:
        keys = list(objs)
    if len(keys) > MAX_SCOPE:
        raise HTTPException(400, f"the root object scope holds {len(keys):,} objects; at most {MAX_SCOPE:,} are supported")
    return sorted(keys)


def _expected(d: dict) -> dict[str, dict]:
    """The sensor objects automatic saving wants in the Ontology, by primary key: their property values."""
    bound = T._t(d["bound_object_type_id"])
    cfg = T._ts_cfg(bound)
    tsp = cfg["default_property"]
    version = d["versions"][-1]["version"]
    value = json.dumps({"templateRid": TEMPLATE_RID + d["template_id"], "templateVersion": version}, separators=(",", ":"))
    s = d["saving"]
    base = {k: v for k, v in (s.get("property_mapping") or {}).items() if ontology._ptype(bound, k)}
    out: dict[str, dict] = {}
    if d["type"] == "templated":
        link = _link_to(bound, d["root_object_type_id"])[0]
        for root_pk in _scope_roots(d):
            pk = f"{d['id']}-{root_pk}"
            out[pk] = {**base, bound["primary_key"]: pk, tsp: value, link["sensor_name_property"]: s["sensor_name"], link["foreign_key"]: root_pk}
    else:
        pk = d["id"]
        links = (cfg.get("sensor") or {}).get("links") or []
        props = {**base, bound["primary_key"]: pk, tsp: value}
        if links:
            props[links[0]["sensor_name_property"]] = s["sensor_name"]
        out[pk] = props
    return out


def _actual(d: dict) -> dict[str, dict]:
    bound = T._t(d["bound_object_type_id"])
    tsp = T._ts_cfg(bound).get("default_property")
    out = {}
    for pk, o in ontology._objects(bound["id"]).items():
        v = o.get("properties", {}).get(tsp) if tsp else None
        try:
            ref = T.parse_value(v) if v not in (None, "") else None
        except E.EngineError:
            ref = None
        if ref and ref["kind"] == "derived" and _template_id(ref["template"]) == d["template_id"]:
            out[pk] = o.get("properties", {})
    return out


def _plan(d: dict) -> dict:
    want = _expected(d)
    have = _actual(d)
    create = [pk for pk in want if pk not in have]
    modify = [pk for pk in want if pk in have and any(str(have[pk].get(k)) != str(v) for k, v in want[pk].items())]
    delete = [pk for pk in have if pk not in want]
    return {"want": want, "have": have, "create": create, "modify": modify, "delete": delete}


@router.get("/derived/{rec_id}/ontology-status")
def ontology_status(rec_id: str) -> dict:
    """Whether the Ontology holds what the latest logic and the Ontology options ask for."""
    d = _derived(rec_id)
    if d["saving"]["mode"] != "automatic":
        return {"mode": "manual", "template_rid": TEMPLATE_RID + d["template_id"], "objects": len(_actual(d)),
                "pinned_value": json.dumps({"templateRid": TEMPLATE_RID + d["template_id"], "templateVersion": d["versions"][-1]["version"]}, separators=(",", ":"))}
    p = _plan(d)
    return {"mode": "automatic", "up_to_date": not (p["create"] or p["modify"] or p["delete"]), "expected": len(p["want"]), "in_ontology": len(p["have"]),
            "to_create": p["create"][:50], "to_modify": p["modify"][:50], "to_delete": p["delete"][:50],
            "counts": {"create": len(p["create"]), "modify": len(p["modify"]), "delete": len(p["delete"])},
            "version": d["versions"][-1]["version"], "deployed": d.get("deployed")}


class DeployIn(BaseModel):
    actions: Actions = Field(default_factory=Actions)


def _values(action: dict, props: dict, pk: Optional[str]) -> dict:
    vals: dict[str, Any] = {}
    for p in action["parameters"]:
        if p["type"] == "object":
            vals[p["id"]] = pk
        elif p.get("property") in props:
            vals[p["id"]] = props[p["property"]]
    return vals


@router.post("/derived/{rec_id}/deploy")
def deploy(rec_id: str, req: DeployIn) -> dict:
    """Bring the Ontology up to date: create, modify and delete sensor objects with the given (or saved) action types."""
    with _lock:
        d = _derived(rec_id)
        if d["saving"]["mode"] != "automatic":
            raise HTTPException(400, "this derived series uses manual Ontology saving")
        bound = T._t(d["bound_object_type_id"])
        acts = {**{k: v for k, v in (d["saving"].get("actions") or {}).items() if v}, **{k: v for k, v in req.actions.model_dump().items() if v}}
        p = _plan(d)
        edits: list[dict] = []
        for kind, keys in (("create", p["create"]), ("modify", p["modify"]), ("delete", p["delete"])):
            if not keys:
                continue
            if not acts.get(kind):
                raise HTTPException(400, f"supply a {kind} action type of {bound['display_name']} to {kind} {len(keys)} object(s)")
            a = _check_action(bound, kind, acts[kind])
            for pk in keys:
                props = p["want"].get(pk, {})
                if kind == "modify":
                    props = {k: v for k, v in props.items() if k != bound["primary_key"]}
                edits.extend(ontology.action_edits(a, _values(a, props, None if kind == "create" else pk)))
        written = ontology.apply_edits(edits, source=None) if edits else []
        d["saving"]["actions"] = {**(d["saving"].get("actions") or {}), **acts}
        d["deployed"] = {"version": d["versions"][-1]["version"], "at": ontology._now(), "by": auth.actor_id(),
                         "created": len(p["create"]), "modified": len(p["modify"]), "deleted": len(p["delete"])}
        ontology._write(_path("derived", rec_id), d)
    return {"edits": len(written), **ontology_status(rec_id)}


class DeleteFromOntology(BaseModel):
    action: Optional[str] = None


@router.post("/derived/{rec_id}/delete-from-ontology")
def delete_from_ontology(rec_id: str, req: DeleteFromOntology) -> dict:
    with _lock:
        d = _derived(rec_id)
        bound = T._t(d["bound_object_type_id"])
        aid = req.action or (d["saving"].get("actions") or {}).get("delete")
        if not aid:
            raise HTTPException(400, f"supply a delete action type of {bound['display_name']}")
        a = _check_action(bound, "delete", aid)
        have = _actual(d)
        edits = [e for pk in have for e in ontology.action_edits(a, _values(a, {}, pk))]
        ontology.apply_edits(edits, source=None)
        d["deployed"] = None
        ontology._write(_path("derived", rec_id), d)
    return {"deleted": len(have)}


# ------------------------------------------------------------------------------------------------
# function-backed series
# ------------------------------------------------------------------------------------------------


def run_function(cfg: dict, obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], params: dict) -> E.Series:
    import code_repos

    repo_id, file, fn = cfg.get("repo_id"), cfg.get("file"), cfg.get("function")
    if not (repo_id and file and fn):
        raise E.EngineError("pick the code repository, file and function")
    try:
        auth.check_resource("code_repo", repo_id)
    except HTTPException as e:
        raise E.EngineError(str(e.detail)) from None
    args: dict[str, Any] = dict(params)
    if cfg.get("object_param"):
        if not obj:
            raise E.EngineError("the function's object parameter needs an object")
        r = T.Resolver()
        t, pk, props = r.obj(obj)
        args[cfg["object_param"]] = {"__object__": {"object_type_id": t["id"], "object_type": t["api_name"], "primary_key": pk, "properties": props,
                                                    "timeseries": [p["api_name"] for p in t["properties"] if p["type"] == "timeseries"]}}
    rng_text = {"start": E.iso(rng[0]), "end": E.iso(rng[1])}
    key = hashlib.sha256(json.dumps([repo_id, file, fn, cfg.get("branch"), args, rng_text], sort_keys=True, default=str).encode()).hexdigest()
    hit = _fn_cache.get(key)
    if hit and time.time() - hit[0] < FUNCTION_CACHE_S:
        points = hit[1]
    else:
        try:
            res = code_repos.run_ts_function(repo_id, file, fn, args, rng_text, cfg.get("branch") or None)
        except HTTPException as e:
            raise E.EngineError(str(e.detail)) from None
        if not res.get("ok"):
            raise E.EngineError(f"{fn}: {str(res.get('error') or 'the function failed')[-600:]}")
        points = res.get("points") or []
        if len(_fn_cache) > 200:
            _fn_cache.clear()
        _fn_cache[key] = (time.time(), points)
    return E.series_from_points([(int(t), v) for t, v in points], label=fn)


# ------------------------------------------------------------------------------------------------
# Quiver analyses
# ------------------------------------------------------------------------------------------------


class AnalysisIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    logic: Optional[dict] = None
    # the preview / default root object of templated cards
    root: Optional[T.ObjRef] = None
    # [{id, title, cards: [card ids], axis?: "shared" | "separate"}]
    plots: Optional[list[dict]] = None
    # {start, end} or {last: "7d"}
    range: Optional[dict] = None
    # {cards: [card or plot ids], inputs: [parameter card ids]}
    dashboard: Optional[dict] = None
    # display-only groups of cards; card logic and dependencies remain analysis-wide
    canvases: Optional[list[dict]] = None
    view_mode: Optional[Literal["canvas", "graph"]] = None
    object_sets: Optional[list[dict]] = None
    # the revision this copy was loaded at: a save from an older revision than the stored one is refused
    rev: Optional[int] = None


def _analysis(aid: str) -> dict:
    a = ontology._read(_path("quiver", aid))
    if not a:
        raise HTTPException(404, "analysis not found")
    return a


def _check_analysis(a: dict) -> None:
    if a["logic"].get("cards"):
        try:
            E.check_logic(a["logic"])
        except E.EngineError as e:
            raise HTTPException(400, str(e)) from None
    ids = {c["id"] for c in a["logic"].get("cards") or []}
    object_ids = {c.get("id") for c in a.get("object_sets") or [] if c.get("id")}
    for p in a["plots"]:
        p.setdefault("id", uuid.uuid4().hex[:8])
        p["cards"] = [c for c in p.get("cards") or [] if c in ids]
    if not a.get("canvases"):
        a["canvases"] = [{"id": "canvas-main", "name": "Canvas", "cards": [c["id"] for c in a["logic"].get("cards") or []] + list(object_ids)}]
    else:
        for i, canvas in enumerate(a["canvases"]):
            canvas.setdefault("id", f"canvas-{i + 1}")
            canvas.setdefault("name", f"Canvas {i + 1}")
            canvas["cards"] = list(dict.fromkeys(c for c in canvas.get("cards") or [] if c in ids or c in object_ids))
    if a.get("view_mode") not in {"canvas", "graph"}:
        a["view_mode"] = "canvas"


@router.get("/quiver")
def list_analyses() -> list[dict]:
    return [{k: v for k, v in a.items() if k != "logic"} | {"card_count": len(a["logic"].get("cards") or []) + len(a.get("object_sets") or [])} for a in _all("quiver")]


@router.post("/quiver")
def create_analysis(req: AnalysisIn) -> dict:
    now = ontology._now()
    a = {"id": ontology._new_id("qa"), "name": (req.name or "Untitled analysis").strip(), "description": req.description or "",
         "logic": req.logic or {"cards": []}, "root": req.root.model_dump() if req.root else None, "plots": req.plots or [],
         "range": req.range or {"last": "7d"}, "dashboard": req.dashboard or {"cards": [], "inputs": []}, "created_at": now, "updated_at": now,
         "canvases": req.canvases or [{"id": "canvas-main", "name": "Canvas", "cards": [c["id"] for c in (req.logic or {}).get("cards", [])]}],
         "object_sets": req.object_sets or [], "view_mode": req.view_mode or "canvas", "created_by": auth.actor_id()}
    a["rid"] = QUIVER_RID + a["id"]
    _check_analysis(a)
    ontology._write(_path("quiver", a["id"]), a)
    return a


@router.get("/quiver/{aid}")
def get_analysis(aid: str) -> dict:
    a = _analysis(aid)
    timeseries.mark_viewed("quiver", aid)
    return a


@router.put("/quiver/{aid}")
def save_analysis(aid: str, req: AnalysisIn) -> dict:
    with _lock:
        a = _analysis(aid)
        if req.rev is not None and req.rev != int(a.get("rev") or 0):
            raise HTTPException(409, "the analysis was saved by someone else since you opened it: reload to see their version")
        for k, v in req.model_dump(exclude_unset=True).items():
            if v is not None and k != "rev":
                a[k] = v
        _check_analysis(a)
        a["rev"] = int(a.get("rev") or 0) + 1
        a["updated_at"] = ontology._now()
        ontology._write(_path("quiver", aid), a)
    return a


@router.delete("/quiver/{aid}")
def delete_analysis(aid: str) -> dict:
    _analysis(aid)
    _path("quiver", aid).unlink(missing_ok=True)
    return {"deleted": aid}


# ------------------------------------------------------------------------------------------------
# Published dashboards: a Files item (its folder's permissions apply) holding a version per publish
# ------------------------------------------------------------------------------------------------

DASHBOARD_MIME = "application/vnd.bluesandai.quiver-dashboard+json"
VERSIONS_KEPT = 50


class PublishIn(BaseModel):
    # where a first publish saves the dashboard (default: the documents folder); later publishes add versions
    folder_id: Optional[str] = None
    name: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=500)


def _dashboard_item(item_id: str, need: str = "viewer") -> tuple[dict, dict]:
    import drive

    item = drive._item(item_id, need=need)
    if item.get("kind") != "file" or item.get("content_type") != DASHBOARD_MIME:
        raise HTTPException(404, "published dashboard not found")
    return item, json.loads(drive.read_bytes(item).decode("utf-8"))


@router.post("/quiver/{aid}/publish")
def publish_dashboard(aid: str, req: PublishIn) -> dict:
    """Publish the analysis' dashboard: the first time a Files item is created, each later publish saves a new version
    (a snapshot of the analysis as published). Publishing needs edit rights on the dashboard item."""
    import drive
    import pipeline_datasets

    with _lock:
        a = _analysis(aid)
        snap = {k: v for k, v in a.items() if k != "published"}
        existing = None
        if (a.get("published") or {}).get("item_id"):
            try:
                existing = _dashboard_item(a["published"]["item_id"], "editor")
            except HTTPException as e:
                if e.status_code != 404:
                    raise
        if existing:
            item, doc = existing
        else:
            name = drive._clean_name((req.name or f"{a['name']} dashboard").strip())[:200]
            doc = {"analysis_id": aid, "versions": []}
            item = drive.save_bytes(drive._folder_id(req.folder_id) if req.folder_id else drive.default_folder("documents"), f"{name}.quiver-dashboard",
                                    json.dumps(doc).encode("utf-8"), DASHBOARD_MIME)
        version = (doc["versions"][-1]["version"] + 1) if doc["versions"] else 1
        doc["versions"].append({"version": version, "at": ontology._now(), "by": auth.actor_id(), "note": req.note or "", "analysis": snap})
        doc["versions"] = doc["versions"][-VERSIONS_KEPT:]
        pipeline_datasets._replace_content(drive._item(item["id"]), json.dumps(doc, ensure_ascii=False, default=str).encode("utf-8"), DASHBOARD_MIME)
        a["published"] = {"item_id": item["id"], "version": version, "at": ontology._now()}
        ontology._write(_path("quiver", aid), a)
    return {"item_id": item["id"], "version": version}


@router.get("/quiver-dashboards")
def list_dashboards() -> list[dict]:
    """The published dashboards the caller can open (to pick one for an Object View tab)."""
    import drive

    out = []
    for a in _all("quiver"):
        pub = a.get("published") or {}
        if not pub.get("item_id"):
            continue
        try:
            item, _ = _dashboard_item(pub["item_id"])
        except HTTPException:
            continue
        out.append({"item_id": item["id"], "name": item["name"].removesuffix(".quiver-dashboard"), "analysis_id": a["id"], "version": pub.get("version"),
                    "root_object_type_id": (a.get("root") or {}).get("object_type_id"), "path": drive._with_path(item).get("path")})
    return sorted(out, key=lambda d: d["name"].lower())


def _for_object(a: dict, object_type_id: str, primary_key: str) -> tuple[dict, dict]:
    """The analysis opened for one object: its root object (when of that type) is the object, and its object set cards
    of that type hold only it. Returns the copy and what was bound."""
    import copy

    a = copy.deepcopy(a)
    bound = {"root": False, "object_sets": 0}
    if (a.get("root") or {}).get("object_type_id") == object_type_id:
        a["root"] = {**a["root"], "primary_key": primary_key}
        bound["root"] = True
    for c in a.get("object_sets") or []:
        if c.get("kind") in (None, "object_set") and c.get("object_type_id") == object_type_id:
            c["only"] = [primary_key]
            bound["object_sets"] += 1
    return a, bound


@router.get("/quiver-dashboards/{item_id}")
def get_dashboard(item_id: str, version: Optional[int] = None, object_type_id: Optional[str] = None, primary_key: Optional[str] = None) -> dict:
    """A published dashboard as of a version (default: the latest), with its table cards computed for the viewer; with
    an object, the dashboard is opened for it (see _for_object)."""
    import drive
    import quiver_tables

    item, doc = _dashboard_item(item_id)
    if not doc["versions"]:
        raise HTTPException(404, "the dashboard has no published version")
    v = next((x for x in doc["versions"] if x["version"] == version), None) if version else doc["versions"][-1]
    if not v:
        raise HTTPException(404, f"no version {version}")
    a, bound = v["analysis"], None
    if object_type_id and primary_key is not None:
        t = ontology._object_type(object_type_id)
        ontology._find(t, primary_key)
        a, bound = _for_object(a, object_type_id, primary_key)
    tables = {x["id"]: x for x in a.get("object_sets") or [] if x.get("kind") in quiver_tables.TABLE_KINDS}
    wanted = {x for x in (a.get("dashboard") or {}).get("cards") or [] if x in tables}
    can_edit_analysis = ontology._read(_path("quiver", doc["analysis_id"])) is not None
    return {"item": drive._with_path(item), "analysis_id": doc["analysis_id"], "version": v["version"], "at": v["at"], "note": v.get("note", ""),
            "latest": doc["versions"][-1]["version"], "versions": [{k: x.get(k) for k in ("version", "at", "by", "note")} for x in reversed(doc["versions"])],
            "analysis": a, "tables": quiver_tables.run_cards(a, wanted) if wanted else {}, "analysis_exists": can_edit_analysis, "bound": bound}


# ------------------------------------------------------------------------------------------------
# Visual functions: reusable card logic (inputs → output) saved from an analysis
# ------------------------------------------------------------------------------------------------


class VFuncInput(BaseModel):
    card: str
    name: str = Field("", max_length=200)


class VFuncIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=4000)
    # the analysis' logic: only the output card and what it depends on are kept
    logic: dict
    output: str
    inputs: list[VFuncInput] = Field(default_factory=list, max_length=20)


def _vfunc_record(req: VFuncIn) -> dict:
    cards = E.upstream(req.logic, req.output)
    if not cards:
        raise HTTPException(400, f"no card {req.output} in the logic")
    out_card = next(c for c in cards if c["id"] == req.output)
    if out_card["type"] in ("vfunction",) and out_card["config"].get("function_id") is None:
        raise HTTPException(400, "the output is an empty visual function card")
    ids = {c["id"] for c in cards}
    for i in req.inputs:
        if i.card not in ids or i.card == req.output:
            raise HTTPException(400, f"input {i.card} is not a card the output depends on")
    logic = {"cards": cards, "output": req.output}
    try:
        E.check_logic(logic)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    types = {c["id"]: c["type"] for c in cards}
    return {"name": req.name.strip(), "description": req.description, "logic": logic, "output": req.output,
            "inputs": [{"card": i.card, "name": i.name or i.card, "type": types[i.card]} for i in req.inputs]}


def visual_function(fid: str) -> dict:
    f = ontology._read(_path("vfunc", fid))
    if not f:
        raise E.EngineError(f"no visual function {fid}")
    return f


@router.get("/visual-functions")
def list_vfuncs() -> list[dict]:
    return [{k: f.get(k) for k in ("id", "name", "description", "inputs", "output", "created_by", "updated_at")} for f in _all("vfunc")]


@router.post("/visual-functions")
def create_vfunc(req: VFuncIn) -> dict:
    now = ontology._now()
    f = {"id": ontology._new_id("vf"), **_vfunc_record(req), "created_by": auth.actor_id(), "created_at": now, "updated_at": now}
    ontology._write(_path("vfunc", f["id"]), f)
    return f


@router.get("/visual-functions/{fid}")
def get_vfunc(fid: str) -> dict:
    try:
        return visual_function(fid)
    except E.EngineError:
        raise HTTPException(404, "visual function not found") from None


@router.put("/visual-functions/{fid}")
def update_vfunc(fid: str, req: VFuncIn) -> dict:
    """Update the logic in one place: every analysis using the function gets it on its next run."""
    with _lock:
        f = get_vfunc(fid)
        f.update(_vfunc_record(req), updated_at=ontology._now())
        ontology._write(_path("vfunc", fid), f)
    return f


@router.delete("/visual-functions/{fid}")
def delete_vfunc(fid: str) -> dict:
    get_vfunc(fid)
    _path("vfunc", fid).unlink(missing_ok=True)
    return {"deleted": fid}


def _derived_label(rid: str) -> tuple[str, Optional[str]]:
    return f"Derived series · {ontology._read(_path('derived', rid))['name']}", f"/time-series/derived/{rid}"


def _quiver_label(rid: str) -> tuple[str, Optional[str]]:
    return f"Quiver · {_analysis(rid)['name']}", f"/quiver/{rid}"


T.LABELERS.update({"derived": _derived_label, "quiver": _quiver_label})
