"""Media sets and file exports for file sources (Amazon S3, agent-level filesystem).

Media sync (as Foundry's media sets): documents, images, audio and video below a folder of the
source are copied into Files — My Project / Data Source / Media / <connection> / <folder> — or a
chosen folder. Each run copies only files that are new or changed since the last run (path and
modified time, kept in data/media/<connection id>.json), at most MAX_FILES per run. With
`target_media_set_id` the files go into a media set instead, through its own registration path
(schema / allowed formats, media type by content, conversions, path limits; files that do not fit
are skipped and reported per file) and its transaction policy (one transaction per run on
transactional media sets, committed only when the run succeeds). See _sync_to_media_set. A run that fails as a
whole answers 400 with `detail: {message, status: "failed", run}` (recorded in the history too); a partial run 200.

File export (as Foundry's file exports): a dataset (Files Parquet dataset, data source or View)
is written to the source as Parquet, CSV or JSON Lines. Like table exports, the connection must
have "Enable exports to this source" turned on.

Mounted by datasources.py under /api/datasources/connections.
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/connections")

MAX_FILES = 500
MEDIA_EXTENSIONS = [
    "pdf", "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "webp", "heic",
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "md", "html", "eml", "msg",
    "mp3", "wav", "m4a", "mp4", "mov",
]
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _conn_lock(conn_id: str) -> threading.Lock:
    """One media sync at a time per connection (runs of different connections go in parallel)."""
    with _locks_guard:
        return _locks.setdefault(conn_id, threading.Lock())


def _state_path(conn_id: str) -> Path:
    base = Path(os.environ.get("BLUESANDAI_DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
    d = base / "media"
    d.mkdir(parents=True, exist_ok=True)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", conn_id):
        raise HTTPException(400, "bad connection id")
    return d / f"{conn_id}.json"


def _load(conn_id: str) -> dict:
    p = _state_path(conn_id)
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return {"synced": {}, "runs": []}


def _file_connector(conn_id: str):  # noqa: ANN202
    import datasources as ds
    from connectors.files_conn import FileConnector

    c = ds._open(conn_id)
    if not isinstance(c, FileConnector):
        c.close()
        raise HTTPException(400, "Media sets and file exports work with Amazon S3 and agent-level filesystem connections")
    return c


class MediaSync(BaseModel):
    folder: str = "/"  # a folder of the source ("/" = its root)
    extensions: list[str] = Field(default_factory=lambda: list(MEDIA_EXTENSIONS))
    target_folder_id: Optional[str] = None
    # a media set instead of a folder: items go through the media set's own checks and transaction policy
    target_media_set_id: Optional[str] = None
    # media set targets: files gone from the source (in this folder and these file types) are deleted from the media
    # set too — kept in its history as "deleted" versions, like an overwrite. Off by default.
    propagate_deletions: bool = False
    # media set targets, the sync filters of a media set sync:
    # "Exclude files already synced": off = every file is read again (same content is still not written twice)
    exclude_already_synced: bool = True
    # "Path matches": a regular expression on the file's path from the root of the source (searched, so anchor it with
    # ^ and $ for a whole-path match, e.g. "^scans/.*\.png$"); other files are left out. A glob of earlier versions
    # ("scans/*.png", "a*") is still taken as a glob on the path below the folder: see path_filter
    path_matches: Optional[str] = None
    # "File size limit" in bytes: larger files are left out
    file_size_limit: Optional[int] = None
    # "Ignore items not matching schema": on = such a file is skipped and reported; off = it fails the run
    ignore_items_not_matching_schema: bool = True


@router.get("/{conn_id}/media-sync")
def media_state(conn_id: str) -> dict:
    st = _load(conn_id)
    per_set = {
        fid: {
            "synced": len(m.get("synced") or {}),
            "rejected": len(m.get("rejected") or {}),
            # the files the media set does not take, with the reason each was refused for
            "skipped_files": [{"path": p, "reason": v[2] if len(v) > 2 else "not accepted by the media set's formats"} for p, v in sorted((m.get("rejected") or {}).items())[:200]],
        }
        for fid, m in (st.get("media_sets") or {}).items()
    }
    return {"synced": len(st["synced"]), "runs": st["runs"][-20:], "extensions": MEDIA_EXTENSIONS, "media_sets": per_set}


@router.post("/{conn_id}/media-sync")
def media_sync(conn_id: str, req: MediaSync) -> dict:
    import datasources as ds
    import drive
    from connectors import ConnectorError

    ds._require()
    exts = {e.lower().lstrip(".") for e in req.extensions if e.strip()}
    if not exts:
        raise HTTPException(400, "Choose at least one file type")
    row = ds._connection_row(conn_id)
    folder = req.folder.strip("/")

    def label(name: str) -> str:
        return drive._clean_name(drive.BAD_NAME.sub("_", name))

    if req.target_media_set_id:
        if req.target_folder_id:
            raise HTTPException(400, "Choose a target folder or a target media set, not both")
        return _sync_to_media_set(conn_id, req.folder, folder, exts, req.target_media_set_id, req)

    with _conn_lock(conn_id):
        st = _load(conn_id)
        items: dict[str, str] = st.setdefault("items", {})  # source path → its copy in Files
        copied: list[str] = []
        failed: list[dict] = []
        todo: list = []
        target = None
        try:
            with _file_connector(conn_id) as c:
                files = c.fs.walk(folder, 100_000)
                todo = [
                    e for e in files
                    if os.path.splitext(e.path)[1].lower().lstrip(".") in exts
                    and st["synced"].get(e.path) != (e.modified.isoformat() if e.modified else "")
                ]
                if req.target_folder_id:
                    target = drive._folder_id(req.target_folder_id)
                else:
                    target = drive._ensure_folders(drive.default_folder("sources"), [label(n) for n in ["Media", row["name"], *[p for p in folder.split("/") if p]]])
                for e in todo[:MAX_FILES]:
                    name = os.path.basename(e.path)
                    try:
                        rel_dir = os.path.dirname(e.path[len(folder):].lstrip("/"))
                        parent = drive._ensure_folders(target, [label(p) for p in rel_dir.split("/") if p]) if rel_dir else target
                        # a changed file replaces its earlier copy (kept in the trash)
                        if items.get(e.path):
                            try:
                                drive.trash(items.pop(e.path))
                            except HTTPException:
                                pass  # already deleted in Files
                        with _open_stream(c.fs, e.path) as f:
                            item = drive._store(parent, label(name), f, e.size, mimetypes.guess_type(name)[0] or "application/octet-stream")
                        items[e.path] = item["id"]
                        st["synced"][e.path] = e.modified.isoformat() if e.modified else ""
                        copied.append(e.path)
                    except Exception as err:  # noqa: BLE001 - one file's failure never loses the run's state
                        detail = err.detail if isinstance(err, HTTPException) else str(err)
                        failed.append({"path": e.path, "error": str(detail)[:200]})
        except ConnectorError as e:
            raise HTTPException(400, str(e)) from None
        finally:
            # what was copied is recorded even when the run stops early
            run = {
                "at": datetime.now(timezone.utc).isoformat(),
                "folder": req.folder,
                "copied": len(copied),
                "failed": len(failed),
                "remaining": max(0, len(todo) - MAX_FILES),
                "target_folder_id": target,
            }
            if target is not None or copied:
                st["runs"] = [*st["runs"][-49:], run]
                _state_path(conn_id).write_text(json.dumps(st))
    return {**run, "files": copied[:50], "errors": failed[:20]}


_REGEX_ONLY = set(r"^$\()|+{")


def looks_like_glob(pattern: str) -> bool:
    r"""A "Path matches" value written as a glob, as earlier versions of the media sync took it: a `*` or `?` that
    repeats nothing in a regular expression (at the start, or after a literal character, as in "*.png", "a*" or
    "scans/*.png"), and none of the syntax only a regular expression has (anchors, escapes, groups, alternation, + or
    {n}). Patterns such as ".*\.png", "^scans/" or "a.png" are regular expressions."""
    if any(ch in _REGEX_ONLY for ch in pattern):
        return False
    try:
        re.compile(pattern)
    except re.error:
        return any(ch in pattern for ch in "*?[")
    return any(ch in "*?" and (i == 0 or pattern[i - 1] not in ".)]*+?}") for i, ch in enumerate(pattern))


def path_filter(pattern: Optional[str], folder: str = "") -> tuple[Optional[str], Optional[object]]:
    r"""The "Path matches" filter of a media sync: (kind, test) where test(path) is True for a source path (relative
    to the root of the source) that the sync keeps; (None, None) without a pattern.

    As the Data Connection docs say, the pattern is a regular expression on the path relative to the root of the
    source, searched (Python `re.search`: "\.pdf$" keeps PDFs, "^scans/" one folder; anchors are honoured). A
    value written as a glob for earlier versions (see looks_like_glob) keeps its old meaning — the glob matched
    against the path below the synced folder — so syncs set up before keep choosing the same files. A pattern that
    is neither a valid regular expression nor a glob answers 400."""
    import fnmatch

    p = (pattern or "").strip()
    if not p:
        return None, None
    if looks_like_glob(p):
        def rel_of(path: str) -> str:
            return path[len(folder):].lstrip("/") if folder and path.startswith(folder) else path.lstrip("/")

        return "glob", lambda path: fnmatch.fnmatch(rel_of(path), p)
    try:
        rx = re.compile(p)
    except re.error as e:
        raise HTTPException(400, f'"Path matches" is not a valid regular expression: {e}') from None
    return "regex", lambda path: rx.search(path.lstrip("/")) is not None


def _is_refusal(err: Exception) -> bool:
    """The media set refused the item itself (format not allowed, bad path, too large), as opposed to a failure."""
    if not isinstance(err, HTTPException):
        return False
    return err.status_code == 413 or (err.status_code == 400 and str(err.detail).startswith("MediaSet:"))


def _open_stream(fs, path: str):  # noqa: ANN001, ANN202
    """A source file as a readable stream, copied on in chunks: never read into memory as a whole (the filesystem
    backend streams the file, the S3 backend the object's body)."""
    stream = getattr(fs, "open_stream", None)
    return stream(path) if stream else fs.open(path)


class _RunFailed(Exception):
    """A media set sync run stops here: a transactional run is aborted, a transactionless one keeps what it wrote."""


def _sync_to_media_set(conn_id: str, folder_label: str, folder: str, exts: set[str], fid: str, req: MediaSync) -> dict:
    """Media sync into a media set (docs: Data Connection "Set up a media set sync", Media sets "Transaction policies",
    "Path deduplication").

    Schema: every file is copied to a temporary file in chunks (hashed on the way) and checked by the media set
    itself: path and size limits, schema / allowed formats by extension, and the media type by content (a text file
    named .png is not an image). A file that does not fit is skipped, reported per file with the reason and
    remembered, so later runs report it again without reading it until the file or the media set's formats change
    ("Ignore items not matching schema"; with the filter off such a file fails the run).

    Transactions: a transactionless media set takes each file as it arrives (what was written stays when the run
    fails later); a transactional one gets one transaction per run, committed only when the whole run succeeds: a
    file that cannot be read or converted, or a source error, aborts it and nothing of the run becomes visible.

    Incremental ("Exclude files already synced"): files with the modified time and size of the last run are not
    read; a file that was touched but has the same content (SHA-256) is not written again; a changed file replaces
    the item at its path (the earlier one becomes an overwritten version).

    Deletions: a file deleted at the source stays in the media set (media sets are not aware of deletions in the
    source); with `propagate_deletions` its item is soft-deleted (a "deleted" version in the path's history)."""
    import drive
    import media_sets
    from connectors import ConnectorError

    drive._item(fid, need="editor")  # the caller's markings and Project role on the target media set
    s = media_sets.get(fid)
    if not s:
        raise HTTPException(404, "The target is not a media set")
    if s.get("virtual"):
        raise HTTPException(400, "A virtual media set reads its items from its source: use its virtual sync instead")
    if s.get("built_by"):
        raise HTTPException(400, f"A build pipeline writes this media set ({s['built_by']}): sync into another media set")
    policy = s["transaction_policy"]
    formats_sig = f"{s['schema']}|{s.get('primary_format') or ''}|{','.join(s.get('additional_formats') or [])}"
    pattern_kind, keep = path_filter(req.path_matches, folder)  # checked before anything is read
    limit = req.file_size_limit if req.file_size_limit and req.file_size_limit > 0 else None
    walk_limit = 100_000

    def sig(e) -> str:  # noqa: ANN001
        return f"{e.modified.isoformat() if e.modified else ''}|{e.size or 0}"

    def rel_of(path: str) -> str:
        return path[len(folder):].lstrip("/") if folder and path.startswith(folder) else path.lstrip("/")

    def below(path: str) -> bool:
        return not folder or path == folder or path.startswith(folder + "/")

    with _conn_lock(conn_id):
        st = _load(conn_id)
        ms = st.setdefault("media_sets", {}).setdefault(fid, {})
        synced: dict[str, str] = ms.setdefault("synced", {})  # source path → signature of the version in the set
        rejected: dict[str, list] = ms.setdefault("rejected", {})  # source path → [signature, formats, reason] it was refused at
        hashes: dict[str, str] = ms.setdefault("hashes", {})  # source path → SHA-256 of the version in the set
        written: list[str] = []
        skipped: list[dict] = []
        failed: list[dict] = []
        deleted: list[str] = []
        todo: list = []
        unchanged = 0
        filtered = 0
        tx_id: Optional[str] = None
        closed = False
        status = "failed"
        error: Optional[str] = None
        pending: dict[str, tuple[str, str]] = {}  # staged in the open transaction: source path → (signature, hash)
        pending_del: list[str] = []
        try:
            with _file_connector(conn_id) as c:
                listing = c.fs.walk(folder, walk_limit)
                complete = len(listing) < walk_limit
                present = {e.path for e in listing}
                for e in listing:
                    if os.path.splitext(e.path)[1].lower().lstrip(".") not in exts:
                        continue
                    if (keep is not None and not keep(e.path)) or (limit is not None and (e.size or 0) > limit):
                        filtered += 1
                        continue
                    was = rejected.get(e.path) or []
                    if req.exclude_already_synced and synced.get(e.path) == sig(e):
                        unchanged += 1
                    elif req.exclude_already_synced and was[:2] == [sig(e), formats_sig]:
                        skipped.append({"path": e.path, "error": was[2] if len(was) > 2 else "not accepted by the media set's formats", "rejected": True, "remembered": True})
                    else:
                        todo.append(e)
                gone = [p for p in synced if below(p) and p not in present] if complete else []
                if complete:
                    for p in [p for p in rejected if below(p) and p not in present]:
                        rejected.pop(p)
                if not req.propagate_deletions:
                    gone = []
                if policy == "transactional" and (todo or gone):
                    tx_id = media_sets.open_transaction(fid)["id"]
                try:
                    for e in todo[:MAX_FILES]:
                        tmp: Optional[Path] = None
                        try:
                            with _open_stream(c.fs, e.path) as f:
                                tmp, _size, sha = media_sets.spool(f)
                            media_sets.check_file(s, rel_of(e.path), tmp)
                            if e.path in synced and hashes.get(e.path) == sha:
                                synced[e.path] = sig(e)  # touched at the source, same content: nothing to write
                                unchanged += 1
                            elif tx_id:
                                media_sets.stage_file(fid, tx_id, rel_of(e.path), tmp)
                                pending[e.path] = (sig(e), sha)
                            else:
                                media_sets.put_item_file(fid, rel_of(e.path), tmp)
                                synced[e.path] = sig(e)
                                hashes[e.path] = sha
                                rejected.pop(e.path, None)
                                written.append(e.path)
                        except Exception as err:  # noqa: BLE001 - classified below: a refusal, or a failure
                            detail = str(err.detail if isinstance(err, HTTPException) else err)[:300] or type(err).__name__
                            if _is_refusal(err):
                                rejected[e.path] = [sig(e), formats_sig, detail]
                                skipped.append({"path": e.path, "error": detail, "rejected": True})
                                if not req.ignore_items_not_matching_schema:
                                    raise _RunFailed(f"{e.path} does not match the media set's schema ({detail})") from None
                            else:
                                failed.append({"path": e.path, "error": detail, "rejected": False})
                                if tx_id:  # a transactional run commits everything or nothing
                                    raise _RunFailed(f"{e.path}: {detail}") from None
                        finally:
                            if tmp is not None:
                                tmp.unlink(missing_ok=True)
                    for p in gone:
                        target = media_sets.target_path(s, rel_of(p))
                        if tx_id:
                            media_sets.stage_delete(fid, tx_id, target)
                            pending_del.append(p)
                        else:
                            media_sets.delete_path(fid, target)
                            synced.pop(p, None)
                            hashes.pop(p, None)
                            deleted.append(p)
                    if tx_id:
                        if pending or pending_del:
                            media_sets.commit_transaction(fid, tx_id)
                            for p, (sg, sha) in pending.items():
                                synced[p] = sg
                                hashes[p] = sha
                                rejected.pop(p, None)
                                written.append(p)
                            for p in pending_del:
                                synced.pop(p, None)
                                hashes.pop(p, None)
                                deleted.append(p)
                        else:
                            media_sets.abort_transaction(fid, tx_id)
                        closed = True
                    status = "partial" if failed else "succeeded"  # partial: a transactionless run with files that failed
                except _RunFailed as stop:
                    error = str(stop)
        except ConnectorError as e:
            error = str(e)
            raise HTTPException(400, str(e)) from None
        except HTTPException as e:
            error = str(e.detail)
            raise
        finally:
            aborted = 0
            if tx_id and not closed:
                try:  # nothing of a failed transactional run becomes visible
                    media_sets.abort_transaction(fid, tx_id)
                except HTTPException:
                    pass
                aborted = len(pending)
            run = {
                "at": datetime.now(timezone.utc).isoformat(),
                "folder": folder_label,
                "target_media_set_id": fid,
                "target_folder_id": None,
                "transaction_policy": policy,
                "transaction_id": tx_id,
                "status": status,
                "error": error,
                "copied": len(written),
                "accepted": len(written),
                "written": len(written),
                "rejected": len(skipped),
                "skipped": len(skipped),
                "failed": len(failed),
                "unchanged": unchanged,
                "deleted": len(deleted),
                "aborted": aborted,
                "filtered": filtered,
                "path_matches": {"pattern": req.path_matches.strip(), "as": pattern_kind} if pattern_kind else None,
                "remaining": max(0, len(todo) - MAX_FILES) if status != "failed" else max(0, len(todo) - len(written) - len(skipped)),
                "skipped_files": [{"path": x["path"], "reason": x["error"]} for x in skipped[:50]],
                "failed_files": [{"path": x["path"], "reason": x["error"]} for x in failed[:20]],
            }
            st["runs"] = [*st["runs"][-49:], run]
            _state_path(conn_id).write_text(json.dumps(st))
    out = {**run, "files": written[:50], "deleted_files": deleted[:50], "errors": (skipped + failed)[:200]}
    if status == "failed":
        # a run that failed as a whole answers an error, like the source errors of this route (400); the run is in
        # the history above, and the answer carries it so the caller can show its counts and files. A partial run
        # (a transactionless one that kept what arrived) still answers 200 with status "partial".
        raise HTTPException(400, {"message": f"The media set sync failed: {error}", "status": "failed", "run": out})
    return out


class FileExport(BaseModel):
    dataset: dict
    path: str  # file path in the source, e.g. exports/sales.parquet
    format: Literal["parquet", "csv", "jsonl"] = "parquet"


@router.post("/{conn_id}/file-export")
def file_export(conn_id: str, req: FileExport) -> dict:
    import dc_datasets
    import exports
    import pyarrow.csv as pcsv
    import pyarrow.parquet as pq
    from connectors import ConnectorError

    exports._check_connection(conn_id)
    rel = req.path.strip().strip("/")
    if not rel or ".." in rel.split("/"):
        raise HTTPException(400, "Give a file path inside the source, e.g. exports/sales.parquet")
    ext = {"parquet": ".parquet", "csv": ".csv", "jsonl": ".jsonl"}[req.format]
    if not rel.lower().endswith(ext):
        rel += ext
    table, view_id, name = dc_datasets.read(dc_datasets.parse_ref(req.dataset))
    buf = io.BytesIO()
    if req.format == "parquet":
        pq.write_table(table, buf)
        ctype = "application/vnd.apache.parquet"
    elif req.format == "csv":
        pcsv.write_csv(table, buf)
        ctype = "text/csv"
    else:
        for r in table.to_pylist():
            buf.write((json.dumps(r, default=str, ensure_ascii=False) + "\n").encode())
        ctype = "application/x-ndjson"
    data = buf.getvalue()
    try:
        with _file_connector(conn_id) as c:
            c.fs.write(rel, data, ctype)
    except ConnectorError as e:
        raise HTTPException(400, str(e)) from None
    return {"path": rel, "rows": table.num_rows, "bytes": len(data), "dataset": name, "view_id": view_id}
