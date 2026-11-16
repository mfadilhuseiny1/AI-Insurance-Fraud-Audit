"""The managed Python environment of a Jupyter Code Workspace (Foundry's Packages / Libraries panel, PyPI).

The workspace's packages are a spec kept with its files, in .bluesandai/packages.json (so it is versioned with the
workspace's Git repository and follows its branches): [{name, version}] where version "" means the latest. They are
installed with uv into the workspace's package folder (data/code-workspaces/<id>/.packages, first on a Local CPU
kernel's PYTHONPATH; the API's own environment is never changed). Cloud kernels (Compute Engine, RunPod) install the
spec with pip when they start, and a package added while one runs is installed there too. The lockfile is what uv
resolved in the package folder. %pip install in a Local CPU notebook adds to the spec as well.

PyPI is searched by exact project name (PyPI has no search API): the panel shows the project's summary and versions.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import code_workspaces as cw

router = APIRouter(prefix="/api/code-workspaces/{wid}/lab", tags=["code-workspaces"])
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?$")
VERSION = re.compile(r"^[A-Za-z0-9.+!*-]*$")
_locks: dict[str, threading.Lock] = {}


def _lock(wid: str) -> threading.Lock:
    return _locks.setdefault(wid, threading.Lock())


def spec_path(wid: str) -> Path:
    import code_workspace_lab as lab

    return lab.files_dir(wid) / ".bluesandai" / "packages.json"


def packages_dir(wid: str) -> Path:
    d = (cw.DIR / wid / ".packages").resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_spec(wid: str) -> list[dict]:
    p = spec_path(wid)
    try:
        data = json.loads(p.read_text("utf-8")) if p.exists() else {}
    except ValueError:
        return []
    return [x for x in data.get("pypi", []) if isinstance(x, dict) and NAME.match(str(x.get("name", "")))]


def write_spec(wid: str, pkgs: list[dict]) -> None:
    p = spec_path(wid)
    p.parent.mkdir(parents=True, exist_ok=True)
    pkgs = sorted({x["name"].lower(): {"name": x["name"], "version": x.get("version") or ""} for x in pkgs}.values(), key=lambda x: x["name"].lower())
    p.write_text(json.dumps({"pypi": pkgs}, indent=1) + "\n", "utf-8")


def requirement(x: dict) -> str:
    return f"{x['name']}=={x['version']}" if x.get("version") else x["name"]


def _uv() -> str:
    exe = shutil.which("uv")
    if not exe:
        raise HTTPException(500, "uv is not installed on the server: packages cannot be installed on Local CPU")
    return exe


def _run(args: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "VIRTUAL_ENV", "PIP_"))}
    env["NO_COLOR"] = "1"
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env)


def install_local(wid: str, reqs: list[str]) -> subprocess.CompletedProcess:
    return _run([_uv(), "pip", "install", "--target", str(packages_dir(wid)), "--python", sys.executable, *reqs])


def _cloud_install(wid: str, reqs: list[str]) -> int:
    """Install into the workspace's running cloud kernels (silently, before their next cells)."""
    import code_workspace_lab as lab

    n = 0
    for k in list(lab._kernels.values()):
        if k.wid == wid and k.target != "local" and k.state != "dead":
            k.send("shell", "execute_request", {"code": "%pip install -q " + " ".join(f'"{r}"' for r in reqs), "silent": True, "store_history": False,
                                                 "user_expressions": {}, "allow_stdin": False, "stop_on_error": False})
            n += 1
    return n


def cloud_startup_code(wid: str) -> Optional[str]:
    """What a new cloud kernel runs first: the spec's packages (None when there are none)."""
    reqs = [requirement(x) for x in read_spec(wid)]
    return "%pip install -q " + " ".join(f'"{r}"' for r in reqs) if reqs else None


def _installed(wid: str) -> dict[str, str]:
    r = _run([_uv(), "pip", "list", "--format", "json", "--target", str(packages_dir(wid)), "--python", sys.executable], timeout=120)
    try:
        return {x["name"].lower(): x["version"] for x in json.loads(r.stdout or "[]")}
    except ValueError:
        return {}


def _base_version(name: str) -> Optional[str]:
    """The version the platform's own environment has (what a notebook gets without installing anything)."""
    from importlib import metadata

    try:
        return metadata.version(name.split("[")[0])
    except metadata.PackageNotFoundError:
        return None


@router.get("/packages")
def list_packages(wid: str) -> dict:
    cw._get(wid)
    installed = _installed(wid) if shutil.which("uv") else {}
    out = []
    for x in read_spec(wid):
        key = x["name"].split("[")[0].lower()
        out.append({**x, "installed": installed.get(key) or installed.get(key.replace("_", "-")), "base": _base_version(key)})
    return {"packages": out, "manager": "pypi", "uv": bool(shutil.which("uv"))}


@router.get("/packages/search")
def search_package(wid: str, q: str) -> dict:
    """A PyPI project by name: its summary, latest version and recent versions."""
    cw._get(wid)
    name = q.strip()
    if not NAME.match(name):
        raise HTTPException(400, "type a package name, e.g. scikit-learn")
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{urllib.parse.quote(name.split('[')[0])}/json", timeout=20) as r:  # noqa: S310
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise HTTPException(404, f"PyPI has no package named {name}") from None
        raise HTTPException(502, f"PyPI answered {e.code}") from None
    except urllib.error.URLError as e:
        raise HTTPException(502, f"PyPI could not be reached: {e.reason}") from None
    info = data.get("info") or {}

    def key(v: str):
        return [int(p) if p.isdigit() else -1 for p in re.split(r"[.+-]", v)]

    versions = [v for v, files in (data.get("releases") or {}).items() if files and not any(f.get("yanked") for f in files)]
    stable = [v for v in versions if re.fullmatch(r"[0-9]+(\.[0-9]+)*", v)]
    versions = sorted(stable or versions, key=key, reverse=True)[:40]
    return {"name": info.get("name") or name, "summary": info.get("summary") or "", "latest": info.get("version"), "versions": versions,
            "home": info.get("home_page") or (info.get("project_urls") or {}).get("Homepage"), "base": _base_version(name)}


class PackageIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    version: str = Field("", max_length=50)


@router.post("/packages")
def add_package(wid: str, req: PackageIn) -> dict:
    """Add a package to the workspace's environment and install it (Local CPU now, running cloud kernels too)."""
    cw._get(wid, "editor")
    if not NAME.match(req.name) or not VERSION.match(req.version):
        raise HTTPException(400, "invalid package name or version")
    x = {"name": req.name, "version": req.version}
    with _lock(wid):
        r = install_local(wid, [requirement(x)])
        if r.returncode != 0:
            raise HTTPException(400, f"{requirement(x)} could not be installed:\n{(r.stderr or r.stdout)[-1500:]}")
        write_spec(wid, [p for p in read_spec(wid) if p["name"].lower() != req.name.lower()] + [x])
    clouds = _cloud_install(wid, [requirement(x)])
    return {"installed": requirement(x), "log": (r.stdout + r.stderr)[-3000:], "cloud_kernels": clouds}


@router.delete("/packages/{name}")
def remove_package(wid: str, name: str) -> dict:
    cw._get(wid, "editor")
    if not NAME.match(name):
        raise HTTPException(400, "invalid package name")
    with _lock(wid):
        write_spec(wid, [p for p in read_spec(wid) if p["name"].lower() != name.lower()])
        r = _run([_uv(), "pip", "uninstall", name.split("[")[0], "--target", str(packages_dir(wid)), "--python", sys.executable], timeout=300)
    return {"removed": name, "log": (r.stdout + r.stderr)[-2000:]}


@router.post("/packages/sync")
def sync_packages(wid: str) -> dict:
    """Install every package of the spec (after a branch switch, or a spec edited by hand)."""
    cw._get(wid, "editor")
    reqs = [requirement(x) for x in read_spec(wid)]
    if not reqs:
        return {"installed": [], "log": "The environment has no packages."}
    with _lock(wid):
        r = install_local(wid, reqs)
    if r.returncode != 0:
        raise HTTPException(400, f"the environment could not be installed:\n{(r.stderr or r.stdout)[-1500:]}")
    return {"installed": reqs, "log": (r.stdout + r.stderr)[-3000:], "cloud_kernels": _cloud_install(wid, reqs)}


@router.get("/packages/lock")
def lockfile(wid: str) -> dict:
    """What is installed in the workspace's package folder, dependencies included (the lockfile)."""
    cw._get(wid)
    r = _run([_uv(), "pip", "freeze", "--target", str(packages_dir(wid)), "--python", sys.executable], timeout=120)
    return {"lock": r.stdout, "spec": [requirement(x) for x in read_spec(wid)]}
