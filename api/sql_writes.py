"""Writes in SQL Studio (palantir.com/docs/foundry/sql-warehousing/sql-dialect, sql-definitions).

Statements (Foundry's Spark SQL dialect; tables by path in backticks, by RID or item id):

  CREATE [OR REPLACE] TABLE [IF NOT EXISTS] `/path` [(col TYPE [NOT NULL] [COMMENT '…'], …)] [USING iceberg | parquet]
      [PARTITIONED BY (col | years(c) | months(c) | days(c) | hours(c) | bucket(n, c) | truncate(w, c), …)]
      [TBLPROPERTIES ('k'='v', …)] [AS query]
  INSERT INTO | OVERWRITE `/path` [(cols)] { VALUES (…), (…) | query }
  UPDATE `/path` SET col = expr [, …] [WHERE cond]
  DELETE FROM `/path` [WHERE cond]
  ALTER TABLE `/path` ADD COLUMN(S) / DROP COLUMN(S) / RENAME COLUMN / ALTER COLUMN … TYPE / COMMENT / DROP NOT NULL,
      ADD / DROP / REPLACE PARTITION FIELD, WRITE ORDERED BY / LOCALLY ORDERED BY / DISTRIBUTED BY PARTITION / UNORDERED,
      SET / DROP IDENTIFIER FIELDS, SET / UNSET TBLPROPERTIES, CREATE / REPLACE / DROP TAG | BRANCH
  BEGIN; …; COMMIT;   a transaction block: the statements run as one job; when one fails, the tables it wrote are
                      rolled back to their snapshot before the block and the tables it created are moved to the trash
                      (schema and property changes of earlier statements in the block are not undone)
  /*+ adhoc */        a one-time write kept as an extra SQL definition without changing the active one

Created tables are Iceberg unless USING parquet (a Parquet dataset; Avro is not available here). Only Iceberg tables
take INSERT, UPDATE, DELETE and ALTER TABLE. Queries run in DuckDB over the referenced data (sql_studio.select_arrow);
UPDATE and DELETE rewrite the table's rows in one overwrite snapshot. Writes need the Editor role on the output (and on
the folder for a new table); an output inherits the markings of the inputs it was written from.

SQL definitions: every write records a definition for each output (its SQL, operation, inputs, last run, query id).
The first definition of an output is active; later writes add one and make it active unless `adhoc`; CREATE OR
REPLACE TABLE replaces an output's definitions. Rebuilding an output (Dataset Preview → Details → Job spec → Build, or
a Build Schedule) runs its active definition. Data Lineage shows the inputs of every definition.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException

import auth
import db
import drive
from pydantic import BaseModel

router = APIRouter(prefix="/api/sql/definitions")
DIR = Path("data/sql-studio")
_lock = threading.RLock()
WRITE_START = re.compile(r"^\s*(?:/\*\+[^*]*\*/\s*)?(CREATE|INSERT|UPDATE|DELETE|ALTER|BEGIN|MERGE|DROP)\b", re.I)
IDENT = r"(`[^`]+`|ri\.[A-Za-z0-9._-]+|[0-9a-f]{16})"


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "sql-studio"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    p = auth.current() or {}
    return p.get("username") or p.get("id") or "system"


def is_write(sql: str) -> bool:
    return bool(WRITE_START.match(_strip_comments(sql)))


# ------------------------------------------------------------------------------------------------
# lexing helpers
# ------------------------------------------------------------------------------------------------


def _strip_comments(sql: str) -> str:
    """Line and block comments removed (hints /*+ … */ kept)."""
    out, i, n = [], 0, len(sql)
    quote = None
    while i < n:
        ch = sql[i]
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            i += 1
        elif ch in "'\"`":
            quote = ch
            out.append(ch)
            i += 1
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif sql.startswith("/*+", i):
            j = sql.find("*/", i)
            out.append(sql[i:n if j < 0 else j + 2])
            i = n if j < 0 else j + 2
        elif sql.startswith("/*", i):
            j = sql.find("*/", i)
            i = n if j < 0 else j + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _scan(text: str):
    """Yield (index, char, depth) for characters outside quotes."""
    depth, quote = 0, None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
            continue
        if ch in "(<[":
            depth += 1
        elif ch in ")>]":
            depth -= 1
        yield i, ch, depth


def split_statements(sql: str) -> list[str]:
    text = _strip_comments(sql)
    out, start = [], 0
    for i, ch, depth in _scan(text):
        if ch == ";" and depth == 0:
            out.append(text[start:i])
            start = i + 1
    out.append(text[start:])
    return [s.strip() for s in out if s.strip()]


def _split_top(text: str, sep: str = ",") -> list[str]:
    parts, start = [], 0
    for i, ch, depth in _scan(text):
        if ch == sep and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]


def _find_kw(text: str, kw: str) -> int:
    """Index of a keyword at depth 0 outside quotes, or -1."""
    pat = re.compile(rf"\b{kw}\b", re.I)
    depth_at: dict[int, int] = {}
    quoted = set()
    quote = None
    depth = 0
    for i, ch in enumerate(text):
        if quote:
            quoted.add(i)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
            quoted.add(i)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        depth_at[i] = depth
    for m in pat.finditer(text):
        if m.start() not in quoted and depth_at.get(m.start(), 1) == 0:
            return m.start()
    return -1


def _paren(text: str, start: int) -> tuple[str, int]:
    """The contents of the parenthesis opening at text[start], and the index after it."""
    if start >= len(text) or text[start] != "(":
        raise HTTPException(400, "expected (")
    depth, quote = 0, None
    for i in range(start, len(text)):
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
    raise HTTPException(400, "unbalanced parentheses")


def _unquote(ident: str) -> str:
    return ident[1:-1] if ident.startswith("`") and ident.endswith("`") else ident


def _string(lit: str) -> str:
    lit = lit.strip()
    if len(lit) >= 2 and lit[0] == lit[-1] and lit[0] in "'\"":
        return lit[1:-1].replace("\\'", "'").replace("''", "'")
    return lit


def _props(text: str) -> dict[str, str]:
    out = {}
    for p in _split_top(text):
        k, _, v = p.partition("=")
        out[_string(k)] = _string(v)
    return out


# ------------------------------------------------------------------------------------------------
# types
# ------------------------------------------------------------------------------------------------


def arrow_type(t: str) -> pa.DataType:
    """A Spark SQL type (INT, STRING, DECIMAL(10,2), ARRAY<…>, MAP<…,…>, STRUCT<a: …>) as Arrow."""
    s = t.strip()
    low = s.lower()
    simple = {"int": pa.int32(), "integer": pa.int32(), "bigint": pa.int64(), "long": pa.int64(), "smallint": pa.int32(), "short": pa.int32(),
              "tinyint": pa.int32(), "byte": pa.int32(), "string": pa.string(), "text": pa.string(), "double": pa.float64(), "float": pa.float32(),
              "real": pa.float32(), "boolean": pa.bool_(), "bool": pa.bool_(), "date": pa.date32(), "timestamp": pa.timestamp("us", tz="UTC"),
              "timestamp_ltz": pa.timestamp("us", tz="UTC"), "timestamp_ntz": pa.timestamp("us"), "binary": pa.binary()}
    if low in simple:
        return simple[low]
    m = re.fullmatch(r"(varchar|char)\s*\(\s*\d+\s*\)", low)
    if m:
        return pa.string()
    m = re.fullmatch(r"(decimal|numeric|dec)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?", low)
    if m:
        return pa.decimal128(int(m.group(2) or 10), int(m.group(3) or 0))
    m = re.fullmatch(r"(array|map|struct)\s*<(.*)>", s, re.I | re.S)
    if m:
        kind, inner = m.group(1).lower(), m.group(2)
        parts = _split_top(inner)
        if kind == "array":
            return pa.list_(arrow_type(inner))
        if kind == "map":
            if len(parts) != 2:
                raise HTTPException(400, f"MAP needs a key and a value type: {t}")
            return pa.map_(arrow_type(parts[0]), arrow_type(parts[1]))
        fields = []
        for p in parts:
            fm = re.match(r"^`?([A-Za-z_][\w]*)`?\s*:?\s+(.+)$", p.strip(), re.S) or re.match(r"^`?([A-Za-z_][\w]*)`?\s*:\s*(.+)$", p.strip(), re.S)
            if not fm:
                raise HTTPException(400, f"cannot read the struct field {p!r}")
            fields.append(pa.field(fm.group(1), arrow_type(fm.group(2))))
        return pa.struct(fields)
    raise HTTPException(400, f"unknown type {t}")


def _iceberg_schema(arrow_schema: pa.Schema, required: Optional[set[str]] = None, docs: Optional[dict[str, str]] = None):
    from pyiceberg.catalog import Catalog
    from pyiceberg.schema import Schema
    from pyiceberg.types import NestedField

    import iceberg_write

    arrow_schema = iceberg_write.supported_arrow(arrow_schema.empty_table()).schema
    sch = Catalog._convert_schema_if_needed(arrow_schema)
    if required or docs:
        sch = Schema(*[NestedField(f.field_id, f.name, f.field_type, required=f.name in (required or set()), doc=(docs or {}).get(f.name) or f.doc)
                       for f in sch.fields])
    return sch


def _iceberg_type(t: str):
    return _iceberg_schema(pa.schema([pa.field("x", arrow_type(t))])).fields[0].field_type


def _columns(text: str) -> tuple[pa.Schema, set[str], dict[str, str]]:
    fields, required, docs = [], set(), {}
    for part in _split_top(text):
        m = re.match(r"^(`[^`]+`|[A-Za-z_]\w*)\s+(.+?)(\s+NOT\s+NULL)?(?:\s+COMMENT\s+('(?:[^']|'')*'))?\s*$", part, re.I | re.S)
        if not m:
            raise HTTPException(400, f"cannot read the column definition {part!r} (name TYPE [NOT NULL] [COMMENT '…'])")
        name = _unquote(m.group(1))
        fields.append(pa.field(name, arrow_type(m.group(2)), nullable=not m.group(3)))
        if m.group(3):
            required.add(name)
        if m.group(4):
            docs[name] = _string(m.group(4))
    names = [f.name for f in fields]
    if len(set(names)) != len(names):
        raise HTTPException(400, "column names must be unique")
    return pa.schema(fields), required, docs


def _transform(expr: str):
    from pyiceberg import transforms as T

    e = expr.strip()
    m = re.fullmatch(r"(years|months|days|hours|year|month|day|hour)\s*\(\s*`?(\w+)`?\s*\)", e, re.I)
    if m:
        kind = m.group(1).lower().rstrip("s")
        return m.group(2), {"year": T.YearTransform(), "month": T.MonthTransform(), "day": T.DayTransform(), "hour": T.HourTransform()}[kind], f"{m.group(2)}_{kind}"
    m = re.fullmatch(r"bucket\s*\(\s*(\d+)\s*,\s*`?(\w+)`?\s*\)", e, re.I)
    if m:
        return m.group(2), T.BucketTransform(int(m.group(1))), f"{m.group(2)}_bucket"
    m = re.fullmatch(r"truncate\s*\(\s*(\d+)\s*,\s*`?(\w+)`?\s*\)", e, re.I) or re.fullmatch(r"truncate\s*\(\s*`?(\w+)`?\s*,\s*(\d+)\s*\)", e, re.I)
    if m:
        a, b = m.group(1), m.group(2)
        width, col = (int(a), b) if a.isdigit() else (int(b), a)
        return col, T.TruncateTransform(width), f"{col}_trunc"
    m = re.fullmatch(r"`?(\w+)`?", e)
    if m:
        return m.group(1), T.IdentityTransform(), m.group(1)
    raise HTTPException(400, f"unknown partition transform {expr}")


# ------------------------------------------------------------------------------------------------
# targets
# ------------------------------------------------------------------------------------------------


def _existing(ref: str) -> Optional[dict]:
    import sql_studio

    try:
        return sql_studio._item_of(ref)
    except HTTPException:
        return None


def _is_iceberg(item: dict) -> bool:
    import iceberg_catalog as C

    return item.get("content_type") == C.ICEBERG


def _iceberg_target(ref: str, what: str) -> dict:
    item = _existing(ref)
    if not item:
        raise HTTPException(400, f"no table {ref}")
    if not _is_iceberg(item):
        raise HTTPException(400, f"{what}: only Iceberg tables support INSERT, UPDATE, DELETE and ALTER TABLE ({ref} is a {item['name'].rsplit('.', 1)[-1]} dataset)")
    drive._item(item["id"], need="editor")
    return item


def _table(item_id: str, label: str, marks: Optional[set[str]] = None):
    """The table, its writes recording `marks` (the markings of the write's inputs) on the snapshots they add: the
    table's markings are refreshed from its snapshots after every commit (iceberg_catalog), so they must be there."""
    import iceberg_catalog as C

    extra = {"foundry.markings": ",".join(sorted(marks))} if marks else None
    return C.server_table(item_id, writer={"kind": "user", "label": f"SQL: {label}"}, snapshot_extra=extra)


def _input_markings(item: Optional[dict], inputs: list[dict]) -> set[str]:
    """The markings a write gives its output: every input's; when the output reads itself (UPDATE, DELETE, a write
    selecting from its own table), those of the rows it read — an Iceberg table's main snapshot, a Parquet dataset's
    inherited markings."""
    import iceberg_catalog as C

    own = item["id"] if item else None
    marks: set[str] = set()
    for r in inputs:
        i = r.get("item_id")
        if not i:
            continue
        if i == own:
            marks |= C.main_markings(own) if _is_iceberg(item) else set(auth._item_row(own)[1])
        else:
            marks |= auth.effective_markings(i)
    return marks


class Job:
    """One run of a script: outputs written, inputs read, created tables, snapshots to restore on failure."""

    def __init__(self) -> None:
        self.outputs: dict[str, dict] = {}
        self.inputs: dict[str, set[str]] = {}
        self.created: list[str] = []
        self.before: dict[str, Optional[int]] = {}
        self.messages: list[str] = []
        self.query_id = uuid.uuid4().hex[:16]

    def touch(self, item: dict, inputs: list[dict]) -> None:
        self.outputs[item["id"]] = item
        self.inputs.setdefault(item["id"], set()).update(r["item_id"] for r in inputs if r.get("item_id"))
        if item["id"] not in self.before and item["id"] not in self.created and _is_iceberg(item):
            import iceberg_catalog as C

            ref = C.server_table(item["id"]).metadata.refs.get("main")
            self.before[item["id"]] = ref.snapshot_id if ref else None

    def rollback(self) -> list[str]:
        import iceberg_catalog as C

        done = []
        for item_id in self.created:
            try:
                C.drop_table(item_id) if _is_iceberg(db.drive_get(item_id) or {}) else drive.trash(item_id)
                done.append(f"removed the new table {item_id}")
            except Exception as e:  # noqa: BLE001
                done.append(f"could not remove {item_id}: {e}")
        for item_id, sid in self.before.items():
            try:
                tbl = _table(item_id, "transaction rolled back")
                cur = tbl.metadata.refs.get("main")
                if sid is not None and (cur is None or cur.snapshot_id != sid):
                    tbl.manage_snapshots().rollback_to_snapshot(sid).commit()
                    done.append(f"rolled back {item_id} to snapshot {sid}")
                elif sid is None and cur is not None:
                    C.replace_contents(tbl, tbl.schema().as_arrow().empty_table())
                    done.append(f"emptied {item_id}")
            except Exception as e:  # noqa: BLE001
                done.append(f"could not roll back {item_id}: {e}")
        return done


def _propagate(item: dict, inputs: list[dict], marks: set[str]) -> None:
    """After a write: an Iceberg table already carries its snapshots' markings (recorded by the commit, added before
    the rows were visible); a Parquet output is set to exactly `marks` (it was widened before its rows were stored).
    The inputs are noted for lineage and the Project's constraints checked (never failing the write)."""
    import dataset_versions

    ids = [r["item_id"] for r in inputs if r.get("item_id") and r["item_id"] != item["id"]]
    self_read = any(r.get("item_id") == item["id"] for r in inputs)
    if not ids and not self_read:
        return
    try:
        if not _is_iceberg(item):
            auth._set_item(item["id"], inherited=sorted(marks))
        if ids:
            dataset_versions.note_inputs(item["id"], ids)
        auth.check_constraints(item["id"])
    except Exception:  # noqa: BLE001 - never fails the write
        pass


# ------------------------------------------------------------------------------------------------
# statements
# ------------------------------------------------------------------------------------------------


def _create(stmt: str, job: Job, rebuild: bool) -> dict:
    import code_repos
    import iceberg_catalog as C
    import sql_studio

    m = re.match(rf"^CREATE\s+(OR\s+REPLACE\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?{IDENT}\s*", stmt, re.I | re.S)
    if not m:
        raise HTTPException(400, "write CREATE [OR REPLACE] TABLE `/path/to/table` …")
    replace, if_not_exists, ref = bool(m.group(1)) or rebuild, bool(m.group(2)), _unquote(m.group(3))
    rest = stmt[m.end():]
    cols = using = partitions = props = query = None
    while rest.strip():
        rest = rest.lstrip()
        if rest.startswith("(") and cols is None and using is None and partitions is None:
            cols, end = _paren(rest, 0)
            rest = rest[end:]
        elif re.match(r"USING\s+", rest, re.I):
            mm = re.match(r"USING\s+(\w+)", rest, re.I)
            using = mm.group(1).lower()
            rest = rest[mm.end():]
        elif re.match(r"PARTITIONED\s+BY\s*\(", rest, re.I):
            start = rest.index("(")
            partitions, end = _paren(rest, start)
            rest = rest[end:]
        elif re.match(r"TBLPROPERTIES\s*\(", rest, re.I):
            start = rest.index("(")
            props, end = _paren(rest, start)
            rest = rest[end:]
        elif re.match(r"AS\b", rest, re.I):
            query = rest[2:].strip()
            rest = ""
        else:
            raise HTTPException(400, f"unexpected {rest[:40]!r} in CREATE TABLE")
    using = using or "iceberg"
    if using not in ("iceberg", "parquet"):
        raise HTTPException(400, f"USING {using}: tables here are iceberg (the default) or parquet")
    if cols and query:
        raise HTTPException(400, "give the columns or AS query, not both")
    if not cols and not query:
        raise HTTPException(400, "a new table needs columns (…) or AS query")
    inputs: list[dict] = []
    if query:
        data, inputs = sql_studio.select_arrow(query)
        required, docs = set(), {}
    else:
        schema, required, docs = _columns(cols)
        data = schema.empty_table()
    existing = _existing(ref)
    if existing and not replace:
        if if_not_exists:
            return {"output": existing, "operation": "CREATE TABLE", "rows": 0, "message": f"{ref} already exists (IF NOT EXISTS): nothing done"}
        raise HTTPException(409, f"{ref} already exists: use CREATE OR REPLACE TABLE")
    tprops = _props(props) if props else {}
    if using == "parquet":
        if partitions or tprops:
            raise HTTPException(400, "PARTITIONED BY and TBLPROPERTIES are for Iceberg tables")
        return _write_parquet(ref, existing, data, inputs, job)
    if existing and not _is_iceberg(existing):
        raise HTTPException(400, f"{ref} is not an Iceberg table: move it away or write USING parquet")
    import iceberg_write

    data = iceberg_write.supported_arrow(data)
    with C.http_errors():
        marks = _input_markings(existing, inputs)
        if existing:
            drive._item(existing["id"], need="editor")
            job.touch(existing, inputs)
            tbl = _table(existing["id"], "CREATE OR REPLACE TABLE", marks)
            # a replaced table starts over: no identifier fields, partition fields or sort order unless the statement sets them
            if tbl.schema().identifier_field_ids:
                with tbl.update_schema(allow_incompatible_changes=True) as us:
                    us.set_identifier_fields()
            if tbl.spec().fields:
                with tbl.update_spec() as sp:
                    for f in list(tbl.spec().fields):
                        sp.remove_field(f.name)
            if tbl.sort_order().fields:
                with tbl.update_sort_order():
                    pass
            tbl = tbl.refresh()
            if tprops:
                with tbl.transaction() as tx:
                    tx.set_properties(tprops)
                tbl = tbl.refresh()
            tbl = C.replace_contents(tbl, data)
            item = existing
        else:
            parts = [p for p in ref.split("/") if p]
            if len(parts) < 2:
                raise HTTPException(400, f"{ref}: a table lives in a Project (`/Project/[folder/]table`)")
            try:
                parent = code_repos._folder_path(None, parts[:-1])
            except ValueError as e:
                raise HTTPException(400, f"{ref}: {e}") from None
            # created already carrying its inputs' markings, before its first rows are written
            item = C.create_table(parent, parts[-1], _iceberg_schema(data.schema, required, docs), None, None, tprops,
                                  markings=sorted(marks))
            item = db.drive_get(item["id"])
            job.created.append(item["id"])
            job.touch(item, inputs)
            tbl = _table(item["id"], "CREATE TABLE", marks)
            if data.num_rows or marks:
                # an empty result from marked inputs still commits a (row-less) snapshot recording their markings:
                # Iceberg markings come only from snapshots, so without one the next refresh (a later commit, an
                # expiry) would drop them; later appends keep them as they keep any parent's
                tbl = C.replace_contents(tbl, data)
        if partitions:
            with tbl.update_spec() as u:
                for f in list(tbl.spec().fields):
                    u.remove_field(f.name)
                for p in _split_top(partitions):
                    col, tr, name = _transform(p)
                    u.add_field(col, tr, name)
    _propagate(item, inputs, marks)
    return {"output": item, "operation": "CREATE OR REPLACE TABLE" if replace and not rebuild else "CREATE TABLE" + (" AS SELECT" if query else ""),
            "rows": data.num_rows, "inputs": inputs, "replace": bool(m.group(1))}


def _write_parquet(ref: str, existing: Optional[dict], data: pa.Table, inputs: list[dict], job: Job) -> dict:
    import code_repos
    import dataset_versions
    import iceberg_catalog as C
    import pipeline_datasets as P
    import pyarrow.parquet as pq

    buf = io.BytesIO()
    pq.write_table(data, buf, compression="snappy")
    raw = buf.getvalue()
    marks = _input_markings(existing, inputs)
    if existing:
        if _is_iceberg(existing):
            raise HTTPException(400, f"{ref} is an Iceberg table: replace it with an Iceberg table")
        drive._item(existing["id"], need="editor")
        cur = set(auth._item_row(existing["id"])[1])
        if not marks <= cur:
            # the new rows' markings are on the dataset before they are stored; narrowed to them afterwards
            auth._set_item(existing["id"], inherited=sorted(cur | marks))
        P._replace_content(existing, raw)
        item = db.drive_get(existing["id"])
    else:
        parts = [p for p in ref.split("/") if p]
        if len(parts) < 2:
            raise HTTPException(400, f"{ref}: a dataset lives in a Project (`/Project/[folder/]name`)")
        try:
            parent = code_repos._folder_path(None, parts[:-1])
        except ValueError as e:
            raise HTTPException(400, f"{ref}: {e}") from None
        drive._item(parent, need="editor")
        name = parts[-1] if parts[-1].lower().endswith(".parquet") else parts[-1] + ".parquet"
        # stored under an id already carrying the inputs' markings: never findable or readable without them
        drive._require_db()
        folder = drive._folder_id(parent)
        reserved = C.reserve_marked_id(sorted(marks)) if marks else None
        try:
            stored = drive._store(folder, drive._clean_name(name), io.BytesIO(raw), len(raw), P.PARQUET, item_id=reserved)
        except BaseException:
            if reserved:
                C.release_marked_id(reserved)
            raise
        if reserved:
            stored = C.stored_under(stored, reserved)
        item = db.drive_get(stored["id"])
        job.created.append(item["id"])
    job.touch(item, inputs)
    dataset_versions.record(item["id"], raw, "sql", {"kind": "sql", "id": job.query_id, "name": "SQL Studio", "mode": "snapshot", "transaction": "SNAPSHOT",
                                                     "written": data.num_rows})
    _propagate(item, inputs, marks)
    return {"output": item, "operation": "CREATE TABLE USING parquet", "rows": data.num_rows, "inputs": inputs, "replace": True}


def _insert(stmt: str, job: Job) -> dict:
    import iceberg_catalog as C
    import iceberg_write
    import sql_studio

    m = re.match(rf"^INSERT\s+(INTO|OVERWRITE)\s+(?:TABLE\s+)?{IDENT}\s*", stmt, re.I | re.S)
    if not m:
        raise HTTPException(400, "write INSERT INTO `/path/to/table` VALUES (…) or INSERT INTO `/path/to/table` SELECT …")
    overwrite, ref = m.group(1).upper() == "OVERWRITE", _unquote(m.group(2))
    rest = stmt[m.end():].strip()
    cols = None
    if rest.startswith("(") and not re.match(r"\(\s*(SELECT|WITH|VALUES)\b", rest, re.I):
        inner, end = _paren(rest, 0)
        cols = [_unquote(c) for c in _split_top(inner)]
        rest = rest[end:].strip()
    item = _iceberg_target(ref, "INSERT")
    data, inputs = sql_studio.select_arrow(rest)
    job.touch(item, inputs)
    with C.http_errors():
        marks = _input_markings(item, inputs)
        tbl = _table(item["id"], "INSERT OVERWRITE" if overwrite else "INSERT INTO", marks)
        names = [f.name for f in tbl.schema().fields]
        target = cols or names
        if len(target) != data.num_columns:
            raise HTTPException(400, f"{ref} has {len(target)} column{'s' if len(target) != 1 else ''} to fill but the query gives {data.num_columns}")
        unknown = [c for c in target if c not in names]
        if unknown:
            raise HTTPException(400, f"{ref} has no column {', '.join(unknown)}")
        data = data.rename_columns(target)
        data = iceberg_write.prepare(tbl, iceberg_write.supported_arrow(data))
        if overwrite:
            C.replace_contents(tbl, data)
        else:
            tbl.append(data)
    _propagate(item, inputs, marks)
    return {"output": item, "operation": "INSERT OVERWRITE" if overwrite else "INSERT", "rows": data.num_rows, "inputs": inputs}


def _rewrite(item: dict, select_sql: str, label: str, job: Job) -> tuple[int, list[dict]]:
    import iceberg_catalog as C
    import iceberg_write
    import sql_studio

    data, inputs = sql_studio.select_arrow(select_sql)
    job.touch(item, inputs)
    with C.http_errors():
        marks = _input_markings(item, inputs)  # it reads itself: the rows' markings carry over to the rewrite
        tbl = _table(item["id"], label, marks)
        data = iceberg_write.prepare(tbl, iceberg_write.supported_arrow(data))
        C.replace_contents(tbl, data)
    return data.num_rows, inputs, marks


def _count(sql: str) -> int:
    import sql_studio

    t, _ = sql_studio.select_arrow(sql)
    return int(t.column(0)[0].as_py() or 0) if t.num_rows else 0


def _update(stmt: str, job: Job) -> dict:
    import iceberg_catalog as C

    m = re.match(rf"^UPDATE\s+{IDENT}(?:\s+(?:AS\s+)?(?!SET\b)([A-Za-z_]\w*))?\s+SET\s+", stmt, re.I | re.S)
    if not m:
        raise HTTPException(400, "write UPDATE `/path/to/table` SET col = value [WHERE condition]")
    ref, alias = _unquote(m.group(1)), m.group(2)
    rest = stmt[m.end():]
    w = _find_kw(rest, "WHERE")
    sets, cond = (rest[:w], rest[w + 5:].strip()) if w >= 0 else (rest, "")
    item = _iceberg_target(ref, "UPDATE")
    with C.http_errors():
        names = [f.name for f in C.server_table(item["id"]).schema().fields]
    assigns: dict[str, str] = {}
    for a in _split_top(sets):
        am = re.match(r"^(?:\w+\.)?(`[^`]+`|[A-Za-z_]\w*)\s*=\s*(.+)$", a, re.S)
        if not am:
            raise HTTPException(400, f"cannot read the assignment {a!r} (col = value)")
        col = _unquote(am.group(1))
        if col not in names:
            raise HTTPException(400, f"{ref} has no column {col}")
        assigns[col] = am.group(2).strip()
    src = f"`{ref}`" + (f" {alias}" if alias else "")
    test = f"COALESCE(({cond}), FALSE)" if cond else "TRUE"
    exprs = [f"CASE WHEN {test} THEN ({assigns[n]}) ELSE `{n}` END AS `{n}`" if n in assigns else f"`{n}`" for n in names]
    matched = _count(f"SELECT COUNT(*) FROM {src} WHERE {test}")
    _, inputs, marks = _rewrite(item, f"SELECT {', '.join(exprs)} FROM {src}", "UPDATE", job)
    _propagate(item, inputs, marks)
    return {"output": item, "operation": "UPDATE", "rows": matched, "inputs": inputs}


def _delete(stmt: str, job: Job) -> dict:
    m = re.match(rf"^DELETE\s+FROM\s+{IDENT}(?:\s+(?:AS\s+)?(?!WHERE\b)([A-Za-z_]\w*))?\s*", stmt, re.I | re.S)
    if not m:
        raise HTTPException(400, "write DELETE FROM `/path/to/table` WHERE condition")
    ref, alias = _unquote(m.group(1)), m.group(2)
    rest = stmt[m.end():].strip()
    cond = ""
    if rest:
        if not re.match(r"WHERE\b", rest, re.I):
            raise HTTPException(400, f"unexpected {rest[:40]!r} in DELETE")
        cond = rest[5:].strip()
    item = _iceberg_target(ref, "DELETE")
    src = f"`{ref}`" + (f" {alias}" if alias else "")
    test = f"COALESCE(({cond}), FALSE)" if cond else "TRUE"
    deleted = _count(f"SELECT COUNT(*) FROM {src} WHERE {test}")
    _, inputs, marks = _rewrite(item, f"SELECT * FROM {src} WHERE NOT {test}", "DELETE", job)
    _propagate(item, inputs, marks)
    return {"output": item, "operation": "DELETE", "rows": deleted, "inputs": inputs}


def _names_list(text: str) -> list[str]:
    return [_unquote(x.strip()) for x in _split_top(text.strip().strip("()"))]


def _alter(stmt: str, job: Job) -> dict:
    import iceberg_catalog as C

    m = re.match(rf"^ALTER\s+TABLE\s+{IDENT}\s+", stmt, re.I | re.S)
    if not m:
        raise HTTPException(400, "write ALTER TABLE `/path/to/table` …")
    ref = _unquote(m.group(1))
    op = stmt[m.end():].strip()
    item = _iceberg_target(ref, "ALTER TABLE")
    job.touch(item, [])
    what = op.split()[0].upper() + " " + (op.split()[1].upper() if len(op.split()) > 1 else "")
    with C.http_errors():
        tbl = _table(item["id"], f"ALTER TABLE {what.strip()}")
        msg = _alter_op(tbl, op)
    return {"output": item, "operation": f"ALTER TABLE {what.strip()}", "rows": 0, "inputs": [], "message": msg}


def _retain(text: str) -> dict:
    out: dict[str, int] = {}
    m = re.search(r"\bRETAIN\s+(\d+)\s+DAYS\b", text, re.I)
    if m:
        out["max_ref_age_ms"] = int(m.group(1)) * 86_400_000
    m = re.search(r"\bWITH\s+SNAPSHOT\s+RETENTION\s+(\d+)\s+SNAPSHOTS(?:\s+(\d+)\s+DAYS)?", text, re.I)
    if m:
        out["min_snapshots_to_keep"] = int(m.group(1))
        if m.group(2):
            out["max_snapshot_age_ms"] = int(m.group(2)) * 86_400_000
    return out


def _alter_op(tbl: Any, op: str) -> str:
    from pyiceberg.table.sorting import NullOrder

    o = op.strip()
    u = o.upper()
    # columns
    mm = re.match(r"ADD\s+COLUMNS?\s+(.+)$", o, re.I | re.S)
    if mm:
        body = mm.group(1).strip()
        body = body[1:-1] if body.startswith("(") and body.endswith(")") else body
        schema, required, docs = _columns(body)
        isch = _iceberg_schema(schema)
        with tbl.update_schema(allow_incompatible_changes=bool(required)) as us:
            for f in isch.fields:
                us.add_column(f.name, f.field_type, doc=docs.get(f.name), required=f.name in required)
        return f"added {', '.join(schema.names)}"
    mm = re.match(r"DROP\s+COLUMNS?\s+(.+)$", o, re.I | re.S)
    if mm:
        cols = _names_list(mm.group(1))
        with tbl.update_schema() as us:
            for c in cols:
                us.delete_column(c)
        return f"dropped {', '.join(cols)}"
    mm = re.match(r"RENAME\s+COLUMN\s+(`[^`]+`|\w+)\s+TO\s+(`[^`]+`|\w+)$", o, re.I)
    if mm:
        with tbl.update_schema() as us:
            us.rename_column(_unquote(mm.group(1)), _unquote(mm.group(2)))
        return f"renamed {_unquote(mm.group(1))} to {_unquote(mm.group(2))}"
    mm = re.match(r"ALTER\s+COLUMN\s+(`[^`]+`|\w+)\s+(.+)$", o, re.I | re.S)
    if mm:
        col, rest = _unquote(mm.group(1)), mm.group(2).strip()
        tm = re.match(r"TYPE\s+(.+)$", rest, re.I | re.S)
        if tm:
            with tbl.update_schema() as us:
                us.update_column(col, field_type=_iceberg_type(tm.group(1)))
            return f"{col} is now {tm.group(1).strip()}"
        cm = re.match(r"COMMENT\s+('(?:[^']|'')*')$", rest, re.I)
        if cm:
            with tbl.update_schema() as us:
                us.update_column(col, doc=_string(cm.group(1)))
            return f"commented {col}"
        if re.fullmatch(r"DROP\s+NOT\s+NULL", rest, re.I):
            with tbl.update_schema() as us:
                us.make_column_optional(col)
            return f"{col} accepts nulls"
        if re.fullmatch(r"SET\s+NOT\s+NULL", rest, re.I):
            raise HTTPException(400, f"SET NOT NULL: Iceberg cannot make the existing column {col} required (rows may hold nulls); add a new required column instead")
        raise HTTPException(400, f"unsupported ALTER COLUMN {rest[:40]!r}")
    # partition fields
    mm = re.match(r"ADD\s+PARTITION\s+FIELD\s+(.+?)(?:\s+AS\s+(\w+))?$", o, re.I | re.S)
    if mm:
        col, tr, name = _transform(mm.group(1))
        with tbl.update_spec() as us:
            us.add_field(col, tr, mm.group(2) or name)
        return f"partitioned by {mm.group(1).strip()}"
    mm = re.match(r"DROP\s+PARTITION\s+FIELD\s+(.+)$", o, re.I | re.S)
    if mm:
        name = _partition_name(tbl, mm.group(1))
        with tbl.update_spec() as us:
            us.remove_field(name)
        return f"dropped partition field {name}"
    mm = re.match(r"REPLACE\s+PARTITION\s+FIELD\s+(.+?)\s+WITH\s+(.+?)(?:\s+AS\s+(\w+))?$", o, re.I | re.S)
    if mm:
        old = _partition_name(tbl, mm.group(1))
        col, tr, name = _transform(mm.group(2))
        with tbl.update_spec() as us:
            us.remove_field(old)
            us.add_field(col, tr, mm.group(3) or name)
        return f"replaced partition field {old} with {mm.group(2).strip()}"
    # write ordering
    mm = re.match(r"WRITE\s+(UNORDERED|(?:LOCALLY\s+)?ORDERED\s+BY\s+.+|DISTRIBUTED\s+BY\s+PARTITION(?:\s+LOCALLY\s+ORDERED\s+BY\s+.+)?)$", o, re.I | re.S)
    if mm:
        spec = mm.group(1)
        props: dict[str, str] = {}
        keys = ""
        if re.match(r"UNORDERED", spec, re.I):
            props["write.distribution-mode"] = "none"
        elif re.match(r"DISTRIBUTED", spec, re.I):
            props["write.distribution-mode"] = "hash"
            km = re.search(r"LOCALLY\s+ORDERED\s+BY\s+(.+)$", spec, re.I | re.S)
            keys = km.group(1) if km else ""
        else:
            props["write.distribution-mode"] = "none" if spec.upper().startswith("LOCALLY") else "range"
            keys = re.sub(r"^(LOCALLY\s+)?ORDERED\s+BY\s+", "", spec, flags=re.I)
        with tbl.update_sort_order() as so:
            for k in _split_top(keys) if keys else []:
                km = re.match(r"^(`[^`]+`|\w+)(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$", k.strip(), re.I)
                if not km:
                    raise HTTPException(400, f"cannot read the sort key {k!r}")
                desc = (km.group(2) or "").upper() == "DESC"
                nulls = (km.group(3) or ("LAST" if desc else "FIRST")).upper()
                null_order = NullOrder.NULLS_FIRST if nulls == "FIRST" else NullOrder.NULLS_LAST
                (so.desc if desc else so.asc)(_unquote(km.group(1)), _identity(), null_order)
        with tbl.transaction() as tx:
            tx.set_properties(props)
        return f"write {spec.strip()}"
    # identifier fields
    mm = re.match(r"(SET|DROP)\s+IDENTIFIER\s+FIELDS\s+(.+)$", o, re.I | re.S)
    if mm:
        cols = _names_list(mm.group(2))
        current = [tbl.schema().find_column_name(i) for i in tbl.schema().identifier_field_ids]
        new = cols if mm.group(1).upper() == "SET" else [c for c in current if c not in cols]
        with tbl.update_schema(allow_incompatible_changes=True) as us:
            us.set_identifier_fields(*new)
        return f"identifier fields: {', '.join(new) or 'none'}"
    # properties
    mm = re.match(r"SET\s+TBLPROPERTIES\s*\((.+)\)$", o, re.I | re.S)
    if mm:
        props = _props(mm.group(1))
        with tbl.transaction() as tx:
            tx.set_properties(props)
        return f"set {', '.join(props)}"
    mm = re.match(r"UNSET\s+TBLPROPERTIES\s*\((.+)\)$", o, re.I | re.S)
    if mm:
        keys = [_string(k) for k in _split_top(mm.group(1))]
        with tbl.transaction() as tx:
            tx.remove_properties(*keys)
        return f"unset {', '.join(keys)}"
    # tags and branches
    mm = re.match(r"(CREATE\s+OR\s+REPLACE|CREATE|REPLACE|DROP)\s+(TAG|BRANCH)\s+(IF\s+(?:NOT\s+)?EXISTS\s+)?(`[^`]+`|[\w.-]+)(.*)$", o, re.I | re.S)
    if mm:
        verb, kind, cond, name, rest = mm.group(1).upper(), mm.group(2).upper(), (mm.group(3) or "").upper(), _unquote(mm.group(4)), mm.group(5)
        refs = tbl.metadata.refs
        exists = name in refs
        if verb == "DROP":
            if not exists:
                if "IF EXISTS" in cond:
                    return f"no {kind.lower()} {name}"
                raise HTTPException(400, f"no {kind.lower()} {name}")
            if name in ("main", "master"):
                raise HTTPException(400, "the main branch cannot be dropped")
            ms = tbl.manage_snapshots()
            (ms.remove_tag(name) if kind == "TAG" else ms.remove_branch(name)).commit()
            return f"dropped {kind.lower()} {name}"
        sm = re.search(r"\bAS\s+OF\s+VERSION\s+(\d+)", rest, re.I)
        head = refs.get("main")
        sid = int(sm.group(1)) if sm else (head.snapshot_id if head else None)
        if sid is None:
            raise HTTPException(400, "the table has no snapshot yet")
        if exists and verb == "CREATE":
            if "IF NOT EXISTS" in cond:
                return f"{kind.lower()} {name} exists"
            raise HTTPException(400, f"{kind.lower()} {name} already exists")
        if not exists and verb == "REPLACE":
            raise HTTPException(400, f"no {kind.lower()} {name} to replace")
        ret = _retain(rest)
        if exists:
            ms = tbl.manage_snapshots()
            (ms.remove_tag(name) if kind == "TAG" else ms.remove_branch(name)).commit()
            tbl = tbl.refresh()
        ms = tbl.manage_snapshots()
        if kind == "TAG":
            ms.create_tag(sid, name, max_ref_age_ms=ret.get("max_ref_age_ms")).commit()
        else:
            ms.create_branch(sid, name, max_ref_age_ms=ret.get("max_ref_age_ms"), max_snapshot_age_ms=ret.get("max_snapshot_age_ms"),
                             min_snapshots_to_keep=ret.get("min_snapshots_to_keep")).commit()
        return f"{kind.lower()} {name} at snapshot {sid}"
    raise HTTPException(400, f"unsupported ALTER TABLE {u[:40]!r}")


def _identity():
    from pyiceberg.transforms import IdentityTransform

    return IdentityTransform()


def _partition_name(tbl: Any, expr: str) -> str:
    e = expr.strip()
    names = [f.name for f in tbl.spec().fields]
    if _unquote(e) in names:
        return _unquote(e)
    col, tr, name = _transform(e)
    sid = tbl.schema().find_field(col).field_id
    hit = next((f.name for f in tbl.spec().fields if f.source_id == sid and str(f.transform) == str(tr)), None)
    if not hit:
        raise HTTPException(400, f"no partition field {expr}")
    return hit


# ------------------------------------------------------------------------------------------------
# scripts and definitions
# ------------------------------------------------------------------------------------------------


def _hints(stmt: str) -> tuple[set[str], str]:
    m = re.match(r"^\s*/\*\+([^*]*)\*/\s*", stmt)
    if not m:
        return set(), stmt
    return {h.strip().lower().split("(")[0] for h in m.group(1).split(",") if h.strip()}, stmt[m.end():]


def _statement(stmt: str, job: Job, rebuild: bool) -> dict:
    kw = stmt.split(None, 1)[0].upper()
    if kw == "CREATE":
        return _create(stmt, job, rebuild)
    if kw == "INSERT":
        return _insert(stmt, job)
    if kw == "UPDATE":
        return _update(stmt, job)
    if kw == "DELETE":
        return _delete(stmt, job)
    if kw == "ALTER":
        return _alter(stmt, job)
    if kw == "MERGE":
        raise HTTPException(400, "MERGE is not part of Foundry's SQL dialect: use UPDATE, DELETE and INSERT in a transaction block")
    if kw == "DROP":
        raise HTTPException(400, "DROP TABLE is not supported: move the table to the trash in Files")
    raise HTTPException(400, f"{kw} is not a write statement")


def run_script(sql: str, rebuild_of: Optional[tuple[str, str]] = None) -> dict:
    """Run one write statement or a BEGIN … COMMIT block: the result shown in SQL Studio (one row per output)."""
    import time

    started = time.monotonic()
    statements = split_statements(sql)
    if not statements:
        raise HTTPException(400, "write a statement")
    hints, first = _hints(statements[0])
    statements[0] = first
    block = statements[0].upper() in ("BEGIN", "BEGIN TRANSACTION", "START TRANSACTION")
    if block:
        if statements[-1].upper() not in ("COMMIT", "END"):
            raise HTTPException(400, "BEGIN without COMMIT: end the transaction block with COMMIT;")
        body = statements[1:-1]
        if any(s.upper().startswith(("BEGIN", "START TRANSACTION")) for s in body):
            raise HTTPException(400, "transaction blocks cannot be nested")
        if not body:
            raise HTTPException(400, "a transaction block must contain at least one write statement")
        if any(s.upper() in ("COMMIT", "END") for s in body):
            raise HTTPException(400, "COMMIT without BEGIN")
    else:
        if any(s.upper() in ("COMMIT", "END") for s in statements):
            raise HTTPException(400, "COMMIT without BEGIN")
        if len(statements) > 1:
            raise HTTPException(400, "run one statement at a time, or wrap several in BEGIN; …; COMMIT;")
        body = statements
    for s in body:
        if not is_write(s):
            raise HTTPException(400, "a transaction block holds write statements (CREATE, INSERT, UPDATE, DELETE, ALTER TABLE)"
                                if block else "not a write statement")
    job = Job()
    results = []
    try:
        for s in body:
            results.append(_statement(s, job, rebuild_of is not None))
    except Exception as e:
        undone = job.rollback() if block else []
        detail = e.detail if isinstance(e, HTTPException) else str(e)
        if block:
            detail = f"{detail} — the transaction block was rolled back" + (f" ({'; '.join(undone)})" if undone else "")
        raise HTTPException(getattr(e, "status_code", 400), detail) from None
    adhoc = "adhoc" in hints
    op = "TRANSACTION" if block else results[0]["operation"]
    text = sql.strip()
    if rebuild_of is None:
        replaces = {r["output"]["id"] for r in results if r.get("replace") and not adhoc}
        for item_id, item in job.outputs.items():
            _record_definition(item_id, text, op, sorted(job.inputs.get(item_id, set()) - {item_id}), adhoc, item_id in replaces, job.query_id)
    else:
        _mark_run(rebuild_of[0], rebuild_of[1], job.query_id)
    rows = [[r["output"]["name"], r["operation"], r["rows"], r.get("message") or ""] for r in results]
    return {"columns": [{"name": "output", "type": "string"}, {"name": "operation", "type": "string"}, {"name": "rows", "type": "int64"},
                        {"name": "message", "type": "string"}],
            "rows": rows, "row_count": len(rows), "truncated": False, "limit": len(rows), "ms": int((time.monotonic() - started) * 1000),
            "statement": "write", "query_id": job.query_id, "adhoc": adhoc,
            "outputs": [{"item_id": i["id"], "name": i["name"]} for i in job.outputs.values()],
            "resources": [{"ref": i["name"], "kind": "output", "item_id": i["id"], "name": i["name"]} for i in job.outputs.values()]}


def _store() -> dict:
    p = DIR / "definitions.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _save(d: dict) -> None:
    p = DIR / "definitions.json"
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(d, indent=1), "utf-8")
    tmp.replace(p)


def _record_definition(item_id: str, sql: str, op: str, inputs: list[str], adhoc: bool, replace: bool, query_id: str) -> None:
    with _lock:
        d = _store()
        defs = [] if replace else d.get(item_id, [])
        new = {"id": uuid.uuid4().hex[:12], "sql": sql, "operation": op, "inputs": inputs, "adhoc": adhoc, "created_at": _now(), "created_by": _me(),
               "last_run_at": _now(), "query_id": query_id, "active": False}
        if not defs or not adhoc:
            for x in defs:
                x["active"] = False
            new["active"] = True
        defs.append(new)
        d[item_id] = defs
        _save(d)


def _mark_run(item_id: str, def_id: str, query_id: str) -> None:
    with _lock:
        d = _store()
        for x in d.get(item_id, []):
            if x["id"] == def_id:
                x["last_run_at"] = _now()
                x["query_id"] = query_id
        _save(d)


def definitions(item_id: str) -> list[dict]:
    return _store().get(item_id, [])


def all_definitions() -> dict[str, list[dict]]:
    return _store()


def rebuild(item_id: str) -> dict:
    """Run an output's active definition (on demand or from a schedule)."""
    defs = definitions(item_id)
    active = next((x for x in defs if x["active"]), None)
    if not active:
        raise HTTPException(400, "this output has no active SQL definition")
    _, sql = _hints(active["sql"])
    import resource_queues

    lease_id = resource_queues.acquire(item_id, 2, f"SQL rebuild of {(db.drive_get(item_id) or {}).get('name', item_id)}", "sql")
    try:
        return run_script(sql, rebuild_of=(item_id, active["id"]))
    finally:
        resource_queues.release(lease_id)


@router.get("/{item_id}")
def list_definitions(item_id: str) -> dict:
    drive._item(item_id, need="viewer")
    can_edit = True
    try:
        drive._item(item_id, need="editor")
    except HTTPException:
        can_edit = False
    names = {}
    out = []
    for x in reversed(definitions(item_id)):
        ins = []
        for i in x.get("inputs") or []:
            if i not in names:
                it = db.drive_get(i)
                names[i] = it["name"] if it else i
            ins.append({"item_id": i, "name": names[i]})
        out.append({**x, "inputs": ins})
    return {"definitions": out, "can_edit": can_edit}


@router.put("/{item_id}/{def_id}/active")
def set_active(item_id: str, def_id: str) -> dict:
    drive._item(item_id, need="editor")
    with _lock:
        d = _store()
        defs = d.get(item_id, [])
        if not any(x["id"] == def_id for x in defs):
            raise HTTPException(404, "no such definition")
        for x in defs:
            x["active"] = x["id"] == def_id
        _save(d)
    return list_definitions(item_id)


@router.post("/{item_id}/build")
def build(item_id: str) -> dict:
    drive._item(item_id, need="editor")
    return {"result": rebuild(item_id), **list_definitions(item_id)}



# ------------------------------------------------------------------------------------------------
# rebuild schedules
# ------------------------------------------------------------------------------------------------

TICK_S = 30
_started = False


def _schedules() -> dict:
    p = DIR / "schedules.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _save_schedules(d: dict) -> None:
    p = DIR / "schedules.json"
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(d, indent=1), "utf-8")
    tmp.replace(p)


class ScheduleIn(BaseModel):
    cron: str = ""
    timezone: str = "UTC"
    enabled: bool = True


@router.get("/{item_id}/schedule")
def get_schedule(item_id: str) -> dict:
    drive._item(item_id, need="viewer")
    s = _schedules().get(item_id)
    if s:
        import pipeline_runtime

        try:
            s = {**s, "next": pipeline_runtime.next_runs(s["cron"], s.get("timezone") or "UTC", 3) if s.get("enabled") else []}
        except Exception:  # noqa: BLE001
            s = {**s, "next": []}
    return {"schedule": s}


@router.put("/{item_id}/schedule")
def set_schedule(item_id: str, req: ScheduleIn) -> dict:
    """Rebuild the output's active definition on a cron schedule (in a time zone), as the user who set it; an empty
    cron removes the schedule."""
    import pipeline_runtime

    drive._item(item_id, need="editor")
    with _lock:
        d = _schedules()
        if not req.cron.strip():
            d.pop(item_id, None)
        else:
            if not any(x["active"] for x in definitions(item_id)):
                raise HTTPException(400, "this output has no active SQL definition to rebuild")
            try:
                pipeline_runtime.next_runs(req.cron.strip(), req.timezone, 1)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(400, f"invalid schedule: {getattr(e, 'detail', e)}") from None
            p = auth.current() or {}
            prev = d.get(item_id) or {}
            d[item_id] = {"cron": req.cron.strip(), "timezone": req.timezone, "enabled": req.enabled, "owner": p.get("id"), "owner_name": _me(),
                          "last_run_at": prev.get("last_run_at"), "last_status": prev.get("last_status"), "last_error": prev.get("last_error"),
                          "last_minute": prev.get("last_minute")}
        _save_schedules(d)
    return get_schedule(item_id)


def _tick() -> None:
    from zoneinfo import ZoneInfo

    import pipeline_runtime

    now = dt.datetime.now(dt.timezone.utc)
    for item_id, s in list(_schedules().items()):
        if not s.get("enabled"):
            continue
        try:
            local = now.astimezone(ZoneInfo(s.get("timezone") or "UTC"))
        except Exception:  # noqa: BLE001
            local = now
        minute = local.strftime("%Y-%m-%dT%H:%M")
        if s.get("last_minute") == minute or not pipeline_runtime.cron_matches(s["cron"], local):
            continue
        # the rebuild runs as the user who set the schedule up, never as the system (run_as.py)
        import run_as

        try:
            principal, unavailable = run_as.owner_principal(s.get("owner"), "the schedule"), None
        except run_as.OwnerUnavailable as e:
            principal, unavailable = None, str(e)
        token = auth._principal.set(principal)
        status, error = "succeeded", None
        try:
            if unavailable:
                raise HTTPException(403, f"did not run: {unavailable}")
            rebuild(item_id)
        except Exception as e:  # noqa: BLE001
            status, error = "failed", str(getattr(e, "detail", e))[:500]
        finally:
            auth._principal.reset(token)
        with _lock:
            d = _schedules()
            if item_id in d:
                d[item_id].update(last_run_at=_now(), last_status=status, last_error=error, last_minute=minute)
                _save_schedules(d)


def start() -> None:
    """The scheduler thread (server.py starts it)."""
    global _started
    if _started:
        return
    _started = True

    def loop() -> None:
        import time

        while True:
            try:
                _tick()
            except Exception:  # noqa: BLE001 - the scheduler keeps running
                pass
            time.sleep(TICK_S)

    threading.Thread(target=loop, name="sql-definition-schedules", daemon=True).start()
