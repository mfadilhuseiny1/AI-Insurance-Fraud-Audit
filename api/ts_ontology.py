"""Time series in the Ontology (Palantir's time series docs: "Time series properties", "Sensor object type setup",
"Time series permissions", "Set up a time series", "FAQ"), on top of the Time Series DB (timeseries.py) and the query
engine (ts_engine.py).

Time series properties (TSPs)
  An object type property of type "timeseries" holds, per object, a series ID, a qualified series ID
  ({"seriesId":"…","syncRid":"ri.time-series-catalog.main.sync.<id>"}: a TSP backed by several syncs) or a derived
  series (ri.codex-emu.main.template.<id>, or {"templateRid":…,"templateVersion":"0.0.3"}). The object type's
  `time_series` record (Ontology Manager → Capabilities) lists each TSP's backing syncs and its formatting: units
  and internal interpolation (a fixed value or another property of the object), external interpolation, and
  which TSP is the default. A series ID must be held by one of the TSP's syncs ("no time series data exists"
  otherwise — see the diagnostics endpoint).

Sensor object types
  An object type with one (default) TSP linked to a root object type: a foreign key property holding the root
  object's primary key and a sensor name property, unique per root object. Units, interpolation and whether the
  series is categorical can come from properties of each sensor object. Applications fetch a root object's TSPs
  and its linked sensors' series together ("sensor:<sensor name>" in logic).

Permissions
  Reading a TSP needs the object type's markings and, unless the object type stops inheriting them ("Time series
  sync markings" in Capabilities), the markings of every sync backing the TSP. A sync itself always needs its
  markings (inherited from its input dataset).

Also here: the query endpoint every app uses (Quiver, derived series, Workshop, Map, FoundryTS), each query
metered as compute-seconds against the resource that ran it; the setup assistant (create a time series object type
from a backing dataset, add TSPs); the Time Series Catalog home (recently viewed, favorites, most viewed).

Mounted by server.py under /api/timeseries.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import date, datetime
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import timeseries
import ts_engine as E

router = APIRouter(prefix="/api/timeseries")

TEMPLATE_RID = "ri.codex-emu.main.template."
RAW_POINTS = 2_000_000
MAX_BACKING_ROWS = 50_000
# resource label resolvers for usage: prefix → fn(id) -> (label, href)
LABELERS: dict[str, Callable[[str], tuple[str, Optional[str]]]] = {}
UNITS = ("", "°C", "°F", "K", "kPa", "bar", "psi", "Pa", "m", "km", "ft", "m/s", "km/h", "kn", "mph", "rpm", "Hz", "V", "A", "W", "kW", "MW", "kWh",
         "MWh", "%", "L", "m³", "kg", "t", "s", "min", "h", "count", "°")


def _t(type_id: str) -> dict:
    return ontology._object_type(type_id)


def _ts_cfg(t: dict) -> dict:
    cfg = dict(t.get("time_series") or {})
    cfg.setdefault("properties", {})
    cfg.setdefault("default_property", None)
    cfg.setdefault("sensor", None)
    cfg.setdefault("severed_markings", [])
    cfg.setdefault("geospatial", None)
    return cfg


def _prop(t: dict, api_name: str) -> Optional[dict]:
    return next((p for p in t["properties"] if p["api_name"] == api_name), None)


def parse_value(value: Any) -> dict:
    """A TSP value: {"kind": "raw", "series_id", "sync"} or {"kind": "derived", "template", "version"}."""
    if value is None or value == "":
        raise E.EngineError("the property has no value on this object")
    if isinstance(value, dict):
        obj = value
    else:
        text = str(value).strip()
        if text.startswith(TEMPLATE_RID):
            return {"kind": "derived", "template": text, "version": None}
        if text.startswith("{"):
            try:
                obj = json.loads(text)
            except ValueError:
                raise E.EngineError(f"{text[:80]} is not a valid qualified series ID") from None
        else:
            return {"kind": "raw", "series_id": text, "sync": None}
    if obj.get("templateRid"):
        return {"kind": "derived", "template": str(obj["templateRid"]), "version": obj.get("templateVersion") or None}
    if obj.get("seriesId"):
        return {"kind": "raw", "series_id": str(obj["seriesId"]), "sync": timeseries.sync_id_of(obj.get("syncRid") or "") or None}
    raise E.EngineError("a qualified series ID needs seriesId and syncRid")


# ------------------------------------------------------------------------------------------------
# configuration (Ontology Manager → Capabilities → Time series / Geospatial)
# ------------------------------------------------------------------------------------------------


class Formatting(BaseModel):
    value: Optional[str] = None
    property: Optional[str] = None


class TspConfig(BaseModel):
    syncs: list[str] = Field(default_factory=list)
    unit: Formatting = Field(default_factory=Formatting)
    interpolation: Formatting = Field(default_factory=Formatting)
    external: Literal["NONE", "NEAREST"] = "NONE"
    description: str = ""


class SensorLink(BaseModel):
    root_object_type_id: str
    foreign_key: str
    sensor_name_property: str


class SensorConfig(BaseModel):
    links: list[SensorLink] = Field(default_factory=list)
    is_categorical_property: Optional[str] = None
    unit_property: Optional[str] = None
    interpolation_property: Optional[str] = None


class Geospatial(BaseModel):
    track_latitude: Optional[str] = None
    track_longitude: Optional[str] = None


class TimeSeriesConfig(BaseModel):
    properties: dict[str, TspConfig] = Field(default_factory=dict)
    default_property: Optional[str] = None
    sensor: Optional[SensorConfig] = None
    # sync ids whose markings are no longer required when reading through a TSP
    severed_markings: list[str] = Field(default_factory=list)
    geospatial: Optional[Geospatial] = None


def _check_formatting(t: dict, f: dict, what: str, allowed: Optional[tuple[str, ...]] = None) -> None:
    if f.get("property"):
        p = _prop(t, f["property"])
        if not p or p["type"] != "string":
            raise HTTPException(400, f"{what}: {f['property']} must be a string property of {t['display_name']}")
    if f.get("value") and allowed and f["value"].upper() not in allowed:
        raise HTTPException(400, f"{what}: {f['value']} is not one of {', '.join(allowed)}")


def validate_config(t: dict, cfg: dict) -> dict:
    props = {p["api_name"]: p for p in t["properties"]}
    for name, pc in cfg["properties"].items():
        p = props.get(name)
        if not p or p["type"] != "timeseries":
            raise HTTPException(400, f"{name} is not a time series property of {t['display_name']}")
        if name == t["primary_key"]:
            raise HTTPException(400, "the primary key cannot be a time series property")
        if not pc.get("syncs"):
            raise HTTPException(400, f"{p['display_name']}: pick at least one time series sync as its data source")
        clean = []
        for s in pc["syncs"]:
            rec = timeseries.check_sync(s)
            if rec["kind"] != "timeseries":
                raise HTTPException(400, f"{rec['name']} is a geotemporal series sync, not a time series sync")
            clean.append(rec["id"])
        pc["syncs"] = list(dict.fromkeys(clean))
        _check_formatting(t, pc.get("unit") or {}, f"{p['display_name']} units")
        _check_formatting(t, pc.get("interpolation") or {}, f"{p['display_name']} interpolation", E.INTERPOLATIONS)
        if (pc.get("interpolation") or {}).get("value"):
            pc["interpolation"]["value"] = pc["interpolation"]["value"].upper()
    tsps = [p["api_name"] for p in t["properties"] if p["type"] == "timeseries"]
    if cfg.get("default_property") and cfg["default_property"] not in cfg["properties"]:
        raise HTTPException(400, "the default time series property must be one of the configured time series properties")
    if not cfg.get("default_property") and cfg["properties"]:
        cfg["default_property"] = next(iter(cfg["properties"]))
    sensor = cfg.get("sensor")
    if sensor:
        if len(cfg["properties"]) != 1 or len(tsps) != 1:
            raise HTTPException(400, "a sensor object type has exactly one time series property (its default)")
        if not sensor.get("links"):
            raise HTTPException(400, "a sensor object type needs at least one sensor link to a root object type")
        for link in sensor["links"]:
            root = _t(link["root_object_type_id"])
            if root["id"] == t["id"]:
                raise HTTPException(400, "a sensor object type cannot link to itself")
            for key, label in (("foreign_key", "Foreign key"), ("sensor_name_property", "Sensor name")):
                p = props.get(link[key])
                if not p or p["type"] not in ("string", "integer"):
                    raise HTTPException(400, f"{label}: {link[key]} must be a string or integer property")
            if link["sensor_name_property"] in tsps or link["foreign_key"] in tsps:
                raise HTTPException(400, "the foreign key and sensor name cannot be the time series property")
        for key, kind in (("is_categorical_property", "boolean"), ("unit_property", "string"), ("interpolation_property", "string")):
            if sensor.get(key):
                p = props.get(sensor[key])
                if not p or p["type"] != kind:
                    raise HTTPException(400, f"{key.replace('_', ' ')}: {sensor[key]} must be a {kind} property")
        if t["title_property"] in tsps:
            raise HTTPException(400, "a time series property cannot be the title")
    geo = cfg.get("geospatial")
    if geo and (geo.get("track_latitude") or geo.get("track_longitude")):
        for key in ("track_latitude", "track_longitude"):
            if geo.get(key) not in cfg["properties"]:
                raise HTTPException(400, f"{key.replace('_', ' ')} must be a configured time series property")
    cfg["severed_markings"] = sorted({timeseries.sync_id_of(s) for s in cfg.get("severed_markings") or []})
    return cfg


@router.get("/object-types/{type_id}/config")
def get_config(type_id: str) -> dict:
    t = _t(type_id)
    return {"object_type_id": t["id"], **_ts_cfg(t), "units": UNITS, "interpolations": E.INTERPOLATIONS}


@router.put("/object-types/{type_id}/config")
def put_config(type_id: str, req: TimeSeriesConfig) -> dict:
    with ontology._lock:
        t = _t(type_id)
        cfg = validate_config(t, req.model_dump())
        t["time_series"] = cfg
        ontology._put("object-types", t)
    return get_config(type_id)


class AddTsp(BaseModel):
    property: str
    syncs: list[str] = Field(default_factory=list)
    unit: Formatting = Field(default_factory=Formatting)
    interpolation: Formatting = Field(default_factory=Formatting)
    external: Literal["NONE", "NEAREST"] = "NONE"
    # the last step of the setup dialog: a standard TSP, or this object type is a sensor object type
    sensor: Optional[SensorConfig] = None
    make_default: bool = False


@router.post("/object-types/{type_id}/time-series-properties")
def add_tsp(type_id: str, req: AddTsp) -> dict:
    """Time series property setup: select the string property holding series IDs, its syncs, and whether the object
    type is a sensor object type. The property becomes a time series property."""
    with ontology._lock:
        t = _t(type_id)
        p = _prop(t, req.property)
        if not p:
            raise HTTPException(404, f"{t['display_name']} has no property {req.property}")
        if req.property == t["primary_key"]:
            raise HTTPException(400, "the primary key property cannot be a time series property")
        if req.property == t["title_property"]:
            raise HTTPException(400, "the title property cannot be a time series property")
        if p["type"] not in ("string", "timeseries"):
            raise HTTPException(400, "pick a string property that contains the series IDs")
        cfg = _ts_cfg(t)
        before = json.dumps(t["properties"])
        p["type"] = "timeseries"
        cfg["properties"][req.property] = TspConfig(syncs=req.syncs, unit=req.unit, interpolation=req.interpolation, external=req.external).model_dump()
        if req.make_default or not cfg.get("default_property"):
            cfg["default_property"] = req.property
        if req.sensor is not None:
            cfg["sensor"] = req.sensor.model_dump()
        try:
            t["time_series"] = validate_config(t, cfg)
        except HTTPException:
            t["properties"] = json.loads(before)
            raise
        ontology._put("object-types", t)
    return get_config(type_id)


@router.delete("/object-types/{type_id}/time-series-properties/{prop}")
def remove_tsp(type_id: str, prop: str) -> dict:
    """The property goes back to a string property (its series IDs stay)."""
    with ontology._lock:
        t = _t(type_id)
        p = _prop(t, prop)
        if not p or p["type"] != "timeseries":
            raise HTTPException(404, "not a time series property")
        p["type"] = "string"
        cfg = _ts_cfg(t)
        cfg["properties"].pop(prop, None)
        if cfg.get("default_property") == prop:
            cfg["default_property"] = next(iter(cfg["properties"]), None)
        if not cfg["properties"]:
            cfg["sensor"] = None
        geo = cfg.get("geospatial") or {}
        if prop in (geo.get("track_latitude"), geo.get("track_longitude")):
            cfg["geospatial"] = None
        t["time_series"] = cfg
        ontology._put("object-types", t)
    return get_config(type_id)


# ------------------------------------------------------------------------------------------------
# resolving TSPs
# ------------------------------------------------------------------------------------------------


class Resolver:
    """Reads series for the engine as the caller: object type markings, sync markings (unless severed), and usage."""

    def __init__(self) -> None:
        # points scanned by nested derived series and functions, added to the outer query's count
        self.extra_scanned = 0
        self._types: dict[str, dict] = {}
        self._objects: dict[str, dict] = {}
        self._all_types: Optional[list[dict]] = None

    def type(self, type_id: str) -> dict:
        if type_id not in self._types:
            try:
                self._types[type_id] = _t(type_id)
            except HTTPException as e:
                raise E.EngineError(str(e.detail)) from None
        return self._types[type_id]

    def obj(self, ref: Optional[dict]) -> tuple[dict, str, dict]:
        if not ref:
            raise E.EngineError("pick an object: this logic reads time series of a root object")
        t = self.type(str(ref["object_type_id"]))
        pk = str(ref["primary_key"])
        if t["id"] not in self._objects:
            self._objects[t["id"]] = ontology._objects(t["id"])
        o = self._objects[t["id"]].get(pk)
        if o is None:
            raise E.EngineError(f'{t["display_name"]} "{pk}" not found')
        return t, pk, o.get("properties", {})

    def all_types(self) -> list[dict]:
        if self._all_types is None:
            self._all_types = auth.visible_resources("object_type", ontology._all("object-types"))
        return self._all_types

    # -- engine protocol --------------------------------------------------------------------------

    def tsp(self, obj: Optional[dict], prop: str, rng: tuple[Optional[int], Optional[int]], depth: int) -> E.Series:
        t, pk, props = self.obj(obj)
        if prop.startswith("sensor:"):
            name = prop[len("sensor:"):].strip().lower()
            match = [s for s in self.sensors(obj) if s["name"].lower() == name]
            if not match:
                raise E.EngineError(f'{t["display_name"]} "{pk}" has no linked sensor named {prop[7:]}')
            s = match[0]
            series = self.tsp({"object_type_id": s["object_type_id"], "primary_key": s["primary_key"]}, s["property"], rng, depth)
            return replace(series, label=series.label or s["name"])
        cfg = _ts_cfg(t)
        if not prop:
            prop = cfg.get("default_property") or ""
        pc = cfg["properties"].get(prop)
        p = _prop(t, prop)
        if not p or p["type"] != "timeseries" or pc is None:
            raise E.EngineError(f'{prop} is not a time series property of {t["display_name"]}')
        label = f'{props.get(t["title_property"]) or pk} · {p["display_name"]}'
        ref = parse_value(props.get(prop))
        unit, interp, categorical = self._formatting(t, cfg, pc, props)
        if ref["kind"] == "derived":
            import ts_derived

            s = ts_derived.resolve(ref["template"], ref["version"], {"object_type_id": t["id"], "primary_key": pk}, rng, depth + 1, self)
            return replace(s, unit=unit or s.unit, label=label)
        sync = ref["sync"]
        if sync:
            if sync not in pc["syncs"]:
                raise E.EngineError(f"{prop}: the sync {sync} of this qualified series ID is not one of the property's data sources")
            holding = [sync] if timeseries.syncs_holding(ref["series_id"], [sync]) else []
        else:
            holding = timeseries.syncs_holding(ref["series_id"], pc["syncs"])
        if not holding:
            raise E.EngineError(f'no time series data exists for series ID "{ref["series_id"]}" in the syncs of {p["display_name"]}: '
                                "check that the series IDs of the object type match the sync's")
        sync_id = holding[0]
        rec = timeseries._sync(sync_id)
        if sync_id not in cfg.get("severed_markings", []):
            try:
                auth.check_resource("timeseries_sync", sync_id)
            except HTTPException as e:
                raise E.EngineError(str(e.detail)) from None
        if rec.get("status") == "failed" and rec.get("error"):
            raise E.EngineError(f'the sync {rec["name"]} failed: {rec["error"]}')
        points = timeseries.read_points(sync_id, ref["series_id"], *rng)
        s = E.series_from_points(points, interpolation=interp, external=pc.get("external") or "NONE", unit=unit, label=label)
        if categorical is not None and categorical != s.categorical and points:
            s = replace(s, categorical=categorical)
        return s

    def _formatting(self, t: dict, cfg: dict, pc: dict, props: dict) -> tuple[Optional[str], Optional[str], Optional[bool]]:
        sensor = cfg.get("sensor") or {}
        unit = props.get(sensor["unit_property"]) if sensor.get("unit_property") else None
        interp = props.get(sensor["interpolation_property"]) if sensor.get("interpolation_property") else None
        categorical = bool(props.get(sensor["is_categorical_property"])) if sensor.get("is_categorical_property") else None
        u, i = pc.get("unit") or {}, pc.get("interpolation") or {}
        unit = unit or (props.get(u["property"]) if u.get("property") else u.get("value")) or None
        interp = interp or (props.get(i["property"]) if i.get("property") else i.get("value")) or None
        if interp and str(interp).upper() not in E.INTERPOLATIONS:
            interp = None
        return unit, (str(interp).upper() if interp else None), categorical

    def raw(self, series_id: str, sync: Optional[str], rng: tuple[Optional[int], Optional[int]]) -> E.Series:
        if sync:
            try:
                rec = timeseries.check_sync(sync)
            except HTTPException as e:
                raise E.EngineError(str(e.detail)) from None
            ids = [rec["id"]]
        else:
            ids = [s["id"] for s in auth.visible_resources("timeseries_sync", timeseries.all_syncs("timeseries"))]
        holding = timeseries.syncs_holding(series_id, ids)
        if not holding:
            raise E.EngineError(f'no time series data exists for series ID "{series_id}"' + (" in that sync" if sync else ""))
        if len(holding) > 1 and not sync:
            raise E.EngineError(f'series ID "{series_id}" is in several syncs ({", ".join(holding)}): name the sync')
        return E.series_from_points(timeseries.read_points(holding[0], series_id, *rng), label=series_id)

    def derived(self, template: str, version: Optional[str], obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], depth: int) -> E.Series:
        import ts_derived

        return ts_derived.resolve(template, version, obj, rng, depth, self)

    def sensors(self, obj: Optional[dict]) -> list[dict]:
        t, pk, _ = self.obj(obj)
        out = []
        for st in self.all_types():
            cfg = _ts_cfg(st)
            sensor = cfg.get("sensor")
            if not sensor or not cfg.get("default_property"):
                continue
            for link in sensor.get("links") or []:
                if link["root_object_type_id"] != t["id"]:
                    continue
                if st["id"] not in self._objects:
                    self._objects[st["id"]] = ontology._objects(st["id"])
                for spk, so in self._objects[st["id"]].items():
                    sp = so.get("properties", {})
                    if str(sp.get(link["foreign_key"])) == pk:
                        out.append({"name": str(sp.get(link["sensor_name_property"]) or spk), "object_type_id": st["id"], "object_type": st["display_name"],
                                    "primary_key": spk, "property": cfg["default_property"], "value": sp.get(cfg["default_property"])})
        return sorted(out, key=lambda s: s["name"].lower())

    def property(self, obj: Optional[dict], prop: str) -> Any:
        t, _pk, props = self.obj(obj)
        if not _prop(t, prop):
            raise E.EngineError(f'{t["display_name"]} has no property {prop}')
        return props.get(prop)

    def visual_function(self, fid: str) -> dict:
        import ts_derived

        return ts_derived.visual_function(fid)

    def events(self, cfg: dict, obj: Optional[dict]) -> list[dict]:
        """An event set from objects: start / end properties of an object type's objects (with the viewer's
        permissions), optionally only those whose `match_property` equals the root object's primary key."""
        import ontology_explorer as ox

        filters = []
        if cfg.get("match_property"):
            if not obj:
                raise E.EngineError("choose a root object: the event set keeps the events of that object")
            filters.append(ox.Filter(property=cfg["match_property"], op="eq", value=str(obj.get("primary_key"))))
        try:
            res = ox.search(ox.SearchIn(object_type_id=cfg["object_type_id"], filters=filters, limit=1000, histograms=False, resource="quiver"))
        except HTTPException as e:
            raise E.EngineError(str(e.detail)) from None
        out = []
        for o in res["objects"]:
            s = E.to_ms(o["properties"].get(cfg["start_property"]))
            if s is None:
                continue
            end = E.to_ms(o["properties"].get(cfg["end_property"])) if cfg.get("end_property") else s
            label = o["properties"].get(cfg["label_property"]) if cfg.get("label_property") else o.get("title")
            out.append({"start": s, "end": end, "title": "" if label is None else str(label), "object": {"object_type_id": cfg["object_type_id"], "primary_key": o["primary_key"]}})
        return out

    def function(self, cfg: dict, obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], params: dict) -> E.Series:
        import ts_derived

        return ts_derived.run_function(cfg, obj, rng, params)


def object_tsps(type_id: str, pk: str) -> list[dict]:
    """The time series an object shows: its TSPs and its linked sensors' series (search-around on sensor links)."""
    r = Resolver()
    t, key, props = r.obj({"object_type_id": type_id, "primary_key": pk})
    cfg = _ts_cfg(t)
    out = []
    for name, pc in cfg["properties"].items():
        p = _prop(t, name)
        if not p:
            continue
        unit, interp, _ = r._formatting(t, cfg, pc, props)
        value = props.get(name)
        try:
            kind = parse_value(value)["kind"] if value not in (None, "") else None
        except E.EngineError:
            kind = "invalid"
        out.append({"key": name, "label": p["display_name"], "source": "property", "value": value, "ref_kind": kind, "unit": unit,
                    "interpolation": interp, "default": cfg.get("default_property") == name})
    for s in r.sensors({"object_type_id": t["id"], "primary_key": key}):
        st, _spk, sprops = r.obj({"object_type_id": s["object_type_id"], "primary_key": s["primary_key"]})
        scfg = _ts_cfg(st)
        unit, interp, _ = r._formatting(st, scfg, scfg["properties"].get(s["property"]) or {}, sprops)
        out.append({"key": f"sensor:{s['name']}", "label": s["name"], "source": "sensor", "value": s["value"], "unit": unit, "interpolation": interp,
                    "default": False, "sensor": {"object_type_id": s["object_type_id"], "object_type": s["object_type"], "primary_key": s["primary_key"]}})
    return out


# ------------------------------------------------------------------------------------------------
# queries
# ------------------------------------------------------------------------------------------------


class ObjRef(BaseModel):
    object_type_id: str
    primary_key: str


class QueryIn(BaseModel):
    logic: dict
    root: Optional[ObjRef] = None
    start: Optional[str] = None
    end: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    cards: Optional[list[str]] = None
    buckets: int = Field(500, ge=10, le=20000)
    # what the usage is attributed to: quiver:<id>, workshop:<id>, derived:<id>, code_repo:<id>, map, catalog …
    resource: str = "catalog"
    # every point, not bucketed for a chart (FoundryTS, functions)
    raw: bool = False


def _range(start: Optional[str], end: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    try:
        return E.to_ms(start), E.to_ms(end)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/query")
def query(req: QueryIn) -> dict:
    """Evaluate time series logic (cards) for a root object over a time range: every card's result, the points
    scanned and the compute-seconds the query used."""
    start, end = _range(req.start, req.end)
    try:
        res = E.run(req.logic, Resolver(), req.root.model_dump() if req.root else None, start, end, req.params, req.cards,
                    buckets=RAW_POINTS if req.raw else req.buckets)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    timeseries.record_usage(req.resource, res["points_scanned"])
    return res


@router.get("/objects/{type_id}/{pk}/properties")
def list_object_tsps(type_id: str, pk: str) -> list[dict]:
    try:
        return object_tsps(type_id, pk)
    except E.EngineError as e:
        raise HTTPException(404, str(e)) from None


@router.get("/objects/{type_id}/{pk}/series")
def object_series(type_id: str, pk: str, property: str = "", start: Optional[str] = None, end: Optional[str] = None, buckets: int = 500,
                  resource: str = "ontology", rolling: Optional[str] = None, aggregation: str = "mean", raw: bool = False) -> dict:
    """One TSP (or "sensor:<name>") of an object, optionally with a rolling aggregate (Workshop's time series set
    transform)."""
    logic: dict = {"cards": [{"id": "A", "type": "tsp", "config": {"property": property}}], "output": "A"}
    if rolling:
        logic["cards"].append({"id": "B", "type": "rolling", "config": {"input": "A", "window": rolling, "aggregation": aggregation}})
        logic["output"] = "B"
    s, e = _range(start, end)
    try:
        res = E.run(logic, Resolver(), {"object_type_id": type_id, "primary_key": pk}, s, e, cards=[logic["output"]],
                    buckets=RAW_POINTS if raw else max(10, min(buckets, 20000)))
    except E.EngineError as ex:
        raise HTTPException(400, str(ex)) from None
    timeseries.record_usage(resource, res["points_scanned"])
    card = res["cards"][logic["output"]]
    if card["kind"] == "error":
        raise HTTPException(400, card["error"])
    return {**card, "points_scanned": res["points_scanned"], "compute_seconds": res["compute_seconds"]}


class FtsObjectsIn(BaseModel):
    object_types: list[str] = Field(default_factory=list)
    properties: list[str] = Field(default_factory=list)


@router.post("/foundryts/objects")
def foundryts_objects(req: FtsObjectsIn) -> dict:
    """FoundryTS search: objects of time series object types (ids or API names) with their properties and the time
    series properties to read (the default one, or `properties`)."""
    types = auth.visible_resources("object_type", ontology._all("object-types"))
    wanted = [w for w in req.object_types if w]
    picked = [t for t in types if not wanted or t["id"] in wanted or t["api_name"] in wanted or t["api_name"].lower() in {w.lower() for w in wanted}]
    out = []
    for t in picked:
        cfg = _ts_cfg(t)
        tsps = [p["api_name"] for p in t["properties"] if p["type"] == "timeseries"]
        series = [p for p in req.properties if p in tsps] if req.properties else ([cfg["default_property"]] if cfg.get("default_property") else tsps[:1])
        if not series:
            continue
        for pk, o in ontology._objects(t["id"]).items():
            props = o.get("properties", {})
            out.append({"object_type_id": t["id"], "object_type": t["api_name"], "primary_key": pk, "title": str(props.get(t["title_property"]) or pk),
                        "properties": props, "timeseries": tsps, "series": series})
    return {"objects": out}


# ------------------------------------------------------------------------------------------------
# time series object types, diagnostics, sync data sources
# ------------------------------------------------------------------------------------------------


def _ts_types() -> list[dict]:
    out = []
    for t in auth.visible_resources("object_type", ontology._all("object-types")):
        tsps = [p for p in t["properties"] if p["type"] == "timeseries"]
        if not tsps:
            continue
        cfg = _ts_cfg(t)
        out.append({"id": t["id"], "display_name": t["display_name"], "api_name": t["api_name"], "icon": t.get("icon"),
                    "object_count": ontology.object_count(t["id"]),
                    "properties": [{"api_name": p["api_name"], "display_name": p["display_name"], "configured": p["api_name"] in cfg["properties"],
                                    "syncs": (cfg["properties"].get(p["api_name"]) or {}).get("syncs", [])} for p in tsps],
                    "default_property": cfg.get("default_property"), "is_sensor": bool(cfg.get("sensor")),
                    "root_object_types": [link["root_object_type_id"] for link in (cfg.get("sensor") or {}).get("links", [])],
                    "geospatial": cfg.get("geospatial")})
    return out


@router.get("/object-types")
def list_ts_object_types() -> list[dict]:
    """Time series object types: object types with time series properties, and sensor object types."""
    views = {(m["rid"]): m["views"] for m in timeseries.marks() if m["kind"] == "object_type"}
    types = _ts_types()
    for t in types:
        t["views"] = views.get(t["id"], 0)
        t["sensor_types"] = [s["id"] for s in types if t["id"] in s["root_object_types"]]
    return types


@router.get("/object-types/{type_id}/diagnostics")
def diagnostics(type_id: str, samples: int = 20) -> dict:
    """"Why is my time series failing to load?": per TSP, how many objects have a value, how many resolve to data in
    the property's syncs, and the series IDs that do not."""
    t = _t(type_id)
    cfg = _ts_cfg(t)
    objs = ontology._objects(type_id)
    out = []
    for p in t["properties"]:
        if p["type"] != "timeseries":
            continue
        pc = cfg["properties"].get(p["api_name"])
        row: dict[str, Any] = {"property": p["api_name"], "display_name": p["display_name"], "configured": pc is not None, "objects": len(objs),
                               "with_value": 0, "resolved": 0, "derived": 0, "qualified": 0, "missing": [], "invalid": []}
        sync_series = {s: timeseries.series_ids(s) for s in (pc or {}).get("syncs", [])}
        for pk, o in objs.items():
            v = o.get("properties", {}).get(p["api_name"])
            if v in (None, ""):
                continue
            row["with_value"] += 1
            try:
                ref = parse_value(v)
            except E.EngineError as e:
                if len(row["invalid"]) < samples:
                    row["invalid"].append({"primary_key": pk, "value": v, "error": str(e)})
                continue
            if ref["kind"] == "derived":
                row["derived"] += 1
                row["resolved"] += 1
                continue
            if ref["sync"]:
                row["qualified"] += 1
            pool = [ref["sync"]] if ref["sync"] else list(sync_series)
            if any(ref["series_id"] in sync_series.get(s, set()) for s in pool):
                row["resolved"] += 1
            elif len(row["missing"]) < samples:
                row["missing"].append({"primary_key": pk, "series_id": ref["series_id"], "sync": ref["sync"]})
        syncs_total = set().union(*sync_series.values()) if sync_series else set()
        row["sync_series"] = len(syncs_total)
        out.append(row)
    return {"object_type_id": type_id, "properties": out}


@router.get("/syncs/{sync_id}/properties")
def sync_properties(sync_id: str) -> list[dict]:
    """The time series properties a sync is a data source of (the sync page's Ontology section)."""
    rec = timeseries.check_sync(sync_id)
    out = []
    for t in auth.visible_resources("object_type", ontology._all("object-types")):
        for name, pc in _ts_cfg(t)["properties"].items():
            if rec["id"] in pc.get("syncs", []):
                p = _prop(t, name)
                out.append({"object_type_id": t["id"], "object_type": t["display_name"], "property": name, "display_name": p["display_name"] if p else name})
    return out


# ------------------------------------------------------------------------------------------------
# setup assistant: a time series object type from its backing dataset
# ------------------------------------------------------------------------------------------------

_PARQUET_TYPES = {"Integer": "integer", "Long": "integer", "Short": "integer", "Byte": "integer", "Double": "double", "Float": "double", "Decimal": "double",
                  "Boolean": "boolean", "Timestamp": "timestamp", "Date": "date", "String": "string"}


def _cell(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, (list, dict)):
        return json.loads(json.dumps(v, default=str))
    return v


def _backing_rows(dataset_id: str) -> tuple[dict, list[dict], list[dict]]:
    info = timeseries.dataset_columns(dataset_id)
    _item, table = timeseries._dataset_table(dataset_id)
    if table.num_rows > MAX_BACKING_ROWS:
        raise HTTPException(400, f"the backing dataset has {table.num_rows:,} rows; at most {MAX_BACKING_ROWS:,} objects are indexed")
    return info, info["columns"], [{k: _cell(v) for k, v in r.items()} for r in table.to_pylist()]


def _api(name: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_") or "column"
    return out if out[0].isalpha() else f"c_{out}"


class BackedTypeIn(BaseModel):
    dataset_id: str
    display_name: str = Field(min_length=1, max_length=200)
    primary_key: str
    title_property: Optional[str] = None
    # columns holding series IDs: they become time series properties (configured in Capabilities)
    timeseries_columns: list[str] = Field(default_factory=list)
    description: str = ""


def _import_objects(t: dict, rows: list[dict], columns: dict[str, str]) -> int:
    """Replaces the objects with the dataset's rows; edit-only properties (and values of properties no column backs)
    keep their edited values for primary keys still in the data."""
    objs: dict[str, dict] = {}
    old = ontology.load_objects(t["id"])
    mapped = set(columns.values())
    kept = {p["api_name"] for p in t["properties"] if p.get("edit_only") or p["api_name"] not in mapped}
    now = ontology._now()
    types = {p["api_name"]: p["type"] for p in t["properties"]}
    pk_col = next(c for c, a in columns.items() if a == t["primary_key"])
    for r in rows:
        pk = r.get(pk_col)
        if pk in (None, ""):
            continue
        props = {}
        for col, api in columns.items():
            try:
                props[api] = ontology._coerce(types[api], r.get(col), api) if types[api] != "media" else r.get(col)
            except HTTPException:
                props[api] = None
        prev = old.get(str(pk))
        if prev:
            props.update({k: v for k, v in prev.get("properties", {}).items() if k in kept and k not in props})
        objs[str(pk)] = {"properties": props, "created_at": (prev or {}).get("created_at", now), "updated_at": now}
    ontology.save_objects(t["id"], objs)
    ontology._hook("indexed", t["id"], len(objs))
    return len(objs)


@router.post("/setup/object-type")
def create_backed_object_type(req: BackedTypeIn) -> dict:
    """Create a new object type (setup assistant → Create new object type) from a time series object type backing
    dataset: one object per row, a property per column; series ID columns become time series properties."""
    info, cols, rows = _backing_rows(req.dataset_id)
    names = [c["name"] for c in cols]
    if req.primary_key not in names:
        raise HTTPException(400, "pick the primary key column")
    if req.primary_key in req.timeseries_columns:
        raise HTTPException(400, "the primary key cannot be a time series property")
    keys = [r.get(req.primary_key) for r in rows]
    if len(set(map(str, keys))) != len(keys) or any(k in (None, "") for k in keys):
        raise HTTPException(400, f"{req.primary_key} must be unique and set on every row to be the primary key")
    api = {c["name"]: _api(c["name"]) for c in cols}
    props = []
    for c in cols:
        ptype = "timeseries" if c["name"] in req.timeseries_columns else _PARQUET_TYPES.get(c["type"], "string")
        if c["name"] == req.primary_key and ptype not in ("string", "integer"):
            ptype = "string"
        props.append({"api_name": api[c["name"]], "display_name": c["name"].replace("_", " ").strip().capitalize() or c["name"], "type": ptype, "description": ""})
    title = req.title_property if req.title_property in names and req.title_property not in req.timeseries_columns else req.primary_key
    created = ontology.create_object_type(ontology.ObjectTypeIn(display_name=req.display_name, description=req.description or f"Backed by {info['name']}",
                                                                properties=[ontology.Property(**p) for p in props], primary_key=api[req.primary_key],
                                                                title_property=api[title], generate_primary_key=False))
    with ontology._lock:
        t = ontology._get("object-types", created["id"], "object type")
        t["backing_dataset"] = {"dataset_id": req.dataset_id, "name": info["name"], "columns": api, "synced_at": ontology._now(),
                                "dataset_updated_at": info["updated_at"]}
        n = _import_objects(t, rows, api)
        ontology._put("object-types", t)
    return {**ontology.get_object_type(created["id"]), "imported": n}


@router.post("/object-types/{type_id}/sync-backing")
def sync_backing(type_id: str) -> dict:
    """Re-index the objects from the backing dataset (rows replace the objects)."""
    with ontology._lock:
        t = _t(type_id)
        b = t.get("backing_dataset")
        if not b:
            raise HTTPException(400, "this object type has no backing dataset")
    info, _cols, rows = _backing_rows(b["dataset_id"])
    with ontology._lock:
        t = _t(type_id)
        cols = {c: a for c, a in b["columns"].items() if _prop(t, a)}
        n = _import_objects(t, rows, cols)
        t["backing_dataset"] = {**b, "synced_at": ontology._now(), "dataset_updated_at": info["updated_at"]}
        ontology._put("object-types", t)
    return {"imported": n, "synced_at": t["backing_dataset"]["synced_at"]}


# ------------------------------------------------------------------------------------------------
# Time Series Catalog home and usage
# ------------------------------------------------------------------------------------------------


class Mark(BaseModel):
    kind: Literal["sync", "derived", "object_type", "quiver"]
    rid: str
    favorite: Optional[bool] = None


@router.post("/catalog/viewed")
def viewed(req: Mark) -> dict:
    timeseries.mark_viewed(req.kind, req.rid)
    return {"ok": True}


@router.put("/catalog/favorites")
def favorite(req: Mark) -> dict:
    timeseries.set_favorite(req.kind, req.rid, bool(req.favorite))
    return {"ok": True}


@router.get("/catalog/home")
def catalog_home() -> dict:
    """Recently accessed syncs and derived series, favorites, and the most viewed time series object types."""
    import ts_derived

    marks = timeseries.marks()
    syncs = {s["id"]: s for s in auth.visible_resources("timeseries_sync", timeseries.all_syncs())}
    derived = {d["id"]: d for d in ts_derived.visible()}
    types = {t["id"]: t for t in _ts_types()}

    def card(m: dict) -> Optional[dict]:
        if m["kind"] == "sync" and m["rid"] in syncs:
            s = syncs[m["rid"]]
            return {"kind": "sync", "id": s["id"], "name": s["name"], "subtitle": timeseries.KIND_LABEL[s["kind"]], **m}
        if m["kind"] == "derived" and m["rid"] in derived:
            d = derived[m["rid"]]
            return {"kind": "derived", "id": d["id"], "name": d["name"], "subtitle": f"{d['type'].capitalize()} derived series", **m}
        if m["kind"] == "object_type" and m["rid"] in types:
            t = types[m["rid"]]
            return {"kind": "object_type", "id": t["id"], "name": t["display_name"], "subtitle": "Sensor object type" if t["is_sensor"] else "Time series object type", **m}
        return None

    recent = [c for m in sorted((m for m in marks if m["last_viewed"] and m["kind"] in ("sync", "derived")), key=lambda m: m["last_viewed"], reverse=True)
              if (c := card(m))][:8]
    favorites = [c for m in marks if m["favorite"] and m["kind"] in ("sync", "derived") if (c := card(m))]
    most = [c for m in sorted((m for m in marks if m["kind"] == "object_type" and m["views"]), key=lambda m: -m["views"]) if (c := card(m))][:8]
    if len(most) < 8:
        seen = {c["id"] for c in most}
        most += [{"kind": "object_type", "id": t["id"], "name": t["display_name"], "views": 0,
                  "subtitle": "Sensor object type" if t["is_sensor"] else "Time series object type"} for t in types.values() if t["id"] not in seen][: 8 - len(most)]
    return {"recent": recent, "favorites": favorites, "most_viewed_object_types": most,
            "counts": {"syncs": sum(1 for s in syncs.values() if s["kind"] == "timeseries"), "geotemporal": sum(1 for s in syncs.values() if s["kind"] == "geotemporal"),
                       "object_types": len(types), "derived": len(derived)}}


def _label(resource: str) -> tuple[str, Optional[str]]:
    kind, _, rid = resource.partition(":")
    if kind in LABELERS and rid:
        try:
            return LABELERS[kind](rid)
        except Exception:  # noqa: BLE001 - deleted resources keep their usage
            return f"{kind} {rid} (deleted)", None
    return {"catalog": ("Time Series Catalog", "/time-series"), "ontology": ("Ontology Manager", "/ontology"), "map": ("Map", "/map")}.get(resource, (resource, None))


def _workshop_label(mid: str) -> tuple[str, Optional[str]]:
    import workshop

    return f"Workshop · {workshop._module(mid)['name']}", f"/workshop/{mid}"


def _repo_label(rid: str) -> tuple[str, Optional[str]]:
    import code_repos

    return f"Code repository · {code_repos._repo(rid)['name']}", f"/code-repositories/{rid}"


def _automation_label(aid: str) -> tuple[str, Optional[str]]:
    return f"Automate · {ontology._automation(aid)['name']}", f"/automate/{aid}"


LABELERS.update({"workshop": _workshop_label, "code_repo": _repo_label, "automate": _automation_label})


@router.get("/usage")
def usage(days: int = 30) -> dict:
    """Time series query compute usage by resource and day (Resource Management)."""
    rows = timeseries.usage_rows(days)
    by_res: dict[str, dict] = {}
    for r in rows:
        agg = by_res.setdefault(r["resource"], {"resource": r["resource"], "queries": 0, "points": 0, "compute_seconds": 0.0, "days": []})
        agg["queries"] += r["queries"]
        agg["points"] += r["points"]
        agg["compute_seconds"] += r["compute_seconds"]
        agg["days"].append({"day": r["day"], "compute_seconds": r["compute_seconds"], "queries": r["queries"]})
    out = []
    for agg in by_res.values():
        agg["label"], agg["href"] = _label(agg["resource"])
        agg["compute_seconds"] = round(agg["compute_seconds"], 3)
        out.append(agg)
    out.sort(key=lambda a: -a["compute_seconds"])
    return {"resources": out, "total_compute_seconds": round(sum(a["compute_seconds"] for a in out), 3),
            "formula": "compute-seconds = 4 × queries + points scanned / 25,000"}



@router.get("/object-types/{type_id}/tracks")
def object_tracks(type_id: str, start: Optional[str] = None, end: Optional[str] = None, limit: int = 50_000) -> dict:
    """Geospatial time series (Capabilities → Geospatial): each object's track latitude and longitude series joined
    on their timestamps, as the Map's observations (series = the object)."""
    t = _t(type_id)
    geo = _ts_cfg(t).get("geospatial") or {}
    lat, lon = geo.get("track_latitude"), geo.get("track_longitude")
    if not lat or not lon:
        raise HTTPException(400, f"{t['display_name']} has no geospatial track: set Track latitude and Track longitude in Capabilities")
    s, e = _range(start, end)
    r = Resolver()
    obs: list[dict] = []
    errors: list[str] = []
    scanned = 0
    for pk, o in ontology._objects(type_id).items():
        ref = {"object_type_id": type_id, "primary_key": pk}
        try:
            a, b = r.tsp(ref, lat, (s, e), 0), r.tsp(ref, lon, (s, e), 0)
        except E.EngineError as ex:
            errors.append(f"{pk}: {ex}")
            continue
        scanned += len(a) + len(b)
        ts, (las, los) = E.join([a, b]) if a.t and b.t else ([], ([], []))
        title = str(o.get("properties", {}).get(t["title_property"]) or pk)
        for tt, la, lo in zip(ts, las, los):
            if isinstance(la, (int, float)) and isinstance(lo, (int, float)) and -90 <= la <= 90 and -180 <= lo <= 180:
                obs.append({"series_id": title, "t": E.iso(tt), "latitude": la, "longitude": lo, "properties": {"object_type": t["display_name"], "primary_key": pk}})
    timeseries.record_usage("map", scanned)
    obs.sort(key=lambda x: x["t"])
    total = len(obs)
    return {"total": total, "truncated": total > limit, "observations": obs[-limit:], "errors": errors[:20], "name": t["display_name"]}
