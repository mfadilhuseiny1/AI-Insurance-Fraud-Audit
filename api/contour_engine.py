"""Contour's path engine: boards compiled to SQL and run with DuckDB (contour.py).

A path starts from a dataset (a Parquet file in Files), an object type's objects or another path's result, and applies
boards in order. Transform boards change the working data (filter, expression, edit columns, reorder, sort, join,
enrich, set math, transform data, unpivot, remove duplicates); visualization boards show it (table, histogram,
distribution, time series, chart, heatmap, pivot table, calculation, map, export). A visualization with a selection
filters every board below it (chart-to-chart filtering), and one with "switch to aggregated data" makes its result the
working data. Expressions are SQL in Contour's style (Spark-like functions, window functions, CASE WHEN, "quoted"
columns); `$parameter` inserts a parameter's value (an array for multi-value parameters).

Each board compiles to a SELECT over the previous one, chained as CTEs, and DuckDB runs them in memory with external
access disabled (an expression cannot read files or the network). Large datasets are scanned from their Parquet file
instead of read into memory, and a path can run on Spark instead (contour_scale.py, contour_spark.py).
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any, Callable, Optional

import duckdb
import pyarrow as pa

TRANSFORMS = ("filter", "expression", "edit_columns", "reorder_columns", "sort", "join", "enrich", "set_math", "transform_data",
              "unpivot", "dedupe")
VISUALS = ("table", "histogram", "distribution", "time_series", "chart", "heatmap", "pivot", "calculation", "map", "export")
MAX_ROWS = 100_000


class ContourError(Exception):
    pass


def q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(lit(x) for x in v) + "]"
    return "'" + str(v).replace("'", "''") + "'"


def param_values(params_def: list[dict], given: dict) -> dict[str, Any]:
    out = {}
    for p in params_def:
        v = given.get(p["name"], p.get("default"))
        if p.get("multi"):
            v = v if isinstance(v, list) else ([] if v in (None, "") else [v])
            if p.get("type") == "number":
                v = [float(x) for x in v if x not in (None, "")]
        elif p.get("type") == "number" and v not in (None, ""):
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise ContourError(f"parameter {p['name']} must be a number") from None
        out[p["name"]] = v
    return out


# params["__dialect__"]: the analysis' expression dialect ("spark": Contour's Spark SQL, translated to DuckDB)
DIALECT_KEY = "__dialect__"


def subst(expr: str, params: dict) -> str:
    """$parameter → its SQL literal (outside quoted strings and identifiers); a Spark SQL expression is then translated
    to DuckDB SQL."""
    def one(m: re.Match) -> str:
        name = m.group(1)
        if name not in params or name == DIALECT_KEY:
            raise ContourError(f"unknown parameter ${name}")
        return lit(params[name])

    quote = r"('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|`(?:[^`]|``)*`)" if params.get(DIALECT_KEY) == "spark" else r"('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")"
    parts = re.split(quote, expr or "")
    out = "".join(p if i % 2 else re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", one, p) for i, p in enumerate(parts))
    if params.get(DIALECT_KEY) == "spark" and out.strip():
        return spark_expression(out)
    return out


def spark_expression(expr: str) -> str:
    """A Spark SQL expression (Contour's expression language) as DuckDB SQL."""
    import sqlglot

    try:
        return sqlglot.parse_one(expr, read="spark").sql(dialect="duckdb")
    except sqlglot.errors.ParseError as e:
        raise ContourError(f"expression: {str(e).splitlines()[0][:300]}") from None


def _value(v: Any, params: dict) -> Any:
    if isinstance(v, str) and v.startswith("$") and v[1:] in params:
        return params[v[1:]]
    return v


def _wild(term: str) -> str:
    return term.replace("%", r"\%").replace("_", r"\_").replace("*", "%").replace("?", "_")


def _condition(c: dict, params: dict) -> str:
    col = q(c["column"])
    op = c.get("op") or "is"
    vals = [_value(v, params) for v in (c.get("values") if c.get("values") is not None else [c.get("value")])]
    flat: list[Any] = []
    for v in vals:
        flat.extend(v if isinstance(v, list) else [v])
    vals = [v for v in flat if v is not None and v != ""]
    if op == "is_null":
        sql = f"{col} IS NULL"
    elif op == "not_null":
        sql = f"{col} IS NOT NULL"
    elif not vals:
        return "TRUE"  # an empty value (an unset parameter) does not filter
    elif op == "is":
        sql = "(" + " OR ".join(f"CAST({col} AS VARCHAR) = {lit(str(v))}" for v in vals) + ")"
    elif op == "is_wild":
        sql = "(" + " OR ".join(f"CAST({col} AS VARCHAR) ILIKE {lit(_wild(str(v)))} ESCAPE '\\'" for v in vals) + ")"
    elif op == "contains":
        sql = "(" + " OR ".join(f"contains(lower(CAST({col} AS VARCHAR)), lower({lit(str(v))}))" for v in vals) + ")"
    elif op == "contains_wild":
        sql = "(" + " OR ".join(f"CAST({col} AS VARCHAR) ILIKE {lit('%' + _wild(str(v)) + '%')} ESCAPE '\\'" for v in vals) + ")"
    elif op == "matches":
        sql = "(" + " OR ".join(f"regexp_matches(CAST({col} AS VARCHAR), {lit(str(v))})" for v in vals) + ")"
    elif op in ("eq", "neq", "gt", "gte", "lt", "lte"):
        sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
        v = vals[0]
        sql = f"{col} {sym} {lit(v)}" if isinstance(v, (int, float)) else f"CAST({col} AS VARCHAR) {sym} {lit(str(v))}"
        if not isinstance(v, (int, float)):
            try:
                sql = f"TRY_CAST({col} AS DOUBLE) {sym} {float(v)!r}"
            except ValueError:
                pass
    elif op == "between":
        lo, hi = (vals + [None, None])[:2]
        sql = f"{col} BETWEEN {lit(lo)} AND {lit(hi)}"
    elif op == "in":
        sql = f"CAST({col} AS VARCHAR) IN ({', '.join(lit(str(v)) for v in vals)})"
    else:
        raise ContourError(f"unknown filter operator {op}")
    return f"NOT ({sql})" if c.get("negate") else sql


def _agg(metric: str, column: Optional[str]) -> str:
    m = (metric or "count").lower()
    if m == "count":
        return "COUNT(*)"
    if not column:
        raise ContourError(f"{m} needs a column")
    if m == "distinct":
        return f"COUNT(DISTINCT {q(column)})"
    if m in ("sum", "avg", "min", "max", "median", "stddev"):
        return f"{m.upper()}({q(column)})" if m != "stddev" else f"STDDEV_SAMP({q(column)})"
    raise ContourError(f"unknown metric {metric}")


def _bucket(column: str, bucket: Optional[str]) -> str:
    if not bucket or bucket == "none":
        return q(column)
    return f"date_trunc({lit(bucket)}, TRY_CAST({q(column)} AS TIMESTAMP))"


def visual_sql(b: dict, src: str, params: dict) -> str:
    """The query a visualization board runs on its input relation."""
    t = b["type"]
    c = b.get("config") or {}
    if t in ("table", "export"):
        cols = ", ".join(q(x) for x in c.get("columns") or []) or "*"
        order = f" ORDER BY {q(c['sort'])} {'DESC' if c.get('descending') else 'ASC'}" if c.get("sort") else ""
        return f"SELECT {cols} FROM {src}{order}"
    if t == "histogram":
        col = c.get("column") or ""
        if not col:
            raise ContourError("choose the histogram's column")
        order = "value DESC" if (c.get("sort") or "value") == "value" else "key"
        return f"SELECT {q(col)} AS key, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} GROUP BY 1 ORDER BY {order} NULLS LAST LIMIT {int(c.get('limit') or 50)}"
    if t == "distribution":
        col = q(c.get("column") or "")
        bins = max(2, min(int(c.get("bins") or 20), 200))
        return (f"WITH s AS (SELECT TRY_CAST({col} AS DOUBLE) v FROM {src} WHERE {col} IS NOT NULL), "
                f"r AS (SELECT MIN(v) lo, MAX(v) hi FROM s) "
                f"SELECT lo + (hi - lo) / {bins} * LEAST(FLOOR((v - lo) / NULLIF((hi - lo) / {bins}, 0)), {bins - 1}) AS key, COUNT(*) AS value "
                f"FROM s, r GROUP BY 1 ORDER BY 1")
    if t == "time_series":
        col = c.get("date_column") or ""
        if not col:
            raise ContourError("choose the date column")
        series = f", {q(c['series'])} AS series" if c.get("series") else ""
        grp = ", 2" if c.get("series") else ""
        return (f"SELECT {_bucket(col, c.get('bucket') or 'day')} AS key{series}, {_agg(c.get('metric'), c.get('metric_column'))} AS value "
                f"FROM {src} WHERE {q(col)} IS NOT NULL GROUP BY 1{grp} ORDER BY 1")
    if t == "chart":
        x = c.get("x") or ""
        if not x:
            raise ContourError("choose the chart's x axis")
        if c.get("kind") == "scatter":
            # the board itself runs contour_viz.scatter_result (points or density bins); this is the CSV / Quiver form
            extra = (f", {q(c['color'])} AS color" if c.get("color") else "") + (f", {q(c['size'])} AS size" if c.get("size") else "")
            return f"SELECT {q(x)} AS key, {q(c.get('y') or x)} AS value{extra} FROM {src} LIMIT 5000"
        series = f", {q(c['series'])} AS series" if c.get("series") else ""
        grp = ", 2" if c.get("series") else ""
        return (f"SELECT {_bucket(x, c.get('bucket'))} AS key{series}, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} "
                f"GROUP BY 1{grp} ORDER BY {'1' if c.get('kind') == 'line' else 'value DESC'} LIMIT {int(c.get('limit') or 100)}")
    if t == "heatmap":
        x, y = c.get("x") or "", c.get("y") or ""
        if not x or not y:
            raise ContourError("choose the heatmap's two columns")
        return f"SELECT {q(x)} AS x, {q(y)} AS y, {_agg(c.get('metric'), c.get('metric_column'))} AS value FROM {src} GROUP BY 1, 2 LIMIT 2500"
    if t == "pivot":
        rows = c.get("rows") or []
        vals = c.get("values") or [{"metric": "count"}]
        if not rows:
            raise ContourError("choose the pivot table's rows")
        sel = ", ".join(q(r) for r in rows)
        aggs = ", ".join(f"{_agg(v.get('metric'), v.get('column'))} AS {q(v.get('name') or (v.get('metric') or 'count') + ('_' + v['column'] if v.get('column') else ''))}" for v in vals)
        if c.get("columns"):
            col = c["columns"]
            v = vals[0]
            return (f"PIVOT (SELECT {sel}, {q(col)}, {('1' if (v.get('metric') or 'count') == 'count' else q(v.get('column') or ''))} AS __v FROM {src}) "
                    f"ON {q(col)} USING {('COUNT' if (v.get('metric') or 'count') == 'count' else (v.get('metric') or 'sum').upper())}(__v) GROUP BY {sel} ORDER BY {sel}")
        return f"SELECT {sel}, {aggs} FROM {src} GROUP BY {sel} ORDER BY {sel}"
    if t == "calculation":
        ms = c.get("metrics") or [{"name": "rows", "expr": "COUNT(*)"}]
        return "SELECT " + ", ".join(f"{subst(m['expr'], params)} AS {q(m.get('name') or 'value')}" for m in ms) + f" FROM {src}"
    if t == "map":
        # the board itself runs contour_viz.map_result (its layers); this is the first point layer, for CSV / Quiver
        import contour_viz

        return contour_viz.map_points_sql(c, src)
    raise ContourError(f"unknown board {t}")


def _selection_filter(b: dict, src: str) -> Optional[str]:
    """A visualization's selection as a filter on the working data (chart-to-chart filtering)."""
    sel = b.get("selection")
    if not sel:
        return None
    c = b.get("config") or {}
    if b["type"] == "map" or (b["type"] == "chart" and c.get("kind") == "scatter"):
        # brushed rectangles / color categories; map points, regions, lines, circles and polygons (contour_viz.py)
        import contour_viz

        items = sel if isinstance(sel, list) else [sel]
        cond = contour_viz.map_filter(c, items) if b["type"] == "map" else contour_viz.scatter_filter(c, items)
        return f"SELECT * FROM {src} WHERE {cond}" if cond else None
    col = c.get("column") or c.get("x") or c.get("date_column") or ((c.get("rows") or [None])[0])
    if not col:
        return None
    vals = sel if isinstance(sel, list) else [sel]
    if b["type"] in ("time_series",) or (b["type"] == "chart" and c.get("bucket") not in (None, "", "none")):
        cond = " OR ".join(f"{_bucket(col, c.get('bucket') or 'day')} = TRY_CAST({lit(str(v))} AS TIMESTAMP)" for v in vals)
    else:
        cond = " OR ".join("(" + (f"{q(col)} IS NULL" if v is None else f"CAST({q(col)} AS VARCHAR) = {lit(str(v))}") + ")" for v in vals)
    return f"SELECT * FROM {src} WHERE {cond}"


class Compiler:
    """Turns an analysis's paths into CTEs; `tables` gives each source's Arrow table (or, for a large dataset, a lazy
    pyarrow dataset DuckDB scans: contour_scale.py)."""

    def __init__(self, analysis: dict, params: dict, load: Callable[[dict], pa.Table]) -> None:
        self.analysis, self.params, self.load = analysis, params, load
        self.ctes: dict[str, str] = {}
        self.tables: dict[str, pa.Table] = {}
        self.paths = {p["id"]: p for p in analysis.get("paths") or []}
        self.visiting: set[str] = set()
        # Cipher boards: DuckDB functions bound to a checked license (cipher.py), registered on the connection
        self.udfs: dict[str, Callable[[Optional[str]], Optional[str]]] = {}

    def source(self, src: dict) -> str:
        kind = src.get("kind")
        if kind == "path":
            return self.path_rel(src["id"], None)
        key = f"src_{kind}_{re.sub(r'[^A-Za-z0-9]', '_', str(src.get('id')))}"
        if key not in self.tables:
            self.tables[key] = self.load(src)
        return key

    def path_rel(self, path_id: str, upto: Optional[int]) -> str:
        """The relation after the first `upto` boards of a path (all when None)."""
        p = self.paths.get(path_id)
        if not p:
            raise ContourError(f"no path {path_id}")
        boards = p.get("boards") or []
        n = len(boards) if upto is None else upto
        name = f"p_{re.sub(r'[^A-Za-z0-9]', '_', path_id)}_{n}"
        if name in self.ctes:
            return name
        if path_id in self.visiting and upto is None:
            raise ContourError("a path cannot start from its own result")
        self.visiting.add(path_id)
        try:
            prev = self.source(p["source"]) if n == 0 else self.path_rel(path_id, n - 1)
            if n == 0:
                self.ctes[name] = f"SELECT * FROM {prev}"
            else:
                self.ctes[name] = self.board_sql(boards[n - 1], prev)
        finally:
            self.visiting.discard(path_id)
        return name

    def board_sql(self, b: dict, src: str) -> str:
        t = b["type"]
        c = b.get("config") or {}
        params = self.params
        if t in VISUALS:
            if c.get("switch") and t in ("pivot", "histogram", "chart", "calculation", "time_series", "heatmap"):
                return visual_sql(b, src, params)  # switch to aggregated data
            return _selection_filter(b, src) or f"SELECT * FROM {src}"
        if t == "filter":
            conds = [_condition(x, params) for x in c.get("conditions") or []]
            if c.get("expression"):
                conds.append(f"({subst(c['expression'], params)})")
            if not conds:
                return f"SELECT * FROM {src}"
            joined = (" OR " if c.get("mode") == "any" else " AND ").join(conds)
            return f"SELECT * FROM {src} WHERE {'NOT (' + joined + ')' if c.get('remove') else joined}"
        if t == "expression":
            mode = c.get("mode") or "column"
            expr = subst(c.get("expr") or "", params)
            if mode == "filter":
                return f"SELECT * FROM {src} WHERE {expr}"
            if mode == "aggregate":
                groups = c.get("group_by") or []
                aggs = c.get("aggregates") or [{"name": c.get("name") or "value", "expr": expr}]
                sel = ", ".join([q(g) for g in groups] + [f"{subst(a['expr'], params)} AS {q(a['name'])}" for a in aggs])
                return f"SELECT {sel} FROM {src}" + (f" GROUP BY {', '.join(q(g) for g in groups)}" if groups else "")
            name = c.get("name") or "new_column"
            return f"SELECT * REPLACE ({expr} AS {q(name)}) FROM {src}" if c.get("replace") else f"SELECT *, {expr} AS {q(name)} FROM {src}"
        if t == "edit_columns":
            cols = c.get("keep")
            casts = c.get("casts") or {}
            renames = c.get("rename") or {}
            if cols:
                sel = ", ".join(f"{'CAST(' + q(x) + ' AS ' + casts[x] + ')' if x in casts else q(x)} AS {q(renames.get(x, x))}" for x in cols)
                return f"SELECT {sel} FROM {src}"
            excl = f" EXCLUDE ({', '.join(q(x) for x in c.get('remove') or [])})" if c.get("remove") else ""
            rep = ", ".join(f"CAST({q(x)} AS {ty}) AS {q(x)}" for x, ty in casts.items())
            out = f"SELECT *{excl}{' REPLACE (' + rep + ')' if rep else ''} FROM {src}"
            if renames:
                out = f"SELECT * RENAME ({', '.join(f'{q(a)} AS {q(b)}' for a, b in renames.items())}) FROM ({out})"
            return out
        if t == "reorder_columns":
            order = c.get("order") or []
            return f"SELECT {', '.join(q(x) for x in order)}{', * EXCLUDE (' + ', '.join(q(x) for x in order) + ')' if order and c.get('keep_rest', True) else ''} FROM {src}"
        if t == "sort":
            by = c.get("by") or []
            if not by:
                return f"SELECT * FROM {src}"
            return f"SELECT * FROM {src} ORDER BY " + ", ".join(f"{q(x['column'])} {'DESC' if x.get('desc') else 'ASC'} NULLS LAST" for x in by)
        if t in ("join", "enrich"):
            other = self.source(c["source"])
            how = "LEFT" if t == "enrich" else (c.get("how") or "left").upper()
            on = c.get("on") or []
            if not on:
                raise ContourError("choose the join keys")
            cond = " AND ".join(f"l.{q(a)} = r.{q(b)}" for a, b in on)
            if how in ("SEMI", "ANTI"):
                return f"SELECT l.* FROM {src} l {how} JOIN {other} r ON {cond}"
            cols = c.get("columns")
            prefix = c.get("prefix") or ""
            right = [x for x in self.columns(other) if x not in {b for _, b in on}] if cols is None else cols
            sel = ", ".join(f"r.{q(x)} AS {q(prefix + x)}" for x in right)
            return f"SELECT l.*{', ' + sel if sel else ''} FROM {src} l {how} JOIN {other} r ON {cond}"
        if t == "set_math":
            other = self.source(c["source"])
            op = c.get("op") or "union"
            keys = c.get("keys") or []
            if op == "union":
                return f"SELECT * FROM {src} UNION ALL BY NAME SELECT * FROM {other}"
            if not keys:
                raise ContourError("choose the key columns")
            cond = " AND ".join(f"l.{q(k)} = r.{q(k)}" for k in keys)
            return f"SELECT l.* FROM {src} l {'SEMI' if op == 'intersect' else 'ANTI'} JOIN {other} r ON {cond}"
        if t == "transform_data":
            col = q(c.get("column") or "")
            op = c.get("op") or "find_replace"
            if op == "find_replace":
                e = f"replace(CAST({col} AS VARCHAR), {lit(c.get('find') or '')}, {lit(c.get('replace') or '')})"
            elif op == "regex_replace":
                e = f"regexp_replace(CAST({col} AS VARCHAR), {lit(c.get('find') or '')}, {lit(c.get('replace') or '')}, 'g')"
            elif op == "obfuscate":
                e = f"md5(CAST({col} AS VARCHAR) || {lit(c.get('salt') or '')})"
            elif op in ("upper", "lower", "trim"):
                e = f"{op}(CAST({col} AS VARCHAR))"
            else:
                raise ContourError(f"unknown transform {op}")
            return f"SELECT * REPLACE ({e} AS {col}) FROM {src}"
        if t == "unpivot":
            cols = c.get("columns") or []
            if not cols:
                raise ContourError("choose the columns to unpivot")
            return (f"UNPIVOT (SELECT * FROM {src}) ON {', '.join('CAST(' + q(x) + ' AS VARCHAR) AS ' + q(x) for x in cols)} "
                    f"INTO NAME {q(c.get('name_column') or 'column')} VALUE {q(c.get('value_column') or 'value')}")
        if t == "cipher":
            return self.cipher_sql(c, src)
        if t == "dedupe":
            cols = c.get("columns") or []
            if not cols:
                return f"SELECT DISTINCT * FROM {src}"
            return f"SELECT * FROM {src} QUALIFY ROW_NUMBER() OVER (PARTITION BY {', '.join(q(x) for x in cols)}) = 1"
        raise ContourError(f"unknown board {t}")

    def cipher_sql(self, c: dict, src: str) -> str:
        """The Cipher board: encrypt, decrypt or hash columns in place with a Data Manager or Admin license."""
        import cipher

        cols, lic, op = c.get("columns") or [], c.get("license") or "", c.get("operation") or "encrypt"
        if not cols or not lic:
            raise ContourError("choose the columns and a Cipher license")
        try:
            r = cipher._find(lic)
            cipher._check(r, op, ("data_manager", "admin"))
        except Exception as e:  # noqa: BLE001
            raise ContourError(str(getattr(e, "detail", e))) from None
        name = f"cipher_{re.sub(r'[^A-Za-z0-9]', '_', r['id'])}_{op}"
        if name not in self.udfs:
            def bound(r: dict, op: str) -> Callable[[Optional[str]], Optional[str]]:
                return lambda v: cipher.run(r, op, [v])[0]
            self.udfs[name] = bound(r, op)
            cipher._audit(r, op, -1, "Contour Cipher board")
        rep = ", ".join(f"{name}(CAST({q(x)} AS VARCHAR)) AS {q(x)}" for x in cols)
        return f"SELECT * REPLACE ({rep}) FROM {src}"

    _con: Optional[duckdb.DuckDBPyConnection] = None
    # extra DuckDB settings fixed at connect time (contour_scale.py: a spill directory and a memory limit when a large
    # dataset is scanned lazily, a pyarrow dataset in `tables` instead of an Arrow table)
    duck_config: dict[str, Any] = {}

    def con(self) -> duckdb.DuckDBPyConnection:
        if self._con is None:
            if self.duck_config:
                # a spill directory cannot be set once external access is off: set it, then turn access off before
                # any query runs (it cannot be turned back on)
                con = duckdb.connect(config=dict(self.duck_config))
                con.execute("SET enable_external_access = false")
            else:
                con = duckdb.connect(config={"enable_external_access": False})
            for k, t in self.tables.items():
                con.register(k, t)
            self._con = con
        else:
            for k, t in self.tables.items():
                try:
                    self._con.register(k, t)
                except duckdb.Error:
                    pass
        if self.udfs:
            try:
                from duckdb.sqltypes import VARCHAR
            except ImportError:  # duckdb before 1.4
                VARCHAR = duckdb.typing.VARCHAR  # noqa: N806
            for name, fn in self.udfs.items():
                try:
                    self._con.create_function(name, fn, [VARCHAR], VARCHAR, null_handling="special")
                except duckdb.NotImplementedException:
                    pass  # registered already
        return self._con

    def with_clause(self) -> str:
        return ("WITH " + ", ".join(f"{k} AS ({v})" for k, v in self.ctes.items()) + " ") if self.ctes else ""

    def run(self, sql: str, limit: Optional[int] = None) -> pa.Table:
        full = self.with_clause() + (f"SELECT * FROM ({sql}) LIMIT {int(limit)}" if limit is not None else sql)
        try:
            res = self.con().execute(full).arrow()
            return res.read_all() if hasattr(res, "read_all") else res
        except duckdb.Error as e:
            raise ContourError(str(e).split("\n")[0][:500]) from None

    def columns(self, rel: str) -> list[str]:
        return list(self.run(f"SELECT * FROM {rel}", 0).schema.names)

    def count(self, rel: str) -> int:
        return int(self.run(f"SELECT COUNT(*) AS n FROM {rel}").column(0)[0].as_py())


def rows_of(t: pa.Table) -> list[dict]:
    out = []
    for r in t.to_pylist():
        out.append({k: (v.isoformat() if isinstance(v, (dt.date, dt.datetime)) else (float(v) if hasattr(v, "as_integer_ratio") and not isinstance(v, (int, float)) else v)) for k, v in r.items()})
    return out
