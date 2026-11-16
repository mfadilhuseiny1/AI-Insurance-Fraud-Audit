"""Data expectations for Python transforms: `from transforms import expectations as E` and `Check(...)` on an
Input or Output (palantir.com/docs/foundry/transforms-python/data-expectations-reference).

Checks are evaluated with Polars on the dataset (inputs before the compute function runs, outputs on what the
build commits). A failing `on_error='FAIL'` check stops the build (nothing is committed); `'WARN'` is recorded. The
results go on the build record and to Data Health's Expectations tab.

Supported: E.true / false / all / any / negate; column expectations (gt, gte, lt, lte, equals, not_equals,
non_null, is_null, is_in, rlike, has_type, exists, *_col comparisons, timestamp comparisons static / against
another column / relative to now, array is_in / array_contains / size); properties (null_percentage, null_count,
distinct_count, approx_distinct_count, sum, standard deviations, min_value, max_value); group_by(...).is_unique()
/ .count() / .col(...).<property>; E.count(); primary_key; schema().contains / equals / is_subset_of; when /
otherwise; foreign values (is_in_foreign_col, dataset_ref(...).count()). Types are Polars types or PySpark types.
"""

from __future__ import annotations

import re
import types
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional


class Check:
    """An expectation with a name unique in the transform; on_error 'FAIL' (stops the build) or 'WARN'."""

    def __init__(self, expectation: "Expectation", name: str, on_error: str = "FAIL", description: Optional[str] = None) -> None:
        if not isinstance(expectation, Expectation):
            raise TypeError("Check(...) takes an expectation (from transforms.expectations) first")
        if not name or not str(name).strip():
            raise ValueError("a Check needs a name")
        on_error = str(on_error).upper()
        if on_error not in ("FAIL", "WARN"):
            raise ValueError("on_error must be 'FAIL' or 'WARN'")
        self.expectation = expectation
        self.name = str(name)
        self.on_error = on_error
        self.description = description


# ------------------------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------------------------


def _pl():
    import polars as pl

    return pl


def _seconds(v) -> float:
    if isinstance(v, timedelta):
        return v.total_seconds()
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    raise TypeError("an offset is a number of seconds or a timedelta")


def _timestamp(v) -> datetime:
    if isinstance(v, str):
        s = v.strip().replace("Z", "+00:00")
        s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s)
        v = datetime.fromisoformat(s)
    if not isinstance(v, datetime):
        raise TypeError("a static timestamp is an ISO 8601 string or a datetime")
    if v.tzinfo is None:
        raise ValueError(f"timestamps must be timezone aware: {v.isoformat()}")
    return v


def _ts_expr(df, col: str):
    pl = _pl()
    dt = df.schema[col]
    if not isinstance(dt, pl.Datetime):
        raise TypeError(f"timestamp expectations work on Timestamp columns; {col} is {dt}")
    e = pl.col(col)
    return e.dt.convert_time_zone("UTC") if dt.time_zone else e.dt.replace_time_zone("UTC")


def _need(df, *cols: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise KeyError(f"no column {', '.join(missing)}")


def _type_name(t) -> str:
    return getattr(t, "simpleString", None) and t.simpleString() or str(t)


def _polars_type(t):
    """A Polars type for a Polars type (class or instance), a PySpark type, or a type name."""
    pl = _pl()
    if isinstance(t, type) and issubclass(t, pl.DataType):
        return t
    if isinstance(t, pl.DataType):
        return t
    name = type(t).__name__ if not isinstance(t, str) else t
    simple = {"LongType": pl.Int64, "IntegerType": pl.Int32, "ShortType": pl.Int16, "ByteType": pl.Int8, "DoubleType": pl.Float64,
              "FloatType": pl.Float32, "StringType": pl.String, "BooleanType": pl.Boolean, "DateType": pl.Date, "TimestampType": pl.Datetime,
              "TimestampNTZType": pl.Datetime, "BinaryType": pl.Binary, "DecimalType": pl.Decimal, "NullType": pl.Null,
              "string": pl.String, "long": pl.Int64, "int": pl.Int32, "integer": pl.Int32, "double": pl.Float64, "float": pl.Float32,
              "boolean": pl.Boolean, "date": pl.Date, "timestamp": pl.Datetime}
    if name in simple:
        return simple[name]
    if name == "ArrayType":
        return pl.List(_polars_type(t.elementType))
    if name == "MapType":
        return pl.List
    if name == "StructType":
        return pl.Struct
    raise TypeError(f"unknown type {t!r}: use Polars types (pl.Int64) or PySpark types (T.LongType())")


def _type_matches(actual, expected) -> bool:
    exp = _polars_type(expected)
    try:
        return bool(actual == exp)
    except Exception:  # noqa: BLE001
        return str(actual) == str(exp)


# ------------------------------------------------------------------------------------------------
# expectations
# ------------------------------------------------------------------------------------------------


class Expectation:
    """Row expectations give a pass/fail mask per row; the others pass or fail the whole dataset."""

    row_level = False

    def describe(self) -> str:
        return type(self).__name__

    def mask(self, df, env: dict):  # pragma: no cover - row-level subclasses
        raise NotImplementedError

    def evaluate(self, df, env: dict) -> tuple[bool, str]:
        m = self.mask(df, env)
        failing = int((~m).sum()) if len(m) else 0
        if failing:
            return False, f"{failing:,} of {len(m):,} rows fail: {self.describe()}"
        return True, f"all {len(m):,} rows pass: {self.describe()}"

    def __and__(self, other: "Expectation") -> "Expectation":
        return _All([self, other])

    def __or__(self, other: "Expectation") -> "Expectation":
        return _Any([self, other])

    def __invert__(self) -> "Expectation":
        return _Negate(self)


class _Const(Expectation):
    row_level = True

    def __init__(self, value: bool) -> None:
        self.value = value

    def describe(self) -> str:
        return "true" if self.value else "false"

    def mask(self, df, env):
        return _pl().Series([self.value] * df.height, dtype=_pl().Boolean)

    def evaluate(self, df, env):
        return self.value, "E.true()" if self.value else "E.false() always fails"


class _Row(Expectation):
    """A row expectation from a Polars expression (True = the row passes)."""

    row_level = True

    def __init__(self, label: str, build: Callable) -> None:
        self.label = label
        self.build = build

    def describe(self) -> str:
        return self.label

    def mask(self, df, env):
        pl = _pl()
        expr = self.build(df, env)
        return df.select(expr.fill_null(False).alias("_m")).to_series() if df.height else pl.Series([], dtype=pl.Boolean)


class _Whole(Expectation):
    """A dataset-level expectation: fn(df, env) -> (ok, message)."""

    def __init__(self, label: str, fn: Callable) -> None:
        self.label = label
        self.fn = fn

    def describe(self) -> str:
        return self.label

    def evaluate(self, df, env):
        return self.fn(df, env)


class _All(Expectation):
    def __init__(self, items: list[Expectation]) -> None:
        self.items = items
        self.row_level = all(i.row_level for i in items)

    def describe(self) -> str:
        return "all(" + ", ".join(i.describe() for i in self.items) + ")"

    def mask(self, df, env):
        m = _pl().Series([True] * df.height)
        for i in self.items:
            m = m & i.mask(df, env)
        return m

    def evaluate(self, df, env):
        if self.row_level:
            return super().evaluate(df, env)
        msgs = []
        ok = True
        for i in self.items:
            o, msg = i.evaluate(df, env)
            ok &= o
            if not o:
                msgs.append(msg)
        return ok, "; ".join(msgs) if msgs else f"passes: {self.describe()}"


class _Any(Expectation):
    def __init__(self, items: list[Expectation]) -> None:
        self.items = items
        self.row_level = all(i.row_level for i in items)

    def describe(self) -> str:
        return "any(" + ", ".join(i.describe() for i in self.items) + ")"

    def mask(self, df, env):
        m = _pl().Series([False] * df.height)
        for i in self.items:
            m = m | i.mask(df, env)
        return m

    def evaluate(self, df, env):
        if self.row_level:
            return super().evaluate(df, env)
        results = [i.evaluate(df, env) for i in self.items]
        if any(o for o, _ in results):
            return True, f"passes: {self.describe()}"
        return False, "none passes: " + "; ".join(m for _, m in results)


class _Negate(Expectation):
    def __init__(self, item: Expectation) -> None:
        self.item = item
        self.row_level = item.row_level

    def describe(self) -> str:
        return f"not {self.item.describe()}"

    def mask(self, df, env):
        return ~self.item.mask(df, env)

    def evaluate(self, df, env):
        if self.row_level:
            return super().evaluate(df, env)
        ok, msg = self.item.evaluate(df, env)
        return not ok, (f"passes: {self.describe()}" if ok is False else f"fails: {self.describe()} ({msg})")


class _When(Expectation):
    row_level = True

    def __init__(self, cond: Expectation, then: Expectation, other: Optional[Expectation] = None) -> None:
        if not (cond.row_level and then.row_level and (other is None or other.row_level)):
            raise TypeError("when / otherwise take row expectations (column expectations)")
        self.cond, self.then, self.other = cond, then, other

    def otherwise(self, other: Expectation) -> "_When":
        return _When(self.cond, self.then, other)

    def describe(self) -> str:
        return f"when {self.cond.describe()} then {self.then.describe()}" + (f" otherwise {self.other.describe()}" if self.other else "")

    def mask(self, df, env):
        c = self.cond.mask(df, env)
        t = self.then.mask(df, env)
        o = self.other.mask(df, env) if self.other else _pl().Series([True] * df.height)
        return (c & t) | (~c & o)


# -- values: properties of a column, a group or a dataset ----------------------------------------


class _Value:
    """A property to compare: per row (rows=True: a Polars expression) or per group / dataset (a Series of values)."""

    def __init__(self, label: str, rows: bool, compute: Callable, kind: str = "number") -> None:
        self.label = label
        self.rows = rows
        self.compute = compute
        self.kind = kind

    def _cmp(self, op: str, other) -> Expectation:
        sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "eq": "==", "ne": "!="}[op]
        if self.kind == "offset":
            other = _seconds(other)
        label = f"{self.label} {sym} {other.label if isinstance(other, _Value) else repr(other)}"

        def apply(a, b):
            return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b, "eq": a == b, "ne": a != b}[op]

        if self.rows:
            def build(df, env):
                pl = _pl()
                return apply(self.compute(df, env), pl.lit(other)).fill_null(True)

            return _Row(label, build)

        def whole(df, env):
            values = self.compute(df, env)
            target = other.compute(df, env)[0] if isinstance(other, _Value) else other
            vals = [v.replace(tzinfo=timezone.utc) if isinstance(v, datetime) and v.tzinfo is None else v for v in values]
            bad = [v for v in vals if v is not None and not apply(v, target)]
            if len(vals) == 1:
                v = vals[0]
                ok = not bad
                return ok, f"{self.label} is {_fmt(v)}" + ("" if ok else f", expected {sym} {_fmt(target)}")
            return not bad, (f"all {len(vals):,} groups pass: {label}" if not bad else f"{len(bad):,} of {len(vals):,} groups fail: {label}")

        return _Whole(label, whole)

    def gt(self, v):
        return self._cmp("gt", v)

    def gte(self, v):
        return self._cmp("gte", v)

    ge = gte

    def lt(self, v):
        return self._cmp("lt", v)

    def lte(self, v):
        return self._cmp("lte", v)

    le = lte

    def equals(self, v):
        return self._cmp("eq", v)

    def not_equals(self, v):
        return self._cmp("ne", v)

    # timestamps
    def _ts(self, op: str, ts) -> Expectation:
        t = _timestamp(ts)
        return _Value(self.label, self.rows, self.compute, "timestamp")._cmp(op, t)

    def is_after(self, ts):
        return self._ts("gt", ts)

    def is_before(self, ts):
        return self._ts("lt", ts)

    def is_on_or_after(self, ts):
        return self._ts("gte", ts)

    def is_on_or_before(self, ts):
        return self._ts("lte", ts)

    def timestamp_offset_from_current_time(self) -> "_Value":
        """(value - now) in seconds: for timestamps in the future."""
        return _Value(f"{self.label} - now (s)", self.rows, lambda df, env: _offset(self.compute(df, env), env["now"], future=True, rows=self.rows), "offset")

    def timestamp_offset_to_current_time(self) -> "_Value":
        """(now - value) in seconds: for timestamps in the past."""
        return _Value(f"now - {self.label} (s)", self.rows, lambda df, env: _offset(self.compute(df, env), env["now"], future=False, rows=self.rows), "offset")


def _offset(v, now: datetime, future: bool, rows: bool):
    pl = _pl()
    if rows:
        diff = (v - pl.lit(now)) if future else (pl.lit(now) - v)
        return diff.dt.total_microseconds() / 1e6
    out = []
    for x in v:
        if x is None:
            out.append(None)
            continue
        x = x if x.tzinfo else x.replace(tzinfo=timezone.utc)
        out.append(((x - now) if future else (now - x)).total_seconds())
    return pl.Series(out, dtype=pl.Float64)


def _fmt(v) -> str:
    if isinstance(v, float):
        return f"{v:,.6g}"
    if isinstance(v, int):
        return f"{v:,}"
    if isinstance(v, datetime):
        return v.isoformat()
    return repr(v)


class _Col:
    """E.col('name'): expectations on a column."""

    def __init__(self, name: str, group: Optional[list[str]] = None) -> None:
        self.name = name
        self.group = group

    # -- row expectations
    def _row(self, label: str, build: Callable) -> Expectation:
        if self.group is not None:
            raise TypeError("after group_by(...) use a property: .col(c).null_count(), .distinct_count(), ...")
        return _Row(label, build)

    def _cmp(self, op: str, v) -> Expectation:
        return _Value(f"{self.name}", True, lambda df, env: (_need(df, self.name), _pl().col(self.name))[1])._cmp(op, v)

    def gt(self, v):
        return self._cmp("gt", v)

    def gte(self, v):
        return self._cmp("gte", v)

    ge = gte

    def lt(self, v):
        return self._cmp("lt", v)

    def lte(self, v):
        return self._cmp("lte", v)

    le = lte

    def equals(self, v):
        return self._cmp("eq", v)

    def not_equals(self, v):
        return self._cmp("ne", v)

    def non_null(self):
        return self._row(f"{self.name} is not null", lambda df, env: (_need(df, self.name), _pl().col(self.name).is_not_null())[1])

    def is_null(self):
        return self._row(f"{self.name} is null", lambda df, env: (_need(df, self.name), _pl().col(self.name).is_null())[1])

    def is_in(self, *values):
        allowed = list(values[0]) if len(values) == 1 and isinstance(values[0], (list, tuple, set)) else list(values)

        def build(df, env):
            pl = _pl()
            _need(df, self.name)
            non_null = [v for v in allowed if v is not None]
            if isinstance(df.schema[self.name], pl.List):
                return pl.col(self.name).list.eval(pl.element().is_in(non_null) | (pl.element().is_null() if None in allowed else pl.lit(False))).list.all().fill_null(True)
            e = pl.col(self.name).is_in(non_null)
            return (e | pl.col(self.name).is_null()) if None in allowed else e.fill_null(False)

        return self._row(f"{self.name} in {allowed}", build)

    def rlike(self, pattern: str):
        re.compile(pattern)
        return self._row(f"{self.name} matches /{pattern}/",
                         lambda df, env: (_need(df, self.name), _pl().col(self.name).cast(_pl().String).str.contains(pattern).fill_null(True))[1])

    def array_contains(self, value):
        return self._row(f"{self.name} contains {value!r}", lambda df, env: (_need(df, self.name), _pl().col(self.name).list.contains(value).fill_null(False))[1])

    def size(self) -> _Value:
        return _Value(f"size({self.name})", True, lambda df, env: (_need(df, self.name), _pl().col(self.name).list.len())[1])

    def _cmp_col(self, op: str, other: str, offset=0) -> Expectation:
        sym = {"eq": "==", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]

        def build(df, env):
            pl = _pl()
            _need(df, self.name, other)
            a, b = pl.col(self.name), pl.col(other)
            if offset:
                if isinstance(df.schema[other], pl.Datetime):
                    b = b + pl.duration(seconds=_seconds(offset))
                else:
                    b = b + offset
            r = {"eq": a == b, "ne": a != b, "gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
            return r.fill_null(True)

        return self._row(f"{self.name} {sym} {other}" + (f" + {offset}s" if offset else ""), build)

    def equals_col(self, other: str):
        return self._cmp_col("eq", other)

    def not_equals_col(self, other: str):
        return self._cmp_col("ne", other)

    def gt_col(self, other: str):
        return self._cmp_col("gt", other)

    def gte_col(self, other: str):
        return self._cmp_col("gte", other)

    def lt_col(self, other: str):
        return self._cmp_col("lt", other)

    def lte_col(self, other: str):
        return self._cmp_col("lte", other)

    # -- timestamps
    def _ts_row(self) -> _Value:
        return _Value(self.name, True, lambda df, env: (_need(df, self.name), _ts_expr(df, self.name))[1], "timestamp")

    def is_after(self, ts):
        return self._ts_row().is_after(ts)

    def is_before(self, ts):
        return self._ts_row().is_before(ts)

    def is_on_or_after(self, ts):
        return self._ts_row().is_on_or_after(ts)

    def is_on_or_before(self, ts):
        return self._ts_row().is_on_or_before(ts)

    def is_after_col(self, other: str, offset_in_seconds=0):
        return self._cmp_col("gt", other, offset_in_seconds)

    def is_before_col(self, other: str, offset_in_seconds=0):
        return self._cmp_col("lt", other, offset_in_seconds)

    def is_on_or_after_col(self, other: str, offset_in_seconds=0):
        return self._cmp_col("gte", other, offset_in_seconds)

    def is_on_or_before_col(self, other: str, offset_in_seconds=0):
        return self._cmp_col("lte", other, offset_in_seconds)

    def timestamp_offset_from_current_time(self) -> _Value:
        return self._ts_row().timestamp_offset_from_current_time()

    def timestamp_offset_to_current_time(self) -> _Value:
        return self._ts_row().timestamp_offset_to_current_time()

    # -- foreign values
    def is_in_foreign_col(self, ref: "_ForeignCol"):
        if not isinstance(ref, _ForeignCol):
            raise TypeError("is_in_foreign_col takes E.dataset_ref('input').col('column')")

        def build(df, env):
            pl = _pl()
            _need(df, self.name)
            other = ref.frame(env)
            _need(other, ref.column)
            values = other.get_column(ref.column).drop_nulls().unique()
            return pl.col(self.name).is_in(values.implode()) | pl.col(self.name).is_null()

        return self._row(f"{self.name} in {ref.dataset}.{ref.column}", build)

    # -- dataset-level
    def has_type(self, t):
        def fn(df, env):
            if self.name not in df.columns:
                return False, f"no column {self.name}"
            actual = df.schema[self.name]
            ok = _type_matches(actual, t)
            return ok, f"{self.name} is {actual}" + ("" if ok else f", expected {_type_name(t)}")

        return _Whole(f"{self.name} has type {_type_name(t)}", fn)

    def exists(self):
        return _Whole(f"column {self.name} exists", lambda df, env: (self.name in df.columns, f"column {self.name} " + ("exists" if self.name in df.columns else "is missing")))

    # -- properties (per group after group_by)
    def _prop(self, label: str, agg: Callable) -> _Value:
        group = self.group or []

        def compute(df, env):
            pl = _pl()
            _need(df, self.name, *group)
            expr = agg(pl.col(self.name), df).alias("_v")
            if group:
                return df.group_by(group).agg(expr).get_column("_v")
            return df.select(expr).get_column("_v")

        return _Value(f"{label}({self.name})" + (f" by {', '.join(group)}" if group else ""), False, compute)

    def null_percentage(self):
        return self._prop("null_percentage", lambda c, df: (c.null_count() / c.len()).fill_nan(0.0))

    def null_count(self):
        return self._prop("null_count", lambda c, df: c.null_count())

    def distinct_count(self):
        return self._prop("distinct_count", lambda c, df: c.drop_nulls().n_unique())

    def approx_distinct_count(self):
        return self._prop("approx_distinct_count", lambda c, df: c.drop_nulls().approx_n_unique())

    def sum(self):
        return self._prop("sum", lambda c, df: c.sum())

    def standard_deviation_sample(self):
        return self._prop("stddev_samp", lambda c, df: c.std(ddof=1))

    def standard_deviation_population(self):
        return self._prop("stddev_pop", lambda c, df: c.std(ddof=0))

    def max_value(self):
        return self._prop("max", lambda c, df: c.max())

    def min_value(self):
        return self._prop("min", lambda c, df: c.min())


class _Group:
    def __init__(self, cols: list[str]) -> None:
        self.cols = cols

    def is_unique(self) -> Expectation:
        def fn(df, env):
            if not self.cols:
                return True, "no columns to group by"
            _need(df, *self.cols)
            dupes = df.height - df.select(self.cols).unique().height
            return dupes == 0, (f"({', '.join(self.cols)}) is unique" if not dupes else f"{dupes:,} rows repeat a ({', '.join(self.cols)}) already seen")

        return _Whole(f"({', '.join(self.cols)}) is unique", fn)

    def count(self) -> _Value:
        def compute(df, env):
            pl = _pl()
            if not self.cols:
                return pl.Series([df.height])
            _need(df, *self.cols)
            return df.group_by(self.cols).agg(pl.len().alias("_v")).get_column("_v")

        return _Value("count" + (f" by {', '.join(self.cols)}" if self.cols else ""), False, compute)

    def col(self, name: str) -> _Col:
        return _Col(name, self.cols)


class _ForeignCol:
    def __init__(self, dataset: str, column: str) -> None:
        self.dataset, self.column = dataset, column

    def frame(self, env):
        ds = env.get("datasets") or {}
        if self.dataset not in ds:
            raise KeyError(f"E.dataset_ref({self.dataset!r}): no input named {self.dataset} in this transform")
        return ds[self.dataset]()


class _DatasetRef:
    def __init__(self, name: str) -> None:
        self.name = name

    def col(self, column: str) -> _ForeignCol:
        return _ForeignCol(self.name, column)

    def count(self) -> _Value:
        pl = _pl()
        return _Value(f"count({self.name})", False, lambda df, env: pl.Series([_ForeignCol(self.name, "").frame(env).height]))


class _Schema:
    def _check(self, mode: str, spec: dict) -> Expectation:
        def fn(df, env):
            actual = dict(df.schema)
            missing = [k for k in spec if k not in actual]
            wrong = [f"{k} is {actual[k]} (expected {_type_name(v)})" for k, v in spec.items() if k in actual and not _type_matches(actual[k], v)]
            extra = [k for k in actual if k not in spec]
            problems = []
            if mode in ("contains", "equals") and missing:
                problems.append(f"missing {', '.join(missing)}")
            if wrong:
                problems.append("; ".join(wrong))
            if mode in ("equals", "is_subset_of") and extra:
                problems.append(f"unexpected {', '.join(extra)}")
            return not problems, ("; ".join(problems) if problems else f"schema {mode.replace('_', ' ')} the expected columns")

        return _Whole(f"schema {mode} {list(spec)}", fn)

    def contains(self, spec: dict):
        return self._check("contains", spec)

    def equals(self, spec: dict):
        return self._check("equals", spec)

    def is_subset_of(self, spec: dict):
        return self._check("is_subset_of", spec)


def _primary_key(*cols: str) -> Expectation:
    def fn(df, env):
        _need(df, *cols)
        nulls = [c for c in cols if df.get_column(c).null_count()]
        dupes = df.height - df.select(list(cols)).unique().height
        problems = [f"{c} has {df.get_column(c).null_count():,} nulls" for c in nulls]
        if dupes:
            problems.append(f"{dupes:,} duplicate keys")
        return not problems, ("; ".join(problems) if problems else f"({', '.join(cols)}) is a primary key")

    return _Whole(f"primary key ({', '.join(cols)})", fn)


def module() -> types.ModuleType:
    """The transforms.expectations module."""
    m = types.ModuleType("transforms.expectations")
    m.true = lambda: _Const(True)
    m.false = lambda: _Const(False)
    m.all = lambda *items: _All(list(items))
    m.any = lambda *items: _Any(list(items))
    m.negate = lambda item: _Negate(item)
    m.col = lambda name: _Col(name)
    m.group_by = lambda *cols: _Group(list(cols))
    m.count = lambda: _Group([]).count()
    m.primary_key = _primary_key
    m.schema = lambda: _Schema()
    m.when = lambda cond, then: _When(cond, then)
    m.dataset_ref = lambda name: _DatasetRef(name)
    m.Check = Check
    m.Expectation = Expectation
    return m


def evaluate(checks: list[Check], table, target: str, kind: str, datasets: dict[str, Callable]) -> list[dict]:
    """Results of checks on an Arrow table: {id, name, ok, message, mode (abort | warn), kind, target, target_kind}."""
    import polars as pl

    df = pl.from_arrow(table) if table is not None else pl.DataFrame()
    if isinstance(df, pl.Series):
        df = df.to_frame()
    env: dict[str, Any] = {"datasets": datasets, "now": datetime.now(timezone.utc)}
    out = []
    for c in checks:
        try:
            ok, msg = c.expectation.evaluate(df, env)
        except Exception as e:  # noqa: BLE001 - a broken expectation fails its check
            ok, msg = False, f"the expectation could not be evaluated: {type(e).__name__}: {e}"
        out.append({"id": c.name, "name": c.name, "ok": bool(ok), "message": msg, "mode": "abort" if c.on_error == "FAIL" else "warn",
                    "kind": "check", "target": target, "target_kind": kind, "description": c.description})
    return out
