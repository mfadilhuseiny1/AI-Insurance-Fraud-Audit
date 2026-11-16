"""`geospatial_tools` for Python transforms in Code Repositories: Palantir's legacy library for vector geospatial data
("Use vector data in transforms [Legacy]"), on the real PySpark of Spark transforms. Kept so existing code builds;
Pipeline Builder's geospatial transforms are the current way.

    from geospatial_tools import geospatial
    from geospatial_tools.functions import clean_geometry, buffer, area, agg_union, ...
    from geospatial_tools.parsers import geojson_to_dataframe, shapefile_to_dataframe, kml_to_dataframe, kmz_to_dataframe

    @geospatial()
    @transform_df(Output(...), df=Input(...))
    def compute(df):
        return df.withColumn("geometry", clean_geometry("geometry", "EPSG:26910"))

`@geospatial()` (above every other decorator) makes the transform a Spark transform (also without importing pyspark)
and binds `DataFrame.spatial_join`, `distance_join` and `knn_join`. The Spark profile GEOSPARK is accepted (Sedona's
jars are not needed: geometry work runs in Python UDFs on shapely and pyproj). Geometries are GeoJSON strings in
EPSG:4326; a "geohash" here is a "latitude,longitude" string, as in geospatial-tools. Metric work (buffer, simplify,
distance, length, area) projects into `metric_crs` (default EPSG:3395) and back.

Spatial joins index both sides on a grid of cells (the `resolution`, inferred from the right side's shapes when not
given, plays H3's role: it changes speed, not the result), join on shared cells and keep the pairs whose shapes
intersect (or lie within `distance_meters`). `library="sedona"` runs the same join. File geodatabases (GDB) need GDAL,
which is not installed here: gdb_to_dataframe says so.
"""

from __future__ import annotations

import functools
import io
import json
import math
import struct
import types
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, Optional

import geo

# ------------------------------------------------------------------------------------------------
# row-level functions (module level, so Spark's Python workers import them from here)
# ------------------------------------------------------------------------------------------------


def _shape(v: Any):
    if v is None or v == "":
        return None
    try:
        return geo.to_shape(v)
    except Exception:  # noqa: BLE001 - an unreadable geometry is null, as in Spark SQL
        return None


def _out(g) -> Optional[str]:
    return geo.to_geojson(g) if g is not None else None


def _point_text(g) -> Optional[str]:
    """A geometry as a geohash ("lat,long") of its point (or its centroid)."""
    if g is None or g.is_empty:
        return None
    p = g if g.geom_type == "Point" else g.centroid
    return f"{geo._num(p.y)},{geo._num(p.x)}"


def clean_value(value: Any, input_crs: str, geometry_format: str = "geojson", lat_long: bool = False, output_format: str = "geojson") -> Optional[str]:
    if value is None or value == "":
        return None
    try:
        g = geo.to_shape(value, geometry_format, lat_long)
    except Exception:  # noqa: BLE001
        return None
    g = geo.make_valid(geo.reproject(g, input_crs, geo.WGS84))
    return _point_text(g) if output_format == "geohash" else _out(g)


def lat_long_value(lat: Any, lon: Any, input_crs: str, output_format: str = "geojson") -> Optional[str]:
    if lat is None or lon is None:
        return None
    try:
        x, y = geo.reproject_point(float(lon), float(lat), input_crs, geo.WGS84)
    except (TypeError, ValueError):
        return None
    from shapely.geometry import Point

    p = Point(x, y)
    return _point_text(p) if output_format == "geohash" else _out(p)


def _unary(op: str, *args: Any):
    def run(v: Any) -> Any:
        g = _shape(v)
        if g is None:
            return None
        if op == "convex_hull":
            return _out(geo.oriented(g.convex_hull))
        if op == "bounding_box":
            return _out(geo.oriented(g.envelope))
        if op == "bounding_circle":
            return _out(geo.oriented(geo.bounding_circle(g, *args)))
        if op == "centroid":
            return _out(g.centroid)
        if op == "buffer":
            return _out(geo.buffer(g, *args))
        if op == "simplify":
            return _out(geo.simplify(g, *args))
        if op in ("start_point", "end_point"):
            lines = [g] if g.geom_type == "LineString" else list(g.geoms) if g.geom_type == "MultiLineString" else []
            if not lines:
                return None
            from shapely.geometry import Point

            c = lines[0].coords[0] if op == "start_point" else lines[-1].coords[-1]
            return _out(Point(c[0], c[1]))
        if op == "length":
            return geo.length(g, *args)
        if op == "area":
            return geo.area(g, *args)
        raise ValueError(op)

    return run


def _binary(op: str, *args: Any):
    def run(a: Any, b: Any) -> Any:
        ga, gb = _shape(a), _shape(b)
        if ga is None or gb is None:
            return None
        if op == "distance":
            return geo.distance(ga, gb, *args)
        if op == "contains":
            return bool(ga.contains(gb))
        if op == "intersects":
            return bool(ga.intersects(gb))
        r = {"intersection": ga.intersection, "difference": ga.difference, "symmetric_difference": ga.symmetric_difference, "union": ga.union}[op](gb)
        return _out(geo.oriented(r))

    return run


def _aggregate(op: str):
    def run(values: Any) -> Optional[str]:
        shapes = [g for g in (_shape(v) for v in values or []) if g is not None]
        if not shapes:
            return None
        if op == "union":
            from shapely.ops import unary_union

            return _out(geo.oriented(unary_union(shapes)))
        if op == "intersection":
            r = shapes[0]
            for g in shapes[1:]:
                r = r.intersection(g)
            return _out(geo.oriented(r))
        from shapely.geometry import box

        bounds = [g.bounds for g in shapes]
        return _out(geo.oriented(box(min(b[0] for b in bounds), min(b[1] for b in bounds), max(b[2] for b in bounds), max(b[3] for b in bounds))))

    return run


def _subdivide(max_vertices: int):
    def run(v: Any) -> Optional[list]:
        g = _shape(v)
        return None if g is None else [_out(p) for p in geo.subdivide(g, max_vertices)]

    return run


# ------------------------------------------------------------------------------------------------
# geospatial_tools.functions: Spark Column expressions
# ------------------------------------------------------------------------------------------------


def _F():
    from pyspark.sql import functions as F

    return F


def _c(col: Any):
    return _F().col(col) if isinstance(col, str) else col


def _udf(fn, rtype: str = "string"):
    return _F().udf(fn, rtype)


def clean_geometry(geometry, input_crs, geometry_format="geojson", lat_long=False, output_format="geojson"):
    """Make a geometry column valid (RFC 7946 winding) and normalise its CRS to EPSG:4326."""
    if geometry_format not in ("geojson", "geohash", "wkt", "wkb"):
        raise ValueError("geometry_format must be geojson, geohash, wkt or wkb")
    if output_format not in ("geojson", "geohash"):
        raise ValueError("output_format must be geojson or geohash")
    geo.crs_name(input_crs)
    return _udf(functools.partial(clean_value, input_crs=input_crs, geometry_format=geometry_format, lat_long=lat_long, output_format=output_format))(_c(geometry))


def lat_long_to_geometry(lat, long, input_crs, output_format="geojson"):
    """A latitude and a longitude column as a cleaned geometry (or geohash) column."""
    if output_format not in ("geojson", "geohash"):
        raise ValueError("output_format must be geojson or geohash")
    geo.crs_name(input_crs)
    return _udf(functools.partial(lat_long_value, input_crs=input_crs, output_format=output_format))(_c(lat), _c(long))


def geohash_to_geojson(geometry):
    """A geohash ("lat,long") column as GeoJSON points."""
    return _udf(functools.partial(clean_value, input_crs=geo.WGS84, geometry_format="geohash", lat_long=True))(_c(geometry))


def geojson_to_geohash(geometry):
    """A point GeoJSON column as geohashes ("lat,long")."""
    return _udf(functools.partial(clean_value, input_crs=geo.WGS84, output_format="geohash"))(_c(geometry))


def buffer(geometry, meters, metric_crs=geo.METRIC_CRS):
    return _udf(_unary("buffer", float(meters), metric_crs))(_c(geometry))


def convex_hull(geometry):
    return _udf(_unary("convex_hull"))(_c(geometry))


def bounding_box(geometry):
    return _udf(_unary("bounding_box"))(_c(geometry))


def bounding_circle(geometry, segments=100):
    return _udf(_unary("bounding_circle", int(segments)))(_c(geometry))


def simplify(geometry, tolerance, metric_crs=geo.METRIC_CRS):
    return _udf(_unary("simplify", float(tolerance), metric_crs))(_c(geometry))


def start_point(geometry):
    return _udf(_unary("start_point"))(_c(geometry))


def end_point(geometry):
    return _udf(_unary("end_point"))(_c(geometry))


def centroid(geometry):
    return _udf(_unary("centroid"))(_c(geometry))


def intersection(geometry1, geometry2):
    return _udf(_binary("intersection"))(_c(geometry1), _c(geometry2))


def difference(geometry1, geometry2):
    return _udf(_binary("difference"))(_c(geometry1), _c(geometry2))


def symmetric_difference(geometry1, geometry2):
    return _udf(_binary("symmetric_difference"))(_c(geometry1), _c(geometry2))


def union(geometry1, geometry2):
    return _udf(_binary("union"))(_c(geometry1), _c(geometry2))


def distance(geometry1, geometry2, metric_crs=geo.METRIC_CRS):
    """Euclidean distance in meters (in metric_crs)."""
    return _udf(_binary("distance", metric_crs), "double")(_c(geometry1), _c(geometry2))


def length(geometry, metric_crs=geo.METRIC_CRS):
    """Length / perimeter in meters."""
    return _udf(_unary("length", metric_crs), "double")(_c(geometry))


def area(geometry, metric_crs=geo.METRIC_CRS):
    """Area in square meters."""
    return _udf(_unary("area", metric_crs), "double")(_c(geometry))


def contains(geometry1, geometry2):
    return _udf(_binary("contains"), "boolean")(_c(geometry1), _c(geometry2))


def intersects(geometry1, geometry2):
    return _udf(_binary("intersects"), "boolean")(_c(geometry1), _c(geometry2))


def agg_union(geometry):
    """Aggregate: the union of the group's geometries (use inside .agg())."""
    return _udf(_aggregate("union"))(_F().collect_list(_c(geometry)))


def agg_intersection(geometry):
    return _udf(_aggregate("intersection"))(_F().collect_list(_c(geometry)))


def agg_bounding_box(geometry):
    return _udf(_aggregate("bounding_box"))(_F().collect_list(_c(geometry)))


def subdivide_explode(df, geometry, max_vertices):
    """One row per component of at most max_vertices vertices (faster spatial joins on very complex shapes)."""
    F = _F()
    return df.withColumn(geometry, F.explode(_udf(_subdivide(int(max_vertices)), "array<string>")(F.col(geometry))))


# ------------------------------------------------------------------------------------------------
# spatial joins
# ------------------------------------------------------------------------------------------------


def _cells(cell: float, pad_m: float = 0.0):
    """Grid cells (as "ix:iy") covering a geometry's bounding box, padded by pad_m meters."""

    def run(v: Any) -> Optional[list]:
        b = geo.bbox_of(v)
        if b is None:
            return None
        x0, y0, x1, y1 = b
        if pad_m:
            dy = pad_m / 111_320.0
            dx = pad_m / (111_320.0 * max(0.01, math.cos(math.radians(max(abs(y0), abs(y1))))))
            x0, y0, x1, y1 = x0 - dx, y0 - dy, x1 + dx, y1 + dy
        ix0, ix1 = math.floor(x0 / cell), math.floor(x1 / cell)
        iy0, iy1 = math.floor(y0 / cell), math.floor(y1 / cell)
        if (ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 250_000:
            raise ValueError("a shape spans too many join cells: pass a smaller resolution or subdivide_explode it first")
        return [f"{i}:{j}" for i in range(ix0, ix1 + 1) for j in range(iy0, iy1 + 1)]

    return run


def _resolution_deg(resolution: Optional[int]) -> Optional[float]:
    if resolution is None:
        return None
    r = int(resolution)
    if not 0 <= r <= 15:
        raise ValueError("resolution must be an H3 resolution 0..15")
    edge_km = 1281.256 / (math.sqrt(7) ** r)  # H3's average hexagon edge at resolution r
    return max(1e-5, edge_km * 2 / 111.32)


def _infer_cell(df, column: str) -> float:
    """A cell size from the typical extent of a sample of the shapes."""
    rows = df.select(column).where(_F().col(column).isNotNull()).limit(500).collect()
    sizes = []
    for (v,) in rows:
        b = geo.bbox_of(v)
        if b:
            sizes.append(max(b[2] - b[0], b[3] - b[1]))
    if not sizes:
        return 0.1
    sizes.sort()
    return min(10.0, max(0.001, sizes[len(sizes) // 2] or 0.01))


def _check_library(library: str, resolution, left_partitions, right_partitions) -> None:
    if library not in ("h3", "sedona"):
        raise ValueError("library must be 'h3' or 'sedona'")
    if library == "sedona" and resolution is not None:
        raise ValueError("resolution is an H3 setting: it cannot be used with library='sedona'")
    if library == "h3" and (left_partitions is not None or right_partitions is not None):
        raise ValueError("left_partitions / right_partitions are Sedona settings: they cannot be used with library='h3'")


def _keyed(df, pk: Optional[str], name: str):
    if pk:
        if pk not in df.columns:
            raise ValueError(f"{pk} is not a column")
        return df, pk, False
    return df.withColumn(name, _F().monotonically_increasing_id()), name, True


def _pairs(left, right, on: tuple, cell: float, pad_m: float, keep, lpk: str, rpk: str, left_partitions=None, right_partitions=None):
    F = _F()
    lcol, rcol = on
    if left_partitions:
        left = left.repartition(int(left_partitions))
    if right_partitions:
        right = right.repartition(int(right_partitions))
    cells_l = _udf(_cells(cell, pad_m), "array<string>")
    cells_r = _udf(_cells(cell), "array<string>")
    lx = left.select(F.col(lpk).alias("__l"), F.col(lcol).alias("__lg"), F.explode(cells_l(F.col(lcol))).alias("__cell"))
    rx = right.select(F.col(rpk).alias("__r"), F.col(rcol).alias("__rg"), F.explode(cells_r(F.col(rcol))).alias("__cell"))
    cand = lx.join(rx, "__cell").drop("__cell").dropDuplicates(["__l", "__r"])
    return cand.where(_udf(keep, "boolean")(F.col("__lg"), F.col("__rg"))).select("__l", "__r")


def _assemble(left, right, pairs, lpk: str, rpk: str, how: str, drop: list[str]):
    F = _F()
    clash = [c for c in right.columns if c in left.columns and c != rpk]
    if clash:
        right = right.select(*[F.col(c).alias(f"{c}_right") if c in clash else F.col(c) for c in right.columns])
    how = how.lower()
    if how in ("left_semi", "semi", "leftsemi", "left_anti", "anti", "leftanti"):
        out = left.join(pairs.select(F.col("__l").alias(lpk)).distinct(), lpk, how)
    else:
        p = pairs.select(F.col("__l").alias(lpk), F.col("__r").alias(rpk))
        first = {"inner": "inner", "left": "left", "left_outer": "left", "leftouter": "left", "right": "right", "right_outer": "right",
                 "outer": "full", "full": "full", "full_outer": "full", "fullouter": "full"}.get(how)
        if first is None:
            raise ValueError(f"unsupported join type {how!r}")
        out = left.join(p, lpk, "left" if first in ("left", "full") else "inner") if first != "right" else p
        out = out.join(right, rpk, {"inner": "inner", "left": "left", "right": "right", "full": "full"}[first])
        if first == "right":
            out = out.join(left, lpk, "left")
    return out.drop(*[c for c in drop if c in out.columns])


def _intersects(a: Any, b: Any) -> bool:
    ga, gb = _shape(a), _shape(b)
    return bool(ga is not None and gb is not None and ga.intersects(gb))


def _within(meters: float, metric_crs: str):
    def run(a: Any, b: Any) -> bool:
        ga, gb = _shape(a), _shape(b)
        return bool(ga is not None and gb is not None and geo.distance(ga, gb, metric_crs) <= meters)

    return run


def spatial_join(self, right_df, on, how="inner", library="h3", resolution=None, left_partitions=None, right_partitions=None,
                 left_pk=None, right_pk=None):
    """DataFrame.spatial_join: rows whose geometries intersect."""
    _check_library(library, resolution, left_partitions, right_partitions)
    lcol, rcol = on
    left, lpk, gl = _keyed(self, left_pk, "__left_pk")
    right, rpk, gr = _keyed(right_df, right_pk, "__right_pk")
    cell = _resolution_deg(resolution) or _infer_cell(right, rcol)
    pairs = _pairs(left, right, (lcol, rcol), cell, 0.0, _intersects, lpk, rpk, left_partitions, right_partitions)
    return _assemble(left, right, pairs, lpk, rpk, how, [x for x, g in ((lpk, gl), (rpk, gr)) if g])


def distance_join(self, right_df, on, distance_meters, how="inner", metric_crs=geo.METRIC_CRS, left_pk=None, right_pk=None, library="h3",
                  resolution=None, left_partitions=None, right_partitions=None):
    """DataFrame.distance_join: rows whose geometries lie within distance_meters (in metric_crs)."""
    _check_library(library, resolution, left_partitions, right_partitions)
    lcol, rcol = on
    left, lpk, gl = _keyed(self, left_pk, "__left_pk")
    right, rpk, gr = _keyed(right_df, right_pk, "__right_pk")
    d = float(distance_meters)
    cell = _resolution_deg(resolution) or max(_infer_cell(right, rcol), d / 111_320.0)
    pairs = _pairs(left, right, (lcol, rcol), cell, d * 1.5, _within(d, metric_crs), lpk, rpk, left_partitions, right_partitions)
    return _assemble(left, right, pairs, lpk, rpk, how, [x for x, g in ((lpk, gl), (rpk, gr)) if g])


def knn_join(self, right_df, on, k, metric_crs=geo.METRIC_CRS, resolution=None, left_pk=None, right_pk=None):
    """DataFrame.knn_join: a left join of the k nearest rows of right_df (by distance in metric_crs)."""
    from pyspark.sql import Window

    F = _F()
    if int(k) < 1:
        raise ValueError("k must be at least 1")
    _resolution_deg(resolution)
    lcol, rcol = on
    left, lpk, gl = _keyed(self, left_pk, "__left_pk")
    right, rpk, gr = _keyed(right_df, right_pk, "__right_pk")
    dist = _udf(_binary("distance", metric_crs), "double")
    cand = (left.select(F.col(lpk).alias("__l"), F.col(lcol).alias("__lg"))
            .crossJoin(right.select(F.col(rpk).alias("__r"), F.col(rcol).alias("__rg")))
            .withColumn("__d", dist(F.col("__lg"), F.col("__rg"))).where(F.col("__d").isNotNull()))
    w = Window.partitionBy("__l").orderBy("__d", "__r")
    pairs = cand.withColumn("__n", F.row_number().over(w)).where(F.col("__n") <= int(k)).select("__l", "__r")
    return _assemble(left, right, pairs, lpk, rpk, "left", [x for x, g in ((lpk, gl), (rpk, gr)) if g])


def geopandas_spatial_join(df_left, df_right, geometry_left, geometry_right, how="inner", op="intersects"):
    """A spatial join of two pandas DataFrames with GeoJSON geometry columns (geopandas' sjoin): right columns that
    clash get _left / _right suffixes, and index_right holds the matched right row's index."""
    import pandas as pd
    from shapely.strtree import STRtree

    if how not in ("left", "right", "inner"):
        raise ValueError("how must be left, right or inner")
    if op not in ("intersects", "contains", "within"):
        raise ValueError("op must be intersects, contains or within")
    ls = [_shape(v) for v in df_left[geometry_left]]
    rs = [_shape(v) for v in df_right[geometry_right]]
    ridx = [i for i, g in enumerate(rs) if g is not None]
    tree = STRtree([rs[i] for i in ridx]) if ridx else None
    pairs = []
    for i, g in enumerate(ls):
        if g is None or tree is None:
            continue
        for j in tree.query(g):
            r = rs[ridx[int(j)]]
            if getattr(g, op)(r):
                pairs.append((i, ridx[int(j)]))
    left = df_left.copy()
    left["__li"] = range(len(df_left))
    right = df_right.copy()
    right["index_right"] = df_right.index
    right["__ri"] = range(len(df_right))
    clash = [c for c in df_right.columns if c in df_left.columns]
    left = left.rename(columns={c: f"{c}_left" for c in clash})
    right = right.rename(columns={c: f"{c}_right" for c in clash})
    p = pd.DataFrame(pairs, columns=["__li", "__ri"])
    out = left.merge(p, on="__li", how="left" if how == "left" else "inner").merge(right, on="__ri", how="left" if how != "right" else "right")
    if how == "right":
        out = right.merge(p, on="__ri", how="left").merge(left, on="__li", how="left")
    return out.drop(columns=[c for c in ("__li", "__ri") if c in out.columns]).reset_index(drop=True)


# ------------------------------------------------------------------------------------------------
# geospatial_tools.parsers: files of a dataset → DataFrame
# ------------------------------------------------------------------------------------------------


def _files(dataset, glob: str) -> list:
    fs = dataset.filesystem()
    return sorted((f.path for f in fs.ls(glob=glob)), key=str)


def _frame(dataset, rows: list[dict], columns: list[str]):
    """Rows as a DataFrame: Spark (all columns strings) in Spark transforms, pandas otherwise."""
    fs = dataset.filesystem()
    if getattr(fs, "_spark", None) is not None:
        from pyspark.sql.types import StringType, StructField, StructType

        spark = fs._spark()
        schema = StructType([StructField(c, StringType()) for c in columns])
        data = [tuple(None if r.get(c) is None else r[c] if isinstance(r[c], str) else json.dumps(r[c]) if isinstance(r[c], (dict, list)) else str(r[c])
                      for c in columns) for r in rows]
        return spark.createDataFrame(data, schema)
    import pandas as pd

    return pd.DataFrame(rows, columns=columns)


def geojson_to_dataframe(dataset, properties=None, glob="*.geojson", batch_size=100000):
    """GeoJSON files → one row per feature: the chosen properties as columns (else one JSON `properties` column) and
    `geometry`. Features are converted batch_size at a time."""
    rows: list[dict] = []
    frames = []
    columns = [*(properties or ["properties"]), "geometry"]
    fs = dataset.filesystem()
    for path in _files(dataset, glob):
        with fs.open(path, "rb") as f:
            doc = json.load(f)
        feats = doc.get("features", []) if doc.get("type") == "FeatureCollection" else [doc] if doc.get("type") == "Feature" else [{"geometry": doc}]
        for ft in feats:
            pr = ft.get("properties") or {}
            g = ft.get("geometry")
            row = {k: pr.get(k) for k in properties} if properties else {"properties": json.dumps(pr, ensure_ascii=False)}
            row["geometry"] = json.dumps(g, separators=(",", ":")) if g else None
            rows.append(row)
            if len(rows) >= int(batch_size):
                frames.append(_frame(dataset, rows, columns))
                rows = []
    frames.append(_frame(dataset, rows, columns))
    return _concat(frames)


def _concat(frames):
    if len(frames) == 1:
        return frames[0]
    if hasattr(frames[0], "unionByName"):
        out = frames[0]
        for f in frames[1:]:
            out = out.unionByName(f)
        return out
    import pandas as pd

    return pd.concat(frames, ignore_index=True)


def _read_dbf(data: bytes) -> tuple[list[str], list[dict]]:
    n, header_len, rec_len = struct.unpack("<xxxxIHH", data[:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos : pos + 11].split(b"\x00")[0].decode("latin-1")
        ftype = chr(data[pos + 11])
        flen, fdec = data[pos + 16], data[pos + 17]
        fields.append((name, ftype, flen, fdec))
        pos += 32
    rows = []
    for i in range(n):
        start = header_len + i * rec_len
        rec = data[start : start + rec_len]
        if not rec or rec[:1] == b"*":
            rows.append(None)
            continue
        off, row = 1, {}
        for name, ftype, flen, fdec in fields:
            raw = rec[off : off + flen]
            off += flen
            text = raw.decode("utf-8", "replace").strip().strip("\x00")
            if text == "" or set(text) <= {"*", "?"}:
                row[name] = None
            elif ftype in ("N", "F"):
                try:
                    row[name] = int(text) if fdec == 0 and "." not in text else float(text)
                except ValueError:
                    row[name] = None
            elif ftype == "L":
                row[name] = text.upper() in ("Y", "T")
            elif ftype == "D" and len(text) == 8:
                row[name] = f"{text[:4]}-{text[4:6]}-{text[6:]}"
            else:
                row[name] = text
        rows.append(row)
    return [f[0] for f in fields], rows


def _shp_records(data: bytes) -> list[Optional[dict]]:
    """Shapes of a .shp file as GeoJSON geometries (Z / M values dropped)."""
    out = []
    pos = 100
    while pos + 8 <= len(data):
        _num, length = struct.unpack(">ii", data[pos : pos + 8])
        content = data[pos + 8 : pos + 8 + length * 2]
        pos += 8 + length * 2
        if len(content) < 4:
            break
        (stype,) = struct.unpack("<i", content[:4])
        base = stype % 10 if stype not in (31,) else 0
        if stype == 0:
            out.append(None)
        elif base == 1:  # Point, PointZ (11), PointM (21)
            x, y = struct.unpack("<2d", content[4:20])
            out.append({"type": "Point", "coordinates": [x, y]})
        elif base == 8:  # MultiPoint
            (npts,) = struct.unpack("<i", content[36:40])
            pts = [list(struct.unpack("<2d", content[40 + 16 * i : 56 + 16 * i])) for i in range(npts)]
            out.append({"type": "MultiPoint", "coordinates": pts})
        elif base in (3, 5):  # PolyLine, Polygon
            nparts, npts = struct.unpack("<2i", content[36:44])
            parts = list(struct.unpack(f"<{nparts}i", content[44 : 44 + 4 * nparts]))
            p0 = 44 + 4 * nparts
            pts = [list(struct.unpack("<2d", content[p0 + 16 * i : p0 + 16 + 16 * i])) for i in range(npts)]
            rings = [pts[parts[i] : parts[i + 1] if i + 1 < nparts else npts] for i in range(nparts)]
            if base == 3:
                out.append({"type": "LineString", "coordinates": rings[0]} if len(rings) == 1 else {"type": "MultiLineString", "coordinates": rings})
            else:
                # shapefile rings: outer clockwise, holes counter-clockwise; shapely sorts them out
                from shapely.geometry import Polygon
                from shapely.ops import unary_union

                outers = [r for r in rings if geo._ring_area(r) < 0] or rings
                holes = [r for r in rings if geo._ring_area(r) >= 0] if len(outers) < len(rings) else []
                polys = []
                for o in outers:
                    po = Polygon(o)
                    polys.append(Polygon(o, [h for h in holes if po.contains(Polygon(h).representative_point())]))
                out.append(json.loads(geo.to_geojson(geo.make_valid(unary_union(polys))) or "null"))
        else:
            out.append(None)
    return out


def shapefile_rows(shp: bytes, dbf: Optional[bytes], prj: Optional[str]) -> tuple[list[str], list[dict]]:
    shapes = _shp_records(shp)
    names, attrs = _read_dbf(dbf) if dbf else ([], [{} for _ in shapes])
    src = prj.strip() if prj and prj.strip() else None
    rows = []
    for g, a in zip(shapes, attrs):
        if a is None:
            continue
        geom = None
        if g:
            shape = geo.to_shape(g)
            if src:
                shape = geo.make_valid(geo.reproject(shape, src, geo.WGS84))
            geom = geo.to_geojson(shape)
        rows.append({**a, "geometry": geom})
    return [*names, "geometry"], rows


def shapefile_to_dataframe(dataset, glob="*.shp"):
    """Shapefiles → one row per shape: the .dbf attributes and `geometry` (GeoJSON, reprojected to EPSG:4326 from the
    .prj's CRS when there is one). The .shx is not needed; the .dbf and .prj are read next to the .shp."""
    fs = dataset.filesystem()
    present = {f.path for f in fs.ls()}
    all_rows, columns = [], []
    for path in _files(dataset, glob):
        stem = path[: -len(".shp")] if path.lower().endswith(".shp") else path
        sib = lambda ext: next((p for p in present if p.lower() == (stem + ext).lower()), None)  # noqa: E731
        with fs.open(path, "rb") as f:
            shp = f.read()
        dbf = sib(".dbf")
        prj = sib(".prj")
        dbf_bytes = fs.open(dbf, "rb").read() if dbf else None
        prj_text = fs.open(prj, "r").read() if prj else None
        cols, rows = shapefile_rows(shp, dbf_bytes, prj_text)
        columns += [c for c in cols if c not in columns]
        all_rows += rows
    if "geometry" in columns:
        columns = [c for c in columns if c != "geometry"] + ["geometry"]
    return _frame(dataset, all_rows, columns or ["geometry"])


def gdb_to_dataframe(dataset, glob="*.gdb.zip", layer=None):
    raise NotImplementedError("File geodatabases (GDB) need GDAL, which is not installed on this platform: export the layer as a "
                              "shapefile or GeoJSON and use shapefile_to_dataframe / geojson_to_dataframe")


_KML_NS = "{http://www.opengis.net/kml/2.2}"


def _kml_coords(text: str) -> list[list[float]]:
    out = []
    for tok in (text or "").split():
        parts = tok.split(",")
        if len(parts) >= 2:
            out.append([float(parts[0]), float(parts[1])])
    return out


def _kml_geometry(el) -> Optional[dict]:
    tag = el.tag.replace(_KML_NS, "").split("}")[-1]
    find = lambda e, name: e.find(f".//{_KML_NS}{name}") if e.find(f".//{_KML_NS}{name}") is not None else e.find(f".//{name}")  # noqa: E731
    if tag == "Point":
        c = _kml_coords(find(el, "coordinates").text)
        return {"type": "Point", "coordinates": c[0]} if c else None
    if tag == "LineString":
        return {"type": "LineString", "coordinates": _kml_coords(find(el, "coordinates").text)}
    if tag == "Polygon":
        rings = []
        for b in ("outerBoundaryIs", "innerBoundaryIs"):
            for e in list(el.iter(f"{_KML_NS}{b}")) + list(el.iter(b)):
                ring = find(e, "coordinates")
                if ring is not None:
                    rings.append(_kml_coords(ring.text))
        g = geo.make_valid(geo.to_shape({"type": "Polygon", "coordinates": rings}))
        return json.loads(geo.to_geojson(g) or "null")
    if tag == "MultiGeometry":
        parts = [g for g in (_kml_geometry(c) for c in el) if g]
        if not parts:
            return None
        from shapely.ops import unary_union

        return json.loads(geo.to_geojson(geo.oriented(unary_union([geo.to_shape(p) for p in parts]))) or "null")
    return None


def kml_rows(text: bytes, drop_invalid_layers: bool = False) -> list[dict]:
    root = ET.fromstring(text)
    rows = []

    def layer_name(el) -> str:
        n = el.find(f"{_KML_NS}name")
        if n is None:
            n = el.find("name")
        return (n.text or "").strip() if n is not None and n.text else ""

    def walk(el, layer: str) -> int:
        found = 0
        for child in el:
            tag = child.tag.replace(_KML_NS, "")
            if tag in ("Document", "Folder"):
                name = layer_name(child) or layer
                n = walk(child, name)
                if tag == "Folder" and n == 0 and not drop_invalid_layers and any(c.tag.endswith("Placemark") for c in child.iter()):
                    raise ValueError(f"KML layer {name!r} has no readable placemarks (drop_invalid_layers=True skips it)")
                found += n
            elif tag == "Placemark":
                geom = None
                for g in child:
                    if g.tag.replace(_KML_NS, "") in ("Point", "LineString", "Polygon", "MultiGeometry"):
                        geom = _kml_geometry(g)
                if geom is None:
                    continue
                ext = {}
                for d in child.iter(f"{_KML_NS}Data"):
                    v = d.find(f"{_KML_NS}value")
                    ext[d.get("name")] = v.text if v is not None else None
                for d in child.iter(f"{_KML_NS}SimpleData"):
                    ext[d.get("name")] = d.text
                desc = child.find(f"{_KML_NS}description")
                rows.append({"layer": layer, "name": layer_name(child) or None, "description": desc.text if desc is not None else None,
                             "extended_data": json.dumps(ext, ensure_ascii=False) if ext else None, "geometry": json.dumps(geom, separators=(",", ":"))})
                found += 1
        return found

    walk(root, "")
    return rows


KML_COLUMNS = ["layer", "name", "description", "extended_data", "geometry"]


def kml_to_dataframe(dataset, glob="*.kml", drop_invalid_layers=False):
    """KML files → one row per placemark: layer (folder), name, description, extended data (JSON) and geometry."""
    fs = dataset.filesystem()
    rows = []
    for path in _files(dataset, glob):
        with fs.open(path, "rb") as f:
            rows += kml_rows(f.read(), drop_invalid_layers)
    return _frame(dataset, rows, KML_COLUMNS)


def kmz_to_dataframe(dataset, glob="*.kmz"):
    """KMZ files (zipped KML) → rows as kml_to_dataframe."""
    fs = dataset.filesystem()
    rows = []
    for path in _files(dataset, glob):
        with fs.open(path, "rb") as f, zipfile.ZipFile(io.BytesIO(f.read())) as z:
            for name in z.namelist():
                if name.lower().endswith(".kml"):
                    rows += kml_rows(z.read(name))
    return _frame(dataset, rows, KML_COLUMNS)


# ------------------------------------------------------------------------------------------------
# the decorator and the modules
# ------------------------------------------------------------------------------------------------


def _bind() -> None:
    """DataFrame.spatial_join / distance_join / knn_join."""
    try:
        from pyspark.sql import DataFrame
    except ImportError:  # pragma: no cover - pyspark is in requirements.txt
        return
    DataFrame.spatial_join = spatial_join
    DataFrame.distance_join = distance_join
    DataFrame.knn_join = knn_join


def geospatial():
    """Enable the geospatial bindings on a transform; place it above every other decorator."""

    def wrap(obj):
        entry = getattr(obj, "_entry", None)
        if entry is None:
            raise TypeError("@geospatial() must be placed above the transform's other decorators (@transform_df, @configure, ...)")
        entry["geospatial"] = True
        _bind()
        return obj

    return wrap


FUNCTIONS = ("clean_geometry", "lat_long_to_geometry", "geohash_to_geojson", "geojson_to_geohash", "buffer", "convex_hull", "bounding_box",
             "bounding_circle", "simplify", "start_point", "end_point", "centroid", "intersection", "difference", "symmetric_difference", "union",
             "distance", "length", "area", "contains", "intersects", "agg_union", "agg_intersection", "agg_bounding_box", "subdivide_explode")
PARSERS = ("geojson_to_dataframe", "shapefile_to_dataframe", "gdb_to_dataframe", "kml_to_dataframe", "kmz_to_dataframe")


def install() -> None:
    import sys

    pkg = types.ModuleType("geospatial_tools")
    pkg.__path__ = []  # type: ignore[attr-defined]
    pkg.geospatial = geospatial
    fns = types.ModuleType("geospatial_tools.functions")
    for n in FUNCTIONS:
        setattr(fns, n, globals()[n])
    parsers = types.ModuleType("geospatial_tools.parsers")
    for n in PARSERS:
        setattr(parsers, n, globals()[n])
    joins = types.ModuleType("geospatial_tools.spatial_joins")
    for n in ("geopandas_spatial_join", "spatial_join", "distance_join", "knn_join"):
        setattr(joins, n, globals()[n])
    pkg.functions, pkg.parsers, pkg.spatial_joins = fns, parsers, joins
    sys.modules.update({"geospatial_tools": pkg, "geospatial_tools.functions": fns, "geospatial_tools.parsers": parsers,
                        "geospatial_tools.spatial_joins": joins})
