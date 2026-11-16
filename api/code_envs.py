"""Per-repository Python environments for Code Repositories transforms, built with uv.

Foundry resolves a repository's conda_recipe/meta.yaml into an environment during Checks and installs it for builds.
Here a repository whose meta.yaml the API's own environment already satisfies runs in that environment, as before.
When it asks for something that environment lacks — a package that is not installed, another version of one, or
another supported Python (3.10 / 3.11) — code_env.resolve plans a dedicated environment and this module builds it:

  same Python as the API   a venv holding only the packages that differ, layered over the API's site-packages (a
                           .pth file), so the transforms runtime stays available and the repository's versions win
  another Python           `uv venv --python 3.x` (uv downloads the interpreter) with the runner's own packages
                           (RUNTIME) and every package meta.yaml lists

uv solves the requirements together; a conflict fails the build / Checks with uv's explanation. Environments live in
data/code-envs/<key> (the key hashes the Python version and requirements); a resolved environment's versions are kept
in data/code-envs/locks/<key>.txt and passed as constraints if it is ever rebuilt, so an unpinned package keeps the
version it was first resolved to until meta.yaml changes (Foundry's lock file). Builds and checks run their
subprocess with the environment's interpreter (python_for).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import sysconfig
import threading
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("bluesandai.code_envs")

# what code_runner.py itself imports in an environment of another Python version
RUNTIME = ["pandas", "pyarrow", "numpy", "pyyaml", "psutil", "packaging", "polars", "duckdb", "pytest", "pytest-xdist"]
INSTALL_TIMEOUT_S = 900

DIR = Path("data/code-envs")
_locks: dict[str, threading.Lock] = {}
_glock = threading.Lock()


class EnvError(Exception):
    pass


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "code-envs"


def _uv() -> Optional[str]:
    return os.environ.get("BLUESANDAI_UV") or shutil.which("uv") or shutil.which("uv", path=str(Path(sys.executable).parent))


def key_of(plan: dict) -> str:
    base = None if plan.get("python") else f"{sys.version_info.major}.{sys.version_info.minor}:{sys.prefix}"
    raw = json.dumps({"python": plan.get("python"), "requirements": sorted(plan["requirements"]), "base": base,
                      "runtime": RUNTIME if plan.get("python") else None}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def _python_of(env: Path) -> Path:
    return env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def status(plan: dict) -> dict:
    """{key, ready, lock (pinned versions), error} of a planned environment, without building it."""
    key = key_of(plan)
    env = DIR / key
    out: dict = {"key": key, "ready": (env / "ready.json").exists(), "lock": None, "error": None, "built": None}
    if out["ready"]:
        try:
            # when it was built and how long each condaPackRun stage took
            out["built"] = json.loads((env / "ready.json").read_text("utf-8"))
        except ValueError:
            pass
    lock = DIR / "locks" / f"{key}.txt"
    if lock.exists():
        out["lock"] = [ln for ln in lock.read_text("utf-8").splitlines() if ln and not ln.startswith("#")]
    failed = DIR / f"{key}.failed.json"
    if not out["ready"] and failed.exists():
        try:
            out["error"] = json.loads(failed.read_text("utf-8")).get("error")
        except ValueError:
            pass
    return out


def python_of_key(key: str) -> Optional[str]:
    """The interpreter of an installed environment, by key (a debug job reruns a build in an earlier one)."""
    env = DIR / (key or "_")
    if len(key or "") == 20 and key.isalnum() and (env / "ready.json").exists() and _python_of(env).exists():
        return str(_python_of(env))
    return None


def python_for(plan: Optional[dict]) -> str:
    """The interpreter a repository's code runs with: the API's own, or its dedicated environment's (built now
    when it does not exist yet). EnvError when it cannot be built."""
    if not plan:
        return sys.executable
    key = key_of(plan)
    env = DIR / key
    if (env / "ready.json").exists() and _python_of(env).exists():
        return str(_python_of(env))
    with _glock:
        lk = _locks.setdefault(key, threading.Lock())
    with lk:
        if (env / "ready.json").exists() and _python_of(env).exists():
            return str(_python_of(env))
        _build(plan, key, env)
    return str(_python_of(env))


def _run(cmd: list[str], what: str) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=INSTALL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise EnvError(f"{what} took longer than {INSTALL_TIMEOUT_S // 60} minutes") from None
    if p.returncode != 0:
        msg = (p.stderr or p.stdout or "").strip()
        raise EnvError(f"{what} failed:\n{msg[-4000:]}")
    return p.stdout


def check_installable(requirements: list[str]) -> Optional[str]:
    """uv's dry-run resolution of requirements (the Task Runner's install): None, or why they cannot be installed."""
    uv = _uv()
    if not requirements or not uv:
        return None
    try:
        _run([uv, "pip", "install", "--dry-run", "--quiet", "--python", sys.executable, *requirements], "resolving " + ", ".join(requirements))
    except EnvError as e:
        return str(e)
    return None


def _build(plan: dict, key: str, env: Path) -> None:
    uv = _uv()
    if not uv:
        raise EnvError("installing packages that are not in the API's environment needs uv (https://docs.astral.sh/uv/) on the PATH, or BLUESANDAI_UV")
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / "locks").mkdir(exist_ok=True)
    tmp = DIR / f"{key}.building"
    shutil.rmtree(tmp, ignore_errors=True)
    failed = DIR / f"{key}.failed.json"
    started = time.monotonic()
    stages: list[dict] = []

    def stage(name: str, t0: float) -> None:
        stages.append({"name": name, "ms": int((time.monotonic() - t0) * 1000)})

    try:
        t0 = time.monotonic()
        python = plan.get("python") or f"{sys.version_info.major}.{sys.version_info.minor}"
        # same Python: the API's interpreter (so its site-packages fit); another: uv finds or downloads it
        _run([uv, "venv", "--quiet", "--python", sys.executable if not plan.get("python") else python, str(tmp)], f"creating a Python {python} environment")
        stage(f"create the Python {python} environment", t0)
        t0 = time.monotonic()
        py = str(_python_of(tmp))
        reqs = list(plan["requirements"]) + (RUNTIME if plan.get("python") else [])
        if reqs:
            cmd = [uv, "pip", "install", "--quiet", "--python", py, *reqs]
            lock = DIR / "locks" / f"{key}.txt"
            if lock.exists():
                cmd += ["--constraint", str(lock)]
            _run(cmd, "installing " + ", ".join(plan["requirements"] or ["the transforms runtime"]))
            stage("download, verify and link the packages", t0)
        t0 = time.monotonic()
        if not plan.get("python"):
            # layer over the API's packages: the environment's own site-packages come first on sys.path
            site = Path(_run([py, "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], "locating the environment").strip())
            base = dict.fromkeys([sysconfig.get_paths()["purelib"], sysconfig.get_paths()["platlib"]])
            (site / "zz_bluesandai_base.pth").write_text("\n".join(base) + "\n", "utf-8")
        frozen = _run([uv, "pip", "freeze", "--python", py], "listing the installed versions")
        lock = DIR / "locks" / f"{key}.txt"
        if not lock.exists():
            lock.write_text(f"# python {python}; requirements: {', '.join(plan['requirements'])}\n{frozen}", "utf-8")
        stage("write the lock", t0)
        (tmp / "ready.json").write_text(json.dumps({"python": python, "requirements": plan["requirements"], "built_s": round(time.monotonic() - started, 1),
                                                    "built_at": time.time(), "stages": stages}), "utf-8")
        shutil.rmtree(env, ignore_errors=True)
        tmp.replace(env)
        failed.unlink(missing_ok=True)
        log.info("environment %s ready (python %s, %s) in %.0fs", key, python, ", ".join(plan["requirements"]), time.monotonic() - started)
    except EnvError as e:
        shutil.rmtree(tmp, ignore_errors=True)
        failed.write_text(json.dumps({"error": str(e), "at": time.time()}), "utf-8")
        raise
    except OSError as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise EnvError(f"the environment could not be created: {e}") from None
