"""Dataset Preview (Palantir's "Dataset Preview" docs): one page per dataset with its metadata, preview, history,
details, health, compare and Time Travel. Mounted by server.py under /api/dataset-preview.

A dataset here is a Files item:
- a Parquet file (what pipeline deploys and code builds write): schema from the file (ParquetDataFrameReader), versions
  from dataset_versions (every build / deploy / rollback);
- a CSV / TSV / JSON file, or a folder of them (a "raw" dataset, made with New dataset; uploads of .csv, .tsv, .xls,
  .xlsm and .xlsx — workbooks become CSV — append, or update a file of the same name with the same header): parsed with
  the dataset's schema (dataset_reader.py: TextDataFrameReader / DataSourceDataFrameReader options), inferred until one
  is saved. Every upload and schema change records a transaction with the parsed rows, so History, Compare and Time
  Travel work for raw datasets too.

Per dataset (data/dataset_preview/): the saved schema (schemas/<id>.json) and metadata (meta/<id>.json: custom
metadata fields and column issues). Branches of a Parquet dataset are copies under `_branches/<branch>/` next to it
(where builds on branches write); History → Create branch makes one from a transaction.

A dataset over 512 MB is read out of core (see "big datasets"): its rows stay in one Parquet file on disk and DuckDB
pages, sorts, filters, searches, charts, runs SQL and computes column statistics over every row of it.
"""

from __future__ import annotations

import bisect as _bisect
import hashlib
import io
import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import dataset_reader as R
import dataset_versions
import db
import drive

router = APIRouter(prefix="/api/dataset-preview")
DIR: Path = Path()
PARQUET = "application/vnd.apache.parquet"
ICEBERG = "application/vnd.apache.iceberg+json"
TEXT_EXT = (".csv", ".tsv", ".txt", ".json", ".jsonl", ".ndjson")
RAW_EXT = (*TEXT_EXT, ".parquet")
UPLOAD_EXT = (".csv", ".tsv", ".xls", ".xlsm", ".xlsx")
MAX_TABLE_BYTES = 512 * 1024 * 1024
# a dataset bigger than MAX_TABLE_BYTES is read out of core (big datasets below); table() — what other modules load —
# still holds its first rows (Parquet) or its first files / bytes (raw)
PARTIAL_ROWS = 200_000
_partial: dict[str, dict] = {}
BRANCHES = "_branches"
_lock = threading.RLock()
_cache: dict[str, tuple[str, pa.Table]] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "dataset_preview"
    for sub in ("schemas", "meta", "spill"):
        (DIR / sub).mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_file(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _write(path: Path, data: Any) -> None:
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), "utf-8")
    tmp.replace(path)


def _safe(item_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id):
        raise HTTPException(404, "dataset not found")
    return item_id


# ------------------------------------------------------------------------------------------------
# what a dataset is
# ------------------------------------------------------------------------------------------------


def kind_of(item: dict) -> Optional[str]:
    name = item["name"].lower()
    if item["kind"] == "file" and item.get("content_type") == ICEBERG:
        # a Foundry Iceberg table: its own pages (iceberg_tables.py) — Snapshots, Maintenance, metadata JSON
        return "iceberg"
    if item["kind"] == "file":
        if item.get("content_type") == PARQUET or name.endswith(".parquet"):
            return "parquet"
        if name.endswith(TEXT_EXT):
            return "file"
        return None
    if item["kind"] in ("folder", "project"):
        return "raw"
    return None


def _dataset(item_id: str, need: str = "viewer") -> tuple[dict, str]:
    item = drive._item(_safe(item_id), need=need)
    kind = kind_of(item)
    if not kind:
        raise HTTPException(400, f'"{item["name"]}" is not a dataset (Parquet, CSV, TSV or JSON files, or a folder of them)')
    return item, kind


def _raw_files(item: dict) -> list[dict]:
    files = [f for f in drive.list_files(item["id"]) if f["name"].lower().endswith(RAW_EXT)]
    return sorted(files, key=lambda f: (f.get("created_at") or "", f["name"]))


def _files(item: dict, kind: str) -> list[dict]:
    return [item] if kind in ("parquet", "file") else _raw_files(item)


def _contents(files: list[dict]) -> list[tuple[str, bytes]]:
    total = sum(int(f.get("size_bytes") or 0) for f in files)
    if total > MAX_TABLE_BYTES:
        raise HTTPException(413, f"the dataset's files hold {total / 1e6:.0f} MB: this reads at most {MAX_TABLE_BYTES // 2**20} MB at once")
    return [(f["name"], drive.read_bytes(f)) for f in files]


def _contents_head(files: list[dict], limit: int = MAX_TABLE_BYTES) -> tuple[list[tuple[str, bytes]], Optional[dict]]:
    """The files to preview: all of them up to `limit` (MAX_TABLE_BYTES), else the first ones that fit — and of a single
    bigger text file its first `limit` bytes, cut at the last line break. (contents, what was left out or None)."""
    total = sum(int(f.get("size_bytes") or 0) for f in files)
    if total <= limit:
        return [(f["name"], drive.read_bytes(f)) for f in files], None
    out: list[tuple[str, bytes]] = []
    used = 0
    for f in files:
        size = int(f.get("size_bytes") or 0)
        if used + size > limit:
            if not out and f["name"].lower().endswith((".csv", ".tsv", ".txt", ".jsonl", ".ndjson")):
                head = _head(f, limit)
                cut = head.rfind(bytes([10]))
                out.append((f["name"], head[: cut + 1] if cut > 0 else head))
                used = len(out[-1][1])
            break
        out.append((f["name"], drive.read_bytes(f)))
        used += size
    return out, {"total_bytes": total, "read_bytes": used, "files": len(files), "files_read": len(out),
                 "reason": f"the dataset holds {total / 1e6:,.0f} MB: the preview reads its first {used / 1e6:,.0f} MB"}


def saved_schema(item_id: str) -> Optional[dict]:
    return _json_file(DIR / "schemas" / f"{_safe(item_id)}.json", None)


def schema_for(item: dict, kind: str, files: Optional[list[tuple[str, bytes]]] = None) -> tuple[dict, bool]:
    """(schema, saved?). Parquet datasets: from the file. Raw: the saved one, else inferred from the files."""
    if kind == "parquet":
        if _big(item, kind) and item.get("stored_in") != "s3":
            auth.check_item(item)
            f = pq.ParquetFile(drive.LOCAL_DIR / item["id"])  # the footer only: a big file is not read into memory
            try:
                return R.schema_of_table(f.schema_arrow.empty_table()), True
            finally:
                f.close()
        if _big(item, kind):
            return R.schema_of_table(_s3_parquet_schema(item).empty_table()), True
        f = pq.ParquetFile(io.BytesIO(drive.read_bytes(item)))
        return R.schema_of_table(f.schema_arrow.empty_table()), True
    s = saved_schema(item["id"])
    if s:
        return s, True
    if files is None and _big(item, kind):
        return R.infer(_infer_contents(_files(item, kind))), False
    return R.infer(files if files is not None else _contents(_files(item, kind))), False


class _S3File(io.RawIOBase):
    """A file kept in S3 read in place with ranged GETs (read ahead S3_READAHEAD bytes): pyarrow reads a big Parquet
    file's footer and first row groups through it without downloading the file."""

    def __init__(self, item: dict) -> None:
        import storage

        auth.check_item(item)
        self._s3, self._bucket, self._key = storage._s3(), storage._bucket(), f"drive/{item['id']}"
        self.size = int(item.get("size_bytes") or 0)
        self.pos = 0
        self._buf, self._buf_at = b"", 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        if not n:
            return b""
        lo, hi = self.pos, self.pos + n
        if not (self._buf_at <= lo and hi <= self._buf_at + len(self._buf)):
            self._buf = _s3_range(self._s3, self._bucket, self._key, lo, min(self.size, max(hi, lo + S3_READAHEAD)))
            self._buf_at = lo
        out = self._buf[lo - self._buf_at: hi - self._buf_at]
        self.pos += len(out)
        return out

    def readinto(self, b: Any) -> int:
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def _s3_range(s3: Any, bucket: str, key: str, lo: int, hi: int) -> bytes:
    """Bytes [lo, hi) of an S3 object: one ranged GET, or — past S3_PIECE — S3_PIECE-sized GETs in parallel (one GET
    streams far slower than the link: 32 MB took 36 s alone, 15 s as 8 parallel parts)."""
    get = lambda a, b: s3.get_object(Bucket=bucket, Key=key, Range=f"bytes={a}-{b - 1}")["Body"].read()  # noqa: E731
    if hi - lo <= S3_PIECE:
        return get(lo, hi) if hi > lo else b""
    from concurrent.futures import ThreadPoolExecutor

    starts = range(lo, hi, S3_PIECE)
    with ThreadPoolExecutor(min(S3_PARALLEL, len(starts))) as ex:
        return b"".join(ex.map(lambda a: get(a, min(hi, a + S3_PIECE)), starts))


def _head(f: dict, n: int) -> bytes:
    """The first n bytes of a file (drive.read_head; a file in S3 with parallel ranged GETs)."""
    if f.get("stored_in") != "s3":
        return drive.read_head(f, n)
    import storage

    auth.check_item(f)
    size = int(f.get("size_bytes") or 0)
    return _s3_range(storage._s3(), storage._bucket(), f"drive/{f['id']}", 0, min(n, size) if size else n)


def _s3_parquet_schema(item: dict) -> pa.Schema:
    """A big Parquet file kept in S3: its schema from the footer alone (ranged reads), not the whole file."""
    f = pq.ParquetFile(_S3File(item))
    try:
        return f.schema_arrow
    finally:
        f.close()


def _stamp(item: dict, kind: str, files: list[dict]) -> str:
    sch = json.dumps(saved_schema(item["id"]) or {}, sort_keys=True) if kind != "parquet" else ""
    return json.dumps([item.get("updated_at"), [(f["id"], f.get("updated_at"), f.get("size_bytes")) for f in files], sch], default=str)


def table(item: dict, kind: str, tx: Optional[str] = None) -> pa.Table:
    """The dataset as an Arrow table: the current version, or a transaction's kept copy."""
    if tx:
        raw = dataset_versions.data(item["id"], tx)
        if raw is None:
            raise HTTPException(404, "that transaction's data is no longer kept (retention removes older copies)")
        return pq.read_table(io.BytesIO(raw))
    files = _files(item, kind)
    stamp = _stamp(item, kind, files)
    hit = _cache.get(item["id"])
    if hit and hit[0] == stamp:
        return hit[1]
    partial = None
    if kind == "parquet" and int(item.get("size_bytes") or 0) > MAX_TABLE_BYTES:
        # a big Parquet file: its first row groups, read from a local copy without loading the file into memory
        t, partial = _parquet_head(item)
    elif kind == "parquet":
        t = pq.read_table(io.BytesIO(drive.read_bytes(item)))
    else:
        contents, partial = _contents_head(files)
        schema, _ = schema_for(item, kind, contents)
        try:
            t, _ = R.read(contents, schema, imported_at=_imported_at(item), dataset_uri=f"foundry://{item['id']}")
        except R.ParseError as e:
            raise HTTPException(422, {"message": f"Could not load preview: {e}. Edit the schema (parsing options) to fix it.", "errors": e.errors}) from None
    with _lock:
        if len(_cache) > 16:
            _cache.clear()
        _cache[item["id"]] = (stamp, t)
        if partial:
            _partial[item["id"]] = {**partial, "rows_read": t.num_rows}
        else:
            _partial.pop(item["id"], None)
    return t


def _parquet_head(item: dict) -> tuple[pa.Table, dict]:
    # read in place (a local file, or ranged reads of one in S3): only the footer and the first row groups
    if item.get("stored_in") == "s3":
        handle: Any = _S3File(item)
    else:
        auth.check_item(item)
        handle = drive.LOCAL_DIR / item["id"]
    f = pq.ParquetFile(handle)
    try:
        batches, n = [], 0
        for b in f.iter_batches(batch_size=50_000):
            batches.append(b)
            n += b.num_rows
            if n >= PARTIAL_ROWS:
                break
        t = pa.Table.from_batches(batches, schema=f.schema_arrow) if batches else f.schema_arrow.empty_table()
        total = f.metadata.num_rows
    finally:
        f.close()
    size = int(item.get("size_bytes") or 0)
    return t.slice(0, PARTIAL_ROWS), {"total_bytes": size, "rows_total": total,
                                      "reason": f"the file holds {size / 1e6:,.0f} MB: the preview reads its first {min(total, PARTIAL_ROWS):,} of {total:,} rows"}


def partial_of(item_id: str) -> Optional[dict]:
    """How much of a big dataset the last read loaded (None: all of it)."""
    return _partial.get(item_id)


# ------------------------------------------------------------------------------------------------
# big datasets: read out of core
# ------------------------------------------------------------------------------------------------
# A dataset over MAX_TABLE_BYTES is not loaded into memory. The preview reads one Parquet file on disk with DuckDB —
# paging to any row, sorting, filters, row search, charts, SQL and column statistics over every row — and fetches only
# the rows a page shows. That file is a Parquet dataset's own file, or a "spill" copy made once per version, in the
# background, under data/dataset_preview/spill/<id>-<version>.parquet: of a raw dataset (CSV / TSV / JSON lines /
# Parquet files, parsed in chunks with the same reader and schema as the in-memory path, so the rows are the same) and
# of a Parquet file kept in S3. Until the copy is ready the page shows the dataset's first rows, flagged as partial,
# with the progress. Small datasets keep the in-memory table; both run the same queries, so their answers match.

ROW = "__bsai_row"  # the row's position: the sort tiebreaker (the same order on both paths) and how a page is fetched
CHUNK_BYTES = 16 * 2**20  # a raw file is parsed this much at a time
HEAD_BYTES = 4 * 2**20  # schema inference reads this much of every file (it samples 1,000 rows)
STOPGAP_BYTES = 8 * 2**20  # what the preview shows while the spill copy is made (~100k rows; parsed in seconds)
DUCK_MEMORY = "1GB"  # DuckDB spills sorts and aggregations past this to its temp directory
FETCH_BATCH = 32_768  # a page's rows are read from their row groups this many rows at a time
S3_READAHEAD = 8 * 2**20  # a big Parquet file in S3 read in place (its footer, its first rows): bytes read ahead
S3_PIECE = 4 * 2**20  # a longer S3 read is split into ranged GETs of this size, S3_PARALLEL at a time
S3_PARALLEL = 8
_builds: dict[str, dict] = {}
_stats: dict[str, tuple[str, list[dict]]] = {}
_stopgaps: dict[str, tuple[str, pa.Table, Optional[dict]]] = {}
_ASCII_SAFE = re.compile(r"(?i)^(utf-?8|us-?ascii|ascii|latin-?1|iso-?8859-\d+|windows-125\d|cp125\d)$")


def _size(item: dict, kind: str, files: Optional[list[dict]] = None) -> int:
    if kind == "parquet":
        return int(item.get("size_bytes") or 0)
    return sum(int(f.get("size_bytes") or 0) for f in (files if files is not None else _files(item, kind)))


def _big(item: dict, kind: str, files: Optional[list[dict]] = None) -> bool:
    return kind in ("parquet", "file", "raw") and _size(item, kind, files) > MAX_TABLE_BYTES


class Source:
    """What the preview reads: the dataset as a table in memory, or as one Parquet file on disk (out of core)."""

    def __init__(self, table: Optional[pa.Table] = None, path: Optional[Path] = None, partial: Optional[dict] = None,
                 key: str = "", spill: bool = False) -> None:
        self.table, self.path, self.partial, self.key, self.spill = table, path, partial, key, spill
        if path is not None:
            f = pq.ParquetFile(path)
            try:
                self.schema = f.schema_arrow
                md = f.metadata
                self.num_rows = md.num_rows
                self.row_groups = [md.row_group(i).num_rows for i in range(md.num_row_groups)]
            finally:
                f.close()
        else:
            assert table is not None
            self.schema = table.schema
            self.num_rows = table.num_rows
            self.row_groups = []

    @property
    def tiebreak(self) -> bool:
        # read_parquet's file_row_number cannot be added to a file that has a column of that name
        return self.path is None or "file_row_number" not in self.schema.names

    def info(self) -> Optional[dict]:
        if self.path is None:
            return None
        return {"engine": "duckdb", "rows": self.num_rows, "row_groups": len(self.row_groups),
                "copy": self.spill, "note": f"Every query reads all {self.num_rows:,} rows from disk (DuckDB); nothing is loaded into memory"}


def _sql_str(s: str) -> str:
    return s.replace("'", "''")


def _connect(src: Source):
    """A DuckDB connection where `dataset` is the dataset (and _dataset_rows the same with its row position), locked to
    it: no other file can be read, no setting changed."""
    import duckdb
    import numpy as np

    tmp = DIR / "spill" / "duckdb-tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.execute(f"SET memory_limit='{DUCK_MEMORY}'")
        con.execute(f"SET temp_directory='{_sql_str(tmp.as_posix())}'")
        if src.path is None:
            t = src.table
            con.register("dataset", t)
            con.register("_dataset_rows", t.append_column(ROW, pa.array(np.arange(t.num_rows, dtype=np.int64))))
        else:
            p = _sql_str(src.path.as_posix())
            con.execute(f"CREATE VIEW dataset AS SELECT * FROM read_parquet('{p}')")
            if src.tiebreak:
                con.execute(f"CREATE VIEW _dataset_rows AS SELECT * EXCLUDE (file_row_number), file_row_number AS {ROW} "
                            f"FROM read_parquet('{p}', file_row_number = true)")
            con.execute(f"SET allowed_paths=['{p}']")
            con.execute(f"SET allowed_directories=['{_sql_str(tmp.as_posix())}']")
        con.execute("SET enable_external_access=false")
        con.execute("SET lock_configuration=true")
    except Exception:
        con.close()
        raise
    return con


def _arrow(res: Any) -> pa.Table:
    t = res.arrow()
    return t.read_all() if hasattr(t, "read_all") else t


def _where(src: Source, filters: list[dict], search: str = "") -> tuple[str, list[Any]]:
    """The filters (dataset_reader's) and a row search: the rows where any column's text contains the term."""
    where, args = R._where(src.schema.empty_table(), filters)
    term = (search or "").strip()
    if term:
        cols = [f.name for f in src.schema]
        parts = [f"COALESCE(contains(lower(CAST({R._q(c)} AS VARCHAR)), lower(?)), FALSE)" for c in cols]
        where = f"({where}) AND ({' OR '.join(parts) or 'FALSE'})"
        args = [*args, *([term] * len(cols))]
    return where, args


def query_rows(src: Source, filters: list[dict], sort: list[dict], offset: int, limit: int, search: str = "") -> dict:
    """A page of the rows that pass the filters and the search, sorted (ties keep the dataset's order); total = matching
    rows. Out of core, the page's row positions are found first (reading only the columns the filters and sort need),
    then only those rows are read."""
    where, args = _where(src, filters, search)
    names = set(src.schema.names)
    order = ", ".join(f"{R._q(s['column'])} {'DESC' if s.get('desc') else 'ASC'} NULLS LAST" for s in sort or [] if s.get("column") in names)
    offset, limit = max(0, int(offset)), int(limit)
    con = _connect(src)
    try:
        filtered = where != "TRUE"
        total = con.execute(f"SELECT COUNT(*) FROM dataset WHERE {where}", args).fetchone()[0] if filtered else src.num_rows
        if not src.tiebreak:
            out = _arrow(con.execute(f"SELECT * FROM dataset WHERE {where}{f' ORDER BY {order}' if order else ''} LIMIT {limit} OFFSET {offset}", args))
        elif src.path is None:
            out = _arrow(con.execute(f"SELECT * EXCLUDE ({ROW}) FROM _dataset_rows WHERE {where} ORDER BY {order + ', ' if order else ''}{ROW} "
                                     f"LIMIT {limit} OFFSET {offset}", args))
        else:
            if not filtered and not order:
                ids = list(range(offset, min(offset + limit, total)))
            else:
                ids = [r[0] for r in con.execute(f"SELECT {ROW} FROM _dataset_rows WHERE {where} ORDER BY {order + ', ' if order else ''}{ROW} "
                                                 f"LIMIT {limit} OFFSET {offset}", args).fetchall()]
            out = _fetch(con, src, ids)
    finally:
        con.close()
    return {"total": total, "rows": R.json_rows(out)}


def _fetch(con: Any, src: Source, ids: list[int]) -> pa.Table:
    """These rows (by position, in this order) of an on-disk dataset: from the few row groups that hold them, else one
    scan. Either way through DuckDB, so values convert as they do for a table in memory."""
    if not ids:
        return _arrow(con.execute("SELECT * FROM dataset LIMIT 0"))
    starts = [0]
    for n in src.row_groups:
        starts.append(starts[-1] + n)
    groups: dict[int, list[int]] = {}
    for i in sorted(set(ids)):
        groups.setdefault(_bisect.bisect_right(starts, i) - 1, []).append(i)
    if len(groups) <= 16:
        assert src.path is not None
        f = pq.ParquetFile(src.path)
        try:
            # batch by batch: memory holds one batch of a row group, not the group (a group can be a million rows)
            pieces, at = [], {}
            for g, rows_ in groups.items():
                lo = starts[g]
                k = 0
                for batch in f.iter_batches(batch_size=FETCH_BATCH, row_groups=[g]):
                    hi = lo + batch.num_rows
                    j = _bisect.bisect_left(rows_, hi, k)
                    if j > k:
                        pieces.append(pa.Table.from_batches([batch]).take(pa.array([i - lo for i in rows_[k:j]], pa.int64())))
                        for i in rows_[k:j]:
                            at[i] = len(at)
                    k, lo = j, hi
                    if k >= len(rows_):
                        break
        finally:
            f.close()
        page = pa.concat_tables(pieces).take(pa.array([at[i] for i in ids], pa.int64()))
        con.register("_page", page)
        return _arrow(con.execute("SELECT * FROM _page"))
    con.register("_ids", pa.table({"id": pa.array(ids, pa.int64()), "pos": pa.array(range(len(ids)), pa.int64())}))
    return _arrow(con.execute(f"SELECT d.* EXCLUDE ({ROW}) FROM _dataset_rows d JOIN _ids k ON d.{ROW} = k.id ORDER BY k.pos"))


def column_stats(src: Source, top: int = 5) -> list[dict]:
    """The Columns panel over every row: null count and %, approximate distinct count, min / max / mean of numbers and
    dates (one scan for all columns), the most common values (one scan per column). As dataset_reader.column_stats."""
    fields = list(src.schema)
    if not fields:
        return []
    num = lambda t: pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)  # noqa: E731
    aggs: list[str] = []
    for f in fields:
        c = R._q(f.name)
        aggs += [f"COUNT(*) - COUNT({c})", f"approx_count_distinct({c})"]
        if num(f.type):
            aggs += [f"MIN({c})", f"MAX({c})", f"AVG(CAST({c} AS DOUBLE))"]
        elif pa.types.is_temporal(f.type):
            aggs += [f"MIN({c})", f"MAX({c})"]
    n = src.num_rows
    out = []
    con = _connect(src)
    try:
        vals = list(con.execute(f"SELECT {', '.join(aggs)} FROM dataset").fetchone())
        for f in fields:
            c = R._q(f.name)
            nulls, distinct = vals.pop(0), vals.pop(0)
            # approx_count_distinct (HyperLogLog) can overshoot — by a third on 26 M unique ids — never past the values there are
            s: dict[str, Any] = {"name": f.name, "type": R.foundry_type(f.type), "nulls": nulls, "null_pct": round(100 * nulls / n, 2) if n else 0.0,
                                 "distinct": min(distinct, n - nulls)}
            md = f.metadata or {}
            if b"description" in md:
                s["description"] = md[b"description"].decode("utf-8", "replace")
            if num(f.type):
                lo, hi, mean = vals.pop(0), vals.pop(0), vals.pop(0)
                s.update(min=R._json(lo), max=R._json(hi), mean=R._json(mean))
            elif pa.types.is_temporal(f.type):
                lo, hi = vals.pop(0), vals.pop(0)
                s.update(min=R._json(lo), max=R._json(hi))
            s["top"] = [{"value": R._json(v), "count": k} for v, k in con.execute(
                f"SELECT {c}, COUNT(*) AS k FROM dataset WHERE {c} IS NOT NULL GROUP BY 1 ORDER BY k DESC, 1 LIMIT {int(top)}").fetchall()]
            out.append(s)
    finally:
        con.close()
    return out


def chart(src: Source, column: str, bins: int = 20, filters: Optional[list[dict]] = None, search: str = "") -> dict:
    """A histogram (numbers, dates) or the most common values of a column, after the filters. As dataset_reader.chart."""
    if column not in src.schema.names:
        raise ValueError(f"unknown column {column}")
    where, args = _where(src, filters or [], search)
    t = src.schema.field(column).type
    c = R._q(column)
    numeric = pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)
    con = _connect(src)
    try:
        if numeric or pa.types.is_temporal(t):
            expr = f"CAST({c} AS DOUBLE)" if numeric else f"epoch({c})"
            lo, hi = con.execute(f"SELECT MIN({expr}), MAX({expr}) FROM dataset WHERE {where}", args).fetchone()
            if lo is None:
                return {"kind": "histogram", "bins": []}
            width = (hi - lo) / bins if hi > lo else 1
            rows_ = con.execute(f"SELECT LEAST(CAST(FLOOR(({expr} - ?) / ?) AS BIGINT), {bins - 1}) AS b, COUNT(*) FROM dataset "
                                f"WHERE {where} AND {c} IS NOT NULL GROUP BY 1 ORDER BY 1", [lo, width, *args]).fetchall()
            counts = dict(rows_)
            conv = (lambda x: x) if numeric else (lambda x: datetime.fromtimestamp(x, timezone.utc).isoformat())
            return {"kind": "histogram", "temporal": not numeric,
                    "bins": [{"from": conv(lo + i * width), "to": conv(lo + (i + 1) * width), "count": counts.get(i, 0)} for i in range(bins if hi > lo else 1)]}
        # ties in the count by value, so the same values come back on either path (and on every call)
        rows_ = con.execute(f"SELECT {c}, COUNT(*) AS k FROM dataset WHERE {where} GROUP BY 1 ORDER BY k DESC, 1 NULLS LAST LIMIT 25", args).fetchall()
        return {"kind": "values", "values": [{"value": R._json(v), "count": k} for v, k in rows_]}
    finally:
        con.close()


def run_sql(src: Source, sql: str, limit: int = 1000) -> dict:
    """A read-only SELECT over `dataset` (as dataset_reader.run_sql); the connection can read nothing else."""
    text = sql.strip().rstrip(";")
    if not re.match(r"(?is)^\s*(select|with)\b", text) or ";" in text:
        raise ValueError("only one SELECT (or WITH … SELECT) statement over `dataset` can run here")
    if re.search(r"(?i)\b(read_csv|read_parquet|read_json|copy|attach|install|load|pragma|export|import)\b", text):
        raise ValueError("only the dataset can be read")
    con = _connect(src)
    try:
        res = _arrow(con.execute(f"SELECT * FROM ({text}) AS q LIMIT {int(limit) + 1}"))
    finally:
        con.close()
    rows_ = R.json_rows(res)
    return {"columns": [{"name": f.name, "type": R.foundry_type(f.type)} for f in res.schema], "rows": rows_[:limit], "truncated": len(rows_) > limit}


def source(item: dict, kind: str, tx: Optional[str] = None) -> Source:
    """The dataset as the preview reads it: a table in memory (a transaction's copy, or a dataset up to
    MAX_TABLE_BYTES), else its Parquet file on disk — while a raw dataset's copy is being made, its first rows."""
    files = _files(item, kind) if kind in ("parquet", "file", "raw") else []
    if tx or not _big(item, kind, files):
        t = table(item, kind, tx)
        return Source(table=t, partial=None if tx else partial_of(item["id"]))
    stamp = _stamp(item, kind, files)
    key = hashlib.sha1(stamp.encode("utf-8")).hexdigest()[:16]
    if kind == "parquet" and item.get("stored_in") != "s3":
        auth.check_item(item)
        return Source(path=drive.LOCAL_DIR / item["id"], key=f"{item['id']}-{key}")
    path = DIR / "spill" / f"{item['id']}-{key}.parquet"
    if path.is_file():
        return Source(path=path, key=path.stem, spill=True)
    for f in files:
        auth.check_item(f)
    schema = None if kind == "parquet" else _big_schema(item, kind, files)
    plan, why = ("parquet", None) if kind == "parquet" else _plan(schema or {})
    if plan is None:
        # a reader that cannot be split into parts: the first rows only, as before
        t = table(item, kind)
        p = dict(partial_of(item["id"]) or {})
        p["reason"] = f"{p.get('reason', 'the dataset is big')} ({why}: it is not read in parts)"
        return Source(table=t, partial=p)
    b = _start_build(item, kind, files, schema, path, stamp)
    if b["state"] == "error" and b.get("parse_error"):
        raise HTTPException(422, {"message": f"Could not load preview: {b['error']}. Edit the schema (parsing options) to fix it.", "errors": b.get("errors") or []})
    t, p = _stopgap(item, kind, files, schema, stamp)
    p = dict(p or {})
    done, total = b.get("done_bytes", 0), b.get("total_bytes") or 1
    if b["state"] == "error":
        p["reason"] = f"{p.get('reason', 'the dataset is big')}; reading all of it failed: {b['error']}"
    else:
        p["reason"] = f"{p.get('reason', 'the dataset is big')} — reading all {total / 1e6:,.0f} MB in the background ({100 * done / total:.0f}%)"
    p["building"] = {"state": b["state"], "done_bytes": done, "total_bytes": total, "error": b.get("error")}
    p["rows_read"] = t.num_rows
    return Source(table=t, partial=p)


def _infer_contents(files: list[dict]) -> list[tuple[str, bytes]]:
    """What schema inference reads of a big raw dataset: the first HEAD_BYTES of every file, cut at a line break (it
    samples the first 1,000 rows). A JSON document or Parquet file is not cut: those are read as before."""
    if files and files[0]["name"].lower().endswith((".json", ".parquet")):
        return _contents_head(files)[0]
    out = []
    for f in files:
        if int(f.get("size_bytes") or 0) <= HEAD_BYTES:
            out.append((f["name"], drive.read_bytes(f)))
        else:
            head = _head(f, HEAD_BYTES)
            cut = head.rfind(bytes([10]))
            out.append((f["name"], head[: cut + 1] if cut > 0 else head))
    return out


def _big_schema(item: dict, kind: str, files: list[dict]) -> dict:
    return saved_schema(item["id"]) or R.infer(_infer_contents(files))


def _stopgap(item: dict, kind: str, files: list[dict], schema: Optional[dict], stamp: str) -> tuple[pa.Table, Optional[dict]]:
    """The first rows of a big dataset, shown while its copy is made (a Parquet file in S3: its first row groups)."""
    hit = _stopgaps.get(item["id"])
    if hit and hit[0] == stamp:
        return hit[1], hit[2]
    if kind == "parquet":
        t, p = _parquet_head(item)
    else:
        contents, p = _contents_head(files, STOPGAP_BYTES)
        try:
            t, _ = R.read(contents, schema or {}, imported_at=_imported_at(item), dataset_uri=f"foundry://{item['id']}")
        except R.ParseError as e:
            raise HTTPException(422, {"message": f"Could not load preview: {e}. Edit the schema (parsing options) to fix it.", "errors": e.errors}) from None
    with _lock:
        if len(_stopgaps) > 8:
            _stopgaps.clear()
        _stopgaps[item["id"]] = (stamp, t, p)
    return t, p


def _plan(schema: dict) -> tuple[Optional[str], Optional[str]]:
    """How a raw dataset is read in parts: ("text" | "json" | "parquet", None), or (None, why it cannot be)."""
    reader = schema.get("dataFrameReaderClass") or R.TEXT_READER
    meta = schema.get("customMetadata") or {}
    if reader == R.PARQUET_READER or (reader == R.SOURCE_READER and meta.get("format") == "parquet"):
        return "parquet", None
    if not schema.get("fieldSchemaList"):
        return None, "the schema has no columns yet"
    if reader == R.SOURCE_READER and meta.get("format") == "json":
        o = meta.get("options") or {}
        if str(o.get("multiLine", o.get("multiline", "false"))).lower() == "true":
            return None, "multi-line JSON is one document per file"
        return "json", None
    p = _text_params(schema)
    if not _ASCII_SAFE.match(str(p["charset"] or "UTF-8")):
        return None, f"the {p['charset']} charset"
    if p["multiline"] and p["escape"]:
        return None, "multi-line records with an escape character"
    return "text", None


def _text_params(schema: dict) -> dict:
    meta = schema.get("customMetadata") or {}
    if (schema.get("dataFrameReaderClass") or R.TEXT_READER) == R.SOURCE_READER:
        o = {str(k).lower(): v for k, v in (meta.get("options") or {}).items()}
        return {"charset": o.get("encoding", o.get("charset", "UTF-8")), "multiline": str(o.get("multiline", "false")).lower() == "true",
                "escape": o.get("escape"), "quote": o.get("quote", '"'), "record": "\n", "offsets": False}
    p = {**R.default_text_params(skipLines=0), **(meta.get("textParserParams") or {})}
    return {"charset": p.get("charsetName") or "UTF-8", "multiline": p.get("parser") == "MULTILINE_CSV_PARSER", "escape": p.get("escape"),
            "quote": p.get("quoteCharacter"), "record": p.get("recordDelimiter") or "\n", "offsets": bool(p.get("addByteOffset"))}


def _rest_of_file(schema: dict) -> dict:
    """The schema for a file's later parts: no header lines to skip."""
    s = json.loads(json.dumps(schema))
    meta = s.setdefault("customMetadata", {})
    if (s.get("dataFrameReaderClass") or R.TEXT_READER) == R.SOURCE_READER:
        meta["options"] = {k: v for k, v in (meta.get("options") or {}).items() if str(k).lower() != "header"}
    else:
        meta.setdefault("textParserParams", {})["skipLines"] = 0
    return s


def _start_build(item: dict, kind: str, files: list[dict], schema: Optional[dict], path: Path, stamp: str) -> dict:
    with _lock:
        b = _builds.get(item["id"])
        if b and b["stamp"] == stamp:
            return b
        b = {"stamp": stamp, "state": "running", "done_bytes": 0, "total_bytes": _size(item, kind, files), "error": None, "started_at": _now(),
             "finished": threading.Event()}
        _builds[item["id"]] = b
    threading.Thread(target=_build, args=(item, kind, files, schema, path, b), daemon=True, name=f"dataset-spill-{item['id']}").start()
    return b


def build_now(item_id: str) -> dict:
    """Make a big dataset's on-disk copy now (and wait for it); tests and maintenance."""
    item, kind = _dataset(item_id)
    source(item, kind)
    with _lock:
        b = _builds.get(item["id"])
    if b:
        b["finished"].wait()
    return {k: v for k, v in (b or {"state": "done"}).items() if k != "finished"}


def _build(item: dict, kind: str, files: list[dict], schema: Optional[dict], path: Path, b: dict) -> None:
    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        if kind == "parquet":
            drive.copy_content(item, tmp)  # a Parquet file kept in S3: a local copy
            pq.ParquetFile(tmp).close()
            b["done_bytes"] = b["total_bytes"]
        else:
            _spill_raw(item, files, schema or {}, tmp, b)
        tmp.replace(path)
        for old in path.parent.glob(f"{item['id']}-*.parquet"):
            if old != path:
                old.unlink(missing_ok=True)
        b.update(state="done", finished_at=_now())
    except Exception as e:  # noqa: BLE001 - reported on the page
        b.update(state="error", error=str(e)[:500], parse_error=isinstance(e, R.ParseError), errors=getattr(e, "errors", None), finished_at=_now())
        tmp.unlink(missing_ok=True)
    finally:
        b["finished"].set()


def _local(f: dict, scratch: Path) -> Path:
    if f.get("stored_in") == "s3":
        dest = scratch / f["id"]
        drive.copy_content(f, dest)
        return dest
    return drive.LOCAL_DIR / f["id"]


def _spill_raw(item: dict, files: list[dict], schema: dict, dest: Path, b: dict) -> None:
    """Parse a raw dataset's files part by part with its schema (dataset_reader.read, as in memory) into one Parquet file:
    text files are cut at record boundaries; row numbers, byte offsets and error rows count from the start of each file."""
    import tempfile

    plan, why = _plan(schema)
    if plan is None:
        raise ValueError(f"{why}: the dataset cannot be read in parts")
    writer: Optional[pq.ParquetWriter] = None
    imported, uri = _imported_at(item), f"foundry://{item['id']}"

    def write(t: pa.Table) -> None:
        nonlocal writer
        if writer is None:
            writer = pq.ParquetWriter(dest, t.schema)
        elif not t.schema.equals(writer.schema, check_metadata=False):
            t = t.cast(writer.schema)
        writer.write_table(t, row_group_size=131_072)

    try:
        with tempfile.TemporaryDirectory(prefix="dsp-spill-") as scratch:
            if plan == "parquet":
                _spill_parquet(files, schema, write, Path(scratch), b)
            else:
                p = _text_params(schema)
                later = _rest_of_file(schema)
                for f in files:
                    path = _local(f, Path(scratch))
                    rows_base = bytes_base = lines_base = 0
                    first = True
                    with open(path, "rb") as fh:
                        for chunk in _chunks(fh, p, plan):
                            b["done_bytes"] += len(chunk)
                            try:
                                t, problems = R.read([(f["name"], chunk)], schema if first else later, imported_at=imported, dataset_uri=uri)
                            except R.ParseError as e:
                                base = lines_base if plan == "json" else rows_base
                                errs = [{**x, "row": x["row"] + base} if isinstance(x.get("row"), int) else x for x in e.errors]
                                msg = re.sub(rf"^({re.escape(f['name'])}, row )(\d+)", lambda m: f"{m.group(1)}{int(m.group(2)) + base}", str(e), count=1)
                                raise R.ParseError(msg, errs) from None
                            if plan == "text" and p["offsets"] and "_byte_offset" in t.column_names:
                                t = _shift(t, "_byte_offset", bytes_base)
                            if "_row_number" in t.column_names:
                                t = _shift(t, "_row_number", rows_base)
                            rows_base += t.num_rows + len(problems)
                            if plan == "text" and p["offsets"]:
                                text = R._decode(chunk, p["charset"])
                                bytes_base += len((text[1:] if first and text.startswith("﻿") else text).encode("utf-8"))
                            if plan == "json":
                                lines_base += len(R._decode(chunk, "utf-8").splitlines())
                            first = False
                            write(t)
            if writer is None:
                write(R.read([], schema)[0])
    finally:
        if writer is not None:
            writer.close()


def _shift(t: pa.Table, name: str, by: int) -> pa.Table:
    if not by:
        return t
    import pyarrow.compute as pc

    i = t.column_names.index(name)
    return t.set_column(i, t.schema.field(i), pc.add(t.column(i), pa.scalar(by, pa.int64())))


def _chunks(fh: Any, p: dict, plan: str):
    """A file in parts of about CHUNK_BYTES that end at a record boundary (a multi-line CSV: a line break outside
    quotes). An empty file is one empty part."""
    multiline = plan == "text" and p["multiline"]
    # a multi-line CSV is read as lines by the csv module (the record delimiter does not apply)
    sep = b"\n" if plan != "text" or multiline else (p["record"].encode(p["charset"], "replace") or b"\n")
    quote = (p.get("quote") or "")[:1].encode("utf-8") if multiline else b""
    carry, yielded = b"", False
    while True:
        block = fh.read(CHUNK_BYTES)
        if not block:
            if carry or not yielded:
                yield carry
            return
        buf = carry + block
        k = _cut(buf, sep, quote)
        if k <= 0:
            carry = buf
            continue
        yield buf[:k]
        yielded = True
        carry = buf[k:]


def _cut(buf: bytes, sep: bytes, quote: bytes) -> int:
    """Where to end a part: after the last separator (outside quotes when records may span lines); 0 for none."""
    pos = buf.rfind(sep)
    if not quote:
        return pos + len(sep) if pos >= 0 else 0
    total, after = buf.count(quote), 0
    end = len(buf)
    while pos >= 0:
        after += buf.count(quote, pos + 1, end)
        if (total - after) % 2 == 0:
            return pos + 1
        end = pos + 1
        pos = buf.rfind(sep, 0, pos)
    return 0


def _spill_parquet(files: list[dict], schema: dict, write: Any, scratch: Path, b: dict) -> None:
    """Parquet files of a raw dataset, batch by batch (mergeSchema: the union of their columns, as in memory)."""
    meta = schema.get("customMetadata") or {}
    merge = bool((meta.get("options") or {}).get("mergeSchema") or meta.get("mergeSchema"))
    paths = [(f, _local(f, scratch)) for f in files]
    schemas = []
    for _, path in paths:
        pf = pq.ParquetFile(path)
        schemas.append(pf.schema_arrow)
        pf.close()
    if not paths:
        return
    target = pa.unify_schemas(schemas) if merge else schemas[0]
    if not merge:
        for (f, _), s in zip(paths[1:], schemas[1:]):
            if not s.equals(schemas[0], check_metadata=False):
                raise R.ParseError(f"{f['name']} has a different schema; set mergeSchema to combine Parquet files with different columns")
    for f, path in paths:
        pf = pq.ParquetFile(path)
        try:
            for batch in pf.iter_batches(batch_size=131_072):
                t = pa.Table.from_batches([batch])
                if merge:
                    t = pa.Table.from_arrays([t.column(x.name) if x.name in t.column_names else pa.nulls(t.num_rows, x.type) for x in target], schema=target)
                write(t)
        finally:
            pf.close()
        b["done_bytes"] += int(f.get("size_bytes") or 0)


def _imported_at(item: dict) -> datetime:
    v = item.get("updated_at")
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.now(timezone.utc)


def _meta(item_id: str) -> dict:
    m = _json_file(DIR / "meta" / f"{_safe(item_id)}.json", {})
    m.setdefault("custom", {})
    m.setdefault("issues", [])
    return m


def _save_meta(item_id: str, m: dict) -> None:
    _write(DIR / "meta" / f"{_safe(item_id)}.json", m)


def _record(item: dict, kind: str, source: dict) -> Optional[dict]:
    """A transaction with the parsed rows of a raw dataset (after an upload or a schema change)."""
    try:
        t = table(item, kind)
    except HTTPException:
        return None
    return dataset_versions.record(item["id"], R.to_parquet(t), source.get("kind", "upload"), source)


# ------------------------------------------------------------------------------------------------
# branches: copies under _branches/<branch>/ next to the dataset
# ------------------------------------------------------------------------------------------------


def _master(item: dict) -> tuple[Optional[str], str]:
    """(the folder the master copy lives in, the branch of this item)."""
    path = db.drive_path(item["id"])
    if len(path) >= 3 and path[-3]["name"] == BRANCHES:
        grand = db.drive_get(path[-3]["id"]) or {}
        return grand.get("parent_id"), path[-2]["name"]
    return item.get("parent_id"), "master"


def branches(item: dict) -> list[dict]:
    parent, _ = _master(item)
    out = []
    def same(i: dict) -> bool:
        return i["kind"] == item["kind"] and i["name"] == item["name"] and not i.get("trashed_at")

    for i in db.drive_list(parent):
        if same(i):
            out.append({"branch": "master", "item_id": i["id"]})
    folder = next((i for i in db.drive_list(parent) if i["kind"] == "folder" and i["name"] == BRANCHES), None)
    if folder:
        for b in db.drive_list(folder["id"]):
            if b["kind"] != "folder":
                continue
            f = next((i for i in db.drive_list(b["id"]) if same(i)), None)
            if f:
                out.append({"branch": b["name"], "item_id": f["id"]})
    return out


# ------------------------------------------------------------------------------------------------
# listing and creating datasets
# ------------------------------------------------------------------------------------------------


@router.get("/datasets")
def list_datasets(q: str = "", limit: int = 100) -> list[dict]:
    """Datasets for the Dataset Preview home: Parquet and text files, and folders that were made datasets."""
    drive._require_db()
    like = f"%{q.strip().lower()}%"
    rows = db.drive_query(
        "trashed_at IS NULL AND kind = 'file' AND lower(name) LIKE %s AND (content_type = %s OR content_type = %s OR lower(name) LIKE '%%.parquet' "
        "OR lower(name) LIKE '%%.csv' OR lower(name) LIKE '%%.tsv' OR lower(name) LIKE '%%.json' OR lower(name) LIKE '%%.jsonl')",
        (like, PARQUET, ICEBERG), limit=max(1, min(limit, 500)))
    raw_ids = [p.stem for p in (DIR / "schemas").glob("*.json")]
    for rid in raw_ids:
        i = db.drive_get(rid)
        if i and not i.get("trashed_at") and q.strip().lower() in i["name"].lower():
            rows.append(i)
    raw = set(raw_ids)
    out = []
    for i in rows:
        if i["kind"] == "file" and i.get("parent_id") in raw:
            continue  # a file of a folder dataset: the folder is listed
        try:
            auth.check_item(i)
        except HTTPException:
            continue
        k = kind_of(i)
        if k:
            out.append({"id": i["id"], "name": i["name"], "kind": k, "size": i.get("size_bytes"), "updated_at": i.get("updated_at"),
                        "path": [p["name"] for p in db.drive_path(i["id"])[:-1]]})
    out.sort(key=lambda r: str(r.get("updated_at") or ""), reverse=True)
    return out[:limit]


class NewDataset(BaseModel):
    parent_id: Optional[str] = None
    name: str = Field(min_length=1, max_length=200)


@router.post("/datasets")
def create_dataset(req: NewDataset) -> dict:
    """New dataset: an empty folder to drop .csv / .tsv / Excel files into (schema inferred from the first upload)."""
    parent = drive._folder_id(req.parent_id)
    name = drive._clean_name(req.name)
    fid = drive._insert_container(parent, "folder", drive._free_name(parent, name))
    _write(DIR / "schemas" / f"{fid}.json", R.text_schema([]))
    return summary(fid)


# ------------------------------------------------------------------------------------------------
# the dataset page
# ------------------------------------------------------------------------------------------------


@router.get("/{item_id}")
def summary(item_id: str) -> dict:
    item, kind = _dataset(item_id)
    if kind == "iceberg":
        # the page shows the Iceberg views (api/iceberg-tables/{id}); the common header fields are here
        return {"id": item["id"], "name": item["name"], "kind": kind, "parent_id": item.get("parent_id"),
                "path": [{"id": p["id"], "name": p["name"]} for p in db.drive_path(item["id"])[:-1]], "size": item.get("size_bytes"),
                "files": 1, "created_at": item.get("created_at"), "updated_at": item.get("updated_at")}
    files = _files(item, kind)
    out: dict[str, Any] = {
        "id": item["id"], "name": item["name"], "kind": kind, "parent_id": item.get("parent_id"),
        "path": [{"id": p["id"], "name": p["name"]} for p in db.drive_path(item["id"])[:-1]],
        "size": sum(int(f.get("size_bytes") or 0) for f in files), "files": len(files),
        "created_at": item.get("created_at"), "updated_at": item.get("updated_at"),
    }
    big = _big(item, kind, files)
    try:
        contents = None if kind == "parquet" or big else _contents_head(files)[0]
        schema, saved = schema_for(item, kind, contents)
        out.update(schema=schema, schema_saved=saved, reader=schema.get("dataFrameReaderClass"))
    except HTTPException as e:
        out.update(schema=None, schema_saved=False, reader=None, schema_error=e.detail)
    except Exception as e:  # noqa: BLE001 - an unreadable file
        out.update(schema=None, schema_saved=False, reader=None, schema_error=str(e))
    out["partial"] = None
    out["out_of_core"] = None
    try:
        src = source(item, kind)
        out.update(rows=src.num_rows, columns=[{"name": f.name, "type": R.foundry_type(f.type),
                                                "description": (f.metadata or {}).get(b"description", b"").decode("utf-8", "replace") or None} for f in src.schema],
                   preview_error=None, partial=src.partial, out_of_core=src.info())
    except HTTPException as e:
        d = e.detail
        out.update(rows=None, columns=[{"name": f["name"], "type": f["type"]} for f in (out.get("schema") or {}).get("fieldSchemaList") or []],
                   preview_error=d.get("message") if isinstance(d, dict) else str(d), preview_errors=d.get("errors") if isinstance(d, dict) else None)
    except Exception as e:  # noqa: BLE001 - an unreadable big file
        out.update(rows=None, columns=[{"name": f["name"], "type": f["type"]} for f in (out.get("schema") or {}).get("fieldSchemaList") or []],
                   preview_error=f"Could not load preview: {str(e).splitlines()[0] if str(e) else type(e).__name__}", preview_errors=None)
    history = dataset_versions.history(item["id"])
    out["transactions"] = len(history)
    out["last_transaction"] = history[0] if history else None
    m = _meta(item["id"])
    out["custom_metadata"] = m["custom"]
    out["open_issues"] = sum(1 for i in m["issues"] if i.get("status") == "open")
    master_parent, branch = _master(item)
    out["branch"] = branch
    out["branches"] = branches(item)
    out.update(_lineage(item["id"]))
    return out


def _lineage(item_id: str) -> dict:
    """Who builds the dataset, what it reads and feeds, its schedules and health, from Data Lineage."""
    try:
        import lineage

        g = lineage.build_graph()
        nid = f"dataset:{item_id}"
        n = g.nodes.get(nid)
        if not n:
            return {"producers": [], "inputs": [], "outputs": [], "schedules": [], "health": None}
        ins = [g.nodes[e["from"]] for e in g.edges.values() if e["to"] == nid and e["from"] in g.nodes]
        outs = [g.nodes[e["to"]] for e in g.edges.values() if e["from"] == nid and e["to"] in g.nodes]
        brief = lambda x: {k: x.get(k) for k in ("id", "kind", "kind_label", "name", "link", "item_id")}  # noqa: E731
        schedules = []
        for p in ins:
            for s in p.get("schedules") or []:
                schedules.append({**s, "producer": p.get("name"), "producer_link": p.get("link")})
        rules = lineage.health_rules(item_id)
        health = lineage.evaluate_health(n, rules) if rules else None
        producers = [{**p, "link": g.nodes.get(p.get("id"), {}).get("link")} for p in n.get("producers") or []]
        return {"producers": producers, "inputs": [brief(x) for x in ins], "outputs": [brief(x) for x in outs], "schedules": schedules,
                "health": health, "lineage_id": nid}
    except Exception:  # noqa: BLE001 - Lineage is optional for the page
        return {"producers": [], "inputs": [], "outputs": [], "schedules": [], "health": None}


class RowsIn(BaseModel):
    transaction: Optional[str] = None
    filters: list[dict] = Field(default_factory=list)
    sort: list[dict] = Field(default_factory=list)
    offset: int = Field(0, ge=0)
    limit: int = Field(100, ge=1, le=5000)
    # rows where any column's text contains this (case-insensitive)
    search: str = Field("", max_length=500)


@router.post("/{item_id}/rows")
def rows(item_id: str, req: RowsIn) -> dict:
    """The preview table: a page of the rows (offset, limit); filters, the row search and sorting apply to the whole
    dataset (version) — out of core for a big one."""
    item, kind = _dataset(item_id)
    src = source(item, kind, req.transaction)
    try:
        res = query_rows(src, req.filters, req.sort, req.offset, req.limit, req.search)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"columns": [{"name": f.name, "type": R.foundry_type(f.type)} for f in src.schema], "dataset_rows": src.num_rows, **res,
            "offset": req.offset, "partial": None if req.transaction else src.partial, "out_of_core": src.info()}


@router.get("/{item_id}/columns")
def columns(item_id: str, transaction: Optional[str] = None) -> list[dict]:
    """The Columns panel over every row: type, description, null %, distinct values, the most common values, min / max /
    mean. A big dataset's statistics are kept per version (one full read)."""
    item, kind = _dataset(item_id)
    src = source(item, kind, transaction)
    hit = _stats.get(item["id"]) if src.path is not None else None
    if hit and hit[0] == src.key:
        stats = json.loads(json.dumps(hit[1]))
    else:
        stats = column_stats(src)
        if src.path is not None:
            with _lock:
                _stats[item["id"]] = (src.key, json.loads(json.dumps(stats)))
    issues = _meta(item["id"])["issues"]
    for s in stats:
        s["open_issues"] = sum(1 for i in issues if i.get("column") == s["name"] and i.get("status") == "open")
    return stats


class ChartIn(BaseModel):
    column: str
    transaction: Optional[str] = None
    filters: list[dict] = Field(default_factory=list)
    bins: int = Field(20, ge=2, le=100)
    search: str = Field("", max_length=500)


@router.post("/{item_id}/chart")
def chart_endpoint(item_id: str, req: ChartIn) -> dict:
    item, kind = _dataset(item_id)
    try:
        return chart(source(item, kind, req.transaction), req.column, req.bins, req.filters, req.search)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


class QueryIn(BaseModel):
    sql: str = Field(min_length=1, max_length=20000)
    transaction: Optional[str] = None


@router.post("/{item_id}/query")
def query(item_id: str, req: QueryIn) -> dict:
    """Time Travel → Refine query: SQL over the dataset (named `dataset`) at a version — every row of a big one."""
    item, kind = _dataset(item_id)
    try:
        return run_sql(source(item, kind, req.transaction), req.sql)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:  # noqa: BLE001 - SQL errors
        raise HTTPException(400, f"the query failed: {str(e).splitlines()[0]}") from None


# ------------------------------------------------------------------------------------------------
# schema: view, infer, validate, save (raw datasets)
# ------------------------------------------------------------------------------------------------


@router.get("/{item_id}/schema")
def get_schema(item_id: str) -> dict:
    item, kind = _dataset(item_id)
    schema, saved = schema_for(item, kind)
    return {"schema": schema, "saved": saved, "editable": kind != "parquet"}


class InferIn(BaseModel):
    options: dict[str, Any] = Field(default_factory=dict)


@router.post("/{item_id}/schema/infer")
def infer_schema(item_id: str, req: InferIn) -> dict:
    """Edit schema: infer a schema from the files with these parsing options (delimiter, quotes, header rows, ...)."""
    item, kind = _dataset(item_id)
    if kind == "parquet":
        raise HTTPException(400, "Parquet datasets take their schema from the file")
    return {"schema": R.infer(_contents(_files(item, kind)), req.options)}


class SchemaIn(BaseModel):
    schema_: dict = Field(alias="schema")
    validate_: bool = Field(True, alias="validate")
    rows: int = Field(50, ge=1, le=500)


@router.post("/{item_id}/schema/preview")
def preview_schema(item_id: str, req: SchemaIn) -> dict:
    """The first rows and the validation result of a schema before it is saved."""
    item, kind = _dataset(item_id)
    if kind == "parquet":
        raise HTTPException(400, "Parquet datasets take their schema from the file")
    contents = _contents(_files(item, kind))
    v = R.validate(contents, req.schema_)
    sample: list[dict] = []
    cols: list[dict] = []
    if not v["problems"]:
        try:
            t, _ = R.read(contents, req.schema_, strict=False, imported_at=_imported_at(item), dataset_uri=f"foundry://{item['id']}")
            sample = R.json_rows(t.slice(0, req.rows))
            cols = [{"name": f.name, "type": R.foundry_type(f.type)} for f in t.schema]
        except Exception as e:  # noqa: BLE001
            v["errors"] = [{"error": str(e)}, *v["errors"]]
    return {"validation": v, "columns": cols, "rows": sample}


@router.put("/{item_id}/schema")
def save_schema(item_id: str, req: SchemaIn) -> dict:
    """Save and validate (refused when rows fail to parse) or save without validating."""
    item, kind = _dataset(item_id, need="editor")
    if kind == "parquet":
        raise HTTPException(400, "Built datasets take their schema from their build: change the transform or pipeline that writes it")
    shape = R.check_schema(req.schema_)
    if shape:
        raise HTTPException(400, "; ".join(shape))
    if req.validate_:
        v = R.validate(_contents(_files(item, kind)), req.schema_)
        if not v["ok"]:
            raise HTTPException(400, {"message": f"Your dataset failed to validate on {v['failed_rows']} rows. Fix the schema, or save without validating.",
                                      "validation": v})
    _write(DIR / "schemas" / f"{item['id']}.json", req.schema_)
    _cache.pop(item["id"], None)
    _record(item, kind, {"kind": "schema", "validated": req.validate_})
    return {"schema": req.schema_, "saved": True}


# ------------------------------------------------------------------------------------------------
# files and uploads
# ------------------------------------------------------------------------------------------------


@router.get("/{item_id}/files")
def files(item_id: str) -> list[dict]:
    item, kind = _dataset(item_id)
    return [{"id": f["id"], "name": f["name"], "size": f.get("size_bytes"), "updated_at": f.get("updated_at"), "content_type": f.get("content_type")}
            for f in _files(item, kind)]


def _header(data: bytes) -> str:
    text = data[:65536].decode("utf-8", "replace").lstrip("﻿")
    return text.splitlines()[0].strip() if text.strip() else ""


@router.post("/{item_id}/upload")
def upload(item_id: str, file: UploadFile = File(...), sheet: Optional[str] = Form(None), force: bool = Form(False)) -> dict:
    """Upload a .csv, .tsv, .xls, .xlsm or .xlsx file into a dataset (folder). A new file name appends; the same name
    with the same header updates that file; workbooks become CSV (their first sheet, or `sheet`). The file must parse
    with the dataset's saved schema (force skips the check); the first upload of a dataset without one infers it."""
    item, kind = _dataset(item_id, need="editor")
    if kind != "raw":
        raise HTTPException(400, "Upload into a dataset folder: create one with New dataset, or open the folder in Dataset Preview")
    name = drive._clean_name(Path(file.filename or "upload.csv").name)
    if not name.lower().endswith(UPLOAD_EXT):
        raise HTTPException(400, "Upload .csv, .tsv, .xls, .xlsm or .xlsx files")
    data = file.file.read()
    if len(data) > drive.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file is larger than {drive.MAX_UPLOAD_MB} MB")
    if name.lower().endswith((".xls", ".xlsm", ".xlsx")):
        try:
            name, data = R.excel_to_csv(name, data, sheet)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"could not read the workbook: {e}") from None
    existing = next((f for f in _raw_files(item) if f["name"].lower() == name.lower()), None)
    mode = "append"
    if existing:
        if _header(drive.read_bytes(existing)) != _header(data):
            raise HTTPException(409, f'{name} already exists with a different header: rename the file to append it, or upload one with the same columns to update it')
        mode = "update"
    schema = saved_schema(item["id"])
    has_schema = bool(schema and schema.get("fieldSchemaList"))
    if has_schema and not force:
        v = R.validate([(name, data)], schema)
        if not v["ok"]:
            raise HTTPException(400, {"message": f"{name} does not parse with the dataset's schema ({v['failed_rows']} rows fail).", "validation": v})
    content_type = "text/tab-separated-values" if name.lower().endswith(".tsv") else "text/csv"
    if existing:
        import pipeline_datasets

        pipeline_datasets._replace_content(existing, data, content_type)
    else:
        drive._store(item["id"], name, io.BytesIO(data), len(data), content_type)
    if not has_schema:
        _write(DIR / "schemas" / f"{item['id']}.json", R.infer(_contents(_raw_files(item))))
    db.drive_set(item["id"], updated_at=drive._now())
    _cache.pop(item["id"], None)
    item = db.drive_get(item["id"]) or item
    tx = _record(item, kind, {"kind": "upload", "file": name, "mode": mode, "by": (auth.current() or {}).get("username")})
    return {"file": name, "mode": mode, "transaction": tx, "schema_inferred": not has_schema}


@router.get("/{item_id}/download")
def download(item_id: str, format: Literal["csv", "parquet"] = "csv", delimiter: str = ",", bom: bool = False,
             transaction: Optional[str] = None) -> Response:
    """The dataset (or a version) as one file. For Excel in regions whose list separator is ";", pick that delimiter
    (and a UTF-8 BOM so accents survive) — the FAQ's "squeezed" columns."""
    item, kind = _dataset(item_id)
    base = re.sub(r"\.(parquet|csv|tsv|jsonl?|ndjson)$", "", item["name"], flags=re.I)
    if not transaction and _big(item, kind):
        # a big dataset: its Parquet file on disk as it is (CSV of it would be built in memory)
        src = source(item, kind)
        if src.path is None or format != "parquet":
            why = src.partial["reason"] if src.partial else f"the dataset holds {_size(item, kind) / 1e6:,.0f} MB"
            raise HTTPException(413, f"{why} — download it as Parquet{' once it has been read' if src.path is None else ''}, or its files from Files")
        from fastapi.responses import FileResponse
        from urllib.parse import quote as _quote

        return FileResponse(src.path, media_type=PARQUET, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(base)}.parquet"})
    t = table(item, kind, transaction)
    if not transaction and partial_of(item["id"]):
        raise HTTPException(413, f"{partial_of(item['id'])['reason']} — download its files from Files instead")
    if format == "parquet":
        data, media, ext = R.to_parquet(t), PARQUET, "parquet"
    else:
        delim = {"tab": "\t", "\\t": "\t"}.get(delimiter, delimiter)[:1] or ","
        data, media, ext = R.to_csv(t, delim, bom), "text/csv; charset=utf-8", "csv"
    from urllib.parse import quote

    return Response(data, media_type=media, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(base)}.{ext}"})


# ------------------------------------------------------------------------------------------------
# history, branches, compare, Time Travel
# ------------------------------------------------------------------------------------------------


@router.get("/{item_id}/history")
def history(item_id: str) -> dict:
    """Transactions (oldest data may be gone under retention) and the builds that wrote the dataset, with a summary."""
    item, _ = _dataset(item_id)
    # aborted transactions are listed (greyed out in the history) but not counted as transactions
    every = dataset_versions.history(item["id"], aborted=True)
    txs = [t for t in every if not t.get("aborted")]
    events: list[dict] = []
    try:
        import lineage

        events = lineage.node(f"dataset:{item['id']}").get("events") or []
    except Exception:  # noqa: BLE001
        events = []
    by_kind: dict[str, int] = {}
    for t in txs:
        by_kind[t.get("kind", "build")] = by_kind.get(t.get("kind", "build"), 0) + 1
    statuses: dict[str, int] = {}
    for e in events:
        statuses[e.get("status") or "unknown"] = statuses.get(e.get("status") or "unknown", 0) + 1
    return {"transactions": every, "jobs": events, "summary": {"transactions": len(txs), "by_kind": by_kind, "job_statuses": statuses,
                                                               "aborted": len(every) - len(txs),
                                                               "kept": sum(1 for t in txs if t.get("kept", True) and not t.get("purged"))}}


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    transaction: Optional[str] = None


@router.post("/{item_id}/branches")
def create_branch(item_id: str, req: BranchIn) -> dict:
    """History → Create branch: the dataset as of a transaction (default: now) on a new branch, under
    _branches/<branch>/ next to the master copy (where builds on that branch write)."""
    item, kind = _dataset(item_id, need="editor")
    if kind == "iceberg":
        raise HTTPException(400, "Iceberg tables have their own branches (Details → Branches)")
    name = req.name.strip()
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", name) or name == "master":
        raise HTTPException(400, "a branch name holds letters, digits, . _ - and /, and is not master")
    if any(b["branch"] == name for b in branches(item)):
        raise HTTPException(409, f"the branch {name} already has this dataset")
    parent, _ = _master(item)
    folder = drive._ensure_folders(parent, [BRANCHES, name.replace("/", "-")])
    if kind != "parquet":
        return _branch_raw(item, kind, folder, name, req.transaction)
    data = dataset_versions.data(item["id"], req.transaction) if req.transaction else drive.read_bytes(item)
    if data is None:
        raise HTTPException(404, "that transaction's data is no longer kept")
    new = drive.save_bytes(folder, item["name"], data, PARQUET)
    dataset_versions.record(new["id"], data, "branch", {"kind": "branch", "from": item["id"], "from_transaction": req.transaction})
    return {"branch": name, "item_id": new["id"]}


def _branch_raw(item: dict, kind: str, folder: str, name: str, transaction: Optional[str]) -> dict:
    """A branch of a raw dataset (a CSV / JSON file, or a folder of them): its files copied with the saved schema, so
    uploads on the branch leave master alone. As of a transaction, a folder branch holds that transaction's parsed rows
    (a Parquet file)."""
    if transaction:
        data = dataset_versions.data(item["id"], transaction)
        if data is None:
            raise HTTPException(404, "that transaction's data is no longer kept")
        if kind == "file":
            raise HTTPException(400, "a branch of a single raw file is made from its current version (a transaction holds parsed rows)")
        target = drive._insert_container(folder, "folder", item["name"])
        drive.save_bytes(target, f"{item['name']}-{transaction}.parquet", data, PARQUET)
        dataset_versions.record(target, data, "branch", {"kind": "branch", "from": item["id"], "from_transaction": transaction})
        return {"branch": name, "item_id": target}
    if kind == "file":
        target = drive.save_bytes(folder, item["name"], drive.read_bytes(item), item.get("content_type") or "text/csv")["id"]
    else:
        target = drive._insert_container(folder, "folder", item["name"])
        for f in _raw_files(item):
            drive.save_bytes(target, f["name"], drive.read_bytes(f), f.get("content_type") or "text/csv")
    schema = saved_schema(item["id"])
    if schema:
        _write(DIR / "schemas" / f"{_safe(target)}.json", schema)
    _record(db.drive_get(target), kind, {"kind": "branch", "from": item["id"]})
    return {"branch": name, "item_id": target}


class Ref(BaseModel):
    item_id: Optional[str] = None
    transaction: Optional[str] = None


class CompareIn(BaseModel):
    base: Ref = Field(default_factory=Ref)
    other: Ref
    key: Optional[str] = None
    limit: int = Field(200, ge=1, le=2000)


def _ref_table(default_id: str, r: Ref) -> tuple[pa.Table, str]:
    item, kind = _dataset(r.item_id or default_id)
    label = item["name"] + (f" @ {r.transaction}" if r.transaction else "")
    return table(item, kind, r.transaction), label


@router.post("/{item_id}/compare")
def compare(item_id: str, req: CompareIn) -> dict:
    """Compare tab: this dataset (or a version of it) against another dataset, an older transaction or a branch."""
    a, la = _ref_table(item_id, req.base)
    b, lb = _ref_table(item_id, req.other)
    return {"base": la, "other": lb, **R.compare(a, b, req.key, req.limit)}


class RangeIn(BaseModel):
    from_transaction: str
    to_transaction: Optional[str] = None
    key: Optional[str] = None
    limit: int = Field(200, ge=1, le=2000)


@router.post("/{item_id}/time-travel/range")
def time_range(item_id: str, req: RangeIn) -> dict:
    """Time Travel → Range: what changed between an older baseline and a newer version (default: the current data)."""
    item, kind = _dataset(item_id)
    a = table(item, kind, req.from_transaction)
    b = table(item, kind, req.to_transaction)
    return R.compare(a, b, req.key, req.limit)


class BisectIn(BaseModel):
    mode: Literal["row_added", "row_removed", "value_changed"]
    key: str
    key_value: Any
    column: Optional[str] = None
    value: Any = None
    # the versions loaded on the page, oldest first (bisect searches only these)
    transactions: list[str] = Field(default_factory=list, max_length=500)


@router.post("/{item_id}/time-travel/bisect")
def bisect(item_id: str, req: BisectIn) -> dict:
    item, kind = _dataset(item_id)
    if req.mode == "value_changed" and not req.column:
        raise HTTPException(400, "a value bisect needs the column")
    versions = []
    for tx in req.transactions:
        raw = dataset_versions.data(item["id"], tx)
        if raw is not None:
            versions.append((tx, pq.read_table(io.BytesIO(raw))))
    if not versions:
        raise HTTPException(400, "no loaded version still has its data")
    if req.key not in versions[-1][1].column_names and all(req.key not in t.column_names for _, t in versions):
        raise HTTPException(400, f"no version has the key column {req.key}")
    return R.bisect(versions, req.mode, req.key, req.key_value, req.column, req.value)


# ------------------------------------------------------------------------------------------------
# custom metadata, column issues, health, resource usage
# ------------------------------------------------------------------------------------------------


class MetadataIn(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)


@router.put("/{item_id}/metadata")
def save_metadata(item_id: str, req: MetadataIn) -> dict:
    """Details → Custom metadata: fields shown in the information panel."""
    item, _ = _dataset(item_id, need="editor")
    with _lock:
        m = _meta(item["id"])
        m["custom"] = {k.strip()[:100]: str(v)[:2000] for k, v in req.fields.items() if k.strip()}
        _save_meta(item["id"], m)
    return m["custom"]


class IssueIn(BaseModel):
    column: Optional[str] = None
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=5000)
    assignee: Optional[str] = None


def _me_id() -> str:
    return (auth.current() or {}).get("id") or "local"


def _notify_issue(item: dict, issue: dict, what: str, skip: Optional[str] = None) -> None:
    """Tell the issue's assignee and watchers (not the person who made the change) — inbox, and email when set up."""
    import notify

    people = {issue.get("assignee"), *(issue.get("watchers") or [])} - {None, skip}
    where = item["name"] + (f" · column {issue['column']}" if issue.get("column") else "")
    for uid in people:
        try:
            notify.deliver(uid, f"Issue {what}: {issue['title']}", (where + chr(10) * 2 + (issue.get("description") or "")).strip(),
                           link=f"/datasets/{item['id']}?issue={issue['id']}", link_label="Open the issue", source="dataset_issue", email=True)
        except Exception:  # noqa: BLE001 - a notification never fails the change
            pass


@router.get("/{item_id}/issues")
def list_issues(item_id: str) -> list[dict]:
    item, _ = _dataset(item_id)
    return sorted(_meta(item["id"])["issues"], key=lambda i: i.get("created_at", ""), reverse=True)


@router.post("/{item_id}/issues")
def report_issue(item_id: str, req: IssueIn) -> dict:
    """Report an issue on the dataset or one of its columns."""
    item, _ = _dataset(item_id)
    me = _me_id()
    issue = {"id": uuid.uuid4().hex[:10], "column": req.column, "title": req.title.strip(), "description": req.description.strip(), "status": "open",
             "author": (auth.current() or {}).get("username") or "local", "author_id": me, "created_at": _now(), "comments": [],
             "assignee": req.assignee or None, "watchers": [me]}
    with _lock:
        m = _meta(item["id"])
        m["issues"].append(issue)
        _save_meta(item["id"], m)
    _notify_issue(item, issue, "reported", skip=me)
    return issue


class IssueChange(BaseModel):
    status: Optional[Literal["open", "resolved"]] = None
    comment: Optional[str] = Field(None, max_length=5000)
    # "" unassigns
    assignee: Optional[str] = None
    watch: Optional[bool] = None


@router.patch("/{item_id}/issues/{issue_id}")
def update_issue(item_id: str, issue_id: str, req: IssueChange) -> dict:
    item, _ = _dataset(item_id)
    with _lock:
        m = _meta(item["id"])
        issue = next((i for i in m["issues"] if i["id"] == issue_id), None)
        if not issue:
            raise HTTPException(404, "issue not found")
        me = _me_id()
        what = None
        if req.status and req.status != issue["status"]:
            issue["status"] = req.status
            issue["resolved_at"] = _now() if req.status == "resolved" else None
            what = "resolved" if req.status == "resolved" else "reopened"
        if req.comment and req.comment.strip():
            issue["comments"].append({"author": (auth.current() or {}).get("username") or "local", "at": _now(), "text": req.comment.strip()})
            what = what or "commented on"
        if req.assignee is not None and (req.assignee or None) != issue.get("assignee"):
            issue["assignee"] = req.assignee or None
            what = what or ("assigned" if req.assignee else "unassigned")
        watchers = issue.setdefault("watchers", [])
        if req.watch is True and me not in watchers:
            watchers.append(me)
        elif req.watch is False and me in watchers:
            watchers.remove(me)
        elif (req.comment or req.status) and me not in watchers and req.watch is None:
            watchers.append(me)  # taking part in an issue watches it
        _save_meta(item["id"], m)
    if what:
        _notify_issue(item, issue, what, skip=me)
    return issue


@router.get("/tools/people")
def people() -> list[dict]:
    """People an issue can be assigned to (names only)."""
    try:
        users = auth._users()
    except Exception:  # noqa: BLE001
        return []
    return sorted(({"id": u["id"], "label": u.get("display_name") or u["username"]} for u in users if not u.get("disabled")), key=lambda u: u["label"].lower())


@router.get("/{item_id}/health")
def health(item_id: str) -> dict:
    """Health tab: the dataset's checks (Data Lineage rules, run by Data Health) with their latest results."""
    item, _ = _dataset(item_id)
    out = {"rules": [], "evaluation": None}
    try:
        import lineage

        out["rules"] = lineage.health_rules(item["id"])
        g = lineage.build_graph()
        n = g.nodes.get(f"dataset:{item['id']}")
        if n and out["rules"]:
            out["evaluation"] = lineage.evaluate_health(n, out["rules"])
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:300]
    return out


@router.get("/{item_id}/usage")
def usage(item_id: str) -> dict:
    """Details → Resource usage metrics: size and rows of every transaction over time, and what is kept on disk."""
    item, kind = _dataset(item_id)
    txs = list(reversed(dataset_versions.history(item["id"])))
    kept = 0
    for t in txs:
        p = dataset_versions._folder(item["id"]) / f"{t['id']}.parquet"
        if p.is_file():
            kept += p.stat().st_size
    return {"points": [{"at": t.get("at"), "size": t.get("size"), "rows": t.get("rows"), "kind": t.get("kind")} for t in txs],
            "current_size": sum(int(f.get("size_bytes") or 0) for f in _files(item, kind)), "versions_on_disk": kept}
