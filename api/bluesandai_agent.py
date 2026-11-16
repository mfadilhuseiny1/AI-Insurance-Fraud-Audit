#!/usr/bin/env python3
"""BluesandAI Data Connection agent (agent proxy).

Install it on a host inside your network that can reach your source systems, then run:

    pip install websockets
    python bluesandai_agent.py --url https://<your BluesandAI host> --token <agent token>

The agent only makes an outbound connection: a WebSocket to <url>/api/dc-agents/connect. When a connection of the
platform goes to a host of an agent proxy egress policy, the platform asks the agent to open host:port and relays the
bytes through the WebSocket (TLS stays end to end between the platform and your system).

Options:
  --allow HOST[:PORT]   only open these destinations (repeatable; default: whatever the platform's policies ask)
  --resolve HOST=IP     use this address for a host name (like /etc/hosts, for names your DNS does not know)
The agent reconnects with backoff when the connection drops, and reports a heartbeat every 20 s.
Run it under a service manager (systemd, a scheduled task) so it restarts with the host.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import socket
import struct
import sys

VERSION = "1.0.0"


def parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="BluesandAI Data Connection agent")
    p.add_argument("--url", required=True, help="the platform's address, e.g. https://bluesandai.example.com")
    p.add_argument("--token", required=True, help="the agent token shown when the agent was created")
    p.add_argument("--allow", action="append", default=[], help="HOST or HOST:PORT the agent may open (repeatable)")
    p.add_argument("--resolve", action="append", default=[], help="HOST=IP: the address to use for a host name")
    return p.parse_args()


class Agent:
    def __init__(self, args: argparse.Namespace) -> None:
        self.url = args.url.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/api/dc-agents/connect"
        self.token = args.token
        self.allow = [a.lower() for a in args.allow]
        self.resolve = dict(x.split("=", 1) for x in args.resolve if "=" in x)
        self.streams: dict[int, asyncio.StreamWriter] = {}
        self.opened = 0

    def allowed(self, host: str, port: int) -> bool:
        if not self.allow:
            return True
        h = host.lower()
        return any(a == h or a == f"{h}:{port}" for a in self.allow)

    async def run(self) -> None:
        import websockets

        delay = 1
        while True:
            try:
                async with websockets.connect(self.url, additional_headers={"Authorization": f"Bearer {self.token}"}, max_size=None, ping_interval=20) as ws:
                    delay = 1
                    print(f"connected to {self.url}", flush=True)
                    await ws.send(json.dumps({"op": "hello", "hostname": socket.gethostname(), "os": f"{platform.system()} {platform.release()}",
                                              "python": platform.python_version(), "agent_version": VERSION, "allowlist": self.allow}))
                    beat = asyncio.create_task(self.heartbeat(ws))
                    try:
                        async for msg in ws:
                            if isinstance(msg, bytes):
                                sid = struct.unpack(">I", msg[:4])[0]
                                w = self.streams.get(sid)
                                if w:
                                    w.write(msg[4:])
                                    await w.drain()
                                continue
                            m = json.loads(msg)
                            if m.get("op") == "open":
                                asyncio.create_task(self.open(ws, int(m["stream"]), m["host"], int(m["port"])))
                            elif m.get("op") == "close":
                                w = self.streams.pop(int(m["stream"]), None)
                                if w:
                                    w.close()
                    finally:
                        beat.cancel()
                        for w in self.streams.values():
                            w.close()
                        self.streams.clear()
            except Exception as e:  # noqa: BLE001 - reconnect
                print(f"disconnected: {e}; retrying in {delay} s", file=sys.stderr, flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def heartbeat(self, ws) -> None:  # noqa: ANN001
        while True:
            await asyncio.sleep(20)
            await ws.send(json.dumps({"op": "heartbeat", "stats": {"open_streams": len(self.streams), "opened": self.opened}}))

    async def open(self, ws, sid: int, host: str, port: int) -> None:  # noqa: ANN001
        if not self.allowed(host, port):
            await ws.send(json.dumps({"op": "error", "stream": sid, "error": f"{host}:{port} is not in the agent's --allow list"}))
            return
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(self.resolve.get(host, host), port), 15)
        except Exception as e:  # noqa: BLE001
            await ws.send(json.dumps({"op": "error", "stream": sid, "error": f"the agent could not reach {host}:{port}: {e}"}))
            return
        self.streams[sid] = writer
        self.opened += 1
        await ws.send(json.dumps({"op": "opened", "stream": sid}))
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                await ws.send(struct.pack(">I", sid) + data)
        except Exception:  # noqa: BLE001
            pass
        finally:
            if self.streams.pop(sid, None) is not None:
                try:
                    await ws.send(json.dumps({"op": "close", "stream": sid}))
                except Exception:  # noqa: BLE001
                    pass
            writer.close()


if __name__ == "__main__":
    try:
        asyncio.run(Agent(parse()).run())
    except KeyboardInterrupt:
        pass
