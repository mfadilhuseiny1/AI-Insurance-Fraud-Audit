"""Media sets (Palantir's media sets: palantir.com/docs/foundry/media-sets-advanced-formats).

A media set is a Files folder plus the settings kept here, so everything that reads or writes media set folders
(Pipeline Builder, Code Repositories, Data Connection, Workshop, markings on folders) keeps working:

* schema (audio, DICOM, document, email, image, spreadsheet, video, or multimodal = any format) and a primary
  format; additional input formats are converted to the primary format on upload (images with Pillow, audio and
  video with the ffmpeg of imageio-ffmpeg; DOCX / PPTX / TXT become text PDFs — their text only, not their layout);
* path deduplication with version history: an upload to an existing path keeps the older item (its bytes move to
  this module's version store, so its media reference — the old item id — still renders) and shows only the newest;
* soft delete (the item disappears from the set but stays readable through its reference); not for media sets a
  build pipeline writes;
* transaction policies: transactionless (uploads readable at once; builds only add or overwrite) or transactional
  (uploads go through a transaction — one open per media set, at most 10,000 items, committed or aborted as a whole;
  builds may replace the whole set);
* retention policies: delete items older than N days, and overwritten / deleted versions N days after that;
* limits: paths of at most 256 characters, items of at most 50 GB;
* access patterns: thumbnails, rendered PDF pages, video frames, audio waveforms, spreadsheets as JSON, email
  bodies, DICOM layers, PDF text, audio (a selected channel or a mix-down, transcoded), transcription (of a selected
  channel or the mix-down), HLS streaming (an .m3u8 playlist of 6-second MPEG-TS segments, H.264 / AAC, rendered by ffmpeg
  in a background job — the source fetched and probed on its own thread, at most HLS_WORKERS ffmpeg passes at once,
  progress at /hls/status, playable from the first segments (a growing EVENT playlist), cancellable); the audio /
  video patterns (thumbnail / frame, waveform, audio, transcription) run as background jobs too (media_jobs: progress
  at /access/{pattern}/status, 202 while computing, small items still answered inline), and every job of an item
  reads one shared local copy of its source (fetched once, reference-counted, LRU-swept within a size budget) — each
  with a persistence policy: persist after the first request (the default; items never change: a new upload is a new
  id), cache for a time (recomputed once older than its TTL) or recompute at every request (never stored; the byte
  ranges of one audio playback share one output, an HLS playback has its own rendition, both temporary). The
  built-in patterns' policies are media set settings; more patterns (a built-in one with fixed parameters, under a
  name) are registered with POST /{id}/access-patterns, each with its own policy;
* usage: every download and access pattern is metered in compute-seconds per GB with the doc's rates (Resource
  Management reads them);
* virtual media sets: items registered from an Amazon S3 connection without copying them (read from the source on
  demand; not aware of later updates or deletions in the source; no additional input formats).

Data in data/media-sets/: registry.json, versions/<item id>, tx/<transaction id>/, cache/<item id>/, usage.jsonl.
Background jobs leave a record while they run (<output>.job.json, or cache/_jobs/<token>.job.json for a playback's
own): after a restart, resume_jobs() queues the interrupted ones again or marks them failed (see media_jobs).
Mounted under /api/media-sets.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import db
import drive
import media_jobs

log = logging.getLogger("bluesandai.media_sets")
router = APIRouter(prefix="/api/media-sets")
DIR: Path = Path()
_lock = threading.RLock()

MAX_PATH = 256
MAX_ITEM_BYTES = 50 * 1024 ** 3
MAX_TX_ITEMS = 10_000
RETENTION_TICK = 600

# schema: (label, primary formats, {primary: additional input formats converted to it})
_IMG_IN = ["png", "jpg", "jpeg", "bmp", "tiff", "tif", "webp", "gif"]
_AUDIO = ["wav", "flac", "mp3", "mp4", "sph", "webm"]
_VIDEO = ["mp4", "mov", "ts", "mkv"]
SCHEMAS: dict[str, dict] = {
    "audio": {"label": "Audio", "formats": _AUDIO, "additional": {p: [f for f in _AUDIO + ["ogg", "m4a", "opus"] if f != p] for p in ("wav", "flac", "mp3")}},
    "dicom": {"label": "DICOM", "formats": ["dcm"], "additional": {}},
    "document": {"label": "Document", "formats": ["pdf"], "additional": {"pdf": ["docx", "pptx", "txt"]}},
    "email": {"label": "Email", "formats": ["eml"], "additional": {}},
    "image": {},  # set below (needs _canon)
    "spreadsheet": {"label": "Spreadsheet", "formats": ["xlsx"], "additional": {}},
    "video": {"label": "Video", "formats": _VIDEO, "additional": {p: [f for f in _VIDEO if f != p] for p in _VIDEO}},
    "multimodal": {"label": "Multimodal (any file format)", "formats": [], "additional": {}},
}
ALIASES = {"jpeg": "jpg", "tif": "tiff", "jp2k": "jp2", "ntf": "nitf", "dicom": "dcm"}


def _canon(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    return ALIASES.get(ext, ext)


SCHEMAS["image"] = {"label": "Image", "formats": ["png", "jpg", "jp2", "bmp", "tiff", "nitf"],
                    "additional": {p: sorted({_canon(f) for f in _IMG_IN} - {p}) for p in ("png", "jpg", "bmp", "tiff")}}

# compute-seconds per GB (palantir.com/docs/foundry/media-sets-advanced-formats/media-usage-limits)
RATES = {
    "download": 2, "image_thumbnail": 40, "image_resize": 40, "image_rotate": 40, "image_grayscale": 75, "image_crop": 75,
    "image_ocr": 275, "render_dicom_layer": 75, "audio_waveform": 75, "audio_transcode": 75, "audio_chunk": 75,
    "video_frame": 75, "video_scene_timestamps": 40, "video_transcode": 275, "pdf_page_count": 40, "pdf_render_page": 40,
    "pdf_text_raw": 75, "pdf_text_ocr": 275, "pdf_slice": 75, "spreadsheet_json": 275, "email_body": 75, "convert_input_format": 75,
    "audio_select_channel": 75, "audio_transcription": 275, "audio_hls": 75, "video_extract_audio": 75, "video_hls": 275,
}
PATTERN_COST = {"thumbnail": None, "page": "pdf_render_page", "frame": "video_frame", "waveform": "audio_waveform", "sheets": "spreadsheet_json",
                "email": "email_body", "dicom": "render_dicom_layer", "text": "pdf_text_raw", "audio": "audio_select_channel",
                "transcription": "audio_transcription", "hls": "audio_hls"}
# the built-in access patterns of each schema (multimodal: all of them)
SCHEMA_PATTERNS = {"image": ["thumbnail"], "document": ["thumbnail", "page", "text"], "video": ["thumbnail", "frame", "audio", "transcription", "hls"],
                   "audio": ["waveform", "audio", "transcription", "hls"], "spreadsheet": ["sheets"], "email": ["email"], "dicom": ["thumbnail", "dicom"]}
PATTERN_LABELS = {"thumbnail": "Thumbnail", "page": "Render PDF page", "text": "PDF text", "frame": "Video frame", "waveform": "Audio waveform",
                  "audio": "Audio channel / mix-down", "transcription": "Transcription", "hls": "HLS streaming", "sheets": "Spreadsheet as JSON",
                  "email": "Email body", "dicom": "DICOM layer"}
POLICIES = ("persist", "cache", "recompute")
MAX_TTL = 365 * 86400
HLS_SEGMENT = 6.0


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "media-sets"
    for d in ("versions", "tx", "cache"):
        (DIR / d).mkdir(parents=True, exist_ok=True)
    media_jobs.configure(DIR / "cache")


def startup() -> None:
    threading.Thread(target=_retention_loop, daemon=True, name="media-set-retention").start()
    threading.Thread(target=resume_jobs, daemon=True, name="media-job-resume").start()  # jobs a restart interrupted


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None


def _write_json(path: Path, data: Any) -> None:
    import os

    tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    os.replace(tmp, path)


_cache: dict[str, Any] = {"mtime": None, "data": None}


def _reg() -> dict:
    """The registry (a fresh copy; cached while the file is unchanged)."""
    path = DIR / "registry.json"
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = None
    with _lock:
        if _cache["data"] is None or _cache["mtime"] != mtime:
            r = _read_json(path) or {}
            for k in ("sets", "versions", "virtual", "transactions", "index", "deleted"):
                r.setdefault(k, {})
            _cache.update(mtime=mtime, data=r)
        return json.loads(json.dumps(_cache["data"]))


def _save(r: dict) -> None:
    with _lock:
        _write_json(DIR / "registry.json", r)
        _cache.update(mtime=None, data=None)


def get(folder_id: Optional[str]) -> Optional[dict]:
    """A folder's media set settings, or None when the folder is not a media set."""
    if not folder_id:
        return None
    return _reg()["sets"].get(folder_id)


def is_media_set(folder_id: str) -> bool:
    return folder_id in _reg()["sets"]


def _kind(s: Optional[dict], path: str, ct: Optional[str] = None) -> Optional[str]:
    """What an item holds: its media set's schema, or (multimodal, or outside a media set) guessed from the path."""
    return s["schema"] if s and s.get("schema") not in (None, "multimodal") else item_schema(path, ct)


def _ext(name: str) -> str:
    return _canon(name.rsplit(".", 1)[-1]) if "." in name else ""


def item_schema(name: str, content_type: Optional[str] = None) -> Optional[str]:
    e = _ext(name)
    for k, s in SCHEMAS.items():
        if k == "multimodal":
            continue
        if e in s["formats"] or any(e in v for v in s["additional"].values()):
            return "document" if e in ("docx", "pptx", "txt") else k
    ct = content_type or ""
    for k in ("image", "audio", "video"):
        if ct.startswith(f"{k}/"):
            return k
    return None


# ------------------------------------------------------------------------------------------------
# media sets
# ------------------------------------------------------------------------------------------------


class VirtualIn(BaseModel):
    connection_id: str
    # a folder of the source ("/" = its root); paths of registered items are relative to it
    folder: str = "/"


class MediaSetIn(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    parent_id: Optional[str] = None
    # turn an existing Files folder into a media set instead of creating one
    folder_id: Optional[str] = None
    schema_type: str = Field("image", alias="schema")
    primary_format: Optional[str] = None
    additional_formats: list[str] = Field(default_factory=list)
    transaction_policy: Literal["transactionless", "transactional"] = "transactionless"
    virtual: Optional[VirtualIn] = None

    model_config = {"populate_by_name": True}


class RetentionIn(BaseModel):
    # permanently delete items this many days after upload (None: never)
    max_age_days: Optional[float] = Field(None, gt=0)
    # permanently delete overwritten / deleted versions this many days after they were overwritten
    overwritten_days: Optional[float] = Field(None, gt=0)


class SettingsIn(BaseModel):
    additional_formats: Optional[list[str]] = None
    retention: Optional[RetentionIn] = None


def _validate_formats(schema: str, primary: Optional[str], additional: list[str], virtual: bool) -> tuple[Optional[str], list[str]]:
    if schema not in SCHEMAS:
        raise HTTPException(400, f"schema must be one of {', '.join(SCHEMAS)}")
    s = SCHEMAS[schema]
    if schema == "multimodal":
        if additional:
            raise HTTPException(400, "a multimodal media set accepts every format: it has no additional input formats")
        return None, []
    primary = _canon(primary or s["formats"][0])
    if primary not in s["formats"]:
        raise HTTPException(400, f"the primary format of a {s['label'].lower()} media set is one of {', '.join(s['formats'])}")
    add = sorted({_canon(a) for a in additional})
    if add and virtual:
        raise HTTPException(400, "virtual media sets cannot have additional input formats")
    allowed = s["additional"].get(primary, [])
    bad = [a for a in add if a not in allowed]
    if bad:
        raise HTTPException(400, f"{', '.join(bad)} cannot be converted to {primary}" + (f" (allowed: {', '.join(allowed)})" if allowed else
                                                                                         f": {primary} media sets take no additional input formats"))
    return primary, add


def _summary(fid: str, s: dict) -> dict:
    item = db.drive_get(fid)
    files = list_files(fid)
    r = _reg()
    return {**s, "id": fid, "name": item["name"] if item else "?", "path": [p["name"] for p in db.drive_path(fid)[:-1]] if item else [],
            "items": len(files), "size": sum(int(f.get("size_bytes") or 0) for f in files),
            "versions": sum(len(v) for v in (r["versions"].get(fid) or {}).values()),
            "open_transaction": (r["transactions"].get(fid) or {}).get("id"), "missing": not item or bool(item.get("trashed_at"))}


@router.get("/schemas")
def schemas() -> dict:
    return {"schemas": [{"id": k, "label": v["label"], "formats": v["formats"], "additional": v["additional"]} for k, v in SCHEMAS.items()],
            "rates": RATES, "limits": {"max_path": MAX_PATH, "max_item_bytes": MAX_ITEM_BYTES, "max_transaction_items": MAX_TX_ITEMS}}


@router.get("")
def list_media_sets() -> list[dict]:
    out = []
    for fid, s in _reg()["sets"].items():
        try:
            drive._item(fid)
        except HTTPException:
            continue  # gone, or the caller cannot see it (markings)
        out.append(_summary(fid, s))
    return sorted(out, key=lambda x: x["name"].lower())


@router.post("")
def create_media_set(req: MediaSetIn) -> dict:
    primary, add = _validate_formats(req.schema_type, req.primary_format, req.additional_formats, bool(req.virtual))
    virtual = None
    if req.virtual:
        conn = _virtual_connection(req.virtual.connection_id)
        virtual = {"connection_id": req.virtual.connection_id, "connection_name": conn, "folder": "/" + req.virtual.folder.strip("/")}
    with _lock:
        if req.folder_id:
            folder = drive._item(req.folder_id, need="editor")
            if folder["kind"] != "folder":
                raise HTTPException(400, "only a folder can become a media set")
            fid = folder["id"]
            if is_media_set(fid):
                raise HTTPException(409, "this folder is already a media set")
        else:
            if not req.name or not req.name.strip():
                raise HTTPException(400, "a media set needs a name")
            parent = drive._folder_id(req.parent_id) if req.parent_id else _default_parent()
            drive._item(parent, need="editor")
            fid = drive._insert_container(parent, "folder", drive._free_name(parent, drive._clean_name(req.name.strip())))
        now = _now()
        r = _reg()
        r["sets"][fid] = {"schema": req.schema_type, "primary_format": primary, "additional_formats": add, "transaction_policy": req.transaction_policy,
                          "retention": {"max_age_days": None, "overwritten_days": None}, "virtual": virtual, "built_by": None,
                          "created_at": now, "updated_at": now}
        _save(r)
    if req.folder_id:
        bad = [f["name"] for f in list_files(fid) if not _accepts(r["sets"][fid], f["name"])]
        if bad:
            log.info("media set %s holds %d files outside its schema", fid, len(bad))
    return get_media_set(fid)


def _default_parent() -> str:
    root = next((c for c in db.drive_list(None) if c["kind"] == "project" and c.get("system")), None)
    if not root:
        raise HTTPException(400, "choose a folder (parent_id) for the media set")
    found = next((c for c in db.drive_list(root["id"]) if c["kind"] == "folder" and c["name"] == "Media sets" and not c.get("trashed_at")), None)
    return found["id"] if found else drive._insert_container(root["id"], "folder", "Media sets")


@router.get("/{fid}")
def get_media_set(fid: str) -> dict:
    s = _require(fid)
    return _summary(fid, s)


@router.put("/{fid}/settings")
def save_settings(fid: str, req: SettingsIn) -> dict:
    with _lock:
        r = _reg()
        s = _require(fid, "editor", r)
        if req.additional_formats is not None:
            _, s["additional_formats"] = _validate_formats(s["schema"], s.get("primary_format"), req.additional_formats, bool(s.get("virtual")))
        if req.retention is not None:
            s["retention"] = req.retention.model_dump()
        s["updated_at"] = _now()
        _save(r)
    if req.retention is not None:
        apply_retention(fid)
    return get_media_set(fid)


@router.delete("/{fid}")
def unregister(fid: str) -> dict:
    """Stop treating the folder as a media set (its files stay in Files; versions and virtual items are dropped)."""
    with _lock:
        r = _reg()
        _require(fid, "editor", r)
        for path, entries in (r["versions"].pop(fid, {}) or {}).items():
            for e in entries:
                (DIR / "versions" / e["item_id"]).unlink(missing_ok=True)
                r["index"].pop(e["item_id"], None)
        for v in (r["virtual"].pop(fid, {}) or {}).values():
            r["index"].pop(v["id"], None)
        r["sets"].pop(fid, None)
        r["transactions"].pop(fid, None)
        _save(r)
    return {"unregistered": fid}


def _require(fid: str, need: str = "viewer", r: Optional[dict] = None) -> dict:
    drive._item(fid, need=need)
    s = (r or _reg())["sets"].get(fid)
    if not s:
        raise HTTPException(404, "not a media set")
    return s


# ------------------------------------------------------------------------------------------------
# items
# ------------------------------------------------------------------------------------------------


def list_files(fid: str) -> list[dict]:
    """The media set's current items as Drive-like rows (id, name, size_bytes, content_type, created_at, updated_at),
    virtual items included (virtual=True). Used by Code Repositories for media set inputs."""
    files = [c for c in db.drive_list(fid) if c["kind"] == "file" and not c.get("trashed_at")]
    for v in (_reg()["virtual"].get(fid) or {}).values():
        files.append({"id": v["id"], "name": v["path"], "size_bytes": v.get("size") or 0, "content_type": mimetypes.guess_type(v["path"])[0],
                      "created_at": v["registered_at"], "updated_at": v["registered_at"], "virtual": True, "physical": v["physical"]})
    return sorted(files, key=lambda c: c["name"])


def versions_of(fid: str) -> list[dict]:
    """Overwritten and deleted versions (Drive-like rows with overwritten=True), newest first per path."""
    out = []
    for path, entries in (_reg()["versions"].get(fid) or {}).items():
        for e in entries:
            out.append({"id": e["item_id"], "name": path, "size_bytes": e.get("size") or 0, "content_type": e.get("content_type"),
                        "created_at": e.get("uploaded_at"), "updated_at": e.get("uploaded_at"), "overwritten": True, "state": e["state"]})
    return out


def copy_to(f: dict, dest: Path) -> None:
    """A media set item's content to a local file (Drive, version store or the virtual set's source)."""
    if f.get("overwritten"):
        shutil.copyfile(DIR / "versions" / f["id"], dest)
    elif f.get("virtual"):
        dest.write_bytes(_read_virtual(f["id"]))
    else:
        drive.copy_content(f, dest)


def _row(f: dict, s: dict) -> dict:
    return {"id": f["id"], "path": f["name"], "size": int(f.get("size_bytes") or 0), "content_type": f.get("content_type") or mimetypes.guess_type(f["name"])[0],
            "uploaded_at": _iso(f.get("created_at")), "schema": item_schema(f["name"], f.get("content_type")) if s["schema"] == "multimodal" else s["schema"],
            "virtual": bool(f.get("virtual")), **({"state": f["state"], "overwritten": True} if f.get("overwritten") else {})}


def _iso(v: Any) -> Optional[str]:
    return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v else None)


@router.get("/{fid}/items")
def items(fid: str, deduplicate_by_path: bool = True, q: str = "", limit: int = 500, offset: int = 0) -> dict:
    """The media set's items (the newest per path; deduplicate_by_path=false adds overwritten and deleted ones)."""
    s = _require(fid)
    rows = [_row(f, s) for f in list_files(fid)]
    if not deduplicate_by_path:
        rows += [_row(f, s) for f in versions_of(fid)]
    if q:
        rows = [r for r in rows if q.lower() in r["path"].lower()]
    rows.sort(key=lambda r: (r["path"].lower(), r.get("overwritten", False), -(datetime.fromisoformat(r["uploaded_at"]).timestamp() if r["uploaded_at"] else 0)))
    return {"total": len(rows), "items": rows[offset: offset + max(1, min(limit, 5000))]}


def _accepts(s: dict, name: str) -> bool:
    if s["schema"] == "multimodal":
        return True
    e = _ext(name)
    return e == s["primary_format"] or e in s.get("additional_formats", [])


def _too_large(limit: int) -> HTTPException:
    return HTTPException(413, "a media item can be at most 50 GB" if limit == 50 * 1024 ** 3 else f"a media item can be at most {limit:,} bytes")


def _check(s: dict, path: str, size: int) -> tuple[str, bool]:
    """Validate an item's path, size and format for a media set without reading it: (path, needs conversion)."""
    path = path.strip().replace("\\", "/").lstrip("/")
    if not path:
        raise HTTPException(400, "MediaSet:MediaItemPathInvalid: a media item needs a path")
    if len(path) > MAX_PATH:
        raise HTTPException(400, f"MediaSet:MediaItemPathInvalid: paths of media items cannot exceed {MAX_PATH} characters")
    if size > MAX_ITEM_BYTES:
        raise _too_large(MAX_ITEM_BYTES)
    e = _ext(path)
    if s["schema"] != "multimodal":
        primary = s["primary_format"]
        if e != primary:
            if e not in s.get("additional_formats", []):
                allowed = [primary, *s.get("additional_formats", [])]
                raise HTTPException(400, f"MediaSet:MediaItemFormatNotAllowed: {path} is .{e or '?'}; this {SCHEMAS[s['schema']]['label'].lower()} "
                                         f"media set accepts {', '.join('.' + a for a in allowed)}")
            return path, True
    return path, False


def _content_type(path: str, e: str) -> str:
    return mimetypes.guess_type(path)[0] or ("application/dicom" if e == "dcm" else "message/rfc822" if e == "eml" else "application/octet-stream")


def target_path(s: dict, path: str) -> str:
    """The path an item uploaded at `path` gets in the media set (an additional input format takes the primary
    format's extension). No validation."""
    path = path.strip().replace("\\", "/").lstrip("/")
    primary = s.get("primary_format")
    if s["schema"] == "multimodal" or not primary or _ext(path) == primary:
        return path
    return (path.rsplit(".", 1)[0] if "." in path else path) + "." + primary


_SNIFF_LABEL = {"png": "a PNG image", "jpg": "a JPEG image", "gif": "a GIF image", "bmp": "a BMP image", "tiff": "a TIFF image", "webp": "a WebP image",
                "jp2": "a JPEG 2000 image", "nitf": "a NITF image", "pdf": "a PDF document", "zip": "an Office (zip) document", "ole": "a legacy Office document",
                "wav": "WAV audio", "flac": "FLAC audio", "mp3": "MP3 audio", "ogg": "Ogg audio", "mp4": "an MP4 / QuickTime file", "mkv": "a Matroska / WebM file",
                "ts": "an MPEG transport stream", "dcm": "a DICOM file", "sph": "a SPHERE audio file", "text": "plain text"}
# extension → what its content must be; the second group is only refused when the content is clearly something else
_SNIFF_EXPECT = {"png": "png", "jpg": "jpg", "gif": "gif", "bmp": "bmp", "tiff": "tiff", "webp": "webp", "jp2": "jp2", "pdf": "pdf", "docx": "zip", "pptx": "zip",
                 "xlsx": "zip", "wav": "wav", "flac": "flac", "ogg": "ogg", "opus": "ogg", "mp4": "mp4", "mov": "mp4", "m4a": "mp4", "mkv": "mkv", "webm": "mkv"}
_SNIFF_LENIENT = {"mp3": "mp3", "ts": "ts", "dcm": "dcm", "sph": "sph", "nitf": "nitf", "txt": "text", "eml": "text"}


def sniff(head: bytes) -> Optional[str]:
    """The format a file's first bytes (4 KB are enough) show, or None when they show nothing known."""
    h = head
    if h.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if h.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if h.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if h.startswith((b"II*\x00", b"MM\x00*")):
        return "tiff"
    if h.startswith(b"RIFF") and len(h) >= 12:
        return {b"WEBP": "webp", b"WAVE": "wav"}.get(h[8:12])
    if h.startswith((b"\x00\x00\x00\x0cjP  \r\n\x87\n", b"\xff\x4f\xff\x51")):
        return "jp2"
    if h.startswith((b"NITF", b"NSIF")):
        return "nitf"
    if b"%PDF-" in h[:1024]:
        return "pdf"
    if h.startswith((b"PK\x03\x04", b"PK\x05\x06")):
        return "zip"
    if h.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole"
    if h.startswith(b"fLaC"):
        return "flac"
    if h.startswith(b"OggS"):
        return "ogg"
    if h[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"):
        return "mp4"
    if h.startswith(b"\x1a\x45\xdf\xa3"):
        return "mkv"
    if h[128:132] == b"DICM":
        return "dcm"
    if h.startswith(b"NIST_1A"):
        return "sph"
    if h.startswith(b"ID3") or (len(h) > 1 and h[0] == 0xFF and h[1] & 0xE0 == 0xE0):
        return "mp3"
    if len(h) > 188 and h[0] == 0x47 and h[188] == 0x47:
        return "ts"
    if h.startswith(b"BM") and len(h) >= 14 and int.from_bytes(h[6:10], "little") == 0:
        return "bmp"
    if h and b"\x00" not in h:
        try:
            h.decode("utf-8", errors="strict" if len(h) < 4096 else "ignore")
            return "text"
        except UnicodeDecodeError:
            return None
    return None


def content_mismatch(s: dict, path: str, head: bytes) -> Optional[str]:
    """Why a file's content does not fit its name (a text file named .png, a GIF named .jpg), or None when it does.
    Multimodal media sets take any file, and extensions without a known signature are not checked."""
    if s["schema"] == "multimodal":
        return None
    e = _ext(path)
    want = _SNIFF_EXPECT.get(e) or _SNIFF_LENIENT.get(e)
    if not want:
        return None
    got = sniff(head)
    if got == want or (got is None and e in _SNIFF_LENIENT):
        return None
    what = "an empty file" if not head else _SNIFF_LABEL[got] if got else "not recognised"
    return f"{path} is named .{e} but its content is {what}, not {_SNIFF_LABEL[want]}"


def check_file(s: dict, path: str, file: Path) -> tuple[str, bool]:
    """_check plus the content check, for a local file: the media type is read from the file's first bytes, not
    only from its extension. Raises 400 MediaSet:MediaItemFormatNotAllowed / MediaItemPathInvalid, or 413."""
    p, conv = _check(s, path, file.stat().st_size)
    with open(file, "rb") as f:
        _check_content(s, p, f.read(4096))
    return p, conv


def _check_content(s: dict, path: str, head: bytes) -> None:
    """The content check every way into a media set shares (sync, upload, transaction staging, build writes): the
    file's first bytes must be what its extension says. Extensions without a known signature are not checked."""
    why = content_mismatch(s, path, head)
    if why:
        raise HTTPException(400, f"MediaSet:MediaItemFormatNotAllowed: {why}")


def _prepare(s: dict, path: str, data: bytes) -> tuple[str, bytes, str]:
    """Validate an item for a media set and convert an additional input format: (path, bytes, content type)."""
    path, conv = _check(s, path, len(data))
    _check_content(s, path, data[:4096])
    e = _ext(path)
    if conv:
        primary = s["primary_format"]
        data = convert(data, e, primary)
        path = (path.rsplit(".", 1)[0] if "." in path else path) + "." + ("jpg" if primary == "jpg" else primary)
    return path, data, _content_type(path, e)


CHUNK = 1024 * 1024


def spool(stream: Any, limit: Optional[int] = None) -> tuple[Path, int, str]:
    """Copy a readable stream to a temporary file of this module in 1 MB chunks, hashing it as it goes:
    (file, size, sha256 hex). More than `limit` bytes (default: the item limit, 50 GB) raise 413 and keep nothing.
    The caller hands the file to put_item_file / stage_file or deletes it."""
    limit = MAX_ITEM_BYTES if limit is None else limit
    (DIR / "incoming").mkdir(parents=True, exist_ok=True)
    tmp = DIR / "incoming" / uuid.uuid4().hex
    h = hashlib.sha256()
    n = 0
    try:
        with open(tmp, "wb") as out:
            while block := stream.read(CHUNK):
                n += len(block)
                if n > limit:
                    raise _too_large(limit)
                h.update(block)
                out.write(block)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return tmp, n, h.hexdigest()


def _touch(fid: str, replaced: bool = False) -> None:
    """Count a change to the media set (incremental builds notice a transactional output changed outside them);
    `replaced`: its contents were replaced (incremental readers run a snapshot)."""
    with _lock:
        r = _reg()
        s = r["sets"].get(fid)
        if s:
            s["change"] = int(s.get("change") or 0) + 1
            if replaced:
                s["replaced_at"] = _now()
            _save(r)


def change_of(fid: str) -> int:
    return int((get(fid) or {}).get("change") or 0)


def put_item(fid: str, path: str, data: bytes, item_id: Optional[str] = None, prepared: bool = False) -> dict:
    """Add an item; an item already at the path becomes an overwritten version."""
    s = get(fid)
    if not s:
        raise HTTPException(404, "not a media set")
    if s.get("virtual"):
        raise HTTPException(400, "a virtual media set reads its items from its source: register them (virtual sync or register_media_item)")
    ct = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if not prepared:
        path, data, ct = _prepare(s, path, data)
    return _store_item(fid, path, io.BytesIO(data), len(data), ct, item_id)


def _store_item(fid: str, path: str, fileobj: Any, size: int, ct: str, item_id: Optional[str]) -> dict:
    name = drive._clean_name(path.replace("/", "_"))
    with _lock:
        existing = next((c for c in db.drive_list(fid) if c["kind"] == "file" and c["name"] == name and not c.get("trashed_at")), None)
        if existing:
            _archive(fid, existing, "overwritten")
        item = drive._store(fid, name, fileobj, size, ct, item_id=item_id)
        _touch(fid)
        return item


def put_item_file(fid: str, path: str, file: Path, item_id: Optional[str] = None, prepared: bool = False, content_type: Optional[str] = None) -> dict:
    """put_item from a local file, streamed into the store in chunks (the same checks: path, size, formats). Only a
    file in an additional input format, which is converted, is read into memory."""
    s = get(fid)
    if not s:
        raise HTTPException(404, "not a media set")
    if s.get("virtual"):
        raise HTTPException(400, "a virtual media set reads its items from its source: register them (virtual sync or register_media_item)")
    size = file.stat().st_size
    if prepared:
        ct = content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
    else:
        path, conv = check_file(s, path, file)
        if conv:
            return put_item(fid, path, file.read_bytes(), item_id=item_id)
        ct = _content_type(path, _ext(path))
    with open(file, "rb") as f:
        return _store_item(fid, path, f, size, ct, item_id)


def delete_path(fid: str, path: str) -> Optional[str]:
    """Soft-delete the current item at a path (its bytes move to the version store as a "deleted" version, like an
    overwrite). Returns the item id, or None when nothing is at the path."""
    name = drive._clean_name(path.strip().replace("\\", "/").lstrip("/").replace("/", "_"))
    with _lock:
        existing = next((c for c in db.drive_list(fid) if c["kind"] == "file" and c["name"] == name and not c.get("trashed_at")), None)
        if not existing:
            return None
        _archive(fid, existing, "deleted")
        return existing["id"]


def _archive(fid: str, item: dict, state: str) -> None:
    """Move an item's bytes to the version store (its id keeps resolving) and drop it from the folder."""
    dest = DIR / "versions" / item["id"]
    drive.copy_content(item, dest)
    r = _reg()
    r["versions"].setdefault(fid, {}).setdefault(item["name"], []).insert(0, {
        "item_id": item["id"], "size": int(item.get("size_bytes") or 0), "content_type": item.get("content_type"),
        "uploaded_at": _iso(item.get("created_at")), "state": state, "at": _now()})
    r["index"][item["id"]] = {"fid": fid, "path": item["name"], "kind": "version"}
    if fid in r["sets"]:
        r["sets"][fid]["change"] = int(r["sets"][fid].get("change") or 0) + 1
    _save(r)
    files = db.drive_delete(item["id"], drive._now())
    drive._delete_contents(files)
    media_jobs.drop(item["id"])  # replaced or deleted: its shared source copy goes (the version store keeps its bytes)


@router.post("/{fid}/items")
async def upload(fid: str, file: UploadFile = File(...), path: Optional[str] = Form(None), transaction_id: Optional[str] = Form(None)) -> dict:
    """Upload a media item (the file name is its path unless `path` is given). Transactional media sets need an
    open transaction (`transaction_id`)."""
    s = _require(fid, "editor")
    data = await file.read()
    p = path or file.filename or "item"
    if s["transaction_policy"] == "transactional":
        if not transaction_id:
            raise HTTPException(400, "this media set is transactional: open a transaction, upload into it and commit it")
        return stage(fid, transaction_id, p, data)
    if transaction_id:
        raise HTTPException(400, "transactionless media sets have no transactions")
    item = put_item(fid, p, data)
    return _row(item, s)


@router.delete("/{fid}/items/{item_id}")
def delete_item(fid: str, item_id: str) -> dict:
    """Soft delete: the item leaves the media set but stays readable through its media reference."""
    s = _require(fid, "editor")
    if s.get("built_by"):
        raise HTTPException(400, f"media items cannot be deleted from a media set that a build pipeline updates ({s['built_by']})")
    with _lock:
        r = _reg()
        if item_id in (r["virtual"].get(fid) or {}) or any(v["id"] == item_id for v in (r["virtual"].get(fid) or {}).values()):
            path = next(p for p, v in r["virtual"][fid].items() if v["id"] == item_id)
            v = r["virtual"][fid].pop(path)
            r["deleted"].setdefault(fid, {})[item_id] = {**v, "deleted_at": _now()}
            _save(r)
            media_jobs.drop(item_id)
            return {"deleted": item_id, "soft": True}
        item = db.drive_get(item_id)
        if not item or item.get("parent_id") != fid:
            raise HTTPException(404, "no such item in this media set")
        _archive(fid, item, "deleted")
    return {"deleted": item_id, "soft": True}


@router.get("/{fid}/history")
def history(fid: str, path: str) -> list[dict]:
    """The version history of a path: every item uploaded to it, newest first."""
    s = _require(fid)
    name = drive._clean_name(path)
    cur = [_row(f, s) | {"state": "current"} for f in list_files(fid) if f["name"] == name]
    old = [_row(f, s) for f in versions_of(fid) if f["name"] == name]
    return cur + sorted(old, key=lambda x: x["uploaded_at"] or "", reverse=True)


# ------------------------------------------------------------------------------------------------
# transactions
# ------------------------------------------------------------------------------------------------


@router.post("/{fid}/transactions")
def open_transaction(fid: str) -> dict:
    with _lock:
        r = _reg()
        s = _require(fid, "editor", r)
        if s["transaction_policy"] != "transactional":
            raise HTTPException(400, "transactionless media sets have no transactions: upload directly")
        if r["transactions"].get(fid):
            raise HTTPException(409, f"transaction {r['transactions'][fid]['id']} is already open on this media set: commit or abort it first")
        tx = {"id": "tx-" + uuid.uuid4().hex[:12], "opened_at": _now(), "items": []}
        r["transactions"][fid] = tx
        _save(r)
    (DIR / "tx" / tx["id"]).mkdir(parents=True, exist_ok=True)
    return tx


def stage(fid: str, tx_id: str, path: str, data: bytes) -> dict:
    s = get(fid)
    with _lock:
        r = _reg()
        tx = r["transactions"].get(fid)
        if not tx or tx["id"] != tx_id:
            raise HTTPException(409, "no such open transaction on this media set")
        if len(tx["items"]) >= MAX_TX_ITEMS:
            raise HTTPException(400, f"a transaction holds at most {MAX_TX_ITEMS:,} items: commit this one and open another")
        p, data, ct = _prepare(s, path, data)
        f = DIR / "tx" / tx_id / uuid.uuid4().hex  # unique: a re-staged path never reuses another entry's file
        f.write_bytes(data)
        tx["items"] = [i for i in tx["items"] if i["path"] != p] + [{"path": p, "file": f.name, "size": len(data), "content_type": ct}]
        _save(r)
    return {"transaction_id": tx_id, "path": p, "size": len(data), "staged": len(tx["items"])}


def _open_tx(r: dict, fid: str, tx_id: str) -> dict:
    tx = r["transactions"].get(fid)
    if not tx or tx["id"] != tx_id:
        raise HTTPException(409, "no such open transaction on this media set")
    if len(tx["items"]) >= MAX_TX_ITEMS:
        raise HTTPException(400, f"a transaction holds at most {MAX_TX_ITEMS:,} items: commit this one and open another")
    return tx


def stage_file(fid: str, tx_id: str, path: str, file: Path) -> dict:
    """stage() from a local file without reading it: the file is moved into the transaction (a file in an additional
    input format is converted in memory, as stage() does)."""
    s = get(fid)
    with _lock:
        r = _reg()
        tx = _open_tx(r, fid, tx_id)
        size = file.stat().st_size
        p, conv = check_file(s, path, file)
        if conv:
            return stage(fid, tx_id, path, file.read_bytes())
        f = DIR / "tx" / tx_id / uuid.uuid4().hex
        f.parent.mkdir(parents=True, exist_ok=True)
        try:
            file.replace(f)
        except OSError:
            shutil.copyfile(file, f)
        tx["items"] = [i for i in tx["items"] if i["path"] != p] + [{"path": p, "file": f.name, "size": size, "content_type": _content_type(p, _ext(p))}]
        _save(r)
    return {"transaction_id": tx_id, "path": p, "size": size, "staged": len(tx["items"])}


def stage_delete(fid: str, tx_id: str, path: str) -> dict:
    """Stage the deletion of the item at a path: on commit it becomes a "deleted" version (nothing changes before)."""
    with _lock:
        r = _reg()
        tx = _open_tx(r, fid, tx_id)
        p = path.strip().replace("\\", "/").lstrip("/")
        tx["items"] = [i for i in tx["items"] if i["path"] != p] + [{"path": p, "file": None, "size": 0, "content_type": None, "delete": True}]
        _save(r)
    return {"transaction_id": tx_id, "path": p, "delete": True, "staged": len(tx["items"])}


@router.post("/{fid}/transactions/{tx_id}/commit")
def commit_transaction(fid: str, tx_id: str) -> dict:
    """Every item staged in the transaction becomes readable at once."""
    _require(fid, "editor")
    with _lock:
        r = _reg()
        tx = r["transactions"].get(fid)
        if not tx or tx["id"] != tx_id:
            raise HTTPException(409, "no such open transaction on this media set")
        written = []
        deleted = []
        for i in tx["items"]:
            if i.get("delete"):
                if delete_path(fid, i["path"]):
                    deleted.append(i["path"])
                continue
            item = put_item_file(fid, i["path"], DIR / "tx" / tx_id / i["file"], prepared=True, content_type=i.get("content_type"))
            written.append(item["id"])
        r = _reg()
        r["transactions"].pop(fid, None)
        _save(r)
    shutil.rmtree(DIR / "tx" / tx_id, ignore_errors=True)
    return {"committed": tx_id, "items": len(written), "deleted": len(deleted)}


@router.post("/{fid}/transactions/{tx_id}/abort")
def abort_transaction(fid: str, tx_id: str) -> dict:
    """Every item staged in the transaction is deleted."""
    _require(fid, "editor")
    with _lock:
        r = _reg()
        tx = r["transactions"].get(fid)
        if not tx or tx["id"] != tx_id:
            raise HTTPException(409, "no such open transaction on this media set")
        r["transactions"].pop(fid, None)
        _save(r)
    shutil.rmtree(DIR / "tx" / tx_id, ignore_errors=True)
    return {"aborted": tx_id, "items": len(tx["items"])}


def write_build(fid: str, entries: list[tuple], mode: str, built_by: str) -> int:
    """Items a build wrote (Code Repositories' MediaSetOutput): transactional media sets take them as one
    transaction (replace removes the other items); transactionless ones only add or overwrite. Returns the count."""
    s = get(fid)
    if not s:
        raise HTTPException(404, "not a media set")
    if mode == "replace" and s["transaction_policy"] != "transactional":
        raise ValueError("transactionless media sets only support the 'modify' write mode")
    if s["transaction_policy"] == "transactional" and len(entries) > MAX_TX_ITEMS:
        raise ValueError(f"a transaction on a transactional media set holds at most {MAX_TX_ITEMS:,} items ({len(entries):,} written)")
    prepared = [(*_prepare(s, path, data), item_id) for path, data, item_id in entries]  # validate all before writing any
    names = set()
    for path, data, _ct, item_id in prepared:
        names.add(drive._clean_name(path.replace("/", "_")))
        put_item(fid, path, data, item_id=item_id, prepared=True)
    if mode == "replace":
        with _lock:
            for c in db.drive_list(fid):
                if c["kind"] == "file" and not c.get("trashed_at") and c["name"] not in names:
                    _archive(fid, c, "deleted")
        _touch(fid, replaced=True)
    note_built(fid, built_by)
    return len(prepared)


def note_built(fid: str, built_by: str, schema: Optional[str] = None, policy: str = "transactional") -> None:
    """A build writes this folder: register it as a media set (multimodal) if it is not one yet, and mark it as
    updated by a build pipeline (no manual deletes)."""
    with _lock:
        r = _reg()
        s = r["sets"].get(fid)
        if not s:
            now = _now()
            s = r["sets"][fid] = {"schema": schema or "multimodal", "primary_format": None, "additional_formats": [], "transaction_policy": policy,
                                  "retention": {"max_age_days": None, "overwritten_days": None}, "virtual": None, "created_at": now, "updated_at": now}
        s["built_by"] = built_by
        _save(r)


# ------------------------------------------------------------------------------------------------
# virtual media sets
# ------------------------------------------------------------------------------------------------


def _virtual_connection(conn_id: str) -> str:
    import datasources as ds
    import file_transfers

    row = ds._connection_row(conn_id)
    if row["kind"] != "s3":
        raise HTTPException(400, "virtual media sets read from Amazon S3 connections (access key and secret)")
    with file_transfers._file_connector(conn_id):
        pass
    return row["name"]


class VirtualSyncIn(BaseModel):
    extensions: list[str] = Field(default_factory=list)
    limit: int = Field(10_000, ge=1, le=100_000)


@router.post("/{fid}/virtual-sync")
def virtual_sync(fid: str, req: VirtualSyncIn) -> dict:
    """Register the source folder's files as media items without copying them (new paths only)."""
    import file_transfers

    s = _require(fid, "editor")
    v = s.get("virtual")
    if not v:
        raise HTTPException(400, "not a virtual media set")
    exts = {_canon(e) for e in req.extensions} or None
    registered, skipped = 0, 0
    with file_transfers._file_connector(v["connection_id"]) as c:
        entries = c.fs.walk(v["folder"].strip("/"), req.limit)
    for e in entries:
        if e.folder:
            continue
        rel = e.path[len(v["folder"].strip("/")):].lstrip("/") if v["folder"].strip("/") else e.path
        if (exts and _ext(rel) not in exts) or not _accepts(s, rel):
            skipped += 1
            continue
        if register_virtual(fid, e.path, rel, e.size, sync=True):
            registered += 1
    return {"registered": registered, "skipped": skipped, "items": len(list_files(fid))}


def register_virtual(fid: str, physical: str, path: str, size: Optional[int] = None, sync: bool = False) -> bool:
    """Register one source file as a media item (register_media_item); False when the path already exists."""
    s = get(fid)
    if not s or not s.get("virtual"):
        raise ValueError("register_media_item works on virtual media sets only")
    if len(path) > MAX_PATH:
        raise ValueError(f"MediaSet:MediaItemPathInvalid: paths of media items cannot exceed {MAX_PATH} characters")
    if not _accepts(s, path):
        raise ValueError(f"{path} is not a {s['primary_format']} file")
    with _lock:
        r = _reg()
        vs = r["virtual"].setdefault(fid, {})
        if path in vs:
            return False
        iid = uuid.uuid4().hex[:16]
        vs[path] = {"id": iid, "path": path, "physical": physical, "size": size, "registered_at": _now()}
        r["index"][iid] = {"fid": fid, "path": path, "kind": "virtual"}
        _save(r)
    return True


def _read_virtual(item_id: str) -> bytes:
    import file_transfers

    r = _reg()
    ix = r["index"].get(item_id)
    v = next((x for x in (r["virtual"].get(ix["fid"]) or {}).values() if x["id"] == item_id), None) if ix else None
    if not v:
        v = (r["deleted"].get(ix["fid"]) or {}).get(item_id) if ix else None
    if not v:
        raise HTTPException(404, "media item not found")
    conn = r["sets"][ix["fid"]]["virtual"]["connection_id"]
    try:
        with file_transfers._file_connector(conn) as c, c.fs.open(v["physical"]) as f:
            return f.read()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - deleted from the source: the item can no longer be read
        raise HTTPException(404, f"the source no longer has {v['physical']}: {e}") from None


# ------------------------------------------------------------------------------------------------
# reading: content, metadata, access patterns, usage
# ------------------------------------------------------------------------------------------------


def resolve(item_id: str) -> tuple[bytes, str, str, Optional[str]]:
    """(bytes, path, content type, media set id) of a media item by id: current, overwritten / deleted or virtual."""
    if not re.fullmatch(r"[0-9a-f]{16}", item_id):
        raise HTTPException(404, "media item not found")
    item = db.drive_get(item_id)
    if item and item["kind"] == "file" and not item.get("trashed_at"):
        data = drive.read_bytes(item)
        return data, item["name"], item.get("content_type") or mimetypes.guess_type(item["name"])[0] or "application/octet-stream", item.get("parent_id")
    ix = _reg()["index"].get(item_id)
    if not ix:
        raise HTTPException(404, "media item not found")
    drive._item(ix["fid"])  # markings on the media set apply to its old versions too
    if ix["kind"] == "version":
        p = DIR / "versions" / item_id
        if not p.exists():
            raise HTTPException(404, "this version was permanently deleted by the retention policy")
        return p.read_bytes(), ix["path"], mimetypes.guess_type(ix["path"])[0] or "application/octet-stream", ix["fid"]
    return _read_virtual(item_id), ix["path"], mimetypes.guess_type(ix["path"])[0] or "application/octet-stream", ix["fid"]


def _item_meta(item_id: str, check: bool = True) -> tuple[str, str, Optional[str]]:
    """(path, content type, media set id) of an item the caller may read, without reading its bytes (a stored
    access pattern output, an HLS rendition or a playback's output is served without reading the source).
    check=False only for resuming a job a restart interrupted (resume_jobs): its request was checked when it began."""
    if not re.fullmatch(r"[0-9a-f]{16}", item_id):
        raise HTTPException(404, "media item not found")
    item = db.drive_get(item_id)
    if item and item["kind"] == "file" and not item.get("trashed_at"):
        if check:
            drive._item(item_id)
        return item["name"], item.get("content_type") or mimetypes.guess_type(item["name"])[0] or "application/octet-stream", item.get("parent_id")
    ix = _reg()["index"].get(item_id)
    if not ix:
        raise HTTPException(404, "media item not found")
    if check:
        drive._item(ix["fid"])
    if ix["kind"] == "version" and not (DIR / "versions" / item_id).exists():
        raise HTTPException(404, "this version was permanently deleted by the retention policy")
    return ix["path"], mimetypes.guess_type(ix["path"])[0] or "application/octet-stream", ix["fid"]


def record_usage(fid: Optional[str], transformation: str, nbytes: int) -> None:
    rate = RATES.get(transformation)
    if rate is None:
        return
    gb = nbytes / 1024 ** 3
    entry = {"at": _now(), "media_set": fid, "transformation": transformation, "gb": round(gb, 9), "compute_seconds": round(rate * gb, 6)}
    try:
        with open(DIR / "usage.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def usage_entries(since: Optional[datetime] = None) -> list[dict]:
    out = []
    try:
        with open(DIR / "usage.jsonl", encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if since and e["at"] < since.isoformat():
                    continue
                out.append(e)
    except OSError:
        pass
    return out


@router.get("/usage/summary")
def usage(days: int = 30) -> dict:
    """Media compute-seconds by media set and by transformation over the last `days` days."""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))
    entries = usage_entries(since)
    names = {fid: (db.drive_get(fid) or {}).get("name", fid) for fid in {e["media_set"] for e in entries if e["media_set"]}}
    by_set: dict[str, dict] = {}
    by_tr: dict[str, float] = {}
    for e in entries:
        k = e["media_set"] or "_"
        b = by_set.setdefault(k, {"id": e["media_set"], "name": names.get(e["media_set"], "Media items"), "compute_seconds": 0.0, "gb": 0.0, "requests": 0})
        b["compute_seconds"] += e["compute_seconds"]
        b["gb"] += e["gb"]
        b["requests"] += 1
        by_tr[e["transformation"]] = by_tr.get(e["transformation"], 0.0) + e["compute_seconds"]
    return {"total_compute_seconds": round(sum(e["compute_seconds"] for e in entries), 4), "media_sets": sorted(by_set.values(), key=lambda x: -x["compute_seconds"]),
            "transformations": [{"id": k, "compute_seconds": round(v, 4), "rate": RATES[k]} for k, v in sorted(by_tr.items(), key=lambda kv: -kv[1])],
            "rates": RATES}


@router.get("/items/{item_id}/content", response_model=None)
def content(item_id: str, request: Request = None, disposition: Literal["attachment", "inline"] = "inline") -> Response:
    """A media item's bytes (also overwritten, deleted and virtual items: media references keep rendering). Byte
    ranges are served, so audio and video players can seek; a download is metered once (not per range). While a
    job holds the item's shared source copy (or keeps it after), ranges are cut from that copy instead of reading the
    whole item from storage for each of them."""
    src = media_jobs.peek(item_id)
    if src is not None:
        path, ct, fid = _item_meta(item_id)  # the caller's read access, as resolve() checks it
        n, read = src.size, _read_file(src.path)
    else:
        data, path, ct, fid = resolve(item_id)
        n, read = len(data), (lambda a, b: data[a:b])
    rng = (request.headers.get("range") if request else None) or ""
    if not rng or re.match(r"bytes=0-", rng.strip()):
        record_usage(fid, "download", n)
    headers = {"Content-Disposition": f'{disposition}; filename="{path.rsplit("/", 1)[-1]}"', "Cache-Control": "private, max-age=3600", "Access-Control-Expose-Headers": "Content-Disposition"}
    try:
        return _ranged_read(request, n, read, ct, headers)
    except OSError:  # the copy was swept meanwhile: read the item itself
        data, path, ct, fid = resolve(item_id)
        return _ranged(request, data, ct, headers)


@router.get("/items/{item_id}/metadata")
def metadata(item_id: str, wait: Optional[float] = None) -> dict:
    """Item metadata. Audio and video are probed from the shared source copy, fetched off the request thread: the
    request waits up to `wait` seconds (default ACCESS_WAIT) for it, then answers without the stream fields and with
    "probe": "pending" (ask again; the fetch goes on)."""
    path, ct, fid = _item_meta(item_id)
    s = get(fid) or {"schema": "multimodal"}
    kind = item_schema(path, ct) if s["schema"] == "multimodal" else s["schema"]
    if kind in ("audio", "video"):
        meta = {"id": item_id, "path": path, "media_type": ct, "size": _item_size(item_id), "schema": kind, "media_set": fid}
        ix = _reg()["index"].get(item_id)
        if ix:
            meta["state"] = "virtual" if ix["kind"] == "virtual" else "overwritten or deleted"
        info = _probe_item(item_id, path, ACCESS_WAIT if wait is None else max(0.0, min(float(wait), 60.0)))
        if info is None:
            meta["probe"] = "pending"
        elif "error" in info:
            meta["metadata_error"] = info["error"]
        else:
            meta.update({k: v for k, v in info.items() if v is not None and k not in ("has_audio", "has_video")} | ({"has_audio": False} if not info.get("has_audio") else {}))
        return meta
    data, path, ct, fid = resolve(item_id)
    meta: dict[str, Any] = {"id": item_id, "path": path, "media_type": ct, "size": len(data), "schema": kind, "media_set": fid}
    ix = _reg()["index"].get(item_id)
    if ix:
        meta["state"] = "virtual" if ix["kind"] == "virtual" else "overwritten or deleted"
    try:
        meta.update(_type_metadata(kind, path, data))
    except Exception as e:  # noqa: BLE001 - metadata is best effort
        meta["metadata_error"] = str(e)[:200]
    return meta


def _type_metadata(kind: Optional[str], path: str, data: bytes) -> dict:
    if kind == "image":
        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            return {"width": im.width, "height": im.height, "format": im.format, "mode": im.mode}
    if kind == "document" and _ext(path) == "pdf":
        import pypdf

        r = pypdf.PdfReader(io.BytesIO(data))
        info = r.metadata or {}
        return {"pages": len(r.pages), "title": info.get("/Title"), "author": info.get("/Author"),
                "page_dimensions": [{"width": float(p.mediabox.width), "height": float(p.mediabox.height)} for p in r.pages[:50]]}
    if kind in ("audio", "video"):
        with _tmp(data, _ext(path)) as f:
            info = _audio_info(str(f))
        return {k: v for k, v in info.items() if v is not None and k not in ("has_audio", "has_video")} | ({"has_audio": False} if not info.get("has_audio") else {})
    if kind == "dicom":
        import pydicom

        ds = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True, force=True)
        keys = ("PatientID", "PatientName", "StudyInstanceUID", "StudyID", "SeriesInstanceUID", "Modality", "StudyDate", "Rows", "Columns", "NumberOfFrames",
                "BodyPartExamined", "Manufacturer")
        return {k: str(getattr(ds, k)) for k in keys if getattr(ds, k, None) not in (None, "")}
    if kind == "email":
        import email
        import email.policy

        m = email.message_from_bytes(data, policy=email.policy.default)
        return {"from": m.get("From"), "to": m.get("To"), "subject": m.get("Subject"), "date": m.get("Date"),
                "attachments": [a.get_filename() for a in m.iter_attachments()]}
    if kind == "spreadsheet":
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
        p = wb.properties
        return {"sheets": wb.sheetnames, "author": p.creator, "title": p.title}
    return {}


class _tmp:
    def __init__(self, data: bytes, ext: str) -> None:
        self.data, self.ext = data, ext

    def __enter__(self) -> Path:
        import tempfile

        self.d = tempfile.mkdtemp(prefix="media-")
        p = Path(self.d) / f"item.{self.ext or 'bin'}"
        p.write_bytes(self.data)
        return p

    def __exit__(self, *_: object) -> None:
        shutil.rmtree(self.d, ignore_errors=True)


# -- access pattern registry and persistence policies --


class PersistenceIn(BaseModel):
    # persist: computed once, kept; cache: kept for ttl_seconds, then recomputed; recompute: computed at every request
    policy: Literal["persist", "cache", "recompute"] = "persist"
    ttl_seconds: Optional[int] = Field(None, ge=1, le=MAX_TTL)


class PatternParams(BaseModel):
    page: Optional[int] = Field(None, ge=0)
    layer: Optional[int] = Field(None, ge=0)
    width: Optional[int] = Field(None, ge=32, le=2000)
    # audio / video: "mix" (mix down to mono), "all" (keep every channel; audio pattern only) or a 0-based channel index
    channel: Optional[str] = None
    # audio pattern output: wav / mp3 / flac
    format: Optional[str] = None
    # transcription: language code, text / segments, more_economical / more_performant
    language: Optional[str] = None
    output_format: Optional[Literal["text", "segments"]] = None
    mode: Optional[Literal["more_economical", "more_performant"]] = None


class AccessPatternIn(BaseModel):
    name: str = Field(..., pattern=r"^[a-z][a-z0-9_]{0,63}$")
    # the built-in transformation it runs
    pattern: str
    params: PatternParams = Field(default_factory=PatternParams)
    persistence: PersistenceIn = Field(default_factory=PersistenceIn)


class AccessPatternUpdate(BaseModel):
    params: Optional[PatternParams] = None
    persistence: Optional[PersistenceIn] = None


def _norm_persistence(p: PersistenceIn) -> dict:
    if p.policy == "cache" and not p.ttl_seconds:
        raise HTTPException(400, "a cached access pattern needs ttl_seconds (how long an output is kept)")
    return {"policy": p.policy, "ttl_seconds": p.ttl_seconds if p.policy == "cache" else None}


def _builtin_patterns(s: dict) -> list[str]:
    return list(PATTERN_COST) if s["schema"] == "multimodal" else SCHEMA_PATTERNS.get(s["schema"], [])


def _policy(s: Optional[dict], name: str) -> dict:
    """The persistence policy of a built-in pattern or a registered one (default: persist)."""
    if not s:
        return {"policy": "persist", "ttl_seconds": None}
    reg = (s.get("access_patterns") or {}).get(name)
    if reg:
        return reg["persistence"]
    return (s.get("pattern_policies") or {}).get(name) or {"policy": "persist", "ttl_seconds": None}


def _patterns_view(fid: str, s: dict) -> dict:
    return {"builtin": [{"pattern": p, "label": PATTERN_LABELS.get(p, p), "persistence": _policy(s, p), "rate": PATTERN_COST.get(p)} for p in _builtin_patterns(s)],
            "registered": sorted((s.get("access_patterns") or {}).values(), key=lambda x: x["name"]),
            "available": list(PATTERN_COST)}


def _purge(fid: str, prefix: str) -> int:
    """Drop the stored outputs whose key starts with `prefix` for every item of the media set (old versions too)."""
    ids = {f["id"] for f in list_files(fid)} | {k for k, ix in _reg()["index"].items() if ix.get("fid") == fid}
    with _renders_lock:  # renders of those outputs still going would publish them after the change: stop them first
        stale = [j for j in _renders.values() if j.out.parent.name in ids and j.out.name.startswith(prefix)]
    for j in stale:
        if _render_cancel(j):
            j.done.wait(15)
    with _ajobs_lock:  # access pattern jobs of those outputs too (a cancelled job stores nothing)
        stale_a = [j for j in _ajobs.values() if j.label.split("/", 1)[0] in ids and j.label.split("/", 1)[1].startswith(prefix)]
    for j in stale_a:
        if j.cancel():
            j.done.wait(15)
    n = 0
    for i in ids:
        d = DIR / "cache" / i
        if d.is_dir():
            for p in d.iterdir():
                if p.name.startswith(prefix):
                    shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
                    n += 1
    return n


def _prefix(name: str, registered: bool) -> str:
    return f"@{name}-" if registered else f"{name}-"


@router.get("/{fid}/access-patterns")
def list_access_patterns(fid: str) -> dict:
    """The media set's built-in access patterns (with their persistence policies) and the registered ones."""
    return _patterns_view(fid, _require(fid))


@router.post("/{fid}/access-patterns")
def register_access_pattern(fid: str, req: AccessPatternIn) -> dict:
    """Register a transformation as a named access pattern of the media set, with its persistence policy."""
    with _lock:
        r = _reg()
        s = _require(fid, "editor", r)
        if req.pattern not in _builtin_patterns(s):
            raise HTTPException(400, f"a {s['schema']} media set's access patterns run one of: {', '.join(_builtin_patterns(s))}")
        if req.name in PATTERN_COST or req.name in (s.get("access_patterns") or {}):
            raise HTTPException(409, f"an access pattern named {req.name} already exists")
        params = req.params.model_dump(exclude_none=True)
        _check_params(req.pattern, params)
        entry = {"name": req.name, "pattern": req.pattern, "params": params, "persistence": _norm_persistence(req.persistence), "created_at": _now()}
        s.setdefault("access_patterns", {})[req.name] = entry
        s["updated_at"] = _now()
        _save(r)
    return entry


@router.put("/{fid}/access-patterns/{name}")
def update_access_pattern(fid: str, name: str, req: AccessPatternUpdate) -> dict:
    """Change a pattern's persistence policy (built-in or registered) or a registered pattern's parameters. Stored
    outputs of the pattern are dropped, so the new policy and parameters apply from the next request."""
    with _lock:
        r = _reg()
        s = _require(fid, "editor", r)
        reg = (s.get("access_patterns") or {}).get(name)
        if not reg and name not in _builtin_patterns(s):
            raise HTTPException(404, "no such access pattern on this media set")
        if req.params is not None:
            if not reg:
                raise HTTPException(400, "a built-in access pattern takes its parameters per request; register a named pattern to fix them")
            params = req.params.model_dump(exclude_none=True)
            _check_params(reg["pattern"], params)
            reg["params"] = params
        if req.persistence is not None:
            pol = _norm_persistence(req.persistence)
            if reg:
                reg["persistence"] = pol
            else:
                s.setdefault("pattern_policies", {})[name] = pol
        s["updated_at"] = _now()
        _save(r)
    _purge(fid, _prefix(name, bool(reg)))
    return _patterns_view(fid, get(fid) or s)


@router.delete("/{fid}/access-patterns/{name}")
def delete_access_pattern(fid: str, name: str) -> dict:
    with _lock:
        r = _reg()
        s = _require(fid, "editor", r)
        if name not in (s.get("access_patterns") or {}):
            raise HTTPException(404, "no such registered access pattern (built-in ones cannot be removed)")
        s["access_patterns"].pop(name)
        s["updated_at"] = _now()
        _save(r)
    return {"deleted": name, "outputs_dropped": _purge(fid, _prefix(name, True))}


def _channel(v: Optional[str], allow_all: bool) -> str:
    """'mix', 'all' or a 0-based channel index as a string ('left' / 'right' = 0 / 1)."""
    v = (v or "mix").strip().lower()
    v = {"left": "0", "right": "1", "mono": "mix", "mixdown": "mix", "mix_down": "mix"}.get(v, v)
    if v == "all" and allow_all:
        return v
    if v == "mix" or (v.isdigit() and int(v) < 64):
        return str(int(v)) if v.isdigit() else v
    raise HTTPException(400, "channel is 'mix' (mix down to mono)" + (", 'all'" if allow_all else "") + " or a 0-based channel index")


def _check_params(pattern: str, params: dict) -> None:
    if "channel" in params:
        params["channel"] = _channel(params["channel"], pattern == "audio")
    if "format" in params and params["format"] not in AUDIO_OUT:
        raise HTTPException(400, f"format is one of {', '.join(AUDIO_OUT)}")


def _stored(path: Path, pol: dict) -> Optional[bytes]:
    if pol["policy"] == "recompute" or not path.exists():
        return None
    if pol["policy"] == "cache" and time.time() - path.stat().st_mtime > (pol.get("ttl_seconds") or 0):
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def _store(path: Path, out: bytes, pol: dict) -> None:
    if pol["policy"] == "recompute":
        path.unlink(missing_ok=True)  # an output stored under an earlier policy
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_bytes(out)
    import os

    os.replace(tmp, path)


def _policy_headers(name: str, pol: dict, hit: bool) -> dict:
    cc = {"recompute": "no-store", "cache": f"private, max-age={min(pol.get('ttl_seconds') or 0, 86400)}"}.get(pol["policy"], "private, max-age=86400")
    return {"Cache-Control": cc, "X-Access-Pattern": name, "X-Persistence-Policy": pol["policy"], "X-Pattern-Cache": "hit" if hit else "miss",
            "Access-Control-Expose-Headers": "X-Access-Pattern, X-Persistence-Policy, X-Pattern-Cache"}


AUDIO_OUT = {"wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac"}


def _ranged(request: Optional[Request], out: bytes, media: str, headers: dict) -> Response:
    """The output, or the byte range the request asks for (an <audio> element can only seek in a ranged resource)."""
    return _ranged_read(request, len(out), lambda a, b: out[a:b], media, headers)


def _range_of(request: Optional[Request], n: int) -> Optional[tuple[int, int]]:
    """(start, end) inclusive of the request's byte range over n bytes, None without one, (n, n) when unsatisfiable."""
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", ((request.headers.get("range") if request else None) or "").strip())
    if not m or not (m.group(1) or m.group(2)):
        return None
    if m.group(1):
        start, end = int(m.group(1)), min(int(m.group(2)) if m.group(2) else n - 1, n - 1)
    else:  # the last N bytes
        start, end = max(n - int(m.group(2)), 0), n - 1
    return (n, n) if start >= n or start > end else (start, end)


def _ranged_read(request: Optional[Request], n: int, read: Any, media: str, headers: dict) -> Response:
    """_ranged over an output of n bytes read by read(start, stop) — bytes in memory or a playback's file."""
    headers = {**headers, "Accept-Ranges": "bytes"}
    headers["Access-Control-Expose-Headers"] += ", Accept-Ranges, Content-Range, Content-Length"
    rg = _range_of(request, n)
    if rg is None:
        return Response(read(0, n), media_type=media, headers=headers)
    start, end = rg
    if start >= n:
        return Response(b"", status_code=416, headers={**headers, "Content-Range": f"bytes */{n}"})
    return Response(read(start, end + 1), status_code=206, media_type=media, headers={**headers, "Content-Range": f"bytes {start}-{end}/{n}"})


# -- one playback of a recompute pattern: its byte-range requests share one output --

PLAYBACK_IDLE = 120  # seconds a recompute output serves further byte ranges of its playback after the last one
_plays: dict[str, dict] = {}  # pattern output key -> {"file", "size", "made", "used"}
_play_locks: dict[str, threading.Lock] = {}
_plays_lock = threading.Lock()


def _play_dir() -> Path:
    return DIR / "cache" / "_play"


def _play_sweep() -> int:
    """Drop playback outputs idle for PLAYBACK_IDLE (and files left by an earlier process or still open on removal)."""
    now, n = time.time(), 0
    with _plays_lock:
        for k, e in list(_plays.items()):
            if now - e["used"] > PLAYBACK_IDLE:
                _plays.pop(k, None)
        live = {e["file"] for e in _plays.values()}
    _ajobs_sweep()
    with _ajobs_lock:  # recompute outputs of jobs whose requester has not come back for them yet
        live |= {j.result_file for j in _ajobs.values() if j.result_file is not None}
    d = _play_dir()
    if d.is_dir():
        for f in d.iterdir():
            try:
                if f not in live and now - f.stat().st_mtime > PLAYBACK_IDLE:
                    f.unlink()
                    n += 1
            except OSError:  # open by a range request on Windows: next sweep
                pass
    return n


def _read_file(f: Path) -> Any:
    def read(a: int, b: int) -> bytes:
        with open(f, "rb") as fh:
            fh.seek(a)
            return fh.read(max(0, b - a))
    return read


@router.get("/items/{item_id}/access/{pattern}", response_model=None)
def access(item_id: str, pattern: str, request: Request = None, page: int = 0, layer: Optional[int] = None, width: int = 320, channel: Optional[str] = None,
           format: Optional[str] = None, language: Optional[str] = None, output_format: Optional[Literal["text", "segments"]] = None,
           mode: Optional[Literal["more_economical", "more_performant"]] = None, token: Optional[str] = None, wait: Optional[float] = None) -> Response:
    """Access patterns: thumbnail, page (PDF page as PNG), frame (video), waveform, sheets (spreadsheet JSON), email
    (headers and body), dicom (a layer as PNG), text (PDF text per page), audio (channel / mix-down as wav, mp3 or
    flac), transcription (JSON) — or a pattern registered on the item's media set by name (its parameters fixed).
    Each follows its persistence policy (persist / cache for a time / recompute). Under recompute, the audio
    pattern's byte-range requests of one playback share one output (see _audio_playback); X-Pattern-Cache says
    "playback" for those.

    The patterns of audio and video items (thumbnail / frame, waveform, audio, transcription) are computed by a
    background job from the item's shared source copy (see media_jobs): the request waits up to `wait` seconds for
    it — by default up to ACCESS_INLINE_WAIT for a small item (at most ACCESS_INLINE_BYTES; a transcription also at
    most ACCESS_INLINE_SECONDS long), ACCESS_WAIT otherwise — then answers 202 with the job's state and progress
    (JSON, Retry-After, Location). Poll /items/{id}/access/{pattern}/status with the same parameters until "ready",
    then request the output again; under recompute pass the `token` from the 202 / status (that job's output, kept
    PLAYBACK_IDLE seconds after its last request). The caller's read access is checked here, on the request thread."""
    sp = _access_spec(item_id, pattern, page, layer, width, channel, format, language, output_format, mode)
    if sp["job"]:
        return _access_by_job(sp, request, token, wait)
    if token:
        raise HTTPException(400, "a token reads the output of an audio or video access pattern computed in the background")
    path, kind, fid, base, q, opts, width, key, pol, cache, media = (sp[k] for k in ("path", "kind", "fid", "base", "q", "opts", "width", "key", "pol", "cache", "media"))

    def compute() -> bytes:
        data = resolve(item_id)[0]
        res = _compute_pattern(base, kind, path, data, int(q["page"] or 0), q["layer"], width, opts)
        cost = _pattern_cost(base, kind)
        if cost:
            record_usage(fid, cost, len(data))
        return res

    out = _stored(cache, pol)
    hit = out is not None
    if out is None:
        out = compute()
        _store(cache, out, pol)
    return Response(out, media_type=media, headers=_policy_headers(pattern, pol, hit))


def _pattern_cost(base: str, kind: Optional[str]) -> Optional[str]:
    cost = PATTERN_COST[base] or {"image": "image_thumbnail", "document": "pdf_render_page", "video": "video_frame", "dicom": "render_dicom_layer"}.get(kind or "")
    return "video_extract_audio" if base == "audio" and kind == "video" else cost


def _access_spec(item_id: str, pattern: str, page: int = 0, layer: Optional[int] = None, width: int = 320, channel: Optional[str] = None,
                 format: Optional[str] = None, language: Optional[str] = None, output_format: Optional[str] = None, mode: Optional[str] = None,
                 check: bool = True) -> dict:
    """What an access pattern request asks for (its output key, policy, stored output path, media type), after the
    caller's read access was checked (_item_meta). "job": computed by a background job (audio / video patterns)."""
    path, ct, fid = _item_meta(item_id, check)
    s = get(fid)
    reg = (s.get("access_patterns") or {}).get(pattern) if s else None
    q = {"page": page, "layer": layer, "width": width, "channel": channel, "format": format, "language": language, "output_format": output_format, "mode": mode}
    params = dict(q)  # as requested (a job record re-creates the request from them)
    if reg:
        base = reg["pattern"]
        q.update(reg["params"])
    elif pattern in PATTERN_COST and pattern != "hls":
        base = pattern
    else:
        names = [p for p in PATTERN_COST if p != "hls"] + sorted((s or {}).get("access_patterns") or {})
        raise HTTPException(404, f"access patterns: {', '.join(names)} (HLS: /items/{{id}}/hls/playlist.m3u8)")
    if base == "hls":
        raise HTTPException(400, "an HLS access pattern is read at /items/{id}/hls/playlist.m3u8?pattern=<name>")
    width = max(32, min(int(q["width"] or 320), 2000))
    kind = _kind(s, path, ct)
    opts = {"channel": None, "format": None, "language": q["language"], "output_format": q["output_format"] or "text", "mode": q["mode"] or "more_economical"}
    if base in ("audio", "transcription", "waveform"):
        if kind not in ("audio", "video"):
            raise HTTPException(400, f"the {base} access pattern reads audio or video items")
        opts["channel"] = _channel(q["channel"], base == "audio") if (q["channel"] or base != "waveform") else None
        opts["format"] = (q["format"] or "wav").lower()
        if opts["format"] not in AUDIO_OUT:
            raise HTTPException(400, f"format is one of {', '.join(AUDIO_OUT)}")
    key = f"{base}-{q['page']}-{q['layer']}-{width}"
    if base == "audio":
        key += f"-{opts['channel']}-{opts['format']}"
    elif base == "transcription":
        key += f"-{opts['channel']}-{opts['language']}-{opts['output_format']}-{opts['mode']}"
    elif base == "waveform" and opts["channel"]:
        key += f"-{opts['channel']}"
    if reg:
        key = _prefix(pattern, True) + key
    pol = _policy(s, pattern)
    cache = DIR / "cache" / item_id / re.sub(r"[^A-Za-z0-9@_.-]", "_", key)
    media = AUDIO_OUT[opts["format"]] if base == "audio" else "application/json" if base in ("waveform", "sheets", "email", "text", "transcription") else "image/png"
    job = kind in ("audio", "video") and base in _JOB_PATTERNS
    if job:
        if base in ("thumbnail", "frame") and kind != "video":
            raise HTTPException(404, f"no {'thumbnail' if base == 'thumbnail' else 'video frame'} for audio media")
        info = _probes.get(item_id)
        if info:  # probed before: a stream or channel the item lacks is a 400 at once
            if base in ("audio", "transcription", "waveform") and not info.get("has_audio"):
                raise HTTPException(400, "this item has no audio stream")
            if opts["channel"]:
                _channel_args(opts["channel"], info.get("channels"))
    return {"item_id": item_id, "pattern": pattern, "path": path, "kind": kind, "fid": fid, "base": base, "q": q, "opts": opts, "width": width, "key": key,
            "pol": pol, "cache": cache, "media": media, "job": job, "out": f"{item_id}/{cache.name}", "params": params}


# -- access pattern jobs: the audio / video patterns, computed in the background from the shared source copy --

ACCESS_WAIT = 8.0  # seconds a request waits for its job before answering 202
ACCESS_INLINE_WAIT = 120.0  # ...for a small item, answered inline as before (unless its transcription is long)
ACCESS_INLINE_BYTES = 16 * 2 ** 20
ACCESS_INLINE_SECONDS = 120.0  # a transcription of more audio than this is not waited for beyond ACCESS_WAIT
ACCESS_TIMEOUT = 3600  # seconds one ffmpeg pass of a job may take before it is stopped
ACCESS_FAILED_KEEP = 60  # seconds a failed or cancelled job stays reported to the polling client
TRANSCRIBE_PIECE = 300.0  # seconds of audio Whisper transcribes per piece of a long item (progress, cancel between pieces)
_JOB_PATTERNS = ("thumbnail", "frame", "waveform", "audio", "transcription")
_ajobs: dict[str, media_jobs.Job] = {}  # output ("<item>/<stored name>") or, under recompute, job token -> job
_ajobs_lock = threading.Lock()
_probing: dict[str, threading.Event] = {}


def _source_chunks(item_id: str) -> tuple:
    """(chunk iterable, close function, expected bytes) of an item's bytes, read in 1 MB chunks — on the fetch thread
    of its shared source copy (the caller's read access was checked on the request thread)."""
    item = db.drive_get(item_id)
    if item and item["kind"] == "file" and not item.get("trashed_at"):
        if item["stored_in"] == "s3":
            import storage

            body = storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{item_id}")["Body"]
            return body.iter_chunks(1 << 20), body.close, int(item.get("size_bytes") or 0)
        fh = open(drive.LOCAL_DIR / item_id, "rb")
        return iter(lambda: fh.read(1 << 20), b""), fh.close, int(item.get("size_bytes") or 0)
    ix = _reg()["index"].get(item_id) or {}
    if ix.get("kind") == "version":
        fh = open(DIR / "versions" / item_id, "rb")
        return iter(lambda: fh.read(1 << 20), b""), fh.close, os.fstat(fh.fileno()).st_size
    data = _read_virtual(item_id)
    return [data], None, len(data)


def _acquire_source(item_id: str, path: str) -> media_jobs.Source:
    return media_jobs.acquire(item_id, _ext(path), lambda: _source_chunks(item_id))


def _item_size(item_id: str) -> Optional[int]:
    """The item's size in bytes without reading it (None when unknown: a virtual item registered without one)."""
    item = db.drive_get(item_id)
    if item and item["kind"] == "file" and not item.get("trashed_at"):
        return int(item.get("size_bytes") or 0)
    r = _reg()
    ix = r["index"].get(item_id) or {}
    if ix.get("kind") == "version":
        try:
            return (DIR / "versions" / item_id).stat().st_size
        except OSError:
            return None
    v = next((x for x in (r["virtual"].get(ix.get("fid")) or {}).values() if x["id"] == item_id), None) or (r["deleted"].get(ix.get("fid")) or {}).get(item_id) or {}
    src = media_jobs.peek(item_id)
    return v.get("size") or (src.size if src else None)


def _probe_item(item_id: str, path: str, wait: float) -> Optional[dict]:
    """The item's streams (cached), probed from its shared source copy on a background thread; None while that is
    still going after `wait` seconds, {"error": ...} when it failed."""
    if item_id in _probes:
        return _probes[item_id]
    with _ajobs_lock:
        ev = _probing.get(item_id)
        start = ev is None
        if start:
            ev = _probing[item_id] = threading.Event()

    def probe() -> None:
        try:
            src = _acquire_source(item_id, path)
            try:
                _probes[item_id] = _audio_info(str(src.wait()))
            finally:
                media_jobs.release(src)
        except Exception as e:  # noqa: BLE001 - reported to the waiting request
            ev.error = str(e)[:200]  # type: ignore[attr-defined]
        finally:
            with _ajobs_lock:
                _probing.pop(item_id, None)
            ev.set()

    if start:
        threading.Thread(target=probe, name="media-probe", daemon=True).start()
    ev.wait(wait)
    if item_id in _probes:
        return _probes[item_id]
    return {"error": ev.error} if getattr(ev, "error", None) else None


def _ff(job: Optional[media_jobs.Job], src: Path, pre: list[str], post: list[str], out: Path, duration: Optional[float] = None,
        span: tuple[float, float] = (0.0, 1.0)) -> None:
    """One ffmpeg pass from the source copy to `out`, its progress (-progress, against `duration`) mapped into
    job.progress over `span`; killed by a cancel or after ACCESS_TIMEOUT."""
    import code_media

    cmd = [code_media._ffmpeg_exe(), "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1", *pre, "-i", str(src), *post, str(out)]
    timed_out = []
    with open(out.with_name(out.name + ".err"), "w+b") as err:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, stdin=subprocess.DEVNULL)
        if job is not None:
            job.proc = p
            if job.cancelled:
                p.kill()

        def stop() -> None:
            timed_out.append(True)
            p.kill()

        timer = threading.Timer(ACCESS_TIMEOUT, stop)
        timer.daemon = True
        timer.start()
        try:
            for line in p.stdout:
                if job is not None and duration and (line.startswith(b"out_time_us=") or line.startswith(b"out_time_ms=")):
                    try:
                        us = int(line.split(b"=", 1)[1])
                    except ValueError:
                        continue
                    job.progress = max(job.progress, span[0] + (span[1] - span[0]) * min(1.0, us / 1e6 / duration))
            rc = p.wait()
        finally:
            timer.cancel()
            if job is not None:
                job.proc = None
        err.seek(0)
        tail = err.read()[-400:].decode("utf-8", "replace")
    if job is not None:
        job.check()
    if timed_out:
        raise RuntimeError(f"ffmpeg took longer than {ACCESS_TIMEOUT} s and was stopped")
    if rc or not out.exists():
        raise RuntimeError(f"ffmpeg failed: {tail}")


def _compute_av(pattern: str, path: str, src: Path, width: int, opts: dict) -> bytes:
    """An audio / video access pattern computed from the item's local source copy (ffmpeg reads the file; nothing
    of the source is held in memory)."""
    from PIL import Image

    job: Optional[media_jobs.Job] = opts.get("job")
    info = opts.get("info") or {}
    dur = info.get("durationSeconds")
    ch = opts.get("channel")
    d = media_jobs.tmpdir()
    try:
        if pattern in ("thumbnail", "frame"):
            if job is not None:
                job.step = "grabbing a frame"
            out = d / "out.png"
            _ff(job, src, ["-ss", "0"], ["-frames:v", "1"], out)
            return _png(Image.open(io.BytesIO(out.read_bytes())), width)
        if info and not info.get("has_audio"):
            raise HTTPException(400, "this item has no audio stream")
        if pattern == "audio":
            if job is not None:
                job.step = "transcoding"
            fmt = opts.get("format") or "wav"
            out = d / f"out.{fmt}"
            _ff(job, src, [], ["-vn", *_channel_args(ch or "mix", info.get("channels"))], out, dur)
            return out.read_bytes()
        if pattern == "waveform":
            import numpy as np

            if job is not None:
                job.step = "reading the waveform"
            out = d / "out.raw"
            _ff(job, src, [], ["-vn", *(_channel_args(ch, info.get("channels")) if ch else []), "-ac", "1", "-ar", "8000", "-f", "s16le"], out, dur)
            a = np.abs(np.fromfile(out, dtype=np.int16).astype(np.float64)) / 32768.0
            step = 8000 // 50
            n = len(a) // step
            peaks = [round(float(x), 4) for x in a[: n * step].reshape(n, step).max(axis=1)] if n else []
            return json.dumps({"peaks": peaks, **({"channel": ch} if ch else {})}).encode()
        if pattern == "transcription":
            ch = ch or "mix"
            if job is not None:
                job.step = "extracting the audio"
            out = d / "speech.wav"
            _ff(job, src, [], ["-vn", *_channel_args(ch, info.get("channels")), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"], out, dur, (0.0, 0.1))
            fmt = opts.get("output_format") or "text"
            res = _transcribe_wav(job, out, opts.get("language"), opts.get("mode") or "more_economical", fmt)
            if fmt == "segments":
                return json.dumps({**json.loads(res), "channel": ch}).encode()
            return json.dumps({"channel": ch, "language": opts.get("language"), "text": res}).encode()
        raise HTTPException(404, "unknown access pattern")
    finally:
        media_jobs.rmtree(d)


def _whisper(job: Optional[media_jobs.Job], data: bytes, language: Optional[str], mode: str) -> dict:
    """code_media.transcribe_audio's Whisper call ({text, segments, duration}), with a stopping criterion that raises
    Cancelled at the next decoded token once the job is cancelled: a piece otherwise runs to its end, which takes
    minutes for music or noise (beam search to the maximum length), so a cancel or a stopping API process waited that
    long."""
    import code_media

    audio = code_media._pcm16k(data)
    if not len(audio):
        return {"text": "", "segments": [], "duration": 0.0}
    kw: dict = {"task": "transcribe"}
    if language:
        kw["language"] = language
    try:
        asr = code_media._asr(mode)
        if job is not None:
            import torch
            from transformers import StoppingCriteria, StoppingCriteriaList

            class _Cancelled(StoppingCriteria):
                def __call__(self, input_ids, scores, **kwargs):  # noqa: ANN001, ANN003
                    job.check()  # Cancelled leaves generate() and the pipeline's remaining 30 s chunks at once
                    return torch.zeros((input_ids.shape[0],), dtype=torch.bool, device=input_ids.device)

            kw["stopping_criteria"] = StoppingCriteriaList([_Cancelled()])
    except NotImplementedError as e:
        raise HTTPException(501, str(e)) from None
    except ImportError as e:
        raise HTTPException(501, f"transcribe() needs transformers and torch: {e}") from None
    res = asr({"raw": audio, "sampling_rate": 16000}, return_timestamps=True, generate_kwargs=kw)
    if job is not None:
        job.check()  # cancelled meanwhile: what was decoded is cut short, never used
    dur = len(audio) / 16000
    chunks = res.get("chunks") or [{"timestamp": (0.0, dur), "text": res.get("text", "")}]
    segs = []
    for i, c in enumerate(chunks):
        start, end = c.get("timestamp") or (None, None)
        segs.append({"id": i, "start": round(float(start or 0.0), 2), "end": round(float(end if end is not None else dur), 2), "text": str(c.get("text") or "").strip()})
    return {"text": str(res.get("text") or "").strip(), "segments": segs, "duration": round(dur, 2)}


def _transcribe_wav(job: Optional[media_jobs.Job], wav: Path, language: Optional[str], mode: str, output_format: str) -> str:
    """Whisper over a 16 kHz mono wav: at once when short; a long one in pieces of about TRANSCRIBE_PIECE seconds, each
    cut at the quietest 100 ms of its last 10 seconds (between words), so the job reports progress and stops between
    pieces when cancelled (and within a piece, at Whisper's next decoded token: see _whisper). The result is shaped like
    code_media.transcribe_audio's (segment times over the whole)."""
    import wave

    import numpy as np

    with wave.open(str(wav), "rb") as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    piece = int(TRANSCRIBE_PIECE * rate)
    if len(pcm) <= piece * 1.2:
        if job is not None:
            job.step = "transcribing"
        res = _whisper(job, wav.read_bytes(), language, mode)
        if output_format == "segments":
            return json.dumps({"language": language, "duration": res["duration"], "segments": res["segments"]})
        return res["text"]
    cuts, a = [], 0
    frame = rate // 10
    while len(pcm) - a > piece * 1.2:
        lo, hi = a + piece - 10 * rate, a + piece
        win = pcm[lo:hi].astype(np.float64)
        nfr = len(win) // frame
        rms = (win[: nfr * frame].reshape(nfr, frame) ** 2).mean(axis=1)
        b = lo + int(rms.argmin()) * frame + frame // 2
        cuts.append((a, b))
        a = b
    cuts.append((a, len(pcm)))
    segs: list[dict] = []
    texts: list[str] = []
    for i, (a, b) in enumerate(cuts):
        if job is not None:
            job.check()
            job.step = f"transcribing (piece {i + 1} of {len(cuts)})"
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm[a:b].tobytes())
        part = _whisper(job, buf.getvalue(), language, mode)
        off = a / rate
        for sg in part.get("segments") or []:
            segs.append({"id": len(segs), "start": round(sg["start"] + off, 2), "end": round(sg["end"] + off, 2), "text": sg["text"]})
        texts.append(" ".join(sg["text"] for sg in part.get("segments") or []).strip())
        if job is not None:
            job.progress = max(job.progress, 0.1 + 0.9 * b / len(pcm))
    if output_format == "segments":
        return json.dumps({"language": language, "duration": round(len(pcm) / rate, 2), "segments": segs})
    return " ".join(t for t in texts if t)


def _ajobs_sweep() -> None:
    """Forget finished jobs: failed / cancelled ones after ACCESS_FAILED_KEEP, a recompute output after PLAYBACK_IDLE
    without a request (its file is then swept with the playbacks), a stored output's job at once (the store answers)."""
    now = time.time()
    with _ajobs_lock:
        for k, j in list(_ajobs.items()):
            if j.state in ("failed", "cancelled") and now - (j.finished or now) > ACCESS_FAILED_KEEP:
                _ajobs.pop(k)
            elif j.state == "ready" and (k != j.token or now - j.used > PLAYBACK_IDLE):
                _ajobs.pop(k)


def _job_start(sp: dict, recompute: bool) -> media_jobs.Job:
    """Start the job computing the request's output, or join the one already computing it (under recompute too: an
    output being computed has not been served to anyone yet)."""
    _ajobs_sweep()
    with _ajobs_lock:
        job = next((j for j in _ajobs.values() if j.label == sp["out"] and j.state in ("queued", "running")), None)
        if job is not None:
            return job
    if not recompute:  # a shared output another API process is computing: its state, not a second computation
        rec = media_jobs.read_record(_record_path(sp["cache"]))
        if rec and rec.get("state") in ("queued", "running") and media_jobs.owner(rec) == "alive":
            return _job_snapshot(rec)
    with _ajobs_lock:
        job = next((j for j in _ajobs.values() if j.label == sp["out"] and j.state in ("queued", "running")), None)
        if job is not None:
            return job
        job = media_jobs.Job(sp["out"], sp["item_id"], sp["out"])
        _ajobs[job.token if recompute else sp["out"]] = job
    item_id, base, kind, path, fid, q, opts, width, cache, pol = (sp[k] for k in ("item_id", "base", "kind", "path", "fid", "q", "opts", "width", "cache", "pol"))
    job.record_path = _record_path(cache, job.token if recompute else None)
    media_jobs.record(job.record_path, {"kind": "access", "item_id": item_id, "pattern": sp["pattern"], "params": sp["params"], "out": sp["out"],
                                        "policy": pol["policy"], "token": job.token if recompute else None}, job.record_live)

    def prepare(job: media_jobs.Job, src: Path) -> None:
        info = _probes.get(item_id)
        if not info:
            job.step = "probing"
            info = _probes[item_id] = _audio_info(str(src))
        job.info = info
        if base in ("audio", "transcription", "waveform") and not info.get("has_audio"):
            raise HTTPException(400, "this item has no audio stream")
        if opts.get("channel"):
            _channel_args(opts["channel"], info.get("channels"))
        job.step = None

    def compute(job: media_jobs.Job, src: Path) -> None:
        out = _compute_pattern(base, kind, path, src, int(q["page"] or 0), q["layer"], width, {**opts, "job": job, "info": job.info})
        job.check()
        cost = _pattern_cost(base, kind)
        if cost:
            record_usage(fid, cost, job.source_size)
        job.result_size = len(out)
        if recompute and base == "audio":  # a playback's output: its byte ranges are cut from the file
            d = _play_dir()
            d.mkdir(parents=True, exist_ok=True)
            f = d / f"{hashlib.sha1(sp['out'].encode()).hexdigest()[:20]}.{job.token[:8]}.bin"
            f.write_bytes(out)
            job.result_file = f
        elif recompute:
            job.result = out
        else:
            _store(cache, out, pol)
            if base != "audio":
                job.result = out  # small; an audio output is read from the store by its waiting requests

    media_jobs.run(job, _ext(path), lambda: _source_chunks(item_id), prepare, compute)
    return job


def _job_wait(job: media_jobs.Job, sp: dict, wait: Optional[float], t0: float) -> None:
    """Wait for the job as long as the request should (see access())."""
    if wait is not None:
        budget = max(0.0, min(float(wait), ACCESS_INLINE_WAIT))
    else:
        size = _item_size(sp["item_id"])
        budget = ACCESS_INLINE_WAIT if size is not None and size <= ACCESS_INLINE_BYTES else ACCESS_WAIT
    while not job.done.wait(0.05):
        now = time.time()
        if now >= t0 + budget:
            return
        if sp["base"] == "transcription" and now >= t0 + ACCESS_WAIT and (job.info.get("durationSeconds") or 0) > ACCESS_INLINE_SECONDS:
            return


def _job_failed(job: media_jobs.Job) -> HTTPException:
    if job.state == "cancelled":
        return HTTPException(409, "the computation of this output was cancelled: request it again")
    if job.status_code:
        return HTTPException(job.status_code, job.error)
    return HTTPException(500, f"the access pattern failed: {job.error}")


def _job_response(job: media_jobs.Job, sp: dict, request: Optional[Request], recompute: bool) -> Response:
    """202 for a job still going: its state (JSON) and where to ask next."""
    body = {**job.view(), "pattern": sp["pattern"], "policy": sp["pol"]["policy"]}
    if not recompute:
        body.pop("token", None)
    qs = [(k, v) for k, v in (request.query_params.multi_items() if request is not None else []) if k not in ("token", "wait")]
    if recompute:
        qs.append(("token", job.token))
    from urllib.parse import urlencode

    loc = sp["pattern"] + (f"?{urlencode(qs)}" if qs else "")
    body["url"] = loc
    return Response(json.dumps(body), status_code=202, media_type="application/json",
                    headers={"Retry-After": "2", "Cache-Control": "no-store", "Location": loc, "Access-Control-Expose-Headers": "Location, Retry-After"})


def _job_output(job: media_jobs.Job, sp: dict, request: Optional[Request], headers: dict) -> Response:
    """A finished job's output: its file (a recompute playback), its bytes, or the store it wrote (audio)."""
    media = sp["media"]
    if job.result_file is not None:
        return _ranged_read(request, job.result_size, _read_file(job.result_file), media, headers)
    if job.result is not None:
        return _ranged(request, job.result, media, headers) if sp["base"] == "audio" else Response(job.result, media_type=media, headers=headers)
    try:
        n = sp["cache"].stat().st_size
    except OSError:  # dropped meanwhile (a policy change): computed again on the next request
        raise HTTPException(409, "this output was dropped (its access pattern changed): request it again") from None
    return _ranged_read(request, n, _read_file(sp["cache"]), media, headers)


def _access_by_job(sp: dict, request: Optional[Request], token: Optional[str], wait: Optional[float]) -> Response:
    t0 = time.time()
    pattern, pol, base = sp["pattern"], sp["pol"], sp["base"]
    recompute = pol["policy"] == "recompute"
    if recompute:
        sp["cache"].unlink(missing_ok=True)  # an output stored under an earlier policy
    if token and recompute:  # the output of a job an earlier request started (its 202 gave the token)
        job = _job_by_token(sp, token)
        job.used = time.time()
        if job.state in ("queued", "running"):
            _job_wait(job, sp, wait, t0)
        if job.state == "ready":
            job.used = time.time()
            return _job_output(job, sp, request, _policy_headers(pattern, pol, False))
        if job.state in ("failed", "cancelled"):
            raise _job_failed(job)
        return _job_response(job, sp, request, True)
    if not recompute:
        if pol["policy"] == "cache" and _stored_fresh(sp["cache"], pol) or pol["policy"] == "persist" and sp["cache"].exists():
            try:
                n = sp["cache"].stat().st_size
                return _ranged_read(request, n, _read_file(sp["cache"]), sp["media"], _policy_headers(pattern, pol, True)) if base == "audio" else \
                    Response(sp["cache"].read_bytes(), media_type=sp["media"], headers=_policy_headers(pattern, pol, True))
            except OSError:
                pass
        with _ajobs_lock:
            old = _ajobs.get(sp["out"])
            if old is not None and old.state in ("failed", "cancelled"):
                _ajobs.pop(sp["out"])  # reported to this request; the next one computes again
        if old is not None and old.state == "failed":
            raise _job_failed(old)
        job = _job_start(sp, False)
        _job_wait(job, sp, wait, t0)
        if job.state == "ready":
            return _job_output(job, sp, request, _policy_headers(pattern, pol, False))
        if job.state in ("failed", "cancelled"):
            with _ajobs_lock:
                if _ajobs.get(sp["out"]) is job:
                    _ajobs.pop(sp["out"])
            raise _job_failed(job)
        return _job_response(job, sp, request, False)
    if base == "audio":
        return _audio_playback(sp, request, wait, t0)
    job = _job_start(sp, True)
    _job_wait(job, sp, wait, t0)
    if job.state == "ready":
        job.used = time.time()
        return _job_output(job, sp, request, _policy_headers(pattern, pol, False))
    if job.state in ("failed", "cancelled"):
        raise _job_failed(job)
    return _job_response(job, sp, request, True)


def _stored_fresh(path: Path, pol: dict) -> bool:
    try:
        return time.time() - path.stat().st_mtime <= (pol.get("ttl_seconds") or 0)
    except OSError:
        return False


def _job_by_token(sp: dict, token: str) -> media_jobs.Job:
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise HTTPException(400, "token is the 32-character id of a computation (from a 202 or /status)")
    job = _ajobs.get(token)
    if job is None:  # started by another API process, or by one a restart stopped: its record says
        rec = _token_record(token)
        if rec is not None and rec.get("out") == sp["out"]:
            return _job_snapshot(rec)
    if job is None or job.label != sp["out"]:
        raise HTTPException(404, f"this computation's output is gone (kept {PLAYBACK_IDLE} s after its last request, or cancelled): request it again")
    return job


# -- job records (media_jobs.record): interrupted jobs found again after a restart, jobs of other API processes --

RESTART_REASON = "the API process computing this stopped (a restart) before it finished: request it again"
RESTART_FAILED_KEEP = 900  # seconds a playback's computation stopped by a restart is reported as failed


def _jobs_dir() -> Path:
    return DIR / "cache" / "_jobs"


def _record_path(out: Path, token: Optional[str] = None) -> Path:
    """A job's record: next to its stored output / rendition, or (recompute: a playback's own) cache/_jobs/<token>."""
    return _jobs_dir() / f"{token}{media_jobs.RECORD_SUFFIX}" if token else out.with_name(out.name + media_jobs.RECORD_SUFFIX)


def _token_record(token: str) -> Optional[dict]:
    """The record of a playback's computation (recompute) this process does not hold: a failed one, one running in
    another live process, or — its process gone — marked failed now (RESTART_REASON). None when there is none."""
    p = _record_path(Path(), token)
    rec = media_jobs.read_record(p)
    if rec is None:
        return None
    if rec.get("state") == "failed":
        if time.time() - float(rec.get("failed_at") or 0) > RESTART_FAILED_KEEP:
            p.unlink(missing_ok=True)
            return None
        return rec
    if media_jobs.owner(rec) == "alive":
        return rec
    rec = {**rec, "state": "failed", "error": RESTART_REASON, "status_code": 409, "failed_at": time.time()}
    media_jobs.write_record(p, rec)
    return rec


def _job_snapshot(rec: dict) -> media_jobs.Job:
    """A recorded access job not running in this process (another process's, or failed by a restart): its state for
    the status route and the 202 / error answers; done at once, never run or registered here."""
    job = media_jobs.Job(rec.get("out") or "", rec.get("item_id") or "", rec.get("out") or "")
    job.token = rec.get("token") or job.token
    job.state, job.phase, job.step = rec.get("state") or "queued", rec.get("phase"), rec.get("step")
    job.progress = float(rec.get("progress") or 0)
    job.started = rec.get("started")
    job.error, job.status_code = rec.get("error"), rec.get("status_code")
    job.finished = rec.get("failed_at")
    job.remote = int(rec.get("pid") or 0)
    job.done.set()
    return job


def _audio_playback(sp: dict, request: Optional[Request], wait: Optional[float], t0: float) -> Response:
    """The audio pattern under recompute: a request without a range (or from byte 0) starts a new playback, computed
    by a job; its further byte ranges (within PLAYBACK_IDLE of the previous one) are cut from that output instead of
    computing again, and concurrent playback starts share one computation. The output lives in a temporary file only
    while the playback goes on — nothing is persisted. A long item's playback answers 202 with the job's token: its
    ranges are then read with ?token= (see _job_by_token)."""
    pattern, pol = sp["pattern"], sp["pol"]
    pkey = sp["out"]
    rg = _range_of(request, 1 << 62)
    fresh = rg is None or rg[0] == 0
    with _plays_lock:
        lk = _play_locks.setdefault(pkey, threading.Lock())
    with lk:
        e = _plays.get(pkey)
        now = time.time()
        if e and e["file"].exists() and (e["made"] >= t0 or (not fresh and now - e["used"] < PLAYBACK_IDLE)):
            e["used"] = now
            try:
                os.utime(e["file"])
            except OSError:
                pass
            reused = True
        else:
            job = _job_start(sp, True)
            _job_wait(job, sp, wait, t0)
            if job.state in ("failed", "cancelled"):
                raise _job_failed(job)
            if job.state != "ready":
                return _job_response(job, sp, request, True)
            job.used = time.time()
            e = {"file": job.result_file, "size": job.result_size, "made": job.finished, "used": time.time()}
            with _plays_lock:
                old = _plays.get(pkey)
                _plays[pkey] = e
            if old and old["file"] != e["file"]:
                try:
                    old["file"].unlink(missing_ok=True)
                except OSError:  # a range request still reads it: the sweep removes it
                    pass
            reused = False
    _play_sweep()
    headers = {**_policy_headers(pattern, pol, False), **({"X-Pattern-Cache": "playback"} if reused else {})}
    try:
        return _ranged_read(request, e["size"], _read_file(e["file"]), sp["media"], headers)
    except OSError:  # replaced by a new playback meanwhile: that one's bytes are the same output
        cur = _plays.get(pkey) or e
        return _ranged_read(request, cur["size"], _read_file(cur["file"]), sp["media"], headers)


@router.get("/items/{item_id}/access/{pattern}/status")
def access_status(item_id: str, pattern: str, page: int = 0, layer: Optional[int] = None, width: int = 320, channel: Optional[str] = None,
                  format: Optional[str] = None, language: Optional[str] = None, output_format: Optional[Literal["text", "segments"]] = None,
                  mode: Optional[Literal["more_economical", "more_performant"]] = None, token: Optional[str] = None) -> dict:
    """Where an audio / video access pattern's output stands — ready (stored, or a recompute job's output: request it
    with its token), queued (phase fetching with fetch_progress, or waiting for a worker), running (progress, step,
    eta_seconds), failed (error, status_code) or cancelled — starting its job when there is none. Under recompute a
    call without a token starts a new computation and returns its token."""
    sp = _access_spec(item_id, pattern, page, layer, width, channel, format, language, output_format, mode)
    if not sp["job"]:
        raise HTTPException(400, f"the {sp['base']} access pattern of this item is computed inline: request it directly")
    pol = sp["pol"]
    recompute = pol["policy"] == "recompute"
    base = {"pattern": pattern, "policy": pol["policy"]}
    if recompute:
        job = _job_by_token(sp, token) if token else _job_start(sp, True)
        return {**base, **job.view()}
    if pol["policy"] == "cache" and _stored_fresh(sp["cache"], pol) or pol["policy"] == "persist" and sp["cache"].exists():
        return {**base, "state": "ready", "progress": 1.0, "stored": True}
    job = _ajobs.get(sp["out"])
    if job is None or job.state == "cancelled" or (job.state == "failed" and time.time() - (job.finished or 0) > ACCESS_FAILED_KEEP):
        job = _job_start(sp, False)
    v = {**base, **job.view()}
    v.pop("token", None)
    return v


@router.delete("/items/{item_id}/access/{pattern}/job")
def access_cancel(item_id: str, pattern: str, page: int = 0, layer: Optional[int] = None, width: int = 320, channel: Optional[str] = None,
                  format: Optional[str] = None, language: Optional[str] = None, output_format: Optional[Literal["text", "segments"]] = None,
                  mode: Optional[Literal["more_economical", "more_performant"]] = None, token: Optional[str] = None) -> dict:
    """Cancel a queued or running access pattern job: a recompute one with its token; a stored output's job (shared by
    everyone who reads it) needs edit rights on the media set."""
    sp = _access_spec(item_id, pattern, page, layer, width, channel, format, language, output_format, mode)
    if not sp["job"]:
        raise HTTPException(400, "only audio and video access patterns are computed in the background")
    if sp["pol"]["policy"] == "recompute":
        if not token:
            raise HTTPException(400, "a recompute computation is cancelled with its token")
        job = _job_by_token(sp, token)
    else:
        if sp["fid"]:
            drive._item(sp["fid"], need="editor")
        job = _ajobs.get(sp["out"])
        if job is None:
            rec = media_jobs.read_record(_record_path(sp["cache"]))
            if rec and rec.get("state") in ("queued", "running") and media_jobs.owner(rec) == "alive":
                job = _job_snapshot(rec)
    if job is not None and job.remote and job.state in ("queued", "running"):
        raise HTTPException(409, f"this computation runs in another API process (pid {job.remote}): it can only be cancelled there")
    if job is None or not job.cancel():
        raise HTTPException(404, "no computation in progress for this output")
    job.done.wait(15)
    return {"cancelled": True, **job.view()}


# -- audio channels --


_LAYOUTS = {"mono": 1, "stereo": 2, "2.1": 3, "3.0": 3, "quad": 4, "4.0": 4, "4.1": 5, "5.0": 5, "5.1": 6, "6.0": 6, "6.1": 7, "7.0": 7, "7.1": 8,
            "hexagonal": 6, "octagonal": 8, "downmix": 2}


def _audio_info(file: str) -> dict:
    """Duration, audio channel count and layout, and whether there is a video stream (from ffmpeg's stream listing)."""
    import subprocess

    import code_media

    p = subprocess.run([code_media._ffmpeg_exe(), "-hide_banner", "-i", file], capture_output=True, timeout=60)
    err = p.stderr.decode("utf-8", "replace")
    out: dict[str, Any] = {}
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if m:
        out["durationSeconds"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    a = re.search(r"Stream #[^\n]*?Audio: [^\n]*?(\d+) Hz, ([^,\n]+)", err)
    if a:
        layout = a.group(2).strip()
        n = _LAYOUTS.get(layout.split("(")[0])
        if n is None:
            c = re.match(r"(\d+) channels", layout)
            n = int(c.group(1)) if c else None
        out.update(sample_rate=int(a.group(1)), channel_layout=layout, channels=n)
    out["has_video"] = bool(re.search(r"Stream #[^\n]*?Video: (?!png|mjpeg)", err))
    out["has_audio"] = bool(a)
    return out


def _channel_args(channel: Optional[str], channels: Optional[int]) -> list[str]:
    if channel in (None, "all"):
        return []
    if channel == "mix":
        return ["-ac", "1"]
    n = int(channel)
    if channels is not None and n >= channels:
        raise HTTPException(400, f"channel {n} does not exist: this item has {channels} audio channel{'s' if channels != 1 else ''} (0-{channels - 1})")
    return ["-af", f"pan=mono|c0=c{n}"]


def select_channel(data: bytes, ext: str, channel: Optional[str], fmt: str = "wav") -> bytes:
    """One audio channel (0-based), a mono mix-down ('mix') or every channel ('all') of an audio or video item,
    transcoded to wav / mp3 / flac with ffmpeg."""
    import code_media

    with _tmp(data, ext) as f:
        info = _audio_info(str(f))
    if not info.get("has_audio"):
        raise HTTPException(400, "this item has no audio stream")
    try:
        return code_media._ffmpeg(data, ext, ["-vn", *_channel_args(channel, info.get("channels"))], fmt)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from None


# -- HLS streaming --


HLS_TMP_MINUTES = 15  # a recompute (per-playback) rendition is removed this long after its last segment request
HLS_WORKERS = 2  # renders running at once; more wait in the queue ("queued")
HLS_TIMEOUT = 1800  # seconds one render may take before ffmpeg is stopped
HLS_WAIT = 8.0  # seconds a playlist request waits for its render before answering 202 (the client polls /hls/status)
HLS_FAILED_KEEP = 60  # seconds a failed or cancelled render stays reported to the polling client
HLS_START_SEGMENTS = 2  # finished segments after which a render still going is playable (a growing EVENT playlist)
HLS_PROBE_WAIT = 5.0  # seconds a request starting a render waits for the source's probe (a bad channel is a 400 then)
HLS_PROBE_BYTES = 16 * 2 ** 20  # ...unless the source is bigger: its probe comes after a long fetch, the request returns
_probes: dict[str, dict] = {}  # item id -> its streams (_audio_info); items never change: a new upload is a new id


def _hls_pattern(s: Optional[dict], name: str) -> Optional[dict]:
    """None for the built-in "hls" pattern, the registration for a registered HLS pattern (404 otherwise)."""
    if name == "hls":
        return None
    reg = ((s or {}).get("access_patterns") or {}).get(name)
    if not reg or reg["pattern"] != "hls":
        raise HTTPException(404, f"no HLS access pattern named {name} on this media set")
    return reg


class _Render:
    """One HLS render job: queued (phase "fetching" while its own thread waits for the item's shared source copy —
    fetched once for every job of the item, see media_jobs — and probes it), rendering (progress from ffmpeg's
    -progress output; playable once HLS_START_SEGMENTS segments are out), then ready, failed or cancelled. Nothing of
    it runs on a request thread; requests only start, poll or cancel it. src_dir holds the render's own scratch files."""

    def __init__(self, key: str, out: Path, src_dir: Path, src: Path, info: dict, channel: str, fid: Optional[str], item_id: str) -> None:
        self.key, self.out, self.src_dir, self.src, self.info, self.channel, self.fid, self.item_id = key, out, src_dir, src, info, channel, fid, item_id
        self.size, self.fetched, self.total = 0, 0, 0  # bytes of the source: copied, copied so far, expected
        self.source: Optional[media_jobs.Source] = None  # the shared copy held while the render needs it
        self.phase: Optional[str] = "fetching"
        self.bad_request = False  # failed on the item itself (no audio / video stream, no such channel): a 400
        self.probed = threading.Event()
        self.state, self.progress, self.error = "queued", 0.0, None
        self.created, self.started, self.finished = time.time(), None, None
        self.proc: Optional[subprocess.Popen] = None
        self.tmp: Optional[Path] = None
        self.cancelled = self.timed_out = False
        self.peak_rss = 0  # bytes: the ffmpeg process's largest resident set seen while rendering
        self.done = threading.Event()
        self.future: Any = None
        self.record_path: Optional[Path] = None  # its job record (media_jobs.record), removed when it finishes
        self.remote: Optional[int] = None  # a snapshot of a render another API process runs (its pid), see _render_snapshot

    def record_live(self) -> dict:
        return {"state": self.state, "phase": self.phase, "progress": round(self.progress, 4), "started": self.started,
                "tmp": str(self.tmp) if self.tmp else None, "duration_seconds": self.info.get("durationSeconds")}

    def view(self) -> dict:
        v: dict[str, Any] = {"state": self.state, "progress": round(self.progress, 4), "duration_seconds": self.info.get("durationSeconds")}
        if self.state == "queued" and self.phase == "fetching":
            v["phase"] = "fetching"
            if self.total:
                v["fetch_progress"] = round(min(1.0, self.fetched / self.total), 4)
        if self.state == "rendering":
            n = self.segments_ready()
            v.update(segments_ready=n, playable=n >= HLS_START_SEGMENTS)
        if self.started:
            v["elapsed_seconds"] = round((self.finished or time.time()) - self.started, 2)
            if self.state == "rendering" and self.progress > 0.02:
                v["eta_seconds"] = round(v["elapsed_seconds"] * (1 - self.progress) / self.progress, 1)
        if self.error:
            v["error"] = self.error
        return v

    def segments_ready(self) -> int:
        return len(self.segments())

    def segments(self) -> list[str]:
        """The finished segments of a render still going (ffmpeg writes each as .tmp and renames it when complete)."""
        tmp = self.tmp
        if self.state != "rendering" or not tmp:
            return []
        try:
            return sorted(f.name for f in tmp.iterdir() if re.fullmatch(r"seg_\d{5}\.ts", f.name))
        except OSError:  # renamed to the rendition meanwhile
            return []


_renders: dict[str, _Render] = {}  # rendition directory -> its active (or just failed / cancelled) render
_renders_lock = threading.Lock()
_render_pool = ThreadPoolExecutor(max_workers=HLS_WORKERS, thread_name_prefix="media-hls")


def _rss(pid: int) -> int:
    try:
        import psutil

        return psutil.Process(pid).memory_info().rss
    except Exception:  # noqa: BLE001 - measurement only
        return 0


def _hls_run(job: _Render) -> None:
    """The whole item as an HLS VOD rendition in job.out (index.m3u8 + seg_NNNNN.ts): one ffmpeg pass, so segment
    timestamps are continuous; video H.264 with a keyframe every segment, audio AAC (channel: all / mix / index).
    Written to a .tmp directory beside it and renamed when complete; removed on failure, cancel or timeout. While it
    runs, its finished segments are already served (a growing EVENT playlist, see _hls_partial_playlist)."""
    import code_media

    try:
        if job.cancelled:
            raise RuntimeError("cancelled")
        job.started = time.time()
        info, seg = job.info, HLS_SEGMENT
        job.tmp = tmp = job.out.with_name(job.out.name + f".{uuid.uuid4().hex[:6]}.tmp")
        tmp.mkdir(parents=True)
        job.state = "rendering"
        # no B-frames: Chrome's HLS player rejected B-frame video with audio ("buffers not in DTS sequence")
        video = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-bf", "0", "-force_key_frames", f"expr:gte(t,n_forced*{seg:g})"] if info.get("has_video") else ["-vn"]
        audio = ["-c:a", "aac", "-b:a", "128k", *_channel_args(job.channel, info.get("channels"))] if info.get("has_audio") else ["-an"]
        cmd = [code_media._ffmpeg_exe(), "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i", str(job.src), "-map", "0:v:0?", "-map", "0:a:0?",
               # event (made VOD below once complete) and temp_file: a segment carries its final name only when finished
               *video, *audio, "-f", "hls", "-hls_time", f"{seg:g}", "-hls_playlist_type", "event", "-hls_flags", "temp_file", "-hls_list_size", "0",
               "-hls_segment_filename", str(tmp / "seg_%05d.ts"), str(tmp / "index.m3u8")]
        with open(job.src_dir / "ffmpeg.err", "w+b") as err:
            job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, stdin=subprocess.DEVNULL)
            if job.cancelled:  # cancelled between the check above and the start
                job.proc.kill()

            def stop() -> None:
                job.timed_out = True
                job.proc.kill()

            watchdog = threading.Timer(HLS_TIMEOUT, stop)
            watchdog.daemon = True
            watchdog.start()
            dur = info.get("durationSeconds") or 0
            try:
                for line in job.proc.stdout:  # key=value lines, a block about every 0.5 s
                    if line.startswith(b"out_time_us=") or line.startswith(b"out_time_ms="):  # both are microseconds
                        try:
                            us = int(line.split(b"=", 1)[1])
                        except ValueError:
                            continue
                        if dur > 0:
                            job.progress = max(job.progress, min(0.99, us / 1e6 / dur))
                    elif line.startswith(b"progress="):
                        job.peak_rss = max(job.peak_rss, _rss(job.proc.pid))
                rc = job.proc.wait()
            finally:
                watchdog.cancel()
            err.seek(0)
            tail = err.read()[-400:].decode("utf-8", "replace")
        if job.cancelled:
            raise RuntimeError("cancelled")
        if job.timed_out:
            raise RuntimeError(f"the render took longer than {HLS_TIMEOUT} s and was stopped")
        if rc or not (tmp / "index.m3u8").exists():
            raise RuntimeError(f"ffmpeg failed: {tail}")
        pl = (tmp / "index.m3u8").read_text("utf-8")
        if "#EXT-X-ENDLIST" not in pl:
            raise RuntimeError(f"ffmpeg left an unfinished playlist: {tail}")
        (tmp / "index.m3u8").write_text(pl.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD"), "utf-8")
        shutil.rmtree(job.out, ignore_errors=True)
        for attempt in range(40):
            try:
                tmp.rename(job.out)
                break
            except OSError:
                if job.out.exists():  # a rendition of the same directory appeared meanwhile: keep that one
                    shutil.rmtree(tmp, ignore_errors=True)
                    if not (job.out / "index.m3u8").exists():
                        raise
                    break
                if attempt == 39:
                    raise
                time.sleep(0.25)  # Windows: a segment of it is being read by a player right now
        job.progress, job.state = 1.0, "ready"
        record_usage(job.fid, "video_hls" if info.get("has_video") else "audio_hls", job.size)
    except Exception as e:  # noqa: BLE001 - reported to the polling client
        job.state = "cancelled" if job.cancelled else "failed"
        job.error = None if job.cancelled else str(e)[:500]
        if not job.cancelled:
            log.warning("HLS render of %s failed: %s", job.out, job.error)
    finally:
        _render_cleanup(job)


def _render_cleanup(job: _Render) -> None:
    if job.state != "ready" and job.tmp:
        shutil.rmtree(job.tmp, ignore_errors=True)
    shutil.rmtree(job.src_dir, ignore_errors=True)
    src, job.source = job.source, None
    media_jobs.release(src)  # the shared copy stays for the item's next jobs (until swept)
    job.finished = time.time()
    with _renders_lock:
        if job.state == "ready" and _renders.get(job.key) is job:
            _renders.pop(job.key)  # the rendition itself answers from now on
    media_jobs.unrecord(job.record_path)
    job.probed.set()
    job.done.set()


def _render_cancel(job: _Render) -> bool:
    """Stop a queued or running render; its temporary files are removed (a source still being fetched stops at its
    next chunk). False when it had already finished."""
    if job.state not in ("queued", "rendering"):
        return False
    job.cancelled = True
    if job.future is not None and job.future.cancel():  # still queued: the pool never runs it
        job.state = "cancelled"
        _render_cleanup(job)
        return True
    if job.proc is not None and job.proc.poll() is None:
        try:
            job.proc.kill()
        except OSError:
            pass
    return True


def _render_get(key: str) -> Optional[_Render]:
    with _renders_lock:
        job = _renders.get(key)
        if job and job.state in ("failed", "cancelled") and time.time() - (job.finished or 0) > HLS_FAILED_KEEP:
            _renders.pop(key)
            return None
        return job


def _check_streams(info: dict, ch: str) -> None:
    """400 for an item without audio or video, or a channel it does not have."""
    if not info.get("has_audio") and not info.get("has_video"):
        raise HTTPException(400, "this item has no audio or video stream")
    if info.get("has_audio"):
        _channel_args(ch, info.get("channels"))


def _fetch_source(job: _Render) -> None:
    """Hold the item's shared source copy (fetched once for every job of the item, in 1 MB chunks: object storage can
    take a minute for a long video) and wait for it, mirroring its fetch progress; stops waiting when the render is
    cancelled (the fetch itself stops once nobody holds it). The caller's read access was checked on the request
    thread (_item_meta)."""
    job.source = src = media_jobs.acquire(job.item_id, job.src.suffix.lstrip("."), lambda: _source_chunks(job.item_id))

    def tick() -> None:
        job.fetched, job.total = src.fetched, src.total

    try:
        job.src = src.wait(lambda: job.cancelled, tick)
    except media_jobs.Cancelled:
        raise RuntimeError("cancelled") from None
    job.size = src.size


def _hls_prepare(job: _Render) -> None:
    """The render's first phase, on its own thread (not holding a render slot): wait for the shared source copy, probe
    it, then queue the ffmpeg pass on the render pool."""
    try:
        _fetch_source(job)
        if job.cancelled:
            raise RuntimeError("cancelled")
        if not job.info:
            job.info = _probes[job.item_id] = _audio_info(str(job.src))
        try:
            _check_streams(job.info, job.channel)
        except HTTPException as e:
            job.bad_request = True
            raise RuntimeError(e.detail) from None
        job.phase = None
        job.probed.set()
        with _renders_lock:  # a cancel between the check above and here sees no future yet: _hls_run checks again
            job.future = _render_pool.submit(_hls_run, job)
    except Exception as e:  # noqa: BLE001 - reported to the polling client
        job.state = "cancelled" if job.cancelled else "failed"
        job.error = None if job.cancelled else str(e)[:500]
        if not job.cancelled and not job.bad_request:
            log.warning("HLS source of %s could not be prepared: %s", job.out, job.error)
        _render_cleanup(job)


def _render_start(item_id: str, path: str, fid: Optional[str], ch: str, out: Path, pattern: str = "hls", registered: bool = False,
                  token: Optional[str] = None) -> _Render:
    """Start (or join) the render of `out`. The request thread only registers it: the source is fetched and probed
    on the job's own thread, ffmpeg runs on the render pool. An item probed before is checked here (400 at once).
    A shared rendition another API process is rendering is not rendered twice: its recorded state is returned."""
    import tempfile

    key = str(out)
    job = _render_get(key)
    if job and job.state in ("queued", "rendering"):
        return job
    rp = _record_path(out, token)
    rec = media_jobs.read_record(rp)
    if rec and rec.get("state") in ("queued", "rendering"):
        who = media_jobs.owner(rec)
        if who == "alive":
            return _render_snapshot(rec, out)
        if who == "gone" and rec.get("tmp"):  # its half-written rendition (a restart stopped it)
            shutil.rmtree(rec["tmp"], ignore_errors=True)
    info = _probes.get(item_id) or {}
    if info:
        _check_streams(info, ch)
    src_dir = Path(tempfile.mkdtemp(prefix="media-hls-"))
    job = _Render(key, out, src_dir, src_dir / f"item.{_ext(path) or 'bin'}", dict(info), ch, fid, item_id)
    if info:
        job.probed.set()
    with _renders_lock:
        other = _renders.get(key)
        if other and other.state in ("queued", "rendering"):  # a concurrent request started it first
            shutil.rmtree(src_dir, ignore_errors=True)
            return other
        _renders[key] = job
    job.record_path = rp
    media_jobs.record(rp, {"kind": "hls", "item_id": item_id, "pattern": pattern, "registered": registered, "channel": ch, "token": token,
                           "out": str(out)}, job.record_live)
    _hls_sweep(item_id)
    threading.Thread(target=_hls_prepare, args=(job,), name="media-hls-fetch", daemon=True).start()
    return job


def _render_snapshot(rec: dict, out: Path) -> _Render:
    """A recorded render not running in this process (another process's, or failed by a restart): its state for the
    status / playlist routes; done at once, never run or registered here."""
    job = _Render(str(out), out, Path(), Path(), {"durationSeconds": rec.get("duration_seconds")}, rec.get("channel") or "all", None, rec.get("item_id") or "")
    job.state, job.phase, job.progress = rec.get("state") or "queued", rec.get("phase"), float(rec.get("progress") or 0)
    job.started, job.error, job.finished = rec.get("started"), rec.get("error"), rec.get("failed_at")
    job.remote = int(rec.get("pid") or 0)
    job.probed.set()
    job.done.set()
    return job


def _hls_dir(item_id: str, name: str, registered: bool, ch: str, token: Optional[str] = None) -> Path:
    if token:  # recompute: a rendition made for one playlist request, removed after HLS_TMP_MINUTES
        return DIR / "cache" / "_hls" / token
    return DIR / "cache" / item_id / (_prefix(name, registered) + f"{ch}.hls")


def _hls_sweep(item_id: Optional[str] = None) -> int:
    """Remove the per-playback (recompute) renditions whose last segment request is older than HLS_TMP_MINUTES, and
    the item's half-written renditions left by an interrupted ffmpeg run (never those of a render still going)."""
    now, n = time.time(), 0
    with _renders_lock:
        busy = {p for j in _renders.values() if j.state in ("queued", "rendering") for p in (j.tmp, j.out) if p}
    dirs = [d for d in (DIR / "cache" / "_hls").iterdir()] if (DIR / "cache" / "_hls").is_dir() else []
    if item_id and (DIR / "cache" / item_id).is_dir():
        dirs += [d for d in (DIR / "cache" / item_id).iterdir() if d.is_dir() and d.name.endswith(".tmp")]
    for d in dirs:
        if d in busy:
            continue
        try:  # a half-written rendition: only once older than the ffmpeg timeout (30 minutes)
            old = now - d.stat().st_mtime > (3600 if d.name.endswith(".tmp") else HLS_TMP_MINUTES * 60)
        except OSError:
            continue
        if old:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n


def _hls_target(item_id: str, channel: Optional[str], pattern: str, token: Optional[str]) -> tuple:
    """(path, media set id, registration, channel, policy, token) of an HLS request; the token only under recompute."""
    path, ct, fid = _item_meta(item_id)
    s = get(fid)
    reg = _hls_pattern(s, pattern)
    if _kind(s, path, ct) not in ("audio", "video"):
        raise HTTPException(400, "HLS streams audio and video items")
    ch = _channel((reg or {}).get("params", {}).get("channel") or channel or "all", True)
    pol = _policy(s, pattern)
    if pol["policy"] != "recompute":
        token = None
    elif token is not None and not re.fullmatch(r"[0-9a-f]{32}", token):
        raise HTTPException(400, "token is the 32-character id of a playback's rendition")
    return path, fid, reg, ch, pol, token


def _hls_state(item_id: str, channel: Optional[str], pattern: str, token: Optional[str]) -> dict:
    """Where the item's rendition stands, starting its render when there is none: ready (a stored rendition, or a
    playback's own under recompute), queued / rendering (progress), failed (reported for HLS_FAILED_KEEP, then
    retried) or cancelled. Under recompute a request without a token starts a new playback's render (new token)."""
    path, fid, reg, ch, pol, token = _hls_target(item_id, channel, pattern, token)
    new = pol["policy"] == "recompute" and not token
    if new:
        token = uuid.uuid4().hex
    d = _hls_dir(item_id, pattern, bool(reg), ch, token)
    st: dict[str, Any] = {"token": token, "channel": ch, "pattern": pattern, "policy": pol["policy"], "dir": d, "pol": pol, "reg": reg, "job": None, "hit": False,
                          "playlist": f"playlist.m3u8?channel={ch}" + (f"&pattern={pattern}" if pattern != "hls" else "") + (f"&token={token}" if token else "")}
    job = None if new else _render_get(str(d))
    if job and job.state == "cancelled" and not token:
        job = None  # a shared rendition: a new request renders again after a cancel
    if job is None:
        if (d / "index.m3u8").exists() and (token or _stored(d / "index.m3u8", pol) is not None):
            st.update(state="ready", progress=1.0, hit=not token)
            return st
        if token and not new:
            rec = _token_record(token)  # rendering in another API process, or stopped by a restart (failed)
            if rec is None or rec.get("kind") != "hls" or rec.get("item_id") != item_id:
                raise HTTPException(404, f"this playback's rendition is gone (removed {HLS_TMP_MINUTES} minutes after its last use, or cancelled): request the playlist again")
            job = _render_snapshot(rec, d)
            st["job"] = job
            st.update(job.view())
            return st
        job = _render_start(item_id, path, fid, ch, d, pattern, bool(reg), token)
        until = time.time() + HLS_PROBE_WAIT  # a small item is fetched and probed by then: a bad channel is a 400 now
        while not job.probed.wait(0.1) and time.time() < until and not job.total > HLS_PROBE_BYTES:
            pass
    if job.bad_request:  # no audio / video, or not this channel (found after the request, for a long item)
        with _renders_lock:
            if _renders.get(job.key) is job:
                _renders.pop(job.key)
        raise HTTPException(400, job.error or "this item cannot be streamed")
    st["job"] = job
    st.update(job.view())
    if job.state == "ready":
        st.update(state="ready", progress=1.0)
    return st


def _hls_public(st: dict) -> dict:
    out = {k: v for k, v in st.items() if k not in ("dir", "pol", "reg", "job", "hit")}
    out["playable"] = st["state"] == "ready" or bool(st.get("playable"))
    return out


def _hls_playlist_response(item_id: str, st: dict) -> Response:
    d, token, ch, pattern = st["dir"], st["token"], st["channel"], st["pattern"]
    base = f"{pattern}.{ch}" + (f".{token}" if token else "")
    # ?v=: a new rendition gets new segment URLs, so a browser never mixes in cached segments of an older one
    v = (d / "index.m3u8").stat().st_mtime_ns // 1_000_000
    lines = [ln if ln.startswith("#") or not ln.strip() else f"{base}/{ln.strip()}?v={v}" for ln in (d / "index.m3u8").read_text("utf-8").splitlines()]
    return Response("\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl",
                    headers={**_policy_headers(pattern, st["pol"], st["hit"]), "Cache-Control": "no-store"})


def _hls_partial_playlist(st: dict, segs: list[str]) -> Response:
    """The playlist of a render still going: its finished segments as an EVENT playlist without #EXT-X-ENDLIST, so
    the player starts with them and reloads it for more (the finished rendition's playlist is VOD with ENDLIST).
    Every segment but the last of an item is HLS_SEGMENT long (a keyframe is forced at each boundary)."""
    job, token, ch, pattern = st["job"], st["token"], st["channel"], st["pattern"]
    base = f"{pattern}.{ch}" + (f".{token}" if token else "")
    v = int(job.created * 1000)
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", f"#EXT-X-TARGETDURATION:{int(HLS_SEGMENT) + 1}", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT"]
    for s in segs:
        lines += [f"#EXTINF:{HLS_SEGMENT:.6f},", f"{base}/{s}?v={v}"]
    return Response("\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl",
                    headers={**(h := _policy_headers(pattern, st["pol"], False)), "Cache-Control": "no-store", "X-HLS-Partial": "true",
                             "Access-Control-Expose-Headers": h["Access-Control-Expose-Headers"] + ", X-HLS-Partial"})


@router.get("/items/{item_id}/hls/playlist.m3u8", response_model=None)
def hls_playlist(item_id: str, channel: Optional[str] = None, pattern: str = "hls", token: Optional[str] = None, wait: float = HLS_WAIT) -> Response:
    """An HLS (VOD) playlist of an audio or video item: 6-second MPEG-TS segments (H.264 / AAC). The rendition follows
    the pattern's persistence policy: persisted, cached for its TTL, or (recompute) made for one playback — every
    request without a token starts a new one; ?token= reads that playback's rendition, kept until 15 minutes after its
    last segment request. channel: 'all' (default), 'mix' or a 0-based index.

    Rendering runs in the background (at most HLS_WORKERS at once). The request waits up to `wait` seconds (default
    8, at most 25) for the first HLS_START_SEGMENTS segments: a render still going then answers its finished segments
    as a growing EVENT playlist (X-HLS-Partial: true; the player reloads it, the last one is VOD with ENDLIST); before
    that it answers 202 with its state and progress (JSON, Retry-After: 2, Location: the playlist to ask for next) —
    poll /hls/status until `playable`, then load the playlist. A failed render is a 500."""
    st = _hls_state(item_id, channel, pattern, token)
    job = st["job"]
    segs: list[str] = []
    if job is not None and job.state in ("queued", "rendering"):
        until = time.time() + max(0.0, min(float(wait), 25.0))
        while True:
            segs = job.segments()
            if job.done.is_set() or time.time() >= until:
                break
            if len(segs) >= HLS_START_SEGMENTS:  # playable; a render about to finish is waited for (the whole VOD playlist)
                p, el = job.progress, time.time() - (job.started or time.time())
                if p <= 0 or el * (1 - p) / p > 3:
                    break
            job.done.wait(min(0.5, max(0.0, until - time.time())))
        st.update(job.view())
        if job.state == "ready":
            st.update(state="ready", progress=1.0)
    if st["state"] == "ready":
        return _hls_playlist_response(item_id, st)
    if st["state"] == "rendering" and len(segs) >= HLS_START_SEGMENTS:
        return _hls_partial_playlist(st, segs)
    if st["state"] == "failed":
        raise HTTPException(500, f"the HLS render failed: {st.get('error')}")
    if st["state"] == "cancelled":
        raise HTTPException(409, "the HLS render was cancelled")
    return Response(json.dumps(_hls_public(st)), status_code=202, media_type="application/json",
                    headers={"Retry-After": "2", "Cache-Control": "no-store", "Location": st["playlist"], "Access-Control-Expose-Headers": "Location, Retry-After"})


@router.get("/items/{item_id}/hls/status")
def hls_status(item_id: str, channel: Optional[str] = None, pattern: str = "hls", token: Optional[str] = None) -> dict:
    """The state of the item's HLS rendition (queued / rendering with progress, eta_seconds / ready / failed /
    cancelled), starting its render when there is none. Under recompute, the first call (no token) starts a playback
    and returns its token; poll with it, then load `playlist` (relative to /items/{id}/hls/)."""
    return _hls_public(_hls_state(item_id, channel, pattern, token))


@router.delete("/items/{item_id}/hls/render")
def hls_cancel(item_id: str, channel: Optional[str] = None, pattern: str = "hls", token: Optional[str] = None) -> dict:
    """Cancel a queued or running render: ffmpeg is stopped and its temporary files removed. A playback's render
    (recompute) is cancelled with its token; a shared rendition's render needs edit rights on the media set."""
    path, fid, reg, ch, pol, token = _hls_target(item_id, channel, pattern, token)
    if pol["policy"] == "recompute" and not token:
        raise HTTPException(400, "a recompute playback's render is cancelled with its token")
    if not token and fid:
        drive._item(fid, need="editor")
    d = _hls_dir(item_id, pattern, bool(reg), ch, token)
    job = _render_get(str(d))
    if job is None:
        rec = media_jobs.read_record(_record_path(d, token))
        if rec and rec.get("state") in ("queued", "rendering") and media_jobs.owner(rec) == "alive":
            raise HTTPException(409, f"this render runs in another API process (pid {rec.get('pid')}): it can only be cancelled there")
    if not job or not _render_cancel(job):
        raise HTTPException(404, "no HLS render in progress for this rendition")
    job.done.wait(15)
    return {"cancelled": True, **job.view()}


@router.get("/items/{item_id}/hls/{variant}/{segment}", response_model=None)
def hls_segment(item_id: str, variant: str, segment: str) -> Response:
    """A segment of a rendition made by the playlist request."""
    m = re.fullmatch(r"([a-z][a-z0-9_]{0,63})\.(mix|all|\d{1,2})(?:\.([0-9a-f]{32}))?", variant)
    if not m or not re.fullmatch(r"seg_\d{5}\.ts", segment):
        raise HTTPException(404, "no such HLS segment")
    fid = _check_item(item_id)
    reg = _hls_pattern(get(fid), m.group(1))
    d = _hls_dir(item_id, m.group(1), bool(reg), m.group(2), m.group(3))
    data = None
    for _ in range(2):  # the finished rendition, or (a render still going) its finished segments in the .tmp directory
        try:
            data = (d / segment).read_bytes()
            break
        except OSError:
            job = _render_get(str(d))
            tmp = job.tmp if job and job.state == "rendering" else None
            if tmp and segment in job.segments():
                try:
                    data = (tmp / segment).read_bytes()
                    break
                except OSError:  # renamed to the rendition just now: read it there
                    continue
            break
    if data is None:
        raise HTTPException(404, "no such HLS segment (request the playlist again)")
    if m.group(3):  # a playback's rendition: kept HLS_TMP_MINUTES after its last segment request, not after its render
        try:
            os.utime(d)
        except OSError:
            pass
    return Response(data, media_type="video/mp2t", headers={"Cache-Control": "private, max-age=3600" if not m.group(3) else "no-store"})


def resume_jobs() -> dict:
    """The jobs an earlier API process left recorded on this data directory (media_jobs.record): a job whose output
    was finished meanwhile only loses its record; a shared output's interrupted job (an access pattern output or an
    HLS rendition) is queued again; a playback's own computation (recompute, made for one request, which ended with
    the process) is marked failed with RESTART_REASON, which its status and token requests then answer instead of a
    stuck "running". Records of jobs running in another live API process are left alone; failed ones are dropped
    after RESTART_FAILED_KEEP. Runs in the background at startup; returns what it did per record."""
    out = {"found": 0, "requeued": 0, "failed": 0, "dropped": 0, "elsewhere": 0}
    try:
        paths = sorted((DIR / "cache").glob(f"*/*{media_jobs.RECORD_SUFFIX}"))
    except OSError:
        paths = []
    mine = set(media_jobs.recorded())
    for p in paths:
        rec = media_jobs.read_record(p)
        try:
            if rec is None:  # unreadable: a write cut short by the stop
                if time.time() - p.stat().st_mtime > media_jobs.RECORD_STALE:
                    p.unlink(missing_ok=True)
                    out["dropped"] += 1
                continue
            if rec.get("state") == "failed":
                if time.time() - float(rec.get("failed_at") or 0) > RESTART_FAILED_KEEP:
                    p.unlink(missing_ok=True)
                    out["dropped"] += 1
                continue
            who = media_jobs.owner(rec)
            if who == "self" or str(p) in mine:  # this process's own job: only it rewrites / removes the record
                continue
            if who == "alive":
                out["elsewhere"] += 1
                continue
            out[_resume_one(p, rec)] += 1
        except Exception as e:  # noqa: BLE001 - one bad record never stops the others
            log.warning("media job record %s not resumed: %s", p, e)
    if any(out[k] for k in ("found", "requeued", "failed")):
        log.info("media jobs after a restart: %s", out)
    return out


def _stop_all() -> None:
    """The API process is exiting (media_jobs.on_exit): stop every access job and HLS render running here at once (a
    Whisper piece at its next token, ffmpeg killed) instead of the exit waiting for them; their records stay as they
    were, so the next process queues the shared ones again (resume_jobs)."""
    with _ajobs_lock:
        jobs = list(_ajobs.values())
    for j in jobs:
        j.cancel()
    with _renders_lock:
        renders = list(_renders.values())
    for r in renders:
        _render_cancel(r)


media_jobs.on_exit(_stop_all)


def _resume_one(p: Path, rec: dict) -> str:
    kind, item_id, token = rec.get("kind"), rec.get("item_id") or "", rec.get("token")
    if token:  # a playback's own computation: its request is gone
        if kind == "hls" and rec.get("tmp"):
            shutil.rmtree(rec["tmp"], ignore_errors=True)
        media_jobs.write_record(p, {**rec, "state": "failed", "error": RESTART_REASON, "status_code": 409, "failed_at": time.time()})
        return "failed"
    if kind == "access":
        try:
            sp = _access_spec(item_id, rec.get("pattern") or "", **(rec.get("params") or {}), check=False)
        except HTTPException:  # the item, the pattern or its parameters are gone
            p.unlink(missing_ok=True)
            return "dropped"
        pol = sp["pol"]
        if pol["policy"] == "persist" and sp["cache"].exists() or pol["policy"] == "cache" and _stored_fresh(sp["cache"], pol):
            p.unlink(missing_ok=True)
            return "found"
        if not sp["job"] or pol["policy"] == "recompute":
            p.unlink(missing_ok=True)
            return "dropped"
        _job_start(sp, False)
        return "requeued"
    if kind == "hls":
        try:
            path, _ct, fid = _item_meta(item_id, False)
            pattern, ch = rec.get("pattern") or "hls", _channel(rec.get("channel") or "all", True)
            reg = _hls_pattern(get(fid), pattern)
        except HTTPException:
            p.unlink(missing_ok=True)
            return "dropped"
        d = _hls_dir(item_id, pattern, bool(reg), ch)
        pol = _policy(get(fid), pattern)
        if (d / "index.m3u8").exists():
            if rec.get("tmp"):
                shutil.rmtree(rec["tmp"], ignore_errors=True)
            p.unlink(missing_ok=True)
            return "found"
        if pol["policy"] == "recompute":
            if rec.get("tmp"):
                shutil.rmtree(rec["tmp"], ignore_errors=True)
            p.unlink(missing_ok=True)
            return "dropped"
        _render_start(item_id, path, fid, ch, d, pattern, bool(reg))
        return "requeued"
    p.unlink(missing_ok=True)
    return "dropped"


def _check_item(item_id: str) -> Optional[str]:
    """The media set id of an item the caller may read (without reading its bytes)."""
    if not re.fullmatch(r"[0-9a-f]{16}", item_id):
        raise HTTPException(404, "media item not found")
    item = db.drive_get(item_id)
    if item and item["kind"] == "file" and not item.get("trashed_at"):
        drive._item(item_id)
        return item.get("parent_id")
    ix = _reg()["index"].get(item_id)
    if not ix:
        raise HTTPException(404, "media item not found")
    drive._item(ix["fid"])
    return ix["fid"]


def _png(im, width: int) -> bytes:
    im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
    if im.width > width:
        im = im.resize((width, max(1, round(im.height * width / im.width))))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def _compute_pattern(pattern: str, kind: Optional[str], path: str, data: bytes | Path, page: int, layer: Optional[int], width: int, opts: Optional[dict] = None) -> bytes:
    """An access pattern's output from the item's bytes, or (data a Path: an access job's shared source copy) from its
    local file — read by ffmpeg for the audio / video patterns (_compute_av)."""
    import code_media

    from PIL import Image

    opts = opts or {}
    if isinstance(data, Path):
        if kind in ("audio", "video") and pattern in _JOB_PATTERNS:
            return _compute_av(pattern, path, data, width, opts)
        data = data.read_bytes()
    if pattern == "audio":
        return select_channel(data, _ext(path), opts.get("channel") or "mix", opts.get("format") or "wav")
    if pattern == "transcription":
        ch = opts.get("channel") or "mix"
        wav = select_channel(data, _ext(path), ch, "wav")
        try:
            res = code_media.transcribe_audio(wav, opts.get("language"), opts.get("mode") or "more_economical", opts.get("output_format") or "text", False)
        except NotImplementedError as e:
            raise HTTPException(501, str(e)) from None
        if (opts.get("output_format") or "text") == "segments":
            return json.dumps({**json.loads(res), "channel": ch}).encode()
        return json.dumps({"channel": ch, "language": opts.get("language"), "text": res}).encode()
    if pattern == "waveform" and opts.get("channel"):
        return json.dumps({"peaks": code_media._waveform(select_channel(data, _ext(path), opts["channel"], "wav"), "wav", 50), "channel": opts["channel"]}).encode()

    if pattern == "thumbnail":
        if kind == "image":
            return _png(Image.open(io.BytesIO(data)), width)
        if kind == "document" and _ext(path) == "pdf":
            pattern = "page"
        elif kind == "video":
            pattern = "frame"
        elif kind == "dicom":
            pattern = "dicom"
        else:
            raise HTTPException(404, f"no thumbnail for {kind or 'this'} media")
    if pattern == "page":
        imgs = code_media._doc_to_images(data, page, page + 1, width, None, "png")
        if not imgs:
            raise HTTPException(404, "no such page")
        return imgs[0][1]
    if pattern == "frame":
        return _png(Image.open(io.BytesIO(code_media._ffmpeg(data, _ext(path), ["-ss", "0", "-frames:v", "1"], "png", pre=True))), width)
    if pattern == "waveform":
        return json.dumps({"peaks": code_media._waveform(data, _ext(path), 50)}).encode()
    if pattern == "sheets":
        return code_media.spreadsheet_json(data).encode()
    if pattern == "email":
        import email
        import email.policy

        m = email.message_from_bytes(data, policy=email.policy.default)
        body = m.get_body(preferencelist=("plain", "html"))
        return json.dumps({"from": m.get("From"), "to": m.get("To"), "subject": m.get("Subject"), "date": m.get("Date"),
                           "body": body.get_content() if body else "", "attachments": [a.get_filename() for a in m.iter_attachments()]}).encode()
    if pattern == "dicom":
        return _png(code_media.dicom_layer_image(data, layer), width)
    if pattern == "text":
        return json.dumps({"pages": code_media._pdf_text(data)}).encode()
    raise HTTPException(404, "unknown access pattern")


# ------------------------------------------------------------------------------------------------
# conversion of additional input formats
# ------------------------------------------------------------------------------------------------


def convert(data: bytes, src: str, dst: str) -> bytes:
    """An additional input format to the media set's primary format."""
    record_usage(None, "convert_input_format", len(data))
    if dst in SCHEMAS["image"]["formats"]:
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        fmt = {"jpg": "JPEG", "tiff": "TIFF", "png": "PNG", "bmp": "BMP"}[dst]
        if fmt == "JPEG" and im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        b = io.BytesIO()
        im.save(b, fmt)
        return b.getvalue()
    if dst in _AUDIO or dst in _VIDEO:
        import code_media

        return code_media._ffmpeg(data, src, [], dst)
    if dst == "pdf":
        return text_pdf(_document_text(data, src))
    raise HTTPException(400, f"cannot convert .{src} to .{dst}")


def _document_text(data: bytes, src: str) -> list[str]:
    import zipfile

    if src == "txt":
        return data.decode("utf-8", "replace").splitlines()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if src == "docx":
            xml = z.read("word/document.xml").decode("utf-8", "replace")
            return [re.sub(r"<[^>]+>", "", p) for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)] or [""]
        slides = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))
        lines: list[str] = []
        for i, n in enumerate(slides, 1):
            xml = z.read(n).decode("utf-8", "replace")
            lines += [f"Slide {i}", *[t for t in re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)], "\f"]
        return lines


def text_pdf(lines: list[str]) -> bytes:
    """A plain PDF of text lines (Helvetica 10 pt, A4, wrapped; '\\f' starts a new page)."""
    import textwrap

    wrapped: list[str] = []
    for line in lines:
        if line == "\f":
            wrapped.append("\f")
            continue
        wrapped += textwrap.wrap(line.replace("\t", "    "), 95) or [""]
    pages: list[list[str]] = [[]]
    for w in wrapped:
        if w == "\f" or len(pages[-1]) >= 64:
            pages.append([])
            if w == "\f":
                continue
        pages[-1].append(w)
    pages = [p for p in pages if p] or [[""]]

    def esc(t: str) -> str:
        t = t.encode("latin-1", "replace").decode("latin-1")
        return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    objs: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    kids = []
    for p in pages:
        stream = "BT /F1 10 Tf 12 TL 50 800 Td " + " ".join(f"({esc(l)}) Tj T*" for l in p) + " ET"
        objs.append(f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream".encode("latin-1"))
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>".encode())
        kids.append(len(objs))
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


# ------------------------------------------------------------------------------------------------
# retention
# ------------------------------------------------------------------------------------------------


def apply_retention(fid: str) -> dict:
    """Permanently delete items older than max_age_days and versions overwritten more than overwritten_days ago."""
    s = get(fid)
    if not s:
        return {"deleted": 0, "versions": 0}
    ret = s.get("retention") or {}
    now = datetime.now(timezone.utc)
    deleted = versions = 0
    with _lock:
        if ret.get("max_age_days"):
            cutoff = now - timedelta(days=float(ret["max_age_days"]))
            for c in db.drive_list(fid):
                if c["kind"] == "file" and not c.get("trashed_at") and c["created_at"] < cutoff:
                    drive._delete_contents(db.drive_delete(c["id"], drive._now()))
                    media_jobs.drop(c["id"])
                    deleted += 1
        r = _reg()
        for path, entries in list((r["versions"].get(fid) or {}).items()):
            keep = []
            for e in entries:
                gone = False
                if ret.get("max_age_days") and e.get("uploaded_at") and datetime.fromisoformat(e["uploaded_at"]) < now - timedelta(days=float(ret["max_age_days"])):
                    gone = True
                if ret.get("overwritten_days") and datetime.fromisoformat(e["at"]) < now - timedelta(days=float(ret["overwritten_days"])):
                    gone = True
                if gone:
                    (DIR / "versions" / e["item_id"]).unlink(missing_ok=True)
                    shutil.rmtree(DIR / "cache" / e["item_id"], ignore_errors=True)
                    media_jobs.drop(e["item_id"])
                    r["index"].pop(e["item_id"], None)
                    versions += 1
                else:
                    keep.append(e)
            if keep:
                r["versions"][fid][path] = keep
            else:
                r["versions"].get(fid, {}).pop(path, None)
        if ret.get("max_age_days"):
            cutoff_s = (now - timedelta(days=float(ret["max_age_days"]))).isoformat()
            for path, v in list((r["virtual"].get(fid) or {}).items()):
                if v["registered_at"] < cutoff_s:
                    r["virtual"][fid].pop(path)
                    media_jobs.drop(v["id"])
                    r["index"].pop(v["id"], None)
                    deleted += 1
        _save(r)
    return {"deleted": deleted, "versions": versions}


@router.post("/{fid}/retention/apply")
def retention_now(fid: str) -> dict:
    _require(fid, "editor")
    return apply_retention(fid)


def _retention_loop() -> None:
    while True:
        time.sleep(RETENTION_TICK)
        try:
            for fid, s in list(_reg()["sets"].items()):
                if (s.get("retention") or {}).get("max_age_days") or (s.get("retention") or {}).get("overwritten_days"):
                    apply_retention(fid)
        except Exception:  # noqa: BLE001
            log.exception("media set retention failed")
