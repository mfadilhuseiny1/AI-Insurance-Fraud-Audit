"""Container-backed models (Model integration → Container models).

A model resource owns a Docker Artifacts repository (container_registry.py): images are pushed into it with the
registry's usual commands, and the repository's Files item governs the model (its viewers can use the model and
pull its images, its editors push and create versions). A model version picks one or more of those images with
their runtime settings (the port the image listens on, environment variables, arguments, an exec command, a memory
limit, telemetry) and a container model adapter: a class from a Code Repository file implementing
`palantir_models.ContainerModelAdapter` (`init_container(container_context)`, `api()`, `predict(...)`).

At run time (model_container.py) every image of the version starts as a container (sidecar_slot.py: ports published
on localhost, one shared empty volume), the adapter gets a ContainerizedApplicationContext whose `services` map each
container name to its "localhost:<port>" URIs, and requests from the adapter to those ports reach the containers.
Transforms use it through `ModelInput("ri.models.main.model.<id>", "ri.models.main.model-version.<id>")`; this
module also runs a version on rows sent from the model page (POST /versions/<id>/predict).

Models trained here (kind "python"): a Python transform's `ModelOutput(path).publish(adapter)` (model_lib.py) stages
the adapter's saved files, its API and source; when the build succeeds `commit_build` creates the model (a Files item
of type MODEL_TYPE at the path, which governs it) and a version under data/model-assets/<model id>/<version>/
(state/ = the saved files, adapter/ = the source snapshot), with its experiment, and commits the evaluations the
build logged. `resolve_ref` gives the runner a version by path or rid, pinned, on a branch or the latest.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import auth
import container_registry
import container_runtime

router = APIRouter(prefix="/api/model-assets", tags=["model-assets"])
DIR = Path("data/model-assets")
HERE = Path(__file__).resolve().parent
MODEL_RID = "ri.models.main.model."
MODEL_TYPE = "application/vnd.bluesandai.model+json"
MAX_EVALUATION_SETS = 100
VERSION_RID = "ri.models.main.model-version."
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "model-assets"
    DIR.mkdir(parents=True, exist_ok=True)


def image_references() -> dict[tuple[str, str], set[str]]:
    """The registry images container model versions run, by digest: {(Artifacts repository id, image): {digest}}.
    The registry's garbage collection keeps them even when their tag was moved or deleted."""
    out: dict[tuple[str, str], set[str]] = {}
    for p in sorted(DIR.glob("mdl-*.json")):
        rec = json.loads(p.read_text("utf-8"))
        if rec.get("kind", "container") != "container" or not rec.get("repo_id"):
            continue
        for v in rec.get("versions") or []:
            for im in v.get("images") or []:
                if im.get("image") and im.get("digest"):
                    out.setdefault((rec["repo_id"], im["image"]), set()).add(im["digest"])
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


def _path(model_id: str) -> Path:
    if not re.fullmatch(r"mdl-[0-9a-f]{12}", model_id):
        raise HTTPException(404, "model not found")
    return DIR / f"{model_id}.json"


def _read(model_id: str) -> dict:
    p = _path(model_id)
    if not p.exists():
        raise HTTPException(404, "model not found")
    return json.loads(p.read_text("utf-8"))


def _write(rec: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = _path(rec["id"]).with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rec, indent=1), "utf-8")
    os.replace(tmp, _path(rec["id"]))


def _get(model_id: str, need: str = "viewer") -> tuple[dict, Optional[dict]]:
    """(model, its Artifacts repository or None) when the caller has `need` on the Files item governing the model (the
    Artifacts repository of a container model, the model's own item for one trained here)."""
    import drive

    rec = _read(model_id)
    if rec.get("kind", "container") != "container":
        item = drive._item(rec["item_id"], need=need)
        if item.get("trashed_at"):
            raise HTTPException(404, "model not found")
        return rec, None
    repo = container_registry.get(rec["repo_id"])
    if need != "viewer":
        drive._item(repo["item_id"], need=need)
    return rec, repo


def by_rid(rid: str) -> dict:
    rid = str(rid or "").strip()
    if not rid.startswith(MODEL_RID):
        raise HTTPException(404, f"{rid} is not a model resource identifier ({MODEL_RID}<id>)")
    return _get("mdl-" + rid[len(MODEL_RID):])[0]


def _version(rec: dict, ref: Optional[str]) -> dict:
    vs = rec.get("versions") or []
    if not vs:
        raise HTTPException(400, f"the model {rec['name']} has no versions yet: create one on its page")
    if not ref:
        return vs[-1]
    ref = str(ref).strip()
    v = next((x for x in vs if ref in (x["id"], x["rid"], x["version"])), None)
    if not v:
        raise HTTPException(404, f"no version {ref} of the model {rec['name']}")
    return v


def _summary(rec: dict) -> dict:
    last = (rec.get("versions") or [None])[-1]
    return {k: rec.get(k) for k in ("id", "rid", "name", "description", "repo_id", "item_id", "created_at", "created_by")} | {
        "kind": rec.get("kind", "container"), "versions": len(rec.get("versions") or []), "latest": last and last["version"],
        "updated_at": (last or {}).get("created_at") or rec["created_at"]}


# ------------------------------------------------------------------------------------------------
# models and versions
# ------------------------------------------------------------------------------------------------


class ModelIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    folder_id: str
    description: str = Field(default="", max_length=2000)


class ImageIn(BaseModel):
    image: str = Field(min_length=1, max_length=200)
    tag: str = Field(min_length=1, max_length=128)
    # the port the image listens on (else the ports it exposes)
    port: Optional[int] = Field(None, ge=1, le=65535)
    env: dict[str, str] = Field(default_factory=dict)
    # arguments to the image's command, or (command) a new exec command
    args: list[str] = Field(default_factory=list)
    command: Optional[list[str]] = None
    # a docker memory limit, e.g. "2g"
    memory: Optional[str] = Field(None, pattern=r"^\d+(\.\d+)?[kmg]?$")


class VersionIn(BaseModel):
    images: list[ImageIn] = Field(min_length=1, max_length=8)
    adapter_repo_id: str
    adapter_file: str = Field(min_length=1, max_length=400)
    adapter_class: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    bump: Literal["major", "minor", "patch"] = "minor"
    description: str = Field(default="", max_length=2000)
    telemetry: bool = False


@router.get("")
def list_models(kind: Optional[str] = None) -> list[dict]:
    """Model resources the caller may see; `kind`: "container" or "python" only."""
    backfill_container_items()
    out = []
    for p in sorted(DIR.glob("mdl-*.json")):
        try:
            rec, _ = _get(p.stem)
        except HTTPException:
            continue
        if kind and rec.get("kind", "container") != kind:
            continue
        out.append({**_summary(rec), "path": _item_path(rec)})
    return sorted(out, key=lambda r: r["updated_at"], reverse=True)


def _item_path(rec: dict) -> list[str]:
    import db

    item_id = rec.get("item_id")
    if not item_id:
        try:
            item_id = container_registry.get(rec["repo_id"])["item_id"]
        except HTTPException:
            return []
    return [x["name"] for x in db.drive_path(item_id)[:-1]]


@router.post("")
def create_model(req: ModelIn) -> dict:
    name = req.name.strip()
    repo = container_registry.create_repository(container_registry.RepoIn(name=f"{name} model images", folder_id=req.folder_id,
                                                                          description=f"Container images of the model {name}"))
    hexid = uuid.uuid4().hex[:12]
    rec = {"id": f"mdl-{hexid}", "rid": MODEL_RID + hexid, "name": name, "description": req.description.strip(), "repo_id": repo["id"],
           "kind": "container", "created_at": _now(), "created_by": _me(), "versions": []}
    rec["model_item_id"] = _model_item(req.folder_id, name, rec["id"])
    with _lock:
        _write(rec)
    return get_model(rec["id"])


def _model_item(folder_id: str, name: str, model_id: str) -> str:
    """The Files item that names a container model at a path (its Artifacts repository still governs it), so
    ModelInput("/Project/folder/<name>") finds it like a model trained here."""
    import io

    import db
    import drive

    clean = drive._clean_name(name)
    taken = next((c for c in db.drive_list(folder_id) if c["name"] == clean and not c.get("trashed_at")), None)
    body = json.dumps({"model_id": model_id}).encode()
    item = drive._store(folder_id, clean if not taken else drive._free_name(folder_id, clean), io.BytesIO(body), len(body), MODEL_TYPE)
    return item["id"]


def backfill_container_items() -> int:
    """Container models made before they had a Files item of their own get one next to their Artifacts repository."""
    made = 0
    for p in DIR.glob("mdl-*.json"):
        rec = json.loads(p.read_text("utf-8"))
        if rec.get("kind", "container") != "container" or rec.get("model_item_id"):
            continue
        try:
            repo = container_registry.get(rec["repo_id"])
            import db

            folder = (db.drive_get(repo["item_id"]) or {}).get("parent_id")
            if not folder:
                continue
            with _lock:
                rec = _read(rec["id"])
                rec["model_item_id"] = _model_item(folder, rec["name"], rec["id"])
                _write(rec)
            made += 1
        except Exception:  # noqa: BLE001 - a missing repository leaves the model without a path
            continue
    return made


@router.get("/{model_id}")
def get_model(model_id: str) -> dict:
    import drive

    rec, _ = _get(model_id)
    try:
        drive._item(rec.get("item_id") or container_registry.get(rec["repo_id"])["item_id"], need="editor")
        can_edit = True
    except HTTPException:
        can_edit = False
    versions = [{k: v for k, v in x.items() if k not in ("adapter", "external")} | {"adapter": {k: w for k, w in (x.get("adapter") or {}).items() if k != "source"}}
                | ({"external": {k: w for k, w in x["external"].items() if k != "credentials"}} if x.get("external") else {})
                | {"pickle": pickle_info(rec["id"], x["id"])}
                for x in reversed(rec.get("versions") or [])]
    if rec.get("kind", "container") != "container":
        return {**_summary(rec), "path": _item_path(rec), "versions_detail": versions, "can_edit": can_edit,
                "evaluation_sets": sorted({e["set"] for e in _evaluations(rec["id"])}), "experiments": len(_experiments(rec["id"]))}
    repo = container_registry.repository(rec["repo_id"])
    return {**_summary(rec), "path": _item_path(rec), "versions_detail": versions, "repository": repo, "can_edit": can_edit}


@router.delete("/{model_id}")
def delete_model(model_id: str) -> dict:
    """The model record; its Artifacts repository stays in Files (delete it there)."""
    rec, _ = _get(model_id, need="editor")
    if rec.get("kind", "container") != "container":
        # a model trained here is its Files item: it goes to the trash (restorable there)
        import drive

        drive.trash(rec["item_id"])
        return {"deleted": rec["id"], "trashed_item": rec["item_id"]}
    with _lock:
        _path(rec["id"]).unlink(missing_ok=True)
    if rec.get("model_item_id"):
        import drive

        try:
            drive.trash(rec["model_item_id"])
        except HTTPException:
            pass
    return {"deleted": rec["id"]}


def _bump(prev: Optional[str], how: str) -> str:
    major, minor, patch = (int(x) for x in (prev or "0.0.0").split("."))
    return {"major": f"{major + 1}.0.0", "minor": f"{major}.{minor + 1}.0", "patch": f"{major}.{minor}.{patch + 1}"}[how]


def _code_repo(repo_id: str, role: str = "viewer") -> dict:
    """A Code Repository with the caller's access checked as /api/code-repos/{id} checks it (its markings and the
    `role` on its Project: Viewer reads its code, Editor builds it): 404 when it is missing or the caller cannot see
    it, 403 when they see it without the role."""
    import code_repos

    rec = code_repos._repo(repo_id)
    if not auth.visible_resources("code_repo", [rec]):
        raise HTTPException(404, "repository not found")
    auth.check_resource("code_repo", repo_id, role)
    return rec


def _adapter_source(repo_id: str, file: str) -> tuple[str, Optional[str]]:
    """The adapter file on the Code Repository's default branch (its last commit) and that commit."""
    import code_repos

    # copying a repository's code into a model version reads the repository (Viewer, its markings)
    crec = _code_repo(repo_id)
    b = code_repos._branch(crec, None)
    files = code_repos._commit_files(repo_id, b.get("head")) if b.get("head") else dict(b.get("files") or {})
    if file not in files:
        raise HTTPException(400, f"{file} is not in the last commit of {crec['name']}'s {b.get('name') or 'default'} branch")
    return files[file], b.get("head")


def _check_adapter(source: str, cls: str) -> None:
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise HTTPException(400, f"the adapter file does not parse: line {e.lineno}: {e.msg}") from None
    node = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls), None)
    if node is None:
        raise HTTPException(400, f"no class {cls} in the adapter file")
    methods = {n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    missing = [m for m in ("api", "predict") if m not in methods]
    if missing:
        raise HTTPException(400, f"{cls} needs {' and '.join(missing)}() (a container model adapter: init_container, api, predict)")
    if "init_container" not in methods and "load" not in methods:
        raise HTTPException(400, f"{cls} needs init_container(cls, container_context) (or load()) to connect to its containers")


@router.post("/{model_id}/versions")
def create_version(model_id: str, req: VersionIn) -> dict:
    rec, repo = _get(model_id, need="editor")
    if repo is None:
        raise HTTPException(400, f"{rec['name']} is trained in a Python transform: new versions come from ModelOutput.publish() in a build")
    # the adapter repository first (Viewer, its markings): nothing about the images is told to one who cannot read it
    _code_repo(req.adapter_repo_id)
    images = []
    for im in req.images:
        if im.tag == "latest":
            raise HTTPException(400, f"{im.image}: pick a versioned tag, not latest")
        _, digest, m = container_registry.find_image([repo["id"]], im.image, im.tag)
        why = container_registry.runnable(m, im.tag)
        if why:
            raise HTTPException(400, f"{im.image}:{im.tag} does not meet the image requirements: {why}")
        ports = [im.port] if im.port else list(m.get("ports") or [])
        images.append({**im.model_dump(), "digest": digest, "ports": ports, "user": m.get("user")})
    names = [i["image"] for i in images]
    if len(set(names)) != len(names):
        raise HTTPException(400, "each image of a version runs as one container: pick an image once")
    source, commit = _adapter_source(req.adapter_repo_id, req.adapter_file)
    _check_adapter(source, req.adapter_class)
    with _lock:
        rec = _read(model_id)
        prev = (rec.get("versions") or [None])[-1]
        hexid = uuid.uuid4().hex[:12]
        v = {"id": f"mv-{hexid}", "rid": VERSION_RID + hexid, "version": _bump(prev and prev["version"], req.bump), "description": req.description.strip(),
             "images": images, "adapter": {"repo_id": req.adapter_repo_id, "file": req.adapter_file, "class": req.adapter_class, "commit": commit, "source": source},
             "telemetry": req.telemetry, "created_at": _now(), "created_by": _me()}
        rec.setdefault("versions", []).append(v)
        _write(rec)
    # live deployments of the model (direct, on its latest version) upgrade: new containers replace the old ones
    _after_new_version(rec, v)
    return v


# ------------------------------------------------------------------------------------------------
# running a version
# ------------------------------------------------------------------------------------------------


def resolve(rid: str, version: Optional[str], label: str) -> dict:
    """What model_container.ContainerModel needs to run a version: each image loaded into the container runtime as a
    sidecar_slot spec, and the adapter. ValueError when it cannot run."""
    try:
        rec = by_rid(rid)
        v = _version(rec, version)
    except HTTPException as e:
        raise ValueError(str(e.detail)) from None
    rt = container_runtime.runtime()
    if rt["kind"] == "off":
        raise ValueError(f"container-backed models need a container runtime: {rt['error']}")
    try:
        repo = container_registry.get(rec["repo_id"])
    except HTTPException as e:
        raise ValueError(f"{rec['name']}: {e.detail}") from None
    base = Path(container_registry.DIR).parent / "sidecars" / f"model-{label}-{uuid.uuid4().hex[:8]}"
    base.mkdir(parents=True, exist_ok=True)
    containers = []
    for im in v["images"]:
        m = ((repo.get("images") or {}).get(im["image"]) or {}).get("manifests", {}).get(im["digest"])
        if not m:
            raise ValueError(f"{im['image']}:{im['tag']} ({im['digest'][:19]}) is no longer in {repo['name']}")
        ref = container_runtime.local_ref(repo["slug"], im["image"], im["digest"])
        try:
            container_runtime.ensure_image(im["digest"], m, ref)
        except container_runtime.RuntimeError_ as e:
            raise ValueError(str(e)) from None
        run_args = [a for k, val in im.get("env", {}).items() for a in ("-e", f"{k}={val}")]
        if im.get("memory"):
            run_args += ["--memory", im["memory"]]
        if im.get("command"):
            run_args += ["--entrypoint", im["command"][0]]
        containers.append({"name": im["image"], "ref": ref, "user": m["user"], "ports": im.get("ports") or [], "volumes": ["shared"],
                           "docker": [*rt["base"], "docker"] if rt["kind"] == "wsl" else list(rt["base"]), "wsl": rt["kind"] == "wsl",
                           "base_dir": str(base.resolve()), "run_args": run_args, "cmd": [*(im.get("command") or [])[1:], *(im.get("args") or [])],
                           "label": base.name, "image": f"{im['image']}:{im['tag']}"})
    return {"model": rec["name"], "rid": rec["rid"], "version": v["version"], "version_rid": v["rid"], "containers": containers,
            "keepalive": [*rt["base"], "sleep", "infinity"] if rt["kind"] == "wsl" else None, "telemetry": v.get("telemetry"),
            "adapter": {k: v["adapter"][k] for k in ("file", "class", "source")}}


class PredictIn(BaseModel):
    # the adapter's inputs by name: rows (a list of objects) for tabular inputs, else a value
    inputs: dict[str, object] = Field(default_factory=dict)
    timeout_s: int = Field(300, ge=10, le=1800)


@router.post("/{model_id}/versions/{version_id}/predict")
def predict(model_id: str, version_id: str, req: PredictIn) -> dict:
    """Run the version on these inputs: start its containers, call the adapter's predict, stop them."""
    rec, _ = _get(model_id)
    v = _version(rec, version_id)
    if rec.get("kind", "container") != "container":
        return _predict_python(rec, v, req)
    try:
        spec = resolve(rec["rid"], v["id"], "predict")
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    with tempfile.TemporaryDirectory(prefix="bsai-model-") as tmp:
        sp = Path(tmp) / "spec.json"
        sp.write_text(json.dumps({"model": spec, "inputs": req.inputs}), "utf-8")
        out = Path(tmp) / "out.json"
        try:
            p = subprocess.run([sys.executable, str(HERE / "model_container.py"), str(sp), str(out)], cwd=str(HERE), capture_output=True,
                               timeout=req.timeout_s, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        except subprocess.TimeoutExpired:
            raise HTTPException(504, f"the model did not answer within {req.timeout_s} s") from None
        finally:
            import shutil

            shutil.rmtree(spec["containers"][0]["base_dir"], ignore_errors=True)
        if not out.exists():
            raise HTTPException(500, f"the model run failed: {(p.stderr or p.stdout).decode(errors='replace').strip()[-2000:]}")
        res = json.loads(out.read_text("utf-8"))
    if not res.get("ok"):
        raise HTTPException(400, {"error": res.get("error"), "logs": res.get("logs")})
    return {"version": v["version"], **res}


# ------------------------------------------------------------------------------------------------
# models trained here (ModelOutput in Python transforms)
# ------------------------------------------------------------------------------------------------


def _vdir(model_id: str, version_id: str) -> Path:
    return DIR / model_id / version_id


def _pickle_file(model_id: str, version_id: str) -> Optional[Path]:
    """The version's trained model as a pickle: MLflow's python_model.pkl, a serializer's dill.pkl, else the first .pkl
    of its saved state (container and externally hosted models have none)."""
    state = _vdir(model_id, version_id) / "state"
    if not state.is_dir():
        return None
    for rel in ("mlflow/python_model.pkl", "model/dill.pkl"):
        if (state / rel).is_file():
            return state / rel
    return next(iter(sorted(state.rglob("*.pkl"))), None)


def pickle_info(model_id: str, version_id: str) -> Optional[dict]:
    p = _pickle_file(model_id, version_id)
    return p and {"file": p.name, "bytes": p.stat().st_size}


@router.get("/{model_id}/versions/{version_id}/pickle")
def download_pickle(model_id: str, version_id: str) -> FileResponse:
    """The version's pickled model, byte for byte as training saved it. MLflow's pickle imports its code/ folder
    (shipped with the version) and the libraries in its requirements.txt when loaded."""
    rec, _ = _get(model_id)
    v = _version(rec, version_id)
    p = _pickle_file(rec["id"], v["id"])
    if not p:
        raise HTTPException(404, f"version {v['version']} of {rec['name']} has no pickle file")
    name = re.sub(r"[^\w.-]+", "_", rec["name"]).strip("_") or rec["id"]
    return FileResponse(p, media_type="application/octet-stream", filename=f"{name}-v{v['version']}-{p.name}")


def _experiments_dir(model_id: str) -> Path:
    return DIR / model_id / "experiments"


def _experiments(model_id: str) -> list[dict]:
    d = _experiments_dir(model_id)
    out = []
    for p in sorted(d.glob("exp-*.json")) if d.exists() else []:
        out.append(json.loads(p.read_text("utf-8")))
    return sorted(out, key=lambda e: e["created_at"])


def _evaluations(model_id: str) -> list[dict]:
    p = DIR / model_id / "evaluations.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _save_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, indent=1, default=str), "utf-8")
    os.replace(tmp, p)


def _by_item(item_id: str) -> Optional[dict]:
    for p in DIR.glob("mdl-*.json"):
        rec = json.loads(p.read_text("utf-8"))
        if item_id in (rec.get("item_id"), rec.get("model_item_id")):
            return rec
    return None


@router.get("/by-item/{item_id}")
def model_by_item(item_id: str) -> dict:
    rec = _by_item(item_id)
    if not rec:
        raise HTTPException(404, "this Files item is not a model")
    return get_model(rec["id"])


def find_ref(ref: str) -> dict:
    """A model by resource identifier or by path (/Project/folder/model); HTTPException when there is none."""
    import db
    import drive

    ref = str(ref or "").strip()
    if ref.startswith(MODEL_RID):
        return by_rid(ref)
    parts = [x for x in ref.split("/") if x]
    if parts and parts[0] == "Files & Projects":
        parts = parts[1:]
    if not parts:
        raise HTTPException(404, f"{ref} is not a model path or resource identifier")
    parent = None
    for name in parts[:-1]:
        found = next((c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and c["name"] == name and not c.get("trashed_at")), None)
        if not found:
            raise HTTPException(404, f"no model at {ref}: {name} not found")
        parent = found["id"]
    item = next((c for c in db.drive_list(parent) if c["name"] == parts[-1] and c.get("content_type") == MODEL_TYPE and not c.get("trashed_at")), None)
    rec = _by_item(item["id"]) if item else None
    if not rec:
        raise HTTPException(404, f"no model at {ref}")
    return _get(rec["id"])[0]


def _pick_version(rec: dict, version: Optional[str], branch: Optional[str], default_branch: str = "master") -> dict:
    """A pinned version (rid, id or number) wins; else the latest on the branch, else on the default branch."""
    vs = rec.get("versions") or []
    if not vs:
        raise ValueError(f"the model {rec['name']} has no versions yet")
    if version:
        try:
            return _version(rec, version)
        except HTTPException as e:
            raise ValueError(str(e.detail)) from None
    for b in [x for x in (branch, default_branch) if x]:
        on = [v for v in vs if (v.get("branch") or default_branch) == b]
        if on:
            return on[-1]
    raise ValueError(f"the model {rec['name']} has no version on the branch {branch or default_branch}")


def python_spec(rec: dict, v: dict, param: Optional[str] = None) -> dict:
    d = _vdir(rec["id"], v["id"])
    spec = {"kind": "python", "model": rec["name"], "rid": rec["rid"], "version": v["version"], "version_rid": v["rid"], "dir": str(d.resolve()),
            "adapter": {k: v["adapter"][k] for k in ("module", "class")}, "api": v.get("api") or {}, "param": param}
    if v.get("external") or rec.get("external"):
        import secretbox

        ext = v.get("external") or rec["external"]
        spec["external"] = {"base_url": ext.get("base_url"), "configuration": ext.get("configuration") or {},
                            "credentials": secretbox.unseal(bytes.fromhex(ext["credentials"])) if ext.get("credentials") else {}}
    return spec


def resolve_ref(ref: str, version: Optional[str], branch: Optional[str], label: str, param: Optional[str] = None,
                default_branch: str = "master") -> dict:
    """What the runner needs for a ModelInput: a container model's containers (resolve) or a trained model's version
    folder and adapter. ValueError when it cannot run."""
    try:
        rec = find_ref(ref)
    except HTTPException as e:
        raise ValueError(str(e.detail)) from None
    if rec.get("kind", "container") == "container":
        return {**resolve(rec["rid"], version, label), "kind": "container", "param": param, "run": label}
    v = _pick_version(rec, version, branch, default_branch)
    # "run": the build (or "preview") the model is resolved for; its transform-call traces are linked to it
    return {**python_spec(rec, v, param), "run": label}


def _ensure_python_model(code_rec: dict, decl: dict) -> dict:
    """The model a ModelOutput names: an existing one (by rid or path), else created at the path."""
    import io

    import code_repos
    import db
    import drive

    ref = decl.get("ref") or decl["name"]
    if str(ref).startswith(MODEL_RID):
        rec = by_rid(ref)
        if rec.get("kind", "container") == "container":
            raise ValueError(f"{rec['name']} is a container model: ModelOutput publishes to models trained in transforms")
        return rec
    folder = code_repos._output_folder(code_rec, decl.get("folder"), code_rec["default_branch"])
    name = drive._clean_name(decl["name"])
    item = next((c for c in db.drive_list(folder) if c["name"] == name and not c.get("trashed_at")), None)
    if item and item.get("content_type") != MODEL_TYPE:
        raise ValueError(f"{name} in that folder is not a model ({item.get('content_type') or item['kind']})")
    if item:
        rec = _by_item(item["id"])
        if rec:
            drive._item(item["id"], need="editor")
            return rec
    drive._item(folder, need="editor")
    hexid = uuid.uuid4().hex[:12]
    body = json.dumps({"model_id": f"mdl-{hexid}"}).encode()
    if not item:
        item = drive._store(folder, name, io.BytesIO(body), len(body), MODEL_TYPE)
    rec = {"id": f"mdl-{hexid}", "rid": MODEL_RID + hexid, "name": name, "description": "", "kind": "python", "item_id": item["id"],
           "created_at": _now(), "created_by": _me(), "versions": [], "source": {"repo_id": code_rec["id"], "repo": code_rec["name"]}}
    with _lock:
        _write(rec)
    return rec


def _unique(name: str, taken: set) -> str:
    if name not in taken:
        return name
    i = 2
    while f"{name}-{i}" in taken:
        i += 1
    return f"{name}-{i}"


def _save_experiment(model_id: str, exp: dict, version: dict) -> dict:
    taken = {e["name"] for e in _experiments(model_id)}
    eid = f"exp-{uuid.uuid4().hex[:12]}"
    rec = {"id": eid, "rid": f"ri.models.main.experiment.{eid[4:]}", **exp, "name": _unique(exp["name"], taken), "version_id": version["id"],
           "version": version["version"], "version_rid": version["rid"], "branch": version.get("branch")}
    _save_json(_experiments_dir(model_id) / f"{eid}.json", rec)
    return rec


def add_version(rec: dict, staged_zip: bytes, branch: str, source: dict, training: list, code: Optional[dict] = None) -> dict:
    """A staged version (model_lib's state/, adapter/ and version.json, zipped) becomes the model's next version.
    code: the training code's record (code_provenance.summary), kept with the version for its audit."""
    import io
    import zipfile

    hexid = uuid.uuid4().hex[:12]
    vid = f"mv-{hexid}"
    d = _vdir(rec["id"], vid)
    d.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(staged_zip)) as z:
        for n in z.namelist():
            if d.resolve() not in (d / n).resolve().parents:
                raise ValueError(f"unsafe path {n} in the staged model")
        z.extractall(d)
    meta = json.loads((d / "version.json").read_text("utf-8"))
    with _lock:
        rec = _read(rec["id"])
        prev = (rec.get("versions") or [None])[-1]
        v = {"id": vid, "rid": VERSION_RID + hexid, "version": _bump(prev and prev["version"], "minor"), "branch": branch, "kind": "python",
             "description": "", "api": meta["api"], "adapter": {**meta["adapter"], "files": len(meta["adapter"].get("files") or [])},
             "serializers": meta.get("serializers"), "custom_serialization": meta.get("custom_serialization"), "source": source,
             "training_datasets": training, **({"code": code} if code else {}),
             "size_bytes": sum(f.stat().st_size for f in (d / "state").rglob("*") if f.is_file()) if (d / "state").exists() else 0,
             "created_at": _now(), "created_by": _me()}
        if meta.get("experiment"):
            v["experiment_id"] = _save_experiment(rec["id"], meta["experiment"], v)["id"]
        rec.setdefault("versions", []).append(v)
        _write(rec)
    _after_new_version(rec, v)
    return v


def commit_build(code_rec: dict, t: dict, branch: str, b: dict, res: dict) -> None:
    """After a successful build: each ModelOutput's staged version becomes a model version, and the evaluations the
    build logged are committed to their evaluation sets. Adds b["model_versions"] / b["evaluations"]."""
    import drive

    decls = t.get("model_outputs") or {}
    published = []
    for o in res.get("model_outputs") or []:
        rec = _ensure_python_model(code_rec, decls.get(o["param"]) or {})
        source = {"repo_id": code_rec["id"], "repo": code_rec["name"], "transform": b["transform"], "commit": b.get("commit"), "build": b["id"],
                  "branch": branch}
        v = add_version(rec, o["zip"], branch, source, [{"item_id": i["item_id"], "name": i["item_name"]} for i in b.get("inputs") or []])
        published.append({"model_id": rec["id"], "model": rec["name"], "rid": rec["rid"], "version": v["version"], "version_rid": v["rid"]})
    if published:
        b["model_versions"] = published
    evs = []
    for ev in res.get("evaluations") or []:
        rec = by_rid(ev["model"])
        drive._item(rec.get("item_id") or container_registry.get(rec["repo_id"])["item_id"], need="editor")
        with _lock:
            allv = _evaluations(rec["id"])
            sets = {e["set"] for e in allv}
            if ev["set"] not in sets and len(sets) >= MAX_EVALUATION_SETS:
                raise ValueError(f"{rec['name']} has {MAX_EVALUATION_SETS} evaluation sets already")
            v = next((x for x in rec.get("versions") or [] if x["rid"] == ev["version_rid"]), None)
            item = {**ev, "id": f"ev-{uuid.uuid4().hex[:12]}", "name": _unique(ev["name"], {e["name"] for e in allv if e["set"] == ev["set"]}),
                    "version_id": v and v["id"], "version": v and v["version"], "branch": (v or {}).get("branch") or branch,
                    "source": {"repo_id": code_rec["id"], "repo": code_rec["name"], "transform": b["transform"], "build": b["id"], "branch": branch}}
            allv.append(item)
            _save_json(DIR / rec["id"] / "evaluations.json", allv)
            sched = _eval_schedules(rec["id"])
            if not any(s["set"] == ev["set"] and s["repo_id"] == code_rec["id"] and s["transform"] == b["transform"] for s in sched):
                # remembered so the evaluation can be re-run (Run) or scheduled on new versions
                sched.append({"set": ev["set"], "repo_id": code_rec["id"], "transform": b["transform"], "branch": branch, "on_new_version": False})
                _save_json(DIR / rec["id"] / "evaluation-runs.json", sched)
        evs.append({"model": rec["name"], "set": ev["set"], "name": item["name"], "version": item["version"], "metrics": len(ev.get("metrics") or {})})
    if evs:
        b["evaluations"] = evs


def record_api(model_id: str, version_id: str, api: dict) -> None:
    """The API a loaded adapter declares, kept on a version that did not record one (container versions)."""
    with _lock:
        rec = _read(model_id)
        for v in rec.get("versions") or []:
            if v["id"] == version_id and not v.get("api"):
                v["api"] = api
        _write(rec)


def _eval_schedules(model_id: str) -> list[dict]:
    p = DIR / model_id / "evaluation-runs.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _after_new_version(rec: dict, v: dict) -> None:
    """A new version: direct deployments on its branch upgrade; evaluations scheduled on new versions run."""
    try:
        import model_deployments

        model_deployments.on_new_version(rec, v)
    except ImportError:
        pass
    for s in _eval_schedules(rec["id"]):
        if s.get("on_new_version"):
            threading.Thread(target=_scheduled_evaluation, args=(s, v["rid"], rec["id"]), daemon=True).start()


def _scheduled_evaluation(s: dict, version_rid: Optional[str], model_id: Optional[str] = None) -> Optional[dict]:
    """An evaluation scheduled on new versions builds as the user who turned the schedule on (never as the system):
    they need the Editor role on the evaluation transform's repository (and its markings) and may run code; else it
    does not run. The outcome (failed with the reason, or the build's status) is kept on the schedule (last_run)."""
    import logging

    import run_as

    try:
        with run_as.as_owner(s.get("owner"), "the evaluation schedule"):
            _code_repo(s["repo_id"], "editor")
            auth.require_code_author()
            b = _run_evaluation_transform(s, version_rid)
    except Exception as e:  # noqa: BLE001 - the owner is gone or lost access: the evaluation does not run
        err = f"did not run: {getattr(e, 'detail', None) or e}"
        if not isinstance(e, run_as.OwnerUnavailable):
            err += f" (as the schedule's owner {run_as.who(s.get('owner'))}: an Editor must turn the schedule on again)"
        logging.getLogger("model_assets").warning("evaluation %s on a new version %s", s.get("set"), err)
        _record_scheduled_run(model_id, s, {"at": _now(), "version": version_rid, "status": "failed", "error": err[:800], "by": s.get("owner")})
        return None
    _record_scheduled_run(model_id, s, {"at": _now(), "version": version_rid, "status": b.get("status"), "build_id": b.get("id"),
                                        "error": (str(b.get("error"))[:800] if b.get("error") else None), "by": s.get("owner")})
    return b


def _record_scheduled_run(model_id: Optional[str], s: dict, run: dict) -> None:
    """The last run of an evaluation schedule (on new versions), on the schedule: listed with the evaluation set."""
    if not model_id:
        return
    with _lock:
        sched = _eval_schedules(model_id)
        hit = False
        for x in sched:
            if (x.get("set"), x.get("repo_id"), x.get("transform")) == (s.get("set"), s.get("repo_id"), s.get("transform")):
                x["last_run"] = run
                hit = True
        if hit:
            _save_json(DIR / model_id / "evaluation-runs.json", sched)


def _run_evaluation_transform(s: dict, version_rid: Optional[str]) -> dict:
    """Build the transform that writes an evaluation set (its ModelInputs pinned to a version when given)."""
    import code_repos

    rec = code_repos._repo(s["repo_id"])
    b = code_repos._branch(rec, s.get("branch"))
    files = code_repos._commit_files(rec["id"], b["head"]) if b.get("head") else dict(b.get("files") or {})
    return code_repos.build_transform(rec, files, b["name"], s["transform"], "evaluation", b.get("head"), model_version=version_rid)


# -- experiments and evaluations ------------------------------------------------------------------


@router.get("/{model_id}/experiments")
def list_experiments(model_id: str) -> list[dict]:
    rec, _ = _get(model_id)
    return [{k: e.get(k) for k in ("id", "name", "version", "version_id", "branch", "created_at", "params")} |
            {"metrics": {k: {"last": s[-1]["value"], "min": min(x["value"] for x in s), "max": max(x["value"] for x in s), "count": len(s)}
                         for k, s in (e.get("metrics") or {}).items() if s},
             "images": len(e.get("images") or {}), "plots": len(e.get("plots") or {}), "tables": len(e.get("tables") or {}),
             "evaluations": len(e.get("evaluations") or {})}
            for e in reversed(_experiments(rec["id"]))]


@router.get("/{model_id}/experiments/{exp_id}")
def get_experiment(model_id: str, exp_id: str) -> dict:
    rec, _ = _get(model_id)
    e = next((x for x in _experiments(rec["id"]) if x["id"] == exp_id), None)
    if not e:
        raise HTTPException(404, "experiment not found")
    return e


@router.get("/{model_id}/evaluations")
def list_evaluations(model_id: str, evaluation_set: Optional[str] = None) -> dict:
    """Evaluation sets and the chosen set's evaluations, newest version first."""
    rec, _ = _get(model_id)
    sets: dict[str, list] = {}
    for e in _evaluations(rec["id"]):
        sets.setdefault(e["set"], []).append(e)
    pick = evaluation_set or (sorted(sets)[0] if sets else None)
    order = {v["id"]: i for i, v in enumerate(rec.get("versions") or [])}
    chosen = sorted(sets.get(pick, []), key=lambda e: (order.get(e.get("version_id"), -1), e["created_at"]), reverse=True)
    return {"sets": [{"name": k, "evaluations": len(v), "last": max(x["created_at"] for x in v)} for k, v in sorted(sets.items())],
            "set": pick, "evaluations": chosen, "schedules": [s for s in _eval_schedules(rec["id"]) if s["set"] == pick]}


class EvalScheduleIn(BaseModel):
    on_new_version: bool


@router.put("/{model_id}/evaluations/{evaluation_set}/schedule")
def set_evaluation_schedule(model_id: str, evaluation_set: str, req: EvalScheduleIn) -> list[dict]:
    rec, _ = _get(model_id, need="editor")
    with _lock:
        sched = _eval_schedules(rec["id"])
        hits = [s for s in sched if s["set"] == evaluation_set]
        if not hits:
            raise HTTPException(404, "no transform has written this evaluation set yet: build it once first")
        if req.on_new_version:
            # the schedule builds the evaluation transform: Editors of its repository who may run code; it runs as them
            for s in hits:
                _code_repo(s["repo_id"], "editor")
            auth.require_code_author()
        for s in hits:
            s["on_new_version"] = req.on_new_version
            if req.on_new_version:
                s["owner"] = (auth.current() or {}).get("id")
        _save_json(DIR / rec["id"] / "evaluation-runs.json", sched)
    return hits


class EvalRunIn(BaseModel):
    version_id: Optional[str] = None


@router.post("/{model_id}/evaluations/{evaluation_set}/run")
def run_evaluation(model_id: str, evaluation_set: str, req: EvalRunIn) -> dict:
    """Run the evaluation logic of this set (the transform that last wrote it) against a chosen version."""
    rec, _ = _get(model_id, need="editor")
    hits = [s for s in _eval_schedules(rec["id"]) if s["set"] == evaluation_set]
    if not hits:
        raise HTTPException(404, "no transform has written this evaluation set yet: build it once first")
    v = _version(rec, req.version_id) if req.version_id else None
    # a build of the evaluation transform: the Editor role on its repository (and its markings), and running code
    _code_repo(hits[-1]["repo_id"], "editor")
    auth.require_code_author()
    b = _run_evaluation_transform(hits[-1], v and v["rid"])
    return {k: b.get(k) for k in ("id", "status", "error", "evaluations", "transform", "repo_id")}


# -- test runs ------------------------------------------------------------------------------------


def _predict_python(rec: dict, v: dict, req: "PredictIn") -> dict:
    import model_worker

    try:
        client = model_worker.Client(python_spec(rec, v), start_timeout=req.timeout_s)
    except model_worker.WorkerError as e:
        raise HTTPException(400, {"error": str(e), "logs": e.detail.get("logs") or e.detail.get("traceback")}) from None
    try:
        res = client.query(dict(req.inputs), cast=True, timeout=req.timeout_s)
    except model_worker.WorkerError as e:
        raise HTTPException(504 if "within" in str(e) else 500, str(e)) from None
    finally:
        client.close()
    import model_telemetry

    model_telemetry.report(res.get("spans"), {"model.name": rec.get("name"), "model.rid": rec.get("rid"), "model.version": v["version"]}, "test run")
    if not res.get("ok"):
        raise HTTPException(400, {"error": res.get("error"), "logs": (res.get("logs") or "") + (res.get("traceback") or "")})
    outs = {k: (o.get("rows") if "rows" in o else o.get("value")) for k, o in (res.get("outputs") or {}).items()}
    return {"version": v["version"], "ok": True, "outputs": outs, "logs": res.get("logs") or "", "ms": res.get("ms"), "spans": res.get("spans") or []}


# ------------------------------------------------------------------------------------------------
# upgrade the model adapter without retraining (integrate-models/upgrade-model-adapter)
# ------------------------------------------------------------------------------------------------

ADAPTER_SUFFIXES = (".py", ".json", ".yaml", ".yml", ".txt", ".csv")


def _adapter_upgrade_plan(rec: dict, v: dict, branch: Optional[str] = None) -> dict:
    """What an adapter upgrade of this version would use: the adapter's source at the latest commit of its Code
    Repository branch, compared with the source snapshot published with the version. "_files" holds that source."""
    import code_repos

    if rec.get("kind", "container") != "python" or v.get("external") or rec.get("external") or v.get("kind") != "python":
        raise HTTPException(400, "only models trained in Code Repositories can have their adapter upgraded")
    src = v.get("source") or {}
    if not src.get("repo_id"):
        raise HTTPException(400, "this version was not published from a Code Repository")
    try:
        crec = code_repos._repo(src["repo_id"])
    except HTTPException:
        raise HTTPException(400, f"the Code Repository {src.get('repo') or src['repo_id']} of this version no longer exists") from None
    # the plan shows the repository's commits and code, the upgrade copies it: Viewer of the repository, its markings
    _code_repo(crec["id"])
    name = branch or src.get("branch") or crec["default_branch"]
    if name not in crec["branches"]:
        if branch:
            raise HTTPException(404, f'the repository {crec["name"]} has no branch "{branch}"')
        name = crec["default_branch"]
    b = crec["branches"][name]
    files = code_repos._commit_files(crec["id"], b["head"]) if b.get("head") else dict(b.get("files") or {})
    a = v["adapter"]
    mod = a["module"].replace(".", "/")
    roots = []
    for tail in (f"{mod}.py", f"{mod}/__init__.py"):
        roots += [p[: len(p) - len(tail)] for p in files if p == tail or p.endswith("/" + tail)]
    if not roots:
        raise HTTPException(409, f"the module {a['module']} is not in {crec['name']} on {name}: the updated model adapter must be in the same "
                                 "Python module, with the same class name, as the original")
    want = (a.get("root") or "") + "/"
    root = sorted(roots, key=lambda r: (not (r == want or r.endswith("/" + want)), len(r)))[0]
    mod_file = next(p for p in (root + f"{mod}.py", root + f"{mod}/__init__.py") if p in files)
    top = a["class"].split(".")[0]
    if not re.search(rf"^class\s+{re.escape(top)}\b", files[mod_file], re.M):
        raise HTTPException(409, f"{mod_file} on {name} does not define the class {top}: the updated model adapter must keep its class name")
    new = {}
    for p, content in files.items():
        rel = p[len(root):]
        parts = rel.split("/")
        if not p.startswith(root) or not isinstance(content, str) or not rel.endswith(ADAPTER_SUFFIXES):
            continue
        if "__pycache__" in parts or any(x.startswith(".") for x in parts):
            continue
        new[rel] = content
    snap = _vdir(rec["id"], v["id"]) / "adapter"
    old = {p.relative_to(snap).as_posix(): p.read_text("utf-8", errors="replace") for p in snap.rglob("*") if p.is_file()} if snap.exists() else {}
    norm = lambda s: s.replace("\r\n", "\n")  # noqa: E731
    changed = [{"path": p, "status": "added" if p not in old else "modified"} for p in sorted(new) if p not in old or norm(old[p]) != norm(new[p])]
    changed += [{"path": p, "status": "removed"} for p in sorted(old) if p not in new]
    meta = code_repos._commit_meta(crec, b.get("head")) or {}
    return {"repo": {"id": crec["id"], "name": crec["name"]}, "branch": name, "commit": b.get("head"), "commit_message": meta.get("message"),
            "commit_at": meta.get("at"), "from_commit": src.get("commit"), "module": a["module"], "class": a["class"], "root": root.rstrip("/") or ".",
            "adapter_file": mod_file, "changed": changed, "adapter_changed": any(c["path"] == mod_file[len(root):] for c in changed),
            "up_to_date": not changed, "files": len(new), "_files": new}


class AdapterUpgradeIn(BaseModel):
    # the repository branch to take the adapter from (default: the branch the version was trained on)
    branch: Optional[str] = Field(default=None, max_length=200)
    description: str = Field(default="", max_length=2000)


@router.get("/{model_id}/versions/{version_id}/adapter-upgrade")
def adapter_upgrade_plan(model_id: str, version_id: str, branch: Optional[str] = None) -> dict:
    """The Inference configuration card's "Upgrade model adapter": the commit and source changes an upgrade would take."""
    rec, _ = _get(model_id)
    plan = _adapter_upgrade_plan(rec, _version(rec, version_id), branch)
    return {k: w for k, w in plan.items() if k != "_files"}


@router.post("/{model_id}/versions/{version_id}/adapter-upgrade")
def adapter_upgrade(model_id: str, version_id: str, req: AdapterUpgradeIn) -> dict:
    """A new model version: this version's published model artifacts (weights) with the adapter as it is at the latest
    commit of its repository. The new adapter must load the artifacts, else nothing is created. Submissions to
    modeling objectives are not moved: the new version is submitted again."""
    import shutil

    import model_worker

    rec, _ = _get(model_id, need="editor")
    v = _version(rec, version_id)
    plan = _adapter_upgrade_plan(rec, v, req.branch)
    if plan["up_to_date"]:
        raise HTTPException(409, f"the adapter of {v['version']} is already the one at {plan['branch']}'s latest commit: commit the adapter change first")
    old_dir = _vdir(rec["id"], v["id"])
    hexid = uuid.uuid4().hex[:12]
    vid = f"mv-{hexid}"
    d = _vdir(rec["id"], vid)
    try:
        d.mkdir(parents=True)
        if (old_dir / "state").exists():
            shutil.copytree(old_dir / "state", d / "state")
        for rel, content in plan["_files"].items():
            target = d / "adapter" / rel
            if (d / "adapter").resolve() not in target.resolve().parents:
                raise HTTPException(400, f"unsafe path {rel} in the repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content.encode("utf-8"))
        meta = json.loads((old_dir / "version.json").read_text("utf-8")) if (old_dir / "version.json").exists() else {}
        meta["adapter"] = {**(meta.get("adapter") or {}), "module": plan["module"], "class": plan["class"], "files": sorted(plan["_files"])}
        meta["adapter_upgraded_from"] = v["rid"]
        (d / "version.json").write_text(json.dumps(meta, default=str), "utf-8")
        # the upgraded adapter must load the existing artifacts (in its own process, from the new source only)
        spec = {**python_spec(rec, v), "dir": str(d.resolve()), "version_rid": VERSION_RID + hexid}
        try:
            client = model_worker.Client(spec, start_timeout=300)
        except model_worker.WorkerError as e:
            raise HTTPException(400, {"error": f"the upgraded adapter does not load this version's model artifacts: {e}",
                                      "logs": e.detail.get("traceback") or e.detail.get("logs")}) from None
        api = client.api or v.get("api") or {}
        client.close()
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    with _lock:
        rec = _read(rec["id"])
        prev = rec["versions"][-1]
        nv = {"id": vid, "rid": VERSION_RID + hexid, "version": _bump(prev["version"], "patch"), "branch": v.get("branch"), "kind": "python",
              "description": req.description.strip() or f"Adapter upgraded from {v['version']} (same model artifacts)", "api": api,
              "adapter": {**{k: w for k, w in v["adapter"].items() if k != "files"}, "files": len(plan["_files"])},
              "serializers": v.get("serializers"), "custom_serialization": v.get("custom_serialization"),
              "source": {**(v.get("source") or {}), "commit": plan["commit"], "branch": plan["branch"], "adapter_upgrade": True},
              "training_datasets": v.get("training_datasets") or [], "size_bytes": v.get("size_bytes") or 0,
              "upgraded_from": {"id": v["id"], "rid": v["rid"], "version": v["version"]},
              "api_changed": json.dumps(api, sort_keys=True, default=str) != json.dumps(v.get("api") or {}, sort_keys=True, default=str),
              "created_at": _now(), "created_by": _me()}
        if v.get("experiment_id"):
            nv["experiment_id"] = v["experiment_id"]
        rec["versions"].append(nv)
        _write(rec)
    _after_new_version(rec, nv)
    return {**{k: w for k, w in nv.items() if k != "adapter"}, "changed": plan["changed"], "commit": plan["commit"]}


# ------------------------------------------------------------------------------------------------
# externally hosted models (integrate-models/external-model-connection)
# ------------------------------------------------------------------------------------------------


class ExternalIn(BaseModel):
    # the model (only when creating it)
    name: Optional[str] = Field(default=None, max_length=80)
    folder_id: Optional[str] = None
    description: str = Field(default="", max_length=2000)
    # the connection: the URL given to the adapter, unencrypted configuration, encrypted credentials
    base_url: str = Field(default="", max_length=2000)
    configuration: dict[str, str] = Field(default_factory=dict)
    # a new version keeps a credential sent empty
    credentials: dict[str, str] = Field(default_factory=dict)
    # the adapter: a pm.ExternalModelAdapter class from a Code Repository file (its default branch's last commit)
    adapter_repo_id: Optional[str] = None
    adapter_file: Optional[str] = Field(default=None, max_length=400)
    adapter_class: Optional[str] = Field(default=None, max_length=200, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    note: str = Field(default="", max_length=2000)


def _repo_snapshot(repo_id: str, file: str) -> tuple[dict[str, str], str, Optional[str]]:
    """(the source files under the adapter's src root, the adapter's module name, the commit)."""
    import code_repos

    # the adapter's code is copied from the repository: Viewer of it, its markings
    crec = _code_repo(repo_id)
    b = code_repos._branch(crec, None)
    files = code_repos._commit_files(repo_id, b.get("head")) if b.get("head") else dict(b.get("files") or {})
    if file not in files:
        raise HTTPException(400, f"{file} is not in the last commit of {crec['name']}'s default branch")
    parts = file.split("/")
    root = "/".join(parts[: parts.index("src") + 1]) if "src" in parts[:-1] else "/".join(parts[:-1])
    rel = file[len(root) + 1:] if root else file
    module = rel[:-3].replace("/", ".") if rel.endswith(".py") else rel
    module = module.removesuffix(".__init__")
    snap = {k[len(root) + 1:] if root else k: v for k, v in files.items() if k.endswith(".py") and (not root or k.startswith(root + "/"))}
    return snap, module, b.get("head")


def _external_version(rec: dict, req: ExternalIn, prev: Optional[dict]) -> dict:
    import secretbox

    import model_worker

    pe = (prev or {}).get("external") or {}
    old_creds = secretbox.unseal(bytes.fromhex(pe["credentials"])) if pe.get("credentials") else {}
    creds = {**old_creds, **{k: v for k, v in req.credentials.items() if v != ""}}
    repo_id = req.adapter_repo_id or (prev or {}).get("adapter", {}).get("repo_id")
    file = req.adapter_file or (prev or {}).get("adapter", {}).get("file")
    cls = req.adapter_class or (prev or {}).get("adapter", {}).get("class")
    if not (repo_id and file and cls):
        raise HTTPException(400, "choose the model adapter: a Code Repository, a file and a class")
    snap, module, commit = _repo_snapshot(repo_id, file)
    ext = {"base_url": req.base_url.strip() or pe.get("base_url", ""), "configuration": req.configuration or pe.get("configuration") or {},
           "credentials": secretbox.seal(creds).hex() if creds else None, "credential_keys": sorted(creds)}
    hexid = uuid.uuid4().hex[:12]
    vid = f"mv-{hexid}"
    d = _vdir(rec["id"], vid)
    for rel, text in snap.items():
        (d / "adapter" / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / "adapter" / rel).write_text(text, "utf-8")
    (d / "state").mkdir(parents=True, exist_ok=True)
    v = {"id": vid, "rid": VERSION_RID + hexid, "kind": "python", "external": ext, "description": req.note.strip(),
         "adapter": {"module": module, "class": cls, "repo_id": repo_id, "file": file, "commit": commit, "root": "src", "files": len(snap)}}
    # the adapter must load (init_external with this connection); its API is recorded with the version
    try:
        client = model_worker.Client(python_spec(rec, {**v, "version": "check", "api": {}}), start_timeout=120)
    except model_worker.WorkerError as e:
        import shutil

        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, {"error": f"the adapter did not load: {e}", "logs": (e.detail or {}).get("traceback")}) from None
    api = client.api
    client.close()
    meta = {"api": api, "adapter": {"module": module, "class": cls, "root": "src", "files": sorted(snap)}, "serializers": None, "custom_serialization": True}
    (d / "version.json").write_text(json.dumps(meta), "utf-8")
    with _lock:
        rec = _read(rec["id"])
        last = (rec.get("versions") or [None])[-1]
        v.update(version=_bump(last and last["version"], "minor"), branch="master", api=api, serializers=None, custom_serialization=True,
                 source={"kind": "external", "repo_id": repo_id, "repo": "", "transform": file, "build": "", "branch": "master"}, training_datasets=[],
                 size_bytes=0, created_at=_now(), created_by=_me())
        rec.setdefault("versions", []).append(v)
        _write(rec)
    _after_new_version(rec, v)
    return v


@router.post("/external")
def create_external(req: ExternalIn) -> dict:
    """Connect an externally hosted model: a model resource whose versions hold the connection and the adapter."""
    import model_studio

    if not req.name or not req.folder_id:
        raise HTTPException(400, "name the model and choose its folder")
    if req.adapter_repo_id:
        # refused before the model is made: the adapter repository must be readable (Viewer, its markings)
        _code_repo(req.adapter_repo_id)
    rec = model_studio.create_python_model(req.folder_id, req.name, {"kind": "external"})
    with _lock:
        rec = _read(rec["id"])
        rec["description"] = req.description.strip()
        rec["external"] = {"hosted": True}
        _write(rec)
    try:
        _external_version(rec, req, None)
    except HTTPException:
        import drive

        drive.trash(rec["item_id"])
        raise
    return get_model(rec["id"])


@router.post("/{model_id}/external/versions")
def external_version(model_id: str, req: ExternalIn) -> dict:
    """A new version of an externally hosted model: changed URL, configuration, credentials or adapter."""
    rec, _ = _get(model_id, need="editor")
    if not rec.get("external"):
        raise HTTPException(400, "this is not an externally hosted model")
    _external_version(rec, req, (rec.get("versions") or [None])[-1])
    return get_model(model_id)


# telemetry: OTLP export setting, traces of models called in transforms (model_telemetry.py)
import model_telemetry  # noqa: E402

model_telemetry.register(router)
