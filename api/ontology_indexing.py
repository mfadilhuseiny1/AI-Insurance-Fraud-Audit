"""Indexing, modelled on Foundry's Object indexing docs (Funnel batch pipelines, data restrictions, Overview).

Every (re-)index of an object type's backing dataset runs as a Funnel-style batch pipeline and is recorded:

1. Changelog: the difference between the previous index and the dataset — rows added, modified, removed.
2. Merge changes: the user edits (ontology_edits.py) merged onto the changed rows by primary key.
3. Indexing: the data restrictions of Object Storage v2 are checked — no NaN or ±infinity, no empty strings (both
   become null, reported), no null elements in arrays (dropped, reported), no nested arrays, strings up to 12 MB and
   arrays up to 100,000 elements (an index with either fails, like OSv2's build). Values a property does not allow
   (ontology_datasources' "disallowed dataset values") are indexed as null and reported on the run (`invalid_values`),
   or, with the datasource's invalid_values "fail", fail the run with that report.
4. Hydration: the index is written and ready to query.

Mode: incremental when at most half the rows changed (only the changelog is applied), full otherwise or when a user
asks for a full re-index. A run whose schema (the column ↔ property mapping and the property types) differs from the
previous run is a replacement pipeline; the others are the live pipeline. Object types without a dataset are
indexed by their edits alone. How the datasource was read is kept on the run as `read` (ontology_datasources._import):
mode append (only the row groups an APPEND added), compare (every row group, streamed and compared to the row hashes)
or full (every row built), source dataset | changelog, bytes / rows / row groups read, and why an append-only read
was not possible.

Routes: GET /api/ontology/indexing (every object type), GET /api/ontology/object-types/<id>/indexing (runs),
POST …/indexing/full (a full re-index). Mounted by server.py.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

import ontology
from ontology import _lock, _now, _read, _write

router = APIRouter(prefix="/api/ontology")

MAX_STRING_BYTES = 12 * 1024 * 1024
MAX_ARRAY = 100_000
RUNS_KEPT = 50
INCREMENTAL_SHARE = 0.5
# why the current index runs: "manual", "full", "datasource update", "initial", "datasource changed", "migration"
TRIGGER: contextvars.ContextVar[str] = contextvars.ContextVar("index_trigger", default="manual")


def configure() -> None:
    (ontology.DIR / "indexing").mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS.update({"index_begin": begin, "index_end": end, "index_failed": failed})


def _runs_path(tid: str):
    return ontology.DIR / "indexing" / f"{tid}.json"


def runs(tid: str) -> list[dict]:
    return _read(_runs_path(tid), []) or []


def _schema(t: dict, mapping: dict) -> str:
    sig = {"mapping": mapping, "types": {p["api_name"]: [p["type"], bool(p.get("array"))] for p in t["properties"]}, "pk": t["primary_key"]}
    return hashlib.sha1(json.dumps(sig, sort_keys=True).encode()).hexdigest()[:12]


def _clean(value: Any, prop: str, warnings: dict[str, int]) -> Any:
    """OSv2's data restrictions on one value (raises for the ones that fail the index)."""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        warnings[f"{prop}: NaN / infinity → null"] = warnings.get(f"{prop}: NaN / infinity → null", 0) + 1
        return None
    if isinstance(value, str):
        if value == "":
            warnings[f"{prop}: empty string → null"] = warnings.get(f"{prop}: empty string → null", 0) + 1
            return None
        if len(value.encode("utf-8")) > MAX_STRING_BYTES:
            raise HTTPException(400, f"PropertySizeLimitExceeded: a {prop} value is over 12 MB (use a media reference property)")
        return value
    if isinstance(value, list):
        if len(value) > MAX_ARRAY:
            raise HTTPException(400, f"PropertySizeLimitExceeded: a {prop} array has {len(value):,} elements; the limit is 100,000 (use a link type)")
        if any(isinstance(x, list) for x in value):
            raise HTTPException(400, f"NestedArraysNotSupported: {prop} holds nested arrays")
        if any(x is None for x in value):
            warnings[f"{prop}: null array elements dropped"] = warnings.get(f"{prop}: null array elements dropped", 0) + 1
            value = [x for x in value if x is not None]
        return [_clean(x, prop, warnings) for x in value]
    return value


def begin(t: dict, old: dict, new: dict, mapping: dict, totals: Optional[tuple[int, int]] = None) -> dict:
    """Changelog and indexing checks for the rows about to be indexed (cleans `new` in place). totals: (objects stored,
    rows' objects) when `old` and `new` hold only the keys a re-index touched (ontology_datasources: every other
    object is stored and unchanged), so the counts are of the whole sets."""
    started = time.monotonic()
    warnings: dict[str, int] = {}
    for o in new.values():
        props = o.get("properties") or {}
        for k in list(props):
            props[k] = _clean(props[k], k, warnings)
    added = [pk for pk in new if pk not in old]
    removed = [pk for pk in old if pk not in new]
    modified = [pk for pk in new if pk in old and (old[pk].get("properties") or {}) != (new[pk].get("properties") or {})]
    changed = len(added) + len(modified) + len(removed)
    prev = runs(t["id"])
    schema = _schema(t, mapping)
    trigger = TRIGGER.get()
    replacement = bool(prev) and prev[-1].get("schema") != schema
    n_old, n_new = totals if totals is not None else (len(old), len(new))
    full = trigger in ("full", "initial", "datasource changed") or replacement or not n_old or changed > INCREMENTAL_SHARE * max(1, n_new)
    return {"id": uuid.uuid4().hex[:12], "at": _now(), "trigger": trigger, "schema": schema, "pipeline": "replacement" if replacement else "live",
            "mode": "full" if full else "incremental", "rows": n_new, "added": len(added), "modified": len(modified), "removed": len(removed),
            "warnings": [{"message": k, "count": v} for k, v in warnings.items()], "started": started,
            "changelog_ms": int((time.monotonic() - started) * 1000)}


def end(t: dict, run: dict, final: dict) -> None:
    """Merge changes, indexing and hydration are done: record the run."""
    from ontology_edits import layer

    total = int((time.monotonic() - run.pop("started")) * 1000)
    lay = layer(t["id"])
    # (final may hold only the touched keys, every key with edits among them: objects_total counts them all)
    merged = sum(1 for pk in lay if pk in final or lay[pk].get("deleted"))
    n = run.pop("objects_total", None)
    n = len(final) if n is None else n
    read = run.get("read") or {}
    run.update({"status": "succeeded", "objects": n, "edits_merged": merged, "ms": total,
                "steps": [{"name": "Changelog", "status": "succeeded", "detail": f"+{run['added']} ~{run['modified']} −{run['removed']}{_read_detail(read)}",
                           "ms": run.pop("changelog_ms")},
                          {"name": "Merge changes", "status": "succeeded", "detail": f"{merged} objects with user edits"},
                          {"name": "Indexing", "status": "succeeded", "detail": f"{run['mode']} · {len(run['warnings'])} data warnings{_invalid_detail(run)}"},
                          {"name": "Hydration", "status": "succeeded",
                           "detail": f"{n:,} objects ready · {n - run.get('unchanged', 0):,} written, {run.get('unchanged', 0):,} unchanged kept"}]})
    _record(t["id"], run)


def _invalid_detail(run: dict) -> str:
    """The values indexed as null because their properties do not allow them (a datasource's "null" mode)."""
    n = (run.get("invalid_values") or {}).get("total") or 0
    return f" · {n:,} disallowed value{'s' if n != 1 else ''} indexed as null" if n else ""


READ_MODES = {"append": "append-only read", "compare": "snapshot compare", "full": "full read"}


def _read_detail(read: dict) -> str:
    """How the datasource was read (ontology_datasources._import's run["read"]), for the Changelog step."""
    if not read:
        return ""
    out = f" · {READ_MODES.get(read.get('mode'), read.get('mode'))}"
    if read.get("source") == "changelog":
        out += f" of a changelog ({read.get('deleted', 0):,} deleted)"
    out += f": {read.get('rows_read', 0):,} of {read.get('rows', 0):,} rows, {read.get('row_groups_read', 0)} of {read.get('row_groups', 0)} row groups"
    if read.get("row_groups_reused"):
        out += f" ({read['row_groups_reused']} unchanged skipped)"
    out += f", {read.get('bytes', 0) / 1e6:.2f} of {read.get('size', 0) / 1e6:.2f} MB"
    if read.get("copy"):
        out += " from the transaction's local copy"
    return out


def failed(t: dict, error: str, report: Optional[dict] = None) -> None:
    """A failed index. report: the disallowed values that failed it (ontology_datasources' invalid-values report:
    counts per column / property / kind and the first offending rows)."""
    _record(t["id"], {"id": uuid.uuid4().hex[:12], "at": _now(), "trigger": TRIGGER.get(), "status": "failed", "error": error[:500],
                      "pipeline": "live", "mode": "full", "steps": [{"name": "Indexing", "status": "failed", "detail": error[:200]}],
                      **({"invalid_values": report} if report else {})})


def _record(tid: str, run: dict) -> None:
    with _lock:
        rs = runs(tid)
        rs.append(run)
        _write(_runs_path(tid), rs[-RUNS_KEPT:])


def _status(t: dict) -> dict:
    b = t.get("backing_dataset") or {}
    rs = runs(t["id"])
    last = rs[-1] if rs else None
    objs = ontology.stored_objects(t["id"]) if not ontology.SCENARIO.get() else {}
    return {"object_type_id": t["id"], "display_name": t["display_name"], "source": "dataset" if b else "edits only", "dataset": b.get("name"),
            "dataset_id": b.get("dataset_id"), "auto_reindex": b.get("auto_reindex", True) if b else None, "synced_at": b.get("synced_at"),
            "errors": b.get("errors") or [], "objects": len(objs), "last_run": last,
            "status": ("failed" if (last or {}).get("status") == "failed" or b.get("errors") else "ready") if b else "ready"}


@router.get("/indexing")
def overview() -> list[dict]:
    return sorted((_status(t) for t in ontology._all("object-types")), key=lambda r: (r["source"] != "dataset", r["display_name"]))


@router.get("/object-types/{type_id}/indexing")
def type_indexing(type_id: str) -> dict:
    t = ontology._object_type(type_id)
    return {**_status(t), "runs": list(reversed(runs(type_id)))}


@router.post("/object-types/{type_id}/indexing/full")
def full_reindex(type_id: str) -> dict:
    import ontology_datasources

    t = ontology._object_type(type_id)
    if not t.get("backing_dataset"):
        raise HTTPException(400, f"{t['display_name']} has no backing dataset: its objects come from edits only")
    token = TRIGGER.set("full")
    try:
        ontology_datasources.reindex(type_id)
    finally:
        TRIGGER.reset(token)
    return type_indexing(type_id)
