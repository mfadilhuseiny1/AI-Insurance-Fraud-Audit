"""Contour (Analytics doc 03): analyses of paths of boards on datasets and Ontology objects.

An analysis is a Files item (content type CONTOUR_MIME): parameters, paths (each starting from a dataset, an object
type or another path's result, then boards — see contour_engine.py), a dashboard (tabs of boards and text) and the
datasets saved from paths. Running a path returns, for every board, the row count and columns after it and the data
of visualizations; a failing board stops the path there with its error.

- Parameters: string / number / date, multi-value, defaults, suggested values from a column (up to 1,000 distinct
  values) or a list; viewers override them without changing the analysis.
- Dashboard: tabs of boards (any path) and text with $parameter references; viewers' selections filter downstream
  boards (chart-to-chart filtering) for their session only; PDF via the browser's print.
- Save as dataset: a path's result written as Parquet next to the analysis; "Build" recomputes it from the current
  inputs (refresh), by hand or on a schedule (every N hours, run as the user who set it; startup() starts the loop). Export: CSV of a board's data (100,000 rows); a path's SQL for Pipeline Builder and the path as a
  pipeline (contour_pipeline.py).

Mounted by server.py under /api/contour.
"""

from __future__ import annotations

import copy
import csv
import io
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import contour_engine as E

router = APIRouter(prefix="/api/contour")

CONTOUR_MIME = "application/vnd.bluesandai.contour+json"
TABLE_ROWS = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _item(item_id: str, need: str = "viewer") -> dict:
    import drive

    item = drive._item(item_id, need=need)
    if item.get("kind") != "file" or item.get("content_type") != CONTOUR_MIME:
        raise HTTPException(404, "analysis not found")
    return item


def _load(item: dict) -> dict:
    import drive

    try:
        a = json.loads(drive.read_bytes(item).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(500, "the analysis is not readable") from None
    a.setdefault("parameters", [])
    a.setdefault("paths", [])
    a.setdefault("dashboard", {"tabs": [{"id": "tab1", "name": "Dashboard", "items": []}]})
    a.setdefault("saved", {})
    return a


def _store(item: dict, a: dict) -> None:
    import pipeline_datasets

    pipeline_datasets._replace_content(item, json.dumps(a, ensure_ascii=False).encode("utf-8"), CONTOUR_MIME)


def _check(a: dict) -> None:
    names = [p["name"] for p in a.get("parameters") or []]
    if len(set(names)) != len(names) or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", n) for n in names):
        raise HTTPException(400, "parameter names are unique identifiers (letters, digits, _)")
    import contour_scale

    try:
        contour_scale.settings(a)
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    ids = set()
    for p in a.get("paths") or []:
        if p["id"] in ids:
            raise HTTPException(400, "path IDs must be unique")
        ids.add(p["id"])
        if (p.get("source") or {}).get("kind") not in ("dataset", "object_type", "path", "restricted_view"):
            raise HTTPException(400, f"path {p.get('name')}: choose a dataset, a restricted view, an object type or a path to start from")
        for b in p.get("boards") or []:
            if b.get("type") not in E.TRANSFORMS + E.VISUALS:
                raise HTTPException(400, f"unknown board {b.get('type')}")


def _load_source(src: dict):
    """An analysis source as an Arrow table, read with the user's permissions."""
    import drive
    import pyarrow as pa
    import pyarrow.parquet as pq
    import workshop

    if src["kind"] == "dataset":
        item = drive._item(src["id"])
        try:
            return pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).read()
        except Exception as e:  # noqa: BLE001
            raise E.ContourError(f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    if src["kind"] == "restricted_view":
        # the rows this user may see (restricted_views.py); never saved back as a dataset by a batch job
        import restricted_views

        return restricted_views.table_for_ref(src["id"])[0]
    if src["kind"] == "object_type":
        cols, _types, rows = workshop._object_rows(src["id"])
        return pa.Table.from_pylist([{c: r.get(c) for c in cols} for r in rows]) if rows else pa.table({c: pa.array([], pa.string()) for c in cols})
    raise E.ContourError(f"unknown source {src['kind']}")


_BOUNDARIES: dict[tuple, list] = {}
BOUNDARIES_MAX = 200 * 1024 * 1024


def _boundaries(item_id: str) -> list[dict]:
    """The features of a GeoJSON FeatureCollection in Files (a map board's choropleth regions), read with the user's
    permissions; parsed once per file version."""
    import drive

    try:
        item = drive._item(item_id)
    except HTTPException as e:
        raise E.ContourError(f"the boundaries file: {e.detail}") from None
    if (item.get("size") or item.get("size_bytes") or 0) > BOUNDARIES_MAX:
        raise E.ContourError(f'{item["name"]} is over 200 MB: too large for a map')
    key = (item_id, item.get("updated_at"), item.get("size"))
    if key not in _BOUNDARIES:
        try:
            doc = json.loads(drive.read_bytes(item).decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise E.ContourError(f'{item["name"]} is not GeoJSON') from None
        if not isinstance(doc, dict) or doc.get("type") != "FeatureCollection":
            raise E.ContourError(f'{item["name"]} is not a GeoJSON FeatureCollection')
        if len(_BOUNDARIES) > 8:
            _BOUNDARIES.clear()
        _BOUNDARIES[key] = [f for f in doc.get("features") or [] if isinstance(f, dict)]
    return _BOUNDARIES[key]


def _compiler(a: dict, params: dict, path_id: Optional[str] = None, scale: bool = True) -> E.Compiler:
    """The DuckDB compiler for a request; large datasets the path reads are scanned from disk, not read into memory
    (contour_scale.py; `scale` False reads everything into memory). `comp.plan` is the engine decision."""
    import contour_scale

    try:
        vals = E.param_values(a.get("parameters") or [], params)
        plan = contour_scale.Plan(a, path_id, scale=scale)
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    if a.get("expression_dialect") == "spark":
        vals[E.DIALECT_KEY] = "spark"
    comp = plan.compiler(a, vals, _load_source)
    comp.plan = plan
    return comp


def _run_spark(a: dict, path_id: str, comp: E.Compiler) -> Optional[dict]:
    """run_path on Spark (contour_spark.py), or None — with a note on the plan — when the path has a board Spark does
    not run here, Spark cannot start or the Spark run fails (the caller then runs DuckDB)."""
    import contour_scale
    import contour_spark as S
    import drive

    plan = comp.plan
    try:
        S.check(a, path_id)
        spark = S.session()
    except S.Unsupported as e:
        plan.notes.append(f"Spark does not run {e} here: the path ran on DuckDB")
        return None
    except S.SparkUnavailable as e:
        plan.notes.append(f"{e}: the path ran on DuckDB")
        return None
    run = S.SparkRun(a, comp.params, spark, lambda src: contour_scale.dataset_file(drive._item(src["id"])), boundaries=_boundaries)
    try:
        out = run.run_path(path_id, TABLE_ROWS)
    except S.Unsupported as e:
        plan.notes.append(f"Spark does not run {e} here: the path ran on DuckDB")
        return None
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — a board error, a Spark failure: DuckDB runs the path (and reports a board error)
        msg = str(getattr(e, "desc", None) or e).strip().splitlines()
        plan.notes.append(f"the Spark run failed ({(msg[0] if msg else type(e).__name__)[:300]}): the path ran on DuckDB")
        return None
    finally:
        run.close()
    out["params"] = {k: v for k, v in comp.params.items() if k != E.DIALECT_KEY}
    out["engine"] = plan.report("spark")
    return out


def run_path(a: dict, path_id: str, params: dict) -> dict:
    """Every board's row count and columns after it, and visualization data, for one path. `engine` says which engine
    ran it (contour_scale.py): duckdb (in memory), duckdb-scan (large datasets scanned from disk) or spark."""
    comp = _compiler(a, params, path_id)
    p = comp.paths.get(path_id)
    if not p:
        raise HTTPException(404, "path not found")
    if comp.plan.want_spark():
        done = _run_spark(a, path_id, comp)
        if done is not None:
            return done
    out: dict[str, Any] = {"boards": {}, "engine": comp.plan.report(comp.plan.duck_engine())}
    try:
        rel = comp.path_rel(path_id, 0)
        out["source"] = {"rows": comp.count(rel), "columns": comp.columns(rel)}
    except E.ContourError as e:
        out["source"] = {"error": str(e)}
        return out
    for k, b in enumerate(p.get("boards") or []):
        res: dict[str, Any] = {}
        try:
            inp = comp.path_rel(path_id, k)
            if b["type"] == "map" or (b["type"] == "chart" and (b.get("config") or {}).get("kind") == "scatter"):
                # layers / points or density bins with their legends and trend (contour_viz.py)
                import contour_viz

                res.update(contour_viz.map_result(comp, b, inp, _boundaries) if b["type"] == "map" else contour_viz.scatter_result(comp, b, inp))
            elif b["type"] in E.VISUALS:
                sql = E.visual_sql(b, inp, comp.params)
                t = comp.run(sql, E.MAX_ROWS if b["type"] in ("map",) else (TABLE_ROWS if b["type"] in ("table", "export") else 5000))
                res["data"] = E.rows_of(t)
                res["data_columns"] = list(t.schema.names)
                if b["type"] in ("table", "export"):
                    res["total"] = comp.count(inp)
            after = comp.path_rel(path_id, k + 1)
            res["rows"] = comp.count(after)
            res["columns"] = comp.columns(after)
        except E.ContourError as e:
            res["error"] = str(e)
            out["boards"][b["id"]] = res
            break
        out["boards"][b["id"]] = res
    out["params"] = {k: v for k, v in comp.params.items() if k != E.DIALECT_KEY}
    return out


def _view(item: dict, a: dict) -> dict:
    import drive

    try:
        drive._item(item["id"], need="editor")
        can_edit = True
    except HTTPException:
        can_edit = False
    return {"item": drive._with_path(item), "analysis": a, "can_edit": can_edit}


# ------------------------------------------------------------------ routes


class NewIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None
    # start with a path on this source
    source: Optional[dict] = None


@router.get("/analyses")
def list_analyses() -> list[dict]:
    import db
    import drive

    drive._require_db()
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (CONTOUR_MIME,), order="updated_at DESC", limit=500)
    return [drive._with_path(i) for i in auth.visible(items)]


@router.post("/analyses")
def create_analysis(req: NewIn) -> dict:
    import drive

    a = {"title": req.title.strip(), "parameters": [], "paths": [], "dashboard": {"tabs": [{"id": "tab1", "name": "Dashboard", "items": []}]}, "saved": {}}
    if req.source:
        a["paths"].append({"id": uuid.uuid4().hex[:8], "name": "Path 1", "source": req.source, "boards": [{"id": uuid.uuid4().hex[:8], "type": "table", "config": {}}]})
    _check(a)
    name = drive._clean_name(req.title.strip())[:240] + ".contour"
    # an analysis made from a dataset in a Project starts in the Project's Autosaved section (Compass)
    auto = None
    if not req.parent_id and (req.source or {}).get("kind") == "dataset":
        import compass

        auto = compass.autosave_folder((req.source or {}).get("id"))
    folder = drive._folder_id(req.parent_id) if req.parent_id else auto or drive.default_folder("documents")
    item = drive.save_bytes(folder, drive._free_name(folder, name) if auto else name,
                            json.dumps(a, ensure_ascii=False).encode("utf-8"), CONTOUR_MIME)
    return _view(drive._item(item["id"]), a)


@router.get("/analyses/{item_id}")
def get_analysis(item_id: str) -> dict:
    item = _item(item_id)
    return _view(item, _load(item))


class SaveIn(BaseModel):
    analysis: dict


@router.put("/analyses/{item_id}")
def save_analysis(item_id: str, req: SaveIn) -> dict:
    item = _item(item_id, "editor")
    old = _load(item)
    # every save is a revision: a save made from an older revision than the stored one is refused (co-editing)
    if "rev" in req.analysis and int(req.analysis.get("rev") or 0) != int(old.get("rev") or 0):
        raise HTTPException(409, "the analysis was saved by someone else since you opened it: reloaded their version")
    a = {**req.analysis, "saved": old.get("saved") or {}, "rev": int(old.get("rev") or 0) + 1}
    for p in a.get("paths") or []:
        p.setdefault("id", uuid.uuid4().hex[:8])
        for b in p.get("boards") or []:
            b.setdefault("id", uuid.uuid4().hex[:8])
    _check(a)
    _store(item, a)
    return _view(_item(item_id), a)


class RunIn(BaseModel):
    params: dict[str, Any] = {}


@router.post("/analyses/{item_id}/paths/{path_id}/run")
def run_route(item_id: str, path_id: str, req: RunIn) -> dict:
    a = _load(_item(item_id))
    return run_path(a, path_id, req.params)


class DashboardIn(BaseModel):
    params: dict[str, Any] = {}
    # board id → the viewer's selection (overrides the saved one for this request)
    selections: dict[str, Any] = {}


@router.post("/analyses/{item_id}/dashboard")
def dashboard_data(item_id: str, req: DashboardIn) -> dict:
    """The dashboard's boards with the viewer's parameter values and selections (chart-to-chart filtering)."""
    a = copy.deepcopy(_load(_item(item_id)))
    for p in a["paths"]:
        for b in p.get("boards") or []:
            if b["id"] in req.selections:
                b["selection"] = req.selections[b["id"]]
    wanted = {it["path"] for t in a["dashboard"].get("tabs") or [] for it in t.get("items") or [] if it.get("kind") == "board"}
    return {"paths": {pid: run_path(a, pid, req.params) for pid in wanted if pid in {p["id"] for p in a["paths"]}}}


@router.get("/analyses/{item_id}/paths/{path_id}/boards/{board_id}/csv")
def board_csv(item_id: str, path_id: str, board_id: str, params: str = "{}") -> Response:
    """Export: the data at a board (a visualization's data, else the working data after it), up to 100,000 rows."""
    a = _load(_item(item_id))
    comp = _compiler(a, json.loads(params or "{}"), path_id)
    p = comp.paths.get(path_id)
    if not p:
        raise HTTPException(404, "path not found")
    k = next((i for i, b in enumerate(p.get("boards") or []) if b["id"] == board_id), None)
    if k is None:
        raise HTTPException(404, "board not found")
    b = p["boards"][k]
    try:
        sql = E.visual_sql(b, comp.path_rel(path_id, k), comp.params) if b["type"] in E.VISUALS and b["type"] not in ("table", "export") \
            else f"SELECT * FROM {comp.path_rel(path_id, k + 1)}"
        t = comp.run(sql, E.MAX_ROWS)
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(t.schema.names)
    for r in E.rows_of(t):
        w.writerow(["" if r[c] is None else r[c] for c in t.schema.names])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{b.get("title") or b["type"]}.csv"'})


class SaveDatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: Optional[str] = None
    params: dict[str, Any] = {}


def path_table(a: dict, path_id: str, params: dict, board_id: Optional[str] = None):
    """A path's result as an Arrow table (Code Workbook's Contour nodes): the whole path, or up to a board — a
    visualization's data (aggregated, unlimited) or the working data after a transform board."""
    comp = _compiler(a, params, path_id)
    p = comp.paths.get(path_id)
    if not p:
        raise HTTPException(404, "path not found")
    try:
        if not board_id:
            return comp.run(f"SELECT * FROM {comp.path_rel(path_id, None)}")
        k = next((i for i, b in enumerate(p.get("boards") or []) if b["id"] == board_id), None)
        if k is None:
            raise HTTPException(404, "the board is no longer in the path")
        b = p["boards"][k]
        if b["type"] in E.VISUALS and b["type"] not in ("table", "export"):
            return comp.run(E.visual_sql(b, comp.path_rel(path_id, k), comp.params))
        return comp.run(f"SELECT * FROM {comp.path_rel(path_id, k + 1)}")
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None


def _reads_restricted_view(a: dict, path_id: str, seen: Optional[set] = None) -> bool:
    """Whether a path (or a path it starts from, or a board joining another path) reads a restricted view."""
    seen = seen or set()
    if path_id in seen:
        return False
    seen.add(path_id)
    p = next((x for x in a.get("paths") or [] if x["id"] == path_id), None)
    if not p:
        return False
    src = p.get("source") or {}
    if src.get("kind") == "restricted_view" or "restricted_view" in json.dumps(p.get("boards") or []):
        return True
    return src.get("kind") == "path" and _reads_restricted_view(a, src.get("id"), seen)


def _no_restricted(a: dict, path_id: str) -> None:
    if _reads_restricted_view(a, path_id):
        raise HTTPException(400, "This path reads a restricted view: its rows depend on who reads them, so it cannot be saved as a dataset or "
                                 "become a pipeline (export the visible rows instead)")


def _input_markings(item: dict, a: dict, path_id: str) -> tuple[set[str], list[str]]:
    """The markings a path's result carries: those of the datasets and object types it reads (its start, the paths
    it starts from, joined / enriched / set math sides) and of the analysis; and the datasets read, for lineage."""
    import contour_scale
    import marked_outputs

    srcs = contour_scale.reachable_sources(a, path_id)
    datasets = [s["id"] for s in srcs if s.get("kind") == "dataset" and s.get("id")]
    others = [(s["kind"], s["id"]) for s in srcs if s.get("kind") not in ("dataset", "path") and s.get("id")]
    return marked_outputs.markings_of([item["id"], *datasets], others), datasets


def _write_dataset(item: dict, a: dict, path_id: str, name: str, folder_id: Optional[str], params: dict) -> dict:
    _no_restricted(a, path_id)
    import drive
    import marked_outputs
    import pipeline_datasets

    comp = _compiler(a, params, path_id)
    try:
        t = comp.run(f"SELECT * FROM {comp.path_rel(path_id, None)}")
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    if comp.udfs:
        # as in the reference: Cipher operations on columns are saved through Pipeline Builder or transforms
        raise HTTPException(400, "A path that uses a Cipher board cannot be saved as a dataset: use Pipeline Builder's Cipher steps")
    data = pipeline_datasets._parquet_bytes(t)
    cur = (a.get("saved") or {}).get(path_id) or {}
    live = pipeline_datasets._live_file(cur["dataset_id"]) if cur.get("dataset_id") else None
    # the dataset carries the markings of everything the path read (and of the analysis), as a pipeline output does:
    # created already marked, or marked before its rows are replaced (marked_outputs.py)
    marks, inputs = _input_markings(item, a, path_id)
    if live:
        marked_outputs.replace(live, data, pipeline_datasets.PARQUET, marks, inputs)
        did = cur["dataset_id"]
    else:
        folder = drive._folder_id(folder_id or item.get("parent_id"))
        did = marked_outputs.create(folder, f"{name}.parquet", data, pipeline_datasets.PARQUET, marks, inputs)["id"]
    keep = {k: v for k, v in ((a.get("saved") or {}).get(path_id) or {}).items() if k in ("schedule",)}
    a.setdefault("saved", {})[path_id] = {"dataset_id": did, "name": name, "rows": t.num_rows, "built_at": _now(), "params": {k: v for k, v in comp.params.items() if k != E.DIALECT_KEY}, **keep,
                                          "last_status": "succeeded", "last_error": None, "engine": comp.plan.duck_engine()}
    return a["saved"][path_id]


@router.post("/analyses/{item_id}/paths/{path_id}/save")
def save_as_dataset(item_id: str, path_id: str, req: SaveDatasetIn) -> dict:
    """Save as dataset: the path's result as a Parquet dataset; saving again (or Build) rewrites it."""
    item = _item(item_id, "editor")
    a = _load(item)
    saved = _write_dataset(item, a, path_id, req.name, req.folder_id, req.params)
    _store(item, a)
    return saved


@router.post("/analyses/{item_id}/paths/{path_id}/build")
def build(item_id: str, path_id: str) -> dict:
    """Recompute a saved dataset from the current inputs (with the parameters it was saved with)."""
    item = _item(item_id, "editor")
    a = _load(item)
    cur = (a.get("saved") or {}).get(path_id)
    if not cur:
        raise HTTPException(400, "save the path as a dataset first")
    saved = _write_dataset(item, a, path_id, cur["name"], None, cur.get("params") or {})
    _store(item, a)
    return saved


@router.get("/analyses/{item_id}/paths/{path_id}/sql")
def path_sql(item_id: str, path_id: str, params: str = "{}") -> dict:
    """The path as one SQL query (CTEs); a path on a single dataset reads it as `input`, for Pipeline Builder."""
    a = _load(_item(item_id))
    comp = _compiler(a, json.loads(params or "{}"), path_id)
    try:
        rel = comp.path_rel(path_id, None)
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    sql = comp.with_clause() + f"SELECT * FROM {rel}"
    single = len(comp.tables) == 1
    if single:
        only = next(iter(comp.tables))
        sql = re.sub(rf"\b{re.escape(only)}\b", "input", sql)
    src = next((p["source"] for p in a["paths"] if p["id"] == path_id), None)
    # exportable: every input is a dataset (Export to Pipeline Builder makes one pipeline input per dataset)
    return {"sql": sql, "single_source": single, "source": src, "inputs": len(comp.tables),
            "exportable": bool(comp.tables) and all(k.startswith("src_dataset_") for k in comp.tables)}


PB_SAMPLE_ROWS = 200


def _pb_type(t) -> str:
    """A Pipeline Builder column type for an Arrow type."""
    import pyarrow as pa

    if pa.types.is_boolean(t):
        return "Boolean"
    if pa.types.is_integer(t):
        return "Long" if t.bit_width > 32 else "Integer"
    if pa.types.is_floating(t):
        return "Double"
    if pa.types.is_decimal(t):
        return "Decimal"
    if pa.types.is_timestamp(t):
        return "Timestamp"
    if pa.types.is_date(t):
        return "Date"
    return "String"


def _pb_cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def _sqlite_check(sql: str, table) -> list[str]:
    """Run the query on SQLite (Pipeline Builder's SQL step engine) over a sample of the input: an error means the
    step would fail there."""
    import sqlite3

    con = sqlite3.connect(":memory:")
    try:
        cols = list(table.schema.names)
        con.execute(f"CREATE TABLE input ({', '.join(E.q(c) for c in cols)})")
        rows = table.slice(0, 1000).to_pylist()
        con.executemany(f"INSERT INTO input VALUES ({', '.join('?' for _ in cols)})", [[_pb_cell(r.get(c)) for c in cols] for r in rows])
        cur = con.execute(sql)
        cur.fetchmany(5)
        return [d[0] for d in cur.description or []]
    finally:
        con.close()


class ToPipelineIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    params: dict[str, Any] = {}


@router.post("/analyses/{item_id}/paths/{path_id}/to-pipeline")
def to_pipeline(item_id: str, path_id: str, req: ToPipelineIn) -> dict:
    """Export to Pipeline Builder (contour_pipeline.py): a new pipeline with one input per dataset the path reads,
    join / union nodes for its join, enrich and set math boards, the boards between them as SQL steps (translated from
    DuckDB to SQLite, Pipeline Builder's SQL engine; SELECT * EXCLUDE / REPLACE, pivot and unpivot rewritten) and an
    output. Refused, with the reason, when the path reads an object type or when a step does not run on SQLite
    (checked on a sample). `notes` says what was taken from the data (a pivot's values)."""
    import contour_pipeline
    import pipeline_datasets

    a = _load(_item(item_id))
    _no_restricted(a, path_id)
    # read into memory: the export takes the datasets' schemas and sample rows from the loaded tables
    comp = _compiler(a, req.params, path_id, scale=False)
    try:
        ex = contour_pipeline.Export(a, comp, path_id, item_id)
        ex.now = now = _now()
        node = ex.build()
    except (E.ContourError, contour_pipeline.ExportError) as e:
        raise HTTPException(400, str(e)) from None
    path = ex.path
    name = (req.name or f"{path.get('name') or 'Contour path'} pipeline").strip()[:200]
    content = {
        "id": f"pl-{uuid.uuid4().hex[:12]}", "name": name, "type": "batch", "createdAt": now, "updatedAt": now, "legend": [],
        "datasets": ex.datasets, "nodes": ex.nodes,
        "outputs": [{"id": f"out-{uuid.uuid4().hex[:8]}", "name": f"{path.get('name') or 'Contour path'}", "node": node}],
    }
    made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=name, content=content))
    # sql: the last SQL step (the only one for a path on one dataset)
    return {"item": made, "sql": ex.queries[-1] if ex.queries else "", "queries": ex.queries, "notes": ex.notes,
            "inputs": len(ex.datasets), "nodes": [{"kind": n["kind"], "name": n["name"]} for n in ex.nodes]}


@router.get("/analyses/{item_id}/parameters/{name}/suggestions")
def suggestions(item_id: str, name: str) -> list[Any]:
    """Suggested values: a list, or up to 1,000 distinct values of a column of a dataset or path result."""
    a = _load(_item(item_id))
    p = next((x for x in a["parameters"] if x["name"] == name), None)
    if not p:
        raise HTTPException(404, "parameter not found")
    if p.get("values"):
        return list(p["values"])[:1000]
    link = p.get("suggest") or {}
    if not link.get("column") or not link.get("source"):
        return []
    comp = _compiler(a, {})
    try:
        rel = comp.source(link["source"])
        t = comp.run(f"SELECT DISTINCT {E.q(link['column'])} AS v FROM {rel} WHERE {E.q(link['column'])} IS NOT NULL ORDER BY 1 LIMIT 1000")
    except E.ContourError as e:
        raise HTTPException(400, str(e)) from None
    return [r["v"] for r in E.rows_of(t)]


@router.get("/sources")
def sources() -> dict:
    """What a path can start from: Parquet datasets in Files and object types (with their properties)."""
    import workshop

    import restricted_views

    src = workshop.sources()
    rvs = [{"id": v["rid"], "name": v["name"]} for v in restricted_views.list_views()]
    return {"datasets": src["datasets"], "object_types": src["object_types"], "restricted_views": rvs}


# ------------------------------------------------------------------ scheduled builds

log = logging.getLogger("contour")
_started = threading.Event()


class ScheduleIn(BaseModel):
    # hours between builds; none: no schedule
    every_hours: Optional[float] = Field(None, gt=0, le=24 * 31)


@router.put("/analyses/{item_id}/paths/{path_id}/schedule")
def set_schedule(item_id: str, path_id: str, req: ScheduleIn) -> dict:
    """Build a saved dataset on a schedule, as the user who sets it (their access is checked at every run)."""
    item = _item(item_id, "editor")
    a = _load(item)
    cur = (a.get("saved") or {}).get(path_id)
    if not cur:
        raise HTTPException(400, "save the path as a dataset first")
    if req.every_hours is None:
        cur.pop("schedule", None)
    else:
        me = (auth.current() or {}).get("id")
        cur["schedule"] = {"every_hours": req.every_hours, "owner": me, "next_at": (datetime.now(timezone.utc) + timedelta(hours=req.every_hours)).isoformat(timespec="seconds")}
    _store(item, a)
    return cur


def run_due(now: Optional[datetime] = None) -> list[dict]:
    """Build every saved dataset whose schedule is due; returns what ran."""
    import db
    import drive

    now = now or datetime.now(timezone.utc)
    ran = []
    if not db.enabled():
        return ran
    for it in db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (CONTOUR_MIME,), limit=5000):
        try:
            a = json.loads(drive.read_bytes(it).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, HTTPException):
            continue
        for pid, cur in (a.get("saved") or {}).items():
            sch = cur.get("schedule") or {}
            if not sch.get("next_at") or datetime.fromisoformat(sch["next_at"]) > now:
                continue
            # the build runs as the user who scheduled it, never as the system (run_as.py)
            import run_as

            try:
                owner_p, unavailable = run_as.owner_principal(sch.get("owner"), "the scheduled build"), None
            except run_as.OwnerUnavailable as e:
                owner_p, unavailable = None, str(e)
            token = auth._principal.set(owner_p)
            entry = {"analysis": it["id"], "path": pid}
            try:
                if unavailable:
                    raise HTTPException(403, f"did not run: {unavailable}")
                item = _item(it["id"], "editor")
                fresh = _load(item)
                saved = _write_dataset(item, fresh, pid, cur["name"], None, cur.get("params") or {})
                saved["schedule"] = {**sch, "next_at": (now + timedelta(hours=sch["every_hours"])).isoformat(timespec="seconds"), "last_run_at": _now()}
                _store(item, fresh)
                entry["status"] = "succeeded"
            except Exception as e:  # noqa: BLE001 — recorded on the saved dataset, retried at the next slot
                msg = str(getattr(e, "detail", e))[:500]
                entry.update(status="failed", error=msg)
                # recorded by the scheduler itself: the owner may no longer be allowed to open the analysis
                auth._principal.set(None)
                try:
                    item = drive._item(it["id"])
                    fresh = _load(item)
                    c2 = fresh["saved"][pid]
                    c2.update(last_status="failed", last_error=msg)
                    c2["schedule"] = {**sch, "next_at": (now + timedelta(hours=sch["every_hours"])).isoformat(timespec="seconds"), "last_run_at": _now()}
                    _store(item, fresh)
                except Exception:  # noqa: BLE001
                    log.exception("contour: could not record a failed build")
            finally:
                auth._principal.reset(token)
            ran.append(entry)
    return ran


def startup() -> None:
    """Check scheduled builds every minute."""
    if _started.is_set():
        return
    _started.set()

    def loop() -> None:
        while True:
            time.sleep(60)
            try:
                run_due()
            except Exception:  # noqa: BLE001
                log.exception("contour: scheduled builds failed")

    threading.Thread(target=loop, name="contour-schedules", daemon=True).start()
