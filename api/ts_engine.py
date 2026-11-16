"""The time series query engine behind time series properties, derived series, Quiver analyses, time series
alerting and FoundryTS (Palantir's time series docs: "Interpolation in time series", "Which Quiver cards are
supported in derived series logic / time series alerting logic", "Time series query compute usage").

A series is a sorted list of (epoch ms, value) points with an internal interpolation (LINEAR, NEAREST, PREVIOUS,
NEXT or NONE) and an external one (NEAREST or NONE, before the first and after the last point). Numeric series
default to LINEAR, categorical (text) series to PREVIOUS.

Combining series (a formula, bounds, a linked series aggregation) follows the doc: when every input has a defined
interpolation the output has a point at the union of all their timestamps, each input interpolated there; when some
inputs have no interpolation, only the intersection of those inputs' timestamps is used. A timestamp where an input
has no value (no external interpolation past its end) gives no output point.

Logic is a list of cards, each with an identifier ("A", "B", ...) referenced as $A in formulas and as `input` in
other cards, and one output card:

  tsp              a time series property of the root object (or of `object`), or of a linked sensor
                   ("sensor:<sensor name>"); its value may be a series ID, a qualified series ID or a derived series
  series           a series ID in a time series sync (FoundryTS's TimeseriesNode)
  derived          a derived series (template RID, optional version) resolved for the root object or `object`
  function         a function-backed series: a Python function in a code repository returning timestamp / value
  formula          pointwise expression over cards: $A - $B, $A > 120 && $B < 3, abs(...), if_else(c, a, b), @prop
  filter           keep points in a value range, a time range or a set of categorical values
  derivative       rate of change per second / minute / hour / day
  integral         running trapezoid integral from the start of the range
  cumulative       running sum / count / min / max / mean from the start of the range
  rolling          trailing time window aggregate (mean, sum, min, max, count, std, median, first, last, range)
  periodic         aggregate per calendar period (s, m, h, d, w, mo, y; UTC)
  sample           values at a regular interval, by the input's interpolation
  shift            move the points in time
  relative         align the series' start with another time (overlays) or subtract the value at the start
  combine          union of the points of several series (earlier inputs win on equal timestamps)
  bollinger        rolling mean ± k standard deviations (upper, lower or middle band)
  bounds           pointwise upper / lower envelope of several series
  dsp              moving average, exponential smoothing, low-pass or high-pass filter
  segment_stats    one aggregate per segment: the intervals of a search card, or periods
  linked_agg       aggregate the default series of every sensor linked to the root object
  aggregate        one number over the range (numeric aggregation)
  search           time series search: intervals where a condition holds (min / max duration, recovery condition)
  event_set        events from objects: an object type's start / end properties (optionally only the objects whose
                   property matches the root object's primary key)
  event_ranges     events typed in: start and end times
  event_shift      move an event set's starts and ends (before / after durations)
  event_dedupe     merge overlapping events
  vfunction        a visual function: saved card logic run with its inputs taken from this analysis' cards ($A) or
                   values (arguments); inputs left unset use the function's own cards
  param_number, param_string, param_boolean, param_datetime, param_range, param_duration,
  param_object_property, shift_datetime      parameters (scalars a formula or another card reads)

Every query counts the points it scans — what each TSP read returns plus what every card reads from its inputs —
for "compute-seconds = 4 + points_scanned / 25000" (ts_ontology.record_usage).
"""

from __future__ import annotations

import ast
import bisect
import json
import math
import re
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol

INTERPOLATIONS = ("LINEAR", "NEAREST", "PREVIOUS", "NEXT", "NONE")
EXTERNAL = ("NEAREST", "NONE")
AGGREGATES = ("mean", "sum", "min", "max", "count", "std", "median", "first", "last", "range")
MAX_CATEGORIES = 10_000
MAX_DEPTH = 6
MIN_QUERY_COMPUTE = 4.0
POINTS_PER_COMPUTE_SECOND = 25_000

SERIES_CARDS = ("tsp", "series", "derived", "function", "formula", "filter", "derivative", "integral", "cumulative", "rolling", "periodic",
                "sample", "shift", "relative", "combine", "bollinger", "bounds", "dsp", "segment_stats", "linked_agg")
SCALAR_CARDS = ("aggregate", "param_number", "param_string", "param_boolean", "param_datetime", "param_range", "param_duration",
                "param_object_property", "shift_datetime")
EVENT_CARDS = ("event_set", "event_ranges", "event_shift", "event_dedupe")
CARD_TYPES = (*SERIES_CARDS, *SCALAR_CARDS, "search", *EVENT_CARDS, "vfunction")
# cards time series alerting can run (Quiver's list, without DSP filter / integral / cumulative aggregate)
ALERTING_CARDS = ("tsp", "series", "derived", "filter", "derivative", "sample", "segment_stats", "formula", "combine", "periodic", "rolling",
                  "relative", "bollinger", "bounds", "shift", "shift_datetime", "linked_agg", "search", "param_number", "param_string",
                  "param_datetime", "param_range", "param_duration", "param_boolean", "param_object_property")
STREAMING_UNSUPPORTED = ("segment_stats",)
CARD_ID = re.compile(r"^[A-Z][A-Z0-9]{0,5}$")


class EngineError(ValueError):
    pass


@dataclass
class Series:
    t: list[int] = field(default_factory=list)
    v: list[Any] = field(default_factory=list)
    interpolation: str = "LINEAR"
    external: str = "NONE"
    unit: Optional[str] = None
    label: str = ""
    categorical: bool = False

    def __len__(self) -> int:
        return len(self.t)

    @property
    def defined(self) -> bool:
        return self.interpolation != "NONE"

    def like(self, t: list[int], v: list[Any], **kw: Any) -> "Series":
        return replace(self, t=t, v=v, **kw)


def series_from_points(points: list[tuple[int, Any]], *, interpolation: Optional[str] = None, external: str = "NONE",
                       unit: Optional[str] = None, label: str = "") -> Series:
    """Points (any order, duplicate timestamps: the last wins) as a Series; categorical when any value is text."""
    by_t: dict[int, Any] = {}
    for t, v in points:
        if v is None:
            continue
        by_t[int(t)] = v
    ts = sorted(by_t)
    vs = [by_t[t] for t in ts]
    categorical = any(isinstance(v, str) for v in vs)
    if categorical:
        vs = [str(v) for v in vs]
        if len(set(vs)) > MAX_CATEGORIES:
            raise EngineError(f"{label or 'the series'} has more than {MAX_CATEGORIES:,} unique values: a categorical series can have at most "
                              f"{MAX_CATEGORIES:,} variants")
    interp = (interpolation or ("PREVIOUS" if categorical else "LINEAR")).upper()
    if interp not in INTERPOLATIONS:
        raise EngineError(f"unknown interpolation {interpolation}")
    if categorical and interp == "LINEAR":
        interp = "PREVIOUS"  # linear interpolation applies to numeric series only
    ext = (external or "NONE").upper()
    if ext not in EXTERNAL:
        raise EngineError(f"unknown external interpolation {external} (NEAREST or NONE)")
    return Series(ts, vs, interp, ext, unit, label, categorical)


# ------------------------------------------------------------------------------------------------
# time
# ------------------------------------------------------------------------------------------------

_UNITS = {"ms": 1, "s": 1000, "sec": 1000, "m": 60_000, "min": 60_000, "h": 3_600_000, "hr": 3_600_000, "d": 86_400_000, "day": 86_400_000,
          "w": 7 * 86_400_000, "wk": 7 * 86_400_000, "mo": 30 * 86_400_000, "y": 365 * 86_400_000}


def duration_ms(text: Any) -> int:
    """'7d', '-1w', '15m', '90s', '500ms', '1h30m', 3600000 (ms) → milliseconds."""
    if text is None or text == "":
        raise EngineError("a duration is required")
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return int(text)
    s = str(text).strip().lower().replace(" ", "")
    sign = -1 if s.startswith("-") else 1
    s = s.lstrip("+-")
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|sec|min|hr|day|wk|mo|s|m|h|d|w|y)", s)
    if not parts or "".join(a + b for a, b in parts) != s:
        raise EngineError(f"{text!r} is not a duration (e.g. 15m, 1h, 7d, 1w)")
    return sign * int(sum(float(n) * _UNITS[u] for n, u in parts))


def period_unit(text: Any) -> tuple[int, str]:
    """A calendar period: (count, unit) with unit ms | s | m | h | d | w | mo | y."""
    s = str(text or "").strip().lower()
    m = re.fullmatch(r"(\d+)?\s*(ms|s|m|min|h|d|w|mo|y)", s)
    if not m:
        raise EngineError(f"{text!r} is not a period (e.g. 1h, 1d, 1w, 1mo)")
    unit = {"min": "m"}.get(m.group(2), m.group(2))
    return max(1, int(m.group(1) or 1)), unit


def to_ms(value: Any) -> Optional[int]:
    """ISO text, epoch seconds or milliseconds, or a datetime → epoch ms (UTC when no zone is given)."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        return int(value if abs(value) >= 1e11 else value * 1000)
    if isinstance(value, datetime):
        d = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    s = str(value).strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return to_ms(float(s))
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise EngineError(f"{value!r} is not a date / time") from None
    return to_ms(d)


def iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _period_start(ms: int, count: int, unit: str) -> int:
    if unit in ("mo", "y"):
        d = datetime.fromtimestamp(ms / 1000, timezone.utc)
        if unit == "y":
            y = d.year - (d.year % count)
            return int(datetime(y, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
        idx = (d.year * 12 + d.month - 1)
        idx -= idx % count
        return int(datetime(idx // 12, idx % 12 + 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    width = count * _UNITS[unit]
    origin = 4 * 86_400_000 if unit == "w" else 0  # weeks start on Monday (1970-01-05)
    return origin + ((ms - origin) // width) * width


def _next_period(ms: int, count: int, unit: str) -> int:
    if unit in ("mo", "y"):
        d = datetime.fromtimestamp(ms / 1000, timezone.utc)
        months = count * (12 if unit == "y" else 1)
        idx = d.year * 12 + d.month - 1 + months
        return int(datetime(idx // 12, idx % 12 + 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    return ms + count * _UNITS[unit]


def _add_months(ms: int, months: int) -> int:
    """`ms` moved by whole months (the day clamped to the month's length, the time of day kept; UTC)."""
    import calendar

    d = datetime.fromtimestamp(ms / 1000, timezone.utc)
    idx = d.year * 12 + d.month - 1 + months
    y, m = idx // 12, idx % 12 + 1
    d2 = d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))
    return int(d2.timestamp() * 1000)


def _aligned_period(ms: int, count: int, unit: str, align: Optional[int]) -> tuple[int, int]:
    """The [start, end) of the period holding `ms`: calendar periods without an alignment timestamp, else the periods
    that start at `align` and at whole multiples of the period before / after it."""
    if align is None:
        p = _period_start(ms, count, unit)
        return p, _next_period(p, count, unit)
    if unit in ("mo", "y"):
        step = count * (12 if unit == "y" else 1)
        a, b = datetime.fromtimestamp(align / 1000, timezone.utc), datetime.fromtimestamp(ms / 1000, timezone.utc)
        k = ((b.year * 12 + b.month) - (a.year * 12 + a.month)) // step
        while _add_months(align, k * step) > ms:
            k -= 1
        while _add_months(align, (k + 1) * step) <= ms:
            k += 1
        return _add_months(align, k * step), _add_months(align, (k + 1) * step)
    width = count * _UNITS[unit]
    p = align + ((ms - align) // width) * width
    return p, p + width


# ------------------------------------------------------------------------------------------------
# interpolation and joins
# ------------------------------------------------------------------------------------------------


def value_at(s: Series, t: int) -> Any:
    """The series' value at t: its point, else by its internal interpolation between points and its external
    interpolation before the first / after the last point; None when it has no value there."""
    n = len(s.t)
    if not n:
        return None
    i = bisect.bisect_left(s.t, t)
    if i < n and s.t[i] == t:
        return s.v[i]
    if i == 0 or i == n:
        if s.external == "NEAREST":
            return s.v[0] if i == 0 else s.v[-1]
        return None
    a, b = i - 1, i
    mode = s.interpolation
    if mode == "NONE":
        return None
    if mode == "PREVIOUS":
        return s.v[a]
    if mode == "NEXT":
        return s.v[b]
    if mode == "NEAREST":
        return s.v[a] if t - s.t[a] <= s.t[b] - t else s.v[b]
    va, vb = s.v[a], s.v[b]
    if not isinstance(va, (int, float)) or not isinstance(vb, (int, float)):
        return va
    return va + (vb - va) * (t - s.t[a]) / (s.t[b] - s.t[a])


def join(series: list[Series]) -> tuple[list[int], list[list[Any]]]:
    """Timestamps and the value of every series there (see the module docstring): the union when all have an
    interpolation, else the intersection of the series without one. Timestamps where any series has no value are
    left out."""
    if not series:
        return [], []
    undefined = [s for s in series if not s.defined]
    if undefined:
        common = set(undefined[0].t)
        for s in undefined[1:]:
            common &= set(s.t)
        ts = sorted(common)
    else:
        ts = sorted(set().union(*(s.t for s in series)))
    out_t: list[int] = []
    cols: list[list[Any]] = [[] for _ in series]
    for t in ts:
        vals = [value_at(s, t) for s in series]
        if any(v is None for v in vals):
            continue
        out_t.append(t)
        for c, v in zip(cols, vals):
            c.append(v)
    return out_t, cols


def _combined_interpolation(series: list[Series]) -> tuple[str, str]:
    if any(not s.defined for s in series):
        return "NONE", "NONE"
    modes = {s.interpolation for s in series}
    ext = "NEAREST" if all(s.external == "NEAREST" for s in series) else "NONE"
    return (modes.pop() if len(modes) == 1 else "LINEAR"), ext


# ------------------------------------------------------------------------------------------------
# aggregates
# ------------------------------------------------------------------------------------------------


def aggregate(values: list[Any], how: str) -> Any:
    how = (how or "mean").lower()
    if how == "avg":
        how = "mean"
    if how not in AGGREGATES:
        raise EngineError(f"unknown aggregation {how} ({', '.join(AGGREGATES)})")
    if how == "count":
        return len(values)
    if not values:
        return None
    if how == "first":
        return values[0]
    if how == "last":
        return values[-1]
    nums = [float(v) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not nums:
        return None
    if how == "sum":
        return sum(nums)
    if how == "mean":
        return sum(nums) / len(nums)
    if how == "min":
        return min(nums)
    if how == "max":
        return max(nums)
    if how == "range":
        return max(nums) - min(nums)
    if how == "median":
        s = sorted(nums)
        k = len(s) // 2
        return s[k] if len(s) % 2 else (s[k - 1] + s[k]) / 2
    m = sum(nums) / len(nums)
    return math.sqrt(sum((x - m) ** 2 for x in nums) / len(nums))


def _rolling(s: Series, window: int, how: str) -> list[Any]:
    """Trailing time window (t - window, t] aggregate at every point."""
    how = "mean" if how == "avg" else how
    out: list[Any] = []
    if how in ("mean", "sum", "count", "std"):
        q: deque = deque()
        total = sq = 0.0
        for t, v in zip(s.t, s.v):
            x = float(v) if isinstance(v, (int, float)) else None
            q.append((t, x))
            if x is not None:
                total += x
                sq += x * x
            while q and q[0][0] <= t - window:
                _, old = q.popleft()
                if old is not None:
                    total -= old
                    sq -= old * old
            n = sum(1 for _, y in q if y is not None) if how != "count" else len(q)
            if how == "count":
                out.append(n)
            elif not n:
                out.append(None)
            elif how == "sum":
                out.append(total)
            elif how == "mean":
                out.append(total / n)
            else:
                mean = total / n
                out.append(math.sqrt(max(sq / n - mean * mean, 0.0)))
        return out
    if how in ("min", "max"):
        q2: deque = deque()  # monotonic (t, value)
        better = (lambda a, b: a <= b) if how == "min" else (lambda a, b: a >= b)
        for t, v in zip(s.t, s.v):
            if isinstance(v, (int, float)):
                while q2 and better(v, q2[-1][1]):
                    q2.pop()
                q2.append((t, float(v)))
            while q2 and q2[0][0] <= t - window:
                q2.popleft()
            out.append(q2[0][1] if q2 else None)
        return out
    lo = 0
    for i, t in enumerate(s.t):
        while s.t[lo] <= t - window:
            lo += 1
        out.append(aggregate(s.v[lo : i + 1], how))
    return out


# ------------------------------------------------------------------------------------------------
# formulas
# ------------------------------------------------------------------------------------------------

_FUNCS: dict[str, Callable[..., Any]] = {
    "abs": abs, "min": min, "max": max, "round": round, "pow": pow,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10, "exp": math.exp, "floor": math.floor, "ceil": math.ceil,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "if_else": lambda c, a, b: a if c else b,
}
_ALLOWED = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp, ast.Call, ast.Name, ast.Load, ast.Constant,
            ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.FloorDiv, ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or,
            ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE)


@dataclass
class Formula:
    code: Any
    cards: list[str]
    props: list[str]
    text: str


def compile_formula(text: str) -> Formula:
    """Quiver's formula syntax: $A card references, @prop root object properties, && || ! as well as and / or / not."""
    src = str(text or "").strip()
    if not src:
        raise EngineError("the formula is empty")
    cards = sorted(set(re.findall(r"\$([A-Z][A-Z0-9]*)", src)))
    props = sorted(set(re.findall(r"@([A-Za-z][A-Za-z0-9_]*)", src)))
    py = re.sub(r"\$([A-Z][A-Z0-9]*)", r"__c_\1", src)
    py = re.sub(r"@([A-Za-z][A-Za-z0-9_]*)", r"__p_\1", py)
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    py = re.sub(r"\btrue\b", "True", re.sub(r"\bfalse\b", "False", py))
    try:
        tree = ast.parse(py, mode="eval")
    except SyntaxError as e:
        raise EngineError(f"formula {src!r}: {e.msg}") from None
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED):
            raise EngineError(f"formula {src!r}: {type(node).__name__} is not allowed")
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in _FUNCS):
            raise EngineError(f"formula {src!r}: only {', '.join(sorted(_FUNCS))} can be called")
        if isinstance(node, ast.Name) and not (node.id in _FUNCS or node.id.startswith(("__c_", "__p_")) or node.id in ("True", "False")):
            raise EngineError(f"formula {src!r}: unknown name {node.id} (cards are $A, properties @name)")
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float, str, bool)):
            raise EngineError(f"formula {src!r}: unsupported constant")
    return Formula(compile(tree, "<formula>", "eval"), cards, props, src)


def _eval(f: Formula, env: dict[str, Any]) -> Any:
    try:
        r = eval(f.code, {"__builtins__": {}, **_FUNCS}, env)  # noqa: S307 (the AST was checked above)
    except ZeroDivisionError:
        return None
    except (TypeError, ValueError, OverflowError) as e:
        raise EngineError(f"formula {f.text!r}: {e}") from None
    if isinstance(r, bool):
        return 1.0 if r else 0.0
    if isinstance(r, float) and not math.isfinite(r):
        return None
    return r


# ------------------------------------------------------------------------------------------------
# evaluation
# ------------------------------------------------------------------------------------------------


class Resolver(Protocol):
    def tsp(self, obj: Optional[dict], prop: str, rng: tuple[Optional[int], Optional[int]], depth: int) -> Series: ...
    def raw(self, series_id: str, sync: Optional[str], rng: tuple[Optional[int], Optional[int]]) -> Series: ...
    def derived(self, template: str, version: Optional[str], obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], depth: int) -> Series: ...
    def sensors(self, obj: Optional[dict]) -> list[dict]: ...
    def property(self, obj: Optional[dict], prop: str) -> Any: ...
    def function(self, cfg: dict, obj: Optional[dict], rng: tuple[Optional[int], Optional[int]], params: dict) -> Series: ...


@dataclass
class Intervals:
    items: list[dict]


@dataclass
class Scalar:
    value: Any
    kind: str = "number"


def check_logic(logic: dict, allowed: tuple[str, ...] = CARD_TYPES) -> None:
    """Card ids, types and references; raises EngineError."""
    cards = logic.get("cards") or []
    if not isinstance(cards, list) or not cards:
        raise EngineError("the logic has no cards")
    ids = set()
    for c in cards:
        cid = str(c.get("id") or "")
        if not CARD_ID.match(cid):
            raise EngineError(f"card identifier {cid!r} must be capital letters (A, B, …, AA)")
        if cid in ids:
            raise EngineError(f"card identifier {cid} is used twice")
        ids.add(cid)
        if c.get("type") not in allowed:
            raise EngineError(f"card {cid}: {c.get('type')!r} is not supported here")
    for c in cards:
        for ref in _refs(c):
            if ref not in ids:
                raise EngineError(f"card {c['id']} reads ${ref}, which is not a card")
    out = logic.get("output")
    if out and out not in ids:
        raise EngineError(f"the output card {out} does not exist")


def _refs(card: dict) -> list[str]:
    cfg = card.get("config") or {}
    refs: list[str] = []
    for key in ("input", "segments", "at_card", "datetime_card"):
        if cfg.get(key):
            refs.append(str(cfg[key]))
    for r in cfg.get("inputs") or []:
        refs.append(str(r))
    for key in ("formula", "condition", "recovery"):
        if cfg.get(key):
            refs.extend(re.findall(r"\$([A-Z][A-Z0-9]*)", str(cfg[key])))
    return refs


def margins(logic: dict) -> tuple[int, int]:
    """How much earlier / later than the requested range raw series must be read for windows and shifts."""
    before = after = 0
    for c in logic.get("cards") or []:
        cfg = c.get("config") or {}
        try:
            if c.get("type") in ("rolling", "bollinger") and cfg.get("window"):
                before += abs(duration_ms(cfg["window"]))
            elif c.get("type") == "periodic" and cfg.get("period"):
                n, u = period_unit(cfg["period"])
                before += n * _UNITS[u]
            elif c.get("type") == "shift" and cfg.get("by"):
                d = duration_ms(cfg["by"])
                before, after = before + max(0, d), after + max(0, -d)
            elif c.get("type") == "dsp" and cfg.get("window"):
                before += abs(duration_ms(cfg["window"]))
            elif c.get("type") in ("derivative", "sample"):
                before += 0
        except EngineError:
            pass
    return before, after


class Evaluator:
    def __init__(self, logic: dict, resolver: Resolver, root: Optional[dict], start: Optional[int] = None, end: Optional[int] = None,
                 params: Optional[dict] = None, depth: int = 0) -> None:
        if depth > MAX_DEPTH:
            raise EngineError("derived series are nested too deeply (or reference themselves)")
        self.cards = {c["id"]: c for c in logic.get("cards") or []}
        self.logic = logic
        self.resolver = resolver
        self.root = root
        self.start, self.end = start, end
        before, after = margins(logic)
        self.read = (start - before if start is not None else None, end + after if end is not None else None)
        self.params = params or {}
        self.depth = depth
        self.memo: dict[str, Any] = {}
        self.scanned = 0
        self.errors: dict[str, str] = {}
        self._stack: list[str] = []

    # -- helpers ---------------------------------------------------------------------------------

    def get(self, cid: str) -> Any:
        if cid in self.memo:
            return self.memo[cid]
        if cid not in self.cards:
            raise EngineError(f"there is no card {cid}")
        if cid in self._stack:
            raise EngineError(f"card {cid} depends on itself")
        self._stack.append(cid)
        try:
            value = self._card(self.cards[cid])
        except EngineError as e:
            msg = str(e)
            self.errors.setdefault(cid, msg)
            raise EngineError(msg if msg.startswith("card ") else f"card {cid}: {msg}") from None
        finally:
            self._stack.pop()
        self.memo[cid] = value
        return value

    def series(self, cid: Any) -> Series:
        v = self.get(str(cid or ""))
        if not isinstance(v, Series):
            raise EngineError(f"card {cid} is not a time series")
        self.scanned += len(v)
        return v

    def scalar(self, cid: str) -> Any:
        v = self.get(cid)
        if isinstance(v, Scalar):
            return v.value
        raise EngineError(f"card {cid} is not a parameter or number")

    def _cfg_value(self, card: dict, key: str = "value") -> Any:
        if card["id"] in self.params:
            return self.params[card["id"]]
        return (card.get("config") or {}).get(key)

    def _obj(self, cfg: dict) -> Optional[dict]:
        o = cfg.get("object")
        if isinstance(o, dict) and o.get("object_type_id") and o.get("primary_key") not in (None, ""):
            return {"object_type_id": o["object_type_id"], "primary_key": str(o["primary_key"])}
        return self.root

    def _clip(self, s: Series) -> Series:
        if self.start is None and self.end is None:
            return s
        lo = bisect.bisect_left(s.t, self.start) if self.start is not None else 0
        hi = bisect.bisect_right(s.t, self.end) if self.end is not None else len(s.t)
        return s.like(s.t[lo:hi], s.v[lo:hi])

    # -- cards -----------------------------------------------------------------------------------

    def _card(self, card: dict) -> Any:  # noqa: C901 (one branch per card type)
        kind = card["type"]
        cfg = card.get("config") or {}
        label = card.get("title") or ""
        if kind == "tsp":
            prop = str(cfg.get("property") or "")
            if not prop:
                raise EngineError("pick a time series property")
            s = self.resolver.tsp(self._obj(cfg), prop, self.read, self.depth)
            self.scanned += len(s) + self._nested()
            return replace(s, label=label or s.label)
        if kind == "series":
            if not cfg.get("series_id"):
                raise EngineError("enter a series ID")
            s = self.resolver.raw(str(cfg["series_id"]), cfg.get("sync") or None, self.read)
            if cfg.get("interpolation"):
                s = replace(s, interpolation=str(cfg["interpolation"]).upper())
            self.scanned += len(s)
            return replace(s, label=label or str(cfg["series_id"]))
        if kind == "derived":
            if not cfg.get("template"):
                raise EngineError("pick a derived series")
            s = self.resolver.derived(str(cfg["template"]), cfg.get("version") or None, self._obj(cfg), self.read, self.depth + 1)
            self.scanned += len(s) + self._nested()
            return replace(s, label=label or s.label)
        if kind == "function":
            params = {k: (self.scalar(v[1:]) if isinstance(v, str) and re.fullmatch(r"\$[A-Z][A-Z0-9]*", v) else v)
                      for k, v in (cfg.get("parameters") or {}).items()}
            s = self.resolver.function(cfg, self._obj(cfg), self.read, params)
            self.scanned += len(s)
            return replace(s, label=label or s.label or str(cfg.get("function") or "function"))
        if kind == "formula":
            return self._formula(cfg.get("formula") or "", label)
        if kind == "filter":
            s = self.series(cfg.get("input"))
            lo = _num(cfg.get("min"))
            hi = _num(cfg.get("max"))
            t0, t1 = to_ms(cfg.get("start")), to_ms(cfg.get("end"))
            allowed = set(map(str, cfg.get("values") or [])) or None
            keep = [(t, v) for t, v in zip(s.t, s.v)
                    if (t0 is None or t >= t0) and (t1 is None or t <= t1)
                    and (allowed is None or str(v) in allowed)
                    and (lo is None or (isinstance(v, (int, float)) and v >= lo))
                    and (hi is None or (isinstance(v, (int, float)) and v <= hi))]
            return s.like([t for t, _ in keep], [v for _, v in keep], label=label or s.label)
        if kind == "derivative":
            s = self._numeric(self.series(cfg.get("input")))
            unit = _UNITS.get(str(cfg.get("unit") or "s"), 1000)
            ts, vs = [], []
            for i in range(1, len(s.t)):
                dt = (s.t[i] - s.t[i - 1]) / unit
                if dt > 0:
                    ts.append(s.t[i])
                    vs.append((s.v[i] - s.v[i - 1]) / dt)
            return s.like(ts, vs, unit=_rate_unit(s.unit, str(cfg.get("unit") or "s")), label=label or f"d/dt {s.label}")
        if kind == "integral":
            s = self._clip(self._numeric(self.series(cfg.get("input"))))
            unit = _UNITS.get(str(cfg.get("unit") or "s"), 1000)
            # the integration method: linear (trapezoids, the default), left- or right-hand sums
            method = str(cfg.get("method") or "linear").lower()
            if method not in ("linear", "left", "right"):
                raise EngineError("the integration method is linear, left or right")
            acc, vs = 0.0, []
            for i in range(len(s.t)):
                if i:
                    h = (s.v[i] + s.v[i - 1]) / 2 if method == "linear" else s.v[i - 1] if method == "left" else s.v[i]
                    acc += h * (s.t[i] - s.t[i - 1]) / unit
                vs.append(acc)
            return s.like(list(s.t), vs, label=label or f"∫ {s.label}")
        if kind == "cumulative":
            s = self._clip(self.series(cfg.get("input")))
            how = str(cfg.get("aggregation") or "sum")
            vs, acc = [], []
            for v in s.v:
                acc.append(v)
                vs.append(aggregate(acc, how) if how in ("median", "std", "range") else _running(how, vs[-1] if vs else None, v, len(acc)))
            return s.like(list(s.t), vs, categorical=False, label=label or f"cumulative {how} {s.label}")
        if kind == "rolling":
            s = self.series(cfg.get("input"))
            window = abs(duration_ms(cfg.get("window") or "1h"))
            how = str(cfg.get("aggregation") or "mean")
            vs = _rolling(s, window, how)
            keep = [(t, v) for t, v in zip(s.t, vs) if v is not None]
            return s.like([t for t, _ in keep], [v for _, v in keep], categorical=False, label=label or f"rolling {how} {cfg.get('window')} {s.label}")
        if kind == "periodic":
            s = self.series(cfg.get("input"))
            n, u = period_unit(cfg.get("period") or "1d")
            how = str(cfg.get("aggregation") or "mean")
            # the Workshop doc's advanced options: an alignment timestamp (periods start at it and multiples of the
            # period from it; default: calendar periods, weeks from Monday) and the window type (start: each point is
            # a period's start and aggregates [start, end); end: a period's end, aggregating (start, end])
            align = to_ms(cfg.get("align")) if cfg.get("align") not in (None, "") else None
            wtype = str(cfg.get("window_type") or "start").lower()
            if wtype not in ("start", "end"):
                raise EngineError("the window type is start or end")
            buckets: dict[int, list[Any]] = {}
            for t, v in zip(s.t, s.v):
                if wtype == "end":
                    k = _aligned_period(t - 1, n, u, align)[1]  # start < t <= end
                elif align is None:
                    k = _period_start(t, n, u)  # unchanged default
                else:
                    k = _aligned_period(t, n, u, align)[0]
                buckets.setdefault(k, []).append(v)
            ts = sorted(buckets)
            vs = [aggregate(buckets[t], how) for t in ts]
            keep = [(t, v) for t, v in zip(ts, vs) if v is not None]
            return s.like([t for t, _ in keep], [v for _, v in keep], categorical=False,
                          interpolation=str(cfg.get("interpolation") or ("PREVIOUS" if how in ("sum", "count") else s.interpolation)).upper(),
                          label=label or f"{how} per {cfg.get('period') or '1d'} {s.label}")
        if kind == "sample":
            s = self.series(cfg.get("input"))
            every = abs(duration_ms(cfg.get("every") or "1h"))
            if not s.t:
                return s
            t0 = to_ms(cfg.get("start")) or (self.start if self.start is not None else s.t[0])
            t1 = to_ms(cfg.get("end")) or (self.end if self.end is not None else s.t[-1])
            t0 = (t0 // every) * every
            if (t1 - t0) // every > 200_000:
                raise EngineError("sampling would make more than 200,000 points: pick a longer interval or a shorter range")
            ts, vs = [], []
            t = t0
            while t <= t1:
                v = value_at(s, t)
                if v is not None:
                    ts.append(t)
                    vs.append(v)
                t += every
            return s.like(ts, vs, label=label or f"{s.label} every {cfg.get('every')}")
        if kind == "shift":
            s = self.series(cfg.get("input"))
            d = duration_ms(cfg.get("by") or "0s")
            return s.like([t + d for t in s.t], list(s.v), label=label or f"{s.label} shifted {cfg.get('by')}")
        if kind == "relative":
            s = self.series(cfg.get("input"))
            ref = to_ms(cfg.get("reference")) if cfg.get("reference") else (self.scalar_ms(cfg["at_card"]) if cfg.get("at_card") else (s.t[0] if s.t else None))
            if ref is None:
                return s
            if (cfg.get("mode") or "time") == "value":
                base = value_at(s, ref)
                if not isinstance(base, (int, float)):
                    return s.like([], [])
                return s.like(list(s.t), [v - base if isinstance(v, (int, float)) else None for v in s.v], label=label or f"{s.label} relative")
            align = to_ms(cfg.get("align_to")) if cfg.get("align_to") else (self.start if self.start is not None else 0)
            d = align - ref
            return s.like([t + d for t in s.t], list(s.v), label=label or f"{s.label} from {iso(ref)}")
        if kind == "combine":
            inputs = [self.series(i) for i in cfg.get("inputs") or []]
            if not inputs:
                raise EngineError("pick the series to combine")
            seen: dict[int, Any] = {}
            for s in inputs:
                for t, v in zip(s.t, s.v):
                    seen.setdefault(t, v)
            ts = sorted(seen)
            return inputs[0].like(ts, [seen[t] for t in ts], label=label or "combined")
        if kind == "bollinger":
            s = self._numeric(self.series(cfg.get("input")))
            window = abs(duration_ms(cfg.get("window") or "1d"))
            k = _num(cfg.get("k"))
            k = 2.0 if k is None else k
            mean, std = _rolling(s, window, "mean"), _rolling(s, window, "std")
            band = str(cfg.get("band") or "upper")
            sign = {"upper": 1, "lower": -1, "middle": 0}.get(band)
            if sign is None:
                raise EngineError("band is upper, lower or middle")
            vs = [None if m is None else m + sign * k * (sd or 0) for m, sd in zip(mean, std)]
            keep = [(t, v) for t, v in zip(s.t, vs) if v is not None]
            return s.like([t for t, _ in keep], [v for _, v in keep], label=label or f"Bollinger {band} {s.label}")
        if kind == "bounds":
            inputs = [self._numeric(self.series(i)) for i in cfg.get("inputs") or []]
            if not inputs:
                raise EngineError("pick the series")
            ts, cols = join(inputs)
            pick = max if (cfg.get("band") or "upper") == "upper" else min
            interp, ext = _combined_interpolation(inputs)
            return Series(ts, [pick(vals) for vals in zip(*cols)] if ts else [], interp, ext, inputs[0].unit, label or f"{cfg.get('band') or 'upper'} bound")
        if kind == "dsp":
            return self._dsp(self._numeric(self.series(cfg.get("input"))), cfg, label)
        if kind == "segment_stats":
            s = self.series(cfg.get("input"))
            how = str(cfg.get("aggregation") or "mean")
            segs: list[tuple[int, int]]
            if cfg.get("segments"):
                iv = self.get(str(cfg["segments"]))
                if not isinstance(iv, Intervals):
                    raise EngineError(f"card {cfg['segments']} is not a time series search or an event set")
                last = s.t[-1] if s.t else 0
                segs = [(i["start"], i["end"] if i["end"] is not None else last + 1) for i in iv.items]
            else:
                n, u = period_unit(cfg.get("period") or "1d")
                segs = []
                if s.t:
                    p = _period_start(s.t[0], n, u)
                    while p <= s.t[-1]:
                        q = _next_period(p, n, u)
                        segs.append((p, q))
                        p = q
            ts, vs = [], []
            for a, b in segs:
                lo, hi = bisect.bisect_left(s.t, a), bisect.bisect_left(s.t, b)
                v = aggregate(s.v[lo:hi], how)
                if v is not None:
                    ts.append(a)
                    vs.append(v)
            return s.like(ts, vs, categorical=False, interpolation="PREVIOUS", label=label or f"{how} per segment")
        if kind == "linked_agg":
            sensors = self.resolver.sensors(self._obj(cfg))
            wanted = [str(x).lower() for x in (cfg.get("sensors") or [])]
            needle = str(cfg.get("match") or "").lower()
            picked = [x for x in sensors if (not wanted or x["name"].lower() in wanted) and needle in x["name"].lower()]
            series = []
            for x in picked:
                try:
                    s = self.resolver.tsp({"object_type_id": x["object_type_id"], "primary_key": x["primary_key"]}, x.get("property") or "", self.read, self.depth)
                except EngineError:
                    continue
                self.scanned += len(s)
                if not s.categorical:
                    series.append(s)
            how = str(cfg.get("aggregation") or "mean")
            if not series:
                return Series(label=label or f"{how} of linked sensors")
            ts, cols = join(series)
            interp, ext = _combined_interpolation(series)
            return Series(ts, [aggregate(list(vals), how) for vals in zip(*cols)] if ts else [], interp, ext, series[0].unit,
                          label or f"{how} of {len(series)} linked sensors")
        if kind == "aggregate":
            s = self.series(cfg.get("input"))
            t0 = to_ms(cfg.get("start")) if cfg.get("start") else self.start
            t1 = to_ms(cfg.get("end")) if cfg.get("end") else self.end
            vals = [v for t, v in zip(s.t, s.v) if (t0 is None or t >= t0) and (t1 is None or t <= t1)]
            return Scalar(aggregate(vals, str(cfg.get("aggregation") or "mean")))
        if kind == "search":
            return self._search(cfg)
        if kind in EVENT_CARDS:
            return self._events(kind, cfg)
        if kind == "vfunction":
            return self._vfunction(cfg, label)
        if kind in ("param_number", "param_string", "param_boolean", "param_duration"):
            v = self._cfg_value(card)
            if kind == "param_number":
                n = _num(v)
                if n is None:
                    raise EngineError("the numeric parameter has no value")
                return Scalar(n)
            if kind == "param_boolean":
                return Scalar(1.0 if (v is True or str(v).lower() in ("true", "1", "yes")) else 0.0, "boolean")
            if kind == "param_duration":
                return Scalar(duration_ms(v or "1h"), "duration")
            return Scalar("" if v is None else str(v), "string")
        if kind == "param_datetime":
            v = self._cfg_value(card)
            return Scalar(to_ms(v) if v else None, "datetime")
        if kind == "param_range":
            v = self._cfg_value(card)
            if isinstance(v, dict):
                return Scalar({"start": to_ms(v.get("start")), "end": to_ms(v.get("end"))}, "range")
            return Scalar({"start": to_ms(cfg.get("start")), "end": to_ms(cfg.get("end"))}, "range")
        if kind == "param_object_property":
            prop = str(cfg.get("property") or "")
            if not prop:
                raise EngineError("pick a property")
            return Scalar(self.resolver.property(self._obj(cfg), prop), "property")
        if kind == "shift_datetime":
            base = self.scalar_ms(cfg["datetime_card"]) if cfg.get("datetime_card") else to_ms(cfg.get("datetime"))
            if base is None:
                raise EngineError("pick a date / time")
            return Scalar(base + duration_ms(cfg.get("by") or "0s"), "datetime")
        raise EngineError(f"unknown card type {kind}")

    def _nested(self) -> int:
        """Points scanned by derived series a TSP or card resolved (the resolver evaluates them in their own query)."""
        n = int(getattr(self.resolver, "extra_scanned", 0) or 0)
        if n:
            self.resolver.extra_scanned = 0  # type: ignore[attr-defined]
        return n

    def scalar_ms(self, cid: str) -> Optional[int]:
        v = self.scalar(cid)
        if isinstance(v, dict):
            return v.get("start")
        return to_ms(v)

    def _numeric(self, s: Series) -> Series:
        if s.categorical:
            raise EngineError(f"{s.label or 'the input'} is categorical: this card needs a numeric series")
        return s

    def _formula(self, text: str, label: str, inputs: Optional[dict[str, Series]] = None) -> Series:
        f = compile_formula(text)
        series_refs: dict[str, Series] = {}
        scalars: dict[str, Any] = {}
        for ref in f.cards:
            v = inputs[ref] if inputs and ref in inputs else self.get(ref)
            if isinstance(v, Series):
                series_refs[ref] = v
                self.scanned += len(v)
            elif isinstance(v, Scalar):
                scalars[f"__c_{ref}"] = v.value
            else:
                raise EngineError(f"${ref} is a search result and cannot be used in a formula")
        for p in f.props:
            scalars[f"__p_{p}"] = self.resolver.property(self.root, p)
        if not series_refs:
            raise EngineError("a formula needs at least one time series ($A)")
        names = list(series_refs)
        ts, cols = join([series_refs[n] for n in names])
        vs = []
        out_t = []
        for i, t in enumerate(ts):
            env = dict(scalars)
            for n, col in zip(names, cols):
                env[f"__c_{n}"] = col[i]
            r = _eval(f, env)
            if r is not None:
                out_t.append(t)
                vs.append(r)
        first = series_refs[names[0]]
        interp, ext = _combined_interpolation(list(series_refs.values()))
        categorical = any(isinstance(v, str) for v in vs)
        return Series(out_t, vs, "PREVIOUS" if categorical and interp == "LINEAR" else interp, ext, first.unit if len(names) == 1 else None,
                      label or f.text, categorical)

    def _dsp(self, s: Series, cfg: dict, label: str) -> Series:
        how = str(cfg.get("filter") or "moving_average")
        if how == "moving_average":
            vs = _rolling(s, abs(duration_ms(cfg.get("window") or "1h")), "mean")
            return s.like(list(s.t), vs, label=label or f"moving average {s.label}")
        if how in ("ema", "lowpass", "highpass"):
            alpha = _num(cfg.get("alpha"))
            tau = abs(duration_ms(cfg.get("window") or "1h")) if how != "ema" or alpha is None else None
            out, prev, prev_t = [], None, None
            for t, v in zip(s.t, s.v):
                if prev is None:
                    prev = v
                else:
                    a = alpha if tau is None else 1 - math.exp(-(t - prev_t) / tau) if tau else 1.0
                    prev = prev + a * (v - prev)
                prev_t = t
                out.append(v - prev if how == "highpass" else prev)
            return s.like(list(s.t), out, label=label or f"{how} {s.label}")
        raise EngineError("filter is moving_average, ema, lowpass or highpass")

    def _vfunction(self, cfg: dict, label: str) -> Any:
        load = getattr(self.resolver, "visual_function", None)
        if load is None or not cfg.get("function_id"):
            raise EngineError("pick a visual function" if load else "visual functions are not available here")
        fn = load(str(cfg["function_id"]))
        if self.depth >= MAX_DEPTH:
            raise EngineError("visual functions are nested too deeply (or call themselves)")
        inner = Evaluator(fn["logic"], self.resolver, self._obj(cfg), self.start, self.end, self.params, self.depth + 1)
        args = cfg.get("arguments") or {}
        for inp in fn.get("inputs") or []:
            given = args.get(inp["card"])
            if given in (None, ""):
                continue  # the function's own card is the default
            if isinstance(given, str) and re.fullmatch(r"\$[A-Z][A-Z0-9]*", given):
                inner.memo[inp["card"]] = self.get(given[1:])
            else:
                n = _num(given)
                inner.memo[inp["card"]] = Scalar(n) if n is not None else Scalar(str(given), "string")
        try:
            value = inner.get(fn["output"])
        finally:
            self.scanned += inner.scanned
        return replace(value, label=label or fn.get("name") or value.label) if isinstance(value, Series) else value

    def _events(self, kind: str, cfg: dict) -> Intervals:
        if kind == "event_set":
            if not cfg.get("object_type_id") or not cfg.get("start_property"):
                raise EngineError("choose the event object type and its start property")
            events = getattr(self.resolver, "events", None)
            if events is None:
                raise EngineError("event sets from objects are not available here")
            items = events(cfg, self.root)
        elif kind == "event_ranges":
            items = []
            for r in cfg.get("ranges") or []:
                s = to_ms(r.get("start"))
                if s is None:
                    continue
                items.append({"start": s, "end": to_ms(r.get("end")) if r.get("end") else None, "title": r.get("label") or ""})
        else:
            src = self.get(str(cfg.get("input") or ""))
            if not isinstance(src, Intervals):
                raise EngineError(f"${cfg.get('input')} is not an event set or a time series search")
            if kind == "event_dedupe":
                return Intervals(_merge_events([dict(i) for i in src.items]))
            before = abs(duration_ms(cfg["before"])) if cfg.get("before") else 0
            after = abs(duration_ms(cfg["after"])) if cfg.get("after") else 0
            return Intervals([{**i, "start": i["start"] - before, "end": i["end"] + after if i["end"] is not None else None} for i in src.items])
        # events within the query range (open ones included)
        items = [i for i in items if (self.start is None or i["end"] is None or i["end"] >= self.start) and (self.end is None or i["start"] <= self.end)]
        return Intervals(sorted(items, key=lambda i: i["start"]))

    def _search(self, cfg: dict) -> Intervals:
        cond = cfg.get("condition") or ""
        if not cond:
            raise EngineError("enter the search condition, e.g. $A > 120")
        if cfg.get("multi"):
            raise EngineError("the Multi time series search type is not supported")
        on = self._formula(cond, "condition")
        off = self._formula(cfg["recovery"], "recovery") if cfg.get("recovery") else None
        min_d = abs(duration_ms(cfg["min_duration"])) if cfg.get("min_duration") else 0
        max_d = abs(duration_ms(cfg["max_duration"])) if cfg.get("max_duration") else None
        items = search_intervals(on, off, min_d, max_d)
        # intervals that end before the range or start after it belong to the margin read for windows, not the query
        items = [i for i in items if (self.start is None or i["end"] is None or i["end"] >= self.start)
                 and (self.end is None or i["start"] <= self.end)]
        return Intervals(items)


def _merge_events(items: list[dict]) -> list[dict]:
    """Overlapping (or touching) events as one; an open event (no end) runs to the end."""
    out: list[dict] = []
    for i in sorted(items, key=lambda x: x["start"]):
        if out and (out[-1]["end"] is None or i["start"] <= out[-1]["end"]):
            last = out[-1]
            last["end"] = None if last["end"] is None or i["end"] is None else max(last["end"], i["end"])
            last["count"] = last.get("count", 1) + 1
        else:
            out.append({**i, "count": 1})
    return out


def search_intervals(on: Series, off: Optional[Series] = None, min_duration: int = 0, max_duration: Optional[int] = None) -> list[dict]:
    """Intervals where `on` is true (non-zero). An interval starts at the first point where it holds and ends at the
    first point where it no longer holds — or, with a recovery series, where the recovery condition holds — and is
    ongoing (end None) when it still holds at the last point."""
    events: list[tuple[int, Optional[bool], Optional[bool]]] = []
    if off is None:
        events = [(t, bool(v), None) for t, v in zip(on.t, on.v)]
    else:
        ts = sorted(set(on.t) | set(off.t))
        for t in ts:
            a, b = value_at(on, t), value_at(off, t)
            events.append((t, None if a is None else bool(a), None if b is None else bool(b)))
    out: list[dict] = []
    start: Optional[int] = None
    for t, cond, rec in events:
        if start is None:
            if cond:
                start = t
        else:
            ended = (rec is True) if off is not None else (cond is False)
            if ended:
                out.append({"start": start, "end": t})
                start = None
    if start is not None:
        out.append({"start": start, "end": None})
    last = events[-1][0] if events else None
    result = []
    for i in out:
        dur = (i["end"] if i["end"] is not None else (last or i["start"])) - i["start"]
        if i["end"] is not None and dur < min_duration:
            continue
        if max_duration is not None and i["end"] is not None and dur > max_duration:
            continue
        result.append({**i, "duration_ms": dur, "ongoing": i["end"] is None})
    return result


def _running(how: str, prev: Any, v: Any, n: int) -> Any:
    x = float(v) if isinstance(v, (int, float)) else None
    if how == "count":
        return n
    if x is None:
        return prev
    if prev is None:
        return x
    if how == "sum":
        return prev + x
    if how == "min":
        return min(prev, x)
    if how == "max":
        return max(prev, x)
    if how in ("mean", "avg"):
        return prev + (x - prev) / n
    if how == "first":
        return prev
    if how == "last":
        return x
    raise EngineError(f"unknown aggregation {how}")


def _num(v: Any) -> Optional[float]:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _rate_unit(unit: Optional[str], per: str) -> Optional[str]:
    return f"{unit}/{per}" if unit else None


# ------------------------------------------------------------------------------------------------
# results
# ------------------------------------------------------------------------------------------------


def compute_seconds(points_scanned: int, queries: int = 1) -> float:
    return queries * MIN_QUERY_COMPUTE + points_scanned / POINTS_PER_COMPUTE_SECOND


def bucket(s: Series, buckets: int) -> tuple[list[dict], bool]:
    """Points for a chart: at most `buckets`, longer series averaged per time bucket (with min / max)."""
    if len(s.t) <= buckets or s.categorical:
        step = max(1, len(s.t) // max(buckets, 1)) if s.categorical and len(s.t) > buckets else 1
        return [{"t": iso(t), "value": v} for t, v in list(zip(s.t, s.v))[::step]], step > 1
    t0, t1 = s.t[0], s.t[-1]
    width = max((t1 - t0) / buckets, 1)
    acc: dict[int, list[float]] = {}
    for t, v in zip(s.t, s.v):
        if isinstance(v, (int, float)):
            acc.setdefault(min(int((t - t0) / width), buckets - 1), []).append(float(v))
    return [{"t": iso(int(t0 + (b + 0.5) * width)), "value": sum(vs) / len(vs), "min": min(vs), "max": max(vs), "n": len(vs)}
            for b, vs in sorted(acc.items())], True


def stats(s: Series) -> dict:
    nums = [float(v) for v in s.v if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return {"points": len(s.t), "first_ts": iso(s.t[0]) if s.t else None, "last_ts": iso(s.t[-1]) if s.t else None,
            "first": s.v[0] if s.v else None, "last": s.v[-1] if s.v else None,
            "min": min(nums) if nums else None, "max": max(nums) if nums else None, "mean": sum(nums) / len(nums) if nums else None}


def describe(value: Any, buckets: int = 500, clip: Optional[Callable[[Series], Series]] = None) -> dict:
    """A card's result as JSON for the browser."""
    if isinstance(value, Series):
        s = clip(value) if clip else value
        pts, bucketed = bucket(s, buckets)
        return {"kind": "series", "label": s.label, "unit": s.unit, "interpolation": s.interpolation, "external": s.external,
                "categorical": s.categorical, "points": pts, "bucketed": bucketed, "stats": stats(s)}
    if isinstance(value, Intervals):
        return {"kind": "intervals", "intervals": [{**i, "start": iso(i["start"]), "end": iso(i["end"])} for i in value.items], "count": len(value.items)}
    if isinstance(value, Scalar):
        v = value.value
        if value.kind in ("datetime",):
            v = iso(v)
        elif value.kind == "range" and isinstance(v, dict):
            v = {"start": iso(v.get("start")), "end": iso(v.get("end"))}
        return {"kind": "scalar", "scalar_kind": value.kind, "value": v}
    return {"kind": "unknown"}


def run(logic: dict, resolver: Resolver, root: Optional[dict] = None, start: Optional[int] = None, end: Optional[int] = None,
        params: Optional[dict] = None, cards: Optional[list[str]] = None, depth: int = 0, buckets: int = 500) -> dict:
    """Evaluate the requested cards (default: every card) and describe them; a failing card reports its error and
    the others still run."""
    check_logic(logic)
    ev = Evaluator(logic, resolver, root, start, end, params, depth)
    out: dict[str, Any] = {}
    for cid in cards or [c["id"] for c in logic["cards"]]:
        try:
            out[cid] = describe(ev.get(cid), buckets, ev._clip)
        except EngineError as e:
            out[cid] = {"kind": "error", "error": ev.errors.get(cid) or str(e)}
    return {"cards": out, "output": logic.get("output"), "points_scanned": ev.scanned, "compute_seconds": round(compute_seconds(ev.scanned), 4)}


def evaluate_series(logic: dict, resolver: Resolver, root: Optional[dict], start: Optional[int], end: Optional[int],
                    params: Optional[dict] = None, depth: int = 0, card: Optional[str] = None) -> tuple[Series, int]:
    """The output card (or `card`) as a Series clipped to the range, with the points scanned."""
    check_logic(logic)
    cid = card or logic.get("output") or logic["cards"][-1]["id"]
    ev = Evaluator(logic, resolver, root, start, end, params, depth)
    v = ev.get(cid)
    if not isinstance(v, Series):
        raise EngineError(f"the output card {cid} is not a time series")
    return ev._clip(v), ev.scanned


def evaluate_search(logic: dict, resolver: Resolver, root: Optional[dict], start: Optional[int], end: Optional[int],
                    params: Optional[dict] = None, card: Optional[str] = None) -> tuple[list[dict], int]:
    check_logic(logic)
    cid = card or logic.get("output") or logic["cards"][-1]["id"]
    ev = Evaluator(logic, resolver, root, start, end, params)
    v = ev.get(cid)
    if not isinstance(v, Intervals):
        raise EngineError(f"the output card {cid} must be a time series search")
    return v.items, ev.scanned


def upstream(logic: dict, card: str) -> list[dict]:
    """The cards `card` depends on (itself included), in logic order: what "Create derived series" from a Quiver
    card saves."""
    by_id = {c["id"]: c for c in logic.get("cards") or []}
    need: set[str] = set()
    todo = [card]
    while todo:
        cid = todo.pop()
        if cid in need or cid not in by_id:
            continue
        need.add(cid)
        todo.extend(_refs(by_id[cid]))
    return [c for c in logic.get("cards") or [] if c["id"] in need]


def root_objects(logic: dict) -> set[str]:
    """Object types / objects named explicitly by tsp cards (a templated derived series must name none)."""
    out = set()
    for c in logic.get("cards") or []:
        o = (c.get("config") or {}).get("object")
        if c.get("type") in ("tsp", "derived", "linked_agg", "param_object_property", "function") and isinstance(o, dict) and o.get("primary_key"):
            out.add(json.dumps([o.get("object_type_id"), str(o.get("primary_key"))]))
    return out
