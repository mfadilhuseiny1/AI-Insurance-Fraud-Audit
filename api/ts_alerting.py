"""Time series alerting (Palantir's "Time series alerting", "Set up a time series alerting automation", "Additional
configurations" and its FAQ): Automate's "time_series" condition.

An automation holds time series logic (ts_engine.py cards: TSPs of a root object type and its linked sensors,
transforms, ending in a time series search card) and a scope of root objects (all, a property filter or chosen
objects). The logic is templated: it runs for every root object in scope. Each period the search finds — the
condition holding — becomes an object of the alert object type, whose properties are found by their type classes
(timeseries:alert_event_id, …start_time, …end_time; see ALERT_CLASSES). An alert whose condition still holds at
the last point is ongoing (no end time) and is closed when the condition clears — or, for streaming alerting with a
custom recovery condition, when that condition holds.

Evaluation jobs
  One job per alert object type evaluates every automation writing to it ("one job can relate to many
  automations"). Batch jobs run when a time series sync backing the root object type's TSPs (or its sensors') gets
  new data — or on a schedule — and read only the tail: from the last evaluated point minus the default lookback
  window (set it to the longest window of the logic). The first run checks the entire series (optionally only its
  last N points: first job run read limit); later runs only new data, so an automation added to an existing job
  does not alert on history (the first run read limit, in days, bounds how much history the first run reads). Streaming jobs run continuously (every few seconds), evaluate points older than the
  allowed lateness, honour minimum durations and custom recovery conditions, and can exclude syncs. Job
  configuration (Automate → the automation → Time series evaluation status → View configuration) applies to every
  automation of the alert object type: profiles, fail job on any failure, default lookback, first run read limit,
  job timeout, schedule, Ontology polling interval, allowed lateness, excluded syncs.

Logic changes: historical alerts stay; an ongoing alert closes when the new logic says the object is normal, stays
open otherwise. Each logic change is a new automation version (recorded on alerts).

Effects: an automation's action or Logic effect runs on each new alert object, at most every "evaluation frequency"
minutes (0: after every run); with no effect the alerts are only written.

Job records are JSON in data/ontology/ts-jobs/. Mounted by server.py under /api/timeseries/alerting.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import timeseries
import ts_engine as E
import ts_ontology as T

log = logging.getLogger("bluesandai.ts_alerting")
router = APIRouter(prefix="/api/timeseries/alerting")

AUTOMATION_RID = "ri.automate.main.automation."
ALERT_CLASSES = {
    "timeseries:alert_event_id": ("Alert event ID", "string"),
    "timeseries:automation_rid": ("Automation RID", "string"),
    "timeseries:automation_version": ("Automation version", "integer"),
    "timeseries:root_object_pk": ("Root object primary key", "string"),
    "timeseries:root_object_type_api_name": ("Root object type", "string"),
    "timeseries:start_time": ("Start time", "timestamp"),
    "timeseries:end_time": ("End time", "timestamp"),
    "timeseries:generation_time": ("Generation time", "timestamp"),
}
STREAMING_CLASSES = {
    "timeseries:event_start_cause": ("Event start cause", "string"),
    "timeseries:event_end_cause": ("Event end cause", "string"),
    "timeseries:template_rid": ("Template RID", "string"),
    "timeseries:template_version": ("Template version", "string"),
}
TICK = 5  # seconds
RUNS_KEPT = 100
_lock = threading.RLock()
_running: set[str] = set()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso(ms: Optional[int]) -> Optional[str]:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat() if ms is not None else None


# ------------------------------------------------------------------------------------------------
# alert object types
# ------------------------------------------------------------------------------------------------


def _class_map(t: dict) -> dict[str, str]:
    return {p["type_class"]: p["api_name"] for p in t["properties"] if p.get("type_class")}


def supports_alerting(t: dict, streaming: bool = False) -> list[str]:
    """The type classes an object type lacks to hold time series alerts (empty: it supports them)."""
    have = _class_map(t)
    need = {**ALERT_CLASSES, **(STREAMING_CLASSES if streaming else {})}
    return [c for c in need if c not in have]


@router.get("/alert-object-types")
def alert_object_types() -> list[dict]:
    out = []
    for t in auth.visible_resources("object_type", ontology._all("object-types")):
        missing = supports_alerting(t)
        if not missing:
            out.append({"id": t["id"], "display_name": t["display_name"], "streaming": not supports_alerting(t, True),
                        "job": _job_summary(t["id"])})
    return out


class AlertTypeIn(BaseModel):
    display_name: str = Field("Time series alert", min_length=1, max_length=200)
    streaming: bool = True


@router.post("/alert-object-types")
def create_alert_object_type(req: AlertTypeIn) -> dict:
    """Create new object type: an object type with the alert properties (type classes) automations write to."""
    classes = {**ALERT_CLASSES, **(STREAMING_CLASSES if req.streaming else {})}
    props = [ontology.Property(api_name=c.split(":", 1)[1].split("_")[0] + "".join(w.capitalize() for w in c.split(":", 1)[1].split("_")[1:]),
                               display_name=label, type=kind, type_class=c) for c, (label, kind) in classes.items()]
    props.append(ontology.Property(api_name="title", display_name="Title", type="string"))
    t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=req.display_name, description="Alerts written by time series alerting automations",
                                                          icon="bell", properties=props, primary_key="alertEventId", title_property="title",
                                                          generate_primary_key=False))
    return t


# ------------------------------------------------------------------------------------------------
# automations (Automate's time_series condition)
# ------------------------------------------------------------------------------------------------


def _logic_hash(logic: dict) -> str:
    return hashlib.sha256(json.dumps(logic, sort_keys=True).encode()).hexdigest()[:16]


def check(rec: dict) -> None:
    """Validate a time series condition (ontology._check_automation)."""
    c = rec["condition"]
    mode = c.get("mode") or "batch"
    if mode not in ("batch", "streaming"):
        raise HTTPException(400, "the alert output type is batch or streaming")
    c["mode"] = mode
    if rec.get("ts_mode") and rec["ts_mode"] != mode:
        raise HTTPException(400, "the alert output type cannot change after the automation was created")
    rec["ts_mode"] = mode
    root = ontology._object_type(c.get("object_type_id") or "")
    if not T._ts_cfg(root)["properties"] and not any(T._ts_cfg(t).get("sensor") and any(link["root_object_type_id"] == root["id"] for link in T._ts_cfg(t)["sensor"]["links"])
                                                     for t in ontology._all("object-types")):
        raise HTTPException(400, f"{root['display_name']} has no time series properties or sensors: time series alerts need a time series object type")
    alert = ontology._object_type(c.get("alert_object_type_id") or "")
    if alert["id"] == root["id"]:
        raise HTTPException(400, "the alert object type must differ from the root object type")
    missing = supports_alerting(alert, mode == "streaming")
    if missing:
        raise HTTPException(400, f"{alert['display_name']} does not support time series alerting: it needs properties with the type classes {', '.join(missing)}")
    for other in ontology._all("automations"):
        oc = other.get("condition") or {}
        if other["id"] != rec.get("id") and oc.get("kind") == "time_series" and oc.get("alert_object_type_id") == alert["id"] and (oc.get("mode") or "batch") != mode:
            raise HTTPException(400, f"{alert['display_name']}'s evaluation job is {oc.get('mode') or 'batch'}: a {mode} automation needs another alert object type")
    logic = c.get("logic") or {}
    allowed = tuple(x for x in E.ALERTING_CARDS if not (mode == "streaming" and x in E.STREAMING_UNSUPPORTED))
    try:
        E.check_logic(logic, allowed)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    cards = {x["id"]: x for x in logic["cards"]}
    out = logic.get("output") or next((x["id"] for x in reversed(logic["cards"]) if x["type"] == "search"), None)
    if not out or cards[out]["type"] != "search":
        raise HTTPException(400, "connect the logic to a time series search card (the output)")
    logic["output"] = out
    if sum(1 for x in logic["cards"] if x["type"] == "search") > 1:
        raise HTTPException(400, "use one time series search (combine conditions with && or || in its condition)")
    scfg = cards[out].get("config") or {}
    if scfg.get("multi"):
        raise HTTPException(400, "automations cannot be saved with the Multi time series search type")
    if scfg.get("recovery") and mode != "streaming":
        raise HTTPException(400, "custom recovery conditions are a streaming alerting option")
    if E.root_objects(logic):
        raise HTTPException(400, "time series alerting logic needs a single root object: start from one object of the root object type "
                                 "and use its time series properties and linked sensors")
    sc = c.setdefault("scope", {"kind": "all"})
    if sc.get("kind") not in ("all", "filter", "objects"):
        raise HTTPException(400, "the scope is all objects, a property filter or chosen objects")
    c["evaluation_minutes"] = max(0, int(c.get("evaluation_minutes") or 0))
    h = _logic_hash(logic)
    if rec.get("ts_logic_hash") != h:
        rec["ts_logic_hash"] = h
        rec["ts_version"] = int(rec.get("ts_version") or 0) + 1


def _roots(c: dict) -> list[str]:
    objs = ontology._objects(c["object_type_id"])
    sc = c.get("scope") or {"kind": "all"}
    if sc.get("kind") == "objects":
        return [k for k in sc.get("primary_keys") or [] if k in objs]
    if sc.get("kind") == "filter" and sc.get("property"):
        return [k for k, o in objs.items() if str(o.get("properties", {}).get(sc["property"])) == str(sc.get("value"))]
    return list(objs)


# ------------------------------------------------------------------------------------------------
# jobs
# ------------------------------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "batch": {"spark_profiles": [], "fail_on_any": False, "default_lookback": "1d", "first_run_read_limit": None, "timeout_hours": 1,
              "schedule": {"kind": "on_data", "minutes": 60}},
    "streaming": {"profiles": [], "fail_on_any": False, "polling_interval_s": 60, "allowed_lateness_s": 5, "excluded_syncs": [], "every_s": 10,
                  "default_lookback": "1d"},
}


def _job_path(alert_type_id: str):
    return ontology._path("ts-jobs", alert_type_id)


def _job(alert_type_id: str) -> dict:
    j = ontology._read(_job_path(alert_type_id)) or {"alert_object_type_id": alert_type_id, "config": json.loads(json.dumps(DEFAULT_CONFIG)),
                                                     "state": {}, "runs": [], "last_run_at": None, "inputs_seen": None}
    for k, v in DEFAULT_CONFIG.items():
        j["config"].setdefault(k, {})
        for kk, vv in v.items():
            j["config"][k].setdefault(kk, vv)
    return j


def _save_job(j: dict) -> None:
    ontology._write(_job_path(j["alert_object_type_id"]), j)


def _automations(alert_type_id: str, enabled_only: bool = True) -> list[dict]:
    return [a for a in ontology._all("automations") if (a.get("condition") or {}).get("kind") == "time_series"
            and a["condition"].get("alert_object_type_id") == alert_type_id and (a.get("enabled") or not enabled_only)]


def _input_syncs(root_type_id: str) -> set[str]:
    """Time series syncs behind the root object type's TSPs and its sensor object types'."""
    out: set[str] = set()
    for t in ontology._all("object-types"):
        cfg = T._ts_cfg(t)
        if t["id"] == root_type_id or any(link["root_object_type_id"] == root_type_id for link in (cfg.get("sensor") or {}).get("links", [])):
            for pc in cfg["properties"].values():
                out.update(pc.get("syncs") or [])
    return out


def _inputs_mark(autos: list[dict], excluded: list[str]) -> str:
    syncs: set[str] = set()
    for a in autos:
        syncs |= _input_syncs(a["condition"]["object_type_id"])
    marks = []
    for s in sorted(syncs - set(excluded)):
        try:
            marks.append(f"{s}={timeseries._sync(s).get('last_write_at')}")
        except HTTPException:
            continue
    return "|".join(marks)


class _Tracking(T.Resolver):
    """Remembers the newest point time read (the job's watermark per root object)."""

    def __init__(self, excluded: set[str], streaming: bool) -> None:
        super().__init__()
        self.max_t: Optional[int] = None
        self.excluded = excluded
        self.streaming = streaming

    def tsp(self, obj, prop, rng, depth):  # noqa: ANN001, ANN201
        s = super().tsp(obj, prop, rng, depth)
        if s.t:
            self.max_t = max(self.max_t or s.t[-1], s.t[-1])
        return s


def _existing_alerts(alert_t: dict, auto_id: str, root_pk: str) -> list[tuple[str, dict]]:
    cm = _class_map(alert_t)
    out = []
    for pk, o in ontology._objects(alert_t["id"]).items():
        p = o.get("properties", {})
        if p.get(cm["timeseries:automation_rid"]) == AUTOMATION_RID + auto_id and str(p.get(cm["timeseries:root_object_pk"])) == root_pk:
            out.append((pk, p))
    return out


def _ms_of(v: Any) -> Optional[int]:
    try:
        return E.to_ms(v)
    except E.EngineError:
        return None


def evaluate(rec: dict, job: dict, trigger: str) -> dict:
    """Evaluate one automation for every root object in scope; writes alert objects, returns what happened."""
    c = rec["condition"]
    mode = c.get("mode") or "batch"
    cfg = job["config"][mode]
    st = job["state"].setdefault(rec["id"], {"watermarks": {}, "pending_effects": [], "last_effects_at": None, "version": rec.get("ts_version")})
    if st.get("version") != rec.get("ts_version"):
        st["version"] = rec.get("ts_version")
    alert_t = ontology._object_type(c["alert_object_type_id"])
    root_t = ontology._object_type(c["object_type_id"])
    cm = _class_map(alert_t)
    lookback = abs(E.duration_ms(cfg.get("default_lookback") or "1d"))
    lateness = int(cfg.get("allowed_lateness_s") or 0) * 1000 if mode == "streaming" else 0
    logic = c["logic"]
    search = next(x for x in logic["cards"] if x["id"] == logic["output"])
    min_d = abs(E.duration_ms(search["config"]["min_duration"])) if mode == "streaming" and (search.get("config") or {}).get("min_duration") else 0
    # batch alerting ignores minimum and maximum durations; streaming honours minimum durations
    run_logic = json.loads(json.dumps(logic))
    for x in run_logic["cards"]:
        if x["id"] == logic["output"]:
            x["config"] = {k: v for k, v in (x.get("config") or {}).items() if k not in ("max_duration", "min_duration", "start", "end")}
    out: dict[str, Any] = {"automation_id": rec["id"], "status": "succeeded", "objects": 0, "alerts_created": 0, "alerts_closed": 0,
                           "points_scanned": 0, "errors": [], "trigger": trigger}
    now = _now_ms()
    edits: list[dict] = []
    created: list[str] = []
    first_limit = (job["config"]["batch"].get("first_run_read_limit") if mode == "batch" else None)
    for pk in _roots(c):
        out["objects"] += 1
        wm = st["watermarks"].get(pk)
        start = None if wm is None else wm - lookback
        if wm is None and first_limit:
            # the first run reads at most the last N days of history (empty: the whole series)
            start = now - int(first_limit) * 86_400_000
        end = now - lateness if mode == "streaming" else None
        r = _Tracking(set(cfg.get("excluded_syncs") or []), mode == "streaming")
        try:
            items, scanned = E.evaluate_search(run_logic, r, {"object_type_id": root_t["id"], "primary_key": pk}, start, end)
        except E.EngineError as e:
            out["errors"].append({"primary_key": pk, "error": str(e)})
            continue
        out["points_scanned"] += scanned + r.extra_scanned
        existing = _existing_alerts(alert_t, rec["id"], pk)
        spans = [(apk, _ms_of(p.get(cm["timeseries:start_time"])), _ms_of(p.get(cm["timeseries:end_time"]))) for apk, p in existing]
        open_alerts = [(apk, a) for apk, a, b in spans if b is None and a is not None]
        closed = [(a, b) for _apk, a, b in spans if a is not None and b is not None]
        matched_open: set[str] = set()
        for iv in items:
            if min_d and iv["end"] is None and (r.max_t or now) - iv["start"] < min_d:
                continue
            # the tail read from (watermark - lookback) can cut an interval already alerted: the same event, not a new one
            if any(iv["start"] <= b and (iv["end"] is None or iv["end"] >= a) for a, b in closed):
                continue
            cont = next(((apk, a) for apk, a in open_alerts if apk not in matched_open and iv["start"] <= max(wm or a, a)
                         and (iv["end"] is None or iv["end"] >= a)), None)
            if cont:
                matched_open.add(cont[0])
                if iv["end"] is not None:
                    props = {cm["timeseries:end_time"]: _iso(iv["end"])}
                    if "timeseries:event_end_cause" in cm:
                        props[cm["timeseries:event_end_cause"]] = "RECOVERY_CONDITION_MET" if (search.get("config") or {}).get("recovery") else "CONDITION_CLEARED"
                    edits.append({"op": "modify", "object_type_id": alert_t["id"], "primary_key": cont[0], "properties": props})
                    out["alerts_closed"] += 1
                continue
            aid = hashlib.sha1(f"{rec['id']}|{pk}|{iv['start']}".encode()).hexdigest()[:20]
            props = {cm["timeseries:alert_event_id"]: aid, cm["timeseries:automation_rid"]: AUTOMATION_RID + rec["id"],
                     cm["timeseries:automation_version"]: int(rec.get("ts_version") or 1), cm["timeseries:root_object_pk"]: pk,
                     cm["timeseries:root_object_type_api_name"]: root_t["api_name"], cm["timeseries:start_time"]: _iso(iv["start"]),
                     cm["timeseries:end_time"]: _iso(iv["end"]), cm["timeseries:generation_time"]: _iso(now)}
            if "timeseries:event_start_cause" in cm:
                props[cm["timeseries:event_start_cause"]] = "CONDITION_MET"
                props[cm["timeseries:template_rid"]] = T.TEMPLATE_RID + rec["id"]
                props[cm["timeseries:template_version"]] = f"0.0.{int(rec.get('ts_version') or 1)}"
                if iv["end"] is not None:
                    props[cm["timeseries:event_end_cause"]] = "CONDITION_CLEARED"
            title_prop = alert_t["title_property"]
            if title_prop not in props and ontology._ptype(alert_t, title_prop) == "string":
                title = root_t["title_property"]
                root_obj = ontology._objects(root_t["id"]).get(pk, {}).get("properties", {})
                props[title_prop] = f"{rec['name']} · {root_obj.get(title) or pk}"
            edits.append({"op": "create", "object_type_id": alert_t["id"], "primary_key": aid, "properties": props})
            created.append(aid)
            closed.append((iv["start"], iv["end"] if iv["end"] is not None else iv["start"]))
        # an ongoing alert the (possibly changed) logic no longer finds: the object is normal again
        for apk, _a in open_alerts:
            if apk not in matched_open:
                props = {cm["timeseries:end_time"]: _iso(r.max_t or now)}
                if "timeseries:event_end_cause" in cm:
                    props[cm["timeseries:event_end_cause"]] = "LOGIC_CHANGED" if st.get("logic_hash") not in (None, rec.get("ts_logic_hash")) else "CONDITION_CLEARED"
                edits.append({"op": "modify", "object_type_id": alert_t["id"], "primary_key": apk, "properties": props})
                out["alerts_closed"] += 1
        if r.max_t is not None:
            st["watermarks"][pk] = max(wm or r.max_t, r.max_t)
    st["logic_hash"] = rec.get("ts_logic_hash")
    if edits:
        ontology.apply_edits(edits, source=rec["id"])
    out["alerts_created"] = len(created)
    if out["errors"]:
        out["status"] = "failed" if len(out["errors"]) == out["objects"] else "warning"
    timeseries.record_usage(f"automate:{rec['id']}", out["points_scanned"], queries=max(out["objects"], 1))
    # effects on new alerts, at most every evaluation_minutes
    if (rec.get("effect") or {}).get("kind") not in (None, "none"):
        st["pending_effects"] = [*st.get("pending_effects", []), *created]
        due = not c.get("evaluation_minutes") or not st.get("last_effects_at") or now - st["last_effects_at"] >= int(c["evaluation_minutes"]) * 60_000
        if due and st["pending_effects"]:
            for apk in st["pending_effects"]:
                ontology._execute(rec, apk, "time_series", 1)
            out["effects"] = len(st["pending_effects"])
            st["pending_effects"] = []
            st["last_effects_at"] = now
    if trigger == "manual" or created or out["alerts_closed"] or out["errors"]:
        ontology._record_run(rec["id"], {"id": ontology._new_id("run"), "at": ontology._now(), "trigger": f"time_series:{trigger}",
                                         "status": out["status"], "error": "; ".join(f"{e['primary_key']}: {e['error']}" for e in out["errors"][:3]) or None,
                                         "edits": len(edits), "alerts_created": out["alerts_created"], "alerts_closed": out["alerts_closed"],
                                         "objects": out["objects"], "points_scanned": out["points_scanned"]})
    return out


def _evaluate_as_owner(a: dict, job: dict, trigger: str) -> dict:
    """evaluate() as the automation's owner (Automate: "automation evaluation uses the permissions of the owner"): the
    root and alert object types are read with their markings and ontology roles. When it cannot run as the owner
    (none, deleted, deactivated, or the types are hidden from them) nothing is evaluated or written: a failed run with
    the reason, in the job's runs and the automation's."""
    import automate

    who = automate._owner(a)
    c = a.get("condition") or {}
    blocked = automate._owner_blocked(a, who, c.get("alert_object_type_id")) or automate._owner_blocked(a, who, c.get("object_type_id"))
    if blocked:
        err = f"did not run: {blocked}"
        automate._record_failed(a, f"time_series:{trigger}", err)
        return {"automation_id": a["id"], "status": "failed", "objects": 0, "alerts_created": 0, "alerts_closed": 0, "points_scanned": 0,
                "errors": [{"primary_key": "", "error": err}], "trigger": trigger}
    token = auth._principal.set(who) if who else None
    try:
        return evaluate(a, job, trigger)
    finally:
        if token is not None:
            auth._principal.reset(token)


def run_job(alert_type_id: str, trigger: str, only: Optional[str] = None) -> dict:
    """One evaluation run of a job: every enabled automation of the alert object type (or `only`)."""
    with _lock:
        if alert_type_id in _running:
            return {"status": "skipped", "reason": "the job is already running"}
        _running.add(alert_type_id)
    started = time.monotonic()
    try:
        job = _job(alert_type_id)
        autos = [a for a in _automations(alert_type_id, enabled_only=only is None) if not only or a["id"] == only]
        mode = (autos[0]["condition"].get("mode") if autos else None) or "batch"
        cfg = job["config"][mode]
        run: dict[str, Any] = {"at": ontology._now(), "trigger": trigger, "mode": mode, "status": "succeeded", "automations": {}}
        timeout = float(cfg.get("timeout_hours") or 1) * 3600
        for a in autos:
            if time.monotonic() - started > timeout:
                run["status"] = "failed"
                run["error"] = f"the job ran longer than its timeout ({cfg.get('timeout_hours') or 1} h)"
                break
            try:
                res = _evaluate_as_owner(a, job, trigger)
            except HTTPException as e:
                res = {"status": "failed", "errors": [{"primary_key": "", "error": str(e.detail)}]}
            except Exception as e:  # noqa: BLE001
                log.exception("time series alerting %s failed", a["id"])
                res = {"status": "failed", "errors": [{"primary_key": "", "error": str(e)[:300]}]}
            run["automations"][a["id"]] = {k: v for k, v in res.items() if k != "trigger"}
            if res["status"] == "failed" and cfg.get("fail_on_any"):
                run["status"] = "failed"
                run["error"] = f"{a['name']} failed (Fail job on any failure is on)"
                break
        if run["status"] == "succeeded" and any(r["status"] != "succeeded" for r in run["automations"].values()):
            run["status"] = "warning"
        run["ms"] = int((time.monotonic() - started) * 1000)
        job = {**_job(alert_type_id), "state": job["state"]}
        job["last_run_at"] = run["at"]
        job["inputs_seen"] = _inputs_mark(autos, cfg.get("excluded_syncs") or []) if autos else job.get("inputs_seen")
        quiet = not any((r.get("alerts_created") or r.get("alerts_closed") or r.get("errors")) for r in run["automations"].values())
        # streaming runs every few seconds: keep only the runs that did something, and a heartbeat every 10 minutes
        last = job["runs"][0] if job["runs"] else None
        if not (mode == "streaming" and quiet and last and last.get("mode") == "streaming" and trigger == "schedule"
                and (datetime.now(timezone.utc) - datetime.fromisoformat(last["at"])).total_seconds() < 600):
            job["runs"] = [run, *job["runs"]][:RUNS_KEPT]
        job["status"] = run["status"]
        _save_job(job)
        return run
    finally:
        with _lock:
            _running.discard(alert_type_id)


def _due(job: dict, autos: list[dict]) -> Optional[str]:
    mode = (autos[0]["condition"].get("mode") if autos else None) or "batch"
    cfg = job["config"][mode]
    last = datetime.fromisoformat(job["last_run_at"]) if job.get("last_run_at") else None
    age = (datetime.now(timezone.utc) - last).total_seconds() if last else None
    if mode == "streaming":
        return "schedule" if age is None or age >= max(5, int(cfg.get("every_s") or 10)) else None
    sched = cfg.get("schedule") or {"kind": "on_data"}
    if sched.get("kind") == "every":
        return "schedule" if age is None or age >= max(1, int(sched.get("minutes") or 60)) * 60 else None
    mark = _inputs_mark(autos, [])
    return "new_data" if mark != job.get("inputs_seen") else None


def _scheduler() -> None:
    while True:
        time.sleep(TICK)
        try:
            by_type: dict[str, list[dict]] = {}
            for a in ontology._all("automations"):
                c = a.get("condition") or {}
                if c.get("kind") == "time_series" and a.get("enabled") and c.get("alert_object_type_id"):
                    by_type.setdefault(c["alert_object_type_id"], []).append(a)
            for tid, autos in by_type.items():
                job = _job(tid)
                why = _due(job, autos)
                if why:
                    threading.Thread(target=_safe_run, args=(tid, why), daemon=True, name=f"ts-alert-{tid}").start()
        except Exception:  # noqa: BLE001
            log.exception("time series alerting scheduler failed")


def _safe_run(tid: str, why: str) -> None:
    try:
        run_job(tid, why)
    except Exception:  # noqa: BLE001
        log.exception("time series alerting job %s failed", tid)


def startup() -> None:
    threading.Thread(target=_scheduler, daemon=True, name="ts-alerting").start()


# ------------------------------------------------------------------------------------------------
# hooks and endpoints
# ------------------------------------------------------------------------------------------------


def _job_summary(alert_type_id: str) -> dict:
    j = _job(alert_type_id)
    return {"status": j.get("status"), "last_run_at": j.get("last_run_at"), "last_run": j["runs"][0] if j["runs"] else None}


def summary(rec: dict) -> dict:
    c = rec["condition"]
    tid = c.get("alert_object_type_id")
    j = _job(tid) if tid else None
    open_alerts = total = 0
    try:
        alert_t = ontology._object_type(tid)
        cm = _class_map(alert_t)
        for o in ontology._objects(tid).values():
            p = o.get("properties", {})
            if p.get(cm.get("timeseries:automation_rid", "")) == AUTOMATION_RID + rec["id"]:
                total += 1
                open_alerts += p.get(cm.get("timeseries:end_time", "")) in (None, "")
    except HTTPException:
        pass
    mine = [{"at": r["at"], "trigger": r["trigger"], "status": r["automations"][rec["id"]]["status"], **{k: v for k, v in r["automations"][rec["id"]].items() if k != "status"}}
            for r in (j["runs"] if j else []) if rec["id"] in r.get("automations", {})][:20]
    return {"mode": c.get("mode") or "batch", "version": rec.get("ts_version"), "alerts_open": open_alerts, "alerts_total": total,
            "job": {"alert_object_type_id": tid, "status": j.get("status") if j else None, "last_run_at": j.get("last_run_at") if j else None,
                    "config": j["config"][c.get("mode") or "batch"] if j else None},
            "evaluations": mine}


def run_now(rec: dict) -> dict:
    run = run_job(rec["condition"]["alert_object_type_id"], "manual", only=rec["id"])
    res = (run.get("automations") or {}).get(rec["id"]) or {}
    return {"id": ontology._new_id("run"), "at": run.get("at") or ontology._now(), "trigger": "manual", "status": res.get("status") or run.get("status"),
            "error": run.get("reason") or run.get("error") or ("; ".join(e["error"] for e in res.get("errors", [])[:3]) or None),
            "edits": (res.get("alerts_created") or 0) + (res.get("alerts_closed") or 0), **{k: v for k, v in res.items() if k not in ("status", "errors")}}


ontology.TS_HOOKS.update({"check": check, "summary": summary, "run": run_now})


@router.get("/jobs/{alert_type_id}")
def get_job(alert_type_id: str) -> dict:
    t = ontology._object_type(alert_type_id)
    j = _job(alert_type_id)
    autos = _automations(alert_type_id, enabled_only=False)
    return {**j, "alert_object_type": t["display_name"], "mode": (autos[0]["condition"].get("mode") if autos else None) or "batch",
            "automations": [{"id": a["id"], "name": a["name"], "enabled": a.get("enabled"), "mode": a["condition"].get("mode")} for a in autos],
            "input_syncs": sorted(set().union(*(_input_syncs(a["condition"]["object_type_id"]) for a in autos)) if autos else [])}


class JobConfigIn(BaseModel):
    batch: Optional[dict] = None
    streaming: Optional[dict] = None


@router.put("/jobs/{alert_type_id}/config")
def put_job_config(alert_type_id: str, req: JobConfigIn) -> dict:
    """Job-level configuration: applies to every automation writing to this alert object type."""
    ontology._object_type(alert_type_id)
    with _lock:
        j = _job(alert_type_id)
        for mode in ("batch", "streaming"):
            new = getattr(req, mode)
            if new is None:
                continue
            for k, v in new.items():
                if k not in DEFAULT_CONFIG[mode]:
                    raise HTTPException(400, f"unknown {mode} job setting {k}")
                if k == "default_lookback" and v:
                    try:
                        E.duration_ms(v)
                    except E.EngineError as e:
                        raise HTTPException(400, str(e)) from None
                j["config"][mode][k] = v
        _save_job(j)
    return get_job(alert_type_id)


@router.post("/jobs/{alert_type_id}/run")
def run_job_now(alert_type_id: str) -> dict:
    ontology._object_type(alert_type_id)
    return run_job(alert_type_id, "manual")


class LogicPreview(BaseModel):
    object_type_id: str
    primary_key: str
    logic: dict
    start: Optional[str] = None
    end: Optional[str] = None


@router.post("/preview")
def preview(req: LogicPreview) -> dict:
    """The logic editor's preview for one root object: every card, and the alerts the search would produce."""
    s, e = T._range(req.start, req.end)
    try:
        res = E.run(req.logic, T.Resolver(), {"object_type_id": req.object_type_id, "primary_key": req.primary_key}, s, e)
    except E.EngineError as ex:
        raise HTTPException(400, str(ex)) from None
    timeseries.record_usage("automate:preview", res["points_scanned"])
    return res

