"""One sidecar container next to a transform's driver or one of its Spark executors (transforms.sidecar).

Foundry runs the `@sidecar` container in each executor's pod: the executor and the container share volumes under
/opt/palantir/sidecars/shared-volumes/<name> and the container's ports on localhost. Here executors are Spark tasks
on this machine (pyspark_worker.py, one worker process per task) and the containers run on Docker
(container_runtime.py), so each slot gets its own folders, mounted into its container at
/opt/palantir/sidecars/shared-volumes/<name>; in the process that owns the slot, file paths under
/opt/palantir/sidecars/shared-volumes/ and connections to localhost:<exposed port> are redirected to them.

The spec comes from code_repos (`spec["sidecar"]`, passed to workers as BLUESANDAI_SIDECAR): {ref, user, ports,
volumes, docker: [command…], base_dir, run_args, label}.
"""

from __future__ import annotations

import builtins
import io
import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Optional

VOLUME_ROOT = "/opt/palantir/sidecars/shared-volumes"
ENV = "BLUESANDAI_SIDECAR"
_maps: dict[str, str] = {}
_ports: dict[int, int] = {}
_installed: dict = {}


def _wsl_path(p: str) -> str:
    p = str(Path(p).resolve())
    return f"/mnt/{p[0].lower()}/" + p[3:].replace("\\", "/") if len(p) > 2 and p[1] == ":" else p


def _docker(spec: dict, *args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run([*spec["docker"], *args], capture_output=True, timeout=timeout)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _ready(port: int) -> bool:
    """A published port answers: docker's proxy accepts at once, then closes when nothing listens in the container;
    a listening server keeps the connection open waiting for a request."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
            s.settimeout(0.5)
            try:
                return s.recv(1) != b""
            except socket.timeout:
                return True
    except OSError:
        return False


def start(spec: dict, role: str) -> dict:
    slot_id = f"{role}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    base = Path(spec["base_dir"]) / slot_id
    volumes = {}
    for v in spec.get("volumes") or []:
        d = base / v
        d.mkdir(parents=True, exist_ok=True)
        volumes[v] = str(d)
    ports = {p: _free_port() for p in spec.get("ports") or []}
    name = "bsai-sidecar-" + uuid.uuid4().hex[:12]
    args = ["run", "-d", "--name", name, "--label", "bluesandai.sidecar=1", "--label", f"bluesandai.run={spec.get('label', '')}", "--user", spec["user"]]
    for v, d in volumes.items():
        args += ["-v", f"{_wsl_path(d) if spec.get('wsl') else d}:{VOLUME_ROOT}/{v}"]
    for p, hp in ports.items():
        args += ["-p", f"127.0.0.1:{hp}:{p}"]
    # cmd: arguments after the image (a container model version's arguments or exec command)
    args += [*(spec.get("run_args") or []), spec["ref"], *(spec.get("cmd") or [])]
    p = _docker(spec, *args)
    if p.returncode != 0:
        # a container whose process could not start stays "Created"
        _docker(spec, "rm", "-f", name)
        shutil.rmtree(base, ignore_errors=True)
        raise RuntimeError(f"the sidecar container did not start: {(p.stderr or p.stdout).decode(errors='replace').strip()[-800:]}")
    slot = {"id": slot_id, "name": name, "dir": str(base), "volumes": volumes, "ports": ports, "started": time.time()}
    deadline = time.time() + float(spec.get("ready_timeout_s") or 60)
    for _, hp in ports.items():
        while not _ready(hp):
            if time.time() > deadline:
                break
            state = _docker(spec, "inspect", "-f", "{{.State.Running}}", name)
            if state.stdout.decode().strip() == "false":
                break
            time.sleep(0.3)
    for v, d in volumes.items():
        _maps[f"{VOLUME_ROOT}/{v}"] = d
    _ports.update(ports)
    install()
    return slot


def stop(spec: dict, slot: dict) -> str:
    """Stop and remove the container; its logs (stdout / stderr, the container's telemetry)."""
    logs = _docker(spec, "logs", "--timestamps", slot["name"], timeout=60)
    text = (logs.stdout + logs.stderr).decode(errors="replace")
    _docker(spec, "rm", "-f", slot["name"], timeout=60)
    for v in slot["volumes"]:
        _maps.pop(f"{VOLUME_ROOT}/{v}", None)
    for p in slot["ports"]:
        _ports.pop(p, None)
    shutil.rmtree(slot["dir"], ignore_errors=True)
    return text


# ------------------------------------------------------------------------------------------------
# redirection of the shared volume paths and localhost ports in this process
# ------------------------------------------------------------------------------------------------


def _map(p):
    if isinstance(p, (str, os.PathLike)) and not isinstance(p, bytes):
        s = os.fspath(p)
        if not isinstance(s, str):
            return p
        n = s.replace("\\", "/")
        for root, d in _maps.items():
            if n == root or n.startswith(root + "/"):
                return os.path.join(d, *[x for x in n[len(root):].split("/") if x])
    return p


def _wrap1(fn):
    def inner(path, *a, **k):
        return fn(_map(path), *a, **k)

    inner.__wrapped__ = fn
    return inner


def _wrap2(fn):
    def inner(src, dst, *a, **k):
        return fn(_map(src), _map(dst), *a, **k)

    inner.__wrapped__ = fn
    return inner


def install() -> None:
    if _installed:
        return
    _installed["open"] = builtins.open
    builtins.open = _wrap1(builtins.open)
    io.open = builtins.open
    for name in ("open", "stat", "lstat", "listdir", "scandir", "mkdir", "remove", "unlink", "rmdir", "chmod", "access", "utime"):
        if hasattr(os, name):
            setattr(os, name, _wrap1(getattr(os, name)))
    for name in ("rename", "replace"):
        setattr(os, name, _wrap2(getattr(os, name)))
    # Python 3.12 on Windows checks paths in C (nt._path_exists…), not through os.stat
    for name in ("exists", "lexists", "isfile", "isdir", "islink", "getsize", "getmtime", "getatime", "getctime", "realpath", "abspath"):
        if hasattr(os.path, name):
            setattr(os.path, name, _wrap1(getattr(os.path, name)))
    orig = socket.getaddrinfo

    def getaddrinfo(host, port, *a, **k):
        try:
            pn = int(port) if port is not None else None
        except (TypeError, ValueError):
            pn = None
        if pn in _ports and str(host).lower() in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
            return orig("127.0.0.1", _ports[pn], *a, **k)
        return orig(host, port, *a, **k)

    socket.getaddrinfo = getaddrinfo


def spec_from_env() -> Optional[dict]:
    raw = os.environ.get(ENV)
    return json.loads(raw) if raw else None


def append_log(spec: dict, role: str, text: str) -> None:
    """Workers cannot return their container's logs: they go to a file the driver collects."""
    log = Path(spec["base_dir"]) / "sidecar-logs.txt"
    with builtins.open(log, "a", encoding="utf-8") as f:
        f.write(f"--- sidecar of {role} (pid {os.getpid()}) ---\n{text}\n")
