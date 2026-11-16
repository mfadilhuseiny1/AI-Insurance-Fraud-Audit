"""Running a container-backed model version (model_assets.py) in this process.

`ContainerModel(spec)` is what a transform gets for `ModelInput("ri.models.main.model.<id>", "<version rid>")` and
what `python model_container.py spec.json out.json` (the model page's test runs) uses: on first use it starts every
image of the version as a container (sidecar_slot.py: the image's ports published on localhost, a shared empty
volume at /opt/palantir/sidecars/shared-volumes/shared, both redirected in this process), loads the adapter class
from its source, and calls `init_container(ContainerizedApplicationContext)`. The containers stop when the process
exits (or on close()), their logs kept in `logs`.

The palantir_models adapter API itself is model_lib.py (installed by code_models.install).
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import traceback
import types
from typing import Any, Optional

SHARED = "/opt/palantir/sidecars/shared-volumes/shared"
# the models started in this process (stop_all at the end of a build)
LIVE: list["ContainerModel"] = []


# palantir_models: the model adapter API lives in model_lib.py (shared with models trained here)
from model_lib import ContainerizedApplicationContext  # noqa: E402


def install(pm: types.ModuleType) -> None:
    import model_lib

    model_lib.install(pm)


# ------------------------------------------------------------------------------------------------
# a running model version
# ------------------------------------------------------------------------------------------------


class ContainerModel:
    """A container-backed model version: its containers start on first use; attributes come from the adapter."""

    def __init__(self, spec: dict) -> None:
        self.spec = spec
        self.logs = ""
        self._adapter = None
        self._slots: list[tuple[dict, dict]] = []
        self._keep: Optional[subprocess.Popen] = None

    def __repr__(self) -> str:
        return f"<ContainerModel {self.spec.get('model')} {self.spec.get('version')}>"

    def _start(self):
        if self._adapter is not None:
            return self._adapter
        import sidecar_slot

        atexit.register(self.close)
        LIVE.append(self)
        if self.spec.get("keepalive"):
            # WSL stops its VM (and the containers) when no wsl.exe process is attached
            self._keep = subprocess.Popen(self.spec["keepalive"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # a process that is killed cannot stop it: remove_leftovers finds it here
            for d in {c.get("base_dir") for c in self.spec["containers"] if c.get("base_dir")}:
                try:
                    with open(os.path.join(d, f"keepalive-{os.getpid()}.pid"), "w", encoding="utf-8") as f:
                        f.write(str(self._keep.pid))
                except OSError:
                    pass
        for c in self.spec["containers"]:
            self._slots.append((c, sidecar_slot.start(c, "model")))
        services = {c["name"]: [f"localhost:{p}" for p in c.get("ports") or []] for c, _ in self._slots}
        ctx = ContainerizedApplicationContext(services, SHARED)
        a = self.spec["adapter"]
        mod = types.ModuleType("bluesandai_model_adapter")
        mod.__file__ = a["file"]
        sys.modules[mod.__name__] = mod
        exec(compile(a["source"], a["file"], "exec"), mod.__dict__)
        cls = getattr(mod, a["class"], None)
        if cls is None:
            raise RuntimeError(f"no class {a['class']} in {a['file']}")
        self._adapter = cls.init_container(ctx) if "init_container" in vars(cls) or not hasattr(cls, "load") else cls.load()
        return self._adapter

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") or name in ("spec", "logs"):
            raise AttributeError(name)
        import model_telemetry

        # a transform's model: its inference calls are recorded (model_telemetry.trace_model)
        return model_telemetry.wrap_method(self, name, getattr(self._start(), name))

    def close(self) -> str:
        import sidecar_slot

        parts = []
        while self._slots:
            c, slot = self._slots.pop()
            parts.append(f"--- container {c['image']} ---\n{sidecar_slot.stop(c, slot)}")
        if self._keep:
            self._keep.kill()
            self._keep = None
        if parts:
            self.logs = "\n".join(reversed(parts))
        return self.logs


def stop_all() -> str:
    """Stop every model started here; their containers' logs."""
    parts = []
    while LIVE:
        m = LIVE.pop()
        try:
            text = m.close()
        except Exception as e:  # noqa: BLE001
            text = f"the containers did not stop cleanly: {e}"
        parts.append(f"=== model {m.spec.get('model')} {m.spec.get('version')} containers ===\n{text}")
    return "\n".join(parts)


# ------------------------------------------------------------------------------------------------
# the containers of a spec, seen from outside the process that started them (live deployments)
# ------------------------------------------------------------------------------------------------


def _labels(spec: dict) -> list[tuple[list[str], str]]:
    """(docker command, bluesandai.run label) per distinct label of the spec's containers."""
    seen, out = set(), []
    for c in spec.get("containers") or []:
        if c.get("label") and c["label"] not in seen:
            seen.add(c["label"])
            out.append((list(c["docker"]), c["label"]))
    return out


def _run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout)


def container_states(spec: dict) -> list[dict]:
    """The containers a spec's process started (found by their bluesandai.run label): name, image, state, restart
    count, published ports and whether each answers ("ready")."""
    import sidecar_slot

    out = []
    for docker, label in _labels(spec):
        ids = _run([*docker, "ps", "-aq", "--filter", f"label=bluesandai.run={label}"]).stdout.decode(errors="replace").split()
        if not ids:
            continue
        p = _run([*docker, "inspect", *ids])
        try:
            rows = json.loads(p.stdout.decode(errors="replace") or "[]")
        except ValueError:
            rows = []
        for r in rows:
            state = r.get("State") or {}
            ports = {}
            for k, binds in ((r.get("NetworkSettings") or {}).get("Ports") or {}).items():
                for b in binds or []:
                    if b.get("HostPort"):
                        ports[k.split("/")[0]] = int(b["HostPort"])
            running = bool(state.get("Running"))
            answering = {k: sidecar_slot._ready(hp) for k, hp in ports.items()} if running else {k: False for k in ports}
            out.append({"name": (r.get("Name") or "").lstrip("/"), "image": next((c.get("image") for c in spec["containers"] if c["ref"] == (r.get("Config") or {}).get("Image")),
                                                                                  (r.get("Config") or {}).get("Image")),
                        "state": state.get("Status"), "running": running, "exit_code": state.get("ExitCode"), "started_at": state.get("StartedAt"),
                        "restarts": int(r.get("RestartCount") or 0), "ports": ports, "answering": answering,
                        # the limits docker applies (--cpus, --memory): None when unlimited
                        "cpus": round(int((r.get("HostConfig") or {}).get("NanoCpus") or 0) / 1e9, 3) or None,
                        "memory_bytes": int((r.get("HostConfig") or {}).get("Memory") or 0) or None,
                        "labels": {k: v for k, v in ((r.get("Config") or {}).get("Labels") or {}).items() if k.startswith("bluesandai.")},
                        "ready": running and all(answering.values())})
    return out


def container_logs(spec: dict, name: str, since: Optional[float] = None) -> str:
    """A container's stdout / stderr (with timestamps), since a Unix time."""
    for docker, _ in _labels(spec)[:1]:
        p = _run([*docker, "logs", "--timestamps", *(["--since", str(int(since))] if since else []), name])
        return (p.stdout + p.stderr).decode(errors="replace")
    return ""


def remove_leftovers(spec: dict) -> int:
    """Remove every container a spec's process started that is still there (the process was killed before it stopped
    them) and the spec's shared folders; how many containers were removed."""
    import shutil

    n = 0
    for docker, label in _labels(spec):
        try:
            ids = _run([*docker, "ps", "-aq", "--filter", f"label=bluesandai.run={label}"]).stdout.decode(errors="replace").split()
            if ids:
                _run([*docker, "rm", "-f", *ids], timeout=120)
                n += len(ids)
        except (OSError, subprocess.TimeoutExpired):
            pass
    for d in {c.get("base_dir") for c in spec.get("containers") or [] if c.get("base_dir")}:
        _kill_keepalives(d)
        shutil.rmtree(d, ignore_errors=True)
    return n


def _kill_keepalives(base_dir: str) -> None:
    """The keepalive processes (`wsl.exe -- sleep infinity`) a killed model process left behind."""
    import glob

    for pf in glob.glob(os.path.join(base_dir, "keepalive-*.pid")):
        try:
            with open(pf, encoding="utf-8") as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            continue
        try:
            import psutil

            p = psutil.Process(pid)
            if "sleep" not in " ".join(p.cmdline()):  # the pid was reused by another program
                continue
            for ch in p.children(recursive=True):
                ch.kill()
            p.kill()
        except Exception:  # noqa: BLE001 - gone already (it stopped with its model process)
            pass


def _json(v: Any) -> Any:
    if hasattr(v, "to_dict") and hasattr(v, "columns"):
        return json.loads(v.to_json(orient="records", date_format="iso"))
    return v


def main(spec_path: str, out_path: str) -> None:
    import code_models

    code_models.install()
    job = json.loads(open(spec_path, encoding="utf-8").read())
    model = ContainerModel(job["model"])
    res: dict = {}
    try:
        out = model.transform(**job.get("inputs") or {})
        res = {"ok": True, "outputs": {k: _json(v) for k, v in out.items()}}
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exception(type(e), e, e.__traceback__)
        res = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": "".join(tb[-6:])}
    finally:
        res["logs"] = model.close()[-20000:]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(res, f, default=str)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
