"""Ontology object storage: where one object type's objects live on disk.

Every read and write of a type's objects goes through load() / save() here (ontology.load_objects / save_objects).

On-disk format (folder data/ontology/objects):

* single file (every type starts here, and what older code reads and writes):
    <type_id>.json                    {primary key: object}, written whole on each save (indent 1, as before)

* shards (a type whose object count reaches the threshold on a write migrates, once):
    <type_id>.shards/manifest.json    {"format": "bluesandai-ontology-shards", "version": 1, "type_id", "gen",
                                       "count", "next_seq", "shards": [file name of shard 0, 1, ...],
                                       "legacy": [size, mtime_ns] of the single file absorbed, or null, "updated_at"}
    <type_id>.shards/sNNNN-<token>.json
                                      {"v": 1, "seq": [...], "objects": {primary key: object}}
  An object's shard is crc32(primary key, UTF-8) % number of shards. Shard files are never rewritten in place: a
  save writes the changed shards as new files and then replaces the manifest (the commit, one atomic rename), so a
  crash leaves either the old or the new state. "seq" keeps the objects' order (the order the single file had, new
  objects at the end), so readers see the same order as before.

Coexistence rule (an older process, e.g. the API started before this code, only knows <type_id>.json):
  1. No <type_id>.shards/manifest.json: the single file is the store (missing = no objects). Shard files without a
     manifest are leftovers of an interrupted migration and are ignored (removed by the next migration).
  2. A manifest exists: the shards are the store, whatever single file sits next to them. Such a file is either the
     migrated file whose removal was interrupted (its [size, mtime_ns] equals the manifest's "legacy") - removed on
     the next save - or a file written afterwards by code that does not know shards. That code read the type as
     empty (the single file was gone), so its file cannot be the whole type: it is never read, and the next save
     moves it to <type_id>.shards/foreign-<time>.json (kept, for recovery by hand). info() reports either case.

Migration: when a save finds the single file and len(objects) >= threshold, the shards and then the manifest are
written (temp file + rename for each); only after the manifest is in place is the single file removed. A failure
before the manifest rename leaves the single file authoritative and untouched.

Resizing (hysteresis, so a type near a boundary does not flip back and forth on every save):
  * grow: a save with more than 4 x TARGET_PER_SHARD objects per shard writes a new generation with more shards.
  * shrink: a save with fewer than TARGET_PER_SHARD / 4 objects per shard (and more than MIN_SHARDS shards) writes a
    new generation with fewer shards (_n_shards: a power of two). Same steps as a re-shard: new shard files, then the
    manifest (the commit), then the old files removed.
  * unshard: a save with fewer objects than unshard_threshold() (half the migration threshold) moves the type back
    to the single file: (1) the single file's bytes go to <type_id>.tmp; (2) the manifest is rewritten with
    "unshard": [size, mtime_ns] of that temp file (the shards still rule; a rename keeps both values); (3) the temp
    file is renamed to <type_id>.json - a single file next to the manifest whose signature equals "unshard" is a
    recognised leftover (removed by the next sharded save, never moved aside as foreign); (4) the manifest is removed
    (the commit: from now on rule 1, the single file is the store); (5) the shard files are removed (leftovers of a
    crash here are ignored without a manifest). A crash before (4) leaves the old shards authoritative and
    unchanged; after it, the new single file.

Leftovers of an interrupted save are removed by the next save of the type: <type_id>.tmp and an "unshard" mark by a
sharded save, shard and temp files no manifest names by any save once they are ORPHAN_AGE (60 s) old - younger ones
may belong to another process's save that has not committed yet - and the empty <type_id>.shards folder with them.

Locking: saves serialize on a module lock (callers keep their own locks, e.g. ontology._lock); readers take no lock
and retry when a save replaced a shard they were about to read.

Read cache (in process): parsing a big type's JSON costs far more than using it (6,000 objects with 384-float vectors:
~460 ms json.loads). Each parsed file - the single file, or one shard - is kept "frozen" in an LRU keyed by the file's
stat signature [size, mtime_ns, inode]; a read whose stat matches skips the parse. Writes by this process put what they
wrote into the cache (or drop the entry); writes by another process or by hand change the signature, so the next read
parses the file again. For a sharded type only the shards whose signature changed are parsed again (shard files are
immutable and uniquely named anyway); a new manifest generation (a re-shard or shrink, here or in another process) drops
the shards it no longer names, and a read that finds a type unsharded since its last sharded read drops all of them. A file whose mtime is within RACY_NS (3 s) of when its content was seen could
hide a same-size in-place write in the same timestamp tick, so such an entry is checked against the file's bytes
(crc32) on each hit until it is old enough to trust its signature (git's racy-timestamp rule).
  Callers own what load() returns and may change it at any depth (apply_edits, scenarios, data source syncs do). So the
cache never hands out its own containers: load() rebuilds every dict and list ("thaw"). To make that cheap the frozen
form stores a list of scalars (str/int/float/bool/None) as a tuple and a dict as an _FDict that knows which of its
values are containers, so thaw copies them at C speed (list(t), dict(d)) instead of walking each item; scalars are
immutable and shared. Parse and thaw run with the cyclic GC paused. Loading that 6,000-object type from the cache
takes ~20 ms (~270 ms parsing it). The budget (env BLUESANDAI_ONTOLOGY_CACHE_MB, default 512, 0 = no cache) is
measured in estimated memory: CACHE_FACTOR x the file's bytes (parsed JSON measured at 1.2-2.4x its indent-1 file size).
"""

from __future__ import annotations

import gc
import hashlib
import json
import logging
import math
import os
import shutil
import threading
import time
import uuid
import zlib
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

log = logging.getLogger("ontology.store")

FORMAT = "bluesandai-ontology-shards"
ROOT: Path = Path()
# objects per type at which a save migrates the single file to shards (env BLUESANDAI_ONTOLOGY_SHARD_THRESHOLD)
THRESHOLD = 20000
# objects per shard aimed at (env BLUESANDAI_ONTOLOGY_SHARD_SIZE); a type re-shards when it grows to 4x that per shard
TARGET_PER_SHARD = 2048
MIN_SHARDS, MAX_SHARDS = 8, 4096
# per-type threshold overrides (tests use these for their "(test)" types only)
THRESHOLD_OVERRIDES: dict[str, int] = {}
# crash simulation for tests: called with a step name ("shard", "before-commit", "after-commit", "before-unlink";
# unshard: "unshard-temp", "unshard-marked", "unshard-single", then "before-commit", "after-commit"); raising from it
# aborts the save at that point
FAULT: Optional[Callable[[str], None]] = None
# seconds a shard or temp file no manifest names must be old before a save removes it (younger: maybe another
# process's save that has written it and not committed yet)
ORPHAN_AGE = 60.0

_wlock = threading.RLock()
# shard file name -> sha1 of its bytes (shard files are immutable, so the name identifies the content)
_digests: dict[tuple[str, str], str] = {}
# type id -> (manifest gen, {primary key: seq}) of the last load or save in this process
_seqs: dict[str, tuple[str, dict[str, int]]] = {}


def configure(objects_dir: Path, env: Callable[[str], str] = lambda k: "") -> None:
    global ROOT, THRESHOLD, TARGET_PER_SHARD
    ROOT = objects_dir
    ROOT.mkdir(parents=True, exist_ok=True)
    try:
        THRESHOLD = max(1, int(env("BLUESANDAI_ONTOLOGY_SHARD_THRESHOLD") or os.environ.get("BLUESANDAI_ONTOLOGY_SHARD_THRESHOLD") or THRESHOLD))
        TARGET_PER_SHARD = max(16, int(env("BLUESANDAI_ONTOLOGY_SHARD_SIZE") or os.environ.get("BLUESANDAI_ONTOLOGY_SHARD_SIZE") or TARGET_PER_SHARD))
    except ValueError:
        pass
    budget = _env_budget(env)
    if budget is not None:
        set_cache_budget(budget)
    cache_clear()


# ------------------------------------------------------------------------------------------------
# read cache (see the module docstring)
# ------------------------------------------------------------------------------------------------

# estimated bytes in memory per byte of the parsed file
CACHE_FACTOR = 2.5
# file timestamps closer than this to the moment the content was seen may hide a same-size write (coarse mtime ticks:
# NTFS ~16 ms in practice, FAT 2 s): such entries are checked against the file's bytes (see _Cache)
RACY_NS = 3_000_000_000
_SCALARS = frozenset({str, int, float, bool, type(None)})


class _FDict(dict):
    """A frozen dict; ck: the keys whose values are containers (frozen too). Thawed with one dict() copy plus one
    _thaw per container value."""
    __slots__ = ("ck",)


class _NotJson(Exception):
    pass


def _freeze(x: Any, strict: bool = False) -> Any:
    """The frozen form of parsed JSON: new containers throughout (never the caller's); a list of scalars becomes a
    tuple, a dict an _FDict, any other list stays a list of frozen values. strict (data a caller passed to save, not
    parsed): raise _NotJson for anything a JSON round trip would change (tuples, non-str keys, subclasses, other
    types), so the cache only ever holds what a fresh parse of the file would give."""
    t = type(x)
    if t is dict:
        if strict and not {str}.issuperset(map(type, x)):
            raise _NotJson
        out = _FDict(x)
        if _SCALARS.issuperset(map(type, x.values())):
            out.ck = ()
        else:
            ck = [k for k, v in x.items() if type(v) not in _SCALARS]
            for k in ck:
                out[k] = _freeze(x[k], strict)
            out.ck = tuple(ck)
        return out
    if t is list:
        if _SCALARS.issuperset(map(type, x)):
            return tuple(x)
        return [v if type(v) in _SCALARS else _freeze(v, strict) for v in x]
    if strict:
        raise _NotJson
    return x


def _thaw(x: Any) -> Any:
    """A fully independent copy of a frozen value as plain dicts and lists (scalars shared: immutable)."""
    t = type(x)
    if t is _FDict:
        out = dict(x)
        for k in x.ck:
            out[k] = _thaw(out[k])
        return out
    if t is tuple:
        return list(x)
    if t is list:
        return [v if type(v) in _SCALARS else _thaw(v) for v in x]
    return x


_gc_lock = threading.Lock()
_gc_depth = 0
_gc_was_enabled = False
_gc_since = 0.0
_GC_MAX_PAUSE = 5.0


class _GcPaused:
    """Cyclic GC off while building many acyclic containers (a parse, a thaw): otherwise the allocations trigger full
    collections that walk the whole heap, the cache included (measured: a 50,000-object thaw 95 ms without, 100-400 ms
    with). Nested and concurrent uses count; GC comes back on when the last one ends, if it was on before. Loads that
    overlap without a break (busy server threads) would keep it off indefinitely: then a collection runs every
    _GC_MAX_PAUSE seconds anyway."""

    def __enter__(self) -> None:
        global _gc_depth, _gc_was_enabled, _gc_since
        with _gc_lock:
            if _gc_depth == 0:
                _gc_was_enabled = gc.isenabled()
                _gc_since = time.monotonic()
                gc.disable()
            _gc_depth += 1

    def __exit__(self, *exc: Any) -> None:
        global _gc_depth, _gc_since
        collect = False
        with _gc_lock:
            _gc_depth -= 1
            if _gc_depth == 0:
                if _gc_was_enabled:
                    gc.enable()
            elif _gc_was_enabled and time.monotonic() - _gc_since > _GC_MAX_PAUSE:
                _gc_since = time.monotonic()
                collect = True
        if collect:
            gc.collect()


class _Cache:
    """LRU of frozen parsed files: key -> (stat signature, frozen value, estimated bytes, crc32 of the file's bytes,
    trusted). An entry is "racy" (not trusted) while its mtime is within RACY_NS of when the content was observed: a
    later write in the same timestamp tick (same size, in place, so same inode) would keep the signature. A racy entry
    is checked against the file's bytes (read + crc32, far cheaper than a parse) on every hit until a check made more
    than RACY_NS after the mtime passes; then the signature alone decides (the git "racy timestamp" rule)."""

    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.used = 0
        self.items: "OrderedDict[tuple, tuple[tuple, Any, int, int, bool]]" = OrderedDict()
        self.lock = threading.Lock()
        self.stats = {"hits": 0, "misses": 0, "evictions": 0, "puts": 0, "skipped": 0, "verified": 0, "racy_misses": 0}

    def get(self, key: tuple, p: Path) -> Any:
        """The frozen value when the file p still is what was cached, else None (the caller parses p)."""
        if self.budget <= 0:
            return None
        sig = _psig(p)
        with self.lock:
            e = self.items.get(key)
            if sig is None or e is None or e[0] != sig:
                self.stats["misses"] += 1
                return None
            if e[4]:
                self.items.move_to_end(key)
                self.stats["hits"] += 1
                return e[1]
        # racy: compare the bytes (outside the lock)
        obs = time.time_ns()
        try:
            raw, rsig = _read_with_sig(p)
        except OSError:
            raw, rsig = b"", None
        same = rsig == sig and zlib.crc32(raw) == e[3]
        with self.lock:
            if not same:
                self.stats["misses"] += 1
                self.stats["racy_misses"] += 1
                return None
            if self.items.get(key) is e:
                if obs - sig[1] > RACY_NS:
                    self.items[key] = e[:4] + (True,)
                self.items.move_to_end(key)
            self.stats["hits"] += 1
            self.stats["verified"] += 1
            return e[1]

    def put(self, key: tuple, sig: Optional[tuple], value: Any, est: int, crc: int = 0, obs: int = 0) -> None:
        """obs: time.time_ns() taken before the content was read (or after it was written)."""
        with self.lock:
            old = self.items.pop(key, None)
            if old:
                self.used -= old[2]
            if sig is None or est > self.budget:
                self.stats["skipped"] += 1
                return
            self.items[key] = (sig, value, est, crc, obs - sig[1] > RACY_NS)
            self.used += est
            self.stats["puts"] += 1
            while self.used > self.budget and self.items:
                self.used -= self.items.popitem(last=False)[1][2]
                self.stats["evictions"] += 1

    def drop(self, pred: Callable[[tuple], bool]) -> None:
        with self.lock:
            for k in [k for k in self.items if pred(k)]:
                self.used -= self.items.pop(k)[2]


def _env_budget(env: Callable[[str], str] = lambda k: "") -> Optional[int]:
    try:
        return max(0, int(float(env("BLUESANDAI_ONTOLOGY_CACHE_MB") or os.environ.get("BLUESANDAI_ONTOLOGY_CACHE_MB") or 512) * 1024 * 1024))
    except ValueError:
        return None


_b = _env_budget()
_cache = _Cache(512 * 1024 * 1024 if _b is None else _b)
del _b
# type id -> manifest gen whose replaced shards were last dropped from the cache (see _load)
_cache_gens: dict[str, str] = {}


def set_cache_budget(n_bytes: int) -> None:
    """Estimated memory the read cache may hold (0 turns it off); evicts least recently used entries to fit."""
    with _cache.lock:
        _cache.budget = max(0, int(n_bytes))
        while _cache.used > _cache.budget and _cache.items:
            _cache.used -= _cache.items.popitem(last=False)[1][2]
            _cache.stats["evictions"] += 1


def cache_clear(type_id: Optional[str] = None) -> None:
    _cache.drop(lambda k: type_id is None or k[1] == type_id)


def cache_info() -> dict:
    with _cache.lock:
        return {"budget": _cache.budget, "used": _cache.used, "entries": len(_cache.items),
                "keys": [list(k) for k in _cache.items], **_cache.stats}


def _fsig(s: os.stat_result) -> tuple:
    return (s.st_size, s.st_mtime_ns, s.st_ino)


def _psig(p: Path) -> Optional[tuple]:
    try:
        return _fsig(os.stat(p))
    except OSError:
        return None


def _read_with_sig(p: Path) -> tuple[bytes, tuple]:
    """The file's bytes and the signature of the very file read (fstat on the open handle)."""
    _reader_gate()
    with open(p, "rb") as f:
        sig = _fsig(os.fstat(f.fileno()))
        return f.read(), sig


def _read_for_cache(p: Path) -> tuple[bytes, tuple, int]:
    """_read_with_sig plus the time taken before the read (the cache's racy check)."""
    obs = time.time_ns()
    raw, sig = _read_with_sig(p)
    return raw, sig, obs


def _est(n_bytes: int) -> int:
    return int(n_bytes * CACHE_FACTOR) + 256


# ------------------------------------------------------------------------------------------------
# paths and small helpers
# ------------------------------------------------------------------------------------------------


def _check_id(type_id: str) -> str:
    t = str(type_id)
    if not t or any(c in t for c in "/\\:") or t in (".", "..") or t.endswith(".shards"):
        raise ValueError(f"bad object type id {type_id!r}")
    return t


def single_path(type_id: str) -> Path:
    return ROOT / f"{_check_id(type_id)}.json"


def shard_dir(type_id: str) -> Path:
    return ROOT / f"{_check_id(type_id)}.shards"


def _manifest_path(type_id: str) -> Path:
    return shard_dir(type_id) / "manifest.json"


def shard_of(pk: str, n: int) -> int:
    return zlib.crc32(str(pk).encode("utf-8")) % n


def _sig(p: Path) -> Optional[list[int]]:
    try:
        s = p.stat()
        return [s.st_size, s.st_mtime_ns]
    except OSError:
        return None


def _fault(step: str) -> None:
    if FAULT:
        FAULT(step)


# Windows refuses to replace or delete a file somebody has open. Readers of this process take no lock, and a thread
# that opened a file may wait for the interpreter lock with the handle still open, so with a few threads loading one
# type in a loop a save found the file open at each of its 40 tries and failed (PermissionError after 2 s). While a
# save retries, this event is clear: this process's readers finish the file they have and wait here before opening
# the next one, so the retry goes through.
_readers_go = threading.Event()
_readers_go.set()


def _reader_gate() -> None:
    if not _readers_go.is_set():
        _readers_go.wait(1.0)  # bounded: the file may be held by another process, readers must not hang on that


def _replace(tmp: Path, dest: Path) -> None:
    # Windows refuses the replace while a reader thread or another process (the API, a virus scanner) has the file
    # open: retry briefly
    try:
        for attempt in range(40):
            try:
                os.replace(tmp, dest)
                return
            except PermissionError:
                if attempt == 39:
                    raise
                _readers_go.clear()
                time.sleep(0.005 if attempt < 4 else 0.05)
    finally:
        _readers_go.set()


def _write_bytes(dest: Path, data: bytes) -> None:
    tmp = dest.with_name(f"{dest.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _replace(tmp, dest)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _unlink(p: Path) -> bool:
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _manifest(type_id: str) -> Optional[dict]:
    _reader_gate()
    try:
        m = json.loads(_manifest_path(type_id).read_bytes())
    except FileNotFoundError:
        return None
    if not isinstance(m, dict) or m.get("format") != FORMAT or not isinstance(m.get("shards"), list):
        raise RuntimeError(f"{_manifest_path(type_id)} is not a shard manifest")
    return m


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# reading
# ------------------------------------------------------------------------------------------------


def _read_shard(type_id: str, name: str) -> tuple[tuple, dict]:
    """A shard as (seq, {primary key: frozen object}), from the cache when the file's signature still matches."""
    p = shard_dir(type_id).joinpath(name)
    key = ("shard", type_id, name)
    hit = _cache.get(key, p)
    if hit is not None:
        return hit
    raw, sig, obs = _read_for_cache(p)
    _digests[(type_id, name)] = hashlib.sha1(raw).hexdigest()
    sh = json.loads(raw)
    if _cache.budget <= 0:
        # no cache: the parsed objects are this call's own (_thaw passes plain dicts and lists through)
        return sh["seq"], sh["objects"]
    val = (tuple(sh["seq"]), {pk: _freeze(o) for pk, o in sh["objects"].items()})
    _cache.put(key, sig, val, _est(len(raw)), zlib.crc32(raw), obs)
    return val


def _cache_shard(type_id: str, name: str, b: list[tuple[int, str, dict]], raw: bytes) -> None:
    """Put a shard this process just wrote (b: its (seq, primary key, object) rows, raw: its bytes) into the cache.
    An object already frozen (an _FDict: a count save's other objects of the shard, from the cache; never a caller's,
    load() and get_many() hand out thawed copies) is kept as it is (frozen values are never changed in place)."""
    if _cache.budget <= 0:
        return
    try:
        with _GcPaused():
            val = (tuple(s for s, _, _ in b), {pk: o if type(o) is _FDict else _freeze(o, True) for _, pk, o in b})
    except _NotJson:
        return
    _cache.put(("shard", type_id, name), _psig(shard_dir(type_id) / name), val, _est(len(raw)), zlib.crc32(raw),
               time.time_ns())


def _load_single(type_id: str) -> dict:
    """The single file's objects (FileNotFoundError when there is none)."""
    p = single_path(type_id)
    key = ("single", type_id)
    hit = _cache.get(key, p)
    if hit is not None:
        return {pk: _thaw(o) for pk, o in hit.items()}
    raw, sig, obs = _read_for_cache(p)
    objs = json.loads(raw) or {}
    if type(objs) is dict and _cache.budget > 0:
        # _freeze builds new containers throughout: the caller may change objs, the cache keeps its own copy
        _cache.put(key, sig, {pk: _freeze(o) for pk, o in objs.items()}, _est(len(raw)), zlib.crc32(raw), obs)
    return objs


def _live(type_id: str) -> Any:
    """ontology_live when the type is a live type (read straight from its dataset), else None."""
    import ontology_live

    return ontology_live if ontology_live.is_live(type_id) else None


def load(type_id: str) -> dict[str, dict]:
    """The type's objects {primary key: object} (new dicts and lists throughout, each call: callers may change them).
    A live type's come as a mapping read on demand (ontology_live.LiveObjects)."""
    if (lv := _live(type_id)) is not None:
        return lv.load(type_id)
    with _GcPaused():
        return _load(type_id)


def get_many(type_id: str, keys: Iterable[Any]) -> dict[str, dict]:
    """The stored objects with these primary keys (new dicts and lists; keys not stored are left out). A sharded type
    reads only their shards; a single file comes from the cache when it is still current (else it is parsed)."""
    want = {str(k) for k in keys}
    if not want:
        return {}
    if (lv := _live(type_id)) is not None:
        return lv.get_many(type_id, want)
    with _GcPaused():
        for attempt in range(40):
            try:
                m = _manifest(type_id)
                if m is None:
                    hit = _cache.get(("single", type_id), single_path(type_id))
                    if hit is not None:
                        return {k: _thaw(hit[k]) for k in want if k in hit}
                    try:
                        objs = _load_single(type_id)
                    except FileNotFoundError:
                        if _manifest_path(type_id).exists():
                            continue  # migrated meanwhile
                        return {}
                    return {k: objs[k] for k in want if k in objs}
                n = len(m["shards"])
                out: dict[str, dict] = {}
                for i in sorted({shard_of(k, n) for k in want}):
                    _, objs = _read_shard(type_id, m["shards"][i])
                    out.update({k: _thaw(objs[k]) for k in want if k in objs})
                return out
            except FileNotFoundError:
                continue  # a save replaced a shard after we read the manifest: read again
            except PermissionError:
                time.sleep(0.02 * min(attempt + 1, 5))
                continue
    raise RuntimeError(f"objects of {type_id} kept changing while being read")


def _load(type_id: str) -> dict[str, dict]:
    for attempt in range(40):
        try:
            m = _manifest(type_id)
            if m is None:
                if _cache_gens.pop(type_id, None) is not None:
                    # sharded when last read here, unsharded since (maybe by another process): its shards are dead
                    _seqs.pop(type_id, None)
                    _cache.drop(lambda k: k[0] == "shard" and k[1] == type_id)
                try:
                    return _load_single(type_id)
                except FileNotFoundError:
                    if _manifest_path(type_id).exists():
                        continue  # migrated meanwhile
                    return {}
            shards = [_read_shard(type_id, name) for name in m["shards"]]
        except FileNotFoundError:
            continue  # a save replaced a shard after we read the manifest: read again
        except PermissionError:
            # Windows: the file is being replaced or deleted by a save right now
            time.sleep(0.02 * min(attempt + 1, 5))
            continue
        # objects in seq order: seqs are unique and below next_seq, so place them in slots instead of sorting
        size = max([int(m.get("next_seq") or 0)] + [max(seq) + 1 for seq, _ in shards if seq])
        slots: list = [None] * size
        seq_map: dict[str, int] = {}
        merged: dict[str, Any] = {}
        for seq, objs in shards:
            for s, pk in zip(seq, objs):
                slots[s] = pk
                seq_map[pk] = s
            merged.update(objs)
        order = [pk for pk in slots if pk is not None]
        if len(order) != len(merged):
            # two objects with one seq (should not happen): never drop one, order by (seq, key)
            order = sorted(merged, key=lambda pk: (seq_map.get(pk, size), pk))
        _seqs[type_id] = (m["gen"], seq_map)
        if _cache_gens.get(type_id) != m["gen"]:
            # a new generation (maybe another process's save): forget the shards it replaced
            _cache_gens[type_id] = m["gen"]
            live = set(m["shards"])
            _cache.drop(lambda k: k[0] == "shard" and k[1] == type_id and k[2] not in live)
        return {pk: _thaw(merged[pk]) for pk in order}
    raise RuntimeError(f"objects of {type_id} kept changing while being read")


# object counts of single-file types by file signature, kept apart from the object cache so that loading big types
# never evicts them: listing every type (the lineage, the Nexus) used to load and copy each type's objects to count them
_count_cache = _Cache(8 * 1024 * 1024)


def count(type_id: str) -> int:
    if (lv := _live(type_id)) is not None:
        return lv.count(type_id)
    m = _manifest(type_id)
    if m:
        return int(m.get("count") or 0)
    p = single_path(type_id)
    hit = _cache.get(("single", type_id), p)
    if hit is not None:
        return len(hit)
    n = _count_cache.get(("count", type_id), p)
    if n is not None:
        return n
    try:
        raw, sig, obs = _read_for_cache(p)
    except FileNotFoundError:
        return len(load(type_id))  # none yet, or sharded meanwhile
    n = len(json.loads(raw) or {})
    _count_cache.put(("count", type_id), sig, n, 256, zlib.crc32(raw), obs)
    return n


def exists(type_id: str) -> bool:
    return _manifest_path(type_id).exists() or single_path(type_id).exists() or _live(type_id) is not None


def stat(type_id: str) -> Optional[dict]:
    """{format, mtime_ns, size} of what holds the type's objects: changes whenever they change (freshness, volume)."""
    if (lv := _live(type_id)) is not None:
        return lv.stat(type_id)
    m_sig = _sig(_manifest_path(type_id))
    if m_sig:
        try:
            m = _manifest(type_id) or {}
        except (RuntimeError, ValueError):
            m = {}
        size = sum((_sig(shard_dir(type_id) / n) or [0, 0])[0] for n in m.get("shards") or [])
        return {"format": "shards", "mtime_ns": m_sig[1], "size": size}
    s = _sig(single_path(type_id))
    return {"format": "single", "mtime_ns": s[1], "size": s[0]} if s else None


def info(type_id: str) -> dict:
    """What is on disk for the type (tests, diagnostics)."""
    m = _manifest(type_id)
    single = _sig(single_path(type_id))
    out: dict[str, Any] = {"type_id": type_id, "format": "shards" if m else ("single" if single else "none"),
                           "threshold": threshold(type_id)}
    if m:
        out.update(shards=len(m["shards"]), count=m.get("count"), gen=m.get("gen"), files=list(m["shards"]))
        if single:
            out["single_file"] = ("migrated leftover" if single == m.get("legacy") else
                                  "unshard leftover" if single == m.get("unshard") else "foreign (ignored)")
        out["foreign_files"] = sorted(p.name for p in shard_dir(type_id).glob("foreign-*.json"))
    return out


# ------------------------------------------------------------------------------------------------
# writing
# ------------------------------------------------------------------------------------------------


def threshold(type_id: str) -> int:
    return THRESHOLD_OVERRIDES.get(type_id) or THRESHOLD


def unshard_threshold(type_id: str) -> int:
    """Objects below which a save moves a sharded type back to the single file: half the migration threshold, so a
    type that hovers around the threshold does not migrate and return on alternate saves."""
    return threshold(type_id) // 2


def _n_shards(n_objects: int) -> int:
    want = max(1, math.ceil(n_objects / TARGET_PER_SHARD))
    return min(MAX_SHARDS, max(MIN_SHARDS, 1 << (want - 1).bit_length()))


def _serialize(objs: list[tuple[int, str, dict]]) -> bytes:
    return json.dumps({"v": 1, "seq": [s for s, _, _ in objs], "objects": {pk: o for _, pk, o in objs}},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _shard_name(i: int) -> str:
    return f"s{i:04d}-{uuid.uuid4().hex[:10]}.json"


def _write_single(type_id: str, objs: dict, before_replace: Optional[Callable[[Path], None]] = None) -> None:
    """before_replace(temp file): called once the temp file is written, before it is renamed into place (unshard)."""
    # the same bytes ontology._write produced before shards existed
    p = single_path(type_id)
    # an unshard's temp file has the fixed name <type_id>.tmp (the protocol in the module docstring: the next save
    # removes it); a plain write uses a temp file of its own, so two processes saving the same type at once cannot
    # write into one temp file, and those clean-ups never remove a plain write that is still in flight
    tmp = p.with_suffix(".tmp") if before_replace else p.with_name(f"{p.name}.{uuid.uuid4().hex[:8]}.tmp")
    text = json.dumps(objs, ensure_ascii=False, indent=1)
    # = tmp.write_text(text, "utf-8") (text mode turns "\n" into os.linesep; JSON strings never hold a raw newline),
    # as bytes so the cache knows exactly what is on disk
    data = (text.replace("\n", os.linesep) if os.linesep != "\n" else text).encode("utf-8")
    try:
        if before_replace:
            # unshard: this file replaces committed shards, so its bytes must be on disk before the commit
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        else:
            tmp.write_bytes(data)
        tsig = _psig(tmp)
        if before_replace:
            before_replace(tmp)
        _replace(tmp, p)
    except BaseException:
        if not before_replace:
            _unlink(tmp)
        raise
    obs = time.time_ns()
    # what was written goes into the read cache under the file's signature, when the rename kept it (same file) and
    # the data is plain JSON (a JSON round trip would not change it); else the entry is dropped and the next read parses
    sig = _psig(p)
    frozen = None
    if tsig is not None and sig == tsig and type(objs) is dict and _cache.budget > 0:
        try:
            with _GcPaused():
                frozen = {pk: _freeze(o, True) for pk, o in objs.items()} if {str}.issuperset(map(type, objs)) else None
        except _NotJson:
            frozen = None
    _cache.put(("single", type_id), sig if frozen is not None else None, frozen, _est(len(data)), zlib.crc32(data), obs)


def _commit(type_id: str, m: dict) -> None:
    _write_bytes(_manifest_path(type_id), json.dumps(m, ensure_ascii=False, indent=1).encode("utf-8"))


def _write_generation(type_id: str, objs: dict, seqs: list[int], legacy: Optional[list[int]], old: Optional[dict]) -> None:
    """All shards anew, then the manifest (the commit). Used to migrate and to re-shard."""
    d = shard_dir(type_id)
    d.mkdir(parents=True, exist_ok=True)
    n = _n_shards(len(objs))
    buckets: list[list[tuple[int, str, dict]]] = [[] for _ in range(n)]
    for s, (pk, o) in zip(seqs, objs.items()):
        buckets[shard_of(pk, n)].append((s, pk, o))
    names = []
    for i, b in enumerate(buckets):
        name = _shard_name(i)
        raw = _serialize(b)
        _write_bytes(d / name, raw)
        _digests[(type_id, name)] = hashlib.sha1(raw).hexdigest()
        _cache_shard(type_id, name, b, raw)
        names.append(name)
        _fault("shard")
    _fault("before-commit")
    gen = uuid.uuid4().hex[:12]
    _commit(type_id, {"format": FORMAT, "version": 1, "type_id": type_id, "gen": gen, "count": len(objs),
                      "next_seq": (max(seqs) + 1) if seqs else 0, "shards": names,
                      "legacy": legacy if old is None else old.get("legacy"), "updated_at": _now()})
    _seqs[type_id] = (gen, dict(zip(objs.keys(), seqs)))
    _fault("after-commit")
    for name in (old or {}).get("shards") or []:
        _unlink(d / name)
    _gc(type_id, set(names))


def _gc(type_id: str, keep: set[str]) -> None:
    """Shard and temp files no manifest refers to (interrupted saves, replaced shards a reader still held)."""
    cutoff = time.time() - ORPHAN_AGE
    for p in shard_dir(type_id).iterdir():
        if p.name == "manifest.json" or p.name in keep or p.name.startswith("foreign-"):
            continue
        if p.suffix in (".json", ".tmp") and p.name.startswith(("s", "manifest.json.")):
            try:
                if p.stat().st_mtime > cutoff:
                    continue  # maybe another process's save in progress (written, not committed yet)
            except OSError:
                continue
            _unlink(p)
            _digests.pop((type_id, p.name), None)
    _cache.drop(lambda k: k[0] == "shard" and k[1] == type_id and k[2] not in keep)


def _settle_single(type_id: str, m: dict) -> None:
    """A single file next to committed shards (coexistence rule 2): remove the migrated leftover, keep a foreign one
    aside."""
    p = single_path(type_id)
    s = _sig(p)
    if not s:
        return
    _cache.drop(lambda k: k == ("single", type_id))
    if s == m.get("legacy") or s == m.get("unshard"):
        # the migrated file, or the file of an unshard interrupted before its commit
        _unlink(p)
        return
    dest = shard_dir(type_id) / f"foreign-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}.json"
    try:
        _replace(p, dest)
        log.warning("objects of %s: %s was written by code that does not know shards; ignored and kept as %s", type_id, p.name, dest.name)
    except OSError:
        pass


def _sweep(type_id: str) -> None:
    """No manifest: the shard and temp files an interrupted migration or unshard left in <type_id>.shards go (older
    than ORPHAN_AGE; foreign-* files stay), and the folder with them when it is empty."""
    d = shard_dir(type_id)
    if not d.is_dir():
        return
    try:
        _gc(type_id, set())
        d.rmdir()
    except OSError:
        pass


def _remove(p: Path) -> None:
    """Delete a file that must go (a commit): retried while Windows refuses because a reader has it open."""
    try:
        for attempt in range(40):
            try:
                p.unlink()
                return
            except FileNotFoundError:
                return
            except PermissionError:
                if attempt == 39:
                    raise
                _readers_go.clear()  # see _reader_gate
                time.sleep(0.005 if attempt < 4 else 0.05)
    finally:
        _readers_go.set()


def _unshard(type_id: str, objs: dict, m: dict) -> dict:
    """Back to the single file (steps and crash states: the module docstring, "unshard")."""
    d = shard_dir(type_id)
    base = {k: v for k, v in m.items() if k != "unshard"}

    def mark(tmp: Path) -> None:
        _fault("unshard-temp")
        # the shards still rule; the single file about to appear is recognised as this unshard's (rename keeps the
        # size and mtime)
        _commit(type_id, {**base, "unshard": _sig(tmp), "updated_at": _now()})
        _fault("unshard-marked")

    _write_single(type_id, objs, mark)
    _fault("unshard-single")
    _fault("before-commit")
    _remove(_manifest_path(type_id))
    _seqs.pop(type_id, None)
    _cache_gens.pop(type_id, None)
    _fault("after-commit")
    for name in m.get("shards") or []:
        if _unlink(d / name):
            _digests.pop((type_id, name), None)
    _cache.drop(lambda k: k[0] == "shard" and k[1] == type_id)
    for k in [k for k in list(_digests) if k[0] == type_id]:
        _digests.pop(k, None)
    # what earlier interrupted saves left, then the folder when it is empty (foreign files, young orphans and shards
    # a reader still held stay)
    _sweep(type_id)
    log.info("objects of %s: %d objects moved back from %d shards to the single file", type_id, len(objs), len(m.get("shards") or []))
    return {"format": "single", "written": 1, "migrated": False, "unsharded": True}


def _seq_map(type_id: str, m: dict) -> dict[str, int]:
    cached = _seqs.get(type_id)
    if cached and cached[0] == m["gen"]:
        return cached[1]
    out: dict[str, int] = {}
    for name in m["shards"]:
        seq, objs = _read_shard(type_id, name)
        out.update(zip(objs.keys(), seq))
    _seqs[type_id] = (m["gen"], out)
    return out


def _digest_of(type_id: str, name: str) -> Optional[str]:
    d = _digests.get((type_id, name))
    if d is None:
        try:
            d = hashlib.sha1(shard_dir(type_id).joinpath(name).read_bytes()).hexdigest()
        except FileNotFoundError:
            return None
        _digests[(type_id, name)] = d
    return d


def _shard_for_save(type_id: str, name: str) -> tuple[tuple, dict]:
    """A shard as (seq, {primary key: object}) for a count save, which rewrites it with its other objects as stored:
    the cached frozen form when current (written as it is), else the file parsed as plain JSON and not cached (the
    shard is replaced right after; freezing it for the cache, then thawing it to write it again, measured ~60% of a
    re-index's save of 10,000 new keys over 256 shards at 410k objects)."""
    p = shard_dir(type_id).joinpath(name)
    hit = _cache.get(("shard", type_id, name), p)
    if hit is not None:
        return hit
    raw, _ = _read_with_sig(p)
    _digests[(type_id, name)] = hashlib.sha1(raw).hexdigest()
    sh = json.loads(raw)
    return tuple(sh["seq"]), sh["objects"]  # (_thaw passes plain dicts through)


def save(type_id: str, objs: dict[str, dict], changed: Optional[Iterable[Any]] = None, count: Optional[int] = None) -> dict:
    """Store the type's objects (the whole set, as load() returned it plus the caller's changes).

    changed: the primary keys added, modified or deleted since the load, when the caller knows them; only their shards
    are then considered. Without it every shard is compared and only those whose content differs are written.
    count (with changed, a sharded type only): objs holds only the changed keys' objects (others may be there too),
    the whole set has `count` objects, and every other object of the changed keys' shards is kept as stored (new keys
    numbered in objs' order, as a whole-set save would). When the save needs the whole set (no shards, an unshard, a
    re-shard) nothing is written and {"whole_set_needed": True} is returned.
    Returns {"format", "written": shard files written, "migrated": bool}. A live type writes its changed objects'
    edits (ontology_live.save)."""
    if (lv := _live(type_id)) is not None:
        return lv.save(type_id, objs, changed)
    with _wlock:
        m = _manifest(type_id)
        if count is not None and (m is None or changed is None or m.get("unshard") is not None or _sig(single_path(type_id))
                                  or count < unshard_threshold(type_id)):
            return {"format": "shards" if m else "single", "written": 0, "migrated": False, "whole_set_needed": True}
        if m is None:
            if len(objs) < threshold(type_id):
                _write_single(type_id, objs)
                _sweep(type_id)
                return {"format": "single", "written": 1, "migrated": False}
            legacy = _sig(single_path(type_id))
            _write_generation(type_id, objs, list(range(len(objs))), legacy, None)
            _fault("before-unlink")
            if legacy and _sig(single_path(type_id)) == legacy:
                _unlink(single_path(type_id))
            _unlink(single_path(type_id).with_suffix(".tmp"))  # of a single-file write that never finished
            _cache.drop(lambda k: k == ("single", type_id))
            log.info("objects of %s: migrated %d objects to %d shards", type_id, len(objs), len(_manifest(type_id)["shards"]))
            return {"format": "shards", "written": len(_manifest(type_id)["shards"]), "migrated": True}
        _settle_single(type_id, m)
        # an interrupted unshard's mark: its file is gone now, this save's commit drops it
        marked = m.pop("unshard", None) is not None
        if count is None and len(objs) < unshard_threshold(type_id):
            return _unshard(type_id, objs, m)
        _unlink(single_path(type_id).with_suffix(".tmp"))  # the temp file of an unshard that stopped before the rename
        n = len(m["shards"])
        size = len(objs) if count is None else count
        stored: dict[int, tuple] = {}
        if count is not None:
            keys = {str(k) for k in changed}
            todo = {shard_of(k, n) for k in keys}
            if (size > n * TARGET_PER_SHARD * 4 and n < MAX_SHARDS) or (n > MIN_SHARDS and size * 4 < n * TARGET_PER_SHARD and _n_shards(size) < n):
                return {"format": "shards", "written": 0, "migrated": False, "whole_set_needed": True}
            # only the touched shards are read: their keys' places (every changed key's place is in one of them)
            cached = _seqs.get(type_id)
            full_seq = cached[1] if cached and cached[0] == m["gen"] else None
            with _GcPaused():
                stored = {i: _shard_for_save(type_id, m["shards"][i]) for i in todo}
            old_seq = {pk: s for seq, sh in stored.values() for pk, s in zip(sh.keys(), seq)}
        else:
            old_seq = _seq_map(type_id, m)
        nxt = int(m.get("next_seq") or 0)
        if changed is not None:
            keys = {str(k) for k in changed}
            todo = {shard_of(k, n) for k in keys}
            seq_of: dict[str, int] = {}
            for pk in objs:
                if pk in keys and pk not in old_seq:
                    seq_of[pk] = nxt
                    nxt += 1
        else:
            # keep each object's place when the order agrees with the stored one, else renumber everything
            seq_of, last, ordered = {}, -1, True
            for pk in objs:
                s = old_seq.get(pk)
                if s is None:
                    s, nxt = nxt, nxt + 1
                if s <= last:
                    ordered = False
                    break
                seq_of[pk], last = s, s
            if not ordered:
                seq_of = {pk: i for i, pk in enumerate(objs)}
                nxt = len(objs)
            todo = set(range(n))
        grow = size > n * TARGET_PER_SHARD * 4 and n < MAX_SHARDS
        # shrank far below its shard count (under a quarter of the target per shard; the new count then holds at most
        # the target per shard, so neither a grow nor another shrink follows without a 4x change)
        shrink = n > MIN_SHARDS and size * 4 < n * TARGET_PER_SHARD and _n_shards(size) < n
        if grow or shrink:
            # one new generation with more (fewer) shards
            seqs = [seq_of.get(pk, old_seq.get(pk, -1)) for pk in objs]
            if any(s < 0 for s in seqs) or seqs != sorted(seqs):
                seqs = list(range(len(objs)))
            _write_generation(type_id, objs, seqs, None, m)
            n_new = len(_manifest(type_id)["shards"])
            if shrink:
                log.info("objects of %s: %d objects re-sharded from %d to %d shards", type_id, len(objs), n, n_new)
            return {"format": "shards", "written": n_new, "migrated": False, "resharded": True, "shards": n_new}
        buckets: dict[int, list[tuple[int, str, dict]]] = {i: [] for i in todo}
        for pk, o in objs.items():
            i = shard_of(pk, n)
            if i in buckets:
                s = seq_of.get(pk)
                if s is None:
                    s = old_seq.get(pk)
                    if s is None:
                        s, nxt = nxt, nxt + 1
                buckets[i].append((s, pk, o))
        for i, (seq, sh) in stored.items():
            # (count: the shard's other objects as stored, frozen when they came from the cache: they serialize to the
            # same JSON as thawed (an _FDict is a dict, a tuple a list) and _cache_shard keeps them as they are)
            buckets[i].extend((s, pk, o) for pk, s, o in zip(sh.keys(), seq, sh.values()) if pk not in keys and pk not in objs)
        d = shard_dir(type_id)
        names = list(m["shards"])
        replaced = []
        for i in sorted(buckets):
            b = sorted(buckets[i], key=lambda r: r[0])
            raw = _serialize(b)
            digest = hashlib.sha1(raw).hexdigest()
            if digest == _digest_of(type_id, names[i]):
                continue
            name = _shard_name(i)
            _write_bytes(d / name, raw)
            _digests[(type_id, name)] = digest
            _cache_shard(type_id, name, b, raw)
            replaced.append(names[i])
            names[i] = name
            _fault("shard")
        if not replaced:
            if marked:
                _commit(type_id, m)  # nothing to write: the same generation, without the mark
            _gc(type_id, set(names))  # what an interrupted save left
            return {"format": "shards", "written": 0, "migrated": False}
        _fault("before-commit")
        gen = uuid.uuid4().hex[:12]
        _commit(type_id, {**m, "gen": gen, "count": size, "next_seq": nxt, "shards": names, "updated_at": _now()})
        new_seq = {pk: s for b in buckets.values() for s, pk, _ in b}
        if changed is None:
            _seqs[type_id] = (gen, new_seq)
        elif count is not None and full_seq is None:
            _seqs.pop(type_id, None)  # only the touched shards' places are known here
        else:
            if count is not None:
                old_seq = full_seq
            # only the changed keys can differ from the cached map (this module's own dict: updated in place)
            for k in keys:
                old_seq.pop(k, None)
            old_seq.update(new_seq)
            _seqs[type_id] = (gen, old_seq)
        _fault("after-commit")
        for name in replaced:
            if _unlink(d / name):
                _digests.pop((type_id, name), None)
        _gc(type_id, set(names))
        return {"format": "shards", "written": len(replaced), "migrated": False}


def ensure(type_id: str) -> None:
    """An empty object store for a new type (no change when the type already has one)."""
    with _wlock:
        if not exists(type_id):
            _write_single(type_id, {})


def delete(type_id: str) -> None:
    import ontology_live

    with _wlock:
        # a live type: its marker and its edits go with it (the dataset stays in Files)
        ontology_live.drop(type_id)
        _unlink(ontology_live.edits_path(type_id))
        single_path(type_id).unlink(missing_ok=True)
        _unlink(single_path(type_id).with_suffix(".tmp"))
        d = shard_dir(type_id)
        if d.exists():
            # the manifest first: the type reads as empty at once, the rest is clean-up
            _manifest_path(type_id).unlink(missing_ok=True)
            shutil.rmtree(d, ignore_errors=True)
        _seqs.pop(type_id, None)
        for k in [k for k in list(_digests) if k[0] == type_id]:
            _digests.pop(k, None)
        cache_clear(type_id)
