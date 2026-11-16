"""Functions registry, modelled on Foundry's functions: publishing, versions, execution, metrics and the API gateway.

A Python repository's `@function`s (code_functions.py) are published to the registry when a semantic version tag
(`1.2.3`, `0.4.0-rc.1`) is created in Code Repositories, or with Publish. Each release records every function's
signature (inputs, output, declared edits, API name) and is checked for backward compatibility against the previous
release: a dropped function, a dropped or reordered input, a new required input and changed input or output types
are breaking (they belong in a major version, except during 0.y.z development).

Consumers pin a version or a range (`^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0`, `latest`): the greatest satisfying
release runs (pre-releases only when pinned). Functions run in the repository runner with the caller's job token, so
they read only what their user may read; a function times out after its configured limit (60 s by default) and
configurations are inherited by later stable versions. Ontology edit functions return edits that only an action
(a function rule) applies; query functions with an API name are executed through the API gateway at
/api/functions/queries/<apiName>/execute (latest release). Repositories hold custom aliases (configuration
values) and model aliases (language models for functions.language_models.chat).

Each execution is recorded with its duration and failure category (runtime, resource limit, user-facing, invalid
inputs, invalid output, undeclared edits): metrics over 30 days (success / failure, p95), run history over 7 days,
and monitors (p95 duration, failures, user-facing failures in a window) that raise alerts.

Records are JSON under data/functions/. Mounted by server.py under /api/functions.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import contextvars

import auth
import ontology

router = APIRouter(prefix="/api/functions")

DIR: Path = Path()
SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")
DEFAULT_TIMEOUT_S = 60
MAX_TIMEOUT_S = 280
RUNS_KEPT_DAYS = 30
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "functions"
    for d in ("repos", "runs"):
        (DIR / d).mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS.update({"run_function": run_function, "function_info": function_info, "check_function_ref": check_ref,
                                 "branch_function_checks": branch_checks})
    # the global branch hooks are chains (Workshop, restricted views add theirs): join them, never replace them
    _chain_hook("branch_merged", branch_merged)
    _chain_hook("branch_closed", branch_closed)
    import code_repos

    code_repos.TAG_HOOKS.append(_on_tag)


def _in_chain(h: Any, fn: Any, depth: int = 0) -> bool:
    """Whether a hook chain (wrappers holding the previous hook in their closure) already calls fn."""
    if h is None or depth > 10:
        return False
    if h is fn:
        return True
    cells = []
    for cell in getattr(h, "__closure__", None) or []:
        try:
            cells.append(cell.cell_contents)
        except ValueError:
            pass
    return any(callable(x) and _in_chain(x, fn, depth + 1) for x in cells)


def _chain_hook(name: str, fn: Any) -> None:
    prev = ontology.MODEL_HOOKS.get(name)
    if prev is None:
        ontology.MODEL_HOOKS[name] = fn
        return
    if _in_chain(prev, fn):
        return

    def hook(branch_id: str) -> Any:
        # the hooks before (module and view merges) run first; the result is the functions' (published targets)
        try:
            prev(branch_id)
        except Exception:  # noqa: BLE001 - another resource's merge never stops the functions'
            pass
        return fn(branch_id)

    ontology.MODEL_HOOKS[name] = hook


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _repo_file(repo_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", repo_id):
        raise HTTPException(404, "repository not found")
    return DIR / "repos" / f"{repo_id}.json"


def _repo_data(repo_id: str) -> dict:
    d = ontology._read(_repo_file(repo_id), None) or {}
    d.setdefault("releases", [])
    d.setdefault("aliases", {"custom": {}, "model": {}})
    d.setdefault("config", {})
    d.setdefault("monitors", {})
    d.setdefault("sources", [])  # REST API source API names imported into the repository
    return d


def _save_repo(repo_id: str, d: dict) -> None:
    ontology._write(_repo_file(repo_id), d)


def fid_of(repo_id: str, file: str, name: str) -> str:
    return "fn-" + hashlib.sha1(f"{repo_id}:{file}:{name}".encode()).hexdigest()[:12]


# ------------------------------------------------------------------------------------------------
# semantic versions
# ------------------------------------------------------------------------------------------------


def parse(v: str) -> Optional[tuple]:
    m = SEMVER.match(v.strip())
    if not m:
        return None
    pre = m.group(4)
    # a release sorts above its pre-releases
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if pre else 1, pre or "")


def _cmp_ok(v: tuple, op: str, w: tuple) -> bool:
    a, b = v[:4], w[:4]
    return {"=": a == b, ">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b}[op]


def satisfies(version: str, rng: Optional[str]) -> bool:
    v = parse(version)
    if v is None:
        return False
    rng = (rng or "latest").strip()
    if rng in ("latest", "*", ""):
        return v[3] == 1
    if SEMVER.match(rng):
        return parse(rng)[:4] == v[:4] and (parse(rng)[4] == v[4])  # type: ignore[index]
    if v[3] == 0:
        return False
    if rng[0] in "^~":
        base = parse(rng[1:])
        if base is None:
            return False
        if rng[0] == "^":
            upper = (base[0] + 1, 0, 0, 0) if base[0] > 0 else (0, base[1] + 1, 0, 0)
        else:
            upper = (base[0], base[1] + 1, 0, 0)
        return v[:4] >= base[:4] and v[:4] < upper
    for part in rng.split():
        m = re.match(r"^(>=|<=|>|<|=)?(.+)$", part)
        w = parse(m.group(2)) if m else None
        if w is None or not _cmp_ok(v, m.group(1) or "=", w):
            return False
    return True


def resolve(versions: list[str], rng: Optional[str]) -> Optional[str]:
    ok = [v for v in versions if satisfies(v, rng)]
    return max(ok, key=parse) if ok else None  # type: ignore[arg-type]


# ------------------------------------------------------------------------------------------------
# publishing
# ------------------------------------------------------------------------------------------------


def _describe(repo_id: str, commit: str) -> list[dict]:
    import code_repos

    import functions_ts

    rec = code_repos._repo(repo_id)
    files = code_repos._commit_files(repo_id, commit)
    ts_funcs: list[dict] = []
    if functions_ts.has_ts(files):
        # TypeScript v2 functions (ts-functions/src): published with the Python ones
        try:
            ts_funcs = functions_ts.describe(files)
        except RuntimeError as e:
            raise HTTPException(400, f"the repository's TypeScript functions could not be read: {e}") from None
    res = code_repos._run(files, {"mode": "describe", "timeout_s": 120}, rec)
    if not res.get("ok"):
        if ts_funcs:
            return ts_funcs
        raise HTTPException(400, f"the repository's functions could not be read: {res.get('error') or res.get('errors')}")
    return (res.get("functions") or []) + ts_funcs


def compatibility(old: list[dict], new: list[dict]) -> list[dict]:
    """Breaking changes between two releases' signatures."""
    out = []
    now = {(f["file"], f["name"]): f for f in new}
    for f in old:
        g = now.get((f["file"], f["name"]))
        name = f"{f['file']}:{f['name']}"
        if not g:
            out.append({"function": name, "change": "dropped the function"})
            continue
        old_inputs = [i["name"] for i in f["inputs"]]
        new_inputs = [i["name"] for i in g["inputs"]]
        for n in old_inputs:
            if n not in new_inputs:
                out.append({"function": name, "change": f"dropped the input {n}"})
        kept = [n for n in new_inputs if n in old_inputs]
        if kept != [n for n in old_inputs if n in new_inputs]:
            out.append({"function": name, "change": "reordered inputs"})
        old_by = {i["name"]: i for i in f["inputs"]}
        for i in g["inputs"]:
            if i["name"] not in old_by and i["required"]:
                out.append({"function": name, "change": f"added the required input {i['name']}"})
            elif i["name"] in old_by and old_by[i["name"]]["type"] != i["type"]:
                out.append({"function": name, "change": f"changed the type of {i['name']} from {old_by[i['name']]['type']} to {i['type']}"})
        if f["output"] != g["output"]:
            out.append({"function": name, "change": f"changed the output from {f['output']} to {g['output']}"})
    return out


def publish(repo_id: str, version: str, commit: str, strict: bool = False) -> dict:
    v = parse(version)
    if v is None:
        raise HTTPException(400, "a function release is a semantic version, like 1.2.3 or 0.1.0-rc.1")
    funcs = _describe(repo_id, commit)
    with _lock:
        d = _repo_data(repo_id)
        if any(r["version"] == version for r in d["releases"]):
            raise HTTPException(409, f"version {version} is already released (releases are immutable)")
        prev = max((r for r in d["releases"] if parse(r["version"])[3] == 1 and parse(r["version"]) < v), key=lambda r: parse(r["version"]), default=None)
        breaking = compatibility(prev["functions"], funcs) if prev else []
        major_bump = prev is not None and v[0] > parse(prev["version"])[0]
        warn = bool(breaking) and v[0] >= 1 and not major_bump
        if warn and strict:
            raise HTTPException(409, "breaking changes need a major version: " + "; ".join(f"{b['function']} {b['change']}" for b in breaking[:5]))
        for f in funcs:
            f["id"] = fid_of(repo_id, f["file"], f["name"])
            if f.get("interface_error"):
                raise HTTPException(400, f"{f['name']} does not implement {f['implements']}: {f['interface_error']}")
            if f.get("api_name"):
                if not re.fullmatch(r"[a-z][A-Za-z0-9]{0,98}", f["api_name"]):
                    raise HTTPException(400, f"{f['name']}: an API name is lowerCamelCase, under 100 characters")
                clash = [g for g in all_functions() if g.get("api_name") == f["api_name"] and g["id"] != f["id"]]
                if clash:
                    raise HTTPException(409, f"the API name {f['api_name']} is used by {clash[0]['name']}")
        # configuration inheritance: from the prior stable version
        if prev and v[3] == 1:
            for f in funcs:
                cfg = d["config"].get(f["id"]) or {}
                if prev["version"] in cfg and version not in cfg:
                    cfg[version] = dict(cfg[prev["version"]])
                    d["config"][f["id"]] = cfg
        release = {"version": version, "commit": commit, "at": _now(), "by": (auth.current() or {}).get("username") or "local",
                   "functions": funcs, "breaking": breaking, "warning": warn}
        d["releases"].append(release)
        _save_repo(repo_id, d)
    return release


def _on_tag(repo_id: str, tag: dict) -> Optional[dict]:
    """Code Repositories: a semantic version tag publishes the repository's functions."""
    if not parse(tag["name"]):
        return None
    try:
        r = publish(repo_id, tag["name"].lstrip("v"), tag["commit"])
        return {"status": "published", "functions": len(r["functions"]), "warning": r["warning"], "breaking": r["breaking"]}
    except HTTPException as e:
        return {"status": "failed", "error": e.detail}


class PublishIn(BaseModel):
    repo_id: str
    version: str
    # a branch (its last commit) or a commit id; default: the default branch
    ref: Optional[str] = None
    strict: bool = False


@router.post("/publish")
def publish_route(req: PublishIn) -> dict:
    import code_repos

    rec = code_repos._repo(req.repo_id)
    # publishing a repository's functions: Editors of its Project
    auth.check_resource("code_repo", req.repo_id, "editor")
    ref = req.ref or rec["default_branch"]
    commit = rec["branches"][ref]["head"] if ref in rec["branches"] else ref
    if not commit:
        raise HTTPException(400, "commit the repository first")
    return publish(req.repo_id, req.version, commit, req.strict)


# ------------------------------------------------------------------------------------------------
# registry
# ------------------------------------------------------------------------------------------------


def _repos() -> list[str]:
    return [p.stem for p in (DIR / "repos").glob("*.json")]


def _visible_repo(repo_id: str) -> Optional[dict]:
    import code_repos
    import sql_functions

    if repo_id.startswith(sql_functions.REPO_PREFIX):
        return sql_functions.visible(repo_id)
    try:
        rec = code_repos._repo(repo_id)
    except HTTPException:
        return None
    return rec if auth.visible_resources("code_repo", [rec]) else None


def all_functions() -> list[dict]:
    """Every function's latest stable release (else its latest pre-release)."""
    out: dict[str, dict] = {}
    for repo_id in _repos():
        d = _repo_data(repo_id)
        for r in sorted(d["releases"], key=lambda r: parse(r["version"])):  # type: ignore[arg-type, return-value]
            for f in r["functions"]:
                cur = out.get(f["id"])
                stable = parse(r["version"])[3] == 1
                if cur is None or stable or parse(cur["version"])[3] == 0:
                    out[f["id"]] = {**f, "repo_id": repo_id, "version": r["version"], "released_at": r["at"],
                                    "rid": f"ri.function-registry.main.function.{f['id'][3:]}"}
    return list(out.values())


def _function(fid: str) -> tuple[dict, dict, str]:
    """(latest function record, repository data, repo id)."""
    f = next((x for x in all_functions() if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "function not found")
    if not _visible_repo(f["repo_id"]):
        raise HTTPException(403, "You need access to the function's repository")
    return f, _repo_data(f["repo_id"]), f["repo_id"]


def _visible_function(fid: str) -> None:
    """404 / 403 unless the caller can see the function (a published or a model function)."""
    if fid.startswith(MODEL_PREFIX):
        _model_function(fid)
    else:
        _function(fid)


# ------------------------------------------------------------------------------------------------
# model functions: the function wrapping a live model deployment (model_deployments.py), listed and run like any
# other published function so Workshop, Actions and Automate can pick them (ids "mf-<api name>")
# ------------------------------------------------------------------------------------------------

MODEL_PREFIX = "mf-"
_MODEL_TYPES = {"float": "double", "float64": "double", "float32": "float", "int": "integer", "int64": "long", "int32": "integer",
                "str": "string", "bool": "boolean"}


def _model_type(t: Any) -> str:
    if isinstance(t, list):  # a tabular input or output: rows of columns
        return "array<struct>"
    if isinstance(t, dict):
        return "struct"
    return _MODEL_TYPES.get(str(t), str(t or "any"))


def _model_record(m: dict) -> dict:
    sig = m["signature"]
    out = sig.get("output") or {}
    cols = ", ".join(f"{k}: {_model_type(v)}" for k, v in out.items())
    doc = f"Model function of the live deployment {m['deployment']}" + (" (row-wise)" if m["row_wise"] else "") + (f"; returns {cols}" if cols else "")
    return {"id": MODEL_PREFIX + m["api_name"], "name": m["name"], "file": "", "line": 0, "kind": "query", "api_name": m["api_name"], "edits": None,
            "sources": [], "errors": [], "language": "model", "source": "model", "repo_id": "", "deployment_id": m["deployment_id"],
            "deployment": m["deployment"], "row_wise": m["row_wise"], "api_changed": m.get("api_changed", False), "doc": doc,
            "inputs": _model_inputs(sig, m.get("object_binding")), "object_binding": m.get("object_binding"),
            # a row-wise function returns one row; otherwise one value per model output
            "output": "struct" if out else "any", "version": f"{m['version']}.0.0", "released_at": None,
            "rid": f"ri.function-registry.main.model-function.{m['api_name']}"}


def _model_inputs(sig: dict, binding: Optional[dict]) -> list[dict]:
    """A model function's inputs; bound to an object type, the object comes first and its mapped columns are not asked for."""
    cols = sig.get("inputs") or {}
    if not binding:
        return [{"name": k, "type": _model_type(v), "required": True} for k, v in cols.items()]
    return [{"name": binding["input_name"], "type": f"object:{binding['object_type']}", "required": True}] +         [{"name": k, "type": _model_type(v), "required": True} for k, v in cols.items() if k not in binding["properties"]]


def model_functions() -> list[dict]:
    """The model functions the caller can see."""
    try:
        import model_deployments

        out = []
        for m in model_deployments.list_functions():
            f = _model_record(m)
            dep = model_deployments.find_function(m["api_name"]) or {}
            f["released_at"] = ((dep.get("function") or {}).get("versions") or [{}])[-1].get("at")
            f["deployment_href"] = f"/model-assets/{dep['model_id']}" if dep.get("model_id") else \
                f"/modeling-objectives?id={dep['objective_id']}" if dep.get("objective_id") else None
            out.append(f)
        return out
    except Exception:  # noqa: BLE001  (model deployments not configured)
        return []


def _model_monitors_path() -> Path:
    return DIR / "model-function-monitors.json"


def _model_monitors(fid: str) -> list[dict]:
    return (ontology._read(_model_monitors_path(), None) or {}).get(fid) or []


def _model_function(fid: str) -> dict:
    f = next((x for x in model_functions() if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "function not found")
    return f


def _model_versions(fid: str) -> list[dict]:
    import model_deployments

    dep = model_deployments.find_function(fid[len(MODEL_PREFIX):]) or {}
    fn = dep.get("function") or {}
    out = []
    for v in reversed(fn.get("versions") or []):
        sig = _model_record({**fn, "deployment_id": dep.get("id"), "deployment": dep.get("name"), "row_wise": v["row_wise"], "signature": v["signature"],
                             "version": v["version"], "object_binding": v.get("object_binding")})
        out.append({"version": sig["version"], "commit": f"model version {v.get('model_version')}", "at": v["at"], "by": v.get("by"), "breaking": [],
                    "signature": sig})
    return out


def _model_ref_ok(fid: str, version: Optional[str]) -> bool:
    return not version or version == "latest" or bool(resolve([v["version"] for v in _model_versions(fid)], version))


def _execute_model(fid: str, inputs: dict, version: Optional[str], resource: Optional[str]) -> dict:
    """A model function runs the deployment's current function version (a pinned version must still exist)."""
    import model_deployments

    f = _model_function(fid)
    if not _model_ref_ok(fid, version):
        raise HTTPException(404, f"no version of {f['name']} satisfies {version}")
    started = time.monotonic()
    try:
        res = {"ok": True, "value": model_deployments.execute_function(f["api_name"], inputs or {}).get("output")}
    except HTTPException as e:
        res = {"ok": False, "error": e.detail, "category": "invalid_inputs" if e.status_code in (400, 422) else None}
    except Exception as e:  # noqa: BLE001
        res = {"ok": False, "error": str(e)}
    ms = int((time.monotonic() - started) * 1000)
    run = {"id": uuid.uuid4().hex[:12], "at": _now(), "version": f["version"], "ms": ms, "status": "succeeded" if res["ok"] else "failed",
           "category": _category(res), "error": None if res["ok"] else str(res.get("error") or "")[:500], "resource": resource,
           "user": (auth.current() or {}).get("username") or "local", "calls": 0, "call_ms": 0, "warnings": 0}
    _record(fid, run, _model_monitors(fid))
    out = {"ok": res["ok"], "version": f["version"], "ms": ms, "run_id": run["id"], "logs": ""}
    if res["ok"]:
        out["value"] = res["value"]
    else:
        out.update(error=res.get("error"), user_facing=False, category=run["category"])
    return out


# ------------------------------------------------------------------------------------------------
# global branches: functions published on an Ontology branch
# ------------------------------------------------------------------------------------------------

# the branch a run happens on (an Ontology branch id): its branched pre-releases win over main's releases
BRANCH: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("functions_branch", default=None)
# the function versions a run on a branch used (AIP Logic and Logic Flows on a branch show them): a list the caller sets
RAN: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar("functions_ran", default=None)


def _note_ran(fid: str, name: str, repo_id: str, version: str, branched: bool, status: str) -> None:
    ran = RAN.get()
    if ran is None:
        return
    row = next((r for r in ran if r["function_id"] == fid and r["version"] == version), None)
    if row:
        row["calls"] += 1
        if status == "failed":
            row["status"] = "failed"
        return
    ran.append({"function_id": fid, "function": name, "repo_id": repo_id, "version": version, "branched": branched, "status": status, "calls": 1})


def _branch_name(branch_id: str) -> Optional[str]:
    try:
        return (ontology._read(ontology._path("branches", branch_id)) or {}).get("name")
    except HTTPException:
        return None


def current_branch() -> Optional[str]:
    """The global branch a run happens on: set explicitly (the execute API's `branch`, a branch context) or the branch
    whose data the request works in — Workshop, AIP Logic and actions on a branch send the branch's data scenario
    (ontology_branches.py), so a function-backed action applied there runs the branch's versions too."""
    bid = BRANCH.get()
    if bid:
        return bid
    sid = ontology.SCENARIO.get()
    if not sid:
        return None
    try:
        sc = ontology._read(ontology._path("scenarios", str(sid).split("~", 1)[0])) or {}
    except HTTPException:
        return None
    return sc.get("global_branch")


def _branch_base(d: dict, branch_id: str) -> str:
    """When the branch last took main's function versions: its creation, or its last function rebase (branch-wide or
    for this repository). Main versions published later stay off the branch until it rebases."""
    b = ontology._read(ontology._path("branches", branch_id)) or {}
    return max(b.get("created_at") or "", b.get("functions_rebased_at") or "", (d.get("branch_bases") or {}).get(branch_id) or "")


def _visible_versions(d: dict, fid: str) -> list[dict]:
    """Main's versions of a function as the current run sees them: on a branch, those published before its base (all
    of them when the function had none then)."""
    vs = _versions(d, fid)
    bid = current_branch()
    if not bid:
        return vs
    base = _branch_base(d, bid)
    return [v for v in vs if v["at"] <= base] or vs


def publish_branch(repo_id: str, target: str, commit: str, branch_id: str) -> dict:
    """Publish on a global branch: an unstable "Branched pre-release" towards the version target, visible only on
    that branch; publishing again to the same target replaces what the branch uses. Merging the branch publishes the
    target on main from the last branched release; the other branched versions do not reach main."""
    import ontology_branches

    t = parse(target)
    if t is None or t[3] == 0:
        raise HTTPException(400, "the version target is a stable semantic version, like 1.3.0")
    b = ontology_branches._branch(branch_id)
    if b.get("status") not in (None, "open"):
        raise HTTPException(400, f"the branch {b.get('name') or branch_id} is {b['status']}: functions are published only on open branches")
    funcs = _describe(repo_id, commit)
    with _lock:
        d = _repo_data(repo_id)
        if any(r["version"] == target for r in d["releases"]):
            raise HTTPException(409, f"{target} is already released on main: choose a newer version target")
        mine = [r for r in d.setdefault("branch_releases", []) if r["branch"] == branch_id]
        for f in funcs:
            f["id"] = fid_of(repo_id, f["file"], f["name"])
            if f.get("interface_error"):
                raise HTTPException(400, f"{f['name']} does not implement {f['implements']}: {f['interface_error']}")
        rel = {"version": f"{target}-branch.{branch_id.split('-')[-1][:8]}.{len(mine) + 1}", "target": target, "branch": branch_id,
               "branch_name": b.get("name"), "commit": commit, "at": _now(), "by": (auth.current() or {}).get("username") or "local",
               "functions": funcs, "breaking": [], "warning": False}
        d["branch_releases"].append(rel)
        _save_repo(repo_id, d)
    return rel


def _branch_release(d: dict, fid: str, rng: Optional[str]) -> Optional[dict]:
    """On a branch: its newest branched release of the function whose version target satisfies the range."""
    bid = current_branch()
    if not bid:
        return None
    rels = [r for r in d.get("branch_releases") or [] if r["branch"] == bid and any(f["id"] == fid for f in r["functions"])
            and (not rng or rng == "latest" or rng == r["version"] or satisfies(r["target"], rng))]
    return max(rels, key=lambda r: r["at"]) if rels else None


def branch_merged(branch_id: str) -> list[dict]:
    """The Ontology branch merged: each version target published on it is published on main (from its last
    branched release); the branched versions are dropped."""
    out = []
    for repo_id in _repos():
        with _lock:
            d = _repo_data(repo_id)
            rels = [r for r in d.get("branch_releases") or [] if r["branch"] == branch_id]
        last: dict[str, dict] = {}
        for r in sorted(rels, key=lambda r: r["at"]):
            last[r["target"]] = r
        for target, r in last.items():
            try:
                publish(repo_id, target, r["commit"])
                out.append({"repo_id": repo_id, "version": target, "status": "published"})
            except HTTPException as e:
                out.append({"repo_id": repo_id, "version": target, "status": "failed", "error": str(e.detail)})
        if rels:
            branch_closed(branch_id, repo_id)
    return out


def branch_closed(branch_id: str, only_repo: Optional[str] = None) -> None:
    for repo_id in [only_repo] if only_repo else _repos():
        with _lock:
            d = _repo_data(repo_id)
            if any(r["branch"] == branch_id for r in d.get("branch_releases") or []):
                d["branch_releases"] = [r for r in d["branch_releases"] if r["branch"] != branch_id]
                _save_repo(repo_id, d)


def branch_status(branch_id: str, repo_id: Optional[str] = None) -> list[dict]:
    """Per repository with releases on the branch (or the one asked for): main versions published since the branch's
    base (a rebase pulls them in) and each version target — stale when main released it meanwhile (pick a new target
    before merging)."""
    out = []
    for rid in [repo_id] if repo_id else _repos():
        with _lock:
            d = _repo_data(rid)
        mine = sorted((r for r in d.get("branch_releases") or [] if r["branch"] == branch_id), key=lambda r: r["at"])
        if not mine and not repo_id:
            continue
        base = _branch_base(d, branch_id)
        on_main = {r["version"] for r in d["releases"]}
        last: dict[str, dict] = {}
        for r in mine:
            last[r["target"]] = r
        targets = [{"target": t, "version": r["version"], "functions": [f["name"] for f in r["functions"]], "at": r["at"], "stale": t in on_main}
                   for t, r in last.items()]
        newer = sorted((r["version"] for r in d["releases"] if r["at"] > base), key=lambda v: parse(v) or (0,), reverse=True)  # type: ignore[arg-type, return-value]
        out.append({"repo_id": rid, "repository": (_visible_repo(rid) or {}).get("name", rid), "base": base, "newer_on_main": newer,
                    "rebase_available": bool(newer), "targets": targets, "stale_targets": [t["target"] for t in targets if t["stale"]]})
    return out


def branch_checks(branch_id: str) -> list[dict]:
    """Merge checks (ontology_branches.py): version targets main released while the branch was open."""
    return [{"repo_id": s["repo_id"], "repository": s["repository"], "target": t} for s in branch_status(branch_id) for t in s["stale_targets"]]


def _dependents(branch_id: str, fid: str, old: str, new: str) -> list[dict]:
    """Resources pinned to a function's old version target (main's and the branch's Workshop modules among them)."""
    rows = _usage(fid)
    try:
        import workshop

        for p in (workshop.DIR / "branches" / branch_id).glob("*.json"):
            m = (ontology._read(p) or {}).get("module") or ontology._read(p) or {}
            for w in m.get("widgets") or []:
                if (w.get("config") or {}).get("function_id") == fid:
                    rows.append({"kind": "workshop", "id": m.get("id") or p.stem, "name": m.get("name") or p.stem, "version": w["config"].get("function_version"),
                                 "on_branch": True})
    except Exception:  # noqa: BLE001
        pass
    return [u for u in rows if u.get("version") and u["version"] != "latest" and not satisfies(new, u["version"])
            and (u["version"].startswith(old) or satisfies(old, u["version"]))]


def rebase_branch(branch_id: str, repo_id: Optional[str] = None, retarget: Optional[dict[str, str]] = None) -> dict:
    """Rebase the branch's functions onto main: newer main versions become visible on the branch. A version target
    main released meanwhile must move to a new one first (`retarget`: old → new); its branched releases move along,
    and the resources pinned to the old target are listed (they must be updated to the new one)."""
    import ontology_branches

    retarget = retarget or {}
    with ontology._lock:
        b = ontology_branches._branch(branch_id)
        ontology_branches._open(b)
    statuses = branch_status(branch_id, repo_id)
    missing = [{"repo_id": s["repo_id"], "repository": s["repository"], "target": t} for s in statuses for t in s["stale_targets"] if t not in retarget]
    if missing:
        return {"status": "needs_target", "stale": missing, "repos": statuses}
    for new in retarget.values():
        t = parse(new)
        if t is None or t[3] == 0:
            raise HTTPException(400, f"{new}: a version target is a stable semantic version, like 1.3.0")
    dependents: list[dict] = []
    now = _now()
    for s in statuses:
        with _lock:
            d = _repo_data(s["repo_id"])
            on_main = {r["version"] for r in d["releases"]}
            for old, new in retarget.items():
                moved = [r for r in d.get("branch_releases") or [] if r["branch"] == branch_id and r["target"] == old]
                if not moved:
                    continue
                if new in on_main:
                    raise HTTPException(409, f"{new} is already released on main: choose a newer version target")
                for r in moved:
                    for f in r["functions"]:
                        dependents += [{**u, "function": f["name"], "old_target": old, "new_target": new} for u in _dependents(branch_id, f["id"], old, new)]
                    r["version"] = new + r["version"][len(r["target"]):]
                    r["target"] = new
                    r["retargeted_from"] = old
            if repo_id:
                d.setdefault("branch_bases", {})[branch_id] = now
            _save_repo(s["repo_id"], d)
    if not repo_id:
        with ontology._lock:
            b = ontology_branches._branch(branch_id)
            b["functions_rebased_at"] = now
            ontology_branches._save(b)
    # one entry per resource and function
    seen: set = set()
    deps = [u for u in dependents if (k := (u["kind"], u["id"], u["function"], u.get("on_branch"))) not in seen and not seen.add(k)]  # type: ignore[func-returns-value]
    return {"status": "rebased", "rebased_at": now, "repos": branch_status(branch_id, repo_id), "dependents": deps}


def _versions(d: dict, fid: str) -> list[dict]:
    return [{"version": r["version"], "commit": r["commit"], "at": r["at"], "by": r.get("by"), "breaking": [b for b in r.get("breaking") or []],
             "signature": next(f for f in r["functions"] if f["id"] == fid)}
            for r in sorted(d["releases"], key=lambda r: parse(r["version"]), reverse=True) if any(f["id"] == fid for f in r["functions"])]  # type: ignore[arg-type, return-value]


def _usage(fid: str) -> list[dict]:
    out = []
    for a in ontology._all("action-types"):
        for r in a.get("rules") or []:
            if r.get("function_id") == fid:
                out.append({"kind": "action_type", "id": a["id"], "name": a["display_name"], "version": r.get("version")})
    for a in ontology._all("automations"):
        if (a.get("effect") or {}).get("function_id") == fid:
            out.append({"kind": "automation", "id": a["id"], "name": a["name"], "version": a["effect"].get("version")})
    try:
        import workshop

        for p in workshop.DIR.glob("*.json"):
            m = ontology._read(p) or {}
            for w in m.get("widgets") or []:
                if (w.get("config") or {}).get("function_id") == fid:
                    out.append({"kind": "workshop", "id": m["id"], "name": m["name"], "version": w["config"].get("function_version")})
    except Exception:  # noqa: BLE001
        pass
    return out


@router.get("")
def list_functions(q: str = "", kind: Optional[str] = None) -> list[dict]:
    with _lock:
        rows = [f for f in all_functions() if _visible_repo(f["repo_id"])]
    rows += model_functions()
    needle = q.strip().lower()
    if needle:
        rows = [f for f in rows if needle in f"{f['name']} {f.get('doc')} {f.get('api_name') or ''} {f['rid']}".lower()]
    if kind:
        rows = [f for f in rows if f["kind"] == kind]
    for f in rows:
        m = _metrics(f["id"], 30)
        f["succeeded"], f["failed"] = m["succeeded"], m["failed"]
    return sorted(rows, key=lambda f: f["name"])


@router.get("/queries")
def list_queries() -> list[dict]:
    """API-named query functions (the API gateway)."""
    return [{"api_name": f["api_name"], "id": f["id"], "name": f["name"], "version": f["version"], "inputs": f["inputs"], "output": f["output"]}
            for f in list_functions() if f.get("api_name")]


@router.get("/{fid}")
def get_function(fid: str, branch: Optional[str] = None) -> dict:
    if branch and not fid.startswith(MODEL_PREFIX):
        # the function as an open global branch sees it (the function page's "On a branch"); without it: main, or the
        # branch of the request's data scenario
        import ontology_branches

        with ontology._lock:
            b = ontology_branches._branch(branch)
        if b["status"] != "open":
            raise HTTPException(400, f"the branch {b['name']} is {b['status']}: functions resolve only on open branches")
        t_branch = BRANCH.set(branch)
        try:
            return get_function(fid)
        finally:
            BRANCH.reset(t_branch)
    if fid.startswith(MODEL_PREFIX):
        f = _model_function(fid)
        return {**f, "repository": f"Model deployment: {f['deployment']}", "versions": _model_versions(fid), "config": {}, "monitors": _model_monitors(fid),
                "usage": _usage(fid), "metrics": _metrics(fid, 30)}
    with _lock:
        f, d, repo_id = _function(fid)
        rec = _visible_repo(repo_id) or {"name": repo_id}
        out = {**f, "repository": rec["name"], "versions": _versions(d, fid), "config": d["config"].get(fid) or {},
               "monitors": d["monitors"].get(fid) or [], "usage": _usage(fid), "metrics": _metrics(fid, 30)}
    bid = current_branch()
    if bid:
        # on a branch (version selectors): its "Branched pre-release" versions, main's versions it sees, and newer ones
        seen = {v["version"] for v in _visible_versions(d, fid)}
        br = _branch_release(d, fid, None)
        # what a run on the branch uses when it asks for no version: its newest Branched pre-release, else main's
        # newest release the branch sees
        uses = ({"version": br["version"], "branched": True, "target": br["target"]} if br else
                {"version": resolve([v["version"] for v in _visible_versions(d, fid)], None), "branched": False, "target": None})
        out["branch"] = {"id": bid, "name": _branch_name(bid), "resolves": uses, "base": _branch_base(d, bid), "visible_versions": [v["version"] for v in out["versions"] if v["version"] in seen],
                         "newer_on_main": [v["version"] for v in out["versions"] if v["version"] not in seen],
                         "branched": [{"version": r["version"], "target": r["target"], "at": r["at"], "by": r.get("by"), "label": "Branched pre-release"}
                                      for r in sorted(d.get("branch_releases") or [], key=lambda r: r["at"], reverse=True)
                                      if r["branch"] == bid and any(x["id"] == fid for x in r["functions"])]}
    return out


# ------------------------------------------------------------------------------------------------
# execution
# ------------------------------------------------------------------------------------------------


def _unwrap_object(v: Any) -> Any:
    """An object argument as {object_type_id, primary_key}: the runtimes send objects as {"__object__": {...}} (Python
    functions passing an object to a query), plain references stay as they are."""
    if isinstance(v, dict) and isinstance(v.get("__object__"), dict):
        o = v["__object__"]
        return {"object_type_id": o.get("object_type_id"), "primary_key": o.get("primary_key")}
    return v


def _object_list(v: Any) -> list:
    """A list of object arguments; an object set given for a list of objects becomes its members."""
    if isinstance(v, dict) and isinstance(v.get("__object_set__"), dict):
        s = v["__object_set__"]
        return [{"object_type_id": s.get("object_type_id"), "primary_key": pk} for pk in s.get("primary_keys") or []]
    if isinstance(v, dict) and isinstance(v.get("__interface_object_set__"), dict):
        return list(v["__interface_object_set__"].get("objects") or [])
    return v if isinstance(v, list) else [v]


def _implements(t: dict, iface: dict) -> bool:
    """Whether object type t implements the interface (directly, or through an interface extending it)."""
    by_id = {i["id"]: i for i in ontology._all("interfaces")}
    seen, todo = set(), [m.get("interface_id") for m in t.get("implements") or []]
    while todo:
        x = todo.pop()
        if x in seen or x is None:
            continue
        seen.add(x)
        todo.extend((by_id.get(x) or {}).get("extends") or [])
    return iface["id"] in seen


def _interface(name: str) -> Optional[dict]:
    return next((i for i in ontology._all("interfaces") if name in (i["api_name"], i["id"])), None)


def _check_implements(type_id: Any, iface: Optional[dict]) -> None:
    """An object given for an interface input must be of a type implementing the interface."""
    if iface is None or not type_id:
        return
    t = ontology._object_type(type_id)
    if not _implements(t, iface):
        raise HTTPException(400, f"expected an object implementing {iface['api_name']}, got a {t['api_name']} (it does not implement the interface)")


def _object_input(type_name: str, v: Any, iface: Optional[dict] = None) -> dict:
    v = _unwrap_object(v)
    t = next((x for x in ontology._all("object-types") if x["api_name"] == type_name or x["id"] == type_name), None)
    if isinstance(v, dict) and v.get("object_type_id"):
        given = ontology._object_type(v["object_type_id"])
        if t and given["id"] != t["id"]:
            # an object of another type (a Python or TypeScript function passing the wrong object to a query, say)
            raise HTTPException(400, f"expected a {t['api_name']} object, got a {given['api_name']}")
        t = given
    if not t:
        raise HTTPException(400, f"unknown object type {type_name}" if type_name else "an object input needs {object_type_id, primary_key}")
    _check_implements(t["id"], iface)
    pk = v.get("primary_key") if isinstance(v, dict) else v
    t = ontology._object_type(t["id"])
    key, o = ontology._find(t, pk)
    return {"__object__": ontology._public_object(t, key, o)}


def _inputs(sig: dict, inputs: dict) -> dict:
    """Inputs as the runner receives them: objects resolved with the caller's permissions."""
    types_ = {i["name"]: i["type"] for i in sig["inputs"]}
    out = {}
    for k, v in (inputs or {}).items():
        t = types_.get(k, "any")
        if v is None:
            out[k] = None
        elif t.startswith("object:"):
            out[k] = _object_input(t[7:], v)
        elif t.startswith("array<object:"):
            out[k] = [_object_input(t[13:-1], x) for x in _object_list(v)]
        elif t.startswith("interface:"):
            # an object of any implementing type: {object_type_id, primary_key}
            out[k] = _object_input("", v, _interface(t[10:]))
        elif t.startswith("array<interface:"):
            out[k] = [_object_input("", x, _interface(t[16:-1])) for x in _object_list(v)]
        elif t.startswith("interface_set:"):
            iface = next((i for i in ontology._all("interfaces") if t[14:] in (i["api_name"], i["id"])), None)
            if not iface:
                raise HTTPException(400, f"unknown interface {t[14:]}")
            if isinstance(v, dict) and isinstance(v.get("__interface_object_set__"), dict):
                # an interface object set passed on by a Python function
                members = v["__interface_object_set__"].get("objects")
            elif isinstance(v, dict) and isinstance(v.get("__object_set__"), dict):
                members = _object_list(v)
            else:
                members = v.get("objects") if isinstance(v, dict) else v
            members = None if members is None else [_unwrap_object(m) for m in members]
            for m in members or []:
                if not isinstance(m, dict) or not m.get("object_type_id"):
                    raise HTTPException(400, f"an {iface['api_name']} object set takes objects as {{object_type_id, primary_key}}")
                _check_implements(m["object_type_id"], iface)
            out[k] = {"__interface_object_set__": {"interface_id": iface["id"],
                                                   "objects": None if members is None else [{"object_type_id": m["object_type_id"], "primary_key": str(m["primary_key"])} for m in members]}}
        elif t.startswith("object_set:"):
            if isinstance(v, dict) and isinstance(v.get("__object_set__"), dict):
                # an object set passed on by a Python function
                v = v["__object_set__"]
            elif isinstance(v, list) and any(isinstance(x, dict) for x in v):
                # a list of objects for an object set
                objs = [_unwrap_object(x) for x in v]
                v = {"object_type_id": next((x.get("object_type_id") for x in objs if isinstance(x, dict) and x.get("object_type_id")), None),
                     "primary_keys": [x.get("primary_key") if isinstance(x, dict) else x for x in objs]}
            tid = v.get("object_type_id") if isinstance(v, dict) else None
            tt = next((x for x in ontology._all("object-types") if t[11:] in (x["api_name"], x["id"])), None)
            if tid and tt and tid != tt["id"]:
                raise HTTPException(400, f"expected a {tt['api_name']} object set, got one of {ontology._object_type(tid)['api_name']}")
            if not tid:
                tid = tt["id"] if tt else None
            ontology._object_type(tid or "")
            pks = v.get("primary_keys") if isinstance(v, dict) else v
            out[k] = {"__object_set__": {"object_type_id": tid, "primary_keys": [str(x) for x in pks or []]}}
        else:
            out[k] = v
    return out


def _category(res: dict) -> Optional[str]:
    if res.get("ok"):
        return None
    if res.get("category"):
        return {"user_facing": "user_facing_error", "invalid_inputs": "invalid_inputs_error", "undeclared_edits": "undeclared_object_types_edited"}.get(res["category"], res["category"])
    err = str(res.get("error") or "")
    if res.get("oom") or "timed out" in err:
        return "resource_limit_exceeded"
    return "runtime_failure"


def execute(fid: str, inputs: dict, version: Optional[str] = None, resource: Optional[str] = None,
            on_stream: Optional[Any] = None) -> dict:
    import code_repos

    if fid.startswith(MODEL_PREFIX):
        return _execute_model(fid, inputs, version, resource)
    f, d, repo_id = _function(fid)
    release = _branch_release(d, fid, version)
    branched = release is not None
    if release:
        ver = release["version"]
    else:
        ver = resolve([v["version"] for v in _visible_versions(d, fid)], version)
        if not ver:
            raise HTTPException(404, f"no release of {f['name']} satisfies {version}" + (" on this branch (rebase it to use newer main versions)" if current_branch() else ""))
        release = next(r for r in d["releases"] if r["version"] == ver)
    sig = next(x for x in release["functions"] if x["id"] == fid)
    cfg = (d["config"].get(fid) or {}).get(release.get("target") or ver) or {}
    timeout = min(int(cfg.get("timeout_s") or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
    started = time.monotonic()
    try:
        args = _inputs(sig, inputs)
    except HTTPException as e:
        res = {"ok": False, "category": "invalid_inputs", "error": e.detail}
    else:
        if sig.get("source") == "sql":
            # an Ontology SQL function: the worksheet's query with the inputs, run with the caller's permissions
            import sql_functions

            res = sql_functions.invoke(sig, args)
        else:
            res = None
    if res is None:
        rec = code_repos._repo(repo_id)
        files = code_repos._commit_files(repo_id, release["commit"])
        spec = {"mode": "invoke", "file": sig["file"], "function": sig["name"], "args": args, "aliases": d["aliases"], "timeout_s": timeout,
                "repo_id": repo_id, "resources": {"memory_mb": cfg.get("memory_mb")} if cfg.get("memory_mb") else {}}
        own_snapshot = None
        if ontology.SNAPSHOT.get():
            # a query called inside a run with a snapshot: it reads the run's snapshot (the run owns it)
            spec["snapshot"] = ontology.SNAPSHOT.get()
        # consistent snapshots: on when enabled, and by default for function-backed actions (like Foundry); one point
        # in time for the run, opened now and released when the run ends
        elif cfg.get("snapshots") == "enabled" or (cfg.get("snapshots") in (None, "default") and str(resource or "").startswith("action:")):
            own_snapshot = spec["snapshot"] = uuid.uuid4().hex
            ontology.snapshot_open(own_snapshot)
        # called inside an Ontology scenario (a scenario route, a what-if): the function's platform calls read and
        # write in the same scenario
        if ontology.SCENARIO.get():
            import ontology_scenarios

            # the header as the caller sent it: inside a staged-write run, a nested call's layer stays whole, so writes
            # the called function makes outside staging join that run's edits (ontology_scenarios.staged_take_direct)
            req_sid = ontology_scenarios.request_sid()
            spec["scenario"] = req_sid if req_sid and ontology_scenarios._split(req_sid)[0] == ontology.SCENARIO.get() else ontology.SCENARIO.get()

            # a call from inside a staged-write run (nested staged writes): the scenario is the run's transaction; it
            # reads the caller's staged edits, and a staged-write function joins the transaction
            staged = ontology_scenarios.staged_base(spec["scenario"])
            if staged:
                spec["staged_parent"] = staged
        try:
            if sig.get("language") == "typescript":
                import functions_ts

                res = functions_ts.invoke(files, spec, timeout)
            else:
                res = code_repos._run(files, spec, rec, on_stream=on_stream)
        finally:
            if own_snapshot:
                ontology.snapshot_close(own_snapshot)
    if not res.get("ok") and ontology.SCENARIO.get():
        # a call inside a staged-write run failed: every staged edit is discarded, even when the function that made
        # the call (a plain query in between, say) catches the error (nothing happens in an ordinary scenario)
        import ontology_scenarios

        ontology_scenarios.staged_failed(ontology.SCENARIO.get(), f"{f['name']}: {res.get('error') or 'failed'}")
    ms = int((time.monotonic() - started) * 1000)
    run = {"id": uuid.uuid4().hex[:12], "at": _now(), "version": ver, "ms": ms, "status": "succeeded" if res.get("ok") else "failed", "category": _category(res),
           "error": None if res.get("ok") else str(res.get("error") or "")[:500], "resource": resource,
           "user": (auth.current() or {}).get("username") or "local"}
    telemetry = {"calls": (res.get("calls") or [])[:500], "log_records": (res.get("log_records") or [])[:500], "spans": (res.get("spans") or [])[:300],
                 "peak_memory_mb": (res.get("metrics") or {}).get("peak_memory_mb"), "logs": (res.get("logs") or "")[-4000:]}
    run["calls"] = len(res.get("calls") or [])
    run["call_ms"] = round(sum(c.get("ms") or 0 for c in res.get("calls") or []), 1)
    run["warnings"] = sum(1 for r in res.get("log_records") or [] if r.get("level") in ("WARNING", "ERROR", "CRITICAL"))
    if res.get("error_name"):
        run["error_name"] = res["error_name"]
    on_branch = current_branch()
    if on_branch:
        # the run happened on a global branch (the run history shows it): its Branched pre-release or a main version
        run["branch"] = {"id": on_branch, "name": _branch_name(on_branch), "branched": branched}
    _record(fid, run, d["monitors"].get(fid) or [])
    _save_telemetry(fid, run["id"], telemetry)
    _note_ran(fid, f["name"], repo_id, ver, branched, run["status"])
    out = {"ok": bool(res.get("ok")), "version": ver, "ms": ms, "run_id": run["id"], "logs": telemetry["logs"], "telemetry": telemetry}
    if on_branch:
        out["branch"] = run["branch"]
    if res.get("ok"):
        if "edits" in res:
            out.update(edits=res["edits"], declared_types=res.get("declared_types") or [], applied=False)
        # a staged-write function returns a value as well as its staged edits
        if "edits" not in res or res.get("staged_writes"):
            out["value"] = res.get("value")
        if res.get("staged_writes"):
            # nested staged writes: the calling run stages these edits as its own
            out["staged_writes"] = True
    else:
        out.update(error=res.get("error"), user_facing=bool(res.get("user_facing")), category=run["category"],
                   **({"error_name": res["error_name"], "error_params": res.get("error_params") or {}} if res.get("error_name") else {}))
    return out


def run_function(fid: str, version: Optional[str], inputs: dict, opts: Optional[dict] = None) -> dict:
    """For actions (function rules) and Automate (function effects)."""
    opts = opts or {}
    try:
        return execute(fid, inputs, version, opts.get("resource"))
    except HTTPException as e:
        return {"ok": False, "error": e.detail}


def function_info(fid: str, version: Optional[str] = None) -> dict:
    if fid.startswith(MODEL_PREFIX):
        f = _model_function(fid)
        return {"name": f["name"], "edits": None, "inputs": f["inputs"], "output": f["output"], "version": f["version"]}
    f, d, _ = _function(fid)
    br = _branch_release(d, fid, version)
    if br:
        sig = next(x for x in br["functions"] if x["id"] == fid)
        return {"name": sig["name"], "edits": sig.get("edits"), "inputs": sig["inputs"], "output": sig["output"], "version": br["version"]}
    vs = _visible_versions(d, fid)
    ver = resolve([v["version"] for v in vs], version) or f["version"]
    sig = next((v["signature"] for v in vs if v["version"] == ver), f)
    return {"name": sig["name"], "edits": sig.get("edits"), "inputs": sig["inputs"], "output": sig["output"], "version": ver}


def check_ref(fid: str, version: Optional[str]) -> None:
    if fid.startswith(MODEL_PREFIX):
        f = _model_function(fid)
        if not _model_ref_ok(fid, version):
            raise HTTPException(400, f"no version of {f['name']} satisfies {version}")
        return
    f, d, _ = _function(fid)
    if version and not resolve([v["version"] for v in _versions(d, fid)], version):
        raise HTTPException(400, f"no release of {f['name']} satisfies {version}")
    # auto upgrades (ranges) are not allowed on 0.y.z versions
    if version and version[0] in "^~>" and (parse(version.lstrip("^~>= ").split()[0]) or (1,))[0] == 0:
        raise HTTPException(400, "automatic upgrades need a stable version (1.0.0 or later)")


PIPELINE_ROWS = 10_000
# Ontology types are not supported in Pipeline Builder (Foundry hides such functions from the UDF list)
_NOT_IN_PIPELINES = ("object", "interface", "array<object", "array<interface", "object_set", "interface_set", "edits", "OntologyEdit", "stream<", "map<object")


def pipeline_usable(sig: dict) -> bool:
    # like Foundry, Pipeline Builder runs Python functions only; model functions when they take one row
    if sig.get("language") == "model":
        return bool(sig.get("row_wise")) and not sig.get("object_binding")
    return sig.get("language") != "typescript" and not sig.get("edits") and not any(str(t).startswith(_NOT_IN_PIPELINES) for t in [sig.get("output") or ""] + [i["type"] for i in sig.get("inputs") or []])


def execute_rows(fid: str, rows: list[dict], version: Optional[str] = None) -> dict:
    """A function as a Pipeline Builder UDF: one runner call for many rows (each row's cells are its arguments)."""
    import code_repos

    if fid.startswith(MODEL_PREFIX):
        return _execute_model_rows(fid, rows, version)
    f, d, repo_id = _function(fid)
    ver = resolve([v["version"] for v in _versions(d, fid)], version)
    if not ver:
        raise HTTPException(404, f"no release of {f['name']} satisfies {version}")
    release = next(r for r in d["releases"] if r["version"] == ver)
    sig = next(x for x in release["functions"] if x["id"] == fid)
    if sig.get("source") == "sql" or not pipeline_usable(sig):
        raise HTTPException(400, f"{sig['name']} takes or returns Ontology types: it cannot be used in Pipeline Builder")
    if len(rows) > PIPELINE_ROWS:
        raise HTTPException(400, f"at most {PIPELINE_ROWS:,} rows per call")
    cfg = (d["config"].get(fid) or {}).get(ver) or {}
    spec = {"mode": "invoke", "file": sig["file"], "function": sig["name"], "args": {}, "rows": rows, "aliases": d["aliases"],
            "timeout_s": min(int(cfg.get("timeout_s") or DEFAULT_TIMEOUT_S) * 4, MAX_TIMEOUT_S), "repo_id": repo_id}
    started = time.monotonic()
    res = code_repos._run(code_repos._commit_files(repo_id, release["commit"]), spec, code_repos._repo(repo_id))
    failed = sum(1 for r in res.get("rows") or [] if "error" in r)
    run = {"id": uuid.uuid4().hex[:12], "at": _now(), "version": ver, "ms": int((time.monotonic() - started) * 1000),
           "status": "succeeded" if res.get("ok") else "failed", "category": _category(res), "resource": "pipeline-builder",
           "error": None if res.get("ok") else str(res.get("error") or "")[:500], "user": (auth.current() or {}).get("username") or "local",
           "rows": len(rows), "failed_rows": failed}
    _record(fid, run, d["monitors"].get(fid) or [])
    if not res.get("ok"):
        raise HTTPException(400, str(res.get("error") or "the function failed"))
    return {"version": ver, "rows": res.get("rows") or []}


def _execute_model_rows(fid: str, rows: list[dict], version: Optional[str]) -> dict:
    """A row-wise model function as a Pipeline Builder UDF: the rows go to the deployment in one inference request."""
    import model_deployments

    f = _model_function(fid)
    if not _model_ref_ok(fid, version):
        raise HTTPException(404, f"no version of {f['name']} satisfies {version}")
    if not pipeline_usable(f):
        raise HTTPException(400, f"{f['name']} takes a table, not one row: only row-wise model functions run in Pipeline Builder")
    if len(rows) > PIPELINE_ROWS:
        raise HTTPException(400, f"at most {PIPELINE_ROWS:,} rows per call")
    started = time.monotonic()
    error = None
    out: list = []
    try:
        out = [{"value": r} for r in model_deployments.execute_function_rows(f["api_name"], rows)]
    except HTTPException as e:
        error = e.detail.get("error") if isinstance(e.detail, dict) else e.detail
    run = {"id": uuid.uuid4().hex[:12], "at": _now(), "version": f["version"], "ms": int((time.monotonic() - started) * 1000),
           "status": "failed" if error else "succeeded", "category": None, "resource": "pipeline-builder", "error": error and str(error)[:500],
           "user": (auth.current() or {}).get("username") or "local", "rows": len(rows), "failed_rows": len(rows) if error else 0}
    _record(fid, run, _model_monitors(fid))
    if error:
        raise HTTPException(400, str(error))
    return {"version": f["version"], "rows": out}


def registered_models() -> list[dict]:
    """Functions implementing the ChatCompletion function interface (latest release), as language models."""
    out = []
    for f in all_functions():
        if f.get("implements") == "ChatCompletion" and not f.get("interface_error") and _visible_repo(f["repo_id"]):
            out.append({"id": f"function:{f['id']}", "label": f"{f['name']} (registered)", "vendor": "Registered model",
                        "description": f.get("doc") or "A function implementing ChatCompletion", "cost": "per function run",
                        "available": True, "default": False, "registered": True, "version": f["version"],
                        "function_id": f["id"], "repo_id": f["repo_id"], "streaming": str(f.get("output") or "").startswith("stream<")})
    return out


def chat_completion(fid: str, system: str, user: str, on_chunk: Optional[Any] = None) -> str:
    """Call a registered model: the function gets messages [{role, content}] and returns the completion text. A
    function returning Iterator[str] streams: on_chunk(text) gets each piece as it is yielded."""
    f, _, _ = _function(fid)
    if f.get("implements") != "ChatCompletion":
        raise RuntimeError(f"{f['name']} does not implement ChatCompletion")
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    # the runner reports each yielded piece as {chunk, at_ms}
    stream = (lambda e: on_chunk(e.get("chunk") if isinstance(e, dict) and "chunk" in e else e)) if on_chunk else None
    res = execute(fid, {"messages": messages}, None, "registered-model", on_stream=stream)
    if not res.get("ok"):
        raise RuntimeError(f"{f['name']} failed: {res.get('error')}")
    v = res.get("value")
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        v = "".join(v)
    if isinstance(v, dict):
        v = v.get("completion") if "completion" in v else v.get("content", v)
    return v if isinstance(v, str) else json.dumps(v)


# -- the Embedding function interface: registered embedding models ("function:<id>") --------------------------------
# Listed with the embedding models (vectors.embedding_models) and resolved by vectors.MODELS_BY_ID / vectors.embed, so
# semantic search, vector properties, Pipeline Builder's Text to embeddings, KNN text queries and the Model Catalog
# can use them. A function declares its dimension (@function(implements="Embedding", dimension=768)); otherwise the
# dimension of its first answer is recorded for that release. Every answer is checked against it.

EMBED_MAX_TEXTS = 2048


def _embedding_function(fid: str) -> dict:
    f, _, _ = _function(fid)
    if f.get("implements") != "Embedding" or f.get("interface_error"):
        raise HTTPException(400, f"{f['name']} does not implement Embedding")
    return f


def _observed_dimension(f: dict) -> Optional[int]:
    d = _repo_data(f["repo_id"])
    return ((d.get("embedding_dims") or {}).get(f["id"]) or {}).get(f["version"])


def _record_dimension(f: dict, dim: int) -> None:
    with _lock:
        d = _repo_data(f["repo_id"])
        d.setdefault("embedding_dims", {}).setdefault(f["id"], {})[f["version"]] = dim
        _save_repo(f["repo_id"], d)


def registered_embedding_models() -> list[dict]:
    """Functions implementing the Embedding function interface (latest release), as embedding models; the dimension is
    the declared one, else the one recorded from an answer (None until the first call)."""
    out = []
    for f in all_functions():
        if f.get("implements") == "Embedding" and not f.get("interface_error") and _visible_repo(f["repo_id"]):
            dim = f.get("dimension") or _observed_dimension(f)
            out.append({"id": f"function:{f['id']}", "label": f"{f['name']} (registered)", "vendor": "Registered model",
                        "dimension": dim, "dimensions": [dim] if dim else [], "note": f.get("doc") or "A function implementing Embedding",
                        "description": f.get("doc") or "A function implementing Embedding", "cost": "per function run", "available": True,
                        "registered": True, "version": f["version"], "function_id": f["id"], "repo_id": f["repo_id"],
                        "dimension_source": "declared" if f.get("dimension") else "observed" if dim else None})
    return out


def embedding_spec(fid: str, probe: bool = True) -> Optional[dict]:
    """The embedding-model record of a registered embedding function (None when it is not one or not visible); with
    probe, an unknown dimension is found by embedding one short text."""
    try:
        f = _embedding_function(fid)
    except HTTPException:
        return None
    dim = f.get("dimension") or _observed_dimension(f)
    if not dim and probe:
        try:
            dim = len(embed_texts(fid, ["dimension probe"])[0])
        except Exception:  # noqa: BLE001 - reported when the model is used
            dim = None
    return {"id": f"function:{fid}", "label": f"{f['name']} (registered)", "vendor": "Registered model", "dimension": dim or 0,
            "dimensions": [dim] if dim else [], "registered": True, "version": f["version"], "note": f.get("doc") or ""}


def embed_texts(fid: str, texts: list[str], kind: str = "doc", dimension: Optional[int] = None) -> list[list[float]]:
    """Call a registered embedding model: the function gets inputs (a list of strings; kind too when it has an input
    of that name) and returns one vector per input, all of the model's dimension (and of `dimension` when given)."""
    f = _embedding_function(fid)
    out: list[list[float]] = []
    want = f.get("dimension") or _observed_dimension(f)
    for i in range(0, len(texts), EMBED_MAX_TEXTS):
        batch = [str(t) for t in texts[i : i + EMBED_MAX_TEXTS]]
        inputs: dict[str, Any] = {"inputs": batch}
        if any(x["name"] == "kind" for x in f.get("inputs") or []):
            inputs["kind"] = kind
        res = execute(fid, inputs, None, "registered-model")
        if not res.get("ok"):
            raise RuntimeError(f"{f['name']} failed: {res.get('error')}")
        v = res.get("value")
        if isinstance(v, dict):
            v = v.get("embeddings", v.get("vectors"))
        if not isinstance(v, list) or len(v) != len(batch):
            raise RuntimeError(f"{f['name']} returned {len(v) if isinstance(v, list) else type(v).__name__} vectors for {len(batch)} inputs")
        for vec in v:
            if isinstance(vec, dict):
                vec = vec.get("embedding", vec.get("vector"))
            if not isinstance(vec, list) or not vec or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in vec):
                raise RuntimeError(f"{f['name']} returned something other than a list of numbers for an input")
            if want and len(vec) != want:
                raise RuntimeError(f"{f['name']} returned a {len(vec)}-dimensional vector; it makes {want}-dimensional vectors")
            if not want:
                want = len(vec)
                _record_dimension(f, want)
            out.append([float(x) for x in vec])
    if dimension and want and dimension != want:
        raise RuntimeError(f"{f['name']} makes {want}-dimensional vectors; {dimension} were asked for")
    return out


@router.get("/models/registered")
def registered_models_route() -> dict:
    """Registered models: functions implementing ChatCompletion (language models) and Embedding (embedding models)."""
    return {"chat": registered_models(), "embedding": registered_embedding_models()}


class RegisteredChatIn(BaseModel):
    # empty: the default language model
    model: Optional[str] = None
    prompt: str = Field(min_length=1, max_length=200_000)
    system: Optional[str] = None
    # 0 (focused, the default) … 2 (random); Workshop's AIP Generated Content offers 0 … 1
    temperature: Optional[float] = Field(None, ge=0, le=2)


@router.post("/llm/chat/stream")
def llm_chat_stream(req: RegisteredChatIn) -> Any:
    """A completion as server-sent events: "chunk" events with each new piece of text — as a registered model
    (function:<id>) yields it (a ChatCompletion function returning Iterator[str]; one chunk otherwise), or as a
    provider's model streams its answer — a "reset" event when the provider starts its answer again (a retried
    attempt: the text so far is void), then "result"."""
    import queue

    from fastapi.responses import StreamingResponse

    model = req.model or ontology.DEFAULT_LLM
    if model.startswith("function:"):
        _function(model[len("function:"):])  # 404 / 403 before the stream starts
    q: "queue.Queue" = queue.Queue()

    def work() -> None:
        streamed = [0]
        sent = [""]

        def chunk(c: Any) -> None:
            streamed[0] += 1
            q.put(("chunk", c if isinstance(c, str) else json.dumps(c, default=str)))

        def so_far(text: str) -> None:
            # a provider's stream reports the text so far: send what is new, or start again
            if not text.startswith(sent[0]):
                q.put(("reset", {}))
                sent[0] = ""
            if len(text) > len(sent[0]):
                chunk(text[len(sent[0]):])
                sent[0] = text

        try:
            if model.startswith("function:"):
                text = chat_completion(model[len("function:"):], req.system or "", req.prompt, on_chunk=chunk)
            else:
                import pipeline_ai

                out = pipeline_ai.chat_tools(model, req.system or "You are a helpful assistant.", [{"role": "user", "text": req.prompt}], None,
                                             float(req.temperature or 0), 4096, on_text=so_far)
                text = out.get("text") or ""
                if streamed[0] and text != sent[0]:
                    # the final text differs from what was streamed (a retried attempt that did not stream): send it whole
                    q.put(("reset", {}))
                    streamed[0] = 0
            if not streamed[0]:
                chunk(text)
            q.put(("result", {"ok": True, "text": text, "model": model, "chunks": streamed[0]}))
        except HTTPException as e:
            q.put(("result", {"ok": False, "error": e.detail}))
        except Exception as e:  # noqa: BLE001
            q.put(("result", {"ok": False, "error": str(e)[:500]}))

    # the request's context (the signed-in user, its audit record) goes along to the worker thread
    threading.Thread(target=contextvars.copy_context().run, args=(work,), daemon=True).start()

    def events() -> Any:
        while True:
            kind, payload = q.get()
            yield f"event: {kind}\ndata: {json.dumps(payload, default=str)}\n\n"
            if kind == "result":
                break

    return StreamingResponse(events(), media_type="text/event-stream")


class PipelineUdfIn(BaseModel):
    # [{key, function_id, version, rows: [{input: value}]}] — the pipeline evaluator's service calls
    calls: list[dict] = Field(default_factory=list, max_length=50)


@router.post("/tools/pipeline-udf/run")
def pipeline_udf_run(req: PipelineUdfIn) -> dict:
    results = {}
    for c in req.calls:
        try:
            # a service answer is {value} or {error} (the pipeline evaluator's ServiceAnswer); the step reads value.rows
            results[c["key"]] = {"value": {"rows": execute_rows(c["function_id"], c.get("rows") or [], c.get("version") or None)["rows"]}}
        except HTTPException as e:
            results[c["key"]] = {"error": str(e.detail)}
    return {"results": results}


@router.get("/tools/pipeline-udf/functions")
def pipeline_functions() -> list[dict]:
    """Published functions usable as Pipeline Builder UDFs (no Ontology types in their signature)."""
    return [f for f in list_functions() if pipeline_usable(f)]


class ExecuteIn(BaseModel):
    inputs: dict[str, Any] = {}
    version: Optional[str] = None
    resource: Optional[str] = None
    # an Ontology branch: its branched pre-releases are used
    branch: Optional[str] = None


@router.post("/{fid}/execute")
def execute_route(fid: str, req: ExecuteIn) -> dict:
    if not req.branch:
        return execute(fid, req.inputs, req.version, req.resource or "functions")
    import ontology_branches

    # on a branch: its branched pre-releases, and the branch's data for the function's Ontology reads and edits
    with ontology_branches.branch_context(req.branch):
        return execute(fid, req.inputs, req.version, req.resource or "functions")


class PublishBranchIn(BaseModel):
    repo_id: str
    version_target: str
    branch_id: str
    # a code branch or commit; default: the repository's default branch
    ref: Optional[str] = None


@router.post("/publish-branch")
def publish_branch_route(req: PublishBranchIn) -> dict:
    import code_repos

    rec = code_repos._repo(req.repo_id)
    auth.check_resource("code_repo", req.repo_id, "editor")
    try:
        commit = code_repos._branch(rec, req.ref).get("head")  # a code branch (or the default one)
    except HTTPException:
        commit = req.ref  # a commit id
    if not commit:
        raise HTTPException(400, "commit first: the branch has no commits")
    return publish_branch(req.repo_id, req.version_target, commit, req.branch_id)


@router.get("/repos/{repo_id}/branch-releases")
def branch_releases(repo_id: str, branch_id: Optional[str] = None) -> list[dict]:
    auth.check_resource("code_repo", repo_id)
    with _lock:
        d = _repo_data(repo_id)
    return [{k: v for k, v in r.items() if k != "functions"} | {"functions": [f["name"] for f in r["functions"]]}
            for r in d.get("branch_releases") or [] if not branch_id or r["branch"] == branch_id]


@router.get("/branches/{branch_id}/status")
def branch_status_route(branch_id: str, repo_id: Optional[str] = None) -> dict:
    """Functions on a global branch: newer main versions to rebase onto, version targets main released meanwhile."""
    import ontology_branches

    with ontology._lock:
        b = ontology_branches._branch(branch_id)
    if repo_id and not _visible_repo(repo_id):
        raise HTTPException(404, "repository not found")
    repos = branch_status(branch_id, repo_id)
    return {"branch_id": branch_id, "branch_name": b.get("name"), "branch_status": b.get("status"), "repos": repos,
            "rebase_available": any(r["rebase_available"] for r in repos), "stale_targets": branch_checks(branch_id) if not repo_id else
            [{"repo_id": r["repo_id"], "repository": r["repository"], "target": t} for r in repos for t in r["stale_targets"]]}


class RebaseBranchIn(BaseModel):
    # one repository, or every repository (the branch's base for all functions)
    repo_id: Optional[str] = None
    # a version target main released meanwhile → the new target its branched releases move to
    retarget: dict[str, str] = {}


@router.post("/branches/{branch_id}/rebase")
def rebase_branch_route(branch_id: str, req: RebaseBranchIn) -> dict:
    if req.repo_id:
        if not _visible_repo(req.repo_id):
            raise HTTPException(404, "repository not found")
        auth.check_resource("code_repo", req.repo_id, "editor")
    return rebase_branch(branch_id, req.repo_id, req.retarget)


@router.post("/{fid}/execute/stream")
def execute_stream(fid: str, req: ExecuteIn) -> Any:
    """Streaming functions (an Iterator output): server-sent events, one per chunk as it is yielded, then the result."""
    import queue

    from fastapi.responses import StreamingResponse

    _visible_function(fid)
    q: "queue.Queue" = queue.Queue()
    token = auth._principal.get()

    def work() -> None:
        auth._principal.set(token)
        try:
            if req.branch:
                import ontology_branches

                with ontology_branches.branch_context(req.branch):
                    res = execute(fid, req.inputs, req.version, req.resource or "functions", on_stream=lambda c: q.put(("chunk", c)))
            else:
                res = execute(fid, req.inputs, req.version, req.resource or "functions", on_stream=lambda c: q.put(("chunk", c)))
            q.put(("result", res))
        except HTTPException as e:
            q.put(("result", {"ok": False, "error": e.detail}))
        except Exception as e:  # noqa: BLE001
            q.put(("result", {"ok": False, "error": str(e)}))

    # the request's context (a scenario or global branch it works in) goes along to the worker thread
    threading.Thread(target=contextvars.copy_context().run, args=(work,), daemon=True).start()

    def events() -> Any:
        while True:
            kind, payload = q.get()
            yield f"event: {kind}\ndata: {json.dumps(payload, default=str)}\n\n"
            if kind == "result":
                break

    return StreamingResponse(events(), media_type="text/event-stream")


def _telemetry_path(fid: str) -> Path:
    return DIR / "runs" / f"{fid}.telemetry.json"


def _save_telemetry(fid: str, run_id: str, t: dict) -> None:
    with _lock:
        data = ontology._read(_telemetry_path(fid), None) or {}
        data[run_id] = t
        # the last 50 runs keep their telemetry (logs, spans, platform calls)
        for k in list(data)[:-50]:
            data.pop(k, None)
        ontology._write(_telemetry_path(fid), data)


@router.get("/{fid}/runs/{run_id}")
def run_detail(fid: str, run_id: str) -> dict:
    _visible_function(fid)
    run = next((r for r in _runs(fid)["runs"] if r.get("id") == run_id), None)
    if not run:
        raise HTTPException(404, "run not found")
    return {**run, "telemetry": (ontology._read(_telemetry_path(fid), None) or {}).get(run_id)}


class EmbedIn(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=2048)
    model: Optional[str] = None
    kind: str = Field("doc", pattern="^(doc|query)$")


@router.post("/llm/embed")
def llm_embed(req: EmbedIn) -> dict:
    """functions.language_models.embed: text embeddings (unit length) for semantic search and nearest neighbors."""
    import vectors

    model = req.model or vectors.DEFAULT_MODEL
    spec = vectors.MODELS_BY_ID.get(model)
    if not spec:
        raise HTTPException(400, f"unknown embedding model {model}")
    out, _cost = vectors.embed(req.texts, model, spec["dimension"], req.kind)  # type: ignore[arg-type]
    return {"vectors": out, "model": model}


# ------------------------------------------------------------------------------------------------
# REST API sources and webhooks for functions
# ------------------------------------------------------------------------------------------------


def _webhooks() -> Any:
    try:
        import webhooks
    except ImportError as e:
        raise HTTPException(503, f"Data Connection is not available: {e}") from None
    return webhooks


def _source_for(repo_id: Optional[str], api_name: str) -> dict:
    webhooks = _webhooks()

    if not repo_id:
        raise HTTPException(400, "sources are used from a published function")
    auth.check_resource("code_repo", repo_id)
    d = _repo_data(repo_id)
    rows = webhooks.ds._rows("SELECT * FROM rest_sources WHERE api_name = %s OR name = %s", (api_name, api_name))
    if not rows:
        raise HTTPException(404, f"no REST API source {api_name}")
    row = rows[0]
    if row["id"] not in d["sources"] and (row.get("api_name") or row["name"]) not in d["sources"]:
        raise HTTPException(403, f"import the source {api_name} into the repository (Functions → Sources) to use it from code")
    if not row.get("code_imports"):
        raise HTTPException(403, f"the source {api_name} does not allow imports into code (Data Connection → source settings)")
    return row


class SourceDescribeIn(BaseModel):
    repo_id: Optional[str] = None
    source: str


@router.post("/sources/describe")
def source_describe(req: SourceDescribeIn) -> dict:
    row = _source_for(req.repo_id, req.source)
    return {"api_name": row.get("api_name") or row["name"], "domains": [{"url": x["url"]} for x in row["config"]["domains"]]}


class SourceRequestIn(BaseModel):
    repo_id: Optional[str] = None
    function: Optional[str] = None
    source: str
    method: str = Field("GET", pattern="^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$")
    url: str
    params: Optional[dict] = None
    headers: Optional[dict] = None
    json_body: Any = Field(None, alias="json")
    data: Optional[str] = None
    timeout: Optional[float] = None


@router.post("/sources/request")
def source_request(req: SourceRequestIn) -> dict:
    """A function's HTTPS request through an imported source: limited to the source's domains (relative paths join the
    first domain), egress-checked, with the domain's credentials added here (code never sees them)."""
    row = _source_for(req.repo_id, req.source)
    client = _webhooks().Client(row)
    base = row["config"]["domains"][0]["url"]
    url = req.url if req.url.startswith(("http://", "https://")) else base.rstrip("/") + "/" + req.url.lstrip("/")
    kw: dict = {"params": req.params, "headers": req.headers or {}, "timeout": min(req.timeout or 30, 120)}
    if req.json_body is not None:
        kw["json"] = req.json_body
    elif req.data is not None:
        kw["data"] = req.data
    try:
        r = client.request(req.method, url, **kw)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, client.scrub(f"the request failed: {e}")) from None
    return {"status": r.status_code, "headers": {k: v for k, v in r.headers.items() if k.lower() not in ("set-cookie",)},
            "text": client.scrub(r.text[:5_000_000])}


class SourceWebhookIn(BaseModel):
    repo_id: Optional[str] = None
    source: str
    webhook: str
    inputs: dict = {}


@router.post("/sources/webhook")
def source_webhook(req: SourceWebhookIn) -> dict:
    row = _source_for(req.repo_id, req.source)
    return _webhooks().execute_by_name(row.get("api_name") or row["name"], req.webhook, req.inputs)


@router.get("/repos/{repo_id}/sources")
def repo_sources(repo_id: str) -> dict:
    """The REST API sources a repository imported, and those it could import."""
    auth.check_resource("code_repo", repo_id)
    available = []
    try:
        import webhooks

        available = [{"id": r["id"], "name": r["name"], "api_name": r.get("api_name"), "code_imports": bool(r.get("code_imports")),
                      "domains": [x["url"] for x in r["config"]["domains"]]} for r in webhooks.ds._rows("SELECT * FROM rest_sources ORDER BY name")]
    except Exception:  # noqa: BLE001 - Data Connection needs the database
        pass
    return {"imported": _repo_data(repo_id)["sources"], "available": available}


class RepoSourcesIn(BaseModel):
    sources: list[str]


@router.put("/repos/{repo_id}/sources")
def set_repo_sources(repo_id: str, req: RepoSourcesIn) -> dict:
    auth.check_resource("code_repo", repo_id, "editor")
    with _lock:
        d = _repo_data(repo_id)
        d["sources"] = list(dict.fromkeys(req.sources))
        _save_repo(repo_id, d)
    return repo_sources(repo_id)


def _in_staged_run() -> bool:
    import ontology_scenarios

    return bool(ontology_scenarios.staged_base(ontology.SCENARIO.get()))


@router.post("/queries/{api_name}/execute")
def execute_query(api_name: str, req: ExecuteIn) -> dict:
    """The API gateway: an API-named query function, always at its latest release."""
    f = next((x for x in all_functions() if x.get("api_name") == api_name), None)
    if not f:
        # a model function: the wrapper of a live model deployment (model_deployments.py)
        import model_deployments

        if model_deployments.find_function(api_name):
            return model_deployments.execute_function(api_name, req.inputs)
        raise HTTPException(404, f"no query function named {api_name}")
    if f["kind"] == "edit" and not (f.get("staged_writes") and _in_staged_run()):
        # a staged-write function may be called from inside another one's run (directly or through a plain query it
        # calls): its edits join the caller's transaction
        if f.get("staged_writes"):
            raise HTTPException(400, f"queries are read-only: {api_name} is a staged-write function: it can be called only "
                                     "inside a staged-write run (a function-backed action), where its edits join the run's; "
                                     "a plain query called outside such a run has nowhere to keep them")
        raise HTTPException(400, "queries are read-only: Ontology edit functions run through actions")
    return execute(f["id"], req.inputs, "latest" if parse(f["version"])[3] == 1 else f["version"], req.resource or f"api:{api_name}")


class PreviewIn(BaseModel):
    repo_id: str
    branch: Optional[str] = None
    file: Optional[str] = None
    function: Optional[str] = None
    inputs: dict[str, Any] = {}


@router.post("/preview")
def live_preview(req: PreviewIn) -> dict:
    """Live preview: list (without file / function) or run the functions of a branch's last commit, unpublished."""
    import code_repos

    # runs the branch's code: Editors of the repository's Project
    auth.check_resource("code_repo", req.repo_id, "editor")
    rec = code_repos._repo(req.repo_id)
    b = code_repos._branch(rec, req.branch)
    files = code_repos._commit_files(req.repo_id, b["head"]) if b.get("head") else dict(b.get("files") or {})
    if not req.function:
        res = code_repos._run(files, {"mode": "describe", "timeout_s": 120}, rec)
        return {"functions": res.get("functions") or [], "error": None if res.get("ok") else res.get("error")}
    sig = None
    res = code_repos._run(files, {"mode": "describe", "timeout_s": 120}, rec)
    sig = next((x for x in res.get("functions") or [] if x["file"] == req.file and x["name"] == req.function), None)
    if not sig:
        raise HTTPException(404, "function not found on this branch")
    out = code_repos._run(files, {"mode": "invoke", "file": req.file, "function": req.function, "args": _inputs(sig, req.inputs),
                                  "aliases": _repo_data(req.repo_id)["aliases"], "timeout_s": MAX_TIMEOUT_S}, rec)
    return {k: out.get(k) for k in ("ok", "value", "edits", "error", "user_facing", "logs")}


# ------------------------------------------------------------------------------------------------
# configuration, aliases, monitors
# ------------------------------------------------------------------------------------------------


class ConfigIn(BaseModel):
    version: str
    timeout_s: Optional[int] = Field(None, ge=1, le=MAX_TIMEOUT_S)
    memory_mb: Optional[int] = Field(None, ge=512, le=5120)
    snapshots: Optional[str] = Field(None, pattern="^(default|enabled|disabled)$")


@router.put("/{fid}/config")
def set_config(fid: str, req: ConfigIn) -> dict:
    with _lock:
        f, d, repo_id = _function(fid)
        if req.version not in [v["version"] for v in _versions(d, fid)]:
            raise HTTPException(404, "no such version")
        cfg = d["config"].setdefault(fid, {})
        cfg[req.version] = {k: v for k, v in req.model_dump(exclude={"version"}).items() if v is not None}
        _save_repo(repo_id, d)
        return cfg


class MonitorsIn(BaseModel):
    # [{kind: p95_ms | failures | user_facing_failures | other_failures, threshold, window_minutes}]
    monitors: list[dict]


@router.put("/{fid}/monitors")
def set_monitors(fid: str, req: MonitorsIn) -> list[dict]:
    for m in req.monitors:
        if m.get("kind") not in ("p95_ms", "failures", "user_facing_failures", "other_failures"):
            raise HTTPException(400, "a monitor watches p95 duration, failures, user-facing failures or other failures")
    if fid.startswith(MODEL_PREFIX):
        import model_deployments

        # monitors are part of the deployment's configuration: its editors set them
        model_deployments._can(model_deployments.find_function(_model_function(fid)["api_name"]) or {}, "editor")
        with _lock:
            data = ontology._read(_model_monitors_path(), None) or {}
            data[fid] = req.monitors
            ontology._write(_model_monitors_path(), data)
        return req.monitors
    with _lock:
        _, d, repo_id = _function(fid)
        d["monitors"][fid] = req.monitors
        _save_repo(repo_id, d)
        return req.monitors


class AliasesIn(BaseModel):
    custom: dict[str, str] = {}
    model: dict[str, str] = {}


@router.get("/repos/{repo_id}/aliases")
def get_aliases(repo_id: str) -> dict:
    auth.check_resource("code_repo", repo_id)
    return _repo_data(repo_id)["aliases"]


@router.put("/repos/{repo_id}/aliases")
def set_aliases(repo_id: str, req: AliasesIn) -> dict:
    auth.check_resource("code_repo", repo_id, "editor")
    for k in list(req.custom) + list(req.model):
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", k):
            raise HTTPException(400, f"alias {k!r}: letters, digits, _ and -")
    with _lock:
        d = _repo_data(repo_id)
        d["aliases"] = req.model_dump()
        _save_repo(repo_id, d)
        return d["aliases"]


@router.get("/repos/{repo_id}/releases")
def releases(repo_id: str) -> list[dict]:
    auth.check_resource("code_repo", repo_id)
    return sorted(_repo_data(repo_id)["releases"], key=lambda r: parse(r["version"]), reverse=True)  # type: ignore[arg-type, return-value]


class ChatIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=200_000)
    model: Optional[str] = None
    system: Optional[str] = None
    # 0 (focused, the default) … 2 (random)
    temperature: Optional[float] = Field(None, ge=0, le=2)


@router.post("/llm/chat")
def llm_chat(req: ChatIn) -> dict:
    """functions.language_models.chat: a language model call for a running function."""
    import pipeline_ai

    model = req.model or ontology.DEFAULT_LLM
    text = pipeline_ai.chat(model, req.system or "You are a helpful assistant.", req.prompt, None, float(req.temperature or 0), 4096)
    return {"text": text, "model": model}


# ------------------------------------------------------------------------------------------------
# metrics
# ------------------------------------------------------------------------------------------------


def _runs_path(fid: str) -> Path:
    return DIR / "runs" / f"{fid}.json"


def _runs(fid: str) -> dict:
    return ontology._read(_runs_path(fid), None) or {"runs": [], "alerts": []}


def _p95(xs: list[int]) -> Optional[int]:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]


def _record(fid: str, run: dict, monitors: list[dict]) -> None:
    with _lock:
        data = _runs(fid)
        data["runs"].append(run)
        now = datetime.now(timezone.utc)
        cutoff = (now - timedelta(days=RUNS_KEPT_DAYS)).isoformat()
        data["runs"] = [r for r in data["runs"] if r["at"] >= cutoff][-5000:]
        for m in monitors:
            since = (now - timedelta(minutes=int(m.get("window_minutes") or 60))).isoformat()
            recent = [r for r in data["runs"] if r["at"] >= since]
            if m["kind"] == "p95_ms":
                value: Any = _p95([r["ms"] for r in recent])
            else:
                failed = [r for r in recent if r["status"] == "failed"]
                if m["kind"] == "user_facing_failures":
                    failed = [r for r in failed if r.get("category") == "user_facing_error"]
                elif m["kind"] == "other_failures":
                    failed = [r for r in failed if r.get("category") != "user_facing_error"]
                value = len(failed)
            fired = value is not None and value > float(m.get("threshold") or 0)
            last = next((a for a in reversed(data["alerts"]) if a["monitor"] == m["kind"]), None)
            if fired and (not last or last.get("resolved_at")):
                data["alerts"].append({"monitor": m["kind"], "value": value, "threshold": m.get("threshold"), "at": now.isoformat(), "resolved_at": None})
            elif not fired and last and not last.get("resolved_at"):
                last["resolved_at"] = now.isoformat()
        data["alerts"] = data["alerts"][-200:]
        ontology._write(_runs_path(fid), data)


def _metrics(fid: str, days: int) -> dict:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    data = _runs(fid)
    runs = [r for r in data["runs"] if r["at"] >= since]
    cats: dict[str, int] = {}
    by_day: dict[str, dict] = {}
    for r in runs:
        d = by_day.setdefault(r["at"][:10], {"day": r["at"][:10], "succeeded": 0, "failed": 0})
        d[r["status"]] += 1
        if r["status"] == "failed":
            cats[r.get("category") or "runtime_failure"] = cats.get(r.get("category") or "runtime_failure", 0) + 1
    return {"succeeded": sum(r["status"] == "succeeded" for r in runs), "failed": sum(r["status"] == "failed" for r in runs),
            "failures_by_category": cats, "p95_ms": _p95([r["ms"] for r in runs]), "by_day": sorted(by_day.values(), key=lambda x: x["day"]),
            "alerts": list(reversed(data.get("alerts") or []))[:50]}


@router.get("/{fid}/metrics")
def metrics(fid: str, days: int = 30) -> dict:
    _visible_function(fid)
    return _metrics(fid, max(1, min(days, RUNS_KEPT_DAYS)))


@router.get("/{fid}/runs")
def runs(fid: str, days: int = 7) -> list[dict]:
    _visible_function(fid)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return [r for r in reversed(_runs(fid)["runs"]) if r["at"] >= since][:500]
