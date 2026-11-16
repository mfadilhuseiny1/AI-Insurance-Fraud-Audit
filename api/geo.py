"""Geometry helpers shared by the geospatial API (geospatial.py), the Ontology's geo property types (ontology.py)
and the legacy `geospatial_tools` library of Python transforms (code_geo.py), following Palantir's "Geospatial and
geotemporal" docs.

- geopoint: a string "latitude,longitude" in WGS 84 (EPSG:4326), or a Geohash, which becomes the bottom-left corner
  of its rectangle. `geopoint()` normalises any of these (and {lat, lon} objects or GeoJSON points) to "lat,lon".
- geoshape: a GeoJSON Geometry string (RFC 7946) — LineString, Polygon, MultiLineString, MultiPolygon, MultiPoint
  or Point (points belong in geopoint) — never a Feature, FeatureCollection or GeometryCollection; WGS 84
  coordinates; polygons closed, exterior rings counter-clockwise, no self-intersection. `geoshape()` checks a value
  and says what is wrong; `clean()` repairs what can be repaired (make_valid, winding order, CRS).
- CRS: every map here expects WGS 84 and draws in Web Mercator. `reproject()` converts between any two CRSs pyproj
  knows (EPSG codes, WKT, PROJ strings); metric measures (`area`, `length`, `distance`, `buffer`, `simplify`)
  project into a metric CRS first (EPSG:3395 World Mercator by default, as in geospatial-tools).
"""

from __future__ import annotations

import functools
import json
import math
import re
from typing import Any, Iterable, Optional

GEOSHAPE_TYPES = ("LineString", "Polygon", "MultiLineString", "MultiPolygon", "MultiPoint", "Point")
WGS84 = "EPSG:4326"
METRIC_CRS = "EPSG:3395"
# offered in pickers; any other CRS pyproj knows can be typed in
COMMON_CRS = [
    ("EPSG:4326", "WGS 84 (latitude / longitude)"),
    ("EPSG:3857", "WGS 84 / Pseudo-Mercator (Web Mercator)"),
    ("EPSG:3395", "WGS 84 / World Mercator"),
    ("EPSG:4269", "NAD83"),
    ("EPSG:4755", "DGN95 (Indonesia)"),
    ("EPSG:23830", "DGN95 / Indonesia TM-3 zone 46.2"),
    ("EPSG:32748", "WGS 84 / UTM zone 48S (Jakarta)"),
    ("EPSG:32749", "WGS 84 / UTM zone 49S"),
    ("EPSG:32610", "WGS 84 / UTM zone 10N"),
    ("EPSG:26910", "NAD83 / UTM zone 10N"),
    ("EPSG:27700", "OSGB36 / British National Grid"),
]
_GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz"
_GEOHASH_RE = re.compile(r"^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$")
_LATLON_RE = re.compile(r"^\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$")


class GeoError(ValueError):
    """A value that is not a valid geopoint / geoshape / CRS; the message says why."""


# ------------------------------------------------------------------------------------------------
# geohash and geopoint
# ------------------------------------------------------------------------------------------------


def geohash_encode(lat: float, lon: float, precision: int = 12) -> str:
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        rng, v = (lon_r, lon) if even else (lat_r, lat)
        mid = (rng[0] + rng[1]) / 2
        if v >= mid:
            ch |= 16 >> bit
            rng[0] = mid
        else:
            rng[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_GEOHASH[ch])
            bit, ch = 0, 0
    return "".join(out)


def geohash_bounds(gh: str) -> tuple[float, float, float, float]:
    """(min_lat, min_lon, max_lat, max_lon) of a geohash's rectangle."""
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    even = True
    for c in gh.lower():
        i = _GEOHASH.find(c)
        if i < 0:
            raise GeoError(f"{gh!r} is not a geohash")
        for b in (16, 8, 4, 2, 1):
            rng = lon_r if even else lat_r
            mid = (rng[0] + rng[1]) / 2
            if i & b:
                rng[0] = mid
            else:
                rng[1] = mid
            even = not even
    return lat_r[0], lon_r[0], lat_r[1], lon_r[1]


def _check_lat_lon(lat: float, lon: float) -> tuple[float, float]:
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise GeoError("coordinates must be numbers")
    if abs(lat) > 90:
        raise GeoError(f"latitude {lat} is outside -90..90 (is the value longitude,latitude? geopoints are latitude,longitude)")
    if abs(lon) > 180:
        raise GeoError(f"longitude {lon} is outside -180..180")
    return lat, lon


def lat_lon(value: Any) -> tuple[float, float]:
    """(lat, lon) of a geopoint value: "lat,lon", a geohash (bottom-left corner), {lat, lon} / {latitude,
    longitude}, [lat, lon] or a GeoJSON Point."""
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return _check_lat_lon(float(value[0]), float(value[1]))
    if isinstance(value, dict):
        if value.get("type") == "Point":
            c = value.get("coordinates") or []
            if len(c) < 2:
                raise GeoError("a GeoJSON Point needs [longitude, latitude]")
            return _check_lat_lon(float(c[1]), float(c[0]))
        lat = value.get("lat", value.get("latitude"))
        lon = value.get("lon", value.get("lng", value.get("longitude")))
        if lat is None or lon is None:
            raise GeoError("a point needs lat and lon")
        return _check_lat_lon(float(lat), float(lon))
    text = str(value).strip()
    m = _LATLON_RE.match(text)
    if m:
        return _check_lat_lon(float(m.group(1)), float(m.group(2)))
    if text.startswith("{"):
        try:
            return lat_lon(json.loads(text))
        except json.JSONDecodeError:
            raise GeoError("not valid JSON") from None
    m = re.match(r"^\s*POINT\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)\s*$", text, re.I)
    if m:
        return _check_lat_lon(float(m.group(2)), float(m.group(1)))
    if _GEOHASH_RE.match(text.lower()):
        la0, lo0, _, _ = geohash_bounds(text)
        return la0, lo0
    raise GeoError(f"{text[:60]!r} is not a geopoint: use latitude,longitude (e.g. 57.64911,10.40744) or a geohash (e.g. u4pruydqqvj)")


def geopoint(value: Any) -> str:
    """A geopoint value as stored: "lat,lon"."""
    lat, lon = lat_lon(value)
    return f"{_num(lat)},{_num(lon)}"


def _num(v: float) -> str:
    s = f"{v:.8f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ------------------------------------------------------------------------------------------------
# geoshape
# ------------------------------------------------------------------------------------------------


def _shapely():
    try:
        import shapely
    except ImportError as e:  # pragma: no cover - shapely is in requirements.txt
        raise GeoError("geospatial operations need shapely (pip install shapely)") from e
    return shapely


def parse_geojson(value: Any) -> dict:
    """A GeoJSON geometry dict from a string or dict; Features are unwrapped (callers that must refuse them check)."""
    if isinstance(value, dict):
        g = value
    else:
        text = str(value).strip()
        try:
            g = json.loads(text)
        except json.JSONDecodeError:
            raise GeoError("not valid GeoJSON (could not parse the JSON)") from None
    if not isinstance(g, dict) or "type" not in g:
        raise GeoError("GeoJSON needs a type")
    return g


def _positions(c: Any) -> Iterable[list]:
    if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
        yield c
    elif isinstance(c, (list, tuple)):
        for x in c:
            yield from _positions(x)


def _ring_area(ring: list) -> float:
    """Signed area (shoelace) of a ring; > 0 = counter-clockwise."""
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


def geoshape_problems(value: Any) -> list[str]:
    """What keeps a value from being a valid geoshape (empty = valid)."""
    try:
        g = parse_geojson(value)
    except GeoError as e:
        return [str(e)]
    t = g.get("type")
    if t in ("Feature", "FeatureCollection", "GeometryCollection"):
        return [f"a geoshape must be a GeoJSON geometry, not a {t}" + (" (use its geometry)" if t == "Feature" else "")]
    if t not in GEOSHAPE_TYPES:
        return [f"{t!r} is not a GeoJSON geometry type ({', '.join(GEOSHAPE_TYPES)})"]
    coords = g.get("coordinates")
    if not isinstance(coords, list):
        return ["coordinates are missing"]
    out: list[str] = []
    for pos in _positions(coords):
        if len(pos) < 2:
            out.append("every position needs [longitude, latitude]")
            break
        if not (-180 <= pos[0] <= 180 and -90 <= pos[1] <= 90):
            out.append(f"position {pos[:2]} is not WGS 84 longitude, latitude (is it in another CRS, or latitude first?)")
            break
    if out:
        return out
    polys = [coords] if t == "Polygon" else coords if t == "MultiPolygon" else []
    if t in ("LineString",) and len(coords) < 2:
        out.append("a LineString needs at least two positions")
    for rings in polys:
        for i, ring in enumerate(rings):
            if len(ring) < 4:
                out.append("a polygon ring needs at least four positions (the first repeated at the end)")
            elif list(ring[0][:2]) != list(ring[-1][:2]):
                out.append("polygon rings must be closed (the last position equal to the first)")
            elif i == 0 and _ring_area(ring) < 0:
                out.append("the exterior ring must be counter-clockwise (right-hand rule)")
            elif i > 0 and _ring_area(ring) > 0:
                out.append("interior rings (holes) must be clockwise")
    if not out and polys:
        _shapely()
        from shapely.geometry import shape
        from shapely.validation import explain_validity

        geom = shape(g)
        if not geom.is_valid:
            out.append(f"the polygon is not valid: {explain_validity(geom)}")
    return list(dict.fromkeys(out))


def geoshape(value: Any) -> str:
    """A geoshape value as stored (compact GeoJSON); GeoError says why a value is not valid."""
    problems = geoshape_problems(value)
    if problems:
        raise GeoError("; ".join(problems))
    g = parse_geojson(value)
    return json.dumps({"type": g["type"], "coordinates": g["coordinates"]}, separators=(",", ":"))


# ------------------------------------------------------------------------------------------------
# shapely conversions
# ------------------------------------------------------------------------------------------------


def to_shape(value: Any, fmt: str = "geojson", lat_long: bool = False):
    """A shapely geometry (x = longitude) from GeoJSON (string or dict, Features unwrapped), WKT, WKB (bytes or hex)
    or a geospatial-tools "geohash": a "latitude,longitude" string. `lat_long`: the input's coordinates are ordered
    latitude, longitude (a "geohash" is read as "x,y" when it is False)."""
    _shapely()
    from shapely import wkb, wkt
    from shapely.geometry import Point, shape
    from shapely.ops import transform

    if value is None or value == "":
        return None
    fmt = (fmt or "geojson").lower()
    if hasattr(value, "geom_type"):
        g = value
    elif fmt == "geohash":
        m = _LATLON_RE.match(str(value))
        if not m:
            raise GeoError(f"{str(value)[:60]!r} is not a 'latitude,longitude' string")
        a, b = float(m.group(1)), float(m.group(2))
        return Point(b, a) if lat_long else Point(a, b)
    elif fmt == "wkt":
        g = wkt.loads(str(value))
    elif fmt == "wkb":
        g = wkb.loads(value if isinstance(value, (bytes, bytearray)) else bytes.fromhex(str(value)))
    else:
        d = parse_geojson(value)
        if d.get("type") == "Feature":
            d = d.get("geometry") or {}
        if d.get("type") == "FeatureCollection":
            from shapely.ops import unary_union

            g = unary_union([shape(f["geometry"]) for f in d.get("features", []) if f.get("geometry")])
        else:
            g = shape(d)
    return transform(lambda x, y, z=None: (y, x), g) if lat_long else g


def to_geojson(geom) -> Optional[str]:
    if geom is None or geom.is_empty:
        return None
    from shapely.geometry import mapping

    return json.dumps(_round(mapping(geom)), separators=(",", ":"))


def _round(m: Any) -> Any:
    if isinstance(m, dict):
        return {k: _round(v) for k, v in m.items()}
    if isinstance(m, (list, tuple)):
        return [_round(v) for v in m]
    if isinstance(m, float):
        return round(m, 9)
    return m


def oriented(geom):
    """Exterior rings counter-clockwise, holes clockwise (RFC 7946), recursively for multi geometries."""
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.geometry.polygon import orient

    if isinstance(geom, Polygon):
        return orient(geom, 1.0)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([orient(p, 1.0) for p in geom.geoms])
    if hasattr(geom, "geoms") and geom.geom_type == "GeometryCollection":
        from shapely.geometry import GeometryCollection

        return GeometryCollection([oriented(g) for g in geom.geoms])
    return geom


def make_valid(geom):
    import shapely

    if geom is None:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
        # make_valid may return a collection of the polygon parts and stray lines: keep the polygons
        if geom.geom_type == "GeometryCollection":
            polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
            if polys:
                from shapely.ops import unary_union

                geom = unary_union(polys)
    return oriented(geom)


# ------------------------------------------------------------------------------------------------
# coordinate reference systems
# ------------------------------------------------------------------------------------------------


def _pyproj():
    try:
        import pyproj
    except ImportError as e:  # pragma: no cover - pyproj is in requirements.txt
        raise GeoError("coordinate reference systems need pyproj (pip install pyproj)") from e
    return pyproj


def crs_name(crs: Any) -> str:
    pyproj = _pyproj()
    try:
        c = pyproj.CRS.from_user_input(crs)
    except pyproj.exceptions.CRSError as e:
        raise GeoError(f"unknown coordinate reference system {str(crs)[:80]!r}: {e}") from None
    code = c.to_epsg()
    return f"EPSG:{code}" if code else c.name


@functools.lru_cache(maxsize=64)
def transformer(src: str, dst: str):
    """always_xy: coordinates are (x, y) = (longitude, latitude) for geographic CRSs."""
    pyproj = _pyproj()
    try:
        return pyproj.Transformer.from_crs(pyproj.CRS.from_user_input(src), pyproj.CRS.from_user_input(dst), always_xy=True)
    except pyproj.exceptions.CRSError as e:
        raise GeoError(f"unknown coordinate reference system: {e}") from None


def same_crs(a: str, b: str) -> bool:
    if str(a).upper() == str(b).upper():
        return True
    pyproj = _pyproj()
    try:
        return pyproj.CRS.from_user_input(a) == pyproj.CRS.from_user_input(b)
    except pyproj.exceptions.CRSError:
        return False


def reproject(geom, src: str, dst: str = WGS84):
    if geom is None or same_crs(src, dst):
        return geom
    from shapely.ops import transform

    t = transformer(str(src), str(dst))
    return transform(t.transform, geom)


def reproject_point(x: float, y: float, src: str, dst: str = WGS84) -> tuple[float, float]:
    """(x, y) → (x, y) in dst; geographic CRSs take and give (longitude, latitude)."""
    if same_crs(src, dst):
        return x, y
    return transformer(str(src), str(dst)).transform(x, y)


# ------------------------------------------------------------------------------------------------
# measures and operations (WGS 84 in, WGS 84 out; metric work in metric_crs)
# ------------------------------------------------------------------------------------------------


def area(geom, metric_crs: str = METRIC_CRS) -> Optional[float]:
    return None if geom is None else reproject(geom, WGS84, metric_crs).area


def length(geom, metric_crs: str = METRIC_CRS) -> Optional[float]:
    return None if geom is None else reproject(geom, WGS84, metric_crs).length


def distance(a, b, metric_crs: str = METRIC_CRS) -> Optional[float]:
    if a is None or b is None:
        return None
    return reproject(a, WGS84, metric_crs).distance(reproject(b, WGS84, metric_crs))


def buffer(geom, meters: float, metric_crs: str = METRIC_CRS):
    if geom is None:
        return None
    return oriented(reproject(reproject(geom, WGS84, metric_crs).buffer(float(meters)), metric_crs, WGS84))


def simplify(geom, tolerance: float, metric_crs: str = METRIC_CRS):
    if geom is None:
        return None
    return oriented(reproject(reproject(geom, WGS84, metric_crs).simplify(float(tolerance), preserve_topology=True), metric_crs, WGS84))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bounding_circle(geom, segments: int = 100):
    """The minimum bounding circle as a polygon of `segments` sides."""
    import shapely
    from shapely.geometry import Polygon

    if geom is None:
        return None
    circle = shapely.minimum_bounding_circle(geom)
    if circle.geom_type != "Polygon":
        return circle
    cx, cy = circle.centroid.x, circle.centroid.y
    r = shapely.minimum_bounding_radius(geom)
    n = max(3, int(segments))
    return Polygon([(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)])


def subdivide(geom, max_vertices: int) -> list:
    """Split a shape into parts of at most max_vertices vertices by halving its bounding box (for faster joins)."""
    import shapely
    from shapely.geometry import box

    if geom is None or geom.is_empty:
        return []
    max_vertices = max(5, int(max_vertices))
    out: list = []
    stack = [geom]
    while stack:
        g = stack.pop()
        if g.is_empty:
            continue
        if shapely.get_num_coordinates(g) <= max_vertices or g.geom_type in ("Point", "MultiPoint"):
            out.extend(list(g.geoms) if g.geom_type.startswith("Multi") or g.geom_type == "GeometryCollection" else [g])
            continue
        x0, y0, x1, y1 = g.bounds
        if x1 - x0 >= y1 - y0:
            xm = (x0 + x1) / 2
            halves = (box(x0, y0, xm, y1), box(xm, y0, x1, y1))
        else:
            ym = (y0 + y1) / 2
            halves = (box(x0, y0, x1, ym), box(x0, ym, x1, y1))
        if min(x1 - x0, y1 - y0) < 1e-9 and max(x1 - x0, y1 - y0) < 1e-9:
            out.append(g)
            continue
        stack.extend(g.intersection(h) for h in halves)
    return [oriented(g) for g in out if not g.is_empty]


def bbox_of(value: Any) -> Optional[tuple[float, float, float, float]]:
    """(min_lon, min_lat, max_lon, max_lat) of a geopoint or geoshape value."""
    if value is None or value == "":
        return None
    try:
        lat, lon = lat_lon(value)
        return lon, lat, lon, lat
    except GeoError:
        pass
    try:
        g = parse_geojson(value)
    except GeoError:
        return None
    pts = list(_positions(g.get("coordinates") if g.get("type") != "Feature" else (g.get("geometry") or {}).get("coordinates")))
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def value_shape(value: Any):
    """A shapely geometry of a geopoint or geoshape property value (None when it is neither)."""
    if value is None or value == "":
        return None
    from shapely.geometry import Point

    try:
        lat, lon = lat_lon(value)
        return Point(lon, lat)
    except GeoError:
        pass
    try:
        return to_shape(value)
    except Exception:  # noqa: BLE001
        return None
