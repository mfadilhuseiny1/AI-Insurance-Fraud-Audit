"""Workshop: drag-and-drop dashboards (modules) over datasets and ontology object types.

A module is a grid of widgets (table, metric, bar / pie / line chart, filter, text, action button), each
reading one source: a dataset (a Parquet file in Files, e.g. a deployed pipeline output), an object
type (ontology.py) or an interface (the objects of every implementing type under the interface's properties). Widgets ask POST /api/workshop/query for their rows, so filtering, grouping and
aggregation run here, not in the browser. Modules are JSON files in data/workshop/.

Mounted by server.py under /api/workshop.
"""

from __future__ import annotations

import io
import json
import re
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

import db
import drive
import ontology
import pipeline_datasets

router = APIRouter(prefix="/api/workshop")
DIR: Path = Path()
MAX_SOURCE_ROWS = 500_000
MAX_RESULT_ROWS = 5_000
_cache_lock = threading.Lock()
# dataset rows by (item id, updated_at): reread only when the file changes
_cache: dict[str, tuple[str, list[str], dict[str, str], list[dict]]] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "workshop"
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / "versions").mkdir(exist_ok=True)
    (DIR / "favorites").mkdir(exist_ok=True)
    (DIR / "edit-history").mkdir(exist_ok=True)
    (DIR / "resource-links").mkdir(exist_ok=True)
    (DIR / "analyses").mkdir(exist_ok=True)
    (DIR / "branches").mkdir(exist_ok=True)
    _install_merge_hook()
    _install_edit_hook()
    threading.Thread(target=_rehook, name="workshop-edit-history", daemon=True).start()


def _path(module_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", module_id):
        raise HTTPException(404, "module not found")
    return DIR / f"{module_id}.json"


# ------------------------------------------------------------------------------------------------
# modules
# ------------------------------------------------------------------------------------------------


class ModuleIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    # [{id, type, title, x, y, w, h, config, parent?}] — parent: "page:<id>" (default the first page), "<widget id>:<tab id>"
    # (a tabs widget), "<section id>:body" (a section), "overlay:<id>" or "header" (the module header)
    widgets: Optional[list[dict]] = None
    # [{id, name, background?, padding?}]: the module's pages
    pages: Optional[list[dict]] = None
    # [{id, name, kind: drawer | modal, width, side, open_variable, show_header, title, icon, on_close, close_on_backdrop,
    # backdrop}]: overlays opened by events
    overlays: Optional[list[dict]] = None
    # [{name, type: string | number | boolean | date | object | object_set | array, default, url_param}]
    variables: Optional[list[dict]] = None
    # {auto_publish, page_variable, auto_refresh: {enabled, object_type_ids, min_seconds, disable_in_edit}, kiosk,
    #  translations: {enabled, base, languages: {code: {strings: {source: text}, complete: [source]}}},
    #  colors: [{id, name, light, dark}], header: {hidden, title, title_color, icon, icon_color, image_url, image_height,
    # image_position, background, orientation, height, width, collapsible, collapsed, favorite}}
    settings: Optional[dict] = None
    # module-level derived properties: [{object_type_id, name, op, column, other_column?, value?}] (column math)
    derived: Optional[list[dict]] = None
    # a note for the version this save makes
    version_note: Optional[str] = Field(None, max_length=500)
    # creating: the Files Project or folder the module's item goes into (default: the default Project)
    folder_id: Optional[str] = None


WORKSHOP_TYPE = "application/vnd.bluesandai.workshop+json"


def _module(module_id: str, need: str = "viewer") -> dict:
    """A module the caller may open (need viewer) or change (need editor): its Files item's Project roles and markings.
    Modules made before they were Files items (no item_id) stay open to everyone signed in until moved into a Project."""
    m = ontology._read(_path(module_id))
    if not m:
        raise HTTPException(404, "module not found")
    if m.get("item_id") and db.enabled():
        try:
            drive._item(m["item_id"], need=need)
        except HTTPException as e:
            # a module the user may not see is not found; one they see but may not change is forbidden
            if e.status_code == 404 or need == "viewer":
                raise HTTPException(404, "module not found") from None
            raise HTTPException(403, "you need the Editor role on the module's Project to change it") from None
    return m


def _access_info(m: dict) -> dict:
    """can_edit and the Files path of a module, for the editor."""
    if not m.get("item_id") or not db.enabled():
        return {"can_edit": True, "path": None, "in_files": False}
    try:
        drive._item(m["item_id"], need="editor")
        can = True
    except HTTPException:
        can = False
    try:
        path = drive._with_path(drive._item(m["item_id"])).get("path")
    except HTTPException:
        path = None
    return {"can_edit": can, "path": path, "in_files": True}


def _new_item(folder_id: Optional[str], m: dict) -> Optional[dict]:
    """The module's Files item (`<name>.workshop`) in a Project or folder the caller edits."""
    if not db.enabled():
        return None
    if not folder_id:
        drive.ensure_defaults()
        folder_id = (db.drive_by_system("project") or {}).get("id")
    folder = drive._item(folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "put the module in a Project or a folder")
    body = json.dumps({"workshop_module_id": m["id"]}).encode()
    name = drive._clean_name(f"{m['name']}.workshop")
    return drive._store(folder["id"], name, io.BytesIO(body), len(body), WORKSHOP_TYPE)


def _uid() -> str:
    try:
        import auth

        return (auth.current() or {}).get("id") or "anonymous"
    except Exception:  # noqa: BLE001
        return "anonymous"


def _favorites() -> dict[str, list[str]]:
    return ontology._read(DIR / "favorites" / "favorites.json") or {}


@router.get("/modules")
def list_modules() -> list[dict]:
    mods = [m for p in DIR.glob("*.json") if (m := ontology._read(p))]
    if db.enabled():
        # only modules whose Files item the user may see (legacy modules without one stay listed)
        items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (WORKSHOP_TYPE,), order="updated_at DESC", limit=5000)
        visible = {i["id"]: i for i in auth_visible(items)}
        mods = [{**m, "path": drive._with_path(visible[m["item_id"]]).get("path")} if m.get("item_id") else m
                for m in mods if not m.get("item_id") or m["item_id"] in visible]
    fav = set(_favorites().get(_uid(), []))
    out = sorted(({**m, "widget_count": len(m["widgets"]), "favorite": m["id"] in fav} for m in mods), key=lambda m: m["updated_at"], reverse=True)
    return sorted(out, key=lambda m: not m["favorite"])  # favorites first, each group newest first


@router.get("/mobile-apps")
def mobile_apps(q: str = "") -> list[dict]:
    """The mobile app launcher: modules whose device type is Mobile (the user may see), as light records."""
    out = []
    for m in list_modules():
        mob = (m.get("settings") or {}).get("mobile") or {}
        if mob.get("device") != "mobile":
            continue
        nav = mob.get("navbar") or {}
        rec = {"id": m["id"], "name": m["name"], "description": m.get("description") or "", "title": nav.get("title") or m["name"],
               "icon": nav.get("icon") or "device", "updated_at": m["updated_at"], "favorite": m.get("favorite", False),
               "published": bool(m.get("published_version"))}
        if q and q.lower() not in f"{rec['name']} {rec['title']} {rec['description']}".lower():
            continue
        out.append(rec)
    return out


# the summarizer aggregations of the Workshop time series doc (the first seven were the original ones; std: population)
TS_SUMMARY_AGGS = ("last", "first", "min", "max", "mean", "sum", "count", "std", "difference", "relative_difference", "integral", "product",
                   "time_weighted_average", "value_at")
TsAggregation = Literal["last", "first", "min", "max", "mean", "sum", "count", "std", "difference", "relative_difference", "integral", "product",
                        "time_weighted_average", "value_at"]
_LEGACY_AGGS = ("last", "first", "min", "max", "mean", "sum", "count")
_TIME_UNITS = ("s", "m", "min", "h", "d", "w")


class TsTransform(BaseModel):
    """One time series transform of a column, applied in order after the rolling window (the doc's transforms):
    rolling / cumulative / periodic aggregates, derivative and integral (per a time unit), a formula ($X: the
    transform's input, $A: the property, @name: a property of the row's object), a time shift and a time range (keeps
    the points of [start, end): exact `start` / `end`, or relative: the `last` <n><unit> before now, ending
    `end_offset` from now)."""
    type: Literal["rolling", "cumulative", "periodic", "derivative", "integral", "formula", "shift", "time_range"]
    window: Optional[str] = None  # rolling: the trailing window (7d)
    period: Optional[str] = None  # periodic: the interval (1w, 1mo)
    align: Optional[str] = None  # periodic: the alignment timestamp (ISO; periods start there ± whole periods)
    window_type: Literal["start", "end"] = "start"  # periodic: a point is its period's start ([start, end)) or end ((start, end])
    start: Optional[str] = None  # time range: exact start / end (ISO)
    end: Optional[str] = None
    last: Optional[str] = None  # time range: relative, the last <n><unit>
    end_offset: Optional[str] = None  # time range: relative end, a signed duration from now (-7d: a week ago)
    aggregation: Optional[str] = None  # rolling / cumulative / periodic (mean, sum, min, max, count, std, median, first, last, range)
    unit: Optional[str] = None  # derivative / integral: the time unit of the rate / area (s, m, h, d, w)
    method: Literal["linear", "left", "right"] = "linear"  # integral: trapezoids, left- or right-hand sums
    formula: Optional[str] = None
    by: Optional[str] = None  # shift: a duration, negative = earlier (-7d)


class TsColumnOptions(BaseModel):
    property: str
    # the summary value: one of the doc's aggregation types over the range
    aggregation: TsAggregation = "last"
    # the range: the last <n><unit> (30d, 12h, 8w, 6mo), else all of the series
    range_last: Optional[str] = None
    # a custom range (the doc's "Custom range"): exact, `range_start` / `range_end` (ISO or epoch ms; either may be
    # open), or relative, `range_last` before now ending `range_end_offset` from now (-7d: a week ago, 1w: a week ahead)
    range_start: Optional[str] = None
    range_end: Optional[str] = None
    range_end_offset: Optional[str] = None
    buckets: int = Field(30, ge=4, le=200)
    # a rolling aggregate transform first (window, e.g. 7d, and its aggregation): the summary and the sparkline are of
    # the rolled series (the doc's "Weekly Cases": the last weekly average)
    rolling: Optional[str] = None
    rolling_agg: str = "mean"
    # more transforms after the rolling window, in order
    transforms: list[TsTransform] = Field(default_factory=list, max_length=8)
    # single value, or value change: the aggregation over the range minus the same aggregation over the period before it
    # (of the range's length, or `change_offset` earlier: 1y = the same period a year before), as a difference or a percent
    summarizer: Literal["single", "value_change"] = "single"
    change_as: Literal["absolute", "percent"] = "absolute"
    change_offset: Optional[str] = None
    # the time unit of the integral summary (value × time)
    integral_unit: str = "s"
    # value at a time (aggregation value_at; Quiver's "Value at time"): the series' value at an exact time (ISO / epoch
    # ms) or relative to now (a signed duration: -7d a week ago; empty: now), by the series' own interpolation or one
    # picked here (previous: the last point at or before it, next, nearest, linear: between two points only)
    value_at: Optional[str] = None
    value_at_interpolation: Literal["series", "linear", "previous", "next", "nearest"] = "series"


class TsColumnIn(TsColumnOptions):
    object_type_id: str
    primary_keys: list[str] = Field(default_factory=list, max_length=500)
    resource: str = "workshop"


_DURATION ={"s": 1_000, "m": 60_000, "min": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000, "mo": 2_592_000_000, "y": 31_536_000_000}


def _last_ms(text: str, what: str = "range") -> int:
    """The length of <n><unit> in milliseconds (30d, 12h, 8w, 6mo; mo = 30 days, y = 365 days)."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(s|m|min|h|d|w|mo|y)", text.strip().lower())
    if not m:
        raise HTTPException(400, f"{what} {text!r}: use a number and s, m, h, d, w, mo or y (30d)")
    return int(float(m.group(1)) * _DURATION[m.group(2)])


def _range_start(range_last: Optional[str], now_ms: int) -> Optional[int]:
    """The start of "the last <n><unit>" before now (None: all of the series)."""
    if not range_last:
        return None
    return now_ms - _last_ms(range_last)


def _when(text: Optional[str], what: str) -> Optional[int]:
    """An exact time (ISO text or epoch ms) in epoch ms, None when empty; ValueError when it does not parse."""
    import ts_engine as E

    if text in (None, ""):
        return None
    try:
        return E.to_ms(text)
    except E.EngineError:
        raise ValueError(f"{what} {text!r} is not a date / time (2026-01-31 or 2026-01-31T08:00Z)") from None


def _offset_ms(text: str, what: str) -> int:
    """A signed duration (-7d, 1w, 0d) in ms; ValueError when it does not parse."""
    m = re.fullmatch(r"([+-]?)(\d+(?:\.\d+)?)(s|m|min|h|d|w|mo|y)", (text or "").strip().lower())
    if not m:
        raise ValueError(f"{what} {text!r}: use a signed number and s, m, h, d, w, mo or y (-7d: a week ago, 1w: a week ahead)")
    return (-1 if m.group(1) == "-" else 1) * int(float(m.group(2)) * _DURATION[m.group(3)])


def _time_range(last: Optional[str], start: Optional[str], end: Optional[str], end_offset: Optional[str], now: int, what: str = "the range") -> tuple[Optional[int], Optional[int]]:
    """[start, end) of a time range (None: open): exact (`start` / `end`), or relative (the `last` <n><unit> before now,
    ending `end_offset` from now; no end offset: open, as before). ValueError when it is invalid or empty."""
    exact = start not in (None, "") or end not in (None, "")
    if exact and (last or end_offset):
        raise ValueError(f"{what}: an exact range (start / end) or a relative one (last … / end offset), not both")
    if exact:
        lo, hi = _when(start, "start"), _when(end, "end")
    else:
        try:
            lo = now - _last_ms(last) if last else None
        except HTTPException as e:
            raise ValueError(str(e.detail)) from None
        hi = now + _offset_ms(end_offset, "end offset") if end_offset else None
    if lo is not None and hi is not None and lo >= hi:
        raise ValueError(f"{what} ends before it starts")
    return lo, hi


def _col_range(col: "TsColumnOptions", now: int) -> tuple[Optional[int], Optional[int]]:
    return _time_range(col.range_last, col.range_start, col.range_end, col.range_end_offset, now)


def _at_time(text: Optional[str], now: int) -> int:
    """The time of a "value at a time": now when empty, a signed duration from now (-7d), else an exact time."""
    if text in (None, "") or str(text).strip().lower() == "now":
        return now
    if re.fullmatch(r"[+-]?\d+(?:\.\d+)?(s|m|min|h|d|w|mo|y)", str(text).strip().lower()):
        return now + _offset_ms(text, "the time")
    return _when(text, "the time")


def _value_at(s: Any, t: int, how: str) -> Any:
    """The series' value at t: by its own interpolation (`series`), or the last point at or before t (`previous`), the
    first at or after it (`next`), the nearer of the two (`nearest`, the earlier on a tie) or a straight line between
    them (`linear`, None outside the points). None when there is none."""
    import bisect

    import ts_engine as E

    if how == "series":
        return E.value_at(s, t)
    n, i = len(s.t), bisect.bisect_left(s.t, t)
    if i < n and s.t[i] == t:
        return s.v[i]
    before, after = (i - 1 if i else None), (i if i < n else None)
    if how == "previous":
        return s.v[before] if before is not None else None
    if how == "next":
        return s.v[after] if after is not None else None
    if how == "nearest":
        if before is None or after is None:
            k = before if after is None else after
            return s.v[k] if k is not None else None
        return s.v[before] if t - s.t[before] <= s.t[after] - t else s.v[after]
    if before is None or after is None:
        return None
    va, vb = s.v[before], s.v[after]
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (va, vb)):
        return va
    return va + (vb - va) * (t - s.t[before]) / (s.t[after] - s.t[before])


def _ts_cells(object_type_id: str, pks: list[str], property: str, aggregation: str, start: Optional[int], buckets: int,
              rolling: Optional[str] = None, rolling_agg: str = "mean") -> tuple[dict[str, dict], int]:
    """One time series column for the objects: per object its summary value (the aggregation over the range, of the
    rolled series when a rolling window is set), unit and sparkline points; and the points scanned."""
    import ts_ontology as T

    cards: list[dict] = [{"id": "A", "type": "tsp", "config": {"property": property}}]
    series = "A"
    if rolling:
        cards.append({"id": "B", "type": "rolling", "config": {"input": "A", "window": rolling, "aggregation": rolling_agg or "mean"}})
        series = "B"
    cards.append({"id": "C", "type": "aggregate", "config": {"input": series, "aggregation": aggregation}})
    logic = {"cards": cards}
    want = ["A", "C"] if series == "A" else ["A", "B", "C"]
    out: dict[str, dict] = {}
    scanned = 0
    for pk in dict.fromkeys(pks):
        try:
            res = T.E.run(logic, T.Resolver(), {"object_type_id": object_type_id, "primary_key": pk}, start, None, cards=want, buckets=buckets)
        except T.E.EngineError as e:
            out[pk] = {"error": str(e)}
            continue
        except HTTPException as e:
            out[pk] = {"error": str(e.detail)}
            continue
        scanned += res["points_scanned"]
        a, s, c = res["cards"]["A"], res["cards"][series], res["cards"]["C"]
        bad = next((x for x in (a, s, c) if x["kind"] == "error"), None)
        if bad:
            out[pk] = {"error": bad.get("error")}
            continue
        out[pk] = {"value": c.get("value"), "unit": a.get("unit"), "points": [[p["t"], p["value"]] for p in s.get("points", []) if isinstance(p.get("value"), (int, float))]}
    return out, scanned


def _is_legacy(col: TsColumnOptions) -> bool:
    """A column with only the original options (answered by `_ts_cells`, unchanged)."""
    return (not col.transforms and col.summarizer == "single" and col.aggregation in _LEGACY_AGGS
            and not (col.range_start or col.range_end or col.range_end_offset))


def _column_cards(col: TsColumnOptions, now: Optional[int] = None) -> tuple[list[dict], str, bool]:
    """The engine cards of a column's transform chain, the last card's id, and whether the chain must see the whole
    series (cumulative, derivative and integral read every earlier point, not only those of the range)."""
    import time

    cards: list[dict] = [{"id": "A", "type": "tsp", "config": {"property": col.property}}]
    prev, whole = "A", False
    if col.rolling:
        cards.append({"id": "B", "type": "rolling", "config": {"input": "A", "window": col.rolling, "aggregation": col.rolling_agg or "mean"}})
        prev = "B"
    for i, tr in enumerate(col.transforms, 1):
        cid, n, tr_type = f"T{i}", f"transform {i} ({tr.type})", tr.type
        if tr.type in ("derivative", "integral") and (tr.unit or "s") not in _TIME_UNITS:
            raise ValueError(f"{n}: the time unit is one of {', '.join(_TIME_UNITS)}")
        if tr.type == "rolling":
            if not (tr.window or "").strip():
                raise ValueError(f"{n}: enter a window (7d)")
            cfg = {"input": prev, "window": tr.window.strip(), "aggregation": tr.aggregation or "mean"}
        elif tr.type == "cumulative":
            cfg, whole = {"input": prev, "aggregation": tr.aggregation or "sum"}, True
        elif tr.type == "periodic":
            cfg = {"input": prev, "period": (tr.period or "").strip() or "1d", "aggregation": tr.aggregation or "mean"}
            if tr.align:
                cfg["align"] = _when(tr.align, f"{n}: the alignment timestamp")
            if tr.window_type == "end":
                cfg["window_type"] = "end"
        elif tr.type == "time_range":
            lo, hi = _time_range(tr.last, tr.start, tr.end, tr.end_offset, now if now is not None else int(time.time() * 1000), n)
            if lo is None and hi is None:
                raise ValueError(f"{n}: pick a start, an end or the last …")
            # the engine's filter keeps start <= t <= end: end - 1 ms keeps [start, end) like the summary's range
            cfg = {"input": prev, "start": lo, "end": hi - 1 if hi is not None else None}
            tr_type = "filter"
        elif tr.type == "derivative":
            cfg, whole = {"input": prev, "unit": tr.unit or "s"}, True
        elif tr.type == "integral":
            cfg, whole = {"input": prev, "unit": tr.unit or "s", "method": tr.method}, True
        elif tr.type == "formula":
            if not (tr.formula or "").strip():
                raise ValueError(f"{n}: enter a formula ($X * 2 + 5)")
            cfg = {"formula": re.sub(r"\$X\b", "$" + prev, tr.formula)}
        else:
            cfg = {"input": prev, "by": (tr.by or "").strip() or "0s"}
        cards.append({"id": cid, "type": tr_type, "config": cfg})
        prev = cid
    return cards, prev, whole


def _summarize(ts: list[int], vs: list[Any], how: str, unit_ms: int) -> Any:
    """A summarizer aggregation over a range's points (the doc's list): the engine's for the plain ones; difference
    (last − first), relative difference ((last − first) / first), product, integral (trapezoids, per `unit_ms`) and
    the time-weighted average (each value holds until the next point) over the numeric points."""
    import math

    import ts_engine as E

    if how in _LEGACY_AGGS or how == "std":
        return E.aggregate(vs, how)
    pts = [(t, float(v)) for t, v in zip(ts, vs) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    if not pts:
        return None
    first, last = pts[0][1], pts[-1][1]
    if how == "difference":
        return last - first
    if how == "relative_difference":
        return None if first == 0 else (last - first) / first
    if how == "product":
        return math.prod(v for _, v in pts)
    if how == "integral":
        return sum((a[1] + b[1]) / 2 * (b[0] - a[0]) for a, b in zip(pts, pts[1:])) / unit_ms
    span = pts[-1][0] - pts[0][0]
    if not span:
        return last
    return sum(a[1] * (b[0] - a[0]) for a, b in zip(pts, pts[1:])) / span


def _ts_cells_ext(object_type_id: str, pks: list[str], col: TsColumnOptions, now: int) -> tuple[dict[str, dict], int]:
    """A column with transforms, a newer aggregation or the value change summarizer: per object the summary (for value
    change also `current`, `previous`, `change` and `change_pct`), the unit and the sparkline over the range (for value
    change: from the start of the earlier period); and the points scanned. Errors of the column are reported per row."""
    import bisect

    import ts_ontology as T

    E = T.E
    try:
        cards, last, whole = _column_cards(col, now)
        E.check_logic({"cards": cards})
        if col.aggregation == "integral" and col.integral_unit not in _TIME_UNITS:
            raise ValueError(f"the integral's time unit is one of {', '.join(_TIME_UNITS)}")
        unit_ms = E._UNITS[col.integral_unit] if col.aggregation == "integral" else 1
        start, end = _col_range(col, now)
        periods: list[tuple[Optional[int], Optional[int]]] = [(start, end)]
        at: list[int] = []
        if col.aggregation == "value_at":
            # the value at a time (and for value change: at the time `change_offset` earlier, else a range's length
            # earlier); every point is read, the time may lie outside the range (the range is the sparkline's)
            at.append(_at_time(col.value_at, now))
            whole = True
            if col.summarizer == "value_change":
                if not col.change_offset and start is None:
                    raise ValueError("value change of a value at a time compares it with the value an offset earlier: enter the offset (7d) or pick a range")
                off = _last_ms(col.change_offset, "offset") if col.change_offset else (end if end is not None else now) - start
                at.append(at[0] - off)
        elif col.summarizer == "value_change":
            if start is None:
                raise ValueError("value change compares the range with the period before it: pick a range (last 7 days)")
            # the period before: of the range's length (an open end: up to now), or the range `change_offset` earlier
            off = _last_ms(col.change_offset, "offset") if col.change_offset else (end if end is not None else now) - start
            periods.append((start - off, (end if end is not None else now) - off))
    except (ValueError, E.EngineError) as e:
        return {pk: {"error": str(e)} for pk in dict.fromkeys(pks)}, 0
    except HTTPException as e:
        return {pk: {"error": str(e.detail)} for pk in dict.fromkeys(pks)}, 0
    lo_all = None if any(lo is None for lo, _ in periods) else min(lo for lo, _ in periods)
    logic = {"cards": cards}
    out: dict[str, dict] = {}
    scanned = 0
    for pk in dict.fromkeys(pks):
        ev = E.Evaluator(logic, T.Resolver(), {"object_type_id": object_type_id, "primary_key": pk}, None if whole else lo_all, None)
        try:
            s = ev.series(last)
        except E.EngineError as e:
            out[pk] = {"error": str(e)}
            continue
        except HTTPException as e:
            out[pk] = {"error": str(e.detail)}
            continue
        scanned += ev.scanned

        def part(lo: Optional[int], hi: Optional[int]) -> tuple[list[int], list[Any]]:
            i = bisect.bisect_left(s.t, lo) if lo is not None else 0
            j = bisect.bisect_left(s.t, hi) if hi is not None else len(s.t)
            return s.t[i:j], s.v[i:j]

        if at:
            values = [_value_at(s, t, col.value_at_interpolation) for t in at]
        else:
            values = [_summarize(*part(lo, hi), col.aggregation, unit_ms) for lo, hi in periods]
        unit = s.unit
        if col.aggregation == "relative_difference":
            unit = None  # a ratio
        elif col.aggregation == "integral":
            unit = f"{unit}·{col.integral_unit}" if unit else None
        cell: dict[str, Any] = {"value": values[0], "unit": unit}
        if col.summarizer == "value_change":
            cur, prev = values
            num = all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (cur, prev))
            change = cur - prev if num else None
            pct = change / abs(prev) * 100 if num and prev != 0 else None
            cell = {"value": pct if col.change_as == "percent" else change, "unit": "%" if col.change_as == "percent" else unit,
                    "current": cur, "previous": prev, "change": change, "change_pct": pct}
        if at:
            cell["at"] = E.iso(at[0])
            if len(at) > 1:
                cell["previous_at"] = E.iso(at[1])
        ts, vs = part(lo_all, end)
        pts, _ = E.bucket(s.like(ts, vs), col.buckets)
        cell["points"] = [[p["t"], p["value"]] for p in pts if isinstance(p.get("value"), (int, float))]
        out[pk] = cell
    return out, scanned


def _column_cells(object_type_id: str, pks: list[str], col: TsColumnOptions, now: int) -> tuple[dict[str, dict], int]:
    """One column for a page of rows: original columns by `_ts_cells` (unchanged), the others by `_ts_cells_ext`."""
    if _is_legacy(col):
        return _ts_cells(object_type_id, pks, col.property, col.aggregation, _range_start(col.range_last, now), col.buckets, col.rolling, col.rolling_agg)
    return _ts_cells_ext(object_type_id, pks, col, now)


@router.post("/ts-columns")
def ts_columns(req: TsColumnIn) -> dict:
    """Time series property columns of an object table / the Metric Card: per object, the summary value (a summarizer
    over the range, after the rolling window and transforms when set) and the series downsampled to `buckets` points
    for a sparkline."""
    import time

    import timeseries

    now = int(time.time() * 1000)
    _range_start(req.range_last, now)  # a bad range is a 400 here
    out, scanned = _column_cells(req.object_type_id, req.primary_keys, req, now)
    timeseries.record_usage(req.resource, scanned)
    return {"rows": out, "points_scanned": scanned}


class TsColumnSpec(TsColumnOptions):
    id: str


class TsColumnsBatchIn(BaseModel):
    object_type_id: str
    # one page of the table's rows (the client pages beyond 500)
    primary_keys: list[str] = Field(default_factory=list, max_length=500)
    columns: list[TsColumnSpec] = Field(default_factory=list, max_length=50)
    resource: str = "workshop"


@router.post("/ts-columns/batch")
def ts_columns_batch(req: TsColumnsBatchIn) -> dict:
    """Every time series column of an object table for a page of its rows in one request: per column id, the rows as
    /ts-columns answers them (one relative "now" for all columns, so their ranges agree). A column whose range is
    invalid reports the error on each of its rows."""
    import time

    import timeseries

    now = int(time.time() * 1000)
    cols: dict[str, dict] = {}
    scanned = 0
    for col in req.columns:
        try:
            _range_start(col.range_last, now)
        except HTTPException as e:
            cols[col.id] = {pk: {"error": str(e.detail)} for pk in req.primary_keys}
            continue
        out, n = _column_cells(req.object_type_id, req.primary_keys, col, now)
        cols[col.id] = out
        scanned += n
    timeseries.record_usage(req.resource, scanned)
    return {"columns": cols, "points_scanned": scanned}


# QR Code Reader fallback (browsers without the BarcodeDetector API): codes in a camera frame or a photo, with OpenCV
BARCODE_FORMATS = ("ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "codabar", "itf", "pdf417", "data_matrix", "aztec")


@router.post("/decode-codes")
async def decode_codes(request: Request, kind: Literal["qr", "barcode"] = "qr") -> dict:
    """The QR codes (kind=qr) or 1D barcodes (kind=barcode: EAN / UPC / Code 128 / 39 / 93, Codabar, ITF) in an image
    sent as the body (JPEG / PNG). PDF417, Data Matrix and Aztec are only read by the browser's BarcodeDetector."""
    import cv2
    import numpy as np

    raw = await request.body()
    if not raw or len(raw) > 15 * 1024 * 1024:
        raise HTTPException(400, "Send one image (up to 15 MB) as the request body")
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Not an image")
    codes: list[dict] = []
    if kind == "qr":
        ok, texts, _pts, _ = cv2.QRCodeDetector().detectAndDecodeMulti(img)
        if not ok or not any(texts):
            t, _p, _ = cv2.QRCodeDetector().detectAndDecode(img)
            texts = [t] if t else []
        codes = [{"value": t, "format": "qr_code"} for t in texts if t]
    else:
        det = cv2.barcode.BarcodeDetector()
        ok, texts, types, _pts = det.detectAndDecodeWithType(img)
        if not ok:
            # a quiet zone and a slight blur help sharp (printed or generated) codes
            soft = cv2.GaussianBlur(cv2.copyMakeBorder(img, 60, 60, 60, 60, cv2.BORDER_REPLICATE), (3, 3), 0)
            ok, texts, types, _pts = det.detectAndDecodeWithType(soft)
        codes = [{"value": t, "format": str(ty).lower().replace("-", "_")} for t, ty in zip(texts or [], types or []) if t]
    return {"codes": codes}


class FavoriteIn(BaseModel):
    favorite: bool


@router.put("/modules/{module_id}/favorite")
def favorite(module_id: str, req: FavoriteIn) -> dict:
    """Favorite a module (when its header allows it): favorites come first in the module list, per user."""
    _module(module_id)
    with _cache_lock:
        favs = _favorites()
        mine = [x for x in favs.get(_uid(), []) if x != module_id] + ([module_id] if req.favorite else [])
        favs[_uid()] = mine
        ontology._write(DIR / "favorites" / "favorites.json", favs)
    return {"favorite": req.favorite}


def _type_favorites() -> dict[str, list[str]]:
    return ontology._read(DIR / "favorites" / "object_types.json") or {}


@router.get("/favorite-object-types")
def favorite_object_types() -> list[str]:
    """The user's favorite object types (the Resource List's "Favorite" object types), those still visible to them."""
    visible = {t["id"] for t in ontology.list_object_types()}
    return [x for x in _type_favorites().get(_uid(), []) if x in visible]


@router.put("/favorite-object-types/{type_id}")
def favorite_object_type(type_id: str, req: FavoriteIn) -> list[str]:
    """Favorite an object type (or not), per user; returns the user's favorites."""
    ontology._object_type(type_id)  # 404 when it does not exist (or is not visible)
    with _cache_lock:
        favs = _type_favorites()
        favs[_uid()] = [x for x in favs.get(_uid(), []) if x != type_id] + ([type_id] if req.favorite else [])
        ontology._write(DIR / "favorites" / "object_types.json", favs)
    return favorite_object_types()


@router.get("/interface-object/{iface_id}/{type_id}/{pk}")
def interface_object(iface_id: str, type_id: str, pk: str) -> dict:
    """One object of an interface (the Object View widget on an interface source): its implementing type, and each
    interface property read through that type's implementation mapping (the local property, or "struct.field"; an
    unmapped property is null). 404 when the type does not implement the interface (or one extending it)."""
    import ontology_model as om

    with ontology._lock:
        iface = ontology._get("interfaces", iface_id, "interface")
        imp = next((i for t, i in om.implementations(iface_id) if t["id"] == type_id), None)
        if imp is None:
            raise HTTPException(404, "this object type does not implement the interface")
        t = ontology._object_type(type_id)
        o = ontology._objects(type_id).get(str(pk))
        if o is None or not ontology._can_see(t, o):
            raise HTTPException(404, "object not found")
        pub = ontology._public_object(t, str(pk), o)
        mapping = imp.get("mapping") or {}
        props = [{"name": p["api_name"], "label": p.get("display_name") or p["api_name"], "type": p.get("type") or "string", "local": mapping.get(p["api_name"]),
                  "value": om.iface_value(pub["properties"], mapping[p["api_name"]]) if mapping.get(p["api_name"]) else None}
                 for p in om.interface_properties(iface)]
    return {"interface": {"id": iface["id"], "name": iface.get("display_name") or iface["id"]}, "object_type": {"id": t["id"], "display_name": t["display_name"]},
            "primary_key": str(pk), "title": pub.get("title") or str(pk), "properties": props}


# ------------------------------------------------------------------------------------------------
# Resource List: Files tags (the Compass tags applied to Files resources) — the tag catalog the user sees, the tags of
# listed resources, and the "Tags" content (resources having one of the chosen tags)
# ------------------------------------------------------------------------------------------------

MAX_TAGGED = 500


def _visible_tags() -> dict[str, dict]:
    """Tag id → {id, name, category, category_id}: the tags of the categories visible to the user."""
    import compass

    return {t["id"]: {"id": t["id"], "name": t["name"], "category": c["name"], "category_id": c["id"]} for c in compass.tags() for t in c.get("tags") or []}


def _item_tags() -> dict[str, list[str]]:
    import compass

    return compass._tags_doc()["items"]


def _visible_items(ids: list[str]) -> list[dict]:
    """The Files items (with their location) the user may see, in the given order; trashed and missing ones left out."""
    import auth

    if not db.enabled():
        return []
    rows = [it for it in (db.drive_get(i) for i in dict.fromkeys(ids)) if it and not it.get("trashed_at")]
    return [drive._with_path(i) for i in auth.visible(rows)]


@router.get("/resource-tags")
def resource_tags() -> list[dict]:
    """The tags the user can choose (grouped by category in the order of the catalog)."""
    return list(_visible_tags().values())


class TagsOfIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=MAX_TAGGED)


@router.post("/resource-tags/of")
def resource_tags_of(req: TagsOfIn) -> dict[str, list[dict]]:
    """The visible tags of each listed Files resource the user can see (resources without tags: an empty list)."""
    idx, items = _visible_tags(), _item_tags()
    return {it["id"]: [idx[t] for t in items.get(it["id"], []) if t in idx] for it in _visible_items(req.ids)}


@router.get("/resources/tagged")
def tagged_resources(tags: str = "") -> list[dict]:
    """The Files resources having one of the tags (comma-separated tag ids), each with its visible tags, by name.
    Unknown or invisible tags are ignored; no tag: nothing."""
    idx, items = _visible_tags(), _item_tags()
    want = {t for t in tags.split(",") if t.strip() and t in idx}
    if not want:
        return []
    ids = [i for i, ts in items.items() if want & set(ts)][: MAX_TAGGED * 2]
    out = [{**it, "tags": [idx[t] for t in items.get(it["id"], []) if t in idx]} for it in _visible_items(ids)]
    return sorted(out, key=lambda x: x["name"].lower())[:MAX_TAGGED]


@router.post("/modules")
def create_module(req: ModuleIn) -> dict:
    now = ontology._now()
    m = {"id": ontology._new_id("wsm"), "name": (req.name or "Untitled module").strip(), "description": req.description or "",
         "widgets": req.widgets or [], "created_at": now, "updated_at": now, "created_by": _who()}
    item = _new_item(req.folder_id, m)
    if item:
        m["item_id"] = item["id"]
    ontology._write(_path(m["id"]), m)
    return {**m, **_access_info(m)}


def auth_visible(items: list[dict]) -> list[dict]:
    import auth

    return auth.visible(items)


class MoveIn(BaseModel):
    folder_id: str


@router.post("/modules/{module_id}/move")
def move_module(module_id: str, req: MoveIn) -> dict:
    """Put a module in a Project or folder: a module without a Files item gets one (its permissions start applying),
    one with an item moves it."""
    m = _module(module_id, "editor")
    if m.get("item_id"):
        drive.update_item(m["item_id"], drive.ItemChange(move_to=req.folder_id))
    else:
        item = _new_item(req.folder_id, m)
        if not item:
            raise HTTPException(400, "Files is not available")
        m["item_id"] = item["id"]
        ontology._write(_path(module_id), m)
    return {**m, **_access_info(m)}


VAR_TYPES = ("string", "number", "boolean", "date", "timestamp", "object", "object_set", "array", "struct", "struct_array", "object_set_filter", "scenario", "scenario_array")
FIELDS = ("name", "description", "widgets", "pages", "overlays", "variables", "settings", "derived")
DEFINITIONS = ("static", "transform", "function", "aggregation", "property", "sql", "scenario_objects", "knn")


def _check(m: dict) -> None:
    pages = m.get("pages") or []
    ids = {p.get("id") for p in pages}
    if len(ids) != len(pages) or any(not re.fullmatch(r"[\w-]{1,40}", str(i or "")) for i in ids):
        raise HTTPException(400, "pages need unique ids")
    over = {o.get("id") for o in m.get("overlays") or []}
    wids = {w.get("id") for w in m.get("widgets") or []}
    for w in m.get("widgets") or []:
        par = w.get("parent")
        if not par:
            continue
        kind, _, ref = str(par).partition(":")
        if kind == "page" and ref not in ids:
            raise HTTPException(400, f"widget {w.get('id')}: unknown page {ref}")
        if kind == "overlay" and ref not in over:
            raise HTTPException(400, f"widget {w.get('id')}: unknown overlay {ref}")
        if kind not in ("page", "overlay", "header") and kind not in wids:
            raise HTTPException(400, f"widget {w.get('id')}: its container {kind} is not in the module")
    names = set()
    for v in m.get("variables") or []:
        if not re.fullmatch(r"[A-Za-z_]\w*", str(v.get("name") or "")) or v["name"] in names:
            raise HTTPException(400, f"variable names are unique identifiers: {v.get('name')!r}")
        if v.get("type") not in VAR_TYPES:
            raise HTTPException(400, f"variable {v['name']}: type is one of {', '.join(VAR_TYPES)}")
        kind = (v.get("definition") or {}).get("kind", "static")
        if kind not in DEFINITIONS:
            raise HTTPException(400, f"variable {v['name']}: definition is one of {', '.join(DEFINITIONS)}")
        if kind == "sql" and v["type"] in ("object", "object_set"):
            raise HTTPException(400, f"variable {v['name']}: object and object set variables cannot be backed by a SQL query")
        if kind == "knn" and v["type"] not in ("object_set", "object_set_filter", "array"):
            raise HTTPException(400, f"variable {v['name']}: a KNN definition backs an object set, object set filter or array variable")
        if kind == "knn" and not (v.get("definition") or {}).get("object_type_id"):
            raise HTTPException(400, f"variable {v['name']}: a KNN definition needs an object type")
        names.add(v["name"])
    ext = [v.get("external_id") for v in m.get("variables") or [] if v.get("external_id")]
    if len(ext) != len(set(ext)):
        raise HTTPException(400, "external IDs of variables are unique")


def _vpath(module_id: str) -> Path:
    _path(module_id)
    return DIR / "versions" / f"{module_id}.json"


def _versions(module_id: str) -> list[dict]:
    return ontology._read(_vpath(module_id), []) or []


def _snapshot(m: dict) -> dict:
    return {k: m.get(k) for k in FIELDS}


def _summary_of_change(old: Optional[dict], new: dict) -> str:
    if not old:
        return "Created"
    ow = {w["id"]: w for w in old.get("widgets") or []}
    nw = {w["id"]: w for w in new.get("widgets") or []}
    parts = []
    added = [nw[i].get("title") or nw[i]["type"] for i in nw if i not in ow]
    removed = [ow[i].get("title") or ow[i]["type"] for i in ow if i not in nw]
    changed = [nw[i].get("title") or nw[i]["type"] for i in nw if i in ow and json.dumps(nw[i], sort_keys=True) != json.dumps(ow[i], sort_keys=True)]
    if added:
        parts.append(f"added {', '.join(added[:5])}")
    if removed:
        parts.append(f"removed {', '.join(removed[:5])}")
    if changed:
        parts.append(f"changed {', '.join(changed[:5])}{'…' if len(changed) > 5 else ''}")
    for k in ("pages", "overlays", "variables", "settings", "name"):
        if json.dumps(old.get(k), sort_keys=True) != json.dumps(new.get(k), sort_keys=True):
            parts.append(f"{k} changed")
    return "; ".join(parts) or "no changes"


# ------------------------------------------------------------------------------------------------
# branching: a module edited on a global branch (Ontology branches) keeps the main version it started from (base) and
# its branch version; the changelog, a three-way rebase (per widget, variable, page, overlay, derived property,
# setting and field), reviews and merging into main; merging the global branch merges approved module changes too
# ------------------------------------------------------------------------------------------------


def _bpath(branch_id: str, module_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", branch_id):
        raise HTTPException(404, "branch not found")
    d = DIR / "branches" / branch_id
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{module_id}.json"


def _global_branch(branch_id: str) -> dict:
    b = ontology._read(ontology._path("branches", branch_id)) if re.fullmatch(r"[A-Za-z0-9_-]+", branch_id) else None
    if not b:
        raise HTTPException(404, "branch not found")
    return b


def _units(snap: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for w in snap.get("widgets") or []:
        out[f"widget:{w['id']}"] = w
    for v in snap.get("variables") or []:
        out[f"variable:{v['name']}"] = v
    for x in snap.get("pages") or []:
        out[f"page:{x['id']}"] = x
    for x in snap.get("overlays") or []:
        out[f"overlay:{x['id']}"] = x
    for x in snap.get("derived") or []:
        out[f"derived:{x.get('object_type_id')}.{x.get('name')}"] = x
    for k, v in (snap.get("settings") or {}).items():
        out[f"setting:{k}"] = v
    for k in ("name", "description"):
        if snap.get(k) is not None:
            out[f"field:{k}"] = snap.get(k)
    return out


def _from_units(units: dict[str, Any], order: list[dict]) -> dict:
    """A snapshot from units, lists in the order of the given snapshots (the first that has a unit wins)."""
    seen: list[str] = []
    for snap in order:
        for k in _units(snap):
            if k not in seen:
                seen.append(k)
    seen += [k for k in units if k not in seen]
    out: dict = {"widgets": [], "variables": [], "pages": [], "overlays": [], "derived": [], "settings": {}}
    for k in seen:
        if k not in units or units[k] is None:
            continue
        kind, _, name = k.partition(":")
        v = units[k]
        if kind == "widget":
            out["widgets"].append(v)
        elif kind == "variable":
            out["variables"].append(v)
        elif kind == "page":
            out["pages"].append(v)
        elif kind == "overlay":
            out["overlays"].append(v)
        elif kind == "derived":
            out["derived"].append(v)
        elif kind == "setting":
            out["settings"][name] = v
        elif kind == "field":
            out[name] = v
    return out


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _three_way(base: dict, main: dict, branch: dict) -> tuple[dict[str, Any], list[dict]]:
    b0, m, br = _units(base), _units(main), _units(branch)
    merged: dict[str, Any] = {}
    conflicts: list[dict] = []
    for k in list(dict.fromkeys([*b0, *m, *br])):
        x0, xm, xb = b0.get(k), m.get(k), br.get(k)
        if _same(xm, x0):
            merged[k] = xb
        elif _same(xb, x0) or _same(xm, xb):
            merged[k] = xm
        else:
            merged[k] = xb
            conflicts.append({"unit": k, "base": x0, "main": xm, "branch": xb})
    return merged, conflicts


def _changes(base: dict, branch: dict) -> list[dict]:
    b0, br = _units(base), _units(branch)
    out = []
    for k in dict.fromkeys([*b0, *br]):
        if k not in b0:
            out.append({"unit": k, "op": "added"})
        elif k not in br:
            out.append({"unit": k, "op": "deleted"})
        elif not _same(b0[k], br[k]):
            moved = k.startswith("widget:") and b0[k].get("parent") != br[k].get("parent")
            out.append({"unit": k, "op": "moved" if moved else "modified"})
    return out


def _branch_state(module_id: str, branch_id: str, rec: Optional[dict] = None) -> dict:
    rec = rec if rec is not None else ontology._read(_bpath(branch_id, module_id))
    gb = _global_branch(branch_id)
    if not rec:
        return {"branch_id": branch_id, "branch_name": gb["name"], "branch_status": gb["status"], "on_branch": False, "changes": [], "conflicts": [], "rebase_needed": False}
    main = _snapshot(_module(module_id))
    rebase_needed = not _same(_units(main), _units(rec["base"]))
    _, conflicts = _three_way(rec["base"], main, rec["module"]) if rebase_needed else ({}, [])
    reviews = rec.get("reviews") or {}
    return {"branch_id": branch_id, "branch_name": gb["name"], "branch_status": gb["status"], "on_branch": True, "status": rec.get("status", "open"),
            "changes": _changes(rec["base"], rec["module"]), "conflicts": [c["unit"] for c in conflicts], "rebase_needed": rebase_needed,
            "reviews": reviews, "approved": any(r["decision"] == "approve" and r.get("counts") for r in reviews.values()) and not any(r["decision"] == "reject" for r in reviews.values()),
            "by": rec.get("by"), "updated_at": rec.get("updated_at"), "merged_at": rec.get("merged_at")}


@router.get("/modules/{module_id}/branches")
def module_branches(module_id: str) -> list[dict]:
    """Open global branches, and whether this module has changes on them."""
    _module(module_id)
    out = []
    for gb in ontology._all("branches"):
        if gb.get("status") != "open" and not (DIR / "branches" / gb["id"] / f"{module_id}.json").exists():
            continue
        try:
            out.append(_branch_state(module_id, gb["id"]))
        except HTTPException:
            continue
    return sorted(out, key=lambda x: (not x["on_branch"], x["branch_name"]))


@router.get("/modules/{module_id}/branches/{branch_id}")
def module_on_branch(module_id: str, branch_id: str) -> dict:
    """The module as it is on the branch (main's version until it is saved there), with the branch state."""
    m = _module(module_id)
    rec = ontology._read(_bpath(branch_id, module_id))
    state = _branch_state(module_id, branch_id, rec)
    snap = rec["module"] if rec else _snapshot(m)
    return {**m, **snap, **_access_info(m), "branch": state}


@router.put("/modules/{module_id}/branches/{branch_id}")
def save_on_branch(module_id: str, branch_id: str, req: ModuleIn) -> dict:
    """Save to a branch (an open global branch): main is not changed; reviews of earlier changes need a fresh look."""
    m = _module(module_id, "editor")
    gb = _global_branch(branch_id)
    if gb["status"] != "open":
        raise HTTPException(400, f"the branch is {gb['status']}")
    path = _bpath(branch_id, module_id)
    with _hist_lock:
        rec = ontology._read(path) or {"base": _snapshot(m), "module": _snapshot(m), "reviews": {}, "status": "open"}
        if rec.get("status") == "merged":
            rec = {"base": _snapshot(m), "module": _snapshot(m), "reviews": {}, "status": "open"}
        changes = req.model_dump(exclude_unset=True)
        changes.pop("version_note", None)
        changes.pop("folder_id", None)
        snap = dict(rec["module"])
        for k, v in changes.items():
            if v is not None and k in FIELDS:
                snap[k] = v
        _check({**m, **snap})
        rec.update(module=snap, by=_who(), updated_at=ontology._now(), reviews={})
        ontology._write(path, rec)
    return module_on_branch(module_id, branch_id)


class RebaseIn(BaseModel):
    # per conflicting unit: "main", "branch" or {"custom": value}; keep_branch: reject every change from main
    resolutions: dict[str, Any] = {}
    keep_branch: bool = False
    preview: bool = False


@router.post("/modules/{module_id}/branches/{branch_id}/rebase")
def rebase_on_branch(module_id: str, branch_id: str, req: RebaseIn) -> dict:
    """Apply the branch's changes on top of main's latest version. Non-conflicting changes from main come in; each
    conflict (the same unit changed on both) takes main's, the branch's or a custom version."""
    m = _module(module_id, "editor")
    path = _bpath(branch_id, module_id)
    rec = ontology._read(path)
    if not rec:
        raise HTTPException(404, "the module has no changes on this branch")
    main = _snapshot(m)
    merged, conflicts = _three_way(rec["base"], main, rec["module"])
    if req.keep_branch:
        merged = _units(rec["module"])
        conflicts = []
    open_conflicts = []
    for c in conflicts:
        r = req.resolutions.get(c["unit"])
        if r == "main":
            merged[c["unit"]] = c["main"]
        elif r == "branch":
            merged[c["unit"]] = c["branch"]
        elif isinstance(r, dict) and "custom" in r:
            merged[c["unit"]] = r["custom"]
        else:
            open_conflicts.append(c)
    result = _from_units(merged, [rec["module"], main])
    if req.preview or open_conflicts:
        return {"done": False, "conflicts": open_conflicts, "preview": result, "incoming": _changes(rec["base"], main)}
    _check({**m, **result})
    with _hist_lock:
        rec.update(base=main, module={**rec["module"], **result}, rebased_at=ontology._now(), reviews={}, by=_who())
        ontology._write(path, rec)
    return {"done": True, "conflicts": [], "module": module_on_branch(module_id, branch_id)}


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = Field("", max_length=2000)


@router.post("/modules/{module_id}/branches/{branch_id}/review")
def review_on_branch(module_id: str, branch_id: str, req: ReviewIn) -> dict:
    """Approve or reject the module's changes on the branch. An approval counts when the reviewer edits the module and
    is not the one who made the changes (administrators may approve their own changes)."""
    m = _module(module_id)
    path = _bpath(branch_id, module_id)
    import auth

    me = auth.current() or {}
    who = _who() or "anonymous"
    with _hist_lock:
        rec = ontology._read(path)
        if not rec:
            raise HTTPException(404, "the module has no changes on this branch")
        counts = _access_info(m)["can_edit"] and (rec.get("by") != who or me.get("role") == "admin" or not auth.enabled())
        rec.setdefault("reviews", {})[who] = {"decision": req.decision, "comment": req.comment, "at": ontology._now(), "counts": bool(counts)}
        ontology._write(path, rec)
    return _branch_state(module_id, branch_id)


def _merge_into_main(module_id: str, branch_id: str, rec: dict, note: str) -> dict:
    m = ontology._read(_path(module_id)) or {}
    before = _snapshot(m)
    m.update({k: v for k, v in rec["module"].items() if k in FIELDS})
    m["updated_at"] = ontology._now()
    vs = _versions(module_id)
    n = (vs[-1]["version"] if vs else 0) + 1
    vs.append({"version": n, "at": m["updated_at"], "by": _who(), "note": note, "summary": _summary_of_change(before, _snapshot(m)), "snapshot": _snapshot(m)})
    ontology._write(_vpath(module_id), vs[-100:])
    m["latest_version"] = n
    if (m.get("settings") or {}).get("auto_publish", True):
        m["published_version"] = n
    ontology._write(_path(module_id), m)
    rec.update(status="merged", merged_at=ontology._now(), merged_by=_who(), merged_version=n)
    ontology._write(_bpath(branch_id, module_id), rec)
    return m


@router.post("/modules/{module_id}/branches/{branch_id}/merge")
def merge_on_branch(module_id: str, branch_id: str) -> dict:
    """Merge the module's branch version into main: no rebase pending, approved, not rejected."""
    _module(module_id, "editor")
    rec = ontology._read(_bpath(branch_id, module_id))
    if not rec or rec.get("status") == "merged":
        raise HTTPException(400, "nothing to merge")
    st = _branch_state(module_id, branch_id, rec)
    if st["rebase_needed"]:
        raise HTTPException(400, "main changed since the branch: rebase first")
    if not st["approved"]:
        raise HTTPException(400, "the changes need an approval (and no rejection) first")
    with _hist_lock:
        _merge_into_main(module_id, branch_id, rec, f"Merged from branch {st['branch_name']}")
    return module_on_branch(module_id, branch_id)


def _on_branch_merged(branch_id: str) -> list[str]:
    """A global branch merged: its approved, rebased module changes merge into main too."""
    done = []
    d = DIR / "branches" / branch_id
    for f in d.glob("*.json") if d.exists() else []:
        rec = ontology._read(f) or {}
        mid = f.stem
        main = ontology._read(_path(mid))
        if not rec or rec.get("status") == "merged" or not main:
            continue
        reviews = (rec.get("reviews") or {}).values()
        ok_ = any(r["decision"] == "approve" and r.get("counts") for r in reviews) and not any(r["decision"] == "reject" for r in reviews)
        if ok_ and _same(_units(_snapshot(main)), _units(rec["base"])):
            with _hist_lock:
                _merge_into_main(mid, branch_id, rec, "Merged with the global branch")
            done.append(mid)
        else:
            rec["status"] = "not merged (" + ("rebase needed" if ok_ else "not approved") + ")"
            ontology._write(f, rec)
    return done


def _install_merge_hook() -> None:
    prev = ontology.MODEL_HOOKS.get("branch_merged")
    if prev is not None and (getattr(prev, "_workshop_merge", False) or _hook_in_chain_attr(prev, "_workshop_merge")):
        return

    def hook(branch_id: str) -> Any:
        res = prev(branch_id) if prev else None
        try:
            _on_branch_merged(branch_id)
        except Exception:  # noqa: BLE001 - module merges never break a branch merge
            pass
        return res

    hook._workshop_merge = True  # type: ignore[attr-defined]
    ontology.MODEL_HOOKS["branch_merged"] = hook


def _hook_in_chain_attr(h: Any, attr: str, depth: int = 0) -> bool:
    if h is None or depth > 8:
        return False
    if getattr(h, attr, False):
        return True
    cells = []
    for c in getattr(h, "__closure__", None) or []:
        try:
            cells.append(c.cell_contents)
        except ValueError:
            pass
    return any(callable(x) and _hook_in_chain_attr(x, attr, depth + 1) for x in cells)


# ------------------------------------------------------------------------------------------------
# Marketplace packaging: the packaging linter (dependencies and what blocks packaging), a product package (the module
# with its dependencies and installation parameters) and installing a package (inputs, dependency mapping)
# ------------------------------------------------------------------------------------------------

_REF = {
    "object_type": re.compile(r"\bot-[0-9a-f]{12}\b"),
    "action_type": re.compile(r"\bact-[0-9a-f]{12}\b"),
    "link_type": re.compile(r"\blt-[0-9a-f]{12}\b"),
    "logic": re.compile(r"\blogic-[0-9a-f]{12}\b"),
    "agent": re.compile(r"\bagent-[0-9a-f]{12}\b"),
    "module": re.compile(r"\bwsm-[0-9a-f]{12}\b"),
    "function": re.compile(r"\bfn-[0-9a-f]{12}\b"),
}


def _dependencies(m: dict) -> dict[str, list[str]]:
    text = json.dumps(_snapshot(m))
    out = {k: sorted(set(rx.findall(text)) - ({m["id"]} if k == "module" else set())) for k, rx in _REF.items()}
    out["dataset"] = sorted({w["config"]["source"]["id"] for w in m.get("widgets") or [] if (w.get("config") or {}).get("source", {}).get("kind") == "dataset"})
    out["custom_widget"] = sorted({str(w["config"].get("widget_set_id") or w["config"].get("set_id") or w["id"]) for w in m.get("widgets") or [] if w.get("type") == "custom"})
    return out


def _exists(kind: str, rid: str) -> bool:
    try:
        if kind == "object_type":
            ontology._object_type(rid)
        elif kind == "action_type":
            ontology._action_type(rid)
        elif kind == "link_type":
            ontology._get("link-types", rid, "link type")
        elif kind == "logic":
            ontology._get("logic", rid, "logic function")
        elif kind == "module":
            return _path(rid).exists()
        elif kind == "dataset":
            return bool(db.drive_get(rid)) if db.enabled() else True
        return True
    except HTTPException:
        return False


@router.get("/modules/{module_id}/lint")
def lint(module_id: str) -> dict:
    """What packaging this module needs (its dependencies) and what blocks it: references to deleted object types,
    action types or properties, embedded modules that are gone; warnings for what DevOps cannot detect."""
    m = _module(module_id)
    deps = _dependencies(m)
    errors, warnings = [], []
    for kind, ids in deps.items():
        for rid in ids:
            if kind not in ("custom_widget", "function", "agent") and not _exists(kind, rid):
                errors.append({"kind": kind, "id": rid, "message": f"the {kind.replace('_', ' ')} {rid} no longer exists: replace or remove the reference"})
    # properties of object type sources that no longer exist
    for w in m.get("widgets") or []:
        src = (w.get("config") or {}).get("source") or {}
        if src.get("kind") != "object_type" or not _exists("object_type", src.get("id", "")):
            continue
        props = {p["api_name"] for p in ontology._object_type(src["id"])["properties"]}
        derived = {d.get("name") for d in m.get("derived") or []} | {d.get("name") for d in (w["config"].get("derived") or [])}
        for col in [*(w["config"].get("columns") or []), *[f.get("column") for f in w["config"].get("filters") or []], w["config"].get("group_by"), w["config"].get("metric_column")]:
            if col and col not in props and col not in derived and col not in ("__pk", "__link", "__keyword"):
                errors.append({"kind": "property", "id": f"{src['id']}.{col}", "message": f"widget {w.get('title') or w['id']}: the property {col} does not exist on its object type"})
    for w in m.get("widgets") or []:
        if w.get("type") == "custom":
            warnings.append({"kind": "custom_widget", "id": w["id"], "message": "custom widgets must be packaged with their widget set"})
        wc = w.get("config") or {}
        # a Files and Projects Resource List names Files resources (static items, folders, thumbnails, tags) that
        # packaging does not detect (Foundry's Resource List does not either): mapped by hand at installation
        if w.get("type") == "resource_list" and (wc.get("list_type") or "files") == "files":
            content = wc.get("list_content") or "static"
            named = [it.get("id") for it in wc.get("resource_items") or [] if it.get("id")] if content in ("static", "folder") else []
            thumbs = [it.get("thumbnail") for it in wc.get("resource_items") or [] if it.get("thumbnail")]
            if named or thumbs or (content == "tags" and wc.get("resource_tags")):
                what = ", ".join(x for x in [f"{len(named)} {'folder' if content == 'folder' else 'item'}{'s' if len(named) != 1 else ''}" if named else "",
                                             f"{len(thumbs)} thumbnail{'s' if len(thumbs) != 1 else ''}" if thumbs else "",
                                             f"{len(wc.get('resource_tags') or [])} tag{'s' if len(wc.get('resource_tags') or []) != 1 else ''}" if content == "tags" and wc.get("resource_tags") else ""] if x)
                warnings.append({"kind": "resource_list", "id": w["id"], "message": f"widget {w.get('title') or w['id']}: Resource List Files resources ({what}) are not detected as inputs: configure them at installation"})
            gone = [x for x in [*named, *thumbs] if db.enabled() and not db.drive_get(x)]
            for x in dict.fromkeys(gone):
                errors.append({"kind": "file", "id": x, "message": f"widget {w.get('title') or w['id']}: the Files resource {x} no longer exists: choose another or remove it"})
        if w.get("type") == "media_uploader" and wc.get("upload_target") == "media_set":
            import media_sets
            ms = media_sets.get(wc.get("media_set")) if wc.get("media_set") else None
            if wc.get("media_set") and not ms:
                errors.append({"kind": "media_set", "id": wc["media_set"], "message": f"widget {w.get('title') or w['id']}: the media set {wc['media_set']} no longer exists: choose another"})
            elif not wc.get("media_set") and not wc.get("media_set_variable"):
                warnings.append({"kind": "media_uploader", "id": w["id"], "message": f"widget {w.get('title') or w['id']}: uploads to a media set but none is chosen"})
            elif ms and ms.get("virtual"):
                errors.append({"kind": "media_set", "id": wc["media_set"], "message": f"widget {w.get('title') or w['id']}: the media set {wc['media_set']} is virtual (it reads its items from its source)"})
            else:
                warnings.append({"kind": "media_uploader", "id": w["id"], "message": "Media Uploader media sets are not detected as inputs: configure them at installation"})
    params = ((m.get("settings") or {}).get("installation") or {}).get("parameters") or []
    names = {v["name"] for v in m.get("variables") or []}
    for prm in params:
        if prm.get("variable") and prm["variable"] not in names:
            errors.append({"kind": "parameter", "id": prm.get("name", ""), "message": f"installation parameter {prm.get('name')}: variable {prm['variable']} is gone"})
    return {"dependencies": deps, "errors": errors, "warnings": warnings, "packageable": not errors}


@router.get("/modules/{module_id}/package")
def package(module_id: str) -> dict:
    """A Marketplace product with this module: its configuration, dependencies (to map at installation) and
    installation parameters. Refused while the linter finds errors."""
    m = _module(module_id)
    lt = lint(module_id)
    if lt["errors"]:
        raise HTTPException(400, "fix the packaging errors first: " + "; ".join(e["message"] for e in lt["errors"][:3]))
    names = {}
    for kind, ids in lt["dependencies"].items():
        for rid in ids:
            try:
                names[rid] = (ontology._object_type(rid)["display_name"] if kind == "object_type" else ontology._action_type(rid)["display_name"] if kind == "action_type"
                              else (ontology._read(_path(rid)) or {}).get("name") if kind == "module" else rid)
            except HTTPException:
                names[rid] = rid
    return {"kind": "bluesandai.workshop.product", "version": 1, "name": m["name"], "description": m.get("description", ""), "packaged_at": ontology._now(),
            "packaged_by": _who(), "module": _snapshot(m), "dependencies": lt["dependencies"], "names": names,
            "parameters": ((m.get("settings") or {}).get("installation") or {}).get("parameters") or []}


class InstallIn(BaseModel):
    package: dict
    folder_id: Optional[str] = None
    name: Optional[str] = None
    # installation inputs: parameter name → value; dependency mapping: packaged id → id in this environment
    inputs: dict[str, Any] = {}
    mapping: dict[str, str] = {}


@router.post("/install")
def install(req: InstallIn) -> dict:
    """Install a packaged module: a new module in the chosen folder, its dependencies mapped (ids replaced), the
    installation parameters' values as the defaults of their variables."""
    pk = req.package
    if pk.get("kind") != "bluesandai.workshop.product" or not isinstance(pk.get("module"), dict):
        raise HTTPException(400, "not a Workshop product package")
    text = json.dumps(pk["module"])
    for src, dst in req.mapping.items():
        if dst and re.fullmatch(r"[A-Za-z0-9_.-]+", src) and re.fullmatch(r"[A-Za-z0-9_.-]+", dst):
            text = re.sub(rf"\b{re.escape(src)}\b", dst, text)
    snap = json.loads(text)
    missing = [f"{k} {rid}" for k, ids in (pk.get("dependencies") or {}).items() for rid in ids
               if k in ("object_type", "action_type", "link_type", "logic", "module") and not _exists(k, req.mapping.get(rid) or rid)]
    if missing:
        raise HTTPException(400, "map these dependencies to resources here: " + ", ".join(missing[:6]))
    params = {prm["name"]: prm for prm in pk.get("parameters") or []}
    for v in snap.get("variables") or []:
        for name, prm in params.items():
            if prm.get("variable") == v["name"]:
                val = req.inputs.get(name, prm.get("default"))
                v["default"] = (str(val).lower() in ("true", "1", "yes")) if prm.get("type") == "boolean" else val
    now = ontology._now()
    m = {**{k: snap.get(k) for k in FIELDS if k in snap}, "id": ontology._new_id("wsm"), "name": (req.name or pk.get("name") or "Installed module").strip(),
         "created_at": now, "updated_at": now, "created_by": _who(), "installed_from": {"name": pk.get("name"), "packaged_at": pk.get("packaged_at")}}
    m["settings"] = {**(m.get("settings") or {}), "protected": False}
    _check(m)
    item = _new_item(req.folder_id, m)
    if item:
        m["item_id"] = item["id"]
    ontology._write(_path(m["id"]), m)
    return {**m, **_access_info(m)}


@router.get("/modules/{module_id}")
def get_module(module_id: str, count: bool = True, version: Optional[int] = None, published: bool = False) -> dict:
    """The module (its latest saved state), a saved version, or (published=true) the published version for viewers."""
    m = _module(module_id)
    access = _access_info(m)
    pub = m.get("published_version")
    want = version or (pub if published and pub and not (m.get("settings") or {}).get("auto_publish", True) else None)
    if want:
        h = next((x for x in _versions(module_id) if x["version"] == want), None)
        if not h:
            raise HTTPException(404, "version not found")
        m = {**m, **h["snapshot"], "showing_version": want}
    if count:
        # Workflow Lineage's weekly views (view and edit mode alike)
        try:
            import workflow_lineage

            workflow_lineage.note_view(module_id)
        except Exception:  # noqa: BLE001
            pass
    return {**m, **access}


@router.put("/modules/{module_id}")
def save_module(module_id: str, req: ModuleIn) -> dict:
    m = _module(module_id, "editor")
    if (m.get("settings") or {}).get("protected") and not (req.settings or {}).get("protected") is False:
        raise HTTPException(409, "this module is protected: save it to a branch and merge it with an approved proposal")
    before = _snapshot(m)
    changes = req.model_dump(exclude_unset=True)
    note = changes.pop("version_note", None)
    changes.pop("folder_id", None)
    renamed = "name" in changes and changes["name"] and changes["name"].strip() != m.get("name")
    for k, v in changes.items():
        if v is not None:
            m[k] = v.strip() if isinstance(v, str) and k == "name" else v
    _check(m)
    m["updated_at"] = ontology._now()
    # every save is a version; with auto publish (the default) the latest version is what viewers see
    vs = _versions(module_id)
    n = (vs[-1]["version"] if vs else 0) + 1
    if not vs:
        vs.append({"version": n, "at": m.get("created_at") or m["updated_at"], "by": None, "note": "Before versioning", "summary": "Created", "snapshot": before})
        n += 1
    me = _who()
    vs.append({"version": n, "at": m["updated_at"], "by": me, "note": note or "", "summary": _summary_of_change(before, _snapshot(m)), "snapshot": _snapshot(m)})
    vs = vs[-100:]
    ontology._write(_vpath(module_id), vs)
    m["latest_version"] = n
    if (m.get("settings") or {}).get("auto_publish", True):
        m["published_version"] = n
    ontology._write(_path(module_id), m)
    if renamed and m.get("item_id"):
        try:
            drive.update_item(m["item_id"], drive.ItemChange(name=drive._clean_name(f"{m['name']}.workshop")))
        except HTTPException:
            pass  # the name is taken in the folder: the module keeps its new name, the item its old one
    return {**m, **_access_info(m)}


def _who() -> Optional[str]:
    try:
        import auth

        u = auth.current() or {}
        return u.get("display_name") or u.get("username")
    except Exception:  # noqa: BLE001
        return None


@router.get("/modules/{module_id}/versions")
def module_versions(module_id: str) -> list[dict]:
    """The changelog: every saved version with what changed (newest first)."""
    _module(module_id)
    return [{k: v for k, v in x.items() if k != "snapshot"} for x in reversed(_versions(module_id))]


class SqlIn(BaseModel):
    query: str = Field(min_length=1, max_length=100_000)
    # alias → object type id (each becomes a table)
    tables: dict[str, str] = Field(default_factory=dict)
    # alias → value (each becomes a parameter)
    params: dict[str, Any] = Field(default_factory=dict)
    limit: int = 10_000


def _sql_literal(v: Any) -> tuple[str, str]:
    if isinstance(v, bool):
        return "BOOLEAN", "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return "BIGINT", str(v)
    if isinstance(v, float):
        return "DOUBLE", repr(v)
    if v is None:
        return "STRING", "NULL"
    return "STRING", "'" + str(v).replace("'", "''") + "'"


# ------------------------------------------------------------------------------------------------
# user edit history (the Edit History widget): per object type, once tracking is on, every edit's changed
# properties with their value before and after, who made it and when; an append-only log
# ------------------------------------------------------------------------------------------------

MAX_CHANGES = 20_000
_hist_lock = threading.Lock()


def _hist_path(type_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", type_id):
        raise HTTPException(404, "object type not found")
    return DIR / "edit-history" / f"{type_id}.json"


def _on_edits(written: list[dict]) -> None:
    by_type: dict[str, list[dict]] = {}
    for w in written or []:
        if w.get("object_type_id"):
            by_type.setdefault(str(w["object_type_id"]), []).append(w)
    if not by_type:
        return
    who = _who() or "system"
    now = ontology._now()
    for tid, ws in by_type.items():
        path = DIR / "edit-history" / f"{tid}.json"
        if not path.exists():
            continue
        with _hist_lock:
            h = ontology._read(path) or {}
            if not h.get("enabled"):
                continue
            snap = h.setdefault("snapshot", {})
            changes = h.setdefault("changes", [])
            # the stored values (written objects are as the editor sees them: hidden properties read as null)
            stored = ontology.stored_objects(tid)
            for w in ws:
                pk = str(w.get("primary_key"))
                after = (stored.get(pk) or {}).get("properties") or w.get("properties") or {}
                before = snap.get(pk) or {}
                op = w.get("op") or "modify"
                if op == "delete":
                    changes.append({"at": now, "user": who, "primary_key": pk, "op": "delete", "property": None, "before": None, "after": None})
                    snap.pop(pk, None)
                    continue
                for k in sorted(set(after) | set(before)):
                    if k.endswith("Embedding") or isinstance(after.get(k), list) and len(after.get(k) or []) > 64:
                        continue  # vectors and long arrays are not user edits worth showing
                    a, b = after.get(k), before.get(k)
                    if json.dumps(a, default=str, sort_keys=True) != json.dumps(b, default=str, sort_keys=True) and k in after:
                        changes.append({"at": now, "user": who, "primary_key": pk, "op": op, "property": k, "before": b, "after": a})
                snap[pk] = {**before, **after}
            h["changes"] = changes[-MAX_CHANGES:]
            ontology._write(path, h)


def _hook_in_chain(h: Any, depth: int = 0) -> bool:
    if h is None or depth > 8:
        return False
    if getattr(h, "_workshop_history", False):
        return True
    cells = []
    for c in getattr(h, "__closure__", None) or []:
        try:
            cells.append(c.cell_contents)
        except ValueError:
            pass
    return any(callable(x) and _hook_in_chain(x, depth + 1) for x in cells)


def _install_edit_hook() -> None:
    """Chain into ontology.MODEL_HOOKS["edits"] (re-run from a thread: some modules set that slot without chaining)."""
    prev = ontology.MODEL_HOOKS.get("edits")
    if _hook_in_chain(prev):
        return

    def hook(written: list[dict]) -> Any:
        res = prev(written) if prev else None
        try:
            _on_edits(written)
        except Exception:  # noqa: BLE001 - history never breaks an edit
            pass
        return res

    hook._workshop_history = True  # type: ignore[attr-defined]
    ontology.MODEL_HOOKS["edits"] = hook


def _rehook() -> None:
    import time

    while True:
        time.sleep(30)
        try:
            _install_edit_hook()
            _install_merge_hook()
        except Exception:  # noqa: BLE001
            pass


class TrackingIn(BaseModel):
    enabled: bool


@router.put("/edit-history/{type_id}")
def set_tracking(type_id: str, req: TrackingIn) -> dict:
    """Turn user edit history on or off for an object type. Turning it on takes the current values as the baseline
    (edits before that are not in the history); the recorded changes stay when it is turned off."""
    t = ontology._object_type(type_id)
    ontology.auth.check_resource("object_type", type_id)
    with _hist_lock:
        h = ontology._read(_hist_path(type_id)) or {"changes": []}
        if req.enabled and not h.get("enabled"):
            h["snapshot"] = {pk: o.get("properties", {}) for pk, o in ontology.stored_objects(type_id).items()}
            h["since"] = ontology._now()
        h["enabled"] = req.enabled
        ontology._write(_hist_path(type_id), h)
    return {"object_type_id": t["id"], "enabled": req.enabled, "since": h.get("since")}


@router.get("/edit-history/{type_id}/{pk}")
def edit_history(type_id: str, pk: str, order: Literal["newest", "oldest"] = "newest") -> dict:
    ontology.get_object(type_id, pk)  # the object must be visible
    h = ontology._read(_hist_path(type_id)) or {}
    t = ontology._object_type(type_id)
    hidden = set(MODEL_HOOKS_HIDDEN(t, pk))
    mine = [{**c, **({"before": None, "after": None} if c.get("property") in hidden else {})} for c in h.get("changes", []) if c["primary_key"] == str(pk)]
    if order == "newest":
        mine.reverse()
    return {"enabled": bool(h.get("enabled")), "since": h.get("since"), "changes": mine[:500]}


def MODEL_HOOKS_HIDDEN(t: dict, pk: str) -> list[str]:
    """Properties the user may not see on this object (property security policies): their values stay hidden here too."""
    try:
        o = ontology.stored_objects(t["id"]).get(str(pk))
        if o is not None and t.get("security") and "property_policy" in ontology.MODEL_HOOKS:
            return list(ontology.MODEL_HOOKS["property_policy"](t, o))
    except Exception:  # noqa: BLE001
        pass
    return []


# ------------------------------------------------------------------------------------------------
# resources linked to objects (the Linked Compass Resources widget): Files items per object
# ------------------------------------------------------------------------------------------------


def _links_path(type_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", type_id):
        raise HTTPException(404, "object type not found")
    return DIR / "resource-links" / f"{type_id}.json"


def _item_meta(item_id: str) -> Optional[dict]:
    try:
        it = drive._item(item_id)
    except HTTPException:
        return None
    return {"id": it["id"], "name": it["name"], "kind": it["kind"], "content_type": it.get("content_type"),
            "size": it.get("size_bytes", it.get("size")), "updated_at": it.get("updated_at"), "trashed": bool(it.get("trashed_at"))}


@router.get("/resource-links/{type_id}/{pk}")
def resource_links(type_id: str, pk: str) -> list[dict]:
    ontology.get_object(type_id, pk)
    ids = (ontology._read(_links_path(type_id)) or {}).get(str(pk), [])
    # only the items this user may open
    return [m for i in ids if (m := _item_meta(i)) and not m["trashed"]]


class LinkResourceIn(BaseModel):
    item_id: str


@router.post("/resource-links/{type_id}/{pk}")
def link_resource(type_id: str, pk: str, req: LinkResourceIn) -> list[dict]:
    ontology.get_object(type_id, pk)
    if not _item_meta(req.item_id):
        raise HTTPException(404, "file not found")
    with _hist_lock:
        data = ontology._read(_links_path(type_id)) or {}
        ids = data.setdefault(str(pk), [])
        if req.item_id not in ids:
            ids.append(req.item_id)
        ontology._write(_links_path(type_id), data)
    return resource_links(type_id, pk)


@router.delete("/resource-links/{type_id}/{pk}/{item_id}")
def unlink_resource(type_id: str, pk: str, item_id: str) -> list[dict]:
    ontology.get_object(type_id, pk)
    with _hist_lock:
        data = ontology._read(_links_path(type_id)) or {}
        data[str(pk)] = [i for i in data.get(str(pk), []) if i != item_id]
        ontology._write(_links_path(type_id), data)
    return resource_links(type_id, pk)


# ------------------------------------------------------------------------------------------------
# media for the PDF Viewer and Video Display widgets: a media reference (a media set item) or a Files item
# ------------------------------------------------------------------------------------------------


def _media(ref: str) -> tuple[bytes, str, str]:
    """(bytes, name, content type) of a media reference or a Files item, with the caller's permissions."""
    rid = ref.split("#")[0]
    import media_sets

    try:
        data, path, ct, _ = media_sets.resolve(rid)
        return data, path, ct
    except HTTPException:
        item = drive._item(rid)
        return drive.read_bytes(item), item["name"], item.get("content_type") or "application/octet-stream"


def _pdf(ref: str):
    import pypdfium2 as pdfium

    data, _, _ = _media(ref)
    if data[:5] != b"%PDF-":
        raise HTTPException(400, "not a PDF")
    return pdfium.PdfDocument(data)


@router.get("/pdf/{ref}")
def pdf_info(ref: str) -> dict:
    pdf = _pdf(ref)
    return {"pages": len(pdf), "sizes": [list(pdf[i].get_size()) for i in range(len(pdf))]}


@router.get("/pdf/{ref}/page/{n}")
def pdf_page(ref: str, n: int, scale: float = 1.5) -> Response:
    """One page as a PNG (zero-based page number)."""
    pdf = _pdf(ref)
    if not 0 <= n < len(pdf):
        raise HTTPException(404, "no such page")
    buf = io.BytesIO()
    pdf[n].render(scale=max(0.5, min(scale, 4.0))).to_pil().save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png", headers={"cache-control": "private, max-age=300"})


@router.get("/pdf/{ref}/search")
def pdf_search(ref: str, q: str) -> list[dict]:
    """Keyword matches: per match its page and boxes (fractions of the page, from the top left), one box per line."""
    q = q.strip()
    if not q:
        return []
    pdf = _pdf(ref)
    out = []
    for n in range(len(pdf)):
        page = pdf[n]
        w, h = page.get_size()
        tp = page.get_textpage()
        searcher = tp.search(q, match_case=False, match_whole_word=False)
        while (hit := searcher.get_next()) is not None:
            start, count = hit
            lines: list[list[float]] = []
            for i in range(start, start + count):
                l, b, r, t = tp.get_charbox(i)
                if r <= l:
                    continue
                cur = lines[-1] if lines else None
                if cur and abs(cur[1] - b) < (t - b) * 0.6:
                    cur[0], cur[2], cur[3] = min(cur[0], l), max(cur[2], r), max(cur[3], t)
                    cur[1] = min(cur[1], b)
                else:
                    lines.append([l, b, r, t])
            out.append({"page": n, "boxes": [{"x": l / w, "y": 1 - t / h, "w": (r - l) / w, "h": (t - b) / h} for l, b, r, t in lines]})
            if len(out) >= 500:
                return out
    return out


class LocateIn(BaseModel):
    text: str = Field(max_length=100_000)


def _line_boxes(tp, idxs: list[int], w: float, h: float) -> list[dict]:
    """Boxes (fractions of the page, from the top left) of characters, one box per line."""
    lines: list[list[float]] = []
    for i in idxs:
        l, b, r, t = tp.get_charbox(i)
        if r <= l:
            continue
        cur = lines[-1] if lines else None
        lh = max(cur[3] - cur[1], t - b) if cur else 0
        # the same line: the character's middle within the line's height (punctuation is small), not back at its start
        if cur and cur[1] - lh * 0.5 <= (b + t) / 2 <= cur[3] + lh * 0.5 and l >= cur[0] - lh:
            cur[0], cur[2], cur[3] = min(cur[0], l), max(cur[2], r), max(cur[3], t)
            cur[1] = min(cur[1], b)
        else:
            lines.append([l, b, r, t])
    return [{"x": l / w, "y": 1 - t / h, "w": (r - l) / w, "h": (t - b) / h} for l, b, r, t in lines]


@router.post("/pdf/{ref}/locate")
def pdf_locate(ref: str, req: LocateIn) -> dict:
    """Where a passage (a semantic search chunk) is in the PDF's text layer: matched ignoring case and whitespace, across
    pages; when the whole passage is not found (text extracted differently), the longest found start of it, else its
    longest found end. Per page its boxes; `matched` is the share of the passage found."""
    norm_needle = re.sub(r"\s+", " ", req.text).strip().lower()
    if not norm_needle:
        return {"pages": [], "matched": 0.0}
    pdf = _pdf(ref)
    chars: list[str] = []
    where: list[tuple[int, int]] = []
    pages = []
    for n in range(len(pdf)):
        page = pdf[n]
        tp = page.get_textpage()
        pages.append((tp, *page.get_size()))
        count = tp.count_chars()
        text = tp.get_text_range(0, count) if count else ""
        if len(text) != count:  # pdfium added characters: read them one by one
            text = "".join(tp.get_text_range(i, 1) or " " for i in range(count))
        for i, ch in enumerate(text):
            if ch.isspace() or ch == "\x00":
                if chars and chars[-1] != " ":
                    chars.append(" ")
                    where.append((n, -1))
            else:
                chars.append(ch.lower())
                where.append((n, i))
        if chars and chars[-1] != " ":
            chars.append(" ")
            where.append((n, -1))
    hay = "".join(chars)

    def find(s: str) -> int:
        return hay.find(s) if len(s) >= 12 or s == norm_needle else -1

    start, length = find(norm_needle), len(norm_needle)
    if start < 0:
        # the longest start of the passage that is found (binary search on its length), else the longest end
        best = (-1, 0)
        for from_end in (False, True):
            lo, hi = 12, len(norm_needle)
            while lo <= hi:
                mid = (lo + hi) // 2
                part = norm_needle[-mid:] if from_end else norm_needle[:mid]
                at = find(part)
                if at >= 0:
                    if mid > best[1]:
                        best = (at, mid)
                    lo = mid + 1
                else:
                    hi = mid - 1
            if best[1] >= len(norm_needle) * 0.3:
                break
        start, length = best
    if start < 0:
        return {"pages": [], "matched": 0.0}
    by_page: dict[int, list[int]] = {}
    for n, i in where[start:start + length]:
        if i >= 0:
            by_page.setdefault(n, []).append(i)
    out = []
    for n, idxs in sorted(by_page.items()):
        tp, w, h = pages[n]
        out.append({"page": n, "boxes": _line_boxes(tp, idxs, w, h)})
    return {"pages": out, "matched": round(length / len(norm_needle), 3)}


def _page_text(tp) -> str:
    """A text page's characters, one per pdfium character index (so offsets into it are pdfium's)."""
    count = tp.count_chars()
    text = tp.get_text_range(0, count) if count else ""
    if len(text) != count:  # pdfium added characters: read them one by one
        text = "".join(tp.get_text_range(i, 1) or " " for i in range(count))
    return text


def _text_page(ref: str, n: int):
    pdf = _pdf(ref)
    if not 0 <= n < len(pdf):
        raise HTTPException(404, "no such page")
    page = pdf[n]
    tp = page.get_textpage()
    return tp, _page_text(tp), *page.get_size()


@router.get("/pdf/{ref}/text/{n}")
def pdf_text(ref: str, n: int) -> dict:
    """A page's text layer for selecting text spans (annotations): the page text (offsets are pdfium character indices)
    and its runs — consecutive characters on one line, [s, e) offsets and their box as fractions of the page from the
    top left. Characters without a box (generated spaces and line breaks) end a run and are not drawn."""
    tp, text, w, h = _text_page(ref, n)
    runs: list[dict] = []
    cur: Optional[dict] = None
    for i, ch in enumerate(text):
        l, b, r, t = tp.get_charbox(i)
        if r <= l or t <= b or ch in "\r\n\x00":
            cur = None
            continue
        if cur:
            lh = max(cur["t"] - cur["b"], t - b)
            same = cur["e"] == i and cur["b"] - lh * 0.5 <= (b + t) / 2 <= cur["t"] + lh * 0.5 and l >= cur["l"] - lh
            if same:
                cur.update(e=i + 1, l=min(cur["l"], l), b=min(cur["b"], b), r=max(cur["r"], r), t=max(cur["t"], t))
                continue
        cur = {"s": i, "e": i + 1, "l": l, "b": b, "r": r, "t": t}
        runs.append(cur)
    return {"page": n, "text": text, "runs": [{"s": x["s"], "e": x["e"], "x": x["l"] / w, "y": 1 - x["t"] / h, "w": (x["r"] - x["l"]) / w,
                                               "h": (x["t"] - x["b"]) / h} for x in runs]}


@router.get("/pdf/{ref}/span")
def pdf_span(ref: str, page: int, start: int, end: int) -> dict:
    """A text span on a page ([start, end) character offsets of /text): its quoted text (whitespace collapsed) and its
    boxes, one per line, as fractions of the page from the top left — what a text-span annotation stores."""
    tp, text, w, h = _text_page(ref, page)
    if not 0 <= start < end <= len(text):
        raise HTTPException(400, f"the span must be within the page's {len(text)} characters")
    if end - start > 20_000:
        raise HTTPException(400, "the span is longer than 20000 characters")
    quote = re.sub(r"\s+", " ", text[start:end].replace("\x00", " ")).strip()
    return {"page": page, "start": start, "end": end, "quote": quote, "boxes": _line_boxes(tp, list(range(start, end)), w, h)}


_video_tmp: dict[str, str] = {}


def _video_file(ref: str) -> str:
    """A temporary copy of the video for ffmpeg (kept for the process, per reference)."""
    import tempfile

    rid = ref.split("#")[0]
    path = _video_tmp.get(rid)
    data, name, _ = _media(rid)  # also the permission check, every time
    if path and Path(path).exists():
        return path
    suffix = Path(name).suffix or ".mp4"
    fd, path = tempfile.mkstemp(prefix="ws-video-", suffix=suffix)
    with open(fd, "wb") as f:
        f.write(data)
    _video_tmp[rid] = path
    return path


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


@router.get("/video/{ref}/content")
def video_content(ref: str, request: Request) -> Response:
    """The video bytes, with byte ranges so the player can seek."""
    data, _, ct = _media(ref)
    rng = request.headers.get("range")
    if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
        start = int(m.group(1) or 0)
        end = min(int(m.group(2)) if m.group(2) else len(data) - 1, len(data) - 1)
        return Response(data[start:end + 1], status_code=206, media_type=ct,
                        headers={"content-range": f"bytes {start}-{end}/{len(data)}", "accept-ranges": "bytes"})
    return Response(data, media_type=ct, headers={"accept-ranges": "bytes"})


@router.get("/video/{ref}/info")
def video_info(ref: str) -> dict:
    import subprocess

    path = _video_file(ref)
    err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True, timeout=60).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    return {"duration": int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None}


@router.get("/video/{ref}/frame")
def video_frame(ref: str, t: float = 0) -> Response:
    """One frame at t seconds as a small JPEG (key frames under the player)."""
    import subprocess

    path = _video_file(ref)
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, t):.3f}", "-i", path, "-frames:v", "1",
                        "-vf", "scale=200:-2", "-f", "image2", "-vcodec", "mjpeg", "pipe:1"], capture_output=True, timeout=60)
    if r.returncode != 0 or not r.stdout:
        raise HTTPException(400, f"no frame at {t}s")
    return Response(r.stdout, media_type="image/jpeg", headers={"cache-control": "private, max-age=3600"})


@router.get("/video/{ref}/scenes")
def video_scenes(ref: str, sensitivity: Literal["less", "standard", "more"] = "standard") -> list[float]:
    """Times (seconds) of major scene changes, by ffmpeg's scene detection."""
    import subprocess

    path = _video_file(ref)
    th = {"less": 0.4, "standard": 0.2, "more": 0.08}[sensitivity]
    err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path, "-vf", f"select='gt(scene,{th})',showinfo", "-an", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=300).stderr
    times = [float(x) for x in re.findall(r"pts_time:([\d.]+)", err)]
    return [0.0] + [round(x, 2) for x in times if x > 0.5][:60]


# ------------------------------------------------------------------------------------------------
# the Observability Chart: executions and p95 duration of a function or an action type over time
# ------------------------------------------------------------------------------------------------


@router.get("/observability")
def observability(kind: Literal["function", "action"], id: str, metric: Literal["executions", "p95"] = "executions",
                  start: Optional[str] = None, end: Optional[str] = None) -> dict:
    from datetime import timedelta, timezone

    if kind == "action":
        import ontology_actions as oa

        rec = ontology._action_type(id)
        runs = oa._runs(id)["runs"]
        name = rec["display_name"]
    else:
        import functions_registry as fr

        rec = fr._function(id)
        runs = fr._runs(id)["runs"]
        name = rec.get("name") or rec.get("api_name") or id
    now = datetime.now(timezone.utc)
    t1 = datetime.fromisoformat(end.replace("Z", "+00:00")) if end else now
    t0 = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else t1 - timedelta(days=7)
    if t0.tzinfo is None:
        t0 = t0.replace(tzinfo=timezone.utc)
    if t1.tzinfo is None:
        t1 = t1.replace(tzinfo=timezone.utc)
    hourly = (t1 - t0) <= timedelta(days=3)
    step = timedelta(hours=1) if hourly else timedelta(days=1)
    floor = (lambda d: d.replace(minute=0, second=0, microsecond=0)) if hourly else (lambda d: d.replace(hour=0, minute=0, second=0, microsecond=0))
    buckets: dict[str, dict] = {}
    cur = floor(t0)
    while cur <= t1 and len(buckets) < 2000:
        buckets[cur.isoformat()] = {"t": cur.isoformat(), "succeeded": 0, "failed": 0, "ms": []}
        cur += step
    for r in runs:
        at = datetime.fromisoformat(str(r["at"]).replace("Z", "+00:00"))
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if not t0 <= at <= t1:
            continue
        b = buckets.get(floor(at).isoformat())
        if b is None:
            continue
        b["succeeded" if r.get("status") == "succeeded" else "failed"] += 1
        if r.get("ms") is not None:
            b["ms"].append(r["ms"])
    series = []
    for b in buckets.values():
        ms = sorted(b.pop("ms"))
        b["p95"] = ms[min(len(ms) - 1, int(round(0.95 * (len(ms) - 1))))] if ms else None
        series.append(b)
    return {"kind": kind, "id": id, "name": name, "metric": metric, "bucket": "hour" if hourly else "day", "start": t0.isoformat(), "end": t1.isoformat(), "series": series}


# ------------------------------------------------------------------------------------------------
# AIP Analyst: a question about the widget's object set → a query plan (the model) → its result (here)
# ------------------------------------------------------------------------------------------------

ANALYST_SCHEMA = {
    "type": "object",
    "properties": {
        "explanation": {"type": "string"},
        "chart": {"type": "string", "enum": ["metric", "bar", "line", "pie", "table"]},
        "group_by": {"type": "string"},
        "bucket": {"type": "string", "enum": ["none", "day", "month", "year"]},
        "metric": {"type": "string", "enum": ["count", "sum", "avg", "min", "max", "distinct"]},
        "metric_column": {"type": "string"},
        "filters": {"type": "array", "items": {"type": "object", "properties": {"column": {"type": "string"}, "op": {"type": "string"}, "value": {"type": "string"}}, "required": ["column", "op"]}},
        "columns": {"type": "array", "items": {"type": "string"}},
        "sort": {"type": "string"},
        "descending": {"type": "boolean"},
        "limit": {"type": "integer"},
    },
    "required": ["explanation", "chart", "metric"],
}


class AnalystIn(BaseModel):
    source: Source
    filters: list[Filter] = []
    filter_sets: list[FilterSet] = []
    question: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list, max_length=20)
    model: Optional[str] = None
    # the module's derived properties on this source (column math), so questions can use them
    derived: list[DerivedColumn] = []


@router.post("/analyst")
def analyst(req: AnalystIn) -> dict:
    """AIP Analyst over an object set: the model answers with a query on the set's columns (grouping, metric,
    filters, sort) and a chart kind; the query runs here with the user's permissions, so the numbers are real."""
    import pipeline_ai

    base = Query(source=req.source, filters=req.filters, filter_sets=req.filter_sets, derived=req.derived, limit=5)
    sample = query(base)
    cols = [c["name"] for c in sample["columns"]]
    types = {c["name"]: c["type"] for c in sample["columns"]}
    system = (pipeline_ai.PLATFORM + "\n\nYou are AIP Analyst inside a Workshop application. Answer the user's question about an object set by choosing ONE query "
              "over its columns, and explain the answer briefly in the user's language. Use only these columns: "
              + json.dumps(types) + ". Filter ops: eq, neq, gt, gte, lt, lte, contains, in, is_null, not_null. "
              "For a single number use chart 'metric' without group_by; for categories use 'bar' or 'pie' with group_by; for time use 'line' with "
              "group_by on a date column and a bucket; for listing objects use 'table' with columns. Sample rows: "
              + json.dumps(sample.get("rows", [])[:5], default=str)[:3000])
    convo = "\n\n".join(f"[{m.get('role', 'user')}]\n{str(m.get('content', ''))[:2000]}" for m in req.history[-8:])
    user = f"{convo}\n\n[user]\n{req.question}".strip()
    model = req.model or ontology.DEFAULT_LLM
    # the plan as a JSON object in text (schema mode often failed to parse for this shape): one call, then schema mode
    out = None
    text = str(pipeline_ai.chat(model, system + " Answer with only one JSON object with the keys " + ", ".join(ANALYST_SCHEMA["properties"])
                                + " (metric is one of count, sum, avg, min, max, distinct; chart one of metric, bar, line, pie, table).", user, None, 0, 8192))
    try:
        out = json.loads(text[text.index("{"):text.rindex("}") + 1])
        out = out.get("value", out) if isinstance(out, dict) and isinstance(out.get("value"), dict) else out
    except ValueError:
        out = pipeline_ai.chat(model, system, user, ANALYST_SCHEMA, 0, 8192)
    if not isinstance(out, dict):
        raise HTTPException(502, "the model did not answer with a query")
    group_by = out.get("group_by") or None
    if group_by and group_by not in cols:
        group_by = None
    mc = out.get("metric_column") or None
    metric = out.get("metric") or "count"
    if metric != "count" and mc not in cols:
        metric, mc = "count", None
    flt = [Filter(column=f["column"], op=f.get("op", "eq"), value=f.get("value")) for f in out.get("filters") or []
           if f.get("column") in cols and f.get("op") in ("eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null")]
    chart = out.get("chart") or ("bar" if group_by else "metric")
    q = Query(source=req.source, filters=req.filters, filter_sets=[*req.filter_sets, FilterSet(filters=flt)] if flt else req.filter_sets, derived=req.derived,
              group_by=group_by, bucket=(out.get("bucket") if out.get("bucket") in ("day", "month", "year") else None) if group_by else None, metric=metric, metric_column=mc,
              columns=[c for c in out.get("columns") or [] if c in cols] if chart == "table" else [],
              sort=out.get("sort") if out.get("sort") in (cols + ["key", "value"]) else ("key" if chart == "line" else None),
              descending=bool(out.get("descending")) if chart != "line" else False,
              limit=max(1, min(int(out.get("limit") or (50 if chart == "table" else 25)), 500)) if chart in ("table", "bar", "pie", "line") else 0)
    result = query(q)
    return {"explanation": str(out.get("explanation") or ""), "chart": chart if (group_by or chart in ("metric", "table")) else "metric",
            "query": {"group_by": q.group_by, "bucket": q.bucket, "metric": q.metric, "metric_column": q.metric_column,
                      "filters": [f.model_dump() for f in flt], "columns": q.columns, "sort": q.sort, "descending": q.descending, "limit": q.limit},
            "result": result}


# ------------------------------------------------------------------------------------------------
# Vega chart: the AIP spec generator. The author's prompt plus the widget's data inputs (names, fields and their
# types only — no rows) go to the platform's language model (functions_registry's /llm/chat); the answer must be one
# Vega-Lite v5 (or Vega v5) spec reading the inputs by name. It is checked before it is offered: JSON, a known mark,
# encoding fields that exist in the inputs (or are made by the spec's transforms), data only by input name or inline
# values — no url data sources, no links, no external addresses.
# ------------------------------------------------------------------------------------------------

VL_MARKS = {"arc", "area", "bar", "boxplot", "circle", "errorband", "errorbar", "geoshape", "image", "line", "point", "rect", "rule",
            "square", "text", "tick", "trail"}
VL_COMPOSE = ("layer", "concat", "hconcat", "vconcat")
_EXTERNAL = re.compile(r"^\s*(https?:|ftp:|file:|javascript:|data:|//)", re.I)
VEGA_SCHEMAS = {"vega-lite": "https://vega.github.io/schema/vega-lite/v5.json", "vega": "https://vega.github.io/schema/vega/v5.json"}


class VegaField(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field("string", max_length=80)


class VegaInputSchema(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field("objects", max_length=40)
    fields: list[VegaField] = Field(default_factory=list, max_length=300)


class VegaSpecIn(BaseModel):
    mode: Literal["vega-lite", "vega"] = "vega-lite"
    inputs: list[VegaInputSchema] = Field(default_factory=list, max_length=20)
    # the widget's configured selection parameter names: the spec should define them (they write the variables)
    params: list[str] = Field(default_factory=list, max_length=20)


class VegaValidateIn(VegaSpecIn):
    spec: str = Field(max_length=200_000)


class VegaGenerateIn(VegaSpecIn):
    prompt: str = Field(min_length=1, max_length=4000)
    # the spec to iterate on ("remove the gridlines…"); empty: a new chart
    current_spec: Optional[str] = Field(None, max_length=200_000)
    model: Optional[str] = None


def _vl_kind(t: str) -> str:
    t = (t or "").lower()
    if re.search(r"date|time", t):
        return "temporal"
    if re.search(r"int|long|short|byte|float|double|decimal|number|numeric", t):
        return "quantitative"
    return "nominal"


def _vega_json(text: str) -> tuple[Optional[dict], Optional[str]]:
    """The spec in a model's answer: the whole text, a ```json fence or the outermost {...}."""
    s = (text or "").strip()
    m = re.search(r"```(?:json|vega-lite|vega)?\s*(.*?)```", s, re.S | re.I)
    cands = [s] + ([m.group(1).strip()] if m else []) + ([s[s.index("{"):s.rindex("}") + 1]] if "{" in s and "}" in s else [])
    err = "the answer is not JSON"
    for x in cands:
        try:
            v = json.loads(x)
        except ValueError as e:
            err = f"the answer is not valid JSON ({e.msg} at line {e.lineno} column {e.colno})"
            continue
        if isinstance(v, dict):
            return v, None
        err = "the answer is JSON but not one spec object"
    return None, err


def _vega_made(node: Any, out: set) -> bool:
    """Field names a spec's transforms make (as / fold / window / …); False when a transform makes fields from the data's
    values (pivot), so field names cannot be checked."""
    ok = True
    if isinstance(node, dict):
        for t in node.get("transform") or [] if isinstance(node.get("transform"), list) else []:
            if not isinstance(t, dict):
                continue
            if "pivot" in t:
                ok = False
            if "fold" in t:
                out.update(t.get("as") or ["key", "value"])
            if "density" in t:
                out.update(t.get("as") or ["value", "density"])
            if "quantile" in t:
                out.update(t.get("as") or ["prob", "value"])
            if "regression" in t or "loess" in t:
                out.update(x for x in (t.get("regression"), t.get("loess"), t.get("on")) if isinstance(x, str))
            if "lookup" in t and not t.get("as"):
                fr = t.get("from")
                if isinstance(fr, dict):
                    out.update(x for x in fr.get("fields") or [] if isinstance(x, str))
            v = t.get("as")
            out.update([v] if isinstance(v, str) else [x for x in v if isinstance(x, str)] if isinstance(v, list) else [])
            for k in ("aggregate", "window", "joinaggregate"):
                for x in t.get(k) or [] if isinstance(t.get(k), list) else []:
                    if isinstance(x, dict) and isinstance(x.get("as"), str):
                        out.add(x["as"])
        for v in node.values():
            ok = _vega_made(v, out) and ok
    elif isinstance(node, list):
        for v in node:
            ok = _vega_made(v, out) and ok
    return ok


def _vega_external(node: Any, path: str, errors: list[str]) -> None:
    """url data sources, links (href / url channels or properties) and external addresses anywhere in the spec."""
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}" if path else k
            if k in ("url", "href"):
                errors.append(f"{p}: external {'data sources' if k == 'url' else 'links'} are not allowed (data comes from the widget's inputs)")
                continue
            if k == "$schema":
                continue
            if k == "loader":
                errors.append(f"{p}: a loader is not allowed")
                continue
            _vega_external(v, p, errors)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _vega_external(v, f"{path}[{i}]", errors)
    elif isinstance(node, str) and _EXTERNAL.match(node):
        errors.append(f"{path}: external address {node[:80]!r} is not allowed")


def vega_validate(spec: Any, mode: str, inputs: list[VegaInputSchema], params: list[str]) -> dict:
    """Checks a (generated) spec: {ok, errors, warnings, spec}. Errors make it unacceptable; warnings are shown."""
    errors: list[str] = []
    warnings: list[str] = []
    if isinstance(spec, str):
        spec, err = _vega_json(spec)
        if err:
            return {"ok": False, "errors": [err], "warnings": [], "spec": None}
    if not isinstance(spec, dict):
        return {"ok": False, "errors": ["the spec is not a JSON object"], "warnings": [], "spec": None}
    sch = spec.get("$schema")
    if sch is not None and sch != VEGA_SCHEMAS[mode]:
        if isinstance(sch, str) and re.fullmatch(r"https://vega\.github\.io/schema/" + ("vega-lite" if mode == "vega-lite" else "vega") + r"/v5(\.\d+)*(\.json)?", sch):
            pass
        else:
            errors.append(f"$schema must be {VEGA_SCHEMAS[mode]} ({'Vega-Lite' if mode == 'vega-lite' else 'Vega'} v5), not {str(sch)[:120]!r}")
    _vega_external(spec, "", errors)
    names = {i.name for i in inputs}
    fields_of = {i.name: {f.name for f in i.fields} | ({"count"} if i.kind == "aggregation" else set()) for i in inputs}
    if mode == "vega":
        marks = spec.get("marks")
        if not isinstance(marks, list) or not marks:
            errors.append("a Vega spec needs a non-empty marks list")
        for d in spec.get("data") or [] if isinstance(spec.get("data"), list) else []:
            if isinstance(d, dict) and "values" not in d and "source" not in d and d.get("name") not in names:
                errors.append(f"data {str(d.get('name'))[:60]!r} is neither a data input ({', '.join(sorted(names)) or 'none'}) nor inline values")
    else:
        inline = {k: v for k, v in (spec.get("datasets") or {}).items()} if isinstance(spec.get("datasets"), dict) else {}
        made: set = set()
        checkable = _vega_made(spec, made)
        known_all = set().union(*fields_of.values()) if fields_of else set()
        for rows in inline.values():
            for r in rows if isinstance(rows, list) else []:
                if isinstance(r, dict):
                    known_all.update(r.keys())
        units = [0]

        def data_fields(d: Any, inherited: set) -> set:
            if not isinstance(d, dict):
                return inherited
            if "values" in d:
                vals = d["values"]
                return {k for r in vals if isinstance(r, dict) for k in r} if isinstance(vals, list) else inherited
            n = d.get("name")
            if n is not None:
                if n in fields_of:
                    return fields_of[n]
                if n in inline:
                    rows = inline[n]
                    return {k for r in rows if isinstance(r, dict) for k in r} if isinstance(rows, list) else set()
                errors.append(f"data {str(n)[:60]!r} is not a data input of the widget ({', '.join(sorted(names)) or 'none'})")
                return set()
            if "sequence" in d or "graticule" in d or "sphere" in d:
                return inherited | {"data"}
            return inherited

        def field_ok(f: str, known: set) -> bool:
            if f in known or f in made:
                return True
            head = re.split(r"(?<!\\)[.\[]", f, maxsplit=1)[0].replace("\\.", ".")
            return head in known or head in made

        def walk(node: dict, known: set, where: str) -> None:
            known = data_fields(node.get("data"), known)
            if "mark" in node:
                units[0] += 1
                mk = node["mark"]
                t = mk.get("type") if isinstance(mk, dict) else mk
                if t not in VL_MARKS:
                    errors.append(f"{where or 'spec'}.mark: {str(t)[:40]!r} is not a Vega-Lite mark ({', '.join(sorted(VL_MARKS))})")
                enc = node.get("encoding")
                if enc is not None and not isinstance(enc, dict):
                    errors.append(f"{where or 'spec'}.encoding must be an object")
                for ch, defs in (enc or {}).items() if isinstance(enc, dict) else []:
                    for dd in defs if isinstance(defs, list) else [defs]:
                        for x in [dd, *(dd.get("condition") if isinstance(dd.get("condition"), list) else [dd.get("condition")])] if isinstance(dd, dict) else []:
                            f = x.get("field") if isinstance(x, dict) else None
                            if isinstance(f, str) and checkable and not field_ok(f, known):
                                errors.append(f"{where or 'spec'}.encoding.{ch}.field {f!r} is not in the data ({', '.join(sorted(known))[:300] or 'no fields'})")
            for k in VL_COMPOSE:
                for i, sub in enumerate(node.get(k) or [] if isinstance(node.get(k), list) else []):
                    if isinstance(sub, dict):
                        walk(sub, known, f"{where}{'.' if where else ''}{k}[{i}]")
            if isinstance(node.get("spec"), dict):
                walk(node["spec"], known, f"{where}{'.' if where else ''}spec")

        top = spec.get("data")
        # no data: the widget injects the first input (a layer / concat without data of its own reads none: lenient)
        composite = any(k in spec for k in (*VL_COMPOSE, "spec"))
        start = set() if top is not None else known_all if composite or not inputs else fields_of[inputs[0].name]
        walk(spec, start, "")
        if not units[0]:
            errors.append("a Vega-Lite spec needs a mark (or layer / concat / facet specs with marks)")
        if not checkable:
            warnings.append("the spec pivots data values into fields: encoding fields were not checked")

        def defined(node: Any) -> set:
            out: set = set()
            if isinstance(node, dict):
                for p in node.get("params") or [] if isinstance(node.get("params"), list) else []:
                    if isinstance(p, dict) and p.get("select") and isinstance(p.get("name"), str):
                        out.add(p["name"])
                for k in (*VL_COMPOSE, "spec"):
                    for sub in node.get(k) if isinstance(node.get(k), list) else [node.get(k)] if isinstance(node.get(k), dict) else []:
                        out |= defined(sub)
            return out

        have = defined(spec)
        for p in params:
            if p and p not in have:
                warnings.append(f"selection parameter {p!r} is configured on the widget but not defined in the spec: it will not write its variable")
    return {"ok": not errors, "errors": errors[:30], "warnings": warnings[:30], "spec": spec}


def _vega_system(req: VegaGenerateIn) -> str:
    lite = req.mode == "vega-lite"
    lines = []
    for i in req.inputs:
        fs = ", ".join(f"{f.name} ({f.type}; {_vl_kind(f.type)})" for f in i.fields) or "fields unknown"
        lines.append(f'- "{i.name}" ({i.kind}): {fs}')
    sel = ""
    if req.params and lite:
        sel = (" The widget has selection parameters named " + ", ".join(json.dumps(p) for p in req.params) + "; define each in the spec's "
               "params with a select (point selections with fields on a category or group-by field, or interval selections with "
               "encodings on an axis) so clicks and brushes filter the rest of the application.")
    return ("You write chart specs for the Vega Chart widget of a Workshop application. Answer with only ONE JSON object: a "
            + ("Vega-Lite 5 spec (Vega-Lite 5.18)" if lite else "Vega 5 spec")
            + ", no prose and no code fence. The data comes from the widget's data inputs, injected by name; never write data values, "
            "never use url data sources, links (href), images from addresses or any external address. "
            + ('Read an input with "data": {"name": "<input>"} (a layer or concat may read another input the same way). ' if lite
               else 'Read an input with {"name": "<input>"} in the data list (no values, no url). ')
            + "Use only these inputs and fields (name (type; Vega-Lite type)):\n" + "\n".join(lines)
            + "\nUse only these field names in encodings, unless a transform in the spec makes the field (calculate, aggregate, "
            "bin, timeUnit, window, fold … with \"as\"). Give axes readable titles. Do not set width / height / autosize, "
            "background or $schema; the widget sets them." + sel)


@router.post("/vega/validate")
def vega_validate_route(req: VegaValidateIn) -> dict:
    """Checks a spec an author edited before it is accepted into the widget."""
    return vega_validate(req.spec, req.mode, req.inputs, req.params)


@router.post("/vega/generate")
def vega_generate(req: VegaGenerateIn) -> dict:
    """AIP spec generation: the prompt and the inputs' schema (names, fields, types — no rows) to the language model
    through functions_registry.llm_chat; the answer is checked (vega_validate) and, when it fails, sent back once with
    the problems to be corrected. Answers {ok, spec, text, errors, warnings, model, attempts, raw}."""
    import functions_registry

    if not req.inputs:
        raise HTTPException(400, "add a data input first: the generator writes the spec for the widget's inputs")
    system = _vega_system(req)
    cur = (req.current_spec or "").strip()
    user = (f"The current spec:\n{cur}\n\nChange it as asked, keeping what is not mentioned: {req.prompt}" if cur else req.prompt)
    model = req.model or ontology.DEFAULT_LLM
    attempts = 0
    raw = ""
    out: dict = {}
    for attempt in range(2):
        attempts += 1
        ask = user if not attempt else (f"{user}\n\nYour previous answer:\n{raw[:20000]}\n\nIt was rejected: " + "; ".join(out.get("errors") or [])
                                          + ". Answer again with only the corrected JSON spec.")
        try:
            raw = str(functions_registry.llm_chat(functions_registry.ChatIn(prompt=ask, system=system, model=model, temperature=0))["text"] or "")
        except HTTPException:
            raise
        except Exception as e:  # provider down, no key, quota
            raise HTTPException(502, f"the language model did not answer: {str(e)[:300]}")
        out = vega_validate(raw, req.mode, req.inputs, req.params)
        if out["ok"]:
            break
    spec = out.get("spec")
    return {"ok": out["ok"], "spec": spec if out["ok"] else None, "text": json.dumps(spec, indent=2) if isinstance(spec, dict) else raw,
            "errors": out["errors"], "warnings": out["warnings"], "model": model, "attempts": attempts, "raw": raw[:20000]}


# ------------------------------------------------------------------------------------------------
# Free-form Analysis: saved analysis paths per widget (public, or private to their author)
# ------------------------------------------------------------------------------------------------


def _analyses_path(module_id: str, widget_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", module_id) or not re.fullmatch(r"[A-Za-z0-9_-]+", widget_id):
        raise HTTPException(404, "not found")
    return DIR / "analyses" / f"{module_id}__{widget_id}.json"


@router.get("/analyses/{module_id}/{widget_id}")
def list_analyses(module_id: str, widget_id: str) -> list[dict]:
    _module(module_id)
    data = ontology._read(_analyses_path(module_id, widget_id)) or {"items": []}
    me = _uid()
    return [a for a in data["items"] if a.get("visibility") == "public" or a.get("owner") == me]


class AnalysisIn(BaseModel):
    id: Optional[str] = None
    name: str = Field(min_length=1, max_length=200)
    visibility: Literal["private", "public"] = "private"
    cards: list[dict] = Field(default_factory=list, max_length=40)


@router.put("/analyses/{module_id}/{widget_id}")
def save_analysis(module_id: str, widget_id: str, req: AnalysisIn) -> dict:
    _module(module_id)
    path = _analyses_path(module_id, widget_id)
    with _hist_lock:
        data = ontology._read(path) or {"items": []}
        me = _uid()
        cur = next((a for a in data["items"] if a["id"] == req.id), None) if req.id else None
        if cur and cur.get("owner") != me:
            raise HTTPException(403, "only its author changes a saved analysis")
        rec = {"id": req.id or ontology._new_id("ana"), "name": req.name, "visibility": req.visibility, "cards": req.cards,
               "owner": me, "owner_name": _who(), "updated_at": ontology._now()}
        data["items"] = [a for a in data["items"] if a["id"] != rec["id"]] + [rec]
        ontology._write(path, data)
    return rec


@router.delete("/analyses/{module_id}/{widget_id}/{analysis_id}")
def delete_analysis(module_id: str, widget_id: str, analysis_id: str) -> dict:
    path = _analyses_path(module_id, widget_id)
    with _hist_lock:
        data = ontology._read(path) or {"items": []}
        cur = next((a for a in data["items"] if a["id"] == analysis_id), None)
        if not cur:
            raise HTTPException(404, "analysis not found")
        if cur.get("owner") != _uid():
            raise HTTPException(403, "only its author deletes a saved analysis")
        data["items"] = [a for a in data["items"] if a["id"] != analysis_id]
        ontology._write(path, data)
    return {"deleted": analysis_id}


@router.get("/freshness")
def freshness(types: str = "") -> dict:
    """When each object type's objects last changed (an edit, an action or a reindex of its datasource): auto-refresh
    polls this, and the Data Freshness widget shows it. Types the user cannot see are left out."""
    out: dict[str, dict] = {}
    for tid in [t for t in types.split(",") if t][:50]:
        try:
            t = ontology._object_type(tid)
            ontology.auth.check_resource("object_type", tid)
        except HTTPException:
            continue
        st = ontology.objects_stat(tid)
        at = datetime.fromtimestamp(st["mtime_ns"] / 1e9).astimezone().isoformat() if st else None
        out[tid] = {"name": t.get("display_name") or tid, "updated_at": at, "version": st["mtime_ns"] if st else 0}
    return out


@router.post("/sql")
def sql_variable(req: SqlIn) -> dict:
    """A SQL query variable: one Ontology SQL SELECT over object types bound as @tables and variables bound as @parameters."""
    import ontology as onto
    import sql_studio

    parts = []
    for alias, tid in req.tables.items():
        if not re.fullmatch(r"[A-Za-z_]\w*", alias):
            raise HTTPException(400, f"table alias {alias!r}: letters, digits and underscores, starting with a letter")
        onto._object_type(tid)
        parts.append(f"@{alias} `ri.ontology.main.object-type.{tid}`")
    for alias, v in req.params.items():
        if not re.fullmatch(r"[A-Za-z_]\w*", alias) or alias in req.tables:
            raise HTTPException(400, f"parameter alias {alias!r} is not valid or is already a table")
        if isinstance(v, (list, dict)):
            raise HTTPException(400, f"parameter {alias}: arrays and structs cannot be parameters")
        t, lit = _sql_literal(v)
        parts.append(f"@{alias} {t} = {lit}")
    body = req.query.strip().rstrip(";")
    if not re.match(r"(?is)^\s*(select|with)\b", body):
        raise HTTPException(400, "write a single SELECT statement")
    sql = (f"DECLARE {', '.join(parts)};\n" if parts else "") + body
    res = sql_studio.run(sql, "object", max(1, min(req.limit, 10_000)))
    return {"columns": res["columns"], "rows": res["rows"], "row_count": res["row_count"], "truncated": res.get("truncated", False), "ms": res.get("ms")}


class PublishIn(BaseModel):
    version: int


@router.post("/modules/{module_id}/publish")
def publish(module_id: str, req: PublishIn) -> dict:
    """Publish a version: viewers see it while auto publish is off."""
    m = _module(module_id, "editor")
    if not any(x["version"] == req.version for x in _versions(module_id)):
        raise HTTPException(404, "version not found")
    m["published_version"] = req.version
    ontology._write(_path(module_id), m)
    return m


@router.delete("/modules/{module_id}")
def delete_module(module_id: str) -> dict:
    m = _module(module_id, "editor")
    if m.get("item_id"):
        try:
            drive.trash(m["item_id"])
        except HTTPException:
            pass
    _path(module_id).unlink(missing_ok=True)
    return {"deleted": module_id}


# ------------------------------------------------------------------------------------------------
# sources
# ------------------------------------------------------------------------------------------------


def datasets() -> list[dict]:
    """Parquet files in Files (pipeline outputs, data source ingests), newest first, with their folder path."""
    if not db.enabled():
        return []
    items = db.drive_query("content_type = %s AND trashed_at IS NULL", (pipeline_datasets.PARQUET,), limit=500)
    return [drive._with_path(i) for i in items]


@router.get("/sources")
def sources() -> dict:
    return {
        "datasets": [{"id": d["id"], "name": d["name"], "path": [p["name"] for p in d.get("path") or []], "size": d.get("size"),
                      "updated_at": d.get("updated_at")} for d in datasets()],
        "object_types": [{"id": t["id"], "name": t["display_name"], "count": t["object_count"],
                          "properties": [{"name": p["api_name"], "label": p["display_name"], "type": p["type"],
                                          **({"regex": True} if "regex_queries" in (p.get("render_hints") or []) else {}),
                                          **({"prominent": True} if p.get("visibility") == "prominent" else {})} for p in t["properties"]],
                          # the ontology's icon, color and title property (timeline / Gantt events, object set titles)
                          "icon": t.get("icon") or "cube", "color": t.get("color"), "title_property": t.get("title_property"),
                          # the type marked prominent (or promoted): the Resource List's "Prominent" object types
                          **({"prominent": True} if t.get("visibility") == "prominent" or t.get("status") == "promoted" else {})}
                         for t in ontology.list_object_types()],
        "interfaces": _interface_sources(),
        "restricted_views": _restricted_sources(),
    }


def _restricted_sources() -> list[dict]:
    try:
        import restricted_views

        return [{"id": v["rid"], "name": v["name"]} for v in restricted_views.list_views()]
    except Exception:  # noqa: BLE001
        return []


def _interface_sources() -> list[dict]:
    import ontology_model as om

    with ontology._lock:
        out = []
        for i in ontology._all("interfaces"):
            if not om.discoverable(i):
                continue
            impls = om.implementations(i["id"])
            out.append({"id": i["id"], "name": i["display_name"], "api_name": i.get("api_name"), "implemented_by": len(impls),
                        "extends": [a["id"] for a in om._ancestors(i)],
                        "types": [{"id": t["id"], "name": t.get("display_name") or t["id"]} for t, _imp in impls],
                        "action_constraints": [{"api_name": a["api_name"], "display_name": a.get("display_name") or a["api_name"]}
                                               for a in om.interface_action_constraints(i)],
                        "link_constraints": _interface_link_sources(i, impls),
                        "properties": [{"name": p["api_name"], "label": p.get("display_name") or p["api_name"], "type": p.get("type") or "string"}
                                       for p in om.interface_properties(i)] + [{"name": "object_type", "label": "Object type", "type": "string"}]})
        return out


def _interface_link_sources(iface: dict, impls: list[tuple[dict, dict]]) -> list[dict]:
    """An interface's link types (constraints, inherited ones too) with each implementing type's concrete link type and
    the direction it is read in (Filter List / search bar: filters on an interface's linked objects)."""
    import ontology_model as om

    out = []
    for lc in om.interface_link_constraints(iface):
        by_type = {}
        for t, imp in impls:
            lt_id = (imp.get("links") or {}).get(lc["api_name"])
            lt = ontology._read(ontology._path("link-types", lt_id)) if lt_id else None
            if lt:
                by_type[t["id"]] = {"link_type_id": lt["id"], "direction": "forward" if lt["source"]["object_type_id"] == t["id"] else "reverse"}
        out.append({"api_name": lc["api_name"], "display_name": lc.get("display_name") or lc["api_name"], "target_kind": lc.get("target_kind"),
                    "target_id": lc.get("target_object_type_id") or lc.get("target_interface_id"), "cardinality": lc.get("cardinality"),
                    "required": bool(lc.get("required")), "by_type": by_type})
    return out


class InterfaceActionBody(BaseModel):
    interface_id: str
    # the selected object: {object_type_id, primary_key} or "<type id>:<pk>" (an interface source's selection)
    object: Any
    action_type_id: Optional[str] = None
    constraint: Optional[str] = None
    by_type: Optional[dict[str, str]] = None
    # several configured actions (an inline action's list): POST /interface-actions offers every one that applies
    action_type_ids: Optional[list[str]] = None


def _iface_ids_of(t: dict) -> dict[str, dict]:
    """The interfaces an object type implements (directly or through the interfaces they extend) → its implementation."""
    import ontology_model as om

    out: dict[str, dict] = {}
    for imp in t.get("implements") or []:
        out.setdefault(imp["interface_id"], imp)
        for a in om._ancestors({"extends": [imp["interface_id"]]}):
            out.setdefault(a["id"], imp)
    return out


def _iface_constraint_mapping(t: dict, iface_id: str, constraint: str) -> dict:
    """How the type maps an action type constraint of the interface: through any implementation covering it (the
    interface itself or one extending it, which maps the inherited constraints too)."""
    import ontology_model as om

    for imp in t.get("implements") or []:
        covered = {imp["interface_id"]} | {a["id"] for a in om._ancestors({"extends": [imp["interface_id"]]})}
        if iface_id in covered:
            m = (imp.get("actions") or {}).get(constraint) or {}
            if m.get("action_type_id"):
                return m
    return {}


def _iface_selected(body: InterfaceActionBody) -> tuple[dict, dict, str, dict[str, dict]]:
    """The interface, the selected object's type, its primary key and the interfaces the type implements (checked)."""
    v = body.object
    if isinstance(v, str) and ":" in v:
        tid, pk = v.split(":", 1)
    elif isinstance(v, dict):
        tid, pk = v.get("object_type_id"), v.get("primary_key")
    else:
        raise HTTPException(400, "object: {object_type_id, primary_key} or \"<type id>:<pk>\"")
    if not tid or pk in (None, ""):
        raise HTTPException(400, "object: pick an object (its type and primary key)")
    iface = ontology._get("interfaces", body.interface_id, "interface")
    t = ontology._object_type(str(tid))
    key, o = ontology._find(t, str(pk))
    if not ontology._can_see(t, o):
        raise HTTPException(404, "object not found")
    impls = _iface_ids_of(t)
    if iface["id"] not in impls:
        raise HTTPException(400, f"{t['display_name']} does not implement {iface['display_name']}")
    return iface, t, str(key), impls


def _iface_resolve(iface: dict, t: dict, key: str, impls: dict[str, dict], actions: dict[str, dict], *,
                   by_type: Optional[dict[str, str]] = None, constraint: Optional[str] = None, action_type_id: Optional[str] = None) -> dict:
    """One resolution (by_type, else constraint, else action_type_id); HTTPException(400) with the reason otherwise."""
    ref = {"object_type_id": t["id"], "primary_key": key}

    def done(aid: str, via: str, defaults: Optional[dict] = None) -> dict:
        a = actions.get(aid)
        if not a:
            raise HTTPException(400, f"the action type {aid} no longer exists")
        return {"action_type_id": a["id"], "action_name": a.get("display_name") or a["id"], "object_type_id": t["id"],
                "primary_key": key, "via": via, "defaults": defaults or {}}

    def fill(a: dict, ids: Optional[list[str]] = None) -> dict:
        out = {}
        for p in a.get("parameters") or []:
            if ids is not None and p["id"] not in ids:
                continue
            if p.get("type") == "interface":
                out[p["id"]] = ref
            elif p.get("type") == "object" and (p.get("object_type_id") or a.get("object_type_id")) == t["id"]:
                out[p["id"]] = [key] if p.get("array") or p.get("multiple") else key
        return out

    if by_type and by_type.get(t["id"]):
        aid = by_type[t["id"]]
        return done(aid, "by_type", fill(actions.get(aid) or {}))
    if constraint:
        m = _iface_constraint_mapping(t, iface["id"], constraint)
        if not m:
            raise HTTPException(400, f"{t['display_name']} does not map the action type constraint {constraint} of {iface['display_name']}")
        a = actions.get(m["action_type_id"]) or {}
        mapped = list((m.get("parameters") or {}).values())
        return done(m["action_type_id"], "constraint", fill(a, mapped or None))
    if action_type_id:
        a = actions.get(action_type_id)
        if not a:
            raise HTTPException(400, f"the action type {action_type_id} no longer exists")
        ifps = [p for p in a.get("parameters") or [] if p.get("type") == "interface"]
        # an interface parameter on an interface the type implements (directly, through an extending interface it
        # implements, or an interface extending this one)
        if any(p.get("interface_id") in impls for p in ifps):
            return done(a["id"], "interface_action", fill(a))
        if a.get("object_type_id") == t["id"]:
            return done(a["id"], "type_action", fill(a))
        raise HTTPException(400, f"{a.get('display_name') or a['id']} does not apply to {t['display_name']} objects")
    raise HTTPException(400, f"no action for {t['display_name']}: choose an action, an action type constraint or an action per type")


@router.post("/interface-action")
def interface_action(body: InterfaceActionBody) -> dict:
    """Which concrete action an action button on an interface source runs on the selected object, with parameters filled
    from it. In order: the action configured for the object's type (by_type); the interface's action type constraint as
    the object's type maps it (its object / interface parameters get the object); an interface action (an interface
    reference parameter on this interface or one it extends); the configured action when it belongs to the object's type."""
    with ontology._lock:
        iface, t, key, impls = _iface_selected(body)
        actions = {a["id"]: a for a in ontology._all("action-types")}
        return _iface_resolve(iface, t, key, impls, actions, by_type=body.by_type, constraint=body.constraint, action_type_id=body.action_type_id)


@router.post("/interface-actions")
def interface_actions(body: InterfaceActionBody) -> dict:
    """Every configured action that applies to the object selected on an interface source (an inline action's menu):
    the action chosen for its type (by_type), the constraint as its type maps it, then each of action_type_ids /
    action_type_id that is an interface action on an interface the type implements or an action of the type itself —
    resolved as POST /interface-action, without duplicates; the others come back in "refused" with the reason."""
    with ontology._lock:
        iface, t, key, impls = _iface_selected(body)
        actions = {a["id"]: a for a in ontology._all("action-types")}
        tries: list[tuple[str, dict]] = []
        if body.by_type and body.by_type.get(t["id"]):
            tries.append((body.by_type[t["id"]], {"by_type": body.by_type}))
        if body.constraint:
            tries.append((f"constraint:{body.constraint}", {"constraint": body.constraint}))
        ids = list(body.action_type_ids or []) + ([body.action_type_id] if body.action_type_id else [])
        tries += [(aid, {"action_type_id": aid}) for aid in ids if aid]
        options: list[dict] = []
        refused: list[dict] = []
        for what, kw in tries:
            try:
                r = _iface_resolve(iface, t, key, impls, actions, **kw)
            except HTTPException as e:
                a = actions.get(what) or {}
                refused.append({"action_type_id": what, "action_name": a.get("display_name") or what, "reason": e.detail})
                continue
            if all(o["action_type_id"] != r["action_type_id"] for o in options):
                options.append(r)
        return {"object_type_id": t["id"], "object_type_name": t.get("display_name") or t["id"], "primary_key": key,
                "options": options, "refused": refused}


def _json_cell(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, (list, dict)):
        return json.loads(json.dumps(v, default=str))
    return v


def _restricted_rows(rid: str) -> tuple[list[str], dict[str, str], list[dict]]:
    """A restricted view's rows as the caller may see them (per user: never cached)."""
    import restricted_views

    table = restricted_views.table_for_ref(rid)[0].slice(0, MAX_SOURCE_ROWS)
    return (table.column_names, {f.name: pipeline_datasets._column_type(f.type) for f in table.schema},
            [{k: _json_cell(v) for k, v in r.items()} for r in table.to_pylist()])


def _dataset_rows(item_id: str) -> tuple[list[str], dict[str, str], list[dict]]:
    item = drive._item(item_id)
    stamp = str(item.get("updated_at"))
    with _cache_lock:
        hit = _cache.get(item_id)
        if hit and hit[0] == stamp:
            return hit[1], hit[2], hit[3]
    try:
        table = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).read()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet file: {e}') from e
    table = table.slice(0, MAX_SOURCE_ROWS)
    cols = table.column_names
    types = {f.name: pipeline_datasets._column_type(f.type) for f in table.schema}
    rows = [{k: _json_cell(v) for k, v in r.items()} for r in table.to_pylist()]
    with _cache_lock:
        if len(_cache) > 20:
            _cache.clear()
        _cache[item_id] = (stamp, cols, types, rows)
    return cols, types, rows


OBJECT_TYPES = {"string": "String", "integer": "Integer", "double": "Double", "boolean": "Boolean", "date": "Date", "timeseries": "Time series",
                "timestamp": "Timestamp", "media": "Media", "string_array": "Array", "long": "Long", "short": "Integer", "byte": "Integer",
                "float": "Double", "decimal": "Double", "geopoint": "Geopoint", "geoshape": "Geoshape", "geotemporal_series_reference": "String",
                "cipher": "String", "marking": "String"}


def _object_rows(type_id: str, pks: Optional[list[str]] = None) -> tuple[list[str], dict[str, str], list[dict]]:
    """An object type's visible objects as rows; with `pks`, only those objects (a ranked object set, a semantic
    search box's top hits): their records alone are read (ontology_store.get_many), not the whole type — through a
    scenario or a function run's snapshot the type is read as it is there, then cut to them."""
    t = ontology._object_type(type_id)
    cols = [p["api_name"] for p in t["properties"]]
    types = {p["api_name"]: OBJECT_TYPES.get(p["type"], "String") for p in t["properties"]}
    if pks is None:
        objs = ontology._objects(type_id).items()
    else:
        import ontology_store

        ontology.auth.check_resource("object_type", type_id)  # as ontology._objects does for every object read
        want = list(dict.fromkeys(str(k) for k in pks))
        got = (ontology.stored_objects(type_id) if ontology.SCENARIO.get() or ontology.SNAPSHOT.get()
               else ontology_store.get_many(type_id, want))
        objs = [(k, got[k]) for k in want if k in got]
    # through _public_object: property security policies apply (values the user may not see read as null)
    rows = []
    for pk, o in objs:
        if ontology._can_see(t, o):
            pub = ontology._public_object(t, pk, o)
            # property security markings travel with the row (shown when a widget turns them on)
            rows.append({**pub["properties"], "__pk": pk, **({"__markings": pub["property_markings"]} if pub.get("property_markings") else {})})
    return cols, types, rows


def _interface_rows(iface_id: str) -> tuple[list[str], dict[str, str], list[dict]]:
    """An interface-based object set: the objects of every implementing object type, under the interface's property
    names (shared or local; struct fields mapped with "prop.field"), with the object type they come from."""
    import ontology_model as om

    with ontology._lock:
        iface = ontology._get("interfaces", iface_id, "interface")
        props = om.interface_properties(iface)
        cols = [p["api_name"] for p in props] + ["object_type"]
        types = {**{p["api_name"]: OBJECT_TYPES.get(p.get("type") or "string", "String") for p in props}, "object_type": "String"}
        rows = []
        for t, imp in om.implementations(iface_id):
            try:
                t = ontology._object_type(t["id"])
            except HTTPException:
                continue
            mapping = imp.get("mapping") or {}
            for pk, o in ontology._objects(t["id"]).items():
                if not ontology._can_see(t, o):
                    continue
                pub = ontology._public_object(t, pk, o)
                rows.append({**{ip: om.iface_value(pub["properties"], local) for ip, local in mapping.items()},
                             "object_type": t["display_name"], "__pk": f"{t['id']}:{pk}", "__type": t["id"]})
    return cols, types, rows


def _union_rows(ids_text: str) -> tuple[list[str], dict[str, str], list[dict]]:
    """A union of the object sets of several object types (Filter List: "Filter object sets of multiple object types";
    the source id lists the type ids, comma-separated). Properties with the same property ID share a column (common
    properties); a type's own properties are empty on the other types' objects (single properties). Each object
    carries the object type it comes from; primary keys read "type:pk"."""
    ids = list(dict.fromkeys(x.strip() for x in ids_text.split(",") if x.strip()))
    if not ids:
        raise HTTPException(400, "choose the object types of the union")
    if len(ids) > 20:
        raise HTTPException(400, "a union holds at most 20 object types")
    cols: list[str] = []
    types: dict[str, str] = {}
    rows: list[dict] = []
    for tid in ids:
        t = ontology._object_type(tid)
        tcols, ttypes, trows = _object_rows(tid)
        for col in tcols:
            if col not in types:
                cols.append(col)
                types[col] = ttypes.get(col, "String")
            elif types[col] != ttypes.get(col, "String"):
                types[col] = "String"
        rows.extend({**r, "object_type": t["display_name"], "__pk": f"{tid}:{r['__pk']}", "__type": tid} for r in trows)
        if len(rows) > MAX_SOURCE_ROWS:
            raise HTTPException(413, f"the union holds more than {MAX_SOURCE_ROWS:,} objects")
    if "object_type" not in types:
        cols.append("object_type")
    types["object_type"] = "String"
    return cols, types, rows


class Source(BaseModel):
    # object_types: a union of several object types' object sets (id: the type ids, comma-separated)
    kind: Literal["dataset", "object_type", "interface", "restricted_view", "object_types"]
    id: str


class Filter(BaseModel):
    column: str
    # starts_with: the value or one of its words starts with it; search: advanced keyword syntax (AND / OR / NOT,
    # brackets, quoted phrases); regex: a Lucene regular expression on the whole value (workshop_search.py)
    # geo: geospatial search (the Map widget's Search within / objects in view) — the column's geopoint / geoshape
    # meets value {geometry: GeoJSON} or {bbox: [min lon, min lat, max lon, max lat]} (min lon > max lon: across the
    # antimeridian); value.lon_column: the column is a latitude and this one its longitude
    op: Literal["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null", "starts_with", "search", "regex", "geo"] = "eq"
    value: Any = None


class FilterSet(BaseModel):
    """An object set filter variable's value: property filters (column "__link": a filter on linked objects, value
    {link_type_id, direction, filters, negate}), combined with all / any, and a keyword over every property."""
    filters: list[Filter] = []
    mode: Literal["all", "any"] = "all"
    keyword: str = ""
    # the keyword as a plain substring, in advanced syntax, or as a regular expression (workshop_search.py)
    syntax: Literal["simple", "advanced", "regex"] = "simple"
    # Foundry's starting-filter CONTAIN: "contains" filters match prefixes (of the value or a word) only
    contains_prefix: bool = False
    # a ranked object set (a KNN variable): the primary keys in rank order, and each one's relevance
    order: list[str] = []
    relevance: dict[str, float] = {}
    # an empty object set (a KNN variable with no query or no results): no object passes
    empty: bool = False


class JoinSpec(BaseModel):
    dataset_id: str
    left_key: str
    right_key: str
    mode: Literal["left", "inner"] = "left"
    prefix: str = "joined"


class DerivedColumn(BaseModel):
    name: str
    op: Literal["add", "subtract", "multiply", "divide", "concat", "upper", "lower", "year"]
    column: str
    other_column: Optional[str] = None
    value: Any = None


class HistogramSpec(BaseModel):
    """Bucket counts of one property over the filtered rows (Filter List: timeline and distribution charts).
    timeline: a date / timestamp property by day, week (from Monday), month or year (auto: by the values' range);
    distribution: a numeric property in about `bins` equal bins with round edges."""
    column: str
    kind: Literal["timeline", "distribution"]
    interval: Literal["auto", "day", "week", "month", "year"] = "auto"
    bins: int = 24


class Query(BaseModel):
    source: Source
    filters: list[Filter] = []
    filter_mode: Literal["all", "any"] = "all"
    additional_filters: list[Filter] = []
    # object set filter variables applied to this query (each one must hold)
    filter_sets: list[FilterSet] = []
    join: Optional[JoinSpec] = None
    derived: list[DerivedColumn] = []
    # a table: these columns (all when empty); with group_by: one row per group
    columns: list[str] = []
    group_by: Optional[str] = None
    # date bucketing for group_by: day | month | year
    bucket: Optional[Literal["day", "month", "year"]] = None
    metric: Literal["count", "sum", "avg", "min", "max", "distinct"] = "count"
    metric_column: Optional[str] = None
    # bucket counts of a date / numeric property over the filtered rows (instead of rows or groups)
    histogram: Optional[HistogramSpec] = None
    sort: Optional[str] = None
    descending: bool = False
    limit: int = 500
    search: str = ""
    # an object type source: keep the k objects most relevant to a query, in relevance order (a semantic search box)
    semantic: Optional[dict] = None
    # Workshop scenarios [Legacy]: read the objects as they are in this (Ontology) scenario
    scenario_id: Optional[str] = None


def _num(v: Any) -> Optional[float]:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


_GEO_REGIONS: dict[str, Any] = {}


def _geo_region(spec: Any) -> Any:
    """The searched region of a geo filter as a prepared shapely geometry (lon / lat). A region past ±180° (a shape drawn
    across the antimeridian without splitting, a box with min lon > max lon) also covers its other side."""
    from shapely import affinity
    from shapely.geometry import box, shape
    from shapely.ops import unary_union
    from shapely.errors import ShapelyError
    from shapely.prepared import prep

    if not isinstance(spec, dict) or not (spec.get("geometry") or spec.get("bbox")):
        raise HTTPException(400, "a geospatial filter needs a geometry (GeoJSON) or a bbox")
    key = json.dumps({"g": spec.get("geometry"), "b": spec.get("bbox")}, sort_keys=True, default=str)
    if key in _GEO_REGIONS:
        return _GEO_REGIONS[key]
    try:
        if spec.get("bbox") is not None:
            x0, y0, x1, y1 = (float(v) for v in spec["bbox"])
            region = box(x0, y0, 180, y1).union(box(-180, y0, x1, y1)) if x0 > x1 else box(x0, y0, x1, y1)
        else:
            g = spec["geometry"]
            g = json.loads(g) if isinstance(g, str) else g
            if isinstance(g, dict) and g.get("type") == "Feature":
                g = g.get("geometry")
            if isinstance(g, dict) and g.get("type") == "FeatureCollection":
                g = {"type": "GeometryCollection", "geometries": [f.get("geometry") for f in g.get("features") or [] if isinstance(f, dict) and f.get("geometry")]}
            region = shape(g)
            if not region.is_valid:
                region = region.buffer(0) if region.geom_type in ("Polygon", "MultiPolygon") else region
    except (KeyError, TypeError, ValueError, AttributeError, ShapelyError) as e:
        raise HTTPException(400, f"the geospatial filter's shape is not valid GeoJSON: {e}") from None
    if region.is_empty:
        raise HTTPException(400, "the geospatial filter's shape is empty")
    x0, _, x1, _ = region.bounds
    if x1 > 180:
        region = unary_union([region, affinity.translate(region, xoff=-360)])
    if x0 < -180:
        region = unary_union([region, affinity.translate(region, xoff=360)])
    out = prep(region)
    if len(_GEO_REGIONS) > 64:
        _GEO_REGIONS.clear()
    _GEO_REGIONS[key] = out
    return out


def _geo_keep(row: dict, f: Filter) -> bool:
    """A row whose geopoint / geoshape (or latitude and longitude columns) meets the geo filter's region."""
    from ontology_explorer import _geometry

    region = _geo_region(f.value)
    v = row.get(f.column)
    lon_col = f.value.get("lon_column") if isinstance(f.value, dict) else None
    if lon_col:
        lat, lon = _num(v), _num(row.get(lon_col))
        if lat is None or lon is None:
            return False
        v = f"{lat},{lon}"
    for x in v if isinstance(v, list) else [v]:
        g = _geometry(x)
        if g is not None and not g.is_empty and region.intersects(g):
            return True
    return False


def _keep(row: dict, f: Filter) -> bool:
    v = row.get(f.column)
    if f.op == "geo":
        return _geo_keep(row, f)
    if f.op == "is_null":
        return v in (None, "")
    if f.op == "not_null":
        return v not in (None, "")
    if f.op == "in":
        wanted = f.value if isinstance(f.value, list) else [f.value]
        return str(v) in {str(w) for w in wanted}
    if f.op == "contains":
        return str(f.value).lower() in str(v if v is not None else "").lower()
    if f.op in ("starts_with", "search", "regex"):
        import workshop_search as ws

        return ws.prefix_match(f.value, v) if f.op == "starts_with" else ws.advanced_match(f.value, v, f.column, row) if f.op == "search" else ws.regex_match(str(f.value), v)
    a, b = _num(v), _num(f.value)
    if f.op in ("gt", "gte", "lt", "lte"):
        x, y = (a, b) if a is not None and b is not None else (str(v if v is not None else ""), str(f.value))
        return {"gt": x > y, "gte": x >= y, "lt": x < y, "lte": x <= y}[f.op]
    same = a == b if a is not None and b is not None else str(v) == str(f.value)
    return same if f.op == "eq" else not same


def _set_active(f: Filter) -> bool:
    return f.op in ("is_null", "not_null") or f.value not in (None, "", [])


def _link_keep(source: "Source", rows: list[dict], f: Filter) -> set[str]:
    """The rows with at least one linked object passing the link filter's own filters (or none, negated); on a union
    each object type resolves the link on its own (workshop_search.link_keep)."""
    import workshop_search as ws

    return ws.link_keep(source, rows, f)


def _prefix_contains(f: Filter) -> Filter:
    """Foundry's starting-filter CONTAIN: a "contains" filter (also inside a link filter) matches prefixes only."""
    if f.column == "__link" and isinstance(f.value, dict):
        return f.model_copy(update={"value": {**f.value, "filters": [_prefix_contains(Filter(**x)).model_dump() for x in f.value.get("filters") or []]}})
    return f.model_copy(update={"op": "starts_with"}) if f.op == "contains" else f


def _apply_filter_set(source: "Source", cols: list[str], rows: list[dict], fs: FilterSet) -> list[dict]:
    import workshop_search as ws

    if fs.empty:
        return []
    if fs.contains_prefix:
        fs = fs.model_copy(update={"filters": [_prefix_contains(f) for f in fs.filters]})
    if any(f.op == "regex" and f.column != "__link" and _set_active(f) for f in fs.filters):
        allowed = ws.regex_columns(source.kind, source.id)
        for f in fs.filters:
            if f.op == "regex" and f.column in cols and _set_active(f):
                ws.check_regex_column(allowed, f.column)
                ws.compile_regex(str(f.value))
    if fs.keyword.strip() and fs.syntax != "simple":
        rows = ws.keyword_rows(source.kind, source.id, rows, fs.keyword, fs.syntax)
        fs = fs.model_copy(update={"keyword": ""})
    active = [f for f in fs.filters if f.column == "__link" or _set_active(f)]
    for f in active:
        if f.column not in ("__link", "__pk") and f.column not in cols:
            raise HTTPException(400, f'no column "{f.column}"')
    if active:
        linked = [(_link_keep(source, rows, f) if f.column == "__link" else None) for f in active]

        def passes(r: dict) -> bool:
            checks = (str(r["__pk"]) in lk if lk is not None else _keep(r, f) for f, lk in zip(active, linked))
            return all(checks) if fs.mode == "all" else any(checks)

        rows = [r for r in rows if passes(r)]
    if fs.keyword.strip():
        needle = fs.keyword.strip().lower()
        rows = [r for r in rows if any(needle in str(v).lower() for k, v in r.items() if k != "__pk")]
    return rows


@router.get("/links/{type_id}")
def links_of_type(type_id: str) -> list[dict]:
    """The link types out of an object type, for filters on linked objects (Filter List, search bar); for a union the
    type ids comma-separated, each link listed with the object type it starts from (from_type_id)."""
    import ontology_model as om

    ids = list(dict.fromkeys(x.strip() for x in type_id.split(",") if x.strip()))
    for tid in ids:
        ontology._object_type(tid)
    out = []
    for tid, lt, direction in [(tid, lt, d) for tid in ids for lt, d in om.links_of(tid)]:
        _, reach = om.side_of(lt, direction)
        try:
            other = ontology._object_type(reach["object_type_id"])
            ontology.auth.check_resource("object_type", other["id"])
        except HTTPException:
            continue
        out.append({"link_type_id": lt["id"], "direction": direction, "name": reach.get("display_name") or lt.get("display_name") or other["display_name"],
                    "from_type_id": tid, "target_type_id": other["id"], "target_name": other["display_name"],
                    "properties": [{"name": p["api_name"], "label": p.get("display_name") or p["api_name"], "type": p["type"]} for p in other["properties"]]})
    return out


def _join_key(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    return json.dumps(value, sort_keys=True, default=str)


def _join_dataset(cols: list[str], types: dict[str, str], rows: list[dict], spec: JoinSpec) -> tuple[list[str], dict[str, str], list[dict]]:
    right_cols, right_types, right_rows = _dataset_rows(spec.dataset_id)
    if spec.left_key not in cols:
        raise HTTPException(400, f'no left join column "{spec.left_key}"')
    if spec.right_key not in right_cols:
        raise HTTPException(400, f'no right join column "{spec.right_key}"')
    prefix = re.sub(r"[^A-Za-z0-9_]+", "_", spec.prefix.strip()).strip("_") or "joined"
    included = [c for c in right_cols if c != spec.right_key]
    aliases = {c: f"{prefix}_{c}" for c in included}
    collisions = [name for name in aliases.values() if name in cols]
    if collisions:
        raise HTTPException(400, f"joined columns already exist: {', '.join(collisions)}")
    index: dict[str, list[dict]] = {}
    for row in right_rows:
        key = _join_key(row.get(spec.right_key))
        if key is not None:
            index.setdefault(key, []).append(row)
    out: list[dict] = []
    for left in rows:
        matches = index.get(_join_key(left.get(spec.left_key)) or "", [])
        if not matches and spec.mode == "inner":
            continue
        for right in matches or [None]:
            combined = dict(left)
            combined.update({aliases[c]: (right.get(c) if right else None) for c in included})
            out.append(combined)
            if len(out) > MAX_SOURCE_ROWS:
                raise HTTPException(413, f"join result exceeds the {MAX_SOURCE_ROWS:,}-row interactive limit; filter inputs before joining")
    new_types = {**types, **{aliases[c]: right_types.get(c, "String") for c in included}}
    return cols + list(aliases.values()), new_types, out


def _derived_value(row: dict, item: DerivedColumn) -> Any:
    left = row.get(item.column)
    right = row.get(item.other_column) if item.other_column else item.value
    if item.op in ("add", "subtract", "multiply", "divide"):
        a, b = _num(left), _num(right)
        if a is None or b is None or (item.op == "divide" and b == 0):
            return None
        return {"add": a + b, "subtract": a - b, "multiply": a * b, "divide": a / b}[item.op]
    if item.op == "concat":
        return f"{'' if left is None else left}{'' if right is None else right}"
    if left is None:
        return None
    if item.op == "upper":
        return str(left).upper()
    if item.op == "lower":
        return str(left).lower()
    if item.op == "year":
        try:
            return int(str(left)[:4])
        except (TypeError, ValueError):
            return None
    return None


def _apply_derived(cols: list[str], types: dict[str, str], rows: list[dict], derived: list[DerivedColumn]) -> tuple[list[str], dict[str, str], list[dict]]:
    cols = list(cols)
    types = dict(types)
    rows = [dict(row) for row in rows]
    for item in derived:
        name = item.name.strip()
        if not name:
            raise HTTPException(400, "calculated column name cannot be empty")
        if item.column not in cols:
            raise HTTPException(400, f'no expression column "{item.column}"')
        if item.other_column and item.other_column not in cols:
            raise HTTPException(400, f'no second expression column "{item.other_column}"')
        if item.op in ("add", "subtract", "multiply", "divide") and not item.other_column and _num(item.value) is None:
            raise HTTPException(400, "numeric calculated columns require a numeric second column or constant")
        for row in rows:
            row[name] = _derived_value(row, item)
        if name not in cols:
            cols.append(name)
        types[name] = "Integer" if item.op == "year" else "Double" if item.op in ("add", "subtract", "multiply", "divide") else "String"
    return cols, types, rows


def _bucket(v: Any, how: Optional[str]) -> Any:
    if not how or v in (None, ""):
        return v
    s = str(v)
    return s[:10] if how == "day" else s[:7] if how == "month" else s[:4]


def _metric(rows: list[dict], metric: str, col: Optional[str]) -> Any:
    if metric == "count":
        return len(rows)
    vals = [r.get(col) for r in rows if r.get(col) not in (None, "")]
    if metric == "distinct":
        return len({json.dumps(v, sort_keys=True, default=str) for v in vals})
    nums = [n for n in map(_num, vals) if n is not None]
    if not nums:
        return None
    return {"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[metric]


MAX_BUCKETS = 400
TIMELINE_TYPES = ("Date", "Timestamp")
INTEGER_TYPES = ("Byte", "Short", "Integer", "Long")
NUMERIC_TYPES = INTEGER_TYPES + ("Float", "Double", "Decimal")
_INTERVALS = ("day", "week", "month", "year")


def timeline_interval(lo: date, hi: date, wanted: str = "auto") -> tuple[str, int]:
    """The bucket of a timeline over lo..hi and, for years, how many years one bucket holds: the wanted interval, or
    by the range (up to 62 days by day, 62 weeks by week, 62 months by month, else by year); an interval that would
    give more than MAX_BUCKETS buckets gives way to the next coarser one."""
    days = (hi - lo).days + 1
    months = (hi.year - lo.year) * 12 + hi.month - lo.month + 1
    years = hi.year - lo.year + 1
    count = {"day": days, "week": days // 7 + 2, "month": months, "year": years}
    if wanted not in _INTERVALS:
        wanted = "day" if days <= 62 else "week" if days <= 62 * 7 else "month" if months <= 62 else "year"
    while wanted != "year" and count[wanted] > MAX_BUCKETS:
        wanted = _INTERVALS[_INTERVALS.index(wanted) + 1]
    return wanted, (-(-years // MAX_BUCKETS) if wanted == "year" else 1)


def _bucket_start(d: date, interval: str, step: int = 1) -> date:
    if interval == "day":
        return d
    if interval == "week":
        return date.fromordinal(d.toordinal() - d.weekday())
    if interval == "month":
        return d.replace(day=1)
    return date(max(1, d.year - d.year % step), 1, 1)


def _bucket_next(d: date, interval: str, step: int = 1) -> Optional[date]:
    """The start of the bucket after the one starting at d (None past the calendar's end)."""
    try:
        if interval in ("day", "week"):
            return date.fromordinal(d.toordinal() + (1 if interval == "day" else 7))
        if interval == "month":
            return date(d.year + d.month // 12, d.month % 12 + 1, 1)
        return date(d.year - d.year % step + step, 1, 1)
    except (ValueError, OverflowError):
        return None


def _as_day(v: Any) -> Optional[date]:
    """The calendar day an ISO date / timestamp value starts with (as stored: no time zone conversion)."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def numeric_bins(lo: float, hi: float, bins: int = 24, integer: bool = False) -> tuple[float, list[float]]:
    """The step and the edges of a distribution over lo..hi (lo < hi): about `bins` half-open bins [edge, next edge)
    of a round width (1, 2, 2.5 or 5 times a power of ten; whole numbers for integers) starting on a multiple of the
    width; the last edge lies above hi."""
    import math

    bins = max(2, min(int(bins), 100))
    if integer and hi - lo + 1 <= max(bins, 30):
        return 1.0, [float(x) for x in range(int(lo), int(hi) + 2)]
    raw = (hi - lo) / bins
    exp = math.floor(math.log10(raw))
    best: Optional[tuple[float, float, int]] = None
    for e in (exp - 1, exp, exp + 1):
        for m in (1, 2, 2.5, 5):
            step = m * 10.0 ** e
            if integer and (step < 1 or step != int(step)):
                continue
            n = math.floor(hi / step) - math.floor(lo / step) + 1
            if n <= MAX_BUCKETS and (best is None or abs(n - bins) < best[0]):
                best = (abs(n - bins), step, e)
    if best is None:
        step, e = 10.0 ** (exp + 2), exp + 2
    else:
        _, step, e = best
    digits = max(0, min(12, 1 - e))
    first = math.floor(lo / step)
    edges = [round((first + i) * step, digits) for i in range(math.floor(hi / step) - first + 2)]
    while edges[0] > lo:
        edges.insert(0, round(edges[0] - step, digits))
    while edges[-1] <= hi:
        edges.append(round(edges[-1] + step, digits))
    return step, edges


def _histogram(rows: list[dict], types: dict[str, str], cols: list[str], spec: HistogramSpec) -> dict:
    """Bucket counts of spec.column over rows. Buckets are half-open: an object counts in the bucket with
    from <= value < to (a filter gte from + lt to returns exactly the bucket's objects); a property with one distinct
    number gives one closed bucket (from = to: gte + lte). Empty values count as nulls, values that are not a date /
    number as invalid."""
    import bisect
    import math

    if spec.column not in cols:
        raise HTTPException(400, f'no column "{spec.column}"')
    ctype = types.get(spec.column, "String")
    wanted = TIMELINE_TYPES if spec.kind == "timeline" else NUMERIC_TYPES
    if ctype not in wanted:
        raise HTTPException(400, f'a {spec.kind} needs a {"date or timestamp" if spec.kind == "timeline" else "numeric"} property; "{spec.column}" is {ctype}')
    present = [r.get(spec.column) for r in rows if r.get(spec.column) not in (None, "")]
    out: dict[str, Any] = {"kind": spec.kind, "column": spec.column, "type": ctype, "nulls": len(rows) - len(present), "invalid": 0,
                           "count": 0, "min": None, "max": None, "buckets": []}
    if spec.kind == "timeline":
        days = [d for d in map(_as_day, present) if d is not None]
        out.update(invalid=len(present) - len(days), count=len(days), interval=None)
        if not days:
            return out
        lo, hi = min(days), max(days)
        interval, step = timeline_interval(lo, hi, spec.interval)
        counts: dict[date, int] = {}
        for d in days:
            k = _bucket_start(d, interval, step)
            counts[k] = counts.get(k, 0) + 1
        cur: Optional[date] = _bucket_start(lo, interval, step)
        while cur is not None and cur <= hi:
            nxt = _bucket_next(cur, interval, step)
            out["buckets"].append({"from": cur.isoformat(), "to": nxt.isoformat() if nxt else "9999-12-31T99", "count": counts.get(cur, 0)})
            cur = nxt
        out.update(min=lo.isoformat(), max=hi.isoformat(), interval=interval, **({"years": step} if step > 1 else {}))
        return out
    nums = [n for n in map(_num, present) if n is not None and math.isfinite(n)]
    out.update(invalid=len(present) - len(nums), count=len(nums), step=None, integer=False)
    if not nums:
        return out
    lo_n, hi_n = min(nums), max(nums)
    integer = ctype in INTEGER_TYPES and all(n == int(n) for n in nums)
    tidy = (lambda x: int(x) if x == int(x) and abs(x) < 1e15 else x)
    out.update(min=tidy(lo_n), max=tidy(hi_n), integer=integer)
    if lo_n == hi_n:
        out.update(step=0, buckets=[{"from": tidy(lo_n), "to": tidy(hi_n), "count": len(nums), "closed": True}])
        return out
    step_n, edges = numeric_bins(lo_n, hi_n, spec.bins, integer)
    tally = [0] * (len(edges) - 1)
    for n in nums:
        tally[max(0, min(len(tally) - 1, bisect.bisect_right(edges, n) - 1))] += 1
    out.update(step=tidy(step_n), buckets=[{"from": tidy(edges[i]), "to": tidy(edges[i + 1]), "count": tally[i]} for i in range(len(tally))])
    return out


@router.post("/query")
def query(q: Query) -> dict:
    """Rows, groups or a metric of a source (with q.scenario_id: the objects as they are in that scenario)."""
    if q.scenario_id:
        import ontology_scenarios

        with ontology_scenarios.active(q.scenario_id):
            return _query(q)
    return _query(q)


# ------------------------------------------------------------------------------------------------
# Free-form Analysis → Quiver ("Open in Quiver") and → Notepad ("Copy to Notepad")
# ------------------------------------------------------------------------------------------------
#
# The path becomes a Quiver analysis: an object set card for the input object type (a transform table over the
# dataset / restricted view), a transform table with a filter step for the widget's own filters and object set
# filter variables, one more for each Filter object set (and Linked objects) card, and each display card as the
# matching Quiver card reading the table before it. Filters run as SQL expressions written to give Workshop's own
# results (numbers compared as numbers, the rest as text, empty text as null); a filter with no SQL form (keyword
# search, regular expressions, geo, linked objects) is kept as the fixed list of objects it keeps now.

FF_SNAPSHOT_MAX = 10_000
_FF_LABEL = {"filter": "Filter object set", "metric": "Metric", "text": "Text", "table": "Object table", "pivot": "Pivot table", "bar": "Bar chart",
             "pie": "Pie chart", "line": "Line chart", "heat": "Heat grid", "waterfall": "Waterfall", "linked": "Linked objects", "selector": "Object selector"}


class FreeformExportIn(BaseModel):
    name: str = Field("Free-form analysis", min_length=1, max_length=200)
    source: Source
    # the widget's own filters (resolved) and its object set filter variables' values
    filters: list[Filter] = []
    filter_sets: list[FilterSet] = []
    cards: list[dict] = Field(default_factory=list, max_length=40)
    module_id: Optional[str] = None


def _ff_sql(f: Filter) -> Optional[str]:
    """A Workshop filter (workshop._keep) as a DuckDB condition on the Quiver table, or None when it has none."""
    import contour_engine as E

    col = E.q(f.column)
    s = f"CAST({col} AS VARCHAR)"
    d = f"TRY_CAST({col} AS DOUBLE)"
    v = f.value
    if f.column in ("__link", "__pk") or f.op in ("search", "regex", "geo"):
        return None
    if f.op == "is_null":
        return f"({col} IS NULL OR {s} = '')"
    if f.op == "not_null":
        return f"({col} IS NOT NULL AND {s} <> '')"
    if f.op == "in":
        vals = v if isinstance(v, list) else [v]
        return f"COALESCE({s}, 'None') IN ({', '.join(E.lit(str(x)) for x in vals)})" if vals else "FALSE"
    if f.op == "contains":
        return f"contains(lower(COALESCE({s}, '')), {E.lit(str(v).lower())})"
    if f.op == "starts_with":
        n = str(v if v is not None else "").strip().lower()
        # the value or one of its words starts with it (workshop_search.prefix_match: words split on non-word characters)
        return f"(starts_with(lower(COALESCE({s}, '')), {E.lit(n)}) OR len(list_filter(regexp_split_to_array(lower(COALESCE({s}, '')), '\\W+'), lambda w: starts_with(w, {E.lit(n)}))) > 0)"
    b = _num(v)
    if f.op in ("gt", "gte", "lt", "lte"):
        sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.op]
        text = f"COALESCE({s}, '') {sym} {E.lit(str(v))}"
        return f"(CASE WHEN {d} IS NOT NULL THEN {d} {sym} {b!r} ELSE {text} END)" if b is not None else f"({text})"
    if f.op in ("eq", "neq"):
        text = f"COALESCE({s}, 'None') = {E.lit(str(v))}"
        same = f"(CASE WHEN {d} IS NOT NULL THEN {d} = {b!r} ELSE {text} END)" if b is not None else f"({text})"
        return same if f.op == "eq" else f"(NOT {same})"
    return None


def _ff_snapshot(src: Source, fs: FilterSet) -> Optional[list[str]]:
    """The primary keys an object type source keeps under a filter set (filters with no SQL form); None: too many."""
    # a ranked object set (KNN): only its objects are read (the keys then come in its rank order)
    cols, _types, rows = _object_rows(src.id, _ranked_pks(Query(source=src, filter_sets=[fs])))
    rows = _apply_filter_set(src, list(cols), [dict(r) for r in rows], fs)
    keys = [str(r["__pk"]) for r in rows]
    return keys if len(keys) <= FF_SNAPSHOT_MAX else None


def _ff_condition(src: Source, fs: FilterSet, what: str, notes: list[str]) -> Optional[str]:
    """A filter set as one SQL condition: its filters' expressions (all / any), or the objects it keeps now."""
    import contour_engine as E

    if fs.empty:
        notes.append(f"{what}: an empty object set (no query or no results): kept as no objects")
        return "FALSE"
    if fs.contains_prefix:
        fs = fs.model_copy(update={"filters": [_prefix_contains(f) for f in fs.filters]})
    active = [f for f in fs.filters if f.column == "__link" or _set_active(f)]
    sqls = [_ff_sql(f) for f in active]
    if not fs.keyword.strip() and not fs.order and all(x is not None for x in sqls):
        if not sqls:
            return None
        return "(" + (" AND " if fs.mode == "all" else " OR ").join(sqls) + ")"
    if src.kind != "object_type":
        notes.append(f"{what}: not carried over (keyword, regular expression, geo or linked-object filters need an object type input)")
        return None
    keys = _ff_snapshot(src, fs)
    if keys is None:
        notes.append(f"{what}: not carried over (keeps more than {FF_SNAPSHOT_MAX:,} objects; Quiver has no equivalent filter)")
        return None
    notes.append(f"{what}: kept as the {len(keys):,} objects it matched on {date.today().isoformat()} (Quiver has no equivalent filter)")
    return f"CAST(\"primary_key\" AS VARCHAR) IN ({', '.join(E.lit(k) for k in keys)})" if keys else "FALSE"


def freeform_quiver(req: FreeformExportIn, suffix: str = "") -> dict:
    """The Quiver analysis of a Free-form path: created, with the card mapping and the notes on what did not carry over."""
    import ts_derived

    if req.module_id:
        _module(req.module_id)
    src = req.source
    if src.kind not in ("object_type", "dataset", "restricted_view"):
        raise HTTPException(400, "Open in Quiver needs an object type, a dataset or a restricted view as the input")
    # the source exists and the user can read it; its date / timestamp columns
    time_cols = {c["name"] for c in query(Query(source=src, limit=0)).get("columns") or [] if str(c.get("type") or "").lower() in ("date", "timestamp")}
    notes: list[str] = []
    cards: list[dict] = []
    texts: list[str] = []
    ids: set[str] = set()

    def new_id(prefix: str) -> str:
        n = 1
        while f"{prefix}{n}" in ids:
            n += 1
        ids.add(f"{prefix}{n}")
        return f"{prefix}{n}"

    if src.kind == "object_type":
        t = ontology._object_type(src.id)
        base = {"id": f"object-{ontology._new_id('x')[-8:]}", "object_type_id": src.id, "title": t["display_name"], "query": "", "filters": [],
                "visualization": "table", "group_by": None, "metric": "count", "measure": None}
        ids.add(base["id"])
        cards.append(base)
        cur, cur_kind = base["id"], "object_set"
    else:
        cur = new_id("T")
        cards.append({"id": cur, "kind": "table", "title": "Input", "source": {"kind": src.kind, "id": src.id}, "steps": []})
        cur_kind = "table"

    def stage(title: str, conds: list[str]) -> None:
        nonlocal cur, cur_kind
        conds = [x for x in conds if x]
        if not conds:
            return
        tid = new_id("T")
        cards.append({"id": tid, "kind": "table", "title": title, "source": {"kind": cur_kind, "card": cur},
                      "steps": [{"id": "ff", "type": "filter", "config": {"conditions": [], "expression": " AND ".join(conds)}}]})
        cur, cur_kind = tid, "table"

    own = FilterSet(filters=req.filters, mode="all")
    stage("Input filters", [_ff_condition(src, own, "The widget's filters", notes)] +
          [_ff_condition(src, fs, f"Object set filter variable {i + 1}", notes) for i, fs in enumerate(req.filter_sets)])
    mapping: dict[str, str] = {}
    acc: list[FilterSet] = []  # the path's filter / link cards so far (Workshop's form)
    for n, fc in enumerate(req.cards, 1):
        kind = str(fc.get("kind") or "")
        cfg = fc.get("config") or {}
        fid = str(fc.get("id") or n)
        label = f"{_FF_LABEL.get(kind, kind)} (card {n})"
        g, g2 = str(cfg.get("group_by") or ""), str(cfg.get("group_by2") or "")
        metric = str(cfg.get("metric") or "count")
        mcol = str(cfg.get("metric_column") or "")
        if metric != "count" and not mcol:
            metric = "count"  # the widget counts until a column is chosen
        try:
            if kind == "filter":
                flt = [Filter(**x) for x in cfg.get("filters") or [] if isinstance(x, dict) and x.get("column")]
                flt = [f for f in flt if f.op in ("is_null", "not_null") or f.value != ""]
                before = cur
                acc.append(FilterSet(filters=flt, mode="all"))
                stage("Filter object set", [_ff_condition(src, acc[-1], label, notes)])
                if cur != before:
                    mapping[fid] = cur
            elif kind == "linked":
                if not cfg.get("link"):
                    continue
                if src.kind != "object_type":
                    notes.append(f"{label}: not carried over (no object type input)")
                    continue
                lid, direction = str(cfg["link"]).split(":", 1)
                lf = Filter(column="__link", op="eq", value={"link_type_id": lid, "direction": direction, "filters": []})
                before = cur
                acc.append(FilterSet(filters=[lf]))
                stage("Linked objects", [_ff_condition(src, acc[-1], label, notes)])
                if cur != before:
                    mapping[fid] = cur
            elif kind == "text":
                if str(cfg.get("text") or "").strip():
                    texts.append(str(cfg["text"]).strip())
                    notes.append(f"{label}: Quiver has no text card; the text is in the analysis description")
            elif kind == "metric":
                agg = {"count": "COUNT(*)", "distinct": f"COUNT(DISTINCT NULLIF(CAST({_q(mcol)} AS VARCHAR), ''))"}.get(metric) or \
                    f"{metric.upper()}(TRY_CAST({_q(mcol)} AS DOUBLE))"
                vid = new_id("V")
                cards.append({"id": vid, "kind": "value", "title": f"{metric}{' of ' + mcol if metric != 'count' else ''}", "source": {"card": cur}, "expr": agg})
                mapping[fid] = vid
            elif kind in ("bar", "pie", "line"):
                if not g:
                    notes.append(f"{label}: not carried over (no group by chosen)")
                    continue
                cid = new_id("C")
                cards.append({"id": cid, "kind": "chart", "title": f"{_FF_LABEL[kind]}: {metric} by {g}", "source": {"card": cur}, "chart": kind,
                              "config": {"x": g, "metric": metric, **({"metric_column": mcol} if metric != "count" else {}), "limit": 100}})
                mapping[fid] = cid
            elif kind in ("pivot", "heat"):
                if not g:
                    notes.append(f"{label}: not carried over (no rows chosen)")
                    continue
                cid = new_id("C")
                if kind == "heat" and g2:
                    chart, conf = "heatmap", {"x": g, "y": g2, "metric": metric, **({"metric_column": mcol} if metric != "count" else {})}
                elif g2 and metric == "distinct":
                    chart, conf = "heatmap", {"x": g, "y": g2, "metric": metric, "metric_column": mcol}
                    notes.append(f"{label}: a unique count by two properties is a heat map in Quiver (its pivot table has no unique count across columns)")
                else:
                    chart = "pivot"
                    conf = {"rows": [g], **({"columns": g2} if g2 else {}), "values": [{"metric": metric, **({"column": mcol} if metric != "count" else {})}]}
                cards.append({"id": cid, "kind": "chart", "title": f"{_FF_LABEL[kind]}: {metric} by {g}{' and ' + g2 if g2 else ''}", "source": {"card": cur},
                              "chart": chart, "config": conf})
                mapping[fid] = cid
            elif kind == "waterfall":
                val = str(cfg.get("value") or "")
                if not g:
                    notes.append(f"{label}: not carried over (no group by chosen)")
                    continue
                wid = new_id("W")
                cards.append({"id": wid, "kind": "waterfall", "title": f"Waterfall: {'sum of ' + val if val else 'count'} by {g}", "source": {"card": cur},
                              "group_by": g, "metric": "sum" if val else "count", **({"measure": val} if val else {}), "sort": "key", "limit": 50, "total": False})
                mapping[fid] = wid
                ngroups = query(Query(source=src, filters=req.filters, filter_sets=[*req.filter_sets, *acc], group_by=g, limit=1)).get("group_count") or 0
                if ngroups > 50:
                    notes.append(f"{label}: Quiver's waterfall shows at most 50 buckets (the path has {ngroups})")
            elif kind == "table":
                tid = new_id("T")
                shown = [str(x) for x in cfg.get("columns") or [] if x]
                cards.append({"id": tid, "kind": "table", "title": "Object table", "source": {"kind": cur_kind, "card": cur}, "steps": [], **({"columns": shown} if shown else {})})
                mapping[fid] = tid
            elif kind == "selector":
                if src.kind != "object_type":
                    notes.append(f"{label}: not carried over (an object selector needs an object type input)")
                    continue
                sid = new_id("OS")
                cards.append({"id": sid, "kind": "object_selector", "title": "Object selector", "source": {"card": cur},
                              **({"label": str(cfg["title"])} if cfg.get("title") else {}), **({"value": str(cfg["pk"])} if cfg.get("pk") else {})})
                mapping[fid] = sid
            else:
                notes.append(f"{label}: no Quiver counterpart")
        except (TypeError, ValueError) as e:
            notes.append(f"{label}: not carried over ({e})")
    desc = "\n\n".join([f"Opened from a Workshop Free-form Analysis ({req.name})." if not suffix else f"Copied from a Workshop Free-form Analysis ({req.name}).",
                        *texts, *(["Not carried over / changed:\n" + "\n".join(f"- {x}" for x in notes)] if notes else [])])
    shown_ids = [c["id"] for c in cards]
    rng = _ff_time_range(time_cols, [own, *req.filter_sets, *acc])
    a = ts_derived.create_analysis(ts_derived.AnalysisIn(
        name=f"{req.name}{suffix}"[:200], description=desc, object_sets=cards, range=rng,
        canvases=[{"id": "canvas-main", "name": "Canvas", "cards": shown_ids}],
        dashboard={"cards": [mapping[str(x.get("id"))] for x in req.cards if str(x.get("id")) in mapping and x.get("kind") not in ("filter", "linked")], "inputs": []}))
    return {"analysis_id": a["id"], "name": a["name"], "cards": mapping, "notes": notes, "texts": texts, "range": a.get("range", rng)}


def _ff_time_range(time_cols: set[str], sets: list[FilterSet]) -> dict:
    """The Quiver analysis' time range for a Free-form path. The widget has no time range of its own (Workshop's
    Free-form Analysis docs give it none), so: the bounds of the path's filters on date / timestamp columns (all of them
    applying: "all" sets, or a set of one filter) when there are any, else all time ({start: None, end: None}: Quiver's
    "All"; an empty range would become Quiver's default of the last 7 days). The filters themselves are carried as
    filter cards either way; the range is what Quiver's time series and time-based cards default to."""
    import ts_engine as TE

    lo: Optional[tuple[int, str]] = None
    hi: Optional[tuple[int, str]] = None
    for fs in sets:
        if fs.mode == "any" and len(fs.filters) > 1:
            continue  # one of several: no bound for the whole path
        for f in fs.filters:
            if f.column not in time_cols or f.op not in ("eq", "gt", "gte", "lt", "lte"):
                continue
            try:
                ms = TE.to_ms(f.value)
            except TE.EngineError:
                ms = None
            if ms is None:
                continue
            # a whole day ("lte 2026-01-31" on a date column) ends at the end of that day
            end = ms + 86_399_999 if f.op in ("eq", "lte") and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(f.value).strip()) else ms
            if f.op in ("eq", "gt", "gte") and (lo is None or ms > lo[0]):
                lo = (ms, TE.iso(ms))
            if f.op in ("eq", "lt", "lte") and (hi is None or end < hi[0]):
                hi = (end, TE.iso(end))
    return {"start": lo[1] if lo else None, "end": hi[1] if hi else None}


def _q(name: str) -> str:
    import contour_engine as E

    return E.q(name)


@router.post("/freeform/quiver")
def freeform_to_quiver(req: FreeformExportIn) -> dict:
    """Open in Quiver: a new Quiver analysis from the path (changes there do not come back to the widget)."""
    return freeform_quiver(req)


class FreeformNotepadIn(FreeformExportIn):
    # the cards to copy (default: every display card)
    card_ids: Optional[list[str]] = None
    # an existing document (the cards are added at its end), else a new one named document_name in parent_id (default:
    # the module's folder)
    document_id: Optional[str] = None
    document_name: Optional[str] = Field(None, max_length=200)
    parent_id: Optional[str] = None


@router.post("/freeform/notepad")
def freeform_to_notepad(req: FreeformNotepadIn) -> dict:
    """Copy to Notepad: the chosen cards as embedded Quiver widgets (over a Quiver analysis made for the copy) and text
    cards as paragraphs, added to a new or an existing Notepad document."""
    import uuid

    import notepad

    if req.document_id:
        cur = notepad.get_document(req.document_id)
        drive._item(req.document_id, need="editor")
    pick = set(req.card_ids) if req.card_ids is not None else None
    a = freeform_quiver(req, " (Notepad copy)")
    bid = lambda: f"ff-{uuid.uuid4().hex[:10]}"  # noqa: E731
    blocks: list[dict] = [{"id": bid(), "type": "heading", "level": 2, "text": req.name}]
    added, skipped = [], []
    for n, fc in enumerate(req.cards, 1):
        fid, kind = str(fc.get("id") or n), str(fc.get("kind") or "")
        if kind in ("filter", "linked") or (pick is not None and fid not in pick):
            continue
        label = _FF_LABEL.get(kind, kind)
        if kind == "text":
            text = str((fc.get("config") or {}).get("text") or "").strip()
            if text:
                blocks.append({"id": bid(), "type": "paragraph", "text": text[:20_000]})
                added.append(fid)
            continue
        if fid not in a["cards"]:
            skipped.append(f"{label} (card {n})")
            continue
        blocks.append({"id": bid(), "type": "widget", "kind": "quiver_chart", "config": {"analysis_id": a["analysis_id"], "card_id": a["cards"][fid]}})
        added.append(fid)
    notes = [x for x in a["notes"] if not x.endswith("the text is in the analysis description")]
    if notes or skipped:
        blocks.append({"id": bid(), "type": "paragraph", "text": "Not copied / changed: " + "; ".join([*(f"{x}: not set up" for x in skipped), *notes])})
    if req.document_id:
        doc = cur["document"]
        doc["blocks"] = doc["blocks"] + blocks
        if len(doc["blocks"]) > 200:
            raise HTTPException(400, "the document would have more than 200 blocks")
        out = notepad.save_document(req.document_id, notepad.SaveDocumentRequest(expected_updated_at=cur["item"]["updated_at"], document=notepad.NotepadDocument.model_validate(doc)))
    else:
        parent = req.parent_id
        if parent is None and req.module_id:
            m = _module(req.module_id)
            if m.get("item_id"):
                try:
                    parent = drive._item(m["item_id"]).get("parent_id")
                    if parent:
                        drive._item(parent, need="editor")
                except HTTPException:
                    parent = None
        out = notepad.create_document(notepad.CreateDocumentRequest(name=(req.document_name or req.name).strip()[:200], parent_id=parent,
                                                                    document=notepad.NotepadDocument.model_validate({"blocks": blocks})))
    return {"item": out["item"], "analysis_id": a["analysis_id"], "added": added, "skipped": skipped, "notes": a["notes"]}


# ------------------------------------------------------------------------------------------------
# Comments widget: a comment, then the thread's default notifications
# ------------------------------------------------------------------------------------------------


class WidgetCommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    attachments: list[str] = Field([], max_length=10)  # Files item ids
    reply_to: Optional[str] = None
    # Send default notifications: everyone subscribed to the thread (who commented or was mentioned on the object
    # before) is notified; off when the module's action after commenting sends its own notification
    notify: bool = True
    # the module the comment was made in: the notification links to it (otherwise to the object)
    module_id: Optional[str] = None


def thread_subscribers(type_id: str, pk: str) -> set[str]:
    """The users subscribed to an object's comment thread: everyone who commented on it or was mentioned in it."""
    import object_views

    out: set[str] = set()
    for c in object_views.comments_of(type_id, pk):
        if c.get("user") and c["user"] != "local":
            out.add(c["user"])
        out |= {m["user_id"] for m in c.get("mentions") or [] if m.get("user_id")}
    return out


@router.post("/comments/{type_id}/{pk}")
def widget_comment(type_id: str, pk: str, req: WidgetCommentIn) -> dict:
    """Post a comment from the Comments widget (object_views.add_comment: the object's permissions, @mentions notify),
    then notify the thread's other subscribers who can still see the object. Returns the comment with `notified` (the
    users notified now) and `users_to_notify` (every subscriber but the author, mentioned users included: the value
    the widget passes to an action after commenting)."""
    import auth
    import notify
    import object_views

    if req.module_id:
        _module(req.module_id)
    before = thread_subscribers(type_id, pk)
    c = object_views.add_comment(type_id, pk, object_views.CommentIn(text=req.text, attachments=req.attachments, reply_to=req.reply_to))
    me = c["user"]
    mentioned = {m["user_id"] for m in c.get("mentions") or [] if m.get("user_id")}
    notified: list[str] = []
    if req.notify:
        t = ontology._object_type(type_id)
        title = ontology.get_object(type_id, pk)["title"]
        who = (auth.user_label(me) or {}).get("username") if me != "local" else None
        link = f"/workshop/{req.module_id}" if req.module_id else f"/ontology/objects/{type_id}/{pk}?tab=tab-comments"
        for uid in sorted(before - mentioned - {me}):  # mentioned users had their mention notification
            p = auth.principal_of(uid)
            if p is None:
                continue  # deleted or deactivated
            token = auth._principal.set(p)
            try:
                ontology.get_object(type_id, pk)  # the comment follows the object's permissions: no notice to who cannot see it
            except HTTPException:
                continue
            finally:
                auth._principal.reset(token)
            notify.deliver(uid, f"{who or 'Someone'} commented on {title}", c["text"][:500], link=link,
                           link_label="Open the module" if req.module_id else f"Open {t['display_name']}", source="object-comments")
            notified.append(uid)
    return {**c, "notified": notified, "users_to_notify": sorted((before | mentioned) - {me})}


@router.get("/comments/{type_id}/{pk}/people")
def comment_people(type_id: str, pk: str, log: bool = False) -> dict:
    """The names of the people in an object's comment feed (authors, mentioned users and, with `log`, the users in its
    action log), so the Comments widget shows names instead of user ids. Only for a reader of the object, only the ids
    that appear on it, and only a name: {user id: {username, display_name}}."""
    import auth
    import object_views

    ontology.get_object(type_id, pk)  # the object's permissions: who cannot see the object gets no names from it
    ids: set[str] = set()
    for c in object_views.comments_of(type_id, pk):
        if c.get("user"):
            ids.add(str(c["user"]))
        ids |= {str(m["user_id"]) for m in c.get("mentions") or [] if m.get("user_id")}
    if log:
        import ontology_actions

        try:
            ids |= {str(x["user"]) for x in ontology_actions.log_for_object(type_id, pk) if x.get("user")}
        except HTTPException:
            pass
    out: dict[str, dict] = {}
    for uid in sorted(ids - {"local"}):
        try:
            u = auth.user_label(uid)
        except Exception:  # noqa: BLE001 - no user store (sign-in off): the ids stay as they are
            break
        if u and u.get("status") != "deleted":
            out[uid] = {"username": u["username"], "display_name": u.get("display_name") or None}
    return out


# ------------------------------------------------------------------------------------------------
# scenarios [Legacy]: saving a scenario to a scenario object (Save scenario), save states
# ------------------------------------------------------------------------------------------------

SC_RID, SC_NAME, SC_LOCATOR = "versioned-scenario-rid", "scenario-name", "scenario-object-locator"


def _has_tc(rec: Optional[dict], name: str) -> bool:
    """A type class "scenarios:<name>" (or any kind with that name) on a property or a parameter."""
    return any(str(tc).split(":", 1)[-1] == name for tc in (rec or {}).get("type_classes") or [])


class ScenarioSaveIn(BaseModel):
    # the object type implementing the scenario trait (an ID property with scenarios:versioned-scenario-rid, a name
    # property with scenarios:scenario-name) and the actions that create / update its objects; none: the save only
    # persists the scenario (it is still marked Saved)
    object_type_id: Optional[str] = None
    create_action_id: Optional[str] = None
    update_action_id: Optional[str] = None
    # the user's values of the other parameters (the scenario id, name and object are filled automatically)
    parameters: dict[str, Any] = {}
    # the filled parameters only: nothing is saved
    preview: bool = False


def _scenario_object_type(type_id: str) -> tuple[dict, str, Optional[str]]:
    t = ontology._read(ontology._path("object-types", type_id))
    if not t:
        raise HTTPException(404, "object type not found")
    props = t.get("properties") or []
    rid = next((p["api_name"] for p in props if _has_tc(p, SC_RID)), None)
    if not rid:
        raise HTTPException(400, f"{t['display_name']} does not implement the scenario trait: give its ID property the type class scenarios:{SC_RID}")
    return t, rid, next((p["api_name"] for p in props if _has_tc(p, SC_NAME)), None)


def _scenario_params(action: dict, t: dict, sc: dict, pk: Optional[str]) -> dict[str, Any]:
    """The parameters filled from their type classes (or the type classes of the scenario object type's properties
    they write): the scenario id, its name, and on an update the scenario object (the locator)."""
    props = {p["api_name"]: p for p in t.get("properties") or []}
    params = action.get("parameters") or []
    same_type = action.get("object_type_id") == t["id"]
    out: dict[str, Any] = {"values": {}, "filled": [], "locked": [], "id": None, "name": None, "locator": None}
    explicit_locator = any(_has_tc(p, SC_LOCATOR) for p in params)
    for p in params:
        prop = props.get(p.get("property") or "") if same_type else None
        if _has_tc(p, SC_RID) or _has_tc(prop, SC_RID):
            kind, value = "id", sc["rid"]
        elif _has_tc(p, SC_NAME) or _has_tc(prop, SC_NAME):
            kind, value = "name", sc["name"]
        elif pk is not None and (_has_tc(p, SC_LOCATOR) or (not explicit_locator and same_type and p.get("type") == "object" and not p.get("property")
                                                            and p.get("object_type_id", t["id"]) == t["id"])):
            kind, value = "locator", pk
        else:
            continue
        out["values"][p["id"]] = value
        out["filled"].append(p["id"])
        if kind != "name":
            out["locked"].append(p["id"])
        out[kind] = out[kind] or p["id"]
    return out


@router.post("/scenarios/{sid}/save")
def save_scenario(sid: str, req: ScenarioSaveIn) -> dict:
    """Save a scenario: persist it and create its scenario object with the create action, or update the object that
    already stores it with the update action. The scenario id, name and object parameters are filled from their type
    classes; with preview, only the filled parameters (and the required ones still missing) are returned."""
    import ontology_scenarios as osc

    sc = osc._owned(sid)
    if sc.get("staged"):
        raise HTTPException(400, "a function run's transaction cannot be saved")
    if sc.get("merged"):
        raise HTTPException(400, f"{sc['name']} was merged: create a new scenario to keep exploring")
    if not req.object_type_id:
        out0: dict[str, Any] = {"mode": "persist", "object_type_id": None, "primary_key": None, "action_type_id": None, "action": None,
                                "parameters": {}, "filled": [], "locked": [], "missing": [], "fields": []}
        if req.preview:
            return out0
        return out0 | {"scenario": osc.mark_saved(sc["id"], None, None)}
    t, rid_prop, name_prop = _scenario_object_type(req.object_type_id)
    # the object that already stores this scenario (main, never a scenario's view)
    token = ontology.SCENARIO.set(None)
    try:
        objs = ontology.load_objects(t["id"])
    finally:
        ontology.SCENARIO.reset(token)
    existing = next((pk for pk, o in objs.items() if str((o.get("properties") or {}).get(rid_prop) or "") in (sc["rid"], sc["id"])), None)
    mode = "update" if existing else "create"
    action_id = req.update_action_id if existing else req.create_action_id
    if not existing and not action_id:
        raise HTTPException(400, "choose the action that creates scenario objects")
    action = ontology._action_type(action_id) if action_id else None
    out: dict[str, Any] = {"mode": mode, "object_type_id": t["id"], "primary_key": existing, "action_type_id": action_id,
                           "action": action["display_name"] if action else None, "id_property": rid_prop, "name_property": name_prop}
    values: dict[str, Any] = {}
    missing: list[str] = []
    if action:
        if action.get("object_type_id") != t["id"]:
            raise HTTPException(400, f"{action['display_name']} does not {'create' if mode == 'create' else 'update'} {t['display_name']} objects")
        fill = _scenario_params(action, t, sc, existing)
        if mode == "create" and not fill["id"]:
            raise HTTPException(400, f"{action['display_name']} has no parameter for the scenario id (type class scenarios:{SC_RID})")
        if mode == "update" and not fill["locator"]:
            raise HTTPException(400, f"{action['display_name']} has no parameter for the scenario object (type class scenarios:{SC_LOCATOR})")
        known = {p["id"] for p in action.get("parameters") or []}
        values = {**fill["values"], **{k: v for k, v in req.parameters.items() if k in known and k not in fill["locked"]}}
        missing = [p["id"] for p in action.get("parameters") or [] if p.get("required") and not p.get("prefill") and values.get(p["id"]) in (None, "", [])]
        # the form Workshop shows: every parameter, the filled ones first (locked ones read-only)
        fields = [{"id": p["id"], "display_name": p.get("display_name") or p["id"], "type": p.get("type") or "string",
                   "required": bool(p.get("required")), "filled": p["id"] in fill["filled"], "locked": p["id"] in fill["locked"]}
                  for p in action.get("parameters") or []]
        fields.sort(key=lambda f: not f["filled"])
        out.update(parameters=values, filled=fill["filled"], locked=fill["locked"], name_parameter=fill["name"], missing=missing, fields=fields)
    if req.preview:
        return out
    if missing:
        names = {p["id"]: p.get("display_name") or p["id"] for p in action.get("parameters") or []} if action else {}
        raise HTTPException(400, "fill " + ", ".join(names.get(m, m) for m in missing))
    # the scenario's name follows the name parameter when the user changed it
    name_param = out.get("name_parameter")
    new_name = values.get(name_param) if name_param and isinstance(values.get(name_param), str) and values[name_param] != sc["name"] else None
    pk = existing
    if action:
        token = ontology.SCENARIO.set(None)
        try:
            result = ontology.apply_action(action["id"], ontology.ApplyAction(parameters=values))
        finally:
            ontology.SCENARIO.reset(token)
        out["result"] = {k: result.get(k) for k in ("edits", "applied_at") if k in result}
        if not pk:
            objs = ontology.load_objects(t["id"])
            pk = next((k for k, o in objs.items() if str((o.get("properties") or {}).get(rid_prop) or "") == sc["rid"]), None)
    saved = osc.mark_saved(sc["id"], t["id"], pk, new_name)
    return out | {"primary_key": pk, "scenario": saved}


class ScenarioStatesIn(BaseModel):
    ids: list[str] = Field([], max_length=200)


@router.post("/scenario-states")
def scenario_states(req: ScenarioStatesIn) -> dict:
    """Each scenario's save state for the Scenario Manager: new, saved or updated (changed since it was saved)."""
    import ontology_scenarios as osc

    out = {}
    for ref in req.ids:
        try:
            out[ref] = osc.saved_state(ref)
        except HTTPException:
            continue
    return out


def _ranked_pks(q: Query) -> Optional[list[str]]:
    """The primary keys a ranked object set (a KNN variable's value) keeps, when only they can pass the query: an
    object type source and a filter set, holding like every filter set, whose `__pk in` filter must hold (mode all, or
    its only filter) and whose rank order covers those keys (the rows are then put in that order whatever order they
    were read in); none at all for an empty object set. None: read the whole type."""
    if q.source.kind != "object_type":
        return None
    for fs in q.filter_sets:
        if fs.empty:
            return []
        if not fs.order:
            continue
        active = [f for f in fs.filters if f.column == "__link" or _set_active(f)]
        pk_in = next((f for f in active if f.column == "__pk" and f.op == "in"), None)
        if pk_in is None or (fs.mode == "any" and len(active) > 1):
            continue
        keys = [str(w) for w in (pk_in.value if isinstance(pk_in.value, list) else [pk_in.value])]
        if set(keys) <= set(fs.order):
            return keys
    return None


def _semantic_first(q: Query) -> Optional[list[dict]]:
    """A semantic search box over a whole object type (nothing else narrows the rows): the type ranked first
    (ontology_semantic.rank_type, the top hits' records only with a current ANN index), so only those objects' rows
    are read. None when the query narrows the rows first (filters, filter sets, search, an inner join)."""
    if not (q.semantic and q.source.kind == "object_type" and str(q.semantic.get("query") or "").strip()):
        return None
    if (any(f.op in ("is_null", "not_null") or f.value not in (None, "", []) for f in q.filters) or q.additional_filters
            or q.filter_sets or q.search.strip() or q.join):
        return None
    import ontology_semantic

    t = ontology._object_type(q.source.id)
    ranked, _ = ontology_semantic.rank_type(t, str(q.semantic["query"]), q.semantic.get("mode") or "semantic",
                                            int(q.semantic.get("k") or 20), q.semantic.get("property"))
    return ranked


def _query(q: Query) -> dict:
    import workshop_search

    workshop_search.start_budget(q.source.kind, q.source.id)
    # a ranked object set (KNN) or a semantic search box over the whole type: only its objects' records are read
    sem_first = _semantic_first(q)
    pks = [r["primary_key"] for r in sem_first] if sem_first is not None else _ranked_pks(q)
    cols, types, rows = (_dataset_rows(q.source.id) if q.source.kind == "dataset" else _interface_rows(q.source.id) if q.source.kind == "interface"
                         else _restricted_rows(q.source.id) if q.source.kind == "restricted_view"
                         else _union_rows(q.source.id) if q.source.kind == "object_types" else _object_rows(q.source.id, pks))
    cols, types, rows = list(cols), dict(types), [dict(row) for row in rows]
    if q.join:
        cols, types, rows = _join_dataset(cols, types, rows, q.join)
    if q.derived:
        cols, types, rows = _apply_derived(cols, types, rows, q.derived)
    for f in q.filters:
        if f.column not in cols:
            raise HTTPException(400, f'no column "{f.column}"')
    # a filter on an empty value (a module variable not set yet) does not filter
    active = [f for f in q.filters if f.op in ("is_null", "not_null") or f.value not in (None, "", [])]
    if active:
        rows = [r for r in rows if (all if q.filter_mode == "all" else any)(_keep(r, f) for f in active)]
    for f in q.additional_filters:
        if f.column not in cols:
            raise HTTPException(400, f'no column "{f.column}"')
        if f.op == "geo":
            lon_col = f.value.get("lon_column") if isinstance(f.value, dict) else None
            if lon_col and lon_col not in cols:
                raise HTTPException(400, f'no column "{lon_col}"')
            _geo_region(f.value)
        rows = [r for r in rows if _keep(r, f)]
    for fs in q.filter_sets:
        rows = _apply_filter_set(q.source, cols, rows, fs)
    ranked = next((fs for fs in q.filter_sets if fs.order), None)
    if ranked:
        # a ranked object set (KNN): its rank order, and its relevance as a column
        at = {pk: i for i, pk in enumerate(ranked.order)}
        rows.sort(key=lambda r: at.get(str(r.get("__pk")), len(at)))
        if ranked.relevance:
            rows = [{**r, "relevance": ranked.relevance.get(str(r.get("__pk")))} for r in rows]
            cols = cols + ["relevance"] if "relevance" not in cols else cols
            types = {**types, "relevance": "Double"}
            if q.columns and "relevance" not in q.columns:
                q.columns = q.columns + ["relevance"]
    if q.search.strip():
        needle = q.search.strip().lower()
        rows = [r for r in rows if any(needle in str(v).lower() for k, v in r.items() if k != "__pk")]
    if q.semantic and q.source.kind == "object_type" and str(q.semantic.get("query") or "").strip():
        import ontology_semantic

        if sem_first is not None:
            ranked = sem_first  # ranked over the whole type before its top hits were read
        else:
            t = ontology._object_type(q.source.id)
            # rank_type: semantic ranking with a current ANN index reads only the top hits' records (not the rows again)
            ranked, _ = ontology_semantic.rank_type(t, str(q.semantic["query"]), q.semantic.get("mode") or "semantic",
                                                    int(q.semantic.get("k") or 20), q.semantic.get("property"),
                                                    pks=list(dict.fromkeys(str(r["__pk"]) for r in rows)))
        by_pk = {str(r["__pk"]): r for r in rows}
        rows = [{**by_pk[r["primary_key"]], "relevance": r["relevance"]} for r in ranked if r["primary_key"] in by_pk]
        cols = cols + ["relevance"] if "relevance" not in cols else cols
        types = {**types, "relevance": "Double"}
        if q.columns and "relevance" not in q.columns:
            q.columns = q.columns + ["relevance"]
    total = len(rows)
    # an object type's columns carry their property's display name (the table header shows it)
    labels = {p["api_name"]: p["display_name"] for p in ontology._object_type(q.source.id)["properties"]} if q.source.kind == "object_type" else {}
    if q.metric != "count" and q.metric_column and q.metric_column not in cols:
        raise HTTPException(400, f'no column "{q.metric_column}"')
    if q.histogram:
        return {"total": total, "histogram": _histogram(rows, types, cols, q.histogram),
                "columns": [{"name": c, "type": types.get(c, "String"), **({"label": labels[c]} if c in labels else {})} for c in cols]}
    if q.group_by:
        if q.group_by not in cols:
            raise HTTPException(400, f'no column "{q.group_by}"')
        groups: dict[Any, list[dict]] = {}
        for r in rows:
            key = _bucket(r.get(q.group_by), q.bucket)
            groups.setdefault(json.dumps(key, default=str), []).append(r)
        out = [{"key": json.loads(k), "value": _metric(rs, q.metric, q.metric_column), "count": len(rs)} for k, rs in groups.items()]
        if q.sort == "key":
            out.sort(key=lambda g: (g["key"] is None, _num(g["key"]) if _num(g["key"]) is not None else str(g["key"])), reverse=q.descending)
        else:
            out.sort(key=lambda g: (_num(g["value"]) is None, -(_num(g["value"]) or 0)))
        return {"total": total, "groups": out[: max(1, min(q.limit, MAX_RESULT_ROWS))], "group_count": len(out),
                "columns": [{"name": c, "type": types.get(c, "String"), **({"label": labels[c]} if c in labels else {})} for c in cols]}
    if q.sort and q.sort in cols:
        have = [r for r in rows if r.get(q.sort) not in (None, "")]
        empty = [r for r in rows if r.get(q.sort) in (None, "")]
        numeric = all(_num(r[q.sort]) is not None for r in have)
        have.sort(key=lambda r: _num(r[q.sort]) if numeric else str(r[q.sort]).lower(), reverse=q.descending)
        rows = have + empty
    shown = [c for c in q.columns if c in cols] or cols
    limit = max(0, min(q.limit, MAX_RESULT_ROWS))
    return {
        "total": total,
        "value": _metric(rows, q.metric, q.metric_column),
        "columns": [{"name": c, "type": types.get(c, "String"), **({"label": labels[c]} if c in labels else {})} for c in shown],
        "rows": [{**{c: r.get(c) for c in shown}, **({k: r[k] for k in ("__pk", "__markings") if k in r})} for r in rows[:limit]],
    }
