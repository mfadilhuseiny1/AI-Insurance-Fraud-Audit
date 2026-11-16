"""Logic Flows [Sunset] (palantir.com/docs/foundry/building-pipelines/logic-flows-overview): automations run as builds.

An automation is a script over the platform's APIs that takes resources as parameters and a JSON configuration; a
connected flow is one instance of it, created in a Project (a `<name>.logicflow` Files item, so the Project's roles
govern it). Connected flows are validated when created, cannot be edited (archive one and create another), keep no
state between runs, and run manually (Build) or on a schedule (cron + time zone). Each run is recorded with its logs.

Automations:
- Compass Files Lister: lists the RIDs of the resources in an input folder into an output code repository — a pull
  request on a new branch that creates or overwrites `<generated_file_path>/rids.json` (default `compass-lister`);
  with `merge_when_ready` it is merged when the repository's conditions allow (checks, approvals).
- AIP Logic runner: runs a Logic function with fixed inputs (`apply` writes its edits). It runs in the Ontology, so a
  build or the schedule may target a global Nexus branch (`branch_id`): the branch's objects, edits kept on the
  branch, the branch's function versions (recorded per run). A schedule whose branch merged or closed is refused
  and paused.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import re
import threading
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/logic-flows")
FLOW_TYPE = "application/vnd.bluesandai.logic-flow+json"
_lock = threading.RLock()
TICK_S = 30
_started = False

AUTOMATIONS = {
    "compass-files-lister": {
        "name": "Compass Files Lister",
        "description": "Lists the RIDs of the resources in an input folder into a code repository (a pull request writing rids.json).",
        "parameters": [
            {"key": "input_folder", "label": "Input folder", "kind": "folder"},
            {"key": "output_repository", "label": "Output repository", "kind": "code_repository"},
        ],
        "configuration": {"generated_file_path": "compass-lister", "merge_when_ready": False},
    },
    "aip-logic": {
        "name": "AIP Logic runner",
        "description": "Runs an AIP Logic function with fixed inputs (optionally applying its edits) — on main or on a global Nexus branch.",
        "parameters": [{"key": "logic_function", "label": "Logic function", "kind": "logic"}],
        "configuration": {"inputs": {}, "apply": False},
        # runs in the Ontology: a run (or the schedule) may target a global branch
        "branchable": True,
    },
}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    p = auth.current() or {}
    return p.get("id") or "local"


def _flows() -> list[tuple[dict, dict]]:
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND d.content_type = %s", (FLOW_TYPE,), limit=2000)
    out = []
    for it in items:
        try:
            out.append((it, json.loads(drive.read_bytes(it))))
        except Exception:  # noqa: BLE001 - an unreadable flow is skipped
            continue
    return out


def _load(item_id: str, need: str = "viewer") -> tuple[dict, dict]:
    item = drive._item(item_id, need=need)
    if item.get("content_type") != FLOW_TYPE:
        raise HTTPException(404, "not a connected flow")
    return item, json.loads(drive.read_bytes(item))


def _write(item: dict, flow: dict) -> None:
    import pipeline_datasets

    data = json.dumps(flow, indent=1).encode()
    pipeline_datasets._replace_content(item, data, FLOW_TYPE)


def _project_of(item_id: str) -> Optional[str]:
    import resource_queues

    return resource_queues.project_of(item_id)


def _code_repo(repo_id: str, role: str = "viewer") -> dict:
    """A Code Repository with the caller's access checked as /api/code-repos/{id} checks it (its markings and the
    `role` on its Project): 404 when it is missing or the caller cannot see it, 403 when they see it without the role."""
    import code_repos

    rec = code_repos._repo(repo_id)
    if not auth.visible_resources("code_repo", [rec]):
        raise HTTPException(404, "repository not found")
    auth.check_resource("code_repo", repo_id, role)
    return rec


def validate(automation: str, project_id: str, parameters: dict, configuration: dict) -> list[str]:
    """What is wrong with a connected flow's parameters and configuration (empty: valid)."""
    problems: list[str] = []
    a = AUTOMATIONS.get(automation)
    if not a:
        return [f"unknown automation {automation}"]
    if automation == "compass-files-lister":
        folder = parameters.get("input_folder")
        repo = parameters.get("output_repository")
        if not folder:
            problems.append("set the input folder")
        else:
            try:
                f = drive._item(folder, need="viewer")
                if f["kind"] not in ("folder", "project"):
                    problems.append("the input folder is not a folder")
                elif _project_of(folder) != project_id:
                    problems.append("connected flows live in the same Project as their parameters: the input folder is in another Project")
            except HTTPException as e:
                problems.append(f"input folder: {e.detail}")
        if not repo:
            problems.append("set the output repository")
        else:
            try:
                # the flow branches, commits, opens and merges pull requests in the repository: Editor of it (its
                # markings), checked again for whoever runs the flow (a schedule: its owner)
                _code_repo(repo, "editor")
            except HTTPException as e:
                problems.append(f"output repository: {e.detail}")
        path = str(configuration.get("generated_file_path", "compass-lister")).strip().strip("/")
        if path and not re.fullmatch(r"[A-Za-z0-9_.\- ]+(/[A-Za-z0-9_.\- ]+)*", path):
            problems.append("generated_file_path is a relative path in the repository")
        unknown = [k for k in configuration if k not in a["configuration"]]
        if unknown:
            problems.append(f"unknown configuration keys: {', '.join(unknown)}")
        if "merge_when_ready" in configuration and not isinstance(configuration["merge_when_ready"], bool):
            problems.append("merge_when_ready is true or false")
    if automation == "aip-logic":
        import ontology

        logic_id = parameters.get("logic_function")
        if not logic_id:
            problems.append("set the Logic function")
        else:
            try:
                ontology._logic(logic_id)
            except HTTPException as e:
                problems.append(f"Logic function: {e.detail}")
        unknown = [k for k in configuration if k not in a["configuration"]]
        if unknown:
            problems.append(f"unknown configuration keys: {', '.join(unknown)}")
        if not isinstance(configuration.get("inputs", {}), dict):
            problems.append("inputs is an object of the Logic function's input values")
        if "apply" in configuration and not isinstance(configuration["apply"], bool):
            problems.append("apply is true or false")
    return problems


def _branch_check(flow: dict, branch_id: Optional[str]) -> Optional[dict]:
    """The open global branch a run or schedule targets (None: main). Refused for automations outside the Ontology
    and for a branch that merged or closed."""
    if not branch_id:
        return None
    if not AUTOMATIONS.get(flow["automation"], {}).get("branchable"):
        raise HTTPException(400, f"{AUTOMATIONS.get(flow['automation'], {}).get('name', flow['automation'])} does not run in the Ontology: it has no branch to run on")
    import ontology
    import ontology_branches

    with ontology._lock:
        b = ontology_branches._branch(branch_id)
    if b["status"] != "open":
        raise HTTPException(400, f"the branch {b['name']} is {b['status']}: connected flows run only on open branches")
    return {"id": b["id"], "name": b["name"]}


class FlowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    automation: str = "compass-files-lister"
    project_id: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)


def _public(item: dict, flow: dict) -> dict:
    can_edit = True
    try:
        drive._item(item["id"], need="editor")
    except HTTPException:
        can_edit = False
    labels = {}
    for k, v in (flow.get("parameters") or {}).items():
        if k == "output_repository":
            try:
                # the repository's name only for those who can see it
                labels[k] = _code_repo(v)["name"]
            except HTTPException:
                labels[k] = v
        elif k == "logic_function":
            try:
                import ontology

                labels[k] = ontology._logic(v)["name"]
            except HTTPException:
                labels[k] = v
        else:
            it = db.drive_get(v) if isinstance(v, str) else None
            labels[k] = "/".join(p["name"] for p in db.drive_path(v)) if it else v
    return {**flow, "id": item["id"], "name": item["name"].removesuffix(".logicflow"), "path": [p["name"] for p in db.drive_path(item["id"])[:-1]],
            "automation_name": AUTOMATIONS.get(flow["automation"], {}).get("name", flow["automation"]), "parameter_labels": labels, "can_edit": can_edit,
            "branchable": bool(AUTOMATIONS.get(flow["automation"], {}).get("branchable")),
            "runs": (flow.get("runs") or [])[:20]}


@router.get("/automations")
def automations() -> list[dict]:
    return [{"id": k, **v} for k, v in AUTOMATIONS.items()]


@router.post("/validate")
def validate_route(req: FlowIn) -> dict:
    return {"problems": validate(req.automation, req.project_id, req.parameters, {**req.configuration})}


@router.post("")
def create(req: FlowIn) -> dict:
    proj = drive._item(req.project_id, need="editor")
    if proj["kind"] != "project":
        raise HTTPException(400, "connected flows are created in a Project")
    config = {**AUTOMATIONS.get(req.automation, {}).get("configuration", {}), **req.configuration}
    problems = validate(req.automation, req.project_id, req.parameters, req.configuration)
    if problems:
        raise HTTPException(400, "; ".join(problems))
    flow = {"version": 1, "automation": req.automation, "project_id": req.project_id, "parameters": req.parameters, "configuration": config,
            "created_at": _now(), "created_by": _me(), "archived": False, "schedule": None, "runs": []}
    data = json.dumps(flow, indent=1).encode()
    name = req.name.strip()
    item = drive._store(proj["id"], drive._free_name(proj["id"], f"{name}.logicflow"), io.BytesIO(data), len(data), FLOW_TYPE)
    return _public(db.drive_get(item["id"]), flow)


@router.get("")
def list_flows(archived: bool = False) -> list[dict]:
    out = []
    for item, flow in _flows():
        try:
            drive._item(item["id"], need="viewer")
        except HTTPException:
            continue
        if bool(flow.get("archived")) != archived:
            continue
        out.append(_public(item, flow))
    return sorted(out, key=lambda f: (f["automation_name"], f["name"].lower()))


@router.get("/by-item/{item_id}")
def get_flow(item_id: str) -> dict:
    item, flow = _load(item_id)
    return _public(item, flow)


class ArchiveIn(BaseModel):
    archived: bool = True


@router.post("/{item_id}/archive")
def archive(item_id: str, req: ArchiveIn) -> dict:
    with _lock:
        item, flow = _load(item_id, "editor")
        flow["archived"] = req.archived
        if req.archived and flow.get("schedule"):
            flow["schedule"]["enabled"] = False
        _write(item, flow)
    return _public(item, flow)


class ScheduleIn(BaseModel):
    cron: str = ""
    timezone: str = "UTC"
    enabled: bool = True
    # run on a global Nexus branch (Ontology automations only); refused once the branch merges or closes
    branch_id: Optional[str] = None


@router.put("/{item_id}/schedule")
def set_schedule(item_id: str, req: ScheduleIn) -> dict:
    import pipeline_runtime

    with _lock:
        item, flow = _load(item_id, "editor")
        if flow.get("archived"):
            raise HTTPException(400, "an archived connected flow does not run")
        if not req.cron.strip():
            flow["schedule"] = None
        else:
            try:
                pipeline_runtime.next_runs(req.cron.strip(), req.timezone, 1)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(400, f"invalid schedule: {getattr(e, 'detail', e)}") from None
            branch = _branch_check(flow, req.branch_id)
            flow["schedule"] = {"cron": req.cron.strip(), "timezone": req.timezone, "enabled": req.enabled, "owner": _me(),
                                "last_minute": (flow.get("schedule") or {}).get("last_minute"),
                                "branch_id": branch["id"] if branch else None, "branch_name": branch["name"] if branch else None}
        _write(item, flow)
    return _public(item, flow)


# ------------------------------------------------------------------------------------------------
# running
# ------------------------------------------------------------------------------------------------


def _compass_files_lister(flow: dict, log: list[str]) -> dict:
    import code_repos

    params, config = flow["parameters"], flow["configuration"]
    folder = drive._item(params["input_folder"], need="viewer")
    children = [c for c in db.drive_list(folder["id"]) if not c.get("trashed_at")]
    resources = []
    for c in sorted(children, key=lambda x: x["name"].lower()):
        kind = "folder" if c["kind"] in drive.CONTAINERS else ("dataset" if c["name"].lower().endswith((".parquet", ".csv", ".tsv", ".json", ".jsonl"))
                                                               else (c.get("content_type") or "file"))
        resources.append({"rid": f"ri.compass.main.{'folder' if kind == 'folder' else 'resource'}.{c['id']}", "name": c["name"], "type": kind})
    log.append(f"listed {len(resources)} resources of {folder['name']}")
    payload = json.dumps({"folder": f"ri.compass.main.folder.{folder['id']}", "folder_name": folder["name"], "generated_at": _now(),
                          "resources": resources}, indent=2) + "\n"
    repo_id = params["output_repository"]
    # whoever runs the flow (a schedule: its owner) edits the repository: Editor of it, its markings
    rec = _code_repo(repo_id, "editor")
    base = (str(config.get("generated_file_path") or "compass-lister")).strip().strip("/")
    path = f"{base}/rids.json" if base else "rids.json"
    default = rec["default_branch"]
    current = code_repos._branch(rec, default)["files"].get(path)
    if current == payload or (current and json.loads(current).get("resources") == resources):
        log.append(f"{path} is up to date on {default}: no pull request")
        return {"pull_request": None, "resources": len(resources), "changed": False}
    branch = f"logic-flows/compass-lister-{uuid.uuid4().hex[:6]}"
    code_repos.create_branch(repo_id, code_repos.BranchIn(name=branch, source=default))
    files = dict(code_repos._branch(code_repos._repo(repo_id), branch)["files"])
    files[path] = payload
    code_repos.save_files(repo_id, code_repos.FilesPut(branch=branch, files=files))
    c = code_repos.commit(repo_id, code_repos.CommitIn(branch=branch, message=f"Compass Files Lister: {len(resources)} resources of {folder['name']}"))
    log.append(f"committed {path} on {branch} ({c['id'][:10]})")
    pr = code_repos.create_pr(repo_id, code_repos.PrIn(source=branch, target=default, title=f"Compass Files Lister: {folder['name']}",
                                                       description=f"Generated by the connected flow. {len(resources)} resources listed into `{path}`."))
    log.append(f"opened pull request #{pr['id']} into {default}")
    merged = False
    if config.get("merge_when_ready"):
        try:
            code_repos.run_checks(repo_id, c["id"], branch)
        except Exception as e:  # noqa: BLE001
            log.append(f"checks could not run: {e}")
        state = code_repos.get_pr(repo_id, pr["id"])["state"]
        if state["can_merge"]:
            mode = code_repos._repo(repo_id)["settings"]["merge_modes"][0]
            code_repos.merge_pr(repo_id, pr["id"], code_repos.PrMerge(mode=mode))
            merged = True
            log.append(f"merged #{pr['id']} ({mode})")
        else:
            log.append("not merged yet: " + "; ".join(state["blockers"]))
    return {"pull_request": pr["id"], "branch": branch, "path": path, "resources": len(resources), "changed": True, "merged": merged}


def _aip_logic(flow: dict, log: list[str]) -> dict:
    """Run the Logic function; on a global branch it reads the branch's objects, applied edits stay on the branch and
    function-backed actions run the branch's function versions (ontology_branches.run_logic_on)."""
    import functions_registry
    import ontology
    import ontology_branches

    logic_id = flow["parameters"]["logic_function"]
    config = flow["configuration"]
    trigger = {"kind": "logic_flow", "automation_id": flow["_item_id"], "automation": f"Logic Flow {flow['_item_name']}"}
    branch = flow.get("_branch")
    ran: list[dict] = []
    t_ran = functions_registry.RAN.set(ran)
    try:
        if branch:
            r = ontology_branches.run_logic_on(branch["id"], logic_id, config.get("inputs") or {}, bool(config.get("apply")), trigger=trigger)
            ran = (r.get("scenario") or {}).get("functions") or []
            log.append(f"ran on the branch {branch['name']} (its objects; edits stay on the branch)")
        else:
            r = ontology.run_logic(logic_id, config.get("inputs") or {}, bool(config.get("apply")), trigger=trigger)
    finally:
        functions_registry.RAN.reset(t_ran)
    for f in ran:
        log.append(f"function {f['function']} {f['version']}{' (Branched pre-release)' if f['branched'] else ''}: {f['calls']} call{'s' if f['calls'] != 1 else ''}, {f['status']}")
    log.append(f"Logic run {r['id']}: {r['status']}, {len(r.get('edits') or [])} edits proposed, {len(r.get('applied') or [])} applied")
    if r["status"] != "succeeded":
        raise ValueError(f"the Logic run failed: {r.get('error')}")
    return {"logic_run": r["id"], "logic_id": logic_id, "edits": len(r.get("edits") or []), "applied": len(r.get("applied") or []), "functions": ran}


RUNNERS = {"compass-files-lister": _compass_files_lister, "aip-logic": _aip_logic}


def run(item_id: str, trigger: str = "manual", branch_id: Optional[str] = None) -> dict:
    # a scheduled run acts as the user who set the schedule up (_tick): it needs their Editor role and markings too
    item, flow = _load(item_id, "editor")
    if flow.get("archived"):
        raise HTTPException(400, "an archived connected flow does not run")
    import resource_queues

    started = time.monotonic()
    rec: dict[str, Any] = {"id": "lfrun-" + uuid.uuid4().hex[:10], "at": _now(), "trigger": trigger, "by": _me(), "status": "running"}
    # a manual build names its branch; a scheduled one runs on the schedule's branch
    if trigger != "manual":
        branch_id = (flow.get("schedule") or {}).get("branch_id")
    try:
        branch = _branch_check(flow, branch_id)
    except HTTPException as e:
        if trigger == "manual":
            raise
        # the schedule's branch merged or closed (or is gone): the run is refused and the schedule pauses
        rec.update(status="failed", error=f"{e.detail} — the schedule is paused", logs=[], ms=0,
                   branch={"id": branch_id, "name": (flow.get("schedule") or {}).get("branch_name")})
        with _lock:
            item, flow = _load(item_id, "viewer")
            if flow.get("schedule"):
                flow["schedule"]["enabled"] = False
                flow["schedule"]["paused_reason"] = str(e.detail)
            flow["runs"] = [rec, *(flow.get("runs") or [])][:50]
            _write(item, flow)
        return rec
    if branch:
        rec["branch"] = branch
    log: list[str] = []
    lease = resource_queues.acquire(item_id, 1, f"Connected flow {item['name']}", "logic_flow")
    try:
        problems = validate(flow["automation"], flow["project_id"], flow["parameters"], {k: v for k, v in flow["configuration"].items()})
        if problems:
            raise ValueError("; ".join(problems))
        rec["result"] = RUNNERS[flow["automation"]]({**flow, "_item_id": item_id, "_item_name": item["name"].removesuffix(".logicflow"), "_branch": branch}, log)
        rec["status"] = "succeeded"
    except Exception as e:  # noqa: BLE001
        rec.update(status="failed", error=str(getattr(e, "detail", e))[:800])
    finally:
        resource_queues.release(lease)
    rec["logs"] = log
    rec["ms"] = int((time.monotonic() - started) * 1000)
    with _lock:
        item, flow = _load(item_id, "viewer")
        flow["runs"] = [rec, *(flow.get("runs") or [])][:50]
        _write(item, flow)
    return rec


class RunIn(BaseModel):
    # build on a global Nexus branch (Ontology automations only)
    branch_id: Optional[str] = None


@router.post("/{item_id}/run")
def run_route(item_id: str, req: Optional[RunIn] = None) -> dict:
    return run(item_id, "manual", (req or RunIn()).branch_id)


def _tick() -> None:
    from zoneinfo import ZoneInfo

    import pipeline_runtime

    now = dt.datetime.now(dt.timezone.utc)
    for item, flow in _flows():
        s = flow.get("schedule") or {}
        if not s.get("enabled") or flow.get("archived"):
            continue
        try:
            local = now.astimezone(ZoneInfo(s.get("timezone") or "UTC"))
        except Exception:  # noqa: BLE001
            local = now
        minute = local.strftime("%Y-%m-%dT%H:%M")
        if s.get("last_minute") == minute or not pipeline_runtime.cron_matches(s["cron"], local):
            continue
        with _lock:
            it, fl = _load(item["id"], "viewer")
            if fl.get("schedule"):
                fl["schedule"]["last_minute"] = minute
                _write(it, fl)
        # the scheduled run acts as the user who set the schedule up, never as the system (run_as.py)
        import run_as

        try:
            principal = run_as.owner_principal(s.get("owner"), "the schedule")
        except run_as.OwnerUnavailable as e:
            with _lock:
                it, fl = _load(item["id"], "viewer")
                fl["runs"] = [{"id": "lfrun-" + uuid.uuid4().hex[:10], "at": _now(), "trigger": "schedule", "by": None, "status": "failed",
                               "error": f"did not run: {e}", "logs": [], "ms": 0}, *(fl.get("runs") or [])][:50]
                _write(it, fl)
            continue
        token = auth._principal.set(principal)
        try:
            run(item["id"], "schedule")
        except Exception as e:  # noqa: BLE001 - the owner lost the Editor role or a marking on the flow: recorded
            auth._principal.set(None)
            with _lock:
                it, fl = _load(item["id"], "viewer")
                fl["runs"] = [{"id": "lfrun-" + uuid.uuid4().hex[:10], "at": _now(), "trigger": "schedule", "by": s.get("owner"), "status": "failed",
                               "error": f"did not run: the schedule's owner {run_as.who(s.get('owner'))} cannot run it now "
                                        f"({getattr(e, 'detail', None) or e}); an Editor must take it over (save the schedule again)",
                               "logs": [], "ms": 0}, *(fl.get("runs") or [])][:50]
                _write(it, fl)
        finally:
            auth._principal.reset(token)


def start() -> None:
    global _started
    if _started:
        return
    _started = True

    def loop() -> None:
        while True:
            try:
                _tick()
            except Exception:  # noqa: BLE001
                pass
            time.sleep(TICK_S)

    threading.Thread(target=loop, name="logic-flows", daemon=True).start()
