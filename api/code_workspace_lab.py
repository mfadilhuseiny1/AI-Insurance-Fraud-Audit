"""The notebook editor of a Jupyter Code Workspace (the page's JupyterLab): the workspace's files and its kernels.

Files: each workspace keeps its notebooks and files on the platform (data/code-workspaces/<id>/files), whatever runs
them; /contents reads, writes, creates, renames, uploads and deletes them (a notebook is nbformat 4 JSON).

Kernels run where the page's compute picker says:
- "local": an IPython kernel (ipykernel, through jupyter_client) on this API's machine, working in the notebook's
  folder. It reaches the workspace's dataset and model aliases like a pod does (foundry.transforms,
  palantir_models.code_workspaces), with a secret made for this machine's kernels.
- "cloud": a kernel on the workspace's machine (Cloud CPU on Google Compute Engine, Cloud CPU + GPU on a RunPod
  pod; code_workspaces.jupyter_endpoint), started through the machine's Jupyter Server
  (/api/sessions, working in /workspace/<the notebook's folder>) and driven over its kernel websocket from here, so
  the page never holds the pod's token. The workspace's files (not notebooks) are copied to /workspace first.

Messages are Jupyter's (messaging protocol 5.3): /execute streams the kernel's replies to one request as NDJSON
(stream, display_data, execute_result, error, clear_output, input_request, status, execute_reply) until the kernel
is idle again. A local kernel left idle for KERNEL_IDLE_MINUTES is shut down.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import secrets
import shutil
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import code_workspaces as cw

router = APIRouter(prefix="/api/code-workspaces/{wid}/lab", tags=["code-workspaces"])
KERNEL_IDLE_MINUTES = 120
MAX_SYNC_BYTES = 20 * 1024 * 1024
_lock = threading.RLock()
_kernels: dict[str, "Kernel"] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# files
# ------------------------------------------------------------------------------------------------


def files_dir(wid: str) -> Path:
    d = cw.DIR / wid / "files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve(wid: str, path: str) -> Path:
    root = files_dir(wid).resolve()
    rel = (path or "").strip().strip("/").replace("\\", "/")
    if any(p in ("..", "") for p in rel.split("/")) and rel:
        raise HTTPException(400, "invalid path")
    if any(p.lower() == ".git" for p in rel.split("/")):
        raise HTTPException(400, "the workspace's Git repository is managed from the Git panel")
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise HTTPException(400, "invalid path")
    return p


def _rel(wid: str, p: Path) -> str:
    return p.resolve().relative_to(files_dir(wid).resolve()).as_posix()


def _kind(p: Path) -> str:
    return "directory" if p.is_dir() else "notebook" if p.suffix == ".ipynb" else "file"


def _entry(wid: str, p: Path) -> dict:
    st = p.stat()
    rel = _rel(wid, p)
    return {"name": p.name, "path": "" if rel == "." else rel, "type": _kind(p), "size": None if p.is_dir() else st.st_size,
            "last_modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds")}


def empty_notebook() -> dict:
    return {"cells": [{"cell_type": "code", "execution_count": None, "id": uuid.uuid4().hex[:8], "metadata": {}, "outputs": [], "source": ""}],
            "metadata": {"kernelspec": {"display_name": "Python 3 (ipykernel)", "language": "python", "name": "python3"},
                         "language_info": {"name": "python", "file_extension": ".py", "mimetype": "text/x-python"}},
            "nbformat": 4, "nbformat_minor": 5}


def _text_like(p: Path) -> bool:
    try:
        p.read_bytes()[:8192].decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


@router.get("/contents")
def get_contents(wid: str, path: str = "") -> dict:
    cw._get(wid)
    p = _resolve(wid, path)
    if not p.exists():
        raise HTTPException(404, f"{path} does not exist")
    out = _entry(wid, p)
    if p.is_dir():
        items = [_entry(wid, c) for c in p.iterdir() if not c.name.startswith(".")]
        out["content"] = sorted(items, key=lambda e: (e["type"] != "directory", e["name"].lower()))
    elif p.suffix == ".ipynb":
        try:
            out["content"] = json.loads(p.read_text("utf-8") or "null") or empty_notebook()
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"{p.name} is not a valid notebook: {e}") from None
    elif p.stat().st_size <= 5 * 1024 * 1024 and _text_like(p):
        out["content"], out["format"] = p.read_text("utf-8"), "text"
    else:
        out["content"], out["format"] = None, "binary"
    return out


class SaveIn(BaseModel):
    path: str
    type: Literal["notebook", "file", "directory"]
    content: Any = None
    # an explicit save (Ctrl+S, the Save button) always keeps a checkpoint; autosaves one every few minutes
    checkpoint: bool = False


@router.put("/contents")
def save_contents(wid: str, req: SaveIn) -> dict:
    cw._get(wid, "editor")
    p = _resolve(wid, req.path)
    if req.type == "directory":
        p.mkdir(parents=True, exist_ok=True)
        return _entry(wid, p)
    p.parent.mkdir(parents=True, exist_ok=True)
    import code_workspace_versions as versions

    versions.keep_first(wid, _rel(wid, p))
    tmp = p.with_name(p.name + ".saving")
    if req.type == "notebook":
        if not isinstance(req.content, dict) or "cells" not in req.content:
            raise HTTPException(400, "a notebook's content is nbformat JSON")
        tmp.write_text(json.dumps(req.content, indent=1, ensure_ascii=False) + "\n", "utf-8")
    else:
        tmp.write_text(str(req.content or ""), "utf-8")
    os.replace(tmp, p)
    versions.on_saved(wid, _rel(wid, p), req.checkpoint)
    return _entry(wid, p)


def _free(parent: Path, stem: str, ext: str) -> Path:
    for i in range(0, 1000):
        p = parent / f"{stem}{i if i else ''}{ext}"
        if not p.exists():
            return p
    raise HTTPException(409, "too many untitled files")


class NewIn(BaseModel):
    path: str = ""
    type: Literal["notebook", "file", "directory"]
    ext: str = Field(".txt", pattern=r"^\.[A-Za-z0-9]{1,8}$")


@router.post("/contents/new")
def new_contents(wid: str, req: NewIn) -> dict:
    cw._get(wid, "editor")
    parent = _resolve(wid, req.path)
    if not parent.is_dir():
        raise HTTPException(400, "create files in a folder")
    if req.type == "directory":
        p = _free(parent, "Untitled Folder", "")
        p.mkdir()
    elif req.type == "notebook":
        p = _free(parent, "Untitled", ".ipynb")
        p.write_text(json.dumps(empty_notebook(), indent=1) + "\n", "utf-8")
    else:
        p = _free(parent, "untitled", req.ext)
        p.write_text("", "utf-8")
    return _entry(wid, p)


class RenameIn(BaseModel):
    path: str
    new_path: str


@router.post("/contents/rename")
def rename_contents(wid: str, req: RenameIn) -> dict:
    cw._get(wid, "editor")
    src, dst = _resolve(wid, req.path), _resolve(wid, req.new_path)
    if not src.exists():
        raise HTTPException(404, f"{req.path} does not exist")
    if dst.exists():
        raise HTTPException(409, f"{dst.name} already exists")
    if src in dst.parents:
        raise HTTPException(400, "a folder cannot be moved into itself")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError:
        # Windows keeps a folder that is a running kernel's working directory
        raise HTTPException(409, f"{src.name} is in use: shut down the kernels of its notebooks (Running panel), then try again") from None
    old, new = req.path.replace("\\", "/").strip("/"), req.new_path.replace("\\", "/").strip("/")
    import code_workspace_versions as versions

    versions.on_renamed(wid, old, new)
    with _lock:
        for k in _kernels.values():
            if k.wid == wid and (k.path == old or k.path.startswith(old + "/")):
                k.path = new + k.path[len(old):]
    return _entry(wid, dst)


@router.post("/contents/copy")
def copy_contents(wid: str, req: RenameIn) -> dict:
    """Duplicate a file: new_path is the folder it goes to (a free "-Copy" name is chosen)."""
    cw._get(wid, "editor")
    src = _resolve(wid, req.path)
    if not src.is_file():
        raise HTTPException(400, "only files can be duplicated")
    dst = _free(_resolve(wid, req.new_path), f"{src.stem}-Copy", src.suffix)
    shutil.copyfile(src, dst)
    return _entry(wid, dst)


@router.delete("/contents")
def delete_contents(wid: str, path: str) -> dict:
    cw._get(wid, "editor")
    p = _resolve(wid, path)
    if p == files_dir(wid).resolve():
        raise HTTPException(400, "the workspace's root folder cannot be deleted")
    if not p.exists():
        raise HTTPException(404, f"{path} does not exist")
    # what is deleted stays restorable from its checkpoints for 30 days
    import code_workspace_versions as versions

    for f in ([p] if p.is_file() else [x for x in p.rglob("*") if x.is_file()][:500]):
        versions.before_overwrite(wid, _rel(wid, f), "before-delete")
    # the notebooks' kernels go first: on Windows a kernel's working directory cannot be deleted
    rel = path.replace("\\", "/").strip("/")
    for k in list(_kernels.values()):
        if k.wid == wid and (k.path == rel or k.path.startswith(rel + "/")):
            k.shutdown()
            _kernels.pop(k.id, None)
    for attempt in range(20):
        try:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
            break
        except OSError:
            if attempt == 19:
                raise HTTPException(409, f"{p.name} is in use by another program: close it and try again") from None
            time.sleep(0.25)
    return {"deleted": path}


@router.put("/contents/raw")
async def upload_contents(wid: str, path: str, request: Request) -> dict:
    """Upload a file (the body is its bytes)."""
    cw._get(wid, "editor")
    p = _resolve(wid, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    import code_workspace_versions as versions

    data = await request.body()
    versions.before_overwrite(wid, _rel(wid, p), "before-upload")
    p.write_bytes(data)
    versions.on_saved(wid, _rel(wid, p), False)
    return _entry(wid, p)


@router.get("/contents/raw")
def download_contents(wid: str, path: str) -> Response:
    cw._get(wid)
    p = _resolve(wid, path)
    if not p.is_file():
        raise HTTPException(404, f"{path} does not exist")
    return Response(p.read_bytes(), media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{p.name}"'})


# ------------------------------------------------------------------------------------------------
# kernels
# ------------------------------------------------------------------------------------------------


class Kernel:
    """One kernel: messages from it go to whoever waits on the request (parent msg_id) they answer."""

    def __init__(self, wid: str, path: str, target: str) -> None:
        self.id = "k-" + uuid.uuid4().hex[:12]
        self.wid, self.path, self.target = wid, path, target
        self.state = "starting"
        self.execution_count = 0
        self.started_at = _now()
        self.last_activity = time.time()
        self.error: Optional[str] = None
        self._waiting: dict[str, queue.Queue] = {}
        self._wlock = threading.Lock()

    # -- routing
    def subscribe(self, msg_id: str) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._wlock:
            self._waiting[msg_id] = q
        return q

    def unsubscribe(self, msg_id: str) -> None:
        with self._wlock:
            self._waiting.pop(msg_id, None)

    def dispatch(self, channel: str, msg: dict) -> None:
        self.last_activity = time.time()
        mtype = msg.get("header", {}).get("msg_type") or msg.get("msg_type")
        content = msg.get("content") or {}
        parent = (msg.get("parent_header") or {}).get("msg_id")
        if mtype == "status":
            self.state = content.get("execution_state", self.state)
        if mtype == "execute_input" and content.get("execution_count"):
            self.execution_count = content["execution_count"]
        with self._wlock:
            q = self._waiting.get(parent) if parent else None
        if q is not None:
            q.put({"channel": channel, "msg_type": mtype, "content": content, "metadata": msg.get("metadata") or {}})

    def died(self, why: str) -> None:
        self.state, self.error = "dead", why
        with self._wlock:
            for q in self._waiting.values():
                q.put({"channel": "iopub", "msg_type": "kernel_dead", "content": {"reason": why}, "metadata": {}})

    def send(self, channel: str, msg_type: str, content: dict, q: Optional[queue.Queue] = None) -> str:
        """Send a message; with q, its replies go to q (subscribed before it leaves, so none is missed)."""
        msg = self.session.msg(msg_type, content)
        if q is not None:
            with self._wlock:
                self._waiting[msg["header"]["msg_id"]] = q
        self._send(channel, msg)
        return msg["header"]["msg_id"]

    # -- what each kind implements
    def _send(self, channel: str, msg: dict) -> None:
        raise NotImplementedError

    def interrupt(self) -> None:
        raise NotImplementedError

    def restart(self) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        raise NotImplementedError

    def public(self) -> dict:
        return {"id": self.id, "path": self.path, "target": self.target, "state": self.state, "execution_count": self.execution_count,
                "started_at": self.started_at, "error": self.error, "name": "python3", "display_name": "Python 3 (ipykernel)"}


def _session():
    from jupyter_client.session import Session

    return Session(key=b"", username="bluesandai")


def _client_dir(wid: str) -> Path:
    """The platform client (foundry.transforms, palantir_models) for local kernels, as a pod gets it."""
    import workspace_client

    d = cw.DIR / wid / ".client"
    files = {"workspace_client.py": (cw.HERE / "workspace_client.py").read_text("utf-8"), "model_lib.py": (cw.HERE / "model_lib.py").read_text("utf-8"),
             **workspace_client.PACKAGE_FILES}
    for name, text in files.items():
        f = d / name
        f.parent.mkdir(parents=True, exist_ok=True)
        if not f.exists() or f.read_text("utf-8") != text:
            f.write_text(text, "utf-8")
    return d


def local_secret(wid: str) -> tuple[str, str]:
    """A secret for one local kernel of the workspace, and its hash: the pod endpoints accept it like a pod secret
    while the kernel runs (each kernel has its own, so starting one does not cut off the others)."""
    secret = "bsai_local_" + secrets.token_urlsafe(32)
    digest = hashlib.sha256(secret.encode()).hexdigest()
    with cw._lock:
        rec = cw._read(wid)
        rec.pop("local_secret_hash", None)
        rec["local_secret_hashes"] = (rec.get("local_secret_hashes") or [])[-49:] + [digest]
        rec["owner"] = rec.get("owner") or cw._me()
        cw._write(rec)
    return secret, digest


def forget_local_secret(wid: str, digest: str) -> None:
    with cw._lock:
        try:
            rec = cw._read(wid)
        except HTTPException:
            return
        rec["local_secret_hashes"] = [h for h in rec.get("local_secret_hashes") or [] if h != digest]
        cw._write(rec)


# what a local kernel inherits from this machine's environment: what Python and the OS need, never the API's secrets
_ENV_KEEP = ("PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE",
             "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS",
             "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "TZ", "JAVA_HOME")

# %pip in a local kernel: packages go to the workspace's own folder (the API's environment is never changed)
PIP_STARTUP = r"""
import os, shlex, subprocess, sys, importlib
from IPython.core.magic import register_line_magic

@register_line_magic
def pip(line):
    # pip install / uninstall / list for this workspace (into its own package folder, with uv)
    target, uv = os.environ["BLUESANDAI_PACKAGES"], os.environ.get("BLUESANDAI_UV") or "uv"
    args = shlex.split(line)
    if not args:
        print("Usage: %pip install <package> ...   (%pip list, %pip uninstall <package>)"); return
    # uv finds no interpreter from the notebook's folder: always name it; --target is the workspace's package folder
    cmd = [uv, "pip", *args, "--python", sys.executable]
    if args[0] in ("install", "uninstall", "list", "freeze", "show"):
        cmd += ["--target", target]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        print("uv is not installed on the BluesandAI server: packages cannot be installed on Local CPU."); return
    print(r.stdout + r.stderr, end="")
    importlib.invalidate_caches()
    if r.returncode == 0 and args[0] in ("install", "uninstall") and os.environ.get("BLUESANDAI_ENV_SPEC"):
        _keep_spec(args[0], [a for a in args[1:] if not a.startswith("-")])
    if args[0] == "install" and r.returncode == 0:
        print("Installed for this workspace (added to its Packages). Restart the kernel if the package was already imported.")


def _keep_spec(action, reqs):
    import json, re
    path = os.environ["BLUESANDAI_ENV_SPEC"]
    try:
        with open(path, encoding="utf-8") as f:
            pkgs = json.load(f).get("pypi", [])
    except (OSError, ValueError):
        pkgs = []
    for req in reqs:
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)\s*(?:==\s*([^,;\s]+))?", req)
        if not m:
            continue
        pkgs = [p for p in pkgs if p.get("name", "").lower() != m.group(1).lower()]
        if action == "install":
            pkgs.append({"name": m.group(1), "version": m.group(2) or ""})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"pypi": sorted(pkgs, key=lambda p: p["name"].lower())}, f, indent=1)
        f.write("\n")

del pip
"""


class LocalKernel(Kernel):
    """ipykernel on this machine (jupyter_client); one thread polls its iopub, shell and stdin channels."""

    def __init__(self, wid: str, path: str, api_base: str) -> None:
        super().__init__(wid, path, "local")
        from jupyter_client import KernelManager

        cwd = _resolve(wid, path).parent
        secret, self.secret_hash = local_secret(wid)
        packages = (cw.DIR / wid / ".packages").resolve()
        packages.mkdir(parents=True, exist_ok=True)
        ipython = (cw.DIR / wid / ".ipython").resolve()
        startup = ipython / "profile_default" / "startup" / "00-bluesandai-pip.py"
        startup.parent.mkdir(parents=True, exist_ok=True)
        if not startup.exists() or startup.read_text("utf-8") != PIP_STARTUP:
            startup.write_text(PIP_STARTUP, "utf-8")
        env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP}
        env.update({"BLUESANDAI_API_URL": api_base, "BLUESANDAI_WORKSPACE_ID": wid, "BLUESANDAI_POD_URL": f"{api_base}/api/code-workspace-pod/{wid}",
                    "BLUESANDAI_API_TOKEN": secret, "BLUESANDAI_PACKAGES": str(packages), "BLUESANDAI_UV": shutil.which("uv") or "", "IPYTHONDIR": str(ipython),
                    "BLUESANDAI_ENV_SPEC": str(files_dir(wid).resolve() / ".bluesandai" / "packages.json"),
                    "PYTHONPATH": os.pathsep.join([str(packages), str(_client_dir(wid).resolve())]), "PYTHONIOENCODING": "utf-8",
                    "MPLBACKEND": "module://matplotlib_inline.backend_inline", "PYDEVD_DISABLE_FILE_VALIDATION": "1", "JPY_SESSION_NAME": str(_resolve(wid, path))})
        self.km = KernelManager(kernel_name="python3")
        self.km.start_kernel(cwd=str(cwd), env=env)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=90)
        self.state = "idle"
        self._shell = threading.Lock()
        self._stop = False
        threading.Thread(target=self._poll, daemon=True, name=f"kernel-{self.id}").start()

    def _poll(self) -> None:
        while not self._stop:
            got = False
            for channel, chan in (("iopub", self.kc.iopub_channel), ("shell", self.kc.shell_channel), ("stdin", self.kc.stdin_channel)):
                try:
                    with self._shell:
                        ready = chan.msg_ready()
                        msg = chan.get_msg(timeout=0) if ready else None
                except Exception:  # noqa: BLE001
                    msg = None
                if msg:
                    got = True
                    self.dispatch(channel, msg)
            if not got:
                if not self.km.is_alive() and self.state != "restarting":
                    self.died("The kernel process exited.")
                    return
                time.sleep(0.02)

    @property
    def session(self):
        return self.kc.session

    def _send(self, channel: str, msg: dict) -> None:
        chan = {"shell": self.kc.shell_channel, "stdin": self.kc.stdin_channel, "control": self.kc.control_channel}[channel]
        with self._shell:
            chan.send(msg)

    def interrupt(self) -> None:
        self.km.interrupt_kernel()

    def restart(self) -> None:
        self.state = "restarting"
        with self._shell:
            self.km.restart_kernel(now=True)
            self.kc.stop_channels()
            self.kc = self.km.client()
            self.kc.start_channels()
        self.kc.wait_for_ready(timeout=90)
        self.execution_count = 0
        self.state = "idle"

    def shutdown(self) -> None:
        self._stop = True
        forget_local_secret(self.wid, self.secret_hash)
        try:
            self.kc.stop_channels()
            self.km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001
            pass
        self.state = "dead"


# the machine's Jupyter: (base URL, token, TLS context or None for the default checks)
Machine = tuple[str, str, Optional[ssl.SSLContext]]


def _pod_jupyter(rec: dict) -> Machine:
    pod = rec.get("pod") or {}
    ep = cw.jupyter_endpoint(rec)
    if not pod.get("id") or pod.get("status") != "running" or not ep:
        raise HTTPException(409, "the workspace's machine is not running: start it first")
    return ep[0], rec["jupyter_token"], ep[1]


def _pod_call(m: Machine, method: str, path: str, body: Optional[dict] = None, timeout: int = 60) -> Any:
    base, token, ctx = m
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"token {token}", "Content-Type": "application/json", "User-Agent": "bluesandai/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:  # noqa: S310
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"the machine's Jupyter refused {method} {path} ({e.code}): {e.read().decode('utf-8', 'replace')[:300]}") from None
    except urllib.error.URLError as e:
        raise HTTPException(502, f"the machine's Jupyter could not be reached: {e.reason}") from None


def sync_files(wid: str, m: Machine) -> int:
    """Copy the workspace's files (not notebooks, up to MAX_SYNC_BYTES each) into /workspace on the pod."""
    root = files_dir(wid)
    n = 0
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        target = urllib.parse.quote(f"workspace/{rel}")
        if p.is_dir():
            _pod_call(m, "PUT", f"/api/contents/{target}", {"type": "directory"})
        elif p.suffix != ".ipynb" and p.stat().st_size <= MAX_SYNC_BYTES:
            _pod_call(m, "PUT", f"/api/contents/{target}", {"type": "file", "format": "base64", "content": base64.b64encode(p.read_bytes()).decode()}, timeout=300)
            n += 1
    return n


class RemoteKernel(Kernel):
    """A kernel on the workspace's pod, through its Jupyter Server: REST for its lifecycle, the websocket for messages."""

    def __init__(self, wid: str, path: str, rec: dict) -> None:
        super().__init__(wid, path, "cloud-gpu" if (rec.get("pod") or {}).get("compute", rec["compute"]).get("kind") == "gpu" else "cloud-cpu")
        self.m = _pod_jupyter(rec)
        _pod_call(self.m, "PUT", "/api/contents/workspace", {"type": "directory"})
        sync_files(wid, self.m)
        sess = _pod_call(self.m, "POST", "/api/sessions",
                         {"path": f"workspace/{path}", "name": Path(path).name, "type": "notebook", "kernel": {"name": "python3"}})
        self.session_id, self.kernel_id = sess["id"], sess["kernel"]["id"]
        self.session = _session()
        self._send_lock = threading.Lock()
        self._connect()
        import code_workspace_env

        first = code_workspace_env.cloud_startup_code(wid)
        if first:
            self.send("shell", "execute_request", {"code": first, "silent": True, "store_history": False, "user_expressions": {}, "allow_stdin": False,
                                                    "stop_on_error": False})

    def _connect(self) -> None:
        from websockets.sync.client import connect

        base, token, ctx = self.m
        url = base.replace("https://", "wss://") + f"/api/kernels/{self.kernel_id}/channels?session_id={self.session.session}"
        self.ws = connect(url, additional_headers={"Authorization": f"token {token}", "User-Agent": "bluesandai/1.0"}, max_size=None, open_timeout=60,
                          **({"ssl": ctx} if ctx else {}))
        self.state = "idle"
        threading.Thread(target=self._read, args=(self.ws,), daemon=True, name=f"kernel-{self.id}").start()

    def _read(self, ws) -> None:
        try:
            for raw in ws:
                if isinstance(raw, bytes):
                    continue  # binary-framed messages carry buffers (widgets), not used here
                msg = json.loads(raw)
                self.dispatch(msg.get("channel", "iopub"), msg)
        except Exception as e:  # noqa: BLE001
            if self.state not in ("dead", "restarting"):
                self.died(f"The connection to the machine's kernel closed ({type(e).__name__}).")
            return
        if self.state not in ("dead", "restarting"):
            self.died("The connection to the machine's kernel closed (the machine may have stopped).")

    def _send(self, channel: str, msg: dict) -> None:
        msg["channel"] = channel
        with self._send_lock:
            self.ws.send(json.dumps(msg, default=str))

    def interrupt(self) -> None:
        _pod_call(self.m, "POST", f"/api/kernels/{self.kernel_id}/interrupt")

    def restart(self) -> None:
        self.state = "restarting"
        _pod_call(self.m, "POST", f"/api/kernels/{self.kernel_id}/restart", timeout=120)
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        self._connect()
        self.execution_count = 0

    def shutdown(self) -> None:
        self.state = "dead"
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            _pod_call(self.m, "DELETE", f"/api/sessions/{self.session_id}")
        except HTTPException:
            pass


def _kernel(wid: str, kid: str) -> Kernel:
    k = _kernels.get(kid)
    if not k or k.wid != wid:
        raise HTTPException(404, "this kernel is gone: start a new one")
    return k


def _cull() -> None:
    while True:
        time.sleep(300)
        for k in list(_kernels.values()):
            if isinstance(k, LocalKernel) and k.state == "idle" and time.time() - k.last_activity > KERNEL_IDLE_MINUTES * 60:
                k.shutdown()
                _kernels.pop(k.id, None)
            elif k.state == "dead" and time.time() - k.last_activity > 3600:
                _kernels.pop(k.id, None)


threading.Thread(target=_cull, daemon=True, name="kernel-cull").start()


@router.get("/kernels")
def list_kernels(wid: str) -> list[dict]:
    cw._get(wid)
    return [k.public() for k in _kernels.values() if k.wid == wid]


class KernelIn(BaseModel):
    path: str
    target: Literal["local", "cloud"]


@router.post("/kernels")
def start_kernel(wid: str, req: KernelIn, request: Request) -> dict:
    """The notebook's kernel on that target: the running one, or a new one."""
    rec = cw._get(wid, "editor")
    if not _resolve(wid, req.path).is_file():
        raise HTTPException(404, f"{req.path} does not exist")
    with _lock:
        for k in list(_kernels.values()):
            if k.wid == wid and k.path == req.path:
                if k.state != "dead" and (k.target == "local") == (req.target == "local"):
                    return k.public()
                k.shutdown()
                _kernels.pop(k.id, None)
    if req.target == "local":
        host, port = (request.scope.get("server") or ("127.0.0.1", 8000))[:2]
        try:
            k: Kernel = LocalKernel(wid, req.path, f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"the local kernel did not start: {e}") from None
    else:
        k = RemoteKernel(wid, req.path, cw._refresh(rec))
    with _lock:
        _kernels[k.id] = k
    return k.public()


@router.get("/kernels/{kid}")
def get_kernel(wid: str, kid: str) -> dict:
    cw._get(wid)
    return _kernel(wid, kid).public()


@router.delete("/kernels/{kid}")
def shutdown_kernel(wid: str, kid: str) -> dict:
    cw._get(wid, "editor")
    k = _kernel(wid, kid)
    k.shutdown()
    _kernels.pop(kid, None)
    return {"shutdown": kid}


@router.post("/kernels/{kid}/interrupt")
def interrupt_kernel(wid: str, kid: str) -> dict:
    cw._get(wid, "editor")
    k = _kernel(wid, kid)
    k.interrupt()
    return k.public()


@router.post("/kernels/{kid}/restart")
def restart_kernel(wid: str, kid: str) -> dict:
    cw._get(wid, "editor")
    k = _kernel(wid, kid)
    try:
        k.restart()
    except Exception as e:  # noqa: BLE001
        k.died(f"The kernel did not restart: {e}")
        raise HTTPException(500, f"the kernel did not restart: {e}") from None
    return k.public()


class ExecuteIn(BaseModel):
    code: str
    silent: bool = False
    store_history: bool = True


def _stream(k: Kernel, msg_id: str, q: queue.Queue, done_on: str):
    yield json.dumps({"msg_type": "request_sent", "content": {"msg_id": msg_id}}) + "\n"
    idle = reply = False
    try:
        while not (idle and reply):
            try:
                m = q.get(timeout=15)
            except queue.Empty:
                if k.state == "dead":
                    yield json.dumps({"msg_type": "kernel_dead", "content": {"reason": k.error or "The kernel died."}}) + "\n"
                    return
                yield "\n"  # keeps proxies from closing a long-running cell's connection
                continue
            yield json.dumps(m, default=str) + "\n"
            if m["msg_type"] == "kernel_dead":
                return
            if m["msg_type"] == "status" and m["content"].get("execution_state") == "idle":
                idle = True
            if m["msg_type"] == done_on:
                reply = True
    finally:
        k.unsubscribe(msg_id)


def _request(k: Kernel, msg_type: str, content: dict, done_on: str) -> StreamingResponse:
    if k.state == "dead":
        raise HTTPException(409, k.error or "the kernel is dead: restart it")
    q: queue.Queue = queue.Queue()
    msg_id = k.send("shell", msg_type, content, q)
    return StreamingResponse(_stream(k, msg_id, q, done_on), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/kernels/{kid}/execute")
def execute(wid: str, kid: str, req: ExecuteIn) -> StreamingResponse:
    """Run code; the kernel's messages for it, one JSON object per line, until it is idle again."""
    cw._get(wid, "editor")
    k = _kernel(wid, kid)
    return _request(k, "execute_request", {"code": req.code, "silent": req.silent, "store_history": req.store_history, "user_expressions": {},
                                           "allow_stdin": True, "stop_on_error": True}, "execute_reply")


class InputIn(BaseModel):
    value: str


@router.post("/kernels/{kid}/input")
def send_input(wid: str, kid: str, req: InputIn) -> dict:
    """The answer to an input() the kernel asked for."""
    cw._get(wid, "editor")
    k = _kernel(wid, kid)
    k.send("stdin", "input_reply", {"value": req.value})
    return {"ok": True}


class CodeAt(BaseModel):
    code: str
    cursor_pos: int


def _ask(k: Kernel, msg_type: str, content: dict, reply_type: str, timeout: float = 10) -> dict:
    if k.state == "dead":
        raise HTTPException(409, k.error or "the kernel is dead: restart it")
    q: queue.Queue = queue.Queue()
    msg_id = k.send("shell", msg_type, content, q)
    end = time.time() + timeout
    try:
        while time.time() < end:
            try:
                m = q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                break
            if m["msg_type"] == reply_type:
                return m["content"]
    finally:
        k.unsubscribe(msg_id)
    return {"status": "timeout"}


@router.post("/kernels/{kid}/complete")
def complete(wid: str, kid: str, req: CodeAt) -> dict:
    cw._get(wid)
    return _ask(_kernel(wid, kid), "complete_request", {"code": req.code, "cursor_pos": req.cursor_pos}, "complete_reply")


@router.post("/kernels/{kid}/inspect")
def inspect(wid: str, kid: str, req: CodeAt) -> dict:
    cw._get(wid)
    return _ask(_kernel(wid, kid), "inspect_request", {"code": req.code, "cursor_pos": req.cursor_pos, "detail_level": 0}, "inspect_reply")


def shutdown_workspace(wid: str, target: Optional[str] = None) -> None:
    """Shut down the workspace's kernels (all, or the cloud ones when its pod stops)."""
    for k in list(_kernels.values()):
        if k.wid == wid and (target is None or (target == "cloud") == (k.target != "local")):
            k.shutdown()
            _kernels.pop(k.id, None)

