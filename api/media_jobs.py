"""Shared local source copies of media items and the background jobs of media set access patterns (media_sets.py).

Source copies: an access pattern job (transcription, video frame / thumbnail, waveform, audio transcode) or an HLS
render reads its item from a local file. Every job of an item reads the same copy, fetched once on its own thread in
1 MB chunks (object storage can take a minute for a long video) with progress. An item id is one immutable version (a
new upload is a new id), so a copy stays valid until the item is replaced, deleted or removed by retention, which
drop() handles. Copies are reference-counted: acquire() / release(). A copy nobody holds stays for the next job until
it has been idle SOURCE_IDLE seconds or the LRU sweep needs room (SOURCE_BUDGET bytes over all copies; copies in use
are never removed, so the budget can be exceeded while they are). A fetch all of whose holders released it stops at
its next chunk. Copies live in cache/_src/; files left by an earlier process are swept.

Access jobs: `Job` holds the state the polling client sees (queued with phase fetching / waiting for a worker,
running with progress and a step label, ready, failed, cancelled); `run()` drives one (fetch on the job's own thread,
the computation on the ACCESS_WORKERS pool, so a long fetch does not hold a worker). Access checks stay on the request
thread (media_sets): nothing here checks who may read an item.

Job records: a small JSON per queued / running job next to its output (record() / unrecord()), so a restarted API
process finds interrupted jobs again and another process on the same data sees a job running elsewhere (see the
section at the end and media_sets.resume_jobs).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("bluesandai.media_jobs")

SOURCE_BUDGET = int(os.environ.get("BLUESANDAI_MEDIA_SOURCE_BUDGET") or 4 * 2 ** 30)  # bytes over all unheld copies kept
SOURCE_IDLE = 1800  # seconds an unheld copy is kept after its last use
SOURCE_ORPHAN_AGE = 120  # seconds before a file in cache/_src that no copy owns (an earlier process's) is removed
ACCESS_WORKERS = 2  # access pattern computations running at once (ffmpeg / Whisper); more wait ("queued")

DIR: Path = Path()


def configure(cache_dir: Path) -> None:
    global DIR
    DIR = cache_dir / "_src"
    DIR.mkdir(parents=True, exist_ok=True)


class Cancelled(Exception):
    pass


class Source:
    """One item's local copy: fetching (fetched / total bytes), then ready or failed."""

    def __init__(self, item_id: str, path: Path) -> None:
        self.item_id, self.path = item_id, path
        self.refs = 0
        self.state = "fetching"
        self.fetched, self.total = 0, 0
        self.error: Optional[BaseException] = None
        self.ready = threading.Event()
        self.used = self.created = time.time()
        self.stale = False  # dropped (item replaced / deleted): removed once nobody holds it
        self.abort = False  # every holder released it while fetching: the fetch stops

    @property
    def size(self) -> int:
        return self.fetched

    def fetch_progress(self) -> Optional[float]:
        if self.state == "ready":
            return 1.0
        return round(min(1.0, self.fetched / self.total), 4) if self.total else None

    def wait(self, cancelled: Callable[[], bool] = lambda: False, tick: Optional[Callable[[], None]] = None) -> Path:
        """Block until the copy is ready (its path) or failed (its error); Cancelled when cancelled() turns true."""
        while not self.ready.wait(0.2):
            if tick:
                tick()
            if cancelled():
                raise Cancelled()
        if tick:
            tick()
        if self.state != "ready":
            err = self.error
            if isinstance(err, Cancelled) or err is None:
                raise RuntimeError("the source fetch was stopped")
            raise err
        return self.path


_sources: dict[str, Source] = {}  # item id -> its current copy
_detached: list[Source] = []  # dropped copies still held by a job: removed when released
_lock = threading.Lock()


def acquire(item_id: str, ext: str, opener: Callable[[], tuple]) -> Source:
    """Hold the item's copy, starting its fetch when there is none. opener() -> (chunk iterable, close function or
    None, expected total bytes) runs on the fetch thread. Returns at once; Source.wait() blocks for the bytes."""
    with _lock:
        s = _sources.get(item_id)
        if s is not None and s.state == "ready" and not s.path.exists():
            _sources.pop(item_id, None)
            s = None
        if s is not None and s.state == "failed":
            s = None
        if s is None:
            safe = "".join(ch for ch in (ext or "bin") if ch.isalnum())[:8] or "bin"
            s = Source(item_id, DIR / f"{item_id}.{uuid.uuid4().hex[:8]}.{safe}")
            _sources[item_id] = s
            threading.Thread(target=_fetch, args=(s, opener), name="media-source-fetch", daemon=True).start()
        s.abort = False  # a fetch whose holders had all left continues for this one
        s.refs += 1
        s.used = time.time()
        return s


def release(s: Optional[Source]) -> None:
    if s is None:
        return
    with _lock:
        s.refs = max(0, s.refs - 1)
        s.used = time.time()
        if s.refs == 0:
            if s.state == "fetching":
                s.abort = True
            elif s.stale and s in _detached:
                _detached.remove(s)
                _unlink(s.path)
    sweep()


def drop(item_id: str) -> None:
    """The item was replaced, deleted or removed: its copy goes (at once, or when its last holder releases it)."""
    with _lock:
        s = _sources.pop(item_id, None)
        if s is None:
            return
        s.stale = True
        if s.refs == 0:
            if s.state == "fetching":
                s.abort = True
            else:
                _unlink(s.path)
        else:
            _detached.append(s)


def peek(item_id: str) -> Optional[Source]:
    """The item's copy when it is ready (without holding it), else None."""
    with _lock:
        s = _sources.get(item_id)
        return s if s is not None and s.state == "ready" and s.path.exists() else None


def _unlink(p: Path) -> None:
    try:
        p.unlink(missing_ok=True)
    except OSError:  # Windows: still open somewhere; the orphan sweep removes it later
        pass


def _fetch(s: Source, opener: Callable[[], tuple]) -> None:
    closer = None
    try:
        chunks, closer, total = opener()
        s.total = int(total or 0)
        tmp = s.path.with_name(s.path.name + ".part")
        with open(tmp, "wb") as f:
            for b in chunks:
                with _lock:
                    if s.abort:
                        raise Cancelled()
                f.write(b)
                s.fetched += len(b)
        os.replace(tmp, s.path)
        with _lock:
            if s.abort:  # every holder left just as it finished: keep it like an unheld copy (the sweep decides)
                s.abort = False
            s.state = "ready"
            if not s.total:
                s.total = s.fetched
            if s.stale and s.refs == 0:
                _unlink(s.path)
    except BaseException as e:  # noqa: BLE001 - reported to every waiting job
        with _lock:
            s.state, s.error = "failed", e
            if _sources.get(s.item_id) is s:
                _sources.pop(s.item_id)
        _unlink(s.path.with_name(s.path.name + ".part"))
        if not isinstance(e, Cancelled):
            log.warning("media source fetch of %s failed: %s", s.item_id, e)
    finally:
        if closer:
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass
        s.ready.set()
    sweep()


def sweep() -> int:
    """Remove unheld copies idle for SOURCE_IDLE, then the least recently used unheld ones while all copies together
    exceed SOURCE_BUDGET, and files no copy owns (left by an earlier process). Returns the number removed."""
    now, n = time.time(), 0
    with _lock:
        ready = [s for s in _sources.values() if s.state == "ready"]
        for s in sorted(ready, key=lambda x: x.used):
            if s.refs == 0 and now - s.used > SOURCE_IDLE:
                _sources.pop(s.item_id, None)
                _unlink(s.path)
                n += 1
        ready = [s for s in _sources.values() if s.state == "ready"]
        total = sum(s.size for s in ready) + sum(s.fetched for s in _sources.values() if s.state == "fetching")
        for s in sorted(ready, key=lambda x: x.used):
            if total <= SOURCE_BUDGET:
                break
            if s.refs == 0:
                _sources.pop(s.item_id, None)
                _unlink(s.path)
                total -= s.size
                n += 1
        owned = {s.path.name for s in _sources.values()} | {s.path.name + ".part" for s in _sources.values()} | {s.path.name for s in _detached}
    try:
        files = list(DIR.iterdir()) if DIR.is_dir() else []
    except OSError:
        files = []
    for f in files:
        if f.name in owned:
            continue
        try:
            if now - f.stat().st_mtime > SOURCE_ORPHAN_AGE:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n


def stats() -> dict:
    with _lock:
        return {"copies": len(_sources), "bytes": sum(s.fetched for s in _sources.values()), "held": sum(1 for s in _sources.values() if s.refs),
                "fetching": sum(1 for s in _sources.values() if s.state == "fetching"), "detached": len(_detached), "budget": SOURCE_BUDGET}


def clear() -> None:
    """Forget every unheld copy (tests; a held one is dropped when released)."""
    for item_id in list(_sources):
        drop(item_id)


# ------------------------------------------------------------------------------------------------
# access pattern jobs
# ------------------------------------------------------------------------------------------------

pool = ThreadPoolExecutor(max_workers=ACCESS_WORKERS, thread_name_prefix="media-access")


class Job:
    """One access pattern computation. state: queued (phase "fetching" while the source copy is fetched, then
    "waiting" for a worker) -> running (progress 0-1, step) -> ready / failed / cancelled."""

    def __init__(self, key: str, item_id: str, label: str) -> None:
        self.key, self.item_id, self.label = key, item_id, label
        self.token = uuid.uuid4().hex
        self.state, self.phase, self.step = "queued", "fetching", None
        self.progress = 0.0
        self.error: Optional[str] = None
        self.status_code: Optional[int] = None  # an error about the item or the request itself (400 / 404 / 501)
        self.result: Optional[bytes] = None
        self.result_file: Optional[Path] = None
        self.result_size = 0
        self.created, self.started, self.finished = time.time(), None, None
        self.used = self.created
        self.source: Optional[Source] = None
        self.source_size = 0
        self.info: dict = {}  # the item's streams (an audio / video probe), set by prepare
        self.proc: Any = None  # the running ffmpeg, killed on cancel
        self.cancelled = False
        self.future: Any = None
        self.done = threading.Event()
        self.record_path: Optional[Path] = None  # its job record (see record()), removed when it finishes
        self.remote: Optional[int] = None  # a snapshot of a job another API process runs (its pid): nothing runs here

    def record_live(self) -> dict:
        return {"state": self.state, "phase": self.phase, "progress": round(self.progress, 4), "step": self.step, "started": self.started}

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()

    def view(self) -> dict:
        v: dict[str, Any] = {"state": self.state, "progress": round(self.progress, 4), "token": self.token}
        if self.state == "queued":
            v["phase"] = self.phase
            if self.phase == "fetching" and self.source is not None:
                fp = self.source.fetch_progress()
                if fp is not None:
                    v["fetch_progress"] = fp
        if self.step:
            v["step"] = self.step
        if self.started:
            v["elapsed_seconds"] = round((self.finished or time.time()) - self.started, 2)
            if self.state == "running" and self.progress > 0.02:
                v["eta_seconds"] = round(v["elapsed_seconds"] * (1 - self.progress) / self.progress, 1)
        if self.error:
            v["error"] = self.error
        if self.status_code:
            v["status_code"] = self.status_code
        return v

    def cancel(self) -> bool:
        """Stop a queued or running job (an ffmpeg pass is killed; Whisper stops between pieces). False when finished."""
        if self.state not in ("queued", "running"):
            return False
        self.cancelled = True
        if self.future is not None and self.future.cancel():
            self._finish("cancelled")
            return True
        p = self.proc
        if p is not None:
            try:
                if p.poll() is None:
                    p.kill()
            except OSError:
                pass
        return True

    def _finish(self, state: str) -> None:
        self.state = state
        self.finished = self.used = time.time()
        src, self.source = self.source, None
        release(src)
        unrecord(self.record_path)
        self.done.set()


def run(job: Job, ext: str, opener: Callable[[], tuple], prepare: Callable[[Job, Path], None], compute: Callable[[Job, Path], None]) -> None:
    """Start the job: on its own thread, hold and wait for the item's source copy, then prepare(job, path) (a probe:
    may raise for a bad request), then compute(job, path) on the worker pool. Exceptions become the job's error."""

    def fail(e: BaseException) -> None:
        from fastapi import HTTPException

        if job.cancelled or isinstance(e, Cancelled):
            job._finish("cancelled")
            return
        if isinstance(e, HTTPException):
            job.status_code, job.error = e.status_code, str(e.detail)[:500]
        elif isinstance(e, NotImplementedError):
            job.status_code, job.error = 501, str(e)[:500]
        else:
            job.error = str(e)[:500] or type(e).__name__
            log.warning("media access job %s failed: %s", job.key, job.error)
        job._finish("failed")

    def work() -> None:
        try:
            job.check()
            job.state, job.phase, job.started = "running", None, time.time()
            compute(job, job.source.path)
            job.check()
            job.progress = 1.0
            job._finish("ready")
        except BaseException as e:  # noqa: BLE001
            fail(e)

    def prep() -> None:
        try:
            job.source = src = acquire(job.item_id, ext, opener)
            src.wait(lambda: job.cancelled)
            job.source_size = src.size
            prepare(job, src.path)
            job.check()
            job.phase = "waiting"
            job.future = pool.submit(work)
        except BaseException as e:  # noqa: BLE001
            fail(e)

    threading.Thread(target=prep, name="media-access-prep", daemon=True).start()


def tmpdir() -> Path:
    """A scratch directory for one computation's ffmpeg output (the caller removes it)."""
    d = DIR.parent / "_job" / uuid.uuid4().hex[:12]
    d.mkdir(parents=True, exist_ok=True)
    return d


def rmtree(d: Path) -> None:
    shutil.rmtree(d, ignore_errors=True)


# ------------------------------------------------------------------------------------------------
# job records: one small JSON per queued / running job (an access pattern job or an HLS render), written next to
# its output when it starts, rewritten every RECORD_BEAT seconds with its state and progress, removed when it
# finishes. A record names its API process (pid + process start time), so the next process on the same data
# directory finds the jobs a restart interrupted (media_sets.resume_jobs) and another process sees that a job is
# running elsewhere instead of starting it twice. A record whose process is gone, or which has not been rewritten
# for RECORD_STALE seconds, is an interrupted job.
# ------------------------------------------------------------------------------------------------

RECORD_BEAT = 2.0
RECORD_STALE = 120.0
RECORD_SUFFIX = ".job.json"
_records: dict[str, tuple[Path, dict, Callable[[], dict]]] = {}  # path -> (path, fixed fields, live fields)
_rec_lock = threading.Lock()
_beat: Optional[threading.Thread] = None


def _create_time(pid: int) -> Optional[float]:
    try:
        import psutil

        return round(psutil.Process(pid).create_time(), 2)
    except Exception:  # noqa: BLE001 - psutil missing or no such process
        return None


PROC = {"pid": os.getpid(), "proc_started": _create_time(os.getpid())}


def owner(rec: dict) -> str:
    """"self" (this process), "alive" (another running API process) or "gone" (its process ended or stopped
    rewriting it: the job was interrupted)."""
    if rec.get("pid") == PROC["pid"] and rec.get("proc_started") == PROC["proc_started"]:
        return "self"
    if time.time() - float(rec.get("updated") or 0) > RECORD_STALE:
        return "gone"
    try:
        import psutil
    except ImportError:
        return "alive"  # within RECORD_STALE of its last rewrite
    try:
        started = round(psutil.Process(int(rec.get("pid") or 0)).create_time(), 2)
    except Exception:  # noqa: BLE001 - NoSuchProcess, AccessDenied, a bad pid
        return "gone"
    return "alive" if rec.get("proc_started") is None or abs(started - float(rec["proc_started"])) < 1 else "gone"


def _write_record(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
        tmp.write_text(json.dumps(data), "utf-8")
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except OSError:  # Windows: another process is reading it right now
                if attempt == 4:
                    _unlink(tmp)
                    return
                time.sleep(0.05)
    except OSError as e:
        log.warning("media job record %s not written: %s", path, e)


def write_record(path: Path, data: dict) -> None:
    """A record written once (not kept up to date), e.g. a job marked failed after a restart; owned by this process."""
    _write_record(path, {**data, **PROC, "updated": time.time()})


def record(path: Path, fields: dict, live: Callable[[], dict]) -> None:
    """Record a job that just started: `fields` once, live() at every beat, until unrecord(path)."""
    rec = {**fields, **PROC, "created": time.time()}
    with _rec_lock:
        _records[str(path)] = (path, rec, live)
        _unremoved.discard(str(path))  # a new job of the same output owns the path now
        _write_record(path, {**rec, **live(), "updated": time.time()})
        _ensure_beat()


def unrecord(path: Optional[Path]) -> None:
    if path is None:
        return
    with _rec_lock:
        if _exiting:  # stopped by the process exit (see on_exit): the record stays, so the next process resumes it
            return
        if _records.pop(str(path), None) is not None:
            _remove_record(path)


_unremoved: set[str] = set()  # records a reader held open when their job finished: removed at the next beats


def _remove_record(path: Path) -> None:
    """Remove a finished job's record (under _rec_lock). On Windows a file another thread or process is reading at
    that moment cannot be deleted: retried briefly, then at every beat, so a finished job never leaves a record
    saying queued / running behind."""
    for attempt in range(5):
        try:
            path.unlink(missing_ok=True)
            _unremoved.discard(str(path))
            return
        except OSError:
            time.sleep(0.02 * (attempt + 1))
    _unremoved.add(str(path))
    _ensure_beat()


def _ensure_beat() -> None:
    global _beat
    if _beat is None or not _beat.is_alive():
        _beat = threading.Thread(target=_beat_loop, name="media-job-records", daemon=True)
        _beat.start()


def read_record(path: Path) -> Optional[dict]:
    try:
        rec = json.loads(path.read_text("utf-8"))
        return rec if isinstance(rec, dict) else None
    except (OSError, ValueError):
        return None


def recorded() -> list[str]:
    """The record paths of this process's running jobs."""
    with _rec_lock:
        return list(_records)


def _beat_loop() -> None:
    while True:
        time.sleep(RECORD_BEAT)
        with _rec_lock:
            items = list(_records.values())
            for p in list(_unremoved):
                if p not in _records:
                    _remove_record(Path(p))
                else:
                    _unremoved.discard(p)
        for path, rec, live in items:
            try:
                data = {**rec, **live(), "updated": time.time()}
            except Exception:  # noqa: BLE001 - a job finishing meanwhile
                continue
            with _rec_lock:  # not rewritten once the job finished (unrecord removed it) or the process is exiting
                if str(path) in _records and not _exiting:
                    _write_record(path, data)


# ------------------------------------------------------------------------------------------------
# process exit: the worker pools' threads are joined when the interpreter exits, so a graceful stop of the API waited
# for every running computation (a Whisper piece, a 30-minute render). on_exit() runs first: it stops them at once
# (the hooks media_sets registers cancel its jobs and renders) and freezes their records as they were — queued /
# running, naming this process — so the next process resumes them as after a kill (media_sets.resume_jobs).
# ------------------------------------------------------------------------------------------------

_exiting = False
_exit_hooks: list[Callable[[], None]] = []


def on_exit(hook: Callable[[], None]) -> None:
    """Call hook() (cancel this module user's running work) when the process exits."""
    _exit_hooks.append(hook)


def _at_exit() -> None:
    global _exiting
    with _rec_lock:
        _exiting = True
    for hook in list(_exit_hooks):
        try:
            hook()
        except Exception as e:  # noqa: BLE001 - one failing hook never keeps the others from stopping their work
            log.warning("media job exit hook failed: %s", e)


try:  # before the thread pools' own exit hook (registered earlier, run later) joins their workers
    threading._register_atexit(_at_exit)  # type: ignore[attr-defined]
except (AttributeError, RuntimeError):  # another Python, or already exiting
    import atexit

    atexit.register(_at_exit)
