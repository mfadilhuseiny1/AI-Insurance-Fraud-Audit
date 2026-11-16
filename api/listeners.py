"""HTTPS listeners: inbound webhooks from external systems written to a stream, as Data Connection's
listeners.

A listener provisions an endpoint URL (`/api/listen/<token>`), verifies each request with the
protocol of the system sending it, and writes the event to the listener's stream (one record per
event: when it was received, the request headers, query and body). Pipelines, streaming pipelines
and the stream's records read the events from there.

Verification by listener type:
  custom         basic authentication, or a shared secret in a header or the `token` query parameter
  github         X-Hub-Signature-256: sha256=HMAC-SHA256(secret, body)
  jira           X-Hub-Signature: sha256=HMAC-SHA256(secret, body) (no secret: unsigned)
  gitlab         X-Gitlab-Token equals the secret
  slack          X-Slack-Signature: v0=HMAC-SHA256(secret, "v0:<timestamp>:<body>"), timestamp within
                 5 minutes; answers Slack's url_verification challenge
  stripe         Stripe-Signature: t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<body>"), within 5 minutes
  shopify        X-Shopify-Hmac-Sha256: base64 HMAC-SHA256(secret, body)
  google_pubsub  the shared secret as the `token` query parameter of the push subscription URL
  hmac           a configurable header carrying HMAC-SHA256 or SHA1 of the body, hex or base64

A listener only accepts events while active. Events are limited to 1 MB and, per listener, about
100 requests per second. An endpoint can be rotated: a new endpoint is generated and the old one
expires at a chosen time (or immediately).

Mounted by server.py under /api/listeners (management) and /api/listen (inbound).

Access (sign-in on) — the model of the listener's stream (pipeline_runtime.py, the old pipeline streams): a listener
has a home, the Files folder or Project it was created in (moved with PUT /{id}/home), whose markings and Project
roles apply: Viewer lists the listener and reads its events; Editor also sees its endpoint URLs (their tokens are the
inbound credential), edits it, starts / stops it, rotates and expires endpoints, moves it and deletes it (with its
stream). Creating one in a folder needs Editor on that folder. A listener without a home is its creator's (and
administrators'); one without a home and a creator (made before 2026-10-14) is administrators' only, until one of them
moves it into a folder. Markings applied to the listener's stream (`pipeline_stream:<stream id>`) apply to the
listener too. The stream gets the same home and creator, so the stream routes give the same people the same access.
A listener the caller cannot read is "not found" (404) and listed nowhere; a reader who may not change it gets 403.
The endpoint tokens are never in listings, and returned only to those who may change the listener. Inbound requests
(/api/listen/<token>, public) are authenticated by the listener's endpoint token and its own secret only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets as pysecrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import auth
import datasources as ds
import db
import pipeline_runtime
import rate_limits
import secretbox

log = logging.getLogger("bluesandai.listeners")
router = APIRouter(prefix="/api/listeners")
inbound = APIRouter(prefix="/api/listen")

MAX_EVENT_BYTES = 1_000_000
RATE_PER_SECOND = 100
TOLERANCE_S = 300
KINDS = ["custom", "github", "jira", "gitlab", "slack", "stripe", "shopify", "google_pubsub", "hmac"]
Kind = Literal["custom", "github", "jira", "gitlab", "slack", "stripe", "shopify", "google_pubsub", "hmac"]
# headers never written to the stream
REDACT = {"authorization", "cookie", "x-gitlab-token", "proxy-authorization"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS listeners (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    kind        text NOT NULL,
    config      jsonb NOT NULL,
    secret      bytea,
    stream_id   text NOT NULL,
    status      text NOT NULL DEFAULT 'inactive',
    endpoints   jsonb NOT NULL,
    stats       jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
ALTER TABLE listeners ADD COLUMN IF NOT EXISTS item_id text;
ALTER TABLE listeners ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE listeners ADD COLUMN IF NOT EXISTS created_by_name text;
"""

STREAM_SCHEMA = [
    {"name": "event_id", "type": "String"},
    {"name": "received_at", "type": "String"},
    {"name": "listener", "type": "String"},
    {"name": "headers", "type": "String"},
    {"name": "query", "type": "String"},
    {"name": "body", "type": "String"},
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


_ready = False


def _migrate() -> None:
    """Listeners made before the access model take the home and creator their stream recorded (a stream created
    since 2026-10-14 knows its creator); the others stay without both: administrators' only, as their streams."""
    for r in ds._rows("SELECT id, stream_id FROM listeners WHERE item_id IS NULL AND created_by IS NULL"):
        try:
            s = pipeline_runtime._stream(r["stream_id"])
        except HTTPException:
            continue
        if s.get("item_id") or s.get("created_by"):
            ds._exec("UPDATE listeners SET item_id = %s, created_by = %s, created_by_name = %s WHERE id = %s",
                     (s.get("item_id"), s.get("created_by"), s.get("created_by_name"), r["id"]))


def startup() -> None:
    global _ready
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(SCHEMA)
    _migrate()
    _ready = True


def _require() -> None:
    """PostgreSQL, and the table with its access columns (processes that did not run startup())."""
    ds._require()
    if not _ready:
        startup()


class ListenerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Kind = "custom"
    # custom: "basic" | "header" | "query" | "none"; hmac: header, algorithm, encoding, prefix
    auth: Literal["basic", "header", "query", "none"] = "header"
    header_name: Optional[str] = None
    algorithm: Literal["sha256", "sha1"] = "sha256"
    encoding: Literal["hex", "base64"] = "hex"
    prefix: str = ""
    # the signing secret / shared secret / password; blank keeps the saved one
    secret: Optional[str] = None
    username: Optional[str] = None
    # creating: the Files folder or Project the listener (and its stream) lives in; none: the creator's own.
    # Ignored by an update (PUT /{id}/home moves a listener)
    parent_id: Optional[str] = None


def _row(listener_id: str) -> dict:
    rows = ds._rows("SELECT * FROM listeners WHERE id = %s", (listener_id,))
    if not rows:
        raise HTTPException(404, "Listener not found")
    return rows[0]


def _as_stream(row: dict) -> dict:
    """The listener as its stream's access model sees it: the stream's id (its markings), home and creator."""
    return {"id": row["stream_id"], "item_id": row.get("item_id"), "created_by": row.get("created_by")}


def _access(row: dict, p: Optional[dict]) -> str:
    """"edit", "read" or "none" (pipeline_runtime._stream_access: sign-in off and the system may do anything)."""
    return pipeline_runtime._stream_access(_as_stream(row), p)


def _row_for(listener_id: str, request: Request, need: str = "read") -> tuple[dict, str]:
    """The listener and the caller's access, or 404 (cannot read it) / 403 (may read, not change)."""
    row = _row(listener_id)
    acc = _access(row, pipeline_runtime._caller(request))
    if acc == "none":
        raise HTTPException(404, "Listener not found")
    if need == "edit" and acc != "edit":
        home = pipeline_runtime._stream_home(_as_stream(row))
        if home:
            auth.check_item_id(home, "editor")  # 403 naming the role (and the Project, for "Request access")
        raise HTTPException(403, "You need the Editor role on this listener's Project to change it")
    return row, acc


def _folder(parent_id: str) -> str:
    """A Files folder or Project the caller may create in (Editor), or 404 / 403."""
    try:
        item = db.drive_get(parent_id)
    except Exception:  # noqa: BLE001
        item = None
    if not item or item.get("trashed_at") or item.get("kind") not in ("folder", "project"):
        raise HTTPException(404, "folder not found")
    auth.check_item_id(parent_id, "editor")
    return parent_id


def _sync_stream(row: dict) -> None:
    """The stream follows its listener: the same home and creator (pipeline_runtime's stream record)."""
    with pipeline_runtime._lock, pipeline_runtime._db() as con:
        found = con.execute("SELECT record FROM streams WHERE id = ?", (row["stream_id"],)).fetchone()
        if not found:
            return
        rec = json.loads(found[0])
        rec.update(item_id=row.get("item_id"), created_by=row.get("created_by") or rec.get("created_by"),
                   created_by_name=row.get("created_by_name") or rec.get("created_by_name"))
        con.execute("UPDATE streams SET record = ? WHERE id = ?", (json.dumps(rec), row["stream_id"]))


def _live_endpoints(row: dict) -> list[dict]:
    now = _now().isoformat()
    return [e for e in row["endpoints"] if not e.get("expires_at") or e["expires_at"] > now]


def _public(row: dict, base_url: str = "", acc: str = "edit", tokens: bool = True) -> dict:
    """A listener as a caller sees it: the endpoint tokens (URLs) and the basic-auth username only for those who may
    change it, and never in listings (`tokens`); an endpoint without them keeps its dates."""
    sec = secretbox.unseal(row.get("secret"))
    show = acc == "edit" and tokens
    now = _now().isoformat()
    home = pipeline_runtime._stream_home(_as_stream(row))
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "config": row["config"],
        "secret_set": bool(sec.get("secret")),
        "username": sec.get("username") if acc == "edit" else None,
        "stream_id": row["stream_id"],
        "status": row["status"],
        "endpoints": [{"token": e["token"] if show else None, "url": f"{base_url}/api/listen/{e['token']}" if show else None,
                       "created_at": e.get("created_at"), "expires_at": e.get("expires_at"),
                       "expired": bool(e.get("expires_at") and e["expires_at"] <= now)} for e in row["endpoints"]],
        "stats": row.get("stats") or {},
        "item_id": home,
        "project_id": auth.project_of(home) if home else None,
        "created_by": row.get("created_by"),
        "created_by_name": row.get("created_by_name"),
        "can_edit": acc == "edit",
        # markings for the listener and its events go on its stream
        "markings_resource": f"{pipeline_runtime.STREAM_KIND}:{row['stream_id']}",
        "created_at": ds._iso(row["created_at"]),
        "updated_at": ds._iso(row["updated_at"]),
    }


def _config(req: ListenerIn) -> dict:
    cfg: dict[str, Any] = {}
    if req.kind == "custom":
        cfg["auth"] = req.auth
        if req.auth == "header":
            if not (req.header_name or "").strip() or not re.fullmatch(r"[A-Za-z0-9\-_]+", req.header_name.strip()):
                raise HTTPException(400, "Name the header that carries the shared secret")
            cfg["header_name"] = req.header_name.strip()
    if req.kind == "hmac":
        if not (req.header_name or "").strip():
            raise HTTPException(400, "Name the header that carries the signature")
        cfg.update(header_name=req.header_name.strip(), algorithm=req.algorithm, encoding=req.encoding, prefix=req.prefix)
    return cfg


def _needs_secret(kind: str, cfg: dict) -> bool:
    if kind == "jira":
        return False
    if kind == "custom":
        return cfg.get("auth") != "none"
    return True


def _base(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("")
def list_listeners(request: Request) -> list[dict]:
    """The listeners the caller may read (never with their endpoint tokens: GET /{id} has them, for editors)."""
    _require()
    p = pipeline_runtime._caller(request)
    out = []
    for r in ds._rows("SELECT * FROM listeners ORDER BY updated_at DESC"):
        acc = _access(r, p)
        if acc != "none":
            out.append(_public(r, _base(request), acc, tokens=False))
    return out


@router.get("/{listener_id}")
def get_listener(listener_id: str, request: Request) -> dict:
    _require()
    row, acc = _row_for(listener_id, request)
    return _public(row, _base(request), acc)


@router.post("")
def create_listener(req: ListenerIn, request: Request) -> dict:
    _require()
    p = pipeline_runtime._caller(request)
    parent = (req.parent_id or "").strip() or None
    if parent:
        _folder(parent)
    cfg = _config(req)
    sec: dict[str, str] = {}
    if req.secret:
        sec["secret"] = req.secret
    if req.username:
        sec["username"] = req.username
    if _needs_secret(req.kind, cfg) and not sec.get("secret"):
        raise HTTPException(400, "Enter the signing secret or shared secret the external system uses")
    if req.kind == "custom" and cfg.get("auth") == "basic" and not sec.get("username"):
        raise HTTPException(400, "Basic authentication needs a username")
    # the stream gets the same home (create_stream checks Editor on it again) and creator (the caller)
    stream = pipeline_runtime.create_stream(pipeline_runtime.NewStream(name=f"{req.name.strip()} (listener events)", schema=STREAM_SCHEMA, parent_id=parent))
    user = p if p and not p.get("service") and p.get("id") not in (None, "local") else None
    now = _now()
    lid = uuid.uuid4().hex[:16]
    endpoints = [{"token": pysecrets.token_urlsafe(24), "created_at": now.isoformat(), "expires_at": None}]
    ds._exec(
        "INSERT INTO listeners (id, name, kind, config, secret, stream_id, status, endpoints, created_at, updated_at, item_id, created_by, created_by_name)"
        " VALUES (%s, %s, %s, %s, %s, %s, 'inactive', %s, %s, %s, %s, %s, %s)",
        (lid, req.name.strip(), req.kind, Jsonb(cfg), secretbox.seal(sec), stream["id"], Jsonb(endpoints), now, now,
         parent, user and user.get("id"), user and user.get("username")),
    )
    return get_listener(lid, request)


@router.put("/{listener_id}")
def update_listener(listener_id: str, req: ListenerIn, request: Request) -> dict:
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    if req.kind != row["kind"]:
        raise HTTPException(400, "The listener type cannot change — create a new listener")
    cfg = _config(req)
    sec = secretbox.unseal(row.get("secret"))
    if req.secret:
        sec["secret"] = req.secret
    if req.username is not None:
        sec["username"] = req.username
    if _needs_secret(req.kind, cfg) and not sec.get("secret"):
        raise HTTPException(400, "Enter the signing secret or shared secret the external system uses")
    ds._exec(
        "UPDATE listeners SET name = %s, config = %s, secret = %s, updated_at = %s WHERE id = %s",
        (req.name.strip(), Jsonb(cfg), secretbox.seal(sec), _now(), listener_id),
    )
    return get_listener(listener_id, request)


class StatusIn(BaseModel):
    active: bool


@router.post("/{listener_id}/status")
def set_status(listener_id: str, req: StatusIn, request: Request) -> dict:
    _require()
    _row_for(listener_id, request, "edit")
    ds._exec("UPDATE listeners SET status = %s, updated_at = %s WHERE id = %s", ("active" if req.active else "inactive", _now(), listener_id))
    return get_listener(listener_id, request)


class RotateIn(BaseModel):
    # hours until the current endpoint stops working; 0 deletes it now
    expire_in_hours: int = Field(24, ge=0, le=24 * 90)


@router.post("/{listener_id}/rotate")
def rotate(listener_id: str, req: RotateIn, request: Request) -> dict:
    """A new endpoint; the current one expires (zero-downtime rotation) or is deleted. At most two
    endpoints, one of them active (without an expiry)."""
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    live = _live_endpoints(row)
    if len(live) >= 2:
        raise HTTPException(409, "An endpoint rotation is already in progress — delete the expiring endpoint first")
    now = _now()
    kept = []
    if req.expire_in_hours:
        for e in live:
            kept.append({**e, "expires_at": e.get("expires_at") or (now + timedelta(hours=req.expire_in_hours)).isoformat()})
    endpoints = [*kept, {"token": pysecrets.token_urlsafe(24), "created_at": now.isoformat(), "expires_at": None}]
    ds._exec("UPDATE listeners SET endpoints = %s, updated_at = %s WHERE id = %s", (Jsonb(endpoints), now, listener_id))
    return get_listener(listener_id, request)


class ExpiryIn(BaseModel):
    expires_at: Optional[str] = None


@router.put("/{listener_id}/endpoints/{token}")
def set_expiry(listener_id: str, token: str, req: ExpiryIn, request: Request) -> dict:
    """Extend (or set) the expiry of an expiring endpoint; an expired one cannot be changed."""
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    now = _now().isoformat()
    eps = row["endpoints"]
    ep = next((e for e in eps if e["token"] == token), None)
    if not ep:
        raise HTTPException(404, "Endpoint not found")
    if ep.get("expires_at") and ep["expires_at"] <= now:
        raise HTTPException(409, "The endpoint has expired — delete it and rotate again")
    if not ep.get("expires_at"):
        raise HTTPException(400, "The active endpoint has no expiry — rotate to replace it")
    try:
        when = datetime.fromisoformat((req.expires_at or "").replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "expires_at is an ISO date-time") from None
    ep["expires_at"] = when.astimezone(timezone.utc).isoformat()
    ds._exec("UPDATE listeners SET endpoints = %s, updated_at = %s WHERE id = %s", (Jsonb(eps), _now(), listener_id))
    return get_listener(listener_id, request)


@router.delete("/{listener_id}/endpoints/{token}")
def delete_endpoint(listener_id: str, token: str, request: Request) -> dict:
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    if not any(e["token"] == token for e in row["endpoints"]):
        raise HTTPException(404, "Endpoint not found")
    eps = [e for e in row["endpoints"] if e["token"] != token]
    if not any(not e.get("expires_at") for e in eps):
        raise HTTPException(400, "The active endpoint cannot be deleted — rotate first")
    ds._exec("UPDATE listeners SET endpoints = %s, updated_at = %s WHERE id = %s", (Jsonb(eps), _now(), listener_id))
    return get_listener(listener_id, request)


class HomeIn(BaseModel):
    parent_id: str = Field(min_length=1)


@router.put("/{listener_id}/home")
def move_listener(listener_id: str, req: HomeIn, request: Request) -> dict:
    """Move a listener (and its stream) into a Files folder or Project: the new home's markings and roles apply. Needs
    the right to change the listener and Editor on the folder (how administrators give a listener made before
    2026-10-14 a home)."""
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    parent = _folder(req.parent_id.strip())
    ds._exec("UPDATE listeners SET item_id = %s, updated_at = %s WHERE id = %s", (parent, _now(), listener_id))
    _sync_stream({**row, "item_id": parent})
    return get_listener(listener_id, request)


@router.delete("/{listener_id}")
def delete_listener(listener_id: str, request: Request, delete_stream: bool = False) -> dict:
    _require()
    row = _row_for(listener_id, request, "edit")[0]
    stream_there = True
    if delete_stream:
        try:
            pipeline_runtime._stream(row["stream_id"])
        except HTTPException:
            stream_there = False  # deleted already
        if stream_there:
            # the stream's own rules decide too (its markings / home could differ): nothing is deleted when refused
            pipeline_runtime._stream_for(row["stream_id"], request, "edit")
    ds._exec("DELETE FROM listeners WHERE id = %s", (listener_id,))
    if delete_stream and stream_there:
        pipeline_runtime.delete_stream(row["stream_id"])
    return {"deleted": listener_id}


@router.get("/{listener_id}/events")
def events(listener_id: str, request: Request, limit: int = 50) -> dict:
    """The newest events (the test page). Reading them needs read access (Viewer)."""
    _require()
    row = _row_for(listener_id, request)[0]
    s = pipeline_runtime._stream(row["stream_id"])
    with pipeline_runtime._db() as con:
        rows = con.execute(
            "SELECT seq, at, record FROM stream_records WHERE stream_id = ? ORDER BY seq DESC LIMIT ?", (s["id"], max(1, min(limit, 500)))
        ).fetchall()
    return {"stream_id": s["id"], "events": [{"seq": seq, "at": at, **json.loads(r)} for seq, at, r in rows]}


# --------------------------------------------------------------------------------------------
# inbound
# --------------------------------------------------------------------------------------------

def _hmac(secret: str, msg: bytes, algo: str = "sha256") -> bytes:
    return hmac.new(secret.encode(), msg, hashlib.sha256 if algo == "sha256" else hashlib.sha1).digest()


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def _verify(row: dict, request: Request, body: bytes) -> None:
    """Raises 401 when the request is not signed / authenticated as the listener's type requires."""
    kind, cfg = row["kind"], row["config"]
    sec = secretbox.unseal(row.get("secret"))
    secret = sec.get("secret") or ""
    h = request.headers
    deny = HTTPException(401, "Signature verification failed")
    if kind == "custom":
        auth = cfg.get("auth", "header")
        if auth == "none":
            return
        if auth == "basic":
            got = h.get("authorization", "")
            want = "Basic " + base64.b64encode(f"{sec.get('username', '')}:{secret}".encode()).decode()
            if not _eq(got, want):
                raise HTTPException(401, "Basic authentication failed")
            return
        got = h.get(cfg.get("header_name", "")) if auth == "header" else request.query_params.get("token")
        if not got or not _eq(got, secret):
            raise HTTPException(401, "The shared secret does not match")
        return
    if kind in ("github", "jira"):
        header = "x-hub-signature-256" if kind == "github" else "x-hub-signature"
        if kind == "jira" and not secret:
            return
        got = h.get(header) or (h.get("x-hub-signature-256") if kind == "jira" else None) or ""
        if not _eq(got, "sha256=" + _hmac(secret, body).hex()):
            raise deny
        return
    if kind == "gitlab":
        if not _eq(h.get("x-gitlab-token", ""), secret):
            raise deny
        return
    if kind == "slack":
        ts = h.get("x-slack-request-timestamp", "")
        if not ts.isdigit() or abs(time.time() - int(ts)) > TOLERANCE_S:
            raise HTTPException(401, "Stale or missing Slack request timestamp")
        if not _eq(h.get("x-slack-signature", ""), "v0=" + _hmac(secret, f"v0:{ts}:".encode() + body).hex()):
            raise deny
        return
    if kind == "stripe":
        parts: dict[str, list[str]] = {}
        for item in h.get("stripe-signature", "").split(","):
            if "=" in item:
                k, v = item.split("=", 1)
                parts.setdefault(k.strip(), []).append(v.strip())
        ts = (parts.get("t") or [""])[0]
        if not ts.isdigit() or abs(time.time() - int(ts)) > TOLERANCE_S:
            raise HTTPException(401, "Stale or missing Stripe timestamp")
        want = _hmac(secret, f"{ts}.".encode() + body).hex()
        if not any(_eq(v, want) for v in parts.get("v1", [])):
            raise deny
        return
    if kind == "shopify":
        if not _eq(h.get("x-shopify-hmac-sha256", ""), base64.b64encode(_hmac(secret, body)).decode()):
            raise deny
        return
    if kind == "google_pubsub":
        if not _eq(request.query_params.get("token", ""), secret):
            raise HTTPException(401, "The push subscription's token does not match")
        return
    if kind == "hmac":
        digest = _hmac(secret, body, cfg.get("algorithm", "sha256"))
        sig = digest.hex() if cfg.get("encoding", "hex") == "hex" else base64.b64encode(digest).decode()
        if not _eq(h.get(cfg["header_name"], ""), (cfg.get("prefix") or "") + sig):
            raise deny
        return
    raise deny


def _find(token: str) -> dict:
    rows = ds._rows("SELECT * FROM listeners WHERE endpoints @> %s", (Jsonb([{"token": token}]),))
    if not rows:
        raise HTTPException(404, "Unknown listener endpoint")
    row = rows[0]
    if not any(e["token"] == token for e in _live_endpoints(row)):
        raise HTTPException(410, "This listener endpoint has expired")
    return row


@inbound.api_route("/{token}", methods=["POST", "PUT", "GET"])
async def receive(token: str, request: Request) -> Any:
    if not db.enabled():
        raise HTTPException(503, "Listeners need the PostgreSQL database")
    row = _find(token)
    body = await request.body()
    if len(body) > MAX_EVENT_BYTES:
        raise HTTPException(413, "Events are limited to 1 MB")
    if row["status"] != "active":
        raise HTTPException(503, "The listener is not active — start it to accept events")
    # shared by every API process (PostgreSQL); this process's own count when it is not available: rate_limits.take
    if not rate_limits.take(f"listener:{row['id']}", RATE_PER_SECOND, 1):
        raise HTTPException(429, "Rate limited: about 100 requests per second per listener")
    if request.method == "GET":
        # some systems check the endpoint with a GET before sending events
        return PlainTextResponse("ok")
    _verify(row, request, body)
    text = body.decode("utf-8", errors="replace")
    # Slack checks the endpoint with a url_verification challenge
    if row["kind"] == "slack":
        try:
            payload = json.loads(text)
            if payload.get("type") == "url_verification":
                return JSONResponse({"challenge": payload.get("challenge")})
        except json.JSONDecodeError:
            pass
    headers = {k: v for k, v in request.headers.items() if k.lower() not in REDACT}
    query = {k: v for k, v in request.query_params.items() if k != "token"}
    event_id = uuid.uuid4().hex
    pipeline_runtime.push_records(
        row["stream_id"],
        {"event_id": event_id, "received_at": _now().isoformat(), "listener": row["id"], "headers": json.dumps(headers), "query": json.dumps(query), "body": text},
    )
    stats = dict(row.get("stats") or {})
    stats["events"] = stats.get("events", 0) + 1
    stats["last_event_at"] = _now().isoformat()
    ds._exec("UPDATE listeners SET stats = %s WHERE id = %s", (Jsonb(stats), row["id"]))
    return {"ok": True, "event_id": event_id}
