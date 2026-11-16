"""Quiver single cards (Analytics doc 05, "Card references"): the object set / transform table / numeric / date cards
that return one value, an array or a small chart, computed on the transform table engine (quiver_tables.py).

Cards (in the analysis' `object_sets` list, told apart by `kind`):
- numeric_agg: {source: {card}, aggregation, column?, percentile?} — "Numeric aggregation" over an object set card,
  "Transform table aggregation" over a table, "Number array aggregation" over a column values card.
- column_values: {source: {card}, column, distinct?, sort?, limit?} — "Transform table column values" / "Unique column
  values": a column as an array.
- numeric_formula: {formula} — "Numeric formula" over other cards' values ($N1, $V1 …) and parameters ($P).
- round: {mode: floor|ceil|round, input, digits?} — "Floor" / "Ceiling" (and rounding to a number of digits).
- date_diff: {start, end, unit} — "Date difference" in weeks, days, hours, minutes, seconds or milliseconds.
- date_part: {input, part} — "Day of week" (ISO: Monday 1 … Sunday 7), "Day of month", "Day of year", "Hour of day",
  "Month", "Year" (UTC).
- correlation: {source: {card}, columns?, method: pearson|spearman} — "Correlation matrix" between numeric columns
  (pairwise complete rows).
- waterfall: {source: {card}, group_by, metric, measure?, sort?, limit?, total?} or {steps: [{label, input}], total?}
  — "Waterfall plot": buckets from an object set / table grouped by a column, or typed-in / referenced numbers.

String, Boolean and Array cards (Analytics doc 05, "String" / "Boolean" / "Array" card references):
- string_op: {op, input, …} — "Concatenate" (input2, delimiter), "Substring" (start, length), "Find and replace"
  (find, replace, regex?, ignore_case?), "To lower case", "To upper case", trim, string length, regex extract (pattern,
  group), "Split" (delimiter → a string array), "String to number", "String to Boolean" (true_values, false_values,
  default), "Date to string" (format such as YYYY-MM-DD or DD MMM YYYY HH:mm).
- comparison: {op, left, right, right2?} — numbers: "Equal to", "Not equal to", "Greater than" … ; strings / booleans:
  "Is", "Is not", "Contains", "Does not contain", "Starts with", "Ends with"; dates: "Before", "On or before", "After",
  "On or after", "On", "Not on", "Between (inclusive)". A Boolean; null when an input is empty.
- boolean_formula: {formula} — the formula syntax returning true / false (&& || ! and comparisons).
- create_array: {items: [operand], element_type?} — "Create array": typed values and cards' values (an array card's
  values are spliced in).
- stepped_array: {start, end, step} — "Stepped array".
- array_op: {op, input, …} — "Array length", "Array start", "Array end", "Value at index" (index, 0 first, negative
  from the end), "Array contains" (value), "Array join" (delimiter), "Array sort" (order), "Unique values",
  "Strings to numbers / dates / booleans".
- coalesce: {inputs: [operand]} — "Coalesce": the first input that is not null.
Arrays of any of these cards are also inputs of a numeric aggregation ("Number array aggregation").

Range cards ("Numeric range parameter", "Range start", "Range end", "Numeric range to date range"):
- range: {start, end, range_type?: auto|number|date} — a numeric or a date / time range from typed values, cards'
  values or parameters; its value is {start, end} (the start is not after the end).
- range_op: {op: start|end|to_date_range, input} — the start / end of a range card or of a date / time range
  parameter ($ID); to_date_range reads a numeric range's ends as epoch milliseconds.

Selector parameter cards (a viewer changes `value` on the canvas or on a dashboard; the saved value is the default):
- string_selector: {options: [text] | source: {card}, column?, multiple?, value} — "String selector": one (or several)
  of typed options, of the distinct values of a column of an object set / table card, or of an array card's values.
- property_select: {source: {card: object set}, property, multiple?, value} — "Property value select parameter": one
  (or several) of the values of an object set property, with the property's type.
- object_selector: {source: {card}, multiple?, label?, value} — "Object selector": one object (or several) of an object
  set card by primary key. Its value is the primary key (an array when multiple) and the card is itself an object set
  (the selected objects) other cards read as their input.
- row_selector: {source: {card}, key?, label?, value} — "Transform table row selector": one row of a table, by the
  value of a key column or by its row index (0 first). Its value is the row; "$ID.column" reads one cell.
Their values are also parameters of the transform tables' expressions and filters ($ID).

Date cards:
- date_convert: {op: string_to_date (format?, timezone?) | number_to_date (unit: milliseconds|seconds|days), input} —
  "String to date" (Day.js format tokens; without a format ISO or MM/DD/YYYY), "Number to date".
- period_to_date: {period: day|week|month|year, input?, week_start?} — "Day / Week / Month / Year to date": the date
  range from 00:00 on the first day of the input date's period to the input date (UTC; no input: now).

Cards from data:
- object_property: {source: {card}, property} — "Object property": a property of the one object of an object selector
  (or of an object set holding one object) as a string, number or date.
- multipass_attribute: {attribute, user?} — "Multipass attribute": an attribute of the current user (user ID, username,
  display name, given / family name, email, role, organization, groups, or a custom attribute), or the user ID,
  username or display name of the user whose ID is the input.
- xy_range: {x_start, x_end, y_start, y_end, x_type?, y_type?} — "X/Y range parameter": two ranges (numbers, dates or
  ordinal strings); "$ID.x" / "$ID.y" are range inputs.

Time series cards (their input is a time series card of the analysis' logic, `source: {card: "A"}`, read for the
analysis' root object; `range`: "analysis" (default: the analysis' time range) | "full" | {start, end} | {last} | "$ID",
a range card or a date / time range parameter):
- series_agg: {source, aggregation, range?, percentile?, method?, bounds?, time_unit?} — "Time series numeric
  aggregation": sum, mean, std (population, as the other time series cards), max, min, relative_difference,
  difference, product, count, first, last, median, percentile, range, and the time-weighted time_weighted_average and
  integral (method: linear | lhs | rhs; bounds: none | linear | nearest | previous | next — how the curve is extended
  to the range's ends; time_unit of the integral: s | m | h | d).
- series_op: {op, source, at?, interpolation?, external?, range?} — "Value at time" (value_at) and "Enum value at
  time" (enum_value_at): the series' value at `at` by its interpolation (or the one chosen), read from the whole
  series; "Latest value for enum time series" (latest_enum); "Time series unit" (unit); "Time series start date" /
  "Time series end date" (start / end: the first / last point's time in the range); "Backing object from time
  series" (backing_object: the primary key of the root or sensor object the series is read for).
- regression: {source, fit: linear|polynomial|exponential, degree?, x_unit?, range?} — "Time series regression
  coefficients": the best-fit coefficients as a number array, lowest power first (y = c0 + c1·x + …; exponential:
  y = a·e^(b·x) as [a, b]), x the time since the first point in x_unit (s | m | h | d). With a time series scatter plot
  card as the source: "Scatter plot regression coefficients" over its points.
- shift_datetime: {input?, amount, unit} — "Shift date/time": the date (empty: now) shifted by a number of weeks, days,
  hours, minutes, seconds or milliseconds (negative: earlier).
- series_distribution: {source, bins?, range?} — "Time series distribution": counts of the values per bin (an enum
  series: per value).
- series_scatter: {x: {card}, y: {card}, range?, buckets?, bucket_value?, view: scatter|heat_grid, grid?, fit?,
  degree?} — "Time series scatter plot" (two series joined by their interpolation, aggregated per time bucket),
  "Time series heat grid" (the density of the points per cell) and "Scatter plot regression" (the best-fit line).

Object set cards (Analytics doc 05, "Object cards"): each is itself an object set — its objects, with the viewer's
permissions, as an object set card's table (primary_key, a column per property) — that tables, charts, single cards
and other object set cards read as their input (object_set_table); the result shows the first 50 objects (a report widget: 1,000) and the count.
- filter_object_set: {source: {card}, match: all|any, conditions: [{property, op, value, negate?} | {link:
  "<link type>:<forward|reverse>", property?, op, value} | {match, conditions, negate?}]} — "Filter object set":
  conditions on properties (eq, neq, contains, starts_with, gt, gte, lt, lte, between, in, is_null, not_null, regex,
  wildcard), on a linked object's property (objects linked to at least one matching object; linked / not_linked
  without a property: linked to any object or to none), nested and / or groups. A value is typed (between / in: "a,
  b") or "$ID", a card's value or a parameter (an array: any of its values; a range: between its ends).
- set_math: {inputs: [card …], op: union|intersection|difference} — "Set math" of object sets of the same type
  (difference: the first set minus the others).
- linked_object_set: {source: {card}, link: "<link type>:<direction>"} — "Switch to linked object set" (a search
  around): the objects linked to any object of the input.
- status_filter: {source: {card}, start_property, end_property, status: open|closed, range?} — "Status filter": open
  during the range (opened before its end, not closed by it; no end date: still open) or closed during it (an end
  date in the range). The range is that of the time series cards (the analysis' range, "full", fixed, {last}, "$ID").
- object_view: {source: {card}} (an object set holding one object) or {object_type_id?, primary_key} (typed or "$ID";
  a backing object from time series card gives the type too) — "Object view": the object's properties; its value
  is the primary key.
- defined_by_property: {source: {card} | object_type_id, property, from: {card, property?} | value} — "Defined by
  property": the objects (of the input, or of the whole type) whose property holds one of a set of values: the values
  of another card's column / property (an object set or table card; without a property, an array or value card's
  value), or typed / "$ID" values — e.g. the identifier of a saved object set, for cohorts tagged by hand. Numbers
  compare as numbers, dates as dates, the rest as text; no values: no objects. An array property matches when any of
  its elements holds a value; an array property of the values card's objects gives each of its elements as a value.
- saved_object_set: {object_set: "ri.object-set.main.exploration.<id>" | "ri.object-set.main.list.<id>"} — "Import
  saved object set": an Object Explorer exploration (its search run now, with the viewer's permissions) or a saved
  object list (also one saved from a Quiver object set card, POST /{aid}/cards/{cid}/object-list) the viewer can see;
  the result carries the saved set's name, description, owner and dates.

An input ("operand") of the value cards is "$ID" — another card's value (a value, aggregation, formula … card) or a
parameter card of the time series logic — or a literal number / date / text. "$ID.name" reads a row's cell, a range's
start / end or an X/Y range's x / y.
"""

from __future__ import annotations

import ast
import math
import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import pyarrow as pa

import contour_engine as E

VALUE_KINDS = ("numeric_agg", "column_values", "numeric_formula", "round", "date_diff", "date_part",
               "string_op", "comparison", "boolean_formula", "create_array", "stepped_array", "array_op", "coalesce",
               "range", "range_op", "string_selector", "property_select", "object_selector", "row_selector",
               "date_convert", "period_to_date", "object_property", "multipass_attribute", "xy_range",
               "series_agg", "series_op", "regression", "shift_datetime")
# parameter cards a viewer changes: `value` is the selection (a list when `multiple`)
SELECTOR_KINDS = ("string_selector", "property_select", "object_selector", "row_selector")
# selectors whose value is a parameter of the transform tables' expressions and filters
PARAM_SELECTOR_KINDS = ("string_selector", "property_select", "object_selector")
# cards that are an object set / table other cards read as their input
INPUT_KINDS = ("object_set", "table", "cross_filter", "object_selector")
RANGE_OPS = ("start", "end", "to_date_range")
RANGE_TYPES = ("auto", "number", "date")
XY_RANGE_TYPES = ("auto", "number", "date", "string")
DATE_CONVERSIONS = ("string_to_date", "number_to_date")
NUMBER_DATE_UNITS = {"milliseconds": 1, "seconds": 1000, "days": 86_400_000}
PERIODS = ("day", "week", "month", "year")
MULTIPASS_ATTRIBUTES = ("id", "username", "display_name", "first_name", "last_name", "email", "role", "organization", "groups")
MAX_OPTIONS = 1000
# cards whose result may be an array (a numeric aggregation reads it as a number array)
ARRAY_KINDS = ("column_values", "create_array", "stepped_array", "array_op", "string_op", "coalesce",
               "string_selector", "property_select", "multipass_attribute", "regression")
STRING_OPS =("concatenate", "substring", "find_replace", "lower", "upper", "trim", "length", "regex_extract", "split",
              "to_number", "to_boolean", "date_to_string")
NUMBER_COMPARISONS = ("eq", "neq", "gt", "gte", "lt", "lte")
STRING_COMPARISONS = ("is", "is_not", "contains", "not_contains", "starts_with", "ends_with")
DATE_COMPARISONS = ("before", "on_or_before", "after", "on_or_after", "on", "not_on", "between")
COMPARISONS = NUMBER_COMPARISONS + STRING_COMPARISONS + DATE_COMPARISONS
ARRAY_OPS = ("length", "first", "last", "at", "contains", "join", "sort", "unique", "to_numbers", "to_dates", "to_booleans")
MAX_STRING = 100_000
MAX_PATTERN = 500
REGEX_TIMEOUT = 1.0
CHART_KINDS = ("correlation", "waterfall", "series_distribution", "series_scatter")
# object cards that return an object set (read by other cards as their input, like an object set card)
OBJECT_SET_KINDS = ("filter_object_set", "set_math", "linked_object_set", "status_filter", "object_view", "defined_by_property", "saved_object_set")
SET_RID = "ri.object-set.main."
SHOW_OBJECTS = 50  # objects an object set card's result carries (comp.object_rows raises it: a report widget, a CSV)
MAX_DEFINING_VALUES = 100_000
KINDS = VALUE_KINDS + CHART_KINDS + OBJECT_SET_KINDS
# the cards whose rows are whole objects of one type (an object set card, an object selector and the object set cards)
OBJECT_INPUT_KINDS = ("object_set", "object_selector", *OBJECT_SET_KINDS)
INPUT_KINDS = INPUT_KINDS + OBJECT_SET_KINDS
SET_MATH_OPS = ("union", "intersection", "difference")
OBJECT_FILTER_OPS = ("eq", "neq", "contains", "starts_with", "gt", "gte", "lt", "lte", "between", "in", "is_null", "not_null", "regex", "wildcard",
                     "linked", "not_linked")
STATUSES = ("open", "closed")
MAX_SET_INPUTS = 10
MAX_CONDITIONS = 50
# time series cards (their input is a time series card of the analysis' logic)
SERIES_AGGREGATIONS = ("sum", "mean", "std", "max", "min", "relative_difference", "difference", "product", "count", "first", "last",
                       "time_weighted_average", "integral", "median", "percentile", "range")
WEIGHTED_AGGREGATIONS = ("time_weighted_average", "integral")
INTEGRATION_METHODS = ("linear", "lhs", "rhs")
BOUNDS_INTERPOLATIONS = ("none", "linear", "nearest", "previous", "next")
TIME_UNITS = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}
SERIES_OPS = ("value_at", "enum_value_at", "latest_enum", "unit", "start", "end", "backing_object")
FITS = ("linear", "polynomial", "exponential")
MAX_DEGREE = 13
BUCKET_VALUES = ("mean", "sum", "min", "max", "median", "first", "last")
MAX_SCATTER = 5000
MAX_BINS = 200
MAX_GRID = 100
MAX_CATEGORIES_SHOWN = 50
AGGREGATIONS = ("count", "unique_count", "sum", "mean", "min", "max", "median", "std", "variance", "percentile", "product",
                "first", "last", "difference", "relative_difference")
DATE_AGGREGATIONS = ("count", "unique_count", "min", "max", "first", "last")
DATE_UNITS = {"week": 604_800_000, "day": 86_400_000, "hour": 3_600_000, "minute": 60_000, "second": 1000, "millisecond": 1}
DATE_PARTS = ("day_of_week", "day_of_month", "day_of_year", "hour", "month", "year")
WATERFALL_METRICS = ("count", "sum", "avg", "min", "max", "unique_count")
MAX_ARRAY = 10_000
MAX_CORR_COLUMNS = 20
MAX_WATERFALL = 50

# value(card_id) → that card's result dict (computed on demand); param values come from the compiler
ValueOf = Callable[[str], dict]


def col_kind(t: pa.DataType) -> str:
    if pa.types.is_boolean(t):
        return "boolean"
    if pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t):
        return "number"
    if pa.types.is_timestamp(t) or pa.types.is_date(t):
        return "date"
    return "string"


class Schema(dict):
    """Column kinds (a plain dict to every reader) carrying `lists`: the array columns and their elements' kind."""

    lists: dict[str, str] = {}


def _schema(comp: E.Compiler, rel: str) -> dict[str, str]:
    """Column kinds: number, date, string, boolean. Text columns whose every value reads as a date (an object set's
    date properties arrive as ISO text) are dates."""
    schema = comp.run(f"SELECT * FROM {rel}", 0).schema
    types = Schema({f.name: col_kind(f.type) for f in schema})
    # array columns (array properties): their elements' kind (the column itself reads as text where a kind is asked)
    types.lists = {f.name: col_kind(f.type.value_type) for f in schema if pa.types.is_list(f.type) or pa.types.is_large_list(f.type)}
    text = [k for k, v in types.items() if v == "string" and k != "primary_key" and k not in types.lists]
    if text:
        checks = ", ".join(f"COUNT({E.q(k)}) > 0 AND COUNT({E.q(k)}) = COUNT(TRY_CAST(CAST({E.q(k)} AS VARCHAR) AS TIMESTAMP)) AS {E.q(k)}" for k in text)
        row = E.rows_of(comp.run(f"SELECT {checks} FROM {rel}"))[0]
        types.update({k: "date" for k in text if row.get(k)})
    return types


def _date_col(types: dict[str, str], col: str) -> str:
    # an expression reading the column as a timestamp (date columns may be ISO text)
    return f"TRY_CAST(CAST({E.q(col)} AS VARCHAR) AS TIMESTAMP)" if types.get(col) == "date" else E.q(col)


def _input_rel(comp: E.Compiler, cards: dict[str, dict], c: dict, allowed: tuple[str, ...] = INPUT_KINDS,
               what: str = "an object set or a transform table") -> tuple[str, str]:
    src = (c.get("source") or {}).get("card")
    if not src or src not in cards:
        raise E.ContourError("choose the card to read from")
    kind = cards[src].get("kind") or "object_set"
    if kind not in allowed:
        raise E.ContourError(f"${src} is not {what}")
    return src, comp.path_rel(src, None)


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    try:
        f = float(str(v))
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def _clean(v: Any) -> Any:
    return None if isinstance(v, float) and not math.isfinite(v) else v


def aggregate_values(values: list[Any], how: str, percentile: Optional[float] = None, kind: str = "number") -> Any:
    """One aggregation of a list of values in their order (nulls already removed). Standard deviation and variance are
    the sample statistics (n − 1), percentiles interpolate linearly between the closest ranks."""
    if how == "count":
        return len(values)
    if how == "unique_count":
        return len({str(v) for v in values})
    if not values:
        return None
    if kind == "date":
        if how not in DATE_AGGREGATIONS:
            raise E.ContourError(f"{how.replace('_', ' ')} needs a numeric column (dates take count, unique count, min, max, first, last)")
        if how == "first":
            return values[0]
        if how == "last":
            return values[-1]
        return min(values) if how == "min" else max(values)
    if how == "first":
        return values[0]
    if how == "last":
        return values[-1]
    nums = [x for x in (_num(v) for v in values) if x is not None]
    if not nums:
        return None
    if how == "sum":
        return math.fsum(nums)
    if how == "mean":
        return math.fsum(nums) / len(nums)
    if how == "min":
        return min(nums)
    if how == "max":
        return max(nums)
    if how == "product":
        p = 1.0
        for x in nums:
            p *= x
        return p
    if how == "difference":
        return nums[-1] - nums[0]
    if how == "relative_difference":
        return None if nums[0] == 0 else (nums[-1] - nums[0]) / abs(nums[0])
    s = sorted(nums)
    if how == "median":
        how, percentile = "percentile", 50
    if how == "percentile":
        p = 50.0 if percentile is None else float(percentile)
        if not 0 <= p <= 100:
            raise E.ContourError("the percentile is between 0 and 100")
        pos = (len(s) - 1) * p / 100
        lo = math.floor(pos)
        hi = min(lo + 1, len(s) - 1)
        return s[lo] + (s[hi] - s[lo]) * (pos - lo)
    if how in ("std", "variance"):
        if len(nums) < 2:
            return None
        m = math.fsum(nums) / len(nums)
        var = math.fsum((x - m) ** 2 for x in nums) / (len(nums) - 1)
        return var if how == "variance" else math.sqrt(var)
    raise E.ContourError(f"unknown aggregation {how} ({', '.join(AGGREGATIONS)})")


def numeric_agg(comp: E.Compiler, cards: dict[str, dict], c: dict, value_of: ValueOf) -> dict:
    how = c.get("aggregation") or "count"
    if how not in AGGREGATIONS:
        raise E.ContourError(f"unknown aggregation {how} ({', '.join(AGGREGATIONS)})")
    src = (c.get("source") or {}).get("card")
    if src in cards and cards[src].get("kind") in ARRAY_KINDS:
        # Number array aggregation: the array of a column values (create array, split, array sort …) card
        r = value_of(src)
        if r.get("error"):
            raise E.ContourError(f"${src}: {r['error']}")
        if r.get("type") != "array":
            raise E.ContourError(f"${src} is not an array")
        vals = [v for v in r.get("value") or [] if v is not None]
        kind = r.get("element_type") or "number"
        if kind in ("string", "boolean") and how not in ("count", "unique_count"):
            raise E.ContourError(f"${src} is a {kind} array: only count and unique count apply")
        if kind == "date":
            # one fixed-width UTC form, so min / max compare as dates
            vals = [_iso_ms(_date_ms(v, "a date")) for v in vals]
        return {"value": _clean(aggregate_values(vals, how, c.get("percentile"), kind)), "type": "date" if kind == "date" and how not in ("count", "unique_count") else "number",
                "input": "array", "count": len(vals)}
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    col = c.get("column") or None
    if how != "count" and not col:
        raise E.ContourError(f"{how.replace('_', ' ')} needs a column")
    if col and col not in types:
        raise E.ContourError(f"${src} has no column {col}")
    kind = types.get(col, "number") if col else "number"
    if kind in ("string", "boolean") and how not in ("count", "unique_count"):
        raise E.ContourError(f"{col} is a {kind} column: only count and unique count apply")
    if not col:
        value: Any = comp.count(rel)
    else:
        # the column's non-null values in the table's order (first / last / difference depend on it)
        t = comp.run(f"SELECT {_date_col(types, col)} AS v FROM {rel} WHERE {E.q(col)} IS NOT NULL")
        vals = t.column(0).to_pylist()
        if kind == "date":
            vals = [v if isinstance(v, datetime) else datetime.combine(v, datetime.min.time()) for v in vals]
        value = aggregate_values(vals, how, c.get("percentile"), kind)
        if isinstance(value, datetime):
            value = value.isoformat()
    out_type = "date" if kind == "date" and how not in ("count", "unique_count") else "number"
    return {"value": _clean(value), "type": out_type, "input_columns": list(types), "column_types": types}


def column_values(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    col = c.get("column") or ""
    if not col:
        raise E.ContourError("choose the column")
    if col not in types:
        raise E.ContourError(f"${src} has no column {col}")
    limit = max(1, min(int(c.get("limit") or MAX_ARRAY), MAX_ARRAY))
    sel = f"SELECT DISTINCT {E.q(col)} AS v FROM {rel} WHERE {E.q(col)} IS NOT NULL" if c.get("distinct") else f"SELECT {E.q(col)} AS v FROM {rel} WHERE {E.q(col)} IS NOT NULL"
    order = {"asc": " ORDER BY v ASC", "desc": " ORDER BY v DESC"}.get(c.get("sort") or "", "")
    total = int(comp.run(f"SELECT COUNT(*) FROM ({sel})").column(0)[0].as_py())
    vals = [r["v"] for r in E.rows_of(comp.run(f"SELECT * FROM ({sel}{order}) LIMIT {limit}"))]
    return {"value": vals, "type": "array", "element_type": types[col], "count": total, "truncated": total > limit,
            "input_columns": list(types), "column_types": types}


# ------------------------------------------------------------------------------------------------
# operands and formulas
# ------------------------------------------------------------------------------------------------

# in a formula: $ID or $ID.name (a row's cell, a range's end)
REF = re.compile(r"\$([A-Za-z][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|\s*\())?")
# a whole input: $ID or $ID.name (the name may hold spaces: a column)
OPERAND_REF = re.compile(r"\$([A-Za-z][A-Za-z0-9_-]*)(?:\.(.+))?")


def ref_of(spec: Any, cards: dict[str, dict], params: dict) -> Optional[tuple[str, Optional[str]]]:
    """("ID", None) for "$ID", ("ID", "name") for "$ID.name" when ID is a card or a parameter; None for typed text."""
    m = OPERAND_REF.fullmatch(str(spec if spec is not None else "").strip())
    if not m or (m.group(2) is not None and m.group(1) not in cards and m.group(1) not in params):
        return None
    return m.group(1), m.group(2)


def _member(v: Any, ref: str, name: str) -> Any:
    """$ID.name: a cell of a row selector's row, the start / end of a range, the x / y range of an X/Y range."""
    if v is None:
        return None  # no row selected: its cells are empty
    if not isinstance(v, dict):
        raise E.ContourError(f"${ref} is not a row or a range: ${ref}.{name} cannot be read")
    if name not in v:
        raise E.ContourError(f"${ref} has no {'column' if not set(v) <= {'start', 'end', 'x', 'y'} else 'part'} {name}")
    return v[name]


def ref_type(ref: str, name: Optional[str], cards: dict[str, dict], value_of: ValueOf, v: Any) -> str:
    """The type of what "$ID" / "$ID.name" reads."""
    if ref not in cards:
        return _type_of(v)
    r = value_of(ref)
    if name is None:
        return r.get("type") or _type_of(v)
    if r.get("type") == "row":
        return (r.get("column_types") or {}).get(name) or _type_of(v)
    if r.get("type") == "range":
        return r.get("element_type") or _type_of(v)
    return _type_of(v)


def operand(spec: Any, cards: dict[str, dict], params: dict, value_of: ValueOf) -> Any:
    """"$ID" → a card's value or a parameter's ("$ID.name": a part of it); anything else is the literal (a number when
    it reads as one)."""
    if isinstance(spec, (int, float)) and not isinstance(spec, bool):
        return spec
    s = str(spec if spec is not None else "").strip()
    if not s:
        raise E.ContourError("choose the input")
    m = ref_of(s, cards, params)
    if m:
        ref, name = m
        if ref in cards:
            r = value_of(ref)
            if r.get("error"):
                raise E.ContourError(f"${ref}: {r['error']}")
            if "value" not in r:
                raise E.ContourError(f"${ref} does not return a value")
            v = r["value"]
        elif ref in params:
            v = params[ref]
        else:
            raise E.ContourError(f"unknown card or parameter ${ref}")
        return v if name is None else _member(v, ref, name)
    n = _num(s)
    return n if n is not None and re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", s) else s


def _pow(a: Any, b: Any) -> float:
    # floats only: an integer power of a huge exponent would compute for minutes
    return math.pow(float(a), float(b))


def _arith(op: str, a: Any, b: Any) -> Any:
    """+ - * / % on numbers only (a string times a large number would build a huge string)."""
    for x in (a, b):
        if x is not None and not isinstance(x, (int, float)):
            raise E.ContourError(f"formula: {op} needs numbers, not {x!r}")
    if a is None or b is None:
        return None
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    return a % b


class _Arith(ast.NodeTransformer):
    OPS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Mod: "%"}

    def visit_BinOp(self, node: ast.BinOp) -> ast.AST:
        self.generic_visit(node)
        return ast.copy_location(ast.Call(func=ast.Name(id="__arith", ctx=ast.Load()), args=[ast.Constant(self.OPS[type(node.op)]), node.left, node.right], keywords=[]), node)


_FUNCS: dict[str, Callable[..., Any]] = {
    "abs": abs, "min": min, "max": max, "pow": _pow, "round": lambda a, d=0: math.copysign(math.floor(abs(a) * 10.0 ** int(d) + 0.5), a) / 10.0 ** int(d),
    "floor": math.floor, "ceil": math.ceil, "sqrt": math.sqrt, "cbrt": lambda a: math.copysign(abs(a) ** (1 / 3), a),
    "exp": math.exp, "ln": math.log, "log": math.log, "log10": math.log10, "log2": math.log2,
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin, "acos": math.acos, "atan": math.atan, "atan2": math.atan2,
    "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh, "asinh": math.asinh, "acosh": math.acosh, "atanh": math.atanh,
    "signum": lambda a: (a > 0) - (a < 0), "isnan": lambda a: a is None or (isinstance(a, float) and math.isnan(a)),
    "isfinite": lambda a: isinstance(a, (int, float)) and math.isfinite(a), "if_else": lambda c, a, b: a if c else b,
}


def _f_text(a: Any) -> str:
    if not isinstance(a, str):
        raise E.ContourError(f"formula: {a!r} is not a string")
    return a


def _f_length(a: Any) -> int:
    if not isinstance(a, (str, list)):
        raise E.ContourError(f"formula: length takes a string or an array, not {a!r}")
    return len(a)


def _f_contains(a: Any, b: Any) -> bool:
    if isinstance(a, list):
        return b in a
    return _f_text(b) in _f_text(a)


def _f_concat(*xs: Any) -> str:
    out = "".join("" if x is None else _text(x) for x in xs)
    if len(out) > MAX_STRING:
        raise E.ContourError(f"formula: the string is longer than {MAX_STRING:,} characters")
    return out


# text and array functions of the formula syntax (strings and arrays come from cards, they are never built from numbers)
_FUNCS.update({
    "length": _f_length, "contains": _f_contains, "starts_with": lambda a, b: _f_text(a).startswith(_f_text(b)),
    "ends_with": lambda a, b: _f_text(a).endswith(_f_text(b)), "lower": lambda a: _f_text(a).lower(),
    "upper": lambda a: _f_text(a).upper(), "trim": lambda a: _f_text(a).strip(), "concat": _f_concat,
})


def _ternary(src: str) -> str:
    """`a ? b : c` (right-associative, outside strings) → `(b if a else c)`."""
    def split_top(s: str, ch: str) -> int:
        depth, quote = 0, ""
        for i, x in enumerate(s):
            if quote:
                quote = "" if x == quote else quote
            elif x in "\"'":
                quote = x
            elif x in "([":
                depth += 1
            elif x in ")]":
                depth -= 1
            elif x == ch and depth == 0:
                return i
        return -1

    def conv(s: str) -> str:
        # function arguments separately: max($A, $B > 0 ? 1 : 2)
        parts, depth, quote, last = [], 0, "", 0
        for i, x in enumerate(s):
            if quote:
                quote = "" if x == quote else quote
            elif x in "\"'":
                quote = x
            elif x in "([":
                depth += 1
            elif x in ")]":
                depth -= 1
            elif x == "," and depth == 0:
                parts.append(s[last:i])
                last = i + 1
        if parts:
            return ",".join(conv(p) for p in [*parts, s[last:]])
        # parenthesised groups first
        out, i = "", 0
        while i < len(s):
            if s[i] == "(":
                depth, j = 0, i
                while j < len(s):
                    depth += 1 if s[j] == "(" else -1 if s[j] == ")" else 0
                    if depth == 0:
                        break
                    j += 1
                out += "(" + conv(s[i + 1:j]) + ")"
                i = j + 1
            else:
                out += s[i]
                i += 1
        q = split_top(out, "?")
        if q < 0:
            return out
        rest = out[q + 1:]
        # the matching ':' — skipping nested '?' … ':' pairs
        depth, k = 0, -1
        for i, x in enumerate(rest):
            if x == "?":
                depth += 1
            elif x == ":":
                if depth == 0:
                    k = i
                    break
                depth -= 1
        if k < 0:
            raise E.ContourError("a ? b : c is missing its ':'")
        return f"(({conv(rest[:k])}) if ({out[:q]}) else ({conv(rest[k + 1:])}))"

    return conv(src)


def _eval_formula(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> tuple[Any, list[str]]:
    """Quiver's formula syntax on single values: + - * / %, comparisons, && || !, a ? b : c, the built-in functions."""
    src = str(c.get("formula") or "").strip()
    if not src:
        raise E.ContourError("the formula is empty")
    found = sorted(set(REF.findall(src)))
    refs = [r + (f".{name}" if name else "") for r, name in found]
    env: dict[str, Any] = {}
    for r, name in found:
        if name and r not in cards and r not in params:
            raise E.ContourError(f"unknown card or parameter ${r}")
        v = operand(f"${r}" + (f".{name}" if name else ""), cards, params, value_of)
        # numeric text reads as a number, except a string card's value ("007" stays text)
        text = r in cards and (ref_type(r, name, cards, value_of, v) if name else value_of(r).get("type")) == "string"
        if isinstance(v, str) and _num(v) is not None and not text:
            v = _num(v)
        env[f"__c_{r}" + (f"__{name}" if name else "")] = v
    py = REF.sub(lambda m: f"__c_{m.group(1)}" + (f"__{m.group(2)}" if m.group(2) else ""), src)
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    py = re.sub(r"\btrue\b", "True", re.sub(r"\bfalse\b", "False", py))
    py = re.sub(r"\bNaN\b", "None", py)
    py = _ternary(py)
    try:
        tree = ast.parse(py, mode="eval")
    except SyntaxError as e:
        raise E.ContourError(f"formula: {e.msg}") from None
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp, ast.Call, ast.Name, ast.Load, ast.Constant,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or,
               ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot)
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise E.ContourError(f"formula: {type(node).__name__} is not allowed (powers are pow(a, b))")
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in _FUNCS):
            raise E.ContourError(f"formula: only {', '.join(sorted(_FUNCS))} can be called")
        if isinstance(node, ast.Name) and not (node.id in _FUNCS or node.id in env or node.id in ("True", "False", "None")):
            raise E.ContourError(f"formula: unknown name {node.id} (cards and parameters are $ID)")
    tree = ast.fix_missing_locations(_Arith().visit(tree))
    try:
        v = eval(compile(tree, "<formula>", "eval"), {"__builtins__": {}, "__arith": _arith, **_FUNCS}, env)  # noqa: S307 (AST checked above)
    except ZeroDivisionError:
        v = None
    except (TypeError, ValueError, OverflowError) as e:
        raise E.ContourError(f"formula: {e}") from None
    if isinstance(v, float) and not math.isfinite(v):
        v = None
    return v, refs


def numeric_formula(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    v, refs = _eval_formula(c, cards, params, value_of)
    if isinstance(v, bool):
        v = 1 if v else 0
    if isinstance(v, list):
        raise E.ContourError("formula: the result is an array — aggregate it (length(…), or a numeric aggregation card)")
    return {"value": v, "type": "string" if isinstance(v, str) else "number", "refs": refs}


def boolean_formula(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """The formula syntax returning true / false: comparisons, && || !, contains(…), starts_with(…) …; a number is
    true when it is not 0, an empty result is null."""
    v, refs = _eval_formula(c, cards, params, value_of)
    if v is not None and not isinstance(v, (bool, int, float)):
        raise E.ContourError(f"formula: the result {v!r} is not true / false")
    return {"value": None if v is None else bool(v), "type": "boolean", "refs": refs}


def round_card(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    mode = c.get("mode") or "floor"
    if mode not in ("floor", "ceil", "round"):
        raise E.ContourError("mode is floor, ceil or round")
    v = _num(operand(c.get("input"), cards, params, value_of))
    if v is None:
        return {"value": None, "type": "number"}
    d = max(-12, min(12, int(c.get("digits") or 0)))
    f = 10.0 ** d
    if mode == "round":
        # half away from zero, as people round by hand
        r = math.copysign(math.floor(abs(v) * f + 0.5), v) / f
    else:
        r = (math.floor(v * f) if mode == "floor" else math.ceil(v * f)) / f
    return {"value": int(r) if d <= 0 else r, "type": "number"}


def _date_ms(v: Any, what: str) -> int:
    import ts_engine as TE

    if isinstance(v, (dict, list)):
        raise E.ContourError(f"{what} is {'a range' if isinstance(v, dict) else 'an array'}, not a date / time")
    try:
        ms = TE.to_ms(v)
    except TE.EngineError:
        raise E.ContourError(f"{what}: {v!r} is not a date / time") from None
    if ms is None:
        raise E.ContourError(f"{what} is empty")
    return ms


def date_diff(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    unit = c.get("unit") or "day"
    if unit not in DATE_UNITS:
        raise E.ContourError(f"unit is one of {', '.join(DATE_UNITS)}")
    a = _date_ms(operand(c.get("start"), cards, params, value_of), "the start")
    b = _date_ms(operand(c.get("end"), cards, params, value_of), "the end")
    d = (b - a) / DATE_UNITS[unit]
    return {"value": int(d) if float(d).is_integer() else d, "type": "number", "unit": unit}


def date_part(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    part = c.get("part") or "day_of_week"
    if part not in DATE_PARTS:
        raise E.ContourError(f"part is one of {', '.join(DATE_PARTS)}")
    d = datetime.fromtimestamp(_date_ms(operand(c.get("input"), cards, params, value_of), "the date") / 1000, timezone.utc)
    v = {"day_of_week": d.isoweekday(), "day_of_month": d.day, "day_of_year": d.timetuple().tm_yday, "hour": d.hour, "month": d.month, "year": d.year}[part]
    return {"value": v, "type": "number", "date": d.isoformat().replace("+00:00", "Z")}


# ------------------------------------------------------------------------------------------------
# strings, Booleans and arrays
# ------------------------------------------------------------------------------------------------

ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?")


def _iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(v: Any) -> str:
    """A value as text: true / false, integral numbers without .0, dates in ISO."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e16:
        return str(int(v))
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, list):
        raise E.ContourError("an array is not a string (Array join makes one)")
    if isinstance(v, dict):
        if set(v) <= {"start", "end"}:
            raise E.ContourError("a range is not a single value (Range start / Range end read its ends)")
        if set(v) <= {"x", "y"}:
            raise E.ContourError("an X/Y range is not a single value ($ID.x / $ID.y are its ranges)")
        raise E.ContourError("a row is not a single value ($ID.column reads one of its cells)")
    return str(v)


def _type_of(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "range"
    if isinstance(v, datetime):
        return "date"
    return "string"


def _infer(vals: list[Any]) -> str:
    """An array's element type from its values (ISO date text reads as dates)."""
    xs = [v for v in vals if v is not None]
    if not xs:
        return "string"
    if all(isinstance(v, bool) for v in xs):
        return "boolean"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in xs):
        return "number"
    if all(isinstance(v, datetime) or (isinstance(v, str) and ISO_DATE.fullmatch(v.strip())) for v in xs):
        return "date"
    return "string"


def _check_len(s: str) -> str:
    if len(s) > MAX_STRING:
        raise E.ContourError(f"the string is longer than {MAX_STRING:,} characters")
    return s


def text_operand(spec: Any, cards: dict[str, dict], params: dict, value_of: ValueOf) -> tuple[Any, str]:
    """A string input: "$ID" → the card's / parameter's value and its type; typed text is kept as typed (spaces
    included, "007" stays text)."""
    s = "" if spec is None else str(spec)
    m = ref_of(s, cards, params)
    if m:
        v = operand(s, cards, params, value_of)
        return v, ref_type(m[0], m[1], cards, value_of, v)
    return s, "string"


def typed_operand(spec: Any, cards: dict[str, dict], params: dict, value_of: ValueOf) -> tuple[Any, str]:
    """A value of any type: "$ID" → the value with its card's type; a typed number reads as a number, true / false as a
    Boolean, an ISO date as a date, anything else as text."""
    if isinstance(spec, (int, float, bool)):
        return spec, _type_of(spec)
    v, t = text_operand(spec, cards, params, value_of)
    if not (isinstance(spec, str) and spec.strip().startswith("$")):
        s = str(v).strip()
        if s.lower() in ("true", "false"):
            return s.lower() == "true", "boolean"
        n = _num(s)
        if n is not None and re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", s):
            return (int(n) if n.is_integer() and "." not in s and "e" not in s.lower() else n), "number"
        if ISO_DATE.fullmatch(s):
            return s, "date"
        return v, "string"
    if t == "string" and isinstance(v, str) and ISO_DATE.fullmatch(v.strip()) and not (str(spec).strip()[1:] in cards):
        t = "date"  # a date / time parameter
    return v, t


def array_operand(spec: Any, cards: dict[str, dict], params: dict, value_of: ValueOf, what: str = "the array") -> tuple[list, str]:
    """An array input: an array card ($L1 …) or an array parameter; its values and element type."""
    s = str(spec if spec is not None else "").strip()
    if not s:
        raise E.ContourError(f"choose {what}")
    if not s.startswith("$"):
        raise E.ContourError(f"{what}: choose an array card ($ID)")
    v = operand(s, cards, params, value_of)
    if not isinstance(v, list):
        raise E.ContourError(f"{s} is not an array")
    ref = s[1:]
    et = value_of(ref).get("element_type") if ref in cards else None
    return list(v), et or _infer(v)


def _rx():
    """The regex module (with a time limit, so a pathological pattern cannot hang the server); re without it."""
    try:
        import regex

        return regex, {"timeout": REGEX_TIMEOUT}
    except ImportError:  # pragma: no cover
        return re, {}


def _compile(pattern: str, ignore_case: bool = False):
    if not pattern:
        raise E.ContourError("the pattern is empty")
    if len(pattern) > MAX_PATTERN:
        raise E.ContourError(f"the pattern is longer than {MAX_PATTERN} characters")
    mod, _ = _rx()
    try:
        return mod.compile(pattern, mod.IGNORECASE if ignore_case else 0)
    except Exception as e:  # noqa: BLE001 — re.error / regex.error
        raise E.ContourError(f"pattern: {e}") from None


def _regex_call(fn: Callable[..., Any], *args: Any, **kw: Any) -> Any:
    _, extra = _rx()
    try:
        return fn(*args, **kw, **extra)
    except TimeoutError:
        raise E.ContourError(f"the pattern took longer than {REGEX_TIMEOUT:g} s on this text — simplify it") from None
    except E.ContourError:
        raise
    except Exception as e:  # noqa: BLE001 — a bad group reference in the replacement …
        raise E.ContourError(f"pattern: {e}") from None


# moment-style date format tokens (Quiver's "YY-MMM-DD"); [text] is literal
_DATE_TOKENS = re.compile(r"\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|SSS|A|ZZ|Z")
_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
_DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def format_date(ms: int, fmt: str) -> str:
    d = datetime.fromtimestamp(ms / 1000, timezone.utc)
    if not fmt.strip():
        return _iso_ms(ms)
    h12 = d.hour % 12 or 12

    def one(m: re.Match) -> str:
        t = m.group(0)
        if t.startswith("["):
            return t[1:-1]
        return {
            "YYYY": f"{d.year:04d}", "YY": f"{d.year % 100:02d}", "MMMM": _MONTHS[d.month - 1], "MMM": _MONTHS[d.month - 1][:3],
            "MM": f"{d.month:02d}", "M": str(d.month), "DDDD": f"{d.timetuple().tm_yday:03d}", "DD": f"{d.day:02d}", "D": str(d.day),
            "dddd": _DAYS[d.weekday()], "ddd": _DAYS[d.weekday()][:3], "HH": f"{d.hour:02d}", "H": str(d.hour), "hh": f"{h12:02d}",
            "h": str(h12), "mm": f"{d.minute:02d}", "ss": f"{d.second:02d}", "SSS": f"{d.microsecond // 1000:03d}",
            "A": "AM" if d.hour < 12 else "PM", "ZZ": "+0000", "Z": "+00:00",
        }[t]

    return _DATE_TOKENS.sub(one, fmt[:200])


def _to_bool(v: Any, true_values: list[str], false_values: list[str], default: bool) -> bool:
    if isinstance(v, bool):
        return v
    s = _text(v).strip().lower()
    if s in [x.strip().lower() for x in true_values]:
        return True
    if s in [x.strip().lower() for x in false_values]:
        return False
    if s in ("true", "false"):
        return s == "true"
    return default


def _to_number(v: Any) -> Optional[float | int]:
    if isinstance(v, bool) or v is None:
        return None
    n = _num(_text(v).strip().replace(",", "")) if isinstance(v, str) else _num(v)
    if n is None:
        return None
    return int(n) if n.is_integer() and abs(n) < 1e16 else n


def _to_date(v: Any) -> Optional[str]:
    import ts_engine as TE

    try:
        ms = TE.to_ms(v)
    except TE.EngineError:
        return None
    return None if ms is None else _iso_ms(ms)


def _int_operand(spec: Any, default: int, what: str, cards: dict[str, dict], params: dict, value_of: ValueOf) -> int:
    if spec is None or (isinstance(spec, str) and not spec.strip()):
        return default
    n = _num(operand(spec, cards, params, value_of))
    if n is None or not float(n).is_integer() or abs(n) > 1e9:
        raise E.ContourError(f"{what} is a whole number")
    return int(n)


def string_op(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    op = c.get("op") or "upper"
    if op not in STRING_OPS:
        raise E.ContourError(f"operation is one of {', '.join(STRING_OPS)}")
    v, vt = text_operand(c.get("input"), cards, params, value_of)
    if isinstance(v, dict):
        _text(v)  # a range: refused
    if op == "date_to_string":
        if v is None or v == "":
            return {"value": None, "type": "string"}
        return {"value": format_date(_date_ms(v, "the date"), str(c.get("format") or "")), "type": "string"}
    if op == "to_boolean":
        if v is None:
            return {"value": None, "type": "boolean"}
        return {"value": _to_bool(v, list(c.get("true_values") or []), list(c.get("false_values") or []), bool(c.get("default"))), "type": "boolean"}
    if op == "to_number":
        return {"value": None if v is None else _to_number(v), "type": "number"}
    if v is None:
        # an empty input stays empty (concatenate reads it as "")
        if op not in ("concatenate",):
            return {"value": None, "type": "array" if op == "split" else "number" if op == "length" else "string"}
        v = ""
    s = _check_len(_text(v))
    if op == "concatenate":
        b, _ = text_operand(c.get("input2"), cards, params, value_of)
        d, _ = text_operand(c.get("delimiter") or "", cards, params, value_of)
        return {"value": _check_len(s + _text(d) + _text(b)), "type": "string"}
    if op == "substring":
        start = _int_operand(c.get("start"), 0, "the start", cards, params, value_of)
        if c.get("length") in (None, ""):
            return {"value": s[start:] if start >= 0 else s[max(0, len(s) + start):], "type": "string"}
        n = _int_operand(c.get("length"), 0, "the length", cards, params, value_of)
        if n < 0:
            raise E.ContourError("the length is 0 or more")
        b = start if start >= 0 else max(0, len(s) + start)
        return {"value": s[b:b + n], "type": "string"}
    if op == "lower":
        return {"value": s.lower(), "type": "string"}
    if op == "upper":
        return {"value": s.upper(), "type": "string"}
    if op == "trim":
        return {"value": s.strip(), "type": "string"}
    if op == "length":
        return {"value": len(s), "type": "number"}
    if op == "find_replace":
        find, _ = text_operand(c.get("find"), cards, params, value_of)
        repl, _ = text_operand(c.get("replace") or "", cards, params, value_of)
        find, repl = _text(find), _text(repl)
        if not find:
            raise E.ContourError("enter the text to find")
        if c.get("regex"):
            rx = _compile(find, bool(c.get("ignore_case")))
            total = [len(s)]

            def sub(m: Any) -> str:
                out = m.expand(repl)
                total[0] += len(out) - len(m.group(0))
                if total[0] > MAX_STRING:
                    raise E.ContourError(f"the string is longer than {MAX_STRING:,} characters")
                return out

            return {"value": _regex_call(rx.sub, sub, s), "type": "string"}
        if c.get("ignore_case"):
            rx = re.compile(re.escape(find), re.IGNORECASE)
            n = len(rx.findall(s))
            if len(s) + n * (len(repl) - len(find)) > MAX_STRING:
                raise E.ContourError(f"the string is longer than {MAX_STRING:,} characters")
            return {"value": rx.sub(lambda _m: repl, s), "type": "string"}
        if len(s) + s.count(find) * (len(repl) - len(find)) > MAX_STRING:
            raise E.ContourError(f"the string is longer than {MAX_STRING:,} characters")
        return {"value": s.replace(find, repl), "type": "string"}
    if op == "regex_extract":
        rx = _compile(_text(c.get("pattern") or ""), bool(c.get("ignore_case")))
        g = int(c.get("group") or 0)
        if g < 0 or g > rx.groups:
            raise E.ContourError(f"the pattern has {rx.groups} group{'s' if rx.groups != 1 else ''} (group 0 is the whole match)")
        m = _regex_call(rx.search, s)
        return {"value": None if m is None else m.group(g), "type": "string"}
    # split
    d, _ = text_operand(c.get("delimiter") if c.get("delimiter") is not None else ",", cards, params, value_of)
    d = _text(d)
    if not d:
        raise E.ContourError("enter the delimiter")
    parts = s.split(d)
    if c.get("trim", True):
        parts = [p.strip() for p in parts]
    if c.get("drop_empty"):
        parts = [p for p in parts if p]
    if len(parts) > MAX_ARRAY:
        raise E.ContourError(f"{len(parts):,} parts — an array holds at most {MAX_ARRAY:,}")
    return {"value": parts, "type": "array", "element_type": "string", "count": len(parts)}


def _word_find(s: str, sub: str) -> bool:
    """`sub` in `s` with special characters and spaces as word boundaries ("Contains"): the match starts and ends at a
    boundary."""
    if not sub:
        return True
    i = s.find(sub)
    while i >= 0:
        j = i + len(sub)
        if (i == 0 or not s[i - 1].isalnum() or not sub[0].isalnum()) and (j == len(s) or not s[j].isalnum() or not sub[-1].isalnum()):
            return True
        i = s.find(sub, i + 1)
    return False


def comparison(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    op = c.get("op") or "eq"
    if op not in COMPARISONS:
        raise E.ContourError(f"comparison is one of {', '.join(COMPARISONS)}")
    # strings compare as typed ("007" is not "7"); numbers and dates read typed text as numbers / dates
    read = text_operand if op in STRING_COMPARISONS else typed_operand
    a, at = read(c.get("left"), cards, params, value_of)
    b, bt = read(c.get("right"), cards, params, value_of)
    if isinstance(a, list) or isinstance(b, list):
        raise E.ContourError("an array is not a single value (Array contains compares with an array)")
    if isinstance(a, dict) or isinstance(b, dict):
        _text(a if isinstance(a, dict) else b)  # a range: refused

    def out(v: Optional[bool]) -> dict:
        return {"value": v, "type": "boolean"}

    if a is None or b is None:
        return out(None)
    if op in NUMBER_COMPARISONS:
        x, y = _num(a), _num(b)
        if x is None or y is None:
            raise E.ContourError(f"{_text(a if x is None else b)!r} is not a number")
        return out({"eq": x == y, "neq": x != y, "gt": x > y, "gte": x >= y, "lt": x < y, "lte": x <= y}[op])
    if op in DATE_COMPARISONS:
        x, y = _date_ms(a, "the date"), _date_ms(b, "the second date")
        if op == "between":
            z, _ = typed_operand(c.get("right2"), cards, params, value_of)
            if z is None:
                return out(None)
            hi = _date_ms(z, "the third date")
            return out(y <= x <= hi)
        return out({"before": x < y, "on_or_before": x <= y, "after": x > y, "on_or_after": x >= y, "on": x == y, "not_on": x != y}[op])
    if op in ("is", "is_not"):
        if isinstance(a, bool) or isinstance(b, bool):
            # a Boolean is the same as true / false typed in any case, nothing else
            def as_bool(v: Any) -> Optional[bool]:
                if isinstance(v, bool):
                    return v
                s = _text(v).strip().lower()
                return s == "true" if s in ("true", "false") else None

            same = as_bool(a) is not None and as_bool(a) == as_bool(b)
        else:
            sa, sb = _text(a), _text(b)
            same = sa.lower() == sb.lower() if c.get("ignore_case") else sa == sb
        return out(same if op == "is" else not same)
    sa, sb = _text(a), _text(b)
    if c.get("ignore_case"):
        sa, sb = sa.lower(), sb.lower()
    if op in ("contains", "not_contains"):
        found = _word_find(sa, sb) if c.get("whole_words", op == "contains") else sb in sa
        return out(found if op == "contains" else not found)
    return out(sa.startswith(sb) if op == "starts_with" else sa.endswith(sb))


def create_array(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """Typed values and cards' values in order; an array card's values are spliced in. element_type converts every value
    (auto: numbers when every value is a number, else as they are)."""
    vals: list[Any] = []
    for spec in c.get("items") or []:
        if spec is None or (isinstance(spec, str) and not spec.strip()):
            continue
        v, _ = typed_operand(spec, cards, params, value_of)
        if isinstance(v, dict):
            _text(v)  # a range: refused
        if isinstance(v, list):
            vals.extend(v)
        else:
            vals.append(v)
        if len(vals) > MAX_ARRAY:
            raise E.ContourError(f"an array holds at most {MAX_ARRAY:,} values")
    et = c.get("element_type") or "auto"
    if et not in ("auto", "string", "number", "boolean", "date"):
        raise E.ContourError("element type is auto, string, number, boolean or date")
    vals = _convert(vals, et)
    return {"value": vals, "type": "array", "element_type": _infer(vals) if et == "auto" else et, "count": len(vals)}


def _convert(vals: list[Any], et: str) -> list[Any]:
    if et == "string":
        return [None if v is None else _text(v) for v in vals]
    if et == "number":
        out = []
        for v in vals:
            n = None if v is None else _to_number(v)
            if v is not None and n is None:
                raise E.ContourError(f"{_text(v)!r} is not a number")
            out.append(n)
        return out
    if et == "boolean":
        out = []
        for v in vals:
            if v is not None and not isinstance(v, bool) and _text(v).strip().lower() not in ("true", "false"):
                raise E.ContourError(f"{_text(v)!r} is not true / false")
            out.append(None if v is None else _to_bool(v, [], [], False))
        return out
    if et == "date":
        return [None if v is None else _iso_ms(_date_ms(v, "a value")) for v in vals]
    # auto: mixed numbers and text become text
    if _infer(vals) == "string" and any(isinstance(v, (int, float)) for v in vals if v is not None):
        return [None if v is None else _text(v) for v in vals]
    return vals


def stepped_array(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    nums = []
    for k in ("start", "end", "step"):
        n = _num(operand(c.get(k) if c.get(k) not in (None, "") else ("1" if k == "step" else ""), cards, params, value_of))
        if n is None:
            raise E.ContourError(f"the {k} is not a number")
        nums.append(n)
    a, b, step = nums
    if step <= 0:
        raise E.ContourError("the step is more than 0 (a start above the end counts down)")
    n = math.floor(abs(b - a) / step + 1e-9) + 1
    if n > MAX_ARRAY:
        raise E.ContourError(f"{n:,} values — an array holds at most {MAX_ARRAY:,}")
    sign = 1 if b >= a else -1
    vals = [round(a + sign * i * step, 12) for i in range(n)]
    vals = [int(v) if float(v).is_integer() else v for v in vals]
    return {"value": vals, "type": "array", "element_type": "number", "count": n}


def _sort_key(et: str) -> Callable[[Any], Any]:
    if et == "number":
        return lambda v: _num(v) if _num(v) is not None else math.inf
    if et == "date":
        return lambda v: _date_ms(v, "a value")
    if et == "boolean":
        return lambda v: bool(v)
    return lambda v: _text(v)


def array_op(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    op = c.get("op") or "length"
    if op not in ARRAY_OPS:
        raise E.ContourError(f"operation is one of {', '.join(ARRAY_OPS)}")
    vals, et = array_operand(c.get("input"), cards, params, value_of)

    def one(v: Any) -> dict:
        return {"value": v, "type": et, "count": len(vals)}

    def arr(xs: list[Any], t: str) -> dict:
        return {"value": xs, "type": "array", "element_type": t, "count": len(xs)}

    if op == "length":
        return {"value": len(vals), "type": "number"}
    if op == "first":
        return one(vals[0] if vals else None)
    if op == "last":
        return one(vals[-1] if vals else None)
    if op == "at":
        i = _int_operand(c.get("index"), 0, "the index (0 is the first value, -1 the last)", cards, params, value_of)
        return one(vals[i] if -len(vals) <= i < len(vals) else None)
    if op == "contains":
        x, _ = typed_operand(c.get("value"), cards, params, value_of)
        if et == "number":
            n = _num(x)
            found = n is not None and any(_num(v) == n for v in vals)
        elif et == "date":
            ms = _date_ms(x, "the value")
            found = any(v is not None and _date_ms(v, "a value") == ms for v in vals)
        elif et == "boolean":
            b = _to_bool(x, [], [], False)
            found = any(v is not None and _to_bool(v, [], [], False) == b for v in vals)
        else:
            found = _text(x) in [_text(v) for v in vals if v is not None]
        return {"value": found, "type": "boolean"}
    if op == "join":
        d, _ = text_operand(c.get("delimiter") if c.get("delimiter") is not None else ", ", cards, params, value_of)
        return {"value": _check_len(_text(d).join(_text(v) for v in vals if v is not None)), "type": "string"}
    if op == "sort":
        key = _sort_key(et)
        present = sorted((v for v in vals if v is not None), key=key, reverse=c.get("order") == "desc")
        return arr(present + [None] * (len(vals) - len(present)), et)
    if op == "unique":
        seen, out = set(), []
        for v in vals:
            k = (type(v).__name__, _text(v)) if v is not None else None
            if k not in seen:
                seen.add(k)
                out.append(v)
        return arr(out, et)
    if op == "to_numbers":
        return arr([_to_number(v) for v in vals], "number")
    if op == "to_dates":
        return arr([_to_date(v) for v in vals], "date")
    return arr([None if v is None else _to_bool(v, [], [], False) for v in vals], "boolean")


def coalesce(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    items = [x for x in c.get("inputs") or [] if not (x is None or (isinstance(x, str) and not x.strip()))]
    if not items:
        raise E.ContourError("add the inputs")
    for spec in items:
        v, t = typed_operand(spec, cards, params, value_of)
        if v is not None and not (isinstance(v, float) and math.isnan(v)):
            out: dict[str, Any] = {"value": v, "type": t}
            if isinstance(v, list):
                ref = str(spec).strip()[1:]
                out.update(type="array", element_type=(value_of(ref).get("element_type") if ref in cards else None) or _infer(v), count=len(v))
            return out
    return {"value": None, "type": "string"}


# ------------------------------------------------------------------------------------------------
# ranges
# ------------------------------------------------------------------------------------------------


def _range_end(v: Any, rt: str, what: str) -> Any:
    """One end of a range as a number or an ISO date (UTC, milliseconds); None when empty."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    if isinstance(v, (list, dict)) or isinstance(v, bool):
        raise E.ContourError(f"{what} is not a single number or date")
    if rt == "number":
        n = _to_number(v)
        if n is None:
            raise E.ContourError(f"{what}: {_text(v)!r} is not a number")
        return n
    return _iso_ms(_date_ms(v, what))


def _range_order(a: Any, b: Any, rt: str) -> None:
    if a is None or b is None:
        return
    if (a > b) if rt == "number" else (_date_ms(a, "the start") > _date_ms(b, "the end")):
        raise E.ContourError("the start of the range is after its end")


def range_card(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """A numeric or date / time range from two inputs (typed, cards' values or parameters). Auto: a numeric range when
    both ends are numbers, else a date / time range. An empty end leaves the range open on that side."""
    rt = c.get("range_type") or "auto"
    if rt not in RANGE_TYPES:
        raise E.ContourError(f"range type is one of {', '.join(RANGE_TYPES)}")
    ends = []
    for k in ("start", "end"):
        spec = c.get(k)
        if spec is None or (isinstance(spec, str) and not spec.strip()):
            ends.append((None, "string"))
        else:
            ends.append(typed_operand(spec, cards, params, value_of))
    if all(v is None for v, _ in ends):
        raise E.ContourError("enter the start and the end of the range")
    if rt == "auto":
        rt = "number" if all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool) and t != "date") for v, t in ends) else "date"
    a, b = _range_end(ends[0][0], rt, "the start"), _range_end(ends[1][0], rt, "the end")
    _range_order(a, b, rt)
    return {"value": {"start": a, "end": b}, "type": "range", "element_type": rt}


def range_operand(spec: Any, cards: dict[str, dict], params: dict, value_of: ValueOf) -> tuple[dict, str]:
    """A range input: a range card or a date / time range parameter ($ID); {start, end} and number | date."""
    s = str(spec if spec is not None else "").strip()
    if not s:
        raise E.ContourError("choose the range")
    m = ref_of(s, cards, params)
    if not m:
        raise E.ContourError("the range: choose a range card or a range parameter ($ID)")
    v = operand(s, cards, params, value_of)
    if not isinstance(v, dict) or not ({"start", "end"} & set(v)):
        raise E.ContourError(f"{s} is not a range")
    ref, name = m
    if ref in cards:
        r = value_of(ref)
        # $XY1.x / $XY1.y: one of an X/Y range's two ranges
        et = (r.get("element_types") or {}).get(name) if name else r.get("element_type")
        return {"start": v.get("start"), "end": v.get("end")}, et or "number"
    # a date / time range parameter of the time series logic
    a, b = _range_end(v.get("start"), "date", "the start"), _range_end(v.get("end"), "date", "the end")
    _range_order(a, b, "date")
    return {"start": a, "end": b}, "date"


def range_op(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    op = c.get("op") or "start"
    if op not in RANGE_OPS:
        raise E.ContourError(f"operation is one of {', '.join(RANGE_OPS)}")
    r, rt = range_operand(c.get("input"), cards, params, value_of)
    if op in ("start", "end"):
        return {"value": r[op], "type": rt}
    if rt != "number":
        raise E.ContourError("the range is already a date / time range" if rt == "date" else "a range of strings is not a date / time range")
    out = {k: None if r[k] is None else _iso_ms(_epoch_ms(r[k])) for k in ("start", "end")}
    return {"value": out, "type": "range", "element_type": "date"}


def _epoch_ms(n: Any) -> int:
    # years 0001 … 9999, so the date can be written
    if not isinstance(n, (int, float)) or not -62_135_596_800_000 <= n <= 253_402_300_799_999:
        raise E.ContourError(f"{_text(n)} is not a time in epoch milliseconds")
    return int(n)


def xy_range(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """An X range and a Y range (a "box"): each numeric, date / time or ordinal (strings, kept as typed)."""
    value: dict[str, dict] = {}
    types: dict[str, str] = {}
    for axis in ("x", "y"):
        rt = c.get(f"{axis}_type") or "auto"
        if rt not in XY_RANGE_TYPES:
            raise E.ContourError(f"the {axis.upper()} range type is one of {', '.join(XY_RANGE_TYPES)}")
        ends = []
        for k in ("start", "end"):
            spec = c.get(f"{axis}_{k}")
            if spec is None or (isinstance(spec, str) and not spec.strip()):
                ends.append((None, "string"))
            else:
                ends.append(text_operand(spec, cards, params, value_of) if rt == "string" else typed_operand(spec, cards, params, value_of))
        if all(v is None for v, _ in ends):
            raise E.ContourError(f"enter the start and the end of the {axis.upper()} range")
        if rt == "string":
            a, b = (None if v is None else _text(v) for v, _ in ends)
        else:
            if rt == "auto":
                rt = "number" if all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool) and t != "date") for v, t in ends) else "date"
            a, b = _range_end(ends[0][0], rt, f"the {axis.upper()} start"), _range_end(ends[1][0], rt, f"the {axis.upper()} end")
            if a is not None and b is not None and ((a > b) if rt == "number" else (_date_ms(a, "the start") > _date_ms(b, "the end"))):
                raise E.ContourError(f"the start of the {axis.upper()} range is after its end")
        value[axis] = {"start": a, "end": b}
        types[axis] = rt
    return {"value": value, "type": "xy_range", "element_types": types}


# ------------------------------------------------------------------------------------------------
# selector parameters
# ------------------------------------------------------------------------------------------------


def selection(c: dict) -> list[Any]:
    """A selector card's selection as a list: `value` is one value, or a list of them when `multiple`."""
    v = c.get("value")
    items = v if isinstance(v, list) else [v]
    items = [x for x in items if x is not None and not (isinstance(x, str) and x == "")]
    for x in items:
        if isinstance(x, bool) or not isinstance(x, (str, int, float)):
            raise E.ContourError("the selection is a value or a list of values")
    if len(items) > 1 and not c.get("multiple"):
        raise E.ContourError("choose one value (this selector is not a multiselect)")
    if len(items) > MAX_OPTIONS:
        raise E.ContourError(f"at most {MAX_OPTIONS:,} values can be selected")
    return items


def _unique(vals: list[Any]) -> list[Any]:
    seen: set[str] = set()
    out = []
    for v in vals:
        k = _text(v)
        if v is not None and k != "" and k not in seen:  # an empty string is "nothing selected", not an option
            seen.add(k)
            out.append(v)
    return out


def _pick(options: list[Any], items: list[Any], what: str) -> list[Any]:
    """The options the selection names (compared as text: 3 is "3"); a value that is not an option is refused."""
    by_text = {_text(o): o for o in options}
    out = []
    for x in items:
        if _text(x) not in by_text:
            raise E.ContourError(f"{_text(x)!r} is not one of {what}")
        out.append(by_text[_text(x)])
    return out


def _distinct(comp: E.Compiler, rel: str, col: str) -> list[Any]:
    sel = f"SELECT DISTINCT {E.q(col)} AS v FROM {rel} WHERE {E.q(col)} IS NOT NULL"
    vals = [r["v"] for r in E.rows_of(comp.run(f"SELECT * FROM ({sel} ORDER BY v) LIMIT {MAX_ARRAY}"))]
    if any(isinstance(v, list) for v in vals):
        # an array column (an array property): its distinct elements are the options
        els = {(type(x).__name__, x): x for v in vals for x in (v if isinstance(v, list) else [v]) if x is not None and not isinstance(x, (list, dict))}
        vals = sorted(els.values(), key=lambda x: (not isinstance(x, (int, float)), x if isinstance(x, (int, float)) else str(x)))[:MAX_ARRAY]
    return vals


def _selected(c: dict, options: list[Any], what: str, element_type: str, extra: Optional[dict] = None) -> dict:
    chosen = _pick(options, selection(c), what)
    out: dict[str, Any] = {"options": options[:MAX_OPTIONS], "options_total": len(options), **(extra or {})}
    if c.get("multiple"):
        out.update(value=chosen, type="array", element_type=element_type, count=len(chosen))
    else:
        out.update(value=chosen[0] if chosen else None, type=element_type)
    return out


def string_selector(comp: E.Compiler, cards: dict[str, dict], c: dict, value_of: ValueOf) -> dict:
    """One (or several) of a list of strings: typed options, the distinct values of a column of an object set / table
    card, or an array card's values."""
    src = (c.get("source") or {}).get("card")
    extra: dict[str, Any] = {}
    if not src:
        options = _unique([str(x) for x in c.get("options") or [] if x is not None and str(x) != ""])
        if not options:
            raise E.ContourError("add the options, or choose the card to take them from")
        what = "the options"
    elif src not in cards:
        raise E.ContourError("__missing__")
    elif cards[src].get("kind") in ARRAY_KINDS:
        r = value_of(src)
        if r.get("error"):
            raise E.ContourError(f"${src}: {r['error']}")
        if r.get("type") != "array":
            raise E.ContourError(f"${src} is not an array")
        options = _unique([_text(v) for v in r.get("value") or [] if v is not None])
        what = f"the values of ${src}"
    else:
        src, rel = _input_rel(comp, cards, c, what="an object set, a transform table or an array card")
        types = _schema(comp, rel)
        col = c.get("column") or ""
        if not col:
            raise E.ContourError("choose the column")
        if col not in types:
            raise E.ContourError(f"${src} has no column {col}")
        options = _unique([_text(v) for v in _distinct(comp, rel, col)])
        what = f"the values of {col} in ${src}"
        extra = {"input_columns": list(types), "column_types": types}
    return _selected(c, options, what, "string", extra)


def property_select(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """One (or several) of the values of an object set property, with the property's type."""
    src, rel = _input_rel(comp, cards, c, OBJECT_INPUT_KINDS, "an object set")
    types = _schema(comp, rel)
    prop = c.get("property") or ""
    if not prop:
        raise E.ContourError("choose the property")
    if prop not in types:
        raise E.ContourError(f"${src} has no property {prop}")
    return _selected(c, _unique(_distinct(comp, rel, prop)), f"the values of {prop} in ${src}", types[prop], {"input_columns": list(types), "column_types": types})


def _title_column(cards: dict[str, dict], cid: str) -> Optional[str]:
    """The title property of the object type the card's objects come from."""
    try:
        import ontology
        import quiver_tables

        root = quiver_tables._root_object_set(cards, cid)
        if not root:
            return None
        with ontology._lock:
            return ontology._object_type(root["object_type_id"]).get("title_property")
    except Exception:  # noqa: BLE001 — a label only: the primary key is shown instead
        return None


def object_selector(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """One object (or several) of an object set card by primary key. The card is an object set itself — its path in the
    table engine holds the selected objects — and its value is the primary key (an array when multiple)."""
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    if "primary_key" not in types:
        raise E.ContourError(f"${src} has no primary_key column: an object selector reads an object set (or a table that keeps the primary_key)")
    label = c.get("label") or ""
    if label and label not in types:
        raise E.ContourError(f"${src} has no column {label}")
    if not label:
        label = _title_column(cards, c["id"]) or "primary_key"
        label = label if label in types else "primary_key"
    pk = 'CAST("primary_key" AS VARCHAR)'
    opts = E.rows_of(comp.run(f"SELECT * FROM (SELECT {pk} AS k, CAST({E.q(label)} AS VARCHAR) AS l FROM {rel} ORDER BY 2, 1) LIMIT {MAX_OPTIONS}"))
    items = [_text(x) for x in selection(c)]
    names: dict[str, Any] = {}
    if items:
        got = E.rows_of(comp.run(f"SELECT {pk} AS k, CAST({E.q(label)} AS VARCHAR) AS l FROM {rel} WHERE {pk} IN ({', '.join(E.lit(x) for x in items)})"))
        names = {r["k"]: r["l"] for r in got}
        for x in items:
            if x not in names:
                raise E.ContourError(f"{x!r} is not an object of ${src}")
    own = comp.path_rel(c["id"], None)
    shown = comp.run(f"SELECT * FROM {own}", 50)
    out: dict[str, Any] = {"options": [{"value": r["k"], "label": r["l"] if r["l"] not in (None, "") else r["k"]} for r in opts], "options_total": comp.count(rel),
                           "objects": [{"primary_key": x, "label": names[x] if names[x] not in (None, "") else x} for x in items], "label_column": label,
                           "columns": list(shown.schema.names), "rows": E.rows_of(shown), "total": len(items),
                           "input_columns": list(types), "column_types": types}
    if c.get("multiple"):
        out.update(value=items, type="array", element_type="string", count=len(items))
    else:
        out.update(value=items[0] if items else None, type="string")
    return out


def row_selector(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """One row of a transform table (or an object set): by the value of a key column (the first row holding it) or by
    its row index, 0 first. The value is the row ({column: cell}); "$ID.column" reads one cell."""
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    key = c.get("key") or ""
    if key and key not in types:
        raise E.ContourError(f"${src} has no column {key}")
    label = c.get("label") or key
    if label and label not in types:
        raise E.ContourError(f"${src} has no column {label}")
    total = comp.count(rel)
    first = E.rows_of(comp.run(f"SELECT * FROM {rel}", MAX_OPTIONS))
    out: dict[str, Any] = {"type": "row", "columns": list(types), "column_types": types, "input_columns": list(types), "options_total": total, "key": key or None,
                           "options": [{"value": r[key] if key else i, "label": _text(r[label]) if label and not isinstance(r[label], (list, dict)) else f"row {i}"}
                                       for i, r in enumerate(first) if not key or r[key] is not None]}
    items = selection({**c, "multiple": False})
    if not items:
        return {**out, "value": None}
    v = items[0]
    if key:
        n = _num(v)
        cond = f"{E.q(key)} = {E.lit(n)}" if types[key] == "number" and n is not None else f"CAST({E.q(key)} AS VARCHAR) = {E.lit(_text(v))}"
        got = E.rows_of(comp.run(f"SELECT * FROM {rel} WHERE {cond}", 1))
        if not got:
            raise E.ContourError(f"no row of ${src} has {key} = {_text(v)!r}")
        return {**out, "value": got[0]}
    n = _num(v)
    if n is None or not float(n).is_integer() or n < 0:
        raise E.ContourError("the row index is a whole number, 0 for the first row (or choose a key column)")
    if n >= total:
        raise E.ContourError(f"row {int(n)} is outside ${src}: it has {total:,} row{'s' if total != 1 else ''} (the first is 0)")
    return {**out, "value": E.rows_of(comp.run(f"SELECT * FROM {rel} LIMIT 1 OFFSET {int(n)}"))[0], "row_index": int(n)}


# ------------------------------------------------------------------------------------------------
# dates from strings and numbers; period to date
# ------------------------------------------------------------------------------------------------

# Day.js parse tokens ("DD/MM/YYYY HH:mm"); [text] is literal
_PARSE_TOKENS = re.compile(r"\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z")
_PARSE_RX = {
    "YYYY": r"(?P<Y>\d{4})", "YY": r"(?P<y>\d{2})", "MMMM": r"(?P<Bl>[A-Za-z]+)", "MMM": r"(?P<Bs>[A-Za-z]{3})", "MM": r"(?P<M>\d{2})", "M": r"(?P<M>\d{1,2})",
    "DDDD": r"(?P<j>\d{1,3})", "DD": r"(?P<D>\d{2})", "D": r"(?P<D>\d{1,2})", "dddd": r"[A-Za-z]+", "ddd": r"[A-Za-z]{3}",
    "HH": r"(?P<H>\d{2})", "H": r"(?P<H>\d{1,2})", "hh": r"(?P<h>\d{2})", "h": r"(?P<h>\d{1,2})", "mm": r"(?P<m>\d{2})", "m": r"(?P<m>\d{1,2})",
    "ss": r"(?P<s>\d{2})", "s": r"(?P<s>\d{1,2})", "SSS": r"(?P<f>\d{3})", "A": r"(?P<p>[AaPp][Mm])", "a": r"(?P<p>[AaPp][Mm])",
    "ZZ": r"(?P<z>Z|[+-]\d{2}:?\d{2})", "Z": r"(?P<z>Z|[+-]\d{2}:?\d{2})",
}


def _zone(name: Any):
    from datetime import timedelta

    n = str(name or "UTC").strip()
    if n.upper() in ("UTC", "Z", "GMT"):
        return timezone.utc
    m = re.fullmatch(r"([+-])(\d{2}):?(\d{2})", n)
    if m:
        return timezone((1 if m.group(1) == "+" else -1) * timedelta(hours=int(m.group(2)), minutes=int(m.group(3))))
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(n)
    except Exception:  # noqa: BLE001 — an unknown name, or no time zone data on this machine
        raise E.ContourError(f"unknown time zone {n!r} (UTC, an offset such as +07:00, or a name such as Asia/Jakarta)") from None


def parse_date(s: str, fmt: str, tz: Any = timezone.utc) -> int:
    """A date string → epoch ms. With a Day.js format the whole string must match it; without one the string is ISO
    (2023-07-18, 2023-07-18T09:30:00Z) or American MM/DD/YYYY (optionally HH:mm or HH:mm:ss). A string without a zone
    is read in `tz`."""
    from datetime import timedelta

    s = s.strip()
    if not fmt.strip():
        if ISO_DATE.fullmatch(s):
            try:
                d = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                raise E.ContourError(f"{s!r} is not a date") from None
            return int((d if d.tzinfo else d.replace(tzinfo=tz)).timestamp() * 1000)
        if not re.fullmatch(r"\d{1,2}/\d{1,2}/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?", s):
            raise E.ContourError(f"{s!r} is not a date (ISO or MM/DD/YYYY; give the format of anything else)")
        fmt = "M/D/YYYY" + ("" if " " not in s else " H:mm:ss" if s.count(":") == 2 else " H:mm")
    if len(fmt) > 200:
        raise E.ContourError("the format is longer than 200 characters")
    pattern, last, used = "", 0, set()
    for m in _PARSE_TOKENS.finditer(fmt):
        pattern += re.escape(fmt[last:m.start()])
        t = m.group(0)
        if t.startswith("["):
            pattern += re.escape(t[1:-1])
        else:
            group = re.search(r"\?P<(\w+)>", _PARSE_RX[t])
            if group and group.group(1) in used:
                raise E.ContourError(f"the format {fmt!r} has {t} twice")
            used.update([group.group(1)] if group else [])
            pattern += _PARSE_RX[t]
        last = m.end()
    pattern += re.escape(fmt[last:])
    if not used:
        raise E.ContourError(f"the format {fmt!r} has no date tokens (YYYY, MM, DD, HH, mm …)")
    got = re.fullmatch(pattern, s)
    if not got:
        raise E.ContourError(f"{s!r} does not match the format {fmt}")
    g = {k: v for k, v in got.groupdict().items() if v is not None}
    year = int(g["Y"]) if "Y" in g else (int(g["y"]) + (1900 if int(g["y"]) > 68 else 2000)) if "y" in g else 1970
    month = int(g.get("M", 1))
    for k, names in (("Bl", _MONTHS), ("Bs", tuple(x[:3] for x in _MONTHS))):
        if k in g:
            low = [x.lower() for x in names]
            if g[k].lower() not in low:
                raise E.ContourError(f"{g[k]!r} is not a month name")
            month = low.index(g[k].lower()) + 1
    hour = int(g.get("H", g.get("h", 0)))
    if "h" in g and "H" not in g:
        if not 1 <= hour <= 12:
            raise E.ContourError(f"{s!r}: the hour {hour} is not on a 12-hour clock")
        hour = hour % 12 + (12 if g.get("p", "am").lower() == "pm" else 0)
    try:
        if "j" in g:
            d = datetime(year, 1, 1, hour, int(g.get("m", 0)), int(g.get("s", 0)), int(g.get("f", 0)) * 1000) + timedelta(days=int(g["j"]) - 1)
            if int(g["j"]) < 1 or d.year != year:
                raise ValueError
        else:
            d = datetime(year, month, int(g.get("D", 1)), hour, int(g.get("m", 0)), int(g.get("s", 0)), int(g.get("f", 0)) * 1000)
    except ValueError:
        raise E.ContourError(f"{s!r} is not a date that exists") from None
    if "z" in g:
        d = d.replace(tzinfo=_zone(g["z"]))
    return int((d if d.tzinfo else d.replace(tzinfo=tz)).timestamp() * 1000)


def date_convert(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    op = c.get("op") or "string_to_date"
    if op not in DATE_CONVERSIONS:
        raise E.ContourError(f"conversion is one of {', '.join(DATE_CONVERSIONS)}")
    if op == "number_to_date":
        unit = c.get("unit") or "milliseconds"
        if unit not in NUMBER_DATE_UNITS:
            raise E.ContourError(f"unit is one of {', '.join(NUMBER_DATE_UNITS)}")
        v = operand(c.get("input"), cards, params, value_of)
        if v is None:
            return {"value": None, "type": "date"}
        n = None if isinstance(v, (list, dict)) else _to_number(v)
        if n is None:
            raise E.ContourError(f"{_text(v)!r} is not a number")
        ms = n * NUMBER_DATE_UNITS[unit]
        if not -62_135_596_800_000 <= ms <= 253_402_300_799_999:
            raise E.ContourError(f"{_text(n)} {unit} since 1970 is outside the years 1 … 9999")
        return {"value": _iso_ms(int(ms)), "type": "date", "unit": unit}
    v, _ = text_operand(c.get("input"), cards, params, value_of)
    if v is None or (isinstance(v, str) and not v.strip()):
        return {"value": None, "type": "date"}
    return {"value": _iso_ms(parse_date(_text(v), str(c.get("format") or ""), _zone(c.get("timezone")))), "type": "date"}


def period_start(ms: int, period: str, week_start: str = "monday") -> int:
    """00:00 (UTC) on the first day of the day / week / month / year holding the time."""
    from datetime import timedelta

    d = datetime.fromtimestamp(ms / 1000, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "week":
        d -= timedelta(days=d.weekday() if week_start != "sunday" else (d.weekday() + 1) % 7)
    elif period == "month":
        d = d.replace(day=1)
    elif period == "year":
        d = d.replace(month=1, day=1)
    return int(d.timestamp() * 1000)


def period_to_date(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """"Day / Week / Month / Year to date": the range from the start of the input date's period to the input date."""
    period = c.get("period") or "month"
    if period not in PERIODS:
        raise E.ContourError(f"period is one of {', '.join(PERIODS)}")
    week_start = c.get("week_start") or "monday"
    if week_start not in ("monday", "sunday"):
        raise E.ContourError("the week starts on monday or sunday")
    spec = c.get("input")
    if spec is None or (isinstance(spec, str) and not spec.strip()):
        end = int(datetime.now(timezone.utc).timestamp() * 1000)
    else:
        v, _ = typed_operand(spec, cards, params, value_of)
        if v is None:
            return {"value": None, "type": "range", "element_type": "date"}
        end = _date_ms(v, "the date")
    return {"value": {"start": _iso_ms(period_start(end, period, week_start)), "end": _iso_ms(end)}, "type": "range", "element_type": "date", "period": period}


# ------------------------------------------------------------------------------------------------
# values from data: an object's property, the current user's attributes
# ------------------------------------------------------------------------------------------------


def object_property(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """A property of one object: the object of an object selector, or of an object set holding exactly one object."""
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    prop = c.get("property") or ""
    extra = {"input_columns": list(types), "column_types": types}
    if not prop:
        raise E.ContourError("choose the property")
    if prop not in types:
        raise E.ContourError(f"${src} has no property {prop}")
    n = comp.count(rel)
    if n > 1:
        raise E.ContourError(f"${src} holds {n:,} objects: an object property reads one object (add an object selector)")
    if n == 0:
        return {"value": None, "type": types[prop], "object": None, **extra}
    row = E.rows_of(comp.run(f"SELECT * FROM {rel}", 1))[0]
    return {"value": _clean(row[prop]), "type": types[prop], "object": row.get("primary_key"), **extra}


def multipass_attribute(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """An attribute of the user reading the card (auth.py: the request's principal), or — user ID, username and display
    name only — of the user whose ID is the input."""
    import auth

    attr = str(c.get("attribute") or "username")
    custom = attr[len("attribute:"):] if attr.startswith("attribute:") else None
    if custom is None and attr not in MULTIPASS_ATTRIBUTES:
        raise E.ContourError(f"attribute is one of {', '.join(MULTIPASS_ATTRIBUTES)}, or attribute:<name> for a custom attribute")
    spec = c.get("user")
    if not (spec is None or (isinstance(spec, str) and not spec.strip())):
        uid, _ = text_operand(spec, cards, params, value_of)
        if uid is None:
            return {"value": None, "type": "string"}
        if attr not in ("id", "username", "display_name"):
            raise E.ContourError("of another user only the user ID, the username and the display name can be read")
        label = auth.user_label(_text(uid).strip())
        if not label or label.get("status") == "deleted":
            raise E.ContourError(f"no user with the ID {_text(uid).strip()!r}")
        return {"value": label.get(attr), "type": "string"}
    p = auth.current()
    if p is None or p.get("service"):
        if auth.enabled():
            raise E.ContourError("no signed-in user reads this card (it runs for the system)")
        p = {"id": "local", "username": "local", "role": "admin"}
    me = auth._me(p)
    if attr == "groups":
        names = [g["name"] for g in me.get("groups") or []]
        return {"value": names, "type": "array", "element_type": "string", "count": len(names)}
    v = (me.get("attributes") or {}).get(custom) if custom is not None else me.get(attr)
    if isinstance(v, list):
        return {"value": [_text(x) for x in v], "type": "array", "element_type": "string", "count": len(v)}
    return {"value": None if v is None else _text(v) if not isinstance(v, dict) else str(v), "type": "string"}


# ------------------------------------------------------------------------------------------------
# charts
# ------------------------------------------------------------------------------------------------


def _ranks(x: list[float]) -> list[float]:
    """Ranks 1…n, ties get their average rank."""
    order = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def _pearson(x: list[float], y: list[float]) -> Optional[float]:
    n = len(x)
    if n < 2:
        return None
    mx, my = math.fsum(x) / n, math.fsum(y) / n
    sxy = math.fsum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = math.fsum((a - mx) ** 2 for a in x)
    syy = math.fsum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return None
    return max(-1.0, min(1.0, sxy / math.sqrt(sxx * syy)))


def correlation(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """Pearson or Spearman correlation of every pair of numeric columns, over the rows where both have a value."""
    src, rel = _input_rel(comp, cards, c)
    types = _schema(comp, rel)
    numeric = [k for k, v in types.items() if v == "number"]
    cols = [x for x in (c.get("columns") or []) if x in numeric] or numeric
    method = c.get("method") or "pearson"
    if method not in ("pearson", "spearman"):
        raise E.ContourError("method is pearson or spearman")
    if len(cols) < 2:
        raise E.ContourError(f"${src} needs two numeric columns for a correlation matrix")
    if len(cols) > MAX_CORR_COLUMNS:
        raise E.ContourError(f"{len(cols)} columns — choose at most {MAX_CORR_COLUMNS}")
    rows = comp.run(f"SELECT {', '.join(f'TRY_CAST({E.q(x)} AS DOUBLE) AS {E.q(x)}' for x in cols)} FROM {rel}")
    data = {x: rows.column(x).to_pylist() for x in cols}
    out = []
    for a in cols:
        for b in cols:
            pairs = [(u, v) for u, v in zip(data[a], data[b]) if u is not None and v is not None and math.isfinite(u) and math.isfinite(v)]
            xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
            if method == "spearman":
                xs, ys = _ranks(xs), _ranks(ys)
            r = 1.0 if a == b and len(pairs) >= 2 and len(set(xs)) > 1 else _pearson(xs, ys)
            out.append({"x": a, "y": b, "value": None if r is None else round(r, 6), "n": len(pairs)})
    return {"data": out, "data_columns": ["x", "y", "value", "n"], "columns": cols, "method": method,
            "input_columns": list(types), "column_types": types}


def waterfall(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    """Buckets as floating bars, each starting where the previous ended; an optional total bar."""
    buckets: list[tuple[str, float]] = []
    types: dict[str, str] = {}
    if c.get("steps") is not None and not (c.get("source") or {}).get("card"):
        for i, s in enumerate(c.get("steps") or []):
            v = _num(operand(s.get("input"), cards, params, value_of))
            buckets.append((str(s.get("label") or s.get("input") or f"step {i + 1}"), v or 0.0))
    else:
        src, rel = _input_rel(comp, cards, c)
        types = _schema(comp, rel)
        g = c.get("group_by") or ""
        if not g:
            raise E.ContourError("choose the column to group by")
        if g not in types:
            raise E.ContourError(f"${src} has no column {g}")
        metric = c.get("metric") or "count"
        if metric not in WATERFALL_METRICS:
            raise E.ContourError(f"metric is one of {', '.join(WATERFALL_METRICS)}")
        m = c.get("measure") or ""
        if metric != "count":
            if not m:
                raise E.ContourError(f"{metric} needs a measure column")
            if m not in types:
                raise E.ContourError(f"${src} has no column {m}")
            if metric != "unique_count" and types[m] != "number":
                raise E.ContourError(f"{m} is not numeric")
        agg = {"count": "COUNT(*)", "unique_count": f"COUNT(DISTINCT {E.q(m)})", "avg": f"AVG({E.q(m)})"}.get(metric) or f"{metric.upper()}({E.q(m)})"
        order = {"key": "1 ASC NULLS LAST", "value_asc": "2 ASC NULLS LAST"}.get(c.get("sort") or "", "2 DESC NULLS LAST")
        limit = max(1, min(int(c.get("limit") or 20), MAX_WATERFALL))
        rows = E.rows_of(comp.run(f"SELECT CAST({E.q(g)} AS VARCHAR) AS k, {agg} AS v FROM {rel} GROUP BY 1 ORDER BY {order}, 1 LIMIT {limit}"))
        buckets = [(r["k"] if r["k"] is not None else "(empty)", float(r["v"] or 0)) for r in rows]
    data, run = [], 0.0
    for k, v in buckets:
        data.append({"key": k, "value": v, "start": run, "end": run + v, "total": False})
        run += v
    if c.get("total", True):
        data.append({"key": c.get("total_label") or "Total", "value": run, "start": 0.0, "end": run, "total": True})
    return {"data": data, "data_columns": ["key", "value", "start", "end", "total"], "input_columns": list(types), "column_types": types}


# ------------------------------------------------------------------------------------------------
# time series cards: a value, an array or a small chart from a time series card of the analysis' logic
# ------------------------------------------------------------------------------------------------

SeriesRange = tuple[Optional[int], Optional[int]]


def _analysis(comp: E.Compiler) -> dict:
    a = getattr(comp, "analysis", None)
    if not isinstance(a, dict):
        raise E.ContourError("time series cards are read in a Quiver analysis")
    return a


def _series_id(comp: E.Compiler, cards: dict[str, dict], c: dict, key: str = "source", what: str = "the time series") -> str:
    cid = str((c.get(key) or {}).get("card") or "")
    if not cid:
        raise E.ContourError(f"choose {what}")
    if not any(x.get("id") == cid for x in (_analysis(comp).get("logic") or {}).get("cards") or []):
        raise E.ContourError(f"${cid} is not a time series card" if cid in cards else f"no time series card ${cid}")
    return cid


def series_range(comp: E.Compiler, c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> SeriesRange:
    """The card's range as (start ms, end ms), None for an open side: the analysis' range (default), "full", a fixed
    {start, end} or relative {last} range, or "$ID" — a range card or a date / time range parameter."""
    import quiver_series

    spec = c.get("range")
    if isinstance(spec, str) and spec.strip().startswith("$"):
        r, rt = range_operand(spec, cards, params, value_of)
        if rt != "date":
            raise E.ContourError(f"{spec.strip()} is a {'numeric range' if rt == 'number' else 'range of strings'}: a time series is read over a date / time range")
        return (None if r["start"] is None else _date_ms(r["start"], "the range's start"),
                None if r["end"] is None else _date_ms(r["end"], "the range's end"))
    return quiver_series.resolve_range(_analysis(comp), spec)


def read_series(comp: E.Compiler, cid: str, rng: SeriesRange) -> Any:
    """A time series card of the logic for the analysis' root object, clipped to the range (ts_engine.Series). One read
    per (card, range) and run, with the reader's permissions, metered against the analysis."""
    import timeseries
    import ts_engine as TE
    import ts_ontology

    a = _analysis(comp)
    cache = comp.__dict__.setdefault("series_cache", {})
    key = (cid, rng)
    if key not in cache:
        try:
            s, scanned = TE.evaluate_series(a.get("logic") or {}, ts_ontology.Resolver(), a.get("root"), rng[0], rng[1], card=cid)
        except TE.EngineError as e:
            raise E.ContourError(str(e)) from None
        cache[key] = s
        if a.get("id"):
            timeseries.record_usage(f"quiver:{a['id']}", scanned, queries=1)
    return cache[key]


def _numbers(s: Any) -> tuple[list[int], list[float]]:
    pairs = [(t, float(v)) for t, v in zip(s.t, s.v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    return [p[0] for p in pairs], [p[1] for p in pairs]


def _not_enum(cid: str, s: Any, what: str) -> None:
    if s.categorical:
        raise E.ContourError(f"${cid} is an enum (string) time series: {what}")


def time_weighted(ts: list[int], vs: list[float], t0: Optional[int], t1: Optional[int], method: str = "linear",
                  bounds: str = "none") -> tuple[Optional[float], int, Optional[float]]:
    """The area under a series' curve between t0 and t1 (value × milliseconds), the time it covers and the first
    value. `ts` / `vs` are the whole series (sorted): the points inside [t0, t1] are joined by the integration method —
    linear (trapezoids), lhs (each point's value held until the next) or rhs (each point's value held back to the
    previous). bounds extends the curve to t0 / t1 when no point is on them: linear (between the points on either
    side), nearest, previous or next point; "none" leaves the gaps at the ends out. No point: (None, 0, None)."""
    import bisect

    lo = bisect.bisect_left(ts, t0) if t0 is not None else 0
    hi = bisect.bisect_right(ts, t1) if t1 is not None else len(ts)
    pts = list(zip(ts[lo:hi], vs[lo:hi]))

    def edge(b: int) -> Optional[float]:
        i = bisect.bisect_left(ts, b)
        if i < len(ts) and ts[i] == b:
            return None  # a point is on the boundary
        prev = (ts[i - 1], vs[i - 1]) if i > 0 else None
        nxt = (ts[i], vs[i]) if i < len(ts) else None
        if bounds == "linear":
            return None if not prev or not nxt else prev[1] + (nxt[1] - prev[1]) * (b - prev[0]) / (nxt[0] - prev[0])
        if bounds == "previous":
            return prev[1] if prev else None
        if bounds == "next":
            return nxt[1] if nxt else None
        if prev and nxt:
            return prev[1] if b - prev[0] <= nxt[0] - b else nxt[1]
        return prev[1] if prev else nxt[1] if nxt else None

    if bounds != "none":
        if t0 is not None:
            v = edge(t0)
            if v is not None:
                pts.insert(0, (t0, v))
        if t1 is not None and (t0 is None or t1 > t0):
            v = edge(t1)
            if v is not None:
                pts.append((t1, v))
    if not pts:
        return None, 0, None
    parts = []
    for (ta, va), (tb, vb) in zip(pts, pts[1:]):
        parts.append(((va + vb) / 2 if method == "linear" else va if method == "lhs" else vb) * (tb - ta))
    return math.fsum(parts), pts[-1][0] - pts[0][0], pts[0][1]


def series_agg(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    """One number from a numeric time series over a range. The standard deviation is the population's (as the time
    series columns and the logic's aggregate card). Time-weighted average: the area under the curve divided by the time
    the area covers; integral: the area, per time_unit."""
    import ts_engine as TE

    how = str(c.get("aggregation") or "mean")
    if how not in SERIES_AGGREGATIONS:
        raise E.ContourError(f"unknown aggregation {how} ({', '.join(SERIES_AGGREGATIONS)})")
    cid = _series_id(comp, cards, c)
    rng = series_range(comp, c, cards, params, value_of)
    method = str(c.get("method") or "linear").lower()
    bounds = str(c.get("bounds") or "none").lower()
    unit = str(c.get("time_unit") or "s")
    if how in WEIGHTED_AGGREGATIONS:
        if method not in INTEGRATION_METHODS:
            raise E.ContourError(f"the integration method is one of {', '.join(INTEGRATION_METHODS)}")
        if bounds not in BOUNDS_INTERPOLATIONS:
            raise E.ContourError(f"the bounds interpolation is one of {', '.join(BOUNDS_INTERPOLATIONS)}")
        if unit not in TIME_UNITS:
            raise E.ContourError(f"the time unit is one of {', '.join(TIME_UNITS)}")
    s = read_series(comp, cid, rng)
    if how != "count":
        _not_enum(cid, s, "only count applies (Enum value at time and Latest value for enum time series read its values)")
    out: dict[str, Any] = {"type": "number", "points": len(s), "label": s.label, "range": [TE.iso(rng[0]), TE.iso(rng[1])]}
    value_unit = s.unit if how not in ("count", "product", "relative_difference") else None
    if how in WEIGHTED_AGGREGATIONS:
        # the points outside the range are read only when the curve is extended to the range's ends
        whole = s if bounds == "none" or rng == (None, None) else read_series(comp, cid, (None, None))
        area, span, first = time_weighted(*_numbers(whole), rng[0], rng[1], method, bounds)
        if area is None:
            value: Any = None
        elif how == "integral":
            value = area / TIME_UNITS[unit]
            value_unit = f"{s.unit}·{unit}" if s.unit else None
        else:
            value = area / span if span else first
        out.update(covered_ms=span, method=method, bounds=bounds)
    elif how == "count":
        value = len(s)
    else:
        nums = _numbers(s)[1]
        if how in ("std", "range"):
            value = None if not nums else max(nums) - min(nums) if how == "range" else math.sqrt(math.fsum((x - math.fsum(nums) / len(nums)) ** 2 for x in nums) / len(nums))
        else:
            value = aggregate_values(nums, how, c.get("percentile"))
    return {**out, "value": _clean(value), "value_unit": value_unit}


def _backing_object(comp: E.Compiler, cid: str) -> dict:
    """The object a time series card reads: the tsp card's object (or the analysis' root object), or — a linked sensor
    ("sensor:<name>") — the sensor object."""
    import ontology
    import ts_engine as TE
    import ts_ontology

    a = _analysis(comp)
    sources = [x for x in TE.upstream(a.get("logic") or {}, cid) if x.get("type") in ("tsp", "derived", "linked_agg", "function")]
    if not sources:
        raise E.ContourError(f"${cid} is not read from an object's time series (a series by its ID has no backing object)")
    resolver = ts_ontology.Resolver()
    found: dict[tuple[str, str], dict] = {}
    try:
        for x in sources:
            cfg = x.get("config") or {}
            o = cfg.get("object")
            ref = o if isinstance(o, dict) and o.get("object_type_id") and o.get("primary_key") not in (None, "") else a.get("root")
            if not ref or ref.get("primary_key") in (None, ""):
                raise E.ContourError("pick the analysis' root object")
            ref = {"object_type_id": str(ref["object_type_id"]), "primary_key": str(ref["primary_key"])}
            prop = str(cfg.get("property") or "")
            if x.get("type") == "tsp" and prop.startswith("sensor:"):
                name = prop[len("sensor:"):].strip().lower()
                match = [s for s in resolver.sensors(ref) if s["name"].lower() == name]
                if not match:
                    raise E.ContourError(f"the object has no linked sensor named {prop[len('sensor:'):]}")
                ref = {"object_type_id": str(match[0]["object_type_id"]), "primary_key": str(match[0]["primary_key"])}
            found[(ref["object_type_id"], ref["primary_key"])] = ref
        if len(found) > 1:
            raise E.ContourError(f"${cid} reads the time series of {len(found)} objects: a backing object is the one object of a series")
        t, pk, props = resolver.obj(next(iter(found.values())))
    except TE.EngineError as e:
        raise E.ContourError(str(e)) from None
    with ontology._lock:
        o = ontology._objects(t["id"]).get(pk)
        if o is None or not ontology._can_see(t, o):
            raise E.ContourError(f'{t["display_name"]} "{pk}" not found')
    title = props.get(t.get("title_property")) if t.get("title_property") else None
    return {"value": pk, "type": "string", "object": pk, "object_type_id": t["id"], "object_type": t["display_name"],
            "label": pk if title in (None, "") else _text(title) if not isinstance(title, (list, dict)) else pk}


def series_op(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    from dataclasses import replace

    import ts_engine as TE

    op = str(c.get("op") or "value_at")
    if op not in SERIES_OPS:
        raise E.ContourError(f"operation is one of {', '.join(SERIES_OPS)}")
    cid = _series_id(comp, cards, c)
    if op == "backing_object":
        return _backing_object(comp, cid)
    if op in ("value_at", "enum_value_at"):
        enum = op == "enum_value_at"
        spec = c.get("at")
        if spec is None or (isinstance(spec, str) and not spec.strip()):
            raise E.ContourError("choose the time")
        at, _ = typed_operand(spec, cards, params, value_of)
        interp = str(c.get("interpolation") or "").upper()
        ext = str(c.get("external") or "").upper()
        if interp and interp not in TE.INTERPOLATIONS:
            raise E.ContourError(f"interpolation is one of {', '.join(TE.INTERPOLATIONS)} (empty: the series' own)")
        if ext and ext not in TE.EXTERNAL:
            raise E.ContourError(f"the interpolation before / after the series is one of {', '.join(TE.EXTERNAL)} (empty: the series' own)")
        # the points around the time, whatever the analysis' range
        s = read_series(comp, cid, (None, None))
        if enum and not s.categorical and len(s):
            raise E.ContourError(f"${cid} is a numeric time series: Value at time reads it")
        if not enum:
            _not_enum(cid, s, "Enum value at time reads it")
        if interp == "LINEAR" and s.categorical:
            raise E.ContourError("linear interpolation applies to numeric series only")
        if interp or ext:
            s = replace(s, interpolation=interp or s.interpolation, external=ext or s.external)
        out: dict[str, Any] = {"type": "string" if enum else "number", "value_unit": None if enum else s.unit, "label": s.label,
                               "interpolation": s.interpolation, "external": s.external}
        if at is None:
            return {**out, "value": None}
        ms = _date_ms(at, "the time")
        return {**out, "value": _clean(TE.value_at(s, ms)), "at": _iso_ms(ms), "exact": ms in s.t}
    rng = series_range(comp, c, cards, params, value_of)
    s = read_series(comp, cid, rng)
    extra = {"label": s.label, "points": len(s), "range": [TE.iso(rng[0]), TE.iso(rng[1])]}
    if op == "unit":
        return {"value": s.unit or None, "type": "string", **extra}
    if op == "latest_enum":
        if not s.categorical and len(s):
            raise E.ContourError(f"${cid} is a numeric time series: Time series numeric aggregation (last) reads its latest value")
        return {"value": s.v[-1] if s.v else None, "type": "string", "at": _iso_ms(s.t[-1]) if s.t else None, **extra}
    if not s.t:
        return {"value": None, "type": "date", **extra}
    return {"value": _iso_ms(s.t[0] if op == "start" else s.t[-1]), "type": "date", **extra}


def _equation(coefs: list[float], fit: str) -> str:
    if fit == "exponential":
        return f"y = {coefs[0]:.6g}·e^({coefs[1]:.6g}·x)"
    out = f"{coefs[0]:.6g}"
    for i, k in enumerate(coefs[1:], 1):
        out += f" {'−' if k < 0 else '+'} {abs(k):.6g}·x" + (f"^{i}" if i > 1 else "")
    return "y = " + out


def predict(coefs: list[float], fit: str, x: float) -> Optional[float]:
    try:
        y = coefs[0] * math.exp(coefs[1] * x) if fit == "exponential" else math.fsum(k * x ** i for i, k in enumerate(coefs))
    except OverflowError:
        return None
    return y if math.isfinite(y) else None


def fit_curve(xs: list[Any], ys: list[Any], fit: Any, degree: Any = None) -> dict:
    """The least-squares best fit of y on x: linear (y = c0 + c1·x), polynomial of a degree 0 … 13 (y = c0 + c1·x + …
    + cn·x^n) or exponential (y = a·e^(b·x), fitted on ln y: every y above 0). Coefficients lowest power first
    ([a, b] for the exponential); r_squared on y itself (None when y is constant)."""
    import warnings

    import numpy as np

    fit = str(fit or "linear")
    if fit not in FITS:
        raise E.ContourError(f"the fit is one of {', '.join(FITS)}")
    deg = 1
    if fit == "polynomial":
        n = _num(2 if degree in (None, "") else degree)
        if n is None or not float(n).is_integer() or not 0 <= n <= MAX_DEGREE:
            raise E.ContourError(f"the degree is a whole number between 0 and {MAX_DEGREE}")
        deg = int(n)
    pairs = [(float(x), float(y)) for x, y in zip(xs, ys)
             if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool) and math.isfinite(x) and math.isfinite(y)]
    distinct = len({p[0] for p in pairs})
    if distinct < deg + 1:
        name = f"polynomial fit of degree {deg}" if fit == "polynomial" else f"{fit} fit"
        raise E.ContourError(f"a {name} needs at least {deg + 1} point{'s' if deg else ''} with different x values ({distinct} here)")
    x = np.array([p[0] for p in pairs], dtype=float)
    y = np.array([p[1] for p in pairs], dtype=float)
    if fit == "exponential" and bool((y <= 0).any()):
        raise E.ContourError("an exponential fit needs values above 0")
    target = np.log(y) if fit == "exponential" else y
    if deg == 0:
        coefs = [float(target.mean())]
    else:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            # fitted on x scaled to [-1, 1] (a high degree stays well conditioned), then as powers of x itself
            coefs = [float(k) for k in np.polynomial.Polynomial.fit(x, target, deg).convert().coef]
        coefs += [0.0] * (deg + 1 - len(coefs))
    if fit == "exponential":
        coefs = [math.exp(coefs[0]), coefs[1]]
        with np.errstate(over="ignore"):
            fitted = coefs[0] * np.exp(coefs[1] * x)
    else:
        fitted = np.polynomial.polynomial.polyval(x, coefs)
    if not all(math.isfinite(k) for k in coefs) or not bool(np.isfinite(fitted).all()):
        raise E.ContourError("the fit did not converge on these points")
    total = float(((y - y.mean()) ** 2).sum())
    r2 = None if total == 0 else 1 - float(((y - fitted) ** 2).sum()) / total
    return {"coefficients": coefs, "r_squared": r2, "n": len(pairs), "fit": fit, "degree": deg, "equation": _equation(coefs, fit)}


def _scatter_points(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> tuple[list[float], list[float], list[int], dict]:
    """A scatter plot's points: the two series joined on their timestamps by their interpolation (ts_engine.join), then
    one point per time bucket — the buckets split the time the joined points span evenly (1,000 by default) and each
    holds the bucket value (the average by default) of its x and of its y values."""
    import ts_engine as TE

    xid = _series_id(comp, cards, c, "x", "the X time series")
    yid = _series_id(comp, cards, c, "y", "the Y time series")
    rng = series_range(comp, c, cards, params, value_of)
    sx, sy = read_series(comp, xid, rng), read_series(comp, yid, rng)
    for cid, s in ((xid, sx), (yid, sy)):
        _not_enum(cid, s, "a scatter plot needs numeric series")
    buckets = max(1, min(int(c.get("buckets") or 1000), MAX_SCATTER))
    how = str(c.get("bucket_value") or "mean")
    if how not in BUCKET_VALUES:
        raise E.ContourError(f"the bucket value is one of {', '.join(BUCKET_VALUES)}")
    ts, cols = TE.join([sx, sy])
    info = {"x_label": sx.label or f"${xid}", "y_label": sy.label or f"${yid}", "x_unit": sx.unit, "y_unit": sy.unit, "joined": len(ts),
            "buckets": buckets, "bucket_value": how, "range": [TE.iso(rng[0]), TE.iso(rng[1])]}
    if not ts:
        return [], [], [], info
    lo, width = ts[0], (ts[-1] - ts[0]) / buckets
    groups: dict[int, tuple[list[float], list[float]]] = {}
    for t, a, b in zip(ts, cols[0], cols[1]):
        g = groups.setdefault(min(int((t - lo) / width), buckets - 1) if width else 0, ([], []))
        g[0].append(a)
        g[1].append(b)
    order = sorted(groups)
    return ([float(TE.aggregate(groups[i][0], how)) for i in order], [float(TE.aggregate(groups[i][1], how)) for i in order],
            [int(lo + i * width) for i in order], info)


def series_scatter(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    xs, ys, ts, info = _scatter_points(comp, cards, c, params, value_of)
    view = str(c.get("view") or "scatter")
    if view not in ("scatter", "heat_grid"):
        raise E.ContourError("the view is scatter or heat_grid")
    out: dict[str, Any] = {**info, "view": view, "points": len(xs),
                           "extent": {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)]} if xs else None}
    if view == "heat_grid":
        grid = max(2, min(int(c.get("grid") or 20), MAX_GRID))
        cells: dict[tuple[int, int], int] = {}
        if xs:
            (x0, x1), (y0, y1) = out["extent"]["x"], out["extent"]["y"]
            wx, wy = (x1 - x0) / grid, (y1 - y0) / grid
            for a, b in zip(xs, ys):
                k = (min(int((a - x0) / wx), grid - 1) if wx else 0, min(int((b - y0) / wy), grid - 1) if wy else 0)
                cells[k] = cells.get(k, 0) + 1
            out["data"] = [{"x0": x0 + i * wx, "x1": x0 + (i + 1) * wx, "y0": y0 + j * wy, "y1": y0 + (j + 1) * wy, "count": n} for (i, j), n in sorted(cells.items())]
        else:
            out["data"] = []
        out.update(grid=grid, data_columns=["x0", "x1", "y0", "y1", "count"])
    else:
        out.update(data=[{"t": _iso_ms(t), "x": a, "y": b} for t, a, b in zip(ts, xs, ys)], data_columns=["t", "x", "y"])
    if c.get("fit"):
        # the best-fit line ("Scatter plot regression"); a fit that cannot be made says why and the points stay
        try:
            f = fit_curve(xs, ys, c.get("fit"), c.get("degree"))
            x0, x1 = out["extent"]["x"]
            line = [(x, predict(f["coefficients"], f["fit"], x)) for x in (x0 + (x1 - x0) * i / 60 for i in range(61))]
            out["fit"] = {**f, "line": [[x, y] for x, y in line if y is not None]}
        except E.ContourError as e:
            out["fit"] = {"error": str(e)}
    return out


def regression(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    """The best-fit coefficients of a time series against time, or — the source a time series scatter plot card — of
    its points' y against x, as a number array."""
    src = str((c.get("source") or {}).get("card") or "")
    if not src:
        raise E.ContourError("choose the time series (or the time series scatter plot)")
    if (cards.get(src) or {}).get("kind") == "series_scatter":
        xs, ys, _ts, info = _scatter_points(comp, cards, cards[src], params, value_of)
        f = fit_curve(xs, ys, c.get("fit"), c.get("degree"))
        extra: dict[str, Any] = {"input": "scatter", "points": len(xs), "x_label": info["x_label"], "y_label": info["y_label"]}
    else:
        unit = str(c.get("x_unit") or "d")
        if unit not in TIME_UNITS:
            raise E.ContourError(f"the time unit of x is one of {', '.join(TIME_UNITS)}")
        cid = _series_id(comp, cards, c)
        s = read_series(comp, cid, series_range(comp, c, cards, params, value_of))
        _not_enum(cid, s, "a regression needs a numeric series")
        ts, vs = _numbers(s)
        # x: the time since the first point (no points: the fit says so)
        f = fit_curve([(t - ts[0]) / TIME_UNITS[unit] for t in ts], vs, c.get("fit"), c.get("degree"))
        extra = {"input": "series", "points": len(ts), "x_unit": unit, "origin": _iso_ms(ts[0]), "label": s.label}
    coefs = f.pop("coefficients")
    return {"value": coefs, "type": "array", "element_type": "number", "count": len(coefs), **f, **extra}


def series_distribution(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> dict:
    """How often a series takes its values over the range: equal-width bins between its smallest and largest value (the
    last bin includes the largest), or — an enum series — a count per value, the most frequent first."""
    import ts_engine as TE

    cid = _series_id(comp, cards, c)
    rng = series_range(comp, c, cards, params, value_of)
    s = read_series(comp, cid, rng)
    out: dict[str, Any] = {"label": s.label, "value_unit": s.unit, "points": len(s), "range": [TE.iso(rng[0]), TE.iso(rng[1])], "categorical": bool(s.categorical)}
    if s.categorical:
        counts: dict[str, int] = {}
        for v in s.v:
            counts[str(v)] = counts.get(str(v), 0) + 1
        rows = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return {**out, "data": [{"value": k, "count": n} for k, n in rows[:MAX_CATEGORIES_SHOWN]], "data_columns": ["value", "count"],
                "total": len(rows), "truncated": len(rows) > MAX_CATEGORIES_SHOWN}
    bins = max(1, min(int(c.get("bins") or 20), MAX_BINS))
    nums = _numbers(s)[1]
    out.update(bins=bins, data_columns=["start", "end", "count"])
    if not nums:
        return {**out, "data": []}
    lo, hi = min(nums), max(nums)
    if lo == hi:
        return {**out, "bins": 1, "data": [{"start": lo, "end": hi, "count": len(nums)}]}
    width = (hi - lo) / bins
    counts_n = [0] * bins
    for v in nums:
        counts_n[min(int((v - lo) / width), bins - 1)] += 1
    return {**out, "data": [{"start": lo + i * width, "end": lo + (i + 1) * width if i < bins - 1 else hi, "count": n} for i, n in enumerate(counts_n)]}


def shift_datetime(c: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> dict:
    """The date / time (empty: now) moved by a number of weeks, days, hours, minutes, seconds or milliseconds."""
    unit = str(c.get("unit") or "day")
    if unit not in DATE_UNITS:
        raise E.ContourError(f"unit is one of {', '.join(DATE_UNITS)}")
    spec = c.get("input")
    if spec is None or (isinstance(spec, str) and not spec.strip()):
        base: Optional[int] = int(datetime.now(timezone.utc).timestamp() * 1000)
    else:
        v, _ = typed_operand(spec, cards, params, value_of)
        base = None if v is None else _date_ms(v, "the date")
    amount = c.get("amount")
    n = _num(operand(0 if amount is None or (isinstance(amount, str) and not amount.strip()) else amount, cards, params, value_of))
    if n is None:
        raise E.ContourError("the amount to shift by is not a number")
    if base is None:
        return {"value": None, "type": "date"}
    ms = base + n * DATE_UNITS[unit]
    if not -62_135_596_800_000 <= ms <= 253_402_300_799_999:
        raise E.ContourError("the shifted date is outside the years 1 … 9999")
    return {"value": _iso_ms(int(round(ms))), "type": "date", "date": _iso_ms(base), "shift_unit": unit}


# ------------------------------------------------------------------------------------------------
# object set cards: filter object set, set math, switch to linked object set, status filter, object view
# ------------------------------------------------------------------------------------------------

def _object_source(cards: dict[str, dict], c: dict, key: str = "source") -> str:
    src = str((c.get(key) or {}).get("card") or "")
    if not src:
        raise E.ContourError("choose the object set to read from")
    if src not in cards:
        raise E.ContourError(f"__missing__{src}")
    if (cards[src].get("kind") or "object_set") not in OBJECT_INPUT_KINDS:
        raise E.ContourError(f"${src} is not an object set (an object set card, an object selector or another object set card)")
    return src


def _link(lt_id: str, direction: str) -> tuple[dict, dict, dict]:
    """(link type, the side it starts from, the side it reaches) of a link the viewer may use."""
    import ontology
    import ontology_model as om
    from fastapi import HTTPException

    if direction not in ("forward", "reverse"):
        raise E.ContourError("a link's direction is forward or reverse")
    try:
        with ontology._lock:
            lt = om._get("link-types", lt_id, "link type")
    except HTTPException:
        raise E.ContourError(f"no link type {lt_id}") from None
    if not om.discoverable(lt):
        raise E.ContourError(f"no link type {lt_id}")
    start, reach = om.side_of(lt, direction)
    return lt, start, reach


def _linked_map(lt: dict, direction: str, keys: set[str]) -> dict[str, list[str]]:
    import ontology
    import ontology_model as om

    with ontology._lock:
        return om.linked_map(lt, direction, keys)


def _link_spec(spec: Any) -> tuple[str, str]:
    """"<link type ID>:<forward|reverse>" (the direction defaults to forward)."""
    s = str(spec or "").strip()
    if not s:
        raise E.ContourError("choose the link")
    lt_id, _, direction = s.partition(":")
    return lt_id, direction or "forward"


def object_type_of(cards: dict[str, dict], cid: str, comp: Optional[E.Compiler] = None, seen: Optional[set[str]] = None) -> Optional[str]:
    """The object type of an object set card's objects (None when it cannot be told yet)."""
    import quiver_tables

    seen = set() if seen is None else seen
    if cid in seen:
        raise E.ContourError(f"${cid} reads its own objects")
    seen.add(cid)
    c = cards.get(cid)
    if c is None:
        raise E.ContourError(f"__missing__{cid}")
    kind = c.get("kind") or "object_set"
    if kind == "object_set":
        return c.get("object_type_id")
    if kind == "object_selector":
        root = quiver_tables._root_object_set(cards, cid)
        return root["object_type_id"] if root else None
    if kind in ("filter_object_set", "status_filter"):
        return object_type_of(cards, _object_source(cards, c), comp, seen)
    if kind == "set_math":
        ids = [str(x) for x in c.get("inputs") or [] if x]
        if not ids:
            raise E.ContourError("choose the object sets to combine")
        return object_type_of(cards, ids[0], comp, seen)
    if kind == "linked_object_set":
        lt_id, direction = _link_spec(c.get("link"))
        return _link(lt_id, direction)[2]["object_type_id"]
    if kind == "object_view":
        if (c.get("source") or {}).get("card"):
            return object_type_of(cards, _object_source(cards, c), comp, seen)
        if c.get("object_type_id"):
            return str(c["object_type_id"])
        # the primary key from a card that knows its object's type (a backing object from time series)
        m = ref_of(c.get("primary_key"), cards, {})
        if m and m[0] in cards and comp is not None and getattr(comp, "value_of", None):
            return comp.value_of(m[0]).get("object_type_id")
        return None
    if kind == "defined_by_property":
        if (c.get("source") or {}).get("card"):
            return object_type_of(cards, _object_source(cards, c), comp, seen)
        if not c.get("object_type_id"):
            raise E.ContourError("choose the object set (or the object type) whose objects the property picks")
        return str(c["object_type_id"])
    if kind == "saved_object_set":
        return saved_set(c.get("object_set"), comp)["object_type_id"]
    raise E.ContourError(f"${cid} is not an object set")


def saved_set(ref: Any, comp: Optional[E.Compiler] = None) -> dict:
    """A saved object set the viewer can see — an Object Explorer exploration (its search run now, with the viewer's
    permissions) or an object list — by RID (ri.object-set.main.exploration.<id> / .list.<id>) or ID: {kind, id, rid,
    name, description, owner, created_at, updated_at, object_type_id, keys}. Kept on the compiler for one run."""
    import ontology_explorer as ox
    import ontology_model as om
    from fastapi import HTTPException

    s = str(ref or "").strip()
    if not s:
        raise E.ContourError("choose the saved object set to import")
    memo = None if comp is None else comp.__dict__.setdefault("_saved_sets", {})
    if memo is not None and s in memo:
        return memo[s]
    kind, rid_id = None, s
    if s.startswith(SET_RID):
        kind, _, rid_id = s[len(SET_RID):].partition(".")
        if kind not in ("exploration", "list") or not rid_id:
            raise E.ContourError(f"{s} is not a saved object set identifier (ri.object-set.main.exploration.<id> or .list.<id>)")
    out: Optional[dict] = None
    try:
        if kind in (None, "exploration"):
            e = next((x for x in ox.list_explorations() if x["id"] == rid_id), None)
            if e:
                spec = dict(e.get("spec") or {})
                if spec.get("interface_id"):
                    raise E.ContourError(f"{e['name']}: an exploration of an interface holds objects of several types — import one of its object types")
                req = ox.SearchIn(**{**spec, "offset": 0, "limit": 1, "histograms": False, "aggregate": None, "resource": "quiver"})
                token = om.RESOURCE.set("quiver")
                try:
                    with ox._lock:
                        r = ox.run_search(req)
                    for k in r["kinds"]:
                        om.record_query(k, r["type_ids"][-1:] if k != "base" else r["type_ids"][:1], len(r["rows"]))
                finally:
                    om.RESOURCE.reset(token)
                out = {"kind": "exploration", "id": e["id"], "rid": f"{SET_RID}exploration.{e['id']}", "name": e.get("name"),
                       "description": e.get("description") or "", "owner": e.get("owner"), "created_at": e.get("created_at"),
                       "updated_at": e.get("updated_at") or e.get("created_at"), "object_type_id": r["type"]["id"],
                       "keys": [str(x["primary_key"]) for x in r["rows"]]}
        if out is None and kind in (None, "list"):
            if any(x["id"] == rid_id for x in ox.list_object_lists()):
                with ox._lock:
                    rec = ox._list_rec(rid_id)
                out = {"kind": "list", "id": rec["id"], "rid": f"{SET_RID}list.{rec['id']}", "name": rec.get("name"),
                       "description": rec.get("description") or "", "owner": rec.get("owner"), "created_at": rec.get("created_at"),
                       "updated_at": rec.get("updated_at") or rec.get("created_at"), "object_type_id": rec["object_type_id"],
                       "keys": [str(k) for k in rec.get("primary_keys") or []]}
    except HTTPException as ex:
        raise E.ContourError(str(ex.detail)) from None
    if out is None:
        raise E.ContourError(f"no saved object set {s} you can see (an Object Explorer exploration or an object list)")
    if memo is not None:
        memo[s] = out
    return out


def _keys(comp: E.Compiler, rel: str) -> list[str]:
    return [r["k"] for r in E.rows_of(comp.run(f'SELECT CAST("primary_key" AS VARCHAR) AS k FROM {rel}')) if r["k"] is not None]


def _params(comp: E.Compiler) -> dict:
    params = {k: v for k, v in (comp.params or {}).items() if not str(k).startswith("__")}
    params.update(getattr(comp, "range_params", None) or {})
    return params


def _value_of(comp: E.Compiler) -> ValueOf:
    fn = getattr(comp, "value_of", None)
    return fn if fn else (lambda ref: {"error": f"${ref} cannot be read here"})


def _ts_lit(ms: int) -> str:
    """A UTC timestamp literal (date columns read as TIMESTAMP, without a zone)."""
    return f"TIMESTAMP '{datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')}'"


_tmp_n = [0]


def _register(comp: E.Compiler, t: pa.Table) -> str:
    """A table the card's SQL reads (the linked objects a condition filters), registered on the compiler."""
    _tmp_n[0] += 1
    name = f"tmp_objects_{_tmp_n[0]}"
    comp.tables[name] = t
    return name


def _cond_values(cond: dict, cards: dict[str, dict], params: dict, value_of: ValueOf) -> list[Any]:
    """A condition's value(s): typed (a list, or "a, b" for in / between) or "$ID" — a card's value or a parameter (an
    array spreads)."""
    v = cond.get("value")
    if isinstance(v, str) and v.strip().startswith("$") and ref_of(v, cards, params):
        got = operand(v, cards, params, value_of)
        if isinstance(got, dict) and {"start", "end"} & set(got):
            return [got.get("start"), got.get("end")]  # a range: between its ends
        return list(got) if isinstance(got, list) else [got]
    if isinstance(v, list):
        return v
    if v is None or (isinstance(v, str) and not v.strip()):
        return []
    if cond.get("op") in ("in", "between") and isinstance(v, str):
        return [x.strip() for x in v.split(",")]
    return [v]


def _predicate(cond: dict, types: dict[str, str], cards: dict[str, dict], params: dict, value_of: ValueOf, what: str) -> str:
    """One property condition as SQL over an object table: =, ≠, contains, starts with, >, ≥, <, ≤, between, in, is
    empty, has a value, regex, wildcard (* and ?). Dates compare as dates, numbers as numbers, the rest as text."""
    prop, op = str(cond.get("property") or ""), str(cond.get("op") or "eq")
    if op not in OBJECT_FILTER_OPS or op in ("linked", "not_linked"):
        raise E.ContourError(f"the operator is one of {', '.join(x for x in OBJECT_FILTER_OPS if x not in ('linked', 'not_linked'))}")
    if not prop:
        return "TRUE"  # a condition still being set up does not filter
    if prop not in types:
        raise E.ContourError(f"{what} has no property {prop}")
    lists = getattr(types, "lists", None) or {}
    if prop in lists:
        # an array property: empty when it has no elements; any other condition holds when an element meets it (≠:
        # no element equals), elements compared in their own kind
        col = E.q(prop)
        if op == "is_null":
            return f"({col} IS NULL OR len({col}) = 0)"
        if op == "not_null":
            return f"({col} IS NOT NULL AND len({col}) > 0)"
        try:
            inner = _predicate({**cond, "property": "__el", "op": "eq" if op == "neq" else op}, {"__el": lists[prop]}, cards, params, value_of, what)
        except E.ContourError as e:
            raise E.ContourError(str(e).replace("__el", prop)) from None
        if inner == "TRUE":
            return "TRUE"
        anyof = f"(len(list_filter({col}, __el -> {inner.replace(E.q('__el'), '__el')})) > 0)"
        return f"(NOT {anyof} OR {col} IS NULL)" if op == "neq" else anyof
    col, kind = E.q(prop), types[prop]
    text = f"CAST({col} AS VARCHAR)"
    if op == "is_null":
        return f"({col} IS NULL OR {text} = '')"
    if op == "not_null":
        return f"({col} IS NOT NULL AND {text} <> '')"
    vals = [x for x in _cond_values(cond, cards, params, value_of) if x is not None and x != ""]
    if not vals:
        return "TRUE"  # an empty value (an unset parameter) does not filter

    def typed(v: Any) -> tuple[str, str]:
        # (column expression, literal) compared in the property's type
        if kind == "number":
            n = _num(v)
            if n is None:
                raise E.ContourError(f"{prop} is a number: {_text(v)!r} is not one")
            return f"TRY_CAST({col} AS DOUBLE)", repr(n)
        if kind == "date":
            return _date_col(types, prop), _ts_lit(_date_ms(v, prop))
        return (f"lower({text})", E.lit(_text(v).lower())) if kind == "boolean" else (text, E.lit(_text(v)))

    if op in ("eq", "neq", "in"):
        parts = [f"{a} = {b}" for a, b in (typed(v) for v in vals)]
        sql = "(" + " OR ".join(parts) + ")"
        return f"(NOT {sql} OR {col} IS NULL)" if op == "neq" else sql
    if op in ("gt", "gte", "lt", "lte"):
        a, b = typed(vals[0])
        return f"{a} {({'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='})[op]} {b}"
    if op == "between":
        if len(vals) < 2:
            raise E.ContourError("between needs two values: from, to")
        (a, lo), (_, hi) = typed(vals[0]), typed(vals[1])
        return f"{a} BETWEEN {lo} AND {hi}"
    if op == "contains":
        return "(" + " OR ".join(f"contains(lower({text}), {E.lit(_text(v).lower())})" for v in vals) + ")"
    if op == "starts_with":
        return "(" + " OR ".join(f"starts_with(lower({text}), {E.lit(_text(v).lower())})" for v in vals) + ")"
    if op == "wildcard":
        return "(" + " OR ".join(f"{text} ILIKE {E.lit(E._wild(_text(v)))} ESCAPE '\\'" for v in vals) + ")"
    # regex (Python-like syntax on DuckDB's RE2): any part of the text matches
    for v in vals:
        if len(_text(v)) > MAX_PATTERN:
            raise E.ContourError(f"a pattern is at most {MAX_PATTERN} characters")
    return "(" + " OR ".join(f"regexp_matches({text}, {E.lit(_text(v))})" for v in vals) + ")"


def _linked_keys(comp: E.Compiler, cond: dict, keys: list[str], cards: dict[str, dict], params: dict, value_of: ValueOf) -> set[str]:
    """The objects (of `keys`) linked to at least one object matching the condition on the linked object's property
    ("linked" / "not_linked" without a property: linked to any object)."""
    import quiver_tables

    lt_id, direction = _link_spec(cond.get("link"))
    lt, _start, reach = _link(lt_id, direction)
    links = _linked_map(lt, direction, set(keys))
    t, rows = quiver_tables.type_rows(reach["object_type_id"])
    reached = {x for xs in links.values() for x in xs}
    visible = {r["primary_key"] for r in rows if r["primary_key"] in reached}
    if cond.get("op") in ("linked", "not_linked") and not cond.get("property"):
        match = visible
    else:
        sub = {**cond, "link": None}
        if sub.get("op") in ("linked", "not_linked"):
            sub["op"] = "not_null"
        rel = _register(comp, quiver_tables.rows_table(t, [r for r in rows if r["primary_key"] in visible]))
        types = _schema(comp, rel)
        pred = _predicate(sub, types, cards, params, value_of, f"{t['display_name']} (linked)")
        match = set(_keys(comp, f"(SELECT * FROM {rel} WHERE {pred})"))
    hit = {k for k, xs in links.items() if any(x in match for x in xs)}
    return set(keys) - hit if cond.get("op") == "not_linked" else hit


def _condition_sql(comp: E.Compiler, cond: dict, types: dict[str, str], keys: list[str], cards: dict[str, dict], params: dict, value_of: ValueOf,
                   what: str, depth: int = 0) -> str:
    """A condition (a property, a linked object's property) or a nested group {match: all|any, conditions} as SQL."""
    if depth > 10:
        raise E.ContourError("filters nest at most 10 deep")
    if isinstance(cond.get("conditions"), list):
        parts = [_condition_sql(comp, x, types, keys, cards, params, value_of, what, depth + 1) for x in cond["conditions"] if isinstance(x, dict)]
        if not parts:
            return "TRUE"
        sql = "(" + (" OR " if cond.get("match") == "any" else " AND ").join(parts) + ")"
        return f"NOT {sql}" if cond.get("negate") else sql
    if cond.get("link"):
        hit = _linked_keys(comp, cond, keys, cards, params, value_of)
        if not hit:
            return "FALSE"
        rel = _register(comp, pa.table({"k": pa.array(sorted(hit), pa.string())}))
        return f'CAST("primary_key" AS VARCHAR) IN (SELECT k FROM {rel})'
    return _predicate(cond, types, cards, params, value_of, what)


def _count_conditions(conds: list) -> int:
    return sum(1 + _count_conditions(x.get("conditions") or []) for x in conds if isinstance(x, dict))


def _object_keys(comp: E.Compiler, cards: dict[str, dict], c: dict) -> list[str]:
    """The primary keys of the objects an object set card holds, in its input's order."""
    import quiver_tables

    kind = c["kind"]
    params, value_of = _params(comp), _value_of(comp)
    if kind == "filter_object_set":
        src = _object_source(cards, c)
        rel = comp.path_rel(src, None)
        conds = [x for x in c.get("conditions") or [] if isinstance(x, dict)]
        if _count_conditions(conds) > MAX_CONDITIONS:
            raise E.ContourError(f"at most {MAX_CONDITIONS} conditions")
        keys = _keys(comp, rel)
        sql = _condition_sql(comp, {"match": c.get("match") or "all", "conditions": conds}, _schema(comp, rel), keys, cards, params, value_of, f"${src}")
        return _keys(comp, f"(SELECT * FROM {rel} WHERE {sql})")
    if kind == "set_math":
        op = c.get("op") or "union"
        if op not in SET_MATH_OPS:
            raise E.ContourError(f"the operation is one of {', '.join(SET_MATH_OPS)}")
        ids = [str(x) for x in c.get("inputs") or [] if x]
        if len(ids) < 2:
            raise E.ContourError("choose two object sets (or more) to combine")
        if len(ids) > MAX_SET_INPUTS:
            raise E.ContourError(f"at most {MAX_SET_INPUTS} object sets")
        tid = None
        sets: list[list[str]] = []
        for x in ids:
            _object_source(cards, {"source": {"card": x}})
            t = object_type_of(cards, x, comp)
            if tid is None:
                tid = t
            elif t != tid:
                raise E.ContourError(f"${x} holds objects of another type: set math combines object sets of the same type")
            sets.append(_keys(comp, comp.path_rel(x, None)))
        if op == "union":
            seen: dict[str, None] = {}
            for s in sets:
                seen.update(dict.fromkeys(s))
            return list(seen)
        rest = [set(s) for s in sets[1:]]
        if op == "intersection":
            return [k for k in sets[0] if all(k in s for s in rest)]
        return [k for k in sets[0] if not any(k in s for s in rest)]  # the first set minus the others
    if kind == "linked_object_set":
        src = _object_source(cards, c)
        lt_id, direction = _link_spec(c.get("link"))
        lt, start, reach = _link(lt_id, direction)
        tid = object_type_of(cards, src, comp)
        if tid and start["object_type_id"] != tid:
            raise E.ContourError(f"${src} holds objects of another type than the link starts from")
        links = _linked_map(lt, direction, set(_keys(comp, comp.path_rel(src, None))))
        return list(dict.fromkeys(x for xs in links.values() for x in xs))
    if kind == "status_filter":
        src = _object_source(cards, c)
        rel = comp.path_rel(src, None)
        types = _schema(comp, rel)
        a, b = str(c.get("start_property") or ""), str(c.get("end_property") or "")
        if not a or not b:
            raise E.ContourError("choose the start and the end date properties")
        for p in (a, b):
            if p not in types:
                raise E.ContourError(f"${src} has no property {p}")
            if types[p] != "date":
                raise E.ContourError(f"{p} is not a date / time property")
        status = c.get("status") or "open"
        if status not in STATUSES:
            raise E.ContourError("the status is open or closed")
        lo, hi = series_range(comp, c, cards, params, value_of)
        s, e = _date_col(types, a), _date_col(types, b)
        conds = [f"{s} IS NOT NULL"]
        if status == "open":
            # opened before or during the range and not closed by its end (no end date: still open)
            if hi is not None:
                conds += [f"{s} <= {_ts_lit(hi)}", f"({e} IS NULL OR {e} > {_ts_lit(hi)})"]
            else:
                conds.append(f"{e} IS NULL")
        else:
            # closed during the range, so opened before or during it; objects closed before the range are not
            conds.append(f"{e} IS NOT NULL")
            if lo is not None:
                conds.append(f"{e} >= {_ts_lit(lo)}")
            if hi is not None:
                conds.append(f"{e} <= {_ts_lit(hi)}")
        return _keys(comp, f"(SELECT * FROM {rel} WHERE {' AND '.join(conds)})")
    if kind == "object_view":
        if (c.get("source") or {}).get("card"):
            src = _object_source(cards, c)
            keys = _keys(comp, comp.path_rel(src, None))
            if len(keys) > 1:
                raise E.ContourError(f"${src} holds {len(keys):,} objects: an object view shows one object (add an object selector)")
            return keys
        spec = c.get("primary_key")
        if spec is None or (isinstance(spec, str) and not spec.strip()):
            raise E.ContourError("choose the object (a primary key, or a card whose value is one)")
        v = operand(spec, cards, params, value_of)
        if isinstance(v, list):
            if len(v) > 1:
                raise E.ContourError(f"{spec} holds {len(v)} values: an object view shows one object")
            v = v[0] if v else None
        if v is None or v == "":
            return []
        tid = object_type_of(cards, c["id"], comp)
        if not tid:
            raise E.ContourError("choose the object type")
        t, rows = quiver_tables.type_rows(tid)
        pk = _text(v)
        if not any(r["primary_key"] == pk for r in rows):
            raise E.ContourError(f'{t["display_name"]} "{pk}" not found')
        return [pk]
    if kind == "defined_by_property":
        return _defined_by_property(comp, cards, c, params, value_of)
    if kind == "saved_object_set":
        return list(dict.fromkeys(saved_set(c.get("object_set"), comp)["keys"]))
    raise E.ContourError(f"${c['id']} is not an object set card")


def _base_rel(comp: E.Compiler, cards: dict[str, dict], c: dict) -> tuple[str, str]:
    """(the relation of the objects a defined by property card picks from, how it is named in messages): its input
    object set card, or every object of its type the viewer can see."""
    import quiver_tables

    if (c.get("source") or {}).get("card"):
        src = _object_source(cards, c)
        return comp.path_rel(src, None), f"${src}"
    tid = object_type_of(cards, c["id"], comp)
    memo = comp.__dict__.setdefault("_type_rels", {})
    if tid not in memo:
        t, rows = quiver_tables.type_rows(tid)
        memo[tid] = (_register(comp, quiver_tables.rows_table(t, rows)), t["display_name"])
    return memo[tid]


def _array_props(tid: Optional[str]) -> dict[str, str]:
    """An object type's array properties: api name → the elements' kind (number, date, boolean, string)."""
    import ontology
    from fastapi import HTTPException

    if not tid:
        return {}
    try:
        with ontology._lock:
            t = ontology._object_type(tid)
    except HTTPException:
        return {}
    return {p["api_name"]: ("string" if p.get("type") == "string_array" else _prop_kind(p.get("type")))
            for p in t["properties"] if p.get("array") or p.get("type") == "string_array"}


def _array_elements(comp: E.Compiler, tid: str, keys: list[str], prop: str) -> list[tuple[str, Any]]:
    """(primary key, element) for every element of an array property of the given objects (as the viewer sees them:
    hidden values read as empty)."""
    import quiver_tables

    memo = comp.__dict__.setdefault("_type_raw", {})
    if tid not in memo:
        memo[tid] = {r["primary_key"]: r["properties"] for r in quiver_tables.type_rows(tid)[1]}
    raw = memo[tid]
    out = []
    for k in keys:
        v = (raw.get(k) or {}).get(prop)
        for x in v if isinstance(v, (list, tuple)) else [] if v is None else [v]:
            if x is not None and x != "" and not isinstance(x, (list, dict)):
                out.append((k, x))  # (struct elements are not matched)
    return out


def _object_source_type(cards: dict[str, dict], cid: str, comp: E.Compiler) -> Optional[str]:
    """The object type of a card's rows when the card holds objects (an object set card), else None."""
    kind = (cards.get(cid) or {}).get("kind") or "object_set"
    if kind not in ("object_set", "object_selector", *OBJECT_SET_KINDS):
        return None
    try:
        return object_type_of(cards, cid, comp)
    except E.ContourError:
        return None


def _defined_by_property(comp: E.Compiler, cards: dict[str, dict], c: dict, params: dict, value_of: ValueOf) -> list[str]:
    """Defined by property: the input's objects whose property holds one of the values — another card's column, or
    typed / "$ID" values (e.g. a saved object set's identifier). An array property matches when any of its elements
    holds one of the values; an array property the values come from gives each of its elements."""
    rel, what = _base_rel(comp, cards, c)
    types = _schema(comp, rel)
    prop = str(c.get("property") or "")
    if not prop:
        raise E.ContourError("choose the property that holds the values")
    if prop not in types:
        raise E.ContourError(f"{what} has no property {prop}")
    tid = object_type_of(cards, c["id"], comp)
    arrays = _array_props(tid)
    kind = arrays.get(prop) or types[prop]
    src = c.get("from") or {}
    fc = str(src.get("card") or "")
    if fc:
        if fc == c["id"]:
            raise E.ContourError("the values come from another card")
        if fc not in cards:
            raise E.ContourError(f"__missing__{fc}")
        fprop = str(src.get("property") or "")
        if fprop:
            frel = comp.path_rel(fc, None)
            ftypes = _schema(comp, frel)
            if fprop not in ftypes:
                raise E.ContourError(f"${fc} has no column {fprop}")
            ftid = _object_source_type(cards, fc, comp)
            if ftid and fprop in _array_props(ftid):
                # an array property of the objects: each element is a value
                vals = list(dict.fromkeys(x for _, x in _array_elements(comp, ftid, _keys(comp, frel), fprop)))
            else:
                vals = [r["v"] for r in E.rows_of(comp.run(f"SELECT DISTINCT {E.q(fprop)} AS v FROM {frel} WHERE {E.q(fprop)} IS NOT NULL"))]
                # an array column of a table: each element is a value
                vals = list(dict.fromkeys(x for v in vals for x in (v if isinstance(v, list) else [v]) if not isinstance(x, (list, dict))))
        else:
            got = value_of(fc)
            if got.get("error"):
                raise E.ContourError(f"${fc}: {got['error']}")
            if "value" not in got:
                raise E.ContourError(f"${fc} has no value: choose the column (or property) whose values define the set")
            v = got["value"]
            vals = list(v) if isinstance(v, list) else [v]
            # the values of an array column (arrays of elements): each element is a value
            vals = [x for y in vals for x in (y if isinstance(y, list) else [y])]
    else:
        vals = _cond_values({"op": "in", "value": c.get("value")}, cards, params, value_of)
        if not vals and c.get("value") in (None, ""):
            raise E.ContourError("choose the values: another card's column or property, or typed values ($ID: a card's value)")
    vals = [x for x in vals if x is not None and x != ""]
    if len(vals) > MAX_DEFINING_VALUES:
        raise E.ContourError(f"{len(vals):,} values — at most {MAX_DEFINING_VALUES:,} define an object set")
    if not vals:
        return []

    def typed(xs: list) -> tuple[list, Any]:
        # values in the property's kind (those that are not of it match nothing) and their Arrow type
        if kind == "number":
            return [n for n in (_num(x) for x in xs) if n is not None], pa.float64()
        if kind == "date":
            ms = []
            for x in xs:
                try:
                    ms.append(_date_ms(x, prop))
                except E.ContourError:
                    continue  # a value that is not a date matches no object
            return ms, pa.int64()
        return [(_text(x).lower() if kind == "boolean" else _text(x)) for x in xs if not isinstance(x, (list, dict))], pa.string()

    want, at = typed(vals)
    if not want:
        return []
    vt = _register(comp, pa.table({"v": pa.array(want, at)}))
    if prop in arrays:
        # an array property: the objects with an element equal to one of the values (compared in the elements' type)
        keys = _keys(comp, rel)
        ks, es = [], []
        for k, x in _array_elements(comp, tid, keys, prop):
            got, _ = typed([x])
            if got:
                ks.append(k)
                es.append(got[0])
        et = _register(comp, pa.table({"k": pa.array(ks, pa.string()), "e": pa.array(es, at)}))
        pred = f'CAST("primary_key" AS VARCHAR) IN (SELECT k FROM {et} WHERE e IN (SELECT v FROM {vt}))'
        return _keys(comp, f"(SELECT * FROM {rel} WHERE {pred})")
    col = E.q(prop)
    if kind == "number":
        pred = f"TRY_CAST({col} AS DOUBLE) IN (SELECT v FROM {vt})"
    elif kind == "date":
        pred = f"epoch_ms({_date_col(types, prop)}) IN (SELECT v FROM {vt})"
    else:
        expr = f"lower(CAST({col} AS VARCHAR))" if kind == "boolean" else f"CAST({col} AS VARCHAR)"
        pred = f"{expr} IN (SELECT v FROM {vt})"
    return _keys(comp, f"(SELECT * FROM {rel} WHERE {pred})")


def object_set_table(comp: E.Compiler, cards: dict[str, dict], c: dict) -> pa.Table:
    """An object set card's objects as an object set card's table (primary_key, a column per property), with the
    viewer's permissions."""
    import quiver_tables

    keys = _object_keys(comp, cards, c)
    tid = object_type_of(cards, c["id"], comp)
    if not tid:
        raise E.ContourError("the object type of the input cannot be told: choose an object set card as the input")
    t, rows = quiver_tables.type_rows(tid)
    order = {k: i for i, k in enumerate(keys)}
    return quiver_tables.rows_table(t, sorted((r for r in rows if r["primary_key"] in order), key=lambda r: order[r["primary_key"]]))


def _ways_out(tid: str) -> list[dict]:
    """The links from an object type the viewer may follow, with the reached type's properties."""
    import ontology
    import ontology_model as om
    from fastapi import HTTPException

    out = []
    with ontology._lock:
        for lt, direction in om.links_of(tid):
            if not om.discoverable(lt):
                continue
            start, reach = om.side_of(lt, direction)
            if start["object_type_id"] != tid:
                continue
            try:
                other = ontology._object_type(reach["object_type_id"])
            except HTTPException:
                continue
            out.append({"link": f"{lt['id']}:{direction}", "label": f"{lt.get('display_name') or lt['id']} → {reach.get('plural_display_name') or reach.get('display_name') or other['display_name']}",
                        "object_type_id": other["id"], "object_type": other["display_name"],
                        "properties": [{"api_name": p["api_name"], "display_name": p.get("display_name") or p["api_name"], "type": p.get("type")} for p in other["properties"] if p.get("type") != "vector"]})
    return out


def _type_info(tid: Optional[str]) -> dict:
    import ontology
    from fastapi import HTTPException

    if not tid:
        return {}
    try:
        with ontology._lock:
            t = ontology._object_type(tid)
    except HTTPException:
        return {}
    return {"object_type_id": t["id"], "object_type": t["display_name"], "title_property": t.get("title_property"),
            "properties": [{"api_name": p["api_name"], "display_name": p.get("display_name") or p["api_name"], "type": p.get("type")} for p in t["properties"] if p.get("type") != "vector"]}


def object_set_card(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """An object set card's result: its objects (the first 50 shown; comp.object_rows: more), how many, their type; for the editor the input's
    property types and the links out of its type. An object view's value is its object's primary key."""
    rel = comp.path_rel(c["id"], None)
    total = comp.count(rel)
    shown = comp.run(f"SELECT * FROM {rel}", max(1, int(getattr(comp, "object_rows", None) or SHOW_OBJECTS)))
    tid = object_type_of(cards, c["id"], comp)
    out: dict[str, Any] = {"columns": list(shown.schema.names), "rows": E.rows_of(shown), "total": total, "count": total, **_type_info(tid)}
    out.update(_object_editor_info(comp, cards, c))
    if c["kind"] == "saved_object_set":
        s = saved_set(c.get("object_set"), comp)
        # the saved set's metadata; `stored` objects in it (some may be gone or hidden from the viewer)
        out["saved"] = {**{k: v for k, v in s.items() if k != "keys"}, "stored": len(s["keys"])}
    if c["kind"] == "object_view":
        row = out["rows"][0] if out["rows"] else None
        title = row.get(out.get("title_property") or "") if row else None
        out.update(value=row["primary_key"] if row else None, type="string", object=row["primary_key"] if row else None, object_row=row,
                   label=None if row is None else (_text(title) if title not in (None, "") and not isinstance(title, (list, dict)) else row["primary_key"]))
    return out


def _object_editor_info(comp: E.Compiler, cards: dict[str, dict], c: dict) -> dict:
    """What the card's settings pick from: the input's property types (input_columns / column_types), the links out
    of the input's type (a linked object set, a filter on linked objects) and, for set math, the inputs' types."""
    out: dict[str, Any] = {}
    src = str((c.get("source") or {}).get("card") or "")
    try:
        if src and src in cards and c["kind"] in ("filter_object_set", "status_filter", "linked_object_set", "object_view", "defined_by_property"):
            types = _schema(comp, comp.path_rel(src, None))
            out.update(input_columns=list(types), column_types=types)
            tid = object_type_of(cards, src, comp)
            out["input_type"] = _type_info(tid)
            if tid and c["kind"] in ("filter_object_set", "linked_object_set"):
                out["links"] = _ways_out(tid)
        if c["kind"] == "set_math":
            out["input_types"] = {x: object_type_of(cards, x, comp) for x in c.get("inputs") or [] if x in cards}
    except Exception:  # noqa: BLE001 — pickers only: the card's own result (or error) says what is wrong
        pass
    if c["kind"] == "defined_by_property":
        try:
            if not src and c.get("object_type_id"):
                info = _type_info(str(c["object_type_id"]))
                out["input_type"] = info
                out["input_columns"] = ["primary_key", *(p["api_name"] for p in info.get("properties") or [])]
                out["column_types"] = {p["api_name"]: _prop_kind(p.get("type")) for p in info.get("properties") or []}
        except Exception:  # noqa: BLE001
            pass
        try:
            # array properties match on any element
            out["array_properties"] = list(_array_props(object_type_of(cards, c["id"], comp)))
        except Exception:  # noqa: BLE001
            pass
        fc = str((c.get("from") or {}).get("card") or "")
        try:
            if fc and fc in cards and fc != c["id"]:
                # the columns of the card the values come from (a value / array card has none: its value is read)
                out["from_column_types"] = _schema(comp, comp.path_rel(fc, None))
                out["from_array_properties"] = list(_array_props(_object_source_type(cards, fc, comp)))
        except Exception:  # noqa: BLE001
            pass
    return out


def _prop_kind(t: Any) -> str:
    """An ontology property type as a column kind (number, date, boolean, string)."""
    t = str(t or "").lower()
    if t in ("integer", "long", "short", "byte", "double", "float", "decimal"):
        return "number"
    if t in ("date", "timestamp"):
        return "date"
    return "boolean" if t == "boolean" else "string"


def run_card(comp: E.Compiler, cards: dict[str, dict], c: dict, value_of: ValueOf) -> dict:
    try:
        return _run_card(comp, cards, c, value_of)
    except (TypeError, ValueError, OverflowError) as e:
        # a malformed setting (digits / limit / percentile not a number …) is the card's error, not a failed run
        err = f"{c.get('kind')}: {e}"
    except E.ContourError as e:
        err = str(e)
    if "__missing__" in err:
        return {"error": "the source card no longer exists"}
    out: dict[str, Any] = {"error": err}
    # the input's columns even so: a card being set up ("choose the column") needs them for its column pickers
    if c.get("kind") in ("numeric_agg", "column_values", "correlation", "waterfall", "string_selector", "property_select", "object_selector",
                         "row_selector", "object_property") and (c.get("source") or {}).get("card"):
        try:
            types = _schema(comp, _input_rel(comp, cards, c)[1])
            out.update(input_columns=list(types), column_types=types)
        except Exception:  # noqa: BLE001 — the input itself is broken; the error above says why
            pass
    if c.get("kind") in OBJECT_SET_KINDS:
        # an object set card being set up ("choose the link") still lists the input's properties and links
        out.update(_object_editor_info(comp, cards, c))
    return out


def _run_card(comp: E.Compiler, cards: dict[str, dict], c: dict, value_of: ValueOf) -> dict:
    params = {k: v for k, v in (comp.params or {}).items() if not str(k).startswith("__")}
    # date / time range parameters ({start, end}); they are not SQL parameters of the table engine
    params.update(getattr(comp, "range_params", None) or {})
    kind = c["kind"]
    if kind == "numeric_agg":
        return numeric_agg(comp, cards, c, value_of)
    if kind == "column_values":
        return column_values(comp, cards, c)
    if kind == "numeric_formula":
        return numeric_formula(c, cards, params, value_of)
    if kind == "round":
        return round_card(c, cards, params, value_of)
    if kind == "date_diff":
        return date_diff(c, cards, params, value_of)
    if kind == "date_part":
        return date_part(c, cards, params, value_of)
    if kind == "string_op":
        return string_op(c, cards, params, value_of)
    if kind == "comparison":
        return comparison(c, cards, params, value_of)
    if kind == "boolean_formula":
        return boolean_formula(c, cards, params, value_of)
    if kind == "create_array":
        return create_array(c, cards, params, value_of)
    if kind == "stepped_array":
        return stepped_array(c, cards, params, value_of)
    if kind == "array_op":
        return array_op(c, cards, params, value_of)
    if kind == "coalesce":
        return coalesce(c, cards, params, value_of)
    if kind == "range":
        return range_card(c, cards, params, value_of)
    if kind == "range_op":
        return range_op(c, cards, params, value_of)
    if kind == "xy_range":
        return xy_range(c, cards, params, value_of)
    if kind == "string_selector":
        return string_selector(comp, cards, c, value_of)
    if kind == "property_select":
        return property_select(comp, cards, c)
    if kind == "object_selector":
        return object_selector(comp, cards, c)
    if kind == "row_selector":
        return row_selector(comp, cards, c)
    if kind == "date_convert":
        return date_convert(c, cards, params, value_of)
    if kind == "period_to_date":
        return period_to_date(c, cards, params, value_of)
    if kind == "object_property":
        return object_property(comp, cards, c)
    if kind == "multipass_attribute":
        return multipass_attribute(c, cards, params, value_of)
    if kind == "correlation":
        return correlation(comp, cards, c)
    if kind == "waterfall":
        return waterfall(comp, cards, c, params, value_of)
    if kind == "series_agg":
        return series_agg(comp, cards, c, params, value_of)
    if kind == "series_op":
        return series_op(comp, cards, c, params, value_of)
    if kind == "regression":
        return regression(comp, cards, c, params, value_of)
    if kind == "shift_datetime":
        return shift_datetime(c, cards, params, value_of)
    if kind == "series_distribution":
        return series_distribution(comp, cards, c, params, value_of)
    if kind == "series_scatter":
        return series_scatter(comp, cards, c, params, value_of)
    if kind in OBJECT_SET_KINDS:
        return object_set_card(comp, cards, c)
    raise E.ContourError(f"unknown card kind {kind}")
