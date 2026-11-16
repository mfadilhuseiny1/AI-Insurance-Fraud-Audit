"""The single origin behind the public tunnel (https://hexa.bluesandai.com → 127.0.0.1:8886, see public.ps1).

Cloudflare's published application route sends every request here; this proxy splits them by path, as the
dashboard's per-path routes would:
  /api/kg-usage (the web app's own route handler)                        → the production web on 127.0.0.1:8887
  /api/pipeline-runner                                                    → refused (the API calls it locally)
  /api/*, /v2/* (the API, the Docker registry)                            → the API on 127.0.0.1:8000
  everything else                                                         → the production web on 127.0.0.1:8887
Requests and responses are streamed both ways (uploads, downloads, server-sent and streamed responses), WebSockets
are relayed (Data Connection agents), redirects and cookies pass through untouched, and X-Forwarded-For / -Proto
are kept so the API sees the visitor and HTTPS (sign-in cookies are Secure).

Run: python -m uvicorn public_proxy:app --host 127.0.0.1 --port 8886 --no-access-log (from api/).
"""

from __future__ import annotations

import asyncio
import os
import re

import httpx
import websockets
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

API = os.environ.get("BLUESANDAI_PUBLIC_API", "http://127.0.0.1:8000")
WEB = os.environ.get("BLUESANDAI_PUBLIC_WEB", "http://127.0.0.1:8887")
WEB_API = re.compile(r"^/api/kg-usage(/|$)")
# the build runner is called by the API on this machine only (pipeline_runtime.py), never from outside
PRIVATE = re.compile(r"^/api/pipeline-runner(/|$)")
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host",
       "content-length"}
client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0), follow_redirects=False, http2=False)


def upstream(path: str) -> str:
    if WEB_API.match(path):
        return WEB
    if path.startswith("/api/") or path == "/api" or path.startswith("/v2/") or path == "/v2" or path.startswith("/scim/"):
        return API
    return WEB


def _forwarded(headers, client_host: str | None, scheme: str) -> dict:
    out = {k: v for k, v in headers.items() if k.lower() not in HOP}
    prior = headers.get("x-forwarded-for")
    if client_host:
        out["x-forwarded-for"] = f"{prior}, {client_host}" if prior else client_host
    out["x-forwarded-proto"] = headers.get("x-forwarded-proto") or scheme
    out["x-forwarded-host"] = headers.get("host", "")
    return out


async def proxy(request: Request):
    if PRIVATE.match(request.url.path):
        return PlainTextResponse("not found", status_code=404)
    base = upstream(request.url.path)
    url = base + request.url.path + (f"?{request.url.query}" if request.url.query else "")
    headers = _forwarded(request.headers, request.client.host if request.client else None, request.url.scheme)
    headers["host"] = request.headers.get("host", "")
    body = request.stream() if request.method not in ("GET", "HEAD", "OPTIONS") else None
    try:
        req = client.build_request(request.method, url, headers=headers, content=body)
        resp = await client.send(req, stream=True)
    except httpx.ConnectError:
        which = "API" if base == API else "web app"
        return PlainTextResponse(f"The BluesandAI {which} is not running.", status_code=502)
    out_headers = [(k, v) for k, v in resp.headers.multi_items() if k.lower() not in HOP]

    async def body_iter():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()

    response = StreamingResponse(body_iter(), status_code=resp.status_code)
    response.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out_headers]
    return response


async def ws_proxy(ws: WebSocket):
    path = ws.url.path
    target = upstream(path).replace("http://", "ws://") + path + (f"?{ws.url.query}" if ws.url.query else "")
    skip = HOP | {"sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept"}
    headers = {k: v for k, v in ws.headers.items() if k.lower() not in skip and k.lower() != "sec-websocket-protocol"}
    headers.update(_forwarded(ws.headers, ws.client.host if ws.client else None, "https" if ws.url.scheme == "wss" else ws.url.scheme))
    for k in list(headers):
        if k.lower() in skip:
            headers.pop(k)
    protocols = [p.strip() for p in ws.headers.get("sec-websocket-protocol", "").split(",") if p.strip()] or None
    try:
        upstream_ws = await websockets.connect(target, additional_headers=headers, subprotocols=protocols, max_size=None, open_timeout=10)
    except Exception:  # noqa: BLE001
        await ws.close(code=1011)
        return
    await ws.accept(subprotocol=upstream_ws.subprotocol)

    async def client_to_upstream():
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await upstream_ws.send(msg["bytes"])
                elif msg.get("text") is not None:
                    await upstream_ws.send(msg["text"])
        except WebSocketDisconnect:
            pass
        finally:
            await upstream_ws.close()

    async def upstream_to_client():
        try:
            async for m in upstream_ws:
                if isinstance(m, bytes):
                    await ws.send_bytes(m)
                else:
                    await ws.send_text(m)
        except websockets.ConnectionClosed:
            pass
        finally:
            try:
                await ws.close()
            except RuntimeError:
                pass

    await asyncio.gather(client_to_upstream(), upstream_to_client())


app = Starlette(routes=[
    WebSocketRoute("/{path:path}", ws_proxy),
    Route("/{path:path}", proxy, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
])
