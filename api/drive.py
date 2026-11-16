"""Files & Projects tab: a drive of projects, folders and files, like a Google Drive or a Palantir
project.

The tree (names, parents, sizes, dates) is in PostgreSQL (`drive_items`), so renaming or moving a
folder never touches stored objects. File contents go to S3 under `drive/<item_id>`; if S3 is not
configured they are kept on disk in data/drive/<item_id> instead.

Projects are top-level containers; inside them, folders and files work as anywhere else. The
default project "My Project" and its folders Document, Parsed Document, Extracted Document and
Datapipeline (the `system` column) always exist: uploads for parsing, parse results, extractions and
pipelines are saved there automatically, so they cannot be renamed, moved or deleted. Parsed Document / Buffer holds
the pieces of parse jobs still in progress (or failed), so a retry resumes instead of starting over.

Drive features: checkbox selection in the UI works through the per-item routes below, plus
stars, a trash (items stay restorable for TRASH_DAYS, then are deleted for good), copies, zip
downloads of folders and selections, search, and share links (a token that lets anyone with the
link view and download an item, or everything in a folder, until it expires or is revoked).

Mounted by server.py under /api/drive.
"""

from __future__ import annotations

import io
import logging
import mimetypes
import os
import re
import secrets
import shutil
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import BinaryIO, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from starlette.background import BackgroundTask
from pydantic import BaseModel

import auth
import db
import storage

log = logging.getLogger("bluesandai.drive")

MAX_UPLOAD_MB = 1024
# names may not contain path separators or control characters
BAD_NAME = re.compile(r"[\\/\x00-\x1f]")

# the default project, and its folders by `system` key
DEFAULT_PROJECT = "My Project"
DEFAULT_FOLDERS = {
    "documents": "Document",
    "parsed": "Parsed Document",
    "extracted": "Extracted Document",
    # Pipeline Builder: one folder per pipeline, holding its .pipeline file and deployed datasets
    "pipelines": "Datapipeline",
    # data sources (datasources.py): one folder per source with its ingested Parquet
    "sources": "Data Source",
    # Ontology Manager: files uploaded for media properties (ontology.py)
    "ontology": "Ontology",
    # Code Repositories: one folder per repository with the datasets its builds write (code_repos.py)
    "code": "Code Repositories",
}
# Parsed Document / Buffer: one folder per parse run, holding each finished chunk (see server.py)
BUFFER_FOLDER = "Buffer"
# items that hold others
CONTAINERS = ("project", "folder")
# days an item stays in the trash before it is deleted for good
TRASH_DAYS = 30
# largest zip download (sum of file sizes)
MAX_ZIP_MB = 4096
SHARE_EXPIRY_DAYS = (1, 7, 30)

router = APIRouter(prefix="/api/drive")
LOCAL_DIR: Path  # set by configure()
_defaults_lock = threading.Lock()


def configure(data_dir: Path) -> None:
    global LOCAL_DIR
    LOCAL_DIR = data_dir / "drive"
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    # new items record who created them
    db.creator = lambda: (auth.current() or {}).get("username")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _require_db() -> None:
    if not db.enabled():
        raise HTTPException(503, "Files need the database (BLUESANDAI_DATABASE_URL), which is not available")


def _item(item_id: str, trashed_ok: bool = False, need: str = "viewer") -> dict:
    _require_db()
    item = db.drive_get(item_id)
    if not item or (item.get("trashed_at") and not trashed_ok):
        raise HTTPException(404, "item not found")
    # markings: the caller must hold every marking on the item and its folders; and the Project role `need`
    # (viewer reads, editor changes, owner deletes a Project)
    auth.check_item(item, need)
    return item


def _folder_id(folder_id: Optional[str]) -> Optional[str]:
    """Validate a destination folder or project; None or "" is the root."""
    if not folder_id:
        return None
    # a destination: writing into it needs the Editor role on its Project
    if _item(folder_id, need="editor")["kind"] not in CONTAINERS:
        raise HTTPException(400, "destination is not a folder")
    return folder_id


def _build_reads(request: Optional[Request], item_ids: list[Optional[str]], folder: bool = False) -> None:
    """A call the build runner makes for a build (service token + X-Bsai-Build, see pipeline_runtime): it reads these
    items as the build's identity — its markings and Project roles as they are now (403 with the reason). `folder`:
    a listing of the top level of Files (item_ids empty). Users' own calls are checked as themselves already."""
    if request is None or not request.headers.get("x-bsai-build"):
        return
    import build_calls

    checks = [("read", "item", i, None) for i in dict.fromkeys(item_ids) if i]
    if folder and not checks:
        checks = [("read", "folder", None, None)]
    if checks:
        build_calls.enforce(request, *checks)


def _build_readable(request: Optional[Request], items: list[dict]) -> list[dict]:
    """Of items listed for a build's call, those its identity may read now (the others are left out)."""
    if request is None or not request.headers.get("x-bsai-build"):
        return items
    import build_calls

    rec = build_calls.build_of(request)
    if rec is None:
        return items
    return [i for i in items if build_calls.denies(rec, [("read", "item", i.get("id"), None)]) is None]


def _not_default(item: dict, action: str) -> None:
    if item.get("system"):
        what = "project" if item["kind"] == "project" else "folder"
        raise HTTPException(400, f'"{item["name"]}" is a default {what} and cannot be {action}')


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", ".."):
        raise HTTPException(400, "name is empty")
    if len(name) > 255:
        raise HTTPException(400, "name is longer than 255 characters")
    if BAD_NAME.search(name):
        raise HTTPException(400, "name cannot contain / or \\")
    return name


def _free_name(parent_id: Optional[str], name: str) -> str:
    """name, or "name (2).ext", "name (3).ext"... if the folder already has it."""
    stem, ext = (name.rsplit(".", 1)[0], "." + name.rsplit(".", 1)[1]) if "." in name.strip(".") else (name, "")
    candidate, n = name, 1
    while db.drive_name_taken(parent_id, candidate):
        n += 1
        candidate = f"{stem} ({n}){ext}"
    return candidate


def _public(item: dict) -> dict:
    return {
        "id": item["id"],
        "parent_id": item["parent_id"],
        "kind": item["kind"],
        "name": item["name"],
        "size": item["size_bytes"],
        "content_type": item["content_type"],
        "items": item.get("items"),
        # set on the default project and folders
        "default": bool(item.get("system")),
        "starred": bool(item.get("starred")),
        "trashed_at": item["trashed_at"].isoformat() if item.get("trashed_at") else None,
        "created_at": item["created_at"].isoformat(),
        "updated_at": item["updated_at"].isoformat(),
        # a folder that is a media set (media_sets.py): its schema
        "media_set": _media_set_schema(item),
    }


def _media_set_schema(item: dict) -> Optional[str]:
    if item["kind"] != "folder":
        return None
    try:
        import media_sets

        s = media_sets.get(item["id"])
        return s["schema"] if s else None
    except Exception:  # noqa: BLE001 - before media sets are configured
        return None


def _with_path(item: dict) -> dict:
    """An item plus its location: the folders above it, root-most first."""
    return {**_public(item), "path": db.drive_path(item["id"])[:-1]}


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


@router.get("/folders/{folder_id}")
def list_folder(folder_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    """A folder or project and its contents; folder_id "root" is the top level. For a build (the runner's media
    inputs, branch datasets): the folder and the items its identity may read."""
    _require_db()
    ensure_defaults()
    if folder_id == "root":
        _build_reads(request, [], folder=True)
        return {"folder": None, "items": [_public(i) for i in _build_readable(request, auth.visible(db.drive_list(None)))]}
    # Discoverers browse folders (names and metadata); reading files needs Viewer
    folder = _item(folder_id, need="discoverer")
    _build_reads(request, [folder_id])
    if folder["kind"] not in CONTAINERS:
        raise HTTPException(400, "not a folder")
    return {"folder": _with_path(folder), "items": [_public(i) for i in _build_readable(request, auth.visible(db.drive_list(folder_id)))]}


class NewFolder(BaseModel):
    name: str
    parent_id: Optional[str] = None
    # a project lives at the top level
    kind: Literal["folder", "project"] = "folder"


@router.post("/folders")
def create_folder(req: NewFolder) -> dict:
    _require_db()
    parent_id = _folder_id(req.parent_id)
    if req.kind == "project" and parent_id:
        raise HTTPException(400, "projects can only be created at the top level")
    if req.kind == "project" and auth.settings().get("require_project_classification"):
        raise HTTPException(400, "Projects need a classification: create them with New Project (a space, a template and a classification)")
    name = _clean_name(req.name)
    if db.drive_name_taken(parent_id, name):
        raise HTTPException(409, f'"{name}" already exists in this folder')
    item_id = _insert_container(parent_id, req.kind, name)
    if req.kind == "project":
        auth.project_created(item_id)
    return _public({**_item(item_id), "items": 0})


def _insert_container(parent_id: Optional[str], kind: str, name: str, system: Optional[str] = None) -> str:
    now = _now()
    item = {
        "id": uuid.uuid4().hex[:16],
        "parent_id": parent_id,
        "kind": kind,
        "name": name,
        "size_bytes": 0,
        "content_type": None,
        "stored_in": None,
        "created_at": now,
        "updated_at": now,
        "system": system,
    }
    db.drive_insert(item)
    return item["id"]


@router.post("/files")
def upload(
    file: UploadFile = File(...), parent_id: Optional[str] = Form(None), relative_path: Optional[str] = Form(None)
) -> dict:
    """Upload one file into a folder. A name already in the folder gets a " (2)" suffix.
    relative_path ("Photos/2024/a.jpg", from a folder upload) puts it in those subfolders,
    creating them as needed."""
    _require_db()
    parent_id = _folder_id(parent_id)
    if relative_path:
        parent_id = _ensure_folders(parent_id, relative_path.replace("\\", "/").split("/")[:-1])
    # classification-based access controls: raw data (an upload) needs a file classification — from the Project or a
    # folder above it (the Project's classification), since an upload has no inputs to inherit one from
    if auth.settings().get("require_project_classification"):
        _, hier = auth._category_index()
        classified = bool(parent_id) and bool(auth.file_markings(parent_id) & set(hier))
        if not classified:
            raise HTTPException(400, "Uploads need a classification: upload into a classified Project, or classify the folder first")
    name = _clean_name(Path(file.filename or "upload").name)
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file is larger than {MAX_UPLOAD_MB} MB")
    content_type = file.content_type
    if not content_type or content_type == "application/octet-stream":
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return _public(_store(parent_id, name, file.file, size, content_type))


_folders_lock = threading.Lock()


def _ensure_folders(parent_id: Optional[str], names: list[str]) -> Optional[str]:
    """The folder at parent_id/names[0]/names[1]/..., creating missing ones (parallel uploads of
    one folder share them)."""
    with _folders_lock:
        for name in (n for n in names if n.strip()):
            name = _clean_name(name)
            existing = next(
                (i for i in db.drive_list(parent_id) if i["kind"] in CONTAINERS and i["name"].lower() == name.lower()),
                None,
            )
            parent_id = existing["id"] if existing else _insert_container(parent_id, "folder", _free_name(parent_id, name))
    return parent_id


def _store(parent_id: Optional[str], name: str, fileobj: BinaryIO, size: int, content_type: str, item_id: Optional[str] = None) -> dict:
    """Store a file's contents and add it to a (validated) folder under a free name. `item_id` (16 hex
    characters, unused) lets a caller hand out the id before the file exists (code transforms' media items)."""
    if item_id and (not re.fullmatch(r"[0-9a-f]{16}", item_id) or db.drive_get(item_id)):
        item_id = None
    item_id = item_id or uuid.uuid4().hex[:16]
    # the space of the Project it goes into may say where its files are stored (governance_model.py)
    where = None
    if parent_id:
        try:
            import governance_model

            where = governance_model.setting_for(auth.project_of(parent_id), "storage")
        except Exception:  # noqa: BLE001
            where = None
    if storage.enabled() and where != "local":
        storage.put_fileobj(f"drive/{item_id}", fileobj, content_type)
        stored_in = "s3"
    else:
        with open(LOCAL_DIR / item_id, "wb") as f:
            while block := fileobj.read(1024 * 1024):
                f.write(block)
        stored_in = "local"
    now = _now()
    item = {
        "id": item_id,
        "parent_id": parent_id,
        "kind": "file",
        "name": _free_name(parent_id, name),
        "size_bytes": size,
        "content_type": content_type,
        "stored_in": stored_in,
        "created_at": now,
        "updated_at": now,
    }
    try:
        db.drive_insert(item)
    except Exception:
        _delete_contents([item])
        raise
    return _item(item_id)


@router.get("/items/{item_id}")
def get_item(item_id: str, request: Request = None) -> dict:  # type: ignore[assignment]
    item = _item(item_id, need="discoverer")
    _build_reads(request, [item_id])  # the runner reading an input's item, as the build's identity
    return _with_path(item)


class ItemChange(BaseModel):
    name: Optional[str] = None
    # move: a folder id, or "root" for the top level
    move_to: Optional[str] = None


@router.patch("/items/{item_id}")
def update_item(item_id: str, req: ItemChange) -> dict:
    item = _item(item_id, need="editor")
    changes: dict = {}
    parent_id = item["parent_id"]
    if req.move_to is not None:
        parent_id = None if req.move_to == "root" else _folder_id(req.move_to)
        if parent_id != item["parent_id"]:
            _not_default(item, "moved")
        if parent_id and item["kind"] == "project":
            raise HTTPException(400, "a project stays at the top level")
        if parent_id and item["kind"] == "folder" and db.drive_is_inside(item_id, parent_id):
            raise HTTPException(400, "a folder cannot be moved into itself")
        if parent_id != item["parent_id"]:
            changes["parent_id"] = parent_id
    name = _clean_name(req.name) if req.name is not None else item["name"]
    if name != item["name"]:
        _not_default(item, "renamed")
        changes["name"] = name
    if not changes:
        return _with_path(item)
    if db.drive_name_taken(parent_id, name, except_id=item_id):
        raise HTTPException(409, f'"{name}" already exists in the destination folder')
    db.drive_update(item_id, _now(), **changes)
    return _with_path(_item(item_id))


@router.delete("/items/{item_id}")
def delete_item(item_id: str) -> dict:
    """Delete a file, or a folder or project with everything in it, for good (also from the trash)."""
    item = _item(item_id, trashed_ok=True, need="editor")
    _not_default(item, "deleted")
    if item["kind"] == "project":
        auth.check_project(item_id, "owner")
    files = db.drive_delete(item_id, _now())
    _delete_contents(files)
    return {"deleted": item_id, "files": len(files)}


@router.get("/items/{item_id}/content", response_model=None)
def content(item_id: str, disposition: Literal["attachment", "inline"] = "attachment", request: Request = None) -> Response:  # type: ignore[assignment]
    """Download a file (or, with disposition=inline, open it in the browser)."""
    item = _item(item_id)
    _build_reads(request, [item_id])
    if item["kind"] != "file":
        raise HTTPException(400, "folders cannot be downloaded")
    inline = disposition == "inline"
    if not inline:
        auth.check_download(item_id)
    if item["stored_in"] == "s3":
        url = storage.presigned_url(f"drive/{item_id}", item["name"], inline=inline, content_type=item["content_type"])
        return RedirectResponse(url, status_code=307)
    return FileResponse(
        LOCAL_DIR / item_id, media_type=item["content_type"], filename=item["name"], content_disposition_type=disposition
    )


# ------------------------------------------------------------------------------------------------
# Drive features: views, stars, trash, copies, zip downloads, share links
# ------------------------------------------------------------------------------------------------


def _located(items: list[dict]) -> list[dict]:
    """Items for a cross-folder view (starred, recent, search, trash), each with its location (only those the
    caller's markings allow)."""
    return [_with_path(i) for i in auth.visible(items)]


@router.get("/usage")
def usage() -> dict:
    _require_db()
    return db.drive_usage()


@router.get("/starred")
def starred() -> list[dict]:
    _require_db()
    return _located(db.drive_query("starred AND trashed_at IS NULL", order="lower(name)"))


@router.get("/recent")
def recent(limit: int = 50) -> list[dict]:
    """Files changed most recently, anywhere."""
    _require_db()
    return _located(db.drive_query("kind = 'file' AND trashed_at IS NULL", limit=max(1, min(limit, 200))))


@router.get("/search")
def search(q: str) -> list[dict]:
    """Items anywhere whose name contains q (case-insensitive)."""
    _require_db()
    q = q.strip()
    if not q:
        return []
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return _located(
        db.drive_query("name ILIKE %s AND trashed_at IS NULL", (like,), order="kind = 'file', lower(name)", limit=100)
    )


class StarRequest(BaseModel):
    starred: bool


@router.post("/items/{item_id}/star")
def star(item_id: str, req: StarRequest) -> dict:
    _item(item_id)
    db.drive_set(item_id, starred=req.starred)
    return _public(_item(item_id))


@router.post("/items/{item_id}/trash")
def trash(item_id: str) -> dict:
    """Move to the trash (with everything inside); restorable for TRASH_DAYS."""
    item = _item(item_id, need="editor")
    _not_default(item, "deleted")
    if item["kind"] == "project":
        auth.check_project(item_id, "owner")
    db.drive_trash(item_id, _now())
    return {"trashed": item_id}


@router.get("/trash")
def list_trash() -> list[dict]:
    """What was put in the trash (not the items inside trashed folders), newest first."""
    _require_db()
    _purge_trash()
    return _located(auth.visible(db.drive_query("trashed_root = id", order="trashed_at DESC", limit=500)))


@router.post("/items/{item_id}/restore")
def restore(item_id: str) -> dict:
    """Restore to the original folder, or to the top level if that folder is gone or in the trash.
    A name taken there in the meantime gets a " (2)" suffix."""
    item = _item(item_id, trashed_ok=True, need="editor")
    if item.get("trashed_root") != item_id:
        raise HTTPException(400, "this item is not in the trash (or was trashed with its folder)")
    parent_id = item["parent_id"]
    parent = db.drive_get(parent_id) if parent_id else None
    if parent_id and (not parent or parent.get("trashed_at")):
        parent_id = None
    if item["kind"] == "project":
        parent_id = None
    db.drive_restore(item_id, _now(), parent_id, _free_name(parent_id, item["name"]))
    return _with_path(_item(item_id))


@router.delete("/trash")
def empty_trash() -> dict:
    _require_db()
    roots = db.drive_query("trashed_root = id", limit=100000)
    files: list[dict] = []
    for r in roots:
        files += db.drive_delete(r["id"], _now())
    _delete_contents(files)
    return {"deleted": len(roots), "files": len(files)}


def _purge_trash() -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=TRASH_DAYS)).isoformat(timespec="seconds")
    files: list[dict] = []
    for r in db.drive_query("trashed_root = id AND trashed_at < %s", (cutoff,), limit=1000):
        files += db.drive_delete(r["id"], _now())
    if files:
        _delete_contents(files)


class CopyRequest(BaseModel):
    # destination folder; default: the same folder as the original
    parent_id: Optional[str] = None


@router.post("/items/{item_id}/copy")
def copy_item(item_id: str, req: CopyRequest) -> dict:
    """Copy a file, or a folder with everything in it. In the same folder the copy is named
    "Copy of <name>"; elsewhere it keeps its name (with " (2)" if taken)."""
    item = _item(item_id)
    if item["kind"] == "project":
        raise HTTPException(400, "projects cannot be copied; copy the folders inside instead")
    parent_id = _folder_id(req.parent_id) if req.parent_id else item["parent_id"]
    if not req.parent_id and parent_id:
        auth.check_item_id(parent_id, "editor")
    if parent_id and item["kind"] == "folder" and db.drive_is_inside(item_id, parent_id):
        raise HTTPException(400, "a folder cannot be copied into itself")
    tree = db.drive_subtree(item_id)
    if sum(t["size_bytes"] for t in tree if t["kind"] == "file") > MAX_ZIP_MB * 1024 * 1024:
        raise HTTPException(413, f"more than {MAX_ZIP_MB} MB to copy")
    name = f"Copy of {item['name']}" if parent_id == item["parent_id"] else item["name"]
    new_ids = {item["parent_id"]: parent_id}
    first = None
    for t in tree:
        target = new_ids[t["parent_id"]]
        if t["kind"] == "file":
            new = _copy_file(t, target, name if t["id"] == item_id else t["name"])
        else:
            nm = _free_name(target, name) if t["id"] == item_id else t["name"]
            new = _item(_insert_container(target, "folder", nm))
        new_ids[t["id"]] = new["id"]
        first = first or new
    return _with_path(first)


def _copy_file(item: dict, parent_id: Optional[str], name: str) -> dict:
    new_id = uuid.uuid4().hex[:16]
    if item["stored_in"] == "s3":
        storage.copy(f"drive/{item['id']}", f"drive/{new_id}")
        stored_in = "s3"
    else:
        shutil.copyfile(LOCAL_DIR / item["id"], LOCAL_DIR / new_id)
        stored_in = "local"
    now = _now()
    db.drive_insert(
        {
            "id": new_id,
            "parent_id": parent_id,
            "kind": "file",
            "name": _free_name(parent_id, name),
            "size_bytes": item["size_bytes"],
            "content_type": item["content_type"],
            "stored_in": stored_in,
            "created_at": now,
            "updated_at": now,
        }
    )
    return _item(new_id)


def _open(item: dict) -> BinaryIO:
    """A readable stream of a file's contents."""
    if item["stored_in"] == "s3":
        return storage.open_stream(f"drive/{item['id']}")
    return open(LOCAL_DIR / item["id"], "rb")


def _zip_response(roots: list[dict], filename: str, public: bool = False, request: Optional[Request] = None) -> Response:
    """A zip of items (files, and folders with everything in them), keeping the folder structure. `public`: a shared
    link's zip (no one signed in): marked items are left out. `request`: a build's call leaves out what its identity
    may not read."""
    entries: list[dict] = []
    for root in roots:
        # a marked item inside a folder is left out of the folder's zip
        if public:
            entries += [e for e in db.drive_subtree(root["id"]) if not _marked_for_link(e["id"])]
        else:
            entries += _build_readable(request, [e for e in db.drive_subtree(root["id"]) if auth.has_operation(e.get("id"), "download")] if auth.current() else db.drive_subtree(root["id"]))
    if sum(e["size_bytes"] for e in entries if e["kind"] == "file") > MAX_ZIP_MB * 1024 * 1024:
        raise HTTPException(413, f"more than {MAX_ZIP_MB} MB to download; download fewer items")
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            used: set[str] = set()
            for e in entries:
                arc = e["rel"]
                if e["kind"] != "file":
                    zf.writestr(arc + "/", b"")
                    continue
                stem, dot, ext = arc.rpartition(".")
                n = 1
                while arc.lower() in used:  # two roots with the same name
                    n += 1
                    arc = f"{stem} ({n}).{ext}" if dot else f"{e['rel']} ({n})"
                used.add(arc.lower())
                with _open(e) as src, zf.open(arc, "w", force_zip64=True) as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        tmp.close()
    except Exception:
        tmp.close()
        os.unlink(tmp.name)
        raise
    return FileResponse(
        tmp.name, media_type="application/zip", filename=filename, background=BackgroundTask(os.unlink, tmp.name)
    )


def _zip_name(roots: list[dict]) -> str:
    if len(roots) == 1:
        return roots[0]["name"] + ".zip"
    return f"download-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"


@router.get("/zip", response_model=None)
def download_zip(ids: str = Query(..., description="comma-separated item ids"), request: Request = None) -> Response:  # type: ignore[assignment]
    """Download several items, or a folder, as one zip."""
    roots = [_item(i) for i in dict.fromkeys(x for x in ids.split(",") if x)]
    if not roots:
        raise HTTPException(400, "nothing to download")
    for r in roots:
        auth.check_download(r["id"])
    _build_reads(request, [r["id"] for r in roots])
    return _zip_response(roots, _zip_name(roots), request=request)


# -- share links ---------------------------------------------------------------------------------


def _public_share(share: dict) -> dict:
    return {
        "token": share["token"],
        "item_id": share["item_id"],
        "name": share.get("name"),
        "kind": share.get("kind"),
        "created_at": share["created_at"].isoformat(),
        "expires_at": share["expires_at"].isoformat() if share.get("expires_at") else None,
        "expired": bool(share.get("expires_at") and share["expires_at"] < datetime.now(timezone.utc)),
    }


class ShareRequest(BaseModel):
    # 1, 7 or 30; None = never expires
    expires_days: Optional[int] = None


@router.post("/items/{item_id}/shares")
def create_share(item_id: str, req: ShareRequest) -> dict:
    """Create a link that lets anyone who has it view and download the item (Editors of its Project)."""
    item = _item(item_id, need="editor")
    if req.expires_days is not None and req.expires_days not in SHARE_EXPIRY_DAYS:
        raise HTTPException(400, f"expires_days must be one of {SHARE_EXPIRY_DAYS} or empty")
    now = datetime.now(timezone.utc)
    expires = (now + timedelta(days=req.expires_days)).isoformat(timespec="seconds") if req.expires_days else None
    token = secrets.token_urlsafe(18)
    db.share_create(token, item_id, now.isoformat(timespec="seconds"), expires)
    return _public_share({**db.share_get(token), "name": item["name"], "kind": item["kind"]})


@router.get("/items/{item_id}/shares")
def item_shares(item_id: str) -> list[dict]:
    _item(item_id)
    return [_public_share(s) for s in db.share_list(item_id)]


@router.get("/shares")
def all_shares() -> list[dict]:
    _require_db()
    return [_public_share(s) for s in db.share_list() if auth.can_access(s.get("item_id"))]


@router.delete("/shares/{token}")
def revoke_share(token: str) -> dict:
    _require_db()
    share = db.share_get(token)
    if share:
        _item(share["item_id"], trashed_ok=True, need="editor")
    db.share_delete(token)
    return {"revoked": token}


def _shared(token: str, item_id: Optional[str] = None) -> tuple[dict, dict, dict]:
    """(share, shared root item, requested item) for a public request; the requested item must be
    the shared item or inside it."""
    _require_db()
    share = db.share_get(token)
    if not share:
        raise HTTPException(404, "this link does not exist or was turned off")
    if share["expires_at"] and share["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(410, "this link has expired")
    root = db.drive_get(share["item_id"])
    if not root or root.get("trashed_at"):
        raise HTTPException(404, "the shared item was deleted")
    if auth.enabled() and auth.effective_markings(root["id"]):
        raise HTTPException(403, "this item carries markings: links do not open marked items")
    if not item_id or item_id == root["id"]:
        return share, root, root
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or root["id"] not in (p["id"] for p in db.drive_path(item_id)):
        raise HTTPException(404, "item not found")
    # a marked item inside a shared folder is not part of the link (never named, opened or downloaded)
    if _marked_for_link(item["id"]):
        raise HTTPException(404, "item not found")
    return share, root, item


def _marked_for_link(item_id: str) -> bool:
    """Links are opened without signing in: an item with any marking (own, from a folder above, or inherited from its
    inputs) stays out of them."""
    return bool(auth.enabled() and auth.effective_markings(item_id))


def _shared_public(item: dict) -> dict:
    """What a link visitor sees of an item: no ids of anything outside the share, no dates of creation."""
    pub = _public(item)
    return {k: pub[k] for k in ("id", "kind", "name", "size", "content_type", "items", "updated_at")}


@router.get("/shared/{token}")
def open_share(token: str, folder: Optional[str] = None) -> dict:
    """Public: the shared item; for a folder, the contents of it (or of a folder inside it)."""
    share, root, current = _shared(token, folder)
    path = db.drive_path(current["id"])
    below_root = path[[p["id"] for p in path].index(root["id"]) :]
    return {
        "expires_at": share["expires_at"].isoformat() if share["expires_at"] else None,
        "root": _shared_public(root),
        "current": _shared_public(current),
        "path": below_root,
        "items": [_shared_public(i) for i in db.drive_list(current["id"]) if not _marked_for_link(i["id"])] if current["kind"] in CONTAINERS else [],
    }


@router.get("/shared/{token}/items/{item_id}/content", response_model=None)
def shared_content(token: str, item_id: str, disposition: Literal["attachment", "inline"] = "attachment") -> Response:
    _, _, item = _shared(token, item_id)
    if item["kind"] != "file":
        raise HTTPException(400, "folders download as a zip")
    return content(item["id"], disposition)


@router.get("/shared/{token}/zip", response_model=None)
def shared_zip(token: str, folder: Optional[str] = None) -> Response:
    _, _, item = _shared(token, folder)
    return _zip_response([item], item["name"] + ".zip", public=True)


# ------------------------------------------------------------------------------------------------
# used by server.py and knowledge.py (Parse → "Choose from Files", "Save to Files", and the
# automatic copies in the default project)
# ------------------------------------------------------------------------------------------------


def ensure_defaults() -> None:
    """Create the default project and its folders if missing (a name a user already took at that
    level gets a " (2)" suffix). Cheap once they exist."""
    if not db.enabled():
        return
    with _defaults_lock:
        project = db.drive_by_system("project")
        if not project:
            project = _item(_insert_container(None, "project", _free_name(None, DEFAULT_PROJECT), "project"))
            log.info("created the default project %s", project["id"])
        for key, name in DEFAULT_FOLDERS.items():
            if not db.drive_by_system(key):
                _insert_container(project["id"], "folder", _free_name(project["id"], name), key)
        if not db.drive_by_system("buffer"):
            parsed = db.drive_by_system("parsed")
            _insert_container(parsed["id"], "folder", _free_name(parsed["id"], BUFFER_FOLDER), "buffer")


def default_folder(key: str) -> str:
    """Id of a default folder: "documents", "parsed", "extracted", "pipelines", "sources", "ontology" or "code"."""
    ensure_defaults()
    folder = db.drive_by_system(key)
    if not folder:
        raise RuntimeError(f"default folder {key} is missing")
    return folder["id"]


def save_to_default(key: str, name: str, data: bytes | Path, content_type: str) -> Optional[dict]:
    """Save bytes or a local file into a default folder. Never raises (the copy is a convenience):
    returns the new item, or None if Files is unavailable or the save failed."""
    if not db.enabled():
        return None
    try:
        parent_id = default_folder(key)
        name = _clean_name(BAD_NAME.sub("_", name))
        if isinstance(data, Path):
            with open(data, "rb") as f:
                return _public(_store(parent_id, name, f, data.stat().st_size, content_type))
        return _public(_store(parent_id, name, io.BytesIO(data), len(data), content_type))
    except Exception:
        log.exception("could not save %s to the default %s folder", name, key)
        return None


def get_file(item_id: str) -> dict:
    item = _item(item_id)
    if item["kind"] != "file":
        raise HTTPException(400, "not a file")
    return item


def save_bytes(parent_id: Optional[str], name: str, data: bytes, content_type: str) -> dict:
    """Add a generated file (e.g. a parse result) to a folder; None is the top level."""
    _require_db()
    return _public(_store(_folder_id(parent_id), _clean_name(name), io.BytesIO(data), len(data), content_type))


def copy_content(item: dict, dest: Path) -> None:
    """Write a drive file's contents to a local path (the caller needs its markings, like read_bytes)."""
    auth.check_item(item)
    if item["stored_in"] == "s3":
        storage.download_file(f"drive/{item['id']}", str(dest))
    else:
        shutil.copyfile(LOCAL_DIR / item["id"], dest)


_buffer_lock = threading.Lock()


def buffer_run_folder(name: str) -> str:
    """Id of the folder `name` in Parsed Document / Buffer, created if missing (one per parse run)."""
    parent_id = default_folder("buffer")
    name = _clean_name(BAD_NAME.sub("_", name))
    with _buffer_lock:
        for item in db.drive_list(parent_id):
            if item["kind"] == "folder" and item["name"].lower() == name.lower():
                return item["id"]
        return _insert_container(parent_id, "folder", name)


def find_buffer_run_folder(name: str) -> Optional[str]:
    parent_id = default_folder("buffer")
    name = _clean_name(BAD_NAME.sub("_", name))
    for item in db.drive_list(parent_id):
        if item["kind"] == "folder" and item["name"].lower() == name.lower():
            return item["id"]
    return None


def list_files(folder_id: str) -> list[dict]:
    return [i for i in db.drive_list(folder_id) if i["kind"] == "file"]


def read_bytes(item: dict) -> bytes:
    auth.check_item(item)
    if item["stored_in"] == "s3":
        return storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{item['id']}")["Body"].read()
    return (LOCAL_DIR / item["id"]).read_bytes()


def read_head(item: dict, n: int) -> bytes:
    """The first n bytes of a file (the start of a big file, without reading it all)."""
    auth.check_item(item)
    if item["stored_in"] == "s3":
        return storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{item['id']}", Range=f"bytes=0-{max(0, n - 1)}")["Body"].read()
    with open(LOCAL_DIR / item["id"], "rb") as f:
        return f.read(n)


def delete_tree(item_id: str) -> None:
    """Delete a (non-default) folder and everything in it."""
    item = _item(item_id)
    if item.get("system"):
        raise ValueError("default folders cannot be deleted")
    _delete_contents(db.drive_delete(item_id, _now()))


def _delete_contents(files: list[dict]) -> None:
    """Remove stored contents; a failure leaves an orphaned object but never fails the request."""
    try:
        s3_keys = [f"drive/{f['id']}" for f in files if f["stored_in"] == "s3"]
        if s3_keys:
            storage.delete_keys(s3_keys)
        for f in files:
            if f["stored_in"] == "local":
                (LOCAL_DIR / f["id"]).unlink(missing_ok=True)
    except Exception:
        log.exception("could not delete the contents of %d drive files", len(files))
