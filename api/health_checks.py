"""Health checks for datasets and schedules (Palantir's "Data Health": health checks, schedule checks,
expectations), evaluated in the background instead of only when Data Lineage loads.

* Dataset checks: freshness, time since last updated (optionally ignoring empty transactions), row count,
  required columns, schema (allow additions, or exact match, with types), last build status and up to date
  with its inputs. They are set per dataset in Data Lineage (Data health tab, data/lineage/health.json) and
  checked every couple of minutes; Data Health lists their state.
* Data freshness: the newest value of a timestamp column in the rows (when the data is from, not when the
  dataset was written) is older than the threshold.
* Sync checks on Data Connection syncs (into the platform) and exports (out of it): sync status (the last run
  failed) and sync freshness (a sync: no successful run within the threshold; an export: its dataset changed
  more than the threshold ago and was not exported since) and sync row count (rows of the last successful run,
  or in the synced dataset / the export target, outside a minimum / maximum). Resource id "source:<id>" or
  "export:<id>". Besides monitoring views, they are set on the sync itself (Data Connection, table
  dc_sync_checks): evaluated after each run and in the background, and when a check starts failing or passes
  again its subscribers (whoever added it, and those who subscribe) get an in-app notification (notify.py),
  provided they can still see the sync's connection. Row count checks also gate runs: an export run whose rows
  would fail one stops before writing (export_gate); a sync run that would fail one does not commit its dataset
  transaction, so the previous version stays current (sync_gate). The check's reason is the run's error.
* Schedule checks: schedule status (last run failed, schedule paused) and schedule duration (last run took
  longer than a threshold).
* Monitoring views (Data Health, api/streaming.py) hold dataset checks, schedule checks and stream monitors
  side by side: the stream monitoring evaluator asks this module for dataset and schedule monitors, and their
  alerts go to the view's subscriptions (email, PagerDuty, webhook). A monitor that does not auto-resolve
  keeps its alert open after the check passes again, until someone resolves it.
* Expectations: the results of pipeline expectations (outputs and input pre-conditions, abort or warn) of
  recent builds, and of the data expectation checks (Check(E..., on_error=FAIL | WARN)) of Python transforms in
  Code Repositories, for Data Health.

The checks read a snapshot of the lineage graph (rows, columns, producers, staleness), refreshed by a
background thread every REFRESH_S seconds. Mounted by server.py under /api/health.
"""

from __future__ import annotations

import io
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import auth
import db
import drive
import pipeline_datasets as pdata

log = logging.getLogger("bluesandai.health_checks")
router = APIRouter(prefix="/api/health")

REFRESH_S = 120

# kind: (resource type, unit of the monitor threshold, description)
CHECKS: dict[str, tuple[str, str, str]] = {
    "freshness": ("dataset", "hours", "The dataset was last updated more than the threshold ago"),
    "time_since_updated": ("dataset", "hours", "Time since the last transaction with data (empty transactions can be ignored) is above the threshold"),
    "row_count": ("dataset", "rows", "Row count below the threshold (or above the maximum)"),
    "columns": ("dataset", "columns", "A required column is missing"),
    "schema": ("dataset", "columns", "The schema differs from the expected one (exact match, or additions allowed), with types"),
    "data_freshness": ("dataset", "hours", "The newest value of a timestamp column is older than the threshold"),
    "build_status": ("dataset", "", "The last build of the dataset failed"),
    "up_to_date": ("dataset", "", "An input of the dataset changed after its last build"),
    "sync_status": ("dc_sync", "", "The last run of a Data Connection sync or export failed"),
    "sync_freshness": ("dc_sync", "hours", "A sync has had no successful run within the threshold; an export's dataset changed longer than the threshold ago without being exported"),
    "sync_row_count": ("dc_sync", "rows", "Rows of the last successful run (or in the synced dataset / export target) below the threshold (or above the maximum)"),
    "schedule_status": ("schedule", "", "The schedule's last run failed (or it was paused after failures)"),
    "schedule_duration": ("schedule", "minutes", "The schedule's last run took longer than the threshold"),
}

_facts: dict[str, dict] = {}
_facts_at = 0.0
_facts_lock = threading.Lock()
_schema_cache: dict[str, tuple[str, list[dict]]] = {}
_newest_cache: dict[tuple[str, str], tuple[str, Optional[str]]] = {}
_state: dict[str, dict] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(at: Optional[str]) -> Optional[datetime]:
    if not at:
        return None
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ------------------------------------------------------------------------------------------------
# facts: the lineage graph's dataset nodes, refreshed in the background
# ------------------------------------------------------------------------------------------------


def refresh() -> dict[str, dict]:
    global _facts, _facts_at, _refreshing
    import lineage

    with _facts_lock:
        _refreshing += 1
    try:
        g = lineage.build_graph()
    finally:
        with _facts_lock:
            _refreshing -= 1
    facts = {n["item_id"]: n for n in g.nodes.values() if n["kind"] == "dataset" and n.get("item_id")}
    with _facts_lock:
        _facts, _facts_at = facts, time.time()
    _save_listing(facts)
    return facts


# The datasets a check can watch (GET /resources) as of the last graph build, kept on disk: building the lineage
# graph takes minutes on the real data, so after a restart the listing is served from here while it is rebuilt.
_refreshing = 0
_listing: dict[str, Any] = {"saved": None}


def _listing_file():
    import dataset_versions

    return dataset_versions.DIR.parent / "health-resources.json"


def _listing_of(facts: dict[str, dict]) -> dict[str, dict]:
    return {i: {"name": n["name"], "path": list(n.get("path") or [])} for i, n in facts.items() if not n.get("missing")}


def _save_listing(facts: dict[str, dict]) -> None:
    listing = _listing_of(facts)
    if listing == _listing["saved"]:
        return
    try:
        f = _listing_file()
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(listing), "utf-8")
        tmp.replace(f)
        _listing["saved"] = listing
    except (OSError, TypeError, ValueError):
        log.exception("the health resources listing was not saved")


def _load_listing() -> Optional[dict[str, dict]]:
    try:
        data = json.loads(_listing_file().read_text("utf-8"))
        return {str(i): {"name": str(n["name"]), "path": [str(p) for p in n.get("path") or []]} for i, n in data.items()}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def _refresh_soon() -> None:
    """Rebuild the facts in the background unless a rebuild is already under way."""
    with _facts_lock:
        if _refreshing or _listing.get("kicked"):
            return
        _listing["kicked"] = True

    def run() -> None:
        try:
            refresh()
        except Exception:  # noqa: BLE001
            log.exception("refreshing dataset facts failed")
        finally:
            _listing["kicked"] = False

    threading.Thread(target=run, daemon=True, name="health-facts-refresh").start()


# Each pipeline's schedules (id, name) by the pipeline file's updated_at and size, also on disk: listing them read
# every pipeline file from storage (minutes on a cold start for ~1000 pipelines, 8 of them with schedules).
_sched_names: dict[str, tuple[str, list[tuple[str, str]]]] = {}
_sched_disk = {"loaded": False, "dirty": False}
_sched_lock = threading.Lock()


def _sched_stamp(item: dict) -> str:
    # updated_at has whole seconds: the size tells most second saves within one apart
    return f"{item.get('updated_at')} {item.get('size_bytes')}"


def _sched_file():
    import dataset_versions

    return dataset_versions.DIR.parent / "health-schedules.json"


def _load_sched_names() -> None:
    if _sched_disk["loaded"]:
        return
    _sched_disk["loaded"] = True
    try:
        for k, v in json.loads(_sched_file().read_text("utf-8")).items():
            _sched_names.setdefault(str(k), (str(v[0]), [(str(a), str(b)) for a, b in v[1]]))
    except (OSError, ValueError, TypeError, IndexError):
        pass


# A changed pipeline file is read again before the listing answers. Files of tens of MB take 15-30 s to come from
# object storage, so a pipeline whose schedules are already known is waited for this long only: after that the
# listing answers with the schedules of the file's previous version and the read finishes in the background (the
# next call has them). A pipeline never read before is always waited for.
SCHED_WAIT_S = 1.5
_sched_reading: dict[str, Any] = {}  # pipeline id -> the Future of the read under way
_sched_pool: list[Any] = []


def _read_schedules(item: dict, rt: Any) -> None:
    """Reads one pipeline file and stores the (schedule id, name) of its schedules with an id, as
    pipeline_schedules.list_schedules lists them."""
    try:
        content = rt._pipeline_content(item)
        if content is None:  # a file that cannot be read is tried again next time
            return
        found = [(s["id"], s["name"]) for s in content.get("schedules") or [] if s.get("id")]
        with _sched_lock:
            _sched_names[item["id"]] = (_sched_stamp(item), found)
            _sched_disk["dirty"] = True
    except Exception:  # noqa: BLE001
        log.exception("reading the schedules of pipeline %s failed", item.get("id"))
    finally:
        with _sched_lock:
            _sched_reading.pop(item["id"], None)


def _pipeline_schedules(item: dict) -> list[tuple[str, str]]:
    """(schedule id, name) of a pipeline's schedules as last read (_prefetch_schedules reads the changed files)."""
    with _sched_lock:
        hit = _sched_names.get(item["id"])
    return hit[1] if hit else []


def _prefetch_schedules(items: list[dict], rt: Any) -> None:
    """Reads the pipeline files not cached yet in parallel (storage latency, not CPU), then saves the cache."""
    waits = []
    with _sched_lock:
        _load_sched_names()
        for i in items:
            hit = _sched_names.get(i["id"])
            if hit and hit[0] == _sched_stamp(i):
                continue
            fut = _sched_reading.get(i["id"])
            if fut is None:
                if not _sched_pool:
                    from concurrent.futures import ThreadPoolExecutor

                    _sched_pool.append(ThreadPoolExecutor(16, thread_name_prefix="health-schedules"))
                fut = _sched_reading[i["id"]] = _sched_pool[0].submit(_read_schedules, i, rt)
            waits.append((fut, hit is not None))
    if waits:
        from concurrent.futures import wait

        wait([f for f, known in waits if not known])
        wait([f for f, known in waits if known], timeout=SCHED_WAIT_S)
    with _sched_lock:
        if not _sched_disk["dirty"]:
            return
        live = {i["id"] for i in items}
        for k in [k for k in _sched_names if k not in live]:
            del _sched_names[k]
        try:
            tmp = _sched_file().with_suffix(".tmp")
            tmp.write_text(json.dumps({k: [v[0], [list(x) for x in v[1]]] for k, v in _sched_names.items()}), "utf-8")
            tmp.replace(_sched_file())
            _sched_disk["dirty"] = False
        except OSError:
            log.exception("the pipeline schedules cache was not saved")


def facts(item_id: str) -> Optional[dict]:
    if time.time() - _facts_at > REFRESH_S * 5 or (item_id not in _facts and time.time() - _facts_at > 30):
        try:
            refresh()
        except Exception:  # noqa: BLE001
            log.exception("refreshing dataset facts failed")
    return _facts.get(item_id)


def schema_of(item_id: str) -> Optional[list[dict]]:
    """Columns with their types (the pipeline type names) of a Parquet dataset, cached until it changes."""
    item = db.drive_get(item_id)
    if not item:
        return None
    stamp = str(item.get("updated_at"))
    hit = _schema_cache.get(item_id)
    if hit and hit[0] == stamp:
        return hit[1]
    try:
        schema = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).schema_arrow
        cols = [{"name": f.name, "type": pdata._column_type(f.type)} for f in schema]
    except Exception:  # noqa: BLE001
        return None
    _schema_cache[item_id] = (stamp, cols)
    return cols


def _as_time(v: Any) -> Optional[datetime]:
    """A timestamp, date, ISO string or epoch number (seconds, or milliseconds when that large) as UTC."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if hasattr(v, "year") and hasattr(v, "month"):  # a date
        return datetime(v.year, v.month, v.day, tzinfo=timezone.utc)
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if abs(v) > 1e11 else v, tz=timezone.utc)
    return _parse(str(v).strip())


def newest_value(item_id: str, column: str) -> tuple[Optional[str], Optional[str]]:
    """(newest value of a timestamp column as ISO, error) in a Parquet dataset, cached until it changes."""
    item = db.drive_get(item_id)
    if not item or item.get("trashed_at"):
        return None, "the dataset was deleted or is in the trash"
    stamp = str(item.get("updated_at"))
    hit = _newest_cache.get((item_id, column))
    if hit and hit[0] == stamp:
        return hit[1], None
    try:
        table = pq.read_table(io.BytesIO(drive.read_bytes(item)), columns=[column])
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        return None, f'no column "{column}"' if column in msg or "No match" in msg or "not found" in msg.lower() else "not a readable Parquet dataset"
    newest: Optional[datetime] = None
    for v in table.column(0).to_pylist():
        t = _as_time(v)
        if t and (newest is None or t > newest):
            newest = t
    value = newest.isoformat(timespec="seconds") if newest else None
    _newest_cache[(item_id, column)] = (stamp, value)
    return value, None


def _last_data_transaction(item_id: str, ignore_empty: bool) -> Optional[str]:
    """When the dataset last got a transaction (with rows written, when empty ones are ignored)."""
    import dataset_versions

    txs = dataset_versions.history(item_id)
    for i, tx in enumerate(txs):
        if not ignore_empty:
            return tx.get("at")
        src = tx.get("source") or {}
        written = src.get("written")
        prev = txs[i + 1].get("rows") if i + 1 < len(txs) else None
        empty = tx.get("rows") == 0 or written == 0 or (written is None and src.get("transaction") == "APPEND" and prev is not None and tx.get("rows") == prev)
        if not empty:
            return tx.get("at")
    return None


# ------------------------------------------------------------------------------------------------
# checks
# ------------------------------------------------------------------------------------------------


def check_node(n: dict, rule: dict) -> dict:
    """{kind, ok, value, message} of one dataset check on a lineage dataset node."""
    k = rule["kind"]
    value: Optional[float] = None
    if k == "freshness":
        hours = float(rule.get("hours") or 24)
        at = _parse(n.get("updated_at"))
        age = (_now() - at).total_seconds() / 3600 if at else None
        ok = age is not None and age <= hours
        value = round(age, 2) if age is not None else None
        msg = f"updated {age:.1f} h ago (limit {hours:g} h)" if age is not None else "never updated"
    elif k == "time_since_updated":
        hours = float(rule.get("hours") or 24)
        ignore = bool(rule.get("ignore_empty"))
        at = _parse(_last_data_transaction(n["item_id"], ignore)) if n.get("item_id") else None
        if at is None and not ignore:
            at = _parse(n.get("updated_at"))
        age = (_now() - at).total_seconds() / 3600 if at else None
        ok = age is not None and age <= hours
        value = round(age, 2) if age is not None else None
        what = "last transaction with data" if ignore else "last transaction"
        msg = f"{what} {age:.1f} h ago (limit {hours:g} h)" if age is not None else f"no {what}"
    elif k == "row_count":
        rows = n.get("rows")
        lo, hi = rule.get("min"), rule.get("max")
        ok = rows is not None and (lo is None or rows >= lo) and (hi is None or rows <= hi)
        value = rows
        msg = f"{rows if rows is not None else '?'} rows (expected {lo if lo is not None else 0} to {hi if hi is not None else 'any'})"
    elif k == "columns":
        want = [c for c in rule.get("required") or [] if c]
        missing = [c for c in want if c not in (n.get("columns") or [])]
        ok = not missing
        value = len(missing)
        msg = "all required columns present" if ok else f"missing {', '.join(missing)}"
    elif k == "schema":
        expected = [c for c in rule.get("columns") or [] if c.get("name")]
        actual = schema_of(n["item_id"]) if n.get("item_id") else None
        if actual is None:
            ok, msg = False, "schema unavailable (not a Parquet dataset, or unreadable)"
        else:
            have = {c["name"]: c["type"] for c in actual}
            problems = []
            for c in expected:
                if c["name"] not in have:
                    problems.append(f"{c['name']} missing")
                elif c.get("type") and c["type"] != have[c["name"]]:
                    problems.append(f"{c['name']} is {have[c['name']]}, expected {c['type']}")
            extra = [c for c in have if c not in {e["name"] for e in expected}]
            if rule.get("mode") == "exact" and extra:
                problems.append(f"unexpected {', '.join(extra)}")
            ok = not problems
            value = len(problems)
            msg = ("schema matches" + (f" ({len(extra)} added columns allowed)" if extra else "")) if ok else "; ".join(problems)
    elif k == "data_freshness":
        hours = float(rule.get("hours") or 24)
        column = str(rule.get("column") or "").strip()
        if not column:
            ok, msg = False, "choose the timestamp column"
        elif not n.get("item_id"):
            ok, msg = False, "not a dataset in Files"
        else:
            newest, err = newest_value(n["item_id"], column)
            at = _parse(newest)
            age = (_now() - at).total_seconds() / 3600 if at else None
            ok = age is not None and age <= hours
            value = round(age, 2) if age is not None else None
            msg = err or (f"newest {column} is {age:.1f} h old ({newest[:16].replace('T', ' ')}; limit {hours:g} h)" if age is not None else f"no values in {column}")
    elif k == "build_status":
        st = (n.get("last_build") or {}).get("status")
        ok = st in (None, "succeeded")
        msg = f"last build {st or 'unknown'}"
    elif k == "up_to_date":
        ok = not n.get("stale")
        msg = n.get("stale") or "up to date with its inputs"
    else:
        ok, msg = False, f"unknown check {k}"
    return {"id": rule.get("id"), "kind": k, "ok": ok, "value": value, "message": msg}


def check_dataset(item_id: str, rule: dict) -> dict:
    n = facts(item_id)
    if not n:
        item = db.drive_get(item_id)
        if not item or item.get("trashed_at"):
            return {"id": rule.get("id"), "kind": rule["kind"], "ok": False, "value": None, "message": "the dataset was deleted or is in the trash"}
        n = {"item_id": item_id, "name": item["name"], "updated_at": str(item.get("updated_at"))}
    return check_node(n, rule)


def check_schedule(pipeline_id: str, schedule_id: str, rule: dict) -> dict:
    import pipeline_schedules as ps
    import pipeline_runtime as rt

    k = rule["kind"]
    book = rt.get_state(pipeline_id, f"schedule:{schedule_id}", {}) or {}
    runs = [ps._with_builds(r) for r in ps._runs(pipeline_id, schedule_id, 20)]
    started = [r for r in runs if r["outcome"] == "started" and r.get("status") not in (None, "running")]
    last = started[0] if started else None
    if k == "schedule_status":
        if book.get("paused"):
            return {"kind": k, "ok": False, "value": 1, "message": f"paused: {book['paused'].get('reason')}"}
        if not last:
            return {"kind": k, "ok": True, "value": 0, "message": "no finished run yet"}
        ok = last["status"] == "succeeded"
        return {"kind": k, "ok": ok, "value": 0 if ok else 1, "message": f"last run {last['status']} ({last['at'][:16].replace('T', ' ')})"}
    if k == "schedule_duration":
        limit = float(rule.get("minutes") or 60)
        if not last:
            return {"kind": k, "ok": True, "value": None, "message": "no finished run yet"}
        ends = [_parse(b.get("finished_at")) for b in last.get("build_status") or [] if b.get("finished_at")]
        start = _parse(last["at"])
        minutes = round((max(ends) - start).total_seconds() / 60, 2) if ends and start else None
        ok = minutes is None or minutes <= limit
        return {"kind": k, "ok": ok, "value": minutes, "message": f"last run took {minutes} min (limit {limit:g} min)" if minutes is not None else "duration unknown"}
    return {"kind": k, "ok": False, "value": None, "message": f"unknown check {k}"}


# Data Connection runs (data_source_runs, dc_export_runs) finish as "completed" or "failed"
_SYNC_OK = ("completed", "succeeded")


def _sync_ok(run: dict) -> bool:
    return run.get("status") in _SYNC_OK


def _sync_runs(rid: str, limit: int = 30) -> tuple[dict, list[dict]]:
    """(the sync or export, its runs newest first) of a "source:<id>" / "export:<id>" resource id."""
    import datasources as ds

    kind, _, sid = rid.partition(":")
    if kind == "source":
        rows = ds._rows("SELECT * FROM data_sources WHERE id = %s", (sid,))
        runs = ds._rows("SELECT * FROM data_source_runs WHERE source_id = %s ORDER BY started_at DESC LIMIT %s", (sid, limit)) if rows else []
    elif kind == "export":
        rows = ds._rows("SELECT * FROM dc_exports WHERE id = %s", (sid,))
        runs = ds._rows("SELECT * FROM dc_export_runs WHERE export_id = %s ORDER BY started_at DESC LIMIT %s", (sid, limit)) if rows else []
    else:
        rows, runs = [], []
    if not rows:
        raise LookupError(f"{kind or 'sync'} not found")
    return rows[0], runs


def _last_ok_run(rid: str, written: bool = False) -> list[dict]:
    """The last successful run of a sync or export, however many failed runs came after it (written: of a sync,
    the last one that wrote a transaction)."""
    import datasources as ds

    kind, _, sid = rid.partition(":")
    table, key = ("data_source_runs", "source_id") if kind == "source" else ("dc_export_runs", "export_id")
    extra = " AND item_id IS NOT NULL" if written and kind == "source" else ""
    return ds._rows(f"SELECT * FROM {table} WHERE {key} = %s AND status = ANY(%s){extra} ORDER BY started_at DESC LIMIT 1", (sid, list(_SYNC_OK)))


def _export_dataset_changed_at(row: dict) -> Optional[datetime]:
    """When an export's dataset last changed (a Files dataset's update, or a data source's last successful run)."""
    ref = row.get("dataset") or {}
    if ref.get("kind") == "source":
        try:
            _, runs = _sync_runs(f"source:{ref.get('id')}", 10)
        except LookupError:
            return None
        # a run that found nothing new wrote no transaction: the dataset did not change
        ok = [r for r in runs if _sync_ok(r) and r.get("item_id")] or _last_ok_run(f"source:{ref.get('id')}", written=True)
        return _parse(str(ok[0]["finished_at"])) if ok and ok[0].get("finished_at") else None
    item = db.drive_get(ref.get("item_id") or "")
    return _parse(str(item.get("updated_at"))) if item else None


def check_sync(rid: str, rule: dict) -> dict:
    """Sync status / sync freshness of a Data Connection sync (source:<id>) or export (export:<id>)."""
    k = rule["kind"]
    try:
        row, runs = _sync_runs(rid)
    except LookupError as e:
        return {"kind": k, "ok": False, "value": None, "message": f"{e} (deleted)"}
    finished = [r for r in runs if r["status"] != "running"]
    if k == "sync_status":
        if not finished:
            return {"kind": k, "ok": True, "value": 0, "message": "no finished run yet"}
        last = finished[0]
        ok = _sync_ok(last)
        at = str(last.get("finished_at") or last["started_at"])[:16].replace("T", " ")
        return {"kind": k, "ok": ok, "value": 0 if ok else 1,
                "message": f"last run {last['status']} ({at})" + ("" if ok else f": {(last.get('error') or '')[:200]}")}
    if k == "sync_freshness":
        hours = float(rule.get("hours") or 24)
        ok_runs = [r for r in runs if _sync_ok(r)] or _last_ok_run(rid)
        last_ok = _parse(str(ok_runs[0].get("finished_at") or ok_runs[0]["started_at"])) if ok_runs else None
        if rid.startswith("export:"):
            # an export is fresh while the target holds the dataset's latest data: stale for as long as the
            # dataset has changed without being exported again
            changed = _export_dataset_changed_at(row)
            if last_ok is None:
                return {"kind": k, "ok": False, "value": None, "message": "never exported successfully"}
            if changed is None or changed <= last_ok:
                return {"kind": k, "ok": True, "value": 0.0, "message": f"up to date with its dataset (exported {(_now() - last_ok).total_seconds() / 3600:.1f} h ago)"}
            behind = (_now() - changed).total_seconds() / 3600
            return {"kind": k, "ok": behind <= hours, "value": round(behind, 2),
                    "message": f"the dataset changed {behind:.1f} h ago and has not been exported since (limit {hours:g} h)"}
        age = (_now() - last_ok).total_seconds() / 3600 if last_ok else None
        return {"kind": k, "ok": age is not None and age <= hours, "value": round(age, 2) if age is not None else None,
                "message": f"last successful run {age:.1f} h ago (limit {hours:g} h)" if age is not None else "no successful run yet"}
    if k == "sync_row_count":
        lo, hi = rule.get("min"), rule.get("max")
        bounds = " and ".join(([f"at least {lo:g}"] if lo is not None else []) + ([f"at most {hi:g}"] if hi is not None else [])) or "no limit"
        if rule.get("measure") == "total":
            state = row.get("state") or {}
            if rid.startswith("export:"):
                n, what = state.get("exported_rows"), "rows in the export target"
            else:
                n, what = state.get("rows_total"), "rows in the synced dataset"
            if n is None or not (_last_ok_run(rid) or [r for r in runs if _sync_ok(r)]):
                return {"kind": k, "ok": True, "value": None, "message": "no successful run yet"}
        else:
            ok_runs = [r for r in runs if _sync_ok(r)] or _last_ok_run(rid)
            if not ok_runs:
                return {"kind": k, "ok": True, "value": None, "message": "no successful run yet"}
            n, what = ok_runs[0].get("rows") or 0, "rows in the last successful run"
        n = int(n or 0)
        ok = (lo is None or n >= float(lo)) and (hi is None or n <= float(hi))
        return {"kind": k, "ok": ok, "value": n, "message": f"{n:,} {what} (expected {bounds})"}
    return {"kind": k, "ok": False, "value": None, "message": f"unknown check {k}"}


def monitor_rule(m: dict) -> dict:
    """A monitoring-view monitor as a check: threshold / threshold_max and its config."""
    cfg = dict(m.get("config") or {})
    k = m["rule"]
    thr, hi = m.get("threshold"), m.get("threshold_max")
    if k in ("freshness", "time_since_updated", "data_freshness", "sync_freshness"):
        cfg["hours"] = thr or cfg.get("hours") or 24
    elif k in ("row_count", "sync_row_count"):
        cfg.setdefault("min", thr)
        if hi is not None:
            cfg.setdefault("max", hi)
    elif k == "schedule_duration":
        cfg["minutes"] = thr or cfg.get("minutes") or 60
    return {"kind": k, **cfg}


def measure(m: dict) -> tuple[Optional[float], bool, str]:
    """(value, firing, message) of a dataset or schedule monitor."""
    rule = monitor_rule(m)
    if m["resource_type"] == "schedule":
        pid, _, sid = m["resource_id"].partition("/")
        r = check_schedule(pid, sid, rule)
    elif m["resource_type"] == "dc_sync":
        r = check_sync(m["resource_id"], rule)
    else:
        r = check_dataset(m["resource_id"], rule)
    return r.get("value"), not r["ok"], r["message"]


def resource_name(kind: str, rid: str) -> str:
    if kind == "dc_sync":
        try:
            row, _ = _sync_runs(rid, 1)
        except Exception:  # noqa: BLE001
            return f"(deleted {'export' if rid.startswith('export:') else 'sync'})"
        return f"{row['name']} ({'export' if rid.startswith('export:') else 'sync'})"
    if kind == "schedule":
        pid, _, sid = rid.partition("/")
        try:
            content = json.loads(drive.read_bytes(pdata._pipeline_item(pid)))
            s = next((x for x in content.get("schedules") or [] if x.get("id") == sid), None)
            return f"{(db.drive_get(pid) or {}).get('name', '').removesuffix(pdata.PIPELINE_EXT)} · {s['name']}" if s else "(deleted schedule)"
        except Exception:  # noqa: BLE001
            return "(deleted schedule)"
    item = db.drive_get(rid)
    return item["name"] if item and not item.get("trashed_at") else "(deleted dataset)"


def history(kind: str, rid: str) -> list[dict]:
    """A monitor's series: rows per transaction of a dataset, minutes per run of a schedule, or rows per run of
    a sync or export (failed runs as 0)."""
    if kind == "dc_sync":
        try:
            _, runs = _sync_runs(rid, 60)
        except LookupError:
            return []
        return [{"minute": str(r["started_at"])[:16].replace(" ", "T"), "value": (r.get("rows") or 0) if _sync_ok(r) else 0} for r in reversed(runs)]
    if kind == "schedule":
        import pipeline_schedules as ps

        pid, _, sid = rid.partition("/")
        pts = []
        for r in reversed(ps._runs(pid, sid, 60)):
            r = ps._with_builds(r)
            ends = [_parse(b.get("finished_at")) for b in r.get("build_status") or [] if b.get("finished_at")]
            if ends and _parse(r["at"]):
                pts.append({"minute": r["at"][:16], "value": round((max(ends) - _parse(r["at"])).total_seconds() / 60, 2)})
        return pts
    import dataset_versions

    return [{"minute": (tx.get("at") or "")[:16], "value": tx.get("rows")} for tx in reversed(dataset_versions.history(rid)[:60])]


# ------------------------------------------------------------------------------------------------
# Sync checks set on a Data Connection sync or export, with in-app notifications
# ------------------------------------------------------------------------------------------------

SYNC_KINDS = ("sync_status", "sync_freshness", "sync_row_count")
SYNC_LABELS = {"sync_status": "Sync status", "sync_freshness": "Sync freshness", "sync_row_count": "Sync row count"}
SYNC_SCHEMA = """
CREATE TABLE IF NOT EXISTS dc_sync_checks (
    id           text PRIMARY KEY,
    resource_id  text NOT NULL,
    kind         text NOT NULL,
    config       jsonb NOT NULL DEFAULT '{}',
    enabled      boolean NOT NULL DEFAULT true,
    subscribers  jsonb NOT NULL DEFAULT '[]',
    state        jsonb NOT NULL DEFAULT '{}',
    created_by   text,
    created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS dc_sync_checks_by_resource ON dc_sync_checks (resource_id);
"""
_sync_table = False
_sync_eval_lock = threading.Lock()


def _sync_db() -> None:
    global _sync_table
    if not db.enabled():
        raise HTTPException(503, "Sync checks need the PostgreSQL database (BLUESANDAI_DATABASE_URL)")
    if not _sync_table:
        with db._connect() as conn:
            conn.execute(SYNC_SCHEMA)
        _sync_table = True


def _me_id() -> str:
    return (auth.current() or {}).get("id") or "local"


def _sync_connection(rid: str) -> tuple[dict, str]:
    """(the sync or export row, its connection id); LookupError when it is gone."""
    row, _ = _sync_runs(rid, 1)
    return row, row["connection_id"]


def _visible_sync(rid: str) -> dict:
    """The sync or export of a resource id when the caller may see its connection, else 404."""
    try:
        row, cid = _sync_connection(rid)
    except LookupError:
        raise HTTPException(404, "Sync not found") from None
    if not auth.visible_resources("connection", [{"id": cid}]):
        raise HTTPException(404, "Sync not found")
    return row


def _user_sees(user_id: str, connection_id: str) -> bool:
    """A subscriber still holds the connection's markings (and a role in its Project) — checked before telling them."""
    if not auth.enabled():
        return True
    try:
        p = auth.principal_of(user_id)
        if p is None:
            return False
        return auth.satisfies(auth.resource_effective("connection", connection_id), p.get("markings")) and \
            auth._rank(auth.role_for(auth.resource_project("connection", connection_id), p)) >= 1
    except Exception:  # noqa: BLE001 - a user we cannot check is not told
        return False


def _sync_link(rid: str) -> str:
    kind, _, sid = rid.partition(":")
    return f"/sources?{'export' if kind == 'export' else 'source'}={sid}"


def _public_sync_check(r: dict) -> dict:
    st = r.get("state") or {}
    me = _me_id()
    return {"id": r["id"], "resource_id": r["resource_id"], "kind": r["kind"], "label": SYNC_LABELS.get(r["kind"], r["kind"]),
            "config": r.get("config") or {}, "enabled": r["enabled"], "subscribed": me in (r.get("subscribers") or []),
            "subscribers": len(r.get("subscribers") or []), "created_at": r["created_at"].isoformat() if isinstance(r.get("created_at"), datetime) else r.get("created_at"),
            "status": "disabled" if not r["enabled"] else ("unknown" if "ok" not in st else "passing" if st["ok"] else "failing"),
            "ok": st.get("ok"), "value": st.get("value"), "message": st.get("message"), "failing_since": st.get("failing_since"), "checked_at": st.get("checked_at")}


def _notify_sync_check(r: dict, name: str, connection_id: str, res: dict) -> list[str]:
    """Tell the check's subscribers in the app that it started failing or passes again; returns who was told."""
    import notify

    failing = not res["ok"]
    subject = f"{SYNC_LABELS.get(r['kind'], r['kind'])} {'failing' if failing else 'passing again'}: {name}"
    body = res["message"] if failing else f"{res['message']}\n\nThe check passes again."
    told = []
    for uid in r.get("subscribers") or []:
        if not _user_sees(uid, connection_id):
            continue
        try:
            notify.deliver(uid, subject, body, link=_sync_link(r["resource_id"]), link_label="Open the sync", source="data-connection:sync-checks",
                           web=True, email=False)
            told.append(uid)
        except Exception:  # noqa: BLE001 - a notification never stops the checks
            log.exception("sync check notification to %s failed", uid)
    return told


def evaluate_sync_checks(rid: Optional[str] = None) -> list[dict]:
    """Check the enabled sync checks (of one sync, or all) now; a check that starts failing or passes again
    notifies its subscribers once (the state change is claimed in the database, so two evaluators — a run
    finishing and the background loop — never both notify). Checks of deleted syncs are removed.
    Returns the transitions: [{id, resource_id, kind, ok, told}]."""
    if not db.enabled():
        return []
    import datasources as ds

    _sync_db()
    rows = ds._rows("SELECT * FROM dc_sync_checks WHERE resource_id = %s" if rid else "SELECT * FROM dc_sync_checks", (rid,) if rid else ())
    by_resource: dict[str, list[dict]] = {}
    for r in rows:
        by_resource.setdefault(r["resource_id"], []).append(r)
    changes = []
    with _sync_eval_lock:
        for res_id, checks_ in by_resource.items():
            try:
                row, cid = _sync_connection(res_id)
            except LookupError:
                ds._exec("DELETE FROM dc_sync_checks WHERE resource_id = %s", (res_id,))
                continue
            except Exception:  # noqa: BLE001
                log.exception("sync checks of %s failed", res_id)
                continue
            name = f"{row['name']} ({'export' if res_id.startswith('export:') else 'sync'})"
            for r in checks_:
                if not r["enabled"]:
                    continue
                try:
                    res = check_sync(res_id, {"kind": r["kind"], **(r.get("config") or {})})
                except Exception as e:  # noqa: BLE001 - one broken check does not stop the others
                    log.exception("sync check %s failed", r["id"])
                    res = {"ok": False, "value": None, "message": f"the check could not be evaluated: {type(e).__name__}"}
                prev = r.get("state") or {}
                was_ok = prev.get("ok", True)
                now = _now().isoformat(timespec="seconds")
                state = {"ok": res["ok"], "value": res.get("value"), "message": res["message"], "checked_at": now,
                         "failing_since": None if res["ok"] else (prev.get("failing_since") or now)}
                if bool(was_ok) == bool(res["ok"]):
                    ds._exec("UPDATE dc_sync_checks SET state = %s WHERE id = %s", (Jsonb(state), r["id"]))
                    continue
                # claim the change: only the evaluator that flips the stored state notifies
                with db._lock, db._connect() as conn:
                    cur = conn.execute("UPDATE dc_sync_checks SET state = %s WHERE id = %s AND COALESCE((state->>'ok')::boolean, true) = %s",
                                       (Jsonb(state), r["id"], bool(was_ok)))
                    claimed = cur.rowcount == 1
                if claimed:
                    told = _notify_sync_check(r, name, cid, res)
                    changes.append({"id": r["id"], "resource_id": res_id, "kind": r["kind"], "ok": res["ok"], "told": told})
    return changes


def export_gate(export_id: str, run_rows: int, total_rows: int) -> Optional[str]:
    """Why an export run must stop before it writes anything, or None: an enabled sync row count check on the
    export ("export:<id>") that the rows about to be exported would fail — rows of this run ("run"), or rows the
    export target holds afterwards ("total"). Status and freshness checks never stop a run: a failed or stale
    export is fixed by running it. A check that cannot be read does not stop the export."""
    return _row_count_gate(f"export:{export_id}", run_rows, total_rows, "this run would export {n:,} rows",
                           "the export target would hold {n:,} rows", "Nothing was written.")


def sync_gate(source_id: str, run_rows: int, total_rows: int) -> Optional[str]:
    """Why a Data Connection sync run must not commit its dataset transaction, or None: an enabled sync row count
    check on the sync ("source:<id>") that the run would fail — rows this run fetched ("run"), or rows the synced
    dataset holds afterwards ("total"). The previous dataset version stays current. Status and freshness checks
    never stop a run; a check that cannot be read does not stop the sync."""
    return _row_count_gate(f"source:{source_id}", run_rows, total_rows, "this run fetched {n:,} rows",
                           "the synced dataset would hold {n:,} rows", "The dataset was not changed.")


def _row_count_gate(rid: str, run_rows: int, total_rows: int, run_what: str, total_what: str, tail: str) -> Optional[str]:
    if not db.enabled():
        return None
    import datasources as ds

    try:
        _sync_db()
        rows = ds._rows("SELECT * FROM dc_sync_checks WHERE resource_id = %s AND kind = 'sync_row_count' AND enabled ORDER BY created_at",
                        (rid,))
    except Exception:  # noqa: BLE001
        log.exception("%s: reading its row count checks failed", rid)
        return None
    reasons = []
    for r in rows:
        cfg = r.get("config") or {}
        lo, hi = cfg.get("min"), cfg.get("max")
        total = cfg.get("measure") == "total"
        n = total_rows if total else run_rows
        if (lo is None or n >= float(lo)) and (hi is None or n <= float(hi)):
            continue
        bounds = " and ".join(([f"at least {float(lo):g}"] if lo is not None else []) + ([f"at most {float(hi):g}"] if hi is not None else []))
        what = (total_what if total else run_what).format(n=n)
        reasons.append(f"{what} (expected {bounds})")
    if not reasons:
        return None
    return f"Stopped by the {SYNC_LABELS['sync_row_count']} check{'s' if len(reasons) > 1 else ''}: {'; '.join(reasons)}. {tail}"


class SyncCheckIn(BaseModel):
    resource_id: str
    kind: Literal["sync_status", "sync_freshness", "sync_row_count"]
    hours: Optional[float] = Field(None, gt=0)
    min: Optional[float] = Field(None, ge=0)
    max: Optional[float] = Field(None, ge=0)
    # sync_row_count: rows of the last successful run ("run") or in the dataset / export target ("total")
    measure: Literal["run", "total"] = "run"
    enabled: bool = True


class SyncCheckChange(BaseModel):
    hours: Optional[float] = Field(None, gt=0)
    min: Optional[float] = Field(None, ge=0)
    max: Optional[float] = Field(None, ge=0)
    clear_min: bool = False
    clear_max: bool = False
    measure: Optional[Literal["run", "total"]] = None
    enabled: Optional[bool] = None
    # subscribe / unsubscribe the caller
    subscribed: Optional[bool] = None


def _sync_config(kind: str, hours: Optional[float], lo: Optional[float], hi: Optional[float], measure: str) -> dict:
    if kind == "sync_freshness":
        return {"hours": hours or 24}
    if kind == "sync_row_count":
        if lo is None and hi is None:
            raise HTTPException(400, "Set a minimum or a maximum row count")
        if lo is not None and hi is not None and lo > hi:
            raise HTTPException(400, "The minimum is above the maximum")
        return {"min": lo, "max": hi, "measure": measure}
    return {}


def _sync_check_row(check_id: str) -> dict:
    import datasources as ds

    _sync_db()
    rows = ds._rows("SELECT * FROM dc_sync_checks WHERE id = %s", (check_id,))
    if not rows:
        raise HTTPException(404, "Sync check not found")
    _visible_sync(rows[0]["resource_id"])
    return rows[0]


@router.get("/syncs/checks")
def sync_checks(resource_id: str) -> dict:
    """The checks set on a sync or export, evaluated now."""
    import datasources as ds

    _sync_db()
    row = _visible_sync(resource_id)
    evaluate_sync_checks(resource_id)
    rows = ds._rows("SELECT * FROM dc_sync_checks WHERE resource_id = %s ORDER BY created_at", (resource_id,))
    return {"resource_id": resource_id, "name": row["name"], "checks": [_public_sync_check(r) for r in rows]}


@router.get("/syncs/status")
def sync_check_status() -> list[dict]:
    """Per sync or export with checks the caller can see: passing / failing (as last evaluated) — for listings."""
    import datasources as ds

    _sync_db()
    rows = ds._rows("SELECT resource_id, kind, enabled, state FROM dc_sync_checks ORDER BY resource_id")
    out: dict[str, dict] = {}
    for r in rows:
        st = r.get("state") or {}
        o = out.setdefault(r["resource_id"], {"resource_id": r["resource_id"], "checks": 0, "failing": [], "checked_at": None})
        o["checks"] += 1
        if r["enabled"] and st.get("ok") is False:
            o["failing"].append(r["kind"])
        o["checked_at"] = max(filter(None, [o["checked_at"], st.get("checked_at")]), default=None)
    visible = []
    for o in out.values():
        try:
            _visible_sync(o["resource_id"])
        except HTTPException:
            continue
        visible.append({**o, "status": "failing" if o["failing"] else "passing"})
    return visible


@router.post("/syncs/checks")
def create_sync_check(req: SyncCheckIn) -> dict:
    import datasources as ds

    _sync_db()
    _visible_sync(req.resource_id)
    cfg = _sync_config(req.kind, req.hours, req.min, req.max, req.measure)
    cid = "sc-" + uuid.uuid4().hex[:12]
    ds._exec("INSERT INTO dc_sync_checks (id, resource_id, kind, config, enabled, subscribers, state, created_by, created_at) "
             "VALUES (%s, %s, %s, %s, %s, %s, '{}', %s, %s)",
             (cid, req.resource_id, req.kind, Jsonb(cfg), req.enabled, Jsonb([_me_id()]), _me_id(), _now()))
    evaluate_sync_checks(req.resource_id)
    return _public_sync_check(_sync_check_row(cid))


@router.put("/syncs/checks/{check_id}")
def update_sync_check(check_id: str, req: SyncCheckChange) -> dict:
    import datasources as ds

    r = _sync_check_row(check_id)
    cfg = dict(r.get("config") or {})
    if r["kind"] != "sync_status" and (any(v is not None for v in (req.hours, req.min, req.max, req.measure)) or req.clear_min or req.clear_max):
        lo = None if req.clear_min else req.min if req.min is not None else cfg.get("min")
        hi = None if req.clear_max else req.max if req.max is not None else cfg.get("max")
        cfg = _sync_config(r["kind"], req.hours or cfg.get("hours"), lo, hi, req.measure or cfg.get("measure") or "run")
    subs = list(r.get("subscribers") or [])
    me = _me_id()
    if req.subscribed is True and me not in subs:
        subs.append(me)
    elif req.subscribed is False:
        subs = [s for s in subs if s != me]
    enabled = r["enabled"] if req.enabled is None else req.enabled
    # a changed rule is evaluated afresh (a check that was failing and still fails does not notify again);
    # a disabled check forgets its state (turned on again, it starts over)
    state = {} if not enabled else (r.get("state") or {})
    ds._exec("UPDATE dc_sync_checks SET config = %s, enabled = %s, subscribers = %s, state = %s WHERE id = %s",
             (Jsonb(cfg), enabled, Jsonb(subs), Jsonb(state), check_id))
    evaluate_sync_checks(r["resource_id"])
    return _public_sync_check(_sync_check_row(check_id))


@router.delete("/syncs/checks/{check_id}")
def delete_sync_check(check_id: str) -> dict:
    import datasources as ds

    _sync_check_row(check_id)
    ds._exec("DELETE FROM dc_sync_checks WHERE id = %s", (check_id,))
    return {"deleted": check_id}


# ------------------------------------------------------------------------------------------------
# Lineage rules, checked in the background
# ------------------------------------------------------------------------------------------------


def evaluate_rules() -> dict[str, dict]:
    """Every dataset's Lineage health rules, checked now; kept with when each started failing."""
    import lineage

    out: dict[str, dict] = {}
    for item_id, rules in lineage._health_rules().items():
        active = [r for r in rules if r.get("enabled", True)]
        if not active:
            continue
        prev = _state.get(item_id) or {}
        prev_since = {r.get("id"): r.get("failing_since") for r in prev.get("results") or []}
        results = []
        for r in active:
            res = check_dataset(item_id, r)
            res["failing_since"] = None if res["ok"] else (prev_since.get(r.get("id")) or _now().isoformat(timespec="seconds"))
            results.append(res)
        n = _facts.get(item_id) or {}
        out[item_id] = {"item_id": item_id, "name": n.get("name") or resource_name("dataset", item_id), "path": n.get("path") or [],
                        "status": "failing" if any(not x["ok"] for x in results) else "passing", "results": results,
                        "checked_at": _now().isoformat(timespec="seconds")}
    _state.clear()
    _state.update(out)
    return out


def _loop() -> None:
    while True:
        try:
            refresh()
            evaluate_rules()
        except Exception:  # noqa: BLE001
            log.exception("dataset health checks failed")
        try:
            evaluate_sync_checks()  # exports and scheduled syncs, freshness over time
        except Exception:  # noqa: BLE001
            log.exception("sync checks failed")
        time.sleep(REFRESH_S)


_started = False


def startup() -> None:
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_loop, daemon=True, name="health-checks").start()


# ------------------------------------------------------------------------------------------------
# endpoints
# ------------------------------------------------------------------------------------------------


@router.get("/checks")
def checks() -> dict:
    return {"checks": [{"id": k, "resource_type": v[0], "unit": v[1], "description": v[2]} for k, v in CHECKS.items()]}


@router.get("/datasets")
def dataset_health(refresh_now: bool = False) -> list[dict]:
    """The state of every dataset's health rules (checked in the background every couple of minutes)."""
    if refresh_now or not _state:
        refresh()
        evaluate_rules()
    # datasets the caller lacks the markings (or Project role) of are left out
    return sorted((v for v in _state.values() if auth.can_access(v["item_id"])), key=lambda x: (x["status"] != "failing", x["name"].lower()))


@router.get("/expectations")
def expectations(limit: int = 200) -> list[dict]:
    """Expectation results of recent pipeline builds: output expectations and input pre-conditions, newest first."""
    import pipeline_runtime as rt

    out = []
    for b in rt._builds(limit=max(1, min(limit, 1000))):
        if not auth.can_access(b["pipeline_id"]):
            continue
        common = {"build_id": b["id"], "pipeline_id": b["pipeline_id"], "pipeline_name": b.get("pipeline_name"), "at": b.get("finished_at") or b["created_at"],
                  "branch": b.get("branch") or "main", "build_status": b["status"]}
        for pre in b.get("preconditions") or []:
            out.append({**common, "target": pre.get("input"), "target_kind": "input", **{k: pre.get(k) for k in ("id", "ok", "message", "mode", "kind")}})
        for j in b.get("jobs") or []:
            for o in j.get("outputs") or []:
                for e in o.get("expectations") or []:
                    out.append({**common, "target": o.get("name"), "target_kind": "output", **{k: e.get(k) for k in ("id", "ok", "message", "mode", "kind")}})
    try:
        import code_repos

        for b in sorted(code_repos.all_builds(), key=lambda x: x["at"], reverse=True)[:max(1, min(limit, 1000))]:
            for e in b.get("expectations") or []:
                out.append({"build_id": b["id"], "pipeline_id": None, "pipeline_name": f"{b['repo_name']} · {b['transform'].split('::')[-1]}",
                            "repo_id": b["repo_id"], "transform": b["transform"], "source": "code", "at": b["at"], "branch": b.get("branch") or "master",
                            "build_status": b["status"], "target": e.get("target"), "target_kind": e.get("target_kind"),
                            **{k: e.get(k) for k in ("id", "ok", "message", "mode", "kind")}})
    except Exception:  # noqa: BLE001
        log.exception("reading Code Repositories expectations failed")
    return sorted(out, key=lambda x: x.get("at") or "", reverse=True)


@router.get("/resources")
def resources() -> dict:
    """Datasets, schedules and Data Connection syncs a check can watch. The datasets are those of the last lineage
    graph build (kept fresh in the background; after a restart the listing saved by the last build is served while
    the graph is rebuilt — the graph is built here only when there is neither)."""
    import pipeline_runtime as rt
    import pipeline_schedules as ps

    listing = _listing_of(_facts) if _facts else None
    stale = False
    if listing is None:
        listing = _load_listing()
        stale = listing is not None
    if listing is None:
        try:
            listing = _listing_of(refresh())
        except Exception:  # noqa: BLE001
            log.exception("refreshing dataset facts failed")
            listing = {}
    datasets = sorted(({"id": i, "name": n["name"], "path": " / ".join(n["path"])} for i, n in listing.items() if auth.can_access(i)), key=lambda d: d["name"].lower())
    # the schedules of pipeline_schedules.list_schedules (pipelines the caller can read), without each one's run state,
    # next runs and warnings, which are not listed here
    drive._require_db()
    pipelines = ps._pipeline_items()
    _prefetch_schedules(pipelines, rt)
    items = [i for i in pipelines if auth.can_access(i["id"])]
    schedules = [{"id": f"{item['id']}/{sid}", "name": f"{item['name'].removesuffix(pdata.PIPELINE_EXT)} · {name}"}
                 for item in items for sid, name in _pipeline_schedules(item)]
    syncs: list[dict] = []
    try:
        import datasources as ds

        # syncs and exports of connections whose markings the caller lacks are left out
        sources = ds._rows("SELECT id, name, connection_id FROM data_sources ORDER BY name")
        exports = ds._rows("SELECT id, name, connection_id FROM dc_exports ORDER BY name")
        seen = {r["connection_id"] for r in sources + exports}
        usable = {x["id"] for x in auth.visible_resources("connection", [{"id": i} for i in seen])}
        syncs += [{"id": f"source:{r['id']}", "name": f"{r['name']} (sync)"} for r in sources if r["connection_id"] in usable]
        syncs += [{"id": f"export:{r['id']}", "name": f"{r['name']} (export)"} for r in exports if r["connection_id"] in usable]
    except Exception:  # noqa: BLE001 - Data Connection needs the database
        log.exception("listing Data Connection syncs failed")
    if stale:
        _refresh_soon()  # started last: the graph build competes for the interpreter
    return {"datasets": datasets, "schedules": schedules, "syncs": syncs}
