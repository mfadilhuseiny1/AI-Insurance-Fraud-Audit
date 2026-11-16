"""Preparation [Sunset] (palantir.com/docs/foundry/preparation): interactive cleaning and preparation of a dataset.

A preparation is a Files item (`<name>.preparation`, application/vnd.bluesandai.preparation+json) holding its starting
dataset and a changelog. New ones are kept in Files › .auto-save until saved elsewhere. Each change is compiled to a
DuckDB step over the previous one (`WITH s0 AS (input), s1 AS (…) …`), so a preview can stop at any change (inserting
changes into the middle of the changelog) and a change that no longer applies (after changing the starting dataset)
is reported with its error and everything after it is not applied.

Changes: trim, empty_to_null, normalize_strings, change_case, change_type, new_value (for the selected values, or all
rows; `/NULL` is null), extract (indexed substring or regex), normalize_column_names, rename, delete_columns,
remove_rows / keep_rows (the focused values, or nulls), add_column and apply_expression (Spark SQL expressions,
`monotonically_increasing_id()` is the original row order), split.

Column statistics drive the quality flags (needs trim, empty, all null, numeric strings) and their one-click fixes.
Save as dataset writes an updating dataset (Update rebuilds it from the current changelog and input) or a one-off one;
each save keeps the changelog it used (Restore saved version). Project scoping: a saved dataset needs the input in the
preparation's Project (or referenced there, project_references.py) and the output in that Project.
"""

from __future__ import annotations

import io
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import duckdb
import pyarrow as pa
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive
import marked_outputs

router = APIRouter(prefix="/api/preparation")
PREP_TYPE = "application/vnd.bluesandai.preparation+json"
# branch copies of saved datasets (as Dataset Preview lays them out)
BRANCHES = "_branches"
PREVIEW_ROWS = 200
CHANGE_TYPES = ("trim", "empty_to_null", "normalize_strings", "change_case", "change_type", "new_value", "extract", "normalize_column_names", "rename",
                "delete_columns", "remove_rows", "keep_rows", "add_column", "apply_expression", "split")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


def q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


# ------------------------------------------------------------------------------------------------
# preparations (Files items)
# ------------------------------------------------------------------------------------------------


def _autosave_folder() -> str:
    drive.ensure_defaults()
    root = db.drive_by_system("project")
    found = next((c for c in db.drive_list(root["id"]) if c["kind"] == "folder" and c["name"] == ".auto-save" and not c.get("trashed_at")), None)
    return found["id"] if found else drive._insert_container(root["id"], "folder", ".auto-save")


def _load(item_id: str, need: str = "viewer") -> tuple[dict, dict]:
    item = drive._item(item_id, need=need)
    if item.get("content_type") != PREP_TYPE:
        raise HTTPException(400, "not a preparation")
    return item, json.loads(drive.read_bytes(item) or b"{}")


def _write(item: dict, prep: dict) -> None:
    import pipeline_datasets

    prep["updated_at"] = _now()
    pipeline_datasets._replace_content(item, json.dumps(prep).encode(), PREP_TYPE)


def _public(item: dict, prep: dict) -> dict:
    path = [p["name"] for p in db.drive_path(item["id"])[:-1]]
    inp = db.drive_get(prep["input"]["item_id"]) if prep.get("input") else None
    can_edit = True
    try:
        drive._item(item["id"], need="editor")
    except HTTPException:
        can_edit = False
    return {**prep, "branch": prep.get("branch") or "master", "branches": ["master", *[b for b in prep.get("branches") or [] if b != "master"]],
            "id": item["id"], "name": item["name"].removesuffix(".preparation"), "path": path, "autosaved": bool(path) and path[-1] == ".auto-save",
            "input_item": {"id": inp["id"], "name": inp["name"], "path": [p["name"] for p in db.drive_path(inp["id"])[:-1]], "updated_at": str(inp.get("updated_at"))} if inp else None,
            "can_edit": can_edit, "scope": scope(item, prep)}


class NewPrep(BaseModel):
    input_item_id: str
    name: Optional[str] = None
    folder_id: Optional[str] = None


@router.post("")
def create(req: NewPrep) -> dict:
    """Clean in Preparation: a new preparation of a dataset (in .auto-save unless a folder is given)."""
    inp = drive._item(req.input_item_id)
    if req.folder_id:
        folder = drive._folder_id(req.folder_id)
    else:
        import compass

        # the dataset's Project's Autosaved section (Compass), else the platform's .auto-save folder
        folder = compass.autosave_folder(req.input_item_id) or _autosave_folder()
    name = (req.name or f"{inp['name'].rsplit('.', 1)[0]} preparation").strip()
    prep = {"version": 1, "input": {"item_id": inp["id"]}, "changes": [], "outputs": [], "saved_versions": [], "project_scoped": True,
            "created_at": _now(), "created_by": _me()}
    body = json.dumps(prep).encode()
    item = drive._store(folder, drive._free_name(folder, f"{name}.preparation"), io.BytesIO(body), len(body), PREP_TYPE)
    return _public(item, prep)


@router.get("/{item_id}")
def get(item_id: str) -> dict:
    item, prep = _load(item_id)
    return _public(item, prep)


class ChangeIn(BaseModel):
    id: Optional[str] = None
    type: str
    params: dict[str, Any] = Field(default_factory=dict)


class PrepIn(BaseModel):
    changes: list[ChangeIn]
    input_item_id: Optional[str] = None
    project_scoped: Optional[bool] = None


@router.put("/{item_id}")
def save(item_id: str, req: PrepIn) -> dict:
    """Save the changelog (autosaved after every change), the starting dataset and Project scoping."""
    item, prep = _load(item_id, "editor")
    bad = [c.type for c in req.changes if c.type not in CHANGE_TYPES]
    if bad:
        raise HTTPException(400, f"unknown change type {bad[0]}")
    old = {c["id"]: c for c in prep.get("changes") or []}
    prep["changes"] = [{"id": c.id or uuid.uuid4().hex[:10], "type": c.type, "params": c.params,
                        "at": (old.get(c.id) or {}).get("at") or _now(), "by": (old.get(c.id) or {}).get("by") or _me()} for c in req.changes]
    if req.input_item_id and req.input_item_id != prep["input"]["item_id"]:
        drive._item(req.input_item_id)
        prep["input"] = {"item_id": req.input_item_id}
    if req.project_scoped is not None:
        if req.project_scoped:
            s = scope(item, {**prep, "project_scoped": True})
            if s["problems"]:
                raise HTTPException(400, "fix these first: " + "; ".join(s["problems"]))
        prep["project_scoped"] = req.project_scoped
    _write(item, prep)
    return _public(item, prep)


class MoveIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str


@router.post("/{item_id}/save-as")
def save_as(item_id: str, req: MoveIn) -> dict:
    """Save: give the preparation a name and location (moves it out of .auto-save)."""
    item, prep = _load(item_id, "editor")
    folder = drive._folder_id(req.folder_id)
    name = req.name.strip() if req.name.strip().endswith(".preparation") else f"{req.name.strip()}.preparation"
    drive.update_item(item["id"], drive.ItemChange(move_to=folder, name=drive._free_name(folder, name) if folder != item.get("parent_id") else name))
    return _public(drive._item(item["id"]), prep)


@router.post("/{item_id}/duplicate")
def duplicate(item_id: str) -> dict:
    item, prep = _load(item_id)
    folder = item.get("parent_id") or _autosave_folder()
    try:
        drive._item(folder, need="editor")
    except HTTPException:
        folder = _autosave_folder()
    copy = {**prep, "outputs": [], "saved_versions": [], "created_at": _now(), "created_by": _me()}
    body = json.dumps(copy).encode()
    new = drive._store(folder, drive._free_name(folder, item["name"].replace(".preparation", " (copy).preparation")), io.BytesIO(body), len(body), PREP_TYPE)
    return _public(new, copy)


# ------------------------------------------------------------------------------------------------
# compiling changes
# ------------------------------------------------------------------------------------------------


def _string(t: str) -> bool:
    return t.upper().startswith(("VARCHAR", "STRING", "TEXT"))


def snake(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name).strip())
    s = re.sub(r"[^0-9a-zA-Z]+", "_", s).strip("_").lower()
    return s or "column"


def _expr(sql: str) -> str:
    """A Spark SQL expression (Contour's expression language here) in DuckDB."""
    import sqlglot

    text = re.sub(r"monotonically_increasing_id\(\s*\)", "__row", sql, flags=re.I)
    try:
        return sqlglot.transpile(text, read="spark", write="duckdb")[0]
    except sqlglot.errors.ParseError as e:
        raise ValueError(f"the expression does not parse: {str(e).splitlines()[0][:200]}") from None


def _cond(col: str, values: list, nulls: bool) -> str:
    parts = []
    vals = [v for v in values if v is not None]
    if vals:
        parts.append(f"CAST({q(col)} AS VARCHAR) IN ({', '.join(lit(str(v)) for v in vals)})")
    if nulls or any(v is None for v in values):
        parts.append(f"{q(col)} IS NULL")
    return "(" + " OR ".join(parts) + ")" if parts else "TRUE"


TYPES = {"string": "VARCHAR", "integer": "BIGINT", "double": "DOUBLE", "date": "DATE", "timestamp": "TIMESTAMP", "boolean": "BOOLEAN"}


def _value(v: Any, typ: str) -> str:
    if v == "/NULL" or v is None:
        return "NULL"
    return f"TRY_CAST({lit(v)} AS {typ})"


def compile_change(c: dict, cols: list[tuple[str, str]], prev: str) -> str:
    """One change as a SELECT over the previous step; `cols`: (name, DuckDB type) of the previous step."""
    p = c.get("params") or {}
    names = [n for n, _ in cols]
    types = dict(cols)

    def need(col: str) -> str:
        if col not in types:
            raise ValueError(f"no column {col!r}")
        return col

    t = c["type"]
    if t in ("trim", "empty_to_null", "change_case"):
        col = need(p.get("column"))
        x = q(col)
        e = {"trim": f"trim({x})", "empty_to_null": f"nullif({x}, '')"}.get(t)
        if t == "change_case":
            case = p.get("case", "upper")
            e = {"upper": f"upper({x})", "lower": f"lower({x})",
                 "title": f"array_to_string(list_transform(string_split(lower({x}), ' '), w -> upper(w[1]) || w[2:]), ' ')"}.get(case)
            if not e:
                raise ValueError(f"unknown case {case}")
        return f"SELECT * REPLACE ({e} AS {x}) FROM {prev}"
    if t == "normalize_strings":
        targets = [need(x) for x in p.get("columns") or []] or [n for n, ty in cols if _string(ty) and n != "__row"]
        reps = []
        for col in targets:
            e = q(col)
            for op in p.get("ops") or ["trim"]:
                e = {"trim": f"trim({e})", "collapse_whitespace": f"regexp_replace({e}, '\\s+', ' ', 'g')", "lowercase": f"lower({e})", "uppercase": f"upper({e})",
                     "empty_to_null": f"nullif({e}, '')", "remove_non_printable": f"regexp_replace({e}, '[^[:print:]]', '', 'g')"}.get(op) or e
            reps.append(f"{e} AS {q(col)}")
        return f"SELECT * REPLACE ({', '.join(reps)}) FROM {prev}" if reps else f"SELECT * FROM {prev}"
    if t == "change_type":
        col = need(p.get("column"))
        to = TYPES.get(p.get("to"))
        if not to:
            raise ValueError(f"unknown type {p.get('to')}")
        x = q(col)
        if to in ("BIGINT", "DOUBLE") and _string(types[col]):
            # currency and thousands separators: keep digits, the decimal point, the sign and exponents
            e = f"TRY_CAST(nullif(regexp_replace({x}, '[^0-9.eE+-]', '', 'g'), '') AS {to})"
            if to == "BIGINT":
                e = f"CAST(round(TRY_CAST(nullif(regexp_replace({x}, '[^0-9.eE+-]', '', 'g'), '') AS DOUBLE)) AS BIGINT)"
        else:
            e = f"TRY_CAST({x} AS {to})"
        return f"SELECT * REPLACE ({e} AS {x}) FROM {prev}"
    if t == "new_value":
        col = need(p.get("column"))
        cond = _cond(col, p.get("values") or [], bool(p.get("nulls"))) if (p.get("values") or p.get("nulls")) else "TRUE"
        return f"SELECT * REPLACE (CASE WHEN {cond} THEN {_value(p.get('value'), types[col])} ELSE {q(col)} END AS {q(col)}) FROM {prev}"
    if t == "extract":
        col = need(p.get("column"))
        x = f"CAST({q(col)} AS VARCHAR)"
        if p.get("kind", "substring") == "substring":
            start, end = int(p.get("start") or 1), int(p.get("end") or 1)
            e = f"substr({x}, {start}, {max(0, end - start + 1)})"
        else:
            e = f"nullif(regexp_extract({x}, {lit(p.get('pattern') or '')}, {int(p.get('group') or 0)}), '')"
        target = p.get("into") or col
        return f"SELECT * REPLACE ({e} AS {q(col)}) FROM {prev}" if target == col else f"SELECT *, {e} AS {q(target)} FROM {prev}"
    if t == "normalize_column_names":
        seen: dict[str, int] = {}
        sel = []
        for n in names:
            if n == "__row":
                sel.append(q(n))
                continue
            s = snake(n)
            seen[s] = seen.get(s, 0) + 1
            sel.append(f"{q(n)} AS {q(s if seen[s] == 1 else f'{s}_{seen[s]}')}")
        return f"SELECT {', '.join(sel)} FROM {prev}"
    if t == "rename":
        ren = {k: v for k, v in (p.get("renames") or {}).items() if v and k != v}
        for k in ren:
            need(k)
        return f"SELECT {', '.join(f'{q(n)} AS {q(ren.get(n, n))}' for n in names)} FROM {prev}"
    if t == "delete_columns":
        drop = [need(x) for x in p.get("columns") or []]
        return f"SELECT * EXCLUDE ({', '.join(q(x) for x in drop)}) FROM {prev}" if drop else f"SELECT * FROM {prev}"
    if t in ("remove_rows", "keep_rows"):
        col = need(p.get("column"))
        cond = _cond(col, p.get("values") or [], bool(p.get("nulls")))
        return f"SELECT * FROM {prev} WHERE {'NOT ' if t == 'remove_rows' else ''}coalesce({cond}, FALSE)"
    if t == "add_column":
        name = (p.get("name") or "").strip()
        if not name or name in types:
            raise ValueError("give the new column a name not used yet")
        return f"SELECT *, ({_expr(p.get('expression') or 'NULL')}) AS {q(name)} FROM {prev}"
    if t == "apply_expression":
        col = need(p.get("column"))
        return f"SELECT * REPLACE (({_expr(p.get('expression') or q(col))}) AS {q(col)}) FROM {prev}"
    if t == "split":
        col = need(p.get("column"))
        into = [x for x in p.get("into") or [] if x]
        if not into:
            raise ValueError("name the columns to split into")
        parts = ", ".join(f"nullif(split_part(CAST({q(col)} AS VARCHAR), {lit(p.get('delimiter') or ' ')}, {i + 1}), '') AS {q(n)}" for i, n in enumerate(into))
        return f"SELECT *, {parts} FROM {prev}"
    raise ValueError(f"unknown change {t}")


class Compiled:
    def __init__(self, con: duckdb.DuckDBPyConnection, sql: str, applied: int, errors: dict[str, str], columns: list[tuple[str, str]]) -> None:
        self.con, self.sql, self.applied, self.errors, self.columns = con, sql, applied, errors, columns


def _input(prep: dict) -> tuple[pa.Table, dict]:
    import sql_studio

    return sql_studio._data_table(prep["input"]["item_id"])


def compile_prep(prep: dict, upto: Optional[int] = None, table: Optional[pa.Table] = None) -> Compiled:
    """The changelog (up to change `upto`, exclusive) over the starting dataset."""
    if table is None:
        table, _ = _input(prep)
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.register("__input", table)
    con.execute("CREATE TEMP VIEW s0 AS SELECT *, row_number() OVER () - 1 AS __row FROM __input")
    prev = "s0"
    errors: dict[str, str] = {}
    changes = (prep.get("changes") or [])[: upto if upto is not None else None]
    applied = 0

    def cols_of(view: str) -> list[tuple[str, str]]:
        return [(r[0], r[1]) for r in con.execute(f"DESCRIBE {view}").fetchall()]

    for i, c in enumerate(changes):
        try:
            sql = compile_change(c, cols_of(prev), prev)
            con.execute(f"CREATE TEMP VIEW s{i + 1} AS {sql}")
            con.execute(f"SELECT * FROM s{i + 1} LIMIT 0")
            prev = f"s{i + 1}"
            applied += 1
        except (ValueError, duckdb.Error) as e:
            errors[c["id"]] = str(e).splitlines()[0][:400]
            break
    columns = [x for x in cols_of(prev) if x[0] != "__row"]
    return Compiled(con, f"SELECT * EXCLUDE (__row) FROM {prev}", applied, errors, columns)


def _arrow_type_name(t: str) -> str:
    u = t.upper()
    return ("String" if _string(u) else "Integer" if u in ("BIGINT", "INTEGER", "SMALLINT", "TINYINT", "HUGEINT", "UBIGINT", "UINTEGER") else
            "Double" if u in ("DOUBLE", "FLOAT", "REAL") or u.startswith("DECIMAL") else "Date" if u == "DATE" else "Timestamp" if u.startswith("TIMESTAMP") else
            "Boolean" if u == "BOOLEAN" else t)


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


class PreviewIn(BaseModel):
    upto: Optional[int] = None
    focus: Optional[dict[str, Any]] = None  # {column, values, nulls}
    changes: Optional[list[ChangeIn]] = None  # unsaved changes (staged renames)


def _with(prep: dict, req: PreviewIn) -> dict:
    if req.changes is None:
        return prep
    return {**prep, "changes": [{"id": c.id or f"tmp{i}", "type": c.type, "params": c.params} for i, c in enumerate(req.changes)]}


@router.post("/{item_id}/preview")
def preview(item_id: str, req: PreviewIn) -> dict:
    _, prep = _load(item_id)
    prep = _with(prep, req)
    try:
        c = compile_prep(prep, req.upto)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - the starting dataset cannot be read
        raise HTTPException(400, f"the starting dataset cannot be read: {e}") from None
    where = ""
    f = req.focus or {}
    if f.get("column") and (f.get("values") or f.get("nulls")):
        where = f" WHERE coalesce({_cond(f['column'], f.get('values') or [], bool(f.get('nulls')))}, FALSE)"
    total = c.con.execute(f"SELECT count(*) FROM ({c.sql}){where}").fetchone()[0]
    all_rows = c.con.execute(f"SELECT count(*) FROM ({c.sql})").fetchone()[0]
    res = c.con.execute(f"SELECT * FROM ({c.sql}){where} LIMIT {PREVIEW_ROWS}")
    names = [d[0] for d in res.description]
    rows = [[_cell(v) for v in r] for r in res.fetchall()]
    return {"columns": [{"name": n, "type": _arrow_type_name(t)} for n, t in c.columns], "rows": rows, "names": names, "row_count": all_rows,
            "focused_rows": total if where else None, "applied": c.applied, "errors": c.errors}


@router.post("/{item_id}/stats")
def stats(item_id: str, column: str, req: PreviewIn) -> dict:
    """A column's statistics and quality flags (each with the change that fixes it)."""
    _, prep = _load(item_id)
    c = compile_prep(_with(prep, req), req.upto)
    types = dict(c.columns)
    if column not in types:
        raise HTTPException(404, f"no column {column}")
    x = q(column)
    base = f"({c.sql})"
    total, nulls, distinct = c.con.execute(f"SELECT count(*), count(*) - count({x}), count(DISTINCT {x}) FROM {base}").fetchone()
    out: dict[str, Any] = {"column": column, "type": _arrow_type_name(types[column]), "rows": total, "nulls": nulls, "distinct": distinct, "flags": []}
    top = c.con.execute(f"SELECT CAST({x} AS VARCHAR) AS v, count(*) AS n FROM {base} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 25").fetchall()
    out["top"] = [{"value": v, "count": n} for v, n in top]
    flags = out["flags"]
    if total and nulls == total:
        flags.append({"kind": "all_null", "label": "Null (100%)", "count": nulls, "action": "Delete column", "change": {"type": "delete_columns", "params": {"columns": [column]}}})
    elif total and nulls / total > 0.5:
        flags.append({"kind": "mostly_null", "label": f"Null ({nulls / total:.0%})", "count": nulls, "action": None, "change": None})
    if _string(types[column]):
        trim, empty, upper, lower, numeric = c.con.execute(
            f"SELECT count(*) FILTER (WHERE {x} <> trim({x})), count(*) FILTER (WHERE {x} = ''), count(*) FILTER (WHERE {x} = upper({x}) AND {x} <> lower({x})), "
            f"count(*) FILTER (WHERE {x} = lower({x}) AND {x} <> upper({x})), count(*) FILTER (WHERE TRY_CAST(nullif(regexp_replace({x}, '[^0-9.eE+-]', '', 'g'), '') AS DOUBLE) IS NOT NULL "
            f"AND regexp_matches({x}, '^[^A-Za-z]*$')) FROM {base}").fetchone()
        nonnull = total - nulls
        out.update(needs_trim=trim, empty=empty, uppercase=upper, lowercase=lower, mixed_case=max(0, nonnull - upper - lower - empty), numeric_like=numeric)
        if trim:
            flags.append({"kind": "needs_trim", "label": "Needs trim", "count": trim, "action": "Trim whitespace", "change": {"type": "trim", "params": {"column": column}}})
        if empty:
            flags.append({"kind": "empty", "label": "Empty", "count": empty, "action": "Set to null", "change": {"type": "empty_to_null", "params": {"column": column}}})
        if nonnull and numeric == nonnull:
            flags.append({"kind": "numeric", "label": "Numeric", "count": numeric, "action": "Change type to Double", "change": {"type": "change_type", "params": {"column": column, "to": "double"}}})
    else:
        try:
            mn, mx, mean = c.con.execute(f"SELECT min({x}), max({x}), avg(TRY_CAST({x} AS DOUBLE)) FROM {base}").fetchone()
            out.update(min=_cell(mn), max=_cell(mx), mean=mean)
        except duckdb.Error:
            pass
    return out


# ------------------------------------------------------------------------------------------------
# outputs
# ------------------------------------------------------------------------------------------------


def project_of(item_id: Optional[str]) -> Optional[dict]:
    path = db.drive_path(item_id) if item_id else []
    return {"id": path[0]["id"], "name": path[0]["name"]} if path else None


def scope(item: dict, prep: dict) -> dict:
    """Project scoping: the input must be in the preparation's Project (or referenced there), outputs in that Project."""
    import project_references

    proj = project_of(item["id"])
    problems = []
    inp = prep.get("input", {}).get("item_id")
    in_proj = project_of(inp)
    input_ok = bool(proj and in_proj and (in_proj["id"] == proj["id"] or project_references.is_referenced(proj["id"], inp)))
    if prep.get("project_scoped") and not input_ok:
        problems.append(f"the input dataset is not in {proj['name'] if proj else 'this Project'} and not referenced there")
    out_bad = [o for o in prep.get("outputs") or [] if (project_of(o["item_id"]) or {}).get("id") != (proj or {}).get("id")]
    if prep.get("project_scoped") and out_bad:
        problems.append(f"{len(out_bad)} output(s) are outside {proj['name'] if proj else 'this Project'}")
    return {"project": proj, "input_in_scope": input_ok, "input_project": in_proj, "problems": problems}


class SaveDatasetIn(BaseModel):
    folder_id: str
    name: str = Field(min_length=1, max_length=200)
    mode: str = "updating"  # updating | one_off


def _input_markings(item: dict, prep: dict) -> tuple[set[str], list[str]]:
    """The markings an output carries — its input dataset's and the preparation's, as a pipeline output carries its
    inputs' and the pipeline's — and the input, for lineage. Applied before any of its rows exist
    (marked_outputs.py)."""
    inputs = [i for i in [(prep.get("input") or {}).get("item_id")] if i]
    return marked_outputs.markings_of([item["id"], *inputs]), inputs


def _build(item: dict, prep: dict) -> tuple[bytes, int]:
    import pyarrow.parquet as pq

    c = compile_prep(prep)
    if c.errors:
        raise HTTPException(400, "fix the changes in red first: " + "; ".join(c.errors.values()))
    table = c.con.execute(c.sql).arrow()
    if hasattr(table, "read_all"):
        table = table.read_all()
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue(), table.num_rows


@router.post("/{item_id}/save-dataset")
def save_dataset(item_id: str, req: SaveDatasetIn) -> dict:
    """Save as dataset: an updating dataset (rebuilt with Update) or a one-off one."""
    import dataset_versions
    import pipeline_datasets

    if req.mode not in ("updating", "one_off"):
        raise HTTPException(400, "mode: updating or one_off")
    item, prep = _load(item_id, "editor")
    folder = drive._folder_id(req.folder_id)
    if prep.get("project_scoped"):
        s = scope(item, prep)
        proj = s["project"]
        if not s["input_in_scope"]:
            raise HTTPException(400, f"the input dataset is out of this preparation's Project scope: add it as a reference to {proj['name'] if proj else 'the Project'} first")
        if (project_of(folder) or {}).get("id") != (proj or {}).get("id"):
            raise HTTPException(400, f"a Project-scoped preparation saves into its own Project ({proj['name'] if proj else '?'})")
    data, rows = _build(item, prep)
    name = req.name.strip() if req.name.strip().endswith(".parquet") else f"{req.name.strip()}.parquet"
    branch = prep.get("branch") or "master"
    if branch != "master":
        # a dataset saved on a branch: the branch copy under _branches/<branch>/ next to it (Dataset Preview's layout)
        folder = drive._ensure_folders(folder, [BRANCHES, branch.replace("/", "-")])
    existing = next((c for c in db.drive_list(folder) if c["kind"] == "file" and c["name"] == name and not c.get("trashed_at")), None)
    marks, inputs = _input_markings(item, prep)
    if existing:
        marked_outputs.replace(existing, data, pipeline_datasets.PARQUET, marks, inputs)
        out = db.drive_get(existing["id"])
    else:
        out = marked_outputs.create(folder, name, data, pipeline_datasets.PARQUET, marks, inputs)
    source = {"kind": "preparation", "id": item["id"], "name": item["name"].removesuffix(".preparation"), "transaction": "SNAPSHOT", "branch": branch}
    dataset_versions.record(out["id"], data, "build", source)
    version = {"id": uuid.uuid4().hex[:10], "at": _now(), "by": _me(), "output_item_id": out["id"], "changes": prep.get("changes") or [], "input": prep["input"],
               "branch": branch}
    prep.setdefault("saved_versions", []).insert(0, version)
    prep["saved_versions"] = prep["saved_versions"][:30]
    prep["outputs"] = [o for o in prep.get("outputs") or [] if o["item_id"] != out["id"]] + [
        {"item_id": out["id"], "mode": req.mode, "saved_at": _now(), "rows": rows, "changes": len(prep.get("changes") or []), "input_updated_at": _input_stamp(prep),
         "branch": branch}]
    _write(item, prep)
    return {**_public(item, prep), "saved": {"item_id": out["id"], "rows": rows}}


def _input_stamp(prep: dict) -> Optional[str]:
    inp = db.drive_get(prep["input"]["item_id"])
    return str(inp.get("updated_at")) if inp else None


@router.post("/{item_id}/outputs/{output_item_id}/update")
def update_output(item_id: str, output_item_id: str) -> dict:
    """Update: rebuild an updating output from the current changelog and starting dataset."""
    import dataset_versions
    import pipeline_datasets

    item, prep = _load(item_id, "editor")
    o = next((x for x in prep.get("outputs") or [] if x["item_id"] == output_item_id), None)
    if not o:
        raise HTTPException(404, "not an output of this preparation")
    if o["mode"] != "updating":
        raise HTTPException(400, "a one-off dataset is not updated: save a new dataset")
    out = drive._item(output_item_id, need="editor")
    data, rows = _build(item, prep)
    marked_outputs.replace(out, data, pipeline_datasets.PARQUET, *_input_markings(item, prep))
    dataset_versions.record(out["id"], data, "build", {"kind": "preparation", "id": item["id"], "name": item["name"].removesuffix(".preparation"), "transaction": "SNAPSHOT"})
    o.update(saved_at=_now(), rows=rows, changes=len(prep.get("changes") or []), input_updated_at=_input_stamp(prep))
    _write(item, prep)
    return _public(item, prep)


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.post("/{item_id}/branches")
def create_branch(item_id: str, req: BranchIn) -> dict:
    """Create a branch (the branch selector's Create branch) and switch to it: datasets saved now go to their branch
    copies, and Restore saved version offers that branch's saves."""
    item, prep = _load(item_id, "editor")
    name = req.name.strip()
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", name) or name == "master":
        raise HTTPException(400, "a branch name holds letters, digits, . _ - and /, and is not master")
    if name in (prep.get("branches") or []):
        raise HTTPException(409, f"the branch {name} exists")
    prep["branches"] = [*(prep.get("branches") or []), name]
    prep["branch"] = name
    _write(item, prep)
    return _public(item, prep)


@router.put("/{item_id}/branch")
def switch_branch(item_id: str, req: BranchIn) -> dict:
    item, prep = _load(item_id, "editor")
    if req.name != "master" and req.name not in (prep.get("branches") or []):
        raise HTTPException(404, f"no branch {req.name}")
    prep["branch"] = req.name
    _write(item, prep)
    return _public(item, prep)


class SaveBranchIn(BaseModel):
    branch: str


@router.post("/{item_id}/outputs/{output_item_id}/save-branch")
def save_to_branch(item_id: str, output_item_id: str, req: SaveBranchIn) -> dict:
    """Actions → Save to another branch: write the preparation's result to an output's copy on another branch."""
    import dataset_versions
    import dataset_preview
    import pipeline_datasets

    item, prep = _load(item_id, "editor")
    o = next((x for x in prep.get("outputs") or [] if x["item_id"] == output_item_id), None)
    if not o:
        raise HTTPException(404, "not an output of this preparation")
    if req.branch != "master" and req.branch not in (prep.get("branches") or []):
        raise HTTPException(404, f"no branch {req.branch}: create it first")
    out = drive._item(output_item_id, need="viewer")
    master_parent, out_branch = dataset_preview._master(out)
    folder = master_parent if req.branch == "master" else drive._ensure_folders(master_parent, [BRANCHES, req.branch.replace("/", "-")])
    data, rows = _build(item, prep)
    target = next((c for c in db.drive_list(folder) if c["kind"] == "file" and c["name"] == out["name"] and not c.get("trashed_at")), None)
    marks, inputs = _input_markings(item, prep)
    if target:
        drive._item(target["id"], need="editor")
        marked_outputs.replace(target, data, pipeline_datasets.PARQUET, marks, inputs)
        target = db.drive_get(target["id"])
    else:
        drive._item(folder, need="editor")
        target = marked_outputs.create(folder, out["name"], data, pipeline_datasets.PARQUET, marks, inputs)
    dataset_versions.record(target["id"], data, "build", {"kind": "preparation", "id": item["id"], "name": item["name"].removesuffix(".preparation"),
                                                         "transaction": "SNAPSHOT", "branch": req.branch})
    prep.setdefault("saved_versions", []).insert(0, {"id": uuid.uuid4().hex[:10], "at": _now(), "by": _me(), "output_item_id": target["id"],
                                                     "changes": prep.get("changes") or [], "input": prep["input"], "branch": req.branch})
    prep["saved_versions"] = prep["saved_versions"][:30]
    o.setdefault("branch_copies", {})[req.branch] = {"item_id": target["id"], "saved_at": _now(), "rows": rows}
    _write(item, prep)
    return {**_public(item, prep), "saved": {"item_id": target["id"], "rows": rows, "branch": req.branch}}


class RestoreIn(BaseModel):
    version_id: str


@router.post("/{item_id}/restore")
def restore(item_id: str, req: RestoreIn) -> dict:
    """Restore saved version: the changelog (and starting dataset) a dataset was saved with."""
    item, prep = _load(item_id, "editor")
    v = next((x for x in prep.get("saved_versions") or [] if x["id"] == req.version_id), None)
    if not v:
        raise HTTPException(404, "no such saved version")
    prep["changes"] = v["changes"]
    prep["input"] = v["input"]
    if v.get("branch") and v["branch"] != (prep.get("branch") or "master"):
        prep["branch"] = v["branch"]
    _write(item, prep)
    return _public(item, prep)


@router.get("")
def list_preparations() -> list[dict]:
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND d.content_type = %s", (PREP_TYPE,), limit=1000)
    out = []
    for it in items:
        if not auth.can_access(it["id"]):
            continue
        try:
            prep = json.loads(drive.read_bytes(it) or b"{}")
        except ValueError:
            continue
        path = [p["name"] for p in db.drive_path(it["id"])[:-1]]
        out.append({"id": it["id"], "name": it["name"].removesuffix(".preparation"), "path": path, "changes": len(prep.get("changes") or []),
                    "outputs": len(prep.get("outputs") or []), "updated_at": prep.get("updated_at") or str(it.get("updated_at")), "autosaved": bool(path) and path[-1] == ".auto-save"})
    return sorted(out, key=lambda x: x["updated_at"] or "", reverse=True)


# what Data Lineage reads of each preparation (input, outputs, updated_at), by item id, kept until the file changes and
# on disk: each graph build read every preparation from storage (S3 included), again after every restart
_LINEAGE_KEYS = ("input", "outputs", "updated_at")
_contents: dict[str, tuple[str, dict]] = {}
_contents_loaded = False
_contents_lock = threading.Lock()


def _contents_file():
    import dataset_versions

    return dataset_versions.DIR.parent / "lineage_preparations.json"


def all_preparations() -> list[tuple[dict, dict]]:
    """Every preparation (item, {input, outputs, updated_at}), for Data Lineage."""
    global _contents_loaded
    with _contents_lock:
        if not _contents_loaded:
            _contents_loaded = True
            try:
                for k, (stamp, content) in json.loads(_contents_file().read_text("utf-8")).items():
                    _contents.setdefault(k, (stamp, content))
            except (OSError, ValueError, TypeError):
                pass
    out = []
    changed = False
    for it in db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND d.content_type = %s", (PREP_TYPE,), limit=1000):
        stamp = f"{it.get('updated_at')}|{it.get('size')}"
        hit = _contents.get(it["id"])
        try:
            if hit and hit[0] == stamp:
                auth.check_item(it)  # as a read of the file would
                out.append((it, hit[1]))
                continue
            full = json.loads(drive.read_bytes(it) or b"{}")
        except ValueError:
            continue
        content = {k: full.get(k) for k in _LINEAGE_KEYS}
        _contents[it["id"]] = (stamp, content)
        changed = True
        out.append((it, content))
    if changed:
        with _contents_lock:
            try:
                path = _contents_file()
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
                tmp.write_text(json.dumps(_contents), "utf-8")
                tmp.replace(path)
            except OSError:
                pass
    return out
