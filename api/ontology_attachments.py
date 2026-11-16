"""Attachments and media for functions (Foundry's Attachment.read() / attachments.upload() and Media read / upload).

An attachment or a media item is a Files item; object properties of type attachment or media hold its ID. Functions
run in the repository runner and reach the platform over JSON, so the bytes travel base64-encoded:

- GET  /api/ontology/attachments/{id}            metadata: name, media type, size, path
- GET  /api/ontology/attachments/{id}/content    {"data": base64} (the caller needs the item's markings)
- POST /api/ontology/attachments                 upload {filename, data (base64), media_type?, kind: attachment | media,
                                                 object_type_id?, property?}: an attachment goes to My Project /
                                                 Ontology attachments, a media item to the property's upload
                                                 destination (else My Project / Ontology)

Uploaded files persist in Files; like Foundry they are meant to be set on an object property by the function's edits.
Uploads no object refers to after UNCLAIMED_HOURS go to the trash (restorable for the trash's retention): an hourly
sweep, or POST /api/ontology/attachments/cleanup.

Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import base64
import binascii
import mimetypes
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import ontology

router = APIRouter(prefix="/api/ontology/attachments")

MAX_BYTES = 50 * 1024 * 1024


def _meta(item: dict) -> dict:
    import db

    return {"id": item["id"], "name": item["name"], "media_type": item.get("content_type") or "application/octet-stream",
            "size_bytes": item.get("size_bytes", item.get("size")) or 0, "path": "/".join(p["name"] for p in db.drive_path(item["id"]))}


def _file(item_id: str) -> dict:
    import drive

    item = drive._item(item_id)
    if item["kind"] != "file":
        raise HTTPException(400, "not a file")
    return item


@router.get("/{item_id}")
def metadata(item_id: str) -> dict:
    return _meta(_file(item_id))


@router.get("/{item_id}/content")
def content(item_id: str) -> dict:
    import drive

    item = _file(item_id)
    if (item.get("size_bytes") or 0) > MAX_BYTES:
        raise HTTPException(413, f"{item['name']} is larger than {MAX_BYTES // (1024 * 1024)} MB")
    return {**_meta(item), "data": base64.b64encode(drive.read_bytes(item)).decode()}


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    data: str  # base64
    media_type: Optional[str] = None
    kind: Literal["attachment", "media"] = "attachment"
    object_type_id: Optional[str] = None
    property: Optional[str] = None


@router.post("")
def upload(req: UploadIn) -> dict:
    import drive

    try:
        data = base64.b64decode(req.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "data is not base64") from None
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"at most {MAX_BYTES // (1024 * 1024)} MB")
    mt = req.media_type or mimetypes.guess_type(req.filename)[0] or "application/octet-stream"
    if req.kind == "media":
        folder = ontology.media_folder(req.object_type_id, req.property)["id"]
    else:
        folder = _attachments_folder()
    item = drive.save_bytes(folder, req.filename, data, mt)
    _remember(item["id"], req.kind)
    return _meta(item)


# ------------------------------------------------------------------------------------------------
# unclaimed uploads: trashed when no object refers to them
# ------------------------------------------------------------------------------------------------

UNCLAIMED_HOURS = 24
_ledger_lock = __import__("threading").Lock()


def _ledger_path():
    return ontology.DIR / "attachment-uploads.json"


def _remember(item_id: str, kind: str) -> None:
    with _ledger_lock:
        led = ontology._read(_ledger_path(), {}) or {}
        led[item_id] = {"at": ontology._now(), "kind": kind}
        ontology._write(_ledger_path(), led)


def _referenced() -> set[str]:
    """Every Files item id an attachment or media property of any object holds."""
    out: set[str] = set()
    for t in ontology._all("object-types"):
        props = [p["api_name"] for p in t["properties"] if p["type"] in ("attachment", "media")]
        if not props:
            continue
        import ontology_live

        # a live type's attachments can only be in its edits (its dataset's columns are no attachments)
        objs = ({"properties": e} for e, _ in ontology_live.edits(t["id"]).values()) if ontology_live.is_live(t["id"]) else ontology.stored_objects(t["id"]).values()
        for o in objs:
            for n in props:
                v = (o.get("properties") or {}).get(n)
                for x in v if isinstance(v, list) else [v]:
                    if isinstance(x, dict):
                        x = x.get("id") or x.get("item_id") or x.get("rid")
                    if x:
                        out.add(str(x))
    return out


def cleanup(hours: float = UNCLAIMED_HOURS, now=None) -> dict:
    """Trash uploads older than `hours` that no object refers to; forget the ones an object claimed."""
    from datetime import datetime, timedelta, timezone

    import db

    now = now or datetime.now(timezone.utc)
    with _ledger_lock:
        led = ontology._read(_ledger_path(), {}) or {}
    if not led:
        return {"trashed": [], "claimed": 0, "waiting": 0}
    refs = _referenced()
    trashed, claimed, keep = [], 0, {}
    for item_id, rec in led.items():
        if item_id in refs:
            claimed += 1
            continue
        try:
            at = datetime.fromisoformat(str(rec["at"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        if now - at < timedelta(hours=hours):
            keep[item_id] = rec
            continue
        item = db.drive_get(item_id)
        if item and not item.get("trashed_at"):
            db.drive_trash(item_id, now.isoformat(timespec="seconds"))
            trashed.append(item_id)
    with _ledger_lock:
        cur = ontology._read(_ledger_path(), {}) or {}
        # uploads recorded while sweeping stay
        ontology._write(_ledger_path(), {**keep, **{k: v for k, v in cur.items() if k not in led}})
    return {"trashed": trashed, "claimed": claimed, "waiting": len(keep)}


@router.post("/cleanup")
def cleanup_route() -> dict:
    import auth

    if auth.enabled():
        auth.require_admin()
    return cleanup()


def startup() -> None:
    import threading
    import time

    def loop() -> None:
        while True:
            time.sleep(3600)
            try:
                cleanup()
            except Exception:  # noqa: BLE001 - tried again next hour
                pass

    threading.Thread(target=loop, daemon=True, name="attachment-cleanup").start()


def _attachments_folder() -> str:
    """My Project / Ontology / Attachments (created on first use)."""
    import db
    import drive

    parent = drive.default_folder("ontology")
    for item in db.drive_list(parent):
        if item["kind"] == "folder" and item["name"].lower() == "attachments":
            return item["id"]
    return drive._insert_container(parent, "folder", "Attachments")
