"""WMS / WMTS layers for the Map's tile layers (used by geospatial.py's POST /api/geo/capabilities and
GET /api/geo/warp/<spec>/{z}/{x}/{y}.png).

Capabilities documents (pure parsing, no network):
  - WMTS: tile URLs come from the layer's ResourceURL templates (RESTful), else from the GetTile endpoints of
    ows:OperationsMetadata (KVP or RESTful, by their GetEncoding constraint; the endpoint may be another host than
    the capabilities URL), else KVP on the capabilities URL. Dimensions ({Time}, …) are filled with their defaults.
  - WMS: GetMap on the DCPType endpoint (its own query parameters kept, e.g. MapServer's ?map=…).
  - A layer offered in Web Mercator with tile matrices named by zoom ("0", "EPSG:3857:0", …, matched on the
    scale denominators of GoogleMapsCompatible) is drawn directly: a {z}/{x}/{y} (or {bbox-epsg-3857}) template the
    browser loads.
  - Other layers — tile matrix sets in EPSG:4326 / CRS84, other CRSs pyproj knows, Mercator sets with other matrix
    names or tile sizes, WMS layers without EPSG:3857 — are reprojected by the platform: a "warp spec" whose tiles
    GET /api/geo/warp/… draws per Web Mercator tile (source tiles / a GetMap image fetched through the tile proxy,
    every pixel sampled at its position in the source CRS). CRSs that cannot be transformed get a reason instead.

Warping (warp_tile): for each pixel centre of the 256 × 256 Web Mercator tile z/x/y, its coordinates in the source CRS
(analytic for EPSG:4326 / CRS84, pyproj otherwise), then the source tile matrix whose resolution best matches, the
tile (row, col) and pixel within it; pixels outside the matrix stay transparent. Sampling (`sampling`, per request or
in the spec): "nearest" (the source pixel the point falls in: categorical layers keep their exact colours),
"bilinear" (the four source pixels around the point weighted by distance, alpha-premultiplied so transparent
neighbours leave no dark fringe; across source tile edges; fading out over the last half-pixel at a tile matrix's
edge, clamped at a GetMap image's edge: imagery), or "auto" (the default: nearest when the source images are classes
— all paletted (PNG8 / GIF) or at most 256 colours in all —, bilinear for imagery). Geographic matrices (and
cylindrical projections, periodic()): longitudes are periodic (a set laid out over 0…360° covers -10° as 350°), and
bilinear neighbours wrap across the antimeridian when the matrix spans the whole world. A WMS image crossing the
source CRS's antimeridian is requested as two GetMaps, one each side, on one pixel grid, and stitched (plan_wms).
"""

from __future__ import annotations

import io
import math
import re
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional
from urllib.parse import quote, urljoin, urlsplit

XLINK = "{http://www.w3.org/1999/xlink}href"
R = 6378137.0
HALF = math.pi * R  # 20037508.342789244: half the Web Mercator world
GOOGLE_SCALE0 = 559082264.0287178  # GoogleMapsCompatible's level-0 scale denominator (0.28 mm pixels)
PIXEL = 0.00028  # OGC standardized rendering pixel size, metres
DEG_M = 2 * math.pi * R / 360  # metres per degree (WMTS 1.0.0 annex E: 111319.49079327358)
TILE = 256
MAX_SOURCE_TILES = 24  # source tiles one Web Mercator tile may need (more: zoom in)
MAX_PIXELS = 4096 * 4096  # a source image larger than this is refused
SAMPLINGS = ("auto", "nearest", "bilinear")
MAX_CLASS_COLOURS = 256  # "auto": source images with at most this many colours in all are classes (nearest)


class WarpError(Exception):
    """A tile that cannot be drawn (bad spec, too many source tiles, unreadable image)."""


class CrsUnsupported(Exception):
    """A CRS that cannot be shown on the Web Mercator map."""


# ------------------------------------------------------------------------------------------------ XML helpers


def local(tag: Any) -> str:
    return str(tag).rsplit("}", 1)[-1]


def child(el: Any, name: str) -> Any:
    return next((c for c in el if local(c.tag) == name), None) if el is not None else None


def children(el: Any, name: str) -> list:
    return [c for c in el if local(c.tag) == name] if el is not None else []


def text(el: Any, name: str) -> Optional[str]:
    c = child(el, name)
    return (c.text or "").strip() if c is not None and c.text and c.text.strip() else None


def kvp_base(href: str) -> str:
    """An endpoint ready for KVP parameters: its own query kept ("…/mapserv?map=x.map&"), ending in ? or &."""
    href = href.strip()
    if "?" not in href:
        return href + "?"
    return href if href.endswith(("?", "&")) else href + "&"


def _q(v: str) -> str:
    return quote(str(v), safe=":,-_.~/")


def http_url(u: Optional[str]) -> bool:
    try:
        s = urlsplit(u or "")
    except ValueError:
        return False
    return s.scheme in ("http", "https") and bool(s.hostname)


# ------------------------------------------------------------------------------------------------ CRSs


_EPSG = re.compile(r"(?:^|[:/])(?:EPSG)(?:[:/]+(?:[\d.]+[:/]+)*)(\d+)$", re.I)


def crs_code(raw: Optional[str]) -> str:
    """A normalized CRS name: "EPSG:<n>", "CRS84" or the text as given (urn:ogc:def:crs:EPSG:6.18:3:3857,
    urn:ogc:def:crs:EPSG::4326, http://www.opengis.net/def/crs/EPSG/0/4326, CRS:84, OGC:CRS84, …)."""
    s = (raw or "").strip()
    u = s.upper()
    if u.endswith("CRS84") or u in ("CRS:84", "OGC:CRS84", "URN:OGC:DEF:CRS:OGC:1.3:CRS84", "URN:OGC:DEF:CRS:OGC:2:84"):
        return "CRS84"
    m = _EPSG.search(s)
    if m:
        code = m.group(1)
        return "EPSG:3857" if code in ("900913", "3785", "102100", "102113") else f"EPSG:{code}"
    return s


def is_mercator(code: str) -> bool:
    return code == "EPSG:3857"


def crs_info(code: str) -> dict:
    """{geographic, lat_first, mpu (metres per CRS unit)} or CrsUnsupported. EPSG:4326 / CRS84 / EPSG:3857 without
    pyproj; any other CRS through pyproj (installed with the API), which must also transform from EPSG:3857."""
    if code == "EPSG:4326":
        return {"geographic": True, "lat_first": True, "mpu": DEG_M}
    if code == "CRS84":
        return {"geographic": True, "lat_first": False, "mpu": DEG_M}
    if code == "EPSG:3857":
        return {"geographic": False, "lat_first": False, "mpu": 1.0}
    try:
        import pyproj
    except ImportError:  # pragma: no cover - pyproj is in requirements.txt
        raise CrsUnsupported(f"{code} cannot be shown: only EPSG:3857, EPSG:4326 and CRS84 work without pyproj") from None
    try:
        crs = pyproj.CRS.from_user_input(code)
        pyproj.Transformer.from_crs("EPSG:3857", crs, always_xy=True)
    except Exception as e:  # pyproj.exceptions.CRSError, ProjError
        raise CrsUnsupported(f"{code} cannot be shown on the Web Mercator map: the CRS is not known ({str(e)[:120]})") from None
    axes = crs.axis_info
    if not axes:
        raise CrsUnsupported(f"{code} cannot be shown on the Web Mercator map: the CRS has no axes")
    first = (axes[0].direction or "").lower()
    if crs.is_geographic:
        return {"geographic": True, "lat_first": first in ("north", "south"), "mpu": DEG_M}
    if not crs.is_projected:
        raise CrsUnsupported(f"{code} cannot be shown on the Web Mercator map: it is neither geographic nor projected")
    return {"geographic": False, "lat_first": first in ("north", "south"), "mpu": float(axes[0].unit_conversion_factor or 1.0)}


_tls = threading.local()


def _transformer(code: str) -> Any:
    """pyproj EPSG:4326 → code (easting / longitude first), kept per thread (Transformers are not shared across threads)."""
    cache = getattr(_tls, "transformers", None)
    if cache is None:
        cache = _tls.transformers = {}
    t = cache.get(code)
    if t is None:
        import pyproj

        if len(cache) > 32:
            cache.clear()
        t = cache[code] = pyproj.Transformer.from_crs("EPSG:4326", code, always_xy=True)
    return t


def to_source(code: str, X: Any, Y: Any) -> tuple[Any, Any]:
    """Web Mercator metres → the source CRS, easting / longitude first (arrays; nan where undefined)."""
    import numpy as np

    if code == "EPSG:3857":
        return X, Y
    lon = X / R * (180 / math.pi)
    lat = np.degrees(np.arctan(np.sinh(Y / R)))
    if code in ("EPSG:4326", "CRS84"):
        return lon, lat
    sx, sy = _transformer(code).transform(lon, lat, errcheck=False)
    sx, sy = np.asarray(sx, dtype=float), np.asarray(sy, dtype=float)
    bad = ~np.isfinite(sx) | ~np.isfinite(sy) | (np.abs(sx) > 1e30) | (np.abs(sy) > 1e30)
    sx[bad] = np.nan
    sy[bad] = np.nan
    return sx, sy


def _lon_lat_to_mercator(lon: Any, lat: Any) -> tuple[Any, Any]:
    import numpy as np

    lon = (np.asarray(lon, dtype=float) + 180.0) % 360.0 - 180.0
    return lon * (math.pi / 180) * R, R * np.log(np.tan(math.pi / 4 + np.radians(np.asarray(lat, dtype=float)) / 2))


def periodic(code: str) -> Optional[tuple[float, float, float]]:
    """(seam longitude, period P, x_east) of a CRS whose easting is linear in longitude and independent of latitude
    (geographic CRSs, Mercator / equirectangular / cylindrical equal-area projections): the world spans easting
    [x_east - P, x_east), and longitudes east of the seam (central meridian + 180°) wrap round to its west end. None
    for other CRSs (UTM, conic, azimuthal, pseudo-cylindrical: no straight seam to split a request at). Geographic
    CRSs exactly from their longitude unit and prime meridian; projections measured (x at five longitudes and three
    latitudes through pyproj)."""
    if code in ("EPSG:4326", "CRS84"):
        return 180.0, 360.0, 180.0
    if code in _PERIODIC:
        return _PERIODIC[code]
    got: Optional[tuple[float, float, float]] = None
    try:
        import numpy as np
        import pyproj

        crs = pyproj.CRS.from_user_input(code)
        pm = crs.prime_meridian
        pm_deg = float(pm.longitude) * float(pm.unit_conversion_factor or 0.0) * 180 / math.pi if pm is not None and pm.longitude else 0.0
        if crs.is_geographic:
            lon_axis = next((a for a in crs.axis_info if (a.direction or "").lower() in ("east", "west")), None)
            u = float(lon_axis.unit_conversion_factor or 0.0) if lon_axis is not None else 0.0  # radians per unit
            if u > 0 and (lon_axis.direction or "").lower() == "east":
                P = 2 * math.pi / u
                got = (pm_deg + 180.0, P, P / 2)
        else:
            with warnings.catch_warnings():  # "you will likely lose important projection information" (only lon_0 read)
                warnings.simplefilter("ignore")
                lon0 = float(crs.to_dict().get("lon_0") or 0.0) + pm_deg
            d = np.array([-179.0, -90.0, 0.0, 90.0, 179.0])
            D, LA = np.meshgrid(d, np.array([-60.0, 0.0, 60.0]))
            X, Y = _lon_lat_to_mercator(lon0 + D, LA)
            sx, _ = to_source(code, X, Y)
            if np.isfinite(sx).all():
                k = float((sx[1, 3] - sx[1, 1]) / 180.0)
                x0 = sx[:, 2:3]
                # within 0.01° (datum shifts allowed); transverse, conic and pseudo-cylindrical projections are off by degrees
                if k > 0 and np.abs(sx - (x0 + k * D)).max() <= k * 0.01 and np.abs(x0 - x0[1]).max() <= k * 0.01:
                    got = (lon0 + 180.0, 360.0 * k, float(x0[1, 0]) + 180.0 * k)
        if got is not None:
            seam = (got[0] + 180.0) % 360.0 - 180.0
            got = (180.0 if seam <= -180.0 + 1e-9 else seam, got[1], got[2])
    except Exception:
        got = None
    if len(_PERIODIC) > 256:
        _PERIODIC.clear()
    _PERIODIC[code] = got
    return got


_PERIODIC: dict[str, Optional[tuple[float, float, float]]] = {}


# ------------------------------------------------------------------------------------------------ WMTS


def _floats(s: Optional[str]) -> list[float]:
    try:
        return [float(v) for v in (s or "").replace(",", " ").split()]
    except ValueError:
        return []


def matrix_set(el: Any) -> dict:
    """A TileMatrixSet: identifier, CRS, and its matrices (id, scale, resolution in CRS units, top-left x / y with
    easting first, tile and matrix sizes); "error" when its CRS cannot be shown."""
    ident = text(el, "Identifier") or ""
    raw = text(el, "SupportedCRS") or ""
    code = crs_code(raw)
    out: dict = {"id": ident, "crs": code, "crs_raw": raw, "matrices": [], "error": None, "well_known": text(el, "WellKnownScaleSet")}
    try:
        info = crs_info(code)
    except CrsUnsupported as e:
        out["error"] = str(e)
        info = None
    for m in children(el, "TileMatrix"):
        tl = _floats(text(m, "TopLeftCorner"))
        try:
            scale = float(text(m, "ScaleDenominator") or "nan")
            tw, th = int(text(m, "TileWidth") or TILE), int(text(m, "TileHeight") or TILE)
            mw, mh = int(text(m, "MatrixWidth") or 0), int(text(m, "MatrixHeight") or 0)
        except ValueError:
            continue
        if len(tl) < 2 or not scale > 0 or tw <= 0 or th <= 0 or mw <= 0 or mh <= 0:
            continue
        x, y = tl[0], tl[1]
        if info and info["lat_first"]:
            # axis order of the CRS (EPSG:4326: "90 -180" = lat lon). Servers writing lon lat anyway: a first value
            # beyond ±90 on a geographic CRS can only be a longitude.
            if not (info["geographic"] and abs(tl[0]) > 90 >= abs(tl[1])):
                x, y = tl[1], tl[0]
        mpu = info["mpu"] if info else 1.0
        out["matrices"].append({"id": text(m, "Identifier") or "", "scale": scale, "res": scale * PIXEL / mpu, "x": x, "y": y,
                                "tw": tw, "th": th, "mw": mw, "mh": mh})
    if not out["matrices"] and not out["error"]:
        out["error"] = f"the tile matrix set {ident} has no usable tile matrices"
    return out


def mercator_zooms(s: dict) -> Optional[dict]:
    """For a Web Mercator set laid out like GoogleMapsCompatible (256-pixel tiles, top-left at the world's corner, scale
    halving per level): {matrix id: zoom}. None when it is laid out otherwise."""
    if not is_mercator(s["crs"]) or not s["matrices"]:
        return None
    zooms = {}
    for m in s["matrices"]:
        z = math.log2(GOOGLE_SCALE0 / m["scale"])
        if abs(z - round(z)) > 0.01 or m["tw"] != TILE or m["th"] != TILE:
            return None
        if abs(m["x"] + HALF) > 10 or abs(m["y"] - HALF) > 10:
            return None
        zooms[m["id"]] = int(round(z))
    return zooms


def zoom_prefix(zooms: dict) -> Optional[str]:
    """The common prefix when every matrix is named prefix + zoom ("3", "EPSG:3857:3", "L3"…), else None."""
    prefixes = set()
    for ident, z in zooms.items():
        if not ident.endswith(str(z)) or (len(ident) > len(str(z)) and ident[-len(str(z)) - 1].isdigit()):
            return None
        prefixes.add(ident[: len(ident) - len(str(z))])
    return prefixes.pop() if len(prefixes) == 1 else None


def operations(root: Any) -> dict[str, list[dict]]:
    """ows:OperationsMetadata: {operation: [{href, encodings}]} for HTTP GET endpoints (encodings from the
    GetEncoding constraint on the Get element or the operation; empty when not stated)."""
    out: dict[str, list[dict]] = {}
    om = child(root, "OperationsMetadata")
    for op in children(om, "Operation"):
        name = op.get("name") or ""
        op_enc = _encodings(op)
        for dcp in children(op, "DCP"):
            for get in children(child(dcp, "HTTP"), "Get"):
                href = (get.get(XLINK) or "").strip()
                if href:
                    out.setdefault(name, []).append({"href": href, "encodings": _encodings(get) or op_enc})
    return out


def _encodings(el: Any) -> set[str]:
    enc: set[str] = set()
    for c in children(el, "Constraint"):
        if (c.get("name") or "").lower() != "getencoding":
            continue
        av = child(c, "AllowedValues")
        for v in children(av, "Value") + children(c, "Value"):
            if v.text:
                enc.add("RESTful" if v.text.strip().lower() == "restful" else v.text.strip().upper())
    return enc


_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def _pick_format(formats: list[str]) -> str:
    for f in ("image/png", "image/png8", "image/jpeg", "image/webp"):
        if f in formats:
            return f
    return next((f for f in formats if f.startswith("image/")), formats[0] if formats else "image/png")


def wmts_layers(root: Any, url: str) -> list[dict]:
    """Each layer: name, title, abstract, crs, tile_matrix_set, and either `template` ({z}/{x}/{y}, drawn directly),
    `warp_spec` (drawn reprojected by the platform) or `reason` (cannot be shown)."""
    contents = child(root, "Contents")
    if contents is None:
        return []
    sets = {s["id"]: s for s in (matrix_set(el) for el in children(contents, "TileMatrixSet"))}
    ops = operations(root).get("GetTile") or []
    kvp = next((o["href"] for o in ops if "KVP" in o["encodings"] and http_url(o["href"])), None)
    rest = next((o["href"] for o in ops if "RESTful" in o["encodings"] and http_url(o["href"])), None)
    if kvp is None:
        # an endpoint without a stated encoding is KVP (WMTS 1.0.0 §7.1.1.2); no OperationsMetadata: the capabilities URL
        kvp = next((o["href"] for o in ops if not o["encodings"] and http_url(o["href"])), None)
    if kvp is None and not ops:
        kvp = url.split("?", 1)[0]
    out = []
    for layer in children(contents, "Layer"):
        ident = text(layer, "Identifier")
        if not ident:
            continue
        styles = children(layer, "Style")
        style = next((text(s, "Identifier") for s in styles if s.get("isDefault") == "true"), None) or next((text(s, "Identifier") for s in styles), None) or "default"
        formats = [f.text.strip() for f in children(layer, "Format") if f.text and f.text.strip()]
        dims = {}
        for d in children(layer, "Dimension"):
            did = text(d, "Identifier")
            val = text(d, "Default") or next((v.text.strip() for v in children(d, "Value") if v.text and v.text.strip()), None)
            if did and val:
                dims[did] = val
        resources = [(r.get("format") or "", r.get("template") or "") for r in children(layer, "ResourceURL")
                     if (r.get("resourceType") or "").lower() == "tile" and r.get("template")]
        fmt = _pick_format(formats or [f for f, _ in resources])
        res_tpl = next((t for f, t in resources if f == fmt), resources[0][1] if resources else None)
        if res_tpl:
            fmt = next((f for f, t in resources if t == res_tpl), fmt) or fmt

        def source_template(tms: str) -> Optional[str]:
            """The tile URL with {TileMatrix}, {TileRow} and {TileCol} left in."""
            if res_tpl:
                t = urljoin(url, res_tpl.strip())
                t = t.replace("{TileMatrixSet}", _q(tms)).replace("{Style}", _q(style)).replace("{style}", _q(style))
                for k, v in dims.items():
                    t = re.sub(r"\{" + re.escape(k) + r"\}", _q(v).replace("\\", "\\\\"), t, flags=re.I)
                return t if http_url(t) else None
            if kvp:
                t = (f"{kvp_base(kvp)}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={_q(ident)}&STYLE={_q(style)}"
                     f"&TILEMATRIXSET={_q(tms)}&TILEMATRIX={{TileMatrix}}&TILEROW={{TileRow}}&TILECOL={{TileCol}}&FORMAT={_q(fmt)}")
                return t + "".join(f"&{_q(k)}={_q(v)}" for k, v in dims.items())
            if rest:
                # the RESTful pattern of WMTS 1.0.0 §10.2 under the operation's endpoint
                base = rest.split("?", 1)[0].rstrip("/")
                dpath = "".join(f"/{_q(v)}" for v in dims.values())
                return f"{base}/{_q(ident)}/{_q(style)}{dpath}/{_q(tms)}/{{TileMatrix}}/{{TileRow}}/{{TileCol}}.{_EXT.get(fmt, 'png')}"
            return None

        links = [text(link, "TileMatrixSet") for link in children(layer, "TileMatrixSetLink")]
        links = [s for s in links if s in sets]
        item: dict = {"name": ident, "title": text(layer, "Title") or ident, "abstract": text(layer, "Abstract") or "",
                      "mercator": False, "template": None, "warp_spec": None, "reason": None, "crs": None, "tile_matrix_set": None}
        # 1. a GoogleMapsCompatible-like set named by zoom: drawn directly by the browser
        direct = None
        for s in links:
            zooms = mercator_zooms(sets[s])
            prefix = zoom_prefix(zooms) if zooms else None
            if prefix is not None:
                direct = (s, prefix)
                break
        if direct:
            s, prefix = direct
            t = source_template(s)
            if t:
                item.update(mercator=True, crs=sets[s]["crs"], tile_matrix_set=s,
                            template=t.replace("{TileMatrix}", _q(prefix) + "{z}").replace("{TileRow}", "{y}").replace("{TileCol}", "{x}"))
                out.append(item)
                continue
        # 2. any other set whose CRS can be transformed: reprojected by the platform (Web Mercator sets first)
        usable = sorted((s for s in links if not sets[s]["error"]), key=lambda s: (not is_mercator(sets[s]["crs"]), sets[s]["crs"] not in ("EPSG:4326", "CRS84")))
        for s in usable:
            t = source_template(s)
            if t:
                ms = sets[s]
                item.update(crs=ms["crs"], tile_matrix_set=s, warp_spec={
                    "kind": "wmts", "template": t, "crs": ms["crs"], "format": fmt,
                    "matrices": [{k: m[k] for k in ("id", "res", "x", "y", "tw", "th", "mw", "mh")} for m in ms["matrices"]]})
                break
        if item["warp_spec"] is None:
            if not links:
                item["reason"] = "the layer links no tile matrix set described in the document"
            elif usable:
                item["reason"] = "no tile URL: the layer has no ResourceURL and the service no GetTile endpoint"
            else:
                item["reason"] = "; ".join(dict.fromkeys(sets[s]["error"] for s in links)) or "no tile matrix set can be shown"
            item["crs"] = sets[links[0]]["crs"] if links else None
        out.append(item)
    return out


# ------------------------------------------------------------------------------------------------ WMS


def wms_layers(root: Any, url: str) -> list[dict]:
    """Each named layer: Web Mercator ones as a {bbox-epsg-3857} GetMap template; others (EPSG:4326, CRS:84, other
    CRSs pyproj knows) as a warp spec with a GetMap template in that CRS; or a reason."""
    version = root.get("version") or "1.3.0"
    v13 = version.startswith("1.3")
    crs_key = "CRS" if v13 else "SRS"
    cap = child(root, "Capability")
    gm = child(child(cap, "Request"), "GetMap")
    formats = [f.text.strip() for f in children(gm, "Format") if f.text]
    endpoint = url.split("?", 1)[0]
    for dcp in children(gm, "DCPType"):
        res = child(child(child(dcp, "HTTP"), "Get"), "OnlineResource")
        href = res.get(XLINK) if res is not None else None
        if href and http_url(href):
            endpoint = href
            break
    base = kvp_base(endpoint)
    fmt = "image/png" if "image/png" in formats or not formats else _pick_format(formats)
    out: list[dict] = []

    def walk(layer: Any, inherited: list[str]) -> None:
        own = [(c.text or "").strip() for c in children(layer, crs_key) if c.text]
        crs = list(dict.fromkeys(inherited + [x for c in own for x in c.split()]))
        name = text(layer, "Name")
        if name:
            codes = {c: crs_code(c) for c in crs}
            item: dict = {"name": name, "title": text(layer, "Title") or name, "abstract": text(layer, "Abstract") or "",
                          "mercator": False, "template": None, "warp_spec": None, "reason": None, "crs": None}
            head = f"{base}SERVICE=WMS&VERSION={version}&REQUEST=GetMap&LAYERS={_q(name)}&STYLES="
            tail = f"&FORMAT={_q(fmt)}&TRANSPARENT=TRUE"
            merc = next((c for c, k in codes.items() if is_mercator(k)), None)
            if merc:
                item.update(mercator=True, crs="EPSG:3857",
                            template=f"{head}&{crs_key}={_q(merc)}&BBOX={{bbox-epsg-3857}}&WIDTH=256&HEIGHT=256{tail}")
            else:
                order = sorted(codes.items(), key=lambda kv: (kv[1] not in ("CRS84", "EPSG:4326"), kv[1] != "CRS84"))
                reasons = []
                for raw, code in order:
                    try:
                        info = crs_info(code)
                    except CrsUnsupported as e:
                        reasons.append(str(e))
                        continue
                    item.update(crs=code, warp_spec={
                        "kind": "wms", "crs": code, "format": fmt, "axis_swap": bool(v13 and info["lat_first"]),
                        "template": f"{head}&{crs_key}={_q(raw)}&BBOX={{bbox}}&WIDTH={{width}}&HEIGHT={{height}}{tail}"})
                    break
                if item["warp_spec"] is None:
                    item["reason"] = reasons[0] if reasons else "the layer names no CRS"
            out.append(item)
        for sub in children(layer, "Layer"):
            walk(sub, crs)

    for top in children(cap, "Layer"):
        walk(top, [])
    return out


def spec_urls(spec: dict) -> list[str]:
    """Sample upstream URLs of a warp spec (its host and port are what the tile proxy's allow-list must hold)."""
    t = spec.get("template") or ""
    if spec.get("kind") == "wms":
        return [t.replace("{bbox}", "0,0,1,1").replace("{width}", "256").replace("{height}", "256")]
    m = (spec.get("matrices") or [{"id": "0"}])[0]
    return [t.replace("{TileMatrix}", quote(str(m["id"]), safe=":")).replace("{TileRow}", "0").replace("{TileCol}", "0")]


# ------------------------------------------------------------------------------------------------ warping


def mercator_tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    step = 2 * HALF / 2**z
    return -HALF + x * step, HALF - (y + 1) * step, -HALF + (x + 1) * step, HALF - y * step


def pixel_grid(z: int, x: int, y: int, size: int = TILE) -> tuple[Any, Any]:
    """Web Mercator coordinates of the pixel centres of tile z/x/y (rows top to bottom)."""
    import numpy as np

    x0, y0, x1, y1 = mercator_tile_bounds(z, x, y)
    f = (np.arange(size) + 0.5) / size
    return np.meshgrid(x0 + f * (x1 - x0), y1 - f * (y1 - y0))


def _decode(data: bytes) -> Any:
    return _decode_info(data)[0]


def _decode_info(data: bytes) -> tuple[Any, bool]:
    """(RGBA array, paletted): paletted images (PNG8 / GIF / 1-bit) are classes, not imagery."""
    import numpy as np
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        if img.width * img.height > MAX_PIXELS:
            raise WarpError(f"a source image of {img.width} × {img.height} pixels is too large")
        return np.asarray(img.convert("RGBA")), img.mode in ("P", "PA", "1")
    except WarpError:
        raise
    except Exception as e:
        raise WarpError(f"a source image could not be read: {type(e).__name__}") from None


def sampling_mode(spec: dict, sampling: Optional[str] = None) -> str:
    """The sampling asked for (the request's, else the spec's, else "auto"); WarpError when unknown."""
    s = str(sampling or spec.get("sampling") or "auto").strip().lower()
    if s not in SAMPLINGS:
        raise WarpError(f"unknown sampling {s[:20]!r}: use {', '.join(SAMPLINGS)}")
    return s


def _corners(fu: Any, fv: Any, width: int, height: int, wrap: bool = False, fade: bool = False) -> tuple[Any, Any, Any, Any, Any, Any]:
    """The four neighbours (c0, c1, r0, r1) and weights (wx, wy) of continuous pixel coordinates: clamped at the
    raster's edges, or — fade — not clamped (indices may lie outside: the caller treats them as transparent), and
    — wrap — columns periodic (a geographic matrix spanning exactly 360°: the antimeridian)."""
    import numpy as np

    if not fade:
        fv = np.clip(fv, 0.0, height - 1.0)
    r0 = np.floor(fv).astype(np.int64)
    r1 = r0 + 1 if fade else np.minimum(r0 + 1, height - 1)
    if wrap:
        c0 = np.floor(fu).astype(np.int64)
        wx = fu - c0
        c0 = np.mod(c0, width)
        c1 = np.mod(c0 + 1, width)
    elif fade:
        c0 = np.floor(fu).astype(np.int64)
        wx = fu - c0
        c1 = c0 + 1
    else:
        fu = np.clip(fu, 0.0, width - 1.0)
        c0 = np.floor(fu).astype(np.int64)
        wx = fu - c0
        c1 = np.minimum(c0 + 1, width - 1)
    return c0, c1, r0, r1, wx, fv - r0


def bilinear(gather: Callable[[Any, Any], Any], fu: Any, fv: Any, width: int, height: int, wrap: bool = False,
             fade: bool = False) -> Any:
    """Bilinear samples at continuous pixel coordinates fu / fv (pixel centres at integers) of a width × height
    raster read through gather(rows, cols) → RGBA (n, 4); at the raster's edges neighbours clamped (an image whose
    margin is part of the request: WMS) or — fade — transparent beyond the edge (a tile matrix's extent: the last
    half-pixel fades out instead of repeating the edge pixels); columns periodic with wrap (across the antimeridian);
    colours interpolated alpha-premultiplied. RGBA uint8 (n, 4)."""
    import numpy as np

    c0, c1, r0, r1, wx, wy = _corners(fu, fv, width, height, wrap, fade)
    wx, wy = wx[:, None], wy[:, None]
    acc = np.zeros((fu.shape[0], 4), dtype=np.float64)
    for rows, cols, w in ((r0, c0, (1 - wx) * (1 - wy)), (r0, c1, wx * (1 - wy)), (r1, c0, (1 - wx) * wy), (r1, c1, wx * wy)):
        if fade:
            inside = (rows >= 0) & (rows < height) & (cols >= 0) & (cols < width)
            p = gather(np.clip(rows, 0, height - 1), np.clip(cols, 0, width - 1)).astype(np.float64)
            p[~inside] = 0.0
        else:
            p = gather(rows, cols).astype(np.float64)
        a = p[:, 3:4] / 255.0
        acc[:, :3] += w * p[:, :3] * a
        acc[:, 3:4] += w * a
    alpha = acc[:, 3:4]
    rgb = np.where(alpha > 1e-9, acc[:, :3] / np.maximum(alpha, 1e-9), 0.0)
    out = np.concatenate([rgb, alpha * 255.0], axis=1)
    return np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)


def choose_matrix(matrices: list[dict], target_res: float) -> dict:
    """The coarsest matrix at least as fine as the target resolution (with 50 % slack), else the finest."""
    ms = sorted(matrices, key=lambda m: -m["res"])
    if not math.isfinite(target_res) or target_res <= 0:
        return ms[-1]
    return next((m for m in ms if m["res"] <= target_res * 1.5), ms[-1])


def source_pixels(spec: dict, z: int, x: int, y: int, size: int = TILE) -> tuple[Any, Any]:
    X, Y = pixel_grid(z, x, y, size)
    return to_source(spec["crs"], X, Y)


def plan_wmts(spec: dict, z: int, x: int, y: int, size: int = TILE) -> dict:
    """Which source matrix / tiles / pixels tile z/x/y needs (no fetching): {matrix, tiles: [(row, col)], col, row,
    valid, fu, fv} with col / row the global pixel indices in the matrix (nearest) and fu / fv the continuous ones
    (pixel centres at integers, for bilinear sampling)."""
    import numpy as np

    sx, sy = source_pixels(spec, z, x, y, size)
    fin = np.isfinite(sx) & np.isfinite(sy)
    if not fin.any():
        return {"matrix": None, "tiles": [], "valid": fin}
    dx = (np.nanmax(sx) - np.nanmin(sx)) / size
    dy = (np.nanmax(sy) - np.nanmin(sy)) / size
    m = choose_matrix(spec["matrices"], math.sqrt(max(dx, 1e-30) * max(dy, 1e-30)))
    wrap = False
    per = periodic(spec.get("crs") or "")
    if per is not None:
        # longitudes are periodic: a matrix laid out over 0…360 (or starting west of -180) still covers -10° as 350°;
        # one spanning exactly the world (360°; P metres for a cylindrical projection) wraps bilinear neighbours
        # across the antimeridian instead of fading out at the matrix edge.
        P = per[1]
        span = m["mw"] * m["tw"] * m["res"]
        east = m["x"] + span
        sx = np.where(fin & (sx < m["x"]) & (sx + P < east), sx + P, sx)
        sx = np.where(fin & (sx >= east) & (sx - P >= m["x"]), sx - P, sx)
        wrap = abs(span - P) <= m["res"] * 0.01
    col = np.floor((np.where(fin, sx, 0) - m["x"]) / m["res"]).astype(np.int64)
    row = np.floor((m["y"] - np.where(fin, sy, 0)) / m["res"]).astype(np.int64)
    tc, tr = np.floor_divide(col, m["tw"]), np.floor_divide(row, m["th"])
    valid = fin & (tc >= 0) & (tc < m["mw"]) & (tr >= 0) & (tr < m["mh"])
    tiles = sorted({(int(a), int(b)) for a, b in zip(tr[valid].ravel(), tc[valid].ravel())})
    fu = (np.where(fin, sx, 0) - m["x"]) / m["res"] - 0.5
    fv = (m["y"] - np.where(fin, sy, 0)) / m["res"] - 0.5
    return {"matrix": m, "tiles": tiles, "col": col, "row": row, "tr": tr, "tc": tc, "valid": valid, "fu": fu, "fv": fv, "wrap": wrap}


def bilinear_tiles(p: dict) -> list[tuple[int, int]]:
    """The source tiles bilinear sampling reads for a plan_wmts plan: those of the four pixels around every point
    (neighbours across a tile edge), inside the matrix only (wrapped across the antimeridian when the plan wraps;
    neighbours outside the matrix are transparent, not fetched)."""
    m, v = p["matrix"], p["valid"]
    W, H = m["mw"] * m["tw"], m["mh"] * m["th"]
    c0, c1, r0, r1, _, _ = _corners(p["fu"][v], p["fv"][v], W, H, bool(p.get("wrap")), fade=True)
    out = set(p["tiles"])
    for cols in (c0, c1):
        for rows in (r0, r1):
            ok = (rows >= 0) & (rows < H) & (cols >= 0) & (cols < W)
            out.update(zip((rows[ok] // m["th"]).tolist(), (cols[ok] // m["tw"]).tolist()))
    return sorted(out)


def _getmap_url(spec: dict, bbox: tuple[float, float, float, float], w: int, h: int) -> str:
    xmin, ymin, xmax, ymax = bbox
    b = (ymin, xmin, ymax, xmax) if spec.get("axis_swap") else (xmin, ymin, xmax, ymax)
    return spec["template"].replace("{bbox}", ",".join(repr(round(v, 10)) for v in b)).replace("{width}", str(w)).replace("{height}", str(h))


def plan_wms(spec: dict, z: int, x: int, y: int, size: int = TILE) -> dict:
    """The GetMap request(s) tile z/x/y needs: {url, bbox, width, height, parts, sx, sy, valid}. bbox (easting first)
    and width are those of the whole image; parts: [{url, bbox, width}] — one GetMap, or, when the image crosses the
    source CRS's antimeridian (geographic CRSs at their prime meridian + 180°, cylindrical projections at their central
    meridian + 180°: periodic()), one per side of it, each inside the world, on one pixel grid with a column edge on the seam, stitched
    left to right; sx is then unwrapped (eastings past the seam continue beyond the world's east edge)."""
    import numpy as np

    sx, sy = source_pixels(spec, z, x, y, size)
    fin = np.isfinite(sx) & np.isfinite(sy)
    if not fin.any():
        return {"url": None, "parts": [], "valid": fin}
    per = periodic(spec.get("crs") or "")
    if per is not None:
        _, P, east = per
        if float(np.nanmax(sx)) - float(np.nanmin(sx)) > P / 2:  # the tile may span the seam: its west end continues east of it
            moved = np.where(fin & (sx < east - P / 2), sx + P, sx)
            if float(np.nanmax(moved)) - float(np.nanmin(moved)) < float(np.nanmax(sx)) - float(np.nanmin(sx)):
                sx = moved  # (not for a tile as wide as the world: zoom 0 stays one image)
    xmin, xmax, ymin, ymax = float(np.nanmin(sx)), float(np.nanmax(sx)), float(np.nanmin(sy)), float(np.nanmax(sy))
    # half a pixel of margin so the edge pixel centres sample inside the image
    px = math.sqrt(max((xmax - xmin) / size, 1e-12) * max((ymax - ymin) / size, 1e-12))
    xmin, xmax, ymin, ymax = xmin - px / 2, xmax + px / 2, ymin - px / 2, ymax + px / 2
    h = int(min(2048, max(1, math.ceil((ymax - ymin) / px))))
    plan = {"height": h, "sx": sx, "sy": sy, "valid": fin}
    # a seam east + jP inside (xmin, xmax) by more than 1 % of a pixel. (EPSG:4326 / CRS84: never — Web Mercator tiles
    # end on ±180° and the margin stays inside; it happens with other prime meridians / central meridians.)
    tol = px * 0.01
    if per is not None and east + (math.floor((xmin + tol - east) / P) + 1) * P < xmax - tol:
        # pixel columns of q = P / n (n whole: every seam east + jP falls on a column edge), indices from the seam
        n = max(1, math.ceil(P / px))
        if (xmax - xmin) / (P / n) > 2046:
            n = max(1, math.floor(2046 * P / (xmax - xmin)))
        q = P / n
        i0, i1 = math.floor((xmin - east) / q), math.ceil((xmax - east) / q)
        parts = []
        a = i0
        while a < i1:
            world = math.floor(a / n) + 1  # columns [(world - 1) n, world n) lie in the world shifted by world·P
            b = min(i1, world * n)
            ca, cb = a - (world - 1) * n, b - (world - 1) * n  # columns within the world, 0 at its west edge
            bb = (east - P + ca * q, ymin, east if cb == n else east - P + cb * q, ymax)
            parts.append({"url": _getmap_url(spec, bb, b - a, h), "bbox": bb, "width": b - a})
            a = b
        plan.update(parts=parts, url=parts[0]["url"], bbox=(east + i0 * q, ymin, east + i1 * q, ymax), width=i1 - i0)
        return plan
    w = int(min(2048, max(1, math.ceil((xmax - xmin) / px))))
    url = _getmap_url(spec, (xmin, ymin, xmax, ymax), w, h)
    plan.update(url=url, bbox=(xmin, ymin, xmax, ymax), width=w, parts=[{"url": url, "bbox": (xmin, ymin, xmax, ymax), "width": w}])
    return plan


def tile_url(spec: dict, matrix_id: str, row: int, col: int) -> str:
    return spec["template"].replace("{TileMatrix}", quote(str(matrix_id), safe=":")).replace("{TileRow}", str(row)).replace("{TileCol}", str(col))


def _resolve_auto(mode: str, paletted: list[bool], imgs: list) -> str:
    """auto → nearest for classes: every source image paletted, or all of them together fitting a palette (at most
    MAX_CLASS_COLOURS distinct RGBA colours: land cover, zoning, a checkerboard…); bilinear for imagery."""
    if mode != "auto":
        return mode
    if not imgs:
        return "bilinear"
    if all(paletted):
        return "nearest"
    import numpy as np

    seen: set = set()
    for img in imgs:
        u = np.unique(np.ascontiguousarray(img).view(np.uint32))
        if len(u) > MAX_CLASS_COLOURS:
            return "bilinear"
        seen.update(u.tolist())
        if len(seen) > MAX_CLASS_COLOURS:
            return "bilinear"
    return "nearest"


def warp_tile(spec: dict, z: int, x: int, y: int, fetch: Callable[[str], Optional[bytes]], size: int = TILE,
              sampling: Optional[str] = None) -> bytes:
    """Web Mercator tile z/x/y of a warp spec as PNG. fetch(url) → image bytes, or None for an empty tile; it raises
    for refusals (the caller's tile proxy). sampling: "nearest", "bilinear" or "auto" (default: the spec's, else auto)."""
    import numpy as np
    from PIL import Image

    mode = sampling_mode(spec, sampling)
    out = np.zeros((size, size, 4), dtype=np.uint8)
    if spec.get("kind") == "wmts":
        p = plan_wmts(spec, z, x, y, size)
        if len(p["tiles"]) > MAX_SOURCE_TILES:
            raise WarpError(f"this view needs {len(p['tiles'])} source tiles per map tile (at most {MAX_SOURCE_TILES}): zoom in")
        m = p["matrix"]
        if p["tiles"]:
            need = p["tiles"] if mode == "nearest" else bilinear_tiles(p)
            urls = [tile_url(spec, m["id"], r, c) for r, c in need]
            with ThreadPoolExecutor(max_workers=min(6, len(urls))) as ex:
                bodies = list(ex.map(fetch, urls))
            imgs: dict[tuple[int, int], Any] = {}
            paletted: list[bool] = []
            for key, body in zip(need, bodies):
                if body:
                    imgs[key], pal = _decode_info(body)
                    paletted.append(pal)
            mode = _resolve_auto(mode, paletted, list(imgs.values()))
            v = p["valid"]
            if mode == "nearest":
                for (r, c), img in imgs.items():
                    sel = v & (p["tr"] == r) & (p["tc"] == c)
                    # pixel within the tile, scaled when the image is not TileWidth × TileHeight
                    py = ((p["row"][sel] - r * m["th"]) * img.shape[0]) // m["th"]
                    pxx = ((p["col"][sel] - c * m["tw"]) * img.shape[1]) // m["tw"]
                    out[sel] = img[np.clip(py, 0, img.shape[0] - 1), np.clip(pxx, 0, img.shape[1] - 1)]
            else:
                tw, th = m["tw"], m["th"]
                for key, img in imgs.items():
                    if img.shape[0] != th or img.shape[1] != tw:  # a tile not TileWidth × TileHeight: resampled to it
                        imgs[key] = np.asarray(Image.fromarray(img, "RGBA").resize((tw, th), Image.BILINEAR))

                def gather(rows: Any, cols: Any) -> Any:
                    got = np.zeros((rows.shape[0], 4), dtype=np.uint8)  # missing / empty tiles: transparent
                    tr, tc = rows // th, cols // tw
                    for (r, c), img in imgs.items():
                        sel = (tr == r) & (tc == c)
                        if sel.any():
                            got[sel] = img[rows[sel] - r * th, cols[sel] - c * tw]
                    return got

                if v.any():
                    out[v] = bilinear(gather, p["fu"][v], p["fv"][v], m["mw"] * tw, m["mh"] * th, bool(p.get("wrap")), fade=True)
    elif spec.get("kind") == "wms":
        p = plan_wms(spec, z, x, y, size)
        parts = p["parts"]
        if parts:
            # every part (both sides of a split request) through the same fetch: the caller's tile proxy and its checks
            if len(parts) == 1:
                bodies = [fetch(parts[0]["url"])]
            else:
                with ThreadPoolExecutor(max_workers=min(4, len(parts))) as ex:
                    bodies = list(ex.map(fetch, [pt["url"] for pt in parts]))
            if len(parts) == 1:
                decoded = [_decode_info(bodies[0])] if bodies[0] else []
                img = decoded[0][0] if decoded else None
            else:
                decoded, pieces = [], []
                for pt, body in zip(parts, bodies):
                    piece = np.zeros((p["height"], pt["width"], 4), dtype=np.uint8)  # an empty answer: transparent
                    if body:
                        im, pal = _decode_info(body)
                        decoded.append((im, pal))
                        if im.shape[0] != p["height"] or im.shape[1] != pt["width"]:  # not the size asked for
                            im = np.asarray(Image.fromarray(im, "RGBA").resize((pt["width"], p["height"]), Image.NEAREST))
                        piece = im
                    pieces.append(piece)
                img = np.concatenate(pieces, axis=1) if decoded else None
            if img is not None:
                mode = _resolve_auto(mode, [d[1] for d in decoded], [d[0] for d in decoded])
                xmin, ymin, xmax, ymax = p["bbox"]
                v = p["valid"]
                if mode == "nearest":
                    cols = np.floor((p["sx"][v] - xmin) / (xmax - xmin) * img.shape[1]).astype(np.int64)
                    rows = np.floor((ymax - p["sy"][v]) / (ymax - ymin) * img.shape[0]).astype(np.int64)
                    out[v] = img[np.clip(rows, 0, img.shape[0] - 1), np.clip(cols, 0, img.shape[1] - 1)]
                elif v.any():
                    fu = (p["sx"][v] - xmin) / (xmax - xmin) * img.shape[1] - 0.5
                    fv = (ymax - p["sy"][v]) / (ymax - ymin) * img.shape[0] - 0.5
                    out[v] = bilinear(lambda rows, cols: img[rows, cols], fu, fv, img.shape[1], img.shape[0])
    else:
        raise WarpError("unknown warp spec")
    buf = io.BytesIO()
    Image.fromarray(out, "RGBA").save(buf, "PNG", optimize=False)
    return buf.getvalue()
