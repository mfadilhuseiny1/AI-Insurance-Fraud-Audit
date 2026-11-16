"""SQL in Foundry (palantir.com/docs/foundry/sql-warehousing): SQL Studio, the SQL console and their SQL engine.

Queries use Foundry's Spark SQL dialect. sqlglot parses them (read="spark"); every table reference is resolved to a
resource the caller may read, registered in a DuckDB connection under a private name (as Arrow, or a lazy scan of its
Parquet file: see "Out of core" below), and
the statement is transpiled to DuckDB and run there:

  data mode (Furnace)        `/path/to/dataset`, `ri.foundry.main.dataset.<id>` or an item id; a branch as
                             `branch`.`/path` or `/path`.branch_<name>; Parquet / CSV / JSON datasets, Views, Iceberg tables
                             (and their metadata tables `/path`.snapshots / .files / .history / .refs / .manifests)
  object mode (Ontology SQL) `ri.ontology.main.object-type.<id>` or an object type's API name (columns: property API
                             names), `ri.ontology.main.relation.<id>` many-to-many links (columns
                             <objectTypeApiName>_<linkApiName> holding the linked primary keys); read-only;
                             DECLARE @var TYPE = value[, ...] and object set variables DECLARE @x `ri...object-type...`

`SHOW FUNCTIONS [LIKE 'pattern']` lists DuckDB's functions (name, kind scalar / aggregate / window, signature). Results
are previews: the first 1,000 rows (up to 10,000 when asked). Writes (CREATE TABLE, INSERT, UPDATE, DELETE, ALTER TABLE,
BEGIN … COMMIT blocks) run in sql_writes.py. SQL access needs read access to every referenced resource (markings, Project roles, object type access).

Worksheets: private ones (only their owner) or saved into a Project (a Files item `<name>.sqlworksheet` whose access
decides who can read / edit it); each save is a version that can be restored; unsaved changes (and the scratchpad) are
kept as per-user drafts. The AIP panel generates / explains / fixes SQL with the schemas of the referenced resources.

Out of core: a Parquet dataset of SCAN_BYTES or more (its file; kept in S3: a local copy streamed to disk once per
version, data/sql-studio/s3-cache) and a big raw dataset Dataset Preview keeps as one Parquet copy on disk are not
loaded into memory: DuckDB scans the file lazily (only the columns and row groups the query needs), and
sorts, joins, aggregations and windows past MEMORY_LIMIT spill to a temp directory (data/sql-studio/duckdb-tmp), with
one thread per MEMORY_PER_THREAD of the limit at most (more threads than that run out of memory instead of spilling). A
restricted view over such a dataset is filtered by its policy batch by batch into a Parquet file (cached per reader and
dataset version) that is scanned the same way. Every connection is locked to the files the statement referenced: no
other file can be read and no setting changed. Smaller datasets, Views, Iceberg tables and object types are read into
memory as before.

Mounted by server.py under /api/sql.
"""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional, Union

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/sql")

PREVIEW_LIMITS = (1000, 10000)
TIMEOUT_S = 120
WORKSHEET_TYPE = "application/vnd.bluesandai.sql-worksheet+json"
ICEBERG_METADATA = ("snapshots", "files", "history", "refs", "manifests", "partitions", "entries")
DIR = Path("data/sql-studio")
_lock = threading.RLock()
# out of core: datasets this big are scanned from disk, and what DuckDB holds in memory before spilling to disk
SCAN_BYTES = int(os.environ.get("BLUESANDAI_SQL_SCAN_BYTES") or 32 * 2**20)
MEMORY_LIMIT = os.environ.get("BLUESANDAI_SQL_MEMORY_LIMIT") or "2GB"
# threads per query: at most one per MEMORY_PER_THREAD of MEMORY_LIMIT (every thread pins blocks of its own; a big
# window or sort with many threads under a small limit runs out of memory instead of spilling)
MEMORY_PER_THREAD = 64 * 2**20
THREADS = int(os.environ.get("BLUESANDAI_SQL_THREADS") or 0)  # 0: by MEMORY_LIMIT and the CPU count
RV_CACHE_FILES = 16  # restricted views filtered to disk, kept per reader and dataset version
S3_CACHE_BYTES = int(os.environ.get("BLUESANDAI_SQL_S3_CACHE_BYTES") or 20 * 2**30)  # local copies of big S3 datasets


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "sql-studio"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    p = auth.current()
    return (p or {}).get("id") or "system"


# ------------------------------------------------------------------------------------------------
# resolving table references
# ------------------------------------------------------------------------------------------------

ITEM_ID = re.compile(r"^[0-9a-f]{16}$")
UNQUOTED_RID = re.compile(r"(?<![`\w.\-])(ri\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+\.[A-Za-z0-9_\-]+)")


def _item_of(ref: str) -> dict:
    """A Files item by path (`/Project/folder/name`, the extension optional), item id or `ri.foundry.main.<kind>.<id>`."""
    import code_repos

    r = ref.strip()
    if r.startswith("ri."):
        r = r.rsplit(".", 1)[-1]
    if ITEM_ID.match(r):
        item = db.drive_get(r)
        if item and not item.get("trashed_at"):
            return item
        raise HTTPException(400, f"no dataset with the id {ref}")
    try:
        return code_repos.resolve_dataset(r.lstrip("/"))
    except ValueError as e:
        raise HTTPException(400, str(e).replace("Input ", "Table ")) from None


class _OnDisk:
    """A table reference read lazily from one Parquet file on disk (never loaded into memory here)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        f = pq.ParquetFile(path)  # the footer only
        try:
            self.schema = f.schema_arrow
            self.num_rows = f.metadata.num_rows
        finally:
            f.close()


Source = Union[pa.Table, _OnDisk]


def _on_disk(item: dict, kind: str) -> Optional[_OnDisk]:
    """A dataset's rows as a Parquet file to scan (the caller's access to it already checked), or None: read into memory."""
    import dataset_preview

    size = int(item.get("size_bytes") or 0) if kind == "parquet" else 0
    if kind == "parquet" and size >= SCAN_BYTES:
        auth.check_item(item)  # as reading its bytes does
        if item.get("stored_in") == "s3":
            return _OnDisk(_s3_copy(item))
        path = drive.LOCAL_DIR / item["id"]
        if path.is_file():
            return _OnDisk(path)
        return None
    # a big raw dataset Dataset Preview reads out of core: its Parquet copy, once made (until then its first rows)
    source = getattr(dataset_preview, "source", None)
    big = getattr(dataset_preview, "_big", None)
    if kind in ("file", "raw") and source is not None and big is not None and big(item, kind):
        src = source(item, kind)
        if getattr(src, "path", None) is not None:
            return _OnDisk(Path(src.path))
    return None


def _s3_copy(item: dict) -> Path:
    """A Parquet dataset kept in S3 as a local file (streamed to disk once per version, never into memory), cached
    under data/sql-studio/s3-cache up to S3_CACHE_BYTES (least recently used copies removed first)."""
    stamp = json.dumps([item["id"], str(item.get("updated_at") or ""), int(item.get("size_bytes") or 0)])
    cache = DIR / "s3-cache"
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{item['id']}-{hashlib.sha1(stamp.encode()).hexdigest()[:16]}.parquet"
    if out.is_file():
        try:
            os.utime(out)
        except OSError:
            pass
        return out
    tmp = cache / f"{out.stem}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        drive.copy_content(item, tmp)  # checks the caller's markings, as read_bytes does
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    files = sorted(cache.glob("*.parquet"), key=lambda x: x.stat().st_mtime, reverse=True)
    total = 0
    for f in files:
        total += f.stat().st_size
        if f != out and total > S3_CACHE_BYTES:
            try:
                f.unlink()  # a copy another query is reading stays (Windows refuses), removed next time
            except OSError:
                pass
    return out


def _data_source(ref: str, branch: Optional[str] = None, lazy: bool = True) -> tuple[Source, dict]:
    """Rows of a dataset / View / Iceberg table the caller may read (and its item): with `lazy`, a big Parquet dataset
    as its file on disk."""
    import dataset_preview
    import iceberg_catalog

    item = _item_of(ref)
    drive._item(item["id"], need="viewer")  # markings and Project role
    if item.get("content_type") == iceberg_catalog.ICEBERG:
        return iceberg_catalog.scan_arrow(item["id"], branch), item
    if item["name"].lower().endswith(".view"):
        import views

        return views.read_view(item["id"])[0], item
    if branch and branch != "master":
        match = next((b for b in dataset_preview.branches(item) if b["branch"] == branch), None)
        if not match:
            raise HTTPException(400, f'{ref} has no branch "{branch}"')
        item = drive._item(match["item_id"], need="viewer")
    item, kind = dataset_preview._dataset(item["id"])
    disk = _on_disk(item, kind) if lazy else None
    if disk is not None:
        return disk, item
    return dataset_preview.table(item, kind), item


def _data_table(ref: str, branch: Optional[str] = None) -> tuple[pa.Table, dict]:
    """Rows of a dataset / View / Iceberg table the caller may read (and its item), in memory (other modules' reads)."""
    t, item = _data_source(ref, branch, lazy=False)
    assert isinstance(t, pa.Table)
    return t, item


def _restricted_source(ref: str) -> tuple[Source, dict]:
    """`ri.foundry.main.restricted-view.<id>` as the caller sees it. Over a backing dataset scanned from disk the rows
    are filtered as restricted_views.visible_table does — the system sees every row, anyone else the rows their
    attributes pass the policy for (ontology_security.evaluate on each row) — batch by batch into a Parquet file;
    otherwise restricted_views.table_for_ref (in memory) as before."""
    import dataset_preview
    import restricted_views as rvm

    rid = ref[len(rvm.RID):] if ref.startswith(rvm.RID) else ref
    rec = rvm._get(rid)  # Viewer on the view (its markings: the backing dataset's, less those it stops propagating)
    item, kind = dataset_preview._dataset(rvm.backing_item_id(rec))  # as _backing_table reads it
    disk = _on_disk(item, kind)
    if disk is None:
        return rvm.visible_table(rec), rec
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return disk, rec
    import ontology_security as osec

    user = rvm._user()
    policy = rec.get("policy")
    st = disk.path.stat()
    key = hashlib.sha1(json.dumps([rid, policy, user, str(disk.path), st.st_size, st.st_mtime_ns], sort_keys=True, default=str).encode()).hexdigest()[:24]
    cache = DIR / "rv-scan"
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{key}.parquet"
    if not out.is_file():
        tmp = cache / f"{key}.{uuid.uuid4().hex[:8]}.tmp"
        f = pq.ParquetFile(disk.path)
        try:
            with pq.ParquetWriter(tmp, f.schema_arrow) as w:
                for batch in f.iter_batches(batch_size=65_536):
                    rows = batch.to_pylist()
                    keep = [i for i, r in enumerate(rows) if osec.evaluate(policy, user, r)]
                    if keep:
                        w.write_batch(batch if len(keep) == batch.num_rows else batch.take(pa.array(keep, type=pa.int64())))
            tmp.replace(out)
        finally:
            f.close()
            tmp.unlink(missing_ok=True)
        _prune(cache)
    else:
        try:
            os.utime(out)  # recently used: kept by _prune
        except OSError:
            pass
    return _OnDisk(out), rec


def _prune(cache: Path) -> None:
    files = sorted(cache.glob("*.parquet"), key=lambda x: x.stat().st_mtime, reverse=True)
    for old in files[RV_CACHE_FILES:]:
        try:
            old.unlink()
        except OSError:
            pass


def _iceberg_metadata(ref: str, which: str, branch: Optional[str]) -> pa.Table:
    import iceberg_catalog

    item = _item_of(ref)
    drive._item(item["id"], need="viewer")
    if item.get("content_type") != iceberg_catalog.ICEBERG:
        raise HTTPException(400, f"{ref}.{which}: metadata tables exist for Iceberg tables only")
    tbl = iceberg_catalog.server_table(item["id"], branch)
    try:
        return getattr(tbl.inspect, which)()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"{ref}.{which}: {e}") from None


PROP_TYPES = {"string": pa.string(), "integer": pa.int64(), "long": pa.int64(), "short": pa.int64(), "byte": pa.int64(), "double": pa.float64(),
              "float": pa.float64(), "decimal": pa.float64(), "boolean": pa.bool_(), "date": pa.date32(), "timestamp": pa.timestamp("us", tz="UTC")}


def _coerce(v: Any, t: pa.DataType) -> Any:
    if v is None or v == "":
        return None
    try:
        if pa.types.is_integer(t):
            return int(v)
        if pa.types.is_floating(t):
            return float(v)
        if pa.types.is_boolean(t):
            return v if isinstance(v, bool) else str(v).lower() in ("true", "1", "yes")
        if pa.types.is_date(t):
            return dt.date.fromisoformat(str(v)[:10])
        if pa.types.is_timestamp(t):
            x = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            return x if x.tzinfo else x.replace(tzinfo=dt.timezone.utc)
        return v if isinstance(v, str) else json.dumps(v, default=str) if isinstance(v, (dict, list)) else str(v)
    except (TypeError, ValueError):
        return None


def _object_type_of(ref: str) -> dict:
    import ontology

    r = ref.strip()
    key = r.rsplit(".", 1)[-1] if r.startswith("ri.ontology.main.object-type.") else r
    types = ontology._all("object-types")
    t = next((x for x in types if x["id"] == key), None) or next((x for x in types if x["api_name"].lower() == key.lower()), None)
    if not t:
        raise HTTPException(400, f"no object type {ref} (use its RID or API name)")
    return t


def _object_table(t: dict) -> pa.Table:
    import ontology

    objs = ontology._objects(t["id"])  # the object type's markings
    props = t["properties"]
    schema = pa.schema([(p["api_name"], pa.list_(pa.string()) if p.get("array") else PROP_TYPES.get(p.get("type", "string"), pa.string())) for p in props])
    rows = []
    for pk, o in objs.items():
        if not ontology._can_see(t, o):
            continue
        vals = dict(o.get("properties") or {})
        vals.setdefault(t["primary_key"], pk)
        rows.append({f.name: ([str(x) for x in vals[f.name]] if isinstance(vals.get(f.name), list) else None) if pa.types.is_list(f.type) else _coerce(vals.get(f.name), f.type)
                     for f in schema})
    return pa.Table.from_pylist(rows, schema=schema)


def _relation_table(ref: str) -> pa.Table:
    import ontology
    import ontology_model

    lt_id = ref.rsplit(".", 1)[-1]
    lt = next((x for x in ontology._all("link-types") if x["id"] == lt_id), None)
    if not lt:
        raise HTTPException(400, f"no link type {ref}")
    if lt.get("cardinality") != "many_to_many":
        raise HTTPException(400, f"{ref}: only many-to-many links are tables (join one-to-one / many-to-one links on their keys)")
    auth.check_resource("link_type", lt["id"])
    src = ontology._object_type(lt["source"]["object_type_id"])
    tgt = ontology._object_type(lt["target"]["object_type_id"])
    ontology._objects(src["id"])
    ontology._objects(tgt["id"])
    # <objectTypeApiName>_<the link's API name on that type>: the linked objects' primary keys
    src_col = f"{src['api_name']}_{lt['target']['api_name']}"
    tgt_col = f"{tgt['api_name']}_{lt['source']['api_name']}"
    pairs = list(ontology_model._pairs(lt))
    return pa.table({src_col: pa.array([str(t) for _, t in pairs], pa.string()), tgt_col: pa.array([str(s) for s, _ in pairs], pa.string())})


# ------------------------------------------------------------------------------------------------
# running a statement
# ------------------------------------------------------------------------------------------------


def _declares(sql: str) -> tuple[str, dict[str, str]]:
    """Ontology SQL's leading `DECLARE @a TYPE = value, @b `object type rid`;`: (the rest, {name: replacement})."""
    m = re.match(r"^\s*DECLARE\s+(.+?);", sql, re.S | re.I)
    if not m:
        if re.search(r"^\s*DECLARE\b", sql, re.I | re.M):
            raise HTTPException(400, "DECLARE must be the first statement and end with a semicolon")
        return sql, {}
    rest = sql[m.end():]
    if re.search(r"^\s*(DECLARE|SET)\b", rest, re.I | re.M):
        raise HTTPException(400, "DECLARE can be used once (declare several variables with commas) and SET is not allowed")
    out: dict[str, str] = {}
    parts, depth, cur = [], 0, ""
    for ch in m.group(1):
        if ch in "([" or ch == "'" and False:
            depth += 1
        if ch in ")]":
            depth -= 1
        if ch == "," and depth == 0 and cur.count("'") % 2 == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += ch
    parts.append(cur)
    for part in parts:
        v = re.match(r"^\s*@([A-Za-z0-9_]+)\s+(`[^`]+`|[A-Za-z]+(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)\s*(?:=\s*(.+?))?\s*$", part, re.S)
        if not v:
            raise HTTPException(400, f"cannot read the declaration {part.strip()!r} (write @name TYPE = value)")
        name, typ, value = v.group(1), v.group(2), v.group(3)
        if typ.startswith("`"):
            if value is not None:
                raise HTTPException(400, f"@{name}: an object set variable is every object of its type; it cannot have a value")
            out[name] = typ
        else:
            if value is None:
                raise HTTPException(400, f"@{name} needs a value (@{name} {typ} = ...)")
            out[name] = f"CAST({value.strip()} AS {typ})"
    for name, repl in out.items():
        rest = re.sub(rf"@{name}\b", lambda _m, r=repl: r, rest)
    return rest, out


def _show_functions(like: Optional[str]) -> dict:
    import duckdb

    con = duckdb.connect()
    rows = con.execute("SELECT function_name, function_type, parameters, return_type FROM duckdb_functions() "
                       "WHERE function_type IN ('scalar', 'aggregate', 'window', 'macro') ORDER BY function_name").fetchall()
    kinds = {"macro": "scalar"}
    seen: dict[tuple, dict] = {}
    pat = re.compile("^" + re.escape(like).replace("%", ".*").replace("_", ".") + "$", re.I) if like else None
    for name, kind, params, ret in rows:
        if name.startswith("__") or (pat and not pat.match(name)):
            continue
        sig = f"{name}({', '.join(params or [])})" + (f" -> {ret}" if ret else "")
        seen.setdefault((name, sig), {"name": name, "kind": kinds.get(kind, kind), "signature": sig})
    out = list(seen.values())
    return {"columns": [{"name": "name", "type": "string"}, {"name": "kind", "type": "string"}, {"name": "signature", "type": "string"}],
            "rows": [[r["name"], r["kind"], r["signature"]] for r in out[:PREVIEW_LIMITS[1]]], "row_count": len(out), "truncated": False,
            "statement": "show_functions", "resources": []}


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return None if v != v or v in (float("inf"), float("-inf")) else v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    if isinstance(v, (list, tuple)):
        return [_cell(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _cell(x) for k, x in v.items()}
    return str(v)


WRITE_KINDS = ("Create", "Insert", "Update", "Delete", "Merge", "Drop", "Alter", "TruncateTable", "Command")


def _spark_fixups(ast: Any) -> None:
    """Spark semantics DuckDB lacks: date_add / date_sub(date, days) return a DATE (DuckDB's interval arithmetic gives a
    timestamp)."""
    from sqlglot import exp

    for node in list(ast.find_all(exp.DateAdd, exp.DateSub, exp.TsOrDsAdd)):
        unit = node.args.get("unit")
        if unit is None or str(unit.name if hasattr(unit, "name") else unit).upper() in ("DAY", "DAYS"):
            node.replace(exp.Cast(this=node.copy(), to=exp.DataType.build("date")))


def select_arrow(sql: str) -> tuple[pa.Table, list[dict]]:
    """Every row of a data mode query (Spark SQL) as Arrow, and the resources it read: the source of a write."""
    import duckdb
    import sqlglot
    from sqlglot import exp

    text = UNQUOTED_RID.sub(r"`\1`", sql.strip().rstrip(";").strip())
    try:
        ast = sqlglot.parse_one(text, read="spark")
    except sqlglot.errors.ParseError as e:
        raise HTTPException(400, f"syntax error: {e.errors[0].get('description') if e.errors else e}") from None
    if not isinstance(ast, (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery, exp.Values)):
        raise HTTPException(400, "the source of a write is a query (SELECT … or VALUES …)")
    _spark_fixups(ast)
    con = _connect()
    timer = threading.Timer(TIMEOUT_S * 5, con.interrupt)
    timer.start()
    names: dict[str, str] = {}
    try:
        paths: list[str] = []
        resources, names = _bind(ast, "data", con, paths)
        _seal(con, paths)
        query = ast.sql(dialect="duckdb")
        if isinstance(ast, exp.Values):
            query = f"SELECT * FROM ({query}) AS _sql_values"
        return con.execute(query).fetch_arrow_table(), resources
    except duckdb.InterruptException:
        raise HTTPException(408, f"the query ran longer than {TIMEOUT_S * 5} s and was stopped") from None
    except duckdb.Error as e:
        msg = str(e)
        for reg, what in names.items():
            msg = msg.replace(reg, what)
        raise HTTPException(400, re.sub(r"\s+", " ", msg)[:2000]) from None
    finally:
        timer.cancel()
        con.close()


def _sql_str(s: str) -> str:
    return s.replace("'", "''")


class _Conn:
    """A DuckDB connection that spills past MEMORY_LIMIT to a temp directory of its own (no other query's spilled
    blocks are readable from it), removed when it closes."""

    def __init__(self) -> None:
        import duckdb

        self.con: Any = None
        self.tmp = (DIR / "duckdb-tmp" / uuid.uuid4().hex[:16]).resolve()
        self.tmp.mkdir(parents=True, exist_ok=True)
        try:
            self.con = duckdb.connect()
            self.con.execute("SET TimeZone = 'UTC'")  # as Spark sessions here (code_pyapi) and Foundry's SQL
            self.con.execute(f"SET memory_limit = '{_sql_str(MEMORY_LIMIT)}'")
            self.con.execute(f"SET threads = {_threads()}")
            self.con.execute(f"SET temp_directory = '{_sql_str(self.tmp.as_posix())}'")
        except Exception:
            self.close()
            raise

    def __getattr__(self, name: str) -> Any:  # execute, register, interrupt …
        return getattr(self.con, name)

    def close(self) -> None:
        import shutil

        try:
            if self.con is not None:
                self.con.close()
        finally:
            shutil.rmtree(self.tmp, ignore_errors=True)


_UNITS = {"": 1, "B": 1, "KB": 10**3, "MB": 10**6, "GB": 10**9, "TB": 10**12, "KIB": 2**10, "MIB": 2**20, "GIB": 2**30, "TIB": 2**40}


def _threads() -> int:
    """THREADS, or one thread per MEMORY_PER_THREAD of MEMORY_LIMIT (at least 1, at most the CPU count)."""
    cpus = os.cpu_count() or 1
    if THREADS > 0:
        return min(THREADS, 4 * cpus)
    m = re.fullmatch(r"\s*([\d.]+)\s*([A-Za-z]*)\s*", MEMORY_LIMIT)
    unit = _UNITS.get(m.group(2).upper()) if m else None
    if unit is None:
        return cpus
    return max(1, min(cpus, int(float(m.group(1)) * unit) // MEMORY_PER_THREAD))


def _connect() -> _Conn:
    return _Conn()


def _seal(con: Any, paths: list[str]) -> None:
    """Lock the connection to what the statement referenced: the Parquet files bound (`paths`) and its own temp
    directory can be read — no other file, URL or extension — and no setting can be changed."""
    if paths:
        con.execute("SET allowed_paths = [" + ", ".join(f"'{_sql_str(p)}'" for p in paths) + "]")
    tmp = getattr(con, "tmp", None)
    if tmp is not None:
        con.execute(f"SET allowed_directories = ['{_sql_str(tmp.as_posix())}']")
    con.execute("SET enable_external_access = false")
    con.execute("SET lock_configuration = true")


def _register(con: Any, reg: str, table: Source, paths: list[str]) -> None:
    """A table reference in the connection: an Arrow table, or a view scanning a Parquet file lazily."""
    if isinstance(table, _OnDisk):
        p = table.path.resolve().as_posix()
        scan = f"read_parquet('{_sql_str(p)}')"
        # the column types an Arrow table of the file has in DuckDB (as when it was read into memory): read_parquet
        # widens some (a timestamp[ms] / [s] column becomes TIMESTAMP), so those are cast back
        con.register(f"{reg}_schema", table.schema.empty_table())
        want = {r[0]: r[1] for r in con.execute(f"DESCRIBE {reg}_schema").fetchall()}
        con.unregister(f"{reg}_schema")
        have = {r[0]: r[1] for r in con.execute(f"DESCRIBE SELECT * FROM {scan}").fetchall()}
        cols = [f'CAST("{c.replace(chr(34), chr(34) * 2)}" AS {want[c]}) AS "{c.replace(chr(34), chr(34) * 2)}"'
                if c in want and want[c] != have[c] else f'"{c.replace(chr(34), chr(34) * 2)}"' for c in have]
        con.execute(f"CREATE VIEW {reg} AS SELECT {', '.join(cols) if cols else '*'} FROM {scan}")
        paths.append(p)
    else:
        con.register(reg, table)


def _bind(ast: Any, mode: str, con: Any, paths: Optional[list[str]] = None) -> tuple[list[dict], dict[str, str]]:
    """Resolve every table reference of a parsed statement to a resource the caller may read, register it in the
    DuckDB connection under a private name and point the reference there: (resources, {private name: reference}).
    The Parquet files scanned from disk are added to `paths`."""
    from sqlglot import exp

    paths = [] if paths is None else paths
    ctes = {c.alias_or_name.lower() for c in ast.find_all(exp.CTE)}
    resources: list[dict] = []
    names: dict[str, str] = {}
    for i, t in enumerate(list(ast.find_all(exp.Table))):
        name, db_part, catalog = t.name, t.db, t.catalog
        if not name or (not db_part and name.lower() in ctes):
            continue
        reg = f"_sql_t{i}"
        branch = None
        what = name
        if db_part and (db_part.startswith("/") or db_part.startswith("ri.") or ITEM_ID.match(db_part)) and name.lower() in ICEBERG_METADATA:
            if mode != "data":
                raise HTTPException(400, "Iceberg metadata tables are queried in data mode")
            table = _iceberg_metadata(db_part, name.lower(), catalog or None)
            what = f"{db_part}.{name}"
            resources.append({"ref": what, "kind": "iceberg metadata"})
        elif db_part and (db_part.startswith("/") or db_part.startswith("ri.foundry") or ITEM_ID.match(db_part)) and name.lower().startswith("branch_"):
            if mode != "data":
                raise HTTPException(400, "datasets are queried in data mode")
            table, item = _data_source(db_part, name[len("branch_"):])
            what = f"{db_part}.{name}"
            resources.append({"ref": what, "kind": "dataset", "item_id": item["id"], "name": item["name"], "branch": name[len("branch_"):]})
        elif name.startswith("ri.ontology.main.object-type.") or (mode == "object" and not name.startswith("/") and not name.startswith("ri.") and not db_part):
            if mode != "object":
                raise HTTPException(400, f"{name} is an object type: object types are queried in object mode")
            ot = _object_type_of(name)
            table = _object_table(ot)
            resources.append({"ref": name, "kind": "object type", "id": ot["id"], "name": ot["display_name"], "api_name": ot["api_name"]})
        elif name.startswith("ri.ontology.main.relation."):
            if mode != "object":
                raise HTTPException(400, f"{name} is a link type: links are queried in object mode")
            table = _relation_table(name)
            resources.append({"ref": name, "kind": "link type"})
        elif name.startswith("ri.foundry.main.restricted-view."):
            if mode != "data":
                raise HTTPException(400, f"{name} is a restricted view: restricted views are queried in data mode")
            table, rv = _restricted_source(name)
            resources.append({"ref": name, "kind": "restricted view", "id": rv["id"], "name": rv["name"]})
        elif name.startswith("/") or name.startswith("ri.") or ITEM_ID.match(name):
            if mode != "data":
                raise HTTPException(400, f"{name} is a dataset: datasets are queried in data mode")
            branch = db_part or None
            table, item = _data_source(name, branch)
            resources.append({"ref": name, "kind": "Iceberg table" if item.get("content_type", "").endswith("iceberg+json") else "dataset",
                              "item_id": item["id"], "name": item["name"], **({"branch": branch} if branch else {})})
        else:
            raise HTTPException(400, f'unknown table "{name}": reference datasets by path or id in backticks (`/Project/folder/dataset`)'
                                     if mode == "data" else f'unknown table "{name}": reference object types by RID or API name')
        _register(con, reg, table, paths)
        names[reg] = what
        new = exp.Table(this=exp.to_identifier(reg))
        if t.args.get("alias"):
            new.set("alias", t.args["alias"])
        t.replace(new)
    return resources, names


def run(sql: str, mode: str = "data", limit: int = PREVIEW_LIMITS[0]) -> dict:
    """Run one statement: {columns, rows, row_count, truncated, ms, statement, resources}."""
    import duckdb
    import sqlglot
    from sqlglot import exp

    started = time.monotonic()
    limit = PREVIEW_LIMITS[1] if limit > PREVIEW_LIMITS[0] else PREVIEW_LIMITS[0]
    text = sql.strip().rstrip(";").strip()
    if not text:
        raise HTTPException(400, "write a query")
    show = re.match(r"^SHOW\s+FUNCTIONS(?:\s+LIKE\s+'([^']*)')?$", text, re.I)
    if show:
        return {**_show_functions(show.group(1)), "ms": int((time.monotonic() - started) * 1000)}
    import sql_writes

    if sql_writes.is_write(sql):
        if mode == "object":
            raise HTTPException(400, "object mode is read-only: switch to data mode to write tables")
        return sql_writes.run_script(sql)
    text, variables = _declares(text + ";")
    text = text.strip().rstrip(";").strip()
    if variables and mode != "object":
        raise HTTPException(400, "DECLARE variables are an Ontology SQL feature: switch to object mode")
    text = UNQUOTED_RID.sub(r"`\1`", text)
    try:
        statements = [s for s in sqlglot.parse(text, read="spark") if s is not None]
    except sqlglot.errors.ParseError as e:
        raise HTTPException(400, f"syntax error: {e.errors[0].get('description') if e.errors else e}" + (
            f" (line {e.errors[0].get('line')}, column {e.errors[0].get('col')})" if e.errors and e.errors[0].get("line") else "")) from None
    if not statements:
        raise HTTPException(400, "write a query")
    if len(statements) > 1:
        raise HTTPException(400, "run one statement at a time (select the statement to run)")
    ast = statements[0]
    if type(ast).__name__ not in WRITE_KINDS and not isinstance(ast, (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery)):
        # sqlglot reads stray words as an expression ("SELEC * FRM x"): not a statement
        raise HTTPException(400, "syntax error: expected a statement such as SELECT … FROM …")
    if type(ast).__name__ in WRITE_KINDS or not isinstance(ast, (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery)):
        if mode == "object":
            raise HTTPException(400, "object mode is read-only: run SELECT queries against object types")
        raise HTTPException(400, f"{type(ast).__name__.upper()} statements are not supported yet: SQL Studio runs SELECT queries (and SHOW FUNCTIONS)")
    _spark_fixups(ast)
    con = _connect()
    try:
        paths: list[str] = []
        resources, names = _bind(ast, mode, con, paths)
        _seal(con, paths)
    except Exception:
        con.close()
        raise
    if isinstance(ast, exp.Select):
        current = ast.args.get("limit")
        n = None
        try:
            n = int(current.expression.name) if current is not None else None
        except (AttributeError, ValueError):
            n = None
        ast = ast.limit(min(n, limit + 1) if n is not None else limit + 1)
        query = ast.sql(dialect="duckdb")
    else:
        query = f"SELECT * FROM ({ast.sql(dialect='duckdb')}) AS _sql_q LIMIT {limit + 1}"
    timer = threading.Timer(TIMEOUT_S, con.interrupt)
    timer.start()
    try:
        result = con.execute(query).fetch_arrow_table()
    except duckdb.InterruptException:
        raise HTTPException(408, f"the query ran longer than {TIMEOUT_S} s and was stopped") from None
    except duckdb.Error as e:
        msg = str(e)
        for reg, what in names.items():
            msg = msg.replace(reg, what)
        raise HTTPException(400, re.sub(r"\s+", " ", msg)[:2000]) from None
    finally:
        timer.cancel()
        con.close()
    truncated = result.num_rows > limit
    if truncated:
        result = result.slice(0, limit)
    cols = [{"name": f.name, "type": str(f.type)} for f in result.schema]
    data = result.to_pylist()
    return {"columns": cols, "rows": [[_cell(r[c["name"]]) for c in cols] for r in data], "row_count": result.num_rows, "truncated": truncated,
            "limit": limit, "ms": int((time.monotonic() - started) * 1000), "statement": "select", "resources": resources,
            "sql": query}


class QueryIn(BaseModel):
    sql: str = Field(min_length=1, max_length=200_000)
    mode: Literal["data", "object"] = "data"
    limit: int = PREVIEW_LIMITS[0]


@router.post("/query")
def query(req: QueryIn) -> dict:
    out = run(req.sql, req.mode, req.limit)
    out.pop("sql", None)
    return out


# ------------------------------------------------------------------------------------------------
# resources and schemas (resource browser, autocomplete, AIP)
# ------------------------------------------------------------------------------------------------


@router.get("/resources")
def resources(mode: Literal["data", "object"] = "data", q: str = "", limit: int = 300) -> list[dict]:
    """What the caller can query: data mode datasets, Views and Iceberg tables; object mode object types and many-to-many links."""
    needle = q.strip().lower()
    out: list[dict] = []
    if mode == "object":
        import ontology

        for t in ontology.list_object_types():
            if needle and needle not in t["display_name"].lower() and needle not in t["api_name"].lower():
                continue
            out.append({"kind": "object type", "name": t["display_name"], "api_name": t["api_name"], "ref": f"ri.ontology.main.object-type.{t['id']}",
                        "path": f"ontology / {t.get('ontology_id') or 'default'}", "columns": [{"name": p["api_name"], "type": p.get("type", "string")} for p in t["properties"]],
                        "count": t.get("object_count")})
        for lt in ontology._all("link-types"):
            if lt.get("cardinality") != "many_to_many" or (needle and needle not in lt.get("display_name", "").lower()):
                continue
            if not auth.visible_resources("link_type", [lt]):
                continue
            out.append({"kind": "link type", "name": lt.get("display_name") or lt["id"], "ref": f"ri.ontology.main.relation.{lt['id']}", "path": "ontology / many-to-many links"})
        return out[:limit]
    import iceberg_catalog

    rows = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND (d.content_type = %s OR d.content_type = %s OR d.name ILIKE %s)",
                          ("application/vnd.apache.parquet", iceberg_catalog.ICEBERG, "%.view"), limit=2000)
    for item in auth.visible(rows):
        path = [p["name"] for p in db.drive_path(item["id"])]
        if "_branches" in path or (needle and needle not in "/".join(path).lower()):
            continue
        # references without the .parquet extension (paths resolve without it), as Foundry dataset paths
        if path and path[-1].lower().endswith(".parquet"):
            path = [*path[:-1], path[-1][: -len(".parquet")]]
        kind = "Iceberg table" if item.get("content_type") == iceberg_catalog.ICEBERG else "View" if item["name"].lower().endswith(".view") else "dataset"
        out.append({"kind": kind, "name": item["name"], "item_id": item["id"], "ref": "/" + "/".join(path), "path": " / ".join(path[:-1]),
                    "updated_at": str(item.get("updated_at") or "")})
        if len(out) >= limit:
            break
    import restricted_views

    for rv in restricted_views.list_views():
        if needle and needle not in rv["name"].lower():
            continue
        out.append({"kind": "restricted view", "name": rv["name"], "ref": rv["rid"], "path": f"restricted views / {rv.get('backing_name') or ''}",
                    "updated_at": str(rv.get("updated_at") or rv.get("created_at") or "")})
    return sorted(out, key=lambda r: r["updated_at"], reverse=True)


@router.get("/schema")
def schema(ref: str, mode: Literal["data", "object"] = "data") -> dict:
    """The columns of one resource (a dataset path / id, or an object type / link RID)."""
    if mode == "object":
        if ref.startswith("ri.ontology.main.relation."):
            t = _relation_table(ref)
            return {"ref": ref, "columns": [{"name": f.name, "type": str(f.type)} for f in t.schema]}
        ot = _object_type_of(ref)
        return {"ref": ref, "name": ot["display_name"], "primary_key": ot["primary_key"],
                "columns": [{"name": p["api_name"], "type": p.get("type", "string"), "description": p.get("description") or ""} for p in ot["properties"]]}
    if ref.startswith("ri.foundry.main.restricted-view."):
        table, rv = _restricted_source(ref)
        return {"ref": ref, "name": rv["name"], "columns": [{"name": f.name, "type": str(f.type)} for f in table.schema], "rows": table.num_rows}
    table, item = _data_source(ref)  # a big dataset: its file's footer, not its rows
    return {"ref": ref, "name": item["name"], "columns": [{"name": f.name, "type": str(f.type)} for f in table.schema], "rows": table.num_rows}


# ------------------------------------------------------------------------------------------------
# worksheets and drafts
# ------------------------------------------------------------------------------------------------


def _store() -> dict:
    p = DIR / "worksheets.json"
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {"worksheets": {}, "drafts": {}}


def _save_store(s: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = DIR / "worksheets.tmp"
    tmp.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    tmp.replace(DIR / "worksheets.json")


def _can(ws: dict, need: str) -> bool:
    """Private: only the owner. In a Project: its Files item's access (viewer reads, editor writes)."""
    if ws.get("item_id"):
        try:
            drive._item(ws["item_id"], need="viewer" if need == "read" else "editor")
            return True
        except HTTPException:
            return False
    return ws["owner"] == _me() or not auth.enabled()


def _ws(ws_id: str, need: str = "read") -> dict:
    ws = _store()["worksheets"].get(ws_id)
    if not ws:
        raise HTTPException(404, "worksheet not found")
    if not _can(ws, need):
        raise HTTPException(403, "you cannot " + ("open" if need == "read" else "edit") + " this worksheet")
    return ws


def _public_ws(ws: dict, versions: bool = False) -> dict:
    out = {k: v for k, v in ws.items() if k != "versions"}
    out["version_count"] = len(ws.get("versions") or [])
    out["location"] = "project" if ws.get("item_id") else "private"
    if ws.get("item_id"):
        out["path"] = " / ".join(p["name"] for p in db.drive_path(ws["item_id"])[:-1])
    if versions:
        out["versions"] = [{k: v for k, v in x.items()} for x in reversed(ws.get("versions") or [])]
    out["can_edit"] = _can(ws, "write")
    return out


@router.get("/worksheets")
def list_worksheets() -> list[dict]:
    """Worksheets the caller can open: their private ones and project worksheets they can read."""
    out = [_public_ws(w) for w in _store()["worksheets"].values() if _can(w, "read")]
    return sorted(out, key=lambda w: w.get("updated_at") or "", reverse=True)


class WorksheetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sql: str = Field("", max_length=200_000)
    mode: Literal["data", "object"] = "data"
    # None: private; a Project or folder: saved there as a Files item others can open
    folder_id: Optional[str] = None


def _project_item(ws: dict, folder_id: str) -> str:
    folder = drive._item(folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "save project worksheets into a Project or a folder")
    body = json.dumps({"worksheet_id": ws["id"], "name": ws["name"]}).encode()
    name = ws["name"] if ws["name"].endswith(".sqlworksheet") else f"{ws['name']}.sqlworksheet"
    import io

    item = drive._store(folder["id"], name, io.BytesIO(body), len(body), WORKSHEET_TYPE)
    return item["id"]


@router.post("/worksheets")
def create_worksheet(req: WorksheetIn) -> dict:
    with _lock:
        s = _store()
        now = _now()
        ws = {"id": uuid.uuid4().hex[:16], "name": req.name.strip(), "owner": _me(), "mode": req.mode, "sql": req.sql, "created_at": now, "updated_at": now,
              "item_id": None, "versions": [{"id": uuid.uuid4().hex[:10], "at": now, "by": _me(), "sql": req.sql, "mode": req.mode}]}
        if req.folder_id:
            ws["item_id"] = _project_item(ws, req.folder_id)
        s["worksheets"][ws["id"]] = ws
        s["drafts"].pop(f"{_me()}:scratchpad", None)
        _save_store(s)
        return _public_ws(ws, versions=True)


@router.get("/worksheets/by-item/{item_id}")
def worksheet_by_item(item_id: str) -> dict:
    """The worksheet a project `.sqlworksheet` Files item holds (opened from Files)."""
    item = drive._item(item_id, need="viewer")
    try:
        ws_id = json.loads(drive.read_bytes(item)).get("worksheet_id")
    except (ValueError, AttributeError):
        ws_id = None
    if not ws_id:
        raise HTTPException(400, f'"{item["name"]}" is not a SQL worksheet')
    return get_worksheet(ws_id)


@router.get("/worksheets/{ws_id}")
def get_worksheet(ws_id: str) -> dict:
    ws = _ws(ws_id)
    out = _public_ws(ws, versions=True)
    draft = _store()["drafts"].get(f"{_me()}:{ws_id}")
    if draft and draft.get("sql") != ws["sql"]:
        out["draft"] = draft
    return out


class WorksheetSave(BaseModel):
    sql: str = Field("", max_length=200_000)
    mode: Literal["data", "object"] = "data"
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    # move a private worksheet into a Project (sharing it)
    folder_id: Optional[str] = None


@router.put("/worksheets/{ws_id}")
def save_worksheet(ws_id: str, req: WorksheetSave) -> dict:
    """A manual save: a new version (the unsaved draft is cleared)."""
    with _lock:
        s = _store()
        ws = s["worksheets"].get(ws_id)
        if not ws or not _can(ws, "write"):
            raise HTTPException(404 if not ws else 403, "worksheet not found" if not ws else "you cannot edit this worksheet")
        now = _now()
        ws.update(sql=req.sql, mode=req.mode, updated_at=now)
        if req.name:
            ws["name"] = req.name.strip()
        if req.folder_id and not ws.get("item_id"):
            ws["item_id"] = _project_item(ws, req.folder_id)
        ws.setdefault("versions", []).append({"id": uuid.uuid4().hex[:10], "at": now, "by": _me(), "sql": req.sql, "mode": req.mode})
        ws["versions"] = ws["versions"][-200:]
        s["drafts"].pop(f"{_me()}:{ws_id}", None)
        _save_store(s)
        return _public_ws(ws, versions=True)


class RestoreIn(BaseModel):
    version: str


@router.post("/worksheets/{ws_id}/restore")
def restore_worksheet(ws_id: str, req: RestoreIn) -> dict:
    """Restore an earlier version: saved as a new version."""
    ws = _ws(ws_id, "write")
    v = next((x for x in ws.get("versions") or [] if x["id"] == req.version), None)
    if not v:
        raise HTTPException(404, "version not found")
    return save_worksheet(ws_id, WorksheetSave(sql=v["sql"], mode=v.get("mode", "data")))


@router.delete("/worksheets/{ws_id}")
def delete_worksheet(ws_id: str) -> dict:
    with _lock:
        s = _store()
        ws = s["worksheets"].get(ws_id)
        if not ws or not _can(ws, "write"):
            raise HTTPException(404 if not ws else 403, "worksheet not found" if not ws else "you cannot delete this worksheet")
        if ws.get("item_id"):
            try:
                drive.trash(ws["item_id"])
            except HTTPException:
                pass
        s["worksheets"].pop(ws_id)
        _save_store(s)
        return {"deleted": ws_id}


class DraftIn(BaseModel):
    sql: str = Field("", max_length=200_000)
    mode: Literal["data", "object"] = "data"


@router.put("/drafts/{key}")
def save_draft(key: str, req: DraftIn) -> dict:
    """Unsaved changes, kept between sessions (key: a worksheet id, or "scratchpad")."""
    if key != "scratchpad":
        _ws(key, "read")
    with _lock:
        s = _store()
        s["drafts"][f"{_me()}:{key}"] = {"sql": req.sql, "mode": req.mode, "at": _now()}
        _save_store(s)
    return {"ok": True}


@router.get("/drafts/scratchpad")
def get_scratchpad() -> dict:
    return _store()["drafts"].get(f"{_me()}:scratchpad") or {"sql": "", "mode": "data"}


# ------------------------------------------------------------------------------------------------
# AIP: generate, explain and fix SQL
# ------------------------------------------------------------------------------------------------


class AssistIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    sql: str = Field("", max_length=50_000)
    mode: Literal["data", "object"] = "data"
    # resources to describe (refs), besides those referenced in the SQL
    refs: list[str] = Field(default_factory=list, max_length=10)
    history: list[dict] = Field(default_factory=list, max_length=20)
    error: Optional[str] = Field(None, max_length=4000)


DIALECT_NOTES = """Foundry SQL is Spark SQL (ANSI). Reference tables in backticks:
- data mode: `/Project/folder/dataset` (path) or an id; branch: `branch`.`/path` or `/path`.branch_<name>; Iceberg metadata: `/path`.snapshots
- object mode: `ri.ontology.main.object-type.<id>` or the object type's API name; columns are property API names; many-to-many links:
  `ri.ontology.main.relation.<id>` with columns <objectTypeApiName>_<linkApiName>; DECLARE @var TYPE = value, ...; first.
Subqueries are parenthesized. Only SELECT statements run."""


@router.post("/assist")
def assist(req: AssistIn) -> dict:
    """The AIP panel: generate a query, explain it or fix an error, with the schemas of the resources involved."""
    import pipeline_ai

    refs = list(dict.fromkeys([*req.refs, *re.findall(r"`([^`]+)`", req.sql)]))[:10]
    schemas = []
    for r in refs:
        try:
            s = schema(r, req.mode)
            schemas.append(f"{r}: " + ", ".join(f"{c['name']} {c['type']}" for c in s["columns"][:80]))
        except HTTPException:
            continue
    system = ("You write and explain SQL for a data platform's SQL Studio. " + DIALECT_NOTES +
              "\nAnswer as JSON {\"sql\": the full query (or \"\" when only explaining), \"explanation\": short plain-language text}.")
    convo = "\n".join(f"{m.get('role', 'user')}: {str(m.get('content', ''))[:2000]}" for m in req.history[-10:])
    user = (f"Mode: {req.mode}\nSchemas:\n" + ("\n".join(schemas) or "(none referenced)") + f"\n\nCurrent editor:\n{req.sql or '(empty)'}\n"
            + (f"\nLast error:\n{req.error}\n" if req.error else "") + (f"\nConversation so far:\n{convo}\n" if convo else "") + f"\nRequest: {req.prompt}")
    answer = pipeline_ai.chat(pipeline_ai.DEFAULT_TEXT_MODEL, system, user,
                              schema={"type": "object", "properties": {"sql": {"type": "string"}, "explanation": {"type": "string"}}, "required": ["sql", "explanation"]},
                              max_tokens=1500)
    if not isinstance(answer, dict):
        answer = {"sql": "", "explanation": str(answer)}
    return {"sql": (answer.get("sql") or "").strip(), "explanation": (answer.get("explanation") or "").strip(), "schemas": refs}


class FormatIn(BaseModel):
    sql: str = Field(min_length=1, max_length=200_000)


@router.post("/format")
def format_sql(req: FormatIn) -> dict:
    """The editor's Format: the statements pretty-printed in the Spark SQL dialect (a DECLARE header kept as is)."""
    import sqlglot

    text = req.sql
    head = ""
    m = re.match(r"^\s*(DECLARE\s+.+?;)\s*", text, re.S | re.I)
    if m:
        head, text = m.group(1).strip() + "\n\n", text[m.end():]
    try:
        out = ";\n\n".join(sqlglot.transpile(UNQUOTED_RID.sub(r"`\1`", text), read="spark", write="spark", pretty=True))
    except sqlglot.errors.ParseError as e:
        raise HTTPException(400, f"cannot format: {e.errors[0].get('description') if e.errors else e}") from None
    return {"sql": head + out}
