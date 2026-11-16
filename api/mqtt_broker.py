"""The platform's MQTT broker: one Eclipse Mosquitto container (bsai-mosquitto, on the container runtime), internal to
this machine.

  * Node-RED workspaces reach it as mqtt://mqtt:1883 on the `bluesandai` docker network; each gets its own login and a
    ready "BluesandAI MQTT" broker config node (code_workspace_vscode.start).
  * This machine (Streaming syncs, local tools) reaches it on localhost:<mqtt port> and ws://localhost:<websocket port>.
    Nothing is published beyond this machine.
  * Every client signs in: credentials (username, password shown once, topic permissions) are managed on the MQTT Broker
    page and written to Mosquitto's password and ACL files; a change reloads the broker (SIGHUP), connections stay.
  * A monitor client (bsai-monitor) follows $SYS and every topic, for the page's clients, rates and live topics.

The broker starts with the first Node-RED that needs it (or from the page) and keeps running until stopped on the page.
Mounted by server.py under /api/mqtt-broker.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import code_workspaces as cw

IMAGE = "eclipse-mosquitto:2.0.20"
NAME = (os.environ.get("BLUESANDAI_CONTAINER_PREFIX") or "bsai") + "-mosquitto"  # instance.env: beside the platform
VOLUME = NAME + "-data"
NETWORK = "bluesandai"
ALIAS = "mqtt"
MONITOR_USER = "bsai-monitor"
DIR = cw.DIR.parent / "mqtt-broker"
CONF = DIR / "config"
STATE = DIR / "state.json"
CREDS = DIR / "credentials.json"
USERNAME = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")

router = APIRouter(prefix="/api/mqtt-broker", tags=["mqtt-broker"])
_lock = threading.RLock()
_live: dict[str, Any] = {"keepalive": None, "monitor": None}
_stats: dict[str, Any] = {}
_topics: dict[str, dict] = {}
MAX_TOPICS = 500
# when each device message (not $SYS) arrived, for "messages in the last minute"
_recent: "collections.deque[float]" = collections.deque(maxlen=100_000)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _save(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), "utf-8")
    tmp.replace(path)


def _state() -> dict:
    # enabled: the broker should run (it starts with the first Node-RED that needs it); off after Stop on the page
    return {"enabled": True, "status": "stopped", "ports": None, **_load(STATE, {})}


def _hash(password: str) -> str:
    """Mosquitto's password file format: PBKDF2-SHA512, 101 iterations ($7$)."""
    salt = secrets.token_bytes(12)
    dk = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, 101, 64)
    return f"$7${101}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def _creds() -> list[dict]:
    return _load(CREDS, [])


def _monitor_password() -> str:
    st = _load(STATE, {})
    if not st.get("monitor_password"):
        st["monitor_password"] = secrets.token_urlsafe(24)
        _save(STATE, st)
    return st["monitor_password"]


def _write_config() -> None:
    """mosquitto.conf, the password file and the ACL from the credentials (the monitor included)."""
    CONF.mkdir(parents=True, exist_ok=True)
    (CONF / "mosquitto.conf").write_text(
        "# written by BluesandAI (api/mqtt_broker.py): edits are replaced\n"
        "persistence true\npersistence_location /mosquitto/data/\nlog_dest stdout\nlog_type error\nlog_type warning\nlog_type notice\n"
        "allow_anonymous false\npassword_file /mosquitto/config/passwd\nacl_file /mosquitto/config/acl\n"
        "sys_interval 10\nmax_queued_messages 10000\n"
        "listener 1883\nlistener 9001\nprotocol websockets\n", "utf-8", newline="\n")
    creds = _creds()
    password = _monitor_password()
    st = _load(STATE, {})
    if not st.get("monitor_hash"):
        st["monitor_hash"] = _hash(password)
        _save(STATE, st)
    lines = [f"{MONITOR_USER}:{st['monitor_hash']}", *(f"{c['username']}:{c['hash']}" for c in creds)]
    (CONF / "passwd").write_text("\n".join(lines) + "\n", "utf-8", newline="\n")
    acl = [f"user {MONITOR_USER}", "topic readwrite #", "topic read $SYS/#", ""]
    for c in creds:
        acl.append(f"user {c['username']}")
        acl += [f"topic {t['access']} {t['pattern']}" for t in c["topics"]]
        acl.append("")
    (CONF / "acl").write_text("\n".join(acl), "utf-8", newline="\n")


# ------------------------------------------------------------------------------------------------
# the container
# ------------------------------------------------------------------------------------------------


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_ports() -> dict:
    out = {}
    for key, first in (("mqtt", 1883), ("ws", 9001)):
        out[key] = next(p for p in range(first, first + 50) if p not in out.values() and _port_free(p))
    return out


def _answers(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def running() -> bool:
    st = _state()
    return st.get("status") == "running" and bool(st.get("ports")) and _answers(st["ports"]["mqtt"])


def _ensure_network() -> None:
    import container_runtime as crt

    if crt.docker("network", "inspect", NETWORK, check=False, timeout=60).returncode != 0:
        crt.docker("network", "create", "--label", "bluesandai.sidecar=network", NETWORK, check=False, timeout=60)


def _keepalive() -> None:
    import container_runtime as crt

    rt = crt.runtime()
    p = _live.get("keepalive")
    if rt["kind"] == "wsl" and not (p and p.poll() is None):
        _live["keepalive"] = subprocess.Popen([*rt["base"], "sleep", "infinity"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL)


def start(by: Optional[str] = None) -> dict:
    """Start the broker (idempotent)."""
    import container_runtime as crt

    if not crt.available():
        raise HTTPException(503, f"The MQTT broker needs a container runtime: {crt.runtime().get('error')}")
    with _lock:
        if running():
            _keepalive()
            _ensure_monitor()
            return status_public()
        _write_config()
        _ensure_network()
        ports = _pick_ports()
        _keepalive()
        crt.docker("rm", "-f", NAME, check=False, timeout=60)
        try:
            crt.docker("run", "-d", "--name", NAME, "--label", "bluesandai.sidecar=mqtt", "--restart", "unless-stopped",
                       "--network", NETWORK, "--network-alias", ALIAS, "--memory", "256m", "--cpus", "1",
                       "-p", f"127.0.0.1:{ports['mqtt']}:1883", "-p", f"127.0.0.1:{ports['ws']}:9001",
                       "-v", f"{crt.host_path(CONF)}:/mosquitto/config", "-v", f"{VOLUME}:/mosquitto/data", IMAGE, timeout=300)
        except crt.RuntimeError_ as ex:
            raise HTTPException(502, f"The MQTT broker did not start: {ex}") from None
        for _ in range(30):
            if _answers(ports["mqtt"]):
                break
            time.sleep(1)
        else:
            logs = crt.docker("logs", "--tail", "20", NAME, check=False, timeout=30)
            raise HTTPException(502, f"The MQTT broker did not answer: {(logs.stdout or b'').decode(errors='replace')[-600:]}")
        st = _load(STATE, {})
        st.update({"enabled": True, "status": "running", "ports": ports, "started_at": _now(), "started_by": by or cw._me()})
        _save(STATE, st)
    _ensure_monitor()
    return status_public()


def stop() -> dict:
    import container_runtime as crt

    with _lock:
        if crt.available():
            crt.docker("rm", "-f", NAME, check=False, timeout=60)
        st = _load(STATE, {})
        st.update({"enabled": False, "status": "stopped", "stopped_at": _now()})
        _save(STATE, st)
        p = _live.get("keepalive")
        if p and p.poll() is None:
            p.terminate()
        _live["keepalive"] = None
    _stats.clear()
    return status_public()


def ensure() -> Optional[dict]:
    """For a Node-RED starting: the broker running unless it was stopped on the page. None when it is off."""
    if not _state().get("enabled", True):
        return None
    try:
        start()
    except HTTPException:
        return None
    return _state()


def reload() -> None:
    """Credentials changed: rewrite the files and let Mosquitto reread them (connections stay)."""
    import container_runtime as crt

    with _lock:
        _write_config()
        if running():
            crt.docker("kill", "-s", "HUP", NAME, check=False, timeout=30)


def connect(container: str) -> None:
    """Put a container on the broker's network (it then reaches mqtt://mqtt:1883)."""
    import container_runtime as crt

    _ensure_network()
    crt.docker("network", "connect", NETWORK, container, check=False, timeout=60)


def startup() -> None:
    """After an API restart: a running broker is held again (keep-alive) and watched."""
    def run() -> None:
        try:
            import container_runtime as crt

            st = _state()
            if st.get("status") != "running" or not crt.available():
                return
            if running():
                _keepalive()
                _ensure_monitor()
            elif st.get("enabled"):
                start(st.get("started_by"))
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True, name="mqtt-broker-startup").start()


# ------------------------------------------------------------------------------------------------
# the monitor: $SYS statistics and live topics
# ------------------------------------------------------------------------------------------------


def _ensure_monitor() -> None:
    m = _live.get("monitor")
    if m is not None and m.is_connected():
        return
    import paho.mqtt.client as mqtt

    st = _state()
    if not st.get("ports"):
        return
    if m is not None:
        try:
            m.loop_stop()
            m.disconnect()
        except Exception:  # noqa: BLE001
            pass
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"bsai-monitor-{uuid.uuid4().hex[:6]}")
    client.username_pw_set(MONITOR_USER, _monitor_password())

    def on_connect(c: Any, userdata: Any, flags: Any, reason: Any, props: Any) -> None:
        if not reason.is_failure:
            c.subscribe([("#", 0), ("$SYS/broker/#", 0)])

    def on_message(c: Any, userdata: Any, msg: Any) -> None:
        text = msg.payload[:300].decode("utf-8", "replace")
        if msg.topic.startswith("$SYS/"):
            _stats[msg.topic[len("$SYS/broker/"):]] = text
            return
        _recent.append(time.monotonic())
        t = _topics.get(msg.topic)
        if t is None:
            if len(_topics) >= MAX_TOPICS:
                oldest = min(_topics, key=lambda k: _topics[k]["last_at"])
                _topics.pop(oldest, None)
            t = _topics[msg.topic] = {"topic": msg.topic, "count": 0, "bytes": 0}
        t["count"] += 1
        t["bytes"] += len(msg.payload)
        t["last_at"] = _now()
        t["last"] = text
        t["retained"] = bool(msg.retain)

    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect("127.0.0.1", st["ports"]["mqtt"], keepalive=30)
        client.loop_start()
        _live["monitor"] = client
    except OSError:
        _live["monitor"] = None


# ------------------------------------------------------------------------------------------------
# credentials
# ------------------------------------------------------------------------------------------------


def _public_cred(c: dict) -> dict:
    return {k: v for k, v in c.items() if k != "hash"}


def nodered_login(wid: str) -> tuple[str, str]:
    """A Node-RED workspace's broker login (created once; its password kept in the workspace record)."""
    username = f"nodered-{wid}"
    with cw._lock:
        rec = cw._read(wid)
        password = rec.get("mqtt_password")
        if not password:
            password = rec["mqtt_password"] = secrets.token_urlsafe(18)
            cw._write(rec)
    with _lock:
        creds = [c for c in _creds() if c["username"] != username]
        creds.append({"id": f"mqc-{uuid.uuid4().hex[:10]}", "username": username, "hash": _hash(password), "kind": "nodered", "workspace": wid,
                      "topics": [{"pattern": "#", "access": "readwrite"}], "owner": rec.get("created_by"), "created_at": _now(),
                      "label": f"Node-RED · {rec.get('name') or wid}"})
        _save(CREDS, creds)
    reload()
    return username, password


def drop_nodered_login(wid: str) -> None:
    with _lock:
        creds = _creds()
        kept = [c for c in creds if c.get("workspace") != wid]
        if len(kept) != len(creds):
            _save(CREDS, kept)
            reload()


class TopicIn(BaseModel):
    pattern: str = Field(min_length=1, max_length=200)
    access: Literal["read", "write", "readwrite"] = "readwrite"


class CredentialIn(BaseModel):
    username: str
    label: str = Field("", max_length=120)
    topics: list[TopicIn] = Field(min_length=1, max_length=50)


def _can_manage() -> bool:
    p = auth.current()
    return not auth.enabled() or bool(p and (p.get("role") == "admin" or p.get("service")))


@router.get("")
def get_status() -> dict:
    out = status_public()
    p = auth.current() or {}
    mine = p.get("id")
    out["credentials"] = [_public_cred(c) for c in _creds() if _can_manage() or c.get("owner") == mine]
    out["can_manage"] = _can_manage()
    out["can_create"] = auth.can_run_code()
    return out


def status_public() -> dict:
    st = _state()
    up = running()
    ports = st.get("ports") or {}
    stats = {k: _stats.get(k) for k in ("clients/connected", "clients/total", "messages/received", "messages/sent", "load/messages/received/1min",
                                        "load/messages/sent/1min", "subscriptions/count", "retained messages/count", "uptime", "version")} if up else {}
    topics = sorted(_topics.values(), key=lambda t: t.get("last_at") or "", reverse=True)[:100] if up else []
    # in plain numbers: the platform's own monitor and the broker's $SYS topics left out
    cutoff = time.monotonic() - 60
    try:
        clients = max(0, int(_stats.get("clients/connected") or 0) - 1)
    except ValueError:
        clients = None
    m = re.match(r"(\d+)", str(_stats.get("uptime") or ""))
    summary = {"clients": clients, "messages_last_minute": sum(1 for t in _recent if t >= cutoff), "topics": len(_topics),
               "uptime_seconds": int(m.group(1)) if m else None} if up else {}
    return {
        "status": "running" if up else "stopped",
        "enabled": st.get("enabled", True),
        "image": IMAGE,
        "started_at": st.get("started_at"),
        "ports": ports or None,
        "addresses": {
            "node_red": "mqtt://mqtt:1883",
            "this_machine": f"mqtt://localhost:{ports['mqtt']}" if ports else None,
            "websocket": f"ws://localhost:{ports['ws']}" if ports else None,
        },
        "stats": stats,
        "summary": summary,
        "topics": topics,
    }


@router.post("/start")
def start_route() -> dict:
    auth.require_admin()
    return start()


@router.post("/stop")
def stop_route() -> dict:
    auth.require_admin()
    return stop()


@router.post("/credentials")
def create_credential(req: CredentialIn) -> dict:
    """A login for devices or tools: the password is shown once."""
    auth.require_code_author()
    name = req.username.strip()
    if not USERNAME.match(name):
        raise HTTPException(400, "A username is 3–64 letters, digits, dots, dashes or underscores")
    if name == MONITOR_USER or name.startswith(("nodered-", "bsai-")):
        raise HTTPException(400, "Usernames starting with nodered- or bsai- are the platform's")
    for t in req.topics:
        if any(ch in t.pattern for ch in "\n\r") or ("#" in t.pattern and not t.pattern.endswith("#")):
            raise HTTPException(400, f'"{t.pattern}" is not a topic pattern (# only at the end)')
    password = secrets.token_urlsafe(18)
    p = auth.current() or {}
    with _lock:
        creds = _creds()
        if any(c["username"].lower() == name.lower() for c in creds):
            raise HTTPException(409, f'There is already a login "{name}"')
        cred = {"id": f"mqc-{uuid.uuid4().hex[:10]}", "username": name, "hash": _hash(password), "kind": "user", "label": req.label.strip(),
                "topics": [t.model_dump() for t in req.topics], "owner": p.get("id"), "owner_name": p.get("display_name") or p.get("username"),
                "created_at": _now()}
        creds.append(cred)
        _save(CREDS, creds)
    reload()
    return {**_public_cred(cred), "password": password}


@router.delete("/credentials/{cid}")
def delete_credential(cid: str) -> dict:
    p = auth.current() or {}
    with _lock:
        creds = _creds()
        c = next((x for x in creds if x["id"] == cid), None)
        if c is None:
            raise HTTPException(404, "No such login")
        if c.get("kind") == "nodered":
            raise HTTPException(400, "This is a Node-RED workspace's login: it goes when the workspace is deleted")
        if not (_can_manage() or c.get("owner") == p.get("id")):
            raise HTTPException(403, "Only its owner or an administrator can delete this login")
        _save(CREDS, [x for x in creds if x["id"] != cid])
    reload()
    return {"deleted": cid}


class PublishIn(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    payload: str = Field("", max_length=100_000)
    retain: bool = False


@router.post("/publish")
def publish(req: PublishIn) -> dict:
    """A test message from the page."""
    auth.require_code_author()
    if any(ch in req.topic for ch in "+#") or req.topic.startswith("$"):
        raise HTTPException(400, "Publish to a topic without wildcards")
    if not running():
        raise HTTPException(409, "Start the broker first")
    _ensure_monitor()
    m = _live.get("monitor")
    if m is None:
        raise HTTPException(502, "The broker's monitor is not connected")
    info = m.publish(req.topic, req.payload.encode(), qos=1, retain=req.retain)
    info.wait_for_publish(timeout=5)
    return {"published": info.is_published()}
