"""SCIM 2.0 provisioning (RFC 7643 / 7644): an identity provider (Entra ID, Okta, …) creates, updates and deactivates
users and groups here, instead of only syncing them at sign-in.

Base URL: {API}/scim/v2, authenticated with a bearer token an administrator generates (Control Panel → Security →
SCIM provisioning; shown once, stored as a hash). Supported: ServiceProviderConfig, ResourceTypes, Schemas; Users
(list with filter `userName eq "…"` / `externalId eq "…"`, startIndex / count paging; get; create; replace; PATCH of
active, name, displayName, emails, userName, externalId; delete = deactivate) and Groups (list with `displayName eq`;
get; create; replace; PATCH add / remove / replace members and displayName; delete). Provisioned users sign in with
single sign-on (no password); deactivation ends their sessions and tokens. Every change is in the sign-in activity
log (`scim_*` events).

Mounted by server.py (outside /api: the sign-in middleware does not apply; the SCIM token does).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

import auth

router = APIRouter(prefix="/scim/v2", tags=["scim"])
admin = APIRouter(prefix="/api/auth/scim", tags=["scim"])
USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"
LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
SCIM_JSON = "application/scim+json"


def _sha(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def _token_record() -> Optional[dict]:
    with auth._db() as con:
        row = con.execute("SELECT value FROM settings WHERE key = 'scim_token'").fetchone()
    return json.loads(row[0]) if row else None


def _check(request: Request) -> None:
    rec = _token_record()
    h = request.headers.get("authorization", "")
    token = h[7:].strip() if h.lower().startswith("bearer ") else ""
    if not rec or not token or not hmac.compare_digest(_sha(token), rec["hash"]):
        raise HTTPException(401, "a valid SCIM bearer token is required")


def _err(status: int, detail: str, scim_type: Optional[str] = None) -> JSONResponse:
    return JSONResponse({"schemas": [ERROR_SCHEMA], "status": str(status), "detail": detail, **({"scimType": scim_type} if scim_type else {})},
                        status_code=status, media_type=SCIM_JSON)


def _ok(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=SCIM_JSON)


def _base(request: Request) -> str:
    return str(request.base_url).rstrip("/") + "/scim/v2"


# ------------------------------------------------------------------------------------------------
# users
# ------------------------------------------------------------------------------------------------


def _user_out(u: dict, request: Request) -> dict:
    return {"schemas": [USER_SCHEMA], "id": u["id"], "externalId": u.get("scim_external_id"), "userName": u["username"],
            "name": {"givenName": u.get("first_name") or "", "familyName": u.get("last_name") or "", "formatted": u.get("display_name") or ""},
            "displayName": u.get("display_name") or u["username"], "active": not u.get("disabled"),
            "emails": [{"value": u["email"], "primary": True, "type": "work"}] if u.get("email") else [],
            "groups": [{"value": g, "$ref": f"{_base(request)}/Groups/{g}"} for g in sorted(auth.groups_of(u["id"]))],
            "meta": {"resourceType": "User", "created": u.get("created_at"), "location": f"{_base(request)}/Users/{u['id']}"}}


def _apply_user(u: dict, body: dict) -> list[str]:
    """Apply SCIM user attributes; returns what changed."""
    changed = []
    name = body.get("name") or {}
    if "givenName" in name:
        u["first_name"] = name.get("givenName") or ""
        changed.append("first_name")
    if "familyName" in name:
        u["last_name"] = name.get("familyName") or ""
        changed.append("last_name")
    if body.get("displayName"):
        u["display_name"] = body["displayName"]
        changed.append("display_name")
    emails = body.get("emails")
    if isinstance(emails, list) and emails:
        primary = next((e for e in emails if isinstance(e, dict) and e.get("primary")), emails[0])
        u["email"] = (primary or {}).get("value") or u.get("email") or ""
        changed.append("email")
    if "externalId" in body:
        u["scim_external_id"] = body.get("externalId")
    if "active" in body:
        active = body["active"] if isinstance(body["active"], bool) else str(body["active"]).lower() == "true"
        if u.get("disabled") == active:
            u["disabled"] = not active
            changed.append("active")
            if not active:
                _end_sessions(u["id"])
    if body.get("userName") and body["userName"].strip().lower() != u["username"]:
        new = body["userName"].strip().lower()
        if any(x["username"] == new for x in auth._users() if x["id"] != u["id"]):
            raise HTTPException(409, f"userName {new} is taken")
        u["username"] = new
        changed.append("userName")
    return changed


def _end_sessions(user_id: str) -> None:
    with auth._lock, auth._db() as con:
        con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def _filter(flt: str) -> Optional[tuple[str, str]]:
    m = re.fullmatch(r'\s*(\w+)\s+eq\s+"([^"]*)"\s*', flt or "")
    return (m.group(1), m.group(2)) if m else None


def _page(rows: list[dict], start: int, count: int) -> dict:
    start = max(1, start)
    page = rows[start - 1: start - 1 + max(0, count)]
    return {"schemas": [LIST_SCHEMA], "totalResults": len(rows), "startIndex": start, "itemsPerPage": len(page), "Resources": page}


@router.get("/Users")
def list_users(request: Request, filter: str = "", startIndex: int = 1, count: int = 100):  # noqa: A002, N803
    _check(request)
    users = auth._users()
    f = _filter(filter)
    if f:
        attr, val = f
        key = {"username": "username", "externalid": "scim_external_id", "id": "id", "emails": "email"}.get(attr.lower())
        users = [u for u in users if key and str(u.get(key) or "").lower() == val.lower()]
    return _ok(_page([_user_out(u, request) for u in users], startIndex, count))


@router.get("/Users/{uid}")
def get_user(uid: str, request: Request):
    _check(request)
    try:
        return _ok(_user_out(auth._user(uid), request))
    except HTTPException:
        return _err(404, "user not found")


@router.post("/Users")
async def create_user(request: Request):
    _check(request)
    body = await request.json()
    username = str(body.get("userName") or "").strip().lower()
    if not username:
        return _err(400, "userName is required", "invalidValue")
    if any(x["username"] == username for x in auth._users()):
        return _err(409, f"userName {username} already exists", "uniqueness")
    name = body.get("name") or {}
    emails = body.get("emails") or []
    email = next((e.get("value") for e in emails if isinstance(e, dict) and e.get("primary")), None) or (emails[0].get("value") if emails and isinstance(emails[0], dict) else "")
    try:
        u = auth._new_user(username, None, "user", body.get("displayName") or "", first_name=name.get("givenName") or "", last_name=name.get("familyName") or "",
                           email=email or "", sso_only=True)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))
    if body.get("externalId"):
        u["scim_external_id"] = body["externalId"]
    if body.get("active") is False:
        u["disabled"] = True
    auth._save_user(u)
    auth.audit("scim_user_created", u, f"provisioned {username}")
    return _ok(_user_out(auth._user(u["id"]), request), 201)


@router.put("/Users/{uid}")
async def replace_user(uid: str, request: Request):
    _check(request)
    try:
        u = auth._user(uid)
    except HTTPException:
        return _err(404, "user not found")
    body = await request.json()
    try:
        changed = _apply_user(u, body)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail), "uniqueness")
    auth._save_user(u)
    auth.audit("scim_user_updated", u, ", ".join(changed) or "no change")
    return _ok(_user_out(u, request))


@router.patch("/Users/{uid}")
async def patch_user(uid: str, request: Request):
    _check(request)
    try:
        u = auth._user(uid)
    except HTTPException:
        return _err(404, "user not found")
    body = await request.json()
    changed: list[str] = []
    for op in body.get("Operations") or []:
        kind, path, value = str(op.get("op", "")).lower(), op.get("path"), op.get("value")
        if kind not in ("add", "replace", "remove"):
            return _err(400, f"unsupported op {op.get('op')}", "invalidSyntax")
        if path:
            # name.givenName, emails[type eq "work"].value, active …
            p = re.sub(r"\[.*?\]", "", str(path))
            if p.startswith("name."):
                value = {"name": {p[5:]: value}}
            elif p.startswith("emails"):
                value = {"emails": [{"value": value if not isinstance(value, list) else (value[0] or {}).get("value"), "primary": True}]}
            else:
                value = {p: value if kind != "remove" else None}
        if isinstance(value, dict):
            try:
                changed += _apply_user(u, value)
            except HTTPException as e:
                return _err(e.status_code, str(e.detail), "uniqueness")
    auth._save_user(u)
    auth.audit("scim_user_updated", u, ", ".join(changed) or "no change")
    return _ok(_user_out(u, request))


@router.delete("/Users/{uid}")
def delete_user(uid: str, request: Request):
    """Deprovisioning deactivates the user (their resources and audit history stay)."""
    _check(request)
    try:
        u = auth._user(uid)
    except HTTPException:
        return _err(404, "user not found")
    u["disabled"] = True
    auth._save_user(u)
    _end_sessions(uid)
    auth.audit("scim_user_deactivated", u, "deprovisioned")
    return JSONResponse(None, status_code=204)


# ------------------------------------------------------------------------------------------------
# groups
# ------------------------------------------------------------------------------------------------


def _group_out(g: dict, request: Request) -> dict:
    users = {u["id"]: u for u in auth._users()}
    return {"schemas": [GROUP_SCHEMA], "id": g["id"], "externalId": g.get("scim_external_id"), "displayName": g["name"],
            "members": [{"value": m, "display": (users.get(m) or {}).get("username"), "$ref": f"{_base(request)}/Users/{m}"} for m in g.get("members") or []],
            "meta": {"resourceType": "Group", "created": g.get("created_at"), "location": f"{_base(request)}/Groups/{g['id']}"}}


def _group(gid: str) -> Optional[dict]:
    return next((g for g in auth._groups() if g["id"] == gid), None)


def _members(values: Any) -> set[str]:
    known = {u["id"] for u in auth._users()}
    return {str(v.get("value")) for v in values or [] if isinstance(v, dict) and str(v.get("value")) in known}


@router.get("/Groups")
def list_groups(request: Request, filter: str = "", startIndex: int = 1, count: int = 100):  # noqa: A002, N803
    _check(request)
    gs = auth._groups()
    f = _filter(filter)
    if f:
        attr, val = f
        key = {"displayname": "name", "externalid": "scim_external_id", "id": "id"}.get(attr.lower())
        gs = [g for g in gs if key and str(g.get(key) or "").lower() == val.lower()]
    return _ok(_page([_group_out(g, request) for g in gs], startIndex, count))


@router.get("/Groups/{gid}")
def get_group(gid: str, request: Request):
    _check(request)
    g = _group(gid)
    return _ok(_group_out(g, request)) if g else _err(404, "group not found")


@router.post("/Groups")
async def create_group(request: Request):
    _check(request)
    body = await request.json()
    name = str(body.get("displayName") or "").strip()
    if not name:
        return _err(400, "displayName is required", "invalidValue")
    if any(g["name"].lower() == name.lower() for g in auth._groups()):
        return _err(409, f"group {name} already exists", "uniqueness")
    g = {"id": "grp-" + uuid.uuid4().hex[:8], "name": name, "description": "Provisioned by SCIM", "members": sorted(_members(body.get("members"))),
         "markings": [], "managers": [], "created_at": auth._iso(), "scim_external_id": body.get("externalId")}
    auth._put_record("groups", g)
    auth.audit("scim_group_created", None, name)
    return _ok(_group_out(g, request), 201)


@router.put("/Groups/{gid}")
async def replace_group(gid: str, request: Request):
    _check(request)
    g = _group(gid)
    if not g:
        return _err(404, "group not found")
    body = await request.json()
    if body.get("displayName"):
        g["name"] = body["displayName"].strip()
    if "members" in body:
        g["members"] = sorted(_members(body.get("members")))
    auth._put_record("groups", g)
    auth.audit("scim_group_updated", None, g["name"])
    return _ok(_group_out(g, request))


@router.patch("/Groups/{gid}")
async def patch_group(gid: str, request: Request):
    _check(request)
    g = _group(gid)
    if not g:
        return _err(404, "group not found")
    body = await request.json()
    members = set(g.get("members") or [])
    for op in body.get("Operations") or []:
        kind, path, value = str(op.get("op", "")).lower(), str(op.get("path") or ""), op.get("value")
        if path.startswith("members") or (not path and isinstance(value, dict) and "members" in value):
            vals = value.get("members") if isinstance(value, dict) else value
            m = re.search(r'value\s+eq\s+"([^"]+)"', path)
            if kind == "add":
                members |= _members(vals)
            elif kind == "remove":
                members -= {m.group(1)} if m else (_members(vals) if vals else set(members))
            elif kind == "replace":
                members = _members(vals)
        elif path == "displayName" or (isinstance(value, dict) and value.get("displayName")):
            g["name"] = str(value if path == "displayName" else value["displayName"]).strip()
        elif path == "externalId":
            g["scim_external_id"] = value
    g["members"] = sorted(members)
    auth._put_record("groups", g)
    auth.audit("scim_group_updated", None, f"{g['name']}: {len(members)} members")
    return _ok(_group_out(g, request))


@router.delete("/Groups/{gid}")
def delete_group(gid: str, request: Request):
    _check(request)
    if not _group(gid):
        return _err(404, "group not found")
    with auth._lock, auth._db() as con:
        con.execute("DELETE FROM groups WHERE id = ?", (gid,))
    auth._cache.clear()
    auth.audit("scim_group_deleted", None, gid)
    return JSONResponse(None, status_code=204)


# ------------------------------------------------------------------------------------------------
# discovery
# ------------------------------------------------------------------------------------------------


@router.get("/ServiceProviderConfig")
def service_provider_config():
    return _ok({"schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"], "patch": {"supported": True}, "bulk": {"supported": False},
                "filter": {"supported": True, "maxResults": 1000}, "changePassword": {"supported": False}, "sort": {"supported": False},
                "etag": {"supported": False}, "authenticationSchemes": [{"type": "oauthbearertoken", "name": "Bearer token", "primary": True}]})


@router.get("/ResourceTypes")
def resource_types():
    return _ok({"schemas": [LIST_SCHEMA], "totalResults": 2, "Resources": [
        {"schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], "id": "User", "name": "User", "endpoint": "/Users", "schema": USER_SCHEMA},
        {"schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], "id": "Group", "name": "Group", "endpoint": "/Groups", "schema": GROUP_SCHEMA}]})


@router.get("/Schemas")
def schemas():
    return _ok({"schemas": [LIST_SCHEMA], "totalResults": 2, "Resources": [{"id": USER_SCHEMA, "name": "User"}, {"id": GROUP_SCHEMA, "name": "Group"}]})


# ------------------------------------------------------------------------------------------------
# the SCIM token (administrators)
# ------------------------------------------------------------------------------------------------


@admin.get("")
def scim_info(request: Request) -> dict:
    auth.require_admin()
    rec = _token_record()
    return {"base_url": f"{auth.api_public_url()}/scim/v2", "token": {"created_at": rec["created_at"], "prefix": rec["prefix"]} if rec else None}


@admin.post("/token")
def new_token(request: Request) -> dict:
    """A new SCIM bearer token (shown once; the previous one stops working)."""
    auth.require_admin()
    token = "bsai_scim_" + secrets.token_urlsafe(32)
    rec = {"hash": _sha(token), "created_at": auth._iso(), "prefix": token[:14]}
    with auth._lock, auth._db() as con:
        con.execute("INSERT INTO settings (key, value) VALUES ('scim_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(rec),))
    auth.audit("scim_token_created", None, rec["prefix"], request)
    return {**scim_info(request), "secret": token}


@admin.delete("/token")
def revoke_token(request: Request) -> dict:
    auth.require_admin()
    with auth._lock, auth._db() as con:
        con.execute("DELETE FROM settings WHERE key = 'scim_token'")
    auth.audit("scim_token_revoked", None, "", request)
    return scim_info(request)
