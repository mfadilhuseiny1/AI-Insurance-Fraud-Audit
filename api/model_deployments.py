"""Model deployments that run: live deployments serving predictions and batch deployments writing datasets.

* A direct model deployment (one per model and branch) hosts the latest version on its branch and upgrades when a
  new version is published. A Modeling Objective live deployment hosts the objective's current staging or production
  release and upgrades when a new release is made. Each running deployment is one model_worker.py process holding the
  loaded model (models trained in transforms, externally hosted and container models alike); it starts on the first
  request after the API restarts ("scale from zero") and stops when the deployment is disabled.
* Queries: POST /api/model-deployments/<id>/query, and Foundry's REST endpoints under the environment URL
  `<host>/api`: POST /api/foundry-ml-live/api/inference/transform/<rid>/v2 (multi I/O: a named field per input, a named
  field per output) and .../<rid> (single I/O, Modeling Objective deployments only: requestData → responseData).
  Direct deployments cast inputs to the model API's types; 400 = the model failed or the request does not fit the
  API (the stack trace is in the body), 422 = malformed request, 503 = the deployment is not running.
* Model functions: a function (API name) published for a live deployment has the model's API, or one row in / one
  row out with row-wise processing for single tabular input / output models; POST /functions/<apiName>/execute, and
  the functions API gateway falls back to it (functions_registry.execute_query), so Python functions call it with
  FoundryClient().ontology.queries.<name>(...).
* Batch deployments (Modeling Objectives): the release's model runs over an input dataset into an output dataset;
  rebuilt when a new release is made, or on demand.
* Run history and logs per deployment (kept 7 days), request metrics, and for objective live deployments an optional
  model inference history dataset (timestamp, user_id, request_uuid, live_rid, objective_rid, model_rid,
  model_version_rid, input, output, error).

* Container-backed models: the worker starts the version's images as containers (ports, env, args, exec command and
  memory of the version; the deployment's env on top; live ones with docker's `--restart on-failure`). A monitor
  checks every running worker each MONITOR_S seconds (the process is alive; each container runs and its published
  ports answer), keeps the containers' state for the deployment page, collects their logs when the version has
  telemetry on, and after two failed checks replaces the worker (new containers, the old ones removed), backing off
  between attempts and giving up after MAX_RESTARTS. Stopping, deleting or upgrading a deployment removes its
  containers (also when the worker had to be killed).
* Batch deployments also rebuild when their input dataset updates (a new transaction, or new contents): the
  monitor compares the input's stamp with the one the last run read.
* A batch run reads and writes as a user, never as the system (run_as.py): "Build now" as the user who clicked it,
  every other run (created, new release, input updated) as the deployment's owner (who created it, or last enabled
  it or saved its triggers). Before anything is read the user is checked: active, the viewer role on the objective
  and the model, read access to the input dataset (its markings and Project role) and the editor role on the output
  folder (and the output dataset). A user who lost access fails the run with "did not run: <reason>"; nothing is
  read or written. Sign-in off: runs as before.
* Who may do what on a deployment (_can; sign-in on): a direct deployment follows its model (markings and Project role
  on the model's Files item), an objective one its Modeling Objective (grants, Project role, the markings of its
  Project; a live one also the markings of the release's model). Viewer: see it, logs / runs / traces, query it
  (the /v2 and single I/O endpoints too) and call its model function; editor: configure, scale, enable / disable,
  publish its function, sync its inference history; owner: delete it and set up / switch / remove its model
  inference history (Foundry's edit-inference-ledger, "typically granted with the owner role on a modeling
  objective"). The inference history is written as its owner (who set it up or last switched recording on), never
  as the system: an owner without the editor role on the history dataset (or deactivated) writes nothing, the
  reason is kept on the history and logged, the requests stay recorded until access is back.

* Replicas: a running live deployment is a set of replicas, each its own worker process (and, for a container model,
  its own containers, labelled bluesandai.deployment=<id> and bluesandai.replica=<n>). Requests go round-robin to
  the replicas (an idle one first, not one that failed its last health check while others pass); a replica whose process stops while answering is dropped and the request is
  retried on another. The monitor checks every replica: a failing one is replaced on its own while the others keep
  serving; only when every replica fails does the whole deployment restart (with the back-off above).
* Scaling: between max(1, min_replicas) and max_replicas. With max above min the monitor autoscales on the average
  number of requests in flight (load per replica at 75% of target_in_flight or more: one more replica; the load
  fitting under 50% on one replica less: one fewer) or on the p95 latency (above target_p95_ms: one more; under
  half of it: one fewer), measured over scale_window_s since the last change, one step at a time, no change within
  cooldown_s of the last one (and no scale-down before a full window). min_replicas 0: the deployment stops after
  idle_s without a request and starts again on the next one. The window and the cool-down count from the moment
  the replicas changed (a started replica is ready). A settings change brings the count into the new range at once;
  load-based steps are the monitor's (every MONITOR_S), or evaluate_scaling() / POST …/scaling/evaluate. A replica
  being started or stopped is not in the set requests go to (status: replicas with state starting / stopping).
  The autoscaler's time is `_clock` (replaceable in tests; `evaluate_scaling(dep_id, now)` decides at a given time).
* Limits: a container model's containers run with `--cpus` = the deployment's vCPUs per replica (capped at the
  docker host's CPUs) and `--memory` = its memory per replica, unless an image of the version sets a lower memory
  limit of its own (the lower applies). Replicas of Python models are plain processes: their vCPUs / memory are
  kept for the record, not enforced.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import auth
import model_assets
import model_worker

router = APIRouter(prefix="/api/model-deployments", tags=["model-deployments"])
live_router = APIRouter(prefix="/api/foundry-ml-live/api/inference/transform", tags=["model-deployments"])
DIR = Path("data/model-deployments")
LIVE_RID = "ri.foundry-ml-live.main.live-deployment."
KEEP_DAYS = 7
MAX_RUNS = 5000
_lock = threading.RLock()
# running deployments: deployment id -> the replica set {"replicas": [replica…], "version_id", "version", "version_rid",
# "model_rid", "started_at", "api", "dep_id", "scale", …}; "client" / "spec" are the first replica's. A replica is
# {"client", "spec", "index", "started_at", "strikes", "in_flight", "requests", "errors", "containers", …}.
WORKERS: dict[str, dict] = {}
_start_locks: dict[str, threading.Lock] = {}
# replica lists, round-robin pointers and request accounting
_lb_lock = threading.Lock()
# the health monitor: seconds between checks, failed checks before a restart, restart attempts before giving up
MONITOR_S = float(os.environ.get("BLUESANDAI_DEPLOY_MONITOR_S") or 15)
STRIKES = 2
MAX_RESTARTS = 6
# what the autoscaler keeps of past requests (seconds)
KEEP_LOAD_S = 3600
# autoscaling thresholds (fractions of the target)
SCALE_UP_AT = 0.75
SCALE_DOWN_UNDER = 0.5
# deployments being restarted: id -> {"attempts", "next_at" (monotonic), "reason"}
_recover: dict[str, dict] = {}
_monitor: dict = {}
# the clock of the load balancer and the autoscaler (request times, load windows, cool-down, idle time): monotonic
# seconds. A test replaces it (model_deployments._clock = fake) to move time without sleeping.
_clock = time.monotonic


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "model-deployments"
    DIR.mkdir(parents=True, exist_ok=True)
    ensure_monitor()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


def _path(dep_id: str) -> Path:
    if not re.fullmatch(r"dep-[0-9a-f]{12}", dep_id):
        raise HTTPException(404, "deployment not found")
    return DIR / f"{dep_id}.json"


def _read(dep_id: str) -> dict:
    p = _path(dep_id)
    if not p.exists():
        raise HTTPException(404, "deployment not found")
    return json.loads(p.read_text("utf-8"))


def _write(rec: dict) -> dict:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = _path(rec["id"]).with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rec, indent=1, default=str), "utf-8")
    os.replace(tmp, _path(rec["id"]))
    return rec


def _all() -> list[dict]:
    return [json.loads(p.read_text("utf-8")) for p in sorted(DIR.glob("dep-*.json"))]


def _by_rid(rid: str) -> dict:
    rid = str(rid or "")
    if rid.startswith("ri.foundry-ml-live.") and not rid.startswith(LIVE_RID):
        rid = LIVE_RID + rid.rsplit(".", 1)[-1]
    rec = next((d for d in _all() if d["rid"] == rid), None)
    if not rec:
        raise HTTPException(404, f"no live deployment {rid}")
    return rec


# ------------------------------------------------------------------------------------------------
# what a deployment serves
# ------------------------------------------------------------------------------------------------


def _target(dep: dict) -> tuple[dict, dict]:
    """(model, version) the deployment should serve now: a direct deployment the latest version on its branch, an
    objective deployment the objective's release in its environment."""
    if dep["kind"] == "direct":
        rec, _ = model_assets._get(dep["model_id"])
        try:
            return rec, _latest(rec, dep.get("branch"))
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
    import modeling_objectives

    model_id, version_id = modeling_objectives.release_target(dep["objective_id"], dep["environment"])
    rec, _ = model_assets._get(model_id)
    return rec, model_assets._version(rec, version_id)


def _latest(rec: dict, branch: Optional[str]) -> dict:
    if rec.get("kind", "container") == "container":
        return model_assets._version(rec, None)
    return model_assets._pick_version(rec, None, branch)


def _spec(rec: dict, v: dict, dep_id: str, dep: Optional[dict] = None, replica: Optional[int] = None) -> dict:
    """What model_worker runs. `dep_id` names the containers' label (a deployment id, or "batch-…" / "eval-…");
    `dep` given (a live deployment): its env goes on top of the version's, docker restarts a crashed container, the
    containers get the deployment's vCPUs (`--cpus`) and are labelled with the deployment and the replica."""
    if rec.get("kind", "container") == "container":
        label = f"live-{dep_id[4:]}" if dep_id.startswith("dep-") else dep_id
        if replica:
            label += f"-r{replica}"
        try:
            spec = {**model_assets.resolve(rec["rid"], v["id"], label), "kind": "container", "api": v.get("api") or {}}
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        cfg = (dep or {}).get("config") or {}
        env = cfg.get("env") or {}
        live: list[str] = []
        if dep and dep["kind"] != "batch":
            live = ["--restart", "on-failure:3", "--label", f"bluesandai.deployment={dep['id']}"]
            if replica:
                live += ["--label", f"bluesandai.replica={replica}"]
            cpus = _cpus(cfg.get("cpu"))
            if cpus:
                live += ["--cpus", cpus]
        for c in spec["containers"]:
            c["run_args"] = [*c.get("run_args", []), *[a for k, val in env.items() for a in ("-e", f"{k}={val}")], *live]
            if dep and dep["kind"] != "batch":
                c["run_args"] = _with_memory(c["run_args"], cfg.get("memory_gb"))
        return spec
    return model_assets.python_spec(rec, v)


_host: dict = {}


def _host_cpus() -> Optional[int]:
    """The docker host's CPU count (docker refuses `--cpus` above it); None when the runtime does not say."""
    if "cpus" not in _host:
        try:
            import container_runtime

            p = container_runtime.docker("info", "--format", "{{.NCPU}}", check=False, timeout=60)
            n = int(p.stdout.decode(errors="replace").strip()) if p.returncode == 0 else 0
        except Exception:  # noqa: BLE001 - no runtime, or it did not answer: no cap known (asked again next time)
            return None
        if n <= 0:
            return None
        _host["cpus"] = n
    return _host["cpus"]


def _cpus(cpu: Any) -> Optional[str]:
    """`--cpus` for a deployment's vCPU setting, capped at the docker host's CPUs."""
    try:
        n = float(cpu)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    host = _host_cpus()
    if host:
        n = min(n, float(host))
    return f"{max(n, 0.01):g}"


_MEM_UNIT = {"": 1, "b": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}
# docker refuses a memory limit under 6 MB
MIN_MEMORY_BYTES = 6 * 1024 ** 2


def _mem_bytes(text: Any) -> Optional[int]:
    """A docker memory value ("512m", "2g", bytes) in bytes; None when it is not one."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([bkmg]?)", str(text or "").strip().lower())
    return int(float(m.group(1)) * _MEM_UNIT[m.group(2)]) if m else None


def _with_memory(run_args: list[str], memory_gb: Any) -> list[str]:
    """docker run arguments with the deployment's memory per replica as `--memory` (bytes). An image of the version
    that sets its own memory limit keeps it when it is the tighter one: the lower of the two applies."""
    try:
        want = int(float(memory_gb) * 1024 ** 3)
    except (TypeError, ValueError):
        return run_args
    if want <= 0:
        return run_args
    want = max(want, MIN_MEMORY_BYTES)
    out = list(run_args)
    at = [i for i, a in enumerate(out[:-1]) if a == "--memory"]
    own = _mem_bytes(out[at[-1] + 1]) if at else None
    if own is not None and own <= want:
        return out
    for i in reversed(at):
        del out[i:i + 2]
    return [*out, "--memory", str(want)]


def _container(w: Optional[dict]) -> bool:
    return bool(w and (w.get("spec") or {}).get("kind") == "container")


def _sync(g: dict) -> None:
    """The replica set's "client" / "spec": its first replica's (for callers that know one worker)."""
    if g["replicas"]:
        g["client"], g["spec"] = g["replicas"][0]["client"], g["replicas"][0]["spec"]


def _alive(g: Optional[dict]) -> bool:
    return bool(g and any(r["client"].alive for r in g.get("replicas") or []))


def _mark(g: dict, index: Any, state: Optional[str]) -> None:
    """A replica that is starting or stopping (not in the set requests are routed to), for the deployment's status;
    state None: done."""
    with _lb_lock:
        p = g.setdefault("pending", {})
        if state:
            p[index] = {"state": state, "at": _now()}
        else:
            p.pop(index, None)


def _retire(g: dict, r: dict) -> None:
    """Stop a replica that already left its set (no request is routed to it any more); shown as stopping meanwhile."""
    _mark(g, r.get("index"), "stopping")
    try:
        _close_replica(r)
    finally:
        _mark(g, r.get("index"), None)


def _close_replica(r: dict) -> None:
    """Stop one replica's worker; a container model's containers are removed even when the worker had to be killed."""
    try:
        r["client"].close()
    finally:
        if _container(r):
            import model_container

            n = model_container.remove_leftovers(r["spec"])
            if n and r.get("dep_id"):
                _log(r["dep_id"], "WARN", f"removed {n} container(s) the stopped worker left running"
                     + (f" (replica {r['index']})" if r.get("index") else ""))


def _close_worker(w: dict) -> None:
    """Stop every replica of a replica set (in parallel); their containers are gone when this returns."""
    if "replicas" not in w:
        _close_replica(w)
        return
    with _lb_lock:
        reps = list(w["replicas"])
    if len(reps) == 1:
        _close_replica(reps[0])
        return
    ts = [threading.Thread(target=_close_replica, args=(r,), daemon=True) for r in reps]
    for t in ts:
        t.start()
    for t in ts:
        t.join(180)


def _log(dep_id: str, level: str, message: str, **extra: Any) -> None:
    d = DIR / dep_id
    d.mkdir(parents=True, exist_ok=True)
    with _lock, open(d / "logs.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "level": level, "message": message[:4000], **extra}) + "\n")


def _tail(p: Path, n: int) -> list[dict]:
    if not p.exists():
        return []
    out = []
    for line in p.read_text("utf-8").splitlines()[-n:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def _trim(p: Path) -> None:
    """Keep 7 days (and at most MAX_RUNS lines)."""
    if not p.exists() or p.stat().st_size < 512_000:
        return
    cut = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    lines = [line for line in p.read_text("utf-8").splitlines() if json.loads(line).get("at", "") >= cut][-MAX_RUNS:]
    p.write_text("\n".join(lines) + ("\n" if lines else ""), "utf-8")


def _take_worker(dep_id: str) -> Optional[dict]:
    with _lock:
        _recover.pop(dep_id, None)
        return WORKERS.pop(dep_id, None)


def _stop_worker(dep_id: str, wait: bool = False) -> None:
    w = _take_worker(dep_id)
    if w:
        if wait:
            _close_worker(w)
        else:
            threading.Thread(target=_close_worker, args=(w,), daemon=True).start()


def _bounds(dep: dict) -> tuple[int, int]:
    """The replica range of a running deployment: (max(1, min_replicas), max_replicas)."""
    cfg = dep.get("config") or {}
    lo = max(1, int(cfg.get("min_replicas") if cfg.get("min_replicas") is not None else 1))
    return lo, max(lo, int(cfg.get("max_replicas") or 1))


def _start_replica(dep: dict, rec: dict, v: dict, index: int, quiet_spec_error: bool = False) -> dict:
    """One replica: a worker process (and a container model's containers). HTTPException 503 when it does not start."""
    tag = f" (replica {index})"
    try:
        spec = _spec(rec, v, dep["id"], dep, index)
    except HTTPException as e:
        if not quiet_spec_error:
            _log(dep["id"], "ERROR", f"the model cannot run: {e.detail}")
        raise HTTPException(503, f"the deployment could not start: {e.detail}") from None
    started = time.monotonic()
    try:
        client = model_worker.Client(spec, on_stderr=lambda line, d=dep["id"], i=index: _log(d, "STDERR", line.rstrip(), replica=i))
    except model_worker.WorkerError as e:
        _log(dep["id"], "ERROR", f"the model did not load{tag}: {e}", traceback=(e.detail or {}).get("traceback"), replica=index)
        if spec.get("kind") == "container":
            import model_container

            model_container.remove_leftovers(spec)
        raise HTTPException(503, f"the deployment could not start: {e}") from None
    if client.load_logs:
        _log(dep["id"], "INFO", client.load_logs, replica=index)
    _log(dep["id"], "INFO", f"ready in {time.monotonic() - started:.1f} s{tag}", replica=index)
    r = {"client": client, "spec": spec, "index": index, "started_at": _now(), "dep_id": dep["id"], "logs_since": time.time(),
         "strikes": 0, "in_flight": 0, "requests": 0, "errors": 0}
    if spec.get("kind") == "container":
        _check_containers(r)
    return r


def _start_replicas(dep: dict, rec: dict, v: dict, indexes: list[int]) -> tuple[list[dict], list[HTTPException]]:
    """Start replicas in parallel: (the ones that run, the errors of the others)."""
    out: list = [None] * len(indexes)

    def go(k: int) -> None:
        try:
            out[k] = _start_replica(dep, rec, v, indexes[k], quiet_spec_error=k > 0)
        except HTTPException as e:
            out[k] = e
        except Exception as e:  # noqa: BLE001
            out[k] = HTTPException(503, f"the deployment could not start: {type(e).__name__}: {e}")

    if len(indexes) == 1:
        go(0)
    else:
        ts = [threading.Thread(target=go, args=(k,), daemon=True) for k in range(len(indexes))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    return [r for r in out if isinstance(r, dict)], [e for e in out if isinstance(e, HTTPException)]


def _worker(dep: dict) -> dict:
    """The running replica set of a deployment, started (or replaced after an upgrade) when needed."""
    if dep.get("status") != "running":
        raise HTTPException(503, f"the deployment {dep['name']} is disabled")
    rec, v = _target(dep)
    w = WORKERS.get(dep["id"])
    if w and w["version_id"] == v["id"] and _alive(w):
        return w
    lock = _start_locks.setdefault(dep["id"], threading.Lock())
    with lock:
        w = WORKERS.get(dep["id"])
        if w and w["version_id"] == v["id"] and _alive(w):
            return w
        was = w and w["version"]
        lo, hi = _bounds(dep)
        # an upgrade keeps the current scale
        n = min(hi, max(lo, int(((w or {}).get("scale") or {}).get("desired") or lo)))
        container = rec.get("kind", "container") == "container"
        _log(dep["id"], "INFO", f"starting {rec['name']} {v['version']} ({v['rid']})" + (f" on {n} replicas" if n > 1 else "") + (f", replacing {was}" if was else "")
             + (": " + ", ".join(f"{im['image']}:{im['tag']} (ports {', '.join(map(str, im.get('ports') or [])) or 'none'})" for im in v.get("images") or []) if container else ""))
        reps, errs = _start_replicas(dep, rec, v, list(range(1, n + 1)))
        if not reps:
            _note(dep["id"], health="failed", error=str(errs[0].detail)[:2000])
            raise errs[0]
        if errs:
            _log(dep["id"], "WARN", f"{len(errs)} of {n} replicas did not start (the monitor tries again): {errs[0].detail}")
        client = reps[0]["client"]
        if not v.get("api") and client.api:
            # container versions do not record their API: the loaded adapter tells it
            v["api"] = client.api
            model_assets.record_api(rec["id"], v["id"], client.api)
        now = _clock()
        new = {"replicas": reps, "pending": {}, "version_id": v["id"], "version": v["version"], "version_rid": v["rid"], "model_rid": rec["rid"],
               "started_at": _now(), "api": v.get("api") or {}, "dep_id": dep["id"], "next_index": n + 1, "rr": 0,
               "busy": deque(), "active": {}, "lat": deque(), "last_request": now, "scale": {"desired": n, "last_change": now},
               "reconcile_lock": threading.Lock()}
        _sync(new)
        with _lock:
            # disabled or deleted while it started (stop / delete take the worker under the same lock): not kept
            try:
                cancelled = _read(dep["id"]).get("status") != "running"
            except HTTPException:
                cancelled = True
            if not cancelled:
                WORKERS[dep["id"]] = new
        if cancelled:
            _log(dep["id"], "INFO", "disabled while starting: stopping the new worker" + (" and its containers" if _container(new) else ""))
            _close_worker(new)
            raise HTTPException(503, f"the deployment {dep['name']} was disabled while it started")
        if w:
            _log(dep["id"], "INFO", f"stopping {w['version']}" + (" and its containers" if _container(w) else ""))
            threading.Thread(target=_close_worker, args=(w,), daemon=True).start()
        _note(dep["id"], health="healthy", error=None, version_id=v["id"], version=v["version"], upgraded=was, replicas_desired=n)
        ensure_monitor()
        return new


def _note(dep_id: str, upgraded: Optional[str] = None, **changes: Any) -> None:
    with _lock:
        try:
            dep = _read(dep_id)
        except HTTPException:
            return
        if changes.get("version_id") and changes["version_id"] != dep.get("version_id"):
            dep.setdefault("history", []).append({"at": _now(), "version": changes.get("version"), "from": dep.get("version"), "by": _me()})
            dep["history"] = dep["history"][-100:]
        dep.update(changes)
        _write(dep)


def on_new_version(rec: dict, v: dict) -> None:
    """model_assets: a version was published. Running direct deployments on that branch upgrade (no downtime: the new
    worker replaces the old one once it has loaded). A container model's versions have no branch: every direct
    deployment of the model serves its latest version (_latest), so all of them upgrade."""
    container = rec.get("kind", "container") == "container"
    for dep in _all():
        if dep["kind"] == "direct" and dep["model_id"] == rec["id"] and dep.get("status") == "running" and (
                container or (dep.get("branch") or "master") == (v.get("branch") or "master")):
            threading.Thread(target=_safe_start, args=(dep,), daemon=True).start()


def on_release(objective_id: str, environment: str) -> None:
    """modeling_objectives: a new release in an environment. Its live deployments upgrade, its batch deployments rebuild."""
    for dep in _all():
        if dep.get("objective_id") == objective_id and dep.get("environment") == environment and dep.get("status") == "running":
            if dep["kind"] == "objective":
                threading.Thread(target=_safe_start, args=(dep,), daemon=True).start()
            elif dep["kind"] == "batch":
                threading.Thread(target=_run_batch, args=(dep["id"], "release"), daemon=True).start()


def _safe_start(dep: dict) -> None:
    try:
        _worker(dep)
    except HTTPException:
        pass


# ------------------------------------------------------------------------------------------------
# the health monitor: live workers and their containers, batch inputs
# ------------------------------------------------------------------------------------------------


def ensure_monitor() -> None:
    """Start the monitor thread once per process (BLUESANDAI_DEPLOY_MONITOR=off: never; tests call monitor_once)."""
    if (os.environ.get("BLUESANDAI_DEPLOY_MONITOR") or "").lower() in ("off", "0", "false"):
        return
    with _lock:
        t = _monitor.get("thread")
        if t and t.is_alive():
            return
        t = threading.Thread(target=_monitor_loop, name="model-deployments-monitor", daemon=True)
        _monitor["thread"] = t
        t.start()


def _monitor_loop() -> None:
    time.sleep(MONITOR_S)
    while True:
        try:
            monitor_once()
        except Exception as e:  # noqa: BLE001 - the monitor keeps running
            _monitor["error"] = f"{type(e).__name__}: {e}"
        time.sleep(MONITOR_S)


def _check_containers(w: dict) -> list[str]:
    """Refresh a container worker's view of its containers; the problems found."""
    import model_container

    spec = w["spec"]
    try:
        states = model_container.container_states(spec)
    except Exception as e:  # noqa: BLE001 - the runtime did not answer: not the model's fault, checked again later
        w["containers_error"] = str(e)[:500]
        return []
    w["containers"], w["checked_at"] = states, _now()
    w.pop("containers_error", None)
    problems = []
    for c in spec["containers"]:
        mine = [s for s in states if s["image"] == c["image"]]
        if not mine:
            problems.append(f"the container of {c['image']} is gone")
        for s in mine:
            if not s["running"]:
                problems.append(f"the container of {c['image']} is {s['state']} (exit code {s['exit_code']})")
            elif not s["ready"]:
                problems.append(f"the container of {c['image']} does not answer on port " + ", ".join(p for p, ok_ in s["answering"].items() if not ok_))
    return problems


def _pull_container_logs(dep_id: str, w: dict) -> None:
    """Telemetry on: the containers' stdout / stderr since the last check go to the deployment's logs."""
    import model_container

    since, now = w.get("logs_since") or time.time(), time.time()
    for s in w.get("containers") or []:
        try:
            text = model_container.container_logs(w["spec"], s["name"], since - 1)
        except Exception:  # noqa: BLE001
            continue
        seen = w.setdefault("log_seen", set())
        for line in text.splitlines():
            if line.strip() and line not in seen:
                seen.add(line)
                _log(dep_id, "CONTAINER", line, container=s["image"], **({"replica": w["index"]} if w.get("index") else {}))
        if len(seen) > 5000:
            w["log_seen"] = set(list(seen)[-2000:])
    w["logs_since"] = now


def _check_replica(dep_id: str, r: dict) -> Optional[str]:
    """One replica's health: None when healthy, else what is wrong."""
    if not r["client"].alive:
        return "the model process stopped" + (": " + "".join(r["client"].stderr_tail[-5:]).strip()[-500:] if r["client"].stderr_tail else "")
    if _container(r):
        problems = _check_containers(r)
        if r["spec"].get("telemetry"):
            _pull_container_logs(dep_id, r)
        return "; ".join(problems) or None
    return None


def _check_live(dep_id: str, g: dict) -> Optional[str]:
    """One check of a running deployment's replicas: None when all are healthy, else what is wrong. A replica is
    replaced after STRIKES failed checks in a row (at once when its process is gone) while the others keep serving;
    when every replica is to be replaced the whole deployment restarts (with back-off)."""
    try:
        dep = _read(dep_id)
    except HTTPException:
        _stop_worker(dep_id)
        return None
    if dep.get("status") != "running":
        _stop_worker(dep_id)
        return None
    with _lb_lock:
        reps = list(g["replicas"])
    found = []
    for r in reps:
        p = _check_replica(dep_id, r)
        if not p:
            r["strikes"] = 0
            continue
        r["strikes"] = r.get("strikes", 0) + 1
        p = (f"replica {r['index']}: " if len(reps) > 1 else "") + p
        _log(dep_id, "WARN", f"health check failed ({r['strikes']}/{STRIKES}): {p}", replica=r.get("index"))
        found.append((r, p, not r["client"].alive or r["strikes"] >= STRIKES))
    if not found:
        if dep.get("health") not in ("healthy", None):
            _note(dep_id, health="healthy", error=None)
        return None
    problem = "; ".join(p for _, p, _ in found)
    bad = [(r, p) for r, p, b in found if b]
    if bad and len(bad) == len(reps):
        _begin_recovery(dep_id, problem, g)
    elif bad:
        _note(dep_id, health="degraded", error=problem[:2000])
        for r, p in bad:
            _replace_replica(dep_id, g, r, p)
    return problem


def _drop_replica(dep_id: str, g: dict, r: dict, reason: str) -> None:
    """A replica whose process stopped while answering: out of the set (closed in the background); with none left
    the deployment stops (the next request starts it, the monitor has nothing to restart)."""
    with _lb_lock:
        had = any(x is r for x in g["replicas"])
        g["replicas"] = [x for x in g["replicas"] if x is not r]
        _sync(g)
        empty = not g["replicas"]
    if had:
        _log(dep_id, "WARN", f"replica {r.get('index')} stopped: {reason[:500]}" + ("" if empty else " (the other replicas serve; the monitor starts a replacement)"),
             replica=r.get("index"))
        threading.Thread(target=_retire, args=(g, r), daemon=True).start()
    if empty and WORKERS.get(dep_id) is g:
        _stop_worker(dep_id)


def _replace_replica(dep_id: str, g: dict, r: dict, reason: str) -> bool:
    """Replace one failing replica of a set that still has healthy ones: the old one is stopped (its containers
    removed), a new one started on the same version. False when the new one did not start (the monitor's
    reconciliation tries again)."""
    with _lb_lock:
        g["replicas"] = [x for x in g["replicas"] if x is not r]
        _sync(g)
        index = g["next_index"]
        g["next_index"] += 1
    _log(dep_id, "WARN", f"replacing replica {r.get('index')}: {reason[:500]}", replica=r.get("index"))
    _retire(g, r)
    try:
        dep = _read(dep_id)
        rec, v = _target(dep)
    except HTTPException:
        return False
    if v["id"] != g["version_id"] or dep.get("status") != "running":
        return False  # an upgrade or a stop replaces the whole set
    _mark(g, index, "starting")
    try:
        new = _start_replica(dep, rec, v, index)
    except HTTPException as e:
        _log(dep_id, "WARN", f"the replacement of replica {r.get('index')} did not start (tried again at the next check): {e.detail}")
        return False
    finally:
        _mark(g, index, None)
    if not _adopt(dep_id, g, new):
        return False
    _log(dep_id, "INFO", f"replica {r.get('index')} replaced by replica {index}", replica=index)
    with _lock:
        try:
            cur = _read(dep_id)
        except HTTPException:
            return True
        _note(dep_id, replica_replacements=int(cur.get("replica_replacements") or 0) + 1, last_replacement_at=_now(), last_replacement_reason=reason[:500])
    return True


def _adopt(dep_id: str, g: dict, new: dict) -> bool:
    """Add a started replica to its set, unless the set was replaced or stopped meanwhile (then it is closed)."""
    with _lock:
        keep = WORKERS.get(dep_id) is g
        if keep:
            with _lb_lock:
                g["replicas"].append(new)
                _sync(g)
    if not keep:
        _close_replica(new)
    return keep


# ------------------------------------------------------------------------------------------------
# scaling: the replica count follows the load (min / max replicas), idle deployments stop (min 0)
# ------------------------------------------------------------------------------------------------


def _end(g: dict, r: dict, token: str, failed: bool) -> None:
    """A request picked by _pick ended: out of flight, its busy time and latency kept for the autoscaler."""
    t = _clock()
    with _lb_lock:
        t0 = g["active"].pop(token, t)
        r["in_flight"] = max(0, r["in_flight"] - 1)
        r["requests"] += 1
        r["errors"] += int(failed)
        g["busy"].append((t0, t))
        g["lat"].append((t, (t - t0) * 1000))
        g["last_request"] = t
        while g["busy"] and g["busy"][0][1] < t - KEEP_LOAD_S:
            g["busy"].popleft()
        while g["lat"] and g["lat"][0][0] < t - KEEP_LOAD_S:
            g["lat"].popleft()


def _pick(g: dict, tried: set) -> Optional[tuple[dict, str]]:
    """The replica for the next request: round-robin over the running replicas not tried yet, an idle one first;
    replicas that failed their last health check only when no other is left. It is counted in flight here, under
    the same lock as the choice: (replica, token for _end)."""
    with _lb_lock:
        reps = [r for r in g["replicas"] if r["index"] not in tried and r["client"].alive]
        if not reps:
            return None
        reps = [r for r in reps if not r.get("strikes")] or reps
        k = g["rr"] % len(reps)
        g["rr"] += 1
        order = reps[k:] + reps[:k]
        r = next((x for x in order if x["in_flight"] == 0), order[0])
        r["in_flight"] += 1
        token = uuid.uuid4().hex
        g["active"][token] = g["last_request"] = _clock()
        return r, token


def _load(g: dict, now: float, window: float) -> float:
    """The average number of requests in flight over the last `window` seconds (busy time / window), the requests
    still running included."""
    lo = now - window
    with _lb_lock:
        busy = sum(min(e, now) - max(s, lo) for s, e in g["busy"] if e > lo)
        busy += sum(now - max(s, lo) for s in g["active"].values())
    return busy / window if window > 0 else 0.0


def _p95(g: dict, now: float, window: float) -> Optional[float]:
    with _lb_lock:
        ms = sorted(m for t, m in g["lat"] if t >= now - window)
    return round(ms[min(len(ms) - 1, int(len(ms) * 0.95))], 1) if ms else None


def _autoscale(dep: dict, g: dict, now: Optional[float] = None, load_based: bool = True) -> Optional[dict]:
    """The replica count the deployment should have now (g["scale"]["desired"]): one step up or down when the load
    says so, outside the cool-down. Returns the scaling event, if any. `now` is a time of _clock (a test passes the
    moment to decide at); load_based False: only bring the count into the configured range (a settings change)."""
    now = _clock() if now is None else now
    cfg = dep.get("config") or {}
    lo, hi = _bounds(dep)
    s = g["scale"]
    cur = s["desired"]
    new, why = cur, ""
    if not lo <= cur <= hi:
        new, why = min(hi, max(lo, cur)), f"the replica range is now {lo}–{hi}"
    elif hi > lo and load_based:
        window = float(cfg.get("scale_window_s") or 60)
        cooldown = float(cfg.get("cooldown_s") if cfg.get("cooldown_s") is not None else 120)
        since = now - s["last_change"]
        if since < max(cooldown, min(window, 10.0)):
            return None
        span = min(window, since)  # measured since the last change: the load the current replicas carried
        load = _load(g, now, span)
        p95 = _p95(g, now, span)
        s.update(load=round(load, 3), p95_ms=p95, measured_s=round(span, 1))
        if (cfg.get("scale_metric") or "in_flight") == "p95_latency":
            target = float(cfg.get("target_p95_ms") or 1000)
            if p95 is not None and p95 > target and cur < hi:
                new, why = cur + 1, f"p95 latency {p95:g} ms above the {target:g} ms target"
            elif (p95 is None or p95 < target * SCALE_DOWN_UNDER) and cur > lo and since >= window:
                new, why = cur - 1, ("no requests" if p95 is None else f"p95 latency {p95:g} ms under half of the {target:g} ms target")
        else:
            target = float(cfg.get("target_in_flight") or 1)
            if load / (target * cur) >= SCALE_UP_AT and cur < hi:
                new, why = cur + 1, f"{load / cur:.2f} requests in flight per replica, {SCALE_UP_AT:.0%} or more of the target {target:g}"
            elif cur > lo and since >= window and load / (target * (cur - 1)) < SCALE_DOWN_UNDER:
                new, why = cur - 1, f"{load:.2f} requests in flight fit on {cur - 1} replica(s) under {SCALE_DOWN_UNDER:.0%} of the target {target:g}"
    if new == cur:
        return None
    s.update(desired=new, last_change=now)
    ev = {"at": _now(), "from": cur, "to": new, "reason": why}
    _log(dep["id"], "INFO", f"scaling {cur} → {new} replicas: {why}")
    with _lock:
        try:
            d = _read(dep["id"])
        except HTTPException:
            return ev
        _note(dep["id"], replicas_desired=new, scaling=[ev, *(d.get("scaling") or [])][:20])
    return ev


def _reconcile(dep_id: str, g: dict, now: Optional[float] = None, load_based: bool = True, wait: bool = False) -> Optional[dict]:
    """Bring the replica set to the count the autoscaler wants (start missing replicas, stop idle extra ones); stop
    the deployment after idle_s without a request when min_replicas is 0. Returns what changed. One at a time per
    replica set (a config change and the monitor can both ask): a second caller gets None, or waits with `wait`."""
    if not g["reconcile_lock"].acquire(blocking=wait):
        return None
    try:
        return _reconcile_now(dep_id, g, now, load_based)
    finally:
        g["reconcile_lock"].release()


def evaluate_scaling(dep_id: str, now: Optional[float] = None) -> Optional[dict]:
    """Evaluate a running deployment's scaling now instead of at the monitor's next check: the autoscaler decides
    (at `now`, a time of _clock; default the present) and the replicas are started or stopped before this returns.
    What changed ({"event", "started", "stopped_replicas"} or {"stopped": True, …}), or None."""
    g = WORKERS.get(dep_id)
    if g is None:
        return None
    return _reconcile(dep_id, g, now, wait=True)


def _reconcile_now(dep_id: str, g: dict, at: Optional[float] = None, load_based: bool = True) -> Optional[dict]:
    try:
        dep = _read(dep_id)
    except HTTPException:
        return None
    if dep.get("status") != "running" or WORKERS.get(dep_id) is not g:
        return None
    cfg = dep.get("config") or {}
    now = _clock() if at is None else at
    if load_based and int(cfg.get("min_replicas") if cfg.get("min_replicas") is not None else 1) == 0:
        idle = float(cfg.get("idle_s") or 1800)
        with _lb_lock:
            busy = any(r["in_flight"] for r in g["replicas"])
        if not busy and now - g["last_request"] >= idle:
            _log(dep_id, "INFO", f"no request for {idle:g} s: scaled to zero (it starts again on the next request)")
            ev = {"at": _now(), "from": len(g["replicas"]), "to": 0, "reason": f"no request for {idle:g} s"}
            _note(dep_id, scaling=[ev, *(dep.get("scaling") or [])][:20], replicas_desired=0)
            _stop_worker(dep_id, wait=True)
            return {"stopped": True, **ev}
    ev = _autoscale(dep, g, now, load_based)
    try:
        return _apply_scale(dep_id, dep, g, now, ev)
    finally:
        if ev:
            # the window and the cool-down count from the moment the replicas changed (a new replica takes a while
            # to start): the load measured next is what the new count carried, not the time it was starting
            g["scale"]["last_change"] = max(now, _clock() if at is None else at)


def _apply_scale(dep_id: str, dep: dict, g: dict, now: float, ev: Optional[dict]) -> Optional[dict]:
    """Start or stop replicas until the set has the wanted count. A replica is routed to only once it is ready
    (_adopt) and leaves the set before it is stopped, idle ones first."""
    desired = g["scale"]["desired"]
    with _lb_lock:
        have = len(g["replicas"])
    out: dict = {"event": ev} if ev else {}
    if have < desired:
        if now < g.get("start_retry_at", 0):
            return out or None
        try:
            rec, v = _target(dep)
        except HTTPException:
            return out or None
        if v["id"] != g["version_id"]:
            return out or None  # an upgrade is due: the next request (or the upgrade hook) starts the new set
        with _lb_lock:
            idx = list(range(g["next_index"], g["next_index"] + desired - have))
            g["next_index"] += len(idx)
        _log(dep_id, "INFO", f"starting replica(s) {', '.join(map(str, idx))}: {have} running, {desired} wanted")
        for i in idx:
            _mark(g, i, "starting")
        try:
            reps, errs = _start_replicas(dep, rec, v, idx)
        finally:
            for i in idx:
                _mark(g, i, None)
        added = [r["index"] for r in reps if _adopt(dep_id, g, r)]
        if errs:
            g["start_failures"] = g.get("start_failures", 0) + 1
            g["start_retry_at"] = now + min(300.0, MONITOR_S * 2 ** g["start_failures"])
            _log(dep_id, "WARN", f"{len(errs)} replica(s) did not start: {errs[0].detail}")
        else:
            g.pop("start_failures", None)
            g.pop("start_retry_at", None)
        if added:
            out["started"] = added
    elif have > desired:
        with _lb_lock:
            # the newest idle replicas go (one serving a request stays until a later check)
            idle = [r for r in reversed(g["replicas"]) if r["in_flight"] == 0][: have - desired]
            g["replicas"] = [r for r in g["replicas"] if not any(r is x for x in idle)]
            _sync(g)
        for r in idle:
            _log(dep_id, "INFO", f"stopping replica {r['index']}: {desired} wanted", replica=r["index"])
            _retire(g, r)
        if idle:
            out["stopped_replicas"] = [r["index"] for r in idle]
    return out or None


def _begin_recovery(dep_id: str, reason: str, checked: dict) -> None:
    with _lock:
        # the worker that failed the check, unless an upgrade or a stop replaced it meanwhile
        if WORKERS.get(dep_id) is not checked:
            return
        old = WORKERS.pop(dep_id)
        _recover.setdefault(dep_id, {"attempts": 0})
        _recover[dep_id].update(reason=reason, next_at=0.0)
    _note(dep_id, health="restarting", error=reason[:2000])
    _log(dep_id, "WARN", f"restarting: {reason}")
    if old:
        _close_worker(old)
    _restart(dep_id)


def _restart(dep_id: str) -> bool:
    r = _recover.get(dep_id)
    if r is None:
        return False
    try:
        dep = _read(dep_id)
    except HTTPException:
        _recover.pop(dep_id, None)
        return False
    if dep.get("status") != "running":
        _recover.pop(dep_id, None)
        return False
    r["attempts"] += 1
    try:
        _worker(dep)
    except HTTPException as e:
        msg = str(e.detail)
        if r["attempts"] >= MAX_RESTARTS:
            _recover.pop(dep_id, None)
            _log(dep_id, "ERROR", f"gave up after {r['attempts']} restart attempts: {msg}")
            _note(dep_id, health="failed", error=f"gave up after {r['attempts']} restart attempts: {msg}"[:2000])
        else:
            wait = min(300.0, MONITOR_S * 2 ** r["attempts"])
            r["next_at"] = time.monotonic() + wait
            _log(dep_id, "WARN", f"restart attempt {r['attempts']} failed, next in {wait:.0f} s: {msg}")
            _note(dep_id, health="restarting", error=msg[:2000])
        return False
    _recover.pop(dep_id, None)
    _log(dep_id, "INFO", f"restarted (attempt {r['attempts']})")
    with _lock:
        cur = _read(dep_id)
        _note(dep_id, restarts=int(cur.get("restarts") or 0) + 1, last_restart_at=_now(), last_restart_reason=r.get("reason", "")[:500])
    return True


def _input_stamp(item_id: Optional[str]) -> Optional[str]:
    """What identifies the current contents of a batch input: its newest transaction, size and change time."""
    import dataset_versions
    import db

    item = db.drive_get(item_id) if item_id else None
    if not item or item.get("trashed_at"):
        return None
    tx = dataset_versions.current(item["id"]) or {}
    return f"{tx.get('id') or ''}|{item.get('size_bytes')}|{item.get('updated_at')}"


def _check_batch_inputs(item_id: Optional[str] = None) -> list[str]:
    """Batch deployments whose input dataset changed since their last run: rebuilt (in the background)."""
    started = []
    for dep in _all():
        if dep["kind"] != "batch" or dep.get("status") != "running" or dep.get("rebuild_on_input") is False:
            continue
        if item_id and dep.get("input_item_id") != item_id:
            continue
        try:
            stamp = _input_stamp(dep.get("input_item_id"))
        except Exception:  # noqa: BLE001
            continue
        if stamp is None:
            continue
        if not dep.get("input_stamp"):
            # first look at a deployment made before input triggers: the input it last read is taken as current
            _note(dep["id"], input_stamp=stamp)
            continue
        lock = _start_locks.setdefault(dep["id"], threading.Lock())
        if stamp == dep["input_stamp"] or lock.locked():
            continue
        _note(dep["id"], input_stamp=stamp)  # claimed: another check (or process) sees it as built
        _log(dep["id"], "INFO", f"the input dataset {dep.get('input_name') or ''} updated: rebuilding")
        threading.Thread(target=_run_batch, args=(dep["id"], "input updated"), daemon=True).start()
        started.append(dep["id"])
    return started


def on_dataset_transaction(item_id: str) -> list[str]:
    """A dataset got a new transaction (for dataset_versions to call): batch deployments reading it rebuild now
    instead of at the monitor's next check."""
    return _check_batch_inputs(item_id)


def monitor_once() -> dict:
    """One pass of the monitor: check every running worker, retry pending restarts, rebuild batch deployments whose
    input changed. Returns what it did."""
    out: dict = {"checked": 0, "problems": {}, "restarted": [], "replaced": {}, "scaled": {}, "batch": []}
    for dep_id, w in list(WORKERS.items()):
        if WORKERS.get(dep_id) is not w:
            continue
        out["checked"] += 1
        before = {r["index"] for r in w["replicas"]}
        problem = _check_live(dep_id, w)
        if problem:
            out["problems"][dep_id] = problem
            cur = WORKERS.get(dep_id)
            if cur is not None and cur is not w:
                out["restarted"].append(dep_id)
            elif cur is w and {r["index"] for r in w["replicas"]} != before:
                out["replaced"][dep_id] = sorted(before - {r["index"] for r in w["replicas"]})
        if WORKERS.get(dep_id) is w:
            try:
                ch = _reconcile(dep_id, w)
            except Exception as e:  # noqa: BLE001 - scaling never stops the monitor
                ch = {"error": f"{type(e).__name__}: {e}"}
            if ch:
                out["scaled"][dep_id] = ch
    for dep_id, r in list(_recover.items()):
        if dep_id not in WORKERS and time.monotonic() >= r.get("next_at", 0):
            if _restart(dep_id):
                out["restarted"].append(dep_id)
    out["batch"] = _check_batch_inputs()
    _monitor["last_at"] = _now()
    return out


# ------------------------------------------------------------------------------------------------
# deployments
# ------------------------------------------------------------------------------------------------


class ConfigIn(BaseModel):
    min_replicas: int = Field(1, ge=0, le=32)
    max_replicas: int = Field(1, ge=1, le=32)
    # per replica; a container model's containers get them as docker's --cpus / --memory
    cpu: float = Field(1, ge=0.05, le=64)
    memory_gb: float = Field(2, ge=0.03125, le=512)
    env: dict[str, str] = Field(default_factory=dict)
    # batch deployments: Spark profiles, kept for the record
    profiles: list[str] = Field(default_factory=list)
    # autoscaling (max_replicas above min_replicas): on requests in flight per replica or on the p95 latency
    scale_metric: Literal["in_flight", "p95_latency"] = "in_flight"
    target_in_flight: float = Field(1, gt=0, le=1000)
    target_p95_ms: float = Field(1000, gt=0, le=600_000)
    scale_window_s: int = Field(60, ge=1, le=3600)
    cooldown_s: int = Field(120, ge=0, le=86_400)
    # min_replicas 0: stop after this long without a request
    idle_s: int = Field(1800, ge=10, le=7 * 86_400)


_RUNTIME_KEYS = ("cpu", "memory_gb", "env", "profiles")
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def check_config(cfg: ConfigIn) -> ConfigIn:
    """What the field bounds do not say: the replica range is a range, environment variables have usable names.
    HTTPException 400."""
    if cfg.min_replicas > cfg.max_replicas:
        raise HTTPException(400, "the minimum replica count cannot be above the maximum")
    if len(cfg.env) > 200:
        raise HTTPException(400, "at most 200 environment variables")
    for k in cfg.env:
        if not _ENV_NAME.fullmatch(k):
            raise HTTPException(400, f"{k!r} is not an environment variable name (letters, digits and _, not starting with a digit)")
    return cfg


class DirectIn(BaseModel):
    model_id: str
    branch: str = Field("master", max_length=200)
    config: ConfigIn = Field(default_factory=ConfigIn)


def _can(dep: dict, need: str = "viewer") -> None:
    """The caller's role `need` on a deployment (viewer: see it, its logs and runs, query it and call its function;
    editor: configure, enable / disable, scale, publish its function; owner: delete it, set up / switch / remove its
    model inference history). A direct deployment follows its model (the markings and Project role on the model's
    Files item). An objective live or batch deployment follows its Modeling Objective (its grants and Project role),
    and the caller must also hold the markings of the objective's Project; a live one also needs the viewer role on
    the model of the release it serves (its markings). 404 when the caller may not see it."""
    kind = dep.get("kind")
    if kind == "direct":
        model_assets._get(dep["model_id"], need=need)
        return
    if kind not in ("objective", "batch") or not dep.get("objective_id"):
        raise HTTPException(404, "deployment not found")
    import modeling_objectives as mo

    with mo._lock:
        rec = mo._get(dep["objective_id"], need)
    p = auth.current()
    if rec.get("project_id") and auth.enabled() and p is not None and not p.get("service"):
        missing = sorted(auth.missing_markings(auth.effective_markings(rec["project_id"]), p.get("markings")))
        if missing:
            raise HTTPException(403, f"You need the marking{'s' if len(missing) > 1 else ''} {', '.join(auth._marking_names(missing))} of the "
                                     "objective's Project to access this deployment", headers=auth.access_header("marking", markings=missing))
    if kind == "objective":
        try:
            model_id, _ = mo.release_target(dep["objective_id"], dep["environment"])
        except HTTPException as e:
            if e.status_code == 409:
                return  # no deployable release: nothing is served, the objective's role decides
            raise
        model_assets._get(model_id)


def _my_role(dep: dict) -> str:
    """The best role the caller has on a deployment it can see (the web app hides what it may not do)."""
    for need in ("owner", "editor"):
        try:
            _can(dep, need)
            return need
        except HTTPException:
            pass
    return "viewer"


def _status(dep: dict) -> dict:
    w = WORKERS.get(dep["id"])
    alive = _alive(w)
    state = ("disabled" if dep.get("status") != "running" else "restarting" if dep["id"] in _recover else "running" if alive
             else "failed" if dep.get("health") == "failed" else "idle")
    extra: dict = {}
    if alive:
        with _lb_lock:
            reps = list(w["replicas"])
            pending = dict(w.get("pending") or {})
        now = _clock()
        extra["replicas"] = [{"index": r["index"], "alive": r["client"].alive, "pid": r["client"].proc.pid, "started_at": r["started_at"],
                              "in_flight": r["in_flight"], "requests": r["requests"], "errors": r["errors"], "failed_checks": r.get("strikes", 0),
                              "containers": [c["name"] for c in r.get("containers") or []],
                              "healthy": r["client"].alive and not r.get("strikes") and all(c.get("ready") for c in r.get("containers") or [])} for r in reps]
        for r in extra["replicas"]:
            # running: takes requests; unhealthy: failed its last check (only used when no other replica is left)
            r["state"] = "running" if r["healthy"] else "unhealthy" if r["alive"] else "stopped"
        # replicas being started or stopped: not in the set requests are routed to
        extra["replicas"] += [{"index": i, "state": p["state"], "alive": False, "healthy": False, "pid": None, "started_at": p["at"], "in_flight": 0,
                               "requests": 0, "errors": 0, "failed_checks": 0, "containers": []} for i, p in sorted(pending.items())]
        cfg = dep.get("config") or {}
        lo, hi = _bounds(dep)
        s = w["scale"]
        extra["scaling_now"] = {"desired": s["desired"], "min": lo, "max": hi, "autoscaling": hi > lo, "metric": cfg.get("scale_metric") or "in_flight",
                                "load": round(_load(w, now, float(cfg.get("scale_window_s") or 60)), 3),
                                "p95_ms": _p95(w, now, float(cfg.get("scale_window_s") or 60)),
                                "last_change_s_ago": int(now - s["last_change"]),
                                "idle_s": int(now - w["last_request"])}
    if alive and _container(w):
        cs = [{**c, "replica": r["index"]} for r in reps for c in r.get("containers") or []]
        checked = [r["checked_at"] for r in reps if r.get("checked_at")]
        extra.update({"containers": cs, "containers_checked_at": min(checked) if checked else None,
                      "containers_error": next((r["containers_error"] for r in reps if r.get("containers_error")), None),
                      "telemetry": bool(w["spec"].get("telemetry"))})
    if dep["id"] in _recover:
        r = _recover[dep["id"]]
        extra["restart"] = {"attempts": r["attempts"], "reason": r.get("reason"), "next_in_s": max(0, int(r.get("next_at", 0) - time.monotonic()))}
    runs = _tail(DIR / dep["id"] / "runs.jsonl", 2000)
    cut = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    recent = [r for r in runs if r["at"] >= cut]
    ms = sorted(r["ms"] for r in recent if r.get("ms") is not None)
    return {**dep, **extra, "state": state, "loaded_version": w and w["version"] if alive else None, "started_at": w and w["started_at"] if alive else None,
            "metrics": {"requests_24h": len(recent), "errors_24h": sum(1 for r in recent if not r["ok"]),
                        "p50_ms": ms[len(ms) // 2] if ms else None, "p95_ms": ms[min(len(ms) - 1, int(len(ms) * 0.95))] if ms else None,
                        "last_request_at": runs[-1]["at"] if runs else None},
            "endpoint": f"/api/foundry-ml-live/api/inference/transform/{dep['rid']}/v2" if dep["kind"] != "batch" else None}


def _visible(dep: dict) -> bool:
    try:
        _can(dep)
        return True
    except HTTPException:
        return False


@router.get("")
def list_deployments(model_id: Optional[str] = None, objective_id: Optional[str] = None) -> list[dict]:
    out = [d for d in _all() if (not model_id or d.get("model_id") == model_id) and (not objective_id or d.get("objective_id") == objective_id)]
    return [_status(d) for d in sorted(out, key=lambda d: d["created_at"], reverse=True) if _visible(d)]


@router.post("")
def create_direct(req: DirectIn) -> dict:
    """A direct model deployment: one per model and branch; it starts right away."""
    rec, _ = model_assets._get(req.model_id, need="editor")
    check_config(req.config)
    try:
        _latest(rec, req.branch)
    except (ValueError, HTTPException) as e:
        raise HTTPException(400, getattr(e, "detail", None) or str(e)) from None
    with _lock:
        if any(d["kind"] == "direct" and d["model_id"] == rec["id"] and (d.get("branch") or "master") == req.branch for d in _all()):
            raise HTTPException(409, f"{rec['name']} already has a live deployment on {req.branch}")
        dep = _new("direct", f"{rec['name']} ({req.branch})", req.config, model_id=rec["id"], branch=req.branch)
    _safe_start(dep)
    return _status(_read(dep["id"]))


def _new(kind: str, name: str, config: ConfigIn, **fields: Any) -> dict:
    hexid = uuid.uuid4().hex[:12]
    dep = {"id": f"dep-{hexid}", "rid": LIVE_RID + str(uuid.UUID(hex=uuid.uuid4().hex)), "kind": kind, "name": name, "status": "running",
           "config": config.model_dump(), "created_at": _now(), "created_by": _me(), "owner": auth.actor_id(), "history": [], **fields}
    return _write(dep)


def create_for_objective(objective_id: str, environment: str, name: str, description: str, kind: Literal["objective", "batch"], config: ConfigIn,
                         **fields: Any) -> dict:
    """modeling_objectives: a live ("objective") or batch deployment on the objective's release in an environment. The
    caller needs what editing it will need (_can "editor": the objective's role, the markings of its Project and, for a
    live one, the release's model), checked before anything is written."""
    _can({"kind": kind, "objective_id": objective_id, "environment": environment}, "editor")
    check_config(config)
    with _lock:
        dep = _new(kind, name, config, objective_id=objective_id, environment=environment, description=description, **fields)
    if kind == "objective":
        _safe_start(dep)
    else:
        threading.Thread(target=_run_batch, args=(dep["id"], "created"), daemon=True).start()
    return _status(_read(dep["id"]))


@router.get("/{dep_id}")
def get_deployment(dep_id: str) -> dict:
    dep = _read(dep_id)
    _can(dep)
    out = {**_status(dep), "my_role": _my_role(dep)}
    try:
        rec, v = _target(dep)
        out["target"] = {"model_id": rec["id"], "model": rec["name"], "model_rid": rec["rid"], "version": v["version"], "version_rid": v["rid"],
                         "api": v.get("api") or {}}
    except HTTPException as e:
        out["target"] = None
        out["target_error"] = str(e.detail)
    return out


@router.put("/{dep_id}/config")
def update_config(dep_id: str, req: ConfigIn) -> dict:
    dep = _read(dep_id)
    _can(dep, "editor")
    check_config(req)
    old = dep.get("config") or {}
    new = req.model_dump()
    _note(dep_id, config=new)
    if any(old.get(k) != new.get(k) for k in _RUNTIME_KEYS):
        # a runtime change (resources, env) re-runs the deployment
        _stop_worker(dep_id)
    else:
        # only the scaling changed: the running replicas stay, the count is brought into the new range now (the
        # load-based decisions stay with the monitor, which measures a full window)
        g = WORKERS.get(dep_id)
        if g is not None:
            threading.Thread(target=_reconcile, args=(dep_id, g), kwargs={"load_based": False, "wait": True}, daemon=True).start()
    return get_deployment(dep_id)


@router.post("/{dep_id}/scaling/evaluate")
def evaluate_scaling_route(dep_id: str) -> dict:
    """Evaluate the scaling of a running live deployment now (the monitor does it every MONITOR_S seconds): the
    deployment, with what changed under "evaluation" (null: nothing to do)."""
    dep = _read(dep_id)
    _can(dep, "editor")
    if dep["kind"] == "batch":
        raise HTTPException(400, "a batch deployment has no replicas")
    if dep_id not in WORKERS:
        raise HTTPException(409, "the deployment is not running")
    ch = evaluate_scaling(dep_id)
    return {**get_deployment(dep_id), "evaluation": ch}


@router.post("/{dep_id}/start")
def start(dep_id: str) -> dict:
    dep = _read(dep_id)
    _can(dep, "editor")
    owner = _take_over(dep) if dep["kind"] == "batch" else {}
    _note(dep_id, status="running", health=None, error=None, **owner)
    _recover.pop(dep_id, None)
    dep = _read(dep_id)
    if dep["kind"] == "batch":
        threading.Thread(target=_run_batch, args=(dep_id, "manual", auth.current()), daemon=True).start()
    else:
        _worker(dep)
    return get_deployment(dep_id)


@router.post("/{dep_id}/stop")
def stop(dep_id: str) -> dict:
    """Disable: the endpoint stops answering; the deployment keeps its rid and can be enabled again."""
    dep = _read(dep_id)
    _can(dep, "editor")
    with _lock:  # a worker that is starting now sees "disabled" and stops itself (_worker)
        _note(dep_id, status="disabled")
        w = _take_worker(dep_id)
    if w:
        _close_worker(w)  # a container model's containers are gone when this returns
    _log(dep_id, "INFO", "disabled")
    return get_deployment(dep_id)


@router.delete("/{dep_id}")
def delete(dep_id: str) -> dict:
    """Remove the deployment for good (its rid stops answering): the owner role on its model / objective."""
    dep = _read(dep_id)
    _can(dep, "owner")
    with _lock:
        w = _take_worker(dep_id)
        _path(dep_id).unlink(missing_ok=True)
    if w:
        _close_worker(w)
    import shutil

    shutil.rmtree(DIR / dep_id, ignore_errors=True)
    return {"deleted": dep_id}


@router.get("/{dep_id}/logs")
def logs(dep_id: str, limit: int = 500, q: str = "") -> list[dict]:
    dep = _read(dep_id)
    _can(dep)
    rows = _tail(DIR / dep_id / "logs.jsonl", 5000)
    if q:
        rows = [r for r in rows if q.lower() in json.dumps(r).lower()]
    return rows[-max(1, min(limit, 5000)):]


@router.get("/{dep_id}/runs")
def runs(dep_id: str, limit: int = 200) -> list[dict]:
    dep = _read(dep_id)
    _can(dep)
    return list(reversed(_tail(DIR / dep_id / "runs.jsonl", max(1, min(limit, MAX_RUNS)))))


@router.get("/{dep_id}/traces")
def traces(dep_id: str, limit: int = 100, request_uuid: Optional[str] = None) -> list[dict]:
    """Telemetry of inference calls, newest first: the span over each call, the spans the adapter created inside it
    and (request_uuid given) that call's log lines."""
    dep = _read(dep_id)
    _can(dep)
    rows = _tail(DIR / dep_id / "traces.jsonl", MAX_RUNS)
    if request_uuid:
        rows = [r for r in rows if r.get("request_uuid") == request_uuid]
        lines = [x for x in _tail(DIR / dep_id / "logs.jsonl", 5000) if x.get("request_uuid") == request_uuid]
        rows = [{**r, "logs": lines} for r in rows]
    return list(reversed(rows[-max(1, min(limit, MAX_RUNS)):]))


# ------------------------------------------------------------------------------------------------
# queries
# ------------------------------------------------------------------------------------------------


class QueryIn(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)


def infer(dep: dict, inputs: dict, source: str = "query") -> dict:
    """Run one inference request on a live deployment: {"outputs": {name: rows | value}, "ms", "logs", "version"};
    HTTPException 400 with the model's error and stack trace, 503 when it is not running."""
    if dep["kind"] == "batch":
        raise HTTPException(400, "a batch deployment has no endpoint")
    if not isinstance(inputs, dict):
        raise HTTPException(422, "the request body is a JSON object with a field per model input")
    request_uuid = str(uuid.uuid4())
    w = _worker(dep)
    started = time.monotonic()
    res: dict = {}
    error = None
    status = 200
    tried: set = set()
    replica = None
    while True:
        picked = _pick(w, tried)
        if picked is None:
            error, status = "no replica of the deployment is running", 503
            if WORKERS.get(dep["id"]) is w and not _alive(w):
                _stop_worker(dep["id"])
            break
        r, token = picked
        tried.add(r["index"])
        replica = r["index"]
        retry = False
        try:
            # direct deployments enforce the model API's types (casting); objective deployments pass values through
            res = r["client"].query(inputs, cast=dep["kind"] == "direct", timeout=float(dep.get("timeout_s") or 120), request_uuid=request_uuid)
            if not res.get("ok"):
                error, status = (res.get("error") or "the model failed"), 400
        except model_worker.WorkerError as e:
            error, status = str(e), 503 if "not running" in str(e) or "stopped" in str(e) else 504
            if status == 503:
                # the replica's process is gone: out of the set; the request goes to another replica (failover)
                _drop_replica(dep["id"], w, r, str(e))
                retry = _alive(w)
                if retry:
                    _log(dep["id"], "WARN", f"request {request_uuid} retried on another replica: replica {r['index']} stopped while answering", request_uuid=request_uuid)
                    error, status, res = None, 200, {}
        finally:
            _end(w, r, token, bool(error))
        if not retry:
            break
    ms = int((time.monotonic() - started) * 1000)
    outputs = {k: (o.get("rows") if "rows" in o else o.get("value")) for k, o in (res.get("outputs") or {}).items()}
    run = {"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "request_uuid": request_uuid, "user": _me(), "ok": not error, "ms": ms,
           "version": w["version"], "source": source, "error": error and error[:500],
           "rows_in": sum(len(v) for v in inputs.values() if isinstance(v, list)), "replica": replica, **({"retried": len(tried) - 1} if len(tried) > 1 else {})}
    d = DIR / dep["id"]
    d.mkdir(parents=True, exist_ok=True)
    with _lock:
        with open(d / "runs.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(run) + "\n")
        if res.get("spans"):
            # telemetry: the request span and the adapter's own spans (model_worker._Telemetry)
            with open(d / "traces.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": run["at"], "request_uuid": request_uuid, "trace_id": res["spans"][0].get("trace_id"), "ok": not error,
                                    "ms": ms, "version": w["version"], "source": source, "user": run["user"], "spans": res["spans"]}, default=str) + "\n")
        _trim(d / "runs.jsonl")
        _trim(d / "logs.jsonl")
        _trim(d / "traces.jsonl")
    if res.get("spans"):
        import model_telemetry  # to the OpenTelemetry collector, when one is configured (never waits)

        model_telemetry.report(res["spans"], {"model.rid": w.get("model_rid"), "model.version": w["version"]}, "deployment",
                               {"bluesandai.deployment.id": dep["id"], "bluesandai.deployment.kind": dep.get("kind"), "bluesandai.request.source": source})
    if res.get("logs"):
        _log(dep["id"], "MODEL", res["logs"].rstrip(), request_uuid=request_uuid)
    if error:
        _log(dep["id"], "ERROR", error, request_uuid=request_uuid, traceback=res.get("traceback"))
    _history_row(dep, w, run, inputs, outputs, error and (res.get("traceback") or error))
    if error:
        raise HTTPException(status, {"errorCode": "INVALID_ARGUMENT" if status == 400 else "UNAVAILABLE", "error": error,
                                     "stacktrace": res.get("traceback"), "logs": res.get("logs"), "requestUuid": request_uuid})
    return {"outputs": outputs, "ms": ms, "logs": res.get("logs") or "", "version": w["version"], "version_rid": w["version_rid"],
            "request_uuid": request_uuid, "replica": replica}


@router.post("/{dep_id}/query")
def query(dep_id: str, req: QueryIn) -> dict:
    dep = _read(dep_id)
    _can(dep)
    return infer(dep, req.inputs)


async def _body(request: Request) -> Any:
    try:
        return json.loads(await request.body() or b"{}")
    except ValueError:
        raise HTTPException(422, "the request body is not valid JSON") from None


@live_router.post("/{rid}/v2")
async def transform_v2(rid: str, request: Request) -> JSONResponse:
    """Multi I/O endpoint: {"<input>": rows or value, ...} → {"<output>": rows or value, ...}."""
    body = await _body(request)
    if not isinstance(body, dict):
        raise HTTPException(422, "the request body is a JSON object with a field per model input")
    dep = _by_rid(rid)
    _can(dep)
    return JSONResponse(infer(dep, body, "v2")["outputs"])


@live_router.post("/{rid}")
async def transform_v1(rid: str, request: Request) -> JSONResponse:
    """Single I/O endpoint (sunset; Modeling Objective deployments only): {"requestData": rows} → {"modelUuid",
    "responseData": rows}, for models with one tabular input and one tabular output."""
    body = await _body(request)
    if not isinstance(body, dict) or not isinstance(body.get("requestData"), list):
        raise HTTPException(422, 'the request body is {"requestData": [rows], "requestParams": {}}')
    dep = _by_rid(rid)
    _can(dep)
    if dep["kind"] != "objective":
        raise HTTPException(400, "the single I/O endpoint is only supported by Modeling Objective deployments: use the /v2 endpoint")
    _, v = _target(dep)
    api = v.get("api") or {}
    tab_in = [i for i in api.get("inputs") or [] if i["type"] == "tabular"]
    tab_out = [o for o in api.get("outputs") or [] if o["type"] == "tabular"]
    if len(tab_in) != 1 or len(tab_out) != 1 or len(api.get("outputs") or []) != 1:
        raise HTTPException(400, "the single I/O endpoint needs a model with one tabular input and one tabular output: use the /v2 endpoint")
    params = body.get("requestParams") if isinstance(body.get("requestParams"), dict) else {}
    res = infer(dep, {tab_in[0]["name"]: body["requestData"], **params}, "v1")
    return JSONResponse({"modelUuid": res["version_rid"].rsplit(".", 1)[-1], "responseData": res["outputs"][tab_out[0]["name"]]})


# ------------------------------------------------------------------------------------------------
# model functions
# ------------------------------------------------------------------------------------------------


class ObjectBindingIn(BaseModel):
    # an object type (API name or id) whose properties fill model columns: {model column: property API name}
    object_type: str = Field(min_length=1, max_length=200)
    properties: dict[str, str] = Field(min_length=1, max_length=500)
    # the function's object input
    input_name: str = Field("object", min_length=1, max_length=100, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")


class FunctionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    api_name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    # one row in, one row out (only for a single tabular input and a single tabular output)
    row_wise: Optional[bool] = None
    # row-wise only: the function takes an Ontology object and its properties fill these model columns
    object_binding: Optional[ObjectBindingIn] = None


def _binding(req: ObjectBindingIn, signature: dict) -> dict:
    """Check an object binding against the Ontology and the row-wise signature: {object_type_id, object_type, properties, input_name}."""
    import ontology

    t = next((x for x in ontology._all("object-types") if req.object_type in (x["api_name"], x["id"])), None)
    if not t:
        raise HTTPException(400, f"unknown object type {req.object_type}")
    props = {p.get("api_name") or p["id"] for p in t.get("properties") or []}
    cols = signature["inputs"]
    for col, prop in req.properties.items():
        if col not in cols:
            raise HTTPException(400, f"the model has no input column {col}")
        if prop not in props:
            raise HTTPException(400, f"{t['api_name']} has no property {prop}")
    if req.input_name in cols and req.input_name not in req.properties:
        raise HTTPException(400, f"the object input {req.input_name} has the name of a model column")
    return {"object_type_id": t["id"], "object_type": t["api_name"], "properties": dict(req.properties), "input_name": req.input_name}


def _row_wise_ok(api: dict) -> bool:
    ins, outs = api.get("inputs") or [], api.get("outputs") or []
    return len(ins) == 1 and len(outs) == 1 and ins[0]["type"] == "tabular" and outs[0]["type"] == "tabular"


def function_problems(api: dict) -> list[str]:
    """Why a model API cannot be published as a function (the docs' requirements)."""
    out = []
    for i in api.get("inputs") or []:
        if i["type"] not in ("tabular", "parameter", "object", "object_set"):
            out.append(f"input {i['name']}: {i['type']} inputs cannot be used in functions")
    for item in [*(api.get("inputs") or []), *(api.get("outputs") or [])]:
        if item["type"] == "tabular" and not item.get("columns"):
            out.append(f"{item['name']}: declare its columns (pm.Pandas() without columns is not allowed)")
        types = [c["type"] for c in item.get("columns") or []] + ([item.get("value_type")] if item["type"] == "parameter" else [])
        for t in types:
            if t == "any":
                out.append(f"{item['name']}: the Any type is not allowed in a function")
            elif t in ("list", "map"):
                out.append(f"{item['name']}: {t} needs element types (list[str], dict[str, str])")
    return out


def _signature(api: dict, row_wise: bool) -> dict:
    if row_wise:
        return {"inputs": {c["name"]: c["type"] for c in api["inputs"][0].get("columns") or []},
                "output": {c["name"]: c["type"] for c in api["outputs"][0].get("columns") or []}}
    def one(i: dict) -> Any:
        return [{c["name"]: c["type"] for c in i.get("columns") or []}] if i["type"] == "tabular" else i.get("value_type") or i["type"]
    return {"inputs": {i["name"]: one(i) for i in api.get("inputs") or []}, "output": {o["name"]: one(o) for o in api.get("outputs") or []}}


@router.post("/{dep_id}/function")
def publish_function(dep_id: str, req: FunctionIn) -> dict:
    """Publish (or republish: a new function version) the function wrapping this live deployment."""
    dep = _read(dep_id)
    _can(dep, "editor")
    if dep["kind"] == "batch":
        raise HTTPException(400, "functions wrap live deployments")
    _, v = _target(dep)
    api = v.get("api") or {}
    if not api.get("inputs") and not api.get("outputs"):
        raise HTTPException(400, "this model version declares no API")
    problems = function_problems(api)
    if problems:
        raise HTTPException(400, "the model API cannot be published as a function: " + "; ".join(problems))
    with _lock:
        other = next((d for d in _all() if d["id"] != dep_id and (d.get("function") or {}).get("api_name") == req.api_name), None)
        if other:
            raise HTTPException(409, f"the function API name {req.api_name} is used by the deployment {other['name']}")
        row_wise = _row_wise_ok(api) if req.row_wise is None else bool(req.row_wise)
        if row_wise and not _row_wise_ok(api):
            raise HTTPException(400, "row-wise processing needs exactly one tabular input and one tabular output")
        if req.object_binding and not row_wise:
            raise HTTPException(400, "an object input fills one row: publish the function row-wise")
        binding = _binding(req.object_binding, _signature(api, True)) if req.object_binding else None
        prev = dep.get("function") or {}
        versions = [*(prev.get("versions") or []), {"version": len(prev.get("versions") or []) + 1, "at": _now(), "by": _me(), "model_version": v["version"],
                                                     "row_wise": row_wise, "signature": _signature(api, row_wise), "object_binding": binding}]
        dep = _read(dep_id)
        dep["function"] = {"name": req.name.strip(), "api_name": req.api_name, "row_wise": row_wise, "signature": versions[-1]["signature"],
                           "model_version": v["version"], "version": versions[-1]["version"], "versions": versions[-20:], "object_binding": binding}
        _write(dep)
    return get_deployment(dep_id)


@router.delete("/{dep_id}/function")
def remove_function(dep_id: str) -> dict:
    dep = _read(dep_id)
    _can(dep, "editor")
    with _lock:
        dep = _read(dep_id)
        dep.pop("function", None)
        _write(dep)
    return get_deployment(dep_id)


@router.get("/functions/all")
def list_functions() -> list[dict]:
    out = []
    for d in _all():
        if d.get("function") and _visible(d):
            f = d["function"]
            try:
                _, v = _target(d)
                stale = v["version"] != f.get("model_version") and _signature(v.get("api") or {}, f["row_wise"]) != f["signature"]
            except HTTPException:
                stale = False
            out.append({"api_name": f["api_name"], "name": f["name"], "deployment_id": d["id"], "deployment": d["name"], "row_wise": f["row_wise"],
                        "signature": f["signature"], "version": f["version"], "model_version": f.get("model_version"), "object_binding": f.get("object_binding"),
                        # the model's API changed since the function was published: publish a new function version
                        "api_changed": stale})
    return out


def find_function(api_name: str) -> Optional[dict]:
    return next((d for d in _all() if (d.get("function") or {}).get("api_name") == api_name), None)


def execute_function(api_name: str, inputs: dict) -> dict:
    """Run a model function: {"output": ...}; row-wise functions take one row's columns and return one row."""
    dep = find_function(api_name)
    if not dep:
        raise HTTPException(404, f"no model function named {api_name}")
    _can(dep)
    f = dep["function"]
    _, v = _target(dep)
    api = v.get("api") or {}
    if f["row_wise"]:
        if not _row_wise_ok(api):
            raise HTTPException(409, "the model's API changed and no longer fits row-wise processing: publish a new function version")
        if f.get("object_binding"):
            inputs = _bound_row(f["object_binding"], inputs)
        res = infer(dep, {api["inputs"][0]["name"]: [inputs]}, f"function:{api_name}")
        rows = res["outputs"][api["outputs"][0]["name"]]
        return {"output": rows[0] if rows else None, "ms": res["ms"], "version": res["version"]}
    res = infer(dep, inputs, f"function:{api_name}")
    return {"output": res["outputs"], "ms": res["ms"], "version": res["version"]}


def _bound_row(b: dict, inputs: dict) -> dict:
    """A bound function's inputs as a model row: the object's mapped properties (read with the caller's permissions), then the other columns."""
    import ontology

    v = inputs.get(b["input_name"])
    if v is None:
        raise HTTPException(400, f"missing the object input {b['input_name']}")
    pk = v.get("primary_key", v.get("$primaryKey")) if isinstance(v, dict) else v
    t = ontology._object_type(b["object_type_id"])
    key, o = ontology._find(t, pk)
    props = ontology._public_object(t, key, o)["properties"]
    row = {k: x for k, x in inputs.items() if k != b["input_name"]}
    row.update({col: props.get(prop) for col, prop in b["properties"].items()})
    return row


def execute_function_rows(api_name: str, rows: list[dict]) -> list:
    """A row-wise model function over many rows in one inference request (a Pipeline Builder UDF): one output row each."""
    dep = find_function(api_name)
    if not dep:
        raise HTTPException(404, f"no model function named {api_name}")
    _can(dep)
    f = dep["function"]
    if not f["row_wise"]:
        raise HTTPException(400, f"{f['name']} takes a table, not one row: only row-wise model functions run per row")
    _, v = _target(dep)
    api = v.get("api") or {}
    if not _row_wise_ok(api):
        raise HTTPException(409, "the model's API changed and no longer fits row-wise processing: publish a new function version")
    if not rows:
        return []
    res = infer(dep, {api["inputs"][0]["name"]: rows}, f"pipeline:{api_name}")
    out = res["outputs"][api["outputs"][0]["name"]] or []
    if len(out) != len(rows):
        raise HTTPException(400, f"the model returned {len(out)} rows for {len(rows)}")
    return out


@router.post("/functions/{api_name}/execute")
def execute_function_route(api_name: str, req: QueryIn) -> dict:
    return execute_function(api_name, req.inputs)


# ------------------------------------------------------------------------------------------------
# model inference history
# ------------------------------------------------------------------------------------------------


class HistoryIn(BaseModel):
    folder_id: str
    name: str = Field(min_length=1, max_length=120)


HISTORY_COLUMNS = ["timestamp", "user_id", "request_uuid", "live_rid", "objective_rid", "model_rid", "model_version_rid", "input", "output", "error"]


def _history_row(dep: dict, w: dict, run: dict, inputs: dict, outputs: dict, error: Optional[str]) -> None:
    h = dep.get("inference_history")
    if not h or not h.get("enabled"):
        return
    row = {"timestamp": run["at"], "user_id": run["user"], "request_uuid": run["request_uuid"], "live_rid": dep["rid"],
           "objective_rid": f"ri.models.main.objective.{str(dep.get('objective_id') or '').split('-')[-1]}" if dep.get("objective_id") else None,
           "model_rid": w["model_rid"], "model_version_rid": w["version_rid"], "input": json.dumps(inputs, default=str),
           "output": json.dumps(outputs, default=str) if not error else None, "error": error}
    with _lock, open(DIR / dep["id"] / "history.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    last = h.get("flushed_at")
    if not last or (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() > 5:
        threading.Thread(target=_flush_history, args=(dep["id"],), daemon=True).start()


def _history_block(dep: dict, h: dict) -> tuple[Optional[dict], Optional[str]]:
    """(the principal the history is written as, why it cannot be written or None). The history's owner (who set it
    up or last switched recording on; older ones: the deployment's owner) must be an active user with the editor role
    on the history dataset (its markings and Project role). Sign-in off: (None, None), the system writes."""
    import drive
    import run_as

    if not auth.enabled():
        return None, None
    uid = h.get("owner") or dep.get("owner") or dep.get("created_by")
    if not uid or uid in ("local", "system"):
        return None, "the model inference history has no owner it can be written as: an Owner of the deployment must switch recording on again (it is then written as them)"
    try:
        p = run_as.owner_principal(uid, "the model inference history")
    except run_as.OwnerUnavailable:
        status = (auth.user_label(uid) or {}).get("status", "deleted")
        return None, (f"its owner {run_as.who(uid)} is {status}: an Owner of the deployment must switch recording on again "
                      "(it is then written as them)")
    with run_as.acting_as(p):
        try:
            drive._item(h["item_id"], need="editor")
        except HTTPException as e:
            if e.status_code in (401, 403, 404):
                return p, f"its owner {run_as.who(uid)} cannot write the history dataset {h.get('name') or h['item_id']} ({e.detail})"
            raise
    return p, None


def _flush_history(dep_id: str) -> Optional[dict]:
    """Write the recorded requests to the history dataset (a new transaction), as the history's owner — never as the
    system with sign-in on. An owner who lost access to the dataset (a marking, the Project role, deactivated) writes
    nothing: the reason is kept on the history ("error") and logged, the requests stay recorded and are written once
    the access is back."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    import dataset_versions
    import db
    import pipeline_datasets
    import run_as

    with _lock:
        try:
            dep = _read(dep_id)
        except HTTPException:
            return None
        h = dep.get("inference_history")
        p = DIR / dep_id / "history.jsonl"
        if not h or not p.exists():
            return None
        rows = [json.loads(line) for line in p.read_text("utf-8").splitlines() if line.strip()]
        if len(rows) == h.get("rows") and not h.get("error"):
            return h
        item = db.drive_get(h["item_id"])
        if not item or item.get("trashed_at"):
            return None
        principal, why = _history_block(dep, h)
        if why:
            if h.get("error") != f"not written: {why}":
                _log(dep_id, "ERROR", f"model inference history not written: {why}")
            h.update(error=f"not written: {why}", error_at=_now())
            _write(dep)
            return h
        with run_as.acting_as(principal):
            buf = io.BytesIO()
            pq.write_table(pa.table({c: pa.array([r.get(c) for r in rows], type=pa.string()) for c in HISTORY_COLUMNS}), buf)
            pipeline_datasets._replace_content(item, buf.getvalue())
            dataset_versions.record(item["id"], buf.getvalue(), "build", {"kind": "model_inference_history", "id": dep_id, "name": dep["name"], "transaction": "SNAPSHOT"})
        h.pop("error", None)
        h.pop("error_at", None)
        h.update(rows=len(rows), flushed_at=datetime.now(timezone.utc).isoformat())
        _write(dep)
        return h


@router.post("/{dep_id}/inference-history")
def create_history(dep_id: str, req: HistoryIn) -> dict:
    """Record every request and result of this Modeling Objective live deployment into a dataset (Foundry: the
    edit-inference-ledger permission, granted with the owner role on the objective). The history is written as the
    user who sets it up (its owner): the editor role on the folder now, on the dataset at every write."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    import drive
    import pipeline_datasets

    dep = _read(dep_id)
    _can(dep, "owner")
    if dep["kind"] != "objective":
        raise HTTPException(400, "model inference history is for Modeling Objective live deployments")
    if dep.get("inference_history"):
        raise HTTPException(409, "this deployment already has a model inference history")
    drive._item(req.folder_id, need="editor")
    buf = io.BytesIO()
    pq.write_table(pa.table({c: pa.array([], type=pa.string()) for c in HISTORY_COLUMNS}), buf)
    name = drive._clean_name(req.name.strip())
    item = drive._store(req.folder_id, name if name.endswith(".parquet") else f"{name}.parquet", io.BytesIO(buf.getvalue()), len(buf.getvalue()),
                        pipeline_datasets.PARQUET)
    _note(dep_id, inference_history={"item_id": item["id"], "name": item["name"], "enabled": True, "rows": 0, "created_at": _now(), "owner": auth.actor_id()})
    return get_deployment(dep_id)


class HistoryToggle(BaseModel):
    enabled: bool


@router.put("/{dep_id}/inference-history")
def toggle_history(dep_id: str, req: HistoryToggle) -> dict:
    """Switch recording on or off (the owner role). Switching it on makes the caller the history's owner (it is then
    written as them): they must be able to write the history dataset (403 with the reason, nothing changed)."""
    import drive

    dep = _read(dep_id)
    _can(dep, "owner")
    h = dep.get("inference_history")
    if not h:
        raise HTTPException(404, "this deployment has no model inference history")
    owner: dict = {}
    uid = auth.actor_id()
    if req.enabled and uid:
        try:
            drive._item(h["item_id"], need="editor")
        except HTTPException as e:
            if e.status_code in (401, 403, 404):
                raise HTTPException(403, f"You cannot record this history (it would then be written as you): you cannot write {h.get('name') or 'its dataset'} ({e.detail})") from None
            raise
        owner = {"owner": uid}
    with _lock:
        h = _read(dep_id).get("inference_history") or h
        _note(dep_id, inference_history={**h, "enabled": req.enabled, **owner})
    if owner and h.get("error"):
        _flush_history(dep_id)  # the new owner writes what the old one could not
    return get_deployment(dep_id)


@router.post("/{dep_id}/inference-history/sync")
def sync_history(dep_id: str) -> dict:
    """Write the recorded requests now (the editor role); written as the history's owner. 409 with the reason when
    the owner cannot write it."""
    dep = _read(dep_id)
    _can(dep, "editor")
    h = _flush_history(dep_id)
    if h and h.get("error"):
        raise HTTPException(409, f"The model inference history was {h['error']}")
    return get_deployment(dep_id)


@router.delete("/{dep_id}/inference-history")
def remove_history(dep_id: str) -> dict:
    """Stop recording for good (the owner role); the dataset stays in Files."""
    dep = _read(dep_id)
    _can(dep, "owner")
    with _lock:
        dep = _read(dep_id)
        dep.pop("inference_history", None)
        _write(dep)
        (DIR / dep_id / "history.jsonl").unlink(missing_ok=True)
    return get_deployment(dep_id)


# ------------------------------------------------------------------------------------------------
# batch deployments
# ------------------------------------------------------------------------------------------------


def run_model_on_dataset(rec: dict, v: dict, input_item_id: str, label: str) -> tuple[bytes, dict]:
    """A version's inference over a dataset (the model's single tabular input): (the output as parquet, info).
    Used by batch deployments and by Modeling Objectives' evaluation."""
    import pandas as pd

    import db
    import drive

    if rec.get("external"):
        raise ValueError("externally hosted models do not support batch deployments or automatic evaluation: use the model in a Python transform")
    api = v.get("api") or {}
    tab = [i for i in api.get("inputs") or [] if i["type"] == "tabular"]
    others = [i for i in api.get("inputs") or [] if i["type"] not in ("tabular", "parameter")]
    if len(tab) != 1 or others:
        raise ValueError("batch deployments and automatic evaluation need a model with a single tabular dataset input: "
                         "run inference in a Python transform instead")
    item = db.drive_get(input_item_id)
    if not item or item.get("trashed_at"):
        raise ValueError("the input dataset no longer exists")
    df = pd.read_parquet(io.BytesIO(drive.read_bytes(item)))
    spec = _spec(rec, v, label)
    try:
        client = model_worker.Client(spec)
        try:
            out = client.transform({tab[0]["name"]: df})
        finally:
            client.close()
            import model_telemetry  # the run's spans to the OpenTelemetry collector, when one is configured

            model_telemetry.report(getattr(client, "last_spans", None), {"model.name": rec.get("name"), "model.rid": rec.get("rid"),
                                                                          "model.version": v["version"]}, "batch", {"bluesandai.run.id": label})
    finally:
        if spec.get("kind") == "container":
            import model_container

            model_container.remove_leftovers(spec)
    frames = [x for x in out.values() if hasattr(x, "columns")]
    if not frames:
        raise ValueError("the model returned no tabular output")
    res = frames[0]
    res.columns = [str(c) for c in res.columns]
    buf = io.BytesIO()
    res.to_parquet(buf, index=False)
    return buf.getvalue(), {"rows_in": int(len(df)), "rows_out": int(len(res)), "columns": [str(c) for c in res.columns], "input": item["name"]}


def write_dataset(folder_id: str, name: str, data: bytes, source: dict, item_id: Optional[str] = None) -> dict:
    """Write (or replace) a parquet dataset in Files with a transaction."""
    import dataset_versions
    import db
    import drive
    import pipeline_datasets

    fname = name if name.endswith(".parquet") else f"{name}.parquet"
    item = db.drive_get(item_id) if item_id else None
    if not item or item.get("trashed_at"):
        item = next((c for c in db.drive_list(folder_id) if c["kind"] == "file" and c["name"] == fname and not c.get("trashed_at")), None)
    if item:
        pipeline_datasets._replace_content(item, data)
        item = db.drive_get(item["id"])
    else:
        item = drive._store(folder_id, drive._clean_name(fname), io.BytesIO(data), len(data), pipeline_datasets.PARQUET)
    tx = dataset_versions.record(item["id"], data, "build", {**source, "transaction": "SNAPSHOT"})
    return {"item_id": item["id"], "name": item["name"], "transaction": tx["id"]}


def _batch_block(dep: dict, who: str) -> Optional[str]:
    """Why the current principal may not run a batch deployment (None: it may): the viewer role on its objective and
    on the model of the release, read access to the input dataset, the editor role on the output folder and on the
    output dataset. Nothing is read: only the items' access is checked."""
    import db
    import drive

    def denied(e: HTTPException) -> bool:
        return e.status_code in (401, 403, 404)

    try:
        _can(dep, "viewer")
    except HTTPException as e:
        if denied(e):
            return f"{who} cannot see its modeling objective ({e.detail})"
        raise
    try:
        _target(dep)
    except HTTPException as e:
        if denied(e) and e.status_code != 409:
            return f"{who} cannot see the model of the release ({e.detail})"
        raise
    out_item = db.drive_get(dep["output_item_id"]) if dep.get("output_item_id") else None
    for item_id, need, what in ((dep.get("input_item_id"), "viewer", "read the input dataset"),
                                (dep.get("output_folder_id"), "editor", "write to the output folder"),
                                (out_item["id"] if out_item and not out_item.get("trashed_at") else None, "editor", "write the output dataset")):
        if not item_id:
            continue
        try:
            drive._item(item_id, need=need)
        except HTTPException as e:
            if denied(e):
                return f"{who} cannot {what} ({e.detail})"
            raise
    return None


def _batch_principal(dep: dict, caller: Optional[dict]) -> tuple[Optional[dict], str]:
    """(who a batch run acts as, their label): `caller` (Build now: the user who clicked it, looked up again; a service
    as it is), else the deployment's owner. run_as.OwnerUnavailable when that user is gone or deactivated. Sign-in
    off: (None, "the system")."""
    import run_as

    if not auth.enabled():
        return None, "the system"
    if caller is not None and (caller.get("service") or caller.get("id") in (None, "local", "system")):
        return caller, str(caller.get("username") or caller.get("id") or "the caller")
    uid = (caller or {}).get("id") or dep.get("owner") or dep.get("created_by")
    p = run_as.owner_principal(uid, "the batch deployment")
    return p, ("you" if caller else f"its owner {run_as.who(uid)}")


def _run_batch(dep_id: str, trigger: str, caller: Optional[dict] = None) -> None:
    """One batch run, as `caller` (Build now) or the deployment's owner — never as the system (sign-in on)."""
    import run_as

    lock = _start_locks.setdefault(dep_id, threading.Lock())
    with lock:
        try:
            dep = _read(dep_id)
        except HTTPException:
            return
        run = {"id": f"run-{uuid.uuid4().hex[:10]}", "at": _now(), "trigger": trigger, "status": "running"}
        try:
            stamp = _input_stamp(dep.get("input_item_id"))  # what this run reads: a later change rebuilds again
        except Exception:  # noqa: BLE001
            stamp = None
        # a run still "running" here was cut off by a process that stopped (this process holds the lock)
        earlier = [{**r, "status": "failed", "error": "the process running it stopped"} if r.get("status") == "running" else r for r in dep.get("runs") or []]
        _note(dep_id, state_batch="running", runs=[run, *earlier][:50], **({"input_stamp": stamp} if stamp else {}))
        started = time.monotonic()
        acting = None
        try:
            # as the owner / the user who clicked Build now, checked before anything is read or written
            try:
                p, who = _batch_principal(dep, caller)
            except run_as.OwnerUnavailable as e:
                raise HTTPException(403, f"did not run: {e}") from None
            acting = run_as.acting_as(p)
            acting.__enter__()
            why = _batch_block(dep, who)
            if why:
                raise HTTPException(403, f"did not run: {why}")
            rec, v = _target(dep)
            data, info = run_model_on_dataset(rec, v, dep["input_item_id"], f"batch-{dep_id[4:]}")
            out = write_dataset(dep["output_folder_id"], dep["output_name"], data,
                                {"kind": "model_batch_deployment", "id": dep_id, "name": dep["name"], "model": rec["name"], "model_version": v["version"]},
                                dep.get("output_item_id"))
            run.update(status="succeeded", model=rec["name"], version=v["version"], version_rid=v["rid"], **info, output=out)
            _log(dep_id, "INFO", f"batch run {run['id']}: {info['rows_out']} rows written to {out['name']} with {rec['name']} {v['version']}")
            changes = {"output_item_id": out["item_id"], "version_id": v["id"], "version": v["version"], "health": "healthy", "error": None}
        except Exception as e:  # noqa: BLE001
            msg = str(getattr(e, "detail", None) or e)[:2000]
            run.update(status="failed", error=msg)
            _log(dep_id, "ERROR", f"batch run {run['id']} failed: {msg}")
            changes = {"health": "failed", "error": msg}
        finally:
            if acting is not None:
                acting.__exit__(None, None, None)
        run["ms"] = int((time.monotonic() - started) * 1000)
        dep = _read(dep_id)
        runs_ = [run if r["id"] == run["id"] else r for r in dep.get("runs") or []]
        _note(dep_id, state_batch=run["status"], runs=runs_, **changes)
    # the input changed while this run read it (a commit then found the run busy): rebuilt again now, not at the
    # monitor's next check
    if dep.get("input_item_id"):
        try:
            _check_batch_inputs(dep["input_item_id"])
        except Exception:  # noqa: BLE001 - the monitor's check still finds it
            pass


@router.post("/{dep_id}/build")
def build_batch(dep_id: str, wait: bool = False) -> dict:
    """Run a batch deployment now (the output dataset is rebuilt with the current release)."""
    dep = _read(dep_id)
    _can(dep, "editor")
    if dep["kind"] != "batch":
        raise HTTPException(400, "only batch deployments are built")
    # Build now runs as the user who clicked it (the scheduled triggers as the owner)
    if wait:
        _run_batch(dep_id, "manual", auth.current())
    else:
        threading.Thread(target=_run_batch, args=(dep_id, "manual", auth.current()), daemon=True).start()
    return get_deployment(dep_id)


def _take_over(dep: dict) -> dict:
    """A user enabling a batch deployment or saving its triggers becomes its owner (the triggered runs then act as
    them): they must be able to run it themselves (403 with the reason, nothing changed). {} for the system, a
    service and sign-in off (the owner stays)."""
    uid = auth.actor_id()
    if not uid:
        return {}
    why = _batch_block(dep, "you")
    if why:
        raise HTTPException(403, f"You cannot take this batch deployment over (its runs would then run as you): {why}")
    return {"owner": uid}


class TriggersIn(BaseModel):
    # batch deployments: rebuild when the input dataset updates (they always rebuild on a new release)
    rebuild_on_input: bool = True


@router.put("/{dep_id}/triggers")
def update_triggers(dep_id: str, req: TriggersIn) -> dict:
    dep = _read(dep_id)
    _can(dep, "editor")
    if dep["kind"] != "batch":
        raise HTTPException(400, "only batch deployments have build triggers")
    changes: dict = {"rebuild_on_input": req.rebuild_on_input, **_take_over(dep)}
    if req.rebuild_on_input:
        changes["input_stamp"] = None  # the input as it is now counts as built: only later changes rebuild
    _note(dep_id, **changes)
    return get_deployment(dep_id)


@router.get("/monitor/status")
def monitor_status() -> dict:
    t = _monitor.get("thread")
    return {"running": bool(t and t.is_alive()), "interval_s": MONITOR_S, "last_at": _monitor.get("last_at"), "error": _monitor.get("error"),
            "workers": len(WORKERS), "restarting": sorted(_recover)}


def shutdown() -> None:
    for dep_id in list(WORKERS):
        w = WORKERS.pop(dep_id, None)
        if w:
            _close_worker(w)
