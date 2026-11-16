"""Pipeline Builder's DuckDB local engine: a batch pipeline with compute "duckdb" builds on this machine, not in the
web server's JavaScript engine. The build runner compiles each output's graph into one DuckDB statement
(web/src/lib/externalSql.ts, dialect duckdb, local inputs), and this API runs it over the inputs' Parquet files on disk
and writes the result into Files. No rows pass through the runner. That is what lets a pipeline build millions of
rows: the JS engine holds every input row in memory. The editor keeps a sample of each input, and previews a
transform node by running it the same way (its first rows, computed over every input row).

  POST /api/pipeline/duckdb/check      one row of values (expectation counts, a pivot's distinct values)
  POST /api/pipeline/duckdb/run        the output's statement → a Parquet dataset in Files (snapshot)
  GET  /api/pipeline/duckdb/runs/{id}  both start a run in a thread (checks done first): its status and result
  POST /api/pipeline/duckdb/preview    the editor's preview of a node: its first rows, over all input rows (answered
                                       directly, or a run to poll when it takes longer: a checkpoint to compute)

The statement is written by the pipeline's editors, so DuckDB never reaches the file system on its own. Each input
is registered as an Arrow dataset under its table name (in_<dataset id>), only for the Files datasets the pipeline
reads, each checked as the caller (or the build's identity). External access is then switched off and the
configuration locked, so read_parquet, COPY, ATTACH and INSTALL fail. The result streams back as Arrow batches into a
Parquet file this module writes, and pipeline_datasets.commit_output stores it with the same markings, lineage and
dataset versions as any deploy.

Checkpoints (a node marked "Mark as checkpoint" in the Builder): the compiler hands each one over as its own statement
and table name (cp_<node>), in dependency order. Each is computed once into a Parquet file under
data/duckdb-checkpoints/<pipeline>/, named by the hash of its statement and the identity of the inputs it reads
(Files item, size, updated_at) and of the checkpoints it reads, and registered like an input. Every output of a build,
and every preview, that reads it uses that file: logic and data that did not change are not computed again (Palantir's
checkpoints and preview cache), and a change of either gives a new file. The last CP_KEEP files of each checkpoint
are kept.
"""

from __future__ import annotations

import contextvars
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import pyarrow.dataset as pads
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import dataset_versions
import drive
import pipeline_datasets as pdata
import storage

router = APIRouter(prefix="/api/pipeline")

COMPUTE = "duckdb"
TABLE = re.compile(r"^in_[a-z0-9_]{1,120}$")
CP_TABLE = re.compile(r"^cp_[a-z0-9_]{1,120}$")
PIPELINE_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
# bump to compute every checkpoint again (the meaning of a statement changed: a DuckDB upgrade, a compiler fix)
CP_FORMAT = "1"
# files kept per checkpoint: the current one and the one before it (a preview of the previous logic, an older build)
CP_KEEP = 2
# a preview waits this long for its answer, then hands back a run to poll (a checkpoint can take minutes to compute).
# Short: the wait holds one of the API's request threads, and the Builder asks for every node's preview at once — at
# 20 s, ~90 previews of the 120-node BPJS pipeline held every request thread and /api/auth/status took 13 s, so the page
# said the API was offline (2026-10-30). Fast previews (0.1–3 s) still come back directly
PREVIEW_WAIT_S = 3
# DuckDB previews computing at once; the rest wait their turn in their own thread, not in a request thread (each session
# may take MEMORY and every core: unbounded, the API grew to 10 GB and 184 threads)
PREVIEW_SLOTS = threading.BoundedSemaphore(int(os.environ.get("BLUESANDAI_DUCKDB_PREVIEWS") or 2))
BATCH_ROWS = 256_000
MEMORY = os.environ.get("BLUESANDAI_DUCKDB_MEMORY", "8GB")
# rows of a node the editor previews (web/src/lib/deployed.ts SAMPLE_ROWS)
PREVIEW_ROWS = 1000


class Checkpoint(BaseModel):
    """A checkpoint node compiled on its own: the table the statements read it as, and its statement."""
    table: str
    sql: str = Field(min_length=1, max_length=2_000_000)


class Inputs(BaseModel):
    pipeline_id: str
    sql: str = Field(min_length=1, max_length=2_000_000)
    # table name in the statement → the Files dataset it reads
    inputs: dict[str, str] = {}
    # the checkpoint tables the statement reads, in dependency order (computed first, once per content)
    checkpoints: list[Checkpoint] = []


class Run(Inputs):
    name: str = Field(min_length=1, max_length=500)
    parent_id: Optional[str] = None
    item_id: Optional[str] = None
    output_id: Optional[str] = None
    output_name: Optional[str] = None


def _pipeline(pipeline_id: str, need: str) -> dict:
    auth.check_item_id(pipeline_id, need)
    content = json.loads(drive.read_bytes(pdata._pipeline_item(pipeline_id)))
    if content.get("compute") != COMPUTE:
        raise HTTPException(400, "the pipeline does not build on the DuckDB local engine")
    return content


def _statement(sql: str) -> str:
    """The statement, when it is exactly one SELECT as DuckDB's own parser reads it: a ';' inside a text literal
    (a Concatenate separator '; ') is text, and no quoting trick hides a second statement."""
    import duckdb

    s = sql.strip().rstrip(";").strip()
    try:
        statements = duckdb.extract_statements(s)
    except Exception as e:  # noqa: BLE001 - a syntax error, worded as DuckDB words it
        raise _error(e) from None
    if not re.match(r"(?is)^(with|select)\b", s) or len(statements) != 1 or statements[0].type != duckdb.StatementType.SELECT:
        raise HTTPException(400, "a DuckDB local output is a single WITH … SELECT statement")
    return s


def _input_items(content: dict, inputs: dict[str, str], request: Optional[Request]) -> dict[str, dict]:
    """The Files datasets behind the statement's tables: only ones the pipeline reads, each readable by the caller."""
    import pipeline_runtime

    allowed = {(d.get("ref") or {}).get("itemId") for d in (content.get("datasets") or {}).values()
               if isinstance(d, dict) and (d.get("ref") or {}).get("kind") == "drive"}
    out = {}
    for table, item_id in inputs.items():
        if not TABLE.match(table):
            raise HTTPException(400, f"bad input table name {table!r}")
        if item_id not in allowed:
            raise HTTPException(400, f"{table}: not a Files dataset of this pipeline")
        item = drive._item(item_id)
        pipeline_runtime.enforce_build_identity(request, "read", "item", item_id, item["name"])
        if item["kind"] != "file" or not item["name"].lower().endswith(".parquet"):
            raise HTTPException(400, f'"{item["name"]}": the DuckDB local engine reads Parquet datasets')
        out[table] = item
    return out


def _cp_dir() -> Path:
    return Path(os.environ.get("BLUESANDAI_DUCKDB_CHECKPOINTS") or (drive.LOCAL_DIR.parent / "duckdb-checkpoints"))


_cp_locks: dict[str, threading.Lock] = {}
_cp_locks_lock = threading.Lock()


def _cp_lock(path: Path) -> threading.Lock:
    """One computation of a checkpoint file at a time (two previews asking for it wait for the first)."""
    with _cp_locks_lock:
        return _cp_locks.setdefault(str(path), threading.Lock())


def _cp_prune(folder: Path, table: str) -> None:
    """Keep the CP_KEEP most recently used files of a checkpoint; one still open (Windows) is left for next time."""
    files = sorted(folder.glob(f"{table}-*.parquet"), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in files[CP_KEEP:]:
        try:
            f.unlink()
        except OSError:
            pass


class _Session:
    """A locked-down DuckDB connection over the inputs (files stored in S3 are downloaded to a temp folder first)."""

    def __init__(self, items: dict[str, dict]):
        import duckdb

        self.items = items
        self.tmp = Path(tempfile.mkdtemp(prefix="bsai-duckdb-"))
        self.con = duckdb.connect()
        self.con.execute(f"SET memory_limit = '{MEMORY}'")
        # BLUESANDAI_DUCKDB_THREADS caps it (fewer cores at full load: less power and heat on this machine)
        self.con.execute(f"SET threads = {max(1, int(os.environ.get('BLUESANDAI_DUCKDB_THREADS') or 0) or (os.cpu_count() or 2))}")
        self.con.execute(f"SET temp_directory = '{(self.tmp / 'spill').as_posix()}'")
        # the inputs are Arrow datasets, which DuckDB sizes at ~1 row: its build/probe-side choice would then put a
        # table of millions of rows into a join's hash table (21 label lookups of 5.4 million claims ran out of 8 GB).
        # Without it a join holds its right input in memory, as the Builder draws it: the lookup goes on the right.
        self.con.execute("SET disabled_optimizers = 'build_side_probe_side'")
        # rows are written to Parquet as they come: no buffering to keep the scan order of millions of rows
        self.con.execute("SET preserve_insertion_order = false")
        for table, item in items.items():
            path = drive.LOCAL_DIR / item["id"]
            if item["stored_in"] == "s3":
                path = self.tmp / item["id"]
                storage._s3().download_file(storage._bucket(), f"drive/{item['id']}", str(path))
            # an Arrow dataset: scanned in batches with column and filter push-down, never loaded whole
            self.con.register(table, pads.dataset(str(path), format="parquet"))
        self.con.execute("SET enable_external_access = false")
        self.con.execute("SET lock_configuration = true")

    def checkpoints(self, pipeline_id: Optional[str], cps: list[Checkpoint]) -> list[dict]:
        """Register each checkpoint table, computing those whose file is not there yet; what was done for each."""
        if not cps:
            return []
        if not pipeline_id or not PIPELINE_ID.match(pipeline_id):
            raise HTTPException(400, "checkpoints are kept per pipeline: give the pipeline id")
        folder = _cp_dir() / pipeline_id
        keys: dict[str, str] = {}
        done = []
        for cp in cps:
            if not CP_TABLE.match(cp.table):
                raise HTTPException(400, f"bad checkpoint table name {cp.table!r}")
            statement = _statement(cp.sql)
            h = hashlib.sha256(f"{CP_FORMAT}\n{pipeline_id}\n{statement}\n".encode())
            for t in sorted(set(re.findall(r'"(in_[a-z0-9_]+)"', statement))):
                item = self.items.get(t)
                if not item:
                    raise HTTPException(400, f"{cp.table}: reads {t}, which is not an input of this statement")
                h.update(f"{t}:{item['id']}:{item.get('size_bytes')}:{item.get('updated_at')}\n".encode())
            for t in sorted(set(re.findall(r'"(cp_[a-z0-9_]+)"', statement))):
                if t not in keys:
                    raise HTTPException(400, f"{cp.table}: reads the checkpoint {t} before it is computed")
                h.update(f"{t}:{keys[t]}\n".encode())
            keys[cp.table] = h.hexdigest()
            path = folder / f"{cp.table}-{keys[cp.table][:32]}.parquet"
            started = time.time()
            with _cp_lock(path):
                reused = path.exists()
                if reused:
                    try:  # a file left zeroed by a power cut is computed again, not read
                        pq.ParquetFile(path).metadata
                        os.utime(path)  # recently used: kept by the pruning
                    except Exception:  # noqa: BLE001
                        path.unlink(missing_ok=True)
                        reused = False
                if not reused:
                    folder.mkdir(parents=True, exist_ok=True)
                    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.tmp")
                    try:
                        reader = self.con.execute(statement).to_arrow_reader(BATCH_ROWS)
                        with pq.ParquetWriter(tmp, reader.schema, compression="zstd") as w:
                            for batch in reader:
                                w.write_batch(batch)
                        with open(tmp, "rb+") as f:  # on the disk before the rename makes it the checkpoint
                            os.fsync(f.fileno())
                        os.replace(tmp, path)
                    finally:
                        tmp.unlink(missing_ok=True)
                    _cp_prune(folder, cp.table)
            self.con.register(cp.table, pads.dataset(str(path), format="parquet"))
            meta = pq.ParquetFile(path).metadata
            done.append({"table": cp.table, "rows": meta.num_rows, "columns": meta.num_columns, "reused": reused,
                         "seconds": round(time.time() - started, 1)})
        return done

    def close(self) -> None:
        try:
            self.con.close()
        finally:
            shutil.rmtree(self.tmp, ignore_errors=True)


def _error(e: Exception) -> HTTPException:
    return HTTPException(400, f"DuckDB: {str(e).strip().splitlines()[0][:600]}")


# Runs go on in a thread and are polled (GET /duckdb/runs/{id}): an output of millions of rows can take longer than
# an HTTP request may wait (the runner's fetch gives up on a response after 300 s)
_runs: dict[str, dict] = {}
_runs_lock = threading.Lock()
KEEP_S = 3600


def _caller() -> str:
    p = auth.current() or {}
    return f"{'service' if p.get('service') else 'user'}:{p.get('id') or ''}"


def _start(work) -> dict:
    """Run `work()` in a thread as the caller (the auth context goes with it); the run's id to poll."""
    run_id = uuid.uuid4().hex
    now = time.time()
    with _runs_lock:
        for k in [k for k, r in _runs.items() if r.get("finished") and now - r["finished"] > KEEP_S]:
            del _runs[k]
        _runs[run_id] = {"status": "running", "caller": _caller(), "started": now, "done": threading.Event()}

    def go() -> None:
        try:
            out = {"status": "succeeded", "result": work()}
        except HTTPException as e:
            out = {"status": "failed", "error": e.detail if isinstance(e.detail, str) else json.dumps(e.detail), "code": e.status_code}
        except Exception as e:  # noqa: BLE001
            out = {"status": "failed", "error": _error(e).detail, "code": 400}
        with _runs_lock:
            _runs[run_id].update(out, finished=time.time())
            _runs[run_id]["done"].set()

    threading.Thread(target=contextvars.copy_context().run, args=(go,), daemon=True, name=f"duckdb-{run_id[:8]}").start()
    return {"run_id": run_id}


@router.get("/duckdb/runs/{run_id}")
def run_status(run_id: str) -> dict:
    """A run's status: running, or succeeded with its result, or failed with the error (and its HTTP status)."""
    with _runs_lock:
        r = _runs.get(run_id)
        if not r or r["caller"] != _caller():
            raise HTTPException(404, "no such DuckDB run")
        return {k: v for k, v in r.items() if k not in ("caller", "done")} | {"seconds": round((r.get("finished") or time.time()) - r["started"], 1)}


@router.post("/duckdb/check")
def check(req: Inputs, request: Request = None) -> dict:  # type: ignore[assignment]
    """Start a check statement (expectation counts, a pivot's values); its result: the one row's values in SELECT order."""
    import pipeline_runtime

    drive._require_db()
    content = _pipeline(req.pipeline_id, "editor")
    pipeline_runtime.enforce_build_identity(request, "read", "pipeline", req.pipeline_id)
    items = _input_items(content, req.inputs, request)
    statement = _statement(req.sql)

    def work() -> dict:
        s = _Session(items)
        try:
            cps = s.checkpoints(req.pipeline_id, req.checkpoints)
            row = s.con.execute(statement).fetchone()
        finally:
            s.close()
        return {"values": [int(v) if isinstance(v, int) else v for v in (row or [])], "checkpoints": cps}

    return _start(work)


@router.post("/duckdb/run")
def run(req: Run, request: Request = None) -> dict:  # type: ignore[assignment]
    """Start an output's statement; its result: the Parquet dataset (a SNAPSHOT) written in Files, as a deploy answers."""
    import pipeline_runtime

    drive._require_db()
    content = _pipeline(req.pipeline_id, "editor")
    pipeline_runtime.enforce_build_identity(request, "write", "pipeline", req.pipeline_id)
    pdata._check_deploy_target(req.item_id, req.pipeline_id)
    existing = pdata._live_file(req.item_id)
    if request is not None and request.headers.get("x-bsai-build"):
        pdata._build_identity(request, "write", existing, req.parent_id, req.output_name or req.name)
    items = _input_items(content, req.inputs, request)
    statement = _statement(req.sql)

    def work() -> dict:
        s = _Session(items)
        target = s.tmp / "output.parquet"
        rows = 0
        try:
            cps = s.checkpoints(req.pipeline_id, req.checkpoints)
            reader = s.con.execute(statement).to_arrow_reader(BATCH_ROWS)
            with pq.ParquetWriter(target, reader.schema, compression="zstd") as w:
                for batch in reader:
                    w.write_batch(batch)
                    rows += batch.num_rows
            columns = len(reader.schema)
            if existing and dataset_versions.abort_if_empty(existing["id"], rows, {"kind": "pipeline", "id": req.pipeline_id,
                                                                                  "name": req.output_name or req.name, "mode": "snapshot"}):
                current = pq.ParquetFile(io.BytesIO(drive.read_bytes(existing))).metadata
                return {"item": drive._with_path(drive._item(existing["id"])), "rows": current.num_rows, "columns": current.num_columns,
                        "transaction": "ABORTED", "written": 0, "aborted": True, "checkpoints": cps}
            data = target.read_bytes()
        finally:
            s.close()
        item = pdata.commit_output(existing, req.parent_id, req.name, data, rows, req.pipeline_id, req.output_id,
                                   req.output_name or req.name, "snapshot", "SNAPSHOT", rows)
        return {"item": drive._with_path(item), "rows": rows, "columns": columns, "transaction": "SNAPSHOT", "written": rows, "checkpoints": cps}

    return _start(work)


class Preview(BaseModel):
    """The editor's preview of a node in a DuckDB local pipeline: the node compiled to one statement (as a build)."""
    pipeline_id: Optional[str] = None
    sql: str = Field(min_length=1, max_length=2_000_000)
    inputs: dict[str, str] = {}
    checkpoints: list[Checkpoint] = []
    limit: int = Field(PREVIEW_ROWS, ge=1, le=PREVIEW_ROWS)
    # the preview's Next pages: the rows after the first `offset` (the editor wraps Find / Filter by / sort in `sql`)
    offset: int = Field(0, ge=0)
    # false: no totalRows, for the next pages of a statement whose first page was counted
    count: bool = True
    # the pages' ORDER BY (the editor's: a node's rows in one fixed order, so that pages follow on from each other).
    # Only the page is ordered: counting an ordered statement sorts every row first (10 s instead of 0.2 s at 5M rows)
    order: Optional[str] = Field(None, max_length=200_000)


# Node previews of unchanged data must not compute again (Palantir's preview cache, Foundry announcements
# 2024-06: "all node previews can make use of cached results, so only additional downstream nodes need to
# be computed"). Ours live only in this process: the last preview answers, keyed by the statement and the
# inputs' identity as recorded in Files (id, size, updated_at). A redeployed input gets a new updated_at,
# so its key changes and that preview runs again; a browser refresh on static data answers from here.
_preview_cache: dict[str, dict] = {}
_preview_lock = threading.Lock()
_PREVIEW_CACHE_MAX = 64


def _preview_key(req: Preview, items: dict[str, dict]) -> str:
    import hashlib

    parts = [req.sql, str(req.limit), str(req.offset), str(req.count), req.order or "", *(f"{cp.table}\n{cp.sql}" for cp in req.checkpoints)]
    for table in sorted(items):
        item = items[table]
        parts.append(f"{table}:{item['id']}:{item.get('size_bytes')}:{item.get('updated_at')}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


@router.post("/duckdb/preview")
def preview(req: Preview) -> dict:
    """The first rows of a node's result, computed over all the rows of its inputs (so aggregates are exact). Read-only;
    each input is a Parquet dataset the caller may read. Answered directly when it is done within PREVIEW_WAIT_S
    (previews are interactive); else {run_id}, the run to poll (GET /duckdb/runs/{id}: its result is the preview)."""
    drive._require_db()
    if req.pipeline_id:
        auth.check_item_id(req.pipeline_id, "viewer")
    items = {}
    for table, item_id in req.inputs.items():
        if not TABLE.match(table):
            raise HTTPException(400, f"bad input table name {table!r}")
        item = drive._item(item_id)
        if item["kind"] != "file" or not item["name"].lower().endswith(".parquet"):
            raise HTTPException(400, f'"{item["name"]}": the DuckDB local engine reads Parquet datasets')
        items[table] = item
    statement = _statement(req.sql)
    # the page, ordered: still exactly one SELECT (the order cannot close the statement and start another)
    page = _statement(f"SELECT * FROM ({statement}) AS preview_rows" + (f"\nORDER BY {req.order}" if req.order and req.order.strip() else ""))
    key = _preview_key(req, items)
    with _preview_lock:
        hit = _preview_cache.get(key)
    if hit is not None:
        return hit

    def work() -> dict:
        with PREVIEW_SLOTS:
            with _preview_lock:  # computed meanwhile by a preview of the same node that waited ahead of this one
                hit = _preview_cache.get(key)
            if hit is not None:
                return hit
            return compute()

    def compute() -> dict:
        s = _Session(items)
        try:
            s.checkpoints(req.pipeline_id, req.checkpoints)
            table = s.con.execute(f"{page}\nLIMIT {req.limit} OFFSET {req.offset}").to_arrow_table()
            # the node's real row count: the payload above is only the first `limit` preview rows, and the
            # editor must never present that sample as the node's size (the graph reads millions of rows)
            total_rows = s.con.execute(f"SELECT count(*) FROM ({statement})").fetchone()[0] if req.count else None
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise _error(e) from None
        finally:
            s.close()
        payload = pdata.table_payload(table, "preview")
        if total_rows is not None:
            payload["totalRows"] = int(total_rows)
        with _preview_lock:
            _preview_cache[key] = payload
            while len(_preview_cache) > _PREVIEW_CACHE_MAX:
                _preview_cache.pop(next(iter(_preview_cache)))
        return payload

    started = _start(work)
    with _runs_lock:
        done = _runs[started["run_id"]]["done"]
    if not done.wait(PREVIEW_WAIT_S):
        return started
    with _runs_lock:
        r = _runs[started["run_id"]]
    if r["status"] == "failed":
        raise HTTPException(r.get("code", 400), r["error"])
    return r["result"]
