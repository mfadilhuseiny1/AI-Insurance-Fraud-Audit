"""MERGE INTO in an Iceberg table's Custom SQL, without Spark (Spark SQL's syntax and semantics):

    MERGE INTO this [AS] t USING <source> [AS] s ON <condition>
      WHEN MATCHED [AND <condition>] THEN UPDATE SET col = expr, ... | UPDATE SET * | DELETE
      WHEN NOT MATCHED [BY TARGET] [AND <condition>] THEN INSERT (col, ...) VALUES (expr, ...) | INSERT *
      WHEN NOT MATCHED BY SOURCE [AND <condition>] THEN UPDATE SET ... | DELETE

The target is the task's table (`this`, its RID, its item id or its name). The source is another Iceberg table (RID,
item id, Files path or namespace.name), a dataset or View (Files path, item id or RID; a branch as `branch`.`/path`),
`this` itself (as it was before the MERGE), a subquery over any of them, or a VALUES list. Reading a source needs
read access to it (markings and a Viewer role) — the caller's, or for a scheduled task its creator's.

sqlglot parses the statement (read="spark"); DuckDB evaluates the join, the clause conditions (the first clause whose
condition holds applies to a row, as in Spark) and the new values, cast to the target's column types. A target row
matched by more than one source row is refused (Spark's MERGE_CARDINALITY_VIOLATION) when the statement has WHEN
MATCHED clauses; so are unknown or missing columns, values that cannot be stored in a column's type and nulls in
required columns. The result is committed as ONE snapshot: an overwrite that replaces only the data files holding an
updated or deleted row (their other rows are kept: copy-on-write), with the inserted rows added in the same snapshot,
or an append when only rows were inserted. Branch protection applies as for UPDATE / DELETE (the commit goes through
the catalog, which refuses writes to a protected main branch without the Owner role).
"""

from __future__ import annotations

import re
from typing import Any, Optional

import iceberg_catalog as C
import iceberg_write

TID, SID, FILE, ACT = "__merge_tid", "__merge_sid", "__merge_file", "__merge_act"


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _err(e: Exception) -> str:
    if type(e).__name__ == "PermissionException":  # duckdb: external access refused (see run)
        return "files, URLs and extensions are not available: MERGE INTO reads only this table and the tables it names"
    text =re.split(r"\n\s*LINE \d+:", str(getattr(e, "detail", None) or e))[0]  # not DuckDB's generated query
    return re.sub(r"\s+", " ", text).strip()[:1500]


def parse(sql: str):
    """The statement as a sqlglot Merge expression (Spark dialect)."""
    import sqlglot
    from sqlglot import exp

    import sql_studio

    text = sql_studio.UNQUOTED_RID.sub(r"`\1`", sql.strip().rstrip(";").strip())
    try:
        ast = sqlglot.parse_one(text, read="spark")
    except sqlglot.errors.ParseError as e:
        raise C.bad_request(f"MERGE INTO: syntax error: {e.errors[0].get('description') if e.errors else e}") from None
    if not isinstance(ast, exp.Merge):
        raise C.bad_request("not a MERGE INTO statement")
    if ast.args.get("returning"):
        raise C.bad_request("MERGE INTO ... RETURNING is not supported")
    sql_studio._spark_fixups(ast)
    return ast


def _clauses(ast) -> list[dict]:
    """Each WHEN clause: {kind: matched | not_matched | by_source, cond, action: update | delete | insert, sets / cols /
    values / star}."""
    from sqlglot import exp

    whens = ast.args.get("whens")
    items = list(whens.expressions) if whens is not None else list(ast.expressions or [])
    if not items:
        raise C.bad_request("MERGE INTO needs at least one WHEN clause")
    out = []
    for w in items:
        kind = "matched" if w.args.get("matched") else ("by_source" if w.args.get("source") else "not_matched")
        then = w.args.get("then")
        c: dict[str, Any] = {"kind": kind, "cond": w.args.get("condition"), "sql": w.sql(dialect="spark")}
        if isinstance(then, exp.Var) and then.name.upper() == "DELETE":
            c["action"] = "delete"
        elif isinstance(then, exp.Update):
            c["action"] = "update"
            sets = list(then.expressions or [])
            if len(sets) == 1 and isinstance(sets[0], exp.Star):
                c["star"] = True
            else:
                c["sets"] = []
                for a in sets:
                    if not isinstance(a, exp.EQ) or not isinstance(a.this, exp.Column):
                        raise C.bad_request(f"MERGE INTO: bad assignment {a.sql(dialect='spark')}")
                    c["sets"].append((a.this.name, a.expression))
        elif isinstance(then, exp.Insert):
            c["action"] = "insert"
            if isinstance(then.this, exp.Star):
                c["star"] = True
            else:
                def items_of(node: Any) -> list:
                    if isinstance(node, exp.Tuple):
                        return list(node.expressions)
                    if isinstance(node, exp.Paren):
                        return [node.this]
                    return [] if node is None else [node]

                cols = items_of(then.this)
                vals = items_of(then.expression)
                if not cols or any(not isinstance(x, (exp.Column, exp.Identifier)) for x in cols):
                    raise C.bad_request(f"MERGE INTO: INSERT needs a column list or *: {c['sql']}")
                if len(cols) != len(vals):
                    raise C.bad_request(f"MERGE INTO: INSERT lists {len(cols)} columns but {len(vals)} values")
                c["cols"] = [x.name for x in cols]
                c["values"] = vals
        else:
            raise C.bad_request(f"MERGE INTO: unsupported clause {c['sql']}")
        if kind == "not_matched" and c["action"] != "insert":
            raise C.bad_request("MERGE INTO: WHEN NOT MATCHED clauses can only INSERT")
        if kind != "not_matched" and c["action"] == "insert":
            raise C.bad_request("MERGE INTO: only WHEN NOT MATCHED clauses can INSERT")
        out.append(c)
    for kind, label in (("matched", "WHEN MATCHED"), ("not_matched", "WHEN NOT MATCHED"), ("by_source", "WHEN NOT MATCHED BY SOURCE")):
        same = [c for c in out if c["kind"] == kind]
        if any(c["cond"] is None for c in same[:-1]):
            raise C.bad_request(f"MERGE INTO: only the last {label} clause can omit its condition")
    return out


def _target_names(item: dict) -> set[str]:
    return {"this", item["id"].lower(), C.rid(item["id"]).lower(), item["name"].lower()}


def _target_rows(tbl):
    """The table's current rows, each tagged with its data file (index into the returned file list) and a row id."""
    import pyarrow as pa
    from pyiceberg.io.pyarrow import ArrowScan

    schema = tbl.schema().as_arrow()
    ref = tbl.metadata.refs.get(iceberg_write.MAIN)
    files: list = []
    parts = []
    if ref is not None:
        tasks = list(tbl.scan(snapshot_id=ref.snapshot_id).plan_files())
        scan = ArrowScan(tbl.metadata, tbl.io, tbl.schema(), tbl.scan().row_filter, True)
        for i, t in enumerate(tasks):
            rows = scan.to_table([t])
            files.append(t.file)
            if rows.num_rows:
                rows = iceberg_write.prepare(tbl, rows) if rows.schema != schema else rows
                parts.append(rows.append_column(FILE, pa.array([i] * rows.num_rows, pa.int32())))
    if parts:
        data = pa.concat_tables(parts)
    else:
        data = pa.Table.from_arrays([pa.array([], f.type) for f in schema] + [pa.array([], pa.int32())],
                                    schema=pa.schema([*schema, pa.field(FILE, pa.int32())]))
    return data.append_column(TID, pa.array(range(data.num_rows), pa.int64())), files


def _bind_source(using, item: dict, target_data, con, principal: Optional[dict]) -> None:
    """Point every table reference of the source at a registered Arrow table the caller may read."""
    from fastapi import HTTPException
    from sqlglot import exp

    import auth
    import sql_studio

    ctes = {c.alias_or_name.lower() for c in using.find_all(exp.CTE)}
    names = _target_names(item)
    for i, t in enumerate(list(using.find_all(exp.Table))):
        name, dbp, cat = t.name, t.db, t.catalog
        if not name or (not dbp and name.lower() in ctes):
            continue
        reg = f"_merge_src{i}"
        try:
            if not dbp and not cat and name.lower() in names:
                data, src = target_data, item
            elif name.startswith("/") or name.startswith("ri.foundry.") or sql_studio.ITEM_ID.match(name):
                data, src = sql_studio._data_table(name, dbp or None)
            elif name.startswith(C.RID_PREFIX):
                src = C.table_item(name[len(C.RID_PREFIX):])
                data = None
            else:
                src = C.resolve([p for p in (cat, dbp) if p], name)
                data = None
        except HTTPException as e:
            raise (C.forbidden if e.status_code == 403 else C.bad_request)(f"MERGE INTO source {name}: {_err(e)}") from None
        except C.CatalogError as e:
            raise C.CatalogError(e.status, e.kind, f"MERGE INTO source {name}: {e.message}") from None
        if principal is None and auth.enabled() and auth.current() is None and src["id"] != item["id"]:
            raise C.forbidden(f"MERGE INTO source {name}: the task has no user to read it as (its creator was deactivated?)")
        if principal is not None and not auth.can_access(src["id"], principal):
            raise C.forbidden(f"MERGE INTO source {name}: you need read access to {src['name']}")
        if src["id"] == item["id"]:
            data = target_data
        elif data is None:
            data = C.scan_arrow(src["id"], dbp if name.startswith(C.RID_PREFIX) and dbp else None)
        con.register(reg, data)
        new = exp.Table(this=exp.to_identifier(reg))
        if t.args.get("alias"):
            new.set("alias", t.args["alias"])
        t.replace(new)


def _conform(tbl, data, what: str):
    """`data` with exactly the table's columns and types; refuses values that do not fit (schema mismatches)."""
    import pyarrow as pa

    target = tbl.schema().as_arrow()
    req = {f.name for f in tbl.schema().fields if f.required}
    cols = []
    for f in target:
        c = data.column(f.name)
        if c.type != f.type:
            try:
                c = c.cast(f.type)
            except (pa.ArrowInvalid, pa.ArrowNotImplementedError) as e:
                raise C.bad_request(f"MERGE INTO: {what} column {f.name}: cannot store {c.type} as {f.type} ({e})") from None
        if f.name in req and c.null_count:
            raise C.bad_request(f"MERGE INTO: {what} column {f.name} is required but would be null")
        cols.append(c)
    return pa.Table.from_arrays(cols, schema=pa.schema([pa.field(f.name, f.type, f.nullable) for f in target]))


def run(item_id: str, tbl, sql: str, principal: Optional[dict] = None) -> dict:
    """Run one MERGE INTO statement against the table (a server_table on main) as one snapshot."""
    import duckdb
    import pyarrow as pa
    import pyarrow.compute as pc

    import db

    if tbl.metadata.format_version >= 3:
        raise C.bad_request("format version 3 tables are merged by Spark (MERGE INTO in a Spark transform)")
    item = db.drive_get(item_id)
    ast = parse(sql)
    target = ast.this
    if target.db or target.catalog:
        try:
            same = C.resolve([p for p in (target.catalog, target.db) if p], target.name)["id"] == item_id
        except C.CatalogError:
            same = False
    else:
        same = target.name.lower() in _target_names(item)
    if not same:
        raise C.bad_request(f"MERGE INTO targets this table ({item['name']}): name it this, by its RID or by its name — not {target.sql(dialect='spark')}")
    clauses = _clauses(ast)
    talias = target.alias or target.name
    using = ast.args["using"]
    salias = using.alias or (using.name if hasattr(using, "name") and using.name else "") or "source"
    if salias.lower() == talias.lower():
        raise C.bad_request("MERGE INTO: the target and the source need different names (aliases)")

    tcols = [f.name for f in tbl.schema().fields]
    tlookup = {n.lower(): n for n in tcols}
    data, files = _target_rows(tbl)
    plain = data.drop_columns([FILE, TID])

    # reads only the tables registered on it (the target and the sources, as Arrow, checked above): no files, URLs or
    # extensions — read_csv / read_parquet / ATTACH in the source would read the server's own files, outside any
    # marking or Project role
    con = duckdb.connect(config={"enable_external_access": False})
    try:
        con.execute("SET TimeZone = 'UTC'")
        _bind_source(using, item, plain, con, principal)
        using = ast.args["using"]  # a table source was replaced by its registered name
        try:
            src = con.sql(f"SELECT * FROM {using.sql(dialect='duckdb')}").to_arrow_table()
        except duckdb.Error as e:
            raise C.bad_request(f"MERGE INTO source: {_err(e)}") from None
        lower = [n.lower() for n in src.column_names]
        if len(set(lower)) != len(lower):
            raise C.bad_request(f"MERGE INTO: the source has duplicate column names {src.column_names}")
        slookup = {n.lower(): n for n in src.column_names}
        src = src.append_column(SID, pa.array(range(src.num_rows), pa.int64()))
        con.register("_merge_target", data)
        con.register("_merge_source", src)
        types = {r[0]: r[1] for r in con.sql("DESCRIBE _merge_target").fetchall()}
        T, S = _q(talias), _q(salias)
        on = ast.args["on"].sql(dialect="duckdb")
        join = f"FROM _merge_target AS {T} JOIN _merge_source AS {S} ON ({on})"

        def sql_of(node) -> str:
            return node.sql(dialect="duckdb")

        def col_expr(c: dict, col: str) -> str:
            """The SQL a clause gives a target column (its current value when it does not set it)."""
            keep = f"{T}.{_q(col)}" if c["kind"] != "not_matched" else "NULL"
            if c["action"] == "delete":
                return keep
            if c.get("star"):
                if col.lower() not in slookup:
                    raise C.bad_request(f"MERGE INTO: {'UPDATE SET' if c['action'] == 'update' else 'INSERT'} * needs every column of the "
                                        f"target in the source: the source has no column {col}")
                return f"{S}.{_q(slookup[col.lower()])}"
            pairs = c["sets"] if c["action"] == "update" else list(zip(c["cols"], c["values"]))
            for name, expr in pairs:
                if tlookup.get(name.lower()) == col:
                    return sql_of(expr)
            return keep

        for c in clauses:
            for name in [n for n, _ in c.get("sets", [])] + list(c.get("cols", [])):
                if name.lower() not in tlookup:
                    raise C.bad_request(f"MERGE INTO: the target has no column {name}")
            names = [n.lower() for n, _ in c.get("sets", [])] + [n.lower() for n in c.get("cols", [])]
            if len(set(names)) != len(names):
                raise C.bad_request(f"MERGE INTO: a column is assigned twice in {c['sql']}")

        def evaluate(kind: str, from_sql: str, id_col: Optional[str]) -> tuple[list[dict], Optional[Any]]:
            """Rows the `kind` clauses act on: (clauses, Arrow table of id, action index and new column values)."""
            cs = [c for c in clauses if c["kind"] == kind]
            if not cs:
                return cs, None
            conds = [f"({sql_of(c['cond'])})" if c["cond"] is not None else "TRUE" for c in cs]
            act = "CASE " + " ".join(f"WHEN {cond} THEN {k}" for k, cond in enumerate(conds)) + " ELSE -1 END"
            sel = [f"{id_col} AS {TID}" if id_col else f"NULL AS {TID}", f"{act} AS {ACT}"]
            for col in tcols:
                branches = " ".join(f"WHEN {cond} THEN CAST(({col_expr(c, col)}) AS {types[col]})" for cond, c in zip(conds, cs))
                sel.append(f"CASE {branches} ELSE NULL END AS {_q(col)}")
            q = f"SELECT * FROM (SELECT {', '.join(sel)} {from_sql}) WHERE {ACT} >= 0"
            try:
                return cs, con.sql(q).to_arrow_table()
            except duckdb.Error as e:
                raise C.bad_request(f"MERGE INTO: {_err(e)}") from None

        try:
            pairs = con.sql(f"SELECT {T}.{TID} AS tid, {S}.{SID} AS sid {join}").to_arrow_table()
        except duckdb.Error as e:
            raise C.bad_request(f"MERGE INTO: ON condition: {_err(e)}") from None
        con.register("_merge_pairs", pairs)
        if any(c["kind"] == "matched" for c in clauses) and pairs.num_rows:
            dup = con.sql("SELECT tid, count(*) AS n FROM _merge_pairs GROUP BY tid HAVING count(*) > 1 LIMIT 1").fetchall()
            if dup:
                raise C.bad_request("MERGE INTO: the ON condition matched a single row of the target table with multiple rows of the source "
                                    f"table ({dup[0][1]} source rows match one target row), so it is ambiguous which one updates or deletes it "
                                    "(MERGE_CARDINALITY_VIOLATION): de-duplicate the source")
        changed = []  # (clauses, rows) for matched and by-source
        for kind, from_sql in (("matched", join),
                               ("by_source", f"FROM _merge_target AS {T} WHERE {T}.{TID} NOT IN (SELECT tid FROM _merge_pairs)")):
            cs, rows = evaluate(kind, from_sql, f"{T}.{TID}")
            if rows is not None and rows.num_rows:
                changed.append((cs, rows))
        _cs, ins = evaluate("not_matched", f"FROM _merge_source AS {S} WHERE {S}.{SID} NOT IN (SELECT sid FROM _merge_pairs)", None)
    finally:
        con.close()

    upd_parts, deleted = [], []
    for cs, rows in changed:
        acts = rows.column(ACT).to_pylist()
        is_del = pa.array([cs[a]["action"] == "delete" for a in acts])
        deleted.extend(rows.filter(is_del).column(TID).to_pylist())
        upd = rows.filter(pc.invert(is_del))
        if upd.num_rows:
            upd_parts.append(upd)
    upd = pa.concat_tables(upd_parts) if upd_parts else None
    n_upd = upd.num_rows if upd is not None else 0
    inserts = _conform(tbl, ins, "inserted") if ins is not None and ins.num_rows else None
    n_ins = inserts.num_rows if inserts is not None else 0
    changed_ids = set(deleted) | (set(upd.column(TID).to_pylist()) if upd is not None else set())
    result = {"matched": len(set(pairs.column("tid").to_pylist())) if pairs.num_rows else 0, "updated": n_upd, "deleted": len(deleted),
              "inserted": n_ins, "files_rewritten": 0, "snapshot_id": None}
    if not changed_ids and not n_ins:
        result["operation"] = "none"
        return result
    if not changed_ids:
        tbl.append(inserts)
        result["operation"] = "append"
    else:
        hit = pc.is_in(data.column(TID), value_set=pa.array(sorted(changed_ids), pa.int64()))
        affected = sorted(set(data.filter(hit).column(FILE).to_pylist()))
        in_files = pc.is_in(data.column(FILE), value_set=pa.array(affected, pa.int32()))
        kept = data.filter(pc.and_(in_files, pc.invert(hit))).select([*tcols, TID])
        parts = [kept]
        if upd is not None:
            parts.append(_conform(tbl, upd, "updated").append_column(TID, upd.column(TID)).cast(kept.schema))
        rewritten = pa.concat_tables(parts).sort_by(TID).drop_columns([TID])
        rewritten = _conform(tbl, rewritten, "kept")
        out = pa.concat_tables([rewritten, inserts]) if inserts is not None else rewritten
        iceberg_write.overwrite_files(tbl, [files[i] for i in affected], out)
        result.update(operation="overwrite", files_rewritten=len(affected))
    ref = tbl.refresh().metadata.refs.get(iceberg_write.MAIN)
    result["snapshot_id"] = str(ref.snapshot_id) if ref else None
    return result
