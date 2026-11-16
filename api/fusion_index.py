"""Lime-style dataset indexes for Fusion lookups (Analytics doc 09: "Index datasets", "Lookup datasets").

A Parquet dataset in Files is indexed explicitly, on chosen key columns. The index is a SQLite sidecar built from one
version of the dataset (Files' updated_at + size; the latest transaction is kept for display):

- `rows`: every row a lookup can see (the first workshop.MAX_SOURCE_ROWS rows, the same rows the unindexed reader
  keeps), its cells as JSON in the dataset's column order, at its row position `r`, plus for every key column the id
  of the cell's distinct value (`f0`, `f1`, …, indexed: distinct value → row positions).
- `d<j>`: the distinct values of key column j with what each lookup modifier compares: `k` the equality key
  (numbers, numeric text and booleans share a key), `kn` the number it compares as, `ks` its text for text order,
  `x` its text as exact() / fuzzy() read it and `n` the length of that text in lower case; all indexed.
- `w<j>`: word → distinct value (the words all_token_match / any_token_match look for).

Lookups (`lookup`, `lookup_array`, `lookup_distinct`, `lookup_dropdown`, `lookup_sorted`; `lookup_schema` reads the
column names) on a dataset whose index is up to date: every filter on a key column that is a plain value, a list of
values, eq, exact, gt, gte, lt, lte, fuzzy, all_token_match or any_token_match gives candidate row positions through
the index (a superset of the matching rows); the candidates are read in row order and EVERY filter is then checked on
them with the rules of an unindexed lookup (fusion_formula._match), so the result is the one a scan gives, in the
same order, with the same 2,000-result limit. A lookup the index cannot narrow (only neq filters, filters on columns
that are not keys, eq(null), a fuzzy match over too many distinct values, a column whose cells the sidecar cannot
hold) scans the dataset as before.

- A stale index (the dataset has a newer version) never answers: the lookup scans, and the index is rebuilt (inside
  the lookup for a small dataset, in the background otherwise).
- Manual update mode (a document's "Update sources") does not read indexes: its lookups keep the data read at the
  last update (fusion._cached_datasets).
- An index answers only users who can read the dataset: every lookup resolves the dataset through Files first
  (drive._item: markings and the Project role), with or without an index.
- Limits: MAX_KEYS key columns, MAX_INDEXES indexes, MAX_INDEX_BYTES per sidecar, MAX_TOTAL_BYTES for all of them.
- Clean-up: the index of a dataset that was deleted or trashed is dropped (sweep(): on listing, and at most every
  few minutes on lookups); removing an index deletes only its sidecar, never the dataset.

Files: data/fusion/indexes/registry.json and <dataset id>-<version hash>.sqlite. Routes under /api/fusion/indexes,
included by fusion.py's router.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import fusion_formula as F

router = APIRouter(prefix="/indexes")

DIR = Path()
MAX_KEYS = 8
MAX_INDEXES = 200
MAX_INDEX_BYTES = 2 * 1024 ** 3  # one sidecar
MAX_TOTAL_BYTES = 10 * 1024 ** 3  # all sidecars
INLINE_BYTES = 4 * 1024 * 1024  # a stale index of a dataset smaller than this is rebuilt inside the lookup
FUZZY_MAX = 50_000  # a fuzzy match compares at most this many distinct values; more → the lookup scans
SWEEP_EVERY = 300.0
BATCH = 20_000
_lock = threading.RLock()
_registry: dict[str, dict] = {}
_building: dict[str, dict] = {}  # dataset id -> {"rows": n, "started": t} while a build runs
_garbage: set[str] = set()  # sidecar files a reader still held open when they were replaced (Windows)
_swept = [0.0]
_PLAIN = (type(None), bool, int, float, str)
_WORD = re.compile(r"\w+")


def configure(data_dir: Path) -> None:
    global DIR, _registry
    DIR = data_dir / "fusion" / "indexes"
    DIR.mkdir(parents=True, exist_ok=True)
    try:
        _registry = json.loads((DIR / "registry.json").read_text("utf-8"))
    except (OSError, ValueError):
        _registry = {}
    for ent in _registry.values():
        if ent.get("status") == "syncing":  # the process stopped during a build
            ent["status"] = "failed" if not ent.get("file") else "ready"
            ent["error"] = ent.get("error") or ("the build was interrupted" if not ent.get("file") else None)
    for p in DIR.glob("*.building.sqlite"):
        _remove(p)


def _save() -> None:
    tmp = DIR / "registry.json.tmp"
    tmp.write_text(json.dumps(_registry, indent=1, default=str), "utf-8")
    os.replace(tmp, DIR / "registry.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _who() -> str:
    import auth

    me = auth.current() or {}
    return me.get("username") or "local"


def _remove(p: Path) -> None:
    try:
        p.unlink(missing_ok=True)
        _garbage.discard(str(p))
    except OSError:
        _garbage.add(str(p))


def _collect() -> None:
    for p in list(_garbage):
        _remove(Path(p))


# ------------------------------------------------------------------ versions and keys


def stamp(item: dict) -> str:
    """The dataset version an index is built from: Files' updated_at and size, and for a file stored on this
    computer its modification time (updated_at has whole seconds; two writes in one second still differ)."""
    s = f"{item.get('updated_at')}|{item.get('size_bytes', item.get('size'))}"
    if item.get("stored_in") and item.get("stored_in") != "s3":
        import drive

        try:
            st = (drive.LOCAL_DIR / item["id"]).stat()
            s += f"|{st.st_mtime_ns}|{st.st_size}"
        except OSError:
            pass
    return s


def _vhash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:12]


def key_of(v: Any) -> Optional[str]:
    """The equality key of a cell or of a looked-up value: two values a lookup's equality (fusion_formula.compare
    "==") can call equal always have the same key ("n:" numbers, numeric text and booleans; "s:" other text), so
    the index finds a superset of the matching rows and _match decides."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "n:1" if v else "n:0"
    try:
        if isinstance(v, (int, float)):
            return "n:" + F.to_text(float(v))
        s = v if isinstance(v, str) else F.to_text(v)
        n = F.num(s)
    except (OverflowError, ValueError):
        return "s:" + F.to_text(v)
    return "n:" + F.to_text(n) if n is not None else "s:" + s


def _number(v: Any) -> Optional[float]:
    """The number a cell (or a looked-up value) compares as in gt / gte / lt / lte, when it can compare as one."""
    try:
        if isinstance(v, (bool, int, float, Decimal)):
            n = float(v)
        elif isinstance(v, str):
            n = F.num(v)
        else:
            return None
    except (OverflowError, ValueError, ArithmeticError):
        return None
    return None if n is None or n != n else n


def _distinct_key(v: Any) -> Any:
    """Cells with the same key behave alike under every modifier (1, 1.0, True and "1" do not)."""
    t = type(v)
    if t in (bool, int, str):
        return (t, v)
    if t is float:
        return (t, repr(v))
    if t in (list, dict):
        return ("j", json.dumps(v, default=str))
    return (t.__name__, repr(v))


def _plan(val: Any) -> Optional[tuple]:
    """How the index narrows one filter on a key column: None (it cannot), ("none",) (nothing matches),
    ("sql", sub-select of distinct ids with {d} / {w} for the tables, parameters) or ("fuzzy", text, distance)."""
    dist = 2
    if not F._is_modifier(val):
        if val is None or val == "":
            return None  # no filter at all
        vals = val if isinstance(val, list) else [val]
        op = "=="
    else:
        dist = val.get("distance", 2)
        op, val = val.get("op"), val.get("value")
        vals = [val]
        if op == "==" and isinstance(val, list):
            return None  # eq(list) equals a list cell
    if op == "==":
        keys = set()
        for x in vals:
            if x is None or isinstance(x, (dict, list)):
                return None  # null equals empty cells, which have no key
            keys.add(key_of(x))
        if not keys:
            return ("none",)
        if len(keys) > 900:
            return None
        return ("sql", f"SELECT id FROM {{d}} WHERE k IN ({', '.join('?' * len(keys))})", sorted(keys))
    if op == "exact":
        return ("sql", "SELECT id FROM {d} WHERE x = ?", [F.to_text(val)])
    if op in ("<", ">", "<=", ">="):
        if val is None or not isinstance(val, (bool, int, float, Decimal, str)):
            return None
        if (isinstance(val, float) and val != val) or (isinstance(val, Decimal) and val.is_nan()):
            return None  # a decimal cell cannot be compared with NaN: the scan reports it
        # not strict: big integers and numeric text round to the same number; _match decides
        sop = ">=" if op in (">", ">=") else "<="
        n = _number(val)
        parts, params = [], []
        if n is not None:
            parts.append(f"SELECT id FROM {{d}} WHERE kn {sop} ?")
            params.append(n)
        parts.append(f"SELECT id FROM {{d}} WHERE ks {sop} ?")  # cells that compare as text
        params.append(val if isinstance(val, str) else str(val))
        return ("sql", " UNION ".join(parts), params)
    if op == "fuzzy":
        try:
            return ("fuzzy", F.to_text(val).lower(), int(dist))
        except (TypeError, ValueError):
            return None
    if op in ("all_tokens", "any_tokens"):
        terms = list(dict.fromkeys(_WORD.findall(F.to_text(val).lower())))
        if not terms:
            return ("none",)
        if len(terms) > 200:
            return None
        if op == "any_tokens":
            return ("sql", f"SELECT id FROM {{w}} WHERE w IN ({', '.join('?' * len(terms))})", terms)
        return ("sql", " INTERSECT ".join("SELECT id FROM {w} WHERE w = ?" for _ in terms), terms)
    return None  # neq (and anything unknown): every row is a candidate


# ------------------------------------------------------------------ building


def _read_dataset(item: dict) -> bytes:
    import drive

    return drive.read_bytes(item)


def _total_bytes(but: Optional[str] = None) -> int:
    with _lock:
        return sum(int(e.get("size_bytes") or 0) for i, e in _registry.items() if i != but and e.get("file"))


def _build(item: dict, keys: list[str], data: bytes, who: str, ver: str) -> None:
    """Writes the sidecar for this dataset version and swaps it in (the previous one is removed)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    import pipeline_datasets
    import workshop

    did = item["id"]
    t0 = time.perf_counter()
    tmp = DIR / f"{did}-{_vhash(ver)}.building.sqlite"
    final = DIR / f"{did}-{_vhash(ver)}.sqlite"
    _remove(tmp)
    try:
        pf = pq.ParquetFile(io.BytesIO(data))
        total = pf.metadata.num_rows
        limit = min(total, workshop.MAX_SOURCE_ROWS)
        with _lock:
            if did in _registry:
                _registry[did]["total"] = limit
        schema = pf.schema_arrow
        cols = list(schema.names)
        if len(set(cols)) != len(cols):
            raise ValueError("the dataset has two columns with the same name")
        missing = [k for k in keys if k not in cols]
        if missing:
            raise ValueError(f"the dataset has no column {', '.join(missing)}")
        codecs = ["decimal" if pa.types.is_decimal(f.type) else "plain" for f in schema]
        types = {f.name: pipeline_datasets._column_type(f.type) for f in schema}
        kpos = [cols.index(k) for k in keys]
        nk = len(keys)
        jcell = workshop._json_cell
        con = sqlite3.connect(tmp)
        try:
            con.execute("PRAGMA journal_mode=OFF")
            con.execute("PRAGMA synchronous=OFF")
            con.execute("PRAGMA cache_size=-200000")
            con.execute(f"CREATE TABLE rows (r INTEGER PRIMARY KEY, j TEXT{''.join(f', f{j} INTEGER' for j in range(nk))})")
            for j in range(nk):
                con.execute(f"CREATE TABLE d{j} (id INTEGER PRIMARY KEY, k TEXT, kn REAL, ks TEXT, x TEXT, n INTEGER)")
                con.execute(f"CREATE TABLE w{j} (w TEXT, id INTEGER, PRIMARY KEY (w, id)) WITHOUT ROWID")
            ins = f"INSERT INTO rows VALUES ({', '.join('?' * (2 + nk))})"
            seen: list[dict] = [{} for _ in keys]
            r = 0
            for batch in pf.iter_batches(batch_size=BATCH):
                if r >= limit:
                    break
                if r + batch.num_rows > limit:
                    batch = batch.slice(0, limit - r)
                n = batch.num_rows
                # the cells as an unindexed lookup sees them (workshop._dataset_rows: to_pylist, then _json_cell)
                cells = [[v if type(v) in _PLAIN else jcell(v) for v in batch.column(i).to_pylist()] for i in range(len(cols))]
                stored = []
                for i, col in enumerate(cells):
                    if codecs[i] == "decimal":
                        col = [None if v is None else str(v) for v in col]
                    elif codecs[i] == "plain" and any(type(v) not in _PLAIN and type(v) not in (list, dict) for v in col):
                        codecs[i] = "skip"  # times, durations …: not held; lookups that read this column scan
                    if codecs[i] == "skip":
                        col = [None] * n
                    stored.append(col)
                fcols = []
                for j, p in enumerate(kpos):
                    ids, fresh, words = [], [], []
                    known = seen[j]
                    for v in cells[p]:
                        dk = _distinct_key(v)
                        vid = known.get(dk)
                        if vid is None:
                            vid = known[dk] = len(known) + 1
                            x = F.to_text(v)
                            low = x.lower()
                            fresh.append((vid, key_of(v), _number(v), None if v is None else str(v), x, len(low)))
                            words.extend((w, vid) for w in set(_WORD.findall(low)))
                        ids.append(vid)
                    con.executemany(f"INSERT INTO d{j} VALUES (?, ?, ?, ?, ?, ?)", fresh)
                    con.executemany(f"INSERT OR IGNORE INTO w{j} VALUES (?, ?)", words)
                    fcols.append(ids)
                con.executemany(ins, zip(range(r, r + n), (json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in zip(*stored)), *fcols))
                r += n
                with _lock:
                    _building.setdefault(did, {})["rows"] = r
                    gone = did not in _registry
                if gone:
                    raise ValueError("the index was removed while it was being built")
                con.commit()
                if tmp.stat().st_size > MAX_INDEX_BYTES:
                    raise ValueError(f"the index would be larger than {MAX_INDEX_BYTES // 1024 ** 3} GB; index fewer key columns")
            for j in range(nk):
                con.execute(f"CREATE INDEX ix_f{j} ON rows (f{j})")
                for c in ("k", "kn", "ks", "x", "n"):
                    con.execute(f"CREATE INDEX ix_d{j}_{c} ON d{j} ({c})")
            con.execute("ANALYZE")
            con.commit()
        finally:
            con.close()
        size = tmp.stat().st_size
        if size > MAX_INDEX_BYTES:
            raise ValueError(f"the index would be larger than {MAX_INDEX_BYTES // 1024 ** 3} GB; index fewer key columns")
        if size + _total_bytes(but=did) > MAX_TOTAL_BYTES:
            raise ValueError(f"the indexes together would be larger than {MAX_TOTAL_BYTES // 1024 ** 3} GB; remove one first")
        os.replace(tmp, final)
        tx = None
        try:
            import dataset_versions

            cur = dataset_versions.current(did)
            tx = cur.get("id") if cur else None
        except Exception:  # noqa: BLE001
            tx = None
        with _lock:
            ent = _registry.get(did)
            if ent is None:  # removed while building
                _remove(final)
                return
            old = ent.get("file")
            ent.update({"status": "ready", "file": final.name, "version": ver, "transaction": tx, "columns": cols, "codecs": codecs,
                        "types": types, "built_keys": keys, "rows": r, "dataset_rows": total, "size_bytes": size, "built_at": _now(),
                        "built_by": who, "build_ms": round((time.perf_counter() - t0) * 1000), "error": None, "failed_version": None,
                        "dataset_name": item["name"], "distinct": {k: len(seen[j]) for j, k in enumerate(keys)}})
            _save()
            if old and old != final.name:
                _remove(DIR / old)
            _collect()
    except Exception as e:  # noqa: BLE001
        _remove(tmp)
        with _lock:
            ent = _registry.get(did)
            if ent is not None:
                # failed_version: a stale index is not rebuilt again for the same failing version on every lookup
                ent.update({"status": "ready" if ent.get("file") else "failed", "error": str(e)[:500], "failed_at": _now(), "failed_version": ver})
                _save()
    finally:
        with _lock:
            _building.pop(did, None)


def _start(item: dict, keys: list[str], wait: bool, data: Optional[bytes] = None, ver: Optional[str] = None) -> None:
    """Builds now (wait) or in a background thread; a build already running for the dataset is left alone. `ver` is
    the version read BEFORE the data (a write in between leaves the index stale, never wrongly up to date)."""
    did = item["id"]
    ver = ver or stamp(item)
    with _lock:
        if did in _building or did not in _registry:
            return
        _building[did] = {"rows": 0, "started": time.time()}
        ent = _registry[did]
        ent["status"] = "syncing"
        ent["building_version"] = ver
        _save()
    who = _who()
    try:
        if data is None:
            data = _read_dataset(item)
    except Exception as e:  # noqa: BLE001
        with _lock:
            _building.pop(did, None)
            ent.update({"status": "ready" if ent.get("file") else "failed", "error": str(e)[:500], "failed_version": ver})
            _save()
        return
    if wait:
        _build(item, keys, data, who, ver)
    else:
        threading.Thread(target=_build, args=(item, keys, data, who, ver), daemon=True, name=f"fusion-index-{did}").start()


# ------------------------------------------------------------------ reading


class IndexSource:
    """An up-to-date index: `select(filters, limit, need)` returns the matching rows, or None when the index cannot
    narrow the lookup (the caller scans)."""

    def __init__(self, ent: dict, path: Path):
        self.path = path
        self.columns: list[str] = ent["columns"]
        self.codecs: list[str] = ent.get("codecs") or ["plain"] * len(self.columns)
        self.keys: list[str] = ent.get("built_keys") or []
        self.count: int = ent.get("rows") or 0
        self.last: dict = {}  # how the last select ran: {"used_index", "candidates", "ms", "reason"}

    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(f"file:{self.path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
        con.execute("PRAGMA query_only=1")
        return con

    def _no(self, reason: str) -> None:
        self.last = {"used_index": False, "reason": reason}
        return None

    def select(self, filters: list[tuple[str, Any]], limit: Optional[int] = None, need: Optional[list[str]] = None) -> Optional[list[dict]]:
        t0 = time.perf_counter()
        want = list(dict.fromkeys([*(need or []), *(c for c, _ in filters)]))
        if any(c not in self.columns for c in want):
            return self._no("a column is not in the index")
        cpos = [self.columns.index(c) for c in want]
        if any(self.codecs[i] == "skip" for i in cpos):
            return self._no("the index does not hold a column of this type")
        plans = []
        for col, val in filters:
            if col in self.keys:
                p = _plan(val)
                if p is not None:
                    if p[0] == "none":
                        self.last = {"used_index": True, "candidates": 0, "ms": round((time.perf_counter() - t0) * 1000, 2)}
                        return []
                    plans.append((self.keys.index(col), p))
        if not plans:
            return self._no("no filter on a key column the index can narrow" if filters else "the lookup has no filter")
        try:
            con = self._con()
        except sqlite3.Error:
            return self._no("the index file could not be opened")
        try:
            conds, params, sets = [], [], []
            for j, p in plans:
                if p[0] == "sql":
                    conds.append(f"f{j} IN ({p[1].format(d=f'd{j}', w=f'w{j}')})")
                    params.extend(p[2])
                    continue
                _, text, dist = p
                near = con.execute(f"SELECT id, x FROM d{j} WHERE n BETWEEN ? AND ? LIMIT ?", (len(text) - dist, len(text) + dist, FUZZY_MAX + 1)).fetchall()
                if len(near) > FUZZY_MAX:
                    continue  # too many distinct values to compare: this filter is checked on the rows instead
                ids = [i for i, x in near if F._levenshtein(x.lower(), text) <= dist]
                rs: set[int] = set()
                for i in range(0, len(ids), 900):
                    chunk = ids[i:i + 900]
                    rs.update(x[0] for x in con.execute(f"SELECT r FROM rows WHERE f{j} IN ({', '.join('?' * len(chunk))})", chunk))
                sets.append(rs)
            if not conds and not sets:
                return self._no("the fuzzy match has too many distinct values to compare")
            if conds:
                sets.append({x[0] for x in con.execute(f"SELECT r FROM rows WHERE {' AND '.join(conds)}", params)})
            sets.sort(key=len)
            rids = sorted(sets[0].intersection(*sets[1:]))
            out: list[dict] = []
            done = False
            for i in range(0, len(rids), 500):
                chunk = rids[i:i + 500]
                for (js,) in con.execute(f"SELECT j FROM rows WHERE r IN ({', '.join('?' * len(chunk))}) ORDER BY r", chunk):
                    rec = json.loads(js)
                    row = {}
                    for c, p in zip(want, cpos):
                        v = rec[p]
                        if v is not None:
                            if self.codecs[p] == "decimal":
                                v = Decimal(v)
                            elif v != v and type(v) is float:
                                v = float("nan")  # one object per cell, as the reader gives (lookup_distinct tells them apart)
                        row[c] = v
                    if F._match(row, filters):
                        out.append(row)
                        if limit and len(out) >= limit:
                            done = True
                            break
                if done:
                    break
        except sqlite3.Error:
            return self._no("the index file could not be read")
        finally:
            con.close()
        self.last = {"used_index": True, "candidates": len(rids), "ms": round((time.perf_counter() - t0) * 1000, 2)}
        return out


class Rows:
    """A dataset's rows as Fusion's lookups read them: through the index when it can narrow the lookup, else the
    rows of the unindexed reader (`load`, read once and only when needed). `info` is the document's source entry;
    its "lookup" counts say how the lookups ran."""

    def __init__(self, columns: list[str], src: Optional[IndexSource], load: Callable[[], list[dict]], info: dict):
        self.columns = columns
        self.src = src
        self._load = load
        self._rows: Optional[list[dict]] = None
        self.info = info
        info["lookup"] = {"count": 0, "indexed": 0, "scanned": 0, "ms": 0.0, "filter_columns": [], "scan_reason": None}

    def all(self) -> list[dict]:
        if self._rows is None:
            self._rows = self._load()
        return self._rows

    def __len__(self) -> int:
        return len(self.all())

    def __iter__(self) -> Iterator[dict]:
        return iter(self.all())

    def __getitem__(self, i: Any) -> Any:
        return self.all()[i]

    def select(self, filters: list[tuple[str, Any]], limit: Optional[int] = None, need: Optional[list[str]] = None) -> list[dict]:
        t0 = time.perf_counter()
        st = self.info["lookup"]
        out = self.src.select(filters, limit, need) if self.src is not None else None
        if out is None:
            hit = [r for r in self.all() if F._match(r, filters)]
            out = hit[:limit] if limit else hit
            st["scanned"] += 1
            st["scan_reason"] = (self.src.last.get("reason") if self.src is not None else None) or st["scan_reason"]
        else:
            st["indexed"] += 1
        st["count"] += 1
        st["ms"] = round(st["ms"] + (time.perf_counter() - t0) * 1000, 2)
        for c, _ in filters:
            if c not in st["filter_columns"]:
                st["filter_columns"].append(c)
        return out


def source(item: dict, rebuild: bool = True) -> Optional[IndexSource]:
    """The index of a dataset the caller can read (item came from drive._item) when it is built from the dataset's
    current version, else None: a stale index never answers. A stale index starts its rebuild here."""
    did = item["id"]
    sweep(every=SWEEP_EVERY)
    ver = stamp(item)
    with _lock:
        ent = _registry.get(did)
        if not ent:
            return None
        stale = not ent.get("file") or ent.get("version") != ver
        start = stale and rebuild and did not in _building and ent.get("failed_version") != ver and bool(ent.get("keys"))
        keys = list(ent.get("keys") or [])
    if start:
        small = int(item.get("size_bytes") or item.get("size") or 0) < INLINE_BYTES
        _start(item, keys, wait=small, ver=ver)
    with _lock:
        ent = _registry.get(did)
        if not ent or not ent.get("file") or ent.get("version") != ver:
            return None
        path = DIR / ent["file"]
        if not path.exists():
            ent.update({"status": "failed", "file": None, "error": "the index file is missing; rebuild it"})
            _save()
            return None
        return IndexSource(ent, path)


def status_of(ent: dict, item: Optional[dict]) -> str:
    if ent["id"] in _building:
        return "syncing"
    if item is None:
        return "missing"
    if not ent.get("file"):
        return "failed" if ent.get("status") == "failed" else "syncing"
    return "up_to_date" if ent.get("version") == stamp(item) else "stale"


def summary(item: dict) -> Optional[dict]:
    """What a document's source entry says about the dataset's index (None when it is not indexed)."""
    with _lock:
        ent = _registry.get(item["id"])
        if not ent:
            return None
        return {"status": status_of(dict(ent, id=item["id"]), item), "keys": ent.get("built_keys") or ent.get("keys"),
                "rows": ent.get("rows"), "built_at": ent.get("built_at"), "error": ent.get("error")}


# ------------------------------------------------------------------ clean-up


def _drop(dataset_id: str) -> bool:
    with _lock:
        if dataset_id in _building:
            return False
        had = _registry.pop(dataset_id, None) is not None
        if had:
            _save()
        for p in DIR.glob(f"{dataset_id}-*.sqlite"):
            _remove(p)
        return had


def sweep(every: float = 0.0) -> list[str]:
    """Drops the indexes of datasets that were deleted or trashed, and sidecar files no index owns."""
    import db

    if every and time.time() - _swept[0] < every:
        return []
    _swept[0] = time.time()
    if not db.enabled():
        return []
    dropped = []
    with _lock:
        ids = list(_registry)
    for did in ids:
        try:
            raw = db.drive_get(did)
        except Exception:  # noqa: BLE001
            continue  # the database is not reachable: nothing is dropped on a guess
        if (not raw or raw.get("trashed_at")) and _drop(did):
            dropped.append(did)
    with _lock:
        owned = {e.get("file") for e in _registry.values()}
        for p in DIR.glob("*.sqlite"):
            if p.name not in owned and not p.name.endswith(".building.sqlite"):
                _remove(p)
        _collect()
    return dropped


# ------------------------------------------------------------------ routes


def _dataset(dataset_id: str) -> dict:
    import drive
    import pipeline_datasets

    item = drive._item(dataset_id)
    if item.get("kind") != "file" or item.get("content_type") != pipeline_datasets.PARQUET:
        raise HTTPException(400, "only Parquet datasets in Files can be indexed")
    return item


def _public(ent: dict, item: Optional[dict]) -> dict:
    import drive

    b = _building.get(ent["id"])
    return {
        "dataset_id": ent["id"], "name": item["name"] if item else ent.get("dataset_name"),
        "path": [p["name"] for p in (drive._with_path(item).get("path") or [])] if item else [],
        "keys": ent.get("keys"), "built_keys": ent.get("built_keys"), "status": status_of(ent, item),
        "rows": ent.get("rows"), "dataset_rows": ent.get("dataset_rows"), "columns": ent.get("columns"), "distinct": ent.get("distinct"),
        "unheld_columns": [c for c, k in zip(ent.get("columns") or [], ent.get("codecs") or []) if k == "skip"],
        "size_bytes": ent.get("size_bytes"), "version": ent.get("version"), "transaction": ent.get("transaction"),
        "dataset_updated_at": str(item.get("updated_at")) if item else None,
        "built_at": ent.get("built_at"), "built_by": ent.get("built_by"), "build_ms": ent.get("build_ms"),
        "created_at": ent.get("created_at"), "created_by": ent.get("created_by"), "error": ent.get("error"),
        "progress": {"rows": b.get("rows", 0), "total": ent.get("total")} if b else None,
    }


def public(dataset_id: str, item: dict) -> Optional[dict]:
    """The index of a dataset the caller can read, as the routes describe it (None when it has none)."""
    with _lock:
        ent = _registry.get(dataset_id)
        return _public(dict(ent, id=dataset_id), item) if ent else None


def _may_manage(ent: dict, item: dict) -> None:
    import auth
    import drive

    me = auth.current()
    if not auth.enabled() or me is None or me.get("role") == "admin" or ent.get("created_by") == _who():
        return
    drive._item(item["id"], need="editor")


class IndexIn(BaseModel):
    dataset_id: str
    keys: list[str] = Field(min_length=1, max_length=MAX_KEYS)
    wait: bool = False


@router.get("")
def list_indexes() -> list[dict]:
    """The indexed datasets the caller can read."""
    import drive

    sweep()
    out = []
    with _lock:
        ents = [dict(e, id=i) for i, e in _registry.items()]
    for ent in ents:
        try:
            item = drive._item(ent["id"])
        except HTTPException:
            continue
        out.append(_public(ent, item))
    return sorted(out, key=lambda x: (x["name"] or "").lower())


@router.get("/limits")
def limits() -> dict:
    import workshop

    return {"max_keys": MAX_KEYS, "max_indexes": MAX_INDEXES, "max_index_bytes": MAX_INDEX_BYTES, "max_total_bytes": MAX_TOTAL_BYTES,
            "max_rows": workshop.MAX_SOURCE_ROWS, "total_bytes": _total_bytes(), "indexes": len(_registry)}


@router.post("")
def create_index(req: IndexIn) -> dict:
    """Index a dataset on key columns (or change the key columns of its index); the build starts at once."""
    import pyarrow.parquet as pq

    item = _dataset(req.dataset_id)
    keys = list(dict.fromkeys(k.strip() for k in req.keys if k.strip()))
    if not keys:
        raise HTTPException(400, "choose at least one key column")
    ver = stamp(item)
    data = _read_dataset(item)
    try:
        cols = pq.read_schema(io.BytesIO(data)).names
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet file: {e}') from e
    bad = [k for k in keys if k not in cols]
    if bad:
        raise HTTPException(400, f"the dataset has no column {', '.join(bad)}")
    if len(set(cols)) != len(cols):
        raise HTTPException(400, "the dataset has two columns with the same name")
    with _lock:
        if item["id"] in _building:
            raise HTTPException(409, "this dataset's index is being built; try again when it is done")
        ent = _registry.get(item["id"])
        if ent:
            _may_manage(dict(ent, id=item["id"]), item)
            ent.update({"keys": keys, "error": None, "failed_version": None})
        else:
            if len(_registry) >= MAX_INDEXES:
                raise HTTPException(413, f"at most {MAX_INDEXES} datasets are indexed; remove an index first")
            if _total_bytes() >= MAX_TOTAL_BYTES:
                raise HTTPException(413, f"the indexes already hold {MAX_TOTAL_BYTES // 1024 ** 3} GB; remove an index first")
            ent = _registry[item["id"]] = {"keys": keys, "status": "syncing", "file": None, "created_at": _now(), "created_by": _who(),
                                           "dataset_name": item["name"]}
        _save()
    _start(item, keys, wait=req.wait, data=data, ver=ver)
    with _lock:
        return _public(dict(_registry[item["id"]], id=item["id"]), item)


@router.get("/{dataset_id}")
def get_index(dataset_id: str) -> dict:
    import drive

    item = drive._item(dataset_id)
    with _lock:
        ent = _registry.get(dataset_id)
        if not ent:
            raise HTTPException(404, "this dataset is not indexed")
        return _public(dict(ent, id=dataset_id), item)


@router.post("/{dataset_id}/rebuild")
def rebuild_index(dataset_id: str, wait: bool = False) -> dict:
    """Re-sync the index from the dataset's current version."""
    item = _dataset(dataset_id)
    with _lock:
        ent = _registry.get(dataset_id)
        if not ent:
            raise HTTPException(404, "this dataset is not indexed")
        if dataset_id in _building:
            raise HTTPException(409, "the index is already being built")
        ent["error"] = None
        ent["failed_version"] = None
        keys = list(ent["keys"])
    _start(item, keys, wait=wait)
    with _lock:
        return _public(dict(_registry[dataset_id], id=dataset_id), item)


@router.delete("/{dataset_id}")
def remove_index(dataset_id: str) -> dict:
    """Stop indexing a dataset: its sidecar files are deleted (the dataset is not touched)."""
    import drive

    item = drive._item(dataset_id)
    with _lock:
        ent = _registry.get(dataset_id)
        if not ent:
            raise HTTPException(404, "this dataset is not indexed")
        _may_manage(dict(ent, id=dataset_id), item)
        if dataset_id in _building:
            raise HTTPException(409, "the index is being built; remove it when the build is done")
        _drop(dataset_id)
    return {"removed": dataset_id}
