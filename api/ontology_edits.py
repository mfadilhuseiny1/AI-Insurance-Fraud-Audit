"""Object edits and materializations, modelled on Foundry's "Object edits and materializations" docs.

User edits (every edit through `ontology.apply_edits`: actions, Logic, automations, inline edits, merges) are kept
in a layer of their own per object type (`user-edits/<type>.json`), apart from the backing datasource, so a
re-index resolves conflicts the way Object Storage v2 does:

- "Apply user edits" (default): an edited property keeps the user's value whatever the datasource says later; an
  object deleted by a user stays deleted even if its row comes back; an object created by a user holds only the
  user's values (columns of a row with the same key are ignored) and survives its row disappearing; a modified
  object whose row disappears is gone until the row returns, with the edits still applied.
- "Apply most recent value": an edit to a property applies only if it is newer than the datasource row's timestamp
  property (rows without a timestamp take every edit); edit-only properties always take the edit. Edits made before
  the strategy was switched on count as made when it was switched on.
- Each datasource of a multi-datasource object type (ontology_mdo.py) has its own strategy (the type-level one is
  the backing dataset's): an edit to a property is resolved by the strategy, and against the timestamp, of the
  datasource that backs that property.

Per object type (the Datasources tab's Edits section): the Edits toggle (off: actions refuse to edit the type),
"Track user edit history" (every edit with each property's before / after value; turning it off deletes the
history), the conflict resolution strategy, and schema migrations of existing edits: drop all edits (objects reset
to the datasource), drop property edits, move property edits to another property, cast property edits to a new
type. Deleting or retyping a property that has user edits needs a migration first (a breaking schema change).

Materializations: a Files dataset holding the latest state of every object (datasource and edits combined), with
columns from the Ontology's property definitions; "automatic" rebuilds it after every edit, "periodic" when the
datasource is re-indexed or every 6 hours if edits arrived. Only the latest snapshot matters. The dataset carries the
markings its rows need (materialization_markings): the object type's, every datasource's (their own, inherited and
folder markings) and the object type's mandatory controls. It is created already marked, gains new markings before its
rows are replaced and is narrowed only after; a watcher follows the inputs' markings between builds (a marking added
at an input is added to the dataset at once; one removed is removed by a rebuild).

Edits recorded before the layer existed (the edit log of ontology_model.py names the properties, not the values) are
taken into the layer once (backfill): only where the stored object still differs from the datasource, i.e. the edit
survived the re-indexes of that time.

Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth
import ontology
from ontology import _lock, _now, _read, _write

log = logging.getLogger("bluesandai.ontology_edits")
router = APIRouter(prefix="/api/ontology")

HISTORY_KEPT = 200  # entries per object
PERIODIC_SECONDS = 6 * 3600
CASTS = {
    "attachment": {"string"}, "boolean": {"string"}, "date": {"string"}, "double": {"integer", "long", "string"},
    "geopoint": {"string"}, "geoshape": {"string"}, "integer": {"long", "double", "string"}, "long": {"integer", "double", "string"},
    "marking": {"string"}, "timestamp": {"string"},
    "string": {"integer", "long", "double", "boolean", "date", "timestamp", "geopoint", "geoshape"},
}
_dirty: set[str] = set()
# called with (records, user, time) after user edits are recorded (machinery.py keeps process logs with them)
LISTENERS: list = []


def configure() -> None:
    for name in ("user-edits", "edit-history"):
        (ontology.DIR / name).mkdir(parents=True, exist_ok=True)
    if not _backfill_path().exists():
        try:
            # when the layer began, fixed before anything else writes to it (the backfill takes only older edits)
            _write(_backfill_path(), {"layer_started": layer_started()})
        except OSError as e:
            log.warning("user edits layer start not recorded: %s", e)
    ontology.MODEL_HOOKS.update({"user_edits": record, "edits_allowed": check_allowed, "merge_edits": merge, "edits_schema": check_schema,
                                 "reindexed": _after_reindex})


def startup() -> None:
    threading.Thread(target=_loop, daemon=True, name="materializations").start()
    threading.Thread(target=_watch_markings, daemon=True, name="materialization-markings").start()
    threading.Thread(target=_backfill_once, daemon=True, name="user-edits-backfill").start()


def config(t: dict) -> dict:
    c = dict(t.get("edits_config") or {})
    c.setdefault("enabled", True)
    c.setdefault("history", False)
    c.setdefault("strategy", "user_edits")
    c.setdefault("timestamp_property", None)
    c.setdefault("strategy_changed_at", None)
    # additional datasources' conflict resolution: dataset id -> {strategy, timestamp_property, changed_at}
    c.setdefault("datasource_strategies", {})
    c.setdefault("materialization", None)
    return c


def _layer_path(tid: str):
    return ontology.DIR / "user-edits" / f"{tid}.json"


def _history_path(tid: str):
    return ontology.DIR / "edit-history" / f"{tid}.json"


def layer(tid: str) -> dict:
    return _read(_layer_path(tid), {}) or {}


# ------------------------------------------------------------------------------------------------
# hooks from ontology.apply_edits and ontology_datasources._import
# ------------------------------------------------------------------------------------------------


def check_allowed(t: dict) -> None:
    if not config(t)["enabled"]:
        raise HTTPException(403, f"User edits are turned off for {t['display_name']} (Ontology Manager → Datasources → Edits)")


def record(records: list[dict]) -> None:
    """Keep the user edits just written (records: op, object_type_id, primary_key, before, after, changed)."""
    who = auth.actor_id() or (auth.current() or {}).get("username") or "system"
    now = _now()
    by: dict[str, list[dict]] = {}
    for r in records:
        by.setdefault(r["object_type_id"], []).append(r)
    for tid, rs in by.items():
        t = _read(ontology._path("object-types", tid)) or {}
        lay = layer(tid)
        for r in rs:
            pk = str(r["primary_key"])
            cur = lay.get(pk)
            if r["op"] == "delete":
                lay[pk] = {"deleted": True, "at": now, "properties": {}, "prop_at": {}}
            elif r["op"] == "create" or not cur or cur.get("deleted"):
                # a create (or a write to an object recreated after a delete) does not inherit earlier edits
                lay[pk] = {"created": r["op"] == "create", "at": now, "properties": dict(r["changed"]), "prop_at": {k: now for k in r["changed"]}}
            else:
                cur["properties"].update(r["changed"])
                cur["prop_at"].update({k: now for k in r["changed"]})
                cur["at"] = now
        _write(_layer_path(tid), lay)
        if config(t)["history"]:
            hist = _read(_history_path(tid), {}) or {}
            for r in rs:
                before, after = r.get("before") or {}, r.get("after") or {}
                keys = sorted(r["changed"]) if r["op"] != "delete" else sorted(before)
                hist.setdefault(str(r["primary_key"]), []).append({
                    "at": now, "user": who, "op": r["op"],
                    "changes": {k: [before.get(k), after.get(k)] for k in keys if r["op"] != "modify" or before.get(k) != after.get(k)}})
                hist[str(r["primary_key"])] = hist[str(r["primary_key"])][-HISTORY_KEPT:]
            _write(_history_path(tid), hist)
        for fn in LISTENERS:
            try:
                fn(rs, who, now)
            except Exception as e:  # noqa: BLE001 - a listener never fails the edit
                log.warning("edit listener failed: %s", e)
        if (config(t)["materialization"] or {}).get("dataset_id"):
            _dirty.add(tid)
            if config(t)["materialization"].get("mode") == "automatic":
                threading.Thread(target=_build_quietly, args=(tid,), daemon=True).start()


def changed_keys(before: Optional[dict], after: Optional[dict]) -> list[str]:
    before, after = before or {}, after or {}
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


def revert(entries: list[dict]) -> None:
    """An action run was reverted (ontology_actions.revert; objects already restored): each object's user edits go
    back to what they were before the run (entry "user_edits": the layer entry then, None = none) — otherwise the next
    re-index would bring the reverted values back — and the edit history gets a "revert" entry. Runs recorded before
    the user edits were kept with them: the restored values are kept as user edits. entries: object_type_id,
    primary_key, before (properties now, before the revert), after (properties restored; None: the object is gone)."""
    who = auth.actor_id() or (auth.current() or {}).get("username") or "system"
    now = _now()
    by: dict[str, list[dict]] = {}
    for e in entries:
        by.setdefault(e["object_type_id"], []).append(e)
    for tid, es in by.items():
        t = _read(ontology._path("object-types", tid)) or {}
        lay = layer(tid)
        for e in es:
            pk = str(e["primary_key"])
            if "user_edits" in e:
                if e["user_edits"] is None:
                    lay.pop(pk, None)
                else:
                    lay[pk] = e["user_edits"]
            elif e["after"] is None:
                lay.pop(pk, None)
            else:
                keys = changed_keys(e["before"], e["after"])
                cur = lay.get(pk) if lay.get(pk) and not lay[pk].get("deleted") else {"created": False, "at": now, "properties": {}, "prop_at": {}}
                cur["properties"].update({k: e["after"].get(k) for k in keys})
                cur["prop_at"].update({k: now for k in keys})
                cur["at"] = now
                lay[pk] = cur
        _write(_layer_path(tid), lay)
        if config(t)["history"]:
            hist = _read(_history_path(tid), {}) or {}
            for e in es:
                b, a = e["before"] or {}, e["after"] or {}
                hist.setdefault(str(e["primary_key"]), []).append({"at": now, "user": who, "op": "revert", "changes": {k: [b.get(k), a.get(k)] for k in changed_keys(b, a)}})
                hist[str(e["primary_key"])] = hist[str(e["primary_key"])][-HISTORY_KEPT:]
            _write(_history_path(tid), hist)


def _ts(v: Any) -> Optional[str]:
    if v in (None, ""):
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d.isoformat(timespec="seconds") if d.tzinfo else d.isoformat(timespec="seconds") + "+00:00"
    except ValueError:
        return str(v)


def datasource_of(t: dict) -> dict[str, Optional[str]]:
    """Property api name -> the dataset that backs it (the backing dataset or an additional datasource)."""
    out: dict[str, Optional[str]] = {}
    b = t.get("backing_dataset") or {}
    for api in (b.get("columns") or {}).values():
        out[api] = b.get("dataset_id")
    for d in t.get("additional_datasources") or []:
        for api in (d.get("columns") or {}).values():
            out[api] = d.get("dataset_id")
    return out


def resolution(t: dict, c: dict, dataset_id: Optional[str]) -> tuple[str, Optional[str], Optional[str]]:
    """(strategy, timestamp property, when the strategy was switched on) of the datasource backing a property: an
    additional datasource's own (default: Apply user edits), else the object type's (the backing dataset's, and that of
    properties no datasource backs)."""
    primary = (t.get("backing_dataset") or {}).get("dataset_id")
    if dataset_id and dataset_id != primary and any(d.get("dataset_id") == dataset_id for d in t.get("additional_datasources") or []):
        s = (c.get("datasource_strategies") or {}).get(dataset_id) or {}
        return s.get("strategy") or "user_edits", s.get("timestamp_property"), s.get("changed_at")
    return c["strategy"], c["timestamp_property"], c.get("strategy_changed_at")


def merge(t: dict, objs: dict) -> dict:
    """The objects of a re-index (datasource rows) with the user edits applied."""
    lay = layer(t["id"])
    if not lay:
        return objs
    c = config(t)
    edit_only = {p["api_name"] for p in t["properties"] if p.get("edit_only")}
    backed_by = datasource_of(t)
    now = _now()
    for pk, e in lay.items():
        if e.get("deleted"):
            objs.pop(pk, None)
            continue
        if e.get("created"):
            # an object a user created: only the user's values (and edit-only ones), whatever the datasource holds
            prev = objs.get(pk) or {}
            objs[pk] = {"properties": dict(e["properties"]), "created_at": prev.get("created_at", e["at"]), "updated_at": now}
            continue
        row = objs.get(pk)
        if row is None:
            continue
        props = row.setdefault("properties", {})
        # only the datasource's values count (the row before any edit is applied), per datasource
        rows_ts: dict[Optional[str], Optional[str]] = {}
        orig = dict(props)
        for k, v in e["properties"].items():
            if k not in edit_only:
                ds = backed_by.get(k)
                strategy, ts_prop, switched_on = resolution(t, c, ds)
                if strategy == "most_recent" and ts_prop:
                    if ds not in rows_ts:
                        rows_ts[ds] = _ts(orig.get(ts_prop))
                    ts = rows_ts[ds]
                    at = (e.get("prop_at") or {}).get(k, e["at"])
                    if switched_on and at < switched_on:
                        at = switched_on  # an edit older than the strategy counts from when it was switched on
                    if ts and at <= ts:
                        continue
            props[k] = v
    return objs


def _after_reindex(tid: str) -> None:
    t = _read(ontology._path("object-types", tid)) or {}
    if (config(t)["materialization"] or {}).get("dataset_id"):
        threading.Thread(target=_build_quietly, args=(tid,), daemon=True).start()


def check_schema(old: dict, new: dict) -> None:
    """Deleting or retyping a property that has user edits is a breaking schema change: migrate its edits first."""
    lay = layer(new["id"])
    if not lay:
        return
    edited = {k for e in lay.values() for k in (e.get("properties") or {})}
    after = {p["api_name"]: p for p in new["properties"]}
    for p in old["properties"]:
        name = p["api_name"]
        if name not in edited or name == old["primary_key"]:
            continue
        if name not in after:
            raise HTTPException(400, f"{p['display_name']} has user edits: drop or move its edits (Datasources → Edits → Migrations) before deleting it")
        q = after[name]
        if (q["type"], bool(q.get("array"))) != (p["type"], bool(p.get("array"))):
            raise HTTPException(400, f"{p['display_name']} has user edits: cast or drop its edits before changing its type")


# ------------------------------------------------------------------------------------------------
# materializations
# ------------------------------------------------------------------------------------------------


def _cell(v: Any) -> Any:
    return json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v


_type_locks: dict[str, threading.Lock] = {}
_type_locks_guard = threading.Lock()


def _type_lock(tid: str) -> threading.Lock:
    """One build (or markings sync) of a type's materialization at a time: two concurrent builds would create two
    datasets, or one could narrow the markings another just widened."""
    with _type_locks_guard:
        return _type_locks.setdefault(tid, threading.Lock())


def datasource_ids(t: dict) -> list[str]:
    ids = [(t.get("backing_dataset") or {}).get("dataset_id")] + [d.get("dataset_id") for d in t.get("additional_datasources") or []]
    return [i for i in ids if i]


def input_markings(t: dict) -> set[str]:
    """What a materialized dataset inherits from its inputs: the object type's markings (its own and what it inherits)
    and every datasource's (own, inherited and folder markings), whether or not the object type stopped inheriting
    them: the dataset holds the datasources' rows."""
    import marked_outputs

    return marked_outputs.markings_of(datasource_ids(t), [("object_type", t["id"])])


def control_markings(t: dict, objs: dict) -> set[str]:
    """The object type's mandatory controls (doc 24: a materialized dataset requires the user to satisfy all
    mandatory controls): every marking and organization a mandatory control property allows, and every value its
    objects hold."""
    out: set[str] = set()
    for p in t["properties"]:
        if not p.get("mandatory_control"):
            continue
        out |= set(p.get("allowed_markings") or [])
        out |= {f"org:{o}" for o in p.get("allowed_organizations") or []}
        for o in objs.values():
            v = (o.get("properties") or {}).get(p["api_name"])
            out |= {str(x) for x in (v if isinstance(v, list) else [v]) if x}
    return out


def materialization_markings(tid: str) -> dict:
    """The markings a type's materialized dataset needs (inputs + mandatory controls of its rows as last built) and
    those it carries."""
    t = ontology._object_type(tid)
    mat = config(t)["materialization"] or {}
    want = input_markings(t) | set(mat.get("row_markings") or [])
    cur = sorted(auth._item_row(mat["dataset_id"])[1]) if mat.get("dataset_id") else []
    return {"needed": sorted(want), "inherited": cur}


def _require_datasources(t: dict) -> None:
    """Configuring or building a materialization is an identity transform of the datasources: the caller must be able
    to read each of them (doc 24)."""
    import drive

    for i in datasource_ids(t):
        try:
            drive._item(i)
        except HTTPException as e:
            if e.status_code == 404:
                continue  # a datasource deleted since: nothing of it is read
            raise HTTPException(403, f"Materializing {t['display_name']} needs read access to each of its datasources") from e


def build(tid: str) -> dict:
    """Write the latest state of every object to the materialized dataset."""
    with _type_lock(tid):
        return _build(tid)


def _build(tid: str) -> dict:
    import drive
    import marked_outputs
    import pipeline_datasets
    import pyarrow as pa

    with _lock:
        t = ontology._object_type(tid)
        c = config(t)
        mat = c["materialization"]
        if not mat:
            raise HTTPException(400, f"{t['display_name']} has no materialization")
        objs = ontology.load_objects(tid)
        props = [p for p in t["properties"] if not p.get("derived")]
        numeric = {"integer": pa.int64(), "long": pa.int64(), "short": pa.int64(), "byte": pa.int64(), "double": pa.float64(),
                   "float": pa.float64(), "decimal": pa.float64(), "boolean": pa.bool_()}
        cols = {}
        for p in props:
            vals = [_cell((o.get("properties") or {}).get(p["api_name"])) for _, o in sorted(objs.items())]
            typ = numeric.get(p["type"]) if not p.get("array") else None
            try:
                cols[p["api_name"]] = pa.array(vals, type=typ or pa.string()) if typ else pa.array([None if v is None else str(v) for v in vals], type=pa.string())
            except (pa.ArrowInvalid, pa.ArrowTypeError):
                cols[p["api_name"]] = pa.array([None if v is None else str(v) for v in vals], type=pa.string())
        cols["__updated_at"] = pa.array([o.get("updated_at") for _, o in sorted(objs.items())], type=pa.string())
        table = pa.table(cols)
        row_marks = control_markings(t, objs)
    data = pipeline_datasets._parquet_bytes(table)
    # the materialized dataset carries the markings of the object type, of every datasource and of the object type's
    # mandatory controls (inherited, so they follow the inputs: removing them is done at the source). Never a moment
    # with fewer than its rows need: a new dataset is marked under its id before it exists (marked_outputs.create), an
    # existing one gains the markings before its rows are replaced and is narrowed only after. Project constraints
    # the markings would violate fail the build before anything is written.
    inputs = datasource_ids(t)
    marks = input_markings(t) | row_marks
    item = pipeline_datasets._live_file(mat.get("dataset_id")) if mat.get("dataset_id") else None
    if item:
        marked_outputs.check(item["id"], marks, exists=True)
        cur = set(auth._item_row(item["id"])[1])
        if not marks <= cur:
            auth._set_item(item["id"], inherited=sorted(cur | marks))
        pipeline_datasets._replace_content(item, data)
    else:
        folder = drive._folder_id(mat.get("folder_id") or drive.default_folder("ontology"))
        item = marked_outputs.create(folder, f"{t['display_name']} materialized.parquet", data, pipeline_datasets.PARQUET, marks, inputs)
    # narrowed to what the rows need now: a marking an input gained while the rows were written stays (the watcher
    # may have added it already), one it lost before the build began is dropped
    after = _read(ontology._path("object-types", tid)) or t
    auth._set_item(item["id"], inherited=sorted(marks | input_markings(after)))
    marked_outputs._note(item["id"], inputs)
    with _lock:
        t = ontology._object_type(tid)
        c = config(t)
        c["materialization"] = {**c["materialization"], "dataset_id": item["id"], "last_built_at": _now(), "rows": table.num_rows, "error": None,
                                "row_markings": sorted(row_marks)}
        t["edits_config"] = c
        ontology._put("object-types", t)
    _dirty.discard(tid)
    _watched.add(tid)
    # an input marking gained during the build that the Project does not allow fails it (the markings stay applied)
    auth.check_constraints(item["id"])
    return c["materialization"]


_sync_rebuilt: dict[str, float] = {}
SYNC_SECONDS = 2.0
SYNC_REBUILD_SECONDS = 60.0


def sync_markings(tid: str) -> Optional[str]:
    """Between builds the materialized dataset follows its inputs' markings: one an input (the object type, a
    datasource, a folder above one) gained is added at once; one they lost is removed by a rebuild (the rows are
    rewritten, then narrowed). A materialization built before its markings covered mandatory controls is rebuilt
    once. Returns "widened", "rebuilt" or None."""
    import pipeline_datasets

    out = None
    with _type_lock(tid):
        t = _read(ontology._path("object-types", tid))
        mat = config(t)["materialization"] if t else None
        if not mat or not mat.get("dataset_id"):
            return None
        item = pipeline_datasets._live_file(mat["dataset_id"])
        if not item:
            return None
        want = input_markings(t) | set(mat.get("row_markings") or [])
        cur = set(auth._item_row(item["id"])[1])
        if not want <= cur:
            auth._set_item(item["id"], inherited=sorted(cur | want))
            out = "widened"
        stale = bool(cur - want) or "row_markings" not in mat
    if stale and time.monotonic() - _sync_rebuilt.get(tid, float("-inf")) >= SYNC_REBUILD_SECONDS:
        _sync_rebuilt[tid] = time.monotonic()
        _build_quietly(tid)
        out = "rebuilt"
    return out


_watched: set[str] = set()  # types with a materialized dataset (built in this process, or found by the watcher)


def _watch_markings() -> None:
    listed = float("-inf")
    while True:
        time.sleep(SYNC_SECONDS)
        try:
            if time.monotonic() - listed >= 30:
                _watched.update(t["id"] for t in ontology._all("object-types") if (config(t)["materialization"] or {}).get("dataset_id"))
                listed = time.monotonic()
            for tid in sorted(_watched):
                sync_markings(tid)
        except Exception as e:  # noqa: BLE001 - tried again on the next tick
            log.warning("materialization markings sync failed: %s", e)


# ------------------------------------------------------------------------------------------------
# edits recorded before the layer existed: a one-time backfill from the edit log
# ------------------------------------------------------------------------------------------------


def _backfill_path():
    return ontology.DIR / "user-edits" / ".backfill.json"


def layer_started() -> str:
    """When user edits began to be kept in the layer: the layer directory's creation, or the first layer entry if
    earlier (written once, so later layer changes do not move it)."""
    from datetime import timezone

    rec = _read(_backfill_path(), {}) or {}
    if rec.get("layer_started"):
        return rec["layer_started"]
    d = ontology.DIR / "user-edits"
    started = datetime.fromtimestamp(d.stat().st_ctime, timezone.utc).isoformat(timespec="seconds") if d.exists() else _now()
    for p in d.glob("*.json"):
        for e in (_read(p, {}) or {}).values():
            if isinstance(e, dict) and e.get("at") and not e.get("backfilled") and e["at"] < started:
                started = e["at"]
    return started


def _datasource_values(t: dict) -> dict[str, dict]:
    """{primary key: {property: value}} as the datasources hold them (coerced as a re-index does)."""
    import ontology_datasources

    props = {p["api_name"]: p for p in t["properties"]}
    out: dict[str, dict] = {}
    sources = []
    b = t.get("backing_dataset") or {}
    if b.get("dataset_id"):
        pk_col = next((c for c, api in (b.get("columns") or {}).items() if api == t["primary_key"]), None)
        sources.append((b["dataset_id"], pk_col, b.get("columns") or {}))
    for d in t.get("additional_datasources") or []:
        sources.append((d["dataset_id"], d.get("pk_column"), d.get("columns") or {}))
    for ds_id, pk_col, mapping in sources:
        if not pk_col:
            continue
        _, _, rows = ontology_datasources._read(ds_id)
        for r in rows:
            pk = r.get(pk_col)
            if pk in (None, ""):
                continue
            vals = out.setdefault(str(pk), {})
            for col, api in mapping.items():
                p = props.get(api)
                if p is None or p.get("edit_only"):
                    continue
                try:
                    vals[api] = r.get(col) if p["type"] == "media" else ontology.coerce_property({**p, "value_type_id": None}, r.get(col), api)
                except HTTPException:
                    vals[api] = None
    return out


def backfill(dry_run: bool = True, type_ids: Optional[list[str]] = None) -> dict:
    """Edits made before the layer existed, from the edit log (ontology_model.py: op, primary key, property NAMES, time;
    the last 200 per type), taken into the layer where the edit survived — the log has no values, so the value is the
    stored object's, and only where it still differs from the datasource (a re-index of that time overwrote an edit
    with the datasource's value: such an edit is lost and cannot be told apart from no edit):

    - a deleted object still absent from the store: kept deleted (its row coming back no longer restores it);
    - an object created by a user that no datasource row holds: kept as user-created, with its stored values;
    - a modified (or created, when a row has its key) object: each logged property whose stored value differs from the
      datasource's (edit-only properties always), with the time of its last logged edit.

    Objects with layer entries keep them (a later delete or create is never overridden; a modify gains only properties
    it lacks). Types without a datasource are skipped: no re-index runs, the store holds the edits. Returns a report."""
    cutoff = layer_started()
    report: dict[str, Any] = {"layer_started": cutoff, "dry_run": dry_run, "types": []}
    for t in ontology._all("object-types"):
        if type_ids and t["id"] not in type_ids:
            continue
        entries = [e for e in _read(ontology.DIR / "edit-log" / f"{t['id']}.json", []) or [] if str(e.get("at") or "") < cutoff]
        if not entries:
            continue
        rep: dict[str, Any] = {"object_type_id": t["id"], "display_name": t["display_name"], "log_entries": len(entries),
                               "log_may_be_trimmed": len(_read(ontology.DIR / "edit-log" / f"{t['id']}.json", []) or []) >= 200,
                               "deleted": 0, "created": 0, "modified_objects": 0, "modified_properties": 0,
                               "skipped_lost_or_unchanged": 0, "skipped_in_layer": 0, "skipped_row_missing": 0}
        report["types"].append(rep)
        if not t.get("backing_dataset"):
            rep["skipped"] = "no datasource: no re-index runs, the stored objects hold the edits"
            continue
        # the edit log replayed: the state each object was left in before the layer existed
        state: dict[str, dict] = {}
        for e in entries:
            pk = str(e.get("primary_key"))
            if e.get("op") == "delete":
                state[pk] = {"op": "delete", "at": e["at"], "props": {}}
            elif e.get("op") == "create" or state.get(pk, {}).get("op") in (None, "delete"):
                state[pk] = {"op": e.get("op") or "modify", "at": e["at"], "props": {k: e["at"] for k in e.get("properties") or []}}
            else:
                state[pk]["props"].update({k: e["at"] for k in e.get("properties") or []})
                state[pk]["at"] = e["at"]
        try:
            rows = _datasource_values(t)
        except Exception as ex:  # noqa: BLE001 - reported, the type is left as it is
            rep["skipped"] = f"datasource not readable: {getattr(ex, 'detail', ex)}"
            continue
        props = {p["api_name"]: p for p in t["properties"]}
        with _lock:
            objs = ontology.load_objects(t["id"])
            lay = layer(t["id"])
            changed = False
            for pk, s in state.items():
                cur = lay.get(pk)
                obj = objs.get(pk)
                if s["op"] == "delete":
                    if obj is not None:
                        rep["skipped_lost_or_unchanged"] += 1  # restored by a re-index of that time, or recreated since
                    elif cur:
                        rep["skipped_in_layer"] += 1
                    else:
                        lay[pk] = {"deleted": True, "at": s["at"], "properties": {}, "prop_at": {}, "backfilled": True}
                        rep["deleted"] += 1
                        changed = True
                    continue
                if obj is None:
                    rep["skipped_lost_or_unchanged"] += 1  # gone since (its row removed, or deleted after)
                    continue
                stored = obj.get("properties") or {}
                if s["op"] == "create" and pk not in rows:
                    if cur:
                        rep["skipped_in_layer"] += 1
                        continue
                    keep = {k: v for k, v in stored.items() if k in props and not props[k].get("derived")}
                    lay[pk] = {"created": True, "at": s["at"], "properties": keep, "prop_at": {k: s["at"] for k in keep}, "backfilled": True}
                    rep["created"] += 1
                    changed = True
                    continue
                if pk not in rows:
                    rep["skipped_row_missing"] += 1  # cannot tell an edit from a value of a row since removed
                    continue
                if cur and (cur.get("deleted") or cur.get("created")):
                    rep["skipped_in_layer"] += 1
                    continue
                row = rows[pk]
                take = {}
                for k, at in s["props"].items():
                    p = props.get(k)
                    if p is None or p.get("derived") or k == t["primary_key"] or k not in stored or (cur and k in (cur.get("properties") or {})):
                        continue
                    if p.get("edit_only") or (k in row and stored[k] != row[k]):
                        take[k] = (stored[k], at)
                if not take:
                    rep["skipped_lost_or_unchanged"] += 1
                    continue
                entry = cur or {"created": False, "at": s["at"], "properties": {}, "prop_at": {}}
                entry["properties"].update({k: v for k, (v, _) in take.items()})
                entry["prop_at"].update({k: at for k, (_, at) in take.items()})
                entry["at"] = max(entry.get("at") or "", s["at"])
                entry["backfilled"] = True
                lay[pk] = entry
                rep["modified_objects"] += 1
                rep["modified_properties"] += len(take)
                changed = True
            if changed and not dry_run:
                _write(_layer_path(t["id"]), lay)
    return report


def _backfill_once() -> None:
    """Run the backfill once per data directory (the record is kept in user-edits/.backfill.json)."""
    try:
        rec = _read(_backfill_path(), {}) or {}
        if rec.get("done_at"):
            return
        started = layer_started()
        _write(_backfill_path(), {"layer_started": started})
        rep = backfill(dry_run=False)
        _write(_backfill_path(), {"layer_started": started, "done_at": _now(), "report": rep})
        log.info("user edits backfill: %s", [(r["display_name"], r.get("deleted"), r.get("created"), r.get("modified_properties")) for r in rep["types"]])
    except Exception as e:  # noqa: BLE001 - reported in the log; tried again at the next start
        log.warning("user edits backfill failed: %s", e)


def _build_quietly(tid: str) -> None:
    try:
        build(tid)
    except Exception as e:  # noqa: BLE001 - recorded on the materialization
        log.warning("materialization of %s failed: %s", tid, e)
        with _lock:
            t = _read(ontology._path("object-types", tid))
            if t and (t.get("edits_config") or {}).get("materialization"):
                t["edits_config"]["materialization"]["error"] = str(e)[:500]
                ontology._put("object-types", t)


def _loop() -> None:
    while True:
        time.sleep(300)
        for t in ontology._all("object-types"):
            mat = config(t)["materialization"]
            if not mat or not mat.get("dataset_id") or mat.get("mode") != "periodic":
                continue
            last = mat.get("last_built_at") or ""
            due = not last or (datetime.fromisoformat(_now()) - datetime.fromisoformat(last)).total_seconds() >= PERIODIC_SECONDS
            if t["id"] in _dirty and due:
                _build_quietly(t["id"])


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


def _restricted(t: dict) -> bool:
    """Whether some users may not see every object or property of the type (object / property security policies,
    mandatory controls, datasources the user may not view)."""
    return bool(t.get("security") or t.get("additional_datasources") or any(p.get("mandatory_control") for p in t["properties"]))


def _visible_recent(t: dict, recent: list) -> list:
    """Recent user edits as the caller may see them: only objects they can see, and properties hidden from them
    (security policies, datasources they cannot view) left out. An object no longer stored cannot be checked: left out
    on a restricted type."""
    if not _restricted(t) or not auth.enabled() or (auth.current() or {}).get("service") or auth.current() is None:
        return recent
    objs = ontology.load_objects(t["id"])
    out = []
    for pk, e in recent:
        obj = objs.get(pk)
        if obj is None or not ontology._can_see(t, obj):
            continue
        hidden = set(ontology._public_object(t, pk, obj).get("hidden_properties") or [])
        out.append((pk, {**e, "properties": {k: v for k, v in (e.get("properties") or {}).items() if k not in hidden}}))
    return out


@router.get("/object-types/{type_id}/edits")
def edits_summary(type_id: str, limit: int = 50) -> dict:
    t = ontology._object_type(type_id)
    lay = layer(type_id)
    per_prop: dict[str, int] = {}
    for e in lay.values():
        for k in e.get("properties") or {}:
            per_prop[k] = per_prop.get(k, 0) + 1
    recent = sorted(lay.items(), key=lambda kv: kv[1].get("at", ""), reverse=True)[:max(1, min(limit, 500))]
    recent = _visible_recent(t, recent)
    return {"config": config(t), "edited_objects": len(lay), "created": sum(1 for e in lay.values() if e.get("created")),
            "deleted": sum(1 for e in lay.values() if e.get("deleted")), "modified": sum(1 for e in lay.values() if not e.get("created") and not e.get("deleted")),
            "by_property": per_prop, "last_edit_at": max((e.get("at", "") for e in lay.values()), default=None),
            "has_datasource": bool(t.get("backing_dataset")),
            "recent": [{"primary_key": pk, "op": "delete" if e.get("deleted") else "create" if e.get("created") else "modify", "at": e.get("at"),
                        "properties": e.get("properties")} for pk, e in recent]}


class EditsConfigIn(BaseModel):
    enabled: Optional[bool] = None
    history: Optional[bool] = None
    strategy: Optional[Literal["user_edits", "most_recent"]] = None
    timestamp_property: Optional[str] = None
    # turning history off deletes it: the caller confirms
    confirm_delete_history: bool = False


@router.put("/object-types/{type_id}/edits/config")
def set_config(type_id: str, req: EditsConfigIn) -> dict:
    with _lock:
        t = ontology._object_type(type_id)
        import ontology_model as om

        om.require_role(t.get("ontology_id"), "editor", t, "change edit settings")
        c = config(t)
        if req.enabled is not None:
            c["enabled"] = req.enabled
            if not req.enabled:
                c["history"] = False
        if req.history is not None:
            if req.history and not c["enabled"]:
                raise HTTPException(400, "turn on Edits before tracking user edit history")
            if not req.history and c["history"]:
                if not req.confirm_delete_history:
                    raise HTTPException(400, "turning off Track user edit history permanently deletes the history: confirm to continue")
                _history_path(type_id).unlink(missing_ok=True)
            c["history"] = req.history
        if req.strategy is not None:
            if req.strategy == "most_recent" and c["strategy"] != "most_recent":
                c["strategy_changed_at"] = _now()  # existing edits count from now (doc 24)
            c["strategy"] = req.strategy
        if req.timestamp_property is not None:
            p = next((x for x in t["properties"] if x["api_name"] == req.timestamp_property), None)
            if req.timestamp_property and (not p or p["type"] not in ("timestamp", "date")):
                raise HTTPException(400, "the timestamp property must be a timestamp (or date) property backed by the datasource")
            c["timestamp_property"] = req.timestamp_property or None
        if c["strategy"] == "most_recent" and not c["timestamp_property"]:
            raise HTTPException(400, "Apply most recent value needs the timestamp property")
        t["edits_config"] = c
        ontology._put("object-types", t)
    return config(t)


class DatasourceStrategyIn(BaseModel):
    strategy: Literal["user_edits", "most_recent"]
    timestamp_property: Optional[str] = None


@router.put("/object-types/{type_id}/edits/datasources/{dataset_id}/config")
def set_datasource_strategy(type_id: str, dataset_id: str, req: DatasourceStrategyIn) -> dict:
    """The conflict resolution strategy of one datasource of a multi-datasource object type (doc 24: each datasource
    can have its own). The backing dataset's is the object type's (PUT .../edits/config). The timestamp property must
    be backed by this datasource."""
    with _lock:
        t = ontology._object_type(type_id)
        import ontology_model as om

        om.require_role(t.get("ontology_id"), "editor", t, "change edit settings")
        c = config(t)
        if dataset_id == (t.get("backing_dataset") or {}).get("dataset_id"):
            raise HTTPException(400, "the backing dataset's strategy is the object type's: set it in the Edits settings")
        ds = next((d for d in t.get("additional_datasources") or [] if d.get("dataset_id") == dataset_id), None)
        if not ds:
            raise HTTPException(404, "not a datasource of this object type")
        cur = dict((c["datasource_strategies"] or {}).get(dataset_id) or {})
        ts_prop = req.timestamp_property or None
        if req.strategy == "most_recent":
            if not ts_prop:
                raise HTTPException(400, "Apply most recent value needs the timestamp property")
            p = next((x for x in t["properties"] if x["api_name"] == ts_prop), None)
            if not p or p["type"] not in ("timestamp", "date") or ts_prop not in (ds.get("columns") or {}).values():
                raise HTTPException(400, "the timestamp property must be a timestamp (or date) property backed by this datasource")
            if cur.get("strategy") != "most_recent":
                cur["changed_at"] = _now()
        cur.update({"strategy": req.strategy, "timestamp_property": ts_prop if req.strategy == "most_recent" else None})
        c["datasource_strategies"] = {**(c["datasource_strategies"] or {}), dataset_id: cur}
        t["edits_config"] = c
        ontology._put("object-types", t)
    return config(t)


class MigrateIn(BaseModel):
    kind: Literal["drop_all", "drop_property", "move_property", "cast_property"]
    property: Optional[str] = None
    to: Optional[str] = None


@router.post("/object-types/{type_id}/edits/migrate")
def migrate(type_id: str, req: MigrateIn) -> dict:
    """Schema migrations of existing user edits. Dropping edits resets objects to the datasource (re-index)."""
    with _lock:
        t = ontology._object_type(type_id)
        import ontology_model as om

        om.require_role(t.get("ontology_id"), "editor", t, "migrate user edits")
        lay = layer(type_id)
        props = {p["api_name"]: p for p in t["properties"]}
        if req.kind != "drop_all" and (not req.property or req.property == t["primary_key"]):
            raise HTTPException(400, "pick a property (migrations do not apply to the primary key)")
        changed = 0
        if req.kind == "drop_all":
            changed = len(lay)
            lay = {}
        elif req.kind == "drop_property":
            for e in lay.values():
                if req.property in (e.get("properties") or {}):
                    e["properties"].pop(req.property)
                    (e.get("prop_at") or {}).pop(req.property, None)
                    changed += 1
        elif req.kind == "move_property":
            if req.to not in props or req.to == t["primary_key"]:
                raise HTTPException(400, "move the edits to another property of this object type")
            for e in lay.values():
                if req.property in (e.get("properties") or {}):
                    e["properties"][req.to] = e["properties"].pop(req.property)
                    if req.property in (e.get("prop_at") or {}):
                        e["prop_at"][req.to] = e["prop_at"].pop(req.property)
                    changed += 1
        else:
            target = props.get(req.property)
            frm = req.to
            if not target or not frm:
                raise HTTPException(400, "name the property and the type its edits were (to: old type)")
            if target["type"] not in CASTS.get(frm, set()):
                raise HTTPException(400, f"edits cannot be cast from {frm} to {target['type']}")
            for e in lay.values():
                if req.property in (e.get("properties") or {}):
                    try:
                        e["properties"][req.property] = ontology.coerce_property({**target, "value_type_id": None}, e["properties"][req.property], req.property)
                    except HTTPException:
                        e["properties"][req.property] = None
                    changed += 1
        lay = {pk: e for pk, e in lay.items() if e.get("deleted") or e.get("created") or e.get("properties")}
        _write(_layer_path(type_id), lay)
    reindexed = None
    if t.get("backing_dataset") and req.kind in ("drop_all", "drop_property", "move_property", "cast_property"):
        import ontology_datasources

        reindexed = ontology_datasources.reindex(type_id)
    return {"migrated": changed, "edited_objects": len(lay), "reindexed": bool(reindexed)}


@router.get("/object-types/{type_id}/objects/{pk}/edit-history")
def edit_history(type_id: str, pk: str) -> dict:
    t = ontology._object_type(type_id)
    c = config(t)
    if not c["history"]:
        return {"enabled": False, "entries": []}
    # whoever can see the object with this primary key sees its history, without the properties hidden from them
    hidden = set(ontology.get_object(type_id, pk).get("hidden_properties") or [])
    entries = list(reversed((_read(_history_path(type_id), {}) or {}).get(str(pk), [])))
    if hidden:
        entries = [{**e, "changes": {k: v for k, v in (e.get("changes") or {}).items() if k not in hidden}} for e in entries]
    return {"enabled": True, "entries": entries}


class MaterializationIn(BaseModel):
    mode: Literal["automatic", "periodic"] = "automatic"
    folder_id: Optional[str] = None


@router.put("/object-types/{type_id}/materialization")
def set_materialization(type_id: str, req: MaterializationIn) -> dict:
    with _lock:
        t = ontology._object_type(type_id)
        import ontology_model as om

        om.require_role(t.get("ontology_id"), "editor", t, "configure materializations")
        c = config(t)
        if not c["enabled"]:
            raise HTTPException(400, "materializations are configured once Edits are on")
        _require_datasources(t)
        c["materialization"] = {**(c["materialization"] or {}), "mode": req.mode, "folder_id": req.folder_id or (c["materialization"] or {}).get("folder_id")}
        t["edits_config"] = c
        ontology._put("object-types", t)
    return build(type_id)


@router.post("/object-types/{type_id}/materialization/build")
def build_now(type_id: str) -> dict:
    import ontology_model as om

    t = ontology._object_type(type_id)
    om.require_role(t.get("ontology_id"), "editor", t, "build materializations")
    _require_datasources(t)
    return build(type_id)


@router.get("/object-types/{type_id}/materialization/markings")
def get_materialization_markings(type_id: str) -> dict:
    """The markings the materialized dataset needs (object type, datasources, mandatory controls) and carries."""
    return materialization_markings(type_id)


@router.delete("/object-types/{type_id}/materialization")
def remove_materialization(type_id: str) -> dict:
    """Stop materializing (the dataset stays in Files)."""
    with _lock:
        t = ontology._object_type(type_id)
        import ontology_model as om

        om.require_role(t.get("ontology_id"), "editor", t, "configure materializations")
        c = config(t)
        c["materialization"] = None
        t["edits_config"] = c
        ontology._put("object-types", t)
    return config(t)


@router.post("/object-edits/backfill")
def run_backfill(dry_run: bool = True) -> dict:
    """The edits recorded before the layer existed, taken into it (administrators; dry_run: report only). It also runs
    once by itself at startup."""
    auth.require_admin()
    rep = backfill(dry_run=dry_run)
    if not dry_run:
        rec = _read(_backfill_path(), {}) or {}
        _write(_backfill_path(), {**rec, "layer_started": rep["layer_started"], "done_at": _now(), "report": rep})
    return rep


@router.get("/object-edits/overview")
def overview() -> list[dict]:
    """Every object type with its edit settings, user edits and materialization."""
    out = []
    # only the object types the caller may see (markings, ontology roles), as the object type listing
    types = auth.visible_resources("object_type", ontology._all("object-types"))
    if "discoverable" in ontology.MODEL_HOOKS:
        types = [t for t in types if ontology.MODEL_HOOKS["discoverable"](t)]
    for t in types:
        try:
            ontology._hook("read", t)
        except HTTPException:
            continue
        lay = layer(t["id"])
        c = config(t)
        out.append({"object_type_id": t["id"], "display_name": t["display_name"], "has_datasource": bool(t.get("backing_dataset")), "config": c,
                    "edited_objects": len(lay), "last_edit_at": max((e.get("at", "") for e in lay.values()), default=None)})
    return sorted(out, key=lambda r: (-r["edited_objects"], r["display_name"]))
