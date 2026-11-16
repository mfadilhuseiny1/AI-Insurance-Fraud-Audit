"""Geospatial and geotemporal data on maps, following Palantir's "Geospatial and geotemporal" docs (Foundry Map /
Gotham Gaia). Mounted by server.py under /api/geo.

Data in the Ontology (ontology.py): `geopoint` ("lat,lon" or a geohash) and `geoshape` (GeoJSON geometry) properties
are indexed for geospatial search here; a `geotemporal_series_reference` (GTSR) property names a series of a
geotemporal series sync (timeseries.py), so the object is drawn at its latest observation with its track. Values are
checked by geo.py.

Maps (data/geo/maps/<id>.json): named maps of layers, each drawn by the Map app (/map):
  - objects: an object type's objects, filtered by area (All / View = the map's extent / Draw = a polygon or circle /
    Select = a shape picked on the map), time (static range or rolling window over a timestamp or date property),
    keyword and property filters; optionally refreshed every 30 s (live update). At most 5,000 objects.
  - tracks: "Tracks and observations search" of a geotemporal series sync: a historic range or a live feed (rolling
    window, refreshed), filtered by area.
  - eml: an Enterprise Map Layer (below), refreshed on its interval.
  - template: a search template run with input values.
  - raster: a GeoTIFF (or GeoJP2) image from Files / a media set, warped to Web Mercator (rasters > 67 MB refused).
  - choropleth: region boundaries (a GeoJSON file in Files — e.g. an export of Mapbox Boundaries or any other
    boundary set) coloured by an aggregate of an object type's objects joined on a region id.
  - dropped: chosen objects (dragged from Ontology Manager or added from an object), duplicates reported.

Curated data sources (data/geo/sources.json; Gaia's admin application, administrators only):
  - Enterprise Map Layers: backed by an AIP Logic function (its output: primary keys or objects of the layer's
    object type) or by a versioned object set (an object type with saved property filters); refresh interval and a
    geo filter property.
  - Geo searches + search templates (YAML, the `templates:` list of Gaia's Search Template panel): a query tree of
    AND / OR, KEYWORD, OBJECT_TYPE and property (EXACT / CONTAINS / RANGE) subqueries over Foundry objects, with
    inputs (TEXTFIELD, NUMBER, DATE, SELECT) filled in by whoever runs it.
  - Tile proxy allow-list (`tile_proxy_hosts`): the tile servers GET /api/geo/tile-proxy may fetch for vector tile
    layers whose server sends no CORS headers (tile_proxy.py: SSRF checks, size / time limits, cache, request log).
"""

from __future__ import annotations

import io
import json
import logging
import re
import struct
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import geo

log = logging.getLogger("bluesandai.geospatial")
router = APIRouter(prefix="/api/geo")

MAX_OBJECTS = 5000  # Gaia's object search / EML / search template limit
MAX_RASTER_BYTES = 67 * 1024 * 1024  # "Displaying raster files greater than 67 megabytes (MB) on maps is not supported."
RASTER_PX = 1024  # longest side of a warped raster
LAYER_KINDS = ("objects", "tracks", "eml", "template", "raster", "choropleth", "dropped", "tiles", "features")

DIR: Path = Path()
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "geo"
    (DIR / "maps").mkdir(parents=True, exist_ok=True)
    (DIR / "raster-cache").mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default


def _write(path: Path, data: Any) -> None:
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def _ontology():
    import ontology

    return ontology


def _bad(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


# ------------------------------------------------------------------------------------------------
# validation, CRS
# ------------------------------------------------------------------------------------------------


class ValidateIn(BaseModel):
    type: Literal["geopoint", "geoshape"]
    value: Any = None


@router.post("/validate")
def validate(req: ValidateIn) -> dict:
    """Is the value a valid geopoint / geoshape property value? The stored form, or what is wrong."""
    if req.type == "geopoint":
        try:
            return {"valid": True, "value": geo.geopoint(req.value), "problems": []}
        except geo.GeoError as e:
            return {"valid": False, "value": None, "problems": [str(e)]}
    problems = geo.geoshape_problems(req.value)
    return {"valid": not problems, "value": geo.geoshape(req.value) if not problems else None, "problems": problems}


class CleanIn(BaseModel):
    value: Any
    input_crs: str = geo.WGS84
    geometry_format: Literal["geojson", "wkt", "wkb", "geohash"] = "geojson"
    lat_long: bool = False


@router.post("/clean")
def clean(req: CleanIn) -> dict:
    """geospatial-tools' clean_geometry as a service: valid, RFC 7946 winding, EPSG:4326 GeoJSON."""
    try:
        g = geo.to_shape(req.value, req.geometry_format, req.lat_long)
        g = geo.make_valid(geo.reproject(g, req.input_crs, geo.WGS84))
        return {"value": geo.to_geojson(g), "problems": geo.geoshape_problems(geo.to_geojson(g)) if g is not None and g.geom_type != "Point" else []}
    except (geo.GeoError, ValueError, TypeError) as e:
        raise _bad(e) from None


@router.get("/crs")
def crs_list() -> list[dict]:
    return [{"code": c, "name": n} for c, n in geo.COMMON_CRS]


class ReprojectIn(BaseModel):
    from_crs: str
    to_crs: str = geo.WGS84
    # [[x, y], ...] (geographic CRSs: [longitude, latitude]) and/or a GeoJSON geometry
    points: list[list[float]] = Field(default_factory=list)
    geometry: Any = None


@router.post("/reproject")
def reproject(req: ReprojectIn) -> dict:
    try:
        pts = [list(geo.reproject_point(p[0], p[1], req.from_crs, req.to_crs)) for p in req.points]
        g = geo.to_geojson(geo.reproject(geo.to_shape(req.geometry), req.from_crs, req.to_crs)) if req.geometry else None
        return {"from_crs": geo.crs_name(req.from_crs), "to_crs": geo.crs_name(req.to_crs), "points": pts, "geometry": json.loads(g) if g else None}
    except (geo.GeoError, ValueError, TypeError) as e:
        raise _bad(e) from None


# ------------------------------------------------------------------------------------------------
# data sources: object types with geo properties, geotemporal series syncs, curated sources
# ------------------------------------------------------------------------------------------------


def _type_classes(p: dict) -> set[str]:
    return set(p.get("type_classes") or []) | ({p["type_class"]} if p.get("type_class") else set())


def _legacy_geo(props: list[dict]) -> tuple[list[str], Optional[str]]:
    """The deprecated geo type classes (before geopoint / geoshape): geo:geojson properties hold GeoJSON, a
    geo:latitude and a geo:longitude property make one point (drawn as "<latitude>+<longitude>"), geo:altitude is the
    elevation in meters. (extra geo property names, the altitude property)"""
    def first(tc: str) -> Optional[str]:
        return next((p["api_name"] for p in props if tc in _type_classes(p)), None)

    extra = [p["api_name"] for p in props if "geo:geojson" in _type_classes(p) and p["type"] not in ("geopoint", "geoshape")]
    lat, lon = first("geo:latitude"), first("geo:longitude")
    if lat and lon:
        extra.append(f"{lat}+{lon}")
    return extra, first("geo:altitude")


def prop_shape(props: dict, prop: str):
    """The shape of an object's geo property: a geopoint / geoshape / GeoJSON value, or a "<latitude>+<longitude>"
    property pair (the deprecated geo:latitude / geo:longitude type classes)."""
    if "+" in prop:
        from shapely.geometry import Point

        la, lo = prop.split("+", 1)
        try:
            lat, lon = float(props.get(la)), float(props.get(lo))
        except (TypeError, ValueError):
            return None
        return Point(lon, lat) if -90 <= lat <= 90 and -180 <= lon <= 180 else None
    return geo.value_shape(props.get(prop))


def geo_properties(t: dict) -> dict:
    props = t["properties"]
    legacy, altitude = _legacy_geo(props)
    return {
        "geo": [p["api_name"] for p in props if p["type"] in ("geopoint", "geoshape")] + legacy,
        "altitude": altitude,
        "gtsr": next(({"property": p["api_name"], "sync_id": p.get("sync_id")} for p in props if p["type"] == "geotemporal_series_reference"), None),
        "media": [p["api_name"] for p in props if p["type"] == "media"],
        "time": [p["api_name"] for p in props if p["type"] in ("timestamp", "date")],
    }


def _sources_file() -> Path:
    return DIR / "sources.json"


def _sources() -> dict:
    s = _read(_sources_file(), {}) or {}
    s.setdefault("emls", [])
    s.setdefault("geo_searches", [])
    s.setdefault("templates_yaml", "templates: []\n")
    return s


@router.get("/sources")
def sources(q: str = "") -> dict:
    """Gaia's Data sources tab: object types (with what they can be drawn from), geotemporal series syncs (tracks and
    observations search) and curated sources (EMLs as reference data layers, geo searches with their templates)."""
    import timeseries

    ont = _ontology()
    needle = q.strip().lower()
    hit = lambda *texts: not needle or any(needle in (x or "").lower() for x in texts)  # noqa: E731
    types = []
    for t in auth.visible_resources("object_type", ont._all("object-types")):
        g = geo_properties(t)
        if not (g["geo"] or g["gtsr"] or g["media"]) or not hit(t["display_name"], t["plural_name"], t["api_name"]):
            continue
        types.append({"id": t["id"], "display_name": t["display_name"], "plural_name": t["plural_name"], "api_name": t["api_name"],
                      "icon": t.get("icon"), "properties": t["properties"], **g,
                      "object_count": ont.object_count(t["id"])})
    syncs = [s for s in timeseries.list_syncs("geotemporal") if hit(s["name"], s.get("pipeline_name"))]
    src = _sources()
    templates = {t.get("id"): t for t in _templates(src)}
    searches = [{**s, "template": templates.get(s.get("template_id"))} for s in src["geo_searches"] if hit(s.get("title"), s.get("description"))]
    return {"object_types": types, "syncs": syncs, "emls": [e for e in src["emls"] if hit(e.get("name"), e.get("description"))], "geo_searches": searches}


# ------------------------------------------------------------------------------------------------
# object search
# ------------------------------------------------------------------------------------------------


class Area(BaseModel):
    # all: no filter; view / draw / select: within bbox, polygon or circle
    mode: Literal["all", "view", "draw", "select"] = "all"
    bbox: Optional[list[float]] = None  # [min_lon, min_lat, max_lon, max_lat]
    polygon: Any = None  # GeoJSON (Multi)Polygon
    circle: Optional[dict] = None  # {lat, lon, radius_m}


class TimeFilter(BaseModel):
    property: Optional[str] = None
    mode: Literal["static", "rolling"] = "static"
    start: Optional[str] = None
    end: Optional[str] = None
    minutes: Optional[float] = None


class PropertyFilter(BaseModel):
    property: str
    op: Literal["eq", "neq", "contains", "gt", "gte", "lt", "lte", "in"] = "eq"
    value: Any = None


class ObjectSearch(BaseModel):
    object_type_id: str
    # the geo property to draw / filter on; default: the first geopoint or geoshape (else the GTSR's current position)
    property: Optional[str] = None
    area: Area = Field(default_factory=Area)
    time: Optional[TimeFilter] = None
    q: str = ""
    filters: list[PropertyFilter] = Field(default_factory=list)
    primary_keys: Optional[list[str]] = None
    limit: int = MAX_OBJECTS


def _area_shape(a: Area):
    if a.mode == "all":
        return None
    from shapely.geometry import Point, box

    if a.polygon:
        try:
            return geo.make_valid(geo.to_shape(a.polygon))
        except (geo.GeoError, ValueError, TypeError) as e:
            raise HTTPException(400, f"the drawn shape is not valid GeoJSON: {e}") from None
    if a.circle:
        c = a.circle
        lat, lon, r = float(c["lat"]), float(c["lon"]), float(c.get("radius_m") or 0)
        if r <= 0:
            raise HTTPException(400, "the circle needs a radius")
        return geo.buffer(Point(lon, lat), r, _local_metric(lat, lon))
    if a.bbox and len(a.bbox) == 4:
        x0, y0, x1, y1 = a.bbox
        if x0 > x1:  # across the antimeridian
            from shapely.geometry import MultiPolygon

            return MultiPolygon([box(x0, y0, 180, y1), box(-180, y0, x1, y1)])
        return box(x0, y0, x1, y1)
    if a.mode == "all":
        return None
    raise HTTPException(400, f"area {a.mode}: give a bbox, a polygon or a circle")


def _local_metric(lat: float, lon: float) -> str:
    """A UTM zone around a point (little distortion for buffers there)."""
    zone = int((lon + 180) // 6) % 60 + 1
    return f"EPSG:{32600 + zone if lat >= 0 else 32700 + zone}"


def _when(v: Any) -> Optional[datetime]:
    if v in (None, ""):
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _time_range(tf: Optional[TimeFilter]) -> tuple[Optional[datetime], Optional[datetime]]:
    if not tf:
        return None, None
    if tf.mode == "rolling":
        if not tf.minutes or tf.minutes <= 0:
            raise HTTPException(400, "a rolling window needs its length in minutes")
        end = datetime.now(timezone.utc)
        return end - timedelta(minutes=tf.minutes), end
    return _when(tf.start), _when(tf.end)


def _matches(props: dict, f: PropertyFilter) -> bool:
    v = props.get(f.property)
    want = f.value
    if f.op == "in":
        return str(v) in {str(x) for x in (want if isinstance(want, list) else str(want).split(","))}
    if f.op in ("eq", "neq"):
        same = (str(v).lower() == str(want).lower()) if v is not None and want is not None else v == want
        return same if f.op == "eq" else not same
    if f.op == "contains":
        return want is not None and str(want).lower() in (json.dumps(v) if isinstance(v, list) else str(v or "")).lower()
    try:
        a, b = float(v), float(want)
    except (TypeError, ValueError):
        a, b = str(v or ""), str(want or "")  # ISO dates compare as text
    return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[f.op]


def latest_positions(sync_id: str, series_ids: list[str]) -> dict[str, dict]:
    """The newest observation of each series (a GTSR object's live position and live properties)."""
    import timeseries

    if not series_ids:
        return {}
    out: dict[str, dict] = {}
    with timeseries._db() as con:
        for i in range(0, len(series_ids), 500):
            chunk = series_ids[i : i + 500]
            marks = ",".join("?" * len(chunk))
            rows = con.execute(
                f"SELECT o.series_id, o.ts, o.lat, o.lon, o.props FROM observations o JOIN (SELECT series_id, MAX(ts) AS ts FROM observations "
                f"WHERE sync_id = ? AND series_id IN ({marks}) GROUP BY series_id) m ON o.series_id = m.series_id AND o.ts = m.ts WHERE o.sync_id = ?",
                [sync_id, *chunk, sync_id]).fetchall()
            for s, t, la, lo, p in rows:
                out[s] = {"t": t, "latitude": la, "longitude": lo, "properties": json.loads(p) if p else {}}
    return out


def search_objects(req: ObjectSearch) -> dict:
    """An object type's objects as map features: geometry (GeoJSON) from the geo property, or from the GTSR's latest
    observation; filtered by area, time, keyword and properties."""
    ont = _ontology()
    t = ont._object_type(req.object_type_id)
    g = geo_properties(t)
    prop = req.property or (g["geo"][0] if g["geo"] else None)
    if prop and prop not in g["geo"]:
        raise HTTPException(400, f'{prop} is not a geopoint or geoshape property of {t["display_name"]}')
    gtsr = g["gtsr"]
    if not prop and not gtsr:
        raise HTTPException(400, f'{t["display_name"]} has no geopoint, geoshape or geotemporal series reference property to draw')
    area = _area_shape(req.area)
    start, end = _time_range(req.time)
    tprop = req.time.property if req.time and req.time.property else (g["time"][0] if (start or end) and g["time"] else None)
    if (start or end) and not tprop and not gtsr:
        raise HTTPException(400, f'{t["display_name"]} has no timestamp or date property for a time filter')
    with ont._lock:
        objects = ont._objects(t["id"])
    wanted = set(map(str, req.primary_keys)) if req.primary_keys is not None else None
    needle = req.q.strip().lower()
    rows = []
    for pk, o in objects.items():
        if wanted is not None and pk not in wanted:
            continue
        props = o.get("properties", {})
        if needle and needle not in pk.lower() and not any(needle in str(v).lower() for v in props.values()):
            continue
        if not all(_matches(props, f) for f in req.filters):
            continue
        rows.append((pk, o, props))
    live: dict[str, dict] = {}
    if gtsr and gtsr.get("sync_id") and not prop:
        try:
            live = latest_positions(gtsr["sync_id"], [str(p[gtsr["property"]]) for _, _, p in rows if p.get(gtsr["property"])])
        except HTTPException:
            live = {}
    from shapely.geometry import Point, mapping

    features, total = [], 0
    for pk, o, props in rows:
        position = None
        if prop:
            shape = prop_shape(props, prop)
        else:
            position = live.get(str(props.get(gtsr["property"]))) if gtsr else None
            shape = Point(position["longitude"], position["latitude"]) if position else None
        if shape is None or shape.is_empty:
            continue
        if area is not None and not area.intersects(shape):
            continue
        if start or end:
            tv = _when(position["t"]) if position and not tprop else _when(props.get(tprop)) if tprop else None
            if tv is None or (start and tv < start) or (end and tv > end):
                continue
        total += 1
        if len(features) >= max(1, min(req.limit, MAX_OBJECTS)):
            continue
        f = {**ont._public_object(t, pk, o), "geometry": geo._round(mapping(shape))}
        if g["altitude"] and isinstance(props.get(g["altitude"]), (int, float)):
            f["altitude"] = props[g["altitude"]]
        if gtsr and props.get(gtsr["property"]):
            f["series"] = {"sync_id": gtsr.get("sync_id"), "series_id": str(props[gtsr["property"]]), "position": position}
        features.append(f)
    return {"object_type": {"id": t["id"], "display_name": t["display_name"], "plural_name": t["plural_name"], "icon": t.get("icon"),
                            "title_property": t["title_property"], "properties": t["properties"]},
            "property": prop, "total": total, "truncated": total > len(features), "features": features}


@router.post("/objects/search")
def objects_search(req: ObjectSearch) -> dict:
    return search_objects(req)


@router.get("/objects/{type_id}/{pk}/track")
def object_track(type_id: str, pk: str, start: Optional[str] = None, end: Optional[str] = None, minutes: Optional[float] = None,
                 limit: int = 20000) -> dict:
    """The observations of an object's geotemporal series (its GTSR), oldest first — the track and observation log.
    `minutes`: a rolling window up to now."""
    import timeseries

    ont = _ontology()
    t = ont._object_type(type_id)
    gtsr = geo_properties(t)["gtsr"]
    if not gtsr:
        raise HTTPException(400, f'{t["display_name"]} has no geotemporal series reference property')
    with ont._lock:
        key, o = ont._find(t, pk)
    sid = o.get("properties", {}).get(gtsr["property"])
    if not sid:
        return {"sync_id": gtsr.get("sync_id"), "series_id": None, "total": 0, "truncated": False, "observations": []}
    if minutes:
        start = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    res = timeseries.observations(gtsr["sync_id"], start=start, end=end, series=str(sid), limit=limit)
    live = [p for p in _live_properties(gtsr["sync_id"])]
    return {"sync_id": gtsr["sync_id"], "series_id": str(sid), "live_properties": live, **res}


def _live_properties(sync_id: str) -> list[str]:
    """The live properties of a sync (what each observation carries besides series id, time and position)."""
    import timeseries

    rec = timeseries._sync(sync_id)
    mapped = (rec.get("mapping") or {}).get("properties")
    if mapped:
        return list(mapped)
    with timeseries._db() as con:
        row = con.execute("SELECT props FROM observations WHERE sync_id = ? AND props IS NOT NULL ORDER BY ts DESC LIMIT 1", (sync_id,)).fetchone()
    return list(json.loads(row[0])) if row and row[0] else []


class TrackSearch(BaseModel):
    sync_id: str
    mode: Literal["historic", "live"] = "historic"
    start: Optional[str] = None
    end: Optional[str] = None
    minutes: float = 60
    area: Area = Field(default_factory=Area)
    series: Optional[list[str]] = None
    limit: int = 50000


@router.post("/tracks/search")
def tracks_search(req: TrackSearch) -> dict:
    """Tracks and observations search of a geotemporal series sync: a historic range or a live feed (the last
    `minutes` up to now), only the series with an observation inside the area."""
    import timeseries

    if req.mode == "live":
        start, end = (datetime.now(timezone.utc) - timedelta(minutes=max(1.0, req.minutes))).isoformat(), None
    else:
        start, end = req.start, req.end
    res = timeseries.observations(req.sync_id, start=start, end=end, limit=req.limit)
    obs = res["observations"]
    if req.series:
        keep = set(req.series)
        obs = [o for o in obs if o["series_id"] in keep]
    area = _area_shape(req.area)
    if area is not None:
        from shapely import prepared
        from shapely.geometry import Point

        pa = prepared.prep(area)
        inside = {o["series_id"] for o in obs if pa.intersects(Point(o["longitude"], o["latitude"]))}
        obs = [o for o in obs if o["series_id"] in inside]
    return {"sync": timeseries.get_sync(req.sync_id), "total": res["total"], "truncated": res["truncated"], "observations": obs,
            "live_properties": _live_properties(req.sync_id)}


# ------------------------------------------------------------------------------------------------
# curated sources: Enterprise Map Layers, geo searches and search templates (administrators)
# ------------------------------------------------------------------------------------------------


class EmlIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    kind: Literal["function", "object_set"] = "object_set"
    object_type_id: str
    function_id: Optional[str] = None  # AIP Logic function (function EMLs)
    filters: list[PropertyFilter] = Field(default_factory=list)  # versioned object set EMLs
    refresh_seconds: Optional[int] = Field(None, ge=5)
    geo_filter_property: Optional[str] = None
    capabilities: list[str] = Field(default_factory=list)
    icon: str = "layers"
    classification: str = ""
    acl_groups: list[str] = Field(default_factory=list)


def _check_eml(e: dict) -> None:
    ont = _ontology()
    t = ont._object_type(e["object_type_id"])
    g = geo_properties(t)
    if not (g["geo"] or g["gtsr"]):
        raise HTTPException(400, f'{t["display_name"]} has no geopoint, geoshape or geotemporal series reference property')
    if e.get("geo_filter_property") and e["geo_filter_property"] not in g["geo"]:
        raise HTTPException(400, "the geo filter property must be a geopoint or geoshape property of the object type")
    if e["kind"] == "function":
        if not e.get("function_id"):
            raise HTTPException(400, "a function EML needs the AIP Logic function that returns its objects")
        fn = ont._logic(e["function_id"])
        if any(i.get("required", True) for i in fn.get("inputs") or []):
            raise HTTPException(400, f'{fn["name"]} has required inputs: an EML function takes none')


def _eml(eml_id: str) -> dict:
    e = next((x for x in _sources()["emls"] if x["id"] == eml_id), None)
    if not e:
        raise HTTPException(404, "Enterprise Map Layer not found")
    _acl(e.get("acl_groups"))
    return e


def _acl(groups: Optional[list[str]]) -> None:
    """ACL groups: only members (and administrators) may use a curated source."""
    if not groups or not auth.enabled():
        return
    p = auth.require_user()
    if p.get("role") in ("admin", "service") or p.get("service"):
        return
    mine = set(p.get("groups") or [])
    names = {g["id"]: g.get("name") for g in auth._groups()} if mine else {}
    mine |= {names[g] for g in list(mine) if names.get(g)}
    if not mine & set(groups):
        raise HTTPException(403, "You are not in the groups this data source is shared with")


@router.get("/emls")
def list_emls() -> list[dict]:
    return _sources()["emls"]


@router.post("/emls")
def create_eml(req: EmlIn) -> dict:
    auth.require_admin()
    with _lock:
        rec = {"id": "eml-" + uuid.uuid4().hex[:10], **req.model_dump(), "created_at": _now(), "updated_at": _now()}
        _check_eml(rec)
        s = _sources()
        s["emls"].append(rec)
        _write(_sources_file(), s)
        return rec


@router.put("/emls/{eml_id}")
def update_eml(eml_id: str, req: EmlIn) -> dict:
    auth.require_admin()
    with _lock:
        s = _sources()
        i = next((i for i, x in enumerate(s["emls"]) if x["id"] == eml_id), None)
        if i is None:
            raise HTTPException(404, "Enterprise Map Layer not found")
        rec = {**s["emls"][i], **req.model_dump(), "updated_at": _now()}
        _check_eml(rec)
        s["emls"][i] = rec
        _write(_sources_file(), s)
        return rec


@router.delete("/emls/{eml_id}")
def delete_eml(eml_id: str) -> dict:
    auth.require_admin()
    with _lock:
        s = _sources()
        s["emls"] = [x for x in s["emls"] if x["id"] != eml_id]
        _write(_sources_file(), s)
    return {"deleted": eml_id}


def _function_keys(output: Any) -> list[str]:
    """Primary keys from an EML function's output: a list of keys or objects, or {primary_keys: [...]}."""
    if isinstance(output, str):
        try:
            output = json.loads(output)
        except json.JSONDecodeError:
            output = [s.strip() for s in output.replace("\n", ",").split(",") if s.strip()]
    if isinstance(output, dict):
        output = output.get("primary_keys") or output.get("objects") or output.get("edits") or []
    keys = []
    for x in output if isinstance(output, list) else []:
        if isinstance(x, dict):
            x = x.get("primary_key") or x.get("primaryKey") or x.get("$primaryKey")
        if x not in (None, ""):
            keys.append(str(x))
    return keys


class LayerQuery(BaseModel):
    area: Area = Field(default_factory=Area)
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/emls/{eml_id}/features")
def eml_features(eml_id: str, req: LayerQuery) -> dict:
    """An EML's objects: a function EML runs its AIP Logic function (preview, nothing applied) for the primary keys;
    a versioned object set EML applies its saved filters. The geo filter property limits them to the area."""
    e = _eml(eml_id)
    keys = None
    if e["kind"] == "function":
        run = _ontology().run_logic(e["function_id"], {}, apply=False, source=f"eml:{eml_id}")
        if run.get("status") != "succeeded":
            raise HTTPException(400, f'the EML function failed: {run.get("error")}')
        keys = _function_keys(run.get("output"))
    res = search_objects(ObjectSearch(object_type_id=e["object_type_id"], property=e.get("geo_filter_property"),
                                      area=req.area if e.get("geo_filter_property") else Area(), filters=[PropertyFilter(**f) for f in e.get("filters") or []],
                                      primary_keys=keys))
    return {**res, "eml": e, "refreshed_at": _now()}


def _templates(src: Optional[dict] = None) -> list[dict]:
    import yaml

    src = src or _sources()
    try:
        doc = yaml.safe_load(src.get("templates_yaml") or "") or {}
    except yaml.YAMLError:
        return []
    items = doc.get("templates") if isinstance(doc, dict) else doc
    return [t for t in (items or []) if isinstance(t, dict) and t.get("id")]


QUERY_TYPES = ("AND", "OR", "KEYWORD", "OBJECT_TYPE", "EXACT", "CONTAINS", "RANGE", "NOT")


def check_templates(text: str) -> list[dict]:
    """Parse and check the search template YAML; HTTP 400 says what is wrong."""
    import yaml

    try:
        doc = yaml.safe_load(text or "") or {}
    except yaml.YAMLError as e:
        raise HTTPException(400, f"the YAML does not parse: {e}") from None
    items = doc.get("templates") if isinstance(doc, dict) else doc
    if items is None:
        items = []
    if not isinstance(items, list):
        raise HTTPException(400, "expected a `templates:` list")
    ids = set()
    for t in items:
        if not isinstance(t, dict) or not t.get("id"):
            raise HTTPException(400, "every template needs an id")
        if t["id"] in ids:
            raise HTTPException(400, f'two templates have the id {t["id"]}')
        ids.add(t["id"])
        inputs = {i.get("id") for i in t.get("inputs") or [] if isinstance(i, dict)}

        def walk(q: Any, path: str) -> None:
            if not isinstance(q, dict):
                raise HTTPException(400, f'{t["id"]}: {path} must be a mapping')
            qt = str(q.get("queryType", "")).upper()
            if qt not in QUERY_TYPES:
                raise HTTPException(400, f'{t["id"]}: {path}: queryType {q.get("queryType")!r} is not one of {", ".join(QUERY_TYPES)}')
            if q.get("inputId") and q["inputId"] not in inputs:
                raise HTTPException(400, f'{t["id"]}: {path}: input {q["inputId"]!r} is not declared under inputs')
            for i, sub in enumerate(q.get("subqueries") or []):
                walk(sub, f"{path}.subqueries[{i}]")

        walk(t.get("query") or {"queryType": "AND"}, "query")
    return items


class GeoSearchIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    tab_id: str = ""
    tab_icon: str = "search"
    template_id: str
    classification: str = ""
    acl_groups: list[str] = Field(default_factory=list)


class TemplatesIn(BaseModel):
    yaml: str


@router.get("/search-templates")
def get_templates() -> dict:
    s = _sources()
    return {"yaml": s["templates_yaml"], "templates": _templates(s), "geo_searches": s["geo_searches"]}


@router.put("/search-templates")
def save_templates(req: TemplatesIn) -> dict:
    auth.require_admin()
    check_templates(req.yaml)
    with _lock:
        s = _sources()
        s["templates_yaml"] = req.yaml
        _write(_sources_file(), s)
    return get_templates()


@router.post("/geo-searches")
def create_geo_search(req: GeoSearchIn) -> dict:
    auth.require_admin()
    with _lock:
        s = _sources()
        if req.template_id not in {t["id"] for t in _templates(s)}:
            raise HTTPException(400, f"no search template has the id {req.template_id!r} (Template ID must match a template's id)")
        rec = {"id": "gs-" + uuid.uuid4().hex[:10], **req.model_dump(), "tab_id": req.tab_id or req.template_id, "created_at": _now()}
        s["geo_searches"].append(rec)
        _write(_sources_file(), s)
        return rec


@router.delete("/geo-searches/{search_id}")
def delete_geo_search(search_id: str) -> dict:
    auth.require_admin()
    with _lock:
        s = _sources()
        s["geo_searches"] = [x for x in s["geo_searches"] if x["id"] != search_id]
        _write(_sources_file(), s)
    return {"deleted": search_id}


def _object_type_ref(ref: Any) -> Optional[str]:
    """An OBJECT_TYPE subquery value: an object type id or API name (Foundry would give the RID)."""
    ont = _ontology()
    for t in ont._all("object-types"):
        if str(ref) in (t["id"], t["api_name"], t["display_name"]):
            return t["id"]
    return None


def _template_matcher(q: dict, inputs: dict[str, Any]):
    """(object type ids the query is limited to, a predicate over (pk, properties))."""
    qt = str(q.get("queryType", "AND")).upper()
    val = inputs.get(q["inputId"]) if q.get("inputId") else q.get("value")
    if qt in ("AND", "OR", "NOT"):
        parts = [_template_matcher(s, inputs) for s in q.get("subqueries") or []]
        types: Optional[set] = None
        for ts, _ in parts:
            if ts is not None:
                types = ts if types is None else (types & ts if qt == "AND" else types | ts)
        preds = [p for _, p in parts]
        if qt == "AND":
            return types, lambda pk, pr: all(p(pk, pr) for p in preds)
        if qt == "NOT":
            return None, lambda pk, pr: not any(p(pk, pr) for p in preds)
        return types, lambda pk, pr: any(p(pk, pr) for p in preds) if preds else True
    if qt == "OBJECT_TYPE":
        refs = val if isinstance(val, list) else [val]
        return {x for x in (_object_type_ref(r) for r in refs if r) if x}, lambda pk, pr: True
    if qt == "KEYWORD":
        needle = str(val or "").strip().lower()
        return None, lambda pk, pr: not needle or needle in pk.lower() or any(needle in str(v).lower() for v in pr.values())
    field = q.get("field")
    if not field:
        return None, lambda pk, pr: True
    if val in (None, "") and qt != "RANGE":
        return None, lambda pk, pr: True  # an empty input does not filter
    if qt == "EXACT":
        vals = {str(v).lower() for v in (val if isinstance(val, list) else [val])}
        return None, lambda pk, pr: str(pr.get(field)).lower() in vals
    if qt == "CONTAINS":
        return None, lambda pk, pr: str(val).lower() in str(pr.get(field) or "").lower()
    lo = inputs.get(q["minInputId"]) if q.get("minInputId") else q.get("gte", q.get("min"))
    hi = inputs.get(q["maxInputId"]) if q.get("maxInputId") else q.get("lte", q.get("max"))

    def in_range(pk: str, pr: dict) -> bool:
        v = pr.get(field)
        if v is None:
            return False
        try:
            return (lo in (None, "") or float(v) >= float(lo)) and (hi in (None, "") or float(v) <= float(hi))
        except (TypeError, ValueError):
            return (lo in (None, "") or str(v) >= str(lo)) and (hi in (None, "") or str(v) <= str(hi))

    return None, in_range


@router.post("/search-templates/{template_id}/run")
def run_template(template_id: str, req: LayerQuery) -> dict:
    """Run a search template with input values over Foundry objects; one feature list per object type."""
    s = _sources()
    t = next((x for x in _templates(s) if x["id"] == template_id), None)
    if not t:
        raise HTTPException(404, "search template not found")
    for gs in s["geo_searches"]:
        if gs.get("template_id") == template_id:
            _acl(gs.get("acl_groups"))
    for i in t.get("inputs") or []:
        if i.get("required") and inputs_missing(req.inputs, i.get("id")):
            raise HTTPException(400, f'{i.get("label") or i.get("id")} is required')
    types, pred = _template_matcher(t.get("query") or {"queryType": "AND"}, req.inputs)
    ont = _ontology()
    candidates = [x["id"] for x in auth.visible_resources("object_type", ont._all("object-types"))
                  if (geo_properties(x)["geo"] or geo_properties(x)["gtsr"]) and (types is None or x["id"] in types)]
    layers, total = [], 0
    for type_id in candidates:
        with ont._lock:
            objects = ont._objects(type_id)
        keys = [pk for pk, o in objects.items() if pred(pk, o.get("properties", {}))]
        if not keys:
            continue
        res = search_objects(ObjectSearch(object_type_id=type_id, area=req.area, primary_keys=keys, limit=max(1, MAX_OBJECTS - total)))
        total += res["total"]
        layers.append(res)
        if total >= MAX_OBJECTS:
            break
    return {"template": t, "total": total, "results": layers}


def inputs_missing(inputs: dict, key: Optional[str]) -> bool:
    return key is not None and inputs.get(key) in (None, "")


# ------------------------------------------------------------------------------------------------
# saved maps
# ------------------------------------------------------------------------------------------------


class Layer(BaseModel):
    id: str = Field(default_factory=lambda: "l-" + uuid.uuid4().hex[:8])
    name: str = Field(max_length=200)
    kind: Literal["objects", "tracks", "eml", "template", "raster", "choropleth", "dropped", "tiles", "features"]
    visible: bool = True
    color: str = "#38bdf8"
    opacity: float = Field(1.0, ge=0, le=1)
    config: dict[str, Any] = Field(default_factory=dict)


class MapIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    basemap: str = "streets"
    view: Optional[dict] = None  # {lat, lon, zoom}
    layers: list[Layer] = Field(default_factory=list)


def _map_path(map_id: str) -> Path:
    if not re.fullmatch(r"map-[a-f0-9]{10}", map_id):
        raise HTTPException(404, "map not found")
    return DIR / "maps" / f"{map_id}.json"


def _check_layers(layers: list[dict]) -> None:
    for l in layers:
        c = l.get("config") or {}
        need = {"objects": "object_type_id", "tracks": "sync_id", "eml": "eml_id", "template": "template_id", "choropleth": "boundaries_item_id",
                "dropped": "object_type_id", "tiles": "url", "features": "url"}.get(l["kind"])
        if need and not c.get(need):
            raise HTTPException(400, f'layer {l["name"]}: {need} is missing')
        if l["kind"] == "raster" and not (c.get("item_id") or c.get("object_type_id")):
            raise HTTPException(400, f'layer {l["name"]}: pick a raster file or an object type with a media property')


def _get_map(map_id: str) -> dict:
    rec = _read(_map_path(map_id))
    if not rec:
        raise HTTPException(404, "map not found")
    auth.check_resource("map", map_id)
    return rec


@router.get("/maps")
def list_maps() -> list[dict]:
    recs = [r for p in (DIR / "maps").glob("map-*.json") if (r := _read(p))]
    recs = auth.visible_resources("map", recs)
    return sorted(({**r, "layer_count": len(r.get("layers") or [])} for r in recs), key=lambda r: r.get("updated_at", ""), reverse=True)


@router.post("/maps")
def create_map(req: MapIn) -> dict:
    p = auth.require_user()
    rec = {"id": "map-" + uuid.uuid4().hex[:10], **req.model_dump(), "created_by": p.get("username"), "created_at": _now(), "updated_at": _now()}
    _check_layers(rec["layers"])
    with _lock:
        _write(_map_path(rec["id"]), rec)
    return rec


@router.get("/maps/{map_id}")
def get_map(map_id: str) -> dict:
    return _get_map(map_id)


@router.put("/maps/{map_id}")
def save_map(map_id: str, req: MapIn) -> dict:
    with _lock:
        rec = _get_map(map_id)
        rec.update(req.model_dump(), updated_at=_now())
        _check_layers(rec["layers"])
        _write(_map_path(map_id), rec)
        return rec


@router.delete("/maps/{map_id}")
def delete_map(map_id: str) -> dict:
    with _lock:
        _get_map(map_id)
        _map_path(map_id).unlink(missing_ok=True)
    return {"deleted": map_id}


class DuplicatesIn(BaseModel):
    object_type_id: str
    primary_keys: list[str]


@router.post("/maps/{map_id}/duplicates")
def duplicates(map_id: str, req: DuplicatesIn) -> dict:
    """Which of these objects are already on the map (in a dropped-objects layer of the same type)."""
    rec = _get_map(map_id)
    have = {str(k) for l in rec.get("layers") or [] if l["kind"] == "dropped" and (l.get("config") or {}).get("object_type_id") == req.object_type_id
            for k in (l["config"].get("primary_keys") or [])}
    return {"duplicates": [k for k in req.primary_keys if str(k) in have]}


# ------------------------------------------------------------------------------------------------
# choropleth: boundaries (a GeoJSON from Files) coloured by an aggregate of objects
# ------------------------------------------------------------------------------------------------


class ChoroplethIn(BaseModel):
    boundaries_item_id: str
    feature_key: str  # the region id in each boundary feature's properties (e.g. mapbox_id)
    object_type_id: Optional[str] = None
    join_property: Optional[str] = None  # the object property holding the region id
    agg: Literal["count", "sum", "avg", "min", "max"] = "count"
    value_property: Optional[str] = None


def _files_bytes(item_id: str, limit: int) -> tuple[dict, bytes]:
    import drive

    item = drive.get_file(item_id)
    if (item.get("size") or 0) > limit:
        raise HTTPException(413, f'{item["name"]} is {item["size"] / 1e6:.0f} MB: files over {limit // (1024 * 1024)} MB are not displayed on maps')
    return item, drive.read_bytes(item)


@router.post("/choropleth")
def choropleth(req: ChoroplethIn) -> dict:
    _, data = _files_bytes(req.boundaries_item_id, 200 * 1024 * 1024)
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(400, "the boundaries file is not GeoJSON") from None
    feats = doc.get("features") if isinstance(doc, dict) and doc.get("type") == "FeatureCollection" else None
    if feats is None:
        raise HTTPException(400, "the boundaries file must be a GeoJSON FeatureCollection")
    values: dict[str, list[float]] = {}
    if req.object_type_id and req.join_property:
        ont = _ontology()
        ont._object_type(req.object_type_id)
        with ont._lock:
            objects = ont._objects(req.object_type_id)
        for o in objects.values():
            pr = o.get("properties", {})
            k = pr.get(req.join_property)
            if k in (None, ""):
                continue
            if req.agg == "count":
                values.setdefault(str(k), []).append(1.0)
            else:
                try:
                    values.setdefault(str(k), []).append(float(pr.get(req.value_property)))
                except (TypeError, ValueError):
                    continue
    agg = {"count": sum, "sum": sum, "avg": lambda v: sum(v) / len(v), "min": min, "max": max}[req.agg]
    out = []
    for f in feats:
        props = f.get("properties") or {}
        key = props.get(req.feature_key)
        v = values.get(str(key)) if key is not None else None
        out.append({"id": key, "name": props.get("name") or props.get("name_en") or props.get("NAME") or key, "geometry": f.get("geometry"),
                    "value": agg(v) if v else (0 if req.agg == "count" and values else None)})
    nums = [x["value"] for x in out if isinstance(x["value"], (int, float))]
    return {"features": out, "min": min(nums) if nums else None, "max": max(nums) if nums else None, "matched": sum(1 for x in out if x["id"] is not None and str(x["id"]) in values)}


# ------------------------------------------------------------------------------------------------
# raster: GeoTIFF / GeoJP2 warped to Web Mercator
# ------------------------------------------------------------------------------------------------

_GEOJP2_UUID = bytes.fromhex("b14bf8bd083d4b43a5ae8cd7d5a6ce03")


def _geojp2_tiff(data: bytes) -> Optional[bytes]:
    """The degenerate GeoTIFF inside a GeoJP2 'uuid' box (its tags carry the georeference)."""
    i = 0
    while i + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[i : i + 8])
        head = 8
        if size == 1:
            size = struct.unpack(">Q", data[i + 8 : i + 16])[0]
            head = 16
        elif size == 0:
            size = len(data) - i
        if kind == b"uuid" and data[i + head : i + head + 16] == _GEOJP2_UUID:
            return data[i + head + 16 : i + size]
        if kind == b"jp2h" or size < head:
            pass
        i += max(size, head)
    return None


def _georef(tags: dict) -> dict:
    """Pixel → model transform and CRS from GeoTIFF tags (ModelPixelScale + ModelTiepoint, or ModelTransformation)."""
    keys = tags.get(34735)
    epsg, raster_type = None, 1
    if keys:
        k = list(keys)
        for n in range(k[3]):
            key, loc, _count, value = k[4 + 4 * n : 8 + 4 * n]
            if loc != 0:
                continue
            if key == 3072 and value not in (0, 32767):
                epsg = value
            elif key == 2048 and value not in (0, 32767) and epsg is None:
                epsg = value
            elif key == 1025:
                raster_type = value
    shift = 0.5 if raster_type == 2 else 0.0  # PixelIsPoint: tie points name pixel centres
    if tags.get(34264):
        m = list(tags[34264])
        a, b, c, d, e, f = m[0], m[1], m[3], m[4], m[5], m[7]
    elif tags.get(33550) and tags.get(33922):
        sx, sy = list(tags[33550])[:2]
        tp = list(tags[33922])
        i, j, x, y = tp[0], tp[1], tp[3], tp[4]
        a, b, c, d, e, f = sx, 0.0, x - (i - shift) * sx, 0.0, -sy, y + (j - shift) * sy
    else:
        raise geo.GeoError("no georeference (GeoTIFF ModelTiepoint / ModelPixelScale or ModelTransformation tags)")
    return {"affine": (a, b, c, d, e, f), "crs": f"EPSG:{epsg}" if epsg else geo.WGS84, "crs_assumed": epsg is None}


def _to_rgba(img):
    """Any Pillow image as RGBA; single-band 16-bit / float data stretched (2nd–98th percentile) to grey."""
    import numpy as np
    from PIL import Image

    if img.mode in ("RGB", "RGBA", "L", "LA", "P", "1", "CMYK"):
        return img.convert("RGBA")
    arr = np.asarray(img, dtype="float64")
    nodata = img.info.get("nodata")
    valid = np.isfinite(arr) & (arr != nodata if nodata is not None else True)
    if not valid.any():
        return Image.new("RGBA", img.size, (0, 0, 0, 0))
    lo, hi = np.percentile(arr[valid], [2, 98])
    grey = np.clip((arr - lo) / ((hi - lo) or 1) * 255, 0, 255).astype("uint8")
    rgba = np.dstack([grey, grey, grey, np.where(valid, 255, 0).astype("uint8")])
    return Image.fromarray(rgba, "RGBA")


def raster_from_bytes(data: bytes, name: str = "") -> tuple[dict, bytes]:
    """(info, PNG) of a georeferenced raster, warped to Web Mercator (nearest neighbour) so it lines up on the map.
    info: bbox [min_lon, min_lat, max_lon, max_lat], mercator bounds, source size and CRS."""
    import numpy as np
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 400_000_000
    head = data[:12]
    if data[:4] == b"NITF" or name.lower().endswith((".ntf", ".nitf")):
        raise geo.GeoError("NITF rasters cannot be drawn here (no GDAL); convert them to GeoTIFF in a transform")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001
        raise geo.GeoError(f"could not read the raster: {e}") from None
    if head.startswith(b"\x00\x00\x00\x0cjP  ") or img.format == "JPEG2000":
        box = _geojp2_tiff(data)
        if not box:
            raise geo.GeoError("this JPEG 2000 file has no GeoJP2 georeference")
        tags = dict(Image.open(io.BytesIO(box)).tag_v2)
    elif img.format == "TIFF":
        tags = dict(img.tag_v2)
        if tags.get(42113) not in (None, ""):
            try:
                img.info["nodata"] = float(str(tags[42113]).strip("\x00 "))
            except ValueError:
                pass
    else:
        raise geo.GeoError(f"{img.format or 'this'} images carry no georeference: use a GeoTIFF (or GeoJP2)")
    ref = _georef(tags)
    a, b, c, d, e, f = ref["affine"]
    w, h = img.size
    corners = [(c + a * i + b * j, f + d * i + e * j) for i, j in ((0, 0), (w, 0), (w, h), (0, h))]
    lonlat = [geo.reproject_point(x, y, ref["crs"], geo.WGS84) for x, y in corners]
    merc = [geo.reproject_point(lo, la, geo.WGS84, "EPSG:3857") for lo, la in lonlat]
    mx0, mx1 = min(p[0] for p in merc), max(p[0] for p in merc)
    my0, my1 = min(p[1] for p in merc), max(p[1] for p in merc)
    # about the source resolution (a little more, so warping keeps detail), at most RASTER_PX on the longest side
    scale = min(RASTER_PX, max(256, 2 * max(w, h))) / max(mx1 - mx0, my1 - my0, 1e-9)
    ow, oh = max(1, round((mx1 - mx0) * scale)), max(1, round((my1 - my0) * scale))
    # output pixel centres in Web Mercator → source CRS → source pixel (inverse affine)
    xs = mx0 + (np.arange(ow) + 0.5) / scale
    ys = my1 - (np.arange(oh) + 0.5) / scale
    gx, gy = np.meshgrid(xs, ys)
    sx, sy = geo.transformer("EPSG:3857", ref["crs"]).transform(gx.ravel(), gy.ravel())
    det = a * e - b * d
    if not det:
        raise geo.GeoError("the raster's transform is degenerate")
    sx, sy = np.asarray(sx) - c, np.asarray(sy) - f
    pi = np.floor((e * sx - b * sy) / det).astype("int64")
    pj = np.floor((-d * sx + a * sy) / det).astype("int64")
    inside = (pi >= 0) & (pi < w) & (pj >= 0) & (pj < h)
    src = np.asarray(_to_rgba(img))
    out = np.zeros((oh * ow, 4), dtype="uint8")
    out[inside] = src[pj[inside], pi[inside]]
    png = io.BytesIO()
    Image.fromarray(out.reshape(oh, ow, 4), "RGBA").save(png, "PNG", optimize=True)
    lons, lats = [p[0] for p in lonlat], [p[1] for p in lonlat]
    info = {"bbox": [min(lons), min(lats), max(lons), max(lats)], "mercator": [mx0, my0, mx1, my1], "width": w, "height": h,
            "crs": geo.crs_name(ref["crs"]), "crs_assumed": ref["crs_assumed"], "format": img.format, "mode": img.mode,
            "corners": [[la, lo] for lo, la in lonlat]}
    return info, png.getvalue()


def _raster(item_id: str) -> tuple[dict, bytes]:
    import drive

    item = drive.get_file(item_id)
    cache = DIR / "raster-cache" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', item_id)}-{(item.get('updated_at') or item.get('created_at') or '')[:19].replace(':', '')}"
    info_path, png_path = cache.with_suffix(".json"), cache.with_suffix(".png")
    if info_path.is_file() and png_path.is_file():
        return json.loads(info_path.read_text("utf-8")), png_path.read_bytes()
    item, data = _files_bytes(item_id, MAX_RASTER_BYTES)
    try:
        info, png = raster_from_bytes(data, item["name"])
    except geo.GeoError as e:
        raise HTTPException(400, f'{item["name"]}: {e}') from None
    info["name"] = item["name"]
    png_path.write_bytes(png)
    _write(info_path, info)
    return info, png


@router.get("/raster/{item_id}")
def raster_info(item_id: str) -> dict:
    import pipeline_ai

    return _raster(pipeline_ai.parse_ref(item_id)[0])[0]


@router.get("/raster/{item_id}/image")
def raster_image(item_id: str) -> Response:
    import pipeline_ai

    return Response(_raster(pipeline_ai.parse_ref(item_id)[0])[1], media_type="image/png", headers={"Cache-Control": "private, max-age=300"})


@router.post("/raster/objects")
def raster_objects(req: ObjectSearch) -> dict:
    """The media (raster) property values of an object type's objects, for raster layers backed by objects."""
    ont = _ontology()
    t = ont._object_type(req.object_type_id)
    media = geo_properties(t)["media"]
    prop = req.property or (media[0] if media else None)
    if not prop or prop not in media:
        raise HTTPException(400, f'{t["display_name"]} has no media reference property')
    with ont._lock:
        objects = ont._objects(t["id"])
    out = [{"primary_key": pk, "title": ont._public_object(t, pk, o)["title"], "item_id": o["properties"][prop]}
           for pk, o in objects.items() if o.get("properties", {}).get(prop)]
    return {"property": prop, "items": out[:200]}


# ------------------------------------------------------------------------------------------------
# external feature services and tile servers as map layers
# ------------------------------------------------------------------------------------------------

FEATURE_LIMIT = 5000


class FeatureServiceIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    # arcgis: an ArcGIS FeatureServer / MapServer layer (…/FeatureServer/0); ogc: an OGC API Features collection
    # (…/collections/<id>); geojson: a GeoJSON document
    kind: Literal["arcgis", "ogc", "geojson"] = "geojson"
    # [min lon, min lat, max lon, max lat]: only features in the view (ArcGIS and OGC filter on the server)
    bbox: Optional[list[float]] = None
    where: str = Field("1=1", max_length=2000)
    title_field: Optional[str] = None
    limit: int = Field(2000, ge=1, le=FEATURE_LIMIT)


def _fetch_json(url: str, params: dict) -> Any:
    """GET through the platform (egress policies apply), JSON back."""
    from urllib.parse import urlparse

    import httpx

    import network

    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(400, "the feature service URL must be http(s)")
    try:
        network.check_egress(u.hostname, u.port or (443 if u.scheme == "https" else 80), "This map layer")
    except network.EgressDenied as e:
        raise HTTPException(403, str(e)) from None
    try:
        r = httpx.get(url, params=params, timeout=60, follow_redirects=True, headers={"Accept": "application/geo+json, application/json"})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"the feature service could not be reached: {e}") from None
    if r.status_code >= 400:
        raise HTTPException(502, f"the feature service answered HTTP {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except ValueError:
        raise HTTPException(502, "the feature service did not answer with JSON") from None


def _in_bbox(geom: dict, bbox: list[float]) -> bool:
    pts: list = []

    def walk(c: Any) -> None:
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            pts.append(c)
        elif isinstance(c, (list, tuple)):
            for x in c:
                walk(x)

    walk((geom or {}).get("coordinates"))
    for g in (geom or {}).get("geometries") or []:
        walk(g.get("coordinates"))
    if not pts:
        return False
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return not (max(xs) < bbox[0] or min(xs) > bbox[2] or max(ys) < bbox[1] or min(ys) > bbox[3])


@router.post("/feature-service")
def feature_service(req: FeatureServiceIn) -> dict:
    """An external feature service's features as map features (WGS 84 GeoJSON)."""
    url = req.url.rstrip("/")
    bbox = req.bbox if req.bbox and len(req.bbox) == 4 else None
    if req.kind == "arcgis":
        params: dict = {"where": req.where or "1=1", "outFields": "*", "f": "geojson", "outSR": "4326", "resultRecordCount": req.limit}
        if bbox:
            params.update(geometry=",".join(str(v) for v in bbox), geometryType="esriGeometryEnvelope", inSR="4326", spatialRel="esriSpatialRelIntersects")
        doc = _fetch_json(url if url.endswith("/query") else f"{url}/query", params)
    elif req.kind == "ogc":
        params = {"limit": req.limit, "f": "json"}
        if bbox:
            params["bbox"] = ",".join(str(v) for v in bbox)
        doc = _fetch_json(url if url.endswith("/items") else f"{url}/items", params)
    else:
        doc = _fetch_json(url, {})
    if isinstance(doc, dict) and doc.get("error"):
        raise HTTPException(502, f"the feature service: {doc['error'].get('message') if isinstance(doc['error'], dict) else doc['error']}")
    feats = doc.get("features") if isinstance(doc, dict) else None
    if feats is None and isinstance(doc, dict) and doc.get("type") == "Feature":
        feats = [doc]
    if feats is None:
        raise HTTPException(502, "the answer is not GeoJSON features")
    out = []
    for i, f in enumerate(feats):
        g = f.get("geometry")
        if not g:
            continue
        if bbox and req.kind == "geojson" and not _in_bbox(g, bbox):
            continue
        props = f.get("properties") or {}
        fid = f.get("id", props.get("OBJECTID", props.get("id", i)))
        title = props.get(req.title_field) if req.title_field else next((props[k] for k in ("name", "NAME", "title", "Name") if props.get(k)), None)
        out.append({"id": str(fid), "title": str(title if title is not None else fid), "properties": props, "geometry": g})
        if len(out) >= req.limit:
            break
    return {"features": out, "total": len(out), "truncated": len(out) >= req.limit or bool(doc.get("exceededTransferLimit") if isinstance(doc, dict) else False)}


# ------------------------------------------------------------------------------------------------
# WMS / WMTS capabilities: a service's layers as tile URL templates for "tiles" layers (geo_wmts.py: parsing, warping)
# ------------------------------------------------------------------------------------------------

MERCATOR = ("EPSG:3857", "EPSG:900913", "EPSG:3785", "urn:ogc:def:crs:EPSG::3857", "urn:ogc:def:crs:EPSG:6.18:3:3857", "urn:ogc:def:crs:EPSG::900913")


class CapabilitiesIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    kind: Literal["wms", "wmts"] = "wms"


def _fetch_text(url: str, params: dict) -> str:
    """GET through the platform (egress policies apply), text back."""
    from urllib.parse import urlparse

    import httpx

    import network

    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise HTTPException(400, "the service URL must be http(s)")
    try:
        network.check_egress(u.hostname, u.port or (443 if u.scheme == "https" else 80), "This map layer")
    except network.EgressDenied as e:
        raise HTTPException(403, str(e)) from None
    try:
        # the URL's own query kept (httpx's params= would replace it: ?SERVICE=…&REQUEST=GetCapabilities, MapServer ?map=…)
        if params:
            from urllib.parse import urlencode

            import geo_wmts

            url = geo_wmts.kvp_base(url) + urlencode(params)
        r = httpx.get(url, timeout=60, follow_redirects=True)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"the service could not be reached: {e}") from None
    if r.status_code >= 400:
        raise HTTPException(502, f"the service answered HTTP {r.status_code}: {r.text[:300]}")
    return r.text


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(el: Any, name: str) -> Any:
    return next((c for c in el if _local(c.tag) == name), None)


def _children(el: Any, name: str) -> list:
    return [c for c in el if _local(c.tag) == name]


def _text(el: Any, name: str) -> Optional[str]:
    c = _child(el, name) if el is not None else None
    return (c.text or "").strip() if c is not None and c.text else None


def _base(url: str) -> str:
    return url.split("?", 1)[0]


def _wms_layers(root: Any, url: str) -> list[dict]:
    import geo_wmts

    return geo_wmts.wms_layers(root, url)


def _wmts_layers(root: Any, url: str) -> list[dict]:
    import geo_wmts

    return geo_wmts.wmts_layers(root, url)


WARP_ID = re.compile(r"^[0-9a-f]{32}$")
MAX_WARP_SPECS = 500  # warp specs stored per capabilities request


def _warp_dir() -> Path:
    d = DIR / "warp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _store_warp(spec: dict) -> str:
    """A warp spec (geo_wmts) under data/geo/warp/<sha256>.json; its id (the same spec, the same id)."""
    import hashlib

    body = json.dumps(spec, sort_keys=True, separators=(",", ":"))
    sid = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
    p = _warp_dir() / f"{sid}.json"
    if not p.exists():
        _write(p, spec)
    return sid


def _publish_layers(layers: list[dict]) -> list[dict]:
    """Warp specs stored and replaced by a template of GET /api/geo/warp (relative: the web app prefixes the API URL),
    with the hosts the tile proxy will fetch from and whether its allow-list holds them now."""
    from urllib.parse import urlsplit

    import geo_wmts
    import tile_proxy

    allow = _tile_proxy_allow()
    stored = 0
    for layer in layers:
        spec = layer.pop("warp_spec", None)
        if not spec:
            continue
        if stored >= MAX_WARP_SPECS:
            layer["reason"] = f"more than {MAX_WARP_SPECS} reprojected layers in one service: not offered"
            continue
        hosts, allowed = [], True
        for u in geo_wmts.spec_urls(spec):
            s = urlsplit(u)
            hosts.append(f"{s.hostname}{':' + str(s.port) if s.port else ''}")
            try:
                tile_proxy.check_url(u, allow, resolve=False)
            except tile_proxy.Refused:
                allowed = False
        sid = _store_warp(spec)
        stored += 1
        layer["template"] = f"/api/geo/warp/{sid}/{{z}}/{{x}}/{{y}}.png"
        layer["warp"] = {"crs": spec["crs"], "via": spec["kind"], "hosts": hosts, "allowed": allowed}
    return layers


@router.get("/warp/{spec_id}/{z}/{x}/{y}.png")
def warp_tile(spec_id: str, z: int, x: int, y: int, sampling: Optional[Literal["auto", "nearest", "bilinear"]] = None) -> Response:
    """A Web Mercator tile of a WMS / WMTS layer offered in another CRS (EPSG:4326, CRS84, …) or tile layout, drawn by
    the platform; ?sampling=nearest (categorical layers) | bilinear (imagery) | auto (default, geo_wmts). Every upstream request (source tiles, GetMap images) goes through the tile proxy (tile_proxy.get):
    URL checks, the administrators' allow-list, public addresses only (pinned connection), re-checked redirects,
    size / time / content-type limits, cache and request log."""
    import geo_wmts
    import tile_proxy

    p = auth.require_user()
    if not WARP_ID.match(spec_id):
        raise HTTPException(404, "no such reprojected layer")
    spec = _read(_warp_dir() / f"{spec_id}.json")
    if not isinstance(spec, dict):
        raise HTTPException(404, "no such reprojected layer (read the service's layers again)")
    if not (0 <= z <= 24 and 0 <= x < 2**z and 0 <= y < 2**z):
        raise HTTPException(400, "the tile is outside the Web Mercator grid")
    allow = _tile_proxy_allow()
    user = str(p.get("username") or p.get("id") or "")

    def fetch(u: str) -> Optional[bytes]:
        c, _ = tile_proxy.get(u, allow, user=user)
        return c.body if c.status == 200 else None

    try:
        png = geo_wmts.warp_tile(spec, z, x, y, fetch, sampling=sampling)
    except tile_proxy.Refused as e:
        raise HTTPException(e.status, e.reason) from None
    except geo_wmts.WarpError as e:
        raise HTTPException(422, str(e)) from None
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@router.post("/capabilities")
def capabilities(req: CapabilitiesIn) -> dict:
    """A WMS or WMTS service's layers: those offered in Web Mercator come with a tile URL template ({z}/{x}/{y}, or
    {bbox-epsg-3857} for WMS GetMap per tile); those in other CRSs (EPSG:4326, CRS84, others pyproj knows) or other tile
    layouts with a template of GET /api/geo/warp (reprojected by the platform through the tile proxy); the rest with
    a reason."""
    import xml.etree.ElementTree as ET

    params = {"SERVICE": req.kind.upper(), "REQUEST": "GetCapabilities"}
    if "request=getcapabilities" in req.url.lower() or req.url.split("?", 1)[0].lower().endswith(".xml"):
        params = {}
    text = _fetch_text(req.url, params)
    try:
        root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError as e:
        raise HTTPException(502, f"the capabilities document is not XML: {e}") from None
    if _local(root.tag) in ("ServiceExceptionReport", "ExceptionReport"):
        raise HTTPException(502, "the service answered with an exception: " + " ".join(t.strip() for t in root.itertext() if t.strip())[:300])
    layers = _publish_layers(_wms_layers(root, req.url) if req.kind == "wms" else _wmts_layers(root, req.url))
    service = _child(root, "Service") if req.kind == "wms" else _child(root, "ServiceIdentification")
    return {"title": _text(service, "Title") if service is not None else None, "layers": layers}


# ------------------------------------------------------------------------------------------------
# tile proxy (tile_proxy.py): vector tiles / TileJSON / styles from tile servers without CORS headers
# ------------------------------------------------------------------------------------------------


def _tile_proxy_allow() -> list:
    """The allow-list: the hosts an administrator stored with the curated sources, then BSAI_TILE_PROXY_HOSTS."""
    import tile_proxy

    stored, errors = tile_proxy.parse_entries(_sources().get("tile_proxy_hosts") or [])
    for e in errors:
        log.warning("tile proxy allow-list: %s (ignored)", e)
    return stored + tile_proxy.env_entries()


class TileProxyIn(BaseModel):
    hosts: list[str] = Field(default_factory=list, max_length=200)


@router.get("/tile-proxy/settings")
def tile_proxy_settings() -> dict:
    """The tile proxy's allow-list (stored and from the environment) and limits."""
    import tile_proxy

    auth.require_user()
    return {"hosts": _sources().get("tile_proxy_hosts") or [], "env_hosts": [tile_proxy.entry_text(e) for e in tile_proxy.env_entries()],
            "env_var": tile_proxy.ENV_HOSTS, "max_bytes": tile_proxy.MAX_BYTES, "max_redirects": tile_proxy.MAX_REDIRECTS,
            "timeout_s": tile_proxy.DEADLINE, "content_types": sorted(tile_proxy.CONTENT_TYPES)}


@router.put("/tile-proxy/settings")
def save_tile_proxy_settings(req: TileProxyIn) -> dict:
    """Administrators: the hosts the tile proxy may fetch from (host, *.domain or a public IP, optionally :port)."""
    import tile_proxy

    p = auth.require_admin()
    entries, errors = tile_proxy.parse_entries(req.hosts)
    if errors:
        raise HTTPException(400, "; ".join(errors))
    hosts = list(dict.fromkeys(tile_proxy.entry_text(e) for e in entries))
    with _lock:
        s = _sources()
        s["tile_proxy_hosts"] = hosts
        _write(_sources_file(), s)
    log.info("tile proxy allow-list set by %s: %s", p.get("username"), ", ".join(hosts) or "(empty)")
    return tile_proxy_settings()


@router.get("/tile-proxy/log")
def tile_proxy_log() -> list[dict]:
    """Administrators: the tile proxy's latest requests (newest first; query values redacted)."""
    import tile_proxy

    auth.require_admin()
    return list(reversed(tile_proxy.LOG))


@router.get("/tile-proxy")
def tile_proxy_get(url: str, if_none_match: Optional[str] = Header(None)) -> Response:
    """A tile, TileJSON or style from an allow-listed tile server, fetched by the platform (no cookies or credentials
    of the caller are forwarded). 204 / 404 from the server: an empty tile."""
    import time as _time

    import tile_proxy

    p = auth.require_user()
    try:
        c, state = tile_proxy.get(url, _tile_proxy_allow(), user=str(p.get("username") or p.get("id") or ""))
    except tile_proxy.Refused as e:
        raise HTTPException(e.status, e.reason) from None
    headers = {"ETag": c.etag, "Cache-Control": f"private, max-age={max(0, int(c.expires - _time.time()))}", "X-Tile-Proxy-Cache": state,
               "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}
    if if_none_match and c.etag in [t.strip() for t in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    if c.status != 200:
        return Response(status_code=c.status, headers=headers)
    return Response(c.body, media_type=c.content_type, headers=headers)
