"""Where sign-in data lives: SQLite (data/auth/auth.sqlite, the default) or PostgreSQL.

BLUESANDAI_AUTH_STORE=postgres keeps users, sessions, tokens, groups, organizations, markings, project roles and the
sign-in log in PostgreSQL (BLUESANDAI_AUTH_DATABASE_URL, else BLUESANDAI_DATABASE_URL), in the schema `bsai_auth`
next to your other data. On the first start with PostgreSQL, an existing auth.sqlite is copied over (once: only
while the PostgreSQL tables are empty); the SQLite file is left as it was.

auth.py writes SQLite-style SQL (`?` placeholders, `INSERT … ON CONFLICT … DO UPDATE SET x = excluded.x`), which
PostgreSQL also understands once the placeholders are rewritten; the schema's AUTOINCREMENT becomes BIGSERIAL.
"""

from __future__ import annotations

import logging
import queue
import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import mailer

log = logging.getLogger("bluesandai.auth")

PG_SCHEMA = "bsai_auth"
_kind = "sqlite"
_sqlite_path: Path = Path()
_pg_url: Optional[str] = None
_pool: "queue.LifoQueue[Any]" = queue.LifoQueue(maxsize=8)
_init_lock = threading.Lock()


def kind() -> str:
    return _kind


def _pg_sql(sql: str) -> str:
    return sql.replace("?", "%s")


class _PgConnection:
    """The bits of sqlite3.Connection auth.py uses, over a psycopg connection."""

    def __init__(self, con: Any):
        self.con = con

    def execute(self, sql: str, params: tuple | list = ()) -> Any:
        cur = self.con.cursor()
        cur.execute(_pg_sql(sql), tuple(params))
        return cur

    def executemany(self, sql: str, rows: list) -> Any:
        cur = self.con.cursor()
        cur.executemany(_pg_sql(sql), rows)
        return cur

    def executescript(self, script: str) -> None:
        script = re.sub(r"INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY", script)
        for stmt in (s.strip() for s in script.split(";")):
            if stmt:
                self.con.execute(stmt)


def configure(sqlite_path: Path, schema: str) -> None:
    """Pick the store and create its tables (and copy an existing SQLite store into a new PostgreSQL one)."""
    global _kind, _sqlite_path, _pg_url
    _sqlite_path = sqlite_path
    want = mailer.env("BLUESANDAI_AUTH_STORE", "sqlite").lower()
    if want in ("postgres", "postgresql", "pg"):
        url = mailer.env("BLUESANDAI_AUTH_DATABASE_URL") or mailer.env("BLUESANDAI_DATABASE_URL")
        if not url:
            raise RuntimeError("BLUESANDAI_AUTH_STORE=postgres needs BLUESANDAI_DATABASE_URL (or BLUESANDAI_AUTH_DATABASE_URL)")
        import psycopg

        with psycopg.connect(url, autocommit=True) as c:
            c.execute(f"CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}")
        _kind, _pg_url = "postgres", url
        with connect() as con:
            con.executescript(schema)
        _migrate_from_sqlite(schema)
    else:
        _kind = "sqlite"
        with connect() as con:
            con.executescript(schema)


def _pg_take() -> Any:
    import psycopg

    try:
        con = _pool.get_nowait()
        if con.closed or con.broken:
            raise queue.Empty
        return con
    except queue.Empty:
        con = psycopg.connect(_pg_url, options=f"-c search_path={PG_SCHEMA}")
        return con


@contextmanager
def connect() -> Iterator[Any]:
    """A connection to the store; commits when the block ends without an error."""
    if _kind == "postgres":
        raw = _pg_take()
        try:
            yield _PgConnection(raw)
            raw.commit()
        except BaseException:
            raw.rollback()
            raise
        finally:
            try:
                _pool.put_nowait(raw)
            except queue.Full:
                raw.close()
        return
    con = sqlite3.connect(_sqlite_path, timeout=30)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _tables(schema: str) -> list[str]:
    return re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", schema)


def _migrate_from_sqlite(schema: str) -> None:
    """Copy auth.sqlite into PostgreSQL the first time (while PostgreSQL has no users)."""
    if not _sqlite_path.is_file():
        return
    with _init_lock, connect() as pg:
        if pg.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            return
        src = sqlite3.connect(_sqlite_path)
        try:
            copied = 0
            for t in _tables(schema):
                try:
                    cur = src.execute(f"SELECT * FROM {t}")
                except sqlite3.OperationalError:
                    continue  # an older SQLite store without this table
                cols = [d[0] for d in cur.description]
                rows = cur.fetchall()
                if rows:
                    pg.executemany(f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)}) ON CONFLICT DO NOTHING", rows)
                    copied += len(rows)
            if "audit" in _tables(schema):
                pg.execute("SELECT setval(pg_get_serial_sequence('audit', 'id'), COALESCE((SELECT MAX(id) FROM audit), 0) + 1, false)")
            log.info("copied %d rows of sign-in data from %s into PostgreSQL", copied, _sqlite_path)
        finally:
            src.close()
