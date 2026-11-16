"""A small, permission-preserving Notepad document API backed by Files & Projects.

Documents are JSON block files in Drive with a dedicated content type. Project membership and
inherited markings remain the source of truth for read/write access.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import tempfile
from datetime import date
from typing import Annotated, Any, Literal, Optional, Union

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

import auth
import db
import drive
import notepad_engine as NE
import storage

router = APIRouter(prefix="/api/notepad", tags=["Notepad"])
# a document's resource identifier (Workshop variables hold it): the Files item id behind this prefix
NOTEPAD_RID = "ri.notepad.main.notepad."
NOTEPAD_MIME = "application/vnd.bluesandai.notepad+json"
MAX_DOCUMENT_BYTES = 6 * 1024 * 1024
MAX_IMAGE_BYTES = 1024 * 1024


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ParagraphBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["paragraph"]
    text: str = Field(max_length=20_000)


class HeadingBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["heading"]
    level: Literal[1, 2, 3]
    text: str = Field(max_length=4_000)


class TableBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["table"]
    # up to 1,000 rows: table row generators write one row per object
    rows: list[list[str]] = Field(min_length=1, max_length=1001)


class ImageBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["image"]
    src: str = Field(max_length=1_500_000)
    alt: str = Field(default="", max_length=300)
    width: int = Field(default=100, ge=20, le=100)


class RuleBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["rule"]


class PageBreakBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["page_break"]


class DateBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["date"]
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class AppLinkBlock(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    type: Literal["app_link"]
    app: Literal["contour", "insight", "quiver", "object_explorer", "code_workbook", "workshop", "map"]
    label: str = Field(default="", max_length=200)


class WidgetBlock(StrictModel):
    """Embedded widgets, template widgets and sections (notepad_engine.py); sections hold child blocks."""
    id: str = Field(min_length=1, max_length=80)
    type: Literal["widget"]
    kind: Literal[NE.WIDGET_KINDS]  # type: ignore[valid-type]
    config: dict[str, Any] = Field(default_factory=dict)
    children: list["Block"] = Field(default_factory=list, max_length=200)
    # Lock data: {at, by, data} shown instead of live data
    locked: Optional[dict[str, Any]] = None


Block = Annotated[
    Union[ParagraphBlock, HeadingBlock, TableBlock, ImageBlock, RuleBlock, PageBreakBlock, DateBlock, AppLinkBlock, WidgetBlock],
    Field(discriminator="type"),
]
WidgetBlock.model_rebuild()


class TemplateInput(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=80)
    type: Literal["string", "number", "date", "timestamp", "object", "object_set"]
    object_type_id: Optional[str] = None
    # used while configuring the template only (not a default)
    preview: Any = None
    required: bool = True


class TemplateSpec(StrictModel):
    inputs: list[TemplateInput] = Field(default_factory=list, max_length=50)
    # published versions: {version, name, at, by, document}
    published: list[dict[str, Any]] = Field(default_factory=list)


class PageSettings(StrictModel):
    size: Literal["letter", "a4", "legal"] = "letter"
    orientation: Literal["portrait", "landscape"] = "portrait"
    header: str = Field(default="", max_length=300)
    footer: str = Field(default="", max_length=300)


class NotepadDocument(StrictModel):
    schema_version: Literal[1] = 1
    blocks: list[Block] = Field(default_factory=list, max_length=200)
    template: Optional[TemplateSpec] = None
    settings: Optional[PageSettings] = None
    # envelope security: chosen at creation, the document's markings bound what it shows
    envelope: bool = False


class CreateDocumentRequest(StrictModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None
    document: NotepadDocument


class SaveDocumentRequest(StrictModel):
    expected_updated_at: str = Field(min_length=1, max_length=80)
    document: NotepadDocument


IMAGE_SIGNATURES = {
    "image/png": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda data: data.startswith(b"\xff\xd8\xff"),
    "image/gif": lambda data: data.startswith((b"GIF87a", b"GIF89a")),
    "image/webp": lambda data: len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
}


def _validate_document(document: NotepadDocument) -> bytes:
    seen: set[str] = set()

    def blocks(items: list, depth: int = 0):
        for block in items:
            yield block
            if isinstance(block, WidgetBlock) and block.children:
                if block.kind not in NE.CONTAINERS:
                    raise HTTPException(422, "Only section generators and conditional sections hold content")
                if depth >= 3:
                    raise HTTPException(422, "Sections are nested too deeply")
                yield from blocks(block.children, depth + 1)

    for block in blocks(document.blocks):
        if block.id in seen:
            raise HTTPException(422, "Document block IDs must be unique")
        seen.add(block.id)
        if document.envelope and isinstance(block, WidgetBlock) and block.kind not in NE.ENVELOPE_WIDGETS:
            raise HTTPException(422, f"{block.kind} widgets are not supported in an envelope-secured document")
        if document.envelope and getattr(block, "type", None) == "app_link":
            raise HTTPException(422, "app links are not supported in an envelope-secured document")
    if document.envelope and document.template is not None:
        raise HTTPException(422, "an envelope-secured document cannot be a template")
        if isinstance(block, TableBlock):
            widths = {len(row) for row in block.rows}
            if not widths or len(widths) != 1 or not 1 <= next(iter(widths)) <= 20:
                raise HTTPException(422, "Tables must be rectangular and contain 1–20 columns")
            if any(len(cell) > 2_000 for row in block.rows for cell in row):
                raise HTTPException(422, "A table cell is too long")
        elif isinstance(block, ImageBlock):
            match = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)", block.src)
            if not match:
                raise HTTPException(422, "Images must be embedded PNG, JPEG, GIF, or WebP data")
            mime, encoded = match.groups()
            try:
                payload = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as error:
                raise HTTPException(422, "Image data is not valid base64") from error
            if not payload or len(payload) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "Each embedded image must be no larger than 1 MB")
            if not IMAGE_SIGNATURES[mime](payload):
                raise HTTPException(422, "Image content does not match its declared format")
        elif isinstance(block, DateBlock):
            try:
                date.fromisoformat(block.date)
            except ValueError as error:
                raise HTTPException(422, "Date widgets must use a valid calendar date") from error
    data = json.dumps(document.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(413, "Notepad documents are limited to 6 MB")
    return data


def _is_notepad(item: dict) -> None:
    if item.get("kind") != "file" or item.get("content_type") != NOTEPAD_MIME:
        # Avoid turning the Notepad API into an alternate file reader.
        raise HTTPException(404, "Notepad document not found")


def _decode_document(item: dict) -> NotepadDocument:
    raw = drive.read_bytes(item)
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise HTTPException(413, "Notepad document is larger than the supported limit")
    try:
        value = NotepadDocument.model_validate(json.loads(raw.decode("utf-8")))
        _validate_document(value)
        return value
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError) as error:
        raise HTTPException(500, "Notepad document content is invalid") from error


def _write_file_bytes(item: dict, data: bytes) -> None:
    if item.get("stored_in") == "s3":
        storage.put_fileobj(f"drive/{item['id']}", io.BytesIO(data), NOTEPAD_MIME)
        return
    if item.get("stored_in") != "local":
        raise HTTPException(500, "Notepad storage backend is unavailable")
    fd, temp_path = tempfile.mkstemp(prefix=f".{item['id']}.", dir=drive.LOCAL_DIR)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, drive.LOCAL_DIR / item["id"])
    except Exception:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise


@router.get("/folders")
def list_folders() -> list[dict]:
    drive._require_db()
    items = db.drive_query("kind IN ('project', 'folder') AND trashed_at IS NULL", order="lower(name)", limit=5000)
    return [drive._with_path(item) for item in auth.visible(items)]


@router.get("/documents")
def list_documents() -> list[dict]:
    drive._require_db()
    items = db.drive_query(
        "kind = 'file' AND content_type = %s AND trashed_at IS NULL",
        (NOTEPAD_MIME,),
        order="updated_at DESC",
        limit=500,
    )
    return [drive._with_path(item) for item in auth.visible(items)]


@router.post("/documents")
def create_document(req: CreateDocumentRequest) -> dict:
    parent_id = drive._folder_id(req.parent_id)
    name = drive._clean_name(req.name.strip())
    if not name.lower().endswith(".notepad"):
        name = f"{name[:247]}.notepad"
    data = _validate_document(req.document)
    item = drive.save_bytes(parent_id, name, data, NOTEPAD_MIME)
    return {"item": item, "document": req.document.model_dump(mode="json")}


@router.get("/documents/{item_id}")
def get_document(item_id: str) -> dict:
    item = drive._item(item_id, need="viewer")
    _is_notepad(item)
    return {"item": drive._with_path(item), "document": _decode_document(item).model_dump(mode="json")}


@router.put("/documents/{item_id}")
def save_document(item_id: str, req: SaveDocumentRequest) -> dict:
    item = drive._item(item_id, need="editor")
    _is_notepad(item)
    data = _validate_document(req.document)
    now = drive._now()

    def write_content() -> None:
        # Re-check the current request's Drive authorization immediately before replacing bytes.
        drive._item(item_id, need="editor")
        _write_file_bytes(item, data)

    previous = _decode_document(item).model_dump(mode="json")
    if bool(previous.get("envelope")) != bool(req.document.envelope):
        raise HTTPException(400, "envelope security is chosen when the document is created: create a new document to change it")
    saved = db.drive_replace_content(item_id, req.expected_updated_at, now, len(data), write_content)
    if not saved:
        raise HTTPException(409, "This document changed after it was opened. Reload before saving to avoid overwriting newer edits.")
    document = req.document.model_dump(mode="json")
    if previous != document:
        NE.autosave(item_id, previous)
        _notify_mentions(item, NE.mentions(document) - NE.mentions(previous))
    updated = drive._item(item_id, need="editor")
    return {"item": drive._with_path(updated), "document": document}


# ------------------------------------------------------------------ settings


class LimitsIn(BaseModel):
    top: Optional[int] = None
    nested: Optional[int] = None
    rows: Optional[int] = None


@router.get("/settings")
def get_settings() -> dict:
    """Generation limits: objects per section generator (top level / nested) and rows per table row generator."""
    return {"limits": NE.limits(), "defaults": NE.LIMIT_DEFAULTS, "max": NE.LIMIT_MAX}


@router.put("/settings")
def put_settings(req: LimitsIn) -> dict:
    auth.require_admin()
    NE.save_limits({k: v for k, v in req.model_dump().items() if v is not None})
    return get_settings()


# ------------------------------------------------------------------ widgets, templates, versions, links, exports


def _store(item: dict, document: dict) -> dict:
    """Replace a document's content (server-side changes: lock data, restore, publish)."""
    value = NotepadDocument.model_validate(document)
    data = _validate_document(value)
    current = drive._item(item["id"], need="editor")

    def write_content() -> None:
        _write_file_bytes(current, data)

    at = current["updated_at"]
    if not db.drive_replace_content(item["id"], at.isoformat() if hasattr(at, "isoformat") else str(at), drive._now(), len(data), write_content):
        raise HTTPException(409, "The document changed meanwhile; try again")
    return drive._with_path(drive._item(item["id"], need="editor"))


def _open(item_id: str, need: str = "viewer") -> tuple[dict, dict]:
    item = drive._item(item_id, need=need)
    _is_notepad(item)
    return item, _decode_document(item).model_dump(mode="json")


def _envelope(item_id: str, document: dict) -> Optional[set]:
    """An envelope-secured document's envelope: its markings (from its folders too); None for a regular document."""
    return set(auth.effective_markings(item_id)) if document.get("envelope") else None


def _banner(item_id: str, document: dict) -> Optional[str]:
    """The markings banner of an envelope-secured document."""
    env = _envelope(item_id, document)
    if env is None:
        return None
    names = auth.marking_labels() if env else {}
    return " // ".join(sorted(names.get(m, m) for m in env)).upper() or "UNMARKED"


def _defs(document: dict) -> list[dict]:
    return ((document.get("template") or {}).get("inputs")) or []


def _notify_mentions(item: dict, users: set) -> None:
    if not users:
        return
    import notify

    me = (auth.current() or {}).get("id")
    title = item["name"].removesuffix(".notepad")
    for uid in users - {me}:
        try:
            notify.deliver(uid, f"You were mentioned in {title}", f"{NE._me()['name']} mentioned you in the Notepad document {title}.",
                           link=f"/notepad/{item['id']}", link_label="Open document", source="notepad")
        except Exception:  # noqa: BLE001 — a notification failure must not fail the save
            pass


class ResolveRequest(StrictModel):
    # template input values to preview with (defaults: the inputs' preview values)
    inputs: dict[str, Any] = Field(default_factory=dict)
    # an unsaved document to resolve instead of the saved one
    document: Optional[NotepadDocument] = None


@router.post("/documents/{item_id}/resolve")
def resolve_widgets(item_id: str, req: ResolveRequest) -> dict:
    """Every widget's data (live, or its locked snapshot); a template's widgets use the preview values."""
    _item, stored = _open(item_id)
    doc = req.document.model_dump(mode="json") if req.document is not None else stored
    # the stored document decides envelope security (an unsaved draft cannot switch it off)
    doc["envelope"] = stored.get("envelope", False)
    ctx = NE.Ctx(NE.input_values(_defs(doc), req.inputs, preview=True), _defs(doc), envelope=_envelope(item_id, doc))
    return {"widgets": NE.resolve(doc["blocks"], ctx), "banner": _banner(item_id, doc)}


class DashboardRunRequest(StrictModel):
    # a reader's selections in the dashboard's selector cards: {card ID: value, or a list for a multiselect}
    selections: dict[str, Any] = Field(default_factory=dict)
    # the widget as in an unsaved draft (same ID); none: the saved document's widget
    block: Optional[WidgetBlock] = None


@router.post("/documents/{item_id}/widgets/{block_id}/run")
def run_dashboard_widget(item_id: str, block_id: str, req: DashboardRunRequest) -> dict:
    """An embedded Quiver dashboard re-run with a reader's selections, for this view only: nothing is saved, the
    document (and its exports) keep the dashboard's saved defaults."""
    if len(req.selections) > 200:
        raise HTTPException(400, "at most 200 selections")
    _item, stored = _open(item_id)
    if req.block is not None:
        if req.block.id != block_id:
            raise HTTPException(400, "the widget ID does not match")
        b = req.block.model_dump(mode="json")
    else:
        b = next((x for x in NE.walk(stored["blocks"]) if x.get("type") == "widget" and x["id"] == block_id), None)
        if b is None:
            raise HTTPException(404, "no such widget in the document")
    ctx = NE.Ctx(NE.input_values(_defs(stored), {}, preview=True), _defs(stored), envelope=_envelope(item_id, stored))
    return NE.run_dashboard(b, ctx, req.selections)


@router.get("/quiver-dashboards/{dashboard_item_id}")
def quiver_dashboard_info(dashboard_item_id: str, version: Optional[int] = None) -> dict:
    """A published Quiver dashboard for the widget's properties: its versions and a version's (default: the latest)
    inputs — the root object, parameter cards and selector cards — with their types and the Notepad types they take."""
    return NE.dashboard_info(dashboard_item_id, version)


class LockRequest(StrictModel):
    lock: bool = True
    # none: every widget
    block_ids: Optional[list[str]] = None


@router.post("/documents/{item_id}/lock")
def lock_widgets(item_id: str, req: LockRequest) -> dict:
    """Lock data: snapshot widgets' current data (as the user locking sees it), or unlock them (Update data)."""
    item, doc = _open(item_id, "editor")
    ctx = NE.Ctx(NE.input_values(_defs(doc), {}, preview=True), _defs(doc), envelope=_envelope(item_id, doc))
    me, at, changed = NE._me(), NE._now(), 0
    for b in NE.walk(doc["blocks"]):
        if b.get("type") != "widget" or (req.block_ids is not None and b["id"] not in req.block_ids):
            continue
        # a Quiver dashboard locks when it embeds a published dashboard (an analysis' dashboard is drawn live: "client")
        if b["kind"] in ("section_generator", "table_row_generator", "conditional_section", "value_embed", "latex", "anchor_link"):
            continue
        if req.lock and not b.get("locked"):
            try:
                data = NE.widget_data({**b, "locked": None}, ctx)
            except HTTPException as e:
                raise HTTPException(400, f"cannot lock a widget: {e.detail}") from None
            if data.get("client"):
                continue  # drawn by the browser from live data (Quiver time series): nothing to snapshot
            b["locked"] = {"at": at, "by": me, "data": data}
            changed += 1
        elif not req.lock and b.get("locked"):
            b["locked"] = None
            changed += 1
    out = _store(item, doc) if changed else drive._with_path(item)
    return {"item": out, "document": doc, "changed": changed}


@router.get("/documents/{item_id}/versions")
def list_versions(item_id: str, all: bool = False) -> list[dict]:
    """Version history: user-created versions, or also autosaves (every 5 minutes while editing)."""
    _open(item_id)
    return [{k: v for k, v in x.items() if k != "document"} for x in reversed(NE.versions(item_id)) if all or not x.get("auto")]


class VersionRequest(StrictModel):
    name: str = Field(default="", max_length=200)
    endorsed: bool = False


@router.post("/documents/{item_id}/versions")
def create_version(item_id: str, req: VersionRequest) -> dict:
    _item, doc = _open(item_id, "editor")
    v = NE.add_version(item_id, doc, req.name.strip(), req.endorsed)
    return {k: x for k, x in v.items() if k != "document"}


@router.get("/documents/{item_id}/versions/{version_id}")
def get_version(item_id: str, version_id: str) -> dict:
    _item, doc = _open(item_id)
    v = next((x for x in NE.versions(item_id) if x["id"] == version_id), None)
    if not v:
        raise HTTPException(404, "version not found")
    return {**v, "changes": NE.diff(v["document"], doc)}


@router.post("/documents/{item_id}/versions/{version_id}/restore")
def restore_version(item_id: str, version_id: str) -> dict:
    """Roll back: the current content is saved as a version first."""
    item, doc = _open(item_id, "editor")
    v = next((x for x in NE.versions(item_id) if x["id"] == version_id), None)
    if not v:
        raise HTTPException(404, "version not found")
    NE.add_version(item_id, doc, "Before restoring " + (v.get("name") or v["at"]), auto=True)
    out = _store(item, v["document"])
    return {"item": out, "document": v["document"]}


class PublishRequest(StrictModel):
    name: str = Field(default="", max_length=200)


@router.post("/documents/{item_id}/template/publish")
def publish_template(item_id: str, req: PublishRequest) -> dict:
    """Publish the template's content and inputs as a new version number (generation uses published versions)."""
    item, doc = _open(item_id, "editor")
    if doc.get("template") is None:
        raise HTTPException(400, "this document is not a template")
    pub = doc["template"]["published"]
    snapshot = {"blocks": doc["blocks"], "inputs": doc["template"]["inputs"], "settings": doc.get("settings")}
    v = {"version": (pub[-1]["version"] + 1) if pub else 1, "name": req.name.strip(), "at": NE._now(), "by": NE._me(), "document": snapshot}
    pub.append(v)
    out = _store(item, doc)
    return {"item": out, "document": doc, "version": v["version"]}


class GenerateRequest(StrictModel):
    inputs: dict[str, Any] = Field(default_factory=dict)
    # a published version (default: the latest); "draft" previews the unpublished template with these inputs
    version: Optional[Union[int, Literal["draft"]]] = None
    name: str = Field(default="", max_length=255)
    parent_id: Optional[str] = None
    dry_run: bool = False


@router.post("/documents/{item_id}/template/generate")
def generate(item_id: str, req: GenerateRequest) -> dict:
    """A new document from a template: inputs filled in, generators and conditional sections expanded."""
    item, doc = _open(item_id)
    tpl = doc.get("template")
    if tpl is None:
        raise HTTPException(400, "this document is not a template")
    if req.version == "draft":
        src = {"blocks": doc["blocks"], "inputs": tpl["inputs"], "settings": doc.get("settings")}
    else:
        pubs = tpl["published"]
        if not pubs:
            raise HTTPException(400, "publish the template before generating documents")
        pv = pubs[-1] if req.version is None else next((p for p in pubs if p["version"] == req.version), None)
        if not pv:
            raise HTTPException(404, f"no published version {req.version}")
        src = pv["document"]
    ctx = NE.Ctx(NE.input_values(src["inputs"], req.inputs, preview=req.dry_run), src["inputs"])
    blocks = NE.expand(src["blocks"], ctx)
    new = {"schema_version": 1, "blocks": blocks, "settings": src.get("settings")}
    if sum(1 for _ in NE.walk(blocks)) > 2000:
        raise HTTPException(400, "the generated document is too large (over 2,000 blocks); narrow the object sets")
    if req.dry_run:
        value = NotepadDocument.model_validate(new)
        _validate_document(value)
        return {"document": new, "widgets": NE.resolve(blocks, NE.Ctx({}, []))}
    title = req.name.strip() or f"{item['name'].removesuffix('.notepad')} - {NE._now()[:10]}"
    res = create_document(CreateDocumentRequest(name=title, parent_id=req.parent_id or item.get("parent_id"), document=NotepadDocument.model_validate(new)))
    return res


class SaveAsTemplateRequest(StrictModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: Optional[str] = None


@router.post("/documents/{item_id}/save-as-template")
def save_as_template(item_id: str, req: SaveAsTemplateRequest) -> dict:
    item, doc = _open(item_id)
    doc["template"] = doc.get("template") or {"inputs": [], "published": []}
    doc["template"]["published"] = []
    return create_document(CreateDocumentRequest(name=req.name, parent_id=req.parent_id or item.get("parent_id"), document=NotepadDocument.model_validate(doc)))


@router.get("/documents/{item_id}/links")
def document_links(item_id: str) -> dict:
    """View document links: the objects and resources the document's widgets reference."""
    _item, doc = _open(item_id)
    out = NE.links(doc)
    for o in out["objects"]:
        try:
            o["title"] = NE._obj(o["object_type_id"], o["pk"])["title"]
        except HTTPException:
            o["title"] = None  # an object the viewer cannot see
    for r in out["resources"]:
        if r["kind"] in ("contour", "file", "quiver_dashboard"):
            try:
                r["name"] = drive._item(r["id"])["name"].removesuffix(".quiver-dashboard")
            except HTTPException:
                r["name"] = None
    return out


@router.get("/linked-documents")
def linked_documents(object_type_id: str, pk: str) -> list[dict]:
    """Documents that reference an object (Workshop's Notepad: Linked documents)."""
    drive._require_db()
    items = auth.visible(db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (NOTEPAD_MIME,), order="updated_at DESC", limit=500))
    import contextvars
    from concurrent.futures import ThreadPoolExecutor

    def read(it: dict) -> None:
        # a document's object links, kept until the document changes (reading every document on each call took
        # tens of seconds with a hundred documents in remote storage)
        try:
            doc = _decode_document(it).model_dump(mode="json")
        except HTTPException:
            entry = (str(it["updated_at"]), set(), False)
        else:
            entry = (str(it["updated_at"]), {(o["object_type_id"], str(o["pk"])) for o in NE.links(doc)["objects"]}, doc.get("template") is not None)
        _LINKS[it["id"]] = entry

    stale = [it for it in items if _LINKS.get(it["id"], ("",))[0] != str(it["updated_at"])]
    if stale:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda it: contextvars.copy_context().run(read, it), stale))
    for gone in set(_LINKS) - {it["id"] for it in items} if len(_LINKS) > 2000 else ():
        _LINKS.pop(gone, None)
    out = []
    for it in items:
        _at, links, is_template = _LINKS.get(it["id"], ("", set(), False))
        if (object_type_id, str(pk)) in links:
            author = auth.user_label(it.get("created_by")) if it.get("created_by") else None
            out.append({**drive._with_path(it), "rid": NOTEPAD_RID + it["id"], "author": (author or {}).get("display_name") or (author or {}).get("username"), "template": is_template})
    return out


# linked_documents: {item id: (updated_at, {(object type id, primary key)}, is a template)}
_LINKS: dict[str, tuple] = {}


@router.get("/documents/{item_id}/export")
def export(item_id: str, format: Literal["docx", "markdown", "pdf"] = "docx", filename: Optional[str] = None) -> Response:
    """Export as DOCX (Word) or Markdown, with widgets as their current (or locked) data, or as PDF: the document page
    (embed mode) printed by headless Chrome as the requesting user (report_render.py; the browser's print works too).
    `filename`: the downloaded file's name without extension (default: the document's name)."""
    item, doc = _open(item_id)
    title = item["name"].removesuffix(".notepad")
    if filename and filename.strip():
        title = re.sub(r'[\\/:*?"<>|]|[\x00-\x1f]', "_", filename.strip())[:200].removesuffix(f".{format}")
    if format == "pdf":
        import report_render

        try:
            pdf = report_render.render(f"/notepad/{item_id}?embed=1", "pdf", (auth.current() or {}).get("id"))
        except report_render.RenderError as e:
            raise HTTPException(503, str(e)) from None
        return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": _disposition(title + ".pdf")})
    data = NE.resolve(doc["blocks"], NE.Ctx(NE.input_values(_defs(doc), {}, preview=True), _defs(doc), envelope=_envelope(item_id, doc)))
    banner = _banner(item_id, doc)
    if format == "markdown":
        return Response(NE.to_markdown(title, doc, data, banner), media_type="text/markdown",
                        headers={"Content-Disposition": _disposition(title + ".md")})
    return Response(NE.to_docx(title, doc, data, banner), media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": _disposition(title + ".docx")})


def _disposition(name: str) -> str:
    from urllib.parse import quote

    return f"attachment; filename=\"{name.encode('ascii', 'replace').decode().replace(chr(34), '')}\"; filename*=UTF-8''{quote(name)}"


@router.get("/templates")
def list_templates() -> list[dict]:
    """Document templates (with their published versions' numbers and the latest version's inputs)."""
    drive._require_db()
    items = auth.visible(db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (NOTEPAD_MIME,), order="updated_at DESC", limit=500))
    out = []
    for it in items:
        try:
            doc = _decode_document(it).model_dump(mode="json")
        except HTTPException:
            continue
        tpl = doc.get("template")
        if tpl is None:
            continue
        latest = tpl["published"][-1] if tpl["published"] else None
        out.append({**drive._with_path(it), "versions": [{"version": p["version"], "name": p["name"], "at": p["at"], "by": p["by"]} for p in tpl["published"]],
                    "inputs": latest["document"]["inputs"] if latest else tpl["inputs"]})
    return out


# ------------------------------------------------------------------------------------------------
# AIP assist: write, rewrite or summarize with a language model, grounded in the document
# ------------------------------------------------------------------------------------------------

ASSIST_CONTEXT_CHARS = 24_000
ASSIST_SYSTEM = (
    "You help write a report in Notepad, a document editor. Answer with Markdown only: headings (#, ##, ###), "
    "paragraphs, lists, bold and italics; no code fences, no preamble, no closing remarks. Base facts and numbers on "
    "the document below (its widgets show live data); if the document does not hold what is asked, say so instead of "
    "inventing it. Write in the document's language."
)


class AssistIn(BaseModel):
    instruction: str = Field("", max_length=4000)
    mode: Literal["write", "rewrite", "summarize"] = "write"
    # rewrite: the text of the block to rewrite
    selection: Optional[str] = Field(None, max_length=20_000)
    # the editor's current (possibly unsaved) document; the saved one when missing
    document: Optional[dict] = None
    model: Optional[str] = Field(None, max_length=200)


@router.post("/documents/{item_id}/assist")
def assist(item_id: str, req: AssistIn) -> dict:
    """AIP assist: Markdown from a language model with the document (text and widget data, as in the Markdown export)
    as context. Envelope-secured documents are refused (their marked data would leave the platform)."""
    import ontology
    import pipeline_ai

    item, doc = _open(item_id)
    if doc.get("envelope"):
        raise HTTPException(400, "AIP assist is off for envelope-secured documents")
    if req.mode == "rewrite" and not (req.selection or "").strip():
        raise HTTPException(400, "select a text block to rewrite")
    if req.mode != "summarize" and not req.instruction.strip():
        raise HTTPException(400, "say what to write")
    use = doc
    if req.document:
        try:
            draft = NotepadDocument.model_validate(req.document)
            _validate_document(draft)
            use = draft.model_dump(mode="json")
        except Exception:  # noqa: BLE001 - a draft that does not validate: the saved document
            use = doc
    title = item["name"].removesuffix(".notepad")
    try:
        data = NE.resolve(use["blocks"], NE.Ctx(NE.input_values(_defs(use), {}, preview=True), _defs(use), envelope=None))
        context = NE.to_markdown(title, use, data)
    except Exception:  # noqa: BLE001 - widgets that fail to resolve: the text alone
        context = NE.to_markdown(title, use, {})
    if len(context) > ASSIST_CONTEXT_CHARS:
        context = context[:ASSIST_CONTEXT_CHARS] + "\n\n[… the rest of the document is left out]"
    task = {"write": f"Write new content for the document: {req.instruction.strip()}",
            "rewrite": f"Rewrite this passage of the document. {req.instruction.strip() or 'Make it clearer.'}\n\nPassage:\n{(req.selection or '').strip()}",
            "summarize": f"Summarize the document{': ' + req.instruction.strip() if req.instruction.strip() else ' in a short paragraph and the key points as a list'}."}[req.mode]
    model = req.model or ontology.DEFAULT_LLM
    try:
        text = pipeline_ai.chat(model, ASSIST_SYSTEM, f"The document:\n\n{context}\n\n---\n\n{task}", None, 0.3, 2048)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the language model failed: {e}") from None
    text = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", str(text or "").strip())
    return {"markdown": text, "model": model, "context_chars": len(context)}
