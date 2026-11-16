"""Time series columns of Quiver transform tables (Analytics doc 05: "Time series columns", "Time series operations",
"Sparklines" and their view range).

A transform table whose input is an object set card can add columns computed from each row's time series: a time
series property of the object type (or "sensor:<name>", a linked sensor of the row's object). The card's
`series_columns` list holds them:

    {name?, property, op, range?, at?, points?}

- op: last | first | mean | min | max | sum | count | std | median | range (ts_engine.aggregate over the points in
  the range; std is the population standard deviation), value_at (the series' value at `at`, by its interpolation,
  read from the whole series), start | end (the first / last timestamp in the range), sparkline (down-sampled points
  as JSON text [[epoch ms, value], …], at most `points`, 60 by default).
- range (the sparkline's "view range"; the aggregates' window): "analysis" (default: the analysis' time range) |
  "full" (the full extent of the series) | {"start": …, "end": …} (fixed) | {"last": "7d"} (relative to now).
- transforms (the doc's "Add Transformation" on a time series column, applied in order before the operation):
  [{type, ...}] with type rolling {window: "7d", aggregation: mean|sum|min|max|count|std|median|first|last|range} (the
  window ends at each point, inclusive, and spans the duration: (t - window, t]), periodic {period: "1d", aggregation},
  cumulative {aggregation}, derivative {unit: s|m|h|d}, integral {unit}, shift {by: "-1d"}, sample {every: "1h"},
  filter {min?, max?, start?, end?, values?}, dsp {filter: moving_average|ema|lowpass|highpass, window?, alpha?}
  (ts_engine's cards). The operation then reads the derived series: "sparkline" draws it, "value_at" reads it at a
  time, the aggregates aggregate it (e.g. the latest 7-day rolling mean is op "last" after a rolling transform).
  Windows and shifts read the raw series earlier than the range (ts_engine.margins), so a rolling value at the range's
  start sees the points before it; cumulative / integral start at the range's start.
- op "unit": the series' unit (the doc's "Time series unit" card), as text.
- name: the column's name (default "<property>_<op>", or "<property>_<transforms>_<op>", e.g.
  klaim_harian_rolling_mean_7d_last).

The columns are added to the object set's rows before the table's transformations, so steps can filter, sort, group
and chart them. Each (row, series, range) is one read with the reader's permissions (ts_ontology.Resolver), metered
like the doc's "each time series cell is an independent query"; at most MAX_READS reads per table. A row whose series
cannot be read (no value, no data, no permission) has empty cells; the first few reasons are returned.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

import pyarrow as pa

import contour_engine as E
import ts_engine as TE

AGG_OPS = ("last", "first", "mean", "min", "max", "sum", "count", "std", "median", "range")
OPS = (*AGG_OPS, "value_at", "start", "end", "sparkline", "unit")
ALIASES = {"avg": "mean", "average": "mean", "stddev": "std", "stdev": "std", "standard_deviation": "std", "latest": "last", "earliest": "first",
           "start_date": "start", "end_date": "end", "time_series_unit": "unit"}
# series-to-series transforms of a column (ts_engine card types) and their defaults (which also name the column)
TRANSFORMS: dict[str, dict] = {
    "rolling": {"window": "1h", "aggregation": "mean"},
    "periodic": {"period": "1d", "aggregation": "mean"},
    "cumulative": {"aggregation": "sum"},
    "derivative": {"unit": "s"},
    "integral": {"unit": "s"},
    "shift": {"by": "0s"},
    "sample": {"every": "1h"},
    "filter": {},
    "dsp": {"filter": "moving_average", "window": "1h"},
}
TRANSFORM_ALIASES = {"rolling_aggregate": "rolling", "periodic_aggregate": "periodic", "cumulative_aggregate": "cumulative",
                     "shift_time_series": "shift", "filter_time_series": "filter", "dsp_filter": "dsp"}
MAX_TRANSFORMS = 8
# the parts of a transform's config that name the column (rolling mean 7d -> rolling_mean_7d)
_NAME_KEYS = {"rolling": ("aggregation", "window"), "periodic": ("aggregation", "period"), "cumulative": ("aggregation",),
              "shift": ("by",), "sample": ("every",), "dsp": ("filter",)}
MAX_READS = 2_000
DEFAULT_POINTS = 60
MAX_POINTS = 500
Range = tuple[Optional[int], Optional[int]]


def _op(col: dict) -> str:
    op = str(col.get("op") or "last").strip().lower()
    op = ALIASES.get(op, op)
    if op not in OPS:
        raise E.ContourError(f"unknown time series operation {col.get('op')} ({', '.join(OPS)})")
    return op


def _slug(text: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", str(text)).strip("_")


def transforms(col: dict) -> list[dict]:
    """The column's transforms with their defaults filled in; raises ContourError on an unknown type or a bad
    duration / period / aggregation."""
    raw = col.get("transforms") or []
    if not isinstance(raw, list):
        raise E.ContourError("transforms must be a list")
    if len(raw) > MAX_TRANSFORMS:
        raise E.ContourError(f"a time series column takes at most {MAX_TRANSFORMS} transforms")
    out = []
    for tr in raw:
        if not isinstance(tr, dict):
            raise E.ContourError("each transform is an object {type, ...}")
        kind = str(tr.get("type") or "").strip().lower()
        kind = TRANSFORM_ALIASES.get(kind, kind)
        if kind not in TRANSFORMS:
            raise E.ContourError(f"unknown time series transform {tr.get('type')!r} ({', '.join(TRANSFORMS)})")
        cfg = {**TRANSFORMS[kind], **{k: v for k, v in tr.items() if k not in ("type", "input") and v not in (None, "")}}
        try:
            for key in ("window", "every"):
                if key in cfg and not abs(TE.duration_ms(cfg[key])):
                    raise E.ContourError(f"{kind}: the {key} must be longer than zero")
            if "by" in cfg:
                TE.duration_ms(cfg["by"])
            if "period" in cfg:
                TE.period_unit(cfg["period"])
        except TE.EngineError as e:
            raise E.ContourError(f"{kind}: {e}") from None
        if "aggregation" in cfg:
            how = str(cfg["aggregation"]).lower()
            how = "mean" if how in ("avg", "average") else how
            if how not in TE.AGGREGATES:
                raise E.ContourError(f"{kind}: unknown aggregation {cfg['aggregation']} ({', '.join(TE.AGGREGATES)})")
            cfg["aggregation"] = how
        if kind == "dsp" and cfg["filter"] not in ("moving_average", "ema", "lowpass", "highpass"):
            raise E.ContourError("dsp: filter is moving_average, ema, lowpass or highpass")
        out.append({"type": kind, **cfg})
    return out


def column_name(col: dict) -> str:
    name = str(col.get("name") or "").strip()
    if name:
        return name
    parts = [_slug(col.get("property") or "series")]
    for tr in transforms(col):
        parts.append(_slug("_".join([tr["type"], *(str(tr[k]) for k in _NAME_KEYS.get(tr["type"], ()))])))
    return "_".join([*parts, _op(col)])


def logic_of(prop: str, trs: list[dict]) -> dict:
    """ts_engine logic: the row object's series (card S) through the transforms (T1, T2, ...); the last is the output."""
    cards = [{"id": "S", "type": "tsp", "config": {"property": prop}}]
    for i, tr in enumerate(trs, 1):
        cfg = {k: v for k, v in tr.items() if k != "type"}
        cards.append({"id": f"T{i}", "type": tr["type"], "config": {**cfg, "input": cards[-1]["id"]}})
    return {"cards": cards, "output": cards[-1]["id"]}


def resolve_range(a: dict, spec: Any) -> Range:
    """A column's range as (start ms, end ms); None on a side means unbounded."""
    try:
        if spec in (None, "", "analysis"):
            spec = a.get("range") or {}
        if spec == "full":
            return None, None
        if not isinstance(spec, dict):
            raise E.ContourError(f"unknown range {spec!r}: analysis, full, {{start, end}} or {{last}}")
        if spec.get("last"):
            end = int(datetime.now(timezone.utc).timestamp() * 1000)
            return end - abs(TE.duration_ms(spec["last"])), end
        return TE.to_ms(spec.get("start")), TE.to_ms(spec.get("end"))
    except TE.EngineError as e:
        raise E.ContourError(str(e)) from None


def sparkline(s: TE.Series, points: int) -> str:
    pts, _ = TE.bucket(s, max(2, min(int(points or DEFAULT_POINTS), MAX_POINTS)))
    return json.dumps([[TE.to_ms(p["t"]), p["value"]] for p in pts], separators=(",", ":"))


def compute(s: TE.Series, op: str, col: dict) -> Any:
    if op in AGG_OPS:
        return TE.aggregate(s.v, op)
    if op == "start":
        return s.t[0] if s.t else None
    if op == "end":
        return s.t[-1] if s.t else None
    if op == "sparkline":
        return sparkline(s, col.get("points") or DEFAULT_POINTS) if s.t else None
    if op == "unit":
        return s.unit
    return TE.value_at(s, col["_at"])


def _array(op: str, vals: list[Any]) -> pa.Array:
    if op in ("start", "end"):
        return pa.array(vals, pa.timestamp("ms"))
    if op in ("sparkline", "unit"):
        return pa.array(vals, pa.string())
    if op == "count":
        return pa.array(vals, pa.int64())
    if all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) for v in vals):
        return pa.array([None if v is None else float(v) for v in vals], pa.float64())
    return pa.array([None if v is None else str(v) for v in vals], pa.string())


def add_columns(a: dict, set_card: dict, table: pa.Table, columns: list[dict]) -> tuple[pa.Table, dict]:
    """`table` (the object set card's rows, with primary_key) plus the time series columns; and what the result
    reports: {columns: {name: {property, op, kind, unit}}, reads, points_scanned, errors}."""
    import timeseries
    import ts_ontology

    type_id = set_card.get("object_type_id")
    resolver = ts_ontology.Resolver()
    try:
        t = resolver.type(str(type_id))
    except TE.EngineError as e:
        raise E.ContourError(str(e)) from None
    cfg = ts_ontology._ts_cfg(t)
    specs = []
    names = set(table.schema.names)
    for raw in columns:
        col = dict(raw)
        prop = str(col.get("property") or cfg.get("default_property") or "").strip()
        if not prop:
            raise E.ContourError(f"{t['display_name']} has no time series property: choose the series of the column")
        if not prop.startswith("sensor:"):
            p = ts_ontology._prop(t, prop)
            if not p or p["type"] != "timeseries" or prop not in cfg["properties"]:
                raise E.ContourError(f"{prop} is not a time series property of {t['display_name']}")
        col["property"] = prop
        col["_transforms"] = transforms(col)
        col["_key"] = json.dumps(col["_transforms"], sort_keys=True, default=str)
        op = _op(col)
        name = column_name(col)
        if name in names:
            raise E.ContourError(f"the table already has a column {name}: name the time series column differently")
        names.add(name)
        if op == "value_at":
            try:
                col["_at"] = TE.to_ms(col.get("at"))
            except TE.EngineError as e:
                raise E.ContourError(f"{name}: {e}") from None
            if col["_at"] is None:
                raise E.ContourError(f"{name}: value at time needs a time")
            rng: Range = (None, None)  # interpolation needs the points around the time, whatever the view range
        else:
            rng = resolve_range(a, col.get("range"))
        specs.append((name, op, col, rng))
    pks = [str(x) for x in table.column("primary_key").to_pylist()] if "primary_key" in table.schema.names else []
    if specs and "primary_key" not in table.schema.names:
        raise E.ContourError("time series columns need the object set's primary_key column (keep it in the input table)")
    reads = len({(c["property"], c["_key"], rng) for _n, _o, c, rng in specs}) * len(pks)
    if reads > MAX_READS:
        raise E.ContourError(f"{len(pks):,} rows × {reads // max(len(pks), 1)} series = {reads:,} time series reads — a transform table reads at most "
                             f"{MAX_READS:,}; filter the object set (or use fewer series / ranges)")
    cache: dict[tuple, Any] = {}
    errors: list[str] = []
    failed = 0
    scanned = 0
    out: dict[str, list[Any]] = {name: [] for name, *_ in specs}
    units: dict[str, Optional[str]] = {}
    for pk in pks:
        for name, op, col, rng in specs:
            key = (pk, col["property"], col["_key"], rng)
            if key not in cache:
                obj = {"object_type_id": t["id"], "primary_key": pk}
                try:
                    if col["_transforms"]:
                        # the derived series (ts_engine reads the raw series with the windows' margins, then clips)
                        cache[key], n = TE.evaluate_series(logic_of(col["property"], col["_transforms"]), resolver, obj, rng[0], rng[1])
                        scanned += n
                    else:
                        cache[key] = resolver.tsp(obj, col["property"], rng, 0)
                        scanned += len(cache[key])
                except TE.EngineError as e:
                    cache[key] = None
                    failed += 1
                    if len(errors) < 5:
                        errors.append(f"{pk} · {col['property']}: {e}")
            s = cache[key]
            if s is not None and s.unit and not units.get(name):
                units[name] = s.unit
            out[name].append(None if s is None else compute(s, op, col))
    scanned += resolver.extra_scanned
    if cache and a.get("id"):
        timeseries.record_usage(f"quiver:{a['id']}", scanned, queries=len(cache))
    for name, op, _col, _rng in specs:
        table = table.append_column(name, _array(op, out[name]))
    kinds = {"sparkline": "sparkline", "start": "time", "end": "time", "count": "number", "unit": "text"}
    info = {"columns": {name: {"property": col["property"], "op": op, "kind": kinds.get(op, "value"), "unit": units.get(name),
                               "range": [TE.iso(rng[0]), TE.iso(rng[1])], "transforms": col["_transforms"]} for name, op, col, rng in specs},
            "reads": len(cache), "failed": failed, "points_scanned": scanned, "errors": errors}
    return table, info
