"""Bring-your-own-container transforms (`@transform.using(...).with_container(image, tag)`).

Foundry runs a lightweight transform on top of the user's image (which needs no Python): the transform's Python code
drives it, and the programs it starts (`os.system`, `subprocess`) run from the image. Here the transform's Python
runs in code_runner.py on this machine and, for the duration of the compute function, a container of the image runs
on the container runtime (container_runtime.py: Docker, or Docker inside WSL) as user 5001:

- `$USER_WORKING_DIR` is a folder shared by both: the transform's working directory on this side, mounted at
  /home/user/working_dir in the container; the repository's `src` folder is copied into `$USER_WORKING_DIR/user_code`.
- `os.system(...)` and every `subprocess` call (run, call, check_output, Popen) execute inside the container
  (`docker exec`, in the matching working directory, with USER_WORKING_DIR set), their output in the build's logs;
  files they write appear in the working directory, where the Python side reads them (`pd.read_csv('data.csv')`).
- The container is removed after the run; its logs join the build's. Preview is not supported (as in Foundry).

The spec comes from code_repos (`spec["container"]`): {ref, docker: [command…], wsl, keepalive, base_dir, label}.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

CONTAINER_DIR = "/home/user/working_dir"
_ORIG_POPEN = subprocess.Popen
_ORIG_SYSTEM = os.system


def _wsl_path(p: str) -> str:
    p = str(Path(p).resolve())
    return f"/mnt/{p[0].lower()}/" + p[3:].replace("\\", "/") if len(p) > 2 and p[1] == ":" else p


def _run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    p = _ORIG_POPEN(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
    out, err = p.communicate(timeout=timeout)
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


class _Session:
    def __init__(self, spec: dict, work: Path) -> None:
        self.spec, self.work = spec, work
        self.name = "bsai-byoc-" + uuid.uuid4().hex[:12]
        self.scripts = work / ".byoc"
        self.scripts.mkdir(parents=True, exist_ok=True)
        self.n = 0

    def container_cwd(self, cwd: Optional[str]) -> str:
        here = Path(cwd or os.getcwd()).resolve()
        try:
            rel = here.relative_to(self.work.resolve())
        except ValueError:
            return CONTAINER_DIR
        return f"{CONTAINER_DIR}/{rel.as_posix()}".rstrip("/.") if str(rel) != "." else CONTAINER_DIR

    def exec_args(self, command: str, cwd: Optional[str]) -> list[str]:
        """docker exec of a shell command: written into a script in the shared folder (wsl.exe would split quoted
        arguments), run with sh in the container."""
        self.n += 1
        script = self.scripts / f"cmd-{self.n:04d}.sh"
        script.write_text(command + "\n", "utf-8", newline="\n")
        return [*self.spec["docker"], "exec", "-i", "-w", self.container_cwd(cwd), "-e", f"USER_WORKING_DIR={CONTAINER_DIR}", self.name,
                "sh", f"{CONTAINER_DIR}/.byoc/{script.name}"]


_session: dict = {}


def _command(args, shell: bool) -> str:
    if isinstance(args, (str, bytes)):
        return args.decode() if isinstance(args, bytes) else args
    parts = [os.fspath(a) for a in args]
    return " ".join(parts) if shell else shlex.join(parts)


class _ContainerPopen(_ORIG_POPEN):
    """subprocess.Popen while a BYOC transform runs: the command runs inside the container."""

    def __init__(self, args, *a, shell=False, cwd=None, env=None, executable=None, **kw):  # noqa: ANN001
        s = _session.get("s")
        if s is None:
            super().__init__(args, *a, shell=shell, cwd=cwd, env=env, executable=executable, **kw)
            return
        kw.pop("start_new_session", None)
        super().__init__(s.exec_args(_command(args, shell), cwd), *a, **kw)


def _system(command: str) -> int:
    s = _session.get("s")
    if s is None:
        return _ORIG_SYSTEM(command)
    p = _run(s.exec_args(str(command), None), timeout=24 * 3600)
    sys.stdout.write(p.stdout.decode("utf-8", "replace"))
    if p.stderr:
        sys.stdout.write(p.stderr.decode("utf-8", "replace"))
    return p.returncode


@contextmanager
def session(spec: dict, repo: Path, logs):  # noqa: ANN001
    """Run the compute function with the image's container: yields the working directory."""
    base = Path(spec["base_dir"])
    work = base / "work"
    work.mkdir(parents=True, exist_ok=True)
    src = next((p.parent for p in sorted(repo.rglob("setup.py")) if p.parent.name == "src"), repo)
    shutil.copytree(src, work / "user_code", dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    s = _Session(spec, work)
    keep = _ORIG_POPEN(spec["keepalive"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) if spec.get("keepalive") else None
    mount = _wsl_path(str(work)) if spec.get("wsl") else str(work)
    start = _run([*spec["docker"], "run", "-d", "--name", s.name, "--label", "bluesandai.sidecar=1", "--label", f"bluesandai.run={spec.get('label', '')}",
                  "--user", "5001", "-v", f"{mount}:{CONTAINER_DIR}", "-w", CONTAINER_DIR, "-e", f"USER_WORKING_DIR={CONTAINER_DIR}",
                  "--entrypoint", "sleep", spec["ref"], "infinity"])
    if start.returncode != 0:
        if keep:
            keep.kill()
        raise RuntimeError("the transform's container did not start (the image needs `sleep`, e.g. coreutils or busybox): "
                           + (start.stderr or start.stdout).decode("utf-8", "replace").strip()[-600:])
    old_cwd, old_env = os.getcwd(), os.environ.get("USER_WORKING_DIR")
    _session["s"] = s
    subprocess.Popen = _ContainerPopen  # type: ignore[misc]
    os.system = _system  # type: ignore[assignment]
    os.environ["USER_WORKING_DIR"] = str(work)
    os.chdir(work)
    try:
        yield work
    finally:
        os.chdir(old_cwd)
        if old_env is None:
            os.environ.pop("USER_WORKING_DIR", None)
        else:
            os.environ["USER_WORKING_DIR"] = old_env
        subprocess.Popen = _ORIG_POPEN  # type: ignore[misc]
        os.system = _ORIG_SYSTEM
        _session.pop("s", None)
        out = _run([*spec["docker"], "logs", s.name], timeout=60)
        text = (out.stdout + out.stderr).decode("utf-8", "replace").strip()
        if text:
            logs.write(f"--- container {spec.get('image', '')} ---\n{text}\n")
        _run([*spec["docker"], "rm", "-f", s.name], timeout=120)
        if keep:
            keep.kill()
        shutil.rmtree(base, ignore_errors=True)
