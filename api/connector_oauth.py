"""OAuth 2.0 sign-in for connections (authorization code flow, RFC 6749 §4.1, with PKCE, RFC 7636).

The connection form starts a sign-in with its values (client ID and secret of the app the user
registered with the provider); the browser opens the provider's authorize URL, the provider
redirects back to /api/datasources/oauth/callback, and the code is exchanged for tokens here.
The tokens never reach the browser: the form gets a reference ("oauth:<state>") in the
connector's token field, which `resolve` swaps for the refresh token (or the access token when
the provider issues none) when the connection is tested or saved.

The redirect URL to register with the provider is BLUESANDAI_OAUTH_REDIRECT_URL, or this API's
own /api/datasources/oauth/callback. Pending sign-ins live in memory for 15 minutes.
"""

from __future__ import annotations

import base64
import hashlib
import html
import os
import secrets as pysecrets
import threading
import time
from typing import Any, Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import connectors

router = APIRouter(prefix="/oauth")

TTL_S = 15 * 60
PREFIX = "oauth:"
_pending: dict[str, dict] = {}
_lock = threading.Lock()


class Start(BaseModel):
    kind: str
    values: dict[str, Any]
    # a saved connection's secrets fill fields left empty (e.g. the client secret)
    connection_id: Optional[str] = None


def _gc() -> None:
    now = time.time()
    for k in [k for k, v in _pending.items() if now - v["created"] > TTL_S]:
        _pending.pop(k, None)


def redirect_uri(request: Request) -> str:
    return os.environ.get("BLUESANDAI_OAUTH_REDIRECT_URL") or str(request.url_for("oauth_callback"))


@router.get("/redirect-uri")
def get_redirect_uri(request: Request) -> dict:
    return {"redirect_uri": redirect_uri(request)}


@router.post("/start")
def start(req: Start, request: Request) -> dict:
    try:
        spec = connectors.spec(req.kind)
    except connectors.ConnectorError as e:
        raise HTTPException(400, str(e)) from None
    if not spec.oauth:
        raise HTTPException(400, f"{spec.name} has no OAuth sign-in")
    app = spec.oauth
    values = dict(req.values)
    if req.connection_id:
        import datasources
        import secretbox

        row = datasources._connection_row(req.connection_id)
        if row["kind"] != req.kind:
            raise HTTPException(400, "The connection is of another type")
        # the saved settings decide where the saved secrets go (never hosts from the request)
        values.update({k: v for k, v in (row.get("config") or {}).items() if v not in (None, "")})
        for k, v in secretbox.unseal(row.get("secret")).items():
            if not values.get(k):
                values[k] = v
    client_id = str(values.get(app.client_id_field) or "").strip()
    if not client_id:
        raise HTTPException(400, "Fill in the client ID of your OAuth app first")
    try:
        authorize = app.authorize_url(values)
        token_url = urlparse(app.token_url(values))
    except (KeyError, ValueError, connectors.ConnectorError) as e:
        raise HTTPException(400, f"Fill in the connection details first ({e})") from None
    import network

    try:
        # the code (and client secret) are sent to the token endpoint from this server
        network.check_egress(token_url.hostname, token_url.port or (80 if token_url.scheme == "http" else 443), "This sign-in")
    except network.EgressDenied as e:
        raise HTTPException(400, str(e)) from None
    state = pysecrets.token_urlsafe(24)
    verifier = pysecrets.token_urlsafe(48)
    redirect = redirect_uri(request)
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "state": state, **app.extra}
    scope = str(values.get(app.scope_field) or "").strip() if app.scope_field else ""
    if scope or app.scope:
        params["scope"] = scope or app.scope
    if app.pkce:
        params["code_challenge"] = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params["code_challenge_method"] = "S256"
    with _lock:
        _gc()
        _pending[state] = {"kind": req.kind, "values": values, "verifier": verifier, "redirect": redirect, "created": time.time(), "status": "pending"}
    sep = "&" if "?" in authorize else "?"
    return {"url": f"{authorize}{sep}{urlencode(params)}", "state": state, "redirect_uri": redirect}


def _page(title: str, text: str, ok: bool) -> HTMLResponse:
    color = "#34c38f" if ok else "#f0616d"
    return HTMLResponse(
        f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<body style="background:#070b12;color:#c3ccda;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:{color}">{html.escape(title)}</h2><p>{html.escape(text)}</p></div>
<script>setTimeout(() => window.close(), {1500 if ok else 8000})</script></body>""",
        status_code=200 if ok else 400,
    )


@router.get("/callback", name="oauth_callback")
def callback(state: str = "", code: str = "", error: str = "", error_description: str = "") -> HTMLResponse:
    with _lock:
        p = _pending.get(state)
    if not p:
        return _page("Sign-in expired", "Start the sign-in again from the connection form.", False)
    if error or not code:
        p.update(status="error", message=error_description or error or "The provider returned no code")
        return _page("Sign-in failed", p["message"], False)
    spec = connectors.spec(p["kind"])
    app = spec.oauth
    assert app is not None
    values = p["values"]
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": p["redirect"]}
    if app.pkce:
        data["code_verifier"] = p["verifier"]
    client_id = str(values.get(app.client_id_field) or "")
    client_secret = str(values.get(app.client_secret_field) or "")
    auth = None
    if app.client_auth == "basic" or (app.client_auth == "auto" and client_secret):
        auth = (client_id, client_secret)
    else:
        data["client_id"] = client_id
        if client_secret:
            data["client_secret"] = client_secret
    try:
        r = httpx.post(app.token_url(values), data=data, auth=auth, headers={"Accept": "application/json"}, timeout=30)
        body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        p.update(status="error", message=f"Token exchange failed: {type(e).__name__}")
        return _page("Sign-in failed", p["message"], False)
    if r.status_code >= 400 or not (body.get("refresh_token") or body.get("access_token")):
        p.update(status="error", message=str(body.get("error_description") or body.get("error") or f"HTTP {r.status_code}"))
        return _page("Sign-in failed", p["message"], False)
    p.update(status="done", tokens=body)
    return _page("Signed in", f"{spec.name} is connected. You can close this window.", True)


@router.get("/result/{state}")
def result(state: str) -> dict:
    with _lock:
        p = _pending.get(state)
    if not p:
        raise HTTPException(404, "Sign-in expired: start it again")
    if p["status"] == "done":
        return {"status": "done", "ref": PREFIX + state, "refresh": bool(p["tokens"].get("refresh_token"))}
    return {"status": p["status"], "message": p.get("message")}


def rotated(old: str, new: str) -> None:
    """A connection test used a signed-in refresh token and the provider rotated it: later uses of
    the same sign-in (saving after testing) get the new one."""
    with _lock:
        for p in _pending.values():
            t = p.get("tokens") or {}
            if t.get("refresh_token") == old:
                t["refresh_token"] = new


def resolve(secrets: dict) -> dict:
    """Secret values that reference a finished sign-in → its token (refresh token if issued)."""
    out = dict(secrets)
    for k, v in secrets.items():
        if isinstance(v, str) and v.startswith(PREFIX):
            with _lock:
                p = _pending.get(v[len(PREFIX):])
            if not p or p["status"] != "done":
                raise connectors.ConnectorError("The OAuth sign-in expired: sign in again")
            t = p["tokens"]
            out[k] = t.get("refresh_token") or t.get("access_token")
    return out
