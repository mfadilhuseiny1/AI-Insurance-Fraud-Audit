"""Live object types: the object engine for big types. A live type's objects are not indexed into the object store
(ontology_store's JSON files, read whole into memory): they are read straight from the type's backing Parquet
dataset with DuckDB, one statement per question, so a type holds millions of objects (5.4 million FKRTL claims:
~0.1 GB of memory and well under a second per query, where the JSON store would need ~20 GB).

What makes a type live
* PUT /api/ontology/object-types/{id}/datasource/live {dataset_id, columns?, map_unmapped?} backs the type by a
  local Parquet dataset in Files without importing it. The marker <objects>/<type_id>.live.json records the
  dataset, its file, the column → property mapping and the primary key column; ontology_store reads a type that
  has one through this module.
* The dataset is the truth: a pipeline build that writes the dataset again changes the objects at once (no re-index).

What reads and writes see
* ontology_store.load() returns a LiveObjects mapping: a key looked up is read with one query; len() counts the
  dataset; iterating every object is refused above SMALL objects (with the reason) instead of loading millions.
* Edits (actions, Object View, bulk edits of single objects) modify objects only: each edited object's changed
  values are kept in <objects>/<type_id>.live-edits.sqlite and laid over the dataset's values on every read and query
  (filters, sorts and aggregations see the edited values). Creating or deleting objects is refused: rows come from
  the dataset.
* Object Explorer and the agents' searches (POST /api/ontology/explorer/search) run as DuckDB statements: keyword,
  filters (eq … between, in, null, regex, wildcard, and / or / not), sort, page, the aggregation, the histograms,
  and Search Arounds over foreign-key link types to or from a live type.
* Object Views and links: foreign-key links resolve with queries both ways (a facility profile → its claims).

Refused on a live type (each says why): object or property security policies, mandatory controls, additional or
changelog datasources, semantic search, link types other than foreign keys, loading every object above SMALL.
"""

from __future__ import annotations

import datetime as _dt
import decimal
import hashlib
import json
import os
import re
import sqlite3
import threading
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from fastapi import HTTPException

# a live type this small may still be loaded whole (every module that iterates a type's objects keeps working)
SMALL = 50_000
NUMERIC = ("integer", "long", "short", "byte", "double", "float", "decimal")
SQL_TYPE = {"string": "VARCHAR", "integer": "BIGINT", "long": "BIGINT", "short": "BIGINT", "byte": "BIGINT", "double": "DOUBLE", "float": "DOUBLE",
            "decimal": "DOUBLE", "boolean": "BOOLEAN", "date": "DATE", "timestamp": "TIMESTAMP"}
_meta: dict[str, tuple[int, dict]] = {}
_meta_lock = threading.Lock()
_db_lock = threading.Lock()
_db: Any = None
_tl = threading.local()
_counts: dict[str, tuple[tuple, int]] = {}
# a live search's charts (two or more scans of every row: 8 s on the 5.4M claims), the same until the data, the edits
# or the object types change: paging the results or coming back to an exploration reads them from here
_hists: dict[str, list[dict]] = {}
_hists_lock = threading.Lock()
HISTS_KEEP = 64
# lineage participation of a foreign-key link type with a live side: (state key, answer) per link type
_participations: dict[str, tuple[str, dict]] = {}


class TooLarge(HTTPException):
    def __init__(self, t_name: str, n: int):
        super().__init__(400, f"{t_name} is a live object type with {n:,} objects, read straight from its dataset: loading every object is "
                              f"not supported above {SMALL:,}. Search or filter it (Object Explorer, the agents' search) instead.")


# ------------------------------------------------------------------------------------------------ the marker


def _root() -> Path:
    import ontology_store

    return ontology_store.ROOT


def marker_path(type_id: str) -> Path:
    return _root() / f"{type_id}.live.json"


def edits_path(type_id: str) -> Path:
    return _root() / f"{type_id}.live-edits.sqlite"


def meta(type_id: str) -> Optional[dict]:
    """The live type's marker (None: not a live type), cached by the file's mtime."""
    p = marker_path(type_id)
    try:
        mt = p.stat().st_mtime_ns
    except (FileNotFoundError, OSError):
        _meta.pop(type_id, None)
        return None
    hit = _meta.get(type_id)
    if hit and hit[0] == mt:
        return hit[1]
    with _meta_lock:
        m = json.loads(p.read_text("utf-8"))
        _meta[type_id] = (mt, m)
    return m


def is_live(type_id: Optional[str]) -> bool:
    return bool(type_id) and meta(str(type_id)) is not None


def _write_marker(type_id: str, m: dict) -> None:
    p = marker_path(type_id)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, p)


def drop(type_id: str) -> None:
    """The type is no longer live (its datasource was removed or replaced by an indexed one). Its edits are kept."""
    marker_path(type_id).unlink(missing_ok=True)
    _meta.pop(type_id, None)


# ------------------------------------------------------------------------------------------------ DuckDB


def _cur() -> Any:
    """This thread's cursor on one shared in-memory DuckDB (one buffer pool, one memory limit for all threads)."""
    global _db
    c = getattr(_tl, "cur", None)
    if c is not None:
        return c
    with _db_lock:
        if _db is None:
            import duckdb

            _db = duckdb.connect()
            _db.execute(f"SET threads = {max(1, int(os.environ.get('BLUESANDAI_LIVE_THREADS') or 4))}")
            _db.execute(f"SET memory_limit = '{os.environ.get('BLUESANDAI_LIVE_MEMORY') or '2GB'}'")
            _db.execute("SET preserve_insertion_order = false")
        c = _db.cursor()
    _tl.cur = c
    return c


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _lit(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _source(m: dict) -> str:
    path = Path(m["path"])
    glob = f"{path.as_posix()}/**/*.parquet" if path.is_dir() else path.as_posix()
    return f"read_parquet({_lit(glob)})"


def _signature(m: dict) -> tuple:
    p = Path(m["path"])
    try:
        s = p.stat()
        return (s.st_mtime_ns, s.st_size)
    except OSError:
        return (0, 0)


def _json(v: Any) -> Any:
    """A DuckDB value as the object store keeps values (JSON)."""
    if isinstance(v, _dt.datetime):
        return v.isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (list, tuple)):
        return [_json(x) for x in v]
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, bytes):
        return None
    return v


def _pk_param(m: dict, key: Any) -> Any:
    if m["pk_sql_type"] in ("BIGINT", "INTEGER", "HUGEINT", "SMALLINT", "TINYINT", "UBIGINT", "UINTEGER"):
        try:
            return int(str(key))
        except ValueError:
            return None
    return str(key)


def _columns_sql(m: dict) -> str:
    return ", ".join(f"{_q(c)} AS {_q(a)}" for c, a in m["columns"].items())


# ------------------------------------------------------------------------------------------------ edits


def _edits_con(type_id: str) -> sqlite3.Connection:
    con = sqlite3.connect(edits_path(type_id), timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS edits (pk TEXT PRIMARY KEY, props TEXT NOT NULL, updated_at TEXT NOT NULL)")
    return con


def edits(type_id: str, keys: Optional[Iterable[str]] = None) -> dict[str, tuple[dict, str]]:
    """{primary key: (edited values, when)} of every edited object (or of these keys)."""
    if not edits_path(type_id).exists():
        return {}
    con = _edits_con(type_id)
    try:
        if keys is None:
            rows = con.execute("SELECT pk, props, updated_at FROM edits").fetchall()
        else:
            ks = [str(k) for k in keys]
            rows = []
            for i in range(0, len(ks), 500):
                part = ks[i:i + 500]
                rows += con.execute(f"SELECT pk, props, updated_at FROM edits WHERE pk IN ({','.join('?' * len(part))})", part).fetchall()
    finally:
        con.close()
    return {pk: (json.loads(props), at) for pk, props, at in rows}


def _edit_props(type_id: str) -> set[str]:
    return {k for props, _ in edits(type_id).values() for k in props}


# ------------------------------------------------------------------------------------------------ reads


def count(type_id: str) -> int:
    m = meta(type_id)
    if not m:
        return 0
    sig = _signature(m)
    hit = _counts.get(type_id)
    if hit and hit[0] == sig:
        return hit[1]
    n = int(_cur().execute(f"SELECT count(*) FROM {_source(m)}").fetchone()[0])
    _counts[type_id] = (sig, n)
    return n


def stat(type_id: str) -> Optional[dict]:
    m = meta(type_id)
    if not m:
        return None
    mt, size = _signature(m)
    try:
        em = edits_path(type_id).stat().st_mtime_ns
    except OSError:
        em = 0
    return {"format": "live", "mtime_ns": max(mt, em), "size": size}


def _objects_of(m: dict, rows: list[tuple], names: list[str], ed: dict[str, tuple[dict, str]]) -> dict[str, dict]:
    out = {}
    pk_api = m["pk_property"]
    for r in rows:
        props = {n: _json(v) for n, v in zip(names, r)}
        pk = str(props.get(pk_api))
        e = ed.get(pk)
        if e:
            props.update(e[0])
        out[pk] = {"properties": props, "created_at": None, "updated_at": e[1] if e else None}
    return out


def base_rows(type_id: str, keys: Iterable[Any]) -> dict[str, dict]:
    """The dataset's values of these objects (no edits laid over)."""
    m = meta(type_id)
    if not m:
        return {}
    ks = [k for k in {_pk_param(m, k) for k in keys} if k is not None]
    if not ks:
        return {}
    cur = _cur()
    names = list(m["columns"].values())
    rows: list[tuple] = []
    for i in range(0, len(ks), 1000):
        part = ks[i:i + 1000]
        rows += cur.execute(f"SELECT {_columns_sql(m)} FROM {_source(m)} WHERE {_q(m['pk_column'])} IN ({','.join('?' * len(part))})", part).fetchall()
    return {pk: o["properties"] for pk, o in _objects_of(m, rows, names, {}).items()}


def get_many(type_id: str, keys: Iterable[Any]) -> dict[str, dict]:
    """The objects with these primary keys (edits laid over); keys the dataset does not hold are left out."""
    m = meta(type_id)
    if not m:
        return {}
    want = {str(k) for k in keys}
    base = base_rows(type_id, want)
    ed = edits(type_id, list(base))
    return {pk: {"properties": {**props, **(ed[pk][0] if pk in ed else {})}, "created_at": None, "updated_at": ed[pk][1] if pk in ed else None}
            for pk, props in base.items()}


def existing(type_id: str, keys: Iterable[Any]) -> set[str]:
    m = meta(type_id)
    if not m:
        return set()
    ks = [k for k in {_pk_param(m, k) for k in keys} if k is not None]
    out: set[str] = set()
    cur = _cur()
    for i in range(0, len(ks), 1000):
        part = ks[i:i + 1000]
        out |= {str(r[0]) for r in cur.execute(f"SELECT {_q(m['pk_column'])} FROM {_source(m)} WHERE {_q(m['pk_column'])} IN ({','.join('?' * len(part))})",
                                             part).fetchall()}
    return out


def load_all(type_id: str) -> dict[str, dict]:
    """Every object (only a type of at most SMALL objects)."""
    m = meta(type_id)
    if not m:
        return {}
    n = count(type_id)
    if n > SMALL:
        raise TooLarge(m.get("display_name") or type_id, n)
    names = list(m["columns"].values())
    rows = _cur().execute(f"SELECT {_columns_sql(m)} FROM {_source(m)}").fetchall()
    return _objects_of(m, rows, names, edits(type_id))


class LiveObjects(MutableMapping):
    """A live type's objects as ontology_store.load() hands them out: {primary key: object}, read on demand. Objects
    looked up or written here stay in this mapping until save() writes the changed ones' edits."""

    def __init__(self, type_id: str):
        self.type_id = type_id
        self.local: dict[str, dict] = {}
        self._all: Optional[dict[str, dict]] = None

    def _whole(self) -> dict[str, dict]:
        if self._all is None:
            self._all = load_all(self.type_id)
            self._all.update(self.local)
        return self._all

    def prefetch(self, keys: Iterable[Any]) -> None:
        need = [str(k) for k in keys if str(k) not in self.local]
        if need:
            self.local.update(get_many(self.type_id, need))

    def __getitem__(self, key: Any) -> dict:
        k = str(key)
        if k in self.local:
            return self.local[k]
        if self._all is not None:
            return self._all[k]
        got = get_many(self.type_id, [k])
        if k not in got:
            raise KeyError(k)
        self.local[k] = got[k]
        return got[k]

    def __contains__(self, key: object) -> bool:
        try:
            self[key]
            return True
        except KeyError:
            return False

    def __setitem__(self, key: Any, value: dict) -> None:
        k = str(key)
        if k not in self:
            m = meta(self.type_id) or {}
            raise HTTPException(409, f'{m.get("display_name") or self.type_id} is a live object type: its objects are its dataset\'s rows, '
                                     f'"{k}" cannot be created here (add the row to the dataset)')
        self.local[k] = value
        if self._all is not None:
            self._all[k] = value

    def __delitem__(self, key: Any) -> None:
        m = meta(self.type_id) or {}
        raise HTTPException(409, f'{m.get("display_name") or self.type_id} is a live object type: its objects are its dataset\'s rows, '
                                 f'"{key}" cannot be deleted here (remove the row from the dataset)')

    def __len__(self) -> int:
        return count(self.type_id)

    def __iter__(self) -> Iterator[str]:
        return iter(self._whole())

    def items(self):  # one query, not one per key
        return self._whole().items()

    def values(self):
        return self._whole().values()

    def keys(self):
        return self._whole().keys()

    def copy(self) -> dict:
        return dict(self._whole())


def load(type_id: str) -> LiveObjects:
    return LiveObjects(type_id)


def save(type_id: str, objs: Any, changed: Optional[Iterable[Any]] = None) -> dict:
    """Write the edits of the changed objects: per object, the values that differ from the dataset's (an object whose
    values equal the dataset's again has no edit left)."""
    m = meta(type_id)
    if not m:
        return {"format": "live", "written": 0}
    local = objs.local if isinstance(objs, LiveObjects) else dict(objs)
    keys = [str(k) for k in (changed if changed is not None else local)]
    keys = [k for k in keys if k in local]
    if not keys:
        return {"format": "live", "written": 0}
    base = base_rows(type_id, keys)
    import ontology

    now = ontology._now()
    con = _edits_con(type_id)
    written = 0
    try:
        with con:
            for k in keys:
                if k not in base:
                    raise HTTPException(409, f'"{k}" is not a row of the live type\'s dataset')
                props = local[k].get("properties") or {}
                diff = {p: v for p, v in props.items() if base[k].get(p) != v and p != m["pk_property"]}
                if diff:
                    con.execute("INSERT OR REPLACE INTO edits (pk, props, updated_at) VALUES (?, ?, ?)", (k, json.dumps(diff, ensure_ascii=False, default=str), now))
                else:
                    con.execute("DELETE FROM edits WHERE pk = ?", (k,))
                written += 1
    finally:
        con.close()
    return {"format": "live", "written": written}


# ------------------------------------------------------------------------------------------------ backing a type


def _ptype_of(sql_type: str) -> tuple[Optional[str], bool]:
    """(property type, array) for a DuckDB column type; None: the column cannot back a property."""
    s = sql_type.upper()
    arr = s.endswith("[]")
    s = s[:-2] if arr else s
    if s in ("VARCHAR", "UUID") or s.startswith("ENUM"):
        return "string", arr
    if s in ("BIGINT", "HUGEINT", "UBIGINT", "INTEGER", "UINTEGER", "SMALLINT", "USMALLINT", "TINYINT", "UTINYINT"):
        return ("long" if s in ("BIGINT", "HUGEINT", "UBIGINT", "UINTEGER") else "integer"), arr
    if s in ("DOUBLE", "FLOAT", "REAL") or s.startswith("DECIMAL"):
        return "double", arr
    if s == "BOOLEAN":
        return "boolean", arr
    if s == "DATE":
        return "date", arr
    if s.startswith("TIMESTAMP"):
        return "timestamp", arr
    return None, arr


def back(type_id: str, dataset_id: str, columns: Optional[dict[str, str]], map_unmapped: bool) -> dict:
    """Back an object type by a local Parquet dataset as a live type: properties for the mapped columns (and, with
    map_unmapped, every other supported column), checks on the primary key (present, unique) and on the type (no
    security policy, mandatory control, additional datasource), then the marker. Nothing is imported."""
    import drive
    import ontology

    item = drive._item(dataset_id)
    if (item.get("stored_in") or "local") != "local":
        raise HTTPException(400, "a live object type reads a local dataset (Files, stored locally); this one is not")
    path = drive.LOCAL_DIR / item["id"]
    if not path.exists():
        raise HTTPException(400, f'"{item["name"]}" has no local file to read')
    m0 = {"path": str(path)}
    cur = _cur()
    try:
        desc = cur.execute(f"DESCRIBE SELECT * FROM {_source(m0)}").fetchall()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    col_types = {r[0]: r[1] for r in desc}
    with ontology._lock:
        t = ontology._object_type(type_id)
        if t.get("security"):
            raise HTTPException(400, f"{t['display_name']} has an object or property security policy: not supported on a live type yet")
        if t.get("additional_datasources"):
            raise HTTPException(400, f"{t['display_name']} has additional datasources: not supported on a live type")
        if any(p.get("mandatory_control") for p in t["properties"]):
            raise HTTPException(400, f"{t['display_name']} has a mandatory control property: not supported on a live type yet")
        if ontology_store_count(type_id):
            raise HTTPException(409, f"{t['display_name']} holds indexed objects: back an empty object type (or remove its datasource first)")
        props = {p["api_name"]: p for p in t["properties"]}
        if columns is not None:
            mapping = {c: a for c, a in columns.items() if a}
        else:
            mapping = {c: c for c in col_types if c in props}
        if map_unmapped:
            for c, ty in col_types.items():
                if c in mapping:
                    continue
                pt, arr = _ptype_of(ty)
                if not pt:
                    continue
                api = re.sub(r"[^A-Za-z0-9_]", "_", c)
                if not re.match(r"[A-Za-z]", api):
                    api = "p_" + api
                while api in props:
                    api += "_"
                new = {"api_name": api, "display_name": c.replace("_", " ").capitalize(), "type": pt, "description": "", **({"array": True} if arr else {})}
                ontology._check_property(new)
                t["properties"].append(new)
                props[api] = new
                mapping[c] = api
        for c, a in mapping.items():
            if c not in col_types:
                raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {c}")
            if a not in props:
                raise HTTPException(400, f"the object type has no property {a} (column {c})")
        pk_col = next((c for c, a in mapping.items() if a == t["primary_key"]), None)
        if not pk_col:
            raise HTTPException(400, f"PrimaryKeyNotMapped: no column backs the primary key {t['primary_key']}")
        n, distinct, nulls = cur.execute(f"SELECT count(*), count(DISTINCT {_q(pk_col)}), count(*) FILTER (WHERE {_q(pk_col)} IS NULL OR CAST({_q(pk_col)} AS VARCHAR) = '') "
                                         f"FROM {_source(m0)}").fetchone()
        if nulls:
            raise HTTPException(400, f"PrimaryKeyNotMapped: {nulls:,} rows have no primary key ({pk_col})")
        if distinct != n:
            raise HTTPException(400, f"DuplicatePrimaryKey: {n - distinct:,} rows repeat a primary key ({pk_col})")
        marker = {"type_id": type_id, "display_name": t["display_name"], "dataset_id": item["id"], "dataset_name": item["name"], "path": str(path),
                  "pk_column": pk_col, "pk_property": t["primary_key"], "pk_sql_type": col_types[pk_col].upper(), "title_property": t["title_property"],
                  "columns": mapping, "column_types": {c: col_types[c] for c in mapping}, "rows": int(n), "set_at": ontology._now()}
        t["backing_dataset"] = {"dataset_id": item["id"], "name": item["name"], "columns": mapping, "synced_at": ontology._now(), "storage": "live",
                                "auto_reindex": False, "rows": int(n)}
        _write_marker(type_id, marker)
        ontology._put("object-types", t)
    _counts.pop(type_id, None)
    return {"object_type_id": type_id, "storage": "live", "rows": int(n), "columns": mapping, "properties": len(t["properties"])}


def ontology_store_count(type_id: str) -> int:
    """Objects indexed in the JSON store (not the live dataset's)."""
    import ontology_store

    if is_live(type_id):
        return 0
    return ontology_store.count(type_id)


def describe(type_id: str) -> dict:
    """The live datasource as GET …/datasource shows one."""
    import ontology

    m = meta(type_id) or {}
    t = ontology._object_type(type_id)
    cur = _cur()
    try:
        desc = cur.execute(f"DESCRIBE SELECT * FROM {_source(m)}").fetchall()
        errs = []
    except Exception as e:  # noqa: BLE001
        desc, errs = [], [{"code": "DatasetNotFound", "column": None, "message": str(e)}]
    mapping = m.get("columns") or {}
    cols = [{"name": r[0], "type": r[1], "property": mapping.get(r[0]), "supported": _ptype_of(r[1])[0] is not None} for r in desc]
    for c, a in mapping.items():
        if desc and c not in {r[0] for r in desc}:
            errs.append({"code": "FoundryColumnNameNotFound", "column": c, "message": f"the dataset has no column {c} (property {a})"})
    return {"backing": t.get("backing_dataset"), "storage": "live", "rows": count(type_id) if not errs else None, "columns": cols, "errors": errs,
            "unmapped_columns": [c["name"] for c in cols if not c["property"] and c["supported"]],
            "unmapped_properties": [p["api_name"] for p in t["properties"] if p["api_name"] not in mapping.values() and not p.get("derived")],
            "stale": False, "edited_objects": len(edits(type_id))}


# ------------------------------------------------------------------------------------------------ links


def linked_map_fk(lt: dict, direction: str, pks: Optional[set[str]] = None) -> dict[str, list[str]]:
    """om.linked_map for a foreign-key link type with a live side: from each starting pk to the linked pks."""
    import ontology

    src_id, tgt_id, fk = lt["source"]["object_type_id"], lt["target"]["object_type_id"], lt["foreign_key"]
    out: dict[str, list[str]] = {}
    if is_live(src_id):
        m = meta(src_id)
        fk_col = next((c for c, a in m["columns"].items() if a == fk), None)
        if not fk_col:
            return out
        pkc = m["pk_column"]
        if pks is None and count(src_id) > SMALL:
            raise TooLarge(m.get("display_name") or src_id, count(src_id))
        cur = _cur()
        # forward: source pk → its foreign key; reverse: target pk → the sources that carry it
        a_col, b_col = (pkc, fk_col) if direction == "forward" else (fk_col, pkc)
        rows: list[tuple] = []
        if pks is None:
            rows = cur.execute(f"SELECT CAST({_q(a_col)} AS VARCHAR), CAST({_q(b_col)} AS VARCHAR) FROM {_source(m)} WHERE {_q(fk_col)} IS NOT NULL").fetchall()
        else:
            ks = sorted(pks)
            for i in range(0, len(ks), 1000):
                part = ks[i:i + 1000]
                where = f"CAST({_q(a_col)} AS VARCHAR) IN ({','.join('?' * len(part))})"
                rows += cur.execute(f"SELECT CAST({_q(a_col)} AS VARCHAR), CAST({_q(b_col)} AS VARCHAR) FROM {_source(m)} WHERE {where} AND {_q(fk_col)} IS NOT NULL",
                                    part).fetchall()
        reach_ok: Optional[set] = None
        if direction == "forward":
            bs = {b for _, b in rows}
            reach_ok = existing(tgt_id, bs) if is_live(tgt_id) else {b for b in bs if b in ontology.stored_objects(tgt_id)}
        for a, b in rows:
            if b not in (None, "") and (reach_ok is None or b in reach_ok):
                out.setdefault(a, []).append(b)
        return out
    # the target is live, the source indexed (at most the store's size): the source's foreign keys, checked in one query
    src = ontology.stored_objects(src_id)
    pairs = [(pk, str(v)) for pk, o in src.items() if (v := (o.get("properties") or {}).get(fk)) not in (None, "")]
    ok = existing(tgt_id, {b for _, b in pairs})
    for s, t in pairs:
        if t not in ok:
            continue
        a, b = (s, t) if direction == "forward" else (t, s)
        if pks is None or a in pks:
            out.setdefault(a, []).append(b)
    return out


def participation(lt: dict) -> dict:
    """lineage.participation for a foreign-key link type with a live side: linked objects per side, counted by queries
    (a scan of every row, ~2 s on the 5.4M claims), kept until the link type, a type or either side's data changes."""
    import ontology

    src_id, tgt_id, fk = lt["source"]["object_type_id"], lt["target"]["object_type_id"], lt["foreign_key"]
    key = json.dumps([lt["id"], lt.get("updated_at"), fk] + [[tid, ontology._object_type(tid).get("updated_at"),
                                                               _signature(meta(tid)) if is_live(tid) else ontology.objects_stat(tid)] for tid in (src_id, tgt_id)], default=str)
    with _hists_lock:
        hit = _participations.get(lt["id"])
    if hit and hit[0] == key:
        return hit[1]
    out = _participation(lt, src_id, tgt_id, fk)
    with _hists_lock:
        _participations[lt["id"]] = (key, out)
    return out


def _participation(lt: dict, src_id: str, tgt_id: str, fk: str) -> dict:
    import ontology

    required = any(p.get("api_name") == fk and p.get("required") for p in ontology._object_type(src_id).get("properties") or [])
    if is_live(src_id):
        m = meta(src_id)
        fk_col = next((c for c, a in m["columns"].items() if a == fk), None)
        n_src = count(src_id)
        if fk_col:
            k_src, k_tgt = _cur().execute(f"SELECT count(*) FILTER (WHERE {_q(fk_col)} IS NOT NULL), count(DISTINCT {_q(fk_col)}) FROM {_source(m)}").fetchone()
        else:
            k_src = k_tgt = 0
        n_tgt = count(tgt_id) if is_live(tgt_id) else len(ontology.stored_objects(tgt_id))
    else:
        src = ontology.stored_objects(src_id)
        keys = {str(v) for o in src.values() if (v := (o.get("properties") or {}).get(fk)) not in (None, "")}
        ok = existing(tgt_id, keys)
        n_src, n_tgt = len(src), count(tgt_id)
        k_src = sum(1 for o in src.values() if str((o.get("properties") or {}).get(fk)) in ok)
        k_tgt = len(ok)

    def side(k: int, n: int, schema: bool) -> dict:
        return {"linked": int(k), "objects": int(n), "total": schema or (n > 0 and k == n), "required": schema, "pct": round(100 * k / n, 1) if n else None}

    return {"source": side(k_src, n_src, required), "target": side(k_tgt, n_tgt, False), "links": int(k_src), "live": True}


# ------------------------------------------------------------------------------------------------ searches


class _Rel:
    """A set of a live type's objects as SQL: the type's columns (as property names, edits laid over) filtered by
    `where` (with params)."""

    def __init__(self, t: dict):
        self.t = t
        self.m = meta(t["id"])
        if not self.m:
            raise HTTPException(400, f"{t['display_name']} is not a live object type")
        if t.get("security") or t.get("additional_datasources") or any(p.get("mandatory_control") for p in t["properties"]):
            raise HTTPException(400, f"{t['display_name']}: object security, mandatory controls and additional datasources are not supported on a live type")
        self.props = {p["api_name"]: p for p in t["properties"]}
        self._tables: list[str] = []
        self.where: list[str] = []
        self.params: list[Any] = []
        self._edited = edits(t["id"])
        self._view = self._make_view()

    def _make_view(self) -> str:
        m = self.m
        base = f"SELECT {_columns_sql(m)} FROM {_source(m)}"
        backed = set(m["columns"].values())
        ed_props = sorted({k for props, _ in self._edited.values() for k in props if k in self.props})
        edit_only = [p for p in self.props if p not in backed and not self.props[p].get("derived") and self.props[p]["type"] in SQL_TYPE]
        if not self._edited and not edit_only:
            return f"({base})"
        import pyarrow as pa

        cols: dict[str, list] = {"__pk": [], **{f"__v_{p}": [] for p in ed_props}, **{f"__h_{p}": [] for p in ed_props}}
        for pk, (props, _) in self._edited.items():
            cols["__pk"].append(pk)
            for p in ed_props:
                has = p in props
                v = props.get(p)
                cols[f"__h_{p}"].append(has)
                cols[f"__v_{p}"].append(None if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else str(v)))
        tbl = pa.table({k: pa.array(v, pa.bool_() if k.startswith("__h_") else pa.string()) for k, v in cols.items()})
        name = f"live_edits_{abs(hash((self.t['id'], id(self)))) % 10**12}"
        _cur().register(name, tbl)
        self._tables.append(name)
        sql_types = {a: self.m["column_types"].get(c, "VARCHAR") for c, a in m["columns"].items()}
        repl, extra = [], []
        for p in ed_props:
            ty = sql_types.get(p) or SQL_TYPE.get(self.props[p]["type"], "VARCHAR")
            v = f"TRY_CAST(e.{_q('__v_' + p)} AS {ty})"
            if p in backed:
                repl.append(f"CASE WHEN coalesce(e.{_q('__h_' + p)}, false) THEN {v} ELSE b.{_q(p)} END AS {_q(p)}")
            else:
                extra.append(f"{v} AS {_q(p)}")
        for p in edit_only:
            if p not in ed_props:
                extra.append(f"CAST(NULL AS {SQL_TYPE[self.props[p]['type']]}) AS {_q(p)}")
        star = f"b.* REPLACE ({', '.join(repl)})" if repl else "b.*"
        pk = _q(m["pk_property"])
        return (f"(SELECT {', '.join([star] + extra)} FROM ({base}) b LEFT JOIN {name} e ON CAST(b.{pk} AS VARCHAR) = e.\"__pk\")")

    def close(self) -> None:
        for name in self._tables:
            try:
                _cur().unregister(name)
            except Exception:  # noqa: BLE001 - already gone with the cursor
                pass
        self._tables = []

    # the set
    def sql(self, select: str = "*", tail: str = "") -> str:
        where = (" WHERE " + " AND ".join(f"({w})" for w in self.where)) if self.where else ""
        return f"SELECT {select} FROM {self._view} r{where} {tail}"

    def run(self, select: str = "*", tail: str = "", params: Optional[list] = None) -> list[tuple]:
        return _cur().execute(self.sql(select, tail), self.params + list(params or [])).fetchall()

    def count(self) -> int:
        return int(self.run("count(*)")[0][0])

    # compiling
    def col(self, prop: str) -> str:
        if prop == "__title":
            return f"r.{_q(self.m['title_property'])}"
        if prop not in self.props:
            raise HTTPException(400, f"{self.t['display_name']} has no property {prop}")
        return f"r.{_q(prop)}"

    def kind(self, prop: str) -> str:
        if prop == "__title":
            return "string"
        p = self.props[prop]
        if p.get("array"):
            return "array"
        return "number" if p["type"] in NUMERIC else p["type"]

    def add_filters(self, filters: list[Any]) -> None:
        for f in filters:
            sql, ps = self.filter_sql(f)
            self.where.append(sql)
            self.params += ps

    def filter_sql(self, f: Any, depth: int = 1) -> tuple[str, list]:
        op, prop, value = f.op, f.property, f.value
        if op in ("and", "or", "not"):
            if depth > 32:
                raise HTTPException(400, "a filter tree nests at most 32 levels")
            raw = value if isinstance(value, list) else [value]
            kids = [x if hasattr(x, "op") else type(f)(**x) for x in raw]
            parts = [self.filter_sql(k, depth + 1) for k in kids]
            if not parts:
                return ("true" if op != "or" else "false"), []
            joined = (" AND " if op in ("and", "not") else " OR ").join(f"({s})" for s, _ in parts)
            ps = [p for _, ps in parts for p in ps]
            return (f"NOT ({joined})" if op == "not" else joined), ps
        if prop == "__link":
            raise HTTPException(400, "a linked-object filter is not supported on a live object type yet: use a Search Around")
        if op in ("any_word", "phrase", "within", "geo", "interval", "linked"):
            raise HTTPException(400, f'the "{op}" filter is not supported on a live object type yet')
        c, k = self.col(prop), self.kind(prop)
        text = f"CAST({c} AS VARCHAR)"
        if op == "is_null":
            return (f"{c} IS NULL" + (f" OR {text} = ''" if k == "string" else "") + (f" OR len({c}) = 0" if k == "array" else "")), []
        if op == "not_null":
            return (f"{c} IS NOT NULL" + (f" AND {text} <> ''" if k == "string" else "") + (f" AND len({c}) > 0" if k == "array" else "")), []
        if k == "array":
            raise HTTPException(400, f"filters on the array property {prop} are not supported on a live object type yet (only is / is not empty)")
        if op == "eq":
            return self._eq(c, k, value)
        if op == "neq":
            s, ps = self._eq(c, k, value)
            return f"{c} IS NULL OR NOT ({s})", ps
        if op == "in":
            vals = value if isinstance(value, list) else [value]
            if not vals:
                return "false", []
            parts = [self._eq(c, k, v) for v in vals]
            return " OR ".join(f"({s})" for s, _ in parts), [p for _, ps in parts for p in ps]
        if op == "contains":
            return f"strpos(lower(coalesce({text}, '')), lower(?)) > 0", [str(value or "")]
        if op == "starts_with":
            return f"starts_with(lower(coalesce({text}, '')), lower(?))", [str(value or "")]
        if op == "regex":
            return f"regexp_full_match(coalesce({text}, ''), ?)", [str(value or "")]
        if op == "wildcard":
            pat = "".join("%" if ch == "*" else "_" if ch == "?" else ("\\" + ch if ch in "%_\\" else ch) for ch in str(value or ""))
            return f"lower(coalesce({text}, '')) LIKE lower(?) ESCAPE '\\'", [pat]
        if op == "between":
            lo, hi = (value[0] if len(value) > 0 else None, value[1] if len(value) > 1 else None) if isinstance(value, list) else (None, None)
            parts, ps = [f"{c} IS NOT NULL"], []
            for bound, sign in ((lo, ">="), (hi, "<=")):
                if bound not in (None, ""):
                    s, p = self._cmp(c, k, sign, bound)
                    parts.append(s)
                    ps += p
            return " AND ".join(parts), ps
        if op in ("gt", "gte", "lt", "lte"):
            return self._cmp(c, k, {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op], value)
        raise HTTPException(400, f'the "{op}" filter is not supported on a live object type')

    @staticmethod
    def _num(v: Any) -> Optional[float]:
        if isinstance(v, bool):
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def _eq(self, c: str, k: str, v: Any) -> tuple[str, list]:
        n = self._num(v)
        if k == "number" and n is not None:
            return f"CAST({c} AS DOUBLE) = ?", [n]
        if k == "boolean":
            b = v if isinstance(v, bool) else str(v).strip().lower() in ("true", "1", "ya", "yes")
            return f"{c} = ?", [b]
        return f"lower(CAST({c} AS VARCHAR)) = lower(?)", [str(v)]

    def _cmp(self, c: str, k: str, sign: str, v: Any) -> tuple[str, list]:
        n = self._num(v)
        if k == "number" and n is not None:
            return f"CAST({c} AS DOUBLE) {sign} ?", [n]
        return f"CAST({c} AS VARCHAR) {sign} ?", [str(v)]

    def add_keyword(self, q: str, searchable: list[str]) -> None:
        words = [w for w in re.findall(r"[\w.\-:/*]+", q.lower()) if w not in ("and", "or") and w.strip("*")]
        if not words:
            return
        cols = [self.col(p) for p in searchable if p in self.props and self.kind(p) in ("string", "number")] + [f"r.{_q(self.m['pk_property'])}"]
        hay = "lower(concat_ws(' ', " + ", ".join(f"CAST({c} AS VARCHAR)" for c in cols) + "))"
        for w in words:
            # a whole word or code ("F-4-10-I" is not "F-4-10-II"); a trailing or inner * stands for more letters
            body = re.escape(w.strip("*")).replace(r"\*", "[0-9a-z]*")
            tail = "[0-9a-z]*" if w.endswith("*") else ""
            self.where.append(f"regexp_matches({hay}, ?)")
            self.params.append(f"(^|[^0-9a-z]){body}{tail}([^0-9a-z]|$)")

    def public(self, rows: list[tuple], names: list[str]) -> list[dict]:
        out = []
        pk_api, title = self.m["pk_property"], self.m["title_property"]
        for r in rows:
            props = {n: _json(v) for n, v in zip(names, r)}
            pk = str(props.get(pk_api))
            out.append({"object_type_id": self.t["id"], "primary_key": pk,
                        "title": str(props.get(title)) if props.get(title) not in (None, "") else pk, "properties": props,
                        "created_at": None, "updated_at": (self._edited.get(pk) or (None, None))[1]})
        return out

    def names(self) -> list[str]:
        cur = _cur()
        return [d[0] for d in cur.execute(self.sql("*", "LIMIT 0"), self.params).description]

    def page(self, sort: Optional[str], order: str, offset: int, limit: int) -> list[dict]:
        tail = ""
        pk = f"r.{_q(self.m['pk_property'])}"
        if sort:
            tail = f"ORDER BY {self.col(sort)} {'DESC' if order == 'desc' else 'ASC'} NULLS LAST, {pk}"
        else:
            tail = f"ORDER BY {pk}"
        tail += f" LIMIT {int(limit)} OFFSET {int(offset)}"
        names = self.names()
        return self.public(self.run("*", tail), names)

    def aggregate(self, a: Any) -> dict:
        by = self.props
        if a.metric != "count" and a.property not in by:
            raise HTTPException(400, "pick the property to aggregate")
        if a.metric in ("sum", "avg") and by[a.property]["type"] not in NUMERIC:
            raise HTTPException(400, f"{a.metric} needs a numeric property")
        if a.group_by and a.group_by not in by:
            raise HTTPException(400, f"{self.t['display_name']} has no property {a.group_by}")
        g = f"coalesce(nullif(CAST({self.col(a.group_by)} AS VARCHAR), ''), '—')" if a.group_by else "'all'"
        if a.metric == "count":
            val = "count(*)"
        else:
            c = self.col(a.property)
            val = {"sum": f"sum(CAST({c} AS DOUBLE))", "avg": f"avg(CAST({c} AS DOUBLE))", "min": f"min({c})", "max": f"max({c})"}[a.metric]
        rows = self.run(f"{g} AS g, {val} AS v, count(*) AS n", "GROUP BY 1")
        out = [{"group": str(gk), "value": _json(v), "count": int(n)} for gk, v, n in rows]
        out.sort(key=lambda x: -(x["value"] if isinstance(x["value"], (int, float)) and not isinstance(x["value"], bool) else x["count"]))
        return {"metric": a.metric, "property": a.property, "group_by": a.group_by, "groups": out[:100]}

    def histograms(self, every: bool, aggregatable: Any) -> list[dict]:
        """ontology_explorer._histograms of the set in two scans: first each chart's range, nulls and distinct count,
        then every chart's buckets (DuckDB histogram()); a high-cardinality chart of all_charts takes its top values."""
        props = []
        for p in self.t["properties"]:
            if every:
                if p.get("visibility") == "hidden" or p["type"] in ("vector", "media", "attachment", "timeseries", "geoshape", "cipher", "struct"):
                    continue
            elif not aggregatable(p) or p["api_name"] == self.t["primary_key"] or p.get("type") == "timeseries":
                continue
            if p.get("array") or p["api_name"] not in self.names_set():
                continue
            props.append(p)
        if not props:
            return []
        first, keys = [], {}
        for i, p in enumerate(props):
            c = self.col(p["api_name"])
            if p["type"] in NUMERIC:
                first += [f"min(CAST({c} AS DOUBLE))", f"max(CAST({c} AS DOUBLE))", f"count(*) FILTER (WHERE {c} IS NULL)"]
            else:
                date = p["type"] in ("date", "timestamp")
                keys[i] = f"coalesce(nullif(substr(CAST({c} AS VARCHAR), 1, 7), ''), '—')" if date else f"coalesce(nullif(CAST({c} AS VARCHAR), ''), '—')"
                first.append(f"approx_count_distinct({keys[i]})")
        row = list(self.run(", ".join(first))[0])
        plan, at = [], 0
        for i, p in enumerate(props):
            if p["type"] in NUMERIC:
                lo, hi, nulls = row[at:at + 3]
                at += 3
                if lo is None:
                    continue
                n = 8 if hi > lo else 1
                width = (hi - lo) / n if hi > lo else 1
                expr = f"least({n - 1}, CAST(floor((CAST({self.col(p['api_name'])} AS DOUBLE) - {float(lo)!r}) / {float(width)!r}) AS BIGINT))"
                plan.append((p, "numeric", expr, {"lo": lo, "hi": hi, "n": n, "width": width, "nulls": nulls}))
            else:
                approx = int(row[at] or 0)
                at += 1
                if not approx or (not every and approx > 50 and p["type"] == "string" and not p.get("render_hints")):
                    continue
                plan.append((p, "month" if p["type"] in ("date", "timestamp") else "values", keys[i], {"approx": approx}))
            if not every and len(plan) >= 12:
                break
        small = [x for x in plan if x[1] == "numeric" or x[3].get("approx", 0) <= 5000]
        maps = dict(zip([id(x) for x in small], self.run(", ".join(f"histogram({x[2]})" for x in small))[0])) if small else {}
        out = []
        for x in plan:
            p, kind, expr, info = x
            if kind == "numeric":
                counts = {int(k): int(v) for k, v in (maps.get(id(x)) or {}).items() if k is not None}
                lo, width = info["lo"], info["width"]
                out.append({"property": p["api_name"], "display_name": p["display_name"], "kind": "numeric", "min": lo, "max": info["hi"],
                            "buckets": [{"from": lo + i * width, "to": lo + (i + 1) * width, "count": counts.get(i, 0)} for i in range(info["n"])],
                            "nulls": int(info["nulls"])})
                continue
            if id(x) in maps:
                counts = {str(k): int(v) for k, v in (maps[id(x)] or {}).items()}
                distinct = len(counts)
                items = sorted(counts.items()) if kind == "month" else sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
            else:  # many distinct values (all charts): the top twelve only
                rows = self.run(f"{expr} AS k, count(*) AS n", "GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12")
                distinct, items = info["approx"], [(str(k), int(v)) for k, v in rows]
            out.append({"property": p["api_name"], "display_name": p["display_name"], "kind": kind,
                        "buckets": [{"value": k, "count": v} for k, v in items], "distinct": distinct})
        return out if every else out[:12]

    def names_set(self) -> set:
        if not hasattr(self, "_names"):
            self._names = set(self.names())
        return self._names

    def pks(self, limit: Optional[int] = None) -> list[str]:
        pk = f"r.{_q(self.m['pk_property'])}"
        tail = f"ORDER BY {pk}" + (f" LIMIT {int(limit)}" if limit else "")
        return [str(r[0]) for r in self.run(f"CAST({pk} AS VARCHAR)", tail)]

    def fk_values(self, prop: str) -> list[str]:
        return [str(r[0]) for r in self.run(f"DISTINCT CAST({self.col(prop)} AS VARCHAR)") if r[0] not in (None, "")]

    def restrict_to(self, prop: str, keys: list[str]) -> None:
        """Keep the objects whose property (as text) is one of keys (a Search Around's reach from indexed objects)."""
        import pyarrow as pa

        name = f"live_keys_{abs(hash((self.t['id'], id(self), len(self.where)))) % 10**12}"
        _cur().register(name, pa.table({"k": pa.array(sorted(set(keys)), pa.string())}))
        self._tables.append(name)
        self.where.append(f"CAST({self.col(prop)} AS VARCHAR) IN (SELECT k FROM {name})")

    def restrict_to_set(self, prop: str, other: "_Rel", other_prop: str) -> None:
        """Keep the objects whose property is one of another live set's values of other_prop (a Search Around from a
        live set to a live type: one statement, no keys loaded)."""
        self.where.append(f"CAST({self.col(prop)} AS VARCHAR) IN ({other.sql(f'CAST({other.col(other_prop)} AS VARCHAR)')})")
        self.params += other.params


def involves(req: Any) -> bool:
    """Whether a search starts at or reaches a live object type."""
    import ontology_model as om

    if getattr(req, "interface_id", None):
        return False
    if is_live(req.object_type_id):
        return True
    for sa in req.search_around or []:
        try:
            lt = om._get("link-types", sa.link_type_id, "link type")
        except HTTPException:
            continue
        if is_live(lt["source"]["object_type_id"]) or is_live(lt["target"]["object_type_id"]):
            return True
    return False


def run(req: Any) -> dict:
    """An Object Explorer search that starts at or reaches a live type: each step is a live set (SQL) or indexed rows
    (as ontology_explorer computes them); the result carries its total, page, histograms and aggregation."""
    import ontology
    import ontology_explorer as ex
    import ontology_model as om

    if req.semantic:
        raise HTTPException(400, "semantic search is not supported on a live object type yet")
    if req.with_properties:
        raise HTTPException(400, "derived properties are not supported on a live object type yet")
    kinds = ["base"]
    t = ontology._object_type(req.object_type_id)
    type_ids = [t["id"]]
    rel: Optional[_Rel] = None
    rows: Optional[list[dict]] = None
    rels: list[_Rel] = []
    try:
        if is_live(t["id"]):
            auth_check(t["id"])
            rel = _Rel(t)
            rels.append(rel)
            if req.q.strip():
                rel.add_keyword(req.q, ex._searchable(t))
            rel.add_filters(req.filters)
            loaded = count(t["id"])
        else:
            rows = ex._rows(t)
            loaded = len(rows)
            if req.q.strip():
                import ontology_search

                rows = ontology_search.keyword_filter(t, rows, req.q, ex._searchable(t))
            rows = ex._filter_rows(t, rows, req.filters)
        path = []
        for sa in req.search_around:
            lt = ontology._get("link-types", sa.link_type_id, "link type")
            start, reach = om.side_of(lt, sa.direction)
            if start["object_type_id"] != t["id"]:
                raise HTTPException(400, f"{lt['display_name']} does not start from {t['display_name']}")
            nxt = ontology._object_type(reach["object_type_id"])
            live_link = is_live(lt["source"]["object_type_id"]) or is_live(lt["target"]["object_type_id"])
            if live_link and lt["kind"] != "foreign_key":
                raise HTTPException(400, f"{lt['display_name']}: only foreign-key link types reach or leave a live object type")
            fk = lt.get("foreign_key")
            src_is_start = sa.direction == "forward"  # forward: start = the source, which carries the foreign key
            if is_live(nxt["id"]):
                auth_check(nxt["id"])
                nrel = _Rel(nxt)
                rels.append(nrel)
                if src_is_start:
                    # the start (source) carries the keys of the live target
                    if rel is not None:
                        nrel.restrict_to_set(nxt["primary_key"], rel, fk)
                    else:
                        nrel.restrict_to(nxt["primary_key"], [str(v) for r in rows for v in [r["properties"].get(fk)] if v not in (None, "")])
                else:
                    # the live source carries the start's keys
                    if rel is not None:
                        nrel.restrict_to_set(fk, rel, rel.m["pk_property"])
                    else:
                        nrel.restrict_to(fk, [r["primary_key"] for r in rows])
                nrel.add_filters(sa.filters)
                rel, rows = nrel, None
            else:
                if rel is not None:
                    if src_is_start:
                        reached = set(rel.fk_values(fk))
                    else:
                        # an indexed source whose foreign key is in the live set
                        src_objs = ontology._objects(nxt["id"])
                        cand = {str(v) for o in src_objs.values() if (v := (o.get("properties") or {}).get(fk)) not in (None, "")}
                        rel.restrict_to(rel.m["pk_property"], sorted(cand))
                        pks_live = set(rel.pks())
                        reached = {pk for pk, o in src_objs.items() if str((o.get("properties") or {}).get(fk)) in pks_live}
                    objs = ontology._objects(nxt["id"])
                    rows = [ontology._public_object(nxt, pk, objs[pk]) for pk in sorted(reached) if pk in objs and ontology._can_see(nxt, objs[pk])]
                else:
                    reached = sorted({x for v in om.linked_map(lt, sa.direction, {r["primary_key"] for r in rows}).values() for x in v})
                    objs = ontology._objects(nxt["id"])
                    rows = [ontology._public_object(nxt, pk, objs[pk]) for pk in reached if pk in objs and ontology._can_see(nxt, objs[pk])]
                rows = ex._filter_rows(nxt, rows, sa.filters)
                rel = None
                loaded += len(rows)
            path.append({"link_type_id": lt["id"], "name": reach["display_name"], "object_type_id": nxt["id"],
                         "count": rel.count() if rel is not None else len(rows)})
            kinds.append("search_around")
            t = nxt
            type_ids.append(nxt["id"])
        if req.aggregate:
            kinds.append("aggregation")
        sort, order = req.sort, req.order
        if not sort:
            dflt = next((p["api_name"] for p in t.get("properties", []) if "hubble:default_sort_descending" in (p.get("type_classes") or [])), None)
            if dflt:
                sort, order = dflt, "desc"
        if sort and sort != "__title":
            sp = next((p for p in t.get("properties", []) if p["api_name"] == sort), None)
            hints = (sp or {}).get("render_hints")
            if sp and sp["type"] == "string" and hints and "sortable" not in hints:
                raise HTTPException(400, f"{sp['display_name']} is not sortable: enable the Sortable render hint in Ontology Manager")
        if rel is None:
            # the result is indexed rows: the explorer's own paging, histograms and aggregation
            if sort:
                rows.sort(key=lambda r: ((r["title"] if sort == "__title" else r["properties"].get(sort)) is None,
                                         ex._num(r["title"] if sort == "__title" else r["properties"].get(sort)) or 0,
                                         str(r["title"] if sort == "__title" else r["properties"].get(sort))), reverse=order == "desc")
            for r_ in rels:
                r_.close()
            return {"type": t, "rows": rows, "path": path, "kinds": kinds, "type_ids": type_ids, "loaded": loaded, "live": None}
        total = rel.count()
        lv = {"rel": rel, "rels": rels, "total": total, "sort": sort, "order": order}
        return {"type": t, "rows": LiveRows(lv), "path": path, "kinds": kinds, "type_ids": type_ids, "loaded": loaded, "live": lv}
    except Exception:
        for r in rels:
            r.close()
        raise


class LiveRows:
    """r["rows"] of a live search for in-process callers that read rows (monitors, Quiver, scenarios): len() is the
    total, a slice or an index reads that page, iterating reads every row (only a set of at most SMALL rows)."""

    def __init__(self, lv: dict):
        self.lv = lv

    def __len__(self) -> int:
        return self.lv["total"]

    def __getitem__(self, i: Any) -> Any:
        rel, n = self.lv["rel"], self.lv["total"]
        if isinstance(i, slice):
            start, stop, step = i.indices(n)
            if step != 1:
                return list(self)[i]
            return rel.page(self.lv["sort"], self.lv["order"], start, max(0, stop - start)) if stop > start else []
        k = i + n if i < 0 else i
        if not 0 <= k < n:
            raise IndexError(i)
        return rel.page(self.lv["sort"], self.lv["order"], k, 1)[0]

    def __iter__(self) -> Iterator[dict]:
        n = self.lv["total"]
        if n > SMALL:
            raise TooLarge(self.lv["rel"].t["display_name"] + " (this object set)", n)
        return iter(self.lv["rel"].page(self.lv["sort"], self.lv["order"], 0, n))

    def __bool__(self) -> bool:
        return self.lv["total"] > 0


def finish(r: dict, req: Any) -> dict:
    """The search response fields of a live result (and the live sets released)."""
    import ontology_explorer as ex

    lv = r["live"]
    rel: _Rel = lv["rel"]
    try:
        return {"total": lv["total"],
                "objects": rel.page(lv["sort"], lv["order"], req.offset, req.limit),
                "histograms": _histograms_of(r, req, lambda: rel.histograms(req.all_charts, ex._aggregatable)) if req.histograms else [],
                "aggregation": rel.aggregate(req.aggregate) if req.aggregate else None}
    finally:
        release(r)


def _histograms_of(r: dict, req: Any, compute: Any) -> list[dict]:
    """The charts of a live search, kept per search, caller and state of every type it touches (the backing data, its
    edits, an indexed type's objects, each type's definition)."""
    import auth
    import ontology

    # a live type's edits as its sets read them (the WAL edits database's files come and go with each connection)
    edited = {rel.t["id"]: hashlib.sha1(json.dumps(sorted(rel._edited.items()), default=str).encode()).hexdigest() for rel in r["live"]["rels"]}
    state = []
    for tid in r["type_ids"]:
        t = ontology._object_type(tid)
        state.append([tid, t.get("updated_at"), _signature(meta(tid)) if is_live(tid) else ontology.objects_stat(tid), edited.get(tid)])
    spec = req.model_dump(include={"object_type_id", "q", "filters", "search_around", "all_charts"})
    key = json.dumps([spec, state, (auth.current() or {}).get("id")], sort_keys=True, default=str)
    with _hists_lock:
        hit = _hists.pop(key, None)
        if hit is not None:
            _hists[key] = hit  # most recently used last
            return hit
    out = compute()
    with _hists_lock:
        _hists[key] = out
        while len(_hists) > HISTS_KEEP:
            _hists.pop(next(iter(_hists)))
    return out


def export_rows(r: dict, limit: int) -> list[dict]:
    lv = r["live"]
    try:
        return lv["rel"].page(lv["sort"], lv["order"], 0, limit)
    finally:
        release(r)


def release(r: dict) -> None:
    for rel in (r.get("live") or {}).get("rels") or []:
        rel.close()


def auth_check(type_id: str) -> None:
    import auth

    auth.check_resource("object_type", type_id)
