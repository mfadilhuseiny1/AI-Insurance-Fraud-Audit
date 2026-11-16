"""Contour's scatter plot and map boards (Analytics doc 03: the Chart board's scatter type, the Map board and the
Heatmap board), computed on the server with the path's DuckDB relation (contour_engine.py).

Scatter (a chart board with kind "scatter"): x and y numeric columns, optionally color by a column (categories or a
numeric scale) and size by a numeric column, log axes (rows with values <= 0 on a log axis are left out and counted),
a least-squares trend line fitted on the plotted values (log10 values on log axes; DuckDB's REGR_SLOPE /
REGR_INTERCEPT / REGR_R2). Up to `point_limit` points (default 10,000, at most 50,000) come back one by one and are
drawn on a canvas; above that the board returns density bins (B x B cells over the plotted range, the Chart board's
"result limit" rebucketing): bx = min(floor((px - min) / (max - min) * B), B - 1). A brushed rectangle (in data units)
or a clicked color category is the board's selection and filters the rows below it.

Map: layers on a basemap, each on the current set (the path at this board; only those layers filter) or on another
dataset / path:
- point: lat / lon, color single / by value (categories) / scaled (numeric), size, tooltip; up to 20,000 points.
  Size is a preset (small / medium / large / extra large, drawn in the browser) or a numeric column on a linear, log
  or square root scale: f(v) = v, log10(v) or sqrt(v) over the rows with a usable value (finite; > 0 on log, >= 0 on
  square root), t = (f(v) - f(min)) / (f(max) - f(min)) sets the radius; the legend's 4 bins are equal steps of f
  over every row of the layer (not only the points sent): bin = min(floor(t * 4), 3), bounds f^-1 of the steps.
- cluster and heatmap: rows aggregated in square cells of 360 / 2^k degrees (gx = floor(lon / cell), gy =
  floor(lat / cell)), k the finest level with at most 16,384 cells over the data's extent; count, sum, min, max and
  the centroid per cell, so the browser merges cells into coarser clusters when zoomed out (count / sum / avg / min /
  max; other metrics are shown per cell as computed).
- choropleth: regions of a GeoJSON FeatureCollection in Files joined on a region id column, colored by an aggregate
  of the rows per region; or a GeoJSON geometry column per row colored by a value column (up to 5,000 shapes).
- line: point to point (start / end lat / lon) or a GeoJSON line column (up to 5,000 lines).
Every GeoJSON-column shape carries a key, md5 of the column's text (the same expression filters, on every engine).
Selections (OR-ed, "remove" mode negates them): clicked points (lat = and lon =), regions (region column =), lines
(the four columns =), GeoJSON-column shapes (one clicked shape: its key; the shapes a drawn box / polygon touches,
found in the browser: their keys, at most 5,000), circles (great-circle distance <= radius, on every current-set
point / cluster / heatmap layer) and polygons (ray casting in SQL); at most 30 clicked items per layer.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable, Optional

import pyarrow as pa

from contour_engine import ContourError, q, rows_of

POINT_LIMIT = 10_000
POINT_LIMIT_MAX = 50_000
SCATTER_BINS = 80
CATEGORIES = 10
MAP_POINTS = 20_000
MAP_SHAPES = 5_000
MAP_CELLS = 16_384
MAX_K = 24
MAX_SELECTED = 30
EARTH_R = 6371008.8  # meters, as MapCanvas' haversine
SIZE_BINS = 4
SIZE_SCALES = ("linear", "log", "sqrt")


def num(col: str) -> str:
    return f"TRY_CAST({q(col)} AS DOUBLE)"


def dbl(v: Any) -> str:
    """A double literal parsed exactly (a decimal literal would be a DECIMAL first)."""
    f = float(v)
    if not math.isfinite(f):
        raise ContourError("a selection value is not a finite number")
    return f"CAST('{f!r}' AS DOUBLE)"


def _is_numeric(t: pa.DataType) -> bool:
    return pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)


def _col_type(comp, src: str, col: str) -> pa.DataType:
    t = comp.run(f"SELECT {q(col)} FROM {src}", 0).schema
    return t.field(0).type


def _agg(metric: Optional[str], v: str, raw: Optional[str] = None) -> str:
    """An aggregate of `v` (a DOUBLE expression); `raw` is the column itself (for distinct counts)."""
    m = (metric or "count").lower()
    if m == "count":
        return "COUNT(*)"
    if not raw:
        raise ContourError(f"{m} needs a column")
    return {"sum": f"SUM({v})", "avg": f"AVG({v})", "min": f"MIN({v})", "max": f"MAX({v})", "median": f"MEDIAN({v})",
            "stddev": f"STDDEV_SAMP({v})", "variance": f"VAR_SAMP({v})", "distinct": f"COUNT(DISTINCT {q(raw)})"}.get(m) or _bad(m)


def _bad(m: str) -> str:
    raise ContourError(f"unknown metric {m}")


def _columnar(t: pa.Table) -> dict[str, list]:
    rows = rows_of(t)
    return {k: [r[k] for r in rows] for k in t.schema.names}


def _categories(comp, rel: str, expr: str) -> dict:
    """The most frequent values of an expression (as text), for a categorical color legend."""
    t = comp.run(f"SELECT CAST({expr} AS VARCHAR) AS k, COUNT(*) AS n FROM {rel} GROUP BY 1 ORDER BY n DESC, k NULLS LAST")
    rows = rows_of(t)
    return {"kind": "category", "values": [r["k"] for r in rows[:CATEGORIES]], "counts": [r["n"] for r in rows[:CATEGORIES]], "distinct": len(rows)}


# ------------------------------------------------------------------ scatter


def scatter_base(c: dict, src: str) -> str:
    """x, y, the plotted px / py (log10 on log axes), color and size of every plottable row."""
    x, y = c.get("x") or "", c.get("y") or ""
    if not x or not y:
        raise ContourError("choose the scatter plot's x and y columns")
    px = f"LOG10({num(x)})" if c.get("log_x") else num(x)
    py = f"LOG10({num(y)})" if c.get("log_y") else num(y)
    sel = [f"{num(x)} AS x", f"{num(y)} AS y", f"{px} AS px", f"{py} AS py"]
    if c.get("color"):
        sel.append(f"{q(c['color'])} AS color")
    if c.get("size"):
        sel.append(f"{num(c['size'])} AS size")
    where = [f"isfinite({num(x)})", f"isfinite({num(y)})"]
    if c.get("log_x"):
        where.append(f"{num(x)} > 0")
    if c.get("log_y"):
        where.append(f"{num(y)} > 0")
    return f"SELECT {', '.join(sel)} FROM {src} WHERE {' AND '.join(where)}"


def scatter_result(comp, b: dict, src: str) -> dict:
    c = b.get("config") or {}
    base = scatter_base(c, src)
    has_size = bool(c.get("size"))
    st = rows_of(comp.run(
        f"SELECT COUNT(*) AS n, MIN(px) AS x0, MAX(px) AS x1, MIN(py) AS y0, MAX(py) AS y1, REGR_SLOPE(py, px) AS slope, "
        f"REGR_INTERCEPT(py, px) AS intercept, REGR_R2(py, px) AS r2"
        + (", MIN(size) AS s0, MAX(size) AS s1" if has_size else "") + f" FROM ({base})"))[0]
    total = comp.count(src)
    meta: dict[str, Any] = {"n": st["n"], "total": total, "excluded": total - st["n"], "x0": st["x0"], "x1": st["x1"], "y0": st["y0"], "y1": st["y1"],
                            "log_x": bool(c.get("log_x")), "log_y": bool(c.get("log_y")),
                            # no trend when x does not vary: DuckDB's REGR_SLOPE is then NaN, Spark's NULL
                            "trend": {"slope": st["slope"], "intercept": st["intercept"], "r2": st["r2"]}
                            if isinstance(st["slope"], (int, float)) and math.isfinite(st["slope"]) else None}
    if has_size:
        meta["size"] = {"min": st["s0"], "max": st["s1"]}
    if c.get("color"):
        if _is_numeric(_col_type(comp, src, c["color"])):
            r = rows_of(comp.run(f"SELECT MIN(TRY_CAST(color AS DOUBLE)) AS lo, MAX(TRY_CAST(color AS DOUBLE)) AS hi FROM ({base})"))[0]
            meta["color"] = {"kind": "scale", "min": r["lo"], "max": r["hi"]}
        else:
            meta["color"] = _categories(comp, f"({base})", "color")
    limit = max(100, min(int(c.get("point_limit") or POINT_LIMIT), POINT_LIMIT_MAX))
    meta["limit"] = limit
    if st["n"] <= limit:
        cols = "x AS key, y AS value" + (", color" if c.get("color") else "") + (", size" if has_size else "")
        t = comp.run(f"SELECT {cols} FROM ({base})")
        meta["mode"] = "points"
        return {"data": rows_of(t), "data_columns": list(t.schema.names), "scatter": meta}
    bins = max(10, min(int(c.get("bins") or SCATTER_BINS), 200))
    meta.update(mode="bins", bins=bins)
    t = comp.run(scatter_bins_sql(base, bins, has_size))
    data = rows_of(t)
    meta["max_count"] = max((r["count"] for r in data), default=0)
    return {"data": data, "data_columns": list(t.schema.names), "scatter": meta}


def scatter_bins_sql(base: str, bins: int, has_size: bool = False) -> str:
    """Density bins: B x B cells over the plotted range (the last cell holds the maximum)."""
    def cell(v: str, lo: str, hi: str) -> str:
        return f"CASE WHEN {hi} = {lo} THEN 0 ELSE LEAST(CAST(FLOOR(({v} - {lo}) / ({hi} - {lo}) * {bins}) AS BIGINT), {bins - 1}) END"
    # subqueries, not a WITH: the compiler puts the path's CTEs in front of the query
    return (f"SELECT {cell('px', 'x0', 'x1')} AS bx, {cell('py', 'y0', 'y1')} AS by, COUNT(*) AS count"
            + (", AVG(size) AS size" if has_size else "")
            + f" FROM ({base}) b, (SELECT MIN(px) AS x0, MAX(px) AS x1, MIN(py) AS y0, MAX(py) AS y1 FROM ({base})) r GROUP BY 1, 2 ORDER BY 1, 2")


def scatter_filter(c: dict, sel: list) -> Optional[str]:
    """Brushed rectangles (x0..x1, y0..y1 in data units) and clicked color categories, OR-ed."""
    x, y = c.get("x"), c.get("y")
    parts = []
    for s in sel[: MAX_SELECTED * 2]:
        if not isinstance(s, dict):
            continue
        if "x0" in s and x and y:
            xs, ys = sorted([float(s["x0"]), float(s["x1"])]), sorted([float(s["y0"]), float(s["y1"])])
            parts.append(f"{num(x)} BETWEEN {dbl(xs[0])} AND {dbl(xs[1])} AND {num(y)} BETWEEN {dbl(ys[0])} AND {dbl(ys[1])}")
        elif "color" in s and c.get("color"):
            col = q(c["color"])
            v = s["color"]
            parts.append(f"{col} IS NULL" if v is None else f"CAST({col} AS VARCHAR) = '{str(v).replace(chr(39), chr(39) * 2)}'")
    return " OR ".join(f"({p})" for p in parts) or None


# ------------------------------------------------------------------ map


def map_layers(c: dict) -> list[dict]:
    """The board's layers; a map saved before layers existed (lat / lon / label) is one point layer."""
    layers = c.get("layers")
    if not layers and c.get("lat") and c.get("lon"):
        return [{"id": "l1", "type": "point", "lat": c["lat"], "lon": c["lon"], "tooltip": c.get("label")}]
    return [l for l in layers or [] if isinstance(l, dict)]


def _points_rel(l: dict, rel: str, extra: str = "") -> str:
    lat, lon = l.get("lat") or "", l.get("lon") or ""
    if not lat or not lon:
        raise ContourError("choose the latitude and longitude columns")
    return (f"(SELECT {num(lat)} AS lat, {num(lon)} AS lon{extra} FROM {rel} "
            f"WHERE {num(lat)} BETWEEN -90 AND 90 AND {num(lon)} BETWEEN -180 AND 180)")


def cell_level(lat0: float, lat1: float, lon0: float, lon1: float, max_cells: int = MAP_CELLS) -> int:
    """The finest k (cells of 360 / 2^k degrees) whose cells over the extent are at most max_cells."""
    k = 0
    for j in range(MAX_K + 1):
        cell = 360.0 / 2 ** j
        n = (math.floor(lon1 / cell) - math.floor(lon0 / cell) + 1) * (math.floor(lat1 / cell) - math.floor(lat0 / cell) + 1)
        if n > max_cells:
            break
        k = j
    return k


def cells_sql(pts: str, k: int, metric: Optional[str], col: Optional[str]) -> str:
    cell = f"CAST('{360.0 / 2 ** k!r}' AS DOUBLE)"
    has_v = bool(col) and (metric or "count") != "count"
    return (f"SELECT CAST(FLOOR(lon / {cell}) AS BIGINT) AS gx, CAST(FLOOR(lat / {cell}) AS BIGINT) AS gy, COUNT(*) AS n, "
            f"AVG(lat) AS lat, AVG(lon) AS lon, "
            + (f"SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx, COUNT(v) AS nv, " if has_v else "")
            + f"{_agg(metric, 'v', col)} AS value FROM {pts} GROUP BY 1, 2 ORDER BY 1, 2")


def size_scale_sql(scale: str, v: str) -> tuple[str, str]:
    """(f(v), the condition for a usable value) of a size scale."""
    if scale not in SIZE_SCALES:
        raise ContourError(f"unknown size scale {scale}")
    if scale == "log":
        return f"LOG10({v})", f"isfinite({v}) AND {v} > 0"
    if scale == "sqrt":
        return f"SQRT({v})", f"isfinite({v}) AND {v} >= 0"
    return v, f"isfinite({v})"


def _size_inverse(scale: str, f: float) -> float:
    return 10 ** f if scale == "log" else f * f if scale == "sqrt" else f


def size_legend(comp, pts: str, scale: str, total: int) -> dict:
    """The size column's range over the usable rows and its SIZE_BINS equal steps of f(v), counted over every row."""
    f, ok_ = size_scale_sql(scale, "size")
    st = rows_of(comp.run(f"SELECT COUNT(*) AS n, MIN(size) AS lo, MAX(size) AS hi, MIN({f}) AS f0, MAX({f}) AS f1 FROM {pts} WHERE {ok_}"))[0]
    out: dict[str, Any] = {"scale": scale, "n": st["n"], "missing": total - st["n"], "min": st["lo"], "max": st["hi"], "bins": []}
    if not st["n"]:
        return out
    f0, f1, B = st["f0"], st["f1"], SIZE_BINS
    cell = f"CASE WHEN {dbl(f1)} = {dbl(f0)} THEN 0 ELSE LEAST(CAST(FLOOR(({f} - {dbl(f0)}) / ({dbl(f1)} - {dbl(f0)}) * {B}) AS BIGINT), {B - 1}) END"
    counts = {r["b"]: r["n"] for r in rows_of(comp.run(f"SELECT {cell} AS b, COUNT(*) AS n FROM {pts} WHERE {ok_} GROUP BY 1"))}
    steps = [f0 + (f1 - f0) * j / B for j in range(B + 1)]
    # the outer bounds are the data's own values (f^-1(f(min)) can differ in the last digits)
    bounds = [st["lo"]] + [_size_inverse(scale, s) for s in steps[1:-1]] + [st["hi"]]
    out["bins"] = [{"lo": bounds[j], "hi": bounds[j + 1], "n": counts.get(j, 0)} for j in range(B if f1 != f0 else 1)]
    if f1 == f0:
        out["bins"][0]["hi"] = st["hi"]
    return out


def _layer_point(comp, l: dict, rel: str) -> dict:
    extra = ""
    mode = l.get("color_mode") or "single"
    if mode in ("value", "scale") and l.get("color_column"):
        extra += f", {q(l['color_column'])} AS color"
    if l.get("tooltip"):
        extra += f", CAST({q(l['tooltip'])} AS VARCHAR) AS tooltip"
    by_size = l.get("size_mode") == "column" and bool(l.get("size_column"))
    if by_size:
        extra += f", {num(l['size_column'])} AS size"
    pts = _points_rel(l, rel, extra)
    total = int(comp.run(f"SELECT COUNT(*) FROM {pts}").column(0)[0].as_py())
    out: dict[str, Any] = {"total": total, "points": _columnar(comp.run(f"SELECT * FROM {pts} LIMIT {MAP_POINTS}"))}
    if by_size:
        out["size"] = size_legend(comp, pts, l.get("size_scale") or "linear", total)
        out["size"]["column"] = l["size_column"]
    if "color" in extra:
        if mode == "scale":
            r = rows_of(comp.run(f"SELECT MIN(TRY_CAST(color AS DOUBLE)) AS lo, MAX(TRY_CAST(color AS DOUBLE)) AS hi FROM {pts}"))[0]
            out["color"] = {"kind": "scale", "min": r["lo"], "max": r["hi"]}
        else:
            out["color"] = _categories(comp, pts, "color")
    return out


def _layer_cells(comp, l: dict, rel: str) -> dict:
    metric = (l.get("metric") or "count").lower()
    col = l.get("metric_column") if metric != "count" else None
    if metric != "count" and not col:
        raise ContourError(f"{metric} needs a column")
    pts = _points_rel(l, rel, f", {num(col)} AS v, {q(col)} AS {q(col)}" if col else "")
    ext = rows_of(comp.run(f"SELECT COUNT(*) AS n, MIN(lat) AS a0, MAX(lat) AS a1, MIN(lon) AS o0, MAX(lon) AS o1 FROM {pts}"))[0]
    if not ext["n"]:
        return {"total": 0, "cells": {}, "k": 0, "cell": 360.0, "mergeable": True}
    k = min(cell_level(ext["a0"], ext["a1"], ext["o0"], ext["o1"]), int(l.get("max_level") or MAX_K))
    t = comp.run(cells_sql(pts, k, metric, col))
    return {"total": ext["n"], "k": k, "cell": 360.0 / 2 ** k, "metric": metric, "mergeable": metric in ("count", "sum", "avg", "min", "max"),
            "cells": _columnar(t)}


def _geometry(v: Any) -> Optional[dict]:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    if isinstance(v, dict) and v.get("type") == "Feature":
        v = v.get("geometry")
    if isinstance(v, dict) and isinstance(v.get("type"), str) and ("coordinates" in v or "geometries" in v):
        return v
    return None


def shape_key_sql(col: str) -> str:
    """A GeoJSON-column shape's key: md5 of the column's text (shown and filtered with the same expression)."""
    return f"md5(CAST({q(col)} AS VARCHAR))"


def shape_column(l: dict) -> Optional[str]:
    """The GeoJSON column of a layer drawing one shape per row (GeoJSON choropleth or GeoJSON lines), else None."""
    t = l.get("type") or "point"
    if (t == "choropleth" and l.get("choropleth_kind") == "geojson") or (t == "line" and l.get("line_kind") == "geojson"):
        return l.get("geometry_column") or None
    return None


def _shape_key(k: Any) -> str:
    if not isinstance(k, str) or len(k) != 32 or any(ch not in "0123456789abcdef" for ch in k):
        raise ContourError("a shape selection's key is not an md5 hex digest")
    return k


def _layer_shapes(comp, l: dict, rel: str, value_col: Optional[str]) -> dict:
    g = l.get("geometry_column") or ""
    if not g:
        raise ContourError("choose the GeoJSON column")
    extra = (f", {q(value_col)} AS value" if value_col else "") + (f", CAST({q(l['tooltip'])} AS VARCHAR) AS tooltip" if l.get("tooltip") else "")
    t = comp.run(f"SELECT CAST({q(g)} AS VARCHAR) AS geometry, {shape_key_sql(g)} AS key{extra} FROM {rel} WHERE {q(g)} IS NOT NULL LIMIT {MAP_SHAPES}")
    shapes, bad = [], 0
    for r in rows_of(t):
        geo = _geometry(r["geometry"])
        if geo is None:
            bad += 1
            continue
        shapes.append({"geometry": geo, "key": r["key"], "value": r.get("value"), "tooltip": r.get("tooltip")})
    out: dict[str, Any] = {"shapes": shapes, "invalid": bad}
    vals = [s["value"] for s in shapes if isinstance(s["value"], (int, float)) and not isinstance(s["value"], bool)]
    if value_col and l.get("color_mode") == "scale" and vals:
        out["color"] = {"kind": "scale", "min": min(vals), "max": max(vals)}
    elif value_col and l.get("color_mode") == "value":
        out["color"] = _categories(comp, f"(SELECT {q(value_col)} AS v FROM {rel} WHERE {q(g)} IS NOT NULL)", "v")
    return out


def _layer_regions(comp, l: dict, rel: str, boundaries: Callable[[str], list[dict]]) -> dict:
    region, item, key = l.get("region_column") or "", l.get("boundaries_item_id") or "", l.get("feature_key") or ""
    if not region or not item or not key:
        raise ContourError("choose the boundaries file, its region id property and the region id column")
    metric = (l.get("metric") or "count").lower()
    col = l.get("metric_column") if metric != "count" else None
    t = comp.run(f"SELECT CAST({q(region)} AS VARCHAR) AS k, {_agg(metric, num(col) if col else '', col)} AS value, COUNT(*) AS n "
                 f"FROM {rel} WHERE {q(region)} IS NOT NULL GROUP BY 1")
    agg = {r["k"]: r for r in rows_of(t)}
    feats, matched = [], set()
    for f in boundaries(item):
        props = f.get("properties") or {}
        rid = props.get(key)
        a = agg.get(str(rid)) if rid is not None else None
        if a is not None:
            matched.add(str(rid))
        feats.append({"id": rid, "name": props.get("name") or props.get("name_en") or props.get("NAME") or rid, "geometry": f.get("geometry"),
                      "value": a["value"] if a else None, "n": a["n"] if a else 0})
    vals = [x["value"] for x in feats if isinstance(x["value"], (int, float))]
    return {"regions": feats, "min": min(vals) if vals else None, "max": max(vals) if vals else None, "matched": len(matched),
            "unmatched": sorted(k for k in agg if k not in matched)[:20], "unmatched_count": sum(1 for k in agg if k not in matched)}


def _layer_lines(comp, l: dict, rel: str) -> dict:
    if (l.get("line_kind") or "points") == "geojson":
        return _layer_shapes(comp, l, rel, l.get("value_column") if l.get("color_mode") in ("scale", "value") else None)
    cols = [l.get(k) or "" for k in ("lat", "lon", "lat2", "lon2")]
    if not all(cols):
        raise ContourError("choose the start and end latitude and longitude columns")
    mode = l.get("color_mode") or "single"
    vc = l.get("value_column") if mode in ("scale", "value") else None
    sel = ", ".join(f"{num(x)} AS {n}" for x, n in zip(cols, ("lat", "lon", "lat2", "lon2")))
    extra = (f", {q(vc)} AS value" if vc else "") + (f", CAST({q(l['tooltip'])} AS VARCHAR) AS tooltip" if l.get("tooltip") else "")
    where = " AND ".join(f"isfinite({num(x)})" for x in cols)
    t = comp.run(f"SELECT {sel}{extra} FROM {rel} WHERE {where} LIMIT {MAP_SHAPES}")
    out: dict[str, Any] = {"lines": _columnar(t)}
    if vc and mode == "scale":
        r = rows_of(comp.run(f"SELECT MIN(TRY_CAST({q(vc)} AS DOUBLE)) AS lo, MAX(TRY_CAST({q(vc)} AS DOUBLE)) AS hi FROM {rel}"))[0]
        out["color"] = {"kind": "scale", "min": r["lo"], "max": r["hi"]}
    elif vc:
        out["color"] = _categories(comp, f"(SELECT {q(vc)} AS v FROM {rel})", "v")
    return out


def map_result(comp, b: dict, src: str, boundaries: Callable[[str], list[dict]]) -> dict:
    """Every layer's data; a failing layer carries its error and the others are still drawn."""
    c = b.get("config") or {}
    layers = map_layers(c)
    if not layers:
        raise ContourError("add a layer to the map")
    out = []
    for l in layers:
        res: dict[str, Any] = {"id": l.get("id"), "type": l.get("type") or "point"}
        try:
            rel = comp.source(l["source"]) if l.get("source") else src
            t = res["type"]
            if t == "point":
                res.update(_layer_point(comp, l, rel))
            elif t in ("cluster", "heatmap"):
                res.update(_layer_cells(comp, l, rel))
            elif t == "choropleth":
                if (l.get("choropleth_kind") or "boundaries") == "geojson":
                    mode = l.get("color_mode") or "single"
                    res.update(_layer_shapes(comp, l, rel, l.get("value_column") if mode in ("scale", "value") else None))
                else:
                    res.update(_layer_regions(comp, l, rel, boundaries))
            elif t == "line":
                res.update(_layer_lines(comp, l, rel))
            else:
                raise ContourError(f"unknown map layer {t}")
        except ContourError as e:
            res["error"] = str(e)
        out.append(res)
    return {"data": [], "data_columns": [], "map": {"layers": out}}


def map_points_sql(c: dict, src: str) -> str:
    """CSV export / Quiver: the first point-like layer's coordinates (as the board was before layers)."""
    l = next((x for x in map_layers(c) if not x.get("source") and x.get("lat") and x.get("lon")), None)
    if not l:
        raise ContourError("choose the latitude and longitude columns")
    label = f", {q(l['tooltip'])} AS label" if l.get("tooltip") else ""
    return f"SELECT {num(l['lat'])} AS lat, {num(l['lon'])} AS lon{label} FROM {src} WHERE {q(l['lat'])} IS NOT NULL AND {q(l['lon'])} IS NOT NULL LIMIT 5000"


def circle_sql(lat: str, lon: str, s: dict) -> str:
    """Great-circle (haversine) distance from the centre within the radius, in meters."""
    a, o, r = dbl(s["lat"]), dbl(s["lon"]), dbl(s["radius_m"])
    return (f"2 * {EARTH_R!r} * ASIN(LEAST(1, SQRT(POWER(SIN(RADIANS({num(lat)} - {a}) / 2), 2) + "
            f"COS(RADIANS({a})) * COS(RADIANS({num(lat)})) * POWER(SIN(RADIANS({num(lon)} - {o}) / 2), 2)))) <= {r}")


def polygon_sql(lat: str, lon: str, ring: list) -> str:
    """Point in polygon by ray casting (an odd number of edges crossed to the right of the point)."""
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3 or len(pts) > 1000:
        raise ContourError("a polygon filter needs 3 to 1,000 corners")
    x, y = num(lon), num(lat)
    terms = []
    for i in range(len(pts)):
        (xi, yi), (xj, yj) = pts[i], pts[i - 1]
        if yi == yj:
            continue  # a horizontal edge is never crossed
        terms.append(f"CAST((({y} > {dbl(yi)}) <> ({y} > {dbl(yj)})) AND ({x} < ({dbl(xj)} - {dbl(xi)}) * ({y} - {dbl(yi)}) / ({dbl(yj)} - {dbl(yi)}) + {dbl(xi)}) AS INTEGER)")
    return f"(COALESCE({' + '.join(terms)}, 0) % 2) = 1" if terms else "FALSE"


def map_filter(c: dict, sel: list) -> Optional[str]:
    """A map board's selection as one condition on its current-set layers' columns."""
    layers = [l for l in map_layers(c) if not l.get("source")]
    by_id = {l.get("id"): l for l in layers}
    spatial = [l for l in layers if (l.get("type") or "point") in ("point", "cluster", "heatmap") and l.get("lat") and l.get("lon")]
    parts: list[str] = []
    per_layer: dict[Any, int] = {}
    for s in sel:
        if not isinstance(s, dict):
            continue
        kind = s.get("kind")
        if kind == "circle":
            parts += [circle_sql(l["lat"], l["lon"], s) for l in spatial]
            continue
        if kind == "polygon":
            ring = (s.get("coordinates") or [[]])[0]
            parts += [polygon_sql(l["lat"], l["lon"], ring) for l in spatial]
            continue
        l = by_id.get(s.get("layer"))
        if not l:
            continue
        per_layer[l.get("id")] = per_layer.get(l.get("id"), 0) + 1
        if per_layer[l.get("id")] > MAX_SELECTED:
            continue
        if kind == "point" and l.get("lat") and l.get("lon"):
            parts.append(f"{num(l['lat'])} = {dbl(s['lat'])} AND {num(l['lon'])} = {dbl(s['lon'])}")
        elif kind == "region" and l.get("region_column"):
            col = q(l["region_column"])
            parts.append(f"{col} IS NULL" if s.get("value") is None else f"CAST({col} AS VARCHAR) = '{str(s['value']).replace(chr(39), chr(39) * 2)}'")
        elif kind == "line" and shape_column(l) is None and all(l.get(k) for k in ("lat", "lon", "lat2", "lon2")):
            parts.append(" AND ".join(f"{num(l[k])} = {dbl(s[k])}" for k in ("lat", "lon", "lat2", "lon2")))
        elif kind == "shape" and shape_column(l):
            parts.append(f"{shape_key_sql(shape_column(l))} = '{_shape_key(s.get('key'))}'")
        elif kind == "shapes" and shape_column(l):
            keys = sorted({_shape_key(k) for k in (s.get("keys") or [])})
            if len(keys) > MAP_SHAPES:
                raise ContourError(f"a box selects at most {MAP_SHAPES:,} shapes")
            if keys:
                parts.append(f"{shape_key_sql(shape_column(l))} IN ({', '.join(repr(k) for k in keys)})")
    if not parts:
        return None
    cond = "COALESCE(" + " OR ".join(f"({p})" for p in parts) + ", FALSE)"
    return f"NOT {cond}" if c.get("selection_mode") == "remove" else cond
