"""Views: a dataset that holds no data of its own, read as the union of its backing datasets, as
Foundry's Views.

A View is a `.view` file in Files holding its definition:
  backing          datasets (Files Parquet datasets or data sources) with the same column names and
                   types (any order); with schema evolution, missing columns are read as null
  primary_key      optional: one row per key is kept — the one with the highest values of the
                   ordering columns (compared in order); key columns may not be null
  ordering         the columns that resolve duplicate keys (required with a primary key)
  deletion_column  optional Boolean: when the latest row of a key has true, the key is removed
Deduplication runs before deletion and across every backing dataset. The primary key cannot change
once set (create a new View instead).

Views can be read wherever a dataset can (pipeline inputs, exports); they are not build outputs.

Mounted by server.py under /api/views.
"""

from __future__ import annotations

import hashlib
import io
import json
from typing import Any, Optional

import pyarrow as pa
import pyarrow.compute as pc
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import db
import dc_datasets
import drive
import pipeline_datasets

router = APIRouter(prefix="/api/views")
VIEW = "application/vnd.bluesandai.view+json"
EXT = ".view"


class ViewDef(BaseModel):
    backing: list[dict] = Field(min_length=1, max_length=50)
    primary_key: list[str] = []
    ordering: list[str] = []
    deletion_column: Optional[str] = None
    schema_evolution: bool = False


class NewView(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None
    definition: ViewDef


def _clean(d: ViewDef) -> dict:
    refs = []
    for r in d.backing:
        ref = dc_datasets.parse_ref(r)
        if ref["kind"] == "view":
            raise HTTPException(400, "A View is backed by datasets, not by other Views")
        refs.append(ref)
    if d.primary_key and not d.ordering:
        raise HTTPException(400, "A primary key needs the columns that resolve duplicate keys (the latest row wins)")
    if d.deletion_column and not d.primary_key:
        raise HTTPException(400, "A deletion column needs a primary key")
    return {"backing": refs, "primary_key": d.primary_key, "ordering": d.ordering, "deletion_column": d.deletion_column or None, "schema_evolution": d.schema_evolution}


def _view_item(item_id: str, need: str = "viewer") -> dict:
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or not item["name"].lower().endswith(EXT):
        raise HTTPException(404, "View not found")
    # a View is a Files item: its markings and its Project's roles (Editor to change it)
    auth.check_item(item, need)
    return item


def definition(item_id: str) -> dict:
    return json.loads(drive.read_bytes(_view_item(item_id)))


def _backing_checks(d: dict) -> list:
    """What reading a View definition reads, as build_calls checks: each backing dataset (a Files dataset or a data
    source)."""
    return [("read", "datasource", r["id"], None) if r.get("kind") == "source" else ("read", "item", r.get("item_id"), None)
            for r in d.get("backing") or []]


def _as_build(request: Optional[Request], item: Optional[dict], d: Optional[dict] = None) -> None:
    """The build runner reading a View for a build (X-Bsai-Build): the View and every backing dataset it reads, as
    the build's identity."""
    import build_calls

    if build_calls.build_of(request) is None:
        return
    if d is None and item is not None:
        d = json.loads(drive.read_bytes(item))
    build_calls.enforce(request, *([("read", "item", item["id"], None)] if item else []), *_backing_checks(d or {}))


def resolve(d: dict) -> tuple[pa.Table, str]:
    """(rows, view id) of a View definition."""
    tables, ids = [], []
    for ref in d["backing"]:
        t, vid, name = dc_datasets.read(ref)
        tables.append((name, t))
        ids.append(vid)
    first_name, first = tables[0]
    if d.get("schema_evolution"):
        fields: dict[str, pa.Field] = {}
        for _, t in tables:
            for f in t.schema:
                if f.name in fields and fields[f.name].type != f.type:
                    raise HTTPException(409, f'View:MismatchedColumnType: "{f.name}" has different types in the backing datasets')
                fields.setdefault(f.name, f)
        schema = pa.schema(list(fields.values()))
        parts = []
        for _, t in tables:
            cols = [t.column(f.name) if f.name in t.column_names else pa.nulls(t.num_rows, f.type) for f in schema]
            parts.append(pa.Table.from_arrays(cols, schema=schema))
    else:
        want = {f.name: f.type for f in first.schema}
        for name, t in tables[1:]:
            got = {f.name: f.type for f in t.schema}
            if got != want:
                missing = sorted(set(want) ^ set(got))
                detail = f"columns differ: {', '.join(missing)}" if missing else "column types differ"
                raise HTTPException(409, f"View:MismatchedNumberOfColumns — {name} does not match {first_name} ({detail}). Turn on schema evolution to read missing columns as null.")
        parts = [t.select(list(want)) for _, t in tables]
    table = pa.concat_tables(parts)
    pk, ordering, deletion = d.get("primary_key") or [], d.get("ordering") or [], d.get("deletion_column")
    if pk:
        for c in [*pk, *ordering, *([deletion] if deletion else [])]:
            if c not in table.column_names:
                raise HTTPException(409, f'The View column "{c}" is not in the backing datasets')
        for c in pk:
            if table.column(c).null_count:
                raise HTTPException(409, f'The primary key column "{c}" has nulls')
        # sort by key, then ordering descending: the first row of each key is the latest
        idx = pa.array(range(table.num_rows), type=pa.int64())
        work = table.append_column("__row", idx)
        sorted_t = work.sort_by([*[(c, "ascending") for c in pk], *[(c, "descending") for c in ordering], ("__row", "descending")])
        keys = [sorted_t.column(c).to_pylist() for c in pk]
        keep, prev = [], None
        for i, k in enumerate(zip(*keys)):
            if k != prev:
                keep.append(i)
                prev = k
        latest = sorted_t.take(pa.array(keep, type=pa.int64()))
        if deletion:
            if not pa.types.is_boolean(latest.schema.field(deletion).type):
                raise HTTPException(409, f'The deletion column "{deletion}" must be Boolean')
            latest = latest.filter(pc.invert(pc.fill_null(latest.column(deletion), False)))
        # back in the original row order
        latest = latest.sort_by([("__row", "ascending")])
        table = latest.drop(["__row"])
    view_id = "view:" + hashlib.sha1("|".join(ids).encode()).hexdigest()[:16]
    return table, view_id


def read_view(item_id: str) -> tuple[pa.Table, str]:
    return resolve(definition(item_id))


def _public(item: dict) -> dict:
    d = json.loads(drive.read_bytes(item))
    return {
        "item": drive._with_path(drive._item(item["id"])),
        "definition": {**d, "backing": [{**r, **dc_datasets.describe(r)} for r in d["backing"]]},
    }


@router.get("")
def list_views() -> list[dict]:
    """Every View in Files (not in the trash), newest first."""
    drive._require_db()
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND lower(d.name) LIKE %s", (f"%{EXT}",), limit=1000)
    return [drive._with_path(i) for i in auth.visible(items)]


@router.post("")
def create_view(req: NewView) -> dict:
    drive._require_db()
    d = _clean(req.definition)
    resolve(d)  # the backing datasets must read as one table
    name = req.name.strip()
    if not name.lower().endswith(EXT):
        name += EXT
    item = drive.save_bytes(req.parent_id, name, json.dumps(d, indent=1).encode(), VIEW)
    return _public(db.drive_get(item["id"]))


@router.get("/{item_id}")
def get_view(item_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    drive._require_db()
    item = _view_item(item_id)
    _as_build(request, item)
    return _public(item)


@router.put("/{item_id}")
def update_view(item_id: str, req: ViewDef) -> dict:
    drive._require_db()
    item = _view_item(item_id, "editor")
    old = json.loads(drive.read_bytes(item))
    d = _clean(req)
    if old.get("primary_key") and d["primary_key"] != old["primary_key"]:
        raise HTTPException(409, "The primary key of a View cannot change once set — create a new View")
    resolve(d)
    pipeline_datasets._replace_content(item, json.dumps(d, indent=1).encode(), VIEW)
    return _public(db.drive_get(item_id))


@router.get("/{item_id}/table")
def view_table(item_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    """The View's rows as pipeline columns and rows (a pipeline input)."""
    drive._require_db()
    item = _view_item(item_id)
    _as_build(request, item)
    table, _ = read_view(item_id)
    return pipeline_datasets.table_payload(table, item["name"])


@router.post("/preview")
def preview(req: ViewDef, limit: int = 100, request: Request = None) -> dict:  # type: ignore[assignment]
    """The first rows a definition would read (before saving)."""
    drive._require_db()
    d = _clean(req)
    _as_build(request, None, d)
    table, _ = resolve(d)
    payload = pipeline_datasets.table_payload(table.slice(0, max(1, min(limit, 1000))), "preview")
    return {**payload, "total_rows": table.num_rows}
