"""Contour's "Export to Pipeline Builder" (contour.py): a path as a pipeline graph.

The path's relations (contour_engine.Compiler: one CTE per board) become nodes:

- every dataset the path reads is an input (a dataset with its source node);
- a join / enrich board is a join node, a set math board a union node (union) or a left semi / left anti join node
  (intersection / subtract); what a board joins with is the other dataset's input, or the nodes of the other path;
- the boards between them are one SQL step each run of boards (a transform node), translated from DuckDB to SQLite
  (Pipeline Builder's SQL engine) and run on a sample of what the step reads: an error there refuses the export.

What SQLite has no syntax for is rewritten first, from what is known at export time:

- SELECT * EXCLUDE / REPLACE / RENAME become explicit column lists (the columns of every board are known);
- a pivot table used as the working data becomes one aggregate per value of the pivoted column: the values are those in
  the data at export time (said in the result's notes);
- an unpivot board becomes a UNION ALL with one SELECT per unpivoted column;
- UNION BY NAME is the union node (it unions by name, missing columns are null) followed by a SQL step that lists the
  columns in Contour's order and casts numbers and booleans back to their types.

A rewritten step is also run in DuckDB next to the path's own result: the export is refused unless both give the same
columns and rows. Whatever cannot be expressed raises ExportError with the reason.
"""

from __future__ import annotations

import datetime as dt
import decimal
import re
import uuid
from typing import Any, Optional

import duckdb
import pyarrow as pa

import contour_engine as E

MULTI = ("join", "enrich", "set_math")
# a pivot's columns are written into the SQL step, one aggregate each
PIVOT_VALUES = 200
SAMPLE_ROWS = 1000
JOIN_HOW = {"LEFT": "left", "INNER": "inner", "RIGHT": "right", "FULL": "outer", "OUTER": "outer", "SEMI": "left semi", "ANTI": "left anti"}
PIVOT_AGGS = {"count": "COUNT", "sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}


class ExportError(Exception):
    pass


def _uid(kind: str) -> str:
    return f"{kind}-{uuid.uuid4().hex[:8]}"


def _class(t: pa.DataType) -> str:
    """What a join key or union column holds, as Pipeline Builder compares it."""
    if pa.types.is_boolean(t):
        return "boolean"
    if pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t):
        return "number"
    if pa.types.is_timestamp(t):
        return "timestamp"
    if pa.types.is_date(t):
        return "date"
    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return "text"
    return str(t)


def _modified(e: Any) -> Optional[Any]:
    """The star of a projection when it carries EXCLUDE / REPLACE / RENAME."""
    from sqlglot import exp

    star = e if isinstance(e, exp.Star) else (e.this if isinstance(e, exp.Column) and isinstance(e.this, exp.Star) else None)
    if star is not None and any(star.args.get(k) for k in ("except_", "except", "replace", "rename")):
        return star
    return None


def expand_stars(tree: Any, known: dict[str, list[str]]) -> bool:
    """SELECT * EXCLUDE (…) REPLACE (…) RENAME (…) (also t.*) as explicit column lists, in place; `known` gives the
    columns of the tables and CTEs. True when something was expanded."""
    from sqlglot import exp

    def sources(sel: Any) -> list[tuple[str, Optional[list[str]]]]:
        frm = sel.args.get("from_") or sel.args.get("from")
        out: list[tuple[str, Optional[list[str]]]] = []
        for it in ([frm.this] if frm is not None else []) + [j.this for j in sel.args.get("joins") or []]:
            if isinstance(it, exp.Table):
                out.append((it.alias_or_name, known.get(it.name)))
            elif isinstance(it, exp.Subquery):
                out.append((it.alias_or_name or "", names(it.this)))
            else:
                out.append(("", None))
        return out

    def star_columns(e: Any, srcs: list[tuple[str, Optional[list[str]]]]) -> Optional[list[tuple[str, Any]]]:
        star = e if isinstance(e, exp.Star) else e.this
        table = e.table if isinstance(e, exp.Column) else ""
        pairs = [(alias, cols) for alias, cols in srcs if not table or alias.lower() == table.lower()]
        if not pairs or any(cols is None for _, cols in pairs):
            return None
        excluded = {x.name.lower() for x in star.args.get("except_") or star.args.get("except") or []}
        replaced = {x.alias.lower(): x.this for x in star.args.get("replace") or []}
        renamed = {x.this.name.lower(): x.alias for x in star.args.get("rename") or []}
        out = []
        for alias, cols in pairs:
            for c in cols or []:
                if c.lower() in excluded:
                    continue
                name = renamed.get(c.lower(), c)
                if c.lower() in replaced:
                    out.append((name, exp.alias_(replaced[c.lower()].copy(), name, quoted=True)))
                else:
                    col = exp.column(c, table=alias if table else None, quoted=True)
                    out.append((name, col if name == c else exp.alias_(col, name, quoted=True)))
        return out

    def names(q: Any) -> Optional[list[str]]:
        if not isinstance(q, exp.Select):
            return None
        srcs = sources(q)
        out: list[str] = []
        for e in q.expressions:
            if isinstance(e, exp.Star) or (isinstance(e, exp.Column) and isinstance(e.this, exp.Star)):
                cols = star_columns(e, srcs)
                if cols is None:
                    return None
                out += [n for n, _ in cols]
            else:
                out.append(e.alias_or_name)
        return out

    changed = False
    for sel in list(tree.find_all(exp.Select)):
        if not any(_modified(e) is not None for e in sel.expressions):
            continue
        srcs = sources(sel)
        new = []
        for e in sel.expressions:
            if _modified(e) is None:
                new.append(e)
                continue
            cols = star_columns(e, srcs)
            if cols is None:
                raise ExportError(f"the columns behind {e.sql(dialect='duckdb')} are not known, so it cannot be written as a column list for Pipeline Builder (SQLite)")
            new += [x for _, x in cols]
        if not new:
            raise ExportError("a board removes every column")
        sel.set("expressions", new)
        changed = True
    return changed


class Export:
    """One path of an analysis as Pipeline Builder nodes and datasets (build() returns the node of its result)."""

    def __init__(self, analysis: dict, comp: E.Compiler, path_id: str, item_id: str) -> None:
        self.a, self.comp, self.item_id = analysis, comp, item_id
        self.rel = comp.path_rel(path_id, None)
        self.path = comp.paths[path_id]
        # relation → (its path, boards applied)
        self.info: dict[str, tuple[dict, int]] = {}
        # source table → the analysis' source
        self.srcs: dict[str, dict] = {}
        for p in analysis.get("paths") or []:
            for n in range(len(p.get("boards") or []) + 1):
                name = f"p_{re.sub(r'[^A-Za-z0-9]', '_', p['id'])}_{n}"
                if name in comp.ctes:
                    self.info[name] = (p, n)
            for src in [p.get("source")] + [(b.get("config") or {}).get("source") for b in p.get("boards") or []]:
                if isinstance(src, dict) and src.get("kind") != "path":
                    self.srcs[f"src_{src.get('kind')}_{re.sub(r'[^A-Za-z0-9]', '_', str(src.get('id')))}"] = src
        self.nodes: list[dict] = []
        self.datasets: dict[str, dict] = {}
        self.notes: list[str] = []
        self.queries: list[str] = []
        self.made: dict[str, str] = {}
        self.labels: dict[str, str] = {}
        self.now = ""

    # ---------------------------------------------------------------- the path's relations

    def board(self, rel: str) -> Optional[dict]:
        p, n = self.info[rel]
        return (p.get("boards") or [])[n - 1] if n else None

    def prev(self, rel: str) -> str:
        p, n = self.info[rel]
        return self.comp.source(p["source"]) if n == 0 else f"p_{re.sub(r'[^A-Za-z0-9]', '_', p['id'])}_{n - 1}"

    def is_multi(self, rel: str) -> bool:
        b = self.board(rel)
        return bool(b) and b["type"] in MULTI

    def schema(self, rel: str) -> pa.Schema:
        return self.comp.run(f"SELECT * FROM {rel}", 0).schema

    def label(self, rel: str) -> str:
        return self.labels.get(rel) or (self.info[rel][0].get("name") if rel in self.info else None) or "Contour path"

    # ---------------------------------------------------------------- nodes

    def build(self) -> str:
        out = self.node_of(self.rel, top=True)
        self.layout()
        return out

    def add(self, node: dict) -> str:
        self.nodes.append({**node, "x": 0, "y": 0})
        return node["id"]

    def node_of(self, rel: str, top: bool = False) -> str:
        if rel in self.made:
            return self.made[rel]
        if rel in self.comp.tables:
            nid = self.source_node(rel)
        else:
            chain: list[str] = []
            cur = rel
            while cur not in self.comp.tables and not self.is_multi(cur):
                chain.append(cur)
                cur = self.prev(cur)
            if not chain:
                nid = self.multi_node(rel)
            elif not top and all(self.info[x][1] == 0 for x in chain):
                nid = self.node_of(cur)  # a path without boards is what it starts from
            else:
                nid = self.sql_node(self.node_of(cur), cur, chain[::-1], rel)
        self.made[rel] = nid
        return nid

    def source_node(self, key: str) -> str:
        import contour as C
        import drive

        src = self.srcs.get(key) or {}
        if src.get("kind") != "dataset":
            if len(self.comp.tables) == 1:
                raise ExportError("the path starts from an object type: Pipeline Builder export takes a path on a dataset")
            raise ExportError("the path reads an object type: Pipeline Builder export takes paths on datasets")
        table = self.comp.tables[key]
        item = drive._with_path(drive._item(src["id"]))
        ds_id = _uid("ds")
        name = re.sub(r"\.parquet$", "", item["name"], flags=re.I)
        self.datasets[ds_id] = {"id": ds_id, "name": name, "origin": "Files & Projects / " + " / ".join([x["name"] for x in item.get("path") or []] + [item["name"]]),
                                "createdAt": self.now, "ref": {"kind": "drive", "itemId": src["id"]},
                                "columns": [{"name": f.name, "type": C._pb_type(f.type)} for f in table.schema],
                                "rows": [{k: C._pb_cell(v) for k, v in r.items()} for r in table.slice(0, C.PB_SAMPLE_ROWS).to_pylist()]}
        self.labels[key] = name
        return self.add({"id": _uid("src"), "kind": "source", "name": name, "datasetId": ds_id})

    def multi_node(self, rel: str) -> str:
        """A join / enrich / set math board: a join or union node on what the board reads."""
        comp = self.comp
        b = self.board(rel) or {}
        c = b.get("config") or {}
        t = b["type"]
        prev, other = self.prev(rel), comp.source(c["source"])
        left, right = self.node_of(prev), self.node_of(other)
        ls, rs = self.schema(prev), self.schema(other)
        want = comp.columns(rel)
        what = {"join": "join", "enrich": "enrich", "set_math": "set math"}[t]
        if t == "set_math" and (c.get("op") or "union") == "union":
            return self.union_node(rel, b, left, right, ls, rs, want)
        if t == "set_math":
            keys = [(k, k) for k in c.get("keys") or []]
            how = "left semi" if c.get("op") == "intersect" else "left anti"
        else:
            keys = [(x[0], x[1]) for x in c.get("on") or []]
            sql_how = "LEFT" if t == "enrich" else (c.get("how") or "left").upper()
            if sql_how not in JOIN_HOW:
                raise ExportError(f"the {what} board's {sql_how.lower()} join has no join type in Pipeline Builder")
            how = JOIN_HOW[sql_how]
        for lk, rk in keys:
            if lk not in ls.names or rk not in rs.names:
                raise ExportError(f'the {what} board\'s key "{lk if lk not in ls.names else rk}" is not a column of its input')
            a, z = _class(ls.field(lk).type), _class(rs.field(rk).type)
            if a != z:
                # Pipeline Builder's join matches keys by their value as written: 1 and "1" would match there
                raise ExportError(f'the {what} board compares "{lk}" ({a}) with "{rk}" ({z}): Pipeline Builder joins match keys of the same type, cast one of them in an expression board first')
        node: dict[str, Any] = {"id": _uid("join"), "kind": "join", "name": b.get("title") or f"{what.capitalize()} {self.label(other)}", "left": left, "right": right,
                                "leftKey": keys[0][0], "rightKey": keys[0][1], "keys": [{"left": lk, "right": rk, "op": "="} for lk, rk in keys], "how": how}
        if how in ("left semi", "left anti"):
            expected = list(ls.names)
        else:
            cols, prefix = c.get("columns"), c.get("prefix") or ""
            picked = [x for x in rs.names if x not in {rk for _, rk in keys}] if cols is None else list(cols)
            node.update(leftColumns=None, rightColumns=picked, rightPrefix=prefix)
            # as the join node names its columns: a right column named like one already there gets _right
            expected = list(ls.names)
            for x in dict.fromkeys(picked):
                name = prefix + x
                while name in expected:
                    name += "_right"
                expected.append(name)
            twice = [x for x in dict.fromkeys(prefix + x for x in picked) if x in ls.names or [prefix + y for y in picked].count(x) > 1]
            if twice:
                raise ExportError(f'the {what} board gives the column{"s" if len(twice) > 1 else ""} {", ".join(twice)} twice: give the board a prefix (or choose other columns) so every column has its own name')
        if expected != list(want):
            raise ExportError(f"as a Pipeline Builder join the {what} board gives the columns {', '.join(expected)} instead of {', '.join(want)}")
        return self.add(node)

    def union_node(self, rel: str, b: dict, left: str, right: str, ls: pa.Schema, rs: pa.Schema, want: list[str]) -> str:
        """UNION BY NAME: the union node, then the columns listed in Contour's order with their types restored (the
        union node turns a column into text when its inputs' types differ, e.g. whole numbers and decimals)."""
        import contour as C

        other = self.comp.source((b.get("config") or {})["source"])
        for f in ls:
            if f.name in rs.names and _class(f.type) != _class(rs.field(f.name).type) and "null" not in (str(f.type), str(rs.field(f.name).type)):
                raise ExportError(f'the set math board unions "{f.name}" as {_class(f.type)} with "{f.name}" as {_class(rs.field(f.name).type)}: cast one of them in an expression board first, so both inputs hold the same type')
        expected = list(ls.names) + [x for x in rs.names if x not in ls.names]
        if sorted(expected) != sorted(want):
            raise ExportError(f"as a Pipeline Builder union the set math board gives the columns {', '.join(expected)} instead of {', '.join(want)}")
        uid = self.add({"id": _uid("union"), "kind": "union", "name": b.get("title") or f"Union {self.label(other)}", "inputs": [left, right], "mode": "union all", "strict": False})
        schema = self.schema(rel)
        sel = []
        for name in want:
            ty = schema.field(name).type
            cast = "BOOLEAN" if pa.types.is_boolean(ty) else "BIGINT" if pa.types.is_integer(ty) else "DOUBLE" if pa.types.is_floating(ty) or pa.types.is_decimal(ty) else ""
            sel.append(f"CAST({E.q(name)} AS {cast}) AS {E.q(name)}" if cast else E.q(name))
        sql = "SELECT\n  " + ",\n  ".join(sel) + "\nFROM input"
        try:
            got = C._sqlite_check(sql, self.comp.run(f"SELECT * FROM {rel}", SAMPLE_ROWS))
        except Exception as e:  # noqa: BLE001
            raise ExportError(f"the union's column list does not run on Pipeline Builder's SQL step (SQLite): {e}") from None
        if got != list(want):
            raise ExportError(f"the union's column list gives the columns {', '.join(got)} instead of {', '.join(want)}")
        missing = [x for x in want if x not in ls.names or x not in rs.names]
        self.notes.append(f"Union with {self.label(other)}: a union node (by column name{', ' + ', '.join(missing) + ' null where an input has no such column' if missing else ''}), then a SQL step that lists the columns and casts numbers and booleans back to their types.")
        self.queries.append(sql)
        return self.add({"id": _uid("sql"), "kind": "transform", "name": f"{b.get('title') or 'Union'} columns", "input": uid,
                         "description": "Exported from Contour: the union's columns in order, numbers and booleans cast back to their types",
                         "steps": [{"id": _uid("st"), "kind": "sql", "params": {"query": sql}}]})

    # ---------------------------------------------------------------- SQL steps

    def pivot_sql(self, b: dict, src: str, rel: str) -> str:
        """A pivot table used as the working data (PIVOT … ON column): one aggregate per value in the data now."""
        import contour as C

        c = b.get("config") or {}
        rows, col = c.get("rows") or [], c["columns"]
        v = (c.get("values") or [{"metric": "count"}])[0]
        metric = (v.get("metric") or "count").lower()
        if metric not in PIVOT_AGGS:
            raise ExportError(f"a pivot table with {metric} across the values of a column has no equivalent in Pipeline Builder's SQL step (SQLite): use count, sum, avg, min or max")
        found = self.comp.run(f"SELECT DISTINCT {E.q(col)} AS v, CAST({E.q(col)} AS VARCHAR) AS name FROM {src} WHERE {E.q(col)} IS NOT NULL", PIVOT_VALUES + 1).to_pylist()
        if len(found) > PIVOT_VALUES:
            raise ExportError(f'the pivot table\'s column "{col}" has more than {PIVOT_VALUES} values: a pivot is exported as one SQL aggregate per value')
        by_name = {r["name"]: r["v"] for r in found}
        names = self.comp.columns(rel)[len(rows):]
        if sorted(names) != sorted(by_name):
            raise ExportError(f'the pivot table\'s columns ({", ".join(names)}) are not the values of "{col}" ({", ".join(sorted(by_name))})')
        value = "1" if metric == "count" else E.q(v.get("column") or "")
        cells = []
        for name in names:
            x = by_name[name]
            if isinstance(x, dt.datetime) or not isinstance(x, (str, bool, int, float, decimal.Decimal, dt.date)):
                raise ExportError(f'the pivot table\'s column "{col}" holds {type(x).__name__} values: only text, numbers, booleans and dates can be pivoted in Pipeline Builder\'s SQL step')
            x = float(x) if isinstance(x, decimal.Decimal) else C._pb_cell(x)
            cells.append(f"{PIVOT_AGGS[metric]}(CASE WHEN {E.q(col)} = {E.lit(x)} THEN {value} END) AS {E.q(name)}")
        sel = ", ".join(E.q(r) for r in rows)
        self.notes.append(f'Pivot on "{col}": its {len(names)} column{"" if len(names) == 1 else "s"} ({", ".join(names[:20])}{", …" if len(names) > 20 else ""}) are the values in the data at export time; '
                          "a value that appears later needs its own line in the SQL step.")
        return f"SELECT {', '.join([sel] + cells)} FROM {src} GROUP BY {sel} ORDER BY {sel}"

    def unpivot_sql(self, b: dict, src: str) -> str:
        """An unpivot board: one SELECT per unpivoted column (rows where it is null are left out, as UNPIVOT does)."""
        c = b.get("config") or {}
        cols = c.get("columns") or []
        schema = self.schema(src)
        rest = [x for x in schema.names if x not in cols]
        name, value = E.q(c.get("name_column") or "column"), E.q(c.get("value_column") or "value")
        keep = "".join(E.q(x) + ", " for x in rest)
        loose = [x for x in cols if x in schema.names and _class(schema.field(x).type) not in ("text", "boolean", "date") and not pa.types.is_integer(schema.field(x).type)]
        if loose:
            self.notes.append(f"Unpivot: {', '.join(loose)} {'holds' if len(loose) == 1 else 'hold'} decimals or timestamps; Pipeline Builder writes such values as text by its own rules "
                              "(2.0 becomes 2), check the value column.")

        def text(x: str) -> str:
            # SQLite keeps booleans as 1 / 0: written as DuckDB writes them
            if x in schema.names and pa.types.is_boolean(schema.field(x).type):
                return f"CASE WHEN {E.q(x)} THEN 'true' ELSE 'false' END"
            return f"CAST({E.q(x)} AS VARCHAR)"

        return " UNION ALL ".join(f"SELECT {keep}{E.lit(x)} AS {name}, {text(x)} AS {value} FROM {src} WHERE {E.q(x)} IS NOT NULL" for x in cols)

    def sql_node(self, up: str, base: str, chain: list[str], rel: str) -> str:
        """The boards of `chain` (relations after `base`, oldest first) as one SQL step on the node `up`."""
        p = self.info[rel][0]
        sql = self.translate(base, chain, rel)
        self.queries.append(sql)
        name = p.get("name") or "Contour path"
        used = sum(1 for n in self.nodes if n["kind"] == "transform" and (n["name"] == name or n["name"].startswith(name + " (")))
        return self.add({"id": _uid("sql"), "kind": "transform", "name": name if not used else f"{name} ({used + 1})", "input": up,
                         "description": f"Exported from the Contour analysis {self.a.get('name') or self.item_id}",
                         "steps": [{"id": _uid("st"), "kind": "sql", "params": {"query": sql}}]})

    def translate(self, base: str, chain: list[str], rel: str) -> str:
        import sqlglot
        from sqlglot import exp

        import contour as C

        comp = self.comp
        want = comp.columns(rel)
        sample = comp.run(f"SELECT * FROM {base}", SAMPLE_ROWS)
        tail = f" SELECT {', '.join(E.q(c) for c in want)} FROM {rel}"

        def statement(ctes: dict[str, str]) -> str:
            # the path's own columns, by name (translated rewrites, e.g. of QUALIFY, may add helper columns)
            return re.sub(rf"\b{re.escape(base)}\b", "input", "WITH " + ", ".join(f"{k} AS ({v})" for k, v in ctes.items()) + tail)

        def checked(sql: str) -> str:
            try:
                got = C._sqlite_check(sql, sample)
            except Exception as e:  # noqa: BLE001
                raise ExportError(f"the path uses something Pipeline Builder's SQL step (SQLite) cannot run: {e}") from None
            if got != list(want):
                raise ExportError(f"translated for SQLite the path gives the columns {', '.join(got)} instead of {', '.join(want)}")
            return sql

        special = [x for x in chain if self.is_pivot(x) or (self.board(x) or {}).get("type") == "unpivot"]
        if not special:
            # the path as Contour runs it, when SQLite takes it as it is
            try:
                parts = sqlglot.transpile(statement({x: comp.ctes[x] for x in chain}), read="duckdb", write="sqlite", pretty=True, unsupported_level=sqlglot.ErrorLevel.RAISE)
                if len(parts) == 1 and parts[0].strip():
                    return checked(parts[0])
            except (sqlglot.errors.SqlglotError, ExportError):
                pass
        ctes = {}
        for x in chain:
            b = self.board(x) or {}
            ctes[x] = self.pivot_sql(b, self.prev(x), x) if self.is_pivot(x) else self.unpivot_sql(b, self.prev(x)) if b.get("type") == "unpivot" else comp.ctes[x]
        try:
            tree = sqlglot.parse_one(statement(ctes), read="duckdb")
        except sqlglot.errors.SqlglotError as e:
            raise ExportError(f"the path's SQL cannot be translated for Pipeline Builder (SQLite): {str(e).splitlines()[0][:300]}") from None
        known = {"input": list(sample.schema.names), **{x: comp.columns(x) for x in chain}}
        expand_stars(tree, known)
        if tree.find(exp.SetOperation) is not None and any(u.args.get("by_name") for u in tree.find_all(exp.SetOperation)):
            raise ExportError("the path uses UNION BY NAME in an expression: Pipeline Builder's SQL step (SQLite) has no such union")
        try:
            sql = tree.sql(dialect="sqlite", pretty=True, unsupported_level=sqlglot.ErrorLevel.RAISE)
        except sqlglot.errors.SqlglotError as e:
            raise ExportError(f"the path's SQL cannot be translated for Pipeline Builder (SQLite): {e}") from None
        checked(sql)
        # boards that keep any one row of several (remove duplicates, LIMIT) are compared by columns and count only
        self.same_rows(tree.sql(dialect="duckdb"), base, rel, want, rows=tree.find(exp.Window, exp.Qualify, exp.Limit) is None)
        return sql

    def is_pivot(self, rel: str) -> bool:
        b = self.board(rel) or {}
        c = b.get("config") or {}
        return b.get("type") == "pivot" and bool(c.get("switch")) and bool(c.get("columns")) and bool(c.get("rows"))

    def same_rows(self, rewritten: str, base: str, rel: str, want: list[str], rows: bool = True) -> None:
        """The rewritten step, run in DuckDB on what it reads, gives the board's own rows (numbers with decimals are
        compared by count only: their last digits depend on the order of the additions)."""
        comp = self.comp
        expected = comp.run(f"SELECT {', '.join(E.q(c) for c in want)} FROM {rel}")
        con = comp.con()
        con.register("input", comp.run(f"SELECT * FROM {base}"))
        try:
            res = con.execute(rewritten).arrow()
            got = res.read_all() if hasattr(res, "read_all") else res
            if list(got.schema.names) != list(want):
                raise ExportError(f"written for Pipeline Builder the path gives the columns {', '.join(got.schema.names)} instead of {', '.join(want)}")
            exact = [c for c in want if not (pa.types.is_floating(expected.schema.field(c).type) or pa.types.is_decimal(expected.schema.field(c).type)
                                             or pa.types.is_floating(got.schema.field(c).type) or pa.types.is_decimal(got.schema.field(c).type))]
            differ = got.num_rows != expected.num_rows
            if not differ and exact and rows:
                con.register("pb_expected", expected)
                con.register("pb_got", got)
                sel = ", ".join(E.q(c) for c in exact)
                differ = bool(con.execute(f"SELECT COUNT(*) FROM (SELECT {sel} FROM pb_expected EXCEPT ALL SELECT {sel} FROM pb_got)").fetchone()[0])
            if differ:
                raise ExportError("written without DuckDB's own syntax (SELECT * EXCLUDE / REPLACE, PIVOT, UNPIVOT) the path does not give the same rows, so it is not exported")
        except duckdb.Error as e:
            raise ExportError(f"the path could not be rewritten for Pipeline Builder: {str(e).splitlines()[0][:300]}") from None
        finally:
            for name in ("input", "pb_expected", "pb_got"):
                try:
                    con.unregister(name)
                except duckdb.Error:
                    pass

    # ---------------------------------------------------------------- the graph

    def layout(self) -> None:
        """Inputs on the left, one under the other; every node right of what it reads."""
        by_id = {n["id"]: n for n in self.nodes}
        depth: dict[str, int] = {}
        row: dict[str, float] = {}
        lane = 0
        for n in self.nodes:  # nodes are added after their inputs
            ins = [n[k] for k in ("input", "left", "right") if n.get(k)] + list(n.get("inputs") or [])
            if not ins:
                depth[n["id"]], row[n["id"]] = 0, lane
                lane += 1
            else:
                depth[n["id"]] = 1 + max(depth[i] for i in ins)
                row[n["id"]] = sum(row[i] for i in ins) / len(ins)
        for nid, n in by_id.items():
            n["x"], n["y"] = 80 + 300 * depth[nid], round(120 + 140 * row[nid])
