"""Fusion: collaborative spreadsheets on Foundry data (Analytics doc 09 "Fusion").

A Fusion document is a Files item (content type FUSION_MIME, so Projects, folders and markings govern access) holding
sheets of cells. A cell keeps what was typed (`input`), an optional format, a lock and a dropdown selection; values are
computed on the server by fusion_formula.py, so a synced dataset gets the same numbers the sheet shows.

- Formulas: Fusion syntax and function library (fusion_formula.py), `lookup*` on Files datasets (by name or ID, at
  most 2,000 results), `object_lookup` / `object_dropdown` on Ontology objects (at most 200), the object functions
  (`object`, `object_set` on saved explorations and object lists, `get_property`, `get_object_rid` …) read as the caller.
- Table regions: a header row and data rows; sort (rearranges the rows, like Fusion), append a row (pushes the cells
  below down), submit rows from `action.submit_to_region`, and sync to a dataset (a Parquet file next to the document,
  rewritten whenever the table's values change).
- Actions: buttons from `action.*` formulas run on the server (copy, toast, submit to a region, serial / parallel
  chains with validations, Ontology actions); `submit_to_region_with_*` buttons write rows by key into a table region of
  this or another document the caller can edit.
- Edit history: snapshots (automatic every 10 minutes of editing, or manual) to compare and restore.
- Templates: opening a template makes a copy; `copy` takes cell overrides (Sheet1!A1=value).
- Import XLSX: a workbook becomes a document (formulas kept, Excel's double quotes turned into single quotes).
- Locked cells refuse edits until unlocked; presentation view and a hidden grid are document settings.
- Saving: a document in S3 is saved to a local write-ahead file and written to S3 in the background (see "storage"),
  so a cell edit answers in milliseconds; reads never go back to S3 while this process' copy is the newest.

Mounted by server.py under /api/fusion.
"""

from __future__ import annotations

import atexit
import base64
import binascii
import contextlib
import copy
import hashlib
import io
import json
import logging
import os
import threading
import time
import uuid
import zlib
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import fusion_formula as F
import fusion_index

router = APIRouter(prefix="/api/fusion")
router.include_router(fusion_index.router)  # /api/fusion/indexes: dataset indexes for lookups

FUSION_MIME = "application/vnd.bluesandai.fusion+json"
MAX_CELLS = 100_000
HISTORY_KEPT = 100
AUTO_SNAPSHOT = timedelta(minutes=10)
DIR = Path()
_lock = threading.RLock()
log = logging.getLogger(__name__)


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "fusion"
    (DIR / "history").mkdir(parents=True, exist_ok=True)
    (DIR / "sources").mkdir(parents=True, exist_ok=True)
    _wal_dir().mkdir(parents=True, exist_ok=True)
    fusion_index.configure(data_dir)
    with _docs_lock:
        _docs.clear()
    _recover()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _who() -> str:
    me = auth.current() or {}
    return me.get("username") or "local"


def _new_sheet(name: str) -> dict:
    return {"id": f"sh-{uuid.uuid4().hex[:8]}", "name": name, "cells": {}, "tables": [], "col_widths": {}}


def _blank() -> dict:
    return {"version": 1, "sheets": [_new_sheet("Sheet1")], "settings": {"presentation": False, "hide_grid": False, "auto_update": True},
            "template": False}


# ------------------------------------------------------------------ storage (Files items)


def _item(item_id: str, need: str = "viewer") -> dict:
    import drive

    item = drive._item(item_id, need=need)
    if item.get("kind") != "file" or item.get("content_type") != FUSION_MIME:
        raise HTTPException(404, "Fusion document not found")
    return item


def _stamp(data: bytes) -> str:
    """What a stored document is recognised by (the region cache is valid for exactly these bytes)."""
    return hashlib.sha1(data).hexdigest()


# Write-behind for documents whose content is in S3 (an S3 write takes ~0.5 s, a read ~0.3 s):
# - A save writes the new bytes to a local write-ahead file (fusion/wal/<id>.json: a temporary file, fsynced, renamed
#   over the previous one) and fusion/wal/<id>.stamp (the bytes' SHA-1), sets the Files revision (updated_at, size)
#   and answers. A background thread then writes the newest bytes to S3: rapid edits coalesce (a flush waits
#   FLUSH_DELAY seconds and always takes the newest file), failures are retried with a growing pause (at most
#   FLUSH_RETRY_MAX), the write-ahead file is removed only when S3 holds exactly its bytes, everything pending is
#   flushed on shutdown, and the files a crash left behind are flushed when the API next starts.
# - Reads: this process' copy while it still is the newest stored version (its stamp is the stamp file's and the
#   Files revision is the one it was stored under), else the write-ahead file (never older than S3), else S3.
# - Several API processes sharing the data directory share fusion/wal, so each reads the newest revision any of them
#   saved. An edit (load → change → store) holds a lock shared by every process (a byte-range lock on
#   fusion/wal/locks, which the operating system releases with a crashed process), so edits of one document through
#   different processes run one after the other instead of overwriting each other; the flushes of a document hold
#   another such lock, one at a time across processes, so S3 only ever moves forward to a newer version.
# - Not covered: Files' own readers of the raw content (download, presigned links) see a save once it is flushed
#   (normally within a second); a document deleted while its flush runs may leave its S3 object behind.
WRITE_BEHIND = os.environ.get("BLUESANDAI_FUSION_WRITE_BEHIND", "on").lower() not in ("0", "off", "false", "no")
FLUSH_DELAY = float(os.environ.get("BLUESANDAI_FUSION_FLUSH_DELAY", "0.25"))  # seconds a flush waits for more edits
FLUSH_RETRY_MAX = 60.0  # seconds: the longest pause between flush attempts of a document that failed
LOCK_WAIT = 30.0  # seconds an edit waits for another process' edit of the same document before answering 503
DOCS_KEPT = 64  # documents whose newest bytes this process keeps
FLUSH_STATS = {"flushed": 0, "coalesced": 0, "failed": 0, "recovered": 0, "kept_hits": 0, "wal_reads": 0, "s3_reads": 0}
_docs: "OrderedDict[str, tuple[str, bytes, Optional[str]]]" = OrderedDict()  # id → (stamp, bytes, Files revision)
_docs_lock = threading.Lock()
_DOC, _FLUSH = 0, 1  # the two shared locks of a document: its edits, its S3 flushes
_LOCK_SLOTS = 1 << 20


def _wal_dir() -> Path:
    return DIR / "wal"


def _rev(item: Optional[dict]) -> Optional[str]:
    """The Files revision of a document (what co-editors compare)."""
    return str(item["updated_at"]) if item and item.get("updated_at") is not None else None


def _read_file(p: Path) -> Optional[bytes]:
    """A file another process may be renaming over at this moment (Windows refuses the open meanwhile); None: none."""
    for _ in range(200):
        try:
            return p.read_bytes()
        except FileNotFoundError:
            return None
        except PermissionError:
            time.sleep(0.005)
    return p.read_bytes()


def _write_file(p: Path, data: bytes, sync: bool) -> None:
    """Replace a file in one step (a reader sees the old or the new bytes, never a part)."""
    tmp = p.with_name(f"{p.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        if sync:
            f.flush()
            os.fsync(f.fileno())
    for _ in range(200):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:  # Windows: a reader has the file open for a moment
            time.sleep(0.005)
    os.replace(tmp, p)


def _remove_file(p: Path) -> None:
    for _ in range(200):
        try:
            p.unlink()
            return
        except FileNotFoundError:
            return
        except PermissionError:  # Windows: a reader has the file open for a moment
            time.sleep(0.005)
    p.unlink(missing_ok=True)


# ---- locks shared by every process using the data directory: byte-range locks on fusion/wal/locks

_xl_sys = threading.Lock()  # one lock / unlock call at a time (they move the shared file position)
_xl_fds: dict[str, int] = {}
_xl_threads: dict[tuple[str, int], list] = {}  # (lock file, byte) → [threading.Lock, users]
_xl_tls = threading.local()


def _xl_call(path: str, offset: int, lock: bool) -> bool:
    with _xl_sys:
        fd = _xl_fds.get(path)
        if fd is None:
            fd = _xl_fds[path] = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, offset, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK if lock else msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.lockf(fd, (fcntl.LOCK_EX | fcntl.LOCK_NB) if lock else fcntl.LOCK_UN, 1, offset, os.SEEK_SET)
            return True
        except OSError:
            if not lock:
                raise
            return False


@contextlib.contextmanager
def _xlock(item_id: str, which: int, wal_dir: Optional[Path] = None) -> Iterator[None]:
    """A document's lock (`_DOC` or `_FLUSH`) shared with every process using the data directory; reentrant in a
    thread. 503 when another process holds it longer than LOCK_WAIT."""
    path = str((wal_dir or _wal_dir()) / "locks")
    key = (path, (zlib.crc32(item_id.encode()) % _LOCK_SLOTS) * 2 + which)
    held = _xl_tls.__dict__.setdefault("held", {})
    if held.get(key):
        held[key] += 1
        try:
            yield
        finally:
            held[key] -= 1
        return
    with _xl_sys:
        entry = _xl_threads.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    busy = HTTPException(503, "the document is being saved by another server process: try again in a moment")
    try:
        deadline = time.monotonic() + LOCK_WAIT
        if not entry[0].acquire(timeout=LOCK_WAIT):
            raise busy
        try:
            wait = 0.001
            while not _xl_call(key[0], key[1], True):
                if time.monotonic() > deadline:
                    raise busy
                time.sleep(wait)
                wait = min(wait * 2, 0.02)
            held[key] = 1
            try:
                yield
            finally:
                held.pop(key, None)
                _xl_call(key[0], key[1], False)
        finally:
            entry[0].release()
    finally:
        with _xl_sys:
            entry[1] -= 1
            if not entry[1]:
                _xl_threads.pop(key, None)


@contextlib.contextmanager
def _editing(item: dict) -> Iterator[None]:
    """One edit of a document (load, change, store): this process' edits one at a time, and the document's lock
    shared with the other API processes."""
    with _lock, _xlock(item["id"], _DOC):
        yield


# ---- the newest stored bytes


def _keep(item_id: str, stamp: str, data: bytes, rev: Optional[str]) -> None:
    with _docs_lock:
        _docs[item_id] = (stamp, data, rev)
        _docs.move_to_end(item_id)
        while len(_docs) > DOCS_KEPT:
            _docs.popitem(last=False)


def _stored_bytes(item: dict) -> bytes:
    """The newest stored bytes of a document: S3 only when neither this process' copy nor a write-ahead file is."""
    import drive

    iid, rev = item["id"], _rev(item)
    if not (WRITE_BEHIND and item.get("stored_in") == "s3") and not (_wal_dir() / f"{iid}.json").exists():
        return drive.read_bytes(item)  # (a write-ahead file left while write-behind was on is still the newest)
    auth.check_item(item)  # what drive.read_bytes checks
    newest = _read_file(_wal_dir() / f"{iid}.stamp")
    newest_stamp = newest.decode("ascii", "replace") if newest else None
    with _docs_lock:
        kept = _docs.get(iid)
    if kept and newest_stamp and kept[0] == newest_stamp and kept[2] == rev:
        FLUSH_STATS["kept_hits"] += 1
        return kept[1]
    data = _read_file(_wal_dir() / f"{iid}.json")
    if data is not None:
        FLUSH_STATS["wal_reads"] += 1
    else:
        FLUSH_STATS["s3_reads"] += 1
        data = drive.read_bytes(item)
    if newest_stamp and _stamp(data) == newest_stamp:
        _keep(iid, newest_stamp, data, rev)
    return data


def _load_stamped(item: dict) -> tuple[dict, str]:
    try:
        data = _stored_bytes(item)
        doc = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(500, "the Fusion document is not readable") from None
    doc.setdefault("settings", {})
    for s in doc["sheets"]:
        s.setdefault("cells", {})
        s.setdefault("tables", [])
    return doc, _stamp(data)


def _load(item: dict) -> dict:
    return _load_stamped(item)[0]


def _store(item: dict, doc: dict) -> str:
    """Store the document; returns the stamp of the stored bytes. A document in S3 is written behind: the write-ahead
    file and the Files revision now, S3 in the background."""
    import db
    import drive
    import pipeline_datasets

    data = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    stamp = _stamp(data)
    iid = item["id"]
    if not (WRITE_BEHIND and item.get("stored_in") == "s3"):
        # written straight to storage; a write-ahead file still pending (write-behind was on) is older: retired, and
        # the flush lock keeps a flush of it from overwriting these bytes afterwards
        with _xlock(iid, _DOC), _xlock(iid, _FLUSH):
            pipeline_datasets._replace_content(item, data, FUSION_MIME)
            for p in (_wal_dir() / f"{iid}.json", _wal_dir() / f"{iid}.stamp"):
                _remove_file(p)
        with _docs_lock:
            _docs.pop(iid, None)
        return stamp
    with _xlock(iid, _DOC):
        _write_file(_wal_dir() / f"{iid}.json", data, sync=True)
        _write_file(_wal_dir() / f"{iid}.stamp", stamp.encode("ascii"), sync=False)
        db.drive_update(iid, drive._now(), size_bytes=len(data), content_type=FUSION_MIME)
        rev = _rev(db.drive_get(iid))
    _keep(iid, stamp, data, rev)
    _flush_soon(_wal_dir(), iid)
    return stamp


# ---- the background flush to S3

_flush_cv = threading.Condition()
_flush_due: dict[tuple[str, str], tuple[float, int]] = {}  # (write-ahead directory, id) → (when, failed attempts)
_flusher: Optional[threading.Thread] = None


def _flush_soon(wal_dir: Path, item_id: str, delay: Optional[float] = None, attempts: int = 0) -> None:
    global _flusher
    key = (str(wal_dir), item_id)
    when = time.monotonic() + (FLUSH_DELAY if delay is None else delay)
    with _flush_cv:
        cur = _flush_due.get(key)
        if cur and not attempts:
            FLUSH_STATS["coalesced"] += 1
            when = min(when, cur[0]) if not cur[1] else cur[0]  # a document waiting for a retry keeps its pause
            attempts = cur[1]
        _flush_due[key] = (when, attempts)
        if _flusher is None or not _flusher.is_alive():
            _flusher = threading.Thread(target=_flush_loop, name="fusion-flush", daemon=True)
            _flusher.start()
        _flush_cv.notify()


def _flush_loop() -> None:
    while True:
        with _flush_cv:
            while True:
                now = time.monotonic()
                due = [k for k, (w, _) in _flush_due.items() if w <= now]
                if due:
                    break
                nxt = min((w for w, _ in _flush_due.values()), default=None)
                _flush_cv.wait(None if nxt is None else max(0.001, nxt - now))
            jobs = [(k, _flush_due.pop(k)[1]) for k in due]
        for (d, iid), attempts in jobs:
            try:
                done = _flush_one(Path(d), iid)
            except Exception as e:  # noqa: BLE001 - kept in the write-ahead file and tried again
                FLUSH_STATS["failed"] += 1
                pause = min(FLUSH_RETRY_MAX, 0.5 * 2 ** attempts)
                log.warning("fusion %s: writing to S3 failed (%s); trying again in %.1f s", iid, e, pause)
                _flush_soon(Path(d), iid, pause, attempts + 1)
                continue
            if not done:  # newer bytes arrived meanwhile
                _flush_soon(Path(d), iid, 0.05)


def _put_s3(item_id: str, data: bytes) -> None:
    """One PUT (no transfer thread pool, so it works in the exit flush too)."""
    import storage

    storage._s3().put_object(Bucket=storage._bucket(), Key=f"drive/{item_id}", Body=data, ContentType=FUSION_MIME)


def _flush_one(wal_dir: Path, item_id: str) -> bool:
    """Write a document's newest write-ahead bytes to S3 (the document's flushes one at a time across processes);
    True when nothing is pending any more."""
    import db
    import drive

    wal = wal_dir / f"{item_id}.json"
    # the flush lock is never held while waiting for the edit lock (an edit may hold its edit lock and flush)
    with _xlock(item_id, _FLUSH, wal_dir):
        data = _read_file(wal)
        if data is None:
            return True
        row = db.drive_get(item_id)
        if row and row["kind"] == "file":
            if row.get("stored_in") == "s3":
                _put_s3(item_id, data)
            else:
                (drive.LOCAL_DIR / item_id).write_bytes(data)
            FLUSH_STATS["flushed"] += 1
        else:
            log.warning("fusion %s: the document was deleted before its last save reached storage", item_id)
    # unchanged since: storage holds these bytes or (a later flush's) newer ones
    with _xlock(item_id, _DOC, wal_dir):
        if _read_file(wal) != data:
            return False
        try:
            wal.unlink()
        except PermissionError:  # Windows: a reader has it open; storage already holds these bytes
            return False
        return True


def pending() -> list[str]:
    """The documents whose newest save is not in S3 yet."""
    d = _wal_dir()
    return sorted(p.stem for p in d.glob("*.json")) if d.is_dir() else []


def flush_all() -> list[str]:
    """Write every pending document to S3 now (shutdown, tests); returns those still pending."""
    d = _wal_dir()
    for iid in pending():
        for attempt in range(3):
            try:
                if _flush_one(d, iid):
                    break
            except Exception as e:  # noqa: BLE001 - stays in its write-ahead file for the next start
                log.warning("fusion %s: writing to S3 failed (%s)", iid, e)
                time.sleep(0.2 * (attempt + 1))
    return pending()


def _recover() -> None:
    """Saves a stopped or crashed process left in write-ahead files: written to S3 in the background."""
    for p in _wal_dir().glob("*.tmp"):
        with contextlib.suppress(OSError):
            if time.time() - p.stat().st_mtime > 3600:  # an interrupted write (the file it was replacing is intact)
                p.unlink()
    for iid in pending():
        FLUSH_STATS["recovered"] += 1
        _flush_soon(_wal_dir(), iid, 0)


def _shutdown_flush() -> None:
    if DIR != Path() and pending():
        left = flush_all()
        if left:
            log.warning("fusion: %d document(s) not written to S3 yet; written when the API starts again", len(left))


router.on_shutdown.append(_shutdown_flush)
atexit.register(_shutdown_flush)


def _check(doc: dict) -> None:
    if sum(len(s["cells"]) for s in doc["sheets"]) > MAX_CELLS:
        raise HTTPException(413, f"a document holds at most {MAX_CELLS:,} cells")
    names = [s["name"] for s in doc["sheets"]]
    if len(set(n.lower() for n in names)) != len(names):
        raise HTTPException(400, "sheet names must be unique")
    for s in doc["sheets"]:
        for a in s["cells"]:
            if not F.CELL.match(a):
                raise HTTPException(400, f"{a} is not a cell address")


# ------------------------------------------------------------------ evaluation


def _datasets(name: str) -> tuple[list[str], list[dict], dict]:
    import drive
    import workshop

    item = None
    try:
        item = drive._item(name)
    except HTTPException:
        low = name.lower()
        item = next((d for d in workshop.datasets() if d["name"].lower() in (low, f"{low}.parquet")), None)
    if not item:
        raise F.FusionError(f"no dataset {name}")
    cols, _types, rows = workshop._dataset_rows(item["id"])
    return cols, rows, {"id": item["id"], "name": item["name"], "updated_at": str(item.get("updated_at"))}


def _lookup_datasets():
    """One evaluation's dataset reader: a dataset with an up-to-date index (fusion_index) is looked up through it,
    any other dataset is read whole, once, and only when a lookup scans it. Each source entry says how its lookups
    ran ("index": the index's status, "lookup": the counts)."""
    import drive
    import workshop

    seen: dict[str, tuple[list[str], Any, dict]] = {}

    def get(name: str) -> tuple[list[str], Any, dict]:
        key = name.lower()
        if key in seen:
            return seen[key]
        try:
            item = drive._item(name)
        except HTTPException:
            low = name.lower()
            item = next((d for d in workshop.datasets() if d["name"].lower() in (low, f"{low}.parquet")), None)
            if not item:
                raise F.FusionError(f"no dataset {name}") from None
            item = drive._item(item["id"])  # the caller reads the dataset: markings and the Project role
        if item["id"] in seen:  # the same dataset by another name (its id, its name with or without .parquet)
            seen[key] = seen[item["id"]]
            return seen[key]
        info = {"id": item["id"], "name": item["name"], "updated_at": str(item.get("updated_at"))}
        src = fusion_index.source(item)
        info["index"] = fusion_index.summary(item)
        load = lambda: workshop._dataset_rows(item["id"])[2]  # noqa: E731
        if src is None:
            cols, _types, rows = workshop._dataset_rows(item["id"])
            load = lambda: rows  # noqa: E731
        else:
            cols = src.columns
        info["columns"] = cols
        seen[key] = seen[item["id"]] = (cols, fusion_index.Rows(cols, src, load, info), info)
        return seen[key]

    return get


# ------------------------------------------------------------------ object reads, kept between recalculations
#
# object(), object_set(), object_lookup / object_dropdown(type) read the Ontology as the caller. What they read is kept
# in this process between recalculations (and between documents) under
#   (who is reading: the whole principal — id, role, markings, groups, attributes, scope — what is read, its filters)
# so an entry is never shared by two users, nor by one user whose markings, groups or attributes changed. An entry
# remembers the stored files it was computed from — the objects of every object type it read (ontology.objects_stat:
# changes whenever the objects change, in this or another process), those object types' and link types' definitions
# (security policies included), the join table links, the exploration or list record — and is used only while all of
# them are unchanged; the object types' markings, Project and ontology roles are checked again on every use (they live
# in the auth store, not in those files). Object types whose properties come from additional datasources, explorations
# on interfaces, semantic search or derived query properties, and reads in a scenario or a function-run snapshot are
# never kept. A read that fails is never kept. Hits skip the usage accounting a fresh search records.

_KEPT_MAX = 4096  # entries (an entry holds one object or at most 200)
_kept_objects: "OrderedDict[tuple, tuple]" = OrderedDict()
_kept_lock = threading.Lock()
KEPT_STATS = {"hits": 0, "misses": 0, "stale": 0, "uncacheable": 0, "errors": 0}
_type_names: dict[str, tuple[str, Any]] = {}  # lower-cased name / API name / id -> (object type id, folder signature)


class _Deps:
    __slots__ = ("files", "types", "checks", "ok", "seen")

    def __init__(self) -> None:
        self.files: set[Path] = set()  # stored files whose (mtime, size) must not change
        self.types: set[str] = set()  # object types whose objects must not change (ontology.objects_stat)
        self.checks: set[str] = set()  # object types whose access is checked again on every use
        self.ok = True
        self.seen: set[tuple] = set()


def _fsig(p: Path) -> Optional[tuple]:
    import os

    try:
        st = os.stat(p)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _deps_sig(d: _Deps) -> tuple:
    import ontology

    files = tuple((str(p), _fsig(p)) for p in sorted(d.files, key=str))
    types = tuple((tid, tuple(sorted((ontology.objects_stat(tid) or {}).items()))) for tid in sorted(d.types))
    return files, types


def _viewer_key() -> Optional[str]:
    """Who reads, for the kept object reads: None when nothing may be kept (a scenario, a function-run snapshot)."""
    import ontology

    if ontology.SCENARIO.get() or ontology.SNAPSHOT.get():
        return None
    p = auth.current()
    text = json.dumps([auth.enabled(), p], sort_keys=True, default=lambda x: sorted(map(str, x)) if isinstance(x, (set, frozenset)) else str(x))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _type_deps(d: _Deps, tid: str, check: bool = False, derived: bool = True) -> None:
    """An object type read with its objects: its definition, its objects, and (`derived`) what its derived properties
    read through links."""
    import ontology

    if check:
        d.checks.add(tid)
    if (tid, derived) in d.seen:
        return
    d.seen.add((tid, derived))
    p = ontology._path("object-types", tid)
    d.files.add(p)
    d.types.add(tid)
    if not derived:
        return
    t = ontology._read(p) or {}
    if t.get("additional_datasources"):
        d.ok = False  # properties merged from datasets at read time
    for prop in t.get("properties") or []:
        for hop in (prop.get("derived") or {}).get("links") or []:
            _link_deps(d, hop.get("link_type_id"))


def _link_deps(d: _Deps, ltid: Optional[str]) -> Optional[dict]:
    """A link type followed: its definition, its join table links, the objects of both sides (and the backing type)."""
    import ontology

    if not ltid:
        d.ok = False
        return None
    p = ontology._path("link-types", ltid)
    d.files.add(p)
    lt = ontology._read(p)
    if not lt:
        return None
    d.files.add(ontology.DIR / "links" / f"{ltid}.json")
    for tid in ((lt.get("source") or {}).get("object_type_id"), (lt.get("target") or {}).get("object_type_id"), (lt.get("backing") or {}).get("object_type_id")):
        if tid:
            _type_deps(d, tid, derived=False)
    return lt


def _fresh(val: tuple) -> tuple:
    """A kept (type, object | objects) handed out: the objects and their properties copied (cells never share them)."""
    t, objs = val
    one = lambda o: {**o, "properties": dict(o.get("properties") or {})}  # noqa: E731
    return t, ([one(o) for o in objs] if isinstance(objs, list) else one(objs))


def _kept(key: tuple, deps: Callable[[_Deps], None], compute: Callable[[], tuple]) -> tuple:
    """compute(), or what an earlier identical read by the same viewer gave while nothing it read has changed."""
    import ontology

    viewer = _viewer_key()
    if viewer is None:
        KEPT_STATS["uncacheable"] += 1
        return compute()
    k = (viewer, *key)
    with _kept_lock:
        entry = _kept_objects.get(k)
    if entry is not None:
        d, sig, val = entry
        for tid in sorted(d.checks):
            ontology._object_type(tid)  # the type's markings, Project and ontology roles, as a fresh read checks them
        if _deps_sig(d) == sig:
            with _kept_lock:
                if k in _kept_objects:
                    _kept_objects.move_to_end(k)
            KEPT_STATS["hits"] += 1
            return _fresh(val)
        KEPT_STATS["stale"] += 1
    d = _Deps()
    try:
        deps(d)
    except (HTTPException, OSError, KeyError, TypeError, AttributeError):
        d.ok = False
    sig = _deps_sig(d) if d.ok else None  # taken before reading: a change while reading makes the entry stale
    try:
        val = compute()
    except Exception:
        KEPT_STATS["errors"] += 1  # a failed read is never kept (and a stale entry for it goes)
        with _kept_lock:
            _kept_objects.pop(k, None)
        raise
    KEPT_STATS["misses"] += 1
    if not d.ok:
        KEPT_STATS["uncacheable"] += 1
        return val
    with _kept_lock:
        _kept_objects[k] = (d, sig, _fresh(val))
        _kept_objects.move_to_end(k)
        while len(_kept_objects) > _KEPT_MAX:
            _kept_objects.popitem(last=False)
    return val


def kept_clear() -> None:
    with _kept_lock:
        _kept_objects.clear()
        _type_names.clear()


def _filters_key(filters: list[dict]) -> str:
    return json.dumps(filters, sort_keys=True, default=str)


def _objects(type_ref: str, filters: list[dict]) -> tuple[dict, list[dict]]:
    import ontology_explorer as ox

    t = _object_type_named(type_ref)

    def read() -> tuple[dict, list[dict]]:
        res = ox.search(ox.SearchIn(object_type_id=t["id"], filters=[ox.Filter(**f) for f in filters], limit=200, histograms=False, resource="fusion"))
        return t, res["objects"]

    try:
        return _kept(("search", t["id"], _filters_key(filters)), lambda d: _type_deps(d, t["id"], check=True), read)
    except HTTPException as e:
        raise F.FusionError(str(e.detail)) from None


def _object_type_named(type_ref: str) -> dict:
    """An object type by ID, API name or display name (the first created that matches). The name -> ID resolution is
    kept until the object types folder changes (a type created, saved or deleted)."""
    import ontology

    low = type_ref.lower()
    folder = ontology.DIR / "object-types"
    sig = (str(folder), _fsig(folder))
    hit = _type_names.get(low)
    if hit and hit[1] == sig:
        try:
            t = ontology._read(ontology._path("object-types", hit[0]))
        except HTTPException:
            t = None
        if t and low in (t["id"].lower(), t["api_name"].lower(), t["display_name"].lower()):
            return t
    t = next((x for x in ontology._all("object-types") if low in (x["id"].lower(), x["api_name"].lower(), x["display_name"].lower())), None)
    if not t:
        raise F.FusionError(f"no object type {type_ref}")
    if len(_type_names) > 10_000:
        _type_names.clear()
    _type_names[low] = (t["id"], sig)
    return t


def _object_get(type_ref: str, pk: str) -> tuple[dict, dict]:
    """object(rid): one object, read as the caller (the object type's markings, object security, hidden properties)."""
    import ontology

    tid = _object_type_named(type_ref)["id"]

    def read() -> tuple[dict, dict]:
        t = ontology._object_type(tid)
        obj = ontology._objects(t["id"]).get(str(pk))
        if obj is None or not ontology._can_see(t, obj):
            raise F.FusionError(f"no {t['display_name']} object {pk}")
        return t, ontology._public_object(t, str(pk), obj)

    try:
        return _kept(("object", tid, str(pk)), lambda d: _type_deps(d, tid, check=True), read)
    except HTTPException as e:
        raise F.FusionError(str(e.detail)) from None


_SET_RID = "ri.object-set.main."


def _set_deps(d: _Deps, kind: str, rec: dict) -> None:
    import ontology

    if kind == "list":
        d.files.update({ontology._path("object-lists", rec["id"]), ontology.DIR / "object-lists"})
        _type_deps(d, rec["object_type_id"], check=True)
        return
    # the exploration record, and the folder: a newer exploration of the same name is found first
    d.files.update({ontology._path("explorations", rec["id"]), ontology.DIR / "explorations"})
    spec = rec.get("spec") or {}
    if spec.get("semantic") or spec.get("interface_id") or spec.get("with_properties") or not spec.get("object_type_id"):
        d.ok = False
        return
    _type_deps(d, spec["object_type_id"], check=True)
    for step in spec.get("search_around") or []:
        lt = _link_deps(d, step.get("link_type_id"))
        if not lt:
            d.ok = False
            return
        reach = lt["target" if step.get("direction", "forward") == "forward" else "source"]["object_type_id"]
        _type_deps(d, reach, check=True)


def _object_set(ref: str, filters: list[dict]) -> tuple[dict, list[dict]]:
    """object_set(…): a saved exploration (Object Explorer's published object sets) or an object list the caller can
    see, by RID (ri.object-set.main.exploration.<id> / .list.<id>), ID or name; the filters narrow it (at most 200)."""
    import ontology
    import ontology_explorer as ox

    ref = ref.strip()
    kind = None
    if ref.startswith(_SET_RID):
        kind, _, ref = ref[len(_SET_RID):].partition(".")
    low = ref.lower()

    def read_exploration(e: dict) -> tuple[dict, list[dict]]:
        spec = dict(e.get("spec") or {})
        fs = [ox.Filter(**f) for f in filters]
        steps = [dict(s) for s in spec.get("search_around") or []]
        if steps:  # the filters apply to the objects the exploration ends on
            steps[-1]["filters"] = list(steps[-1].get("filters") or []) + [f.model_dump() for f in fs]
            spec["search_around"] = steps
        else:
            spec["filters"] = list(spec.get("filters") or []) + [f.model_dump() for f in fs]
        spec.update({"offset": 0, "limit": F.MAX_OBJECTS, "histograms": False, "aggregate": None, "resource": "fusion"})
        res = ox.search(ox.SearchIn(**spec))
        return res["result_type"], res["objects"]

    def read_list(rec: dict) -> tuple[dict, list[dict]]:
        t = ontology._object_type(rec["object_type_id"])
        objs = ontology._objects(t["id"])
        rows = [ontology._public_object(t, pk, objs[pk]) for pk in rec.get("primary_keys") or [] if pk in objs and ontology._can_see(t, objs[pk])]
        rows = ox._filter_rows(t, rows, [ox.Filter(**f) for f in filters])
        return t, rows[:F.MAX_OBJECTS]

    try:
        if kind in (None, "exploration"):
            e = next((x for x in ox.list_explorations() if x["id"] == ref), None) or \
                next((x for x in ox.list_explorations() if (x.get("name") or "").lower() == low), None)
            if e:
                return _kept(("exploration", e["id"], _filters_key(filters)), lambda d: _set_deps(d, "exploration", e), lambda: read_exploration(e))
        if kind in (None, "list"):
            lst = next((x for x in ox.list_object_lists() if x["id"] == ref), None) or \
                next((x for x in ox.list_object_lists() if (x.get("name") or "").lower() == low), None)
            if lst:
                rec = ox._list_rec(lst["id"])
                return _kept(("list", rec["id"], _filters_key(filters)), lambda d: _set_deps(d, "list", rec), lambda: read_list(rec))
    except HTTPException as e:
        raise F.FusionError(str(e.detail)) from None
    raise F.FusionError(f"no object set {ref} (a saved exploration or an object list)")


# the formula engine reads single objects and object sets through these (fusion_formula's object functions)
_objects.get = _object_get  # type: ignore[attr-defined]
_objects.object_set = _object_set  # type: ignore[attr-defined]


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime,)):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, float) and v != v:
        return None
    return v


def _cache_path(item_id: str) -> Path:
    return DIR / "sources" / f"{item_id}.pickle"


def _drop_cache(item_id: str) -> None:
    _cache_path(item_id).unlink(missing_ok=True)


def _cached_datasets(item_id: str):
    """Manual update mode: a dataset is read once and kept with the document until "Update sources"."""
    import pickle

    path = _cache_path(item_id)
    try:
        cache = pickle.loads(path.read_bytes()) if path.exists() else {}
    except Exception:
        cache = {}

    live: dict[str, tuple[list[str], Any, dict]] = {}

    def get(name: str) -> tuple[list[str], Any, dict]:
        key = name.lower()
        if key not in cache:
            cols, rows, meta = _datasets(name)
            cache[key] = (cols, rows, {**meta, "cached_at": _now()})
            path.write_bytes(pickle.dumps(cache))
        if key not in live:
            # the kept rows are scanned (an index holds the dataset's current version, not the one kept here)
            cols, rows, meta = cache[key]
            info = {**meta, "index": None, "pinned": True, "columns": cols}
            first = next((v for v in live.values() if v[2]["id"] == meta["id"] and v[2].get("cached_at") == meta.get("cached_at")), None)
            live[key] = first or (cols, fusion_index.Rows(cols, None, lambda: rows, info), info)
        return live[key]

    return get


def evaluate(doc: dict, item_id: Optional[str] = None) -> tuple[F.Evaluator, dict]:
    manual = item_id and doc.get("settings", {}).get("auto_update") is False
    ev = F.Evaluator(doc, _cached_datasets(item_id) if manual else _lookup_datasets(), _objects)
    ev.meta = {"document_identifier": item_id, "creator": None}  # Drive keeps no creator of an item
    raw = ev.values()
    out = {sid: {a: {"d": F.display(v), "v": _jsonable(v)} for a, v in cells.items()} for sid, cells in raw.items()}
    return ev, out


def _view(item: dict, doc: dict) -> dict:
    import drive

    ev, values = evaluate(doc, item["id"])
    # revision: the content's stamp, which co-editors compare too (Files revisions have 1 s resolution, and several
    # saves land within one second)
    return {"item": drive._with_path(item), "document": doc, "values": values, "sources": list(ev.sources.values()),
            "can_edit": _can_edit(item["id"]), "revision": _stamp(json.dumps(doc, ensure_ascii=False).encode("utf-8"))}


def _can_edit(item_id: str) -> bool:
    import drive

    try:
        drive._item(item_id, need="editor")
        return True
    except HTTPException:
        return False


# ------------------------------------------------------------------ tables


def _table_bounds(t: dict) -> tuple[int, int, int, int]:
    r, c = F.parse_addr(t["start"])
    return r, c, r + t["rows"], c + t["columns"] - 1  # header row r, data rows r+1..r+rows


def _find_table(doc: dict, ref: str) -> tuple[dict, dict]:
    for s in doc["sheets"]:
        for t in s["tables"]:
            if ref in (t["id"], t["name"]) or t["name"].lower() == ref.lower():
                return s, t
    raise HTTPException(404, f"no table region {ref}")


def _shift_down(sheet: dict, after_row: int, n: int = 1) -> None:
    """Push every cell below `after_row` down by n rows (table regions below move too)."""
    moved = {}
    for a, cell in sheet["cells"].items():
        r, c = F.parse_addr(a)
        if cell.get("input"):
            # references to the rows that move follow them
            cell = {**cell, "input": F.shift_formula(cell["input"], n, 0, only_rows_after=after_row)}
        moved[F.addr(r + n, c) if r > after_row else a] = cell
    sheet["cells"] = moved
    for t in sheet["tables"]:
        r, c = F.parse_addr(t["start"])
        if r > after_row:
            t["start"] = F.addr(r + n, c)


def _append_row(sheet: dict, t: dict, values: list[Any]) -> int:
    r0, c0, r_end, _ = _table_bounds(t)
    _shift_down(sheet, r_end)
    row = r_end + 1
    for j in range(t["columns"]):
        v = values[j] if j < len(values) else None
        a = F.addr(row, c0 + j)
        if v is None or v == "":
            sheet["cells"].pop(a, None)
        else:
            sheet["cells"][a] = {**sheet["cells"].get(a, {}), "input": F.to_text(v) if not isinstance(v, str) else v}
    t["rows"] += 1
    return row


def _table_values(doc: dict, sheet: dict, t: dict, values: dict) -> tuple[list[str], list[list[Any]]]:
    r0, c0, r_end, c_end = _table_bounds(t)
    vals = values.get(sheet["id"], {})

    def get(r: int, c: int) -> Any:
        v = (vals.get(F.addr(r, c)) or {}).get("v")
        try:
            return F.plain(v)
        except F.FusionError:
            return None

    headers = [F.to_text(get(r0, c)) or F.col_letters(c) for c in range(c0, c_end + 1)]
    rows = [[get(r, c) for c in range(c0, c_end + 1)] for r in range(r0 + 1, r_end + 1)]
    return headers, rows


def _sheet_values(sheet: dict, values: dict) -> tuple[list[str], list[list[Any]]]:
    """A sheet's used range: the first used row holds the headers, the rows below are the data."""
    used = [F.parse_addr(a) for a, c in sheet["cells"].items() if (c.get("input") or "") != ""]
    # … and the cells 2-D results spilled over (values without an input of their own)
    used += [F.parse_addr(a) for a in values.get(sheet["id"], {}) if a not in sheet["cells"]]
    if not used:
        return [], []
    r0, c0 = min(r for r, _ in used), min(c for _, c in used)
    r1, c1 = max(r for r, _ in used), max(c for _, c in used)
    return _table_values({}, sheet, {"start": F.addr(r0, c0), "rows": r1 - r0, "columns": c1 - c0 + 1}, values)


def _sync_tables(item: dict, doc: dict, values: dict) -> list[dict]:
    """Rewrite the dataset of every synced table (and synced sheet) whose values changed."""
    import drive
    import pipeline_datasets
    import pyarrow as pa

    done = []
    for s in doc["sheets"]:
        targets = [(s, s["name"], lambda s=s: _sheet_values(s, values))] if s.get("sync") else []
        targets += [(t, t["name"], lambda s=s, t=t: _table_values(doc, s, t, values)) for t in s["tables"] if t.get("sync")]
        for t, label, read in targets:
            sync = t["sync"]
            headers, rows = read()
            digest = hashlib.sha1(json.dumps([headers, rows], default=str).encode()).hexdigest()
            if digest == sync.get("digest") and sync.get("dataset_id"):
                continue
            cols = []
            for j, h in enumerate(headers):
                vals = [r[j] for r in rows]
                present = [v for v in vals if v not in (None, "")]
                if present and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
                    as_int = all(isinstance(v, int) or float(v).is_integer() for v in present) and (sync.get("types") or {}).get(h) != "double"
                    cols.append(pa.array([int(v) if as_int and v not in (None, "") else (float(v) if v not in (None, "") else None) for v in vals],
                                         type=pa.int64() if as_int else pa.float64()))
                elif present and all(isinstance(v, bool) for v in present):
                    cols.append(pa.array([v if v not in ("",) else None for v in vals], type=pa.bool_()))
                else:
                    cols.append(pa.array([None if v in (None, "") else (json.dumps(v) if isinstance(v, (list, dict)) else str(v)) for v in vals], type=pa.string()))
            table = pa.Table.from_arrays(cols, names=[h or f"col_{j}" for j, h in enumerate(headers)]) if headers else pa.table({})
            data = pipeline_datasets._parquet_bytes(table)
            live = pipeline_datasets._live_file(sync["dataset_id"]) if sync.get("dataset_id") else None
            if live:
                pipeline_datasets._replace_content(live, data)
            else:
                new = drive.save_bytes(sync.get("folder_id") or item.get("parent_id"), f"{sync.get('name') or label}.parquet", data, pipeline_datasets.PARQUET)
                sync["dataset_id"] = new["id"]
            sync.update(digest=digest, synced_at=_now(), rows=len(rows))
            done.append({"table": label, "dataset_id": sync["dataset_id"], "rows": len(rows)})
    return done


# ------------------------------------------------------------------ history


def _history_path(item_id: str) -> Path:
    return DIR / "history" / f"{item_id}.json"


def _history(item_id: str) -> list[dict]:
    p = _history_path(item_id)
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _snapshot(item_id: str, doc: dict, label: str, auto: bool) -> Optional[dict]:
    with _lock:
        hist = _history(item_id)
        if auto and hist and datetime.fromisoformat(hist[-1]["at"]) > datetime.now(timezone.utc) - AUTO_SNAPSHOT:
            return None
        snap = {"id": uuid.uuid4().hex[:10], "at": _now(), "by": _who(), "label": label, "auto": auto, "sheets": copy.deepcopy(doc["sheets"])}
        hist.append(snap)
        _history_path(item_id).write_text(json.dumps(hist[-HISTORY_KEPT:], ensure_ascii=False), "utf-8")
        return snap


def _save(item: dict, doc: dict, label: str = "Edit", stamps: Optional[dict] = None) -> dict:
    """Store the document, snapshot it (at most every 10 minutes automatically), sync its tables; return the view.
    `stamps` receives the stored bytes' stamp under the document's ID."""
    _check(doc)
    _snapshot(item["id"], doc, label, auto=True)
    ev, values = evaluate(doc, item["id"])
    synced = _sync_tables(item, doc, values)
    stamp = _store(item, doc)
    if stamps is not None:
        stamps[item["id"]] = stamp
    view = _view(_item(item["id"]), doc)  # the stored item: its new timestamp
    view["synced"] = synced
    return view


# ------------------------------------------------------------------ routes: documents


class NewDocIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None


@router.get("/documents")
def list_documents() -> list[dict]:
    import db
    import drive

    drive._require_db()
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (FUSION_MIME,), order="updated_at DESC", limit=500)
    return [drive._with_path(i) for i in auth.visible(items)]


@router.post("/documents")
def create_document(req: NewDocIn) -> dict:
    return _create(req.name, req.parent_id, _blank())


def _create(name: str, parent_id: Optional[str], doc: dict) -> dict:
    import drive

    name = drive._clean_name(name.strip())
    if not name.lower().endswith(".fusion"):
        name = f"{name[:240]}.fusion"
    _check(doc)
    item = drive.save_bytes(drive._folder_id(parent_id) if parent_id else drive.default_folder("documents"), name,
                            json.dumps(doc, ensure_ascii=False).encode("utf-8"), FUSION_MIME)
    return _view(drive._item(item["id"]), doc)


@router.get("/documents/{item_id}")
def get_document(item_id: str, request: Request) -> dict:
    """The document with its values; the URL's other query parameters are what query_params(name) reads."""
    item = _item(item_id)
    token = F.QUERY_PARAMS.set({k: v for k, v in request.query_params.items()})
    try:
        return _view(item, _load(item))
    finally:
        F.QUERY_PARAMS.reset(token)


class DocIn(BaseModel):
    # the whole document: sheets (names, cells, tables, column widths), settings, template flag
    document: dict


@router.put("/documents/{item_id}")
def save_document(item_id: str, req: DocIn) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        old = _load(item)
        doc = req.document
        if not doc.get("sheets"):
            raise HTTPException(400, "a document has at least one sheet")
        # synced tables keep their dataset
        syncs = {t["id"]: t.get("sync") for s in old["sheets"] for t in s["tables"]}
        syncs.update({s["id"]: s.get("sync") for s in old["sheets"]})
        if (old.get("settings", {}).get("auto_update") is False) != (doc.get("settings", {}).get("auto_update") is False):
            _drop_cache(item["id"])
        for s in doc["sheets"]:
            s.setdefault("id", f"sh-{uuid.uuid4().hex[:8]}")
            if s["id"] in syncs and syncs[s["id"]] and not s.get("sync"):
                s["sync"] = syncs[s["id"]]
            s.setdefault("cells", {})
            s.setdefault("tables", [])
            for t in s["tables"]:
                if t.get("id") in syncs and syncs[t["id"]] and not t.get("sync"):
                    t["sync"] = syncs[t["id"]]
        return _save(item, doc, "Document settings")


class CellsIn(BaseModel):
    sheet: str
    # address → what was typed (None clears the cell)
    cells: dict[str, Optional[str]] = {}
    # address → the selected value of a dropdown cell
    selected: dict[str, Any] = {}
    # address → {bold, italic, color, fill, number, align}
    formats: dict[str, Optional[dict]] = {}
    # address → locked
    locks: dict[str, bool] = {}


@router.put("/documents/{item_id}/cells")
def edit_cells(item_id: str, req: CellsIn) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet = next((s for s in doc["sheets"] if s["id"] == req.sheet or s["name"] == req.sheet), None)
        if not sheet:
            raise HTTPException(404, "sheet not found")
        cells = sheet["cells"]
        for a, src in req.cells.items():
            a = a.upper()
            if not F.CELL.match(a):
                raise HTTPException(400, f"{a} is not a cell address")
            if (cells.get(a) or {}).get("locked") and req.locks.get(a) is not False:
                raise HTTPException(409, f"{a} is locked: unlock it to edit")
            cur = cells.get(a, {})
            if src is None or src == "":
                cur.pop("input", None)
                cur.pop("selected", None)
            else:
                cur["input"] = src
            if cur:
                cells[a] = cur
            else:
                cells.pop(a, None)
        for a, sel in req.selected.items():
            if sel is None:
                # no selection: a dropdown, checkbox or datepicker shows its formula's own value again
                if a.upper() in cells:
                    cells[a.upper()].pop("selected", None)
                    if not cells[a.upper()]:
                        cells.pop(a.upper())
            else:
                cells.setdefault(a.upper(), {})["selected"] = sel
        for a, fmt in req.formats.items():
            cur = cells.setdefault(a.upper(), {})
            if fmt:
                cur["format"] = {**(cur.get("format") or {}), **fmt}
            else:
                cur.pop("format", None)
        for a, locked in req.locks.items():
            cur = cells.setdefault(a.upper(), {})
            if locked:
                cur["locked"] = True
            else:
                cur.pop("locked", None)
        for a in list(cells):
            if not cells[a]:
                cells.pop(a)
        return _save(item, doc)


@router.post("/documents/{item_id}/sheets")
def add_sheet(item_id: str, name: Optional[str] = None) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        n = name or f"Sheet{len(doc['sheets']) + 1}"
        doc["sheets"].append(_new_sheet(n))
        return _save(item, doc, "Added a sheet")


class RuleIn(BaseModel):
    range: str = Field(min_length=2, max_length=40)
    # gt, gte, lt, lte, eq, neq, between, contains, empty, not_empty, scale (a two-color scale over the range's numbers)
    op: Literal["gt", "gte", "lt", "lte", "eq", "neq", "between", "contains", "empty", "not_empty", "scale"]
    value: Optional[str] = None
    value2: Optional[str] = None
    fill: Optional[str] = Field(None, max_length=30)
    color: Optional[str] = Field(None, max_length=30)
    bold: bool = False
    # scale: the colors of the smallest and largest numbers
    min_color: Optional[str] = Field(None, max_length=30)
    max_color: Optional[str] = Field(None, max_length=30)


class ConditionalIn(BaseModel):
    rules: list[RuleIn] = Field(default_factory=list, max_length=100)


@router.put("/documents/{item_id}/sheets/{sheet}/conditional")
def set_conditional(item_id: str, sheet: str, req: ConditionalIn) -> dict:
    """Conditional formatting: rules over ranges, applied to the computed values (so lookups restyle as data changes)."""
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sh = next((s for s in doc["sheets"] if sheet in (s["id"], s["name"])), None)
        if not sh:
            raise HTTPException(404, "sheet not found")
        rules = []
        for r in req.rules:
            rng = r.range.upper().replace("$", "")
            for part in rng.split(":"):
                try:
                    F.parse_addr(part)
                except Exception:  # noqa: BLE001
                    raise HTTPException(400, f"{r.range} is not a range like A1:C20") from None
            if r.op == "scale" and not (r.min_color and r.max_color):
                raise HTTPException(400, "a color scale needs a minimum and a maximum color")
            rules.append({"id": uuid.uuid4().hex[:8], **r.model_dump(), "range": rng})
        sh["conditional"] = rules
        return _save(item, doc, "Changed conditional formatting")


# ------------------------------------------------------------------ routes: tables


class TableIn(BaseModel):
    sheet: str
    name: str = Field(min_length=1, max_length=100)
    # the region's top-left cell (its header row) and its size
    start: str
    columns: int = Field(ge=1, le=200)
    rows: int = Field(0, ge=0, le=50_000)


@router.post("/documents/{item_id}/tables")
def create_table(item_id: str, req: TableIn) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet = next((s for s in doc["sheets"] if req.sheet in (s["id"], s["name"])), None)
        if not sheet:
            raise HTTPException(404, "sheet not found")
        if any(t["name"].lower() == req.name.lower() for s in doc["sheets"] for t in s["tables"]):
            raise HTTPException(409, f"a table {req.name} exists")
        F.parse_addr(req.start.upper())
        sheet["tables"].append({"id": f"tb-{uuid.uuid4().hex[:8]}", "name": req.name, "start": req.start.upper(), "columns": req.columns, "rows": req.rows})
        return _save(item, doc, f"Created table {req.name}")


class SortIn(BaseModel):
    column: str  # a header name or column letter
    descending: bool = False


@router.post("/documents/{item_id}/tables/{table}/sort")
def sort_table(item_id: str, table: str, req: SortIn) -> dict:
    """Sorting rearranges the rows (it is not a view), like Fusion."""
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet, t = _find_table(doc, table)
        _, values = evaluate(doc, item["id"])
        headers, vals = _table_values(doc, sheet, t, values)
        r0, c0, r_end, _ = _table_bounds(t)
        j = headers.index(req.column) if req.column in headers else (F.col_index(req.column.upper()) - c0 if req.column.isalpha() else -1)
        if not 0 <= j < t["columns"]:
            raise HTTPException(400, f"no column {req.column} in {t['name']}")
        rows = [[sheet["cells"].get(F.addr(r, c0 + k)) for k in range(t["columns"])] for r in range(r0 + 1, r_end + 1)]
        order = sorted(range(len(rows)), key=lambda i: (vals[i][j] is None, (isinstance(vals[i][j], str), vals[i][j] if vals[i][j] is not None else 0)),
                       reverse=req.descending)
        if req.descending:
            # nulls last either way
            order = [i for i in order if vals[i][j] is not None] + [i for i in order if vals[i][j] is None]
        for k, i in enumerate(order):
            for c in range(t["columns"]):
                a = F.addr(r0 + 1 + k, c0 + c)
                if rows[i][c]:
                    # a moved formula keeps pointing at its own row
                    cell = dict(rows[i][c])
                    if cell.get("input"):
                        cell["input"] = F.shift_formula(cell["input"], k - i)
                    sheet["cells"][a] = cell
                else:
                    sheet["cells"].pop(a, None)
        return _save(item, doc, f"Sorted {t['name']}")


class AppendIn(BaseModel):
    values: list[Any] = []


@router.post("/documents/{item_id}/tables/{table}/rows")
def append_row(item_id: str, table: str, req: AppendIn) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet, t = _find_table(doc, table)
        _append_row(sheet, t, req.values)
        return _save(item, doc, f"Added a row to {t['name']}")


class SyncIn(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None
    # header → "double" keeps whole numbers as doubles
    types: dict[str, str] = {}
    enabled: bool = True


@router.put("/documents/{item_id}/tables/{table}/sync")
def sync_table(item_id: str, table: str, req: SyncIn) -> dict:
    """Sync a table region to a dataset: written now and whenever the table's values change."""
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet_of, t = _find_table(doc, table)
        if req.enabled and sheet_of.get("sync"):
            raise HTTPException(400, "a sheet has one kind of sync: this sheet is synced as a whole")
        if not req.enabled:
            t.pop("sync", None)
        else:
            t["sync"] = {**(t.get("sync") or {}), "name": req.name or t["name"], "folder_id": req.folder_id, "types": req.types, "digest": None}
        return _save(item, doc, f"Sync of {t['name']}")


@router.put("/documents/{item_id}/sheets/{sheet}/sync")
def sync_sheet(item_id: str, sheet: str, req: SyncIn) -> dict:
    """Sync a whole sheet (its used range, first row as headers) to a dataset, rewritten whenever its values change."""
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        s = next((x for x in doc["sheets"] if sheet in (x["id"], x["name"])), None)
        if not s:
            raise HTTPException(404, f"no sheet {sheet}")
        if req.enabled and any(t.get("sync") for t in s["tables"]):
            raise HTTPException(400, "a sheet has one kind of sync: stop its table syncs first")
        if not req.enabled:
            s.pop("sync", None)
        else:
            s["sync"] = {**(s.get("sync") or {}), "name": req.name or s["name"], "folder_id": req.folder_id, "types": req.types, "digest": None}
        return _save(item, doc, f"Sync of sheet {s['name']}")


@router.post("/documents/{item_id}/update-sources")
def update_sources(item_id: str) -> dict:
    """Manual update mode: read every dataset again (the values then stay until the next update)."""
    item = _item(item_id, "editor")
    with _editing(item):
        _drop_cache(item_id)
        return _save(_item(item_id, "editor"), _load(item), "Updated sources")


@router.get("/documents/{item_id}/lookups")
def document_lookups(item_id: str, request: Request) -> dict:
    """The datasets this document's lookups read, each with its index (status, key columns, size) and how the
    lookups ran in this evaluation: through the index or by scanning the dataset, and the columns they filter on
    (the natural key columns of an index). Build, rebuild and drop: /api/fusion/indexes."""
    import drive

    item = _item(item_id)
    doc = _load(item)
    token = F.QUERY_PARAMS.set({k: v for k, v in request.query_params.items()})
    try:
        ev, _values = evaluate(doc, item["id"])
    finally:
        F.QUERY_PARAMS.reset(token)
    out = []
    for s in ev.sources.values():
        try:
            ds = drive._item(s["id"])
        except HTTPException:
            ds = None  # kept by a manual-update document, deleted since
        out.append({"id": s["id"], "name": s["name"], "updated_at": s.get("updated_at"), "cached_at": s.get("cached_at"),
                    "pinned": bool(s.get("pinned")), "path": [p["name"] for p in (drive._with_path(ds).get("path") or [])] if ds else [],
                    "columns": s.get("columns") or [], "lookup": s.get("lookup"),
                    "index": fusion_index.public(s["id"], ds) if ds else None})
    return {"manual": doc.get("settings", {}).get("auto_update") is False, "datasets": sorted(out, key=lambda x: x["name"].lower()),
            "limits": fusion_index.limits()}


# ------------------------------------------------------------------ routes: actions


class ActionIn(BaseModel):
    sheet: str
    cell: str


def _write_range(doc: dict, target: dict, values: list[list[Any]], as_input: bool) -> None:
    sheet = next(s for s in doc["sheets"] if s["id"] == target["sheet"])
    cells = target["cells"]
    for i, row in enumerate(cells):
        for j, a in enumerate(row):
            v = values[i % len(values)][j % len(values[0])] if values and values[0] else None
            if (sheet["cells"].get(a) or {}).get("locked"):
                raise F.FusionError(f"{a} is locked")
            if v is None or v == "":
                if a in sheet["cells"]:
                    sheet["cells"][a].pop("input", None)
            else:
                sheet["cells"].setdefault(a, {})["input"] = v if as_input else F.to_text(v)


_DOC_RID = "ri.fusion.main.document."


def _submit_target(doc: dict, ref: str, ctx: dict) -> tuple[Optional[str], dict]:
    """The document a submit_to_region_with_* action writes to, with its ID: this one (its ID, its RID), or another
    Fusion document the caller can edit — loaded once per click and kept in ctx["others"] (stored after the click)."""
    ref = ref.strip()
    rid = ref[len(_DOC_RID):] if ref.startswith(_DOC_RID) else ref
    if not ctx.get("item_id") or rid == ctx.get("item_id"):
        return ctx.get("item_id"), doc
    others = ctx.setdefault("others", {})
    if rid not in others:
        try:
            item = _item(rid, "editor")
            if ctx.get("locks") is not None:  # held until the click is stored: no other process edits it meanwhile
                ctx["locks"].enter_context(_xlock(item["id"], _DOC))
        except HTTPException as e:
            raise F.FusionError(f"document {ref}: {e.detail}") from None
        other, stamp = _load_stamped(item)
        others[rid] = (item, other)
        ctx.setdefault("stamps", {})[rid] = stamp
    return rid, others[rid][1]


# The region cache of the _lazy submissions. What a keyed submission has to know about its target table region —
# where it is, its headers, the row of every key — is read once and kept (in memory, the regions used last), so
# several submissions to one region in quick succession do not read the region again. An entry belongs to exactly
# the stored bytes it was read from (the document's stamp): any other change of the document — an edit, a sort, an
# appended row, another action, a restore, another user's submission — gives the document another stamp and the
# region is read again. A submission keeps its entry up to date while it writes; the entry is kept, under the new
# stamp, only when that submission was the last change of the document in a click that succeeded.

_REGIONS: "OrderedDict[tuple[str, str], dict]" = OrderedDict()
REGIONS_KEPT = 64
region_cache_stats = {"hits": 0, "misses": 0, "kept": 0}


def _region_read(sheet: dict, t: dict) -> dict:
    r0, c0, _, _ = _table_bounds(t)
    return {"sheet": sheet["id"], "start": t["start"], "rows": t["rows"], "columns": t["columns"], "keys": {},
            "headers": [F.to_text((sheet["cells"].get(F.addr(r0, c0 + j)) or {}).get("input")).strip() for j in range(t["columns"])]}


def _region_keys(info: dict, sheet: dict, t: dict, j: int) -> dict[str, int]:
    """The row of every key in column j of the region (the first row, when rows share a key)."""
    idx = info["keys"].get(j)
    if idx is None:
        r0, c0, r_end, _ = _table_bounds(t)
        cells = sheet["cells"]
        idx = info["keys"][j] = {}
        for r in range(r0 + 1, r_end + 1):
            idx.setdefault(F.to_text((cells.get(F.addr(r, c0 + j)) or {}).get("input")), r)
    return idx


def _region_take(rid: str, sheet: dict, t: dict, stamp: Optional[str]) -> Optional[dict]:
    """The kept entry of a region, when the document still is the one it was read from. The entry leaves the cache: the
    submission changes it in place, and it comes back only through _regions_keep."""
    with _lock:
        e = _REGIONS.pop((rid, t["id"]), None)
        if (not e or not stamp or e["stamp"] != stamp
                or (e["sheet"], e["start"], e["rows"], e["columns"]) != (sheet["id"], t["start"], t["rows"], t["columns"])):
            region_cache_stats["misses"] += 1
            return None
        region_cache_stats["hits"] += 1
        return e


def _regions_keep(ctx: dict, stamps: dict) -> None:
    """After a click that succeeded: keep the regions its _lazy submissions wrote to, under the stamps of the documents
    as stored — those nothing else in the click changed afterwards."""
    touched = ctx.get("touched") or {}
    with _lock:
        for (rid, tid), (info, at) in (ctx.get("regions") or {}).items():
            if rid in stamps and touched.get(rid, 0) == at:
                info["stamp"] = stamps[rid]
                _REGIONS[(rid, tid)] = info
                _REGIONS.move_to_end((rid, tid))
                region_cache_stats["kept"] += 1
        while len(_REGIONS) > REGIONS_KEPT:
            _REGIONS.popitem(last=False)


def _submit_rows(doc: dict, act: dict, toasts: list[dict], ctx: dict) -> None:
    """submit_to_region_with_key(_and_timestamp)(_lazy) / action.submit_to_region_with_options: each row goes into the
    table region by its key — an existing key updates the columns given (an empty value is skipped unless
    submitEmptyCells), a new key appends a row. A locked cell refuses the whole submission. The rows are found through
    the region's key index (read once per submission; kept between clicks for the _lazy variants, see above) and the
    cells below the region move down once for all the appended rows."""
    rows = act.get("rows")
    if rows is None:
        raise F.FusionError("the values were not computed: click the button again")
    opts = act.get("options") or {}
    rid, target = _submit_target(doc, F.to_text(act.get("document")), ctx)
    sheet, t = _find_table_or_fail(target, F.to_text(act.get("table")))
    touched = ctx.setdefault("touched", {})
    lazy = bool(act.get("lazy")) and rid is not None
    info = None
    if lazy and not touched.get(rid):
        info = _region_take(rid, sheet, t, (ctx.get("stamps") or {}).get(rid))
    if info is None:
        info = _region_read(sheet, t)
    headers = info["headers"]
    low = [h.lower() for h in headers]
    found: dict[str, int] = {}

    def col(name: str) -> int:
        if name not in found:
            if name in headers:
                found[name] = headers.index(name)
            elif name.lower() in low:
                found[name] = low.index(name.lower())
            else:
                raise F.FusionError(f"the table region {t['name']} has no column {name}")
        return found[name]

    key_name = act["key_column"]
    key_col = col(key_name)
    ts_col = col(act["timestamp_column"]) if act.get("timestamp_column") else None

    def keep() -> None:
        if lazy:
            ctx.setdefault("regions", {})[(rid, t["id"])] = (info, touched.get(rid, 0))

    if not rows:
        if opts.get("succeedWhenNoRows"):
            keep()  # nothing written: the region is as it was read
            return
        raise F.FusionError("nothing to submit: should_submit is false (or the key is empty) for every row")
    stamp = _now()
    empty_overwrites = bool(opts.get("submitEmptyCells"))
    where = "" if target is doc else " in another document"
    done = {"message": f"Submitted {len(rows)} row{'s' if len(rows) != 1 else ''} to {t['name']}{where}", "intent": "success"}
    r0, c0, r_end, _ = _table_bounds(t)
    cells = sheet["cells"]
    idx = _region_keys(info, sheet, t, key_col)
    # what each row does, before anything is written: (row in the sheet, values by column, appended?)
    plan: list[tuple[int, dict[int, Any], bool]] = []
    fresh: dict[str, int] = {}  # the keys the region does not hold → the place of their row among the appended rows
    for row in rows:
        vals = {col(k): v for k, v in row.items()}
        if ts_col is not None:
            vals[ts_col] = stamp
        key = F.to_text(row[key_name] if key_name in row else vals[key_col])
        if F.to_text(vals.get(key_col)) != key:
            # the key cell would not hold the key afterwards (the key column given twice, or as the timestamp column
            # too): row by row, each looking at the cells as the row before left them
            before = copy.deepcopy((sheet["cells"], sheet["tables"]))
            try:
                _submit_rows_one_by_one(sheet, t, rows, col, key_name, key_col, ts_col, stamp, empty_overwrites)
            except F.FusionError:
                sheet["cells"] = before[0]
                for table, was in zip(sheet["tables"], before[1]):
                    table.update(start=was["start"], rows=was["rows"])
                raise
            touched[rid] = touched.get(rid, 0) + 1
            toasts.append(done)
            return
        hit = idx.get(key)
        if hit is None:
            if key in fresh:
                plan.append((r_end + 1 + fresh[key], vals, False))  # a row this submission appended: updated
            else:
                fresh[key] = len(fresh)
                plan.append((r_end + 1 + fresh[key], vals, True))
            continue
        for j, v in vals.items():
            if (v not in (None, "") or empty_overwrites) and (cells.get(F.addr(hit, c0 + j)) or {}).get("locked"):
                raise F.FusionError(f"{F.addr(hit, c0 + j)} is locked")
        plan.append((hit, vals, False))
    if fresh:
        _shift_down(sheet, r_end, len(fresh))
        cells = sheet["cells"]
        t["rows"] += len(fresh)
        info["rows"] = t["rows"]
    indexed = info["keys"]
    for r, vals, appended in plan:
        if appended:
            for j in range(t["columns"]):
                v = vals.get(j)
                a = F.addr(r, c0 + j)
                if v is None or v == "":
                    cells.pop(a, None)
                else:
                    cells[a] = {**cells.get(a, {}), "input": v if isinstance(v, str) else F.to_text(v)}
                if j in indexed:
                    indexed[j].setdefault(F.to_text((cells.get(a) or {}).get("input")), r)
            continue
        for j, v in vals.items():
            if v in (None, "") and not empty_overwrites:
                continue
            a = F.addr(r, c0 + j)
            before = F.to_text((cells.get(a) or {}).get("input"))
            if v in (None, ""):
                if a in cells:
                    cells[a].pop("input", None)
            else:
                cells.setdefault(a, {})["input"] = v if isinstance(v, str) else F.to_text(v)
            if j in indexed and j != key_col and F.to_text((cells.get(a) or {}).get("input")) != before:
                del indexed[j]  # another key column's index: read again when a submission uses it
    touched[rid] = touched.get(rid, 0) + 1
    keep()
    toasts.append(done)


def _submit_rows_one_by_one(sheet: dict, t: dict, rows: list[dict], col: Any, key_name: str, key_col: int, ts_col: Optional[int],
                            stamp: str, empty_overwrites: bool) -> None:
    for row in rows:
        vals = {col(k): v for k, v in row.items()}
        if ts_col is not None:
            vals[ts_col] = stamp
        key = F.to_text(row[key_name] if key_name in row else vals[key_col])
        r0, c0, r_end, _ = _table_bounds(t)  # appending moves the end
        hit = next((r for r in range(r0 + 1, r_end + 1) if F.to_text((sheet["cells"].get(F.addr(r, c0 + key_col)) or {}).get("input")) == key), None)
        if hit is None:
            _append_row(sheet, t, [vals.get(j) for j in range(t["columns"])])
            continue
        for j, v in vals.items():
            a = F.addr(hit, c0 + j)
            if v in (None, "") and not empty_overwrites:
                continue
            if (sheet["cells"].get(a) or {}).get("locked"):
                raise F.FusionError(f"{a} is locked")
            if v in (None, ""):
                if a in sheet["cells"]:
                    sheet["cells"][a].pop("input", None)
            else:
                sheet["cells"].setdefault(a, {})["input"] = v if isinstance(v, str) else F.to_text(v)


def _touch(ctx: dict) -> None:
    """An action other than a keyed submission changes this document: the regions read earlier in the click are not
    kept (see _regions_keep)."""
    touched = ctx.setdefault("touched", {})
    touched[ctx.get("item_id")] = touched.get(ctx.get("item_id"), 0) + 1


def _find_table_or_fail(doc: dict, ref: str) -> tuple[dict, dict]:
    try:
        return _find_table(doc, ref)
    except HTTPException as e:
        raise F.FusionError(str(e.detail)) from None


def _run(doc: dict, act: dict, toasts: list[dict], applied: list[dict], effects: Optional[list[dict]] = None, ctx: Optional[dict] = None) -> None:
    """Run an action on the server. What only the browser can do (open a URL, show the Markdown panel) is appended to
    `effects`, which the editor carries out after the click. `ctx` holds this document's ID and the other documents a
    submission writes to."""
    effects = effects if effects is not None else []
    ctx = ctx if ctx is not None else {}
    kind = act.get("__kind__")
    if kind == "validation":
        if not act.get("ok"):
            raise F.FusionError(f"validation failed: {act.get('message')}")
        return
    a = act.get("action")
    if a == "noop":
        # action.success() / action.fail(): nothing happens; a failure short-circuits a serial
        if not act.get("ok"):
            raise F.FusionError("the action failed")
    elif a == "toast":
        toasts.append({"message": act.get("message") or "", "intent": act.get("intent") or "primary"})
    elif a == "open_url":
        # checked again here: only http and https addresses ever reach the browser
        effects.append({"type": "open_url", "url": F.safe_url(act.get("url")), "redirect": bool(act.get("redirect"))})
    elif a == "open_markdown_panel":
        effects.append({"type": "markdown_panel", "title": F.to_text(act.get("title")), "markdown": F.to_text(act.get("markdown"))})
    elif a == "copy":
        _touch(ctx)
        src = act["source"]
        sheet = next(s for s in doc["sheets"] if s["id"] == src["sheet"])
        if act.get("copy_result"):
            ev = F.Evaluator(doc, _datasets, _objects)
            vals = [[F.plain(ev.cell_value(sheet, c)) for c in row] for row in src["cells"]]
            _write_range(doc, act["target"], vals, as_input=False)
        else:
            # pasting a formula shifts its relative references by the distance moved
            r_s, c_s = F.parse_addr(src["cells"][0][0])
            r_t, c_t = F.parse_addr(act["target"]["cells"][0][0])
            vals = [[F.shift_formula((sheet["cells"].get(c) or {}).get("input"), r_t - r_s, c_t - c_s) for c in row] for row in src["cells"]]
            _write_range(doc, act["target"], vals, as_input=True)
    elif a == "submit_to_region":
        _touch(ctx)
        sheet, t = _find_table(doc, act["table"])
        r0, c0, r_end, _ = _table_bounds(t)
        vals = act.get("values") or []
        key = F.to_text(vals[0]) if vals else ""
        hit = next((r for r in range(r0 + 1, r_end + 1) if F.to_text((sheet["cells"].get(F.addr(r, c0)) or {}).get("input")) == key and key), None)
        if hit is None:
            _append_row(sheet, t, vals)
        else:
            for j in range(t["columns"]):
                v = vals[j] if j < len(vals) else None
                cell = F.addr(hit, c0 + j)
                if v in (None, ""):
                    sheet["cells"].pop(cell, None)
                else:
                    sheet["cells"].setdefault(cell, {})["input"] = F.to_text(v)
    elif a == "submit_rows":
        _submit_rows(doc, act, toasts, ctx)
    elif a == "parallel":
        for x in act.get("actions") or []:
            _run(doc, x, toasts, applied, effects, ctx)
    elif a == "serial":
        try:
            _run(doc, act["first"], toasts, applied, effects, ctx)
        except F.FusionError as e:
            if act.get("on_failure"):
                _run(doc, act["on_failure"], toasts, applied, effects, ctx)
                return
            raise e
        if act.get("on_success"):
            _run(doc, act["on_success"], toasts, applied, effects, ctx)
    elif a == "apply_action":
        import ontology

        ref = act["action_type"]
        at = next((x for x in ontology._all("action-types") if ref in (x["id"], x.get("display_name"), x.get("api_name"))), None)
        if not at:
            raise F.FusionError(f"no action type {ref}")
        by_name = {p.get("display_name", p["id"]).lower(): p["id"] for p in at.get("parameters") or []}
        params = {by_name.get(k.lower(), k): v for k, v in (act.get("parameters") or {}).items()}
        try:
            res = ontology.apply_action(at["id"], ontology.ApplyAction(parameters=params))
        except HTTPException as e:
            raise F.FusionError(str(e.detail)) from None
        applied.append({"action_type": at["display_name"], "edits": len(res.get("edits") or [])})
    else:
        raise F.FusionError(f"unknown action {a}")


@router.post("/documents/{item_id}/actions")
def run_action(item_id: str, req: ActionIn) -> dict:
    """Click a button cell: run its action on the server; toasts and Ontology edits come back with the new values."""
    item = _item(item_id, "editor")
    with _editing(item), contextlib.ExitStack() as held:
        doc, loaded = _load_stamped(item)
        sheet = next((s for s in doc["sheets"] if req.sheet in (s["id"], s["name"])), None)
        if not sheet:
            raise HTTPException(404, "sheet not found")
        ev = F.Evaluator(doc, _datasets, _objects)
        ev.meta = {"document_identifier": item["id"], "creator": None}
        ev.clicking = True  # the _lazy submissions compute their values now
        act = ev.cell_value(sheet, req.cell.upper())
        if not (isinstance(act, dict) and act.get("__kind__") in ("action", "validation")):
            raise HTTPException(400, f"{req.cell} is not an action or validation cell")
        toasts: list[dict] = []
        applied: list[dict] = []
        effects: list[dict] = []
        ctx: dict = {"item_id": item["id"], "stamps": {item["id"]: loaded}, "locks": held}
        ok, error = True, None
        try:
            _run(doc, act, toasts, applied, effects, ctx)
        except F.FusionError as e:
            ok, error = False, str(e)
        stored: dict = {}
        if ok:
            # the other documents a submission wrote to (stored only when the whole action succeeded)
            for other_item, other_doc in (ctx.get("others") or {}).values():
                try:
                    _save(other_item, other_doc, f"Submission from {item['name']}", stored)
                except HTTPException as e:
                    ok, error = False, f"{other_item['name']}: {e.detail}"
        view = _save(item, doc, f"Action {req.cell}", stored) if ok or act.get("__kind__") != "validation" else _view(item, doc)
        if ok:
            _regions_keep(ctx, stored)
        return {**view, "ok": ok, "error": error, "toasts": toasts, "applied": applied, "effects": effects}


class ControlIn(BaseModel):
    sheet: str
    cell: str
    # a checkbox: true / false; a datepicker: yyyy-MM-dd, optionally with HH:mm[:ss] (None or "" clears it)
    value: Optional[Any] = None


@router.put("/documents/{item_id}/control")
def set_control(item_id: str, req: ControlIn) -> dict:
    """Click a checkbox cell or pick a date in a datepicker cell. A control whose first argument is a cell reference —
    checkbox(B1), datepicker(B1) — writes the value to that cell; any other keeps it with its own cell."""
    item = _item(item_id, "editor")
    with _editing(item):
        doc = _load(item)
        sheet = next((s for s in doc["sheets"] if req.sheet in (s["id"], s["name"])), None)
        a = req.cell.upper()
        if not sheet or not F.CELL.match(a):
            raise HTTPException(404, "cell not found")
        ctl = F.Evaluator(doc, _datasets, _objects).cell_value(sheet, a)
        kind = ctl.get("__kind__") if isinstance(ctl, dict) else None
        if kind == "checkbox":
            if not isinstance(req.value, bool):
                raise HTTPException(400, "a checkbox is true or false")
            value: Any = req.value
        elif kind == "datepicker":
            if req.value is not None and not isinstance(req.value, str):
                raise HTTPException(400, "a date is text like 2026-01-31")
            try:
                value = F.date_value(req.value, ctl.get("precision") or "NONE")
            except F.FusionError as e:
                raise HTTPException(400, str(e)) from None
        else:
            raise HTTPException(400, f"{req.cell} is not a checkbox or datepicker cell")
        if (sheet["cells"].get(a) or {}).get("locked"):
            raise HTTPException(409, f"{a} is locked: unlock it to edit")
        bound = ctl.get("bound")
        if bound:
            target = next((s for s in doc["sheets"] if s["id"] == bound["sheet"]), None)
            if not target:
                raise HTTPException(404, "the cell the control is bound to is gone")
            b = bound["cell"]
            if (target["cells"].get(b) or {}).get("locked"):
                raise HTTPException(409, f"{b} is locked: unlock it to edit")
            if value is None:
                if b in target["cells"]:
                    target["cells"][b].pop("input", None)
                    if not target["cells"][b]:
                        target["cells"].pop(b)
            else:
                # a Boolean is written as the formula =true / =false, so the cell holds a Boolean and not the text
                target["cells"].setdefault(b, {})["input"] = ("=true" if value else "=false") if kind == "checkbox" else value
        else:
            sheet["cells"][a]["selected"] = value
        return _save(item, doc, f"{'Checkbox' if kind == 'checkbox' else 'Date'} {a}")


# ------------------------------------------------------------------ routes: history, templates, import


@router.get("/documents/{item_id}/history")
def history(item_id: str) -> list[dict]:
    _item(item_id)
    return [{k: v for k, v in h.items() if k != "sheets"} | {"cells": sum(len(s["cells"]) for s in h["sheets"])} for h in reversed(_history(item_id))]


class SnapshotIn(BaseModel):
    label: str = Field("Saved version", max_length=200)


@router.post("/documents/{item_id}/history")
def create_snapshot(item_id: str, req: SnapshotIn) -> dict:
    item = _item(item_id, "editor")
    snap = _snapshot(item["id"], _load(item), req.label, auto=False)
    return {k: v for k, v in (snap or {}).items() if k != "sheets"}


@router.get("/documents/{item_id}/history/{snap_id}")
def get_snapshot(item_id: str, snap_id: str) -> dict:
    _item(item_id)
    snap = next((h for h in _history(item_id) if h["id"] == snap_id), None)
    if not snap:
        raise HTTPException(404, "snapshot not found")
    return snap


@router.post("/documents/{item_id}/history/{snap_id}/restore")
def restore_snapshot(item_id: str, snap_id: str) -> dict:
    item = _item(item_id, "editor")
    with _editing(item):
        snap = next((h for h in _history(item_id) if h["id"] == snap_id), None)
        if not snap:
            raise HTTPException(404, "snapshot not found")
        doc = _load(item)
        _snapshot(item["id"], doc, "Before restore", auto=False)
        doc["sheets"] = copy.deepcopy(snap["sheets"])
        return _save(item, doc, f"Restored {snap['label']}")


class CopyIn(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None
    # "Sheet1!A1" (or "A1" for the first sheet) → value
    overrides: dict[str, str] = {}


@router.post("/documents/{item_id}/copy")
def copy_document(item_id: str, req: CopyIn) -> dict:
    """A copy (what opening a template does), with cell overrides."""
    item = _item(item_id)
    doc = _load(item)
    doc = copy.deepcopy(doc)
    doc["template"] = False
    for s in doc["sheets"]:
        for t in s["tables"]:
            t.pop("sync", None)
    for ref, value in req.overrides.items():
        sheet_name, _, a = ref.rpartition("!")
        sheet = next((s for s in doc["sheets"] if s["name"] == sheet_name), None) if sheet_name else doc["sheets"][0]
        if not sheet or not F.CELL.match(a.upper()):
            raise HTTPException(400, f"{ref} is not a cell of the document")
        sheet["cells"].setdefault(a.upper(), {})["input"] = value
    base = item["name"].removesuffix(".fusion")
    return _create(req.name or f"{base} (copy)", req.parent_id or item.get("parent_id"), doc)


class ImportIn(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[str] = None
    # a Files item holding the workbook, or its bytes (base64)
    item_id: Optional[str] = None
    data: Optional[str] = None


def _xlsx_doc(data: bytes) -> dict:
    import openpyxl

    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"not a readable Excel workbook: {e}") from None
    doc = _blank()
    doc["sheets"] = []
    for ws in wb.worksheets:
        s = _new_sheet(ws.title)
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                if v is None:
                    continue
                if isinstance(v, str) and v.startswith("="):
                    v = v.replace('"', "'")
                elif isinstance(v, bool):
                    v = "=true" if v else "=false"
                elif isinstance(v, datetime):
                    v = v.date().isoformat() if v.time() == datetime.min.time() else v.isoformat(sep=" ")
                elif hasattr(v, "isoformat"):
                    v = v.isoformat()
                s["cells"][cell.coordinate] = {"input": str(v)}
                if len(s["cells"]) > MAX_CELLS:
                    raise HTTPException(413, f"the workbook has more than {MAX_CELLS:,} cells")
        doc["sheets"].append(s)
    if not doc["sheets"]:
        doc["sheets"] = [_new_sheet("Sheet1")]
    return doc


@router.post("/import-xlsx")
def import_xlsx(req: ImportIn) -> dict:
    import drive

    if req.item_id:
        src = drive._item(req.item_id)
        data, name = drive.read_bytes(src), src["name"].rsplit(".", 1)[0]
    elif req.data:
        try:
            data = base64.b64decode(req.data, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(400, "data is not base64") from None
        name = "Imported workbook"
    else:
        raise HTTPException(400, "give the workbook as item_id or data")
    return _create(req.name or name, req.parent_id, _xlsx_doc(data))


@router.get("/datasets")
def indexed_datasets() -> list[dict]:
    """Datasets Fusion can look up (Parquet datasets in Files the user can read)."""
    import workshop

    return [{"id": d["id"], "name": d["name"], "path": [p["name"] for p in d.get("path") or []], "updated_at": str(d.get("updated_at"))}
            for d in workshop.datasets()]


@router.get("/datasets/{item_id}/preview")
def dataset_preview(item_id: str, limit: int = 20) -> dict:
    import workshop

    cols, types, rows = workshop._dataset_rows(item_id)
    return {"columns": [{"name": c, "type": types.get(c)} for c in cols], "rows": rows[: max(1, min(limit, 200))], "total": len(rows)}
