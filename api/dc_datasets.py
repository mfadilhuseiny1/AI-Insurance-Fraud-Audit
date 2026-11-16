"""Datasets as Data Connection reads them: a reference to a dataset, its current view and rows.

A reference is one of
  {"kind": "file",   "item_id": ...}   a Parquet dataset in Files (uploaded, or written by a pipeline)
  {"kind": "source", "id": ...}        a data source's dataset (the files of its view)
  {"kind": "view",   "item_id": ...}   a View (views.py): the union of its backing datasets

`view_id` identifies the current dataset view: it changes when a SNAPSHOT transaction starts a new
view, and stays the same while APPEND transactions add rows to it. Exports use it to tell new rows
(appended to the view they last exported) from a replaced view.
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import HTTPException

import db
import drive
import pipeline_datasets

# write modes that start a new view (pipeline_datasets.SNAPSHOT_MODES, plus deploys from before them)
_SNAPSHOT_MODES = {"snapshot", "snapshotReplace", "snapshotReplaceRemove", "snapshotNewRows"}


def _file(item_id: str) -> dict:
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or item["kind"] != "file":
        raise HTTPException(404, "The dataset was deleted or moved to the trash")
    if not item["name"].lower().endswith(".parquet"):
        raise HTTPException(400, f'"{item["name"]}" is not a Parquet dataset')
    return item


def _ts(v: Any) -> float:
    if isinstance(v, datetime):
        return v.timestamp()
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def file_view_id(item: dict) -> str:
    """The view of a Files dataset: the newest SNAPSHOT a pipeline deploy committed, or (for files
    replaced outside pipelines) the file's last change."""
    recs = pipeline_datasets.deploys().get(item["id"], [])  # newest first
    updated = _ts(item.get("updated_at"))
    if recs and updated <= _ts(recs[0]["at"]) + 5:
        for r in recs:
            if r.get("transaction") == "SNAPSHOT" or (r.get("transaction") is None and r.get("mode", "snapshot") in _SNAPSHOT_MODES):
                return f"deploy:{r['at']}"
        return f"deploy:{recs[-1]['at']}"
    return f"file:{item.get('updated_at')}:{item.get('size_bytes') or item.get('size')}"


def describe(ref: dict) -> dict:
    """Name and location of a dataset reference (for lists)."""
    try:
        if ref.get("kind") == "source":
            import datasources

            row = datasources._source_row(ref["id"])
            return {"name": row["name"], "kind": "source", "path": f"Data source · {row['schema_name']}.{row['table_name']}"}
        item = db.drive_get(ref.get("item_id") or "")
        if not item:
            return {"name": "(deleted)", "kind": ref.get("kind"), "path": ""}
        return {"name": item["name"], "kind": ref.get("kind"), "path": " / ".join(["Files & Projects", *[p["name"] for p in db.drive_path(item["id"])]])}
    except HTTPException:
        return {"name": "(deleted)", "kind": ref.get("kind"), "path": ""}


def read(ref: dict) -> tuple[pa.Table, str, str]:
    """(rows of the current view, view id, name) of a dataset reference."""
    kind = ref.get("kind")
    if kind == "file":
        item = _file(ref["item_id"])
        return pq.read_table(io.BytesIO(drive.read_bytes(item))), file_view_id(item), item["name"]
    if kind == "source":
        import datasources

        row = datasources._source_row(ref["id"])
        ids = datasources._view(row)
        files = [f for f in (db.drive_get(i) for i in ids) if f and not f.get("trashed_at")]
        if not files:
            raise HTTPException(409, f'"{row["name"]}" has no data yet — run the data source first')
        table = pa.concat_tables([pq.read_table(io.BytesIO(drive.read_bytes(f))) for f in files])
        return table, f"source:{files[0]['id']}", row["name"]
    if kind == "view":
        import views

        table, view_id = views.read_view(ref["item_id"])
        item = db.drive_get(ref["item_id"]) or {"name": "View"}
        return table, view_id, item["name"]
    raise HTTPException(400, f"unknown dataset kind {kind!r}")


def parse_ref(ref: Optional[dict]) -> dict:
    if not isinstance(ref, dict) or ref.get("kind") not in ("file", "source", "view"):
        raise HTTPException(400, "choose a dataset (a Parquet file, a data source or a View)")
    key = "id" if ref["kind"] == "source" else "item_id"
    if not ref.get(key):
        raise HTTPException(400, "choose a dataset")
    return {"kind": ref["kind"], key: str(ref[key])}
