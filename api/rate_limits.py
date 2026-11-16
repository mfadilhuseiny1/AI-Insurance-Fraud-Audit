"""Rate limits and failed-attempt counters shared by every API process (PostgreSQL), so limits hold across processes
and restarts.

Two kinds:

* Failed attempts (sign-in, two-factor codes, password resets, invitations — auth.py): one row per failure in
  `auth_failures`; a key's count is its failures in the last `window` seconds (a sliding window, as the in-memory
  lists were). Recording a failure is one INSERT, so concurrent failures from any number of processes are never
  lost. Success clears the key (one DELETE).
  When PostgreSQL is configured but cannot be reached, failures are counted in this process's memory instead (the
  protection there was before: per process) and an error is logged, so sign-in keeps working (the auth store is
  SQLite) while the limit still holds per process. After a database error it is not tried again for RETRY_AFTER_S
  (5 s), so requests are answered at once instead of each waiting for a connection timeout.

* API rate limits (webhook executions, listener events, `take()`): one counter row per key and fixed time bucket in
  `rate_buckets`; `take()` is a single INSERT … ON CONFLICT DO UPDATE … WHERE n + k <= limit RETURNING n, so the
  counter never passes the limit and no increment is lost. Fixed buckets aligned on the database clock: a burst of up
  to 2 × limit is possible across a bucket boundary (the in-memory deques were sliding).
  LOCAL FAST PATH: each process also keeps a sliding window of the uses it was allowed; when that alone is at the
  limit the call is refused without asking the database (a flood costs no database round trip), and when the
  database cannot be reached (or is not configured) that window decides alone — the old per-process limit — and a
  warning is logged (at most once a minute).

Without PostgreSQL (BLUESANDAI_DATABASE_URL not set) everything is kept in memory per process, as before.

Keys of failed attempts are scoped to the auth store (a hash of its path, or BLUESANDAI_RATE_SCOPE when several
machines share one store under different paths), so a test API with its own auth store never counts toward — or
locks out — the accounts of another store on the same database.

Old rows expire: reads only look inside the window, and at most once a minute per process a background thread
DELETEs rows past their `expires` time (index on expires), so the tables do not grow without bound and no request
waits for it.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

import db

log = logging.getLogger("bluesandai.rate_limits")

SCHEMA = """
CREATE TABLE IF NOT EXISTS auth_failures (
    key      text NOT NULL,
    at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_key_idx ON auth_failures (key, at);
CREATE INDEX IF NOT EXISTS auth_failures_expires_idx ON auth_failures (expires);
CREATE TABLE IF NOT EXISTS rate_buckets (
    key      text NOT NULL,
    bucket   bigint NOT NULL,
    n        integer NOT NULL,
    expires  timestamptz NOT NULL,
    PRIMARY KEY (key, bucket)
);
CREATE INDEX IF NOT EXISTS rate_buckets_expires_idx ON rate_buckets (expires);
"""

CLEANUP_EVERY_S = 60.0
MEMORY_MAX_KEYS = 50_000
RETRY_AFTER_S = 5.0

_lock = threading.Lock()
_ready_for: Optional[str] = None  # the database URL the tables were created on
_last_cleanup = 0.0
_last_warning = 0.0
_down_until = 0.0
_scope_cache: tuple[str, str] = ("", "")
# without PostgreSQL (or while it cannot be reached): key -> failure times (the old behaviour, per process)
_memory: dict[str, list[float]] = {}
_memory_lock = threading.Lock()
# take(): key -> monotonic times of the uses this process was allowed (the local fast path / fallback)
_local: dict[str, deque] = {}
_local_lock = threading.Lock()


class Unavailable(Exception):
    """PostgreSQL is configured but the statement failed (unreachable, timed out …)."""


# -- plumbing --


def _scope() -> str:
    """The auth store this process uses (its path hashed), so separate stores never share counters."""
    global _scope_cache
    env = os.environ.get("BLUESANDAI_RATE_SCOPE", "").strip()
    if env:
        return env
    import auth  # late: auth imports this module

    path = str(auth.DB_PATH)
    if _scope_cache[0] != path:
        norm = os.path.normcase(str(Path(path).resolve())) if path not in ("", ".") else ""
        _scope_cache = (path, hashlib.sha256(norm.encode()).hexdigest()[:16])
    return _scope_cache[1]


def _ensure(conn) -> None:
    global _ready_for
    if _ready_for == db._url:
        return
    with _lock:
        if _ready_for == db._url:
            return
        try:
            conn.execute(SCHEMA)
            conn.commit()
        except Exception:  # noqa: BLE001 - two processes creating the tables at once: the other one won
            conn.rollback()
            conn.execute("SELECT 1 FROM auth_failures LIMIT 0")
            conn.execute("SELECT 1 FROM rate_buckets LIMIT 0")
        _ready_for = db._url


def cleanup(force: bool = False) -> None:
    """Delete expired rows (at most once a minute per process unless forced; best effort)."""
    global _last_cleanup
    now = time.monotonic()
    if not db.enabled() or (not force and now - _last_cleanup < CLEANUP_EVERY_S):
        return
    _last_cleanup = now
    _delete_expired()


def _cleanup_soon() -> None:
    """At most once a minute: delete expired rows on a background thread (requests never wait for it)."""
    global _last_cleanup
    now = time.monotonic()
    if now - _last_cleanup < CLEANUP_EVERY_S:
        return
    _last_cleanup = now
    threading.Thread(target=_delete_expired, name="rate-limits-cleanup", daemon=True).start()


def _delete_expired() -> None:
    try:
        with db._connect() as conn:
            _ensure(conn)
            conn.execute("DELETE FROM auth_failures WHERE expires < now()")
            conn.execute("DELETE FROM rate_buckets WHERE expires < now()")
    except Exception as e:  # noqa: BLE001 - the next call tries again
        log.warning("rate limit cleanup failed: %s", e)


def _run(sql: str, params) -> Optional[tuple]:
    """One statement on a pooled connection (committed at the end of the block); Unavailable on any database error.
    After an error the database is not tried again for RETRY_AFTER_S, so requests do not each wait for a timeout."""
    global _down_until
    if time.monotonic() < _down_until:
        raise Unavailable("the database was unreachable moments ago")
    try:
        with db._connect() as conn:
            _ensure(conn)
            row = conn.execute(sql, params).fetchone()
    except Exception as e:  # noqa: BLE001
        _down_until = time.monotonic() + RETRY_AFTER_S
        raise Unavailable(str(e)) from e
    _cleanup_soon()
    return row


def _warn(what: str, e: Exception, level: int = logging.WARNING) -> None:
    """Log that the shared counters are not reachable (at most once a minute per process)."""
    global _last_warning
    if time.monotonic() - _last_warning > 60:
        _last_warning = time.monotonic()
        log.log(level, "%s: shared counters unavailable, counting in this process only: %s", what, e)


# -- failed attempts --


def _memory_count(key: str, window_s: int) -> int:
    cut = time.time() - window_s
    with _memory_lock:
        recent = [t for t in _memory.get(key, []) if t > cut]
        if recent:
            _memory[key] = recent
        else:
            _memory.pop(key, None)
    return len(recent)


def _memory_fail(key: str, window_s: int) -> int:
    with _memory_lock:
        if len(_memory) >= MEMORY_MAX_KEYS:
            _memory.clear()
        _memory.setdefault(key, []).append(time.time())
    return _memory_count(key, window_s)


def failures(key: str, window_s: int) -> int:
    """Failures recorded for `key` in the last window_s seconds, across every process (plus any counted in this
    process while the database could not be reached)."""
    local = _memory_count(key, window_s)
    if not db.enabled():
        return local
    try:
        row = _run("SELECT count(*) FROM auth_failures WHERE key = %s AND at > now() - make_interval(secs => %s)",
                   (f"{_scope()}:{key}", window_s))
    except Unavailable as e:
        _warn("sign-in attempt limits", e, logging.ERROR)
        return local
    return (int(row[0]) if row else 0) + local


def fail(key: str, window_s: int) -> int:
    """Record one failure (a single INSERT: never lost under concurrency); returns the count in the window."""
    if not db.enabled():
        return _memory_fail(key, window_s)
    try:
        row = _run(
            "WITH ins AS (INSERT INTO auth_failures (key, expires) VALUES (%s, clock_timestamp() + make_interval(secs => %s)) RETURNING 1) "
            "SELECT 1 + (SELECT count(*) FROM auth_failures WHERE key = %s AND at > now() - make_interval(secs => %s)) FROM ins",
            (f"{_scope()}:{key}", window_s, f"{_scope()}:{key}", window_s))
    except Unavailable as e:
        _warn("sign-in attempt limits", e, logging.ERROR)
        return _memory_fail(key, window_s)
    return (int(row[0]) if row else 0) + _memory_count(key, window_s)


def clear(key: str) -> None:
    """Forget a key's failures (after a successful sign-in). Logged, not raised, when the database is down."""
    with _memory_lock:
        _memory.pop(key, None)
    if not db.enabled():
        return
    try:
        _run("WITH d AS (DELETE FROM auth_failures WHERE key = %s RETURNING 1) SELECT count(*) FROM d", (f"{_scope()}:{key}",))
    except Unavailable as e:
        log.error("could not clear sign-in failures for a key: %s", e)


# -- API rate limits --


def _local_full(key: str, limit: int, window_s: float, n: int) -> bool:
    """This process alone was allowed `limit` uses of `key` in the last window_s seconds (sliding)."""
    now = time.monotonic()
    with _local_lock:
        q = _local.get(key)
        if q is None:
            return False
        while q and q[0] <= now - window_s:
            q.popleft()
        return len(q) + n > limit


def _local_add(key: str, limit: int, window_s: float, n: int, check: bool) -> bool:
    """Note n allowed uses in this process's window (refusing instead when `check` and they do not fit)."""
    now = time.monotonic()
    with _local_lock:
        q = _local.get(key)
        if q is None:
            if len(_local) >= MEMORY_MAX_KEYS:
                _local.clear()
            q = _local[key] = deque()
        while q and q[0] <= now - window_s:
            q.popleft()
        if check and len(q) + n > limit:
            return False
        q.extend([now] * n)
        return True


def take(key: str, limit: int, window_s: float, n: int = 1) -> bool:
    """Count n uses of `key` if that keeps it within `limit` per window_s seconds, across every API process.

    True: allowed (counted); False: over the limit (not counted). A use this process alone cannot fit (sliding
    window) is refused without a database round trip. Shared: one atomic counter row per key and window_s bucket
    in PostgreSQL. Without PostgreSQL, or while it cannot be reached (logged), this process's window decides."""
    if n > limit:
        return False
    w = max(float(window_s), 0.001)
    if _local_full(key, limit, w, n):
        return False
    if not db.enabled():
        return _local_add(key, limit, w, n, check=True)
    try:
        row = _run(
            "INSERT INTO rate_buckets AS b (key, bucket, n, expires) "
            "VALUES (%(k)s, floor(extract(epoch FROM clock_timestamp()) / %(w)s)::bigint, %(n)s, "
            "        clock_timestamp() + make_interval(secs => 2 * %(w)s)) "
            "ON CONFLICT (key, bucket) DO UPDATE SET n = b.n + EXCLUDED.n WHERE b.n + EXCLUDED.n <= %(lim)s "
            "RETURNING n",
            {"k": key, "w": w, "n": n, "lim": limit})
    except Unavailable as e:
        _warn("API rate limits", e)
        return _local_add(key, limit, w, n, check=True)
    if row is None:
        return False
    _local_add(key, limit, w, n, check=False)
    return True
