"""PostgreSQL storage for files, jobs, parsed elements and RAG chunks.

Write-through: the API keeps its on-disk files (the source PDFs, page-image cache, downloads)
and mirrors every file, job update and result into PostgreSQL, so parsed data can be queried,
joined and later embedded for retrieval. Disabled when BLUESANDAI_DATABASE_URL is not set.

Tables:
    files     one row per upload
    jobs      one row per parse job; `internal` holds engine/model/cost data never sent to clients
    elements  one row per parsed element (public metadata + internal metadata kept apart)
    chunks    retrieval-ready chunks (text + pages + languages + source element ids), with a
              full-text index for keyword search
    drive_items  the Files tab: folders and files in a tree (parent_id); file contents are in S3
    vector_ingests  which parse jobs were embedded into which S3 Vectors index (vectors.py)
"""

from __future__ import annotations

import logging
import os
import threading
import contextvars
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg.types.json import Jsonb

log = logging.getLogger("bluesandai.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    kind         text NOT NULL,
    pages        integer NOT NULL,
    size_bytes   bigint NOT NULL,
    stored_path  text NOT NULL,
    uploaded_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id                  text PRIMARY KEY,
    file_id             text NOT NULL REFERENCES files(id),
    tier                text NOT NULL,
    status              text NOT NULL,
    page_from           integer NOT NULL,
    page_to             integer NOT NULL,
    pages_total         integer NOT NULL,
    pages_done          integer NOT NULL DEFAULT 0,
    elements            integer NOT NULL DEFAULT 0,
    languages           text[] NOT NULL DEFAULT '{}',
    instructions        text,
    price_per_page_usd  numeric(12, 6),
    price_usd           numeric(12, 6) NOT NULL DEFAULT 0,
    internal            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL,
    started_at          timestamptz,
    finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_file_idx ON jobs (file_id);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS elements (
    job_id             text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seq                integer NOT NULL,
    element_id         text NOT NULL,
    type               text NOT NULL,
    text               text NOT NULL,
    page_number        integer,
    languages          text[] NOT NULL DEFAULT '{}',
    parent_id          text,
    metadata           jsonb NOT NULL,
    internal_metadata  jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS elements_page_idx ON elements (job_id, page_number);

CREATE TABLE IF NOT EXISTS chunks (
    job_id        text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    chunk_index   integer NOT NULL,
    chunk_id      text NOT NULL,
    text          text NOT NULL,
    page_numbers  integer[] NOT NULL DEFAULT '{}',
    languages     text[] NOT NULL DEFAULT '{}',
    element_ids   text[] NOT NULL DEFAULT '{}',
    metadata      jsonb NOT NULL,
    PRIMARY KEY (job_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (to_tsvector('simple', text));

CREATE TABLE IF NOT EXISTS drive_items (
    id            text PRIMARY KEY,
    parent_id     text REFERENCES drive_items(id) ON DELETE CASCADE,
    kind          text NOT NULL,
    name          text NOT NULL,
    size_bytes    bigint NOT NULL DEFAULT 0,
    content_type  text,
    stored_in     text,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_items_parent_idx ON drive_items (parent_id);
-- projects (top-level containers) and the default items ("system": project, documents, parsed,
-- extracted), which the app saves into and which cannot be renamed, moved or deleted
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS system text;
-- who created the item (a username; NULL for items made before this was recorded): Compass searches by creator
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE drive_items DROP CONSTRAINT IF EXISTS drive_items_kind_check;
ALTER TABLE drive_items ADD CONSTRAINT drive_items_kind_check CHECK (kind IN ('project', 'folder', 'file'));
CREATE UNIQUE INDEX IF NOT EXISTS drive_items_system_idx ON drive_items (system) WHERE system IS NOT NULL;
-- Drive features: stars, a trash (a trashed folder marks its whole subtree with trashed_root =
-- the folder's id, so a restore brings everything back), and share links. Names only need to be
-- unique among items that are not in the trash.
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS trashed_root text;
DROP INDEX IF EXISTS drive_items_name_idx;
CREATE UNIQUE INDEX IF NOT EXISTS drive_items_live_name_idx
    ON drive_items (coalesce(parent_id, ''), lower(name)) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS drive_items_trash_idx ON drive_items (trashed_root) WHERE trashed_root IS NOT NULL;
CREATE TABLE IF NOT EXISTS drive_shares (
    token       text PRIMARY KEY,
    item_id     text NOT NULL REFERENCES drive_items(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL,
    expires_at  timestamptz
);

CREATE TABLE IF NOT EXISTS vector_ingests (
    bucket       text NOT NULL,
    index_name   text NOT NULL,
    job_id       text NOT NULL,
    file_name    text NOT NULL,
    model        text NOT NULL,
    dimension    integer NOT NULL,
    status       text NOT NULL,
    vectors      integer NOT NULL DEFAULT 0,
    total        integer NOT NULL DEFAULT 0,
    cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
    error        text,
    created_at   timestamptz NOT NULL,
    finished_at  timestamptz,
    PRIMARY KEY (bucket, index_name, job_id)
);
-- how the run prepared the chunks (vectors.EmbedOptions) and how many it left out
ALTER TABLE vector_ingests ADD COLUMN IF NOT EXISTS options jsonb;
ALTER TABLE vector_ingests ADD COLUMN IF NOT EXISTS skipped integer NOT NULL DEFAULT 0;
-- what started the run (manual, auto, retry, copy) and, for retries, how many times it was retried
ALTER TABLE vector_ingests ADD COLUMN IF NOT EXISTS trigger text;
ALTER TABLE vector_ingests ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
"""

JOB_COLUMNS = (
    "id", "file_id", "tier", "status", "page_from", "page_to", "pages_total", "pages_done",
    "elements", "languages", "instructions", "price_per_page_usd", "price_usd", "internal",
    "created_at", "started_at", "finished_at",
)
# job.json keys that stay server-side
INTERNAL_JOB_KEYS = ("strategy", "model", "fallback_model", "cost", "tokens", "engines", "error_internal", "chunking", "vision", "layout_model")

_url: Optional[str] = None
_lock = threading.Lock()


def init(url: str) -> None:
    """Create the database if missing, then the schema. Raises if PostgreSQL is unreachable."""
    global _url
    parts = urlparse(url)
    dbname = parts.path.lstrip("/") or "bluesandai_parse"
    maintenance = urlunparse(parts._replace(path="/postgres"))
    with psycopg.connect(maintenance, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{dbname}"')
            log.info("created database %s", dbname)
    with psycopg.connect(url) as conn:
        conn.execute(SCHEMA)
    _url = url


def enabled() -> bool:
    return _url is not None


# idle connections reused by _connect(): opening one costs ~60 ms, and a page such as Data Lineage makes hundreds of
# small queries. 8 was too few once other pages poll at the same time (2026-10-30: the Pipeline Builder's previews kept the
# 8 busy, so a saved lineage graph opened a new connection for most of its ~650 queries: 11–33 s, 0.3 s with reuse).
# PostgreSQL allows 100; the API holds about 17 at rest
_idle: list[psycopg.Connection] = []
_idle_lock = threading.Lock()
_IDLE_MAX = int(os.environ.get("BLUESANDAI_DB_IDLE_MAX") or 32)


@contextmanager
def _connect() -> Iterator[psycopg.Connection]:
    """A connection for one `with` block: committed at the end (rolled back on an error), then kept for reuse."""
    conn = None
    with _idle_lock:
        while _idle and conn is None:
            c = _idle.pop()
            if not c.closed and c.info.transaction_status == psycopg.pq.TransactionStatus.IDLE:
                conn = c
            else:
                c.close()
    if conn is None:
        conn = psycopg.connect(_url)
    try:
        yield conn
        conn.commit()
    except BaseException:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001 - a broken connection; not kept
            conn.close()
        raise
    finally:
        keep = not conn.closed and not conn.broken and conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
        with _idle_lock:
            if keep and len(_idle) < _IDLE_MAX:
                _idle.append(conn)
                conn = None
        if conn is not None:
            conn.close()


def upsert_file(meta: dict, stored_path: str) -> None:
    if not _url:
        return
    with _lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO files (id, name, kind, pages, size_bytes, stored_path, uploaded_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, pages = EXCLUDED.pages
            """,
            (meta["id"], meta["name"], meta["kind"], meta["pages"], meta["size"], stored_path, meta["uploaded_at"]),
        )


def upsert_job(job: dict, price_per_page: Optional[float]) -> None:
    if not _url:
        return
    price = price_per_page or 0.0
    row = {
        **{k: job.get(k) for k in JOB_COLUMNS},
        "languages": job.get("languages") or [],
        "price_per_page_usd": price_per_page,
        "price_usd": round(job.get("pages_done", 0) * price, 6),
        "internal": Jsonb({k: job.get(k) for k in INTERNAL_JOB_KEYS}),
    }
    cols = ", ".join(JOB_COLUMNS)
    values = ", ".join(f"%({c})s" for c in JOB_COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in JOB_COLUMNS if c not in ("id", "created_at"))
    with _lock, _connect() as conn:
        conn.execute(f"INSERT INTO jobs ({cols}) VALUES ({values}) ON CONFLICT (id) DO UPDATE SET {updates}", row)


def save_results(job_id: str, internal: list[dict], public: list[dict], chunks: list[dict]) -> None:
    """Replace a job's elements and chunks (idempotent, so a re-run or backfill is safe)."""
    if not _url:
        return
    element_rows = []
    for seq, (pub, full) in enumerate(zip(public, internal)):
        meta = pub["metadata"]
        hidden = {k: v for k, v in full["metadata"].items() if k not in meta}
        element_rows.append(
            (
                job_id, seq, pub["element_id"], pub["type"], pub["text"], meta.get("page_number"),
                meta.get("languages") or [], meta.get("parent_id"), Jsonb(meta), Jsonb(hidden),
            )
        )
    chunk_rows = [
        (
            job_id, c["index"], c["chunk_id"], c["text"], c["metadata"].get("page_numbers") or [],
            c["metadata"].get("languages") or [], c["metadata"].get("element_ids") or [], Jsonb(c["metadata"]),
        )
        for c in chunks
    ]
    with _lock, _connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM elements WHERE job_id = %s", (job_id,))
        cur.execute("DELETE FROM chunks WHERE job_id = %s", (job_id,))
        cur.executemany(
            """
            INSERT INTO elements (job_id, seq, element_id, type, text, page_number, languages,
                                  parent_id, metadata, internal_metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            element_rows,
        )
        cur.executemany(
            """
            INSERT INTO chunks (job_id, chunk_index, chunk_id, text, page_numbers, languages,
                                element_ids, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            chunk_rows,
        )


def delete_job(job_id: str) -> None:
    if not _url:
        return
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def has_results(job_id: str) -> bool:
    if not _url:
        return False
    with _connect() as conn:
        return conn.execute("SELECT 1 FROM elements WHERE job_id = %s LIMIT 1", (job_id,)).fetchone() is not None


def counts() -> dict[str, Any]:
    with _connect() as conn:
        return {
            t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            for t in ("files", "jobs", "elements", "chunks")
        }


# ------------------------------------------------------------------------------------------------
# drive (the Files tab)
# ------------------------------------------------------------------------------------------------

DRIVE_COLUMNS = "id, parent_id, kind, name, size_bytes, content_type, stored_in, created_at, updated_at, system"
# selects also return the Drive feature columns; inserts use DRIVE_COLUMNS
DRIVE_SELECT = DRIVE_COLUMNS + ", starred, trashed_at, trashed_root, created_by"
# the creator of new items: set by drive.configure (the signed-in user)
creator: Callable[[], Optional[str]] = lambda: None
# children counted in a listing (items in the trash are not)
LIVE_CHILDREN = "(SELECT count(*) FROM drive_items c WHERE c.parent_id = d.id AND c.trashed_at IS NULL) AS items"


def _drive_row(cur: psycopg.Cursor, row: tuple) -> dict:
    return {d.name: v for d, v in zip(cur.description, row)}


def drive_list(parent_id: Optional[str]) -> list[dict]:
    """Children of a folder (None = the root): projects, then folders, then files; projects and
    folders carry their item count."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {DRIVE_SELECT}, {LIVE_CHILDREN}
            FROM drive_items d
            WHERE parent_id IS NOT DISTINCT FROM %s AND trashed_at IS NULL
            ORDER BY CASE kind WHEN 'project' THEN 0 WHEN 'folder' THEN 1 ELSE 2 END, lower(name)
            """,
            (parent_id,),
        )
        return [_drive_row(cur, r) for r in cur.fetchall()]


def drive_get(item_id: str) -> Optional[dict]:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {DRIVE_SELECT} FROM drive_items WHERE id = %s", (item_id,))
        row = cur.fetchone()
        return _drive_row(cur, row) if row else None


def drive_by_system(key: str) -> Optional[dict]:
    """A default item (see the `system` column) or None."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {DRIVE_SELECT} FROM drive_items WHERE system = %s", (key,))
        row = cur.fetchone()
        return _drive_row(cur, row) if row else None


# within drive_path_memo(): each item's path read once (a request walking thousands of items, e.g. a lineage graph)
_path_memo: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("drive_path_memo", default=None)


@contextmanager
def drive_path_memo() -> Iterator[None]:
    """drive_path answers each item from memory after its first read, until the block ends."""
    token = _path_memo.set({})
    try:
        yield
    finally:
        _path_memo.reset(token)


def drive_path(item_id: str) -> list[dict]:
    """The item and its ancestors, root-most first: [{id, name}, ...]."""
    memo = _path_memo.get()
    if memo is not None and item_id in memo:
        return [dict(p) for p in memo[item_id]]
    with _connect() as conn:
        rows = conn.execute(
            """
            WITH RECURSIVE up AS (
                SELECT id, parent_id, name, 0 AS depth FROM drive_items WHERE id = %s
                UNION ALL
                SELECT d.id, d.parent_id, d.name, up.depth + 1
                FROM drive_items d JOIN up ON d.id = up.parent_id
            )
            SELECT id, name FROM up ORDER BY depth DESC
            """,
            (item_id,),
        ).fetchall()
    out = [{"id": r[0], "name": r[1]} for r in rows]
    if memo is not None:
        memo[item_id] = [dict(p) for p in out]
    return out


def drive_name_taken(parent_id: Optional[str], name: str, except_id: Optional[str] = None) -> bool:
    with _connect() as conn:
        return (
            conn.execute(
                """
                SELECT 1 FROM drive_items
                WHERE parent_id IS NOT DISTINCT FROM %s AND lower(name) = lower(%s) AND id <> coalesce(%s, '')
                  AND trashed_at IS NULL
                """,
                (parent_id, name, except_id),
            ).fetchone()
            is not None
        )


def drive_insert(item: dict) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            f"""
            INSERT INTO drive_items ({DRIVE_COLUMNS}, created_by)
            VALUES (%(id)s, %(parent_id)s, %(kind)s, %(name)s, %(size_bytes)s, %(content_type)s,
                    %(stored_in)s, %(created_at)s, %(updated_at)s, %(system)s, %(created_by)s)
            """,
            {"system": None, **item, "created_by": item.get("created_by") or creator()},
        )
        _drive_touch(conn, item["parent_id"], item["updated_at"])


def drive_update(item_id: str, now: str, **changes: Any) -> None:
    """Rename (name=) and/or move (parent_id=); both old and new parent folders count as updated."""
    sets = ", ".join(f"{k} = %({k})s" for k in changes)
    if "parent_id" in changes:
        # a move changes the markings the item (and everything under it) inherits from its folders
        with _markings_bumped():
            _drive_update(item_id, now, sets, changes)
    else:
        _drive_update(item_id, now, sets, changes)


@contextmanager
def _markings_bumped() -> Iterator[None]:
    """Around a change of where items sit in the tree (which folders' markings apply to them): every API process's
    cached markings go stale with it (auth.markings_changed). The sign-in store may be another database (SQLite), so
    the version is bumped in its transaction before the block runs and committed right after the block's own commit
    (a failure to bump fails the change); a reader that cached markings in between is invalidated by the commit."""
    import auth
    import auth_store

    with auth_store.connect() as acon:
        auth.markings_changed(acon)
        yield
    # this process too, within the request that moved (its version is read once per request)
    auth._cache.clear()
    auth._file_cache.clear()


def _drive_update(item_id: str, now: str, sets: str, changes: dict) -> None:
    with _lock, _connect() as conn:
        old_parent = conn.execute("SELECT parent_id FROM drive_items WHERE id = %s", (item_id,)).fetchone()[0]
        conn.execute(
            f"UPDATE drive_items SET {sets}, updated_at = %(now)s WHERE id = %(id)s", {**changes, "now": now, "id": item_id}
        )
        _drive_touch(conn, old_parent, now)
        if "parent_id" in changes:
            _drive_touch(conn, changes["parent_id"], now)


def drive_replace_content(item_id: str, expected_updated_at: str, now: str, size_bytes: int, write_content: Callable[[], None]) -> bool:
    """Replace a file's stored bytes only if its Drive revision is still current.

    The row lock is held while the storage callback runs, so concurrent API workers cannot both
    pass the revision check and overwrite each other's contents.
    """
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT parent_id, updated_at FROM drive_items WHERE id = %s AND kind = 'file' AND trashed_at IS NULL FOR UPDATE",
            (item_id,),
        ).fetchone()
        if not row or row[1].isoformat() != expected_updated_at:
            return False
        write_content()
        conn.execute("UPDATE drive_items SET size_bytes = %s, updated_at = %s WHERE id = %s", (size_bytes, now, item_id))
        _drive_touch(conn, row[0], now)
    return True


def drive_is_inside(item_id: str, folder_id: str) -> bool:
    """True if folder_id is item_id itself or one of its descendants (a move there would loop)."""
    return any(p["id"] == item_id for p in drive_path(folder_id))


def drive_delete(item_id: str, now: str) -> list[dict]:
    """Delete an item and everything under it; returns the deleted files so their contents can
    be removed from storage."""
    with _lock, _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH RECURSIVE down AS (
                SELECT id, kind, stored_in FROM drive_items WHERE id = %s
                UNION ALL
                SELECT d.id, d.kind, d.stored_in FROM drive_items d JOIN down ON d.parent_id = down.id
            )
            SELECT id, stored_in FROM down WHERE kind = 'file'
            """,
            (item_id,),
        )
        files = [{"id": r[0], "stored_in": r[1]} for r in cur.fetchall()]
        cur.execute("DELETE FROM drive_items WHERE id = %s RETURNING parent_id", (item_id,))
        row = cur.fetchone()
        if row:
            _drive_touch(conn, row[0], now)
    return files


def drive_subtree(item_id: str) -> list[dict]:
    """An item and everything under it (not in the trash), parents before children, each with
    `rel`: its path from the item ("Folder/Sub/file.pdf")."""
    cols = ", ".join("d." + c.strip() for c in DRIVE_SELECT.split(","))
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            WITH RECURSIVE down AS (
                SELECT {cols}, d.name::text AS rel, 0 AS depth FROM drive_items d WHERE d.id = %s
                UNION ALL
                SELECT {cols}, down.rel || '/' || d.name, down.depth + 1
                FROM drive_items d JOIN down ON d.parent_id = down.id
                WHERE d.trashed_at IS NULL
            )
            SELECT * FROM down ORDER BY depth
            """,
            (item_id,),
        )
        return [_drive_row(cur, r) for r in cur.fetchall()]


def drive_query(where: str, params: tuple = (), order: str = "updated_at DESC", limit: int = 200) -> list[dict]:
    """Items (with child counts) matching a WHERE clause over drive_items d."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {DRIVE_SELECT}, {LIVE_CHILDREN} FROM drive_items d WHERE {where} ORDER BY {order} LIMIT {int(limit)}",
            params,
        )
        return [_drive_row(cur, r) for r in cur.fetchall()]


def drive_set(item_id: str, **values: Any) -> None:
    """Set columns that are not content changes (e.g. starred), leaving updated_at alone."""
    sets = ", ".join(f"{k} = %({k})s" for k in values)
    with _lock, _connect() as conn:
        conn.execute(f"UPDATE drive_items SET {sets} WHERE id = %(id)s", {**values, "id": item_id})


def drive_trash(item_id: str, now: str) -> None:
    """Move an item and everything under it to the trash."""
    with _lock, _connect() as conn:
        conn.execute(
            """
            WITH RECURSIVE down AS (
                SELECT id FROM drive_items WHERE id = %(id)s
                UNION ALL
                SELECT d.id FROM drive_items d JOIN down ON d.parent_id = down.id WHERE d.trashed_at IS NULL
            )
            UPDATE drive_items SET trashed_at = %(now)s, trashed_root = %(id)s WHERE id IN (SELECT id FROM down)
            """,
            {"id": item_id, "now": now},
        )
        parent = conn.execute("SELECT parent_id FROM drive_items WHERE id = %s", (item_id,)).fetchone()
        if parent:
            _drive_touch(conn, parent[0], now)


def drive_restore(item_id: str, now: str, parent_id: Optional[str], name: str) -> None:
    """Bring a trashed item (and what was trashed with it) back, under parent_id as name."""
    # parent_id may not be where it was trashed from (that folder is gone): a move, for the markings it inherits
    with _markings_bumped(), _lock, _connect() as conn:
        # rename/move while still trashed (the unique name index ignores trashed rows), then untrash
        conn.execute(
            "UPDATE drive_items SET parent_id = %s, name = %s, updated_at = %s WHERE id = %s",
            (parent_id, name, now, item_id),
        )
        conn.execute(
            "UPDATE drive_items SET trashed_at = NULL, trashed_root = NULL WHERE trashed_root = %s", (item_id,)
        )
        _drive_touch(conn, parent_id, now)


def drive_usage() -> dict:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT coalesce(sum(size_bytes) FILTER (WHERE kind = 'file' AND trashed_at IS NULL), 0),
                   count(*) FILTER (WHERE kind = 'file' AND trashed_at IS NULL),
                   count(*) FILTER (WHERE kind <> 'file' AND trashed_at IS NULL),
                   coalesce(sum(size_bytes) FILTER (WHERE kind = 'file' AND trashed_at IS NOT NULL), 0),
                   count(*) FILTER (WHERE trashed_root = id)
            FROM drive_items
            """
        ).fetchone()
    return {"bytes": int(row[0]), "files": row[1], "folders": row[2], "trash_bytes": int(row[3]), "trash_items": row[4]}


def share_create(token: str, item_id: str, now: str, expires_at: Optional[str]) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO drive_shares (token, item_id, created_at, expires_at) VALUES (%s, %s, %s, %s)",
            (token, item_id, now, expires_at),
        )


def share_list(item_id: Optional[str] = None) -> list[dict]:
    """Share links (newest first) with the shared item's name and kind; none for trashed items."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.token, s.item_id, s.created_at, s.expires_at, d.name, d.kind
            FROM drive_shares s JOIN drive_items d ON d.id = s.item_id
            WHERE (%s::text IS NULL OR s.item_id = %s) AND d.trashed_at IS NULL
            ORDER BY s.created_at DESC
            """,
            (item_id, item_id),
        )
        return [_drive_row(cur, r) for r in cur.fetchall()]


def share_get(token: str) -> Optional[dict]:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT token, item_id, created_at, expires_at FROM drive_shares WHERE token = %s", (token,))
        row = cur.fetchone()
        return _drive_row(cur, row) if row else None


def share_delete(token: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM drive_shares WHERE token = %s", (token,))


def _drive_touch(conn: psycopg.Connection, folder_id: Optional[str], now: str) -> None:
    if folder_id:
        conn.execute("UPDATE drive_items SET updated_at = %s WHERE id = %s", (now, folder_id))


# ------------------------------------------------------------------------------------------------
# vector ingests (the Vector Storage tab)
# ------------------------------------------------------------------------------------------------

INGEST_COLUMNS = (
    "bucket", "index_name", "job_id", "file_name", "model", "dimension", "status", "vectors", "total",
    "cost_usd", "error", "created_at", "finished_at", "options", "skipped", "trigger", "attempts",
)


def ingest_upsert(row: dict) -> None:
    if not _url:
        return
    cols = ", ".join(INGEST_COLUMNS)
    values = ", ".join(f"%({c})s" for c in INGEST_COLUMNS)
    keys = ("bucket", "index_name", "job_id")
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in INGEST_COLUMNS if c not in keys)
    with _lock, _connect() as conn:
        conn.execute(
            f"INSERT INTO vector_ingests ({cols}) VALUES ({values}) "
            f"ON CONFLICT (bucket, index_name, job_id) DO UPDATE SET {updates}",
            {c: Jsonb(row[c]) if c == "options" and row.get(c) is not None else row.get(c) for c in INGEST_COLUMNS},
        )


def ingest_list(bucket: str, index_name: Optional[str] = None, job_id: Optional[str] = None) -> list[dict]:
    if not _url:
        return []
    where, args = ["bucket = %s"], [bucket]
    if index_name:
        where.append("index_name = %s")
        args.append(index_name)
    if job_id:
        where.append("job_id = %s")
        args.append(job_id)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(INGEST_COLUMNS)} FROM vector_ingests WHERE {' AND '.join(where)} ORDER BY created_at DESC",
            args,
        )
        rows = [dict(zip(INGEST_COLUMNS, r)) for r in cur.fetchall()]
    for r in rows:
        r["cost_usd"] = float(r["cost_usd"])
        r["skipped"] = r["skipped"] or 0
        r["attempts"] = r["attempts"] or 0
        r["trigger"] = r["trigger"] or "manual"
        for k in ("created_at", "finished_at"):
            r[k] = r[k].isoformat() if r[k] else None
    return rows


def ingest_delete(bucket: str, index_name: str, job_id: Optional[str] = None) -> None:
    if not _url:
        return
    with _lock, _connect() as conn:
        if job_id:
            conn.execute(
                "DELETE FROM vector_ingests WHERE bucket = %s AND index_name = %s AND job_id = %s",
                (bucket, index_name, job_id),
            )
        else:
            conn.execute("DELETE FROM vector_ingests WHERE bucket = %s AND index_name = %s", (bucket, index_name))


def ingest_interrupted(now: str) -> None:
    """Runs cut off by an API restart are marked failed (they can be started again)."""
    if not _url:
        return
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE vector_ingests SET status = 'failed', error = 'interrupted by an API restart', finished_at = %s "
            "WHERE status IN ('queued', 'running')",
            (now,),
        )
