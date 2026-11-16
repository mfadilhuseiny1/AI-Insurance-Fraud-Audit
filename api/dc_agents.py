"""Data Connection agents and agent proxy (palantir.com/docs/foundry/data-connection/set-up-agent, architecture).

An agent is a small program installed inside a customer network (the downloadable `bluesandai_agent.py`). It only
makes an outbound connection: a WebSocket to /api/dc-agents/connect, authenticated with the agent's token. An agent is
a resource saved in a Project (a `<name>.agent` Files item: the Project's roles govern who sees, manages and uses it).

Agent proxy (the recommended mode — Foundry worker with an agent proxy egress policy): an egress policy of kind
`agent_proxy` names a host (and its ports) reachable from the agent's network. Connections run here as usual; the host
name resolves to a loopback address of this server (network.py's resolver, like private links), where a listener per
port forwards every TCP connection through the agent's WebSocket to host:port, opened by the agent. The bytes are
relayed as they are, so TLS still verifies the original host name and no inbound path into the customer network is
needed. The agent reports its host, version and heartbeats (online when connected; last seen otherwise).

Agent worker (running syncs on the agent itself) is legacy and not implemented: sources run here (Foundry worker).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import queue
import secrets
import socket
import struct
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import db
import drive

log = logging.getLogger("bluesandai.dc_agents")
router = APIRouter(prefix="/api/dc-agents")
AGENT_TYPE = "application/vnd.bluesandai.dc-agent+json"
SCRIPT = Path(__file__).with_name("bluesandai_agent.py")
LOOPBACK_BASE = (127, 77)
OPEN_TIMEOUT_S = 20
_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


# ------------------------------------------------------------------------------------------------
# agent resources
# ------------------------------------------------------------------------------------------------


def _agents() -> list[tuple[dict, dict]]:
    items = db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND d.content_type = %s", (AGENT_TYPE,), limit=2000)
    out = []
    for it in items:
        try:
            out.append((it, json.loads(drive.read_bytes(it))))
        except Exception:  # noqa: BLE001
            continue
    return out


def _load(agent_id: str, need: str = "viewer") -> tuple[dict, dict]:
    item = drive._item(agent_id, need=need)
    if item.get("content_type") != AGENT_TYPE:
        raise HTTPException(404, "not an agent")
    return item, json.loads(drive.read_bytes(item))


def _write(item: dict, rec: dict) -> None:
    import pipeline_datasets

    pipeline_datasets._replace_content(item, json.dumps(rec, indent=1).encode(), AGENT_TYPE)


def _public(item: dict, rec: dict) -> dict:
    s = SESSIONS.get(item["id"])
    out = {k: v for k, v in rec.items() if k != "token_hash"}
    can_manage = True
    try:
        drive._item(item["id"], need="editor")
    except HTTPException:
        can_manage = False
    import network

    policies = [p for p in network._cache["policies"] if p["kind"] == "agent_proxy" and p.get("target") == item["id"]]
    return {**out, "id": item["id"], "name": item["name"].removesuffix(".agent"), "path": [p["name"] for p in db.drive_path(item["id"])[:-1]],
            "status": "online" if s else "offline", "connected_at": s.connected_at if s else None, "open_streams": len(s.streams) if s else 0,
            "can_manage": can_manage, "policies": [{"id": p["id"], "name": p["name"], "host": p["host"], "ports": p["ports"], "enabled": p["enabled"]} for p in policies]}


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    project_id: str


@router.post("")
def create(req: AgentIn) -> dict:
    proj = drive._item(req.project_id, need="editor")
    if proj["kind"] != "project":
        raise HTTPException(400, "save the agent in a Project")
    token = "bsai_agent_" + secrets.token_urlsafe(32)
    rec = {"version": 1, "token_hash": _sha(token), "created_at": _now(), "created_by": (auth.current() or {}).get("username") or "local",
           "last_seen": None, "host": None, "heartbeats": 0}
    data = json.dumps(rec, indent=1).encode()
    item = drive._store(proj["id"], drive._free_name(proj["id"], f"{req.name.strip()}.agent"), io.BytesIO(data), len(data), AGENT_TYPE)
    return {**_public(db.drive_get(item["id"]), rec), "token": token}


@router.get("")
def list_agents() -> list[dict]:
    out = []
    for item, rec in _agents():
        try:
            drive._item(item["id"], need="viewer")
        except HTTPException:
            continue
        out.append(_public(item, rec))
    return sorted(out, key=lambda a: a["name"].lower())


@router.get("/{agent_id}")
def get_agent(agent_id: str) -> dict:
    item, rec = _load(agent_id)
    return _public(item, rec)


@router.post("/{agent_id}/token")
def rotate_token(agent_id: str) -> dict:
    """A new token: the running agent is disconnected and must be restarted with it."""
    with _lock:
        item, rec = _load(agent_id, "editor")
        token = "bsai_agent_" + secrets.token_urlsafe(32)
        rec["token_hash"] = _sha(token)
        rec["token_rotated_at"] = _now()
        _write(item, rec)
    s = SESSIONS.get(agent_id)
    if s:
        s.close("the agent's token was rotated")
    return {**_public(item, rec), "token": token}


@router.get("/{agent_id}/download")
def download(agent_id: str) -> Response:
    """The agent program (Python 3.9+, `pip install websockets`)."""
    _load(agent_id, "editor")
    return Response(SCRIPT.read_bytes(), media_type="text/x-python", headers={"Content-Disposition": 'attachment; filename="bluesandai_agent.py"'})


def agent_for_use(agent_id: str) -> dict:
    """An agent an egress policy may use (the caller can see it)."""
    item, _ = _load(agent_id, "viewer")
    return item


# ------------------------------------------------------------------------------------------------
# the agent's WebSocket
# ------------------------------------------------------------------------------------------------


class Session:
    """A connected agent: its WebSocket on the server's event loop, and the TCP streams relayed through it."""

    def __init__(self, agent_id: str, ws: WebSocket, loop: asyncio.AbstractEventLoop) -> None:
        self.agent_id = agent_id
        self.ws = ws
        self.loop = loop
        self.connected_at = _now()
        self.streams: dict[int, "Stream"] = {}
        self.next_id = 1
        self.closed = False
        self.send_lock = asyncio.Lock()

    def send_json(self, msg: dict, timeout: float = 20) -> None:
        async def go() -> None:
            async with self.send_lock:
                await self.ws.send_text(json.dumps(msg))

        asyncio.run_coroutine_threadsafe(go(), self.loop).result(timeout)

    def send_data(self, sid: int, data: bytes, timeout: float = 60) -> None:
        async def go() -> None:
            async with self.send_lock:
                await self.ws.send_bytes(struct.pack(">I", sid) + data)

        asyncio.run_coroutine_threadsafe(go(), self.loop).result(timeout)

    def close(self, reason: str) -> None:
        self.closed = True
        for st in list(self.streams.values()):
            st.shutdown()
        try:
            asyncio.run_coroutine_threadsafe(self.ws.close(code=4001, reason=reason[:120]), self.loop)
        except Exception:  # noqa: BLE001
            pass


class Stream:
    """One TCP connection accepted here and relayed through the agent."""

    def __init__(self, session: Session, sid: int, sock: socket.socket) -> None:
        self.session, self.sid, self.sock = session, sid, sock
        self.opened = threading.Event()
        self.error: Optional[str] = None
        self.out: "queue.Queue[Optional[bytes]]" = queue.Queue()
        self.done = False

    def shutdown(self) -> None:
        if self.done:
            return
        self.done = True
        self.out.put(None)
        self.opened.set()
        try:
            self.sock.close()
        except OSError:
            pass
        self.session.streams.pop(self.sid, None)

    def finish(self) -> None:
        """The agent closed its side: send what is queued, then close."""
        self.out.put(None)

    def writer(self) -> None:
        while True:
            data = self.out.get()
            if data is None:
                self.shutdown()
                return
            try:
                self.sock.sendall(data)
            except OSError:
                self.shutdown()
                return

    def reader(self) -> None:
        try:
            while not self.done:
                data = self.sock.recv(65536)
                if not data:
                    break
                self.session.send_data(self.sid, data)
        except Exception:  # noqa: BLE001
            pass
        finally:
            if not self.done:
                try:
                    self.session.send_json({"op": "close", "stream": self.sid})
                except Exception:  # noqa: BLE001
                    pass
            self.shutdown()


SESSIONS: dict[str, Session] = {}


def _agent_by_token(token: str) -> Optional[tuple[dict, dict]]:
    h = _sha(token or "")
    for item, rec in _agents():
        if secrets.compare_digest(rec.get("token_hash") or "", h):
            return item, rec
    return None


@router.websocket("/connect")
async def connect(ws: WebSocket) -> None:
    header = ws.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ws.query_params.get("token", "")
    found = await asyncio.get_running_loop().run_in_executor(None, _agent_by_token, token)
    if not found:
        await ws.close(code=4003, reason="unknown agent token")
        return
    item, _ = found
    await ws.accept()
    old = SESSIONS.get(item["id"])
    if old:
        old.close("another process of this agent connected")
    session = Session(item["id"], ws, asyncio.get_running_loop())
    SESSIONS[item["id"]] = session
    log.info("agent %s connected", item["name"])
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                data = msg["bytes"]
                sid = struct.unpack(">I", data[:4])[0]
                st = session.streams.get(sid)
                if st:
                    st.out.put(data[4:])
                continue
            m = json.loads(msg.get("text") or "{}")
            op = m.get("op")
            if op in ("hello", "heartbeat"):
                await asyncio.get_running_loop().run_in_executor(None, _heartbeat, item["id"], m)
            elif op == "opened":
                st = session.streams.get(int(m["stream"]))
                if st:
                    st.opened.set()
            elif op == "error":
                st = session.streams.get(int(m["stream"]))
                if st:
                    st.error = m.get("error") or "the agent could not open the connection"
                    st.shutdown()
            elif op == "close":
                st = session.streams.get(int(m["stream"]))
                if st:
                    st.finish()
    except WebSocketDisconnect:
        pass
    finally:
        if SESSIONS.get(item["id"]) is session:
            SESSIONS.pop(item["id"], None)
        session.closed = True
        for st in list(session.streams.values()):
            st.shutdown()
        log.info("agent %s disconnected", item["name"])


def _heartbeat(agent_id: str, m: dict) -> None:
    with _lock:
        try:
            item = db.drive_get(agent_id)
            rec = json.loads(drive.read_bytes(item))
        except Exception:  # noqa: BLE001
            return
        rec["last_seen"] = _now()
        rec["heartbeats"] = int(rec.get("heartbeats") or 0) + 1
        if m.get("op") == "hello" or not rec.get("host"):
            rec["host"] = {k: m.get(k) for k in ("hostname", "os", "python", "agent_version", "allowlist") if k in m}
        if m.get("stats"):
            rec["stats"] = m["stats"]
        _write(item, rec)


# ------------------------------------------------------------------------------------------------
# tunnels: loopback listeners for agent proxy policies
# ------------------------------------------------------------------------------------------------


class Tunnel:
    def __init__(self, policy_id: str, agent_id: str, host: str, address: str, port: int) -> None:
        self.policy_id, self.agent_id, self.host, self.address, self.port = policy_id, agent_id, host, address, port
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind((address, port))
        self.sock.listen(64)
        self.stopped = False
        threading.Thread(target=self.accept_loop, name=f"agent-tunnel {host}:{port}", daemon=True).start()

    def accept_loop(self) -> None:
        while not self.stopped:
            try:
                client, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self.relay, args=(client,), daemon=True).start()

    def relay(self, client: socket.socket) -> None:
        s = SESSIONS.get(self.agent_id)
        if not s or s.closed:
            log.warning("agent proxy %s:%s: the agent is offline", self.host, self.port)
            client.close()
            return
        with _lock:
            sid = s.next_id
            s.next_id += 1
        st = Stream(s, sid, client)
        s.streams[sid] = st
        try:
            s.send_json({"op": "open", "stream": sid, "host": self.host, "port": self.port})
        except Exception:  # noqa: BLE001
            st.shutdown()
            return
        if not st.opened.wait(OPEN_TIMEOUT_S) or st.error or st.done:
            log.warning("agent proxy %s:%s: %s", self.host, self.port, st.error or "the agent did not open the connection")
            st.shutdown()
            return
        threading.Thread(target=st.writer, daemon=True).start()
        st.reader()

    def stop(self) -> None:
        self.stopped = True
        try:
            self.sock.close()
        except OSError:
            pass


TUNNELS: dict[tuple[str, int], Tunnel] = {}
ADDRESSES: dict[str, str] = {}  # host -> loopback address


def _address_for(host: str) -> str:
    if host not in ADDRESSES:
        n = len(ADDRESSES) + 1
        ADDRESSES[host] = f"{LOOPBACK_BASE[0]}.{LOOPBACK_BASE[1]}.{n // 250}.{n % 250 + 1}"
    return ADDRESSES[host]


def sync_tunnels(policies: list[dict]) -> dict[str, str]:
    """Listeners for the enabled agent proxy policies (others stopped): {host: loopback address} for routing."""
    wanted: dict[tuple[str, int], tuple[str, str, str]] = {}
    routes: dict[str, str] = {}
    for p in policies:
        if p.get("kind") != "agent_proxy" or not p.get("enabled") or not p.get("target"):
            continue
        host = p["host"].lower()
        addr = _address_for(host)
        routes[host] = addr
        for port in p.get("ports") or []:
            wanted[(addr, int(port))] = (p["id"], p["target"], host)
    with _lock:
        for key in [k for k in TUNNELS if k not in wanted or TUNNELS[k].agent_id != wanted[k][1]]:
            TUNNELS.pop(key).stop()
        for (addr, port), (pid, agent_id, host) in wanted.items():
            if (addr, port) not in TUNNELS:
                try:
                    TUNNELS[(addr, port)] = Tunnel(pid, agent_id, host, addr, port)
                except OSError as e:
                    log.warning("agent proxy listener %s:%s for %s: %s", addr, port, host, e)
    return routes


@router.get("/tools/tunnels")
def tunnels() -> list[dict]:
    return [{"host": t.host, "port": t.port, "address": t.address, "agent_id": t.agent_id, "agent_online": t.agent_id in SESSIONS} for t in TUNNELS.values()]

