"""Jupyter Code Workspaces on RunPod (palantir.com/docs/foundry/code-workspaces; Model Integration tutorial 2b).

A workspace is a Files item (WORKSPACE_TYPE) with a compute choice (a GPU type or CPU, disk), dataset aliases (read
an existing dataset, or write a new one), and model aliases (models trained here, model_assets.py). Start creates a
RunPod Pod (rest.runpod.io, RUNPOD_API_KEY) from RunPod's PyTorch image, which serves JupyterLab on port 8888 behind
RunPod's proxy (https://<pod id>-8888.proxy.runpod.net), protected by a token generated per workspace. The pod's start
command first downloads this platform's client (workspace_client.py + model_lib.py, as the packages palantir_models
and foundry) from the platform's public URL (BLUESANDAI_PUBLIC_URL, default https://hexa.bluesandai.com) and writes
the adapter skeleton of each model alias into /workspace; notebooks then use

    Dataset.get("alias").read_table() / .write_table(df)                 (foundry.transforms)
    ModelOutput("alias").publish(adapter, experiment=...)  ModelInput("alias")   (palantir_models.code_workspaces)

which call the pod endpoints below (/api/code-workspace-pod/<id>/...) with a secret made for the pod when it is
created: it reaches only that workspace's aliases, acting as the workspace's owner (no session, no other endpoint),
and is forgotten when the pod is terminated. Pods created before that kept a 30-day job token on /pod/* routes. Published versions are ordinary model versions: Modeling Objectives,
deployments and evaluation use them like any other.

Cloud CPU machines run on Google Compute Engine instead (gce_machines.py: an e2-standard VM serving Jupyter over
TLS with a certificate pinned by the API, GCP_COMPUTE_* settings); a pod record's "provider" says which ("runpod"
when absent). Both are driven the same way: start, refresh, stop, terminate, and Jupyter's REST API and websocket.

A pod bills while it runs: Stop keeps the disk (/workspace) and stops the GPU billing, Terminate deletes the pod.
A running workspace is checked every 30 seconds and stopped after `idle_minutes` (default 3) without kernel activity
(Jupyter's /api/status). Costs shown are RunPod's hourly price as reported for the pod.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import ssl
import tarfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/code-workspaces", tags=["code-workspaces"])
# what a pod calls, with its workspace secret only (auth.PUBLIC lets these through without a signed-in user): the
# secret reaches that workspace's dataset and model aliases, acting as the workspace's owner, and nothing else
pod_router = APIRouter(prefix="/api/code-workspace-pod/{wid}", tags=["code-workspaces"])
HERE = Path(__file__).resolve().parent
DIR = Path("data/code-workspaces")
WORKSPACE_TYPE = "application/vnd.bluesandai.code-workspace+json"
RUNPOD_API = "https://rest.runpod.io/v1"
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
GPU_TYPES = ["NVIDIA RTX A4000", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090", "NVIDIA L4", "NVIDIA GeForce RTX 4090", "NVIDIA A40", "NVIDIA RTX A6000"]
TOKEN_SECONDS = 30 * 24 * 3600
_lock = threading.RLock()
_env: Callable[[str], str] = lambda k: os.environ.get(k, "")  # noqa: E731
_monitors: dict[str, threading.Thread] = {}


def configure(data_dir: Path, env: Optional[Callable[[str], str]] = None) -> None:
    global DIR, _env
    DIR = data_dir / "code-workspaces"
    DIR.mkdir(parents=True, exist_ok=True)
    if env:
        _env = env


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


def public_url() -> str:
    return (_env("BLUESANDAI_PUBLIC_URL") or "https://hexa.bluesandai.com").rstrip("/")


# ------------------------------------------------------------------------------------------------
# RunPod
# ------------------------------------------------------------------------------------------------


def runpod(method: str, path: str, body: Optional[dict] = None) -> Any:
    """One call to RunPod's REST API (replaced in tests)."""
    key = _env("RUNPOD_API_KEY")
    if not key:
        raise HTTPException(400, "RUNPOD_API_KEY is not set: Jupyter workspaces run on RunPod pods")
    req = urllib.request.Request(RUNPOD_API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json",
                                          "User-Agent": "bluesandai/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")[:600]
        if e.code == 404:
            raise HTTPException(404, "RunPod no longer has this pod") from None
        raise HTTPException(502, f"RunPod refused the request ({e.code}): {text}") from None
    except urllib.error.URLError as e:
        raise HTTPException(502, f"RunPod could not be reached: {e.reason}") from None


def _gce() -> Optional[dict]:
    """The Compute Engine settings for Cloud CPU machines, or None when they are not configured."""
    import gce_machines

    return gce_machines.settings(_env)


def provider(pod: Optional[dict]) -> str:
    return (pod or {}).get("provider") or "runpod"


def jupyter_endpoint(rec: dict) -> Optional[tuple[str, Optional[ssl.SSLContext]]]:
    """The base URL of the machine's Jupyter, and the TLS context to reach it (None: the default checks)."""
    pod = rec.get("pod") or {}
    if not pod.get("id"):
        return None
    if provider(pod) == "gce":
        import gce_machines

        if not pod.get("ip") or not (rec.get("gce_tls") or {}).get("cert"):
            return None
        return f"https://{pod['ip']}:{pod.get('port', 8888)}", gce_machines.ssl_context(rec["gce_tls"]["cert"])
    return f"https://{pod['id']}-8888.proxy.runpod.net", None


def _jupyter_get(rec: dict, path: str) -> Any:
    ep = jupyter_endpoint(rec)
    if not ep:
        return None
    req = urllib.request.Request(ep[0] + path, headers={"Authorization": f"token {rec['jupyter_token']}", "User-Agent": "bluesandai/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ep[1]) as r:  # noqa: S310
            return json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None


def _jupyter_status(rec: dict) -> Optional[dict]:
    """Jupyter's /api/status on the machine: {last_activity, kernels, connections}; None while it is not up."""
    return _jupyter_get(rec, "/api/status")


# ------------------------------------------------------------------------------------------------
# workspaces
# ------------------------------------------------------------------------------------------------


def _path(wid: str) -> Path:
    if not re.fullmatch(r"cws-[0-9a-f]{12}", wid):
        raise HTTPException(404, "workspace not found")
    return DIR / f"{wid}.json"


def _read(wid: str) -> dict:
    p = _path(wid)
    if not p.exists():
        raise HTTPException(404, "workspace not found")
    return json.loads(p.read_text("utf-8"))


def _write(rec: dict) -> dict:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = _path(rec["id"]).with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rec, indent=1, default=str), "utf-8")
    os.replace(tmp, _path(rec["id"]))
    return rec


def _get(wid: str, need: str = "viewer") -> dict:
    import drive

    rec = _read(wid)
    item = drive._item(rec["item_id"], need=need)
    if item.get("trashed_at"):
        raise HTTPException(404, "workspace not found")
    return rec


def _public(rec: dict) -> dict:
    """What the page gets: no API token; the Jupyter link carries the Jupyter token (the caller may open the workspace)."""
    import db

    pod = rec.get("pod") or {}
    out = {k: v for k, v in rec.items() if k not in ("api_token", "jupyter_token", "pod_secret_hash", "local_secret_hash", "local_secret_hashes", "gce_tls",
                                                     "platform_token", "mqtt_password")}
    out["path"] = [x["name"] for x in db.drive_path(rec["item_id"])[:-1]]
    ep = jupyter_endpoint(rec) if pod.get("status") == "running" else None
    out["jupyter_url"] = f"{ep[0]}/lab/tree/workspace?token={rec['jupyter_token']}" if ep else None
    out["public_url"] = public_url()
    return out


class ComputeIn(BaseModel):
    kind: Literal["gpu", "cpu"] = "gpu"
    gpu_type: str = "NVIDIA RTX A4000"
    # RunPod secure cloud (data centers) or community cloud (cheaper, other people's machines)
    cloud: Literal["SECURE", "COMMUNITY"] = "SECURE"
    vcpus: int = Field(4, ge=2, le=32)
    disk_gb: int = Field(20, ge=5, le=500)


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    # where the workspace's Files item goes; not with pipeline_id
    folder_id: Optional[str] = None
    # a Device stream's Node-RED: it hangs off the pipeline file (no Files item of its own; the pipeline's access)
    pipeline_id: Optional[str] = None
    # "jupyter": JupyterLab (Local CPU, Cloud CPU, GPU); "vscode": VS Code in the browser, "nodered": Node-RED with its
    # palette manager — both on this machine (code_workspace_vscode.py)
    # "jupyterlab": JupyterLab in Docker on this machine, in an image of its own (ML Studio's audit kits: the training environment)
    kind: Literal["jupyter", "jupyterlab", "vscode", "nodered"] = "jupyter"
    compute: ComputeIn = Field(default_factory=ComputeIn)
    # a GPU bills while it idles: stop soon (a running cell is not idleness)
    idle_minutes: int = Field(3, ge=1, le=720)


@router.get("/options")
def options() -> dict:
    gce = _gce()
    # Cloud CPU runs on Compute Engine, Cloud CPU + GPU on RunPod
    return {"gpu_types": GPU_TYPES, "image": IMAGE, "configured": bool(_env("RUNPOD_API_KEY")) or bool(gce), "public_url": public_url(),
            "gpu_configured": bool(_env("RUNPOD_API_KEY")), "cpu_configured": bool(gce), "cpu_provider": "gce", "cpu_zone": (gce or {}).get("zone")}


@router.get("")
def list_workspaces() -> list[dict]:
    out = []
    for p in sorted(DIR.glob("cws-*.json")):
        try:
            out.append(_public(_get(p.stem)))
        except HTTPException:
            continue
    return sorted(out, key=lambda r: r["created_at"], reverse=True)


@router.post("")
def create_workspace(req: WorkspaceIn) -> dict:
    import drive

    if req.pipeline_id:
        return _pipeline_workspace(req)
    if not req.folder_id:
        raise HTTPException(400, "choose the Project or folder the workspace goes in")
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "create the workspace in a Project or a folder")
    if req.compute.kind == "gpu" and req.compute.gpu_type not in GPU_TYPES:
        raise HTTPException(400, f"gpu_type is one of {', '.join(GPU_TYPES)}")
    wid = f"cws-{uuid.uuid4().hex[:12]}"
    name = drive._clean_name(req.name.strip())
    body = json.dumps({"workspace_id": wid}).encode()
    item = drive._store(folder["id"], drive._free_name(folder["id"], name), io.BytesIO(body), len(body), WORKSPACE_TYPE)
    # VS Code stops after 30 idle minutes by default (it runs on this machine, nothing bills)
    idle = 30 if req.kind in ("vscode", "jupyterlab") and "idle_minutes" not in req.model_fields_set else req.idle_minutes
    rec = {"id": wid, "name": name, "item_id": item["id"], "kind": req.kind, "compute": req.compute.model_dump(), "idle_minutes": idle,
           "datasets": [], "models": [], "pod": None, "jupyter_token": secrets.token_urlsafe(24), "api_token": None, "created_at": _now(),
           "created_by": _me(), "events": []}
    with _lock:
        _write(rec)
    return _public(rec)


def _pipeline_workspace(req: WorkspaceIn) -> dict:
    """A Device stream's Node-RED (one per pipeline: an existing one is returned)."""
    import drive

    if req.kind != "nodered":
        raise HTTPException(400, "a pipeline's workspace is a Node-RED workspace")
    item = drive._item(req.pipeline_id, need="editor")
    if item["kind"] != "file" or not item["name"].lower().endswith(".pipeline"):
        raise HTTPException(400, "pipeline_id is a pipeline file")
    with _lock:
        for p in DIR.glob("cws-*.json"):
            r = json.loads(p.read_text("utf-8"))
            if r.get("item_id") == item["id"]:
                return _public(r)
        wid = f"cws-{uuid.uuid4().hex[:12]}"
        rec = {"id": wid, "name": item["name"][: -len(".pipeline")], "item_id": item["id"], "pipeline_id": item["id"], "kind": "nodered",
               "compute": req.compute.model_dump(), "idle_minutes": req.idle_minutes, "datasets": [], "models": [], "pod": None,
               "jupyter_token": secrets.token_urlsafe(24), "api_token": None, "created_at": _now(), "created_by": _me(), "events": []}
        _write(rec)
    return _public(rec)


@router.get("/by-item/{item_id}")
def by_item(item_id: str) -> dict:
    for p in DIR.glob("cws-*.json"):
        if json.loads(p.read_text("utf-8")).get("item_id") == item_id:
            return get_workspace(p.stem)
    raise HTTPException(404, "this Files item is not a workspace")


@router.get("/{wid}")
def get_workspace(wid: str) -> dict:
    rec = _get(wid)
    if (rec.get("pod") or {}).get("id") and rec["pod"].get("status") in ("starting", "running"):
        rec = _refresh(rec)
        _watch(rec)
    return _public(rec)


class SettingsIn(BaseModel):
    compute: Optional[ComputeIn] = None
    idle_minutes: Optional[int] = Field(default=None, ge=1, le=720)


@router.put("/{wid}")
def update_workspace(wid: str, req: SettingsIn) -> dict:
    with _lock:
        rec = _get(wid, "editor")
        if req.compute is not None:
            if rec.get("pod"):
                raise HTTPException(409, "terminate the pod before changing its compute")
            rec["compute"] = req.compute.model_dump()
        if req.idle_minutes is not None:
            rec["idle_minutes"] = req.idle_minutes
        return _public(_write(rec))


@router.delete("/{wid}")
def delete_workspace(wid: str) -> dict:
    """Terminates the pod and moves the workspace to the Files trash."""
    import drive

    import code_workspace_lab

    rec = _get(wid, "editor")
    if rec.get("pipeline_id"):
        raise HTTPException(400, "This Node-RED belongs to a Device stream pipeline: delete the pipeline instead")
    code_workspace_lab.shutdown_workspace(wid)
    import code_workspace_terminals

    code_workspace_terminals.shutdown_workspace(wid)
    if rec.get("kind") in ("vscode", "nodered", "jupyterlab"):
        import code_workspace_vscode

        code_workspace_vscode.remove(wid)
    if rec.get("pod"):
        _terminate(rec)
    drive.trash(rec["item_id"])
    return {"deleted": wid}


# -- aliases ----------------------------------------------------------------------------------------


class DatasetAlias(BaseModel):
    alias: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z_][A-Za-z0-9_\-]*$")
    # read an existing dataset (Parquet, CSV / TSV / JSON, or a folder of files: a raw, possibly non-tabular dataset)…
    item_id: Optional[str] = None
    # …or write a new one (created on the first write): a table (write_table) or files (upload_file)
    folder_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)
    kind: Literal["table", "files"] = "table"


@router.post("/{wid}/datasets")
def add_dataset(wid: str, req: DatasetAlias) -> dict:
    import drive

    with _lock:
        rec = _get(wid, "editor")
        if any(d["alias"] == req.alias for d in rec["datasets"]):
            raise HTTPException(409, f"the alias {req.alias} is already used")
        if req.item_id:
            import dataset_preview

            item = drive._item(req.item_id)
            kind = dataset_preview.kind_of(item)
            if kind not in ("parquet", "file", "raw"):
                raise HTTPException(400, "choose a dataset: a Parquet, CSV, TSV or JSON file, or a folder of files")
            rec["datasets"].append({"alias": req.alias, "mode": "read", "item_id": item["id"], "name": item["name"].removesuffix(".parquet"),
                                    "kind": "files" if kind == "raw" else "table", "dataset_kind": kind})
        else:
            if not req.folder_id or not (req.name or "").strip():
                raise HTTPException(400, "a new dataset needs a folder and a name")
            drive._item(req.folder_id, need="editor")
            rec["datasets"].append({"alias": req.alias, "mode": "write", "folder_id": req.folder_id, "name": drive._clean_name(req.name.strip()), "item_id": None,
                                    "kind": req.kind})
        return _public(_write(rec))


@router.delete("/{wid}/datasets/{alias}")
def remove_dataset(wid: str, alias: str) -> dict:
    with _lock:
        rec = _get(wid, "editor")
        rec["datasets"] = [d for d in rec["datasets"] if d["alias"] != alias]
        return _public(_write(rec))


class ModelAlias(BaseModel):
    alias: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    # an existing model…
    model_id: Optional[str] = None
    # …or a new one created in this folder with this name (default: the alias)
    folder_id: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=120)


def adapter_names(alias: str) -> tuple[str, str]:
    """(file name, class name) of the adapter skeleton generated for a model alias."""
    return f"{alias}_adapter.py", "".join(p[:1].upper() + p[1:] for p in re.split(r"[_\W]+", alias) if p) + "Adapter"


def adapter_skeleton(alias: str) -> str:
    _, cls = adapter_names(alias)
    return f'''import mlflow


class {cls}(mlflow.pyfunc.PythonModel):
    """The model "{alias}" as an MLflow model (open source): its inference on a DataFrame. Publish it with
    ModelOutput("{alias}").publish({cls}(fitted, features), input_example=df[features].head(5)); a scikit-learn
    estimator can also be published as it is."""

    def __init__(self, model, features):
        self.model = model
        self.features = list(features)

    def predict(self, context, model_input, params=None):
        df = model_input.copy()
        df["prediction"] = self.model.predict(df[self.features])
        return df
'''


@router.post("/{wid}/models")
def add_model(wid: str, req: ModelAlias) -> dict:
    import model_assets
    import model_studio

    with _lock:
        rec = _get(wid, "editor")
        if any(m["alias"] == req.alias for m in rec["models"]):
            raise HTTPException(409, f"the alias {req.alias} is already used")
        if req.model_id:
            m, _ = model_assets._get(req.model_id)
            if m.get("kind") != "python":
                raise HTTPException(400, f"{m['name']} is a container model: a workspace publishes to models trained in code")
        else:
            if not req.folder_id:
                raise HTTPException(400, "choose an existing model, or a folder for a new one")
            m = model_studio.create_python_model(req.folder_id, req.name or req.alias, {"kind": "code_workspace", "workspace_id": wid, "workspace": rec["name"]})
        file, cls = adapter_names(req.alias)
        rec["models"].append({"alias": req.alias, "model_id": m["id"], "name": m["name"], "adapter_file": file, "adapter_class": cls})
        return _public(_write(rec))


@router.delete("/{wid}/models/{alias}")
def remove_model(wid: str, alias: str) -> dict:
    with _lock:
        rec = _get(wid, "editor")
        rec["models"] = [m for m in rec["models"] if m["alias"] != alias]
        return _public(_write(rec))


# ------------------------------------------------------------------------------------------------
# the pod
# ------------------------------------------------------------------------------------------------


def _event(rec: dict, text: str) -> None:
    rec.setdefault("events", []).append({"at": _now(), "by": _me(), "text": text})
    rec["events"] = rec["events"][-50:]


def _pod_body(rec: dict, secret: str) -> dict:
    c = rec["compute"]
    start = ("(curl -fsSL -H \"Authorization: Bearer $BLUESANDAI_API_TOKEN\" \"$BLUESANDAI_POD_URL/bootstrap.sh\" | bash) "
             "|| echo 'BluesandAI bootstrap failed'; exec /start.sh")
    body: dict = {"name": f"bluesandai-{rec['name']}"[:60], "imageName": IMAGE, "containerDiskInGb": 20, "volumeInGb": c["disk_gb"], "volumeMountPath": "/workspace",
                  "ports": ["8888/http"], "cloudType": c.get("cloud", "SECURE"), "dockerStartCmd": ["bash", "-c", start],
                  "env": {"JUPYTER_PASSWORD": rec["jupyter_token"], "BLUESANDAI_API_URL": public_url(), "BLUESANDAI_WORKSPACE_ID": rec["id"],
                          "BLUESANDAI_POD_URL": f"{public_url()}/api/code-workspace-pod/{rec['id']}", "BLUESANDAI_API_TOKEN": secret}}
    if c["kind"] == "gpu":
        body.update(computeType="GPU", gpuTypeIds=[c["gpu_type"]], gpuCount=1)
    else:
        body.update(computeType="CPU", vcpuCount=c.get("vcpus", 4))
    return body


def _status_of(pod: dict) -> str:
    s = str(pod.get("desiredStatus") or pod.get("status") or "").upper()
    return {"RUNNING": "running", "EXITED": "stopped", "TERMINATED": "terminated"}.get(s, "starting")


def _refresh(rec: dict) -> dict:
    """The pod's state from RunPod, and whether Jupyter answers yet."""
    pod = rec.get("pod") or {}
    if not pod.get("id"):
        return rec
    if provider(pod) == "gce":
        return _refresh_gce(rec)
    try:
        live = runpod("GET", f"/pods/{pod['id']}")
    except HTTPException as e:
        if e.status_code == 404:
            with _lock:
                rec = _read(rec["id"])
                rec["pod"] = None
                _event(rec, "the pod no longer exists on RunPod")
                return _write(rec)
        return rec
    status = _status_of(live)
    jup = _jupyter_status(rec) if status == "running" else None
    with _lock:
        rec = _read(rec["id"])
        if not rec.get("pod"):
            return rec
        rec["pod"].update(status="running" if status == "running" and jup else "starting" if status == "running" else status,
                          cost_per_hr=live.get("costPerHr") or live.get("adjustedCostPerHr") or rec["pod"].get("cost_per_hr"),
                          gpu=(live.get("machine") or {}).get("gpuDisplayName") or (live.get("gpu") or {}).get("displayName") or rec["pod"].get("gpu"),
                          last_activity=(jup or {}).get("last_activity") or rec["pod"].get("last_activity"), kernels=(jup or {}).get("kernels"),
                          checked_at=_now())
        return _write(rec)


def _refresh_gce(rec: dict) -> dict:
    import gce_machines

    pod = rec["pod"]
    cfg = _gce()
    if not cfg:
        return rec
    try:
        live = gce_machines.get(cfg, pod["id"], pod["zone"])
    except HTTPException as e:
        if e.status_code == 404:
            with _lock:
                rec = _read(rec["id"])
                rec["pod"] = None
                _event(rec, "the machine no longer exists on Compute Engine")
                return _write(rec)
        return rec
    with _lock:
        rec = _read(rec["id"])
        if not rec.get("pod"):
            return rec
        rec["pod"].update(ip=live["ip"])
    jup = _jupyter_status(rec) if live["status"] == "running" else None
    with _lock:
        rec = _read(rec["id"])
        if not rec.get("pod"):
            return rec
        rec["pod"].update(ip=live["ip"], status="running" if jup else "starting" if live["status"] in ("running", "starting") else live["status"],
                          last_activity=(jup or {}).get("last_activity") or rec["pod"].get("last_activity"), kernels=(jup or {}).get("kernels"), checked_at=_now())
        return _write(rec)


def _pod_meta(rec: dict, secret: str) -> dict[str, str]:
    """What a Compute Engine machine is given (its metadata), as a RunPod pod gets it in its environment."""
    return {"jupyter-token": rec["jupyter_token"], "jupyter-cert": rec["gce_tls"]["cert"], "jupyter-key": rec["gce_tls"]["key"],
            "bluesandai-api-url": public_url(), "bluesandai-workspace-id": rec["id"],
            "bluesandai-pod-url": f"{public_url()}/api/code-workspace-pod/{rec['id']}", "bluesandai-api-token": secret}


def _gce_or_fail() -> dict:
    cfg = _gce()
    if not cfg:
        raise HTTPException(400, "GCP_COMPUTE_CREDENTIALS is not set: Cloud CPU machines run on Google Compute Engine")
    return cfg


@router.post("/{wid}/start")
def start(wid: str) -> dict:
    """Start the workspace: resume its stopped pod, or create one. The pod bills by the hour while it runs."""
    with _lock:
        rec = _get(wid, "editor")
        pod = rec.get("pod")
        if pod and pod.get("status") in ("starting", "running"):
            return get_workspace(wid)
        if pod and pod.get("id"):
            if provider(pod) == "gce":
                import gce_machines

                gce_machines.start(_gce_or_fail(), pod["id"], pod["zone"])
            else:
                runpod("POST", f"/pods/{pod['id']}/start")
            pod.update(status="starting", started_at=_now())
            _event(rec, "resumed the machine" if provider(pod) == "gce" else "resumed the pod")
        elif rec["compute"]["kind"] == "cpu":
            import gce_machines

            cfg = _gce_or_fail()
            secret = "bsai_pod_" + secrets.token_urlsafe(32)
            rec["gce_tls"] = gce_machines.make_tls()
            made = gce_machines.create(cfg, rec, _pod_meta(rec, secret))
            rec["pod_secret_hash"] = hashlib.sha256(secret.encode()).hexdigest()
            rec["owner"] = rec.get("owner") or _me()
            rec["pod"] = {"id": made["id"], "provider": "gce", "zone": made["zone"], "machine_type": made["machine_type"], "spot": made["spot"],
                          "status": "starting", "started_at": _now(), "created_at": _now(), "cost_per_hr": None, "compute": dict(rec["compute"])}
            spot = ", Spot" if made["spot"] else ""
            _event(rec, f"created the Compute Engine machine {made['id']} ({made['machine_type']}{spot})")
        else:
            secret = "bsai_pod_" + secrets.token_urlsafe(32)
            made = runpod("POST", "/pods", _pod_body(rec, secret))
            rec["pod_secret_hash"] = hashlib.sha256(secret.encode()).hexdigest()
            rec["owner"] = rec.get("owner") or _me()
            rec["pod"] = {"id": made["id"], "status": "starting", "started_at": _now(), "created_at": _now(), "cost_per_hr": made.get("costPerHr"),
                          "compute": dict(rec["compute"])}
            _event(rec, f"created the pod {made['id']}")
        _write(rec)
    _watch(rec)
    return _public(rec)


@router.post("/{wid}/stop")
def stop(wid: str) -> dict:
    """Stop the pod: compute billing stops, the /workspace disk is kept (RunPod bills stopped disks at a low rate)."""
    rec = _get(wid, "editor")
    return _public(_stop(rec, "stopped the pod"))


def _stop(rec: dict, why: str) -> dict:
    import code_workspace_lab

    code_workspace_lab.shutdown_workspace(rec["id"], "cloud")
    import code_workspace_terminals

    code_workspace_terminals.shutdown_workspace(rec["id"], "cloud")
    pod = rec.get("pod") or {}
    if pod.get("id"):
        try:
            if provider(pod) == "gce":
                import gce_machines

                gce_machines.stop(_gce_or_fail(), pod["id"], pod["zone"])
            else:
                runpod("POST", f"/pods/{pod['id']}/stop")
        except HTTPException as e:
            if e.status_code != 404:
                raise
    with _lock:
        rec = _read(rec["id"])
        if rec.get("pod"):
            rec["pod"].update(status="stopped", stopped_at=_now())
            _event(rec, why)
        return _write(rec)


@router.post("/{wid}/terminate")
def terminate(wid: str) -> dict:
    """Delete the pod and its disk; files not written to the platform (datasets, models) are lost."""
    rec = _get(wid, "editor")
    return _public(_terminate(rec))


def _terminate(rec: dict) -> dict:
    import code_workspace_lab

    code_workspace_lab.shutdown_workspace(rec["id"], "cloud")
    import code_workspace_terminals

    code_workspace_terminals.shutdown_workspace(rec["id"], "cloud")
    pod = rec.get("pod") or {}
    if pod.get("id"):
        try:
            if provider(pod) == "gce":
                import gce_machines

                gce_machines.delete(_gce_or_fail(), pod["id"], pod["zone"])
            else:
                runpod("DELETE", f"/pods/{pod['id']}")
        except HTTPException as e:
            if e.status_code != 404:
                raise
    auth.revoke_job_token(rec.get("api_token"))
    with _lock:
        rec = _read(rec["id"])
        was = provider(rec.get("pod"))
        rec["pod"], rec["api_token"], rec["pod_secret_hash"] = None, None, None
        rec.pop("gce_tls", None)
        _event(rec, "deleted the Compute Engine machine" if was == "gce" else "terminated the pod")
        return _write(rec)


def _watch(rec: dict) -> None:
    """One monitor thread per running workspace: refreshes its state and stops it when idle."""
    wid = rec["id"]
    t = _monitors.get(wid)
    if t and t.is_alive():
        return

    def loop() -> None:
        while True:
            time.sleep(int(_env("BLUESANDAI_WORKSPACE_POLL_S") or 30))
            try:
                cur = _read(wid)
            except HTTPException:
                return
            pod = cur.get("pod") or {}
            if pod.get("status") not in ("starting", "running"):
                return
            cur = _refresh(cur)
            pod = cur.get("pod") or {}
            if pod.get("status") != "running":
                if not pod:
                    return
                continue
            last = pod.get("last_activity") or pod.get("started_at")
            try:
                idle = (datetime.now(timezone.utc) - datetime.fromisoformat(str(last).replace("Z", "+00:00"))).total_seconds() / 60
            except ValueError:
                continue
            busy = pod.get("kernels") and _jupyter_busy(cur)
            if idle >= cur.get("idle_minutes", 3) and not busy:
                try:
                    _stop(cur, f"stopped after {int(idle)} minutes without activity")
                except HTTPException:
                    pass
                return

    t = threading.Thread(target=loop, daemon=True, name=f"workspace-{wid}")
    _monitors[wid] = t
    t.start()


def _jupyter_busy(rec: dict) -> bool:
    """A kernel is executing (a long training cell is not idleness)."""
    return any(k.get("execution_state") == "busy" for k in (_jupyter_get(rec, "/api/kernels") or []))


# ------------------------------------------------------------------------------------------------
# what the pod calls (with the workspace's job token)
# ------------------------------------------------------------------------------------------------


def _pod_rec(wid: str, request: Request) -> dict:
    """The workspace, for a call from its pod. On /api/code-workspace-pod/... only the pod secret is accepted, and
    the rest of the request acts as the workspace's owner; on the older /api/code-workspaces/<id>/pod/... a signed-in
    user who may edit it, or the workspace's job token."""
    rec = _read(wid)
    header = request.headers.get("authorization", "")
    bearer = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if request.url.path.startswith("/api/code-workspace-pod/"):
        # the pod's secret, or the one of this machine's kernels (code_workspace_lab.py)
        got = hashlib.sha256(bearer.encode()).hexdigest() if bearer else ""
        if not got or not any(w and secrets.compare_digest(got, w) for w in (rec.get("pod_secret_hash"), rec.get("local_secret_hash"), *(rec.get("local_secret_hashes") or []))):
            raise HTTPException(401, "this workspace's pod secret is required")
        if auth.enabled():
            owner = auth.principal_of(rec.get("owner") or rec.get("created_by"))
            if owner is None:
                raise HTTPException(403, "the workspace's owner no longer exists or is deactivated")
            auth._principal.set(owner)
        return rec
    if rec.get("api_token") and bearer and secrets.compare_digest(bearer, rec["api_token"]):
        return rec
    return _get(wid, "editor")


@router.get("/{wid}/pod/bootstrap.sh")
def bootstrap(wid: str, request: Request) -> PlainTextResponse:
    rec = _pod_rec(wid, request)
    lines = ["#!/bin/bash", "set -e", 'SP=$(python -c "import site; print(site.getsitepackages()[0])")',
             'POD="${BLUESANDAI_POD_URL:-$BLUESANDAI_API_URL/api/code-workspaces/$BLUESANDAI_WORKSPACE_ID/pod}"',
             'curl -fsSL -H "Authorization: Bearer $BLUESANDAI_API_TOKEN" "$POD/client.tar.gz" | tar -xz -C "$SP"',
             # pyarrow 20+ needs NumPy 2; the image's PyTorch is built for NumPy 1.x
             "python -m pip install -q --disable-pip-version-check dill cloudpickle 'pyarrow>=15,<20' pandas pyyaml mlflow scikit-learn || true", "mkdir -p /workspace && cd /workspace",
             'curl -fsSL -H "Authorization: Bearer $BLUESANDAI_API_TOKEN" "$POD/files.tar.gz" | tar -xz --skip-old-files -C /workspace',
             f'echo "BluesandAI workspace {rec["name"]} is ready"']
    return PlainTextResponse("\n".join(lines) + "\n")


def _tar(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), int(time.time()), 0o644
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


@router.get("/{wid}/pod/client.tar.gz")
def client_package(wid: str, request: Request) -> Response:
    """The Python client for the workspace's environment: workspace_client, model_lib, the bluesandai package (workspace,
    evaluation) and, for code written for Foundry, the palantir_models / foundry packages."""
    _pod_rec(wid, request)
    import code_model_templates
    import workspace_client

    files = {"workspace_client.py": (HERE / "workspace_client.py").read_bytes(), "model_lib.py": (HERE / "model_lib.py").read_bytes(),
             **{k: v.encode() for k, v in workspace_client.PACKAGE_FILES.items()},
             # the evaluation helpers of the Model Training template: from bluesandai.evaluation import log_regresi, log_klasifikasi
             "bluesandai/evaluation.py": code_model_templates.EVALUASI.encode()}
    return Response(_tar(files), media_type="application/gzip")


def _snippets(rec: dict) -> str:
    out = [f"# {rec['name']}", "", "A BluesandAI Code Workspace. Datasets and models are reached through their aliases.", ""]
    for d in rec["datasets"]:
        out += [f"## Dataset `{d['alias']}` ({d['mode']})", "```python", "from bluesandai.workspace import Dataset",
                f'{d["alias"]} = Dataset.get("{d["alias"]}").read_table(format="pandas")' if d["mode"] == "read" else f'Dataset.get("{d["alias"]}").write_table(df)', "```", ""]
    for m in rec["models"]:
        out += [f"## Model `{m['alias']}`", f"The model class is in `{m['adapter_file']}` (an MLflow PythonModel). Train, evaluate and publish:", "```python",
                "import mlflow", "from bluesandai.workspace import ModelOutput", "from bluesandai.evaluation import log_regresi  # or log_klasifikasi",
                f"from {m['adapter_file'][:-3]} import {m['adapter_class']}", "",
                'with mlflow.start_run(run_name="notebook"):',
                "    log_regresi(y_test, fitted.predict(X_test), \"holdout\")  # metrics + charts on the model's page",
                f'    ModelOutput("{m["alias"]}").publish({m["adapter_class"]}(fitted, features), input_example=X_test.head(5))', "```",
                "A scikit-learn estimator can be published as it is: `ModelOutput(alias).publish(estimator, input_example=X_test.head(5))`.", ""]
    return "\n".join(out)


@router.get("/{wid}/pod/files.tar.gz")
def starter_files(wid: str, request: Request) -> Response:
    """Files written into /workspace when the pod starts (existing files are kept): adapter skeletons, the snippets."""
    rec = _pod_rec(wid, request)
    files = {m["adapter_file"]: adapter_skeleton(m["alias"]).encode() for m in rec["models"]}
    files["BLUESANDAI.md"] = _snippets(rec).encode()
    return Response(_tar(files), media_type="application/gzip")


def _dataset(rec: dict, alias: str) -> dict:
    d = next((x for x in rec["datasets"] if x["alias"] == alias), None)
    if not d:
        raise HTTPException(404, f"the workspace has no dataset alias {alias}: add it in the Data tab")
    return d


@router.get("/{wid}/pod/datasets/{alias}")
def read_dataset(wid: str, alias: str, request: Request) -> Response:
    import db
    import drive

    rec = _pod_rec(wid, request)
    d = _dataset(rec, alias)
    item = _dataset_item(d, alias)
    import dataset_preview

    kind = dataset_preview.kind_of(item)
    if kind == "parquet":
        return Response(drive.read_bytes(item), media_type="application/vnd.apache.parquet")
    # a CSV / JSON file or a folder of them: read with the dataset's schema (as Dataset Preview does)
    import pyarrow.parquet as pq

    if kind == "raw" and not dataset_preview._raw_files(item):
        raise HTTPException(400, f"{alias} holds no CSV, TSV or JSON files, so it is not a table: use Dataset.get({alias!r}).files()")

    try:
        table = dataset_preview.table(item, kind or "raw")
    except HTTPException as e:
        raise HTTPException(e.status_code, f"{alias} cannot be read as a table ({e.detail}): use Dataset.get({alias!r}).files()") from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"{alias} cannot be read as a table ({e}): use Dataset.get({alias!r}).files()") from None
    buf = io.BytesIO()
    pq.write_table(table, buf)
    return Response(buf.getvalue(), media_type="application/vnd.apache.parquet")


def _dataset_item(d: dict, alias: str) -> dict:
    import db
    import drive

    item = db.drive_get(d["item_id"]) if d.get("item_id") else None
    if not item or item.get("trashed_at"):
        raise HTTPException(404, f"{alias} has no data yet" if d["mode"] == "write" else f"the dataset behind {alias} no longer exists")
    return drive._item(item["id"])


def _walk(folder_id: str, prefix: str = "") -> list[tuple[str, dict]]:
    """(path, item) of every file under a folder, subfolders included."""
    import db

    out: list[tuple[str, dict]] = []
    for i in sorted(db.drive_list(folder_id), key=lambda x: x["name"]):
        if i.get("trashed_at"):
            continue
        if i["kind"] == "file":
            out.append((prefix + i["name"], i))
        elif i["kind"] in ("folder", "project"):
            out += _walk(i["id"], prefix + i["name"] + "/")
    return out


def _dataset_files(rec: dict, alias: str) -> list[tuple[str, dict]]:
    d = _dataset(rec, alias)
    item = _dataset_item(d, alias)
    return [(item["name"], item)] if item["kind"] == "file" else _walk(item["id"])


@router.get("/{wid}/pod/datasets/{alias}/files")
def list_dataset_files(wid: str, alias: str, request: Request) -> list[dict]:
    """The files of a dataset alias (a raw dataset's folder, or the dataset's own file)."""
    rec = _pod_rec(wid, request)
    return [{"path": p, "size": int(i.get("size_bytes") or 0), "modified": i.get("updated_at")} for p, i in _dataset_files(rec, alias)]


@router.get("/{wid}/pod/datasets/{alias}/files/{path:path}")
def read_dataset_file(wid: str, alias: str, path: str, request: Request) -> Response:
    import drive

    rec = _pod_rec(wid, request)
    item = next((i for p, i in _dataset_files(rec, alias) if p == path), None)
    if not item:
        raise HTTPException(404, f"{alias} has no file {path}")
    return Response(drive.read_bytes(item), media_type=item.get("content_type") or "application/octet-stream")


@router.put("/{wid}/pod/datasets/{alias}/files/{path:path}")
async def write_dataset_file(wid: str, alias: str, path: str, request: Request) -> dict:
    """Write a file into a "files" output alias: its folder (made on the first write) holds the files, subfolders kept."""
    import mimetypes

    import db
    import drive

    rec = _pod_rec(wid, request)
    d = _dataset(rec, alias)
    if d["mode"] != "write":
        raise HTTPException(400, f"{alias} is a read-only alias: add an output dataset in the Data panel to write")
    if d.get("kind", "table") != "files":
        raise HTTPException(400, f"{alias} is a table output: write it with write_table(df), or add a files output to upload files")
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise HTTPException(400, "invalid file path")
    data = await request.body()
    with _lock:
        cur = _read(wid)
        dd = next(x for x in cur["datasets"] if x["alias"] == alias)
        folder = db.drive_get(dd["item_id"]) if dd.get("item_id") else None
        if not folder or folder.get("trashed_at") or folder["kind"] not in ("folder", "project"):
            drive._item(dd["folder_id"], need="editor")
            folder_id = drive._insert_container(dd["folder_id"], "folder", drive._free_name(dd["folder_id"], dd["name"]))
            dd["item_id"] = folder_id
            _write(cur)
        else:
            folder_id = folder["id"]
    parent = drive._ensure_folders(folder_id, parts[:-1]) if len(parts) > 1 else folder_id
    name = drive._clean_name(parts[-1])
    old = next((i for i in db.drive_list(parent) if i["kind"] == "file" and i["name"].lower() == name.lower() and not i.get("trashed_at")), None)
    if old:
        drive.trash(old["id"])  # replaced: the earlier file stays in the trash
    stored = drive._store(parent, name, io.BytesIO(data), len(data), mimetypes.guess_type(name)[0] or "application/octet-stream")
    return {"path": "/".join(parts), "size": len(data), "item_id": stored["id"], "dataset": dd["name"]}


@router.put("/{wid}/pod/datasets/{alias}")
async def write_dataset(wid: str, alias: str, request: Request) -> dict:
    import pyarrow.parquet as pq

    import model_deployments

    rec = _pod_rec(wid, request)
    d = _dataset(rec, alias)
    if d["mode"] != "write":
        raise HTTPException(400, f"{alias} is a read-only alias: add an output dataset in the Data tab to write")
    if d.get("kind") == "files":
        raise HTTPException(400, f"{alias} is a files output: write files with upload_file / upload_directory")
    data = await request.body()
    try:
        rows = pq.ParquetFile(io.BytesIO(data)).metadata.num_rows
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "the body is not a parquet file") from None
    out = model_deployments.write_dataset(d["folder_id"], d["name"], data, {"kind": "code_workspace", "id": rec["id"], "name": rec["name"]}, d.get("item_id"))
    with _lock:
        cur = _read(wid)
        for x in cur["datasets"]:
            if x["alias"] == alias:
                x["item_id"] = out["item_id"]
        _write(cur)
    return {"rows": rows, **out}


def _model(rec: dict, alias: str) -> dict:
    m = next((x for x in rec["models"] if x["alias"] == alias), None)
    if not m:
        raise HTTPException(404, f"the workspace has no model alias {alias}: add it in the Models tab")
    return m


@router.post("/{wid}/pod/models/{alias}/publish")
async def publish_model(wid: str, alias: str, request: Request) -> dict:
    """A staged model version from the notebook (state/, adapter/, version.json, zipped) becomes a version of the model."""
    import model_assets

    rec = _pod_rec(wid, request)
    m = _model(rec, alias)
    data = await request.body()
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise HTTPException(400, "the body is not a zip of a staged model version")
    model, _ = model_assets._get(m["model_id"], need="editor")
    v = model_assets.add_version(model, data, "master",
                                 {"kind": "code_workspace", "workspace_id": rec["id"], "repo": rec["name"], "transform": "notebook", "build": "", "branch": "master"},
                                 [{"item_id": d["item_id"], "name": d["name"]} for d in rec["datasets"] if d["mode"] == "read" and d.get("item_id")])
    return {"model": model["name"], "model_id": model["id"], "version": v["version"], "version_rid": v["rid"], "url": f"{public_url()}/model-assets/{model['id']}"}


@router.get("/{wid}/pod/models/{alias}/download")
def download_model(wid: str, alias: str, request: Request, version: Optional[str] = None) -> Response:
    """A model version for ModelInput in the notebook: its files, its adapter source and spec.json."""
    import model_assets

    rec = _pod_rec(wid, request)
    m = _model(rec, alias)
    model, _ = model_assets._get(m["model_id"])
    try:
        v = model_assets._pick_version(model, version, "master")
    except ValueError as e:
        raise HTTPException(404, str(e)) from None
    spec = model_assets.python_spec(model, v, alias)
    spec.pop("external", None)
    d = Path(spec.pop("dir"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(d.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(d).as_posix())
        z.writestr("spec.json", json.dumps(spec))
    return Response(buf.getvalue(), media_type="application/zip")


# the same pod endpoints under /api/code-workspace-pod/<id> (pod secret only)
for _route, _fn, _methods in [("/bootstrap.sh", bootstrap, ["GET"]), ("/client.tar.gz", client_package, ["GET"]), ("/files.tar.gz", starter_files, ["GET"]),
                             ("/datasets/{alias}", read_dataset, ["GET"]), ("/datasets/{alias}", write_dataset, ["PUT"]),
                             ("/datasets/{alias}/files", list_dataset_files, ["GET"]), ("/datasets/{alias}/files/{path:path}", read_dataset_file, ["GET"]),
                             ("/datasets/{alias}/files/{path:path}", write_dataset_file, ["PUT"]),
                             ("/models/{alias}/publish", publish_model, ["POST"]), ("/models/{alias}/download", download_model, ["GET"])]:
    pod_router.add_api_route(_route, _fn, methods=_methods)
