"""Iceberg table maintenance (Palantir's "Iceberg table maintenance" and "Iceberg table retention" docs): the
Maintenance tab of an Iceberg table in Dataset Preview — tasks (a procedure, its parameters, an optional cron
schedule), the jobs that ran them, and the procedures themselves. Mounted by server.py under /api/iceberg-tables.

Procedures:
- rewrite_data_files: compaction — the branch's data rewritten into files of the target size (delete files applied)
  as a REPLACE snapshot; skipped below the minimum number of input files;
- rewrite_manifests: the branch's manifests consolidated (a REPLACE snapshot with the same data files);
- expire_snapshots: snapshots removed from the metadata unless retained: the newest `retain_last` of every branch
  (default history.expire.min-snapshots-to-keep, 1), those newer than `older_than` (default
  history.expire.max-snapshot-age-ms), branch heads and tags. Irreversible; files are not deleted (deferred deletion);
- remove_orphan_files: files under the table's location no snapshot, manifest or metadata file references, older than
  both `older_than` and the disaster recovery lookback window (Control Panel), are deleted. Foundry also runs this
  daily on every table with the lookback window alone;
- custom_sql: statements against the table (it is named `this`, by its RID or by any identifier): CALL
  system.rewrite_data_files / rewrite_manifests / expire_snapshots / remove_orphan_files / rollback_to_snapshot /
  set_current_snapshot; ALTER TABLE ... SET / UNSET TBLPROPERTIES, ADD / RENAME / DROP COLUMN, CREATE / DROP BRANCH or
  TAG; INSERT INTO ... VALUES / SELECT, UPDATE ... SET ... WHERE, DELETE FROM ... WHERE (DuckDB evaluates the values
  and expressions; the WHERE predicate is an Iceberg row filter); MERGE INTO this USING <table, dataset, subquery or
  VALUES> ON ... WHEN [NOT] MATCHED [BY SOURCE] ... (iceberg_merge.py: one copy-on-write snapshot, no Spark).

Permissions (Foundry's operations → Project roles): reading tasks needs Viewer (iceberg:read-maintenance-tasks);
writing tasks, Custom SQL, data-altering SQL and schedules need Editor (iceberg:write-maintenance-tasks,
iceberg:write-sql-maintenance-tasks, iceberg:write-data-altering-maintenance-tasks, iceberg:schedule-maintenance-tasks);
on a table with main branch protection, tasks also need Owner (iceberg:bypass-branch-protection).

Jobs run as a user, never as the system (run_as.py): a manual run as the caller, a scheduled run as the task's owner
(the user who created or last saved it). A scheduled run re-checks the owner first — deleted or deactivated, without
the table's markings, without the Editor role, or without Owner on a protected table: the job is recorded as failed
with the reason and nothing runs. Foundry's daily orphan file removal stays platform housekeeping (it reads no rows
and deletes only files no snapshot references).
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import iceberg_catalog as C
import iceberg_write
import run_as

log = logging.getLogger("bluesandai.iceberg_maintenance")
router = APIRouter(prefix="/api/iceberg-tables")
PROCEDURES = ("rewrite_data_files", "rewrite_manifests", "expire_snapshots", "remove_orphan_files", "custom_sql")
DATA_ALTERING = re.compile(r"^\s*(INSERT|UPDATE|DELETE|MERGE|CALL\s+\S*\.?(rollback_to_snapshot|set_current_snapshot|rollback_to_timestamp))\b", re.I)
JOBS_KEPT = 100
_lock = threading.RLock()
_running: set[str] = set()
_started = {"v": False}


def _path(item_id: str):
    d = C.DIR / "maintenance"
    d.mkdir(parents=True, exist_ok=True)
    C._rec_path(item_id)
    return d / f"{item_id}.json"


def _state(item_id: str) -> dict:
    return C._json(_path(item_id), {"tasks": [], "jobs": []})


def _save(item_id: str, st: dict) -> None:
    with _lock:
        st["jobs"] = st["jobs"][:JOBS_KEPT]
        C._write(_path(item_id), st)


def statements(sql: str) -> list[str]:
    out, cur, quote = [], [], None
    for ch in sql:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"', "`"):
            quote = ch
        if ch == ";":
            if "".join(cur).strip():
                out.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        out.append("".join(cur).strip())
    return out


def classify(task: dict) -> str:
    """form | sql | data-altering SQL (which operations it needs)."""
    if task["procedure"] != "custom_sql":
        return "form"
    return "data-altering" if any(DATA_ALTERING.match(s) for s in statements(task["params"].get("sql") or "")) else "sql"


def _check_write(item: dict) -> None:
    """iceberg:write-maintenance-tasks (+ write-sql / write-data-altering / schedule) → Editor; bypassing main branch
    protection → Owner."""
    with C.http_errors():
        C.table_item(item["id"], need="editor")
        if C.record(item["id"]).get("protected") and not C.can_bypass_protection(item):
            raise C.forbidden(f"{item['name']} has main branch protection: maintenance tasks on it need the Owner role "
                              "(iceberg:bypass-branch-protection)")


# ------------------------------------------------------------------------------------------------
# procedures
# ------------------------------------------------------------------------------------------------


def _ms(v: Any) -> Optional[int]:
    """A time as epoch milliseconds: ISO text, epoch ms, or "<n> days"."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().strip("'").removeprefix("TIMESTAMP").strip().strip("'")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(d|day|days|h|hour|hours)", s, re.I)
    if m:
        n = float(m.group(1)) * (86400 if m.group(2).lower().startswith("d") else 3600)
        return int((time.time() - n) * 1000)
    if s.isdigit():
        return int(s)
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return int((t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp() * 1000)


def expire_snapshots(item_id: str, older_than: Any = None, retain_last: Optional[int] = None, snapshot_ids: Optional[list] = None,
                     writer: Optional[dict] = None) -> dict:
    tbl = C.server_table(item_id, writer=writer, internal=True)
    md = tbl.metadata
    props = md.properties
    if snapshot_ids:
        wanted = {int(x) for x in snapshot_ids}
        retained: set[int] = set()
    else:
        cutoff = _ms(older_than)
        if cutoff is None:
            cutoff = int(time.time() * 1000) - int(props.get("history.expire.max-snapshot-age-ms", "432000000"))
        keep_n = int(retain_last if retain_last is not None else props.get("history.expire.min-snapshots-to-keep", "1"))
        retained = set()
        for name, ref in md.refs.items():
            retained.add(ref.snapshot_id)
            if ref.snapshot_ref_type.value == "branch":
                n = max(keep_n, ref.min_snapshots_to_keep or 0, 1)
                retained |= {s.snapshot_id for s in C.ancestors(md, ref.snapshot_id)[:n]}
        retained |= {s.snapshot_id for s in md.snapshots if s.timestamp_ms >= cutoff}
        wanted = {s.snapshot_id for s in md.snapshots} - retained
    protected = {r.snapshot_id for r in md.refs.values()}
    wanted -= protected
    if wanted:
        tbl.maintenance.expire_snapshots().by_ids(sorted(wanted)).commit()
    C.refresh_markings(item_id)
    return {"expired": len(wanted), "retained": len(md.snapshots) - len(wanted), "expired_ids": [str(i) for i in sorted(wanted)]}


def _referenced(tbl, rec: dict, loc: str) -> set[str]:
    md = tbl.metadata
    refs = {loc, *[e.metadata_file for e in md.metadata_log]}
    for s in md.snapshots:
        refs.add(s.manifest_list)
        for m in s.manifests(tbl.io):
            refs.add(m.manifest_path)
            for e in m.fetch_manifest_entry(tbl.io, discard_deleted=False):
                refs.add(e.data_file.file_path)
    for st in list(md.statistics or []) + list(getattr(md, "partition_statistics", None) or []):
        refs.add(st.statistics_path)
    # metadata a running job staged must not be cleaned up
    with C._lock:
        for j in C._jobs.values():
            st = j["staged"].get(rec["id"])
            if st:
                refs.add(st["loc"])
    return {r.removeprefix("file://") for r in refs}


def remove_orphan_files(item_id: str, older_than: Any = None, dry_run: bool = False) -> dict:
    """Delete unreferenced files under the table's location older than both `older_than` (default 3 days) and the
    disaster recovery lookback window."""
    import pyarrow.fs as pafs

    tbl = C.server_table(item_id)
    rec = C.record(item_id)
    loc = rec.get("metadata_location") or ""
    cutoff = _ms(older_than) if older_than not in (None, "") else int((time.time() - 3 * 86400) * 1000)
    dr = int((time.time() - float(C.settings().get("dr_lookback_days") or 0) * 86400) * 1000)
    cutoff = min(cutoff, dr)
    refs = _referenced(tbl, rec, loc)
    fs, root = pafs.FileSystem.from_uri(tbl.metadata.location)
    try:
        infos = fs.get_file_info(pafs.FileSelector(root, recursive=True, allow_not_found=True))
    except OSError as e:
        raise C.bad_request(f"cannot list the table's location: {e}") from None
    orphans, kept_recent, size = [], 0, 0
    for i in infos:
        if i.type != pafs.FileType.File:
            continue
        path = i.path if i.path.startswith("/") else "/" + i.path
        if path in refs or i.path in refs:
            continue
        mtime = int(i.mtime.timestamp() * 1000) if i.mtime else 0
        if mtime > cutoff:
            kept_recent += 1
            continue
        orphans.append(i.path)
        size += i.size or 0
    if not dry_run:
        for p in orphans:
            try:
                fs.delete_file(p)
            except OSError:
                log.warning("could not delete orphan file %s", p)
    return {"orphans": len(orphans), "bytes": size, "deleted": 0 if dry_run else len(orphans), "kept_within_window": kept_recent,
            "dry_run": dry_run, "files": [p.rsplit("/", 1)[-1] for p in orphans[:50]]}


def rewrite_data_files(item_id: str, branch: str = "main", target_file_size_bytes: Optional[int] = None, min_input_files: int = 1,
                       writer: Optional[dict] = None) -> dict:
    tbl = C.server_table(item_id, None if branch == "main" else branch, writer=writer, internal=True)
    br = "main"
    if br not in tbl.metadata.refs:
        return {"rewritten": 0, "added": 0, "skipped": "the branch has no snapshot"}
    files = list(tbl.scan(snapshot_id=tbl.metadata.refs[br].snapshot_id).plan_files())
    n = len(files) + sum(len(t.delete_files) for t in files)
    if n < max(1, int(min_input_files or 1)):
        return {"rewritten": 0, "added": 0, "skipped": f"{n} input file(s), below the minimum of {min_input_files}"}
    if tbl.metadata.format_version >= 3:
        raise C.bad_request("format version 3 tables are compacted by Spark (CALL system.rewrite_data_files in a Spark transform)")
    return iceberg_write.rewrite_files(tbl, br, target_file_size_bytes)


def rewrite_manifests(item_id: str, branch: str = "main", writer: Optional[dict] = None) -> dict:
    tbl = C.server_table(item_id, None if branch == "main" else branch, writer=writer, internal=True)
    if tbl.metadata.format_version >= 3:
        raise C.bad_request("format version 3 tables' manifests are rewritten by Spark (CALL system.rewrite_manifests in a Spark transform)")
    return iceberg_write.rewrite_manifests(tbl, "main")


# ------------------------------------------------------------------------------------------------
# custom SQL
# ------------------------------------------------------------------------------------------------

_IDENT = r"(`[^`]+`|\"[^\"]+\"|[\w.$/-]+)"


def _args(text: str) -> dict:
    """CALL arguments: name => value pairs (or positional, numbered)."""
    out: dict[str, Any] = {}
    parts, depth, cur, quote = [], 0, [], None
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    for i, p in enumerate(parts):
        k, sep, v = p.partition("=>")
        if not sep:
            k, v = str(i), p
        v = v.strip()
        m = re.fullmatch(r"(?is)array\((.*)\)", v)
        if m:
            out[k.strip().lower()] = [x.strip().strip("'") for x in m.group(1).split(",") if x.strip()]
        elif re.fullmatch(r"(?is)TIMESTAMP\s+'.*'", v):
            out[k.strip().lower()] = v.split("'", 1)[1].rsplit("'", 1)[0]
        else:
            out[k.strip().lower()] = v.strip("'")
    return out


def _props(text: str) -> dict:
    return {k: v for k, v in re.findall(r"'([^']+)'\s*=\s*'([^']*)'", text)}


def _type(t: str):
    from pyiceberg import types as T

    t = t.strip().lower()
    m = re.fullmatch(r"decimal\((\d+),\s*(\d+)\)", t)
    if m:
        return T.DecimalType(int(m.group(1)), int(m.group(2)))
    simple = {"string": T.StringType(), "varchar": T.StringType(), "int": T.IntegerType(), "integer": T.IntegerType(), "bigint": T.LongType(),
              "long": T.LongType(), "double": T.DoubleType(), "float": T.FloatType(), "boolean": T.BooleanType(), "date": T.DateType(),
              "timestamp": T.TimestamptzType(), "timestamp_ntz": T.TimestampType(), "binary": T.BinaryType()}
    if t not in simple:
        raise C.bad_request(f"unsupported column type {t}")
    return simple[t]


def _duck_con():
    """A DuckDB connection that reads only the tables registered on it: no files, URLs or extensions (read_csv,
    read_parquet, ATTACH … would read the server's own files, outside any marking or Project role)."""
    import duckdb

    return duckdb.connect(config={"enable_external_access": False})


def _arrow(con, query: str):
    """A query's result as Arrow; a refused file / URL access is a 400 with the reason."""
    import duckdb

    try:
        return con.sql(query).to_arrow_table()
    except duckdb.PermissionException:
        raise C.bad_request("Custom SQL reads only this table: files, URLs and extensions are not available") from None


def _duck(tbl, sql: str):
    """Run a DuckDB query with the table as `this` (and `t`)."""
    con = _duck_con()
    data = tbl.scan().to_arrow() if tbl.metadata.refs.get("main") else tbl.schema().as_arrow().empty_table()
    con.register("this", data)
    con.register("t", data)
    return _arrow(con, sql)


def run_sql(item_id: str, sql: str, writer: Optional[dict] = None, principal: Optional[dict] = None) -> list[dict]:
    """Run each statement of a Custom SQL task; returns one result per statement. `principal`: who runs it (the
    sources a MERGE INTO reads need their read access)."""
    results = []
    for stmt in statements(sql):
        s = stmt.strip()
        # the snapshots a data-altering statement adds record the markings of the rows it read (as sql_writes does)
        tbl = C.server_table(item_id, writer=writer, internal=False, snapshot_extra=_statement_markings(item_id, s))
        m = re.fullmatch(r"(?is)CALL\s+(?:\w+\.)?(?:system\.)?(\w+)\s*\((.*)\)", s)
        if m:
            proc, args = m.group(1).lower(), _args(m.group(2))
            args.pop("table", None)
            if proc == "rewrite_data_files":
                opts = args.get("options") or []
                res = rewrite_data_files(item_id, target_file_size_bytes=_opt(opts, "target-file-size-bytes"),
                                         min_input_files=int(_opt(opts, "min-input-files") or 1), writer=writer)
            elif proc == "rewrite_manifests":
                res = rewrite_manifests(item_id, writer=writer)
            elif proc == "expire_snapshots":
                res = expire_snapshots(item_id, args.get("older_than"), int(args["retain_last"]) if args.get("retain_last") else None,
                                       args.get("snapshot_ids"), writer=writer)
            elif proc == "remove_orphan_files":
                res = remove_orphan_files(item_id, args.get("older_than"), str(args.get("dry_run", "false")).lower() == "true")
            elif proc in ("rollback_to_snapshot", "set_current_snapshot"):
                sid = int(args.get("snapshot_id") or args.get("1") or args.get("0"))
                ms = tbl.manage_snapshots()
                (ms.rollback_to_snapshot(sid) if proc == "rollback_to_snapshot" else ms.set_current_snapshot(sid)).commit()
                res = {"snapshot_id": str(sid)}
            else:
                raise C.bad_request(f"unsupported procedure system.{proc}")
            results.append({"statement": s, "result": res})
            continue
        m = re.fullmatch(rf"(?is)ALTER\s+TABLE\s+{_IDENT}\s+(.*)", s)
        if m:
            results.append({"statement": s, "result": _alter(tbl, m.group(2).strip())})
            continue
        m = re.fullmatch(rf"(?is)DELETE\s+FROM\s+{_IDENT}(?:\s+WHERE\s+(.*))?", s)
        if m:
            where = m.group(2)
            before = _count(tbl)
            tbl.delete(delete_filter=where.strip() if where else "true")
            results.append({"statement": s, "result": {"deleted": before - _count(C.server_table(item_id))}})
            continue
        m = re.fullmatch(rf"(?is)UPDATE\s+{_IDENT}\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?", s)
        if m:
            sets, where = m.group(2), (m.group(3) or "").strip()
            assigns = _assignments(sets)
            rows = tbl.scan(row_filter=where or "true").to_arrow() if tbl.metadata.refs.get("main") else None
            if rows is None or rows.num_rows == 0:
                results.append({"statement": s, "result": {"updated": 0}})
                continue
            con = _duck_con()
            con.register("rows_", rows)
            replace = ", ".join(f"({expr}) AS \"{col}\"" for col, expr in assigns)
            new = _arrow(con, f"SELECT * REPLACE ({replace}) FROM rows_").cast(rows.schema)
            tbl.overwrite(new, overwrite_filter=where or "true")
            results.append({"statement": s, "result": {"updated": new.num_rows}})
            continue
        m = re.fullmatch(rf"(?is)INSERT\s+INTO\s+{_IDENT}\s*(\([^)]*\))?\s*(VALUES\s+.*|SELECT\s+.*|WITH\s+.*)", s)
        if m:
            cols = [c.strip().strip('`"') for c in (m.group(2) or "").strip("() ").split(",") if c.strip()]
            body = m.group(3)
            data = _duck(tbl, body if not body.upper().startswith("VALUES") else f"SELECT * FROM ({body})")
            names = cols or [f.name for f in tbl.schema().fields]
            if len(names) != data.num_columns:
                raise C.bad_request(f"INSERT gives {data.num_columns} values for {len(names)} columns")
            data = data.rename_columns(names)
            tbl.append(iceberg_write.prepare(tbl, data))
            results.append({"statement": s, "result": {"inserted": data.num_rows}})
            continue
        if re.match(r"(?is)MERGE\s+INTO", s):
            import iceberg_merge

            results.append({"statement": s, "result": iceberg_merge.run(item_id, tbl, s, principal)})
            continue
        if re.match(r"(?is)SELECT\b", s):
            out = _duck(tbl, re.sub(rf"(?is)\bFROM\s+{_IDENT}", "FROM this", s, count=1))
            results.append({"statement": s, "result": {"rows": out.slice(0, 100).to_pylist(), "count": out.num_rows}})
            continue
        raise C.bad_request(f"unsupported statement: {s[:120]}")
    return results


def _statement_markings(item_id: str, s: str) -> Optional[dict]:
    """`snapshot_extra` for the snapshots a Custom SQL statement adds: the markings of the rows it reads — the table's
    current rows (its main snapshot) and, for MERGE INTO, every source table or dataset. Without them an UPDATE /
    DELETE / MERGE that rewrites every data file adds a snapshot with no markings (iceberg_catalog keeps the parent's
    only while some of its files stay), so expiring the older snapshots would unmark the table; and rows a MERGE
    inserts from a marked source would never be marked. None for statements that add no rows."""
    if not re.match(r"(?is)(INSERT|UPDATE|DELETE|MERGE)\b", s):
        return None
    marks = set(C.main_markings(item_id))
    if re.match(r"(?is)MERGE\s+INTO\b", s):
        marks |= _merge_source_markings(item_id, s)
    return {"foundry.markings": ",".join(sorted(marks))} if marks else None


def _merge_source_markings(item_id: str, s: str) -> set[str]:
    """The markings of every table a MERGE INTO's source reads, resolved as iceberg_merge._bind_source resolves them
    (a name it cannot resolve fails the MERGE itself)."""
    from sqlglot import exp

    import db
    import iceberg_merge
    import sql_studio

    item = db.drive_get(item_id) or {"id": item_id, "name": ""}
    using = iceberg_merge.parse(s).args.get("using")
    if using is None:
        return set()
    ctes = {c.alias_or_name.lower() for c in using.find_all(exp.CTE)}
    names = iceberg_merge._target_names(item)
    marks: set[str] = set()
    for t in using.find_all(exp.Table):
        name, dbp, cat = t.name, t.db, t.catalog
        if not name or (not dbp and name.lower() in ctes) or (not dbp and not cat and name.lower() in names):
            continue
        try:
            if name.startswith("/") or name.startswith("ri.foundry.") or sql_studio.ITEM_ID.match(name):
                src = sql_studio._item_of(name)["id"]
            elif name.startswith(C.RID_PREFIX):
                src = name[len(C.RID_PREFIX):]
            else:
                src = C.resolve([p for p in (cat, dbp) if p], name)["id"]
        except (HTTPException, C.CatalogError):
            continue  # the MERGE refuses it when binding its source
        marks |= C.main_markings(src) if src == item_id else auth.effective_markings(src)
    return marks


def _opt(opts: Any, key: str) -> Optional[str]:
    if isinstance(opts, list):
        for i in range(0, len(opts) - 1, 2):
            if opts[i] == key:
                return opts[i + 1]
    return None


def _count(tbl) -> int:
    r = tbl.metadata.refs.get("main")
    s = tbl.metadata.snapshot_by_id(r.snapshot_id) if r else None
    return int((s.summary.additional_properties.get("total-records") if s and s.summary else 0) or 0)


def _assignments(text: str) -> list[tuple[str, str]]:
    out, depth, cur, quote = [], 0, [], None
    for ch in text + ",":
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            col, _, expr = "".join(cur).partition("=")
            if not expr:
                raise C.bad_request(f"bad assignment: {''.join(cur)}")
            out.append((col.strip().strip('`"').split(".")[-1], expr.strip()))
            cur = []
            continue
        cur.append(ch)
    return out


def _alter(tbl, rest: str) -> dict:
    m = re.fullmatch(r"(?is)SET\s+TBLPROPERTIES\s*\((.*)\)", rest)
    if m:
        props = _props(m.group(1))
        with tbl.transaction() as tx:
            tx.set_properties(props)
        return {"set": props}
    m = re.fullmatch(r"(?is)UNSET\s+TBLPROPERTIES\s*(?:IF\s+EXISTS\s*)?\((.*)\)", rest)
    if m:
        keys = re.findall(r"'([^']+)'", m.group(1))
        with tbl.transaction() as tx:
            tx.remove_properties(*keys)
        return {"unset": keys}
    m = re.fullmatch(r"(?is)ADD\s+COLUMNS?\s*\(?(.*?)\)?", rest)
    if m:
        added = []
        with tbl.update_schema() as u:
            for part in [p.strip() for p in m.group(1).split(",") if p.strip()]:
                name, typ = part.split(None, 1)
                u.add_column(name.strip('`"'), _type(typ))
                added.append(name.strip('`"'))
        return {"added": added}
    m = re.fullmatch(r"(?is)RENAME\s+COLUMN\s+(\S+)\s+TO\s+(\S+)", rest)
    if m:
        with tbl.update_schema() as u:
            u.rename_column(m.group(1).strip('`"'), m.group(2).strip('`"'))
        return {"renamed": [m.group(1), m.group(2)]}
    m = re.fullmatch(r"(?is)DROP\s+COLUMN\s+(\S+)", rest)
    if m:
        with tbl.update_schema(allow_incompatible_changes=True) as u:
            u.delete_column(m.group(1).strip('`"'))
        return {"dropped": m.group(1)}
    m = re.fullmatch(r"(?is)CREATE\s+(BRANCH|TAG)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)(?:\s+AS\s+OF\s+VERSION\s+(\d+))?", rest)
    if m:
        kind, name, sid = m.group(1).upper(), m.group(2).strip('`"'), m.group(3)
        head = tbl.metadata.refs.get("main")
        sid = int(sid) if sid else (head.snapshot_id if head else None)
        if sid is None:
            raise C.bad_request("the table has no snapshot to branch or tag")
        ms = tbl.manage_snapshots()
        (ms.create_branch(sid, name) if kind == "BRANCH" else ms.create_tag(sid, name)).commit()
        return {"created": kind.lower(), "name": name, "snapshot_id": str(sid)}
    m = re.fullmatch(r"(?is)DROP\s+(BRANCH|TAG)\s+(?:IF\s+EXISTS\s+)?(\S+)", rest)
    if m:
        kind, name = m.group(1).upper(), m.group(2).strip('`"')
        if name == "main":
            raise C.bad_request("the main branch cannot be dropped")
        ms = tbl.manage_snapshots()
        (ms.remove_branch(name) if kind == "BRANCH" else ms.remove_tag(name)).commit()
        return {"dropped": kind.lower(), "name": name}
    raise C.bad_request(f"unsupported ALTER TABLE: {rest[:100]}")


# ------------------------------------------------------------------------------------------------
# running tasks
# ------------------------------------------------------------------------------------------------


def _run_procedure(item_id: str, task: dict, writer: dict, principal: Optional[dict] = None) -> Any:
    p = task.get("params") or {}
    proc = task["procedure"]
    if proc == "rewrite_data_files":
        return rewrite_data_files(item_id, p.get("branch") or "main", p.get("target_file_size_bytes"), int(p.get("min_input_files") or 1), writer)
    if proc == "rewrite_manifests":
        return rewrite_manifests(item_id, p.get("branch") or "main", writer)
    if proc == "expire_snapshots":
        older = f"{p['older_than_days']} days" if p.get("older_than_days") not in (None, "") else p.get("older_than")
        return expire_snapshots(item_id, older, int(p["retain_last"]) if p.get("retain_last") not in (None, "") else None, p.get("snapshot_ids"), writer)
    if proc == "remove_orphan_files":
        older = f"{p['older_than_days']} days" if p.get("older_than_days") not in (None, "") else p.get("older_than")
        return remove_orphan_files(item_id, older, bool(p.get("dry_run")))
    if proc == "custom_sql":
        return run_sql(item_id, p.get("sql") or "", writer, principal)
    raise C.bad_request(f"unknown procedure {proc}")


def run_task(item_id: str, task_id: str, trigger: str = "manual", user: Optional[str] = None, wait: bool = False) -> dict:
    """Start a maintenance job (in the background unless `wait`)."""
    st = _state(item_id)
    task = next((t for t in st["tasks"] if t["id"] == task_id), None)
    if not task:
        raise HTTPException(404, "no such task")
    # who the job runs as (run_as.py), never the system: a scheduled run as the task's owner (the user who created or
    # last saved it, looked up now), a manual one as the caller; the thread below takes that principal, so every read
    # and commit (MERGE INTO sources too) is checked with their markings and Project roles
    scheduled = trigger == "schedule"
    owner_id = (task.get("owner") or task.get("created_by")) if scheduled else None
    who: Optional[dict] = None
    unavailable: Optional[str] = None
    if scheduled:
        try:
            who = run_as.owner_principal(owner_id, "the scheduled maintenance task")
        except run_as.OwnerUnavailable as e:
            unavailable = str(e)
    else:
        who = auth.current()
    label = user or (run_as.who(owner_id) if scheduled and owner_id else C._principal_label())
    job = {"id": f"mjob-{uuid.uuid4().hex[:10]}", "task_id": task_id, "procedure": task["procedure"], "status": "running", "trigger": trigger,
           "user": label, "started_at": C._now(), "finished_at": None, "result": None, "error": None}
    with _lock:
        st = _state(item_id)
        st["jobs"].insert(0, job)
        _save(item_id, st)

    def go() -> None:
        started = time.monotonic()
        try:
            if unavailable:
                raise _NotRun(unavailable)
            with _acting(who):
                if scheduled:
                    _owner_may_run(item_id, who)
                res = _run_procedure(item_id, task, {"kind": "maintenance", "label": f"{task.get('name') or task['procedure']} (maintenance)"}, who)
            job.update(status="succeeded", result=res)
        except _NotRun as e:
            job.update(status="failed", error=f"did not run: {e}")
        except C.CatalogError as e:
            job.update(status="failed", error=e.message)
        except Exception as e:  # noqa: BLE001
            log.exception("maintenance job failed")
            job.update(status="failed", error=f"{type(e).__name__}: {e}"[:2000])
        job.update(finished_at=C._now(), seconds=round(time.monotonic() - started, 2))
        with _lock:
            s2 = _state(item_id)
            s2["jobs"] = [job if j["id"] == job["id"] else j for j in s2["jobs"]]
            _save(item_id, s2)

    if wait:
        go()
    else:
        threading.Thread(target=go, daemon=True, name=f"iceberg-maint-{job['id']}").start()
    return job


class _NotRun(Exception):
    """The job did not start: its owner cannot run it now (str: the reason)."""


def _acting(principal: Optional[dict]):
    import contextlib

    return run_as.acting_as(principal) if auth.enabled() else contextlib.nullcontext()


def _owner_may_run(item_id: str, who: Optional[dict]) -> None:
    """A scheduled run, as its owner: the table's markings, the Editor role, and Owner on a protected table — the
    checks made when the task was saved, made again each time it fires. _NotRun with the reason."""
    try:
        with C.http_errors():
            item = C.table_item(item_id)
        _check_write(item)
    except HTTPException as e:
        name = run_as.who((who or {}).get("id")) if who else "its owner"
        raise _NotRun(f"the task's owner {name} cannot run it now ({e.detail}): an Editor must save the task again (it then runs as them)") from None


def _tick() -> None:
    """Fire scheduled tasks (every minute) and Foundry's daily orphan file removal."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    import pipeline_runtime as rt

    for f in (C.DIR / "maintenance").glob("*.json") if (C.DIR / "maintenance").exists() else []:
        item_id = f.stem
        try:
            st = _state(item_id)
        except Exception:  # noqa: BLE001
            continue
        for t in st["tasks"]:
            sch = t.get("schedule") or {}
            if not sch.get("enabled") or not sch.get("cron"):
                continue
            try:
                local = now.astimezone(ZoneInfo(sch.get("timezone") or "UTC"))
            except Exception:  # noqa: BLE001
                local = now
            key = f"{item_id}:{t['id']}:{now.isoformat()}"
            if rt.cron_matches(sch["cron"], local) and key not in _fired:
                _fired.add(key)
                try:
                    run_task(item_id, t["id"], "schedule")
                except Exception:  # noqa: BLE001
                    log.exception("scheduled maintenance task failed to start")
    day = now.date().isoformat()
    if _daily.get("day") != day:
        _daily["day"] = day
        for it in C.all_tables():
            try:
                remove_orphan_files(it["id"], older_than=f"{C.settings().get('dr_lookback_days') or 7} days")
            except Exception:  # noqa: BLE001
                log.debug("automatic orphan file removal skipped for %s", it["id"])
    if len(_fired) > 10000:
        _fired.clear()


_fired: set[str] = set()
_daily: dict[str, str] = {}


def start() -> None:
    if _started["v"]:
        return
    _started["v"] = True

    def loop() -> None:
        _daily["day"] = datetime.now(timezone.utc).date().isoformat()  # the first sweep runs tomorrow, not at startup
        while True:
            time.sleep(30)
            try:
                _tick()
            except Exception:  # noqa: BLE001
                log.exception("Iceberg maintenance scheduler")

    threading.Thread(target=loop, daemon=True, name="iceberg-maintenance").start()


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class Schedule(BaseModel):
    enabled: bool = False
    cron: str = ""
    timezone: str = "UTC"


class TaskIn(BaseModel):
    name: str = Field("", max_length=120)
    procedure: Literal["rewrite_data_files", "rewrite_manifests", "expire_snapshots", "remove_orphan_files", "custom_sql"]
    params: dict = {}
    schedule: Optional[Schedule] = None


def _public_task(t: dict) -> dict:
    return {**t, "category": classify(t), "operations": _operations(t)}


def _operations(t: dict) -> list[str]:
    ops = ["iceberg:write-maintenance-tasks"]
    cat = classify(t)
    if cat in ("sql", "data-altering"):
        ops.append("iceberg:write-sql-maintenance-tasks")
    if cat == "data-altering":
        ops.append("iceberg:write-data-altering-maintenance-tasks")
    if (t.get("schedule") or {}).get("enabled"):
        ops.append("iceberg:schedule-maintenance-tasks")
    return ops


def _validate(req: TaskIn) -> dict:
    p = dict(req.params or {})
    if req.procedure == "custom_sql":
        if not (p.get("sql") or "").strip():
            raise HTTPException(400, "write the SQL to run")
        for s in statements(p["sql"]):
            if not re.match(r"(?is)\s*(CALL|ALTER|INSERT|UPDATE|DELETE|MERGE|SELECT)\b", s):
                raise HTTPException(400, f"unsupported statement: {s[:80]}")
    if req.schedule and req.schedule.enabled:
        import pipeline_runtime as rt

        try:
            ZoneInfo(req.schedule.timezone or "UTC")
        except Exception:  # noqa: BLE001
            raise HTTPException(400, f"unknown time zone {req.schedule.timezone}") from None
        if len(req.schedule.cron.split()) != 5 or not rt.next_runs(req.schedule.cron, req.schedule.timezone, 1):
            raise HTTPException(400, "the schedule needs a five-field cron expression")
    return p


@router.get("/{item_id}/maintenance")
def maintenance(item_id: str) -> dict:
    """iceberg:read-maintenance-tasks (Viewer)."""
    with C.http_errors():
        item = C.table_item(item_id)
    st = _state(item_id)
    rec = C.record(item_id)
    return {"tasks": [_public_task(t) for t in st["tasks"]], "jobs": st["jobs"], "protected": bool(rec.get("protected")),
            "can_write": _can(item), "procedures": PROCEDURES, "dr_lookback_days": C.settings().get("dr_lookback_days")}


def _can(item: dict) -> bool:
    try:
        _check_write(item)
        return True
    except HTTPException:
        return False


@router.post("/{item_id}/maintenance/tasks")
def add_task(item_id: str, req: TaskIn) -> dict:
    with C.http_errors():
        item = C.table_item(item_id)
    _check_write(item)
    params = _validate(req)
    t = {"id": f"mtask-{uuid.uuid4().hex[:8]}", "name": req.name.strip() or req.procedure.replace("_", " ").capitalize(), "procedure": req.procedure,
         "params": params, "schedule": req.schedule.model_dump() if req.schedule else None, "created_by": auth.actor_id(),
         "created_by_name": C._principal_label(), "created_at": C._now(), "updated_at": C._now(),
         # a scheduled run acts as this user (run_as.py)
         "owner": auth.actor_id()}
    with _lock:
        st = _state(item_id)
        st["tasks"].append(t)
        _save(item_id, st)
    return _public_task(t)


@router.put("/{item_id}/maintenance/tasks/{task_id}")
def edit_task(item_id: str, task_id: str, req: TaskIn) -> dict:
    with C.http_errors():
        item = C.table_item(item_id)
    _check_write(item)
    params = _validate(req)
    with _lock:
        st = _state(item_id)
        t = next((x for x in st["tasks"] if x["id"] == task_id), None)
        if not t:
            raise HTTPException(404, "no such task")
        t.update(name=req.name.strip() or t["name"], procedure=req.procedure, params=params,
                 schedule=req.schedule.model_dump() if req.schedule else None, updated_at=C._now())
        if auth.actor_id():
            # whoever saves the task takes it over: its scheduled runs act as them from now on
            t["owner"] = auth.actor_id()
        _save(item_id, st)
    return _public_task(t)


@router.delete("/{item_id}/maintenance/tasks/{task_id}")
def delete_task(item_id: str, task_id: str) -> dict:
    with C.http_errors():
        item = C.table_item(item_id)
    _check_write(item)
    with _lock:
        st = _state(item_id)
        st["tasks"] = [t for t in st["tasks"] if t["id"] != task_id]
        _save(item_id, st)
    return {"deleted": task_id}


@router.post("/{item_id}/maintenance/tasks/{task_id}/run")
def run_now(item_id: str, task_id: str, wait: bool = False) -> dict:
    with C.http_errors():
        item = C.table_item(item_id)
    _check_write(item)
    return run_task(item_id, task_id, "manual", wait=wait)


def configure(_data_dir: Any = None) -> None:
    (C.DIR / "maintenance").mkdir(parents=True, exist_ok=True)
