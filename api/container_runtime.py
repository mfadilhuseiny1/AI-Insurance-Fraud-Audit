"""The container runtime sidecar transforms run on: Docker, either on this machine or inside WSL.

`BLUESANDAI_DOCKER` picks it: `docker` (the docker CLI on the PATH), `wsl:<distro>` (Docker Engine inside a WSL
distribution, reached through wsl.exe), or `off`. Unset: the docker CLI when it is on the PATH, else the default WSL
distribution when it has a working docker. Windows paths are bind-mounted as /mnt/<drive>/… under WSL.

Images come from the platform's registry (container_registry.py): an image is written as an OCI layout archive and
`docker load`-ed once, as `bluesandai.local/<repository>/<image>:sha256-<manifest digest>` (one local name per digest,
whichever image store the daemon uses), so it is loaded again only when missing.

`relay_start()`: inside WSL, `localhost` is not this machine (WSL2's NAT network), so `docker push` from WSL cannot
reach the API. The relay listens on 127.0.0.1:<port> inside WSL and bridges each connection to the API through a
Windows process (WSL can start Windows programs), so `docker login 127.0.0.1:<port>` and `docker push` work there.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

RELAY_PORT = int(os.environ.get("BLUESANDAI_REGISTRY_RELAY_PORT") or 5005)
API_PORT = int(os.environ.get("BLUESANDAI_API_PORT") or 8000)
HERE = Path(__file__).resolve().parent
_state: dict = {}
_lock = threading.Lock()


class RuntimeError_(Exception):
    pass


# transforms.sidecar resource profiles: CPU cores, memory GB, GPU, shared memory GB
SIDECAR_PROFILES = {
    "SMALL_CPU_SMALL_MEMORY": (1, 3, False, None),
    "MEDIUM_CPU_MEDIUM_MEMORY": (2, 6, False, None),
    "MEDIUM_CPU_MEDIUM_MEMORY_SMALL_SHARED_MEMORY": (2, 6, False, 2),
    "LARGE_CPU_LARGE_MEMORY": (4, 13, False, None),
    "LARGE_CPU_LARGE_MEMORY_GPU_ENABLED": (4, 13, True, None),
    "X_LARGE_CPU_X_LARGE_MEMORY": (8, 27, False, None),
    "X_LARGE_CPU_X_LARGE_MEMORY_GPU_ENABLED": (8, 27, True, None),
    "XX_LARGE_CPU_XX_LARGE_MEMORY": (16, 54, False, None),
}


def profile_args(profile: Optional[str]) -> list[str]:
    """docker run limits of a sidecar resource profile (CPU capped at this machine's cores)."""
    if not profile:
        return []
    cpus, mem, gpu, shm = SIDECAR_PROFILES[profile]
    args = ["--cpus", str(min(cpus, os.cpu_count() or cpus)), "--memory", f"{mem}g"]
    if shm:
        args += ["--shm-size", f"{shm}g"]
    if gpu:
        args += ["--gpus", "all"]
    return args


def _wsl() -> Optional[str]:
    return shutil.which("wsl.exe") or shutil.which("wsl")


def _detect() -> dict:
    choice = (os.environ.get("BLUESANDAI_DOCKER") or "").strip()
    if choice.lower() in ("off", "none", "0"):
        return {"kind": "off", "error": "container runtime disabled (BLUESANDAI_DOCKER=off)"}
    if choice.startswith("wsl:") or (not choice and not shutil.which("docker") and _wsl()):
        distro = choice[4:] if choice.startswith("wsl:") else None
        base = [_wsl(), *(["-d", distro] if distro else []), "--"]
        try:
            p = subprocess.run([*base, "docker", "version", "--format", "{{.Server.Version}}"], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            return {"kind": "off", "error": f"WSL is not usable: {e}"}
        if p.returncode != 0:
            return {"kind": "off", "error": "no docker in WSL" + (f" ({distro})" if distro else "") + f": {(p.stderr or p.stdout).strip()[:300]}"}
        return {"kind": "wsl", "distro": distro or "default", "base": base, "version": p.stdout.strip()}
    exe = shutil.which(choice or "docker")
    if not exe:
        return {"kind": "off", "error": "no container runtime: install Docker (or Docker Engine in WSL), or set BLUESANDAI_DOCKER"}
    p = subprocess.run([exe, "version", "--format", "{{.Server.Version}}"], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        return {"kind": "off", "error": f"docker is not running: {(p.stderr or p.stdout).strip()[:300]}"}
    return {"kind": "native", "base": [exe], "version": p.stdout.strip()}


def runtime(refresh: bool = False) -> dict:
    with _lock:
        if refresh or "rt" not in _state or (_state["rt"]["kind"] == "off" and time.monotonic() - _state.get("at", 0) > 60):
            _state["rt"] = _detect()
            _state["at"] = time.monotonic()
        return _state["rt"]


def available() -> bool:
    return runtime()["kind"] != "off"


def host_path(p: Path | str) -> str:
    """A path of this machine as the docker daemon sees it."""
    p = str(Path(p).resolve())
    if runtime()["kind"] == "wsl" and re.match(r"^[A-Za-z]:\\", p):
        return f"/mnt/{p[0].lower()}/" + p[3:].replace("\\", "/")
    return p


def docker(*args: str, timeout: int = 300, input_bytes: Optional[bytes] = None, check: bool = True) -> subprocess.CompletedProcess:
    rt = runtime()
    if rt["kind"] == "off":
        raise RuntimeError_(rt["error"])
    cmd = [*rt["base"], "docker", *args] if rt["kind"] == "wsl" else [*rt["base"], *args]
    p = subprocess.run(cmd, capture_output=True, timeout=timeout, input=input_bytes)
    if check and p.returncode != 0:
        raise RuntimeError_(f"docker {args[0]} failed: {(p.stderr or p.stdout).decode(errors='replace').strip()[-1500:]}")
    return p


def local_ref(slug: str, image: str, digest: str) -> str:
    return f"bluesandai.local/{slug}/{image}:sha256-{digest[7:]}"


def ensure_image(digest: str, m: dict, ref: str) -> str:
    """Load an image from the registry into the runtime (once); `ref` is its local name (local_ref)."""
    import container_registry as reg

    if docker("image", "inspect", ref, "--format", "{{.Id}}", check=False).returncode == 0:
        return ref
    tmp_dir = Path(reg.DIR) / "load"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=tmp_dir, suffix=".tar", delete=False) as f:
        dest = Path(f.name)
    try:
        reg.oci_layout(digest, m, ref, dest)
        docker("load", "-i", host_path(dest), timeout=1800)
    finally:
        dest.unlink(missing_ok=True)
    if docker("image", "inspect", ref, "--format", "{{.Id}}", check=False).returncode != 0:
        raise RuntimeError_(f"docker load did not produce {ref}")
    return ref


def info() -> dict:
    rt = runtime(refresh=True)
    out = {k: rt.get(k) for k in ("kind", "distro", "version", "error")}
    if rt["kind"] != "off":
        p = docker("ps", "--filter", "label=bluesandai.sidecar", "--format", "{{json .}}", check=False)
        out["sidecars"] = [json.loads(line) for line in p.stdout.decode(errors="replace").splitlines() if line.strip().startswith("{")]
    out["relay"] = relay_status()
    return out


# ------------------------------------------------------------------------------------------------
# the registry relay (docker push from WSL)
# ------------------------------------------------------------------------------------------------

WSL_RELAY = r'''
import socket, subprocess, sys, threading
host, _, port = sys.argv[1].rpartition(":")
port, bridge = int(port), sys.argv[2:]
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind((host or "127.0.0.1", port)); srv.listen(64)
print("relay listening", port, flush=True)
def pump_in(conn, p):
    try:
        while True:
            b = conn.recv(65536)
            if not b: break
            p.stdin.write(b); p.stdin.flush()
    except OSError: pass
    try: p.stdin.close()
    except OSError: pass
def serve(conn):
    p = subprocess.Popen(bridge, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    threading.Thread(target=pump_in, args=(conn, p), daemon=True).start()
    try:
        while True:
            b = p.stdout.read(65536)
            if not b: break
            conn.sendall(b)
    except OSError: pass
    finally:
        try: conn.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        conn.close(); p.kill()
while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
'''


def relay_status() -> dict:
    p = _state.get("relay")
    running = bool(p and p.poll() is None)
    return {"running": running, "port": RELAY_PORT, "address": f"127.0.0.1:{RELAY_PORT}" if running else None,
            "needed": runtime()["kind"] == "wsl"}


def relay_start() -> dict:
    """Start the WSL-side relay to the API (idempotent)."""
    rt = runtime()
    if rt["kind"] != "wsl":
        return relay_status()
    with _lock:
        p = _state.get("relay")
        if p and p.poll() is None:
            return relay_status()
        import container_registry

        script = Path(container_registry.DIR) / "wsl_relay.py"
        script.write_text(WSL_RELAY, "utf-8")
        # WSL translates the path of the Windows program it starts, not its arguments: the script keeps its Windows
        # path, with forward slashes (wsl.exe hands the arguments to a shell, which drops backslashes)
        bridge = [_wsl_path(sys.executable), (HERE / "registry_bridge.py").as_posix(), str(API_PORT)]
        # a relay left by an earlier API process holds the port: stop it first
        subprocess.run([*rt["base"], "pkill", "-f", f"wsl_relay.py.{RELAY_PORT}"], capture_output=True, timeout=30)
        _state["relay"] = subprocess.Popen([*rt["base"], "python3", _wsl_path(script), str(RELAY_PORT), *bridge],
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    line = _state["relay"].stdout.readline().decode(errors="replace")
    if "listening" not in line:
        return {**relay_status(), "error": line.strip() or "the relay did not start"}
    return relay_status()


def _wsl_path(p: Path | str) -> str:
    p = str(Path(p).resolve())
    return f"/mnt/{p[0].lower()}/" + p[3:].replace("\\", "/") if re.match(r"^[A-Za-z]:\\", p) else p


def relay_stop() -> None:
    p = _state.pop("relay", None)
    if p and p.poll() is None:
        p.kill()


CONTAINER_RELAY_PORT = int(os.environ.get("BLUESANDAI_CONTAINER_RELAY_PORT") or 5006)


def _bridge_gateway() -> str:
    """The docker bridge's gateway: the address containers reach the host (the WSL VM) on."""
    p = docker("network", "inspect", "bridge", check=False, timeout=60)
    try:
        return json.loads(p.stdout)[0]["IPAM"]["Config"][0]["Gateway"]
    except (ValueError, LookupError, TypeError):
        return "172.17.0.1"


def api_url_for_containers() -> tuple[str, list[str]]:
    """How code in a container reaches the API: (base URL, extra docker run arguments). Under WSL a second relay
    listens on the docker bridge's gateway and bridges each connection to the API, as the registry relay does
    (idempotent); with Docker on this machine, host.docker.internal."""
    rt = runtime()
    if rt["kind"] != "wsl":
        return f"http://host.docker.internal:{API_PORT}", ["--add-host", "host.docker.internal:host-gateway"]
    with _lock:
        p = _state.get("container_relay")
        if p and p.poll() is None:
            return _state["container_relay_url"], []
    gateway = _bridge_gateway()
    addr = f"{gateway}:{CONTAINER_RELAY_PORT}"
    with _lock:
        import container_registry

        script = Path(container_registry.DIR) / "wsl_relay.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(WSL_RELAY, "utf-8")
        bridge = [_wsl_path(sys.executable), (HERE / "registry_bridge.py").as_posix(), str(API_PORT)]
        subprocess.run([*rt["base"], "pkill", "-f", f"wsl_relay.py.{addr}"], capture_output=True, timeout=30)
        _state["container_relay"] = subprocess.Popen([*rt["base"], "python3", _wsl_path(script), addr, *bridge],
                                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    line = _state["container_relay"].stdout.readline().decode(errors="replace")
    if "listening" not in line:
        raise RuntimeError_(f"the relay for containers did not start: {line.strip()}")
    _state["container_relay_url"] = f"http://{addr}"
    return _state["container_relay_url"], []
