"""Project references (palantir.com/docs/foundry/compass/use-project-details-panel): a resource from another Project,
explicitly imported into a Project so it can be used there as an input (Preparation's Project scoping).

Adding a reference needs the Viewer role on the resource ("import from") and the Editor role on the Project
("import to"). Stored in data/project-references.json: {project_id: [{item_id, by, at}]}.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth
import db
import drive

router = APIRouter(prefix="/api/project-references")
PATH = Path("data/project-references.json")
_lock = threading.Lock()


def configure(data_dir: Path) -> None:
    global PATH
    PATH = data_dir / "project-references.json"


def _read() -> dict:
    try:
        return json.loads(PATH.read_text("utf-8")) if PATH.exists() else {}
    except ValueError:
        return {}


def is_referenced(project_id: str, item_id: str) -> bool:
    return any(r["item_id"] == item_id for r in _read().get(project_id) or [])


class RefIn(BaseModel):
    project_id: str
    item_id: str


@router.get("/{project_id}")
def list_refs(project_id: str) -> list[dict]:
    drive._item(project_id)
    out = []
    for r in _read().get(project_id) or []:
        it = db.drive_get(r["item_id"])
        if it and not it.get("trashed_at") and auth.can_access(it["id"]):
            out.append({**r, "name": it["name"], "path": [p["name"] for p in db.drive_path(it["id"])[:-1]]})
    return out


@router.post("")
def add_ref(req: RefIn) -> list[dict]:
    project = drive._item(req.project_id, need="editor")
    if project["kind"] != "project":
        raise HTTPException(400, "references are added to a Project")
    drive._item(req.item_id, need="viewer")
    with _lock:
        data = _read()
        refs = data.setdefault(req.project_id, [])
        if not any(r["item_id"] == req.item_id for r in refs):
            refs.append({"item_id": req.item_id, "by": (auth.current() or {}).get("id") or "system", "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        PATH.write_text(json.dumps(data, indent=1), "utf-8")
    return list_refs(req.project_id)


@router.delete("/{project_id}/{item_id}")
def remove_ref(project_id: str, item_id: str) -> list[dict]:
    drive._item(project_id, need="editor")
    with _lock:
        data = _read()
        data[project_id] = [r for r in data.get(project_id) or [] if r["item_id"] != item_id]
        PATH.write_text(json.dumps(data, indent=1), "utf-8")
    return list_refs(project_id)
