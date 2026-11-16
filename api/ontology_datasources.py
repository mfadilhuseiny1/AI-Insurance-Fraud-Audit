"""Backing datasources for object types (Palantir's Object and link types doc: "Choosing a backing datasource",
"Map a property to a column", "Change the column backing a property", Phonograph schema errors).

* GET /datasets/{id}/schema: the columns of a Parquet dataset in Files with the property each would become (base
  type, array), whether it can back a property (map and struct columns cannot), and which columns are unique and
  always set (primary key candidates).
* POST /object-types/from-dataset: the create wizard: one object per row, a property per selected column (renamed,
  retyped), the primary key checked for uniqueness, optionally with the standard create / modify / delete actions.
* /object-types/{id}/datasource: the Datasources tab. GET shows the dataset's columns, the property each backs, the
  unmapped columns and properties, schema errors named like Phonograph's (FoundryColumnNameNotFound,
  FieldTypeIncompatibleWithPropertyType, PrimaryKeyNotMapped, DuplicatePrimaryKey, UnsupportedColumnType,
  DatasetAndBranchAlreadyRegistered) and whether the dataset changed since the last index. PUT adds or replaces the
  datasource and the column ↔ property mapping (a replacement auto-maps columns with the same names; "map unmapped"
  creates properties for the remaining columns) and re-indexes. DELETE detaches it (objects stay, edits only).
  POST …/reindex re-imports the rows; edit-only properties and properties no column backs keep their values.
* A watcher re-indexes object types whose dataset was updated (auto re-index, on by default).
* A re-index builds only new or changed rows (row hashes), reads a big dataset by byte ranges, only the row groups an
  APPEND added, skips row groups whose bytes are unchanged (a SNAPSHOT with few changes decodes only the changed
  groups; an S3 dataset is read from its transaction's verified local copy), and applies changelog datasources (last
  row per key wins, a deletion column deletes): see "incremental re-index", "reading only what an index needs" and
  "snapshot re-index without reading what did not change" below.
* Values a property does not allow are indexed as null and reported on the run, or (the datasource's invalid_values
  "fail") fail the whole re-index with a report of the offending rows: see "disallowed dataset values" below.
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import io
import json
import logging
import math
import os
import threading
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import ontology

router = APIRouter(prefix="/api/ontology")

# objects indexed per object type (all of a type's objects live in one JSON file): BLUESANDAI_ONTOLOGY_MAX_ROWS
MAX_ROWS = 50_000


def max_rows() -> int:
    try:
        return max(1, int(os.environ.get("BLUESANDAI_ONTOLOGY_MAX_ROWS") or MAX_ROWS))
    except ValueError:
        return MAX_ROWS

SCALAR = {"Integer": "integer", "Long": "long", "Short": "short", "Byte": "byte", "Double": "double", "Float": "float", "Decimal": "decimal",
          "Boolean": "boolean", "Timestamp": "timestamp", "Date": "date", "String": "string"}
# property base types a column of each kind can back (strings carry JSON or text for the rest)
ACCEPTS = {
    "string": {"string", "geopoint", "geoshape", "marking", "media", "attachment", "cipher", "vector", "struct", "timeseries", "date", "timestamp",
               "integer", "long", "short", "double", "decimal", "boolean"},
    "integer": {"integer", "long", "short", "byte", "double", "float", "decimal", "string"},
    "long": {"long", "integer", "double", "decimal", "string", "timestamp"},
    "short": {"short", "integer", "long", "double", "string"},
    "byte": {"byte", "short", "integer", "long", "string"},
    "double": {"double", "float", "decimal", "string"},
    "float": {"float", "double", "decimal", "string"},
    "decimal": {"decimal", "double", "string"},
    "boolean": {"boolean", "string"},
    "timestamp": {"timestamp", "date", "string"},
    "date": {"date", "timestamp", "string"},
}


def _open(dataset_id: str, ranged: bool = False) -> tuple[dict, Any]:
    """(Files item, pyarrow ParquetFile) of a Parquet dataset: the file is read once and only its footer is parsed;
    the rows are decoded by the caller, column-wise. Over the row limit: refused from the footer. ranged (re-index):
    a big settled version is read by byte ranges instead (see _RangeFile): no sha1 then."""
    import pyarrow.parquet as pq

    import drive

    read_at = time.time()
    item = drive._item(dataset_id)
    settled = _settled(item.get("updated_at"), read_at)
    src, data = None, b""
    if ranged and settled and int(item.get("size_bytes") or 0) >= stream_min_bytes():
        try:
            src = _RangeFile(item)
            if src.path is None:
                # S3: the transaction's local copy when it holds the same bytes (see "the transaction's local copy")
                cp = _verified_copy(item["id"], src.size, src.tag)
                if cp is not None:
                    src.use_copy(cp)
            pf = pq.ParquetFile(src, buffer_size=STREAM_BUFFER)
            n = pf.metadata.num_rows
        except _Changed:
            src = None  # rewritten while its footer was read: read whole
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    if src is None:
        try:
            data = drive.read_bytes(item)
            pf = pq.ParquetFile(io.BytesIO(data))
            n = pf.metadata.num_rows
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
    if n > max_rows():
        raise HTTPException(400, f"the dataset has {n:,} rows; at most {max_rows():,} objects are indexed (BLUESANDAI_ONTOLOGY_MAX_ROWS)")
    # how it was read (re-index statistics, transaction matching): kept on the reader, not in the API's info
    pf._bsai = {"src": src, "bytes": len(data), "stamp": item.get("updated_at"), "data": data if src is None else None,
                "size": src.size if src is not None else len(data)}
    return {"id": item["id"], "name": item["name"], "updated_at": str(item.get("updated_at")), "sha1": hashlib.sha1(data).hexdigest() if src is None else None,
            "settled": settled, "size": src.size if src is not None else len(data)}, pf


def _bytes_read(pf: Any) -> int:
    m = getattr(pf, "_bsai", None) or {}
    return m["src"].read_bytes if m.get("src") is not None else int(m.get("bytes") or 0)


def _decode(info: dict, fn: Any) -> Any:
    """fn() decoding rows of the dataset; a file whose footer parsed but whose data does not is unreadable too."""
    try:
        return fn()
    except (HTTPException, _Changed):
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{info["name"]}" is not a readable Parquet dataset: {e}') from None


def _table(dataset_id: str) -> tuple[dict, Any]:
    """(Files item, Arrow table) of a Parquet dataset."""
    info, pf = _open(dataset_id)
    return info, _decode(info, pf.read)


def _columns(pf: Any) -> list[dict]:
    return [_column(f) for f in pf.schema_arrow]


def _pk_strings(arr: Any) -> list[Optional[str]]:
    """The primary keys of a column as the index keys objects (str of the cell value); None and "" stay as they are
    (rows without a primary key)."""
    import pyarrow as pa

    t = arr.type
    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return arr.to_pylist()  # (str(v) of a str is v)
    if pa.types.is_integer(t):
        return arr.cast(pa.string()).to_pylist()  # (Arrow writes integers as str() does)
    return [v if v is None or v == "" else str(_cell(v)) for v in arr.to_pylist()]


def _pk_unique(info: dict, pf: Any, col: str) -> bool:
    """= _unique(rows, col), decoding only that column."""
    keys = _pk_strings(_decode(info, lambda: pf.read(columns=[col]).column(0)))
    return None not in keys and "" not in keys and len(set(keys)) == len(keys)


def _errors(t: dict, cols: list[dict], info: dict, pf: Any, mapping: dict[str, str], changelog: Optional[dict] = None, pk: bool = True) -> list[dict]:
    """= errors(t, cols, rows, mapping), with the primary key's uniqueness checked on its column alone (not for a
    changelog datasource, whose rows are versions; pk=False: _import checks it on the keys it scans)."""
    out = errors(t, cols, None, mapping, changelog)
    by_col = {c["name"] for c in cols}
    if pk and not changelog and t["primary_key"] in mapping.values():
        col = next(c for c, a in mapping.items() if a == t["primary_key"])
        if col in by_col and not _pk_unique(info, pf, col):
            out.append({"code": "DuplicatePrimaryKey", "column": col, "message": f"{col} backs the primary key but is not unique and set on every row"})
    return out


# ------------------------------------------------------------------------------------------------
# incremental re-index: per-row content hashes of the rows last indexed
#
# Next to a type's indexing runs, <type id>.rows.arrow (Arrow IPC) keeps, in dataset order, each indexed row's primary
# key and a 64-bit hash of its mapped columns (polars hash_rows, computed column-wise per Parquet row group), plus in
# its schema metadata what the objects were built with: the dataset, the mapping, the property definitions and the
# columns' Arrow types (`sig`), the hasher (polars version: its hashes are not stable across versions), the objects'
# store as the index left it (shard file names, or the single file's stat) and the primary keys with user edits.
# A re-index then builds objects only for rows whose hash differs from the indexed row with that key (rows at the same
# position are compared first, as arrays: an APPEND transaction rewrites the file as the old rows followed by the new
# ones, so only its tail is new), keys that are new, keys with user edits (now or at the last index), and keys whose
# shard was rewritten since by another writer; every other object is the stored one. A single-file store written to
# since, a changed sig or hasher, multi-datasource types and a missing or unreadable file: every row is built (the
# previous behaviour). Then the changelog, edits merge and save run as before, with `changed` passed to save_objects
# so a sharded type writes only the shards of the keys that changed.
# ------------------------------------------------------------------------------------------------

ROWS_FORMAT = 1
# what the last index did (tests, measurements): path full | incremental | append | unchanged, rows, rows_built
LAST: dict[str, Any] = {}


def _rows_path(type_id: str) -> Any:
    return ontology.DIR / "indexing" / f"{type_id}.rows.arrow"


def _dirty(v: Any) -> bool:
    """Whether ontology_indexing's data restrictions change (or warn about) this value: NaN / infinity, empty strings,
    null array elements, recursively."""
    if isinstance(v, float):
        return math.isnan(v) or math.isinf(v)
    if isinstance(v, str):
        return v == ""
    if isinstance(v, list):
        return any(x is None or _dirty(x) for x in v)
    return False


# ------------------------------------------------------------------------------------------------
# disallowed dataset values (Object and link types doc: "If you apply a value type to an object property that contains
# property values that fail validation, that object type will fail to index"; a required property with a null on its
# backing column fails the reindex; Indexing doc: OSv2 enforces data type coherence and stricter geopoint validation)
#
# A datasource's `invalid_values` setting decides what a re-index does with a value its property does not allow:
# "null" (the default, as before): the value is indexed as null, counted in the run's warnings and invalid-values
# report; the hash file keeps each row's disallowed values (column "inv"), so a re-index that does not build a row
# still counts them and the report covers every row, incremental or not (a hash file without that column, written
# before, makes the next index build every row once); "fail": the
# whole re-index fails and nothing is written, the run (and the datasource's errors) carrying a report of the counts
# per column / property / kind and the first REPORT_ROWS offending rows. Kinds: InvalidValue (the value does not
# coerce to the property's type: wrong type, out of the type's range, a bad geopoint / geoshape / timestamp / date,
# null array elements, a marking outside a mandatory control's allowed markings), ValueTypeConstraint (outside the
# property's value type: enum / allowed values, range, string length, regex; checked in "fail" mode only — "null" mode
# keeps the previous behaviour of indexing them as they are), RequiredPropertyNull (a required property's column is
# null; "fail" mode only), NullPrimaryKey (a changelog row without a primary key, skipped in "null" mode),
# DuplicatePrimaryKey (rows of a non-changelog datasource sharing a key, or without one: always fails the index, now
# with the report). In "fail" mode the row-hash signature carries the mode and the value types' definitions, so
# switching the mode or editing a value type checks every row again.
# ------------------------------------------------------------------------------------------------

INVALID_MODES = ("null", "fail")
REPORT_ROWS = 20  # offending rows listed in a report (every offending value is counted)
INVALID_KINDS = {"InvalidValue": "not a valid value of the property's type", "ValueTypeConstraint": "outside the property's value type",
                 "RequiredPropertyNull": "null in a required property", "NullPrimaryKey": "no primary key", "DuplicatePrimaryKey": "a repeated primary key"}


def _short(v: Any) -> Any:
    """A cell value as listed in a report (text cut at 120 characters)."""
    if v is None or isinstance(v, (bool, int)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    s = v if isinstance(v, str) else json.dumps(v, default=str, ensure_ascii=False)
    return s if len(s) <= 120 else s[:117] + "..."


class _Invalid:
    """The disallowed values a re-index met: counts per (column, property, kind) and the first REPORT_ROWS rows."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.counts: dict[tuple, int] = {}
        self.rows: list[dict] = []
        self.total = 0

    def add(self, row: int, pk: Any, col: Optional[str], prop: Optional[str], code: str, value: Any, reason: str) -> None:
        k = (col, prop, code)
        self.counts[k] = self.counts.get(k, 0) + 1
        self.total += 1
        self.rows.append({"row": row + 1, "primary_key": pk, "column": col, "property": prop, "code": code, "value": _short(value), "reason": reason[:300]})
        if len(self.rows) > 4 * REPORT_ROWS:
            self.rows = sorted(self.rows, key=lambda r: (r["row"], r["column"] or ""))[:REPORT_ROWS]

    def summary(self) -> str:
        top = sorted(self.counts.items(), key=lambda kv: -kv[1])[:3]
        parts = [f"{n:,} {INVALID_KINDS.get(code, code)} in {prop or col}" for (col, prop, code), n in top]
        more = len(self.counts) - len(top)
        return "; ".join(parts) + (f"; {more} more column{'s' if more > 1 else ''}" if more > 0 else "")

    def report(self) -> dict:
        rows = sorted(self.rows, key=lambda r: (r["row"], r["column"] or ""))[:REPORT_ROWS]
        return {"mode": self.mode, "total": self.total, "rows_listed": len(rows), "row_limit": REPORT_ROWS,
                "counts": [{"column": c, "property": p, "code": code, "count": n} for (c, p, code), n in sorted(self.counts.items(), key=lambda kv: -kv[1])],
                "rows": rows}


# set while the watcher's step re-indexes (see _check_held): it records a failed run itself, once per failure
_WATCHING: contextvars.ContextVar[bool] = contextvars.ContextVar("ontology_watching", default=False)


def _fail_invalid(t: dict, inv: _Invalid, code: str, message: str) -> None:
    """Fail the index on disallowed values: the error (with the report) is what the re-index raises and keeps on the
    datasource, and the failed run (with the report) is recorded — here, or by the watcher's step, which records a
    failure once (not again on the retry of a version that failed while it could still change). Nothing has been
    written."""
    rep = inv.report()
    first = rep["counts"][0] if rep["counts"] else {}
    e = HTTPException(400, f"{code}: {message}")
    e.schema_errors = [{"code": code, "column": first.get("column"), "message": message, "report": rep}]
    if not _WATCHING.get():
        ontology._hook("index_failed", t, f"{code}: {message}", rep)
        e.index_recorded = True
    raise e


def _invalid_mode(b: Optional[dict]) -> str:
    m = (b or {}).get("invalid_values")
    return m if m in INVALID_MODES else "null"


def _value_types(t: dict, mapping: dict[str, str]) -> dict[str, Optional[dict]]:
    """The value types of the mapped properties (read once per index), by id; None for one not found."""
    props = {p["api_name"]: p for p in t["properties"]}
    ids = {props[a].get("value_type_id") for a in mapping.values() if a in props} - {None}
    return {i: ontology._read(ontology._path("value-types", i)) for i in sorted(ids)}


def _vt_error(vt: Optional[dict], value: Any) -> Optional[str]:
    """= ontology_model's value type hook on one value: why it fails the value type (None when it passes)."""
    import ontology_model

    if vt is None:
        return "its value type was not found"
    for v in value if isinstance(value, list) and vt["base_type"] != "array" else [value]:
        why = ontology_model.value_type_error(vt, v)
        if why:
            return why
    return None


def _checks_sig(mode: str, vts: dict[str, Optional[dict]]) -> Optional[dict]:
    """What a "fail" mode index validated rows against (part of the row-hash signature); None in "null" mode, so the
    hash files of datasources on the default stay valid."""
    if mode != "fail":
        return None
    return {"mode": mode, "value_types": {i: hashlib.sha1(json.dumps([vt.get("base_type"), vt.get("element_type"), (vt.get("versions") or [None])[-1]],
                                                                        sort_keys=True, default=str).encode()).hexdigest() if vt else None
                                          for i, vt in vts.items()}}


def _pk_report(pks: list[Optional[str]], pk_col: str, pk_api: str, mode: str, dups: bool = True) -> _Invalid:
    """The rows without a primary key, and (dups) the rows repeating one (every row of a repeated key but its first)."""
    inv = _Invalid(mode)
    seen: set = set()
    for i, k in enumerate(pks):
        if k in (None, ""):
            inv.add(i, None, pk_col, pk_api, "NullPrimaryKey", k, f"{pk_col} is empty: every row needs a primary key")
        elif not dups:
            continue
        elif k in seen:
            inv.add(i, k, pk_col, pk_api, "DuplicatePrimaryKey", k, f"{k!r} is the primary key of an earlier row too")
        else:
            seen.add(k)
    return inv


def _collect(mode: str, pks: list, row_inv: dict[int, list]) -> _Invalid:
    """The report of the disallowed values per row position (rows in order)."""
    inv = _Invalid(mode)
    for i in sorted(row_inv):
        for col, api, code, value, reason in row_inv[i]:
            inv.add(i, pks[i], col, api, code, value, reason)
    return inv


def _hasher() -> Optional[str]:
    try:
        import polars as pl
    except Exception:  # noqa: BLE001
        return None
    return f"polars {pl.__version__}"


def _row_hashes(table: Any) -> Optional[Any]:
    """uint64 hash per row of an Arrow table (columns in a fixed order), or None when they cannot be hashed."""
    try:
        import polars as pl

        return pl.from_arrow(table, rechunk=False).hash_rows(seed=0).to_numpy()
    except Exception:  # noqa: BLE001 - a column polars cannot take: every row is built
        return None


def _rows_sig(t: dict, b_dataset: str, mapping: dict[str, str], pf: Any, changelog: Optional[dict] = None, checks: Optional[dict] = None) -> str:
    types = {f.name: str(f.type) for f in pf.schema_arrow}
    sig = {"v": ROWS_FORMAT, "dataset": b_dataset, "mapping": mapping, "pk": t["primary_key"], "properties": t["properties"],
           "types": {c: types.get(c) for c in mapping}}
    if changelog is not None:  # (only then: the hash files of plain datasources stay valid)
        dc = changelog.get("deletion_column")
        sig["changelog"] = {"deletion_column": dc, "type": types.get(dc) if dc else None}
    if checks is not None:  # "fail" on disallowed values (see _checks_sig; likewise only then)
        sig["invalid_values"] = checks
    return hashlib.sha1(json.dumps(sig, sort_keys=True, default=str).encode()).hexdigest()


def _store_mark(type_id: str) -> dict:
    import ontology_store

    inf = ontology_store.info(type_id)
    if inf.get("format") == "shards":
        return {"format": "shards", "files": inf.get("files") or []}
    return {"format": inf.get("format"), "stat": ontology.objects_stat(type_id)}


def _layer_keys(type_id: str) -> set[str]:
    try:
        from ontology_edits import layer
    except Exception:  # noqa: BLE001
        return set()
    return set(layer(type_id))


def _load_rows(type_id: str) -> Optional[tuple[dict, list[str], Any, Any]]:
    """(meta, primary key per row, hash per row, changelog deletion flag per row or None)."""
    import pyarrow as pa

    try:
        data = _rows_path(type_id).read_bytes()
        tbl = pa.ipc.open_file(pa.BufferReader(data)).read_all()
        meta = json.loads(tbl.schema.metadata[b"meta"])
        pks = tbl.column("pk").to_pylist()
        dirty = [pks[i] for i in tbl.column("dirty").to_numpy(zero_copy_only=False).nonzero()[0].tolist()]
        dele = tbl.column("del").to_numpy(zero_copy_only=False) if "del" in tbl.column_names else None
        inv: dict = {}
        if "inv" in tbl.column_names:
            iv = tbl.column("inv")
            for j in iv.is_valid().to_numpy(zero_copy_only=False).nonzero()[0].tolist():
                inv[pks[j]] = iv[j].as_py()
        return {**meta, "dirty": dirty, "inv_by_pk": inv}, pks, tbl.column("h").to_numpy(), dele
    except FileNotFoundError:
        return None
    except Exception:  # noqa: BLE001 - unreadable: the next index builds every row and writes it again
        logging.getLogger("bluesandai.ontology_datasources").warning("row hashes of %s unreadable; full re-index", type_id)
        return None


def _drop_rows(type_id: str) -> None:
    with contextlib.suppress(OSError):
        _rows_path(type_id).unlink()


def _save_rows(type_id: str, meta: dict, pks: list[str], hashes: Any, dirty: Optional[list[bool]], dele: Any = None,
               inv: Optional[dict[int, list]] = None) -> None:
    """dirty None: no row is. inv: the disallowed values indexed as null, by row position (column "inv", JSON)."""
    import numpy as np
    import pyarrow as pa

    p = _rows_path(type_id)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        cols = {"pk": pa.array(pks, pa.string()), "h": pa.array(hashes, pa.uint64()),
                "dirty": pa.array(np.zeros(len(pks), bool) if dirty is None else dirty, pa.bool_())}
        if dele is not None:
            cols["del"] = pa.array(dele, pa.bool_())
        col = [None] * len(pks)
        for i, ents in (inv or {}).items():
            col[i] = json.dumps(ents, default=str)
        cols["inv"] = pa.array(col, pa.string())
        tbl = pa.table(cols)
        tbl = tbl.replace_schema_metadata({"meta": json.dumps(meta)})
        sink = pa.BufferOutputStream()
        with pa.ipc.new_file(sink, tbl.schema) as w:
            w.write_table(tbl)
        tmp.write_bytes(sink.getvalue().to_pybytes())
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - only the next index's speed depends on it
        logging.getLogger("bluesandai.ontology_datasources").exception("row hashes of %s not saved", type_id)
        with contextlib.suppress(OSError):
            tmp.unlink()
        _drop_rows(type_id)


def _prior(t: dict, sig: str, old: Any) -> Optional[dict]:
    """{pks: indexed primary keys, h: their row hashes, force: keys to build whatever their hash, same_store, meta,
    dele: the rows' changelog deletion flags} when the stored objects are what the last index built from rows with
    those hashes; None: build every row. old: the stored keys, or a function returning them (only called when another
    writer replaced shards)."""
    import ontology_store

    if t.get("additional_datasources"):
        return None  # multi-datasource types: other datasets' columns change independently
    got = _load_rows(t["id"])
    if not got:
        return None
    meta, pks, hashes, dele = got
    if meta.get("sig") != sig or meta.get("hasher") != _hasher() or len(pks) != len(hashes):
        return None
    if not meta.get("inv"):
        return None  # (written before the disallowed values were kept per row: one full build makes the report whole)
    if dele is not None and len(dele) != len(pks):
        return None
    before, now = meta.get("store") or {}, _store_mark(t["id"])
    # keys with user edits (now, or at the last index: an edit dropped since leaves the edited value stored), and rows
    # whose values the indexing checks change (their data warnings are counted on every run)
    force = set(meta.get("layer") or []) | _layer_keys(t["id"]) | set(meta.get("dirty") or [])
    if before != now:
        if before.get("format") != "shards" or now.get("format") != "shards" or len(before.get("files") or []) != len(now["files"]):
            return None
        # another writer replaced some shards (shard files are immutable): their keys are built again
        n = len(now["files"])
        moved = {i for i, (x, y) in enumerate(zip(before["files"], now["files"])) if x != y}
        force |= {pk for pk in (old() if callable(old) else old) if ontology_store.shard_of(pk, n) in moved}
    return {"pks": pks, "h": hashes, "force": force, "same_store": before == now, "meta": meta, "dele": dele}


# ------------------------------------------------------------------------------------------------
# re-index without loading every object
#
# When the store is as the last index left it (its shard file names, or the single file's stat, are the ones the hash
# file recorded), the stored key set is known without reading it: the keys the indexed rows stood for, minus `absent`
# (row keys the store lacked: user deletions) plus `extra` (stored keys no row stood for: objects users created), both
# kept in the hash file's metadata. Membership is all the scan and the append plan ask of the stored objects, so
# nothing is loaded for them. Objects are then assembled only for the touched keys (rows built, stored keys gone from
# the rows, keys with user edits), from the store's get_many (a sharded type reads only their shards), and run through
# the same index checks and edit merge; every other key is a row unchanged since the last index, which a whole assembly
# would find equal to its stored object and keep as it is. A save writes the changed keys' shards with every other
# object of those shards kept as stored (ontology_store.save's count); a save that must write the whole set (an unshard,
# a re-shard, a single-file store) makes the index assemble every object and save as before. The objects stored are
# the same either way; a Full re-index, a store written by another writer since, or a hash file without the key
# lists (written before them) assemble every object.
# ------------------------------------------------------------------------------------------------


def _stored_keys(prior: dict) -> Optional[set[str]]:
    """The stored primary keys as the last index left them (see above), or None when the hash file does not say."""
    meta = prior["meta"]
    if not isinstance(meta.get("absent"), list) or not isinstance(meta.get("extra"), list):
        return None
    pks, dele = prior["pks"], prior.get("dele")
    if dele is None:
        keys = set(pks)
    else:
        last = dict(zip(pks, dele.tolist()))  # (a later row of a key replaces its earlier ones: the last row's flag)
        keys = {pk for pk, d in last.items() if not d}
    keys.discard(None)
    keys.discard("")
    return (keys - set(meta["absent"])) | set(meta["extra"])


def _save_some(type_id: str, objs: dict, changed: set, count: int) -> dict:
    """= ontology.save_objects(type_id, objs, changed) for objs holding only the touched keys' objects of a set of
    `count` (ontology_store.save's count; {"whole_set_needed": True}: nothing written)."""
    import ontology_store

    if ontology._SNAPSHOTS:
        ontology._snapshot_before_save(type_id, objs, changed)  # (as save_objects: it reads only the changed keys)
    return ontology_store.save(type_id, objs, changed, count=count)


def _scan_cols(pf: Any, mapping: dict[str, str], changelog: Optional[dict]) -> list[str]:
    """The columns an index reads: the mapped ones the file has (sorted), then a changelog's deletion column."""
    delcol = (changelog or {}).get("deletion_column")
    cols = sorted(c for c in mapping if c in {f.name for f in pf.schema_arrow})
    if delcol and delcol not in cols:
        cols.append(delcol)
    return cols


def _scan(info: dict, pf: Any, mapping: dict[str, str], pk_col: str, prior: Optional[dict], old: dict,
          changelog: Optional[dict] = None, skip: Optional[set[int]] = None, reuse: Optional[dict] = None) -> dict:
    """The dataset's rows, in batches per row group read, mapped columns only (and a changelog's deletion column):
    {pks: primary key per row, hashes: row hashes or None, build: {row position: row} of the rows whose objects must be
    built, path, dele: deletion flag per row (changelog with a deletion column) or None, groups_read, rows_read, gh:
    [content hash, first row, rows] per row group, reused: [(first row, indexed first row, rows)] of the groups reused}.
    The row groups in `skip` are not read: their rows are the indexed rows at the same positions (see _plan). A row
    group whose content hash is in `reuse` (see _reusable) is not decoded: its rows are that indexed group's. Rows
    without a primary key are skipped; a changelog row marked deleted is never built, and a changelog row only stands
    for its object when it is the key's last row (by_pk keeps the last position of each key)."""
    import numpy as np

    delcol = (changelog or {}).get("deletion_column")
    cols = _scan_cols(pf, mapping, changelog)
    skip = skip or set()
    reuse = reuse or {}
    old_gh = (prior or {}).get("meta", {}).get("gh") if prior and prior["meta"].get("gcols") == cols else None
    gh: list[list] = []
    reused: list[tuple[int, int, int]] = []
    src = (getattr(pf, "_bsai", None) or {}).get("src")
    if prior:
        old_pks, old_h, force, old_del = prior["pks"], prior["h"], prior["force"], prior.get("dele")
    else:
        old_pks, old_h, force, old_del = [], np.zeros(0, np.uint64), set(), None
    by_pk: Optional[dict[str, int]] = None
    pks: list[Optional[str]] = []
    parts: list[Any] = []
    dels: list[Any] = []
    build: dict[int, dict] = {}
    start, hashed, groups_read, rows_read = 0, True, 0, 0
    md = pf.metadata
    for g in range(pf.num_row_groups):
        n_g = md.row_group(g).num_rows
        if g in skip:
            n = n_g
            e = old_gh[g] if isinstance(old_gh, list) and g < len(old_gh) else None
            gh.append([e[0] if isinstance(e, list) and len(e) == 3 and e[1] == start and e[2] == n else None, start, n])
            pks.extend(old_pks[start:start + n])
            parts.append(old_h[start:start + n])
            if delcol:
                dels.append(old_del[start:start + n])
            start += n
            continue
        hg = _ghash(pf, g, cols, keep=True, wanted=bool(reuse))
        gh.append([hg, start, n_g])
        o = next((s for s, n in reuse.get(hg) or [] if n == n_g and (changelog is None or s == start)), None) if hg else None
        if o is not None:
            # the same bytes as an indexed group: its rows (see "snapshot re-index without reading what did not change")
            if src is not None:
                src.drop()
            pks.extend(old_pks[o:o + n_g])
            parts.append(old_h[o:o + n_g])
            if delcol:
                dels.append(old_del[o:o + n_g])
            reused.append((start, o, n_g))
            start += n_g
            continue
        groups_read += 1
        for rg in _batches(info, pf, g, cols):
            n = rg.num_rows
            rows_read += n
            h = _row_hashes(rg) if hashed else None
            if h is None:
                hashed = False
            d = np.asarray(rg.column(delcol).fill_null(False).to_numpy(zero_copy_only=False), bool) if delcol else None
            if delcol:
                dels.append(d)
            same = np.zeros(n, bool)
            if h is not None and prior:
                m = max(0, min(n, len(old_h) - start))
                same[:m] = h[:m] == old_h[start:start + m]
            idx = np.flatnonzero(~same)
            conv = _pk_strings(rg.column(pk_col).take(idx)) if len(idx) else []
            seg = [old_pks[start + i] for i in range(n)] if same.all() else [None] * n
            if not same.all():
                for i in np.flatnonzero(same):
                    seg[i] = old_pks[start + i]
                for i, k in zip(idx, conv):
                    seg[i] = k
            if changelog is not None and prior and by_pk is None:
                by_pk = {k: j for j, k in enumerate(old_pks)}
            want = []
            for i, (pk, kept) in enumerate(zip(seg, same.tolist())):
                if pk in (None, "") or (d is not None and d[i]):
                    continue
                if pk not in old or pk in force:
                    want.append(i)
                elif not kept or (by_pk is not None and changelog is not None and by_pk.get(pk) != start + i):
                    # (a changelog row unchanged at its position stands for the stored object only if it was the key's last row)
                    if h is None or not prior:
                        want.append(i)
                        continue
                    if by_pk is None:
                        by_pk = {k: j for j, k in enumerate(old_pks)}
                    j = by_pk.get(pk)
                    if j is None or old_h[j] != h[i]:
                        want.append(i)
            if want:
                for i, r in zip(want, rg.take(want).to_pylist()):
                    build[start + i] = {k: _cell(v) for k, v in r.items()}
            pks.extend(seg)
            if h is not None:
                parts.append(h)
            start += n
        if src is not None:
            src.drop()
    hashes = np.concatenate(parts) if hashed and parts else (np.zeros(0, np.uint64) if hashed else None)
    dele = (np.concatenate(dels) if dels else np.zeros(0, bool)) if delcol else None
    if not prior:
        path = "full"
    elif not build:
        path = "unchanged" if len(pks) == len(old_pks) else "incremental"
    elif len(old_pks) < len(pks) and min(build) >= len(old_pks) and len(build) == len(pks) - len(old_pks) and pks[:len(old_pks)] == old_pks:
        path = "append"  # every indexed row in its place, the new rows after them: only the tail was built
    else:
        path = "incremental"
    return {"pks": pks, "hashes": hashes, "build": build, "path": path, "dele": dele, "groups_read": groups_read, "rows_read": rows_read,
            "gh": gh, "gcols": cols, "reused": reused}


def _batches(info: dict, pf: Any, g: int, cols: list[str]) -> Any:
    """The record batches of row group g (BATCH_ROWS rows each): a ranged reader fetches its column chunks in
    STREAM_BUFFER pieces as they are decoded, so a big row group is never held in memory whole."""
    it = _decode(info, lambda: pf.iter_batches(batch_size=BATCH_ROWS, row_groups=[g], columns=cols))
    while True:
        b = _decode(info, lambda: next(it, None))
        if b is None:
            return
        yield b


# ------------------------------------------------------------------------------------------------
# reading only what an index needs: byte-range reads, append-only reads, changelog datasources
#
# Byte ranges: a re-index of a dataset of at least BLUESANDAI_ONTOLOGY_STREAM_MIN_BYTES (default 2 MiB) whose version
# is settled does not read the file whole: the Parquet footer, then only the mapped columns' chunks of the row groups
# it needs, by byte ranges (S3 range GETs pinned to the object's ETag, local reads pinned to the file's mtime and size;
# a write under the read raises _Changed and the re-index reads the file whole instead), decoded in batches of
# BATCH_ROWS: the snapshot compare streams, no full in-memory copy of the file. Smaller datasets, and versions read
# within SETTLE_SECONDS of their stamp (the watcher confirms those by sha1), are read whole as before.
#
# Append-only reads: the row hash file also keeps the dataset transaction the index read (dataset_versions, the log
# every writer keeps) and a fingerprint of each row group's footer metadata. When every transaction since is an APPEND
# (rows added after the existing ones; a SNAPSHOT, UPDATE or rollback reads every row group) and the newest one is the
# version now in Files (same row count and size, recorded at or after its stamp), the leading row groups whose
# fingerprint is unchanged are not read: their rows are the indexed ones (keys, hashes and deletion flags from the
# hash file, objects from the store). A row in them that must be built anyway (user edits, data warnings, a shard
# another writer rewrote, an object missing from the store) has its row group read too. Row groups holding new rows
# are read, their old rows compared as usual. pq.write_table puts up to 1Mi rows in a row group, so a smaller dataset
# rewritten whole by an APPEND is one row group, which is read: the saving is then the old rows' hashing and comparing,
# not bytes. Trusting an APPEND (an unread row group is not looked at) is what Foundry's incremental indexing does; a
# Full re-index reads everything.
#
# Changelog datasources (backing_dataset.changelog = {"deletion_column": column or None}), like Object Storage v2's
# incremental datasets: rows are versions of objects. For each primary key the last row wins (dataset order: a later
# APPEND transaction's rows come after the earlier ones), and when the declared deletion column (Boolean; a column
# merely named is_deleted is not one) is true there, the object is deleted. Duplicate primary keys are allowed. An
# appended changelog transaction is applied as inserts, updates and deletes; a rewritten (compacted) one is compared.
# ------------------------------------------------------------------------------------------------

STREAM_MIN_BYTES = 2 * 1024 * 1024
STREAM_BUFFER = 1 << 20
BATCH_ROWS = 65_536


def stream_min_bytes() -> int:
    v = os.environ.get("BLUESANDAI_ONTOLOGY_STREAM_MIN_BYTES")
    try:
        return max(0, int(v)) if v not in (None, "") else STREAM_MIN_BYTES
    except ValueError:
        return STREAM_MIN_BYTES


class _Changed(Exception):
    """The dataset was rewritten while it was read by ranges."""


class _RangeFile(io.RawIOBase):
    """A Files item read by byte ranges, counting the bytes read (read_bytes) and the requests (requests)."""

    def __init__(self, item: dict) -> None:
        import auth
        import drive

        super().__init__()
        auth.check_item(item)  # as drive.read_bytes
        self.item, self.pos, self.read_bytes, self.requests = item, 0, 0, 0
        self.copy: Optional[str] = None  # the transaction copy read instead of S3 (use_copy)
        self._pre: list[tuple[int, bytes]] = []  # prefetched ranges (prefetch): reads inside one are served from it
        if item["stored_in"] == "s3":
            import storage

            head = storage._s3().head_object(Bucket=storage._bucket(), Key=f"drive/{item['id']}")
            self.size, self.tag, self.path = int(head["ContentLength"]), head["ETag"], None
        else:
            self.path = drive.LOCAL_DIR / item["id"]
            st = self.path.stat()
            self.size, self.tag = st.st_size, (st.st_mtime_ns, st.st_size)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def use_copy(self, path: Any) -> None:
        """Read `path` (a local file holding the same bytes, see _verified_copy) instead of the S3 object, pinned to
        its stat as a local item is."""
        st = path.stat()
        self.path, self.tag, self.copy = path, (st.st_mtime_ns, st.st_size), path.name

    def prefetch(self, ranges: list[tuple[int, int]]) -> None:
        """Read the [start, end) ranges now (adjacent ones, or ones less than PREFETCH_GAP apart, in one request) and
        serve later reads that fall inside one of them from memory: a row group's chunks are hashed, then decoded,
        from one read."""
        self._pre = []
        for a, b in _merged(ranges):
            data = self._range(a, b - a)
            self.read_bytes += len(data)
            self.requests += 1
            self._pre.append((a, data))

    def prefetched(self, a: int, b: int) -> Optional[memoryview]:
        for s, data in self._pre:
            if s <= a and b <= s + len(data):
                return memoryview(data)[a - s:b - s]
        return None

    def drop(self) -> None:
        self._pre = []

    def readinto(self, b: Any) -> int:
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        got = self.prefetched(self.pos, self.pos + n) if self._pre else None
        if got is not None:
            b[:n] = got
            self.pos += n
            return n
        data = self._range(self.pos, n)
        b[:len(data)] = data
        self.pos += len(data)
        self.read_bytes += len(data)
        self.requests += 1
        return len(data)

    def _range(self, start: int, n: int) -> bytes:
        if self.path is None:
            import storage
            from botocore.exceptions import ClientError

            try:
                return storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{self.item['id']}", Range=f"bytes={start}-{start + n - 1}",
                                                IfMatch=self.tag)["Body"].read()
            except ClientError as e:
                if str(e.response.get("Error", {}).get("Code")) in ("PreconditionFailed", "412", "NoSuchKey"):
                    raise _Changed() from None
                raise
        try:
            with open(self.path, "rb") as f:
                st = os.fstat(f.fileno())
                if (st.st_mtime_ns, st.st_size) != self.tag:
                    raise _Changed()
                f.seek(start)
                return f.read(n)
        except FileNotFoundError:
            raise _Changed() from None


def _tx_kind(tx: dict) -> str:
    src = tx.get("source") or {}
    return src.get("transaction") or ("APPEND" if src.get("mode") in ("append", "alwaysAppend") else "SNAPSHOT")


def _tx_now(info: dict, pf: Any) -> Optional[dict]:
    """The dataset transaction whose data is the version read: the newest committed one, when it holds the same rows
    and bytes and was recorded at or after the file's stamp (a write without a transaction leaves a later stamp)."""
    import datetime as dt

    import dataset_versions

    txs = dataset_versions.history(info["id"])
    if not txs:
        return None
    tx, stamp = txs[0], (getattr(pf, "_bsai", None) or {}).get("stamp")
    if tx.get("rows") != pf.metadata.num_rows or tx.get("size") != info["size"] or not hasattr(stamp, "timestamp"):
        return None
    try:
        at = dt.datetime.fromisoformat(str(tx["at"]))
    except (KeyError, ValueError):
        return None
    return tx if int(at.timestamp()) >= int(stamp.timestamp()) else None


def _appended(item_id: str, indexed: str, now: dict) -> bool:
    """Whether every transaction after the indexed one, up to `now`, is an APPEND."""
    import dataset_versions

    newer = []
    for tx in dataset_versions.history(item_id):  # newest first
        if tx["id"] == indexed:
            break
        newer.append(tx)
    else:
        return False  # the indexed transaction is not in the history (any more)
    if (newer[0]["id"] if newer else indexed) != now["id"]:
        return False
    return all(_tx_kind(tx) == "APPEND" for tx in newer)


def _fingerprints(pf: Any) -> list[str]:
    """A fingerprint per row group of its footer metadata (rows, every column chunk's offsets, sizes, encodings and
    statistics)."""
    md = pf.metadata
    return [hashlib.sha1(json.dumps(md.row_group(g).to_dict(), sort_keys=True, default=str).encode()).hexdigest()[:20] for g in range(md.num_row_groups)]


# ------------------------------------------------------------------------------------------------
# snapshot re-index without reading what did not change
#
# The transaction's local copy: every transaction keeps a copy of the file it wrote (dataset_versions,
# data/lineage/versions/<item>/<tx>.parquet). A ranged re-index of an S3 dataset reads the newest transaction's copy of
# the same size instead of S3 when its MD5 is the object's ETag (one part: the MD5 of the bytes; multipart: the MD5 of
# the parts' MD5s, for the part sizes boto3 uses): the same bytes, read from disk. Any other ETag (SSE-KMS, another
# part size), no copy (retention dropped it, a write without a transaction): S3 as before.
#
# Row-group content hashes: the row hash file also keeps, per row group, a SHA-1 of the bytes of the column chunks the
# index reads (mapped columns and the deletion column: from each chunk's first page to the next column chunk in the
# file), with the group's row count, the chunks' compression and physical types (`gh`, for the columns `gcols`). On
# the next index each row group's chunks are read (one ranged request per group, kept in memory for its decoding) and
# hashed first; a group whose hash is one of the indexed groups' (same bytes, so the same rows, wherever it sits in the
# file: a SNAPSHOT that rewrote the file with a few changed rows, an added or dropped unmapped column) is not decoded:
# its rows' keys, hashes and deletion flags are the indexed group's. Only changed groups are decoded, hashed per row
# and compared. Rows re-grouped, reordered or shifted by a delete change the groups' bytes: those groups are decoded
# and compared by key as before. A group holding a row that must be built anyway (user edits, data warnings, a shard
# another writer rewrote, an object missing from the store) is never reused; for a changelog datasource a group is
# reused only at its own position, and when a reused row turns out to be its key's last row while it was not at the
# last index (a later version of the key was removed), every row is read again.
# ------------------------------------------------------------------------------------------------

PREFETCH_GAP = 64 * 1024
GROUP_CACHE_BYTES = 64 * 1024 * 1024
MULTIPART_SIZES = (8 * 1024 * 1024, 5 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024)


def _merged(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for a, b in sorted(ranges):
        if out and a - out[-1][1] <= PREFETCH_GAP:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _etag_of(path: Any, size: int, etag: str) -> bool:
    """Whether the file's bytes have this S3 ETag."""
    etag = str(etag).strip('"')
    if "-" not in etag:
        h = hashlib.md5()
        with open(path, "rb") as f:
            for piece in iter(lambda: f.read(8 << 20), b""):
                h.update(piece)
        return h.hexdigest() == etag
    digest, _, parts = etag.partition("-")
    if not parts.isdigit():
        return False
    for ps in MULTIPART_SIZES:
        if -(-size // ps) != int(parts):
            continue
        md5s = b""
        with open(path, "rb") as f:
            for piece in iter(lambda: f.read(ps), b""):
                md5s += hashlib.md5(piece).digest()
        if hashlib.md5(md5s).hexdigest() == digest:
            return True
    return False


def _verified_copy(item_id: str, size: int, etag: Any) -> Optional[Any]:
    """The local copy of the dataset's newest transaction when it holds the S3 object's bytes (its MD5 is the ETag),
    else None (see above). BLUESANDAI_ONTOLOGY_LOCAL_COPY=0 turns it off."""
    if os.environ.get("BLUESANDAI_ONTOLOGY_LOCAL_COPY", "1") == "0" or not isinstance(etag, str):
        return None
    try:
        import dataset_versions

        txs = dataset_versions.history(item_id)
        if not txs or txs[0].get("size") != size or txs[0].get("kept") is False:
            return None
        p = dataset_versions._folder(item_id) / f"{txs[0]['id']}.parquet"
        if p.stat().st_size != size or not _etag_of(p, size, etag):
            return None
        return p
    except Exception:  # noqa: BLE001 - no usable copy: S3
        return None


def _leaves(schema: Any) -> Optional[dict[str, list[int]]]:
    """The Parquet leaf columns of each top-level Arrow field (depth first, as Parquet stores them)."""
    import pyarrow as pa

    def count(t: Any) -> int:
        if pa.types.is_struct(t):
            return sum(count(t.field(i).type) for i in range(t.num_fields))
        if pa.types.is_list(t) or pa.types.is_large_list(t) or pa.types.is_fixed_size_list(t):
            return count(t.value_type)
        if pa.types.is_map(t):
            return count(t.key_type) + count(t.item_type)
        return 1

    out, i = {}, 0
    for f in schema:
        n = count(f.type)
        out[f.name] = list(range(i, i + n))
        i += n
    return out


def _layout(pf: Any, cols: list[str]) -> Optional[dict]:
    """Per row group: the byte ranges of the chunks of `cols` and what else their rows depend on (see above); None when
    the file's leaf columns cannot be matched to its Arrow fields."""
    m = getattr(pf, "_bsai", None)
    if m is None:
        return None
    lay = m.get("layout")
    if lay is not None and lay["cols"] == cols:
        return lay if lay["ok"] else None
    lay = {"cols": list(cols), "ok": False}
    m["layout"] = lay
    try:
        md = pf.metadata
        leaves = _leaves(pf.schema_arrow)
        if sum(len(v) for v in leaves.values()) != md.num_columns:
            return None
        sch = md.schema
        idx = sorted(i for c in cols for i in leaves.get(c, []))
        for c in cols:
            for i in leaves.get(c, []):
                path = sch.column(i).path
                if path != c and not path.startswith(c + "."):
                    return None

        def first(cc: Any) -> int:
            d = cc.dictionary_page_offset
            return d if cc.has_dictionary_page and d is not None and 0 < d < cc.data_page_offset else cc.data_page_offset

        starts = sorted({first(md.row_group(g).column(i)) for g in range(md.num_row_groups) for i in range(md.num_columns)}
                        | {int(m["size"]) - 8 - md.serialized_size})
        import bisect

        ranges, heads = [], []
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            rs, head = [], [rg.num_rows]
            for i in idx:
                cc = rg.column(i)
                a = first(cc)
                nxt = starts[bisect.bisect_right(starts, a)] if bisect.bisect_right(starts, a) < len(starts) else int(m["size"])
                rs.append((a, max(nxt, a + cc.total_compressed_size)))
                head.append([i, sch.column(i).path, cc.physical_type, cc.compression])
            ranges.append(rs)
            heads.append(json.dumps(head).encode())
        lay.update({"ok": True, "ranges": ranges, "heads": heads})
        return lay
    except Exception:  # noqa: BLE001 - every group read
        return None


def _ghash(pf: Any, g: int, cols: list[str], keep: bool, wanted: bool) -> Optional[str]:
    """The content hash of row group g's chunks of `cols` (see above), or None. keep: a ranged reader keeps the bytes
    for decoding the group (dropped by _scan after it). wanted: a reuse is possible (otherwise a big group of a ranged
    S3 read is not hashed: the hash would cost a second read of its bytes)."""
    lay = _layout(pf, cols)
    if lay is None:
        return None
    rs, m = lay["ranges"][g], pf._bsai
    h = hashlib.sha1(lay["heads"][g])
    src = m.get("src")
    if src is None:
        data = m.get("data")
        if data is None:
            return None
        mv = memoryview(data)
        for a, b in rs:
            h.update(mv[a:b])
        return h.hexdigest()[:24]
    total = sum(b - a for a, b in rs)
    if total <= GROUP_CACHE_BYTES and keep:
        src.prefetch(rs)
        for a, b in rs:
            h.update(src.prefetched(a, b))
        return h.hexdigest()[:24]
    if not wanted and src.path is None:
        return None
    for a, b in rs:  # (a big group: hashed in pieces, decoded from a second read if it changed)
        for s in range(a, b, STREAM_BUFFER):
            piece = src._range(s, min(STREAM_BUFFER, b - s))
            src.read_bytes += len(piece)
            src.requests += 1
            h.update(piece)
    return h.hexdigest()[:24]


def _reusable(prior: dict, old: Any, changelog: Optional[dict], cols: list[str]) -> dict[str, list[tuple[int, int]]]:
    """{content hash: [(first row, rows)]} of the indexed row groups whose rows can stand in for a group of the same
    hash (see above): none of their rows must be built anyway."""
    meta = prior["meta"]
    gh = meta.get("gh")
    if not isinstance(gh, list) or meta.get("gcols") != cols:
        return {}
    pks, force, dele = prior["pks"], prior["force"], prior.get("dele")
    last = {k: j for j, k in enumerate(pks)} if changelog is not None else None
    out: dict[str, list[tuple[int, int]]] = {}
    for e in gh:
        if not isinstance(e, list) or len(e) != 3 or not e[0]:
            continue
        h, s, n = e
        if s + n > len(pks):
            continue
        for j in range(s, s + n):
            pk = pks[j]
            if pk in (None, "") or (last is not None and last.get(pk) != j) or (dele is not None and dele[j]):
                continue
            if pk in force or pk not in old:
                break
        else:
            out.setdefault(h, []).append((s, n))
    return out


def _plan(info: dict, pf: Any, prior: dict, old: dict, changelog: Optional[dict], tx_now: Optional[dict]) -> tuple[set[int], Optional[str]]:
    """(the row groups an index need not read, why every row group is read): append-only reads, see above."""
    import bisect

    meta = prior["meta"]
    if not meta.get("tx") or not meta.get("groups"):
        return set(), "no transaction recorded at the last index"
    if tx_now is None:
        return set(), "the version in Files is not its newest transaction"
    if not _appended(info["id"], meta["tx"], tx_now):
        return set(), "a transaction since the last index is not an APPEND"
    old_pks, md = prior["pks"], pf.metadata
    skip, ends, start = [], [], 0
    for g, fp in enumerate(_fingerprints(pf)):
        n = md.row_group(g).num_rows
        if g >= len(meta["groups"]) or fp != meta["groups"][g] or start + n > len(old_pks):
            break
        skip.append(g)
        start += n
        ends.append(start)
    if not skip:
        return set(), "the first row group changed (rows were appended to it)"
    force, dele = prior["force"], prior.get("dele")
    last = {k: j for j, k in enumerate(old_pks)} if changelog is not None else None
    need = set()
    for j in range(start):
        pk = old_pks[j]
        if pk in (None, "") or (last is not None and last.get(pk) != j) or (dele is not None and dele[j]):
            continue
        if pk in force or pk not in old:
            need.add(bisect.bisect_right(ends, j))
    return set(skip) - need, None


# Files stamps updated_at to the second: a version read less than this long after its stamp may be rewritten under
# the same stamp, so the watcher confirms it once by content hash (see _pending)
SETTLE_SECONDS = 2.0


def _settled(stamp: Any, at: float) -> bool:
    return not hasattr(stamp, "timestamp") or at - stamp.timestamp() >= SETTLE_SECONDS


def _version(info: dict) -> dict:
    """The dataset version an index read, as kept on the datasource."""
    return {"dataset_updated_at": info["updated_at"], "dataset_sha1": info.get("sha1"), "dataset_settled": info.get("settled", True)}


def _column(f: Any) -> dict:
    import pyarrow as pa

    import pipeline_datasets

    t, array = f.type, False
    if pa.types.is_list(t) or pa.types.is_large_list(t):
        t, array = t.value_type, True
    if pa.types.is_struct(t) or pa.types.is_map(t) or pa.types.is_list(t):
        return {"name": f.name, "type": str(f.type), "property_type": None, "array": array, "supported": False}
    kind = pipeline_datasets._column_type(t)
    ptype = SCALAR.get(kind)
    return {"name": f.name, "type": f"Array<{kind}>" if array else kind, "property_type": ptype, "array": array, "supported": ptype is not None}


def _cell(v: Any) -> Any:
    import datetime as dt
    import decimal

    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, list):
        return [_cell(x) for x in v]
    return v


def _read(dataset_id: str) -> tuple[dict, list[dict], list[dict]]:
    info, table = _table(dataset_id)
    if table.num_rows > max_rows():
        raise HTTPException(400, f"the dataset has {table.num_rows:,} rows; at most {max_rows():,} objects are indexed (BLUESANDAI_ONTOLOGY_MAX_ROWS)")
    cols = [_column(f) for f in table.schema]
    rows = [{k: _cell(v) for k, v in r.items()} for r in table.to_pylist()]
    return info, cols, rows


def _unique(rows: list[dict], col: str) -> bool:
    keys = [r.get(col) for r in rows]
    return all(k not in (None, "") for k in keys) and len(set(map(str, keys))) == len(keys)


def _api(name: str) -> str:
    """A column's property API name: its own name when that is a valid API name (rasio_rujukan_pct stays), else camelCase."""
    if ontology.IDENT.match(name) and len(name) <= 100 and name.lower() not in ontology.RESERVED_API_NAMES:
        return name
    return ontology._api_name(name, False)


def _display(col: str) -> str:
    return col.replace("_", " ").strip().capitalize() or col


def _registered(dataset_id: str, except_type: Optional[str] = None) -> Optional[dict]:
    return next((t for t in ontology._all("object-types") if (t.get("backing_dataset") or {}).get("dataset_id") == dataset_id and t["id"] != except_type), None)


@router.get("/datasets/{dataset_id}/schema")
def dataset_schema(dataset_id: str) -> dict:
    info, cols, rows = _read(dataset_id)
    for c in cols:
        c["unique"] = c["supported"] and not c["array"] and _unique(rows, c["name"])
        c["api_name"] = _api(c["name"])
        c["display_name"] = _display(c["name"])
        c["sample"] = [r.get(c["name"]) for r in rows[:3]]
    used = _registered(dataset_id)
    return {**info, "rows": len(rows), "columns": cols, "registered_by": {"id": used["id"], "display_name": used["display_name"]} if used else None}


def errors(t: dict, cols: list[dict], rows: Optional[list[dict]], mapping: dict[str, str], changelog: Optional[dict] = None) -> list[dict]:
    """Schema errors of a datasource mapping, named like the indexer's. changelog: the datasource's changelog settings
    (duplicate primary keys allowed, the deletion column must be a Boolean column)."""
    out = []
    by_col = {c["name"]: c for c in cols}
    delcol = (changelog or {}).get("deletion_column")
    if delcol:
        c = by_col.get(delcol)
        if c is None:
            out.append({"code": "DeletionColumnNotFound", "column": delcol, "message": f"the dataset has no column {delcol} (the changelog's deletion column)"})
        elif c["property_type"] != "boolean" or c["array"]:
            out.append({"code": "DeletionColumnNotBoolean", "column": delcol, "message": f"{delcol} is a {c['type']} column; a deletion column must be Boolean"})
    props = {p["api_name"]: p for p in t["properties"]}
    for col, api in mapping.items():
        c, p = by_col.get(col), props.get(api)
        if p is None:
            out.append({"code": "PropertyNotFound", "column": col, "message": f"the column {col} backs {api}, which is not a property"})
            continue
        if c is None:
            out.append({"code": "FoundryColumnNameNotFound", "column": col, "message": f"the dataset has no column {col} (it backs {p['display_name']})"})
            continue
        if not c["supported"]:
            out.append({"code": "UnsupportedColumnType", "column": col, "message": f"{col} is a {c['type']} column: map and struct columns cannot back properties"})
            continue
        if p.get("derived"):
            out.append({"code": "DerivedPropertyMapped", "column": col, "message": f"{p['display_name']} is derived and cannot be backed by a column"})
            continue
        ok_type = p["type"] in ACCEPTS.get(c["property_type"], set())
        ok_array = bool(p.get("array")) == bool(c["array"]) or (c["property_type"] == "string" and not c["array"])
        if not (ok_type and ok_array):
            out.append({"code": "FieldTypeIncompatibleWithPropertyType", "column": col,
                        "message": f"{col} is a {c['type']} column; {p['display_name']} is a {p['type']}{' array' if p.get('array') else ''}"})
    if t["primary_key"] not in mapping.values():
        out.append({"code": "PrimaryKeyNotMapped", "column": None, "message": f"map a column to the primary key {t['primary_key']}"})
    elif rows is not None and not changelog:
        col = next(c for c, a in mapping.items() if a == t["primary_key"])
        if col in by_col and not _unique(rows, col):
            out.append({"code": "DuplicatePrimaryKey", "column": col, "message": f"{col} backs the primary key but is not unique and set on every row"})
    return out


def _import(t: dict, info: dict, pf: Any, mapping: dict[str, str], reuse: bool = True) -> int:
    """Replaces the objects with the dataset's rows. Edit-only properties, and properties no column backs, keep their
    edited values for primary keys still in the data; values that do not fit their property are null (and reported),
    or fail the whole index when the datasource's invalid_values is "fail" (see "disallowed dataset values"). Incremental:
    objects whose values did not change keep their record (and updated_at), and nothing is written when no object
    changed. reuse: objects whose row did not change since the last index are not built again (see _prior); the
    objects are the same either way."""
    started = time.perf_counter()
    loaded: dict[str, dict] = {}

    def load_old() -> dict:
        if "old" not in loaded:
            loaded["old"] = ontology.load_objects(t["id"])
        return loaded["old"]

    mapped = set(mapping.values())
    kept = {p["api_name"] for p in t["properties"] if p.get("edit_only") or p["api_name"] not in mapped}
    props_by = {p["api_name"]: p for p in t["properties"]}
    pk_col = next(c for c, a in mapping.items() if a == t["primary_key"])
    changelog = (t.get("backing_dataset") or {}).get("changelog")
    delcol = (changelog or {}).get("deletion_column")
    # disallowed values: indexed as null, or the whole index fails (see "disallowed dataset values")
    mode = _invalid_mode(t.get("backing_dataset"))
    strict = mode == "fail"
    vts = _value_types(t, mapping) if strict else {}
    sig = _rows_sig(t, info["id"], mapping, pf, changelog, _checks_sig(mode, vts))
    prior = _prior(t, sig, lambda: load_old()) if reuse else None
    if prior and delcol and prior.get("dele") is None:
        prior = None
    # the stored keys without loading the objects, when the store is as the last index left it (see _stored_keys);
    # until the objects are assembled `old` is only asked which keys are stored
    old_keys = _stored_keys(prior) if prior and prior["same_store"] and "old" not in loaded else None
    old: Any = load_old() if old_keys is None else old_keys
    tx_now = _tx_now(info, pf)
    skip, why = _plan(info, pf, prior, old, changelog, tx_now) if prior else (set(), None)
    # row groups whose bytes an indexed group had (see "snapshot re-index without reading what did not change")
    same_groups = _reusable(prior, old, changelog, _scan_cols(pf, mapping, changelog)) if prior else {}
    sc = _scan(info, pf, mapping, pk_col, prior, old, changelog, skip, same_groups)
    pks, hashes, build, path, dele = sc["pks"], sc["hashes"], sc["build"], sc["path"], sc["dele"]
    if not changelog and (None in pks or "" in pks or len(set(pks)) != len(pks)):
        rep = _pk_report(pks, pk_col, t["primary_key"], mode)
        _fail_invalid(t, rep, "DuplicatePrimaryKey", f"{pk_col} backs the primary key but is not unique and set on every row ({rep.summary()})")
    if strict and changelog is not None and (None in pks or "" in pks):
        # (a changelog row without a key is skipped in "null" mode)
        rep = _pk_report(pks, pk_col, t["primary_key"], mode, dups=False)
        _fail_invalid(t, rep, "InvalidPropertyValues", f"{rep.total:,} value{'s' if rep.total != 1 else ''} the properties do not allow ({rep.summary()}); nothing was indexed")
    # the row standing for each object: its key's last row (a changelog's latest version; other datasources have one)
    last: dict[str, int] = {}
    for i, pk in enumerate(pks):
        if pk not in (None, ""):
            last[pk] = i
    stale = False
    if changelog is not None and sc["reused"]:
        # a reused changelog row now its key's last row must have been its last row at the last index (else the stored
        # object is a later version, which this file no longer has)
        old_last = {k: j for j, k in enumerate(prior["pks"])}
        stale = any(last.get(pks[s + j]) == s + j and old_last.get(pks[s + j]) != o + j for s, o, n in sc["reused"] for j in range(n))
    # (a row read is built whenever its key is not stored: only rows of unread groups can lack an object)
    if stale or (skip or sc["reused"]) and any(build.get(i) is None and pk not in old and not (dele is not None and dele[i]) for pk, i in last.items()):
        # a row of an unread row group whose object is not stored (cannot happen: _plan and _reusable leave those), or
        # a reused changelog row whose key's last version was removed: read everything
        skip, why = set(), "an unread row had no stored object" if not stale else "a reused changelog row is its key's last row now"
        logging.getLogger("bluesandai.ontology_datasources").warning("re-index of %s: %s; every row read", t["id"], why)
        old_keys, old = None, load_old()
        sc = _scan(info, pf, mapping, pk_col, None, old, changelog)
        pks, hashes, build, path, dele = sc["pks"], sc["hashes"], sc["build"], sc["path"], sc["dele"]
        last = {}
        for i, pk in enumerate(pks):
            if pk not in (None, ""):
                last[pk] = i
    read = {"mode": "full" if not prior or path == "full" else "append" if skip else "compare", "source": "changelog" if changelog is not None else "dataset",
            "ranged": (getattr(pf, "_bsai", None) or {}).get("src") is not None, "bytes": _bytes_read(pf), "size": info["size"],
            "row_groups": pf.num_row_groups, "row_groups_read": sc["groups_read"], "rows": len(pks), "rows_read": sc["rows_read"],
            **({"deleted": sum(1 for i in last.values() if dele[i])} if dele is not None else {}),
            **({"row_groups_reused": len(sc["reused"])} if sc["reused"] else {}),
            **({"copy": src_copy} if (src_copy := getattr((getattr(pf, "_bsai", None) or {}).get("src"), "copy", None)) else {}),
            **({"why_all_read": why} if why and prior else {})}  # (why the append-only read did not apply, reused groups or not)
    # the keys the rows stand for (a changelog key whose last row is a deletion is not one)
    live = {pk for pk, i in last.items() if dele is None or not dele[i]}
    # objects assembled for the touched keys only (see "re-index without loading every object" below): the rows built,
    # the stored keys gone from the rows, the keys with user edits; every other key is a row unchanged since the last
    # index, whose object a whole assembly would find equal to the stored one and keep
    touched = ({pks[i] for i in build} | (old_keys - live) | _layer_keys(t["id"])) if old_keys is not None else None
    while True:
        if touched is not None:
            import ontology_store

            # (only keys the store holds: an APPEND's new keys would otherwise read every shard they hash to)
            old = ontology_store.get_many(t["id"], touched & old_keys)
            totals = (len(old_keys), len(live))
        else:
            old, totals = load_old(), None
        now = ontology._now()
        objs: dict[str, dict] = {}
        dirty: set[int] = set()  # rows whose values the indexing checks change (built again on every index)
        # disallowed values of the rows built: row position -> [(column, property, kind, value, reason)]
        row_inv: dict[int, list] = {}
        for pk, i in last.items():
            if dele is not None and dele[i]:
                continue  # deleted by the changelog
            if touched is not None and pk not in touched:
                continue
            r = build.get(i)
            prev = old.get(pk)
            if r is None:
                # the row did not change since the last index: the object as stored (a new record, as a rebuilt one)
                objs[pk] = {"properties": dict(prev.get("properties") or {}), "created_at": prev.get("created_at", now), "updated_at": now}
                continue
            values = {}
            ents: list = []
            for col, api in mapping.items():
                p = props_by[api]
                if p.get("edit_only"):
                    continue
                raw = r.get(col)
                try:
                    v = raw if p["type"] == "media" else ontology.coerce_property({**p, "value_type_id": None}, raw, api)
                except HTTPException as e:
                    # a value its property does not allow: null, or (strict) the index fails after every row is checked
                    v = None
                    reason = str(e.detail)
                    ents.append((col, api, "InvalidValue", _short(raw), reason[len(api) + 2:] if reason.startswith(f"{api}: ") else reason))
                else:
                    if strict:
                        why = _vt_error(vts.get(p["value_type_id"]), v) if v is not None and p.get("value_type_id") else None
                        if why:
                            ents.append((col, api, "ValueTypeConstraint", _short(raw), why))
                        elif p.get("required") and ontology._empty(p, v):
                            ents.append((col, api, "RequiredPropertyNull", _short(raw), f"{p.get('display_name') or api} is required: its column {col} is null"))
                values[api] = v
            if ents:
                row_inv[i] = ents
            if any(_dirty(v) for v in values.values()):
                dirty.add(i)
            if prev:
                values.update({k: v for k, v in (prev.get("properties") or {}).items() if k in kept and k not in values})
            objs[pk] = {"properties": values, "created_at": (prev or {}).get("created_at", now), "updated_at": now}
        if strict and row_inv:
            invalid = _collect(mode, pks, row_inv)
            _fail_invalid(t, invalid, "InvalidPropertyValues", f"{invalid.total:,} value{'s' if invalid.total != 1 else ''} the properties do not allow ({invalid.summary()}); nothing was indexed")
        if prior and not strict:
            # "null" mode: rows not built this time hold the disallowed values the hash file kept for their key (an unbuilt
            # row has the content of the indexed row with that key), so the report covers every row
            for k, js in (prior["meta"].get("inv_by_pk") or {}).items():
                j = last.get(k)
                if j is not None and j not in build and j not in row_inv and not (dele is not None and dele[j]):
                    row_inv[j] = [tuple(x) for x in json.loads(js)]
        invalid = _collect(mode, pks, row_inv)
        if touched is None:
            # column-wise multi-datasource object types: the other datasets' columns (ontology_mdo.py; such types are
            # always assembled whole: they have no row hashes)
            objs = ontology._hook("mdo_rows", t, objs) or objs
        # the Funnel-style pipeline (ontology_indexing.py): changelog and data restrictions, then the edits merged
        try:
            run = ontology._hook("index_begin", t, old, objs, mapping, totals)
        except HTTPException as e:
            ontology._hook("index_failed", t, str(e.detail))
            e.index_recorded = True  # the failed run is in the indexing runs already (see _check)
            raise
        if run and invalid.total:
            # "null" mode: the disallowed values indexed as null, counted (kept per row in the hash file, see above)
            per: dict[str, int] = {}
            for (col, api, code), n in invalid.counts.items():
                per[f"{api}: values its type does not allow → null"] = per.get(f"{api}: values its type does not allow → null", 0) + n
            run["warnings"] = (run.get("warnings") or []) + [{"message": k, "count": n} for k, n in per.items()]
            run["invalid_values"] = invalid.report()
        # user edits win over the rows (or the most recent value wins): ontology_edits.py
        objs = ontology._hook("merge_edits", t, objs) or objs
        changed = set()
        for pk, o in objs.items():
            prev = old.get(pk)
            if prev and (prev.get("properties") or {}) == (o.get("properties") or {}):
                objs[pk] = prev
            else:
                changed.add(pk)
        removed = [pk for pk in old if pk not in objs]
        total = len(objs) + (len(live - touched) if touched is not None else 0)
        if (changed or removed) and touched is not None:
            if not _save_some(t["id"], objs, changed.union(removed), total).get("whole_set_needed"):
                break
            touched = None  # an unshard or a re-shard writes the whole set: assemble it whole
            continue
        if changed or removed:
            ontology.save_objects(t["id"], objs, changed.union(removed))
        break
    unchanged = total - len(changed)
    if run:
        # the changelog as applied, with the user edits merged (index_begin counted the rows before the merge, so an
        # object a user created, edited or deleted showed as removed / modified / added on every run)
        added = sum(1 for pk in changed if pk not in old)
        run.update({"unchanged": unchanged, "added": added, "modified": total - unchanged - added, "removed": len(removed),
                    "rows_built": len(build), "rows_path": path, "read": read, "objects_total": total})
    if hashes is not None and len(hashes) == len(pks) and not t.get("additional_datasources"):
        # what the store holds besides the rows' keys, and which of them it lacks (user edits): with the row keys this
        # is the stored key set the next index starts from without loading the objects
        if touched is not None:
            absent, extra = [pk for pk in live & touched if pk not in objs], [pk for pk in objs if pk not in live]
        else:
            absent, extra = list(live - objs.keys()), list(objs.keys() - live)
        _save_rows(t["id"], {"v": ROWS_FORMAT, "sig": sig, "hasher": _hasher(), "store": _store_mark(t["id"]), "layer": sorted(_layer_keys(t["id"])),
                             "dataset_sha1": info.get("sha1"), "at": now, "tx": (tx_now or {}).get("id"), "groups": _fingerprints(pf),
                             "gh": sc["gh"], "gcols": sc["gcols"], "absent": sorted(absent), "extra": sorted(extra), "inv": 1},
                   pks, hashes, [i in dirty for i in range(len(pks))] if dirty else None, dele, row_inv)
    else:
        _drop_rows(t["id"])
    LAST.clear()
    LAST.update({"type_id": t["id"], "path": path, "rows": len(pks), "rows_built": len(build), "written": len(changed) + len(removed),
                 "read": read, "assembled": "touched" if touched is not None else "whole", "objects_loaded": len(old),
                 "ms": int((time.perf_counter() - started) * 1000)})
    try:
        # usage accounting only (ontology_model.record_indexing): the objects are saved already, so a failure here (usage.json
        # held by another process) must not fail the run, skip index_end / reindexed, or stop the watcher from retrying
        ontology._hook("indexed", t["id"], total)
    except Exception:  # noqa: BLE001
        logging.getLogger("bluesandai.ontology_datasources").exception("indexing usage not recorded for %s", t["id"])
    if run:
        ontology._hook("index_end", t, run, objs)
    ontology._hook("reindexed", t["id"])
    return total


class ColumnIn(BaseModel):
    column: str
    api_name: str = Field(max_length=100)
    display_name: str = Field(max_length=200)
    type: Optional[str] = None
    array: Optional[bool] = None


class FromDatasetIn(BaseModel):
    dataset_id: str
    display_name: str = Field(min_length=1, max_length=200)
    plural_name: Optional[str] = None
    api_name: Optional[str] = None
    description: str = ""
    icon: Optional[str] = None
    color: Optional[str] = None
    ontology_id: Optional[str] = None
    groups: list[str] = []
    primary_key: str  # a column
    title_property: Optional[str] = None  # a column
    columns: list[ColumnIn]  # the columns to map (others are left out: curate intentionally)
    generate_actions: list[str] = []  # create / modify / delete
    auto_reindex: bool = True
    # a changelog dataset: rows are versions of objects (the last row per primary key wins), deleted where the
    # deletion column (Boolean) is true
    changelog: bool = False
    deletion_column: Optional[str] = None
    # a dataset value its property does not allow: indexed as null (default) or the whole index fails (see "disallowed
    # dataset values")
    invalid_values: Literal["null", "fail"] = "null"


def _changelog_of(on: Optional[bool], deletion_column: Optional[str], current: Optional[dict] = None) -> Optional[dict]:
    """The datasource's changelog settings: on None keeps the current ones (a deletion column given changes it)."""
    if on is None:
        if current is not None and deletion_column is not None:
            return {"deletion_column": deletion_column or None}
        return current
    return {"deletion_column": deletion_column or None} if on else None


@router.post("/object-types/from-dataset")
def create_from_dataset(req: FromDatasetIn) -> dict:
    info, pf = _open(req.dataset_id)
    cols = _columns(pf)
    used = _registered(req.dataset_id)
    if used:
        raise HTTPException(409, f"DatasetAndBranchAlreadyRegistered: the dataset already backs {used['display_name']}")
    by_col = {c["name"]: c for c in cols}
    chosen = {c.column: c for c in req.columns}
    changelog = _changelog_of(req.changelog, req.deletion_column)
    if req.primary_key not in chosen:
        raise HTTPException(400, "map the primary key column")
    if req.primary_key not in by_col or (not changelog and not _pk_unique(info, pf, req.primary_key)):
        raise HTTPException(400, f"DuplicatePrimaryKey: {req.primary_key} must be unique and set on every row to be the primary key")
    props, mapping = [], {}
    for c in req.columns:
        col = by_col.get(c.column)
        if not col:
            raise HTTPException(400, f"FoundryColumnNameNotFound: the dataset has no column {c.column}")
        if not col["supported"]:
            raise HTTPException(400, f"UnsupportedColumnType: {c.column} is a {col['type']} column; map and struct columns cannot back properties")
        ptype = c.type or col["property_type"]
        if c.column == req.primary_key and ptype not in ("string", "integer", "long", "short"):
            ptype = "string"
        props.append(ontology.Property(api_name=c.api_name, display_name=c.display_name, type=ptype, array=(c.array if c.array is not None else col["array"]) or None))
        mapping[c.column] = c.api_name
    title = chosen[req.title_property].api_name if req.title_property in chosen else mapping[req.primary_key]
    created = ontology.create_object_type(ontology.ObjectTypeIn(
        display_name=req.display_name, plural_name=req.plural_name, api_name=req.api_name, description=req.description or f"Backed by {info['name']}",
        icon=req.icon, properties=props, primary_key=mapping[req.primary_key], title_property=title, generate_primary_key=False,
        groups=req.groups, ontology_id=req.ontology_id))
    with ontology._lock:
        t = ontology._get("object-types", created["id"], "object type")
        if req.color:
            t["color"] = req.color
        errs = _errors(t, cols, info, pf, mapping, changelog)
        if errs:
            ontology._path("object-types", t["id"]).unlink(missing_ok=True)
            raise HTTPException(400, f"{errs[0]['code']}: {errs[0]['message']}")
        t["backing_dataset"] = {"dataset_id": req.dataset_id, "name": info["name"], "columns": mapping, "synced_at": ontology._now(),
                                **_version(info), "auto_reindex": req.auto_reindex, **({"changelog": changelog} if changelog else {}),
                                **({"invalid_values": "fail"} if req.invalid_values == "fail" else {})}
        try:
            with _triggered("initial"):
                n = _import(t, info, pf, mapping)
        except HTTPException as e:
            if getattr(e, "schema_errors", None):
                # (as for schema errors above: the type is not created; its failed run goes with it)
                ontology._path("object-types", t["id"]).unlink(missing_ok=True)
                with contextlib.suppress(OSError):
                    (ontology.DIR / "indexing" / f"{t['id']}.json").unlink()
            raise
        ontology._put("object-types", t)
    for kind in req.generate_actions:
        if kind in ("create", "modify", "delete"):
            ontology.create_action_type(ontology.ActionTypeIn(object_type_id=t["id"], kind=kind))
    return {**ontology.get_object_type(t["id"]), "imported": n}


class PipelineOutputIn(BaseModel):
    """An object type output of a Pipeline Builder deploy: its dataset, columns and the interfaces it implements."""
    dataset_id: str
    api_name: str
    display_name: Optional[str] = None
    plural_name: Optional[str] = None
    description: str = ""
    primary_key: str  # a column
    title_property: Optional[str] = None  # a column
    columns: list[ColumnIn]
    # [{interface_id, mapping: {interface property: property API name}}]
    interfaces: list[dict] = []
    ontology_id: Optional[str] = None


@router.post("/object-types/from-pipeline-output")
def from_pipeline_output(req: PipelineOutputIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Register (first deploy) or re-index (later deploys) the object type a pipeline output backs, then set the
    interfaces it implements (validated like any implementation: every required interface property mapped to a
    property of a compatible type)."""
    existing = _registered(req.dataset_id)
    # the build runner registering its output's object type (X-Bsai-Build): as the build's identity — it reads the
    # output dataset, and edits the object type (its markings, Editor in its ontology) or creates one in the ontology
    import build_calls

    build_calls.enforce(request, ("read", "item", req.dataset_id, None),
                        ("write", "object_type", existing["id"], req.api_name) if existing else ("write", "ontology", req.ontology_id, None))
    if existing:
        imported = reindex(existing["id"])["imported"]
        tid, created = existing["id"], False
    else:
        r = create_from_dataset(FromDatasetIn(dataset_id=req.dataset_id, display_name=req.display_name or req.api_name, plural_name=req.plural_name,
                                              api_name=req.api_name, description=req.description, primary_key=req.primary_key,
                                              title_property=req.title_property, columns=req.columns, ontology_id=req.ontology_id))
        tid, created, imported = r["id"], True, r["imported"]
    impls = [{"interface_id": i["interface_id"], "mapping": {k: v for k, v in (i.get("mapping") or {}).items() if v}} for i in req.interfaces if i.get("interface_id")]
    try:
        ontology.update_object_type(tid, ontology.ObjectTypeIn.model_construct(implements=impls))
    except HTTPException as e:
        raise HTTPException(e.status_code, f"the object type was {'registered' if created else 're-indexed'}, but implementing the interfaces failed: {e.detail}") from None
    return {**ontology.get_object_type(tid), "created": created, "imported": imported}


@router.get("/object-types/{type_id}/datasource")
def get_datasource(type_id: str) -> dict:
    with ontology._lock:
        t = ontology._object_type(type_id)
    b = t.get("backing_dataset")
    if not b:
        return {"backing": None}
    if b.get("storage") == "live":
        import ontology_live

        return ontology_live.describe(type_id)
    try:
        info, cols, rows = _read(b["dataset_id"])
    except HTTPException as e:
        return {"backing": b, "columns": [], "errors": [{"code": "DatasetNotFound", "column": None, "message": str(e.detail)}], "unmapped_columns": [],
                "unmapped_properties": [], "stale": False}
    mapping = b["columns"]
    by_api = {a: c for c, a in mapping.items()}
    for c in cols:
        c["property"] = mapping.get(c["name"])
    errs = errors(t, cols, rows, mapping, b.get("changelog"))
    # the last re-index's failure on disallowed values (kept on the datasource until an index succeeds) with its report
    for e in b.get("errors") or []:
        if isinstance(e, dict) and e.get("report"):
            same = next((x for x in errs if x["code"] == e["code"] and x.get("column") == e.get("column")), None)
            if same:
                same["report"] = e["report"]
            else:
                errs.append(e)
    return {"backing": b, "dataset": info, "rows": len(rows), "columns": cols, "errors": errs,
            "unmapped_columns": [c["name"] for c in cols if c["name"] not in mapping and c["supported"]],
            "unmapped_properties": [p["api_name"] for p in t["properties"] if p["api_name"] not in by_api and not p.get("derived")],
            "stale": info["updated_at"] != b.get("dataset_updated_at")}


class LiveDatasourceIn(BaseModel):
    """A live datasource (ontology_live): the type's objects are read straight from the dataset, never indexed."""
    dataset_id: str
    # column → property API name; omitted: columns with a property of the same name
    columns: Optional[dict[str, str]] = None
    map_unmapped: bool = False  # create properties for the other supported columns


@router.put("/object-types/{type_id}/datasource/live")
def put_live_datasource(type_id: str, req: LiveDatasourceIn) -> dict:
    """Back an empty object type by a local Parquet dataset as a live type: no row limit, no index, the dataset is
    read on every query (see ontology_live)."""
    import ontology_live

    with reindex_lock(type_id):
        return ontology_live.back(type_id, req.dataset_id, req.columns, req.map_unmapped)


class DatasourceIn(BaseModel):
    dataset_id: str
    # column → property API name; omitted: keep the current mapping, auto-mapping columns with the same names
    columns: Optional[dict[str, str]] = None
    map_unmapped: bool = False  # create properties for the columns no property maps
    auto_reindex: Optional[bool] = None
    # a changelog dataset (see FromDatasetIn); None keeps the current setting
    changelog: Optional[bool] = None
    deletion_column: Optional[str] = None
    # disallowed values: "null" (default) or "fail" the whole re-index; None keeps the current setting
    invalid_values: Optional[Literal["null", "fail"]] = None


@router.put("/object-types/{type_id}/datasource")
def put_datasource(type_id: str, req: DatasourceIn) -> dict:
    with reindex_lock(type_id):  # (indexes the type: in turn with its other re-indexes, see reindex_lock)
        return _put_datasource(type_id, req)


def _put_datasource(type_id: str, req: DatasourceIn) -> dict:
    info, pf = _open(req.dataset_id)
    cols = _columns(pf)
    with ontology._lock:
        t = ontology._object_type(type_id)
        used = _registered(req.dataset_id, type_id)
        if used:
            raise HTTPException(409, f"DatasetAndBranchAlreadyRegistered: the dataset already backs {used['display_name']}")
        old = t.get("backing_dataset") or {}
        names = {c["name"] for c in cols}
        props = {p["api_name"] for p in t["properties"]}
        if req.columns is not None:
            mapping = {c: a for c, a in req.columns.items() if a}
        else:
            # keep the mapping for columns that still exist, auto-map the rest by name
            mapping = {c: a for c, a in (old.get("columns") or {}).items() if c in names}
            for c in cols:
                if c["name"] not in mapping and c["name"] in props and c["name"] not in mapping.values():
                    mapping[c["name"]] = c["name"]
        if req.map_unmapped:
            new_props = []
            for c in cols:
                if c["name"] in mapping or not c["supported"]:
                    continue
                api = _api(c["name"])
                while api in props:
                    api += "_"
                new_props.append({"api_name": api, "display_name": _display(c["name"]), "type": c["property_type"], "description": "", **({"array": True} if c["array"] else {})})
                props.add(api)
                mapping[c["name"]] = api
            if new_props:
                t["properties"] = t["properties"] + new_props
                for p in new_props:
                    ontology._check_property(p)
        changelog = _changelog_of(req.changelog, req.deletion_column, old.get("changelog"))
        errs = _errors(t, cols, info, pf, mapping, changelog)
        if errs:
            raise HTTPException(400, f"{errs[0]['code']}: {errs[0]['message']}")
        # properties no column backs any longer only change through edits
        t["backing_dataset"] = {"dataset_id": req.dataset_id, "name": info["name"], "columns": mapping, "synced_at": ontology._now(),
                                **_version(info),
                                "auto_reindex": old.get("auto_reindex", True) if req.auto_reindex is None else req.auto_reindex,
                                **({"changelog": changelog} if changelog else {}),
                                **({"invalid_values": "fail"} if (req.invalid_values or _invalid_mode(old)) == "fail" else {})}
        with _triggered("datasource changed"):
            n = _import(t, info, pf, mapping)
        ontology._put("object-types", t)
    return {**get_datasource(type_id), "imported": n}


class GenerateIn(BaseModel):
    # where the dataset is created (default: the documents folder) and its name (default: the object type's name)
    folder_id: Optional[str] = None
    name: Optional[str] = Field(None, max_length=200)


@router.post("/object-types/{type_id}/datasource/generate")
def generate_datasource(type_id: str, req: GenerateIn) -> dict:
    """A generated backing dataset for an object type without one: an empty Parquet dataset in Files with a column per
    property (named by API name, typed like the property), registered as the type's datasource. Only for a type that
    has no objects yet (a re-index from an empty dataset would otherwise decide what happens to them)."""
    import drive
    import pipeline_datasets
    import pyarrow as pa

    t = ontology._object_type(type_id)
    if t.get("backing_dataset"):
        raise HTTPException(409, f"{t['display_name']} already has a backing dataset")
    if ontology._objects(type_id):
        raise HTTPException(409, f"{t['display_name']} already has objects: back it with a dataset that holds them")
    arrow = {"string": pa.string(), "integer": pa.int64(), "long": pa.int64(), "short": pa.int32(), "byte": pa.int32(), "double": pa.float64(), "float": pa.float64(),
             "decimal": pa.float64(), "boolean": pa.bool_(), "date": pa.date32(), "timestamp": pa.timestamp("us", tz="UTC")}
    cols = [p for p in t["properties"] if not p.get("derived") and p["type"] in arrow]
    if not any(p["api_name"] == t["primary_key"] for p in cols):
        raise HTTPException(400, "the primary key's type cannot be a dataset column")
    schema = pa.schema([(p["api_name"], pa.list_(arrow[p["type"]]) if p.get("array") else arrow[p["type"]]) for p in cols])
    folder = drive._folder_id(req.folder_id) if req.folder_id else drive.default_folder("documents")
    name = drive._clean_name((req.name or t["display_name"]).strip() or "object type")
    item = drive.save_bytes(folder, f"{name}.parquet", pipeline_datasets._parquet_bytes(schema.empty_table()), pipeline_datasets.PARQUET)
    out = put_datasource(type_id, DatasourceIn(dataset_id=item["id"], columns={p["api_name"]: p["api_name"] for p in cols}))
    return {**out, "dataset": {"id": item["id"], "name": item["name"]}}


@router.delete("/object-types/{type_id}/datasource")
def delete_datasource(type_id: str) -> dict:
    import ontology_live

    with reindex_lock(type_id), ontology._lock:  # (after a running re-index: it would write the row hashes again)
        t = ontology._object_type(type_id)
        t.pop("backing_dataset", None)
        ontology_live.drop(type_id)  # a live type has no objects without its dataset (its edits are kept)
        ontology._put("object-types", t)
        _drop_rows(type_id)
    return {"backing": None}


# ------------------------------------------------------------------------------------------------
# one re-index of an object type at a time, across threads and processes
#
# Every process serving the same data directory runs a watcher (the API, and anything that imports server.py, such as
# in-process tests), and a user can re-index by hand meanwhile. Without a lock two of them could re-index one type at
# once, or one re-index a version another has just indexed (it decided from the type as it was before that index): a
# second run with nothing to do, and a read of the row hashes / objects another run is rewriting. A re-index holds the
# type's lock: a byte of indexing/.reindex.lock (from the type id) locked by the OS, released when its holder exits,
# plus a re-entrant hold within the process. The watcher waits for a type whose lock is held (at most
# WATCH_LOCK_WAIT_SECONDS, then the next pass looks again) and, once it holds it, decides again from the type as stored
# then: usually the holder indexed that version and nothing is left to do. So a pass that returns has dealt with every
# change it found: what it reports and what is stored agree (a pass that skipped a held type returned while that type
# was still being re-indexed, its end state not yet written).
#
# One background watcher per data directory: the periodic pass runs in the process holding indexing/.watcher.lock
# (taken by the first process to try, kept until it exits; the others try again every period). Every process importing
# server.py starts the loop, so without it each one — the API, every in-process test and script — polled every
# auto type every 30 s and raced the others for each new version. watch_once() called directly runs in any process.
# ------------------------------------------------------------------------------------------------

_held: dict[str, list] = {}  # type id -> [owning thread id, depth]
_held_cv = threading.Condition()
_lock_files: dict[str, Any] = {}  # lock file path -> open handle (one per process: POSIX locks are per process)
# how long a re-index asked for (by a user, a pipeline deploy) waits for another one of the same type; after that it
# runs anyway (as before the lock), so a holder that never finishes cannot block it for good
LOCK_WAIT_SECONDS = 600.0
# how long the watcher's step waits for another holder of the type's lock (another watcher, a user's re-index)
WATCH_LOCK_WAIT_SECONDS = 30.0


def _lock_byte(type_id: str) -> int:
    return int(hashlib.sha1(type_id.encode("utf-8")).hexdigest()[:8], 16) & 0x7FFFFFFF


def _os_lock(type_id: str, lock: bool) -> bool:
    """Lock (or unlock) the type's byte of the data directory's lock file for this process; False when another process
    holds it. Called with _held_cv held (one handle per process, positioned before each call)."""
    ok = _file_lock(".reindex.lock", _lock_byte(type_id), lock)
    if not ok and not lock:
        logging.getLogger("bluesandai.ontology_datasources").warning("re-index lock of %s not released", type_id)
    return ok


def _file_lock(name: str, off: int, lock: bool) -> bool:
    """Lock (or unlock) byte `off` of the data directory's indexing/<name> for this process, without waiting; False
    when another process holds it. Callers serialize their calls (the handle is shared and positioned per call)."""
    path = ontology.DIR / "indexing" / name
    key = os.path.normcase(os.path.abspath(path))
    fh = _lock_files.get(key)
    if fh is None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = _lock_files[key] = open(path, "a+b")  # noqa: SIM115 - kept open for the process's life
    try:
        if os.name == "nt":
            import msvcrt

            fh.seek(off)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK if lock else msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.lockf(fh, (fcntl.LOCK_EX | fcntl.LOCK_NB) if lock else fcntl.LOCK_UN, 1, off, os.SEEK_SET)
        return True
    except OSError:
        return False


def _try_hold(type_id: str) -> bool:
    me = threading.get_ident()
    with _held_cv:
        h = _held.get(type_id)
        if h:
            if h[0] != me:
                return False
            h[1] += 1
            return True
        if not _os_lock(type_id, True):
            return False
        _held[type_id] = [me, 1]
        return True


def _release(type_id: str) -> None:
    with _held_cv:
        h = _held[type_id]
        h[1] -= 1
        if h[1] == 0:
            del _held[type_id]
            _os_lock(type_id, False)
            _held_cv.notify_all()


@contextlib.contextmanager
def reindex_lock(type_id: str, wait: Optional[float] = None):
    """Hold the type's re-index lock (re-entrant within a thread). wait: seconds to wait for another holder (0: do not
    wait; None: LOCK_WAIT_SECONDS). Yields whether it is held: False when it was still held elsewhere after `wait`."""
    deadline = time.monotonic() + (LOCK_WAIT_SECONDS if wait is None else wait)
    held = _try_hold(type_id)
    while not held and time.monotonic() < deadline:
        with _held_cv:  # woken at once by a holder in this process; another process's release is polled
            _held_cv.wait(min(0.1, max(0.0, deadline - time.monotonic())))
        held = _try_hold(type_id)
    try:
        yield held
    finally:
        if held:
            _release(type_id)


@router.post("/object-types/{type_id}/datasource/reindex")
def reindex(type_id: str) -> dict:
    with reindex_lock(type_id) as held:
        if not held:
            logging.getLogger("bluesandai.ontology_datasources").warning(
                "re-index of %s still running elsewhere after %.0f s: re-indexing anyway", type_id, LOCK_WAIT_SECONDS)
        with ontology._lock:
            t = ontology._object_type(type_id)
            b = t.get("backing_dataset")
        if not b:
            raise HTTPException(400, "this object type has no backing datasource")
        if b.get("storage") == "live":
            import ontology_live

            # nothing to index: the dataset is read on every query
            return {"object_type_id": type_id, "storage": "live", "imported": 0, "rows": ontology_live.count(type_id)}
        try:
            return _reindex(type_id, b, ranged=True)
        except _Changed:
            # the dataset was rewritten while it was read by ranges (nothing was written yet): read the new version whole
            logging.getLogger("bluesandai.ontology_datasources").info("dataset of %s rewritten during a ranged read; read whole", type_id)
            return _reindex(type_id, b, ranged=False)


def _reindex(type_id: str, b: dict, ranged: bool) -> dict:
    info, pf = _open(b["dataset_id"], ranged=ranged)
    cols = _columns(pf)
    with ontology._lock:
        t = ontology._object_type(type_id)
        # the primary key's uniqueness is checked by _import on the keys it scans (an append-only read does not decode
        # the old rows' key column again)
        errs = _errors(t, cols, info, pf, b["columns"], b.get("changelog"), pk=False)
        n = 0
        recorded = False
        if not errs:
            try:
                # a full re-index asked for (Indexing → Full re-index) builds every row, whatever the row hashes say
                n = _import(t, info, pf, b["columns"], reuse=_trigger() != "full")
            except HTTPException as e:
                if not getattr(e, "schema_errors", None):
                    raise
                errs = e.schema_errors
                recorded = getattr(e, "index_recorded", False)
        if errs:
            t["backing_dataset"] = {**b, "errors": errs}
            ontology._put("object-types", t)
            e = HTTPException(400, f"{errs[0]['code']}: {errs[0]['message']}")
            e.schema_errors = errs
            e.index_recorded = recorded  # (a failed run _import recorded: _check does not record it again)
            raise e
        t["backing_dataset"] = {**{k: v for k, v in b.items() if k != "failed_signature"}, "synced_at": ontology._now(),
                                **_version(info), "errors": []}
        ontology._put("object-types", t)
    return {"imported": n, "synced_at": t["backing_dataset"]["synced_at"]}


# why a backing dataset cannot be read at all (kept as the datasource's failed_signature)
MISSING = ("deleted", "in the trash")
# suffix of the failed_signature of a version that failed within SETTLE_SECONDS of its stamp
UNSETTLED = "|unsettled"


def _signature(t: dict, b: dict, item: dict) -> str:
    """What a failed re-index depended on: the dataset's version, the mapping and property types, the row limit. The
    watcher retries a failed re-index only when one of them changed."""
    import ontology_indexing

    return f"{item.get('updated_at')}|{ontology_indexing._schema(t, b.get('columns') or {})}|{max_rows()}"


def _pending(t: dict) -> Optional[dict]:
    """Change detection for one backed object type, without reading the dataset: one lookup of its Files item, whose
    updated_at changes with every content write (uploads, pipeline deploys, write_dataset transactions, rollbacks).
    None when there is nothing to do: the version is the indexed one, or the one whose failure is already reported.
    Otherwise {"item", "missing", "confirm"}: missing when the dataset is deleted or in the trash; confirm when the
    indexed version was read within SETTLE_SECONDS of its stamp (updated_at is stamped to the second, so the file may
    have been rewritten under the same stamp): its content hash is compared once, and it is re-indexed if it differs."""
    import db

    b = t.get("backing_dataset") or {}
    item = db.drive_get(b["dataset_id"])
    if not item or item.get("trashed_at"):
        missing = MISSING[1] if item else MISSING[0]
        return None if b.get("failed_signature") == missing else {"item": item, "missing": missing, "confirm": False}
    due = {"item": item, "missing": None, "confirm": False}
    failed, sig = b.get("failed_signature"), _signature(t, b, item)
    if failed in MISSING:
        return due  # the dataset is back: index it and clear the error
    fresh = not _settled(item.get("updated_at"), time.time())  # the stamp's second may still be written to
    if failed == sig:
        return None
    if failed == sig + UNSETTLED:
        return None if fresh else due  # failed on a version that could still change under its stamp: one retry
    if str(item.get("updated_at")) == b.get("dataset_updated_at"):
        if b.get("dataset_settled", True) or not b.get("dataset_sha1") or fresh:
            return None
        return {**due, "confirm": True}
    return due


def _check(t: dict) -> Optional[dict]:
    """The watcher's step for one object type: re-index it when its dataset has a new version. A failure (the dataset
    deleted, in the trash, unreadable or over the row limit, schema errors, data restrictions) is kept on the
    datasource (`errors`) and in the indexing runs once, and is not retried until the dataset, the mapping, the
    property types or the row limit change. Returns what was done (None: nothing to do, or still being re-indexed
    elsewhere after WATCH_LOCK_WAIT_SECONDS: the next pass looks again). A change that another holder of the type's lock
    dealt with while this step waited for it (another process's watcher, a user's re-index) is reported with its
    outcome as stored, marked "by": "another re-index": the change this step found has been dealt with."""
    if not _pending(t):
        return None
    with reindex_lock(t["id"], wait=WATCH_LOCK_WAIT_SECONDS) as held:
        if not held:
            return None
        # decided again from the type as stored now: another watcher or a user may have indexed this version since
        cur = ontology._read(ontology._path("object-types", t["id"]))
        b0 = t.get("backing_dataset") or {}
        cb = (cur or {}).get("backing_dataset") or {}
        if not cur or cb.get("dataset_id") != b0.get("dataset_id"):
            return _check_held(t)
        res = _check_held(cur)
        if res is None and _outcome(cb) != _outcome(b0):
            # indexed (or failed) by another holder since this step's copy of the type was read
            if cb.get("errors"):
                return {"object_type_id": t["id"], "status": "failed", "error": cb["errors"][0].get("message") or cb["errors"][0].get("code"),
                        "by": "another re-index"}
            return {"object_type_id": t["id"], "status": "indexed", "synced_at": cb.get("synced_at"), "by": "another re-index"}
        return res


def _outcome(b: dict) -> tuple:
    """What a re-index (or its failure) of a backing dataset leaves on it; a settle-only change (a confirmed content
    hash) leaves it as it was."""
    return (b.get("synced_at"), b.get("dataset_updated_at"), b.get("dataset_sha1"), b.get("failed_signature"), b.get("errors"))


def _check_held(t: dict) -> Optional[dict]:
    """_check with the type's re-index lock held."""
    due = _pending(t)
    if not due:
        return None
    b = t["backing_dataset"]
    item, tried_at = due["item"], time.time()
    try:
        if due["missing"]:
            raise HTTPException(404, f"DatasetNotFound: the backing dataset {b.get('name') or b['dataset_id']} is {due['missing']}")
        if due["confirm"]:
            import drive

            if hashlib.sha1(drive.read_bytes(item)).hexdigest() == b["dataset_sha1"]:
                with ontology._lock:
                    cur = ontology._read(ontology._path("object-types", t["id"]))
                    cb = (cur or {}).get("backing_dataset") or {}
                    if cb.get("dataset_updated_at") == b["dataset_updated_at"] and cb.get("dataset_sha1") == b["dataset_sha1"]:
                        cur["backing_dataset"] = {**cb, "dataset_settled": True}
                        ontology._put("object-types", cur)
                return None  # the indexed content is the current one
        token = _WATCHING.set(True)
        try:
            with _triggered("datasource update"):
                res = reindex(t["id"])
        finally:
            _WATCHING.reset(token)
        return {"object_type_id": t["id"], "status": "indexed", **res}
    except Exception as e:  # noqa: BLE001 - reported on the datasource, never stops the watcher
        message = str(e.detail) if isinstance(e, HTTPException) else f"{type(e).__name__}: {e}"
        code = message.split(":", 1)[0] if ":" in message and message.split(":", 1)[0].isalnum() else "DatasetNotIndexed"
        with ontology._lock:
            cur = ontology._read(ontology._path("object-types", t["id"]))
            cb = (cur or {}).get("backing_dataset")
            if not cb or cb.get("dataset_id") != b["dataset_id"]:
                return None  # deleted, detached or moved to another dataset meanwhile
            errs = getattr(e, "schema_errors", None) or [{"code": code, "column": None, "message": message}]
            sig = due["missing"] or _signature(cur, cb, item) + ("" if _settled(item.get("updated_at"), tried_at) else UNSETTLED)
            cur["backing_dataset"] = {**cb, "errors": errs, "failed_signature": sig}
            ontology._put("object-types", cur)
        # the one retry of a version that failed while it could still change: the same failure is not recorded twice
        repeat = b.get("failed_signature") == sig + UNSETTLED and (b.get("errors") or []) == errs
        if not repeat and not getattr(e, "index_recorded", False):
            # (disallowed values: their report on the run, see _fail_invalid)
            report = next((x["report"] for x in errs if isinstance(x, dict) and x.get("report")), None)
            with _triggered("datasource update"):
                ontology._hook("index_failed", cur, message, *([report] if report else []))
        return {"object_type_id": t["id"], "status": "failed", "error": message}


def watch_once() -> list[dict]:
    """One pass of the watcher over every object type with a backing dataset and auto re-index on: what was done."""
    import db

    out: list[dict] = []
    if not db.enabled():
        return out
    for t in ontology._all("object-types"):
        b = t.get("backing_dataset")
        if not b or not b.get("dataset_id") or not b.get("auto_reindex", True) or b.get("storage") == "live":
            continue
        try:
            done = _check(t)
        except Exception:  # noqa: BLE001 - one object type never stops the others
            logging.getLogger("bluesandai.ontology_datasources").exception("auto re-index check failed for %s", t.get("id"))
            continue
        if done:
            out.append(done)
    return out


_watch_leader: dict[str, bool] = {}  # lock file path -> whether this process is the data directory's watcher


def _is_watcher() -> bool:
    """Whether this process runs the data directory's periodic pass (see "one background watcher per data
    directory"): it holds indexing/.watcher.lock, or takes it now. BLUESANDAI_ONTOLOGY_WATCH_ALL=1: every process."""
    if os.environ.get("BLUESANDAI_ONTOLOGY_WATCH_ALL") == "1":
        return True
    key = os.path.normcase(os.path.abspath(ontology.DIR / "indexing" / ".watcher.lock"))
    with _held_cv:
        if not _watch_leader.get(key):
            _watch_leader[key] = _file_lock(".watcher.lock", 0, True)
        return _watch_leader[key]


def _watch() -> None:
    while True:
        time.sleep(30)
        try:
            if not _is_watcher():
                continue  # another process watches this data directory (taken over when it exits)
            watch_once()
        except Exception:  # noqa: BLE001 - the watcher outlives a failed pass (database down, unreadable type file)
            logging.getLogger("bluesandai.ontology_datasources").exception("auto re-index pass failed")


@contextlib.contextmanager
def _triggered(name: str):
    """Why the index runs, for the indexing run log (ontology_indexing.py)."""
    import ontology_indexing

    token = ontology_indexing.TRIGGER.set(name)
    try:
        yield
    finally:
        ontology_indexing.TRIGGER.reset(token)


def _trigger() -> Optional[str]:
    try:
        import ontology_indexing
    except Exception:  # noqa: BLE001
        return None
    return ontology_indexing.TRIGGER.get()


def start_watcher() -> None:
    threading.Thread(target=_watch, daemon=True, name="ontology-datasource-watch").start()
