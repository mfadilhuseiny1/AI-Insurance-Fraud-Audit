"""What Node-RED's BluesandAI nodes call (api/nodered-nodes/bluesandai): datasets in the workspace's folder and ingest
streams. Node-RED calls with its workspace's platform token (code_workspace_vscode.start), which acts for the user who
started it and reaches /api/nodered-platform/<workspace>/ only (auth.middleware).

A Node-RED workspace's folder is the folder of its Files item; a Device stream's Node-RED hangs off the pipeline file,
so its datasets go next to the pipeline and are recorded as the pipeline's outputs (lineage, markings).
"""

from __future__ import annotations

import io
import json
import threading
from typing import Any, Optional

import pyarrow.parquet as pq
from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

import auth
import code_workspaces as cw
import db

router = APIRouter(prefix="/api/nodered-platform/{wid}", tags=["code-workspaces"])
# the columns of a dataset out node, as Pipeline Builder's built-in device streams wrote them
COLUMNS = [{"name": "ts", "type": "Timestamp"}, {"name": "topic", "type": "String"}, {"name": "device", "type": "String"},
           {"name": "metric", "type": "String"}, {"name": "value", "type": "Double"}, {"name": "payload", "type": "String"}]
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _workspace(wid: str, need: str = "viewer") -> dict:
    p = auth.current()
    scope = str((p or {}).get("scope") or "")
    if scope.startswith("nodered:") and scope != f"nodered:{wid}":
        raise HTTPException(403, "This token belongs to another Node-RED workspace")
    rec = cw._get(wid, need)
    if rec.get("kind") != "nodered":
        raise HTTPException(400, "This workspace is not a Node-RED workspace")
    return rec


def _folder(rec: dict) -> Optional[str]:
    item = db.drive_get(rec["item_id"])
    return item.get("parent_id") if item else None


def _parquet_files(folder: Optional[str]) -> list[dict]:
    return [i for i in db.drive_list(folder) if i["kind"] == "file" and i["name"].lower().endswith(".parquet")]


def _find(folder: Optional[str], name: str) -> Optional[dict]:
    want = name if name.lower().endswith(".parquet") else f"{name}.parquet"
    for i in _parquet_files(folder):
        if i["name"].lower() == want.lower() or i["id"] == name:
            return i
    return None


class AppendIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    rows: list[dict[str, Any]] = Field(max_length=100_000)


@router.post("/datasets/append")
def append_rows(wid: str, req: AppendIn) -> dict:
    """Append a dataset out node's rows to its dataset in the folder (created on the first write)."""
    import pipeline_datasets as pd

    rec = _workspace(wid, "editor")
    folder = _folder(rec)
    name = req.name.strip().removesuffix(".parquet")
    with _locks_guard:
        lock = _locks.setdefault(wid, threading.Lock())
    with lock:
        known = (rec.get("datasets_written") or {}).get(name)
        existing = pd._live_file(known) if known else None
        if existing is None:
            existing = _find(folder, name)
        out = pd.deploy(pd.DeployRequest(name=name, parent_id=folder, item_id=existing["id"] if existing else None, mode="append",
                                         columns=[pd.Column(**c) for c in COLUMNS], rows=req.rows, pipeline_id=rec.get("pipeline_id"),
                                         output_name=name))
        if known != out["item"]["id"]:
            with cw._lock:
                fresh = cw._read(wid)
                fresh.setdefault("datasets_written", {})[name] = out["item"]["id"]
                cw._write(fresh)
    return {"name": out["item"]["name"], "id": out["item"]["id"], "rows": out["rows"], "written": out.get("written")}


@router.get("/datasets")
def list_datasets(wid: str) -> list[dict]:
    """The datasets in the folder, for the nodes' pickers."""
    rec = _workspace(wid)
    return [{"value": i["name"][: -len(".parquet")], "label": i["name"]} for i in _parquet_files(_folder(rec))]


@router.get("/datasets/read")
def read_dataset(wid: str, name: str, limit: int = 1000) -> dict:
    """A dataset's first rows (a dataset in node)."""
    import drive

    rec = _workspace(wid)
    item = _find(_folder(rec), name)
    if item is None:
        raise HTTPException(404, f'No dataset "{name}" in this folder')
    drive._item(item["id"])  # the user may open it (markings)
    table = pq.read_table(io.BytesIO(drive.read_bytes(item)))
    rows = table.slice(0, max(1, min(limit, 100_000))).to_pylist()
    return {"name": item["name"], "columns": [{"name": f.name, "type": str(f.type)} for f in table.schema], "total": table.num_rows,
            "rows": json.loads(json.dumps(rows, default=str))}


@router.get("/streams")
def list_streams(wid: str) -> list[dict]:
    """The ingest streams the user can see, for the stream out node's picker."""
    import streaming

    _workspace(wid)
    return [{"value": s["id"], "label": s.get("name") or s["id"]} for s in streaming.list_streams()]


@router.post("/streams/{stream_id}/records")
def push_records(wid: str, stream_id: str, records: list[dict] = Body(...)) -> dict:
    """A stream out node's records, appended to the stream's current view."""
    import streaming

    _workspace(wid, "editor")
    streaming._stream(stream_id)  # exists, and the user may see it (markings)
    items = [r["value"] if isinstance(r, dict) and set(r) == {"value"} and isinstance(r["value"], dict) else r for r in records]
    if any(not isinstance(r, dict) for r in items):
        raise HTTPException(400, "Records are JSON objects")
    return {"pushed": len(items), "last_seq": streaming.append(stream_id, items)}
