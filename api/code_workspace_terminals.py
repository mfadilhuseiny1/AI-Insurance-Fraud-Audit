"""Terminals of a Jupyter Code Workspace (JupyterLab's Terminal, in the Launcher).

A terminal runs where the workspace's notebooks can run:
- "local": a shell on this API's machine (PowerShell through ConPTY on Windows / pywinpty, bash through a pty on
  Linux), in the workspace's files folder, with the environment of a Local CPU kernel (only the OS variables Python
  needs, the workspace's packages and platform client on PYTHONPATH, the API's Python and uv on PATH);
- "cloud": a terminal of the workspace's machine (Compute Engine or RunPod), made through its Jupyter Server
  (/api/terminals) and relayed from here, so the page never holds the machine's token.

The page speaks terminado's protocol over a websocket, as JupyterLab does: ["stdin", text], ["set_size", rows, cols]
in, ["stdout", text] out. A terminal lives until it is shut down (closing its tab keeps it, as in JupyterLab); its last
output is replayed when a tab attaches again. The websocket is authenticated like the API (session cookie or token,
editor of the workspace) and only accepted from the platform's own pages (Origin).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import threading
import time
import types
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import auth
import code_workspaces as cw

router = APIRouter(prefix="/api/code-workspaces/{wid}/lab", tags=["code-workspaces"])
SCROLLBACK = 64 * 1024
_terms: dict[str, "Terminal"] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Terminal:
    def __init__(self, wid: str, target: str) -> None:
        self.id = "t-" + uuid.uuid4().hex[:10]
        self.wid, self.target = wid, target
        self.created_at = _now()
        self.last_activity = time.time()
        self.buffer = ""
        self.listeners: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self.closed = False

    def emit(self, text: str) -> None:
        self.last_activity = time.time()
        self.buffer = (self.buffer + text)[-SCROLLBACK:]
        for loop, q in list(self.listeners):
            loop.call_soon_threadsafe(q.put_nowait, text)

    def public(self) -> dict:
        return {"id": self.id, "target": self.target, "created_at": self.created_at, "name": self.id}

    def write(self, text: str) -> None:
        raise NotImplementedError

    def resize(self, rows: int, cols: int) -> None:
        pass

    def close(self) -> None:
        self.closed = True


def _local_env(wid: str) -> dict[str, str]:
    import code_workspace_env as envmod
    import code_workspace_lab as lab

    env = {k: v for k, v in os.environ.items() if k.upper() in lab._ENV_KEEP}
    scripts = os.path.dirname(sys.executable)
    uv = shutil.which("uv")
    env["PATH"] = os.pathsep.join([scripts, *( [os.path.dirname(uv)] if uv else []), env.get("PATH", "")])
    env.update({"PYTHONPATH": os.pathsep.join([str(envmod.packages_dir(wid)), str(lab._client_dir(wid).resolve())]), "PYTHONIOENCODING": "utf-8",
                "BLUESANDAI_WORKSPACE_ID": wid, "BLUESANDAI_PACKAGES": str(envmod.packages_dir(wid)), "TERM": "xterm-256color"})
    return env


class LocalTerminal(Terminal):
    def __init__(self, wid: str) -> None:
        super().__init__(wid, "local")
        import code_workspace_lab as lab

        cwd = str(lab.files_dir(wid).resolve())
        env = _local_env(wid)
        if os.name == "nt":
            from winpty import PtyProcess

            shell = shutil.which("powershell.exe") or "cmd.exe"
            args = [shell, "-NoLogo"] if "powershell" in shell.lower() else [shell]
            self.proc = PtyProcess.spawn(args, cwd=cwd, env=env, dimensions=(30, 120))
            self._read = lambda: self.proc.read(4096)
            self._alive = self.proc.isalive
        else:
            import pty
            import subprocess

            master, slave = pty.openpty()
            self.proc = subprocess.Popen([shutil.which("bash") or "/bin/sh", "-i"], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                                         start_new_session=True, close_fds=True)
            os.close(slave)
            self.master = master
            self._read = lambda: os.read(master, 4096).decode("utf-8", "replace")
            self._alive = lambda: self.proc.poll() is None
        threading.Thread(target=self._pump, daemon=True, name=f"terminal-{self.id}").start()

    def _pump(self) -> None:
        while not self.closed:
            try:
                data = self._read()
            except (EOFError, OSError):
                break
            if data:
                self.emit(data)
            elif not self._alive():
                break
        self.closed = True
        self.emit("\r\n[the terminal's shell exited]\r\n")

    def write(self, text: str) -> None:
        if os.name == "nt":
            self.proc.write(text)
        else:
            os.write(self.master, text.encode("utf-8"))

    def resize(self, rows: int, cols: int) -> None:
        try:
            if os.name == "nt":
                self.proc.setwinsize(rows, cols)
            else:
                import fcntl
                import struct
                import termios

                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        self.closed = True
        try:
            if os.name == "nt":
                self.proc.terminate(force=True)
            else:
                self.proc.kill()
        except Exception:  # noqa: BLE001
            pass


class RemoteTerminal(Terminal):
    """A terminal of the workspace's machine, relayed between the page and its Jupyter Server."""

    def __init__(self, wid: str, rec: dict) -> None:
        super().__init__(wid, "cloud")
        import code_workspace_lab as lab

        self.m = lab._pod_jupyter(rec)
        self.name = lab._pod_call(self.m, "POST", "/api/terminals", {"cwd": "workspace"})["name"]
        from websockets.sync.client import connect

        base, token, ctx = self.m
        url = base.replace("https://", "wss://") + f"/terminals/websocket/{urllib.parse.quote(self.name)}"
        self.ws = connect(url, additional_headers={"Authorization": f"token {token}"}, max_size=None, open_timeout=60, **({"ssl": ctx} if ctx else {}))
        self._send_lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True, name=f"terminal-{self.id}").start()

    def _pump(self) -> None:
        try:
            for raw in self.ws:
                msg = json.loads(raw)
                if msg and msg[0] == "stdout":
                    self.emit(msg[1])
                elif msg and msg[0] == "disconnect":
                    break
        except Exception:  # noqa: BLE001
            pass
        self.closed = True
        self.emit("\r\n[the machine's terminal closed]\r\n")

    def _send(self, msg: list) -> None:
        with self._send_lock:
            self.ws.send(json.dumps(msg))

    def write(self, text: str) -> None:
        self._send(["stdin", text])

    def resize(self, rows: int, cols: int) -> None:
        try:
            self._send(["set_size", rows, cols])
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        self.closed = True
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            import code_workspace_lab as lab

            lab._pod_call(self.m, "DELETE", f"/api/terminals/{urllib.parse.quote(self.name)}")
        except HTTPException:
            pass


def _term(wid: str, tid: str) -> Terminal:
    t = _terms.get(tid)
    if not t or t.wid != wid:
        raise HTTPException(404, "this terminal is gone")
    return t


@router.get("/terminals")
def list_terminals(wid: str) -> list[dict]:
    cw._get(wid)
    return [t.public() for t in _terms.values() if t.wid == wid and not t.closed]


class TerminalIn(BaseModel):
    target: Literal["local", "cloud"] = "local"


@router.post("/terminals")
def new_terminal(wid: str, req: TerminalIn) -> dict:
    rec = cw._get(wid, "editor")
    try:
        t: Terminal = LocalTerminal(wid) if req.target == "local" else RemoteTerminal(wid, cw._refresh(rec))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"the terminal did not start: {e}") from None
    with _lock:
        _terms[t.id] = t
    return t.public()


@router.delete("/terminals/{tid}")
def shutdown_terminal(wid: str, tid: str) -> dict:
    cw._get(wid, "editor")
    t = _term(wid, tid)
    t.close()
    _terms.pop(tid, None)
    return {"shutdown": tid}


def shutdown_workspace(wid: str, target: Optional[str] = None) -> None:
    for t in list(_terms.values()):
        if t.wid == wid and (target is None or t.target == target):
            t.close()
            _terms.pop(t.id, None)


def _origin_ok(ws: WebSocket) -> bool:
    """Only the platform's own pages (cross-site websocket hijacking: cookies would ride along otherwise)."""
    origin = ws.headers.get("origin")
    if not origin:
        return True  # not a browser
    host = (urllib.parse.urlparse(origin).hostname or "").lower()
    allowed = {"localhost", "127.0.0.1", (ws.url.hostname or "").lower(), (urllib.parse.urlparse(cw.public_url()).hostname or "").lower()}
    return host in allowed


@router.websocket("/terminals/{tid}/channels")
async def terminal_socket(ws: WebSocket, wid: str, tid: str) -> None:
    # the HTTP middleware does not see websockets: authenticate here, the same way
    if not _origin_ok(ws):
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
        cw._get(wid, "editor")
        t = _term(wid, tid)
    except HTTPException:
        await ws.close(code=4404)
        return
    finally:
        auth._principal.reset(token)
    await ws.accept()
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    entry = (loop, q)
    t.listeners.add(entry)
    if t.buffer:
        await ws.send_text(json.dumps(["stdout", t.buffer]))

    async def pump_out() -> None:
        while True:
            text = await q.get()
            await ws.send_text(json.dumps(["stdout", text]))

    out = asyncio.create_task(pump_out())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if not msg:
                continue
            if msg[0] == "stdin" and not t.closed:
                await asyncio.to_thread(t.write, str(msg[1]))
            elif msg[0] == "set_size" and len(msg) >= 3:
                await asyncio.to_thread(t.resize, int(msg[1]), int(msg[2]))
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        out.cancel()
        t.listeners.discard(entry)
