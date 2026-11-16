"""The R transforms app (`/r`, palantir.com/docs/foundry/transforms-r): its runtime, packages and renv.

R transforms themselves are Code Repositories transforms (code_r.py: `.transforms/*.yml` specs, the `foundry`
dataset bridge, builds and checks through code_repos.py). This module adds what the R workspace needs on top:

  GET  /api/code-repos/tools/r/runtime        the R installation (version, Rscript, shared library, mirrors)
  GET  /api/code-repos/tools/r/repositories   code repositories holding R transforms
  GET  /api/code-repos/tools/r/packages?q=     CRAN / Bioconductor packages from Posit Package Manager, with the
                                              version installed in the shared library
  GET  /api/code-repos/tools/r/installed      {package: version} R can load (shared library, base, recommended)
  POST /api/code-repos/{id}/r/install         install packages into the shared library (every R transform sees it)
  POST /api/code-repos/{id}/r/snapshot        renv::snapshot() of the packages the repository's R code uses: writes
                                              renv.lock into the branch (uncommitted, like a file edit)

Packages come from Posit Package Manager's CRAN and Bioconductor mirrors, as the docs' Artifacts mirrors do.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import code_envs
import code_r
import code_repos as cr

router = APIRouter(prefix="/api/code-repos")

POSIT_API = "https://packagemanager.posit.co/__api__/repos"
PKG_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9.]{0,99}$")
INSTALL_TIMEOUT_S = 1800
_installed_cache: dict[str, tuple[float, dict[str, str]]] = {}


def _shared_lib() -> Path:
    lib = code_envs.DIR / "r-library" / (code_r.version() or "unknown")
    lib.mkdir(parents=True, exist_ok=True)
    return lib


def _rscript(code: str, cwd: Optional[Path] = None, timeout: int = 120) -> subprocess.CompletedProcess:
    exe = code_r.executable()
    if not exe:
        raise HTTPException(400, code_r.runtime_issue())
    with tempfile.TemporaryDirectory(prefix="rtool-") as tmp:
        script = Path(tmp) / "tool.R"
        lib = _shared_lib().resolve().as_posix()
        script.write_text(
            f"options(repos = c(CRAN = {code_r._r_string(code_r.CRAN_MIRROR)}), BioC_mirror = {code_r._r_string(code_r.BIOC_MIRROR)})\n"
            f".libPaths(unique(c({code_r._r_string(lib)}, .libPaths())))\n" + code, "utf-8")
        env = {**os.environ, "R_LIBS_USER": lib, "RENV_CONFIG_REPOS_OVERRIDE": code_r.CRAN_MIRROR,
               "RENV_PATHS_ROOT": str((code_envs.DIR / "renv").resolve())}
        try:
            return subprocess.run([exe, "--vanilla", str(script)], cwd=str(cwd or tmp), env=env, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=timeout)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, f"R did not finish within {timeout // 60} minutes") from None


def _installed(refresh: bool = False) -> dict[str, str]:
    """{package: version} of every package R can load (the shared library, base and recommended packages)."""
    key = code_r.executable() or ""
    hit = _installed_cache.get(key)
    if hit and not refresh and time.time() - hit[0] < 60:
        return hit[1]
    p = _rscript("ip <- installed.packages()[, c('Package', 'Version'), drop = FALSE]\n"
                 "cat(paste(ip[, 1], ip[, 2], sep = '\\t'), sep = '\\n')\n")
    out = {}
    for line in p.stdout.splitlines():
        name, _, ver = line.partition("\t")
        if name and ver:
            out.setdefault(name, ver)
    _installed_cache[key] = (time.time(), out)
    return out


@router.get("/tools/r/runtime")
def r_runtime() -> dict:
    exe = code_r.executable()
    return {"available": bool(exe), "version": code_r.version(), "executable": exe, "error": None if exe else code_r.runtime_issue(),
            "library": str(_shared_lib()) if exe else None, "cran": code_r.CRAN_MIRROR, "bioconductor": code_r.BIOC_MIRROR}


@router.get("/tools/r/installed")
def r_installed() -> dict[str, str]:
    return _installed() if code_r.executable() else {}


def _is_r_repo(files: dict[str, str]) -> bool:
    return any(p.startswith(".transforms/") and "rscript" in c for p, c in files.items()) or any(p.lower().endswith(".r") for p in files)


@router.get("/tools/r/repositories")
def r_repositories() -> list[dict]:
    """Code repositories with R transforms (a `.transforms` spec with an rscript runtime, or R files)."""
    out = []
    for rec in auth.visible_resources("code_repo", cr.all_repos()):
        b = rec["branches"][rec["default_branch"]]
        if _is_r_repo(b["files"]):
            specs = [p for p, c in b["files"].items() if p.startswith(".transforms/") and "rscript" in c]
            out.append({"id": rec["id"], "name": rec["name"], "description": rec.get("description") or "", "default_branch": rec["default_branch"],
                        "branches": sorted(rec["branches"]), "specs": len(specs), "updated_at": b.get("updated_at")})
    return sorted(out, key=lambda r: r.get("updated_at") or "", reverse=True)


def _posit(repo: str, params: dict) -> list[dict]:
    url = f"{POSIT_API}/{repo}/packages?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Posit Package Manager could not be reached: {type(e).__name__}") from None
    return data if isinstance(data, list) else []


@router.get("/tools/r/packages")
def r_packages(q: str = "", limit: int = 25) -> list[dict]:
    """Packages matching `q` on CRAN and Bioconductor (exact names first, then names containing it)."""
    q = q.strip()
    if not q:
        return []
    if not re.fullmatch(r"[A-Za-z0-9.]{1,100}", q):
        raise HTTPException(400, "search with a package name (letters, digits and dots)")
    limit = max(1, min(limit, 50))
    seen: dict[str, dict] = {}
    for repo, label in (("cran", "CRAN"), ("bioconductor", "Bioconductor")):
        for params in ({"name": q, "_limit": 5}, {"name_like": q, "_limit": limit}):
            try:
                rows = _posit(repo, params)
            except HTTPException:
                if repo == "cran":
                    raise
                rows = []
            for p in rows:
                name = p.get("name")
                if name and name not in seen:
                    seen[name] = {"name": name, "version": p.get("version"), "license": p.get("license") or "", "repository": label,
                                  "depends": p.get("depends") or "", "imports": p.get("imports") or ""}
    installed = _installed() if code_r.executable() else {}
    ql = q.lower()
    rows = sorted(seen.values(), key=lambda p: (p["name"].lower() != ql, not p["name"].lower().startswith(ql), p["repository"] != "CRAN", p["name"].lower()))
    return [{**p, "installed": installed.get(p["name"])} for p in rows[:limit]]


def used_packages(files: dict[str, str]) -> list[str]:
    """Packages the repository's R code loads: library(x), require(x), requireNamespace("x") and x::f."""
    found: list[str] = []
    for path, text in sorted(files.items()):
        if not path.lower().endswith(".r") and not path.endswith(".Rprofile"):
            continue
        code = re.sub(r"#[^\n]*", "", text)
        for m in re.finditer(r"\b(?:library|require|requireNamespace)\s*\(\s*['\"]?([A-Za-z][A-Za-z0-9.]*)", code):
            found.append(m.group(1))
        for m in re.finditer(r"\b([A-Za-z][A-Za-z0-9.]*):::?[A-Za-z._]", code):
            found.append(m.group(1))
    base = {"foundry", "base", "stats", "utils", "methods", "graphics", "grDevices", "datasets", "tools", "parallel", "grid", "splines", "stats4", "tcltk", "compiler"}
    return sorted({p for p in found if p not in base})


class InstallIn(BaseModel):
    packages: list[str] = Field(min_length=1, max_length=30)
    repository: Literal["CRAN", "Bioconductor"] = "CRAN"


@router.post("/{repo_id}/r/install")
def r_install(repo_id: str, req: InstallIn) -> dict:
    """Install packages (and their dependencies) into the shared R library, from Posit Package Manager."""
    cr._repo(repo_id)
    bad = [p for p in req.packages if not PKG_NAME.fullmatch(p)]
    if bad:
        raise HTTPException(400, f"not package names: {', '.join(bad)}")
    pkgs = "c(" + ", ".join(code_r._r_string(p) for p in req.packages) + ")"
    lib = code_r._r_string(_shared_lib().resolve().as_posix())
    if req.repository == "Bioconductor":
        code = (f"if (!requireNamespace('BiocManager', quietly = TRUE)) utils::install.packages('BiocManager', lib = {lib})\n"
                f"BiocManager::install({pkgs}, lib = {lib}, update = FALSE, ask = FALSE)\n")
    else:
        code = f"utils::install.packages({pkgs}, lib = {lib})\n"
    code += f"missing <- {pkgs}[!vapply({pkgs}, requireNamespace, logical(1), quietly = TRUE)]\nif (length(missing)) stop('not installed: ', paste(missing, collapse = ', '))\n"
    p = _rscript(code, timeout=INSTALL_TIMEOUT_S)
    log = "\n".join(x for x in (p.stdout, p.stderr) if x).strip()
    installed = _installed(refresh=True)
    if p.returncode:
        raise HTTPException(400, "R could not install the packages: " + (log[-2000:] or f"exit code {p.returncode}"))
    return {"ok": True, "installed": {k: installed.get(k) for k in req.packages}, "log": log[-6000:]}


class SnapshotIn(BaseModel):
    branch: Optional[str] = None


@router.post("/{repo_id}/r/snapshot")
def r_snapshot(repo_id: str, req: SnapshotIn) -> dict:
    """renv::snapshot() of the packages the repository's R code uses, as renv.lock on the branch (uncommitted)."""
    rec = cr._repo(repo_id)
    b = cr._branch(rec, req.branch)
    cr._editable(rec, b)
    pkgs = used_packages(b["files"])
    if not pkgs:
        raise HTTPException(400, "the repository's R code loads no packages (library(), require() or pkg::) besides foundry and base R")
    installed = _installed()
    missing = [p for p in pkgs if p not in installed]
    if missing:
        raise HTTPException(400, f"install these packages first: {', '.join(missing)}")
    with tempfile.TemporaryDirectory(prefix="rsnap-") as tmp:
        project = Path(tmp)
        lock = project / "renv.lock"
        vec = "c(" + ", ".join(code_r._r_string(p) for p in pkgs) + ")"
        code = (f"if (!requireNamespace('renv', quietly = TRUE)) utils::install.packages('renv', lib = {code_r._r_string(_shared_lib().resolve().as_posix())})\n"
                f"renv::snapshot(project = {code_r._r_string(project.resolve().as_posix())}, packages = {vec}, "
                f"lockfile = {code_r._r_string(lock.resolve().as_posix())}, prompt = FALSE, force = TRUE)\n")
        p = _rscript(code, cwd=project, timeout=600)
        if p.returncode or not lock.exists():
            raise HTTPException(400, "renv::snapshot() failed: " + ((p.stderr or p.stdout)[-2000:]))
        text = lock.read_text("utf-8")
    cr._set_file(repo_id, b["name"], {"renv.lock": text})
    try:
        locked = sorted(json.loads(text).get("Packages", {}))
    except ValueError:
        locked = []
    return {"ok": True, "file": "renv.lock", "packages": pkgs, "locked": locked}
