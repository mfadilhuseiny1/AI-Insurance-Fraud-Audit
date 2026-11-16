"""Contour on Spark (contour_scale.py): a path's boards as Spark SQL over its datasets' Parquet files.

Each board becomes a Spark SQL query over the previous board's result (a temporary view in a session of its own, so
runs do not see each other's views or settings), mirroring the DuckDB queries of contour_engine.py: filter conditions,
expressions (written in DuckDB SQL or Contour's Spark SQL; both translated to Spark SQL with sqlglot), the column
editor, reorder, sort, join / enrich (left, inner, right, full, semi, anti), set math, transform data, unpivot, remove
duplicates, and the visualizations' data (table, histogram, distribution, time series, bar / line / pie charts, heat
grid, pivot table, summary statistics) with selections and "switch to aggregated data". A `/` divides as DOUBLE, as
in DuckDB (Spark would keep DECIMAL operands such as 997.0 DECIMAL, with fewer digits).

Map boards run contour_viz.py's own queries (DuckDB SQL) on Spark through VizComp: each query translated with sqlglot
(viz_sql: isfinite as |x| < infinity, LOG10 kept as log10), so every layer — points with sizes, clusters / heatmap
cells, boundary and GeoJSON-column choropleths, lines — and the board's selection (clicked points, regions, lines,
shape keys, circles, polygons) are the same queries as on DuckDB. A column read as a number (TRY_CAST(col AS DOUBLE)
straight from the board's rows) is cast as DuckDB casts its type (duck_double): numbers and booleans alike, text
parsed by DuckDB's rules (whitespace, '+-7', '1_000', '-nan' accepted; hex, '1d', NUL characters not), dates and
timestamps NULL — also when the cast reads the column through a subquery that passes it on as it is (a point layer's
scaled color, cast again from the layer's points). A map runs on Spark only when no column a layer writes as text (tooltip, category colors, region ids) is a float / double
(Spark writes 1.0E7 where DuckDB writes 10000000.0), and GeoJSON columns are text (shape keys are md5 of that text);
otherwise the path runs on DuckDB with a note. Floating aggregates of cells (centroids, sums, averages) may differ in
the last digits; which points / shapes come back past a layer's limit can differ when rows are tied in a sort.

Scatter boards run contour_viz.scatter_result through VizComp the same way: the statistics (count, plotted range,
REGR_SLOPE / REGR_INTERCEPT / REGR_R2 — Spark 3.4+ has them under the same names), the points up to the point limit or
the density cells beyond it (the same cell formula over the same range), the color scale or categories, the size range,
and a brushed rectangle / clicked category selection (contour_viz.scatter_filter, translated). x, y and size may be
numbers, booleans, text, dates or timestamps (cast as DuckDB casts them, as for maps); a color column is numeric (a
scale) or text, boolean, date or timestamp (categories, written alike as text). A scatter switched to its rows
("switch to aggregated data") runs on Spark when its input has at most 5,000 rows (all of them); over that DuckDB's
LIMIT 5000 keeps rows without an order, so the path runs on DuckDB with a note, as for a column of another type.
Counts, cells and categories are exact; the trend's slope / intercept / r², averaged sizes per cell and the log10 of a
log axis may differ in the last digits (Java's log10 vs the C library's: a point exactly on a cell edge could then
fall into the neighbouring cell).

Dates before 1582 and timestamps before 1900 are read as written (datetimeRebaseModeInRead CORRECTED: the files are
pyarrow's / DuckDB's, proleptic Gregorian).

Not supported (the path then runs on DuckDB, with a note): object type and restricted view sources, datasets with a
time-zoned timestamp column (DuckDB gives it in its own time zone, '2024-01-09T11:20:25+07:00') or a time-of-day
column (Spark cannot read Parquet TIME), scatters and maps as above,
Cipher boards, buckets other than minute … year, pivot columns with median / stddev / distinct, regex
replacements with \\ or $ in the replacement, casts to types without a Spark equivalent, and casts of fractional
columns to integer types (DuckDB rounds, Spark truncates). Known differences on supported boards: numbers cast to text
(filters' "is", contains) are written alike except extreme doubles (1e+20 vs 1.0E20, inf vs Infinity) — pivot column
names are DuckDB's own (the values are cast to text by DuckDB, NULL gets no column, as PIVOT does); floating sums may differ in the last digits (summation order); a remove-duplicates on some columns keeps
an arbitrary row of each group in both engines; rows tied in a board's sort order may come in another order. ANSI mode
is on, so a value that does not convert fails the Spark run (and DuckDB then runs the path and reports the error).

The session is the process' local Spark (code_pyapi.spark_session: the JDK 17 in .java/, the Windows worker fix),
started on first use within BLUESANDAI_CONTOUR_SPARK_TIMEOUT seconds (120); after a failed start Spark is not tried
again for 10 minutes. BLUESANDAI_CONTOUR_SPARK=off turns the tier off.
"""

from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import pyarrow as pa

import contour_engine as E


class Unsupported(Exception):
    """A board or source Spark does not run here: the path runs on DuckDB."""


class SparkUnavailable(Exception):
    """Spark could not start."""


_STATE: dict[str, Any] = {"session": None, "failed_at": 0.0, "error": None}
_LOCK = threading.Lock()
RETRY_AFTER = 600.0


def session(timeout: Optional[float] = None):
    """The process' local SparkSession, started on first use (in a thread, so a JVM that hangs does not hang the
    request past `timeout`)."""
    if (os.environ.get("BLUESANDAI_CONTOUR_SPARK") or "").lower() in ("off", "0", "false", "no"):
        raise SparkUnavailable("the Spark tier is turned off (BLUESANDAI_CONTOUR_SPARK)")
    timeout = timeout if timeout is not None else float(os.environ.get("BLUESANDAI_CONTOUR_SPARK_TIMEOUT") or 120)
    with _LOCK:
        if _STATE["session"] is not None:
            return _STATE["session"]
        if _STATE["error"] and time.time() - _STATE["failed_at"] < RETRY_AFTER:
            raise SparkUnavailable(_STATE["error"])
        box: dict[str, Any] = {}

        def start() -> None:
            try:
                import code_pyapi

                s = code_pyapi.spark_session()
                box["s"] = s
                _STATE.update(session=s, error=None)
            except BaseException as e:  # noqa: BLE001 — a missing JDK, a JVM that does not start, …
                box["e"] = e

        th = threading.Thread(target=start, name="contour-spark-start", daemon=True)
        th.start()
        th.join(timeout)
        if "s" in box:
            return box["s"]
        msg = f"Spark did not start within {timeout:g} s" if th.is_alive() else f"Spark could not start: {str(box.get('e'))[:300]}"
        _STATE.update(failed_at=time.time(), error=msg)
        raise SparkUnavailable(msg)


def bq(name: str) -> str:
    return "`" + str(name).replace("`", "``") + "`"


def slit(v: Any) -> str:
    """A Spark SQL literal (backslashes escape in Spark's string literals)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return repr(v)
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return f"CAST('{'NaN' if v != v else ('Infinity' if v > 0 else '-Infinity')}' AS DOUBLE)"
        return f"CAST({v!r} AS DOUBLE)"
    if isinstance(v, (list, tuple)):
        return "array(" + ", ".join(slit(x) for x in v) + ")"
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _s(v: Any) -> str:
    return slit(str(v))


def duck_names(names: list[str]) -> list[str]:
    """The column names DuckDB gives a board's SELECT list: a repeated name (case-insensitively) becomes name_1, … —
    asked of DuckDB itself (a subquery binds them), so a join or a new column named like an existing one is named as
    the in-memory engine names it (Spark would keep two columns of the same name)."""
    if len({n.lower() for n in names}) == len(names):
        return list(names)
    import duckdb

    con = duckdb.connect(config={"enable_external_access": False})
    try:
        sel = ", ".join(f"NULL AS {E.q(n)}" for n in names)
        return [d[0] for d in con.execute(f"SELECT * FROM (SELECT {sel}) LIMIT 0").description]
    finally:
        con.close()


def _select(items: list[tuple[str, str]]) -> str:
    """A SELECT list of (expression, output name) pairs, named as DuckDB names them (duck_names)."""
    names = duck_names([n for _, n in items])
    return ", ".join(f"{e} AS {bq(n)}" for (e, _), n in zip(items, names))


TS_UNITS = ("minute", "hour", "day", "week", "month", "quarter", "year")
JOINS = {"LEFT": "LEFT", "INNER": "INNER", "RIGHT": "RIGHT", "FULL": "FULL OUTER", "SEMI": "LEFT SEMI", "ANTI": "LEFT ANTI"}
CASTS = {"VARCHAR": "STRING", "TEXT": "STRING", "STRING": "STRING", "DOUBLE": "DOUBLE", "FLOAT8": "DOUBLE", "FLOAT": "FLOAT", "REAL": "FLOAT",
         "FLOAT4": "FLOAT", "BIGINT": "BIGINT", "INT8": "BIGINT", "LONG": "BIGINT", "INTEGER": "INT", "INT": "INT", "INT4": "INT",
         "SMALLINT": "SMALLINT", "INT2": "SMALLINT", "TINYINT": "TINYINT", "INT1": "TINYINT", "BOOLEAN": "BOOLEAN", "BOOL": "BOOLEAN",
         "DATE": "DATE", "TIMESTAMP": "TIMESTAMP"}
INTEGER_CASTS = ("BIGINT", "INT", "SMALLINT", "TINYINT")
SWITCH_ROWS = 5000  # a scatter switched to its rows keeps this many (contour_engine.visual_sql)


def _cast_type(t: str) -> str:
    u = str(t or "").strip().upper()
    m = re.fullmatch(r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", u)
    if m:
        return f"DECIMAL({m.group(1)},{m.group(2)})"
    if u not in CASTS:
        raise Unsupported(f"a cast to {t} has no Spark equivalent here")
    return CASTS[u]


def _agg(metric: Optional[str], column: Optional[str]) -> str:
    m = (metric or "count").lower()
    if m == "count":
        return "COUNT(*)"
    if not column:
        raise E.ContourError(f"{m} needs a column")
    if m == "distinct":
        return f"COUNT(DISTINCT {bq(column)})"
    if m in ("sum", "avg", "min", "max", "median"):
        return f"{m.upper()}({bq(column)})"
    if m == "stddev":
        return f"STDDEV_SAMP({bq(column)})"
    raise E.ContourError(f"unknown metric {metric}")


def _bucket(column: str, bucket: Optional[str]) -> str:
    if not bucket or bucket == "none":
        return bq(column)
    if bucket not in TS_UNITS:
        raise Unsupported(f"the {bucket} bucket")
    return f"date_trunc({slit(bucket)}, try_cast({bq(column)} AS TIMESTAMP))"


def check(a: dict, path_id: str) -> None:
    """Unsupported when the path (or a path it reads) has a board or source Spark does not run here."""
    paths = {p["id"]: p for p in a.get("paths") or []}
    seen: set[str] = set()

    def src(s: Optional[dict]) -> None:
        if not isinstance(s, dict):
            return
        if s.get("kind") == "path":
            visit(s.get("id"))
        elif s.get("kind") != "dataset":
            raise Unsupported({"object_type": "an object type source", "restricted_view": "a restricted view source"}.get(s.get("kind"), f"a {s.get('kind')} source"))

    def visit(pid: Optional[str]) -> None:
        if not pid or pid in seen or pid not in paths:
            return
        seen.add(pid)
        p = paths[pid]
        src(p.get("source"))
        for b in p.get("boards") or []:
            t, c = b.get("type"), b.get("config") or {}
            label = f"the {t.replace('_', ' ')} board" + (f" \"{b['title']}\"" if b.get("title") else "")
            if t == "cipher":
                raise Unsupported(label)
            if t == "map":
                import contour_viz

                for l in contour_viz.map_layers(c):
                    src(l.get("source"))
            if t in ("join", "enrich", "set_math"):
                src(c.get("source"))
            if t == "join" and (c.get("how") or "left").upper() not in JOINS:
                raise Unsupported(f"a {c.get('how')} join")
            if t in ("time_series", "chart") and (c.get("bucket") or ("day" if t == "time_series" else "none")) not in (*TS_UNITS, "none"):
                raise Unsupported(f"the {c.get('bucket')} bucket of {label}")
            if t == "transform_data" and (c.get("op") == "regex_replace") and re.search(r"[\\$]", c.get("replace") or ""):
                raise Unsupported(f"{label}: a regex replacement with \\ or $ (group references are written differently)")
            if t == "pivot" and c.get("columns") and ((c.get("values") or [{}])[0].get("metric") or "count") not in ("count", "sum", "avg", "min", "max"):
                raise Unsupported(f"{label}: pivot columns with {(c.get('values') or [{}])[0].get('metric')}")
            if t == "edit_columns":
                for ty in (c.get("casts") or {}).values():
                    _cast_type(ty)

    visit(path_id)


def to_arrow(df, limit: Optional[int] = None) -> pa.Table:
    """A Spark DataFrame's rows as an Arrow table (timestamps as DuckDB gives them: without a time zone, in UTC)."""
    if limit is not None:
        df = df.limit(int(limit))
    batches = df._collect_as_arrow()
    if batches:
        t = pa.Table.from_batches(batches)
    else:
        from pyspark.sql.pandas.types import to_arrow_schema

        t = to_arrow_schema(df.schema).empty_table()
    cols, fields = [], []
    for f, col in zip(t.schema, t.columns):
        if pa.types.is_timestamp(f.type) and f.type.tz:
            col = col.cast(pa.timestamp(f.type.unit))
            f = pa.field(f.name, col.type)
        cols.append(col)
        fields.append(f)
    return pa.Table.from_arrays(cols, schema=pa.schema(fields))


def double_div(node):
    """DuckDB's `/` divides as DOUBLE whatever its operands (1.5 / 2.0 is a DOUBLE); Spark keeps DECIMAL operands
    DECIMAL, with fewer digits (-19.43832 where DuckDB gives -19.438314944834502): both operands cast to DOUBLE."""
    from sqlglot import exp

    if isinstance(node, exp.Div) and not isinstance(node, exp.IntDiv):
        for k in ("this", "expression"):
            v = node.args.get(k)
            if v is not None and not (isinstance(v, exp.Cast) and v.to.this == exp.DataType.Type.DOUBLE):
                node.set(k, exp.cast(v.copy(), "DOUBLE"))
    return node


NUMERIC_TYPES = ("byte", "short", "integer", "long", "float", "double", "decimal")
# columns a map / scatter may read as numbers (TRY_CAST(... AS DOUBLE)): numbers and booleans cast alike, text is
# parsed as DuckDB parses it (duck_text_double), dates and timestamps are NULL in DuckDB (it has no such cast)
AS_NUMBER_TYPES = (*NUMERIC_TYPES, "boolean", "string", "date", "timestamp", "timestamp_ntz")

# DuckDB's TRY_CAST(text AS DOUBLE): ASCII whitespace around, a leading '+' then an optional '-' ('+-7' is -7, '--7'
# NULL), digits with single underscores between them ('1_000', '1.5_5', '1e1_0'), an optional fraction and exponent,
# nan / inf / infinity in any case with a sign; no hex, no 'd' / 'f' suffixes, no NUL characters (Spark's own cast
# accepts those and rejects '1_000', '-nan')
_WS = r"[ \t\n\r\x0B\f]"
_DIG = r"[0-9]+(?:_[0-9]+)*"
_NUM = rf"(?:{_DIG}(?:\.(?:{_DIG})?)?|\.{_DIG})(?:[eE][+-]?{_DIG})?"
_RE_NAN = rf"^{_WS}*\+?-?(?i:nan){_WS}*$"
_RE_NUM = rf"^{_WS}*\+?-?(?:{_NUM}|(?i:inf|infinity)){_WS}*$"
_DROP = r"[ \t\n\r\x0B\f_]"
_PLUS = r"^\+"


def duck_text_double(col: str) -> str:
    """DuckDB's TRY_CAST of a text column (Spark SQL `col`) to DOUBLE, in Spark SQL: the text checked against DuckDB's
    grammar, then whitespace, underscores and a leading '+' dropped and the rest cast (both engines round to the
    nearest double; out of range is ±infinity in both)."""
    clean = f"regexp_replace(regexp_replace({col}, {slit(_DROP)}, ''), {slit(_PLUS)}, '')"
    return (f"(CASE WHEN {col} RLIKE {slit(_RE_NAN)} THEN CAST('NaN' AS DOUBLE) "
            f"WHEN {col} RLIKE {slit(_RE_NUM)} THEN TRY_CAST({clean} AS DOUBLE) END)")


def duck_double(col: str, spark_type: str) -> str:
    """DuckDB's TRY_CAST(col AS DOUBLE) for a column of the given Spark type, in Spark SQL."""
    if spark_type in NUMERIC_TYPES or spark_type == "boolean":
        return f"TRY_CAST({col} AS DOUBLE)"
    if spark_type == "string":
        return duck_text_double(col)
    if spark_type in ("date", "timestamp", "timestamp_ntz"):
        return "CAST(NULL AS DOUBLE)"
    raise Unsupported(f"a {spark_type} column read as a number")


def viz_sql(duck: str, views: Optional[dict] = None) -> str:
    """A query contour_viz.py wrote in DuckDB SQL, as Spark SQL (sqlglot). Spark has no isfinite: |x| < infinity is
    false for NaN and ±infinity and NULL for NULL, as isfinite is in DuckDB. LOG10 stays log10 (sqlglot would write
    LOG(10, x), ln(x) / ln(10), which differs from log10 in the last digits and moves values across size bins).
    `views` ({view name: {column: Spark type}}): a TRY_CAST(column AS DOUBLE) in a SELECT reading one of these views
    directly, or a subquery's column that is such a view's column as it is, is written as DuckDB casts that column's
    type (duck_double) — text parsed by DuckDB's rules, dates and timestamps NULL; casts of computed columns (already
    numbers) stay as they are."""
    import sqlglot
    from sqlglot import exp

    swaps: dict[str, str] = {}

    def view_column(node) -> Optional[str]:
        """The Spark type of a TRY_CAST's column when it is a known view's column (column_type), else None."""
        if not views or not isinstance(node.this, exp.Column):
            return None
        return column_type(node.find_ancestor(exp.Select), node.this.name, 0)

    def column_type(sel, name: str, depth: int) -> Optional[str]:
        """The Spark type of column `name` read by SELECT `sel`: from a known view directly, or through a subquery
        whose column of that name is a known view's column as it is (`SELECT …, kat AS color FROM view`)."""
        frm = (sel.args.get("from_") or sel.args.get("from")) if sel is not None else None  # "from_" in sqlglot 30
        if frm is None or sel.args.get("joins") or depth > 4:
            return None
        if isinstance(frm.this, exp.Table):
            types = views.get(frm.this.name)
            if not types:
                return None
            return types.get(name) or next((t for k, t in types.items() if k.lower() == name.lower()), None)
        if isinstance(frm.this, exp.Subquery) and isinstance(frm.this.this, exp.Select):
            inner = frm.this.this
            for p in inner.expressions:
                if p.alias_or_name.lower() == name.lower():
                    src = p.this if isinstance(p, exp.Alias) else p
                    return column_type(inner, src.name, depth + 1) if isinstance(src, exp.Column) else None
        return None

    def numcast(node):
        if isinstance(node, exp.TryCast) and node.to.this == exp.DataType.Type.DOUBLE:
            t = view_column(node)
            if t is not None and t not in NUMERIC_TYPES:
                token = f"ctnum{len(swaps)}x{os.getpid()}"
                swaps[token] = duck_double(bq(node.this.name), t)
                return exp.column(token)
        return node

    def fix(node):
        if isinstance(node, exp.Anonymous) and node.name.lower() == "isfinite" and len(node.expressions) == 1:
            return exp.LT(this=exp.Abs(this=node.expressions[0].copy()), expression=exp.cast(exp.Literal.string("Infinity"), "DOUBLE"))
        if isinstance(node, exp.Log) and node.expression is not None and isinstance(node.this, exp.Literal) and str(node.this.this) == "10":
            return exp.Anonymous(this="log10", expressions=[node.expression.copy()])
        return double_div(node)

    try:
        # the casts first, while every node still has its SELECT above it (fix's replacements hold copies)
        tree = sqlglot.parse_one(duck, read="duckdb").transform(numcast).transform(fix)
        out = tree.sql(dialect="spark")
    except Unsupported:
        raise
    except Exception:  # noqa: BLE001
        raise Unsupported("a map / scatter query (not translatable to Spark SQL)") from None
    for token, sql in swaps.items():
        out, n = re.subn(rf"`?\b{token}\b`?", lambda _m, s=sql: s, out)
        if n < 1:
            raise Unsupported("a map / scatter query (a numeric cast not translated)")
    return out


def map_check(c: dict, types_of: Callable[[Optional[dict]], dict]) -> None:
    """Unsupported unless every layer's columns read the same on Spark as on DuckDB (see the module notes).
    `types_of(layer source or None)` gives {column: Spark type name} of the layer's rows."""
    import contour_viz

    for l in contour_viz.map_layers(c):
        t = l.get("type") or "point"
        types = types_of(l.get("source"))
        name = f"the map layer {l.get('name') or l.get('id')}"
        metric = (l.get("metric") or "count").lower()
        mode = l.get("color_mode") or "single"
        numeric = [l.get(k) for k in ("lat", "lon", "lat2", "lon2")]
        text = [l.get("tooltip")]
        if t == "point":
            if l.get("size_mode") == "column":
                numeric.append(l.get("size_column"))
            (numeric if mode == "scale" else text).append(l.get("color_column") if mode in ("scale", "value") else None)
        if t in ("cluster", "heatmap", "choropleth") and metric not in ("count", "distinct"):
            numeric.append(l.get("metric_column"))
        if t == "choropleth" and (l.get("choropleth_kind") or "boundaries") == "boundaries":
            text.append(l.get("region_column"))
        if t in ("choropleth", "line") and mode in ("scale", "value"):
            (numeric if mode == "scale" else text).append(l.get("value_column"))
        geo = contour_viz.shape_column(l)
        for col in numeric:
            if col and col in types and types[col] not in AS_NUMBER_TYPES:
                raise Unsupported(f"{name}: the {types[col]} column {col} read as a number")
        for col in text:
            if col and types.get(col) in ("float", "double"):
                raise Unsupported(f"{name}: the fractional column {col} written as text (Spark writes 1.0E7 where DuckDB writes 10000000.0)")
        if geo and geo in types and types[geo] != "string":
            raise Unsupported(f"{name}: the {types[geo]} GeoJSON column {geo} (shape keys are md5 of the text)")


# written alike as text by both engines: timestamps too ('2024-01-01 00:00:00.5' in both) — a dataset's zoned
# timestamp columns run on DuckDB (SparkRun.source), so a Spark TIMESTAMP here comes from a cast of DuckDB's plain one
CATEGORY_TYPES = ("string", "boolean", "date", "timestamp_ntz", "timestamp")


def scatter_check(c: dict, types: dict) -> None:
    """Unsupported unless the scatter's columns read the same on Spark as on DuckDB (see the module notes).
    `types` is {column: Spark type name} of the board's rows; a missing column is left to the run (DuckDB reports it)."""
    for k in ("x", "y", "size"):
        col = c.get(k)
        if col and col in types and types[col] not in AS_NUMBER_TYPES:
            raise Unsupported(f"the scatter chart's {k} column {col} ({types[col]}) read as a number")
    col = c.get("color")
    if col and col in types and types[col] not in NUMERIC_TYPES and types[col] not in CATEGORY_TYPES:
        raise Unsupported(f"the scatter chart's {types[col]} color column {col} (written as text differently)")


class VizComp:
    """What contour_viz.py needs of a compiler (run, count, source), on a Spark run: its DuckDB queries translated by
    viz_sql over the run's temporary views."""

    def __init__(self, run: "SparkRun") -> None:
        self.r = run

    def source(self, src: dict) -> str:
        return self.r.view(self.r.source(src))

    def run(self, sql: str, limit: Optional[int] = None) -> pa.Table:
        return to_arrow(self.r.sql(viz_sql(sql, self.r.view_types)), limit)

    def count(self, rel: str) -> int:
        return int(self.run(f"SELECT COUNT(*) AS n FROM {rel}").column(0)[0].as_py())


class SparkRun:
    """One request's path on Spark: DataFrames per (path, board count) and per source."""

    def __init__(self, a: dict, params: dict, spark, dataset_file: Callable[[dict], str],
                 boundaries: Optional[Callable[[str], list[dict]]] = None) -> None:
        self.a, self.params = a, params
        # a map board's boundaries files (contour._boundaries); without it a boundaries choropleth runs on DuckDB
        self.boundaries = boundaries
        self.spark = spark.newSession()
        self.spark.conf.set("spark.sql.session.timeZone", "UTC")
        self.spark.conf.set("spark.sql.ansi.enabled", "true")
        self.spark.conf.set("spark.sql.caseSensitive", "false")
        # a scatter's density cells join the plotted rows with their one-row range (FROM base b, (SELECT MIN …) r)
        self.spark.conf.set("spark.sql.crossJoin.enabled", "true")
        # Parquet files here are written by pyarrow / DuckDB (proleptic Gregorian): dates before 1582 and timestamps
        # before 1900 are read as they are (Spark would refuse them, guessing at a Spark 2 hybrid calendar)
        self.spark.conf.set("spark.sql.parquet.datetimeRebaseModeInRead", "CORRECTED")
        self.spark.conf.set("spark.sql.parquet.int96RebaseModeInRead", "CORRECTED")
        self.dataset_file = dataset_file
        self.paths = {p["id"]: p for p in a.get("paths") or []}
        self.dfs: dict[tuple, Any] = {}
        self.srcs: dict[str, Any] = {}
        self.views: list[str] = []
        self.view_types: dict[str, dict] = {}  # {view: {column: Spark type}} for viz_sql's numeric casts
        self.visiting: set[str] = set()

    def close(self) -> None:
        for v in self.views:
            try:
                self.spark.catalog.dropTempView(v)
            except Exception:  # noqa: BLE001
                pass

    def view(self, df) -> str:
        name = f"contour_v{len(self.views)}"
        df.createOrReplaceTempView(name)
        self.views.append(name)
        self.view_types[name] = self.types(df)
        return name

    def sql(self, q: str):
        return self.spark.sql(q)

    def expr(self, text: str) -> str:
        """A board's expression (DuckDB SQL, or Spark SQL translated to DuckDB by subst) as Spark SQL."""
        duck = E.subst(text, self.params)
        if not duck.strip():
            return duck
        import sqlglot

        try:
            return sqlglot.parse_one(duck, read="duckdb").transform(double_div).sql(dialect="spark")
        except Exception:  # noqa: BLE001
            raise Unsupported(f"the expression {text[:80]!r} (not translatable to Spark SQL)") from None

    # -- sources and paths

    def source(self, src: dict):
        kind = src.get("kind")
        if kind == "path":
            return self.path_df(src["id"], None)
        if kind != "dataset":
            raise Unsupported(f"a {kind} source")
        key = f"{kind}:{src.get('id')}"
        if key not in self.srcs:
            import pyarrow.parquet as pq

            local = self.dataset_file(src)
            for f in pq.read_schema(local):
                # Spark 3.5 cannot read nanosecond timestamps nor unsigned 64-bit integers from Parquet
                if (pa.types.is_timestamp(f.type) and f.type.unit == "ns") or pa.types.is_uint64(f.type):
                    raise Unsupported(f"the {'nanosecond timestamp' if pa.types.is_timestamp(f.type) else 'unsigned 64-bit'} column {f.name}")
                # DuckDB gives a zoned timestamp in its own time zone ('2024-01-09T11:20:25+07:00'); Spark's come back
                # without a zone, in UTC (as its own TIMESTAMPs from casts must, to match DuckDB's plain TIMESTAMP)
                if pa.types.is_timestamp(f.type) and f.type.tz:
                    raise Unsupported(f"the time-zoned timestamp column {f.name}")
                # Spark 3.5 cannot read Parquet TIME columns
                if pa.types.is_time(f.type):
                    raise Unsupported(f"the time-of-day column {f.name}")
            self.srcs[key] = self.spark.read.parquet(Path(local).as_uri())
        return self.srcs[key]

    def path_df(self, path_id: str, upto: Optional[int]):
        p = self.paths.get(path_id)
        if not p:
            raise E.ContourError(f"no path {path_id}")
        boards = p.get("boards") or []
        n = len(boards) if upto is None else upto
        if (path_id, n) in self.dfs:
            return self.dfs[(path_id, n)]
        if path_id in self.visiting and upto is None:
            raise E.ContourError("a path cannot start from its own result")
        self.visiting.add(path_id)
        try:
            df = self.source(p["source"]) if n == 0 else self.board(boards[n - 1], self.path_df(path_id, n - 1))
        finally:
            self.visiting.discard(path_id)
        self.dfs[(path_id, n)] = df
        return df

    # -- boards

    def condition(self, c: dict) -> str:
        col = bq(c["column"])
        s = f"CAST({col} AS STRING)"
        op = c.get("op") or "is"
        vals = [E._value(v, self.params) for v in (c.get("values") if c.get("values") is not None else [c.get("value")])]
        flat: list[Any] = []
        for v in vals:
            flat.extend(v if isinstance(v, list) else [v])
        vals = [v for v in flat if v is not None and v != ""]
        if op == "is_null":
            sql = f"{col} IS NULL"
        elif op == "not_null":
            sql = f"{col} IS NOT NULL"
        elif not vals:
            return "TRUE"
        elif op == "is":
            sql = "(" + " OR ".join(f"{s} = {_s(v)}" for v in vals) + ")"
        elif op == "is_wild":
            sql = "(" + " OR ".join(f"{s} ILIKE {slit(E._wild(str(v)))}" for v in vals) + ")"
        elif op == "contains":
            sql = "(" + " OR ".join(f"contains(lower({s}), lower({_s(v)}))" for v in vals) + ")"
        elif op == "contains_wild":
            sql = "(" + " OR ".join(f"{s} ILIKE {slit('%' + E._wild(str(v)) + '%')}" for v in vals) + ")"
        elif op == "matches":
            sql = "(" + " OR ".join(f"{s} RLIKE {_s(v)}" for v in vals) + ")"
        elif op in ("eq", "neq", "gt", "gte", "lt", "lte"):
            sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            v = vals[0]
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                sql = f"{col} {sym} {slit(v)}"
            else:
                try:
                    sql = f"try_cast({col} AS DOUBLE) {sym} {slit(float(v))}"
                except ValueError:
                    sql = f"{s} {sym} {_s(v)}"
        elif op == "between":
            lo, hi = (vals + [None, None])[:2]
            sql = f"{col} BETWEEN {slit(lo)} AND {slit(hi)}"
        elif op == "in":
            sql = f"{s} IN ({', '.join(_s(v) for v in vals)})"
        else:
            raise E.ContourError(f"unknown filter operator {op}")
        return f"NOT ({sql})" if c.get("negate") else sql

    def selection(self, b: dict, df):
        sel = b.get("selection")
        if not sel:
            return None
        c = b.get("config") or {}
        if b["type"] == "map":
            # the same condition as on DuckDB (contour_viz.map_filter), translated
            import contour_viz

            self.check_map(c, df)
            cond = contour_viz.map_filter(c, sel if isinstance(sel, list) else [sel])
            return self.sql(viz_sql(f"SELECT * FROM {self.view(df)} WHERE {cond}", self.view_types)) if cond else None
        if b["type"] == "chart" and c.get("kind") == "scatter":
            # brushed rectangles / clicked categories: the DuckDB condition (contour_viz.scatter_filter), translated
            import contour_viz

            scatter_check(c, self.types(df))
            cond = contour_viz.scatter_filter(c, sel if isinstance(sel, list) else [sel])
            return self.sql(viz_sql(f"SELECT * FROM {self.view(df)} WHERE {cond}", self.view_types)) if cond else None
        col = c.get("column") or c.get("x") or c.get("date_column") or ((c.get("rows") or [None])[0])
        if not col:
            return None
        vals = sel if isinstance(sel, list) else [sel]
        if b["type"] in ("time_series",) or (b["type"] == "chart" and c.get("bucket") not in (None, "", "none")):
            cond = " OR ".join(f"{_bucket(col, c.get('bucket') or 'day')} = try_cast({_s(v)} AS TIMESTAMP)" for v in vals)
        else:
            cond = " OR ".join("(" + (f"{bq(col)} IS NULL" if v is None else f"CAST({bq(col)} AS STRING) = {_s(v)}") + ")" for v in vals)
        return self.sql(f"SELECT * FROM {self.view(df)} WHERE {cond}")

    @staticmethod
    def types(df) -> dict:
        return {f.name: f.dataType.typeName() for f in df.schema.fields}

    def check_map(self, c: dict, df) -> None:
        """map_check on the board's rows (and each layer's own source)."""
        map_check(c, lambda src: self.types(self.source(src) if src else df))

    def scatter_board(self, b: dict, df) -> dict:
        """A scatter board's points or density cells, legends and trend (contour_viz.scatter_result) on Spark."""
        import contour_viz

        scatter_check(b.get("config") or {}, self.types(df))
        return contour_viz.scatter_result(VizComp(self), b, self.view(df))

    def map_board(self, b: dict, df) -> dict:
        """A map board's layers (contour_viz.map_result) on Spark."""
        import contour_viz

        c = b.get("config") or {}
        self.check_map(c, df)
        if self.boundaries is None and any((l.get("type") == "choropleth" and (l.get("choropleth_kind") or "boundaries") == "boundaries") for l in contour_viz.map_layers(c)):
            raise Unsupported("a boundaries choropleth without the boundaries files")
        return contour_viz.map_result(VizComp(self), b, self.view(df), self.boundaries or (lambda _i: []))

    def board(self, b: dict, df):
        t = b["type"]
        c = b.get("config") or {}
        if t in E.VISUALS:
            if c.get("switch") and t in ("pivot", "histogram", "chart", "calculation", "time_series", "heatmap"):
                if t == "chart" and c.get("kind") == "scatter" and df.count() > SWITCH_ROWS:
                    # DuckDB keeps "the first" 5,000 rows (LIMIT without an order): only a smaller set is the same set
                    raise Unsupported(f"the scatter chart{' ' + repr(b['title']) if b.get('title') else ''} switched to its rows "
                                      f"over {SWITCH_ROWS:,} rows (DuckDB's LIMIT {SWITCH_ROWS} has no order)")
                return self.visual(b, df)
            sel = self.selection(b, df)
            return df if sel is None else sel
        cols = list(df.columns)
        if t == "filter":
            conds = [self.condition(x) for x in c.get("conditions") or []]
            if c.get("expression"):
                conds.append(f"({self.expr(c['expression'])})")
            if not conds:
                return df
            joined = (" OR " if c.get("mode") == "any" else " AND ").join(conds)
            return self.sql(f"SELECT * FROM {self.view(df)} WHERE {'NOT (' + joined + ')' if c.get('remove') else joined}")
        if t == "expression":
            mode = c.get("mode") or "column"
            expr = self.expr(c.get("expr") or "")
            v = self.view(df)
            if mode == "filter":
                return self.sql(f"SELECT * FROM {v} WHERE {expr}")
            if mode == "aggregate":
                groups = c.get("group_by") or []
                aggs = c.get("aggregates") or [{"name": c.get("name") or "value", "expr": c.get("expr") or ""}]
                sel = _select([(bq(g), g) for g in groups] + [(self.expr(a["expr"]), a["name"]) for a in aggs])
                return self.sql(f"SELECT {sel} FROM {v}" + (f" GROUP BY {', '.join(bq(g) for g in groups)}" if groups else ""))
            name = c.get("name") or "new_column"
            if c.get("replace"):
                if name not in cols:
                    raise E.ContourError(f"no column {name} to replace")
                return self.sql(f"SELECT {', '.join(f'{expr} AS {bq(x)}' if x == name else bq(x) for x in cols)} FROM {v}")
            return self.sql(f"SELECT {_select([(bq(x), x) for x in cols] + [(expr, name)])} FROM {v}")
        if t == "edit_columns":
            casts = c.get("casts") or {}
            renames = c.get("rename") or {}
            types = {f.name: f.dataType.typeName() for f in df.schema.fields}

            def cast(x: str) -> str:
                to = _cast_type(casts[x])
                if to in INTEGER_CASTS and types.get(x) in ("double", "float", "decimal"):
                    raise Unsupported(f"a cast of the fractional column {x} to {casts[x]} (DuckDB rounds, Spark truncates)")
                return f"CAST({bq(x)} AS {to})"

            keep = c.get("keep")
            if keep:
                sel = _select([(cast(x) if x in casts else bq(x), renames.get(x, x)) for x in keep])
                return self.sql(f"SELECT {sel} FROM {self.view(df)}")
            remove = set(c.get("remove") or [])
            missing = [x for x in [*remove, *casts] if x not in cols]
            if missing:
                raise E.ContourError(f"no column {missing[0]}")
            sel = _select([(cast(x) if x in casts else bq(x), renames.get(x, x)) for x in cols if x not in remove])
            return self.sql(f"SELECT {sel} FROM {self.view(df)}")
        if t == "reorder_columns":
            order = c.get("order") or []
            rest = [x for x in cols if x not in order] if c.get("keep_rest", True) else []
            return self.sql(f"SELECT {', '.join(bq(x) for x in [*order, *rest])} FROM {self.view(df)}")
        if t == "sort":
            by = c.get("by") or []
            if not by:
                return df
            return self.sql(f"SELECT * FROM {self.view(df)} ORDER BY " + ", ".join(f"{bq(x['column'])} {'DESC' if x.get('desc') else 'ASC'} NULLS LAST" for x in by))
        if t in ("join", "enrich"):
            other = self.source(c["source"])
            how = "LEFT" if t == "enrich" else (c.get("how") or "left").upper()
            if how not in JOINS:
                raise Unsupported(f"a {how.lower()} join")
            on = c.get("on") or []
            if not on:
                raise E.ContourError("choose the join keys")
            lv, rv = self.view(df), self.view(other)
            cond = " AND ".join(f"l.{bq(x)} = r.{bq(y)}" for x, y in on)
            if how in ("SEMI", "ANTI"):
                return self.sql(f"SELECT l.* FROM {lv} l {JOINS[how]} JOIN {rv} r ON {cond}")
            right = [x for x in other.columns if x not in {y for _, y in on}] if c.get("columns") is None else c["columns"]
            prefix = c.get("prefix") or ""
            sel = _select([(f"l.{bq(x)}", x) for x in cols] + [(f"r.{bq(x)}", prefix + x) for x in right])
            return self.sql(f"SELECT {sel} FROM {lv} l {JOINS[how]} JOIN {rv} r ON {cond}")
        if t == "set_math":
            other = self.source(c["source"])
            op = c.get("op") or "union"
            if op == "union":
                return df.unionByName(other, allowMissingColumns=True)
            keys = c.get("keys") or []
            if not keys:
                raise E.ContourError("choose the key columns")
            cond = " AND ".join(f"l.{bq(k)} = r.{bq(k)}" for k in keys)
            return self.sql(f"SELECT l.* FROM {self.view(df)} l {'LEFT SEMI' if op == 'intersect' else 'LEFT ANTI'} JOIN {self.view(other)} r ON {cond}")
        if t == "transform_data":
            name = c.get("column") or ""
            if name not in cols:
                raise E.ContourError(f"no column {name}")
            s = f"CAST({bq(name)} AS STRING)"
            op = c.get("op") or "find_replace"
            if op == "find_replace":
                e = f"replace({s}, {slit(c.get('find') or '')}, {slit(c.get('replace') or '')})"
            elif op == "regex_replace":
                e = f"regexp_replace({s}, {slit(c.get('find') or '')}, {slit(c.get('replace') or '')})"
            elif op == "obfuscate":
                e = f"md5(concat({s}, {slit(c.get('salt') or '')}))"
            elif op in ("upper", "lower", "trim"):
                e = f"{op}({s})"
            else:
                raise E.ContourError(f"unknown transform {op}")
            return self.sql(f"SELECT {', '.join(f'{e} AS {bq(x)}' if x == name else bq(x) for x in cols)} FROM {self.view(df)}")
        if t == "unpivot":
            ucols = c.get("columns") or []
            if not ucols:
                raise E.ContourError("choose the columns to unpivot")
            missing = [x for x in ucols if x not in cols]
            if missing:
                raise E.ContourError(f"no column {missing[0]}")
            n, v = c.get("name_column") or "column", c.get("value_column") or "value"
            keep = [x for x in cols if x not in ucols]
            stack = f"stack({len(ucols)}, " + ", ".join(f"{slit(x)}, CAST({bq(x)} AS STRING)" for x in ucols) + f") AS ({bq(n)}, {bq(v)})"
            inner = f"SELECT {''.join(bq(x) + ', ' for x in keep)}{stack} FROM {self.view(df)}"
            return self.sql(f"SELECT * FROM ({inner}) WHERE {bq(v)} IS NOT NULL")
        if t == "dedupe":
            keys = c.get("columns") or []
            return df.distinct() if not keys else df.dropDuplicates(list(keys))
        if t == "cipher":
            raise Unsupported("the Cipher board")
        raise E.ContourError(f"unknown board {t}")

    def visual(self, b: dict, df):
        """A visualization's data (contour_engine.visual_sql in Spark SQL)."""
        t = b["type"]
        c = b.get("config") or {}
        src = self.view(df)
        if t in ("table", "export"):
            cols = ", ".join(bq(x) for x in c.get("columns") or []) or "*"
            order = f" ORDER BY {bq(c['sort'])} {'DESC' if c.get('descending') else 'ASC'} NULLS LAST" if c.get("sort") else ""
            return self.sql(f"SELECT {cols} FROM {src}{order}")
        if t == "histogram":
            col = c.get("column") or ""
            if not col:
                raise E.ContourError("choose the histogram's column")
            order = "value DESC" if (c.get("sort") or "value") == "value" else "key"
            return self.sql(f"SELECT {bq(col)} AS key, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} GROUP BY 1 "
                            f"ORDER BY {order} NULLS LAST LIMIT {int(c.get('limit') or 50)}")
        if t == "distribution":
            col = bq(c.get("column") or "")
            bins = max(2, min(int(c.get("bins") or 20), 200))
            return self.sql(f"WITH s AS (SELECT try_cast({col} AS DOUBLE) v FROM {src} WHERE {col} IS NOT NULL), "
                            f"r AS (SELECT MIN(v) lo, MAX(v) hi FROM s) "
                            f"SELECT lo + (hi - lo) / {bins} * LEAST(FLOOR((v - lo) / NULLIF((hi - lo) / {bins}, 0)), {bins - 1}) AS key, COUNT(*) AS value "
                            f"FROM s CROSS JOIN r GROUP BY 1 ORDER BY 1 NULLS LAST")
        if t == "time_series":
            col = c.get("date_column") or ""
            if not col:
                raise E.ContourError("choose the date column")
            series = f", {bq(c['series'])} AS series" if c.get("series") else ""
            grp = ", 2" if c.get("series") else ""
            return self.sql(f"SELECT {_bucket(col, c.get('bucket') or 'day')} AS key{series}, {_agg(c.get('metric'), c.get('metric_column'))} AS value "
                            f"FROM {src} WHERE {bq(col)} IS NOT NULL GROUP BY 1{grp} ORDER BY 1 NULLS LAST")
        if t == "chart":
            x = c.get("x") or ""
            if not x:
                raise E.ContourError("choose the chart's x axis")
            if c.get("kind") == "scatter":
                # switched to its rows (contour_engine.visual_sql's CSV / Quiver form; board() checks the row count)
                extra = (f", {bq(c['color'])} AS color" if c.get("color") else "") + (f", {bq(c['size'])} AS size" if c.get("size") else "")
                return self.sql(f"SELECT {bq(x)} AS key, {bq(c.get('y') or x)} AS value{extra} FROM {src} LIMIT {SWITCH_ROWS}")
            series = f", {bq(c['series'])} AS series" if c.get("series") else ""
            grp = ", 2" if c.get("series") else ""
            return self.sql(f"SELECT {_bucket(x, c.get('bucket'))} AS key{series}, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} "
                            f"GROUP BY 1{grp} ORDER BY {'1' if c.get('kind') == 'line' else 'value DESC'} NULLS LAST LIMIT {int(c.get('limit') or 100)}")
        if t == "heatmap":
            x, y = c.get("x") or "", c.get("y") or ""
            if not x or not y:
                raise E.ContourError("choose the heatmap's two columns")
            return self.sql(f"SELECT {bq(x)} AS x, {bq(y)} AS y, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} GROUP BY 1, 2 LIMIT 2500")
        if t == "pivot":
            rows = c.get("rows") or []
            vals = c.get("values") or [{"metric": "count"}]
            if not rows:
                raise E.ContourError("choose the pivot table's rows")
            sel = ", ".join(bq(r) for r in rows)
            order = ", ".join(f"{bq(r)} ASC NULLS LAST" for r in rows)
            if c.get("columns"):
                return self.pivot_columns(c, rows, vals[0], src, sel, order)
            aggs = ", ".join(f"{_agg(v.get('metric'), v.get('column'))} AS {bq(v.get('name') or (v.get('metric') or 'count') + ('_' + v['column'] if v.get('column') else ''))}" for v in vals)
            return self.sql(f"SELECT {sel}, {aggs} FROM {src} GROUP BY {sel} ORDER BY {order}")
        if t == "calculation":
            ms = c.get("metrics") or [{"name": "rows", "expr": "COUNT(*)"}]
            return self.sql("SELECT " + ", ".join(f"{self.expr(m['expr'])} AS {bq(m.get('name') or 'value')}" for m in ms) + f" FROM {src}")
        if t == "map":
            raise Unsupported("the map board")
        raise E.ContourError(f"unknown board {t}")

    def pivot_columns(self, c: dict, rows: list, v: dict, src: str, sel: str, order: str):
        """A pivot table with a columns field: one aggregate per value (FILTER), named and ordered as DuckDB's PIVOT
        names them: each non-NULL value as DuckDB writes it as text (a NULL value gets no column), sorted as text."""
        import duckdb

        col = c["columns"]
        metric = (v.get("metric") or "count").lower()
        found = to_arrow(self.sql(f"SELECT DISTINCT {bq(col)} AS v, CAST({bq(col)} AS STRING) AS n FROM {src} WHERE {bq(col)} IS NOT NULL LIMIT 1001"))
        if found.num_rows > 1000:
            raise Unsupported("pivot columns with over 1,000 values")
        # the column names DuckDB gives the values (its own cast to text: 1e+20, 1.50 for a DECIMAL(3,2), …)
        con = duckdb.connect(config={"enable_external_access": False})
        try:
            con.register("found", found)
            named = con.execute("SELECT CAST(v AS VARCHAR) AS name, n FROM found").fetchall()
        finally:
            con.close()
        named.sort(key=lambda r: r[0].encode("utf-8"))
        inner = f"(SELECT {sel}, {bq(col)} AS __c, {'1' if metric == 'count' else bq(v.get('column') or '')} AS __v FROM {src})"
        fn = "COUNT" if metric == "count" else metric.upper()
        aggs = [f"{fn}(__v) FILTER (WHERE CAST(__c AS STRING) = {_s(n)}) AS {bq(name)}" for name, n in named]
        return self.sql(f"SELECT {sel}{''.join(', ' + x for x in aggs)} FROM {inner} GROUP BY {sel} ORDER BY {order}")

    # -- a run

    def run_path(self, path_id: str, table_rows: int) -> dict:
        """contour.run_path's result, computed on Spark (a failing board raises: the caller runs DuckDB instead)."""
        p = self.paths.get(path_id)
        if not p:
            raise E.ContourError("path not found")
        out: dict[str, Any] = {"boards": {}}
        src = self.path_df(path_id, 0)
        out["source"] = {"rows": src.count(), "columns": list(src.columns)}
        for k, b in enumerate(p.get("boards") or []):
            res: dict[str, Any] = {}
            inp = self.path_df(path_id, k)
            if b["type"] == "map":
                res.update(self.map_board(b, inp))
            elif b["type"] == "chart" and (b.get("config") or {}).get("kind") == "scatter":
                res.update(self.scatter_board(b, inp))
            elif b["type"] in E.VISUALS:
                t = to_arrow(self.visual(b, inp), table_rows if b["type"] in ("table", "export") else 5000)
                res["data"] = E.rows_of(t)
                res["data_columns"] = list(t.schema.names)
                if b["type"] in ("table", "export"):
                    res["total"] = inp.count()
            after = self.path_df(path_id, k + 1)
            res["rows"] = after.count()
            res["columns"] = list(after.columns)
            out["boards"][b["id"]] = res
        return out
