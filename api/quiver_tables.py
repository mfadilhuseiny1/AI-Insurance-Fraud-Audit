"""Quiver table cards (Analytics doc 05): transform tables, charts, value cards and Vega plot data over object sets,
datasets and manual values, compiled onto the Contour engine (contour_engine.py: SQL CTEs on DuckDB).

The cards live in a Quiver analysis' `object_sets` list next to the object set and function cards, told apart by
`kind`:
- table: {source: {kind: object_set|dataset|table|values, card|id|columns+rows}, columns?, steps: [Contour transform
  boards: filter, expression (columns, filters, group by), edit_columns, sort, join, enrich, set_math, transform_data,
  unpivot, dedupe]} — at most 50,000 rows. Over an object set (or a table whose input leads to one and keeps
  its primary_key column), series_columns: [{name?, property, op, range?, at?,
  points?, transforms?}] adds columns computed from each row's time series before the steps (quiver_series.py:
  aggregates, value at a time, first / last timestamp, unit, sparkline points, over the series or over it after
  transforms such as a rolling aggregate).
- chart: {source: {card}, chart: bar|line|pie|scatter|histogram|distribution|time_series|heatmap|pivot, config}.
- value: {source: {card}, expr} — one value (numeric, string, date or boolean) from an aggregate expression.
- grouped_plot: {source: {card}, column?, label?, page_size?, page?, aggregate?} — a transform table's sparkline time
  series column as one line per row (a page of rows), with an optional linear aggregation (mean, sum, min, max,
  count, median, std, range) across all rows' series.
- vega: {spec} — the client resolves $T / $T.column against the tables' rows returned here.
- cross_filter: {source: {card}, subscribed: [chart IDs], selections: {chart ID: [keys]}} — the input filtered by every
  subscribed chart's selection; each subscribed chart reads the input filtered by the other charts' selections, so the
  charts filter each other.
- single cards (quiver_cards.py): numeric_agg, column_values, numeric_formula, round, date_diff, date_part,
  string_op, comparison, boolean_formula, create_array, stepped_array, array_op, coalesce, range, range_op,
  correlation, waterfall; the selector parameters string_selector, property_select, object_selector, row_selector;
  date_convert, period_to_date, object_property, multipass_attribute, xy_range; the time series cards series_agg,
  series_op, regression, series_distribution, series_scatter (over a time series card of the logic) and
  shift_datetime; the object set cards filter_object_set, set_math, linked_object_set, status_filter, object_view,
  defined_by_property, saved_object_set —
  values computed on demand, so a formula reads the cards it references whatever their order. An object selector is
  also an object set (its selected objects) other cards read as their input; the selectors' values are parameters of
  the tables' expressions and filters. A dashboard viewer's selections apply to their view only
  (POST /dashboards/{item_id}/run).
Object set cards keep their own filters and search text; parameter cards of the time series logic ($A …) are
parameters of every expression. GET /saved-object-sets lists the saved object sets an "Import saved object set" card
picks from (Object Explorer explorations, object lists); POST /{aid}/cards/{cid}/object-list saves an object set card's
objects as an object list another analysis imports.

Mounted by server.py under /api/quiver-tables.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import contour_engine as E
import quiver_cards

router = APIRouter(prefix="/api/quiver-tables")
MAX_ROWS = 50_000
SHOW_ROWS = 500
# objects an object set card carries when embedded (a report widget, a Notepad widget) and in their Markdown / DOCX
# exports: pages of 50 on screen, every one printed; the card's CSV export has every object
EMBED_OBJECTS = 1000
CHARTS = {"bar": ("chart", "bar"), "line": ("chart", "line"), "pie": ("chart", "pie"), "scatter": ("chart", "scatter"), "histogram": ("histogram", None),
          "distribution": ("distribution", None), "time_series": ("time_series", None), "heatmap": ("heatmap", None), "pivot": ("pivot", None)}
TABLE_KINDS = ("table", "chart", "value", "vega", "cross_filter", "action", "grouped_plot", *quiver_cards.KINDS)
# object set card filter ops (lib/ontologyModel.ts FILTER_OPS) → Contour filter conditions
OPS = {"eq": ("is", False), "neq": ("is", True), "contains": ("contains", False), "starts_with": ("is_wild", False), "gt": ("gt", False),
       "gte": ("gte", False), "lt": ("lt", False), "lte": ("lte", False), "between": ("between", False), "is_null": ("is_null", False),
       "not_null": ("not_null", False), "wildcard": ("is_wild", False), "regex": ("matches", False), "in": ("is", False)}


def type_rows(type_id: str) -> tuple[dict, list[dict]]:
    """An object type and the objects of it the viewer may see (ontology._public_object rows: primary_key, title,
    properties)."""
    import ontology

    with ontology._lock:
        t = ontology._object_type(type_id)
        return t, [ontology._public_object(t, pk, o) for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(t, o)]


def rows_table(t: dict, rows: list[dict]) -> pa.Table:
    """Objects as an object set card's table: primary_key, then a column per property."""
    if len(rows) > MAX_ROWS:
        raise E.ContourError(f"{t['display_name']}: {len(rows):,} objects — a transform table takes at most 50,000; filter the object set")
    cols = ["primary_key"] + [p["api_name"] for p in t["properties"] if p["api_name"] != "primary_key"]
    if not rows:
        return pa.table({c: pa.array([], pa.string()) for c in cols})
    # a column per property, typed: array properties stay arrays (Arrow lists), struct properties structs — the web
    # gets them as JSON arrays / objects and shows them as "a, b" (display_text / the web's cellText)
    out = {"primary_key": pa.array([r["primary_key"] for r in rows], pa.string())}
    for c in cols[1:]:
        out[c] = _column([_plain(r["properties"].get(c)) for r in rows])
    return pa.table(out)


def _column(vals: list) -> pa.Array:
    """One property's values as an Arrow column: as they are when they type (numbers, text, Booleans, arrays,
    structs); an array whose elements do not share a type holds them as text; anything else that does not type
    (mixed scalars, mixed arrays and scalars) is text, arrays and structs written as JSON."""
    try:
        arr = pa.array(vals)
        if pa.types.is_list(arr.type) and pa.types.is_null(arr.type.value_type):
            arr = arr.cast(pa.list_(pa.string()))  # only empty arrays: arrays of text
        if not (pa.types.is_struct(arr.type) and arr.type.num_fields == 0):
            return arr
    except (pa.ArrowInvalid, pa.ArrowTypeError, pa.ArrowNotImplementedError, OverflowError):
        pass
    if all(v is None or isinstance(v, list) for v in vals):
        try:
            return pa.array([None if v is None else [None if x is None else _element_text(x) for x in v] for v in vals], pa.list_(pa.string()))
        except (pa.ArrowInvalid, pa.ArrowTypeError):
            pass
    return pa.array([None if v is None else _element_text(v) for v in vals], pa.string())


def _element_text(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False, default=str)
    return display_text(v)


def display_text(v: Any) -> str:
    """A cell as people read it (Markdown, DOCX and PowerPoint exports; the web shows the same): an array as its
    elements joined by ", ", a struct as "field: value, …", true / false, integral numbers without ".0"; an array or
    struct inside one is JSON."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() and abs(v) < 1e16 else repr(v)
    if isinstance(v, list):
        return ", ".join(_inner_text(x) for x in v)
    if isinstance(v, dict):
        return ", ".join(f"{k}: {_inner_text(x)}" for k, x in v.items())
    return str(v)


def _inner_text(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (list, dict)) else display_text(v)


def csv_value(v: Any) -> Any:
    """A CSV cell: arrays and structs as JSON (machine-readable, unambiguous when an element holds a comma), None empty."""
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False, default=str)
    return v


def _object_set_rows(card: dict) -> pa.Table:
    """An object set card's objects (search text applied, with the viewer's permissions) with a primary_key column."""
    t, rows = type_rows(card["object_type_id"])
    if card.get("only") is not None:
        # a dashboard opened for one object (an Object View tab): the set is that object
        keep = {str(x) for x in card["only"]}
        rows = [r for r in rows if r["primary_key"] in keep]
    needle = (card.get("query") or "").strip().lower()
    if needle:
        rows = [r for r in rows if needle in r["title"].lower() or needle in r["primary_key"].lower() or any(needle in str(v).lower() for v in r["properties"].values())]
    return rows_table(t, rows)


def _iso(ms: int) -> Optional[str]:
    import ts_engine as TE

    return TE.iso(ms)


def _plain(v: Any) -> Any:
    """A property value as plain JSON-like data (arrays and structs kept, anything else not a scalar as text)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    return str(v)


def _series_table(a: dict, cid: str) -> pa.Table:
    """A time series card (or a search / event set card) of the analysis' logic as a table: timestamp and value (or
    start, end, title), evaluated for the analysis' root object over its range."""
    from datetime import datetime, timezone

    import ts_engine as TE
    import ts_ontology

    logic = a.get("logic") or {}
    if not any(c.get("id") == cid for c in logic.get("cards") or []):
        raise E.ContourError(f"no time series card ${cid}")
    rng = a.get("range") or {}
    if rng.get("last"):
        end = int(datetime.now(timezone.utc).timestamp() * 1000)
        start = end - TE.duration_ms(rng["last"])
    else:
        start, end = TE.to_ms(rng.get("start")), TE.to_ms(rng.get("end"))
    try:
        res = TE.run(logic, ts_ontology.Resolver(), a.get("root"), start, end, cards=[cid], buckets=ts_ontology.RAW_POINTS)
    except TE.EngineError as e:
        raise E.ContourError(str(e)) from None
    card = res["cards"][cid]
    if card["kind"] == "error":
        raise E.ContourError(card["error"])
    if card["kind"] == "intervals":
        items = card["intervals"]
        return pa.table({"start": pa.array([(i["start"] or "").replace("Z", "") or None for i in items], pa.string()).cast(pa.timestamp("ms")),
                         "end": pa.array([(i["end"] or "").replace("Z", "") or None for i in items], pa.string()).cast(pa.timestamp("ms")),
                         "title": pa.array([i.get("title") or "" for i in items], pa.string())})
    if card["kind"] != "series":
        raise E.ContourError(f"${cid} is not a time series")
    pts = card["points"]
    vals = [p.get("value") for p in pts]
    numeric = all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) for v in vals)
    return pa.table({"timestamp": pa.array([p["t"].replace("Z", "") for p in pts], pa.string()).cast(pa.timestamp("ms")),
                     "value": pa.array(vals, pa.float64() if numeric else pa.string())})


def _values_table(src: dict) -> pa.Table:
    cols = [str(c) for c in src.get("columns") or []]
    if not cols:
        raise E.ContourError("a manual table needs columns")
    rows = [dict(zip(cols, r)) for r in src.get("rows") or []]
    return pa.Table.from_pylist(rows) if rows else pa.table({c: pa.array([], pa.string()) for c in cols})


def _filters_board(card: dict) -> Optional[dict]:
    conds = []
    for f in card.get("filters") or []:
        if not f.get("property") or f.get("op") not in OPS:
            continue
        op, negate = OPS[f["op"]]
        v = f.get("value")
        if f["op"] == "starts_with":
            v = f"{v}*"
        if f["op"] == "between":
            vals = v if isinstance(v, list) else [x.strip() for x in str(v or "").split(",")]
            conds.append({"column": f["property"], "op": op, "values": vals[:2]})
            continue
        vals = v if isinstance(v, list) else ([] if v in (None, "") else [v])
        conds.append({"column": f["property"], "op": op, "values": vals, "negate": negate})
    return {"id": "f", "type": "filter", "config": {"conditions": conds}} if conds else None


def _chart_column(chart: dict) -> Optional[str]:
    cfg = chart.get("config") or {}
    return cfg.get("x") or cfg.get("column") or cfg.get("date_column") or ((cfg.get("rows") or [None])[0])


def _selection_boards(xf: dict, cards: dict, charts: list[str]) -> list[dict]:
    out = []
    for ch in charts:
        sel = [v for v in ((xf.get("selections") or {}).get(ch) or [])]
        col = _chart_column(cards[ch])
        if sel and col:
            out.append({"id": f"sel_{ch}", "type": "filter", "config": {"conditions": [
                {"column": col, "op": "is", "values": [v for v in sel if v is not None]}] if any(v is not None for v in sel) else [{"column": col, "op": "is_null"}]}})
    return out


def _root_object_set(cards: dict[str, dict], cid: str) -> Optional[dict]:
    """The object set card a table's rows come from, following input tables (a table over a table over an object set
    keeps the object set's objects); None for a dataset, manual values or time series input."""
    seen = {cid}
    sid = ((cards.get(cid) or {}).get("source") or {}).get("card")
    while sid and sid in cards and sid not in seen:
        seen.add(sid)
        c = cards[sid]
        if c.get("kind") in (None, "object_set"):
            return c if c.get("object_type_id") else None
        if c.get("kind") in quiver_cards.OBJECT_SET_KINDS:
            # a filter / set math / linked object set … card: its objects are of one type
            try:
                tid = quiver_cards.object_type_of(cards, sid)
            except E.ContourError:
                return None
            return {"id": sid, "object_type_id": tid} if tid else None
        src = c.get("source") or {}
        if c.get("kind") not in ("table", "cross_filter", "object_selector") or src.get("kind") in ("dataset", "values", "series"):
            return None
        sid = src.get("card")
    return None


def _input_tables(cards: dict[str, dict], cid: str) -> list[str]:
    """The table / cross filter cards upstream of a table, nearest first."""
    out: list[str] = []
    sid = ((cards.get(cid) or {}).get("source") or {}).get("card")
    while sid and sid in cards and sid not in out and sid != cid and cards[sid].get("kind") in ("table", "cross_filter", "object_selector"):
        out.append(sid)
        sid = (cards[sid].get("source") or {}).get("card")
    return out


GROUPED_AGGREGATES = ("mean", "sum", "min", "max", "count", "median", "std", "range")
MAX_GROUPED_PAGE = 50
MAX_GROUPED_AGGREGATE = 2_000


def _grouped_plot(comp: E.Compiler, cards: dict[str, dict], c: dict, export: bool = False) -> dict:
    """A grouped time series plot: a transform table's sparkline column as one line per row, a page of rows at a time,
    optionally with a linear aggregation across every row's series (the series joined on the union of their
    timestamps with linear interpolation; timestamps outside a series' extent are left out, so the aggregate covers
    where all series overlap). export: every row's line, not a page (the CSV export)."""
    import json

    import ts_engine as TE

    src = (c.get("source") or {}).get("card")
    if not src or src not in cards:
        raise E.ContourError("choose the transform table to plot")
    if cards[src].get("kind") != "table":
        raise E.ContourError("a grouped time series plot reads a transform table's time series column")
    rel = comp.path_rel(src, None)
    cols = comp.columns(rel)
    info: dict[str, dict] = {}
    for up in reversed([src, *_input_tables(cards, src)]):
        info.update((comp.series_info.get(up) or {}).get("columns") or {})
    sparks = [k for k, v in info.items() if v.get("kind") == "sparkline" and k in cols]
    column = c.get("column") or (sparks[0] if sparks else None)
    if not column:
        raise E.ContourError(f"${src} has no time series column to plot: add one with the Sparkline operation")
    if column not in sparks:
        raise E.ContourError(f"{column} is not a sparkline time series column of ${src}")
    label = c.get("label") if c.get("label") in cols else ("primary_key" if "primary_key" in cols else None)
    size = max(1, min(int(c.get("page_size") or 10), MAX_GROUPED_PAGE))
    total = comp.count(rel)
    pages = max(1, -(-total // size))
    page = max(0, min(int(c.get("page") or 0), pages - 1))
    how = c.get("aggregate") or None
    if how and how not in GROUPED_AGGREGATES:
        raise E.ContourError(f"unknown linear aggregation {how} ({', '.join(GROUPED_AGGREGATES)})")
    if how and total > MAX_GROUPED_AGGREGATE:
        raise E.ContourError(f"{total:,} rows — a linear aggregation joins at most {MAX_GROUPED_AGGREGATE:,} series; filter the table")
    lab = f"CAST({E.q(label)} AS VARCHAR)" if label else "NULL"
    sql = f"SELECT {lab} AS label, {E.q(column)} AS pts FROM {rel}"
    rows = E.rows_of(comp.run(sql) if how or export else comp.run(f"SELECT * FROM ({sql}) LIMIT {size} OFFSET {page * size}"))

    def points(cell: Any) -> list[list]:
        try:
            pts = json.loads(cell) if isinstance(cell, str) else []
        except ValueError:
            return []
        return [[int(p[0]), float(p[1])] for p in pts if isinstance(p, list) and len(p) == 2 and isinstance(p[1], (int, float)) and not isinstance(p[1], bool)]

    every = [{"label": r["label"] if r["label"] is not None else f"row {i + 1}", "points": points(r["pts"])} for i, r in enumerate(rows)]
    shown = every if export else every[page * size:(page + 1) * size] if how else every
    out: dict[str, Any] = {"lines": shown, "total": total, "page": page, "pages": pages, "page_size": size, "column": column,
                           "label_column": label, "unit": info[column].get("unit"), "sparkline_columns": sparks, "input_columns": cols}
    if how:
        series = [TE.Series([p[0] for p in s["points"]], [p[1] for p in s["points"]]) for s in every if s["points"]]
        ts, vals = TE.join(series)
        out["aggregate"] = {"how": how, "series": len(series),
                            "points": [[t, TE.aggregate([col[i] for col in vals], how)] for i, t in enumerate(ts)]}
    return out


def compile_analysis(a: dict) -> tuple[E.Compiler, dict[str, dict]]:
    """The analysis' table cards as a Contour analysis: one path per object set, table and dataset source."""
    cards = {c["id"]: c for c in a.get("object_sets") or [] if c.get("id")}
    paths: list[dict] = []
    for c in cards.values():
        if c.get("kind") in (None, "object_set") and c.get("object_type_id"):
            f = _filters_board(c)
            paths.append({"id": c["id"], "name": c.get("title") or c["id"], "source": {"kind": "object_set", "id": c["id"]}, "boards": [f] if f else []})
        elif c.get("kind") == "table":
            src = c.get("source") or {}
            if src.get("kind") in ("dataset", "restricted_view"):
                source = {"kind": src["kind"], "id": src.get("id")}
            elif src.get("kind") == "values":
                source = {"kind": "values", "id": c["id"]}
            elif src.get("kind") == "series":
                source = {"kind": "series", "id": c["id"]}
            elif c.get("series_columns") and src.get("kind") != "dataset":
                # time series columns (quiver_series.py): the object set's rows plus a column per series operation
                source = {"kind": "object_series", "id": c["id"]}
            else:
                source = {"kind": "path", "id": src.get("card")}
            steps = [s for s in c.get("steps") or [] if s.get("type") in E.TRANSFORMS]
            if c.get("columns"):
                steps = steps + [{"id": "__cols", "type": "edit_columns", "config": {"keep": c["columns"]}}]
            paths.append({"id": c["id"], "name": c.get("title") or c["id"], "source": source, "boards": steps})
        elif c.get("kind") == "cross_filter":
            subs = [x for x in c.get("subscribed") or [] if x in cards]
            src = {"kind": "path", "id": (c.get("source") or {}).get("card")}
            paths.append({"id": c["id"], "name": c.get("title") or c["id"], "source": src, "boards": _selection_boards(c, cards, subs)})
            for ch in subs:
                # what chart `ch` shows: the input filtered by the other charts' selections
                paths.append({"id": f"{c['id']}__minus__{ch}", "name": c["id"], "source": src, "boards": _selection_boards(c, cards, [x for x in subs if x != ch])})
        elif c.get("kind") == "object_selector":
            # an object set itself: the input's objects whose primary key is selected (none selected: no objects)
            try:
                keys = [str(quiver_cards._text(x)) for x in quiver_cards.selection(c)]
            except E.ContourError:
                keys = []  # the card's own result says what is wrong with the selection
            cond = {"column": "primary_key", "op": "is", "values": keys} if keys else {"column": "primary_key", "op": "is_null"}
            paths.append({"id": c["id"], "name": c.get("title") or c["id"], "source": {"kind": "path", "id": (c.get("source") or {}).get("card")},
                          "boards": [{"id": "sel", "type": "filter", "config": {"conditions": [cond]}}]})
        elif c.get("kind") in quiver_cards.OBJECT_SET_KINDS:
            # filter object set, set math, linked object set, status filter, object view: objects computed when read
            # (quiver_cards.object_set_table), as an object set card's table
            paths.append({"id": c["id"], "name": c.get("title") or c["id"], "source": {"kind": "object_card", "id": c["id"]}, "boards": []})
    params = {}
    ranges: dict[str, dict] = {}
    for p in (a.get("logic") or {}).get("cards") or []:
        if p.get("type") == "param_range":
            # a date / time range parameter: {start, end}, read by the range cards (not an SQL parameter)
            cfg = p.get("config") or {}
            v = cfg["value"] if isinstance(cfg.get("value"), dict) else cfg
            ranges[p["id"]] = {"start": v.get("start") or None, "end": v.get("end") or None}
        elif str(p.get("type", "")).startswith("param_") and "value" in (p.get("config") or {}):
            params[p["id"]] = p["config"]["value"]
    for c in cards.values():
        # a selector's selection is a parameter of the tables' expressions and filters ($SS1); several values: a list
        if c.get("kind") in quiver_cards.PARAM_SELECTOR_KINDS and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(c["id"])) and c["id"] not in params:
            try:
                sel = quiver_cards.selection(c)
            except E.ContourError:
                sel = []
            params[c["id"]] = sel if c.get("multiple") else (sel[0] if sel else None)
    analysis = {"paths": paths, "parameters": [{"name": k} for k in params]}
    values = E.param_values(analysis["parameters"], params)
    series_info: dict[str, dict] = {}

    def load(src: dict) -> pa.Table:
        import contour

        if src["kind"] == "object_set":
            return _object_set_rows(cards[src["id"]])
        if src["kind"] == "object_card":
            return quiver_cards.object_set_table(comp, cards, cards[src["id"]])
        if src["kind"] == "object_series":
            import quiver_series

            card = cards[src["id"]]
            sid = (card.get("source") or {}).get("card")
            base = cards.get(sid) or {}
            if not sid or sid not in cards:
                raise E.ContourError(f"__missing__{sid}")
            root = _root_object_set(cards, src["id"])
            if root is None:
                raise E.ContourError("time series columns need an object set card as the table's input, or a table whose input "
                                     "leads to one (its rows keeping the primary_key column)")
            # the input's rows (the object set card's filters, or the input table's steps, applied), then the series
            # columns; an input table is computed without this card, so a loop back to it reads as a missing card
            sub = E.Compiler({"paths": [p for p in paths if p["id"] != src["id"]], "parameters": analysis["parameters"]}, values, load)
            sub.series_info = series_info
            rel = sub.path_rel(sid, None)
            if base.get("kind") == "table":
                n = sub.count(rel)
                if n > MAX_ROWS:
                    raise E.ContourError(f"${sid}: {n:,} rows — a transform table holds at most 50,000")
            rows = sub.run(f"SELECT * FROM {rel}")
            t, series_info[src["id"]] = quiver_series.add_columns(a, root, rows, card["series_columns"])
            return t
        if src["kind"] == "values":
            return _values_table(cards[src["id"]].get("source") or {})
        if src["kind"] == "series":
            return _series_table(a, str((cards[src["id"]].get("source") or {}).get("card") or ""))
        return contour._load_source(src)

    for p in paths:
        if p["source"]["kind"] == "path" and p["source"]["id"] not in {x["id"] for x in paths}:
            p["source"] = {"kind": "path", "id": "__missing__" + str(p["source"]["id"])}
    comp = E.Compiler(analysis, values, load)
    comp.series_info = series_info  # per table card with time series columns, filled when its source loads
    comp.range_params = ranges
    comp.analysis = a  # the time series single cards read the logic's series for the root object over the range
    # the value cards an object set card's conditions read ($N1 …): run_cards puts its own reader here; outside a run
    # (a CSV export) a card is computed on its own
    depth = [0]

    def value_alone(ref: str) -> dict:
        if depth[0] > 8:
            raise E.ContourError(f"${ref}: the cards read each other in a loop")
        depth[0] += 1
        try:
            return run_cards(a, {ref}).get(ref) or {"error": f"${ref} is not a value card"}
        finally:
            depth[0] -= 1

    comp.value_of = value_alone
    return comp, cards


def run_cards(a: dict, only: Optional[set[str]] = None, object_rows: Optional[int] = None) -> dict[str, dict]:
    """The cards' results; `object_rows`: how many objects an object set card's result carries (default 50)."""
    comp, cards = compile_analysis(a)
    comp.object_rows = object_rows
    out: dict[str, dict] = {}
    busy: list[str] = []

    def value_of(ref: str) -> dict:
        # another card's result, computed now when not yet (a formula reads the cards it references)
        if ref not in out:
            if ref in busy:
                raise E.ContourError(f"${ref} depends on itself: {' → '.join('$' + x for x in busy[busy.index(ref):] + [ref])}")
            if cards.get(ref, {}).get("kind") not in TABLE_KINDS:
                return {"error": f"${ref} is not a value card"}
            one(ref)
        return out[ref]

    comp.value_of = value_of

    def one(cid: str) -> None:
        c = cards[cid]
        busy.append(cid)
        try:
            if c["kind"] in quiver_cards.KINDS:
                out[cid] = quiver_cards.run_card(comp, cards, c, value_of)
                return
            if c["kind"] == "action":
                # an Action button: parameter defaults are constants or a value card's result ("$V1")
                refs = {str(v)[1:] for v in (c.get("defaults") or {}).values() if isinstance(v, str) and v.startswith("$") and str(v)[1:] in cards}
                vals = {k: value_of(k) for k in refs}
                defaults = {}
                for pid, v in (c.get("defaults") or {}).items():
                    if isinstance(v, str) and v.startswith("$") and v[1:] in cards:
                        ref = vals.get(v[1:]) or {}
                        if ref.get("error"):
                            raise E.ContourError(f"{v}: {ref['error']}")
                        v = ref.get("value")
                    defaults[pid] = v
                out[cid] = {"defaults": defaults}
                return
            if c["kind"] == "table":
                rel = comp.path_rel(cid, None)
                n = comp.count(rel)
                if n > MAX_ROWS:
                    raise E.ContourError(f"{n:,} rows — a transform table holds at most 50,000")
                t = comp.run(f"SELECT * FROM {rel}", SHOW_ROWS if c.get("show_rows") is None else int(c["show_rows"]))
                steps = len(comp.paths[cid].get("boards") or [])
                # the columns going into each step (the editor's column pickers), then the result's
                out[cid] = {"columns": list(t.schema.names), "rows": E.rows_of(t), "total": n,
                            "step_columns": [comp.columns(comp.path_rel(cid, k)) for k in range(steps + 1)]}
                info = comp.series_info.get(cid)
                # time series columns passed through from input tables (a table over a table) keep their cell kinds
                inherited: dict[str, dict] = {}
                for up in reversed(_input_tables(cards, cid)):
                    inherited.update((comp.series_info.get(up) or {}).get("columns") or {})
                if info or inherited:
                    # which result columns are time series columns (sparklines are JSON text [[epoch ms, value], …])
                    cols = {**inherited, **((info or {}).get("columns") or {})}
                    out[cid]["series_columns"] = {k: v for k, v in cols.items() if k in out[cid]["columns"]}
                if info:
                    out[cid]["series"] = {k: info[k] for k in ("reads", "failed", "points_scanned", "errors")}
            elif c["kind"] == "cross_filter":
                rel = comp.path_rel(cid, None)
                t = comp.run(f"SELECT * FROM {rel}", SHOW_ROWS)
                out[cid] = {"columns": list(t.schema.names), "rows": E.rows_of(t), "total": comp.count(rel),
                            "selections": {k: v for k, v in (c.get("selections") or {}).items() if v}}
            elif c["kind"] == "grouped_plot":
                out[cid] = _grouped_plot(comp, cards, c)
            elif c["kind"] == "vega":
                for ref in c.get("tables") or []:
                    if ref in cards and ref not in out:
                        rel = comp.path_rel(ref, None)
                        t = comp.run(f"SELECT * FROM {rel}", 5000)
                        out[ref] = {"columns": list(t.schema.names), "rows": E.rows_of(t), "total": comp.count(rel)}
                out[cid] = {"ok": True}
            else:
                src = (c.get("source") or {}).get("card")
                if not src or src not in cards:
                    raise E.ContourError("choose the card to read from")
                xf = cards[src]
                if xf.get("kind") == "cross_filter" and cid in (xf.get("subscribed") or []):
                    rel = comp.path_rel(f"{src}__minus__{cid}", None)
                else:
                    rel = comp.path_rel(src, None)
                if c["kind"] == "chart":
                    btype, kind = CHARTS.get(c.get("chart") or "bar", ("chart", "bar"))
                    cfg = dict(c.get("config") or {})
                    if kind:
                        cfg["kind"] = kind
                    t = comp.run(E.visual_sql({"type": btype, "config": cfg}, rel, comp.params), 5000)
                    out[cid] = {"data": E.rows_of(t), "data_columns": list(t.schema.names), "board": {"type": btype, "config": cfg}, "input_columns": comp.columns(rel)}
                    if xf.get("kind") == "cross_filter" and cid in (xf.get("subscribed") or []):
                        out[cid]["cross_filter"] = src
                        out[cid]["selection"] = (xf.get("selections") or {}).get(cid) or []
                else:
                    t = comp.run(f"SELECT {E.subst(c.get('expr') or 'COUNT(*)', comp.params)} AS value FROM {rel}", 1)
                    v = E.rows_of(t)
                    out[cid] = {"value": v[0]["value"] if v else None, "input_columns": comp.columns(rel)}
        except E.ContourError as e:
            msg = str(e)
            out[cid] = {"error": "the source card no longer exists" if "__missing__" in msg else msg}
        finally:
            busy.pop()

    for cid, c in cards.items():
        if c.get("kind") in TABLE_KINDS and (only is None or cid in only) and cid not in out:
            one(cid)
    return out


class RunIn(BaseModel):
    # unsaved cards (the editor's draft); default: the saved analysis
    object_sets: Optional[list[dict]] = None
    logic: Optional[dict] = None
    cards: Optional[list[str]] = None
    # the draft's time range (time series columns default to it)
    range: Optional[dict] = None
    # the draft's root object ({object_type_id, primary_key}): the time series cards read its series
    root: Optional[dict] = None


@router.post("/{aid}/run")
def run(aid: str, req: RunIn) -> dict:
    """The table cards' results: tables (500 rows shown), chart data, values; Vega plots get their tables' rows."""
    import ts_derived

    a = dict(ts_derived._analysis(aid))
    if req.object_sets is not None:
        a["object_sets"] = req.object_sets
    if req.logic is not None:
        a["logic"] = req.logic
    if req.range is not None:
        a["range"] = req.range
    if req.root is not None:
        if not isinstance(req.root.get("object_type_id"), str) or not isinstance(req.root.get("primary_key"), (str, int)):
            raise HTTPException(400, "root is {object_type_id, primary_key}")
        a["root"] = {"object_type_id": req.root["object_type_id"], "primary_key": str(req.root["primary_key"])}
    return {"cards": run_cards(a, set(req.cards) if req.cards else None)}


def apply_selections(a: dict, selections: dict[str, Any]) -> tuple[dict, dict[str, Any]]:
    """A copy of the analysis with a viewer's selections in its selector cards (other cards and unknown IDs are left
    alone), and the selections that were applied. The analysis itself — the saved defaults — is not changed."""
    import copy

    a = copy.deepcopy(a)
    applied: dict[str, Any] = {}
    for c in a.get("object_sets") or []:
        if c.get("id") in selections and c.get("kind") in quiver_cards.SELECTOR_KINDS:
            c["value"] = selections[c["id"]]
            applied[c["id"]] = c["value"]
    return a, applied


class DashboardRunIn(BaseModel):
    version: Optional[int] = None
    # the dashboard opened for one object (an Object View tab)
    object_type_id: Optional[str] = None
    primary_key: Optional[str] = None
    # the viewer's selections: {selector card ID: value, or a list of values for a multiselect}
    selections: dict[str, Any] = {}


@router.post("/dashboards/{item_id}/run")
def run_dashboard(item_id: str, req: DashboardRunIn) -> dict:
    """A published dashboard's table cards computed with the viewer's selections in its selector parameter cards. The
    selections apply to this answer only: the published version and the analysis keep their saved values."""
    import ontology
    import ts_derived

    if len(req.selections) > 200:
        raise HTTPException(400, "at most 200 selections")
    _, doc = ts_derived._dashboard_item(item_id)
    if not doc["versions"]:
        raise HTTPException(404, "the dashboard has no published version")
    v = next((x for x in doc["versions"] if x["version"] == req.version), None) if req.version else doc["versions"][-1]
    if not v:
        raise HTTPException(404, f"no version {req.version}")
    a = v["analysis"]
    if req.object_type_id and req.primary_key is not None:
        ontology._find(ontology._object_type(req.object_type_id), req.primary_key)
        a, _ = ts_derived._for_object(a, req.object_type_id, req.primary_key)
    a, applied = apply_selections(a, req.selections)
    tables = {x["id"] for x in a.get("object_sets") or [] if x.get("kind") in TABLE_KINDS}
    wanted = {x for x in (a.get("dashboard") or {}).get("cards") or [] if x in tables}
    return {"version": v["version"], "selections": applied, "tables": run_cards(a, wanted) if wanted else {}}


@router.get("/{aid}/cards/{cid}/csv")
def card_csv(aid: str, cid: str):
    """Export a transform table (or a chart's data) as CSV, up to 50,000 rows. A grouped time series plot exports every
    row's series as label, timestamp, value (the linear aggregation as one more label); a correlation matrix, a
    waterfall, a time series distribution or scatter plot its cells / buckets / bins / points; a column values card (or any card whose result is an array) its array."""
    import csv
    import io

    from fastapi.responses import Response

    import ts_derived

    a = ts_derived._analysis(aid)
    comp, cards = compile_analysis(a)
    c = cards.get(cid)
    if not c or c.get("kind") not in ("table", "chart", "grouped_plot", *quiver_cards.CHART_KINDS, *quiver_cards.ARRAY_KINDS, *quiver_cards.OBJECT_SET_KINDS):
        raise HTTPException(404, "no table, chart or plot card with this ID")
    if c["kind"] in quiver_cards.ARRAY_KINDS and c["kind"] != "column_values":
        # create array, split, array sort … : an export when the card's result is an array
        r = run_cards(a, {cid})[cid]
        if r.get("error"):
            raise HTTPException(400, r["error"])
        if r.get("type") != "array":
            raise HTTPException(404, "this card's result is not an array")
        cols = [c.get("title") or "value"]
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        for v in r["value"]:
            w.writerow(["" if v is None else ("true" if v is True else "false" if v is False else csv_value(v))])
        return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{cid}.csv"'})
    try:
        if c["kind"] == "table" or c["kind"] in quiver_cards.OBJECT_SET_KINDS:
            t = comp.run(f"SELECT * FROM {comp.path_rel(cid, None)}", MAX_ROWS)
            rows, cols = E.rows_of(t), list(t.schema.names)
        elif c["kind"] == "grouped_plot":
            g = _grouped_plot(comp, cards, c, export=True)
            label = g.get("label_column") or "label"
            cols = [label, "timestamp", g["column"]]
            rows = [{label: ln["label"], "timestamp": _iso(p[0]), g["column"]: p[1]} for ln in g["lines"] for p in ln["points"]]
            if g.get("aggregate"):
                name = f"{g['aggregate']['how']} of {g['aggregate']['series']} series"
                rows += [{label: name, "timestamp": _iso(p[0]), g["column"]: p[1]} for p in g["aggregate"]["points"]]
        elif c["kind"] == "column_values":
            r = run_cards(a, {cid})[cid]
            if r.get("error"):
                raise E.ContourError(r["error"])
            cols = [c.get("column") or "value"]
            rows = [{cols[0]: v} for v in r["value"]]
        else:
            r = run_cards(a, {cid})[cid]
            if r.get("error"):
                raise E.ContourError(r["error"])
            rows, cols = r["data"], r["data_columns"]
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([csv_value(r[k]) for k in cols])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{cid}.csv"'})


@router.get("/saved-object-sets")
def saved_object_sets() -> list[dict]:
    """The saved object sets the viewer can import ("Import saved object set"): Object Explorer explorations (not of an
    interface) and object lists, newest first, with their RID, name, description, object type and owner."""
    import ontology
    import ontology_explorer as ox

    names: dict[str, str] = {}

    def type_name(tid: Optional[str]) -> Optional[str]:
        if not tid:
            return None
        if tid not in names:
            try:
                with ontology._lock:
                    names[tid] = ontology._object_type(tid)["display_name"]
            except HTTPException:
                names[tid] = tid
        return names[tid]

    out = []
    for e in ox.list_explorations():
        spec = e.get("spec") or {}
        if spec.get("interface_id"):
            continue
        tid = None if spec.get("search_around") else spec.get("object_type_id")
        out.append({"rid": f"{quiver_cards.SET_RID}exploration.{e['id']}", "kind": "exploration", "id": e["id"], "name": e.get("name"),
                    "description": e.get("description") or "", "object_type_id": tid, "object_type": type_name(tid) if tid else "search around",
                    "owner": e.get("owner"), "created_at": e.get("created_at")})
    for x in ox.list_object_lists():
        out.append({"rid": f"{quiver_cards.SET_RID}list.{x['id']}", "kind": "list", "id": x["id"], "name": x.get("name"),
                    "description": x.get("description") or "", "object_type_id": x.get("object_type_id"), "object_type": type_name(x.get("object_type_id")),
                    "owner": x.get("owner"), "created_at": x.get("created_at"), "count": x.get("count")})
    return out


class ObjectListIn(BaseModel):
    name: str
    description: str = ""
    # the editor's unsaved cards (default: the saved analysis)
    object_sets: Optional[list[dict]] = None
    logic: Optional[dict] = None
    range: Optional[dict] = None


@router.post("/{aid}/cards/{cid}/object-list")
def save_object_list(aid: str, cid: str, req: ObjectListIn) -> dict:
    """Save an object set card's objects (every one, up to 50,000) as an object list — a saved object set other
    analyses import with "Import saved object set" (and Object Explorer opens). The list is a snapshot of the objects."""
    import ontology_explorer as ox
    import ts_derived

    a = dict(ts_derived._analysis(aid))
    for k in ("object_sets", "logic", "range"):
        if getattr(req, k) is not None:
            a[k] = getattr(req, k)
    if not req.name.strip():
        raise HTTPException(400, "name the object set")
    comp, cards = compile_analysis(a)
    c = cards.get(cid)
    if not c or (c.get("kind") or "object_set") not in quiver_cards.OBJECT_INPUT_KINDS:
        raise HTTPException(404, "no object set card with this ID")
    try:
        tid = quiver_cards.object_type_of(cards, cid, comp)
        if not tid:
            raise E.ContourError("the card's object type cannot be told")
        rel = comp.path_rel(cid, None)
        n = comp.count(rel)
        if n > MAX_ROWS:
            raise E.ContourError(f"{n:,} objects — an object list saved from Quiver holds at most 50,000")
        keys = quiver_cards._keys(comp, rel)
    except E.ContourError as e:
        msg = str(e)
        raise HTTPException(400, "the source card no longer exists" if "__missing__" in msg else msg) from None
    desc = req.description.strip() or f"Saved from the Quiver analysis {a.get('name') or aid}, card ${cid}"
    rec = ox.create_object_list(ox.ObjectListIn(name=req.name.strip()[:200], description=desc[:2000], object_type_id=tid, primary_keys=keys))
    return {**rec, "rid": f"{quiver_cards.SET_RID}list.{rec['id']}"}
