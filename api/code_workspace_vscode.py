"""Editors in containers for Code Workspaces: VS Code (code-server) and Node-RED, run on this machine and opened
inside the page.

A workspace of kind "vscode" or "nodered" (code_workspaces.py) runs its editor's image (ENGINES) in a container on the
container runtime (container_runtime.py: Docker on this machine or inside WSL), with the workspace's files
(code_workspace_lab.files_dir, the same folder JupyterLab workspaces keep) mounted in, and the editor's own state in a
Docker volume per workspace that outlives a stop:
- VS Code: files at /home/coder/project, settings and extensions in ~/.local; stops after `idle_minutes` without editor
  activity (code-server's /healthz heartbeat) and without an open connection.
- Node-RED (the official nodered/node-red image, github.com/node-red/node-red): its user directory /data — flows,
  credentials, settings and the nodes installed from the palette manager (node-red-contrib-* plugins from npm); the
  workspace's files at /data/files for the file nodes. Flows run continuously (IoT ingestion), so it is never stopped
  for idleness: only Stop (or deleting the workspace) stops it.
The editor listens on 127.0.0.1 only (a port of this machine; under WSL, WSL forwards it) with no login of its own: the
browser never reaches it directly.

The page opens /api/code-workspaces/<id>/<engine>/ (HTTP and websockets), which this API relays to the container after
the platform's own checks — signed in, Editor on the workspace, allowed to run code (Control Panel → Security → Code
execution) — so the editor's pages, assets and websockets (VS Code's terminal, Node-RED's comms and debug) run under the
platform's sign-in. The platform's cookies and tokens are not passed on to the container. Stop removes the container,
keeping the files and the volume; deleting the workspace removes both. Containers carry the label
bluesandai.sidecar=<engine>.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import subprocess
import threading
import time
import types
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, RedirectResponse, Response, StreamingResponse

import auth
import code_workspace_assist as assist
import code_workspaces as cw
import db

# per engine: image, the port it serves inside the container, where the workspace's files and the state volume go, the
# user the volume must belong to, its arguments, how it is checked, and the idle default (0: never stopped for idleness)
ENGINES: dict[str, dict[str, Any]] = {
    "vscode": {
        "label": "VS Code", "image": "codercom/code-server:4.96.4", "port": 8080, "files": "/home/coder/project",
        "state": "/home/coder/.local", "volume": "home", "uid": "1000:1000", "health": "/healthz", "idle": 30,
        "env": [], "limits": ["--cpus", "2", "--memory", "4g"],
        "args": ["--auth", "none", "--bind-addr", "0.0.0.0:8080", "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust",
                 "/home/coder/project"],
    },
    "nodered": {
        "label": "Node-RED", "image": "nodered/node-red:4.0.9", "port": 1880, "files": "/data/files",
        "state": "/data", "volume": "data", "uid": "1000:1000", "health": "/", "idle": 0,
        "env": ["-e", "TZ=Asia/Jakarta"], "limits": ["--cpus", "1", "--memory", "1g"], "args": [],
        # the image seeds a new volume with a sample flow warning to mount /data (it is mounted): start from an empty flow
        "prep": "if grep -q 'WARNING: please check you have started this container' /data/flows.json 2>/dev/null; then echo '[]' > /data/flows.json; fi",
    },
    # JupyterLab in a container, in the image a workspace names (rec["image"]: ML Studio builds one per training
    # environment, ml_audit_kit.dockerfile). It serves under the relay's own path (its base_url), so the relay keeps
    # that prefix ("upstream") instead of stripping it; no token of its own: the relay checks the platform's sign-in.
    "jupyterlab": {
        "label": "JupyterLab (Docker)", "image": "python:3.12-slim", "port": 8888, "files": "/home/audit/work",
        "state": "/root/.jupyter", "volume": "jupyter", "uid": "0:0", "health": "/api/code-workspaces/{wid}/jupyterlab/api/status", "idle": 30,
        "env": [], "limits": ["--cpus", "4", "--memory", "8g"], "upstream": "/api/code-workspaces/{wid}/jupyterlab",
        "args": ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser", "--allow-root", "--ServerApp.root_dir=/home/audit/work",
                 "--ServerApp.base_url=/api/code-workspaces/{wid}/jupyterlab/", "--IdentityProvider.token=", "--ServerApp.password=",
                 "--ServerApp.disable_check_xsrf=True", "--ServerApp.allow_remote_access=True"],
    },
}
# kept for callers of the VS Code module
IMAGE = ENGINES["vscode"]["image"]
IDLE_MINUTES = ENGINES["vscode"]["idle"]
PORTS = range(5150, 5250)
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host",
       "content-length", "cookie", "authorization", "origin", "referer"}

router = APIRouter(prefix="/api/code-workspaces/{wid}", tags=["code-workspaces"])
_lock = threading.RLock()
# workspace id -> {"keepalive": Popen, "active": open connections, "touched": monotonic time of the last request}
_live: dict[str, dict[str, Any]] = {}
_client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5.0), follow_redirects=False)
_monitor: Optional[threading.Thread] = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


PREFIX = os.environ.get("BLUESANDAI_CONTAINER_PREFIX") or "bsai"  # instance.env: AI JKN Audit beside the platform


def _name(wid: str, engine: str = "vscode") -> str:
    return f"{PREFIX}-{engine}-{wid}"


def _volume(wid: str, engine: str = "vscode") -> str:
    return f"{PREFIX}-{engine}-{wid}-{ENGINES[engine]['volume']}"


def _engine(rec: dict) -> str:
    kind = rec.get("kind")
    if kind not in ENGINES:
        raise HTTPException(400, "This workspace is a JupyterLab workspace")
    return kind


def _state(rec: dict) -> dict:
    return rec.get(_engine(rec)) or {"status": "stopped"}


def _check(rec: dict, engine: str) -> None:
    if rec.get("kind") != engine:
        raise HTTPException(400, f"This workspace is not a {ENGINES[engine]['label']} workspace")


def _free_port() -> int:
    used = {(r.get(r.get("kind") or "") or {}).get("port") for r in _all_records() if r.get("kind") in ENGINES}
    for p in PORTS:
        if p in used:
            continue
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                continue
        return p
    raise HTTPException(503, "No free port for another editor: stop a VS Code or Node-RED workspace first")


def _all_records() -> list[dict]:
    out = []
    for p in cw.DIR.glob("cws-*.json"):
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _health(port: int, engine: str = "vscode", wid: str = "") -> Optional[dict]:
    """The editor answers (VS Code: its /healthz heartbeat; Node-RED: its editor page; JupyterLab: its /api/status)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{ENGINES[engine]['health'].format(wid=wid)}", timeout=3) as r:
            body = r.read()
            return json.loads(body) if engine == "vscode" else {"status": r.status}
    except Exception:  # noqa: BLE001 - not up (yet)
        return None


def _healthz(port: int) -> Optional[dict]:
    return _health(port, "vscode")


def _keepalive(wid: str) -> None:
    """WSL shuts its VM down (and every container with it) when no wsl.exe process is attached: hold one."""
    import container_runtime as crt

    rt = crt.runtime()
    with _lock:
        live = _live.setdefault(wid, {"active": 0, "touched": time.monotonic()})
        if rt["kind"] == "wsl" and not (live.get("keepalive") and live["keepalive"].poll() is None):
            live["keepalive"] = subprocess.Popen([*rt["base"], "sleep", "infinity"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                 stderr=subprocess.DEVNULL)


def _release(wid: str) -> None:
    with _lock:
        live = _live.pop(wid, None)
    if live and live.get("keepalive") and live["keepalive"].poll() is None:
        live["keepalive"].terminate()


def touch(wid: str) -> None:
    with _lock:
        if wid in _live:
            _live[wid]["touched"] = time.monotonic()


# ------------------------------------------------------------------------------------------------
# start / stop
# ------------------------------------------------------------------------------------------------


def start(wid: str) -> dict:
    import container_runtime as crt
    import code_workspace_lab as lab

    auth.require_code_author()
    rec = cw._get(wid, "editor")
    engine = _engine(rec)
    e = ENGINES[engine]
    if not crt.available():
        raise HTTPException(503, f"{e['label']} needs a container runtime: {crt.runtime().get('error')}")
    st = _state(rec)
    if st.get("status") == "running" and st.get("port") and _health(st["port"], engine, wid):
        _keepalive(wid)
        return st
    image = rec.get("image") or e["image"]
    if engine == "jupyterlab" and rec.get("image_status") not in (None, "ready"):
        raise HTTPException(409, f"the workspace's image is {rec['image_status']}: " + (rec.get("image_error") or "wait for it to be built")[:600])
    files = lab.files_dir(wid)
    port = _free_port()
    _keepalive(wid)
    name, volume = _name(wid, engine), _volume(wid, engine)
    crt.docker("rm", "-f", name, check=False, timeout=60)
    # a new named volume belongs to root: the editor's user (1000) could not keep its state (extensions, flows, nodes)
    # (on stdin: wsl.exe passes arguments through a shell, which would split a script)
    prep = "\n".join([*([e["prep"]] if e.get("prep") else []), f"chown -R {e['uid']} {e['state']}", ""])
    crt.docker("run", "--rm", "-i", "--user", "0", "--entrypoint", "sh", "-v", f"{volume}:{e['state']}", image, "-s",
               input_bytes=prep.encode(), check=False, timeout=120)
    platform = _platform_args(wid) if engine == "nodered" else []
    try:
        crt.docker("run", "-d", "--name", name, "--label", f"bluesandai.sidecar={engine}", "--label", f"bluesandai.workspace={wid}",
                   "-p", f"127.0.0.1:{port}:{e['port']}", *e["limits"], *e["env"], *platform,
                   "-v", f"{volume}:{e['state']}", "-v", f"{crt.host_path(files)}:{e['files']}",
                   image, *[a.format(wid=wid) for a in e["args"]], timeout=300)
    except crt.RuntimeError_ as ex:
        _release(wid)
        raise HTTPException(502, f"{e['label']} did not start: {ex}") from None
    for _ in range(90):
        if _health(port, engine, wid):
            break
        time.sleep(1)
    else:
        logs = crt.docker("logs", "--tail", "20", name, check=False, timeout=30)
        crt.docker("rm", "-f", name, check=False, timeout=60)
        _release(wid)
        raise HTTPException(502, f"{e['label']} did not answer within 90 s: {(logs.stdout or b'').decode(errors='replace')[-600:]}")
    broker = _attach_broker(wid, name, port) if engine == "nodered" else None
    with cw._lock:
        rec = cw._read(wid)
        rec[engine] = {"status": "running", "port": port, "started_at": _now(), "started_by": cw._me(), "image": image,
                       **({"mqtt": broker} if broker else {})}
        cw._event(rec, f"{e['label']} started")
        cw._write(rec)
    touch(wid)
    _ensure_monitor()
    return rec[engine]


BROKER_NODE = "bluesandai-mqtt"


def _attach_broker(wid: str, container: str, port: int) -> Optional[str]:
    """The platform's MQTT broker for a Node-RED: started if needed, this container on its network, and a "BluesandAI
    MQTT" broker config node with the workspace's own login. The broker's address, or None when the broker is off."""
    import mqtt_broker

    try:
        if mqtt_broker.ensure() is None:
            return None
        mqtt_broker.connect(container)
        user, password = mqtt_broker.nodered_login(wid)
        base = f"http://127.0.0.1:{port}"
        head = {"Node-RED-API-Version": "v2"}
        with httpx.Client(timeout=30) as c:
            cur = c.get(f"{base}/flows", headers=head).json()
            flows = [n for n in cur.get("flows", []) if n.get("id") != BROKER_NODE]
            flows.append({"id": BROKER_NODE, "type": "mqtt-broker", "name": "BluesandAI MQTT", "broker": mqtt_broker.ALIAS, "port": "1883",
                          "clientid": "", "autoConnect": True, "usetls": False, "protocolVersion": "4", "keepalive": "60", "cleansession": True,
                          "credentials": {"user": user, "password": password}})
            c.post(f"{base}/flows", headers={**head, "Node-RED-Deployment-Type": "nodes"}, json={"flows": flows, "rev": cur.get("rev")})
        return f"mqtt://{mqtt_broker.ALIAS}:1883"
    except Exception:  # noqa: BLE001 - Node-RED runs without the broker
        import logging

        logging.getLogger(__name__).exception("MQTT broker not attached to %s", wid)
        return None


NODES_DIR = Path(__file__).resolve().parent / "nodered-nodes" / "bluesandai"


def _platform_args(wid: str) -> list[str]:
    """Node-RED's BluesandAI nodes (mounted read-only) and how they reach the platform: the API through the relay for
    containers, with a token that acts for the user starting Node-RED and reaches this workspace's
    /api/nodered-platform/ endpoints only (auth.middleware). A new token on every start; Stop revokes it."""
    import container_runtime as crt

    try:
        url, extra = crt.api_url_for_containers()
    except crt.RuntimeError_ as ex:
        raise HTTPException(502, f"Node-RED could not be connected to the platform: {ex}") from None
    token = auth.issue_job_token(seconds=365 * 86400, label=f"nodered:{wid}") or ""
    with cw._lock:
        rec = cw._read(wid)
        auth.revoke_job_token(rec.get("platform_token"))
        rec["platform_token"] = token or None
        cw._write(rec)
    return [*extra, "-e", f"BLUESANDAI_API={url}", "-e", f"BLUESANDAI_TOKEN={token}", "-e", f"BLUESANDAI_WORKSPACE={wid}",
            "-v", f"{crt.host_path(NODES_DIR)}:/data/nodes/bluesandai:ro"]


def stop(wid: str, why: str = "Stopped") -> dict:
    import container_runtime as crt

    rec = cw._read(wid)
    engine = _engine(rec)
    if crt.available():
        crt.docker("rm", "-f", _name(wid, engine), check=False, timeout=120)
    _release(wid)
    with cw._lock:
        rec = cw._read(wid)
        auth.revoke_job_token(rec.pop("platform_token", None))
        rec[engine] = {**(rec.get(engine) or {}), "status": "stopped", "port": None, "stopped_at": _now()}
        cw._event(rec, f"{ENGINES[engine]['label']} stopped: {why}")
        cw._write(rec)
    return rec[engine]


def remove(wid: str) -> None:
    """The workspace is deleted: its container and its volume go too (its files go to the Files trash)."""
    import container_runtime as crt

    rec = cw._read(wid)
    engine = rec.get("kind") if rec.get("kind") in ENGINES else "vscode"
    if crt.available():
        crt.docker("rm", "-f", _name(wid, engine), check=False, timeout=120)
        crt.docker("volume", "rm", "-f", _volume(wid, engine), check=False, timeout=60)
    auth.revoke_job_token(rec.get("platform_token"))
    if engine == "nodered":
        import mqtt_broker

        mqtt_broker.drop_nodered_login(wid)
    _release(wid)


def _status(wid: str, engine: str) -> dict:
    rec = cw._get(wid, "viewer")
    _check(rec, engine)
    st = rec.get(engine) or {"status": "stopped"}
    if st.get("status") == "running":
        h = _health(st["port"], engine, wid) if st.get("port") else None
        st = {**st, "reachable": bool(h), **({"heartbeat": (h or {}).get("lastHeartbeat")} if engine == "vscode" else {})}
    idle = rec.get("idle_minutes") if engine in ("vscode", "jupyterlab") else 0
    extra = {k: rec.get(k) for k in ("image", "image_status", "image_error") if rec.get(k)} if engine == "jupyterlab" else {}
    return {**st, **extra, "idle_minutes": idle if idle is not None else ENGINES[engine]["idle"], "can_run_code": auth.can_run_code()}


def _start_checked(wid: str, engine: str) -> dict:
    _check(cw._get(wid, "editor"), engine)
    return start(wid)


def _stop_checked(wid: str, engine: str) -> dict:
    _check(cw._get(wid, "editor"), engine)
    return stop(wid)


@router.post("/vscode-server/start")
def start_route(wid: str) -> dict:
    return _start_checked(wid, "vscode")


@router.post("/vscode-server/stop")
def stop_route(wid: str) -> dict:
    return _stop_checked(wid, "vscode")


@router.get("/vscode-server")
def status_route(wid: str) -> dict:
    return _status(wid, "vscode")


@router.post("/nodered-server/start")
def nodered_start_route(wid: str) -> dict:
    return _start_checked(wid, "nodered")


@router.post("/nodered-server/stop")
def nodered_stop_route(wid: str) -> dict:
    return _stop_checked(wid, "nodered")


@router.get("/nodered-server")
def nodered_status_route(wid: str) -> dict:
    return _status(wid, "nodered")


@router.post("/jupyterlab-server/start")
def jupyterlab_start_route(wid: str) -> dict:
    return _start_checked(wid, "jupyterlab")


@router.post("/jupyterlab-server/stop")
def jupyterlab_stop_route(wid: str) -> dict:
    return _stop_checked(wid, "jupyterlab")


@router.get("/jupyterlab-server")
def jupyterlab_status_route(wid: str) -> dict:
    return _status(wid, "jupyterlab")


# ------------------------------------------------------------------------------------------------
# idle stop (VS Code) and restart reconciliation
# ------------------------------------------------------------------------------------------------


def _idle_loop() -> None:
    while True:
        time.sleep(60)
        for rec in _all_records():
            engine = rec.get("kind")
            st = rec.get(engine or "") or {}
            if engine == "nodered" and st.get("status") == "running":
                # a Device stream's Node-RED stops when its pipeline goes to the trash
                item = db.drive_get(rec["item_id"]) if rec.get("pipeline_id") else None
                if rec.get("pipeline_id") and (item is None or item.get("trashed_at")):
                    try:
                        stop(rec["id"], "its pipeline was deleted")
                    except Exception:  # noqa: BLE001
                        pass
                continue
            # Node-RED's flows keep running: only VS Code and JupyterLab stop for idleness
            if engine not in ("vscode", "jupyterlab") or st.get("status") != "running":
                continue
            try:
                limit = 60 * int(rec.get("idle_minutes") or ENGINES[engine]["idle"])
                with _lock:
                    live = _live.get(rec["id"]) or {}
                    open_conns, touched = live.get("active", 0), live.get("touched", 0.0)
                h = _health(st["port"], engine, rec["id"]) if st.get("port") else None
                # VS Code: its heartbeat; JupyterLab: its last activity (a running cell counts as activity)
                beat = (h or {}).get("lastHeartbeat") or 0
                if engine == "jupyterlab" and (h or {}).get("last_activity"):
                    beat = datetime.fromisoformat(h["last_activity"].replace("Z", "+00:00")).timestamp() * 1000
                quiet = (time.time() - beat / 1000) if beat else limit + 1
                if open_conns == 0 and time.monotonic() - touched > limit and quiet > limit:
                    stop(rec["id"], f"idle for {limit // 60} min")
            except Exception:  # noqa: BLE001 - one workspace never stops the others' checks
                continue


def _ensure_monitor() -> None:
    global _monitor
    with _lock:
        if _monitor is None or not _monitor.is_alive():
            _monitor = threading.Thread(target=_idle_loop, daemon=True, name="editor-idle")
            _monitor.start()


def startup() -> None:
    """After an API restart: running containers are held again (keep-alive) and watched; vanished ones marked stopped."""
    import container_runtime as crt

    def run() -> None:
        try:
            if not crt.available():
                return
            for rec in _all_records():
                engine = rec.get("kind")
                st = rec.get(engine or "") or {}
                if engine not in ENGINES or st.get("status") != "running":
                    continue
                if st.get("port") and _health(st["port"], engine, rec["id"]):
                    _keepalive(rec["id"])
                    touch(rec["id"])
                else:
                    stop(rec["id"], "not running after a restart")
            _ensure_monitor()
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True, name="editor-startup").start()


# ------------------------------------------------------------------------------------------------
# the editor, relayed: HTTP and websockets under /api/code-workspaces/<id>/<engine>/
# ------------------------------------------------------------------------------------------------


def _target(wid: str, engine: str) -> int:
    rec = cw._get(wid, "editor")
    _check(rec, engine)
    st = rec.get(engine) or {}
    if st.get("status") != "running" or not st.get("port"):
        raise HTTPException(409, f"{ENGINES[engine]['label']} is not running: start it first")
    return st["port"]


# JupyterLab's pages (its HTML, which the assistant's bridge goes into): /lab, /lab/tree/…, /lab/workspaces/…, /doc/…, not its
# REST API (/lab/api/…) or its extensions' files (/lab/extensions/…)
_LAB_PAGE = re.compile(r"(?:lab|doc)(?:/(?!api/|extensions/).*)?")
THEME_DIR = Path(__file__).resolve().parent / "vendor" / "nodered-theme"
_theme_css: dict[str, str] = {}


def _dark_css() -> str:
    """The Node-RED editor's dark theme (vendor/nodered-theme: theme-collection's "dark", MIT)."""
    if "dark" not in _theme_css:
        _theme_css["dark"] = (THEME_DIR / "dark.min.css").read_text("utf-8")
    return _theme_css["dark"]


def _web_origins() -> list[str]:
    """The platform's web origins as CORS allows them (BLUESANDAI_WEB_ORIGINS, else this machine and its LAN addresses
    on port 8888): the pages that may frame JupyterLab and talk to the assistant's bridge in it."""
    import os

    raw = os.environ.get("BLUESANDAI_WEB_ORIGINS")
    origins = [o.strip().rstrip("/") for o in (raw or "http://localhost:8888,http://127.0.0.1:8888").split(",") if o.strip()]
    origins.append(auth.web_url().rstrip("/"))
    if not raw:
        origins.append("http://*:8888")
    return list(dict.fromkeys(origins))


def _framable(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """JupyterLab may be framed by the platform's web app only: its own `frame-ancestors 'self'` is the relay's origin
    (the API), not the page that embeds it."""
    ancestors = "frame-ancestors 'self' " + " ".join(_web_origins())
    out = []
    for k, v in headers:
        if k.lower() == "x-frame-options":
            continue
        if k.lower() == "content-security-policy":
            v = "; ".join([d.strip() for d in v.split(";") if d.strip() and not d.strip().lower().startswith("frame-ancestors")] + [ancestors])
        out.append((k, v))
    return out


async def _relay(wid: str, engine: str, path: str, request: Request):
    auth.require_code_author()
    port = await asyncio.to_thread(_target, wid, engine)
    touch(wid)
    # Node-RED follows the platform's theme: the page asks for its editor with ?theme=dark, and the editor page gets the
    # dark stylesheet (Node-RED's own editorTheme setting is per instance and needs a restart)
    dark = engine == "nodered" and path in ("", "index.html") and request.query_params.get("theme") == "dark"
    upstream = ENGINES[engine].get("upstream", "").format(wid=wid)
    url = f"http://127.0.0.1:{port}{upstream}/{path}" + (f"?{request.url.query}" if request.url.query else "")
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    headers["host"] = f"127.0.0.1:{port}"
    # JupyterLab's pages get the AI assistant's bridge (code_workspace_assist.with_bridge): read whole, uncompressed
    page = engine == "jupyterlab" and request.method == "GET" and _LAB_PAGE.fullmatch(path) is not None
    if page:
        headers["accept-encoding"] = "identity"
    if dark:
        headers["accept-encoding"] = "identity"
        try:
            resp = await _client.get(url, headers=headers)
        except httpx.ConnectError:
            return PlainTextResponse("Node-RED is not reachable: stop and start it again.", status_code=502)
        html = resp.text.replace("</head>", f"<style id=\"bluesandai-dark\">{_dark_css()}</style></head>", 1)
        keep = [(k, v) for k, v in resp.headers.multi_items() if k.lower() not in HOP | {"set-cookie", "content-encoding", "etag", "last-modified"}]
        r = Response(content=html.encode("utf-8"), status_code=resp.status_code)
        r.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in keep] + [(b"content-length", str(len(html.encode("utf-8"))).encode()),
                                                                                         (b"cache-control", b"no-store")]
        return r
    body = request.stream() if request.method not in ("GET", "HEAD", "OPTIONS") else None
    try:
        resp = await _client.send(_client.build_request(request.method, url, headers=headers, content=body), stream=True)
    except httpx.ConnectError:
        return PlainTextResponse(f"{ENGINES[engine]['label']} is not reachable: stop and start it again.", status_code=502)
    out = [(k, v) for k, v in resp.headers.multi_items() if k.lower() not in HOP | {"set-cookie"}]
    if engine == "jupyterlab":
        out = _framable(out)
    loc = resp.headers.get("location")
    if loc and loc.startswith("/") and not (upstream and loc.startswith(upstream)):
        # an absolute redirect inside the editor stays under the relay (JupyterLab's already is: its base_url)
        out = [(k, v) for k, v in out if k.lower() != "location"] + [("location", f"/api/code-workspaces/{wid}/{engine}{loc}")]
    if page and resp.headers.get("content-type", "").startswith("text/html"):
        try:
            html = (await resp.aread()).decode("utf-8", "replace")
        finally:
            await resp.aclose()
        data = assist.with_bridge(html, _web_origins()).encode("utf-8")
        keep = [(k, v) for k, v in out if k.lower() not in ("content-length", "content-encoding", "etag", "last-modified", "cache-control")]
        r = Response(content=data, status_code=resp.status_code)
        r.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in keep] + [(b"content-length", str(len(data)).encode()), (b"cache-control", b"no-store")]
        return r

    async def stream():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()

    r = StreamingResponse(stream(), status_code=resp.status_code)
    r.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out]
    return r


async def _relay_socket(ws: WebSocket, wid: str, engine: str, path: str) -> None:
    import code_workspace_terminals as terms

    # the HTTP middleware does not see websockets: the same checks as the terminals'
    if not terms._origin_ok(ws):
        await ws.close(code=4403)
        return
    principal = None
    if auth.enabled():
        conn = types.SimpleNamespace(headers=ws.headers, cookies=ws.cookies, state=types.SimpleNamespace(), method="GET", url=ws.url, client=ws.client)
        principal = auth._principal_for(conn)  # type: ignore[arg-type]
        if principal is None:
            await ws.close(code=4401)
            return
        if not auth.can_run_code(principal):
            await ws.close(code=4403)
            return
    token = auth._principal.set(principal)
    try:
        port = _target(wid, engine)
    except HTTPException:
        await ws.close(code=4404)
        return
    finally:
        auth._principal.reset(token)
    target = f"ws://127.0.0.1:{port}{ENGINES[engine].get('upstream', '').format(wid=wid)}/{path}" + (f"?{ws.url.query}" if ws.url.query else "")
    protocols = [p.strip() for p in ws.headers.get("sec-websocket-protocol", "").split(",") if p.strip()] or None
    try:
        # code-server compares Origin with Host: the relay speaks to the editor as its own origin
        up = await websockets.connect(target, origin=f"http://127.0.0.1:{port}", subprotocols=protocols, max_size=None, open_timeout=10)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        await ws.close(code=1011)
        return
    await ws.accept(subprotocol=up.subprotocol)
    with _lock:
        _live.setdefault(wid, {"active": 0, "touched": time.monotonic()})["active"] += 1

    async def to_up() -> None:
        try:
            while True:
                m = await ws.receive()
                if m["type"] == "websocket.disconnect":
                    break
                if m.get("bytes") is not None:
                    await up.send(m["bytes"])
                elif m.get("text") is not None:
                    await up.send(m["text"])
        except (WebSocketDisconnect, websockets.ConnectionClosed, RuntimeError):
            pass
        finally:
            await up.close()

    async def to_page() -> None:
        try:
            async for m in up:
                if isinstance(m, bytes):
                    await ws.send_bytes(m)
                else:
                    await ws.send_text(m)
        except (websockets.ConnectionClosed, RuntimeError):
            pass
        finally:
            try:
                await ws.close()
            except RuntimeError:
                pass

    try:
        await asyncio.gather(to_up(), to_page())
    finally:
        with _lock:
            if wid in _live:
                _live[wid]["active"] = max(0, _live[wid]["active"] - 1)
                _live[wid]["touched"] = time.monotonic()


@router.get("/vscode")
def editor_root(wid: str) -> RedirectResponse:
    # the editors' links are relative: they live under the trailing slash
    return RedirectResponse(f"/api/code-workspaces/{wid}/vscode/", status_code=307)


@router.get("/nodered")
def nodered_root(wid: str) -> RedirectResponse:
    return RedirectResponse(f"/api/code-workspaces/{wid}/nodered/", status_code=307)


@router.api_route("/vscode/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def editor(wid: str, path: str, request: Request):
    return await _relay(wid, "vscode", path, request)


@router.api_route("/nodered/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def nodered_editor(wid: str, path: str, request: Request):
    return await _relay(wid, "nodered", path, request)


@router.websocket("/vscode/{path:path}")
async def editor_socket(ws: WebSocket, wid: str, path: str) -> None:
    await _relay_socket(ws, wid, "vscode", path)


@router.websocket("/nodered/{path:path}")
async def nodered_socket(ws: WebSocket, wid: str, path: str) -> None:
    await _relay_socket(ws, wid, "nodered", path)


@router.get("/jupyterlab")
def jupyterlab_root(wid: str) -> RedirectResponse:
    return RedirectResponse(f"/api/code-workspaces/{wid}/jupyterlab/lab", status_code=307)


@router.api_route("/jupyterlab/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def jupyterlab_editor(wid: str, path: str, request: Request):
    return await _relay(wid, "jupyterlab", path, request)


@router.websocket("/jupyterlab/{path:path}")
async def jupyterlab_socket(ws: WebSocket, wid: str, path: str) -> None:
    await _relay_socket(ws, wid, "jupyterlab", path)
