"""Sign-in, users, API tokens and security markings.

* Users sign in with a username and password (scrypt hashes); the API sets an HTTP-only session cookie
  (BSAI_SESSION, 14 days, renewed while used). Scripts use personal API tokens: Authorization: Bearer bsai_pat_….
  The first start has no users: the sign-in page creates the first administrator (POST /api/auth/setup).
* Every /api request needs a signed-in user except the sign-in endpoints and the endpoints external systems call
  with their own secrets (stream proxy pushes, listener inbound URLs, shared links). The web server's build runner
  uses a service token the API hands it with each build (SERVICE_TOKEN).
* Markings (Palantir's mandatory controls): an administrator defines markings and which users hold them. A file,
  dataset, pipeline or folder can carry markings; the markings of a folder apply to everything in it, and outputs
  built by pipelines inherit the markings of their inputs and of the pipeline (propagated down the lineage). A user
  must hold every marking on an item (and its folders) to see or read it: items they cannot access are left out of
  listings and refused (403). Applying or removing a marking needs holding it.
* User management follows Palantir's Control Panel: users have a profile (first and last name, email, an
  organization, free attributes) and a status (active / deactivated); groups collect users, and markings can be
  granted to a group as well as to a user; every organization is also a marking its members hold (resources can be
  restricted to an organization). A user's markings are their own, their groups' and their organization's.
  Sign-ins, sign-outs, failures and account changes are kept in an audit log (Sign-in activity); users see and
  revoke their own sessions and API tokens on their Account page.
* Administrators manage users, groups, organizations, markings and their members; they are still subject to
  markings on data.
* BLUESANDAI_AUTH=off turns all of this off (development). Background work (schedules, syncs, health checks) and the
  service token act as the system and are not restricted.
* Security settings (Control Panel → Security; `settings` table, defaults below): password policy (length, character
  classes, common passwords, no reuse of the last N, expiry), idle timeout (a session ends after N minutes without
  activity: page interaction reported by the browser's heartbeat, or a change made through the API), session length,
  two-factor requirement for administrators or everyone, sign-in attempt limits per username and per IP address,
  invitation and reset link lifetimes, single sign-on provisioning, and the default role new Projects give everyone.
* Forgot password: a reset link by email (mailer.py, SMTP); administrators can also make a link for a user. Users can
  be invited by email: they pick their own password (and name) from the link. Passwords set by an administrator must
  be changed at the next sign-in.
* Two-factor authentication (auth_mfa.py): TOTP authenticator apps plus recovery codes. When required and not set up,
  sign-in gives a session that can only set it up.
* Single sign-on (auth_sso.py): OpenID Connect (Google, Microsoft Entra ID, Okta, any OIDC provider) and SAML 2.0.
* Project roles: Owner, Editor, Viewer per Project, for users, groups or everyone; Viewer reads, Editor changes
  (files, pipelines, schedules, builds), Owner also manages roles. A Project without roles was open to everyone as
  an Editor before 2026-10-12; now it is closed to everyone but administrators. A new Project gives its creator Owner
  and everyone the default role (none by default).
  Administrators are Owners of every Project.
* Markings also apply to streams, streaming syncs, object types, vector indexes and code repositories (resource ids
  "<kind>:<id>", checked by the modules that own them).
* Job tokens: a build of a Python or Java transform gets a short-lived token for the user who started it
  (BLUESANDAI_API_TOKEN), so transform code can call the API with that user's access.

Store: auth_store.py — data/auth/auth.sqlite, or PostgreSQL (BLUESANDAI_AUTH_STORE=postgres). Mounted by server.py
under /api/auth; the middleware is `middleware`.
"""

from __future__ import annotations

import base64
import binascii
import contextvars
import hashlib
import hmac
import json
import logging
import os
import secrets
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import auth_mfa
import auth_store
import mailer
import rate_limits

log = logging.getLogger("bluesandai.auth")
router = APIRouter(prefix="/api/auth")

COOKIE = os.environ.get("BLUESANDAI_SESSION_COOKIE") or "BSAI_SESSION"  # instance.env: AI JKN Audit beside the platform
SESSION_DAYS = 14
TOKEN_PREFIX = "bsai_pat_"
JOB_PREFIX = "bsai_job_"
# OAuth2 access tokens of Developer Console applications (developer_console.py resolves them to (user id, app id))
OAUTH_PREFIX = "bsai_oat_"
OAUTH_HOOK = None
# an application's enablement restrictions (developer_console.restrictions): fn(app id) -> {projects, markings}
APP_RESTRICTIONS_HOOK = None
def _env_local(key: str) -> str:
    """A value from the repo's .env.local (git-ignored, beside the API keys); "" when absent."""
    try:
        for line in (Path(__file__).resolve().parent.parent / ".env.local").read_text(encoding="utf-8").splitlines():
            k, sep, v = line.strip().partition("=")
            if sep and k.strip() == key and not k.startswith("#"):
                return v.strip().strip("\"'")
    except OSError:
        pass
    return ""


# the build runner in the web server presents this (handed over with each build). Set in the environment or
# .env.local it is fixed, so the platform's own scripts (same machine) can queue builds the live API dispatches;
# otherwise one per API process
SERVICE_TOKEN = (os.environ.get("BLUESANDAI_SERVICE_TOKEN") or _env_local("BLUESANDAI_SERVICE_TOKEN")
                 or "bsai_svc_" + secrets.token_urlsafe(32))
# endpoints that need no signed-in user: sign-in itself, and callers with their own secrets
PUBLIC = (
    "/api/auth/status",
    "/api/auth/policy",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/auth/logout",
    "/api/auth/password/",
    "/api/auth/invitations/",
    "/api/auth/sso/",
    "/api/streaming/stream-proxy/",
    # token-only pushes to the old pipeline streams (pipeline_runtime.py refuses a caller without the stream's token)
    "/api/pipeline/stream-push/",
    # Jupyter workspace pods: code_workspaces.py checks the pod secret and acts as the workspace owner
    "/api/code-workspace-pod/",
    "/api/listen/",
    "/api/drive/shared/",
    # published public Slate applications and their secure uploads (slate.py checks the upload token)
    "/api/slate/public/",
    # OAuth2: the token endpoint (clients authenticate themselves) and hosted Developer Console websites
    "/api/oauth2/token",
    "/api/oauth2/authorize",
    "/api/oauth2/revoke",
    "/api/dc-hosting/",
    # Pilot previews (pilot.py checks the signed preview link; seed data only)
    "/api/pilot/preview/",
    # custom widget files for their opaque-origin iframes (custom_widgets.py checks the signed link)
    "/api/widget-assets/",
    # the Iceberg catalog's OAuth2 client credentials exchange (iceberg_rest.py checks the client secret)
    "/api/iceberg/v1/oauth/tokens",
    # search keys (vectors.py checks the key itself)
    "/api/vectors/v1/search",
    # peer enrollments (peering.py checks the network connection's secret)
    "/api/peering/remote/",
    # Data Connection agents (dc_agents.py checks the agent token)
    "/api/dc-agents/connect",
    # hospital systems sending claims to the realtime fraud engine (aip/realtime/integrasi.check_token: the ingest token)
    "/api/aip/realtime/v1/faskes/klaim",
    # their processing status, the auditor's requests for supporting documents and their replies (same token)
    "/api/aip/realtime/v1/faskes/permintaan",
    # the pre-check of a draft before submission: documents a verifier will look for, never a score (same token)
    "/api/aip/realtime/v1/faskes/precheck",
)
# resources outside Files whose markings are checked by their URL (the modules also check them in code)
RESOURCE_PATHS = (
    (re.compile(r"^/api/vectors/indexes/([^/]+)"), "vector_index"),
    (re.compile(r"^/api/code-repos/(?!tools/)([^/]+)"), "code_repo"),
    (re.compile(r"^/api/streaming/streams/([^/]+)"), "stream"),
    (re.compile(r"^/api/streaming/syncs/([^/]+)"), "stream_sync"),
    (re.compile(r"^/api/ontology/object-types/([^/]+)"), "object_type"),
    (re.compile(r"^/api/timeseries/syncs/(?!preview$|register$)([^/]+)"), "timeseries_sync"),
)
# what a session that must first set up two-factor authentication may call
ENROLL_ONLY = ("/api/auth/status", "/api/auth/policy", "/api/auth/me", "/api/auth/logout", "/api/auth/heartbeat")

DB_PATH: Path = Path()
_lock = threading.RLock()
# failed attempts per key ("user:<name>", "ip:<address>", "reset:<ip>" …) are counted by rate_limits.py

# who the current request acts for: None = the system (background work, auth off)
_principal: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("bsai_principal", default=None)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, agent TEXT);
CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS markings (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS marking_categories (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS custom_roles (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, user_id TEXT, username TEXT, actor TEXT, ip TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
CREATE TABLE IF NOT EXISTS item_markings (item_id TEXT PRIMARY KEY, own TEXT NOT NULL DEFAULT '[]', inherited TEXT NOT NULL DEFAULT '[]', updated_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, record TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS user_secrets (user_id TEXT PRIMARY KEY, mfa_secret TEXT, mfa_pending TEXT, recovery TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS password_history (user_id TEXT NOT NULL, pw_hash TEXT NOT NULL, changed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_roles (project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (project_id, principal_type, principal_id));
CREATE TABLE IF NOT EXISTS item_roles (item_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (item_id, principal_type, principal_id));
CREATE TABLE IF NOT EXISTS job_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, label TEXT);
CREATE TABLE IF NOT EXISTS markings_version (id INTEGER PRIMARY KEY, v BIGINT NOT NULL);
"""
# columns added to tables of earlier versions
MIGRATIONS = ("ALTER TABLE sessions ADD COLUMN last_active_at TEXT", "ALTER TABLE sessions ADD COLUMN scope TEXT DEFAULT 'full'",
              "ALTER TABLE sessions ADD COLUMN ip TEXT", "ALTER TABLE sessions ADD COLUMN method TEXT",
              "ALTER TABLE sessions ADD COLUMN emulation TEXT")


def enabled() -> bool:
    return os.environ.get("BLUESANDAI_AUTH", "on").lower() not in ("off", "0", "false", "no")


def configure(data_dir: Path) -> None:
    global DB_PATH
    d = data_dir / "auth"
    d.mkdir(parents=True, exist_ok=True)
    DB_PATH = d / "auth.sqlite"
    auth_store.configure(DB_PATH, SCHEMA)
    for stmt in MIGRATIONS:
        try:
            with _db() as con:
                con.execute(stmt)
        except Exception:  # noqa: BLE001 - the column exists already
            pass


@contextmanager
def _db() -> Iterator[Any]:
    with auth_store.connect() as con:
        yield con


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ------------------------------------------------------------------------------------------------
# passwords and users
# ------------------------------------------------------------------------------------------------


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, dk = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), dk)
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------------------------------------------
# security settings (Control Panel → Security)
# ------------------------------------------------------------------------------------------------


def _int_env(key: str, default: int) -> int:
    try:
        return int(mailer.env(key, str(default)))
    except ValueError:
        return default


def default_settings() -> dict[str, Any]:
    return {
        # passwords
        "password_min_length": _int_env("BLUESANDAI_PASSWORD_MIN_LENGTH", 8),
        "password_require_upper": False,
        "password_require_lower": False,
        "password_require_digit": False,
        "password_require_symbol": False,
        "password_block_common": True,
        "password_history": 5,
        "password_max_age_days": 0,
        # sessions
        "session_days": SESSION_DAYS,
        "idle_timeout_minutes": _int_env("BLUESANDAI_IDLE_TIMEOUT_MINUTES", 60),
        # two-factor authentication
        "mfa_required_admins": False,
        "mfa_required_all": False,
        # sign-in attempts (failures in the window)
        "login_max_per_user": 10,
        "login_max_per_ip": 30,
        "login_window_minutes": 15,
        # links
        "invite_days": 7,
        "reset_minutes": 60,
        # single sign-on: create accounts on first sign-in (only for these email domains, if any)
        "sso_auto_create": False,
        "sso_allowed_domains": [],
        "sso_default_role": "user",
        # identity provider claims / SAML attributes copied into user attributes at each single sign-on (row policies of
        # restricted views and objects compare them), e.g. department, region, clearance
        "sso_attribute_claims": [],
        # off: users sign in with single sign-on only (administrators can still use their password)
        "password_login": True,
        # what everyone gets on a new Project ("none": only its creator, an Owner)
        "project_default_role": "none",
        # who may author or run code on this machine (Code Repositories, Code Workbooks, Code Workspaces, function
        # previews, packages): "admins", "groups" (administrators and the groups below) or "everyone"
        "code_execution": "admins",
        "code_execution_groups": [],
        # classification-based access controls: every new Project needs a classification marking
        "require_project_classification": False,
        # Files items outside any Project: "creator" (theirs and administrators') or "everyone" (every signed-in user)
        "files_outside_projects": "creator",
        # users who have not signed in for this many days are inactive: their API and application tokens stop working
        # until they sign in again (schedules keep running); 0 turns it off
        "inactive_days": 30,
    }


SETTING_LIMITS = {"inactive_days": (0, 3650), "password_min_length": (6, 128), "password_history": (0, 24), "password_max_age_days": (0, 3650), "session_days": (1, 365),
                  "idle_timeout_minutes": (0, 7 * 24 * 60), "login_max_per_user": (3, 1000), "login_max_per_ip": (3, 10000),
                  "login_window_minutes": (1, 1440), "invite_days": (1, 90), "reset_minutes": (5, 7 * 24 * 60)}
_settings_cache: tuple[float, dict] = (0.0, {})


def settings() -> dict[str, Any]:
    global _settings_cache
    if time.time() - _settings_cache[0] < 5:
        return _settings_cache[1]
    out = default_settings()
    try:
        with _db() as con:
            for k, v in con.execute("SELECT key, value FROM settings").fetchall():
                if k in out:
                    out[k] = json.loads(v)
    except Exception:  # noqa: BLE001 - not configured yet: the defaults
        return out
    _settings_cache = (time.time(), out)
    return out


def _session_seconds() -> int:
    return int(settings()["session_days"]) * 86400


COMMON_PASSWORDS = {
    "password", "password1", "password123", "passw0rd", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwerty123",
    "qwertyuiop", "abc123", "111111", "000000", "iloveyou", "admin", "admin123", "administrator", "welcome", "welcome1",
    "letmein", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "trustno1", "changeme", "secret",
    "bluesand", "bluesandai", "palantir", "foundry", "p@ssw0rd", "p@ssword", "zaq12wsx", "1q2w3e4r", "asdfghjkl", "superman",
}


def policy() -> dict[str, Any]:
    st = settings()
    return {k: st[k] for k in ("password_min_length", "password_require_upper", "password_require_lower", "password_require_digit",
                               "password_require_symbol", "password_block_common", "password_history", "password_max_age_days")}


def password_problems(pw: str, user: Optional[dict] = None) -> list[str]:
    """What a password must do but does not (\"have at least 10 characters\", \"not be a common password\" …); empty: fine."""
    st = settings()
    out = []
    if len(pw) < int(st["password_min_length"]):
        out.append(f"have at least {st['password_min_length']} characters")
    if st["password_require_upper"] and not re.search(r"[A-Z]", pw):
        out.append("contain an upper-case letter")
    if st["password_require_lower"] and not re.search(r"[a-z]", pw):
        out.append("contain a lower-case letter")
    if st["password_require_digit"] and not re.search(r"\d", pw):
        out.append("contain a digit")
    if st["password_require_symbol"] and not re.search(r"[^A-Za-z0-9]", pw):
        out.append("contain a symbol")
    low = pw.lower()
    if st["password_block_common"] and (low in COMMON_PASSWORDS or re.sub(r"[\d!@#$%^&*.]+$", "", low) in COMMON_PASSWORDS):
        out.append("not be a common password")
    if user:
        for part in (user.get("username"), (user.get("email") or "").split("@")[0]):
            if part and len(part) >= 3 and part.lower() in low:
                out.append("not contain your username or email")
                break
        n = int(st["password_history"])
        if n and user.get("id"):
            with _db() as con:
                rows = con.execute("SELECT pw_hash FROM password_history WHERE user_id = ? ORDER BY changed_at DESC LIMIT ?", (user["id"], n)).fetchall()
                cur = con.execute("SELECT pw_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
            hashes = [r[0] for r in rows] + ([cur[0]] if cur else [])
            if any(verify_password(pw, h) for h in hashes if h and h != "!"):
                out.append(f"not be one of your last {n} passwords")
    return out


def _check_password(pw: str, user: Optional[dict] = None) -> None:
    problems = password_problems(pw, user)
    if problems:
        raise HTTPException(400, "The password must " + ", ".join(problems[:-1]) + (" and " if len(problems) > 1 else "") + problems[-1])


def _set_password(user: dict, pw: str, must_change: bool = False) -> None:
    """Store a new password (after the policy check): the old one goes into the history."""
    with _db() as con:
        cur = con.execute("SELECT pw_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    if cur and cur[0] and cur[0] != "!":
        with _lock, _db() as con:
            con.execute("INSERT INTO password_history (user_id, pw_hash, changed_at) VALUES (?, ?, ?)", (user["id"], cur[0], _iso()))
            con.execute("DELETE FROM password_history WHERE user_id = ? AND changed_at < (SELECT MIN(changed_at) FROM "
                        "(SELECT changed_at FROM password_history WHERE user_id = ? ORDER BY changed_at DESC LIMIT 24) recent)", (user["id"], user["id"]))
    user["password_changed_at"] = _iso()
    user["must_change_password"] = must_change
    user.pop("invited", None)
    _save_user(user, hash_password(pw))


def password_expired(u: dict) -> bool:
    if u.get("must_change_password"):
        return True
    days = int(settings()["password_max_age_days"])
    if not days or u.get("sso_only"):
        return False
    changed = u.get("password_changed_at") or u.get("created_at")
    return bool(changed) and changed < _iso(_now() - timedelta(days=days))


def mfa_required(u: dict) -> bool:
    st = settings()
    return bool(st["mfa_required_all"] or (st["mfa_required_admins"] and u.get("role") == "admin"))


# -- attempt limits --


# kept in PostgreSQL when it is configured (shared by every API process, kept over restarts; counted in this
# process's memory while the database cannot be reached), else in memory: rate_limits.py


def _attempts(key: str) -> int:
    return rate_limits.failures(key, int(settings()["login_window_minutes"]) * 60)


def _limit(key: str, maximum: int, what: str = "Too many failed sign-ins") -> None:
    if _attempts(key) >= maximum:
        raise HTTPException(429, f"{what}: try again in {settings()['login_window_minutes']} minutes")


def _count(key: str) -> None:
    rate_limits.fail(key, int(settings()["login_window_minutes"]) * 60)


def _ip(request: Optional[Request]) -> str:
    """The caller's address; behind a proxy, the first X-Forwarded-For hop when BLUESANDAI_TRUST_PROXY=1."""
    if request is None:
        return ""
    if mailer.env("BLUESANDAI_TRUST_PROXY") in ("1", "on", "true"):
        fwd = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if fwd:
            return fwd
    return request.client.host if request.client else ""


def _users() -> list[dict]:
    with _db() as con:
        return [json.loads(r) for (r,) in con.execute("SELECT record FROM users").fetchall()]


def _user(user_id: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    return json.loads(row[0])


def _save_user(u: dict, pw_hash: Optional[str] = None) -> None:
    with _lock, _db() as con:
        if pw_hash is None:
            con.execute("UPDATE users SET record = ?, username = ? WHERE id = ?", (json.dumps(u), u["username"], u["id"]))
        else:
            con.execute(
                "INSERT INTO users (id, username, pw_hash, record) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, "
                "pw_hash = excluded.pw_hash, record = excluded.record",
                (u["id"], u["username"], pw_hash, json.dumps(u)),
            )


USER_FIELDS = ("id", "username", "display_name", "first_name", "last_name", "email", "organization_id", "attributes", "role", "markings",
               "disabled", "created_at", "last_login_at", "last_login_ip", "mfa_enabled", "password_changed_at", "must_change_password",
               "identities", "invited_at")


def is_inactive(u: dict) -> bool:
    """Not signed in for `inactive_days` (Control Panel → Security); service users and exempted users never are."""
    days = int(settings().get("inactive_days") or 0)
    if not days or u.get("exempt_from_inactivity") or (u.get("attributes") or {}).get("service_user_of") or u.get("invited"):
        return False
    last = u.get("last_login_at") or u.get("created_at") or ""
    return bool(last) and last < _iso(_now() - timedelta(days=days))


def _public_user(u: dict) -> dict:
    out = {k: u.get(k) for k in USER_FIELDS}
    out["inactive"] = is_inactive(u)
    out["exempt_from_inactivity"] = bool(u.get("exempt_from_inactivity"))
    out["attributes"] = out["attributes"] or {}
    out["groups"] = sorted(groups_of(u["id"]))
    out["status"] = "deactivated" if u.get("disabled") else "invited" if u.get("invited") else "active"
    out["mfa_enabled"] = bool(u.get("mfa_enabled"))
    out["identities"] = [{"provider": i.get("provider"), "email": i.get("email")} for i in u.get("identities") or []]
    return out


def _groups() -> list[dict]:
    """Every group; memberships past their expiry are removed (and written back) as they are read."""
    with _db() as con:
        rows = [json.loads(r) for (r,) in con.execute("SELECT record FROM groups").fetchall()]
    now = _iso()
    soon = _iso(_now() + timedelta(days=7))
    notices: list[tuple[str, str, str]] = []
    for g in rows:
        exp = g.get("member_expiry") or {}
        gone = {u for u, at in exp.items() if at and at < now}
        due = {u for u, at in exp.items() if at and now <= at <= soon and (g.get("expiry_reminded") or {}).get(u) != at}
        if gone or due:
            g["members"] = [m for m in g.get("members") or [] if m not in gone]
            g["member_expiry"] = {u: at for u, at in exp.items() if u not in gone}
            notices += _membership_notices(g, gone)
            with _lock, _db() as con:
                con.execute("UPDATE groups SET record = ? WHERE id = ?", (json.dumps(g), g["id"]))
            for u in sorted(gone):
                audit("group_membership_expired", None, f"{g['name']}: {u}")
    _deliver_notices(notices)
    return rows


def groups_of(user_id: str, groups: Optional[list[dict]] = None) -> set[str]:
    """The groups a user is in: directly, and through groups nested in other groups (member_groups)."""
    gs = groups if groups is not None else _groups()
    out = {g["id"] for g in gs if user_id in (g.get("members") or [])}
    changed = True
    while changed:
        changed = False
        for g in gs:
            if g["id"] not in out and set(g.get("member_groups") or []) & out:
                out.add(g["id"])
                changed = True
    return out


def group_members(g: dict, groups: Optional[list[dict]] = None) -> set[str]:
    """A group's users: its own members and those of the groups nested in it (transitively)."""
    gs = {x["id"]: x for x in (groups if groups is not None else _groups())}
    seen, todo, out = set(), [g["id"]], set()
    while todo:
        gid = todo.pop()
        if gid in seen or gid not in gs:
            continue
        seen.add(gid)
        out |= set(gs[gid].get("members") or [])
        todo += list(gs[gid].get("member_groups") or [])
    return out


def sync_realm_groups(user_id: str, provider: str, external: Optional[list[str]]) -> None:
    """Groups bound to an identity provider's groups (realm): at each single sign-on the user joins those whose
    external group they are in and leaves the others of that provider. None (the provider sent no groups) changes
    nothing."""
    if external is None:
        return
    have = {str(x).strip().lower() for x in external if str(x).strip()}
    for g in _groups():
        realm = g.get("realm") or {}
        if not realm.get("name") or realm.get("provider") not in (provider, "*"):
            continue
        members = set(g.get("members") or [])
        want = realm["name"].strip().lower() in have
        if want != (user_id in members):
            g["members"] = sorted(members | {user_id} if want else members - {user_id})
            _put_record("groups", g)
            audit("group_synced", None, f"{g['name']}: {'joined' if want else 'left'} {user_id} ({provider})")


def _orgs() -> list[dict]:
    with _db() as con:
        return [json.loads(r) for (r,) in con.execute("SELECT record FROM organizations").fetchall()]


def org_marking(org_id: str) -> str:
    return f"org:{org_id}"


def user_markings(u: dict) -> set[str]:
    """A user's markings: granted to them, to their groups, and their organization's."""
    out = set(u.get("markings") or [])
    gs = _groups()
    mine = groups_of(u["id"], gs)
    for g in gs:
        if g["id"] in mine:
            out |= set(g.get("markings") or [])
    if u.get("organization_id"):
        out.add(org_marking(u["organization_id"]))
    for o in _orgs():
        if u["id"] in (o.get("guests") or []):
            out.add(org_marking(o["id"]))
    return out


def _known_markings() -> set[str]:
    return {m["id"] for m in _markings()} | {org_marking(o["id"]) for o in _orgs()}


def audit(event: str, user: Optional[dict] = None, detail: str = "", request: Optional[Request] = None, username: Optional[str] = None) -> None:
    """One line of the sign-in activity log (sign-ins, failures, account and access changes)."""
    actor = current()
    ip = (request.client.host if request and request.client else None) if request else None
    try:
        with _lock, _db() as con:
            con.execute("INSERT INTO audit (at, event, user_id, username, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (_iso(), event, (user or {}).get("id"), username or (user or {}).get("username"),
                         (actor or {}).get("username") if actor else None, ip, detail[:500]))
            con.execute("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 20000")
    except Exception:  # noqa: BLE001 - auditing never fails the request
        log.exception("audit write failed")
    try:
        import audit3

        audit3.from_auth(event, user, detail, username)
    except Exception:  # noqa: BLE001
        log.exception("audit.3 write failed")


def _new_user(username: str, password: Optional[str], role: str, display_name: str = "", markings: Optional[list[str]] = None, **profile: Any) -> dict:
    """A new user; password None: none yet (invited, or single sign-on only)."""
    name = username.strip().lower()
    if not name or not all(c.isalnum() or c in "._-@" for c in name):
        raise HTTPException(400, "Usernames use letters, digits and . _ - @")
    if password is not None:
        _check_password(password, {"username": name, "email": profile.get("email") or ""})
    with _db() as con:
        if con.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise HTTPException(409, f"User {name} already exists")
    first, last = (profile.get("first_name") or "").strip(), (profile.get("last_name") or "").strip()
    u = {"id": "u-" + uuid.uuid4().hex[:10], "username": name, "display_name": display_name.strip() or " ".join(x for x in (first, last) if x) or name,
         "first_name": first, "last_name": last, "email": (profile.get("email") or "").strip(), "organization_id": profile.get("organization_id") or None,
         "attributes": profile.get("attributes") or {}, "role": role, "markings": sorted(set(markings or [])), "disabled": False,
         "created_at": _iso(), "last_login_at": None, "password_changed_at": _iso() if password else None,
         "must_change_password": bool(profile.get("must_change_password")), "identities": profile.get("identities") or []}
    if profile.get("invited"):
        u.update(invited=True, invited_at=_iso())
    if profile.get("sso_only"):
        u["sso_only"] = True
    # "!" is no password: nothing verifies against it
    _save_user(u, hash_password(password) if password else "!")
    return u


# ------------------------------------------------------------------------------------------------
# who is calling
# ------------------------------------------------------------------------------------------------


def current() -> Optional[dict]:
    """The signed-in user of this request ({id, username, role, markings}); None for the system."""
    return _principal.get()


def _principal_for(request: Request) -> Optional[dict]:
    header = request.headers.get("authorization", "")
    bearer = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if header.lower().startswith("basic "):
        # Git clients (code_git.py): any user name, a personal API token as the password
        try:
            user_pass = base64.b64decode(header[6:].strip()).decode("utf-8", "replace")
        except (ValueError, binascii.Error):
            user_pass = ""
        _, _, password = user_pass.partition(":")
        bearer = password if password.startswith(TOKEN_PREFIX) else ""
    if bearer and hmac.compare_digest(bearer, SERVICE_TOKEN):
        return {"id": "system", "username": "system", "role": "service", "markings": None, "service": True}
    scope, method, via, emulation = "full", "token", "token", None
    if bearer.startswith(OAUTH_PREFIX):
        hit = OAUTH_HOOK(bearer) if OAUTH_HOOK else None
        if not hit:
            return None
        with _db() as con:
            urow = con.execute("SELECT record FROM users WHERE id = ?", (hit[0],)).fetchone()
        if not urow or json.loads(urow[0]).get("disabled"):
            return None
        if is_inactive(json.loads(urow[0])):
            request.state.auth_reason = "The user has not signed in for a while: their application tokens work again after they sign in"
            return None
        # an application's token: the OSDK API only, within the application's scopes (osdk_api.py), limited to the
        # Projects and markings of its enablement settings
        marks = user_markings(json.loads(urow[0]))
        lim = APP_RESTRICTIONS_HOOK(hit[1]) if APP_RESTRICTIONS_HOOK else {}
        if lim.get("markings") is not None:
            marks = {m for m in marks if m in set(lim["markings"]) or m.startswith("org:")}
        return {**_public_user(json.loads(urow[0])), "markings": marks, "service": False, "scope": f"oauth:{hit[1]}", "method": "oauth",
                "project_scope": lim.get("projects")}
    with _db() as con:
        if bearer.startswith(JOB_PREFIX):
            # a transform build acting for the user who started it
            row = con.execute("SELECT user_id, expires_at, label FROM job_tokens WHERE token_hash = ?", (_sha(bearer),)).fetchone()
            if not row or row[1] < _iso():
                return None
            user_id = row[0]
            # a Node-RED workspace's platform nodes: only its /api/nodered-platform/<workspace>/ endpoints (middleware)
            if (row[2] or "").startswith("nodered:"):
                scope = row[2]
        elif bearer.startswith(TOKEN_PREFIX):
            row = con.execute("SELECT user_id, id, record FROM tokens WHERE token_hash = ?", (_sha(bearer),)).fetchone()
            if not row:
                return None
            rec = json.loads(row[2])
            if rec.get("expires_at") and rec["expires_at"] < _iso() or rec.get("disabled"):
                return None
            owner = con.execute("SELECT record FROM users WHERE id = ?", (row[0],)).fetchone()
            if owner and is_inactive(json.loads(owner[0])):
                request.state.auth_reason = "You have not signed in for a while: sign in to the platform to reactivate your API tokens"
                return None
            rec["last_used_at"] = _iso()
            con.execute("UPDATE tokens SET record = ? WHERE id = ?", (json.dumps(rec), row[1]))
            user_id = row[0]
        else:
            cookie = request.cookies.get(COOKIE)
            if not cookie or _cookieless(request):
                return None
            h = _sha(cookie)
            via = "cookie"
            row = con.execute("SELECT user_id, expires_at, last_active_at, scope, method, emulation FROM sessions WHERE token_hash = ?", (h,)).fetchone()
            if not row or row[1] < _iso():
                return None
            user_id, scope, method = row[0], row[3] or "full", row[4] or "password"
            emulation = json.loads(row[5]) if row[5] else None
            # idle timeout: no activity (page interaction heartbeats, or changes) for too long ends the session
            idle = int(settings()["idle_timeout_minutes"])
            last = row[2] or row[1]
            if idle and row[2] and last < _iso(_now() - timedelta(minutes=idle)):
                con.execute("DELETE FROM sessions WHERE token_hash = ?", (h,))
                request.state.auth_reason = f"You were signed out after {idle} minute{'' if idle == 1 else 's'} without activity"
                return None
            if request.method not in ("GET", "HEAD", "OPTIONS") and (not row[2] or row[2] < _iso(_now() - timedelta(seconds=30))):
                con.execute("UPDATE sessions SET last_active_at = ? WHERE token_hash = ?", (_iso(), h))
            # sliding expiry: renewed once a day while used
            renew = _now() + timedelta(seconds=_session_seconds())
            if row[1] < _iso(renew - timedelta(days=1)):
                con.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (_iso(renew), h))
        urow = con.execute("SELECT record FROM users WHERE id = ?", (user_id,)).fetchone()
    if not urow:
        return None
    u = json.loads(urow[0])
    if u.get("disabled"):
        return None
    out = {**_public_user(u), "markings": user_markings(u), "service": False, "scope": scope, "method": method, "via": via}
    return _emulated(out, u, emulation) if emulation else out


async def middleware(request: Request, call_next):  # noqa: ANN001, ANN201
    """Requires a signed-in user (session cookie or API token) on /api requests, and records who it is."""
    path = request.url.path
    if not enabled() or request.method == "OPTIONS" or not path.startswith("/api/"):
        return await call_next(request)
    principal = _principal_for(request)
    if principal is None and not path.startswith(PUBLIC):
        reason = getattr(request.state, "auth_reason", None)
        # Git asks for credentials (a personal API token as the password) when challenged
        challenge = {"WWW-Authenticate": 'Basic realm="BluesandAI Git"'} if path.startswith("/api/git/") else None
        return JSONResponse({"detail": reason or "Sign in to use BluesandAI", "code": "idle_timeout" if reason else "unauthenticated"}, status_code=401,
                            headers=challenge)
    if principal and str(principal.get("scope") or "").startswith("oauth:") and not path.startswith(("/api/v2/", "/api/oauth2/")):
        return JSONResponse({"detail": "application tokens reach the OSDK API (/api/v2) only", "code": "oauth_scope"}, status_code=403)
    if principal and str(principal.get("scope") or "").startswith("nodered:") and not path.startswith(f"/api/nodered-platform/{principal['scope'][8:]}/"):
        return JSONResponse({"detail": "Node-RED's platform token reaches its workspace's platform nodes only", "code": "nodered_scope"}, status_code=403)
    if principal and principal.get("scope") == "enroll" and not path.startswith(ENROLL_ONLY) and not path.startswith(PUBLIC):
        return JSONResponse({"detail": "Set up two-factor authentication first (Account → Two-factor authentication)", "code": "mfa_enrollment_required"},
                            status_code=403)
    if principal and not principal.get("service"):
        for pattern, kind in RESOURCE_PATHS:
            m = pattern.match(path)
            if m:
                need = resource_effective(kind, m.group(1))
                missing = sorted(missing_markings(need, principal.get("markings")))
                if missing:
                    return JSONResponse({"detail": f"You need the marking{'s' if len(missing) > 1 else ''} {', '.join(_marking_names(missing))} to access this "
                                                   f"{RESOURCE_KINDS.get(kind, kind)}", "code": "marking_required"}, status_code=403,
                                        headers=access_header("marking", markings=missing))
                hook = RESOURCE_PROJECT_HOOKS.get(kind)
                project = _safe(hook, m.group(1)) if hook else None
                if project:
                    need_role = "viewer" if request.method in ("GET", "HEAD") else "editor"
                    have = role_for(project, principal)
                    if _rank(have) < _rank(need_role):
                        name = _project_name(project)
                        return JSONResponse({"detail": f"You need the {ROLE_LABEL[need_role]} role on {name} to "
                                                       f"{'open' if need_role == 'viewer' else 'change'} this {RESOURCE_KINDS.get(kind, kind)}",
                                             "code": "project_role_required"}, status_code=403,
                                            headers=access_header("project", project_id=project, project=name, role=need_role))
                break
        if principal.get("via") == "cookie" and request.method not in ("GET", "HEAD") and not trusted_origin(request):
            return JSONResponse({"detail": "This request did not come from BluesandAI's own pages", "code": "untrusted_origin"}, status_code=403)
        if _code_write(path, request.method) and not can_run_code(principal):
            who = "administrators and the allowed groups" if settings().get("code_execution") == "groups" else "administrators"
            return JSONResponse({"detail": CODE_EXECUTION_MESSAGE.format(who=who), "code": "code_execution"}, status_code=403)
    token = _principal.set(principal)
    seen = _markings_seen.set({})  # the markings version, read once for this request
    try:
        return await call_next(request)
    finally:
        _markings_seen.reset(seen)
        _principal.reset(token)


def principal_of(user_id: Optional[str]) -> Optional[dict]:
    """A user as a request principal (markings, groups) for checks made on their behalf outside a request — a
    user-scoped schedule. None when the user does not exist or is deactivated."""
    if not user_id:
        return None
    with _db() as con:
        row = con.execute("SELECT record FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return None
    u = json.loads(row[0])
    if u.get("disabled"):
        return None
    return {**_public_user(u), "markings": user_markings(u), "service": False, "scope": "full", "method": "schedule"}


def user_label(user_id: Optional[str]) -> Optional[dict]:
    """{id, username, display_name, status} of a user (also deactivated ones), for showing a schedule's owner."""
    if not user_id:
        return None
    with _db() as con:
        row = con.execute("SELECT record FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return {"id": user_id, "username": user_id, "display_name": None, "status": "deleted"}
    u = json.loads(row[0])
    return {"id": u["id"], "username": u["username"], "display_name": u.get("display_name"),
            "status": "deactivated" if u.get("disabled") else "active"}


def actor_id() -> Optional[str]:
    """The signed-in user's id; None for the system, sign-in off and the local user."""
    p = current()
    if p is None or p.get("service") or p.get("id") in (None, "local"):
        return None
    return p["id"]


def require_user() -> dict:
    p = current()
    if enabled() and (p is None or p.get("service")):
        raise HTTPException(401, "Sign in first")
    return p or {"id": "local", "username": "local", "role": "admin", "markings": set(), "service": False}


require_session_user = require_user


def require_admin() -> dict:
    p = require_user()
    if enabled() and p["role"] != "admin":
        raise HTTPException(403, "Only administrators can do this")
    return p


# code that runs on this machine (not in a container): authoring or running it is limited by the code_execution setting
CODE_WRITE_PREFIXES = ("/api/code-repos", "/api/code-workbooks", "/api/code-workspaces", "/api/artifact-repos",
                       "/api/functions/preview", "/api/functions/publish")
CODE_EXECUTION_MESSAGE = "Running code on the BluesandAI host is limited to {who} (Control Panel → Security → Code execution)"


def can_run_code(principal: Optional[dict] = None) -> bool:
    """Whether a user may author or run code on the API host (Code Repositories, Workbooks, Workspaces, packages)."""
    p = principal if principal is not None else current()
    if not enabled() or p is None or p.get("service") or p.get("role") == "admin":
        return True
    st = settings()
    mode = st.get("code_execution") or "admins"
    if mode == "everyone":
        return True
    if mode == "groups":
        return bool(set(p.get("groups") or []) & set(st.get("code_execution_groups") or []))
    return False


def require_code_author() -> None:
    if not can_run_code():
        who = "administrators and the allowed groups" if settings().get("code_execution") == "groups" else "administrators"
        raise HTTPException(403, CODE_EXECUTION_MESSAGE.format(who=who))


def _code_write(path: str, method: str) -> bool:
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    if path.startswith("/api/git/"):
        return path.endswith("/git-receive-pack")
    return path.startswith(CODE_WRITE_PREFIXES)


# ------------------------------------------------------------------------------------------------
# markings
# ------------------------------------------------------------------------------------------------


def _markings() -> list[dict]:
    with _db() as con:
        return [json.loads(r) for (r,) in con.execute("SELECT record FROM markings").fetchall()]


def _item_row(item_id: str) -> tuple[list[str], list[str]]:
    with _db() as con:
        row = con.execute("SELECT own, inherited FROM item_markings WHERE item_id = ?", (item_id,)).fetchone()
    return (json.loads(row[0]), json.loads(row[1])) if row else ([], [])


def _set_item(item_id: str, own: Optional[list[str]] = None, inherited: Optional[list[str]] = None) -> None:
    cur_own, cur_inh = _item_row(item_id)
    own = sorted(set(cur_own if own is None else own))
    inherited = sorted(set(cur_inh if inherited is None else inherited))
    with _lock, _db() as con:
        if not own and not inherited:
            con.execute("DELETE FROM item_markings WHERE item_id = ?", (item_id,))
        else:
            con.execute(
                "INSERT INTO item_markings (item_id, own, inherited, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET "
                "own = excluded.own, inherited = excluded.inherited, updated_at = excluded.updated_at",
                (item_id, json.dumps(own), json.dumps(inherited), _iso()),
            )
        markings_changed(con)  # every API process's cached markings go stale with this change (same transaction)
    _cache.clear()
    _file_cache.clear()


# The markings caches are per process; the store's markings_version (bumped with every change of an item's markings,
# by any process) decides whether a cached entry is still valid, so another API process never answers from markings
# older than a change it could already see the effects of (an Iceberg commit widens the table's markings before its
# pointer moves). Read once per request (on the first lookup; again after 0.1 s for a long one — a streamed response
# or a thread that copied the request's context keeps the memo after the request returned); outside a request
# (background jobs) at most every 0.1 s per thread (a read costs ~0.2 ms).
_markings_seen: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("bsai_markings_version", default=None)
_markings_seen_bg = threading.local()
_MARKINGS_VERSION_TTL = 0.1


def markings_changed(con: Any) -> None:
    """Make every API process's cached markings stale: call in the transaction (`con`) that changes markings data."""
    con.execute("INSERT INTO markings_version (id, v) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET v = markings_version.v + 1")


def _markings_version() -> Optional[int]:
    memo = _markings_seen.get()
    now = time.monotonic()
    if memo is not None and "v" in memo and now - memo["at"] < _MARKINGS_VERSION_TTL:
        return memo["v"]
    if memo is None and now - getattr(_markings_seen_bg, "at", float("-inf")) < _MARKINGS_VERSION_TTL:
        return _markings_seen_bg.v
    try:
        with _db() as con:
            row = con.execute("SELECT v FROM markings_version WHERE id = 1").fetchone()
        v: Optional[int] = int(row[0]) if row else 0
    except Exception:  # noqa: BLE001 - unknown: nothing cached is used
        return None
    if memo is not None:
        memo["v"], memo["at"] = v, now
    else:
        _markings_seen_bg.at, _markings_seen_bg.v = now, v
    return v


_cache: dict[str, tuple[float, set[str], Optional[int]]] = {}


def effective_markings(item_id: Optional[str]) -> set[str]:
    """Markings on an item, inherited from its inputs, and on every folder above it."""
    if not item_id:
        return set()
    ver = _markings_version()
    hit = _cache.get(item_id)
    if hit and time.time() - hit[0] < 5 and ver is not None and hit[2] == ver:
        return hit[1]
    try:
        import db

        chain = [p["id"] for p in db.drive_path(item_id)] or [item_id]
    except Exception:  # noqa: BLE001 - no database: the item alone
        chain = [item_id]
    out: set[str] = set()
    with _db() as con:
        for i in chain:
            row = con.execute("SELECT own, inherited FROM item_markings WHERE item_id = ?", (i,)).fetchone()
            if row:
                out |= set(json.loads(row[0])) | set(json.loads(row[1]))
    if len(_cache) > 5000:
        _cache.clear()
    _cache[item_id] = (time.time(), out, ver)
    return out


_file_cache: dict[str, tuple[float, set[str], Optional[int]]] = {}


def file_markings(item_id: Optional[str]) -> set[str]:
    """The markings that decide whether an item can be discovered: its own and those of every folder above it.
    Markings it inherited from its inputs (data markings) also decide whether its data can be read."""
    if not item_id:
        return set()
    ver = _markings_version()
    hit = _file_cache.get(item_id)
    if hit and time.time() - hit[0] < 5 and ver is not None and hit[2] == ver:
        return hit[1]
    try:
        import db

        chain = [p["id"] for p in db.drive_path(item_id)] or [item_id]
    except Exception:  # noqa: BLE001
        chain = [item_id]
    out: set[str] = set()
    with _db() as con:
        for i in chain:
            row = con.execute("SELECT own, inherited FROM item_markings WHERE item_id = ?", (i,)).fetchone()
            if row:
                out |= set(json.loads(row[0])) | (set(json.loads(row[1])) if i != item_id else set())
    if len(_file_cache) > 5000:
        _file_cache.clear()
    _file_cache[item_id] = (time.time(), out, ver)
    return out


def has_operation(item_id: Optional[str], op: str, principal: Optional[dict] = None) -> bool:
    """Whether the caller may do `op` (OPERATIONS) on an item: the markings that apply (file markings to discover,
    every marking for anything else) and a role with that operation on its Project."""
    p = principal if principal is not None else current()
    if not enabled() or p is None or p.get("service"):
        return True
    need = file_markings(item_id) if op == "discover" else effective_markings(item_id)
    if need and missing_markings(need, p["markings"]):
        return False
    if not outside_projects_allowed(item_id, p):
        return False
    if ":" in (item_id or ""):
        project = resource_project(*item_id.split(":", 1))
    else:
        project = project_of(item_id)
    return op in operations_for(project, p) or op in granted_operations(item_id, p)


def can_access(item_id: Optional[str], principal: Optional[dict] = None) -> bool:
    """Markings held, and (for Files items in a Project) a role that reads its data (Viewer and up)."""
    return has_operation(item_id, "read", principal)


def can_discover(item_id: Optional[str], principal: Optional[dict] = None) -> bool:
    """Whether the item shows in listings and search: its file markings, and any role on its Project (Discoverer
    and up)."""
    return has_operation(item_id, "discover", principal)


def check_download(item_id: Optional[str]) -> None:
    """403 unless the caller may download the item's data (a role with the Download operation)."""
    if item_id and not has_operation(item_id, "download"):
        if not can_access(item_id):
            check_item({"id": item_id})
        raise HTTPException(403, "Your role on this Project does not allow downloading its data (the Download operation)")


def check_item(item: Optional[dict], need: str = "viewer") -> None:
    """403 when the caller lacks a marking on the item, or the Project role `need` (discoverer, viewer, editor,
    owner) on its Project (drive helpers call this for every item they load). Discovering needs only the file
    markings; anything else also the markings inherited from inputs."""
    if not item:
        return
    p = current()
    if not enabled() or p is None or p.get("service"):
        return
    if not outside_projects_allowed(item.get("id"), p):
        raise HTTPException(403, "This item is outside any Project: only the user who created it (and administrators) can open it")
    marks = file_markings(item.get("id")) if need == "discoverer" else effective_markings(item.get("id"))
    missing = sorted(missing_markings(marks, p.get("markings")))
    if missing:
        raise HTTPException(403, f"You need the marking{'s' if len(missing) > 1 else ''} {', '.join(_marking_names(missing))} to access this",
                            headers=access_header("marking", markings=missing))
    project = project_of(item.get("id"))
    # a role granted on the item or a folder above it, when the Project's own roles fall short
    if project and KEY_OP.get(need, need) not in operations_for(project, p) and KEY_OP.get(need, need) in granted_operations(item.get("id"), p):
        return
    check_project(project, need)


def access_header(kind: str, **what: Any) -> dict[str, str]:
    """What a 403 lacks, for the web app's "Request access" (an Approvals request): X-Bluesandai-Access JSON."""
    return {"X-Bluesandai-Access": json.dumps({"kind": kind, **what}), "Access-Control-Expose-Headers": "X-Bluesandai-Access"}


def visible(items: list[dict]) -> list[dict]:
    """The items of a listing the caller may see."""
    p = current()
    if not enabled() or p is None or p.get("service"):
        return items
    return [i for i in items if can_discover(i.get("id"), p)]


def _marking_names(ids: list[str]) -> list[str]:
    names = {k: v["name"] for k, v in _marking_info().items()}
    return [names.get(i, i) for i in ids]


# Project constraints (governance_model.py): fn(item id, markings or None for its current ones) -> why it violates
# its Project's allowed / prohibited markings, or None
CONSTRAINT_HOOK = None


def constraint_violation(item_id: str, markings: Optional[set[str]] = None) -> Optional[str]:
    if CONSTRAINT_HOOK is None or ":" in item_id:
        return None
    try:
        return CONSTRAINT_HOOK(item_id, markings)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - a broken constraint store never blocks
        log.exception("project constraints for %s", item_id)
        return None


def check_constraints(item_id: str) -> None:
    """409 when an item's markings (inherited from its inputs too) violate its Project's constraints: the build that
    wrote it fails (the markings stay applied, so its data stays protected)."""
    why = constraint_violation(item_id)
    if why:
        raise HTTPException(409, why)


def propagate(output_item_id: str, source_item_ids: list[Optional[str]]) -> list[str]:
    """An output inherits the markings of the items it was built from (inputs, the pipeline or repository); a
    Project constraint it then violates fails the build (409)."""
    inherited: set[str] = set()
    for i in source_item_ids:
        inherited |= effective_markings(i)
    _set_item(output_item_id, inherited=sorted(inherited))
    try:
        import dataset_versions

        dataset_versions.note_inputs(output_item_id, source_item_ids)
    except Exception:  # noqa: BLE001
        pass
    check_constraints(output_item_id)
    return sorted(inherited)


# ------------------------------------------------------------------------------------------------
# endpoints: sign-in
# ------------------------------------------------------------------------------------------------


class Credentials(BaseModel):
    username: str
    password: str


class SetupIn(Credentials):
    display_name: str = ""


def web_url() -> str:
    """The web app's address, for links in emails and single sign-on redirects."""
    return (mailer.env("BLUESANDAI_WEB_URL") or "http://localhost:8888").rstrip("/")


def api_public_url() -> str:
    """The API's address as the browser reaches it."""
    return (mailer.env("BLUESANDAI_API_PUBLIC_URL") or "http://localhost:8000").rstrip("/")


def _netloc(url: str) -> str:
    from urllib.parse import urlparse

    return (urlparse(url).netloc or "").lower()


def hosting_url() -> str:
    """Where Developer Console websites are served: an origin of their own (BLUESANDAI_HOSTING_URL), so their scripts
    never run beside the platform's session cookie. By default the API's address with localhost and 127.0.0.1
    swapped (separate cookie jars); in production use a different registrable domain (not a subdomain)."""
    env = mailer.env("BLUESANDAI_HOSTING_URL")
    if env:
        return env.rstrip("/")
    api = api_public_url()
    host = _netloc(api).split(":")[0]
    swap = {"localhost": "127.0.0.1", "127.0.0.1": "localhost"}.get(host)
    return api.replace(f"//{host}", f"//{swap}", 1) if swap else api


def _hosting_separate() -> bool:
    return _netloc(hosting_url()) not in (_netloc(api_public_url()), _netloc(web_url()))


def _cookieless(request: Request) -> bool:
    """Requests to the hosting origin never use the platform's session cookie."""
    return _hosting_separate() and (request.headers.get("host") or "").lower() == _netloc(hosting_url())


def trusted_origin(request: Request) -> bool:
    """A cookie-authenticated change must come from the platform's own pages (cross-site request forgery): no Origin
    (not a browser, or same-origin navigation), the request's own origin, or the web app's origins."""
    origin = (request.headers.get("origin") or "").rstrip("/").lower()
    if not origin:
        return True
    host = _netloc(origin)
    if _hosting_separate() and host == _netloc(hosting_url()):
        return False
    if host == (request.headers.get("host") or "").lower():
        return True
    raw = os.environ.get("BLUESANDAI_WEB_ORIGINS") or "http://localhost:8888,http://127.0.0.1:8888"
    allowed = {_netloc(o.strip()) for o in raw.split(",") if o.strip()} | {_netloc(web_url()), _netloc(api_public_url())}
    return host in allowed


def issue_render_session(user_id: str, seconds: int = 300) -> str:
    """A short-lived session for rendering a page as a user (report_render.py); revoke it when done."""
    token = secrets.token_urlsafe(32)
    with _lock, _db() as con:
        con.execute("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, agent, last_active_at, scope, ip, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (_sha(token), user_id, _iso(_now() + timedelta(seconds=seconds)), _iso(), "report renderer", _iso(), "full", None, "render"))
    return token


def revoke_render_session(token: str) -> None:
    with _lock, _db() as con:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (_sha(token),))


def _start_session(response: Response, request: Request, user: dict, scope: str = "full", method: str = "password") -> None:
    token = secrets.token_urlsafe(32)
    seconds = _session_seconds()
    with _lock, _db() as con:
        con.execute("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, agent, last_active_at, scope, ip, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (_sha(token), user["id"], _iso(_now() + timedelta(seconds=seconds)), _iso(), (request.headers.get("user-agent") or "")[:200], _iso(),
                     scope, _ip(request), method))
    secure = request.url.scheme == "https" or mailer.env("BLUESANDAI_COOKIE_SECURE") == "1"
    response.set_cookie(COOKIE, token, max_age=seconds, httponly=True, samesite="lax", secure=secure, path="/")
    user["last_login_at"] = _iso()
    user["last_login_ip"] = _ip(request) or None
    _save_user(user)


def _signed_in(response: Response, request: Request, u: dict, method: str = "password") -> dict:
    """Start the session of a user who passed every sign-in step; one that must set up two-factor gets a setup-only session."""
    enroll = method != "sso" and mfa_required(u) and not u.get("mfa_enabled")
    _start_session(response, request, u, "enroll" if enroll else "full", method)
    audit("sign_in", u, f"via {method}" + (" (two-factor setup required)" if enroll else ""), request)
    return {"user": _me({**_public_user(u), "markings": user_markings(u)}), "mfa_enrollment_required": enroll}


def sso_providers() -> list[dict]:
    try:
        import auth_sso

        return auth_sso.providers()
    except Exception:  # noqa: BLE001 - single sign-on is optional
        log.exception("single sign-on providers unavailable")
        return []


@router.get("/policy")
def public_policy() -> dict:
    """What the sign-in pages need before anyone signs in: the password policy, single sign-on buttons, whether
    password sign-in is on and whether email is configured (for "Forgot password")."""
    st = settings()
    return {"password": policy(), "sso": sso_providers(), "password_login": bool(st["password_login"]), "email": mailer.configured(),
            "idle_timeout_minutes": int(st["idle_timeout_minutes"])}


@router.get("/status")
def status(request: Request) -> dict:
    """Whether sign-in is on, whether the first administrator still has to be created, and who is signed in."""
    if not enabled():
        return {"enabled": False, "setup_needed": False, "user": None}
    with _db() as con:
        (n,) = con.execute("SELECT COUNT(*) FROM users").fetchone()
    p = _principal_for(request)
    signed_in = p and not p.get("service")
    return {"enabled": True, "setup_needed": n == 0, "user": _me(p) if signed_in else None,
            "mfa_enrollment_required": bool(signed_in and p.get("scope") == "enroll"), "service": bool(p and p.get("service")),
            "idle_timeout_minutes": int(settings()["idle_timeout_minutes"]), "reason": getattr(request.state, "auth_reason", None)}


@router.post("/setup")
def setup(req: SetupIn, request: Request, response: Response) -> dict:
    """Create the first administrator (only while there are no users) and sign them in."""
    with _lock:
        with _db() as con:
            (n,) = con.execute("SELECT COUNT(*) FROM users").fetchone()
        if n:
            raise HTTPException(409, "Setup is done: sign in")
        u = _new_user(req.username, req.password, "admin", req.display_name)
    audit("setup", u, "first administrator created", request)
    return _signed_in(response, request, u)


def _action_token(kind: str, user_id: str, seconds: int, record: Optional[dict] = None, replace: bool = True) -> str:
    """A one-time link or step token (reset, invite, mfa, expired …); with replace, earlier ones of the kind end."""
    token = secrets.token_urlsafe(32)
    with _lock, _db() as con:
        if replace:
            con.execute("DELETE FROM action_tokens WHERE user_id = ? AND kind = ?", (user_id, kind))
        con.execute("DELETE FROM action_tokens WHERE expires_at < ?", (_iso(),))
        con.execute("INSERT INTO action_tokens (token_hash, kind, user_id, expires_at, created_at, record) VALUES (?, ?, ?, ?, ?, ?)",
                    (_sha(token), kind, user_id, _iso(_now() + timedelta(seconds=seconds)), _iso(), json.dumps(record or {})))
    return token


def _read_token(token: str, kinds: tuple[str, ...], consume: bool = False) -> tuple[dict, dict]:
    """(user, record) of a valid action token of one of the kinds; 400 when unknown, used or expired."""
    with _lock, _db() as con:
        row = con.execute("SELECT kind, user_id, expires_at, record FROM action_tokens WHERE token_hash = ?", (_sha(token or ""),)).fetchone()
        if not row or row[0] not in kinds or row[2] < _iso():
            raise HTTPException(400, "This link has expired or was already used")
        if consume:
            con.execute("DELETE FROM action_tokens WHERE token_hash = ?", (_sha(token),))
    try:
        u = _user(row[1])
    except HTTPException:
        raise HTTPException(400, "This link is for an account that no longer exists") from None
    if u.get("disabled"):
        raise HTTPException(403, "This account is deactivated: ask an administrator")
    return u, {**json.loads(row[3] or "{}"), "kind": row[0]}


@router.post("/login")
def login(req: Credentials, request: Request, response: Response) -> dict:
    """Password sign-in. The next step may be a two-factor code (mfa_required + mfa_token) or a new password
    (password_expired + reset_token) before the session starts."""
    st = settings()
    name = req.username.strip().lower()
    ip = _ip(request)
    _limit(f"user:{name}", int(st["login_max_per_user"]))
    _limit(f"ip:{ip}", int(st["login_max_per_ip"]), "Too many failed sign-ins from your network")
    with _db() as con:
        row = con.execute("SELECT pw_hash, record FROM users WHERE username = ?", (name,)).fetchone()
        if not row and "@" in name:
            # sign in with the email address too
            match = next((u for u in _users() if (u.get("email") or "").lower() == name), None)
            row = con.execute("SELECT pw_hash, record FROM users WHERE id = ?", (match["id"],)).fetchone() if match else None
    ok = bool(row) and verify_password(req.password, row[0])
    if not ok:
        if not row:
            verify_password(req.password, hash_password("x" * 12))  # same timing as a wrong password
        _count(f"user:{name}")
        _count(f"ip:{ip}")
        audit("sign_in_failed", json.loads(row[1]) if row else None, "wrong password" if row else "unknown user", request, username=name)
        raise HTTPException(401, "Wrong username or password")
    u = json.loads(row[1])
    if u.get("disabled"):
        audit("sign_in_failed", u, "account deactivated", request)
        raise HTTPException(403, "This account is deactivated: ask an administrator")
    if not st["password_login"] and u.get("role") != "admin":
        audit("sign_in_failed", u, "password sign-in is off", request)
        raise HTTPException(403, "Sign in with your company account (single sign-on)")
    rate_limits.clear(f"user:{name}")
    if u.get("mfa_enabled"):
        return {"mfa_required": True, "mfa_token": _action_token("mfa", u["id"], 300, {"after": "expired" if password_expired(u) else ""})}
    if password_expired(u):
        audit("password_expired", u, "must change password", request)
        return {"password_expired": True, "reset_token": _action_token("expired", u["id"], 900),
                "reason": "An administrator set your password: choose your own" if u.get("must_change_password") else "Your password has expired"}
    return _signed_in(response, request, u)


class MfaLogin(BaseModel):
    mfa_token: str
    code: str = ""
    recovery_code: str = ""


def _check_mfa(u: dict, code: str, recovery_code: str) -> str:
    """Accept a TOTP code or a recovery code (used up); returns how ("code" or "recovery code")."""
    with _db() as con:
        row = con.execute("SELECT mfa_secret, recovery FROM user_secrets WHERE user_id = ?", (u["id"],)).fetchone()
    if not row or not row[0]:
        raise HTTPException(400, "Two-factor authentication is not set up")
    if recovery_code.strip():
        codes = json.loads(row[1] or "[]")
        h = auth_mfa.hash_recovery(recovery_code)
        if h not in codes:
            raise HTTPException(401, "That recovery code is wrong or was used")
        with _lock, _db() as con:
            con.execute("UPDATE user_secrets SET recovery = ? WHERE user_id = ?", (json.dumps([c for c in codes if c != h]), u["id"]))
        return "recovery code"
    import secretbox

    secret = secretbox.unseal(row[0].encode()).get("secret")
    counter = auth_mfa.verify(secret or "", code, u.get("mfa_last_counter"))
    if counter is None:
        raise HTTPException(401, "That code is wrong or was already used: use the newest code from your authenticator app")
    u["mfa_last_counter"] = counter
    _save_user(u)
    return "code"


@router.post("/login/mfa")
def login_mfa(req: MfaLogin, request: Request, response: Response) -> dict:
    """Second sign-in step: the authenticator app's code (or a recovery code)."""
    ip = _ip(request)
    _limit(f"ip:{ip}", int(settings()["login_max_per_ip"]), "Too many failed sign-ins from your network")
    u, rec = _read_token(req.mfa_token, ("mfa",))
    _limit(f"mfa:{u['id']}", 5, "Too many wrong codes")
    try:
        how = _check_mfa(u, req.code, req.recovery_code)
    except HTTPException:
        _count(f"mfa:{u['id']}")
        _count(f"ip:{ip}")
        audit("sign_in_failed", u, "wrong two-factor code", request)
        raise
    _read_token(req.mfa_token, ("mfa",), consume=True)
    rate_limits.clear(f"mfa:{u['id']}")
    u = _user(u["id"])
    if how == "recovery code":
        audit("mfa_recovery_used", u, "signed in with a recovery code", request)
    if rec.get("after") == "expired" or password_expired(u):
        return {"password_expired": True, "reset_token": _action_token("expired", u["id"], 900), "reason": "Your password has expired"}
    return _signed_in(response, request, u)


@router.post("/heartbeat")
def heartbeat(request: Request) -> dict:
    """The browser reports page activity (about once a minute while the user interacts): keeps the session from idling out."""
    require_session_user()
    cookie = request.cookies.get(COOKIE)
    if cookie:
        with _lock, _db() as con:
            con.execute("UPDATE sessions SET last_active_at = ? WHERE token_hash = ?", (_iso(), _sha(cookie)))
    return {"idle_timeout_minutes": int(settings()["idle_timeout_minutes"])}


@router.post("/logout")
def logout(request: Request, response: Response) -> dict:
    cookie = request.cookies.get(COOKIE)
    if cookie:
        with _lock, _db() as con:
            row = con.execute("SELECT user_id FROM sessions WHERE token_hash = ?", (_sha(cookie),)).fetchone()
            con.execute("DELETE FROM sessions WHERE token_hash = ?", (_sha(cookie),))
        if row:
            try:
                audit("sign_out", _user(row[0]), request=request)
            except HTTPException:
                pass
    response.delete_cookie(COOKIE, path="/")
    return {"signed_out": True}


# -- forgot password / reset links --


class ForgotIn(BaseModel):
    login: str = Field(min_length=1, max_length=200)


def _send_link(u: dict, kind: str, link: str) -> bool:
    """Email a reset or invitation link to the user; False when email is not configured or the user has no address."""
    if not u.get("email"):
        return False
    name = u.get("display_name") or u["username"]
    if kind == "invite":
        subject = "You are invited to BluesandAI"
        text = (f"Hello {name},\n\nYou have been invited to BluesandAI as {u['username']}. Choose your password here (the link works for "
                f"{settings()['invite_days']} days):\n\n{link}\n")
        html = mailer.html_message("You are invited to BluesandAI",
                                   [f"Hello {name},", f"You have been invited to BluesandAI as {u['username']}. Choose your password to get started."],
                                   ("Accept the invitation", link), f"The link works for {settings()['invite_days']} days.")
    else:
        subject = "Reset your BluesandAI password"
        text = (f"Hello {name},\n\nSomeone (hopefully you) asked to reset the password of {u['username']}. Choose a new one here (the link "
                f"works for {settings()['reset_minutes']} minutes and once):\n\n{link}\n\nIf it was not you, ignore this email.\n")
        html = mailer.html_message("Reset your password",
                                   [f"Hello {name},", f"Someone (hopefully you) asked to reset the password of {u['username']}."],
                                   ("Choose a new password", link),
                                   f"The link works once, for {settings()['reset_minutes']} minutes. If it was not you, ignore this email.")
    try:
        return mailer.send(u["email"], subject, text, html)
    except Exception:  # noqa: BLE001 - the caller reports it was not sent
        log.exception("could not email %s", u["email"])
        return False


@router.post("/password/forgot")
def forgot_password(req: ForgotIn, request: Request) -> dict:
    """Email a reset link to the account with this username or email. The answer is the same whether or not it exists."""
    ip = _ip(request)
    _limit(f"reset:{ip}", 10, "Too many reset requests")
    _count(f"reset:{ip}")
    key = req.login.strip().lower()
    match = next((u for u in _users() if u["username"] == key or (u.get("email") or "").lower() == key), None)
    if match and not match.get("disabled") and not match.get("sso_only") and _attempts(f"reset-user:{match['id']}") < 3:
        _count(f"reset-user:{match['id']}")
        token = _action_token("reset", match["id"], int(settings()["reset_minutes"]) * 60)
        sent = _send_link(match, "reset", f"{web_url()}/reset-password?token={token}")
        audit("password_reset_requested", match, "emailed" if sent else "not emailed (no SMTP server or no email address)", request)
    else:
        audit("password_reset_requested", None, "no matching active account", request, username=key)
    return {"sent": True, "email": mailer.configured()}


@router.get("/password/reset/{token}")
def reset_info(token: str) -> dict:
    """Who a reset (or expired-password) link is for, and the password policy."""
    u, rec = _read_token(token, ("reset", "expired"))
    return {"username": u["username"], "display_name": u.get("display_name"), "kind": rec["kind"], "policy": policy()}


class ResetIn(BaseModel):
    token: str
    new_password: str


@router.post("/password/reset")
def reset_password(req: ResetIn, request: Request, response: Response) -> dict:
    """Set a new password from a reset link (or after an expired password); every session ends. An expired-password
    change signs in (two-factor was already checked)."""
    ip = _ip(request)
    _limit(f"ip:{ip}", int(settings()["login_max_per_ip"]), "Too many attempts from your network")
    u, rec = _read_token(req.token, ("reset", "expired"))
    _check_password(req.new_password, u)
    _read_token(req.token, ("reset", "expired"), consume=True)
    _set_password(u, req.new_password)
    with _lock, _db() as con:
        con.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))
        con.execute("DELETE FROM action_tokens WHERE user_id = ? AND kind IN ('reset', 'expired')", (u["id"],))
    audit("password_reset", u, "from a reset link" if rec["kind"] == "reset" else "expired password changed", request)
    if rec["kind"] == "expired":
        return {"reset": True, **_signed_in(response, request, _user(u["id"]))}
    return {"reset": True}


# -- invitations --


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    username: str = ""
    display_name: str = ""
    first_name: str = ""
    last_name: str = ""
    organization_id: Optional[str] = None
    role: str = Field("user", pattern="^(admin|user)$")
    markings: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)


def _invite_link(u: dict) -> tuple[str, bool]:
    token = _action_token("invite", u["id"], int(settings()["invite_days"]) * 86400)
    link = f"{web_url()}/accept-invite?token={token}"
    return link, _send_link(u, "invite", link)


@router.post("/invitations")
def invite_user(req: InviteIn, request: Request) -> dict:
    """Invite someone by email: their account waits until they choose a password from the link. Without email
    (no SMTP server) the link is returned for the administrator to pass on."""
    require_admin()
    email = req.email.strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(400, "Not an email address")
    if any((u.get("email") or "").lower() == email.lower() for u in _users()):
        raise HTTPException(409, "A user with that email exists")
    _check_refs(req.markings, req.organization_id, req.groups)
    u = _new_user(req.username or email, None, req.role, req.display_name, req.markings, first_name=req.first_name, last_name=req.last_name,
                  email=email, organization_id=req.organization_id, invited=True)
    if req.groups:
        _set_user_groups(u["id"], req.groups)
    link, sent = _invite_link(u)
    audit("user_invited", u, f"role {req.role}; " + ("emailed" if sent else "link handed to the administrator"), request)
    return {"user": _public_user(u), "link": link, "emailed": sent}


@router.post("/users/{user_id}/invite")
def resend_invite(user_id: str, request: Request) -> dict:
    """A new invitation link (the earlier one stops working)."""
    require_admin()
    u = _user(user_id)
    if not u.get("invited"):
        raise HTTPException(400, "This user has accepted the invitation already")
    link, sent = _invite_link(u)
    audit("user_invited", u, "invitation sent again", request)
    return {"link": link, "emailed": sent}


@router.get("/invitations/{token}")
def invitation_info(token: str) -> dict:
    u, _ = _read_token(token, ("invite",))
    return {"username": u["username"], "email": u.get("email"), "display_name": u.get("display_name"), "policy": policy(),
            "sso": sso_providers()}


class AcceptIn(BaseModel):
    token: str
    password: str
    display_name: str = ""


@router.post("/invitations/accept")
def accept_invitation(req: AcceptIn, request: Request, response: Response) -> dict:
    ip = _ip(request)
    _limit(f"ip:{ip}", int(settings()["login_max_per_ip"]), "Too many attempts from your network")
    u, _ = _read_token(req.token, ("invite",))
    _check_password(req.password, u)
    _read_token(req.token, ("invite",), consume=True)
    if req.display_name.strip():
        u["display_name"] = req.display_name.strip()
    _set_password(u, req.password)
    u = _user(u["id"])
    audit("invitation_accepted", u, request=request)
    return _signed_in(response, request, u)


HIDDEN_MARKING = "Hidden marking"


def _marking_info() -> dict[str, dict]:
    """Every marking by id: defined markings and organizations (kind "organization"). Markings of hidden categories
    the caller may not know of are named HIDDEN_MARKING (their id stays, so access checks still name what is lacking)."""
    p = current()
    cats = {c["id"]: c for c in _categories()} if p is not None and not _is_admin(p) else {}
    out = {}
    for m in _markings():
        if cats and not _marking_visible(m, cats, p):
            out[m["id"]] = {"id": m["id"], "name": HIDDEN_MARKING, "color": "#777777", "kind": "marking", "hidden": True}
        else:
            out[m["id"]] = {**m, "kind": "marking"}
    for o in _orgs():
        out[org_marking(o["id"])] = {"id": org_marking(o["id"]), "name": o["name"], "color": o.get("color") or "#2f6fdf", "kind": "organization"}
    return out


def _me(p: dict) -> dict:
    names = _marking_info()
    orgs = {o["id"]: o["name"] for o in _orgs()}
    groups = {g["id"]: g["name"] for g in _groups()}
    return {**{k: p.get(k) for k in ("id", "username", "display_name", "first_name", "last_name", "email", "role", "organization_id", "attributes")},
            "organization": orgs.get(p.get("organization_id") or ""),
            "groups": [{"id": g, "name": groups.get(g, g)} for g in p.get("groups") or []],
            "markings": [{"id": i, "name": names.get(i, {}).get("name", i), "color": names.get(i, {}).get("color"), "kind": names.get(i, {}).get("kind", "marking")}
                         for i in sorted(p.get("markings") or [])],
            "emulation": p.get("emulation"),
            # Code Repositories / Workbooks / Functions publish: pages disable code actions up front (Control Panel → Security → Code execution)
            "can_run_code": can_run_code(p)}


# -- emulation mode --


def _emulated(p: dict, u: dict, em: dict) -> dict:
    """A scoped session (emulation mode): only the chosen groups (and the markings they grant), the chosen markings
    among the user's own, their organization; no administrator powers while it lasts."""
    gs = _groups()
    keep_groups = set(em.get("groups") or []) & set(p.get("groups") or [])
    # a kept group keeps the groups it is nested in (as membership does)
    changed = True
    while changed:
        changed = False
        for g in gs:
            if g["id"] not in keep_groups and set(g.get("member_groups") or []) & keep_groups:
                keep_groups.add(g["id"])
                changed = True
    marks = set(em.get("markings") or []) & user_markings(u)
    for g in gs:
        if g["id"] in keep_groups:
            marks |= set(g.get("markings") or [])
    if u.get("organization_id"):
        marks.add(org_marking(u["organization_id"]))
    for o in _orgs():
        if u["id"] in (o.get("guests") or []):
            marks.add(org_marking(o["id"]))
    return {**p, "groups": sorted(keep_groups), "markings": marks, "role": "user", "real_role": p.get("role"),
            "emulation": {"groups": sorted(keep_groups), "markings": sorted(marks), "started_at": em.get("started_at")}}


class EmulationIn(BaseModel):
    groups: list[str] = Field(default_factory=list)
    markings: list[str] = Field(default_factory=list)


def _session_hash(request: Request) -> str:
    cookie = request.cookies.get(COOKIE)
    if not cookie:
        raise HTTPException(400, "Emulation mode needs a browser session")
    return _sha(cookie)


@router.post("/me/emulation")
def start_emulation(req: EmulationIn, request: Request) -> dict:
    """Start emulation mode: this session keeps only the chosen groups and markings (of your own) until you exit it."""
    p = require_user()
    if p.get("emulation"):
        raise HTTPException(409, "Exit emulation mode first")
    u = _user(p["id"])
    mine_groups = groups_of(u["id"])
    if set(req.groups) - mine_groups:
        raise HTTPException(400, "You can keep only groups you are in")
    if set(req.markings) - set(user_markings(u)):
        raise HTTPException(400, "You can keep only markings you hold")
    em = {"groups": sorted(set(req.groups)), "markings": sorted(set(req.markings)), "started_at": _iso()}
    with _lock, _db() as con:
        con.execute("UPDATE sessions SET emulation = ? WHERE token_hash = ?", (json.dumps(em), _session_hash(request)))
    audit("emulation_started", None, f"groups {em['groups']}, markings {em['markings']}", request)
    return {"emulation": em}


@router.delete("/me/emulation")
def end_emulation(request: Request) -> dict:
    require_user()
    with _lock, _db() as con:
        con.execute("UPDATE sessions SET emulation = NULL WHERE token_hash = ?", (_session_hash(request),))
    audit("emulation_ended", None, "", request)
    return {"emulation": None}


@router.get("/me")
def me() -> dict:
    p = require_user()
    out = _me(p)
    if p.get("id") not in ("local", None):
        u = _user(p["id"])
        out.update(mfa_enabled=bool(u.get("mfa_enabled")), mfa_required=mfa_required(u), password_changed_at=u.get("password_changed_at"),
                   identities=[{"provider": i.get("provider"), "email": i.get("email")} for i in u.get("identities") or []],
                   has_password=_has_password(u["id"]), sign_in_method=p.get("method"))
    return out


def _has_password(user_id: str) -> bool:
    with _db() as con:
        row = con.execute("SELECT pw_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row[0] and row[0] != "!")


class ProfileChange(BaseModel):
    display_name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None


@router.put("/me")
def update_me(req: ProfileChange) -> dict:
    """Users edit their own name and email; organization, groups, role and markings are set by administrators."""
    p = require_user()
    u = _user(p["id"])
    for k, v in req.model_dump(exclude_none=True).items():
        u[k] = v.strip()
    _save_user(u)
    return _me({**_public_user(u), "markings": user_markings(u)})


def _session_id(token_hash: str) -> str:
    return token_hash[:16]


@router.get("/me/sessions")
def my_sessions(request: Request) -> list[dict]:
    """Where you are signed in; the session of this browser is marked current."""
    p = require_user()
    cur = _sha(request.cookies.get(COOKIE) or "")
    with _db() as con:
        rows = con.execute("SELECT token_hash, created_at, expires_at, agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC", (p["id"],)).fetchall()
    return [{"id": _session_id(h), "created_at": c, "expires_at": e, "agent": a, "current": h == cur} for h, c, e, a in rows]


@router.delete("/me/sessions/{session_id}")
def revoke_session(session_id: str, request: Request) -> dict:
    p = require_user()
    with _lock, _db() as con:
        con.execute("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?", (p["id"], session_id))
    audit("session_revoked", _user(p["id"]), request=request)
    return {"revoked": session_id}


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/me/password")
def change_password(req: PasswordChange, request: Request) -> dict:
    p = require_user()
    with _db() as con:
        row = con.execute("SELECT pw_hash FROM users WHERE id = ?", (p["id"],)).fetchone()
    if not row or not verify_password(req.current_password, row[0]):
        raise HTTPException(400, "The current password is wrong")
    u = _user(p["id"])
    _check_password(req.new_password, u)
    _set_password(u, req.new_password)
    audit("password_changed", _user(p["id"]), request=request)
    # other sessions end; this one stays
    keep = _sha(request.cookies.get(COOKIE) or "")
    with _lock, _db() as con:
        con.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (p["id"], keep))
    return {"changed": True}


# -- two-factor authentication --


@router.get("/me/notifications")
def my_notification_settings() -> dict:
    """Per source: in the app (web) and by email; sources without a setting follow what the sender asks."""
    import notify

    p = require_user()
    u = _user(p["id"]) if p.get("id") not in (None, "local") else {}
    return {"sources": [{"id": k, "label": v} for k, v in notify.SOURCES.items()], "settings": u.get("notification_settings") or {}}


class NotificationSettingsIn(BaseModel):
    # {source: {web: bool, email: bool}}; a source left out follows the sender
    settings: dict[str, dict[str, bool]]


@router.put("/me/notifications")
def set_my_notification_settings(req: NotificationSettingsIn) -> dict:
    import notify

    p = require_user()
    bad = set(req.settings) - set(notify.SOURCES)
    if bad:
        raise HTTPException(400, f"Unknown source {sorted(bad)[0]}")
    u = _user(p["id"])
    u["notification_settings"] = {k: {kk: bool(vv) for kk, vv in v.items() if kk in ("web", "email")} for k, v in req.settings.items()}
    _save_user(u)
    return my_notification_settings()


@router.get("/me/mfa")
def my_mfa() -> dict:
    p = require_user()
    u = _user(p["id"])
    with _db() as con:
        row = con.execute("SELECT recovery FROM user_secrets WHERE user_id = ?", (u["id"],)).fetchone()
    return {"enabled": bool(u.get("mfa_enabled")), "required": mfa_required(u), "recovery_codes_left": len(json.loads(row[0] or "[]")) if row else 0}


@router.post("/me/mfa/setup")
def mfa_setup() -> dict:
    """Start setting up an authenticator app: a new secret (shown once, as a QR code and a key) to confirm with a code."""
    import secretbox

    p = require_user()
    u = _user(p["id"])
    secret = auth_mfa.new_secret()
    sealed = secretbox.seal({"secret": secret}).decode()
    with _lock, _db() as con:
        con.execute("INSERT INTO user_secrets (user_id, mfa_pending, recovery) VALUES (?, ?, '[]') ON CONFLICT(user_id) DO UPDATE SET mfa_pending = excluded.mfa_pending",
                    (u["id"], sealed))
    uri = auth_mfa.otpauth_uri(secret, u.get("email") or u["username"])
    return {"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "otpauth_uri": uri, "qr_svg": auth_mfa.qr_svg(uri)}


class MfaCode(BaseModel):
    code: str = ""
    password: str = ""


def _new_recovery(user_id: str) -> list[str]:
    codes = auth_mfa.recovery_codes()
    with _lock, _db() as con:
        con.execute("UPDATE user_secrets SET recovery = ? WHERE user_id = ?", (json.dumps([auth_mfa.hash_recovery(c) for c in codes]), user_id))
    return codes


@router.post("/me/mfa/enable")
def mfa_enable(req: MfaCode, request: Request) -> dict:
    """Confirm the authenticator app with its current code: two-factor is on, and the recovery codes are shown once."""
    import secretbox

    p = require_user()
    u = _user(p["id"])
    with _db() as con:
        row = con.execute("SELECT mfa_pending FROM user_secrets WHERE user_id = ?", (u["id"],)).fetchone()
    if not row or not row[0]:
        raise HTTPException(400, "Start the setup first")
    secret = secretbox.unseal(row[0].encode()).get("secret") or ""
    counter = auth_mfa.verify(secret, req.code)
    if counter is None:
        raise HTTPException(400, "That code is wrong: check the time on your phone and use the newest code")
    with _lock, _db() as con:
        con.execute("UPDATE user_secrets SET mfa_secret = mfa_pending, mfa_pending = NULL WHERE user_id = ?", (u["id"],))
    u.update(mfa_enabled=True, mfa_last_counter=counter)
    _save_user(u)
    codes = _new_recovery(u["id"])
    # a setup-only session becomes a full one
    cookie = request.cookies.get(COOKIE)
    if cookie:
        with _lock, _db() as con:
            con.execute("UPDATE sessions SET scope = 'full' WHERE token_hash = ?", (_sha(cookie),))
    audit("mfa_enabled", u, request=request)
    return {"enabled": True, "recovery_codes": codes}


@router.post("/me/mfa/disable")
def mfa_disable(req: MfaCode, request: Request) -> dict:
    p = require_user()
    u = _user(p["id"])
    if mfa_required(u):
        raise HTTPException(400, "Two-factor authentication is required for your account: it cannot be turned off")
    _check_mfa(u, req.code, "")
    _clear_mfa(u)
    audit("mfa_disabled", u, request=request)
    return {"enabled": False}


@router.post("/me/mfa/recovery-codes")
def mfa_recovery(req: MfaCode, request: Request) -> dict:
    """New recovery codes (the old ones stop working); needs a current code."""
    p = require_user()
    u = _user(p["id"])
    _check_mfa(u, req.code, "")
    codes = _new_recovery(u["id"])
    audit("mfa_recovery_codes", u, "new recovery codes", request)
    return {"recovery_codes": codes}


def _clear_mfa(u: dict) -> None:
    with _lock, _db() as con:
        con.execute("DELETE FROM user_secrets WHERE user_id = ?", (u["id"],))
    u.update(mfa_enabled=False)
    u.pop("mfa_last_counter", None)
    _save_user(u)


@router.delete("/users/{user_id}/mfa")
def reset_user_mfa(user_id: str, request: Request) -> dict:
    """An administrator turns off a user's two-factor authentication (a lost phone); they set it up again."""
    require_admin()
    u = _user(user_id)
    _clear_mfa(u)
    audit("mfa_reset", u, "by an administrator", request)
    return {"reset": True}


@router.post("/users/{user_id}/reset-link")
def admin_reset_link(user_id: str, request: Request) -> dict:
    """A password reset link for a user: emailed when possible, and returned to pass on."""
    require_admin()
    u = _user(user_id)
    token = _action_token("reset", u["id"], int(settings()["reset_minutes"]) * 60)
    link = f"{web_url()}/reset-password?token={token}"
    sent = _send_link(u, "reset", link)
    audit("password_reset_requested", u, "by an administrator" + (", emailed" if sent else ""), request)
    return {"link": link, "emailed": sent}


# -- security settings --


@router.get("/settings")
def get_settings() -> dict:
    require_admin()
    return {"settings": settings(), "defaults": default_settings(), "store": auth_store.kind(), "email": mailer.configured(),
            "email_provider": mailer.provider(), "email_from": mailer.sender() if mailer.configured() else None, "sso": sso_providers(), "web_url": web_url()}


@router.put("/settings")
def put_settings(values: dict[str, Any], request: Request) -> dict:
    """Change security settings (only the keys given)."""
    global _settings_cache
    require_admin()
    defaults = default_settings()
    clean: dict[str, Any] = {}
    for k, v in values.items():
        if k not in defaults:
            raise HTTPException(400, f"Unknown setting {k}")
        d = defaults[k]
        if isinstance(d, bool):
            if not isinstance(v, bool):
                raise HTTPException(400, f"{k} is on or off")
        elif isinstance(d, int):
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{k} is a number") from None
            lo, hi = SETTING_LIMITS.get(k, (0, 10**9))
            if not lo <= v <= hi:
                raise HTTPException(400, f"{k} must be between {lo} and {hi}")
        elif isinstance(d, list):
            if not isinstance(v, list):
                raise HTTPException(400, f"{k} is a list")
            v = sorted({str(x).strip().lower().lstrip("@") for x in v if str(x).strip()})
        elif k == "sso_default_role" and v not in ("user", "admin"):
            raise HTTPException(400, "sso_default_role is user or admin")
        elif k == "project_default_role" and v not in ("none", "discoverer", "viewer", "editor"):
            raise HTTPException(400, "project_default_role is none, discoverer, viewer or editor")
        elif k == "files_outside_projects" and v not in ("creator", "everyone"):
            raise HTTPException(400, "files_outside_projects is creator or everyone")
        elif k == "code_execution" and v not in ("admins", "groups", "everyone"):
            raise HTTPException(400, "code_execution is admins, groups or everyone")
        clean[k] = v
    with _lock, _db() as con:
        for k, v in clean.items():
            con.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, json.dumps(v)))
    _settings_cache = (0.0, {})
    audit("settings_changed", None, ", ".join(f"{k}={v}" for k, v in clean.items()), request)
    return get_settings()


# -- personal API tokens --


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field("", max_length=500)
    expires_days: Optional[int] = Field(None, ge=1, le=3650)


class TokenChange(BaseModel):
    # disabled: temporarily deactivated (enable it again); revoking deletes it for good
    disabled: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)


@router.get("/tokens")
def list_tokens() -> list[dict]:
    p = require_user()
    with _db() as con:
        return [json.loads(r) for (r,) in con.execute("SELECT record FROM tokens WHERE user_id = ?", (p["id"],)).fetchall()]


@router.post("/tokens")
def create_token(req: TokenIn) -> dict:
    """A personal API token for scripts (Authorization: Bearer …); shown once."""
    p = require_user()
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    rec = {"id": "tok-" + uuid.uuid4().hex[:10], "name": req.name, "description": req.description, "disabled": False, "prefix": token[:14],
           "created_at": _iso(), "last_used_at": None,
           "expires_at": _iso(_now() + timedelta(days=req.expires_days)) if req.expires_days else None}
    with _lock, _db() as con:
        con.execute("INSERT INTO tokens (id, user_id, token_hash, record) VALUES (?, ?, ?, ?)", (rec["id"], p["id"], _sha(token), json.dumps(rec)))
    audit("token_created", _user(p["id"]), req.name)
    return {**rec, "token": token}


@router.patch("/tokens/{token_id}")
def update_token(token_id: str, req: TokenChange) -> dict:
    """Disable a token for a while (or enable it again), or change its description."""
    p = require_user()
    with _lock, _db() as con:
        row = con.execute("SELECT record FROM tokens WHERE id = ? AND user_id = ?", (token_id, p["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Token not found")
        rec = json.loads(row[0])
        if req.disabled is not None:
            rec["disabled"] = req.disabled
        if req.description is not None:
            rec["description"] = req.description
        con.execute("UPDATE tokens SET record = ? WHERE id = ?", (json.dumps(rec), token_id))
    audit("token_disabled" if rec.get("disabled") else "token_changed", None, rec["name"])
    return rec


@router.delete("/tokens/{token_id}")
def delete_token(token_id: str) -> dict:
    p = require_user()
    with _lock, _db() as con:
        con.execute("DELETE FROM tokens WHERE id = ? AND user_id = ?", (token_id, p["id"]))
    return {"deleted": token_id}


# -- users (administrators) --


class UserIn(BaseModel):
    username: str
    password: str
    # the user picks their own password at the first sign-in
    must_change_password: bool = True
    display_name: str = ""
    first_name: str = ""
    last_name: str = ""
    email: str = ""
    organization_id: Optional[str] = None
    attributes: dict[str, str] = Field(default_factory=dict)
    role: str = Field("user", pattern="^(admin|user)$")
    markings: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)


class UserChange(BaseModel):
    display_name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    organization_id: Optional[str] = None
    attributes: Optional[dict[str, str]] = None
    role: Optional[str] = Field(None, pattern="^(admin|user)$")
    markings: Optional[list[str]] = None
    groups: Optional[list[str]] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None
    must_change_password: Optional[bool] = None
    # never made inactive for not signing in (Control Panel → Security → inactive days)
    exempt_from_inactivity: Optional[bool] = None


def _check_refs(markings: Optional[list[str]], org: Optional[str], groups: Optional[list[str]]) -> None:
    if markings and set(markings) - {m["id"] for m in _markings()}:
        raise HTTPException(400, "Unknown marking (organizations are set with organization_id)")
    if org and org not in {o["id"] for o in _orgs()}:
        raise HTTPException(400, "Unknown organization")
    if groups and set(groups) - {g["id"] for g in _groups()}:
        raise HTTPException(400, "Unknown group")


def _set_user_groups(user_id: str, groups: list[str]) -> None:
    for g in _groups():
        members = set(g.get("members") or [])
        has = user_id in members
        if (g["id"] in groups) != has:
            g["members"] = sorted(members ^ {user_id})
            _put_record("groups", g)


@router.get("/users")
def list_users(q: str = "", organization_id: Optional[str] = None, group_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    """Users, searchable by name, username or email and filtered by organization, group and status."""
    require_admin()
    out = []
    for u in _users():
        pu = _public_user(u)
        text = " ".join(str(pu.get(k) or "") for k in ("username", "display_name", "first_name", "last_name", "email")).lower()
        if q and q.lower() not in text:
            continue
        if organization_id and pu.get("organization_id") != organization_id:
            continue
        if group_id and group_id not in pu["groups"]:
            continue
        if status and pu["status"] != status:
            continue
        out.append({**pu, "effective_markings": sorted(user_markings(u))})
    return sorted(out, key=lambda u: u["username"])


@router.post("/users")
def create_user(req: UserIn, request: Request) -> dict:
    require_admin()
    _check_refs(req.markings, req.organization_id, req.groups)
    u = _new_user(req.username, req.password, req.role, req.display_name, req.markings, first_name=req.first_name, last_name=req.last_name,
                  email=req.email, organization_id=req.organization_id, attributes=req.attributes, must_change_password=req.must_change_password)
    if req.groups:
        _set_user_groups(u["id"], req.groups)
    audit("user_created", u, f"role {req.role}", request)
    return _public_user(u)


@router.get("/users/{user_id}")
def get_user(user_id: str) -> dict:
    require_admin()
    u = _user(user_id)
    with _db() as con:
        sessions = con.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ? AND expires_at > ?", (user_id, _iso())).fetchone()[0]
        tokens = con.execute("SELECT COUNT(*) FROM tokens WHERE user_id = ?", (user_id,)).fetchone()[0]
    return {**_public_user(u), "effective_markings": sorted(user_markings(u)), "active_sessions": sessions, "api_tokens": tokens}


@router.put("/users/{user_id}")
def update_user(user_id: str, req: UserChange, request: Request) -> dict:
    me_ = require_admin()
    u = _user(user_id)
    admins = [x for x in _users() if x["role"] == "admin" and not x.get("disabled") and x["id"] != user_id]
    if (req.role == "user" or req.disabled) and u["role"] == "admin" and not admins:
        raise HTTPException(400, "Keep at least one active administrator")
    _check_refs(req.markings, req.organization_id, req.groups)
    changes = []
    if req.markings is not None:
        u["markings"] = sorted(set(req.markings))
        changes.append("markings")
    for k in ("display_name", "first_name", "last_name", "email", "organization_id", "attributes", "role", "disabled", "exempt_from_inactivity"):
        v = getattr(req, k)
        if v is not None and v != u.get(k):
            u[k] = (v or None) if k == "organization_id" else v
            changes.append(k)
    pw = None
    if req.password:
        _check_password(req.password, u)
        _set_password(u, req.password, must_change=req.must_change_password is not False)
        pw = True
        changes.append("password reset")
    elif req.must_change_password is not None:
        u["must_change_password"] = req.must_change_password
        changes.append("must change password")
    if not pw:
        _save_user(u)
    if req.groups is not None:
        _set_user_groups(user_id, req.groups)
        changes.append("groups")
    if (req.disabled or pw) and user_id != me_["id"]:
        # a deactivated account or a reset password signs the user out everywhere
        with _lock, _db() as con:
            con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    _cache.clear()
    if changes:
        audit("user_deactivated" if req.disabled else "user_reactivated" if req.disabled is False and "disabled" in changes else "user_updated", u, ", ".join(changes), request)
    return _public_user(u)


@router.delete("/users/{user_id}/sessions")
def sign_out_everywhere(user_id: str, request: Request) -> dict:
    """End every session of a user (they sign in again); API tokens are kept."""
    require_admin()
    u = _user(user_id)
    with _lock, _db() as con:
        n = con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
    audit("signed_out_everywhere", u, f"{n} sessions", request)
    return {"ended": n}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request) -> dict:
    me_ = require_admin()
    if user_id == me_["id"]:
        raise HTTPException(400, "You cannot delete yourself")
    u = _user(user_id)
    _set_user_groups(user_id, [])
    with _lock, _db() as con:
        for t in ("users", "sessions", "tokens", "user_secrets", "password_history", "action_tokens", "job_tokens"):
            con.execute(f"DELETE FROM {t} WHERE {'id' if t == 'users' else 'user_id'} = ?", (user_id,))
        con.execute("DELETE FROM project_roles WHERE principal_type = 'user' AND principal_id = ?", (user_id,))
        con.execute("DELETE FROM item_roles WHERE principal_type = 'user' AND principal_id = ?", (user_id,))
    _grants_reset()
    audit("user_deleted", u, request=request)
    return {"deleted": user_id}


def _put_record(table: str, rec: dict) -> None:
    with _lock, _db() as con:
        if table == "groups":
            row = con.execute("SELECT record FROM groups WHERE id = ?", (rec["id"],)).fetchone()
            _bound_memberships(rec, json.loads(row[0]) if row else {})
        con.execute(f"INSERT INTO {table} (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record", (rec["id"], json.dumps(rec)))
    _cache.clear()


def expiry_limit(g: dict) -> Optional[str]:
    """The latest a new membership of a group may last (its expiration policy: a latest date and / or a maximum
    duration — the more constraining one); None: no policy."""
    pol = g.get("expiry_policy") or {}
    limits = []
    if pol.get("latest"):
        limits.append(pol["latest"])
    if pol.get("max_days"):
        limits.append(_iso(_now() + timedelta(days=int(pol["max_days"]))))
    return min(limits) if limits else None


def _bound_memberships(g: dict, old: dict) -> None:
    """Every write of a group (Control Panel, Approvals, SCIM, single sign-on, templates): new memberships of a group
    with an expiration policy expire by its limit, and no expiry is moved past it; when each expiry was set (for the
    seven-day reminder)."""
    exp = dict(g.get("member_expiry") or {})
    limit = expiry_limit(g)
    if limit:
        new = set(g.get("members") or []) - set(old.get("members") or [])
        for u in g.get("members") or []:
            if u in new or (exp.get(u) and exp[u] != (old.get("member_expiry") or {}).get(u)):
                exp[u] = min(exp.get(u) or limit, limit)
    members = set(g.get("members") or [])
    g["member_expiry"] = {u: at for u, at in exp.items() if u in members}
    was = old.get("member_expiry") or {}
    set_at = {u: at for u, at in (g.get("member_expiry_set") or {}).items() if u in g["member_expiry"]}
    for u, at in g["member_expiry"].items():
        if was.get(u) != at:
            set_at[u] = _iso()
    g["member_expiry_set"] = set_at
    g["expiry_reminded"] = {u: at for u, at in (g.get("expiry_reminded") or {}).items() if g["member_expiry"].get(u) == at}


def _membership_notices(g: dict, gone: set[str]) -> list[tuple[str, str, str]]:
    """Expired memberships: a revocation notice; seven days before an expiry: a reminder (not for memberships set
    to last less than seven days). Marks reminders sent; the caller delivers after saving. Account → Notifications
    can turn them off (source "groups")."""
    out = [(u, f"Your membership of {g['name']} ended", f"Your temporary membership of the group {g['name']} expired.") for u in sorted(gone)]
    soon = _iso(_now() + timedelta(days=7))
    for u, at in (g.get("member_expiry") or {}).items():
        if at > soon or (g.get("expiry_reminded") or {}).get(u) == at:
            continue
        g.setdefault("expiry_reminded", {})[u] = at
        set_at = (g.get("member_expiry_set") or {}).get(u)
        if set_at and set_at > _iso(datetime.fromisoformat(at) - timedelta(days=7)):
            continue  # set to last less than seven days: no reminder
        out.append((u, f"Your membership of {g['name']} ends soon", f"Your membership of the group {g['name']} expires on {at[:10]}."))
    return out


_noticing = threading.local()


def _deliver_notices(notices: list[tuple[str, str, str]]) -> None:
    if not notices or getattr(_noticing, "on", False):
        return
    import notify

    _noticing.on = True
    try:
        for u, subject, body in notices:
            try:
                notify.deliver(u, subject, body, source="groups")
            except Exception:  # noqa: BLE001
                log.exception("group membership notice")
    finally:
        _noticing.on = False


# -- groups --


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    members: list[str] = Field(default_factory=list)
    markings: list[str] = Field(default_factory=list)
    # users who review requests to join the group (Approvals); None keeps the current managers
    managers: Optional[list[str]] = None
    # groups whose members are members of this one too (nested groups); None keeps them
    member_groups: Optional[list[str]] = None
    # {user id: ISO date}: when a membership ends; None keeps them
    member_expiry: Optional[dict[str, str]] = None
    # bound to an identity provider's group: {provider: google|microsoft|okta|oidc|saml|*, name}; members follow
    # single sign-on (None keeps it, {} unbinds)
    realm: Optional[dict[str, str]] = None
    # free attributes; "access-request:<category>" ones become choices of the access request form
    attributes: Optional[dict[str, str]] = None
    # the group's point of contact: {kind: email|issues, value}
    contact: Optional[dict[str, str]] = None
    # temporary memberships: {latest: ISO date, max_days: int} (either or both; {} removes)
    expiry_policy: Optional[dict[str, Any]] = None
    # access requests to join: {min_approvals: int, reviewers: ["user:<id>", "group:<id>"]} ({} removes; no
    # reviewers: the group's managers)
    approval_policy: Optional[dict[str, Any]] = None


def _group_extras(g: dict, req: GroupIn, known: set[str]) -> None:
    groups = {x["id"]: x for x in _groups()}
    if req.member_groups is not None:
        bad = set(req.member_groups) - set(groups)
        if bad:
            raise HTTPException(400, f"Unknown group {sorted(bad)[0]}")
        # no cycles: a nested group may not contain this group
        trial = {**groups, g["id"]: {**g, "member_groups": list(req.member_groups)}}
        seen, todo = set(), list(req.member_groups)
        while todo:
            gid = todo.pop()
            if gid == g["id"]:
                raise HTTPException(400, "A group cannot contain itself (through nested groups)")
            if gid in seen:
                continue
            seen.add(gid)
            todo += list((trial.get(gid) or {}).get("member_groups") or [])
        g["member_groups"] = sorted(set(req.member_groups))
    if req.member_expiry is not None:
        exp = {}
        for uid, at in req.member_expiry.items():
            if uid in known and at:
                try:
                    exp[uid] = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="seconds") if "T" in at \
                        else datetime.fromisoformat(at).replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
                except ValueError:
                    raise HTTPException(400, f"Bad expiry date {at}") from None
        g["member_expiry"] = {u: at for u, at in exp.items() if u in (g.get("members") or [])}
    if req.attributes is not None:
        g["attributes"] = {str(k).strip()[:80]: str(v).strip()[:200] for k, v in req.attributes.items() if str(k).strip()}
    if req.contact is not None:
        if req.contact and (req.contact.get("kind") not in ("email", "issues") or (req.contact["kind"] == "email" and "@" not in (req.contact.get("value") or ""))):
            raise HTTPException(400, "A contact is an email address or Issues")
        g["contact"] = {"kind": req.contact["kind"], "value": (req.contact.get("value") or "").strip()} if req.contact else None
    if req.expiry_policy is not None:
        pol: dict[str, Any] = {}
        if req.expiry_policy.get("latest"):
            try:
                pol["latest"] = datetime.fromisoformat(str(req.expiry_policy["latest"])[:10]).replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
            except ValueError:
                raise HTTPException(400, "The latest expiration is a date") from None
        if req.expiry_policy.get("max_days"):
            try:
                pol["max_days"] = int(req.expiry_policy["max_days"])
            except (TypeError, ValueError):
                raise HTTPException(400, "The maximum duration is a number of days") from None
            if not 1 <= pol["max_days"] <= 3650:
                raise HTTPException(400, "The maximum duration is 1 to 3650 days")
        g["expiry_policy"] = pol or None
    if req.approval_policy is not None:
        ap: dict[str, Any] = {}
        if req.approval_policy:
            n = int(req.approval_policy.get("min_approvals") or 1)
            if not 1 <= n <= 10:
                raise HTTPException(400, "1 to 10 approvals")
            ap = {"min_approvals": n, "reviewers": _clean_principals([str(x) for x in req.approval_policy.get("reviewers") or []])}
        g["approval_policy"] = ap or None
    if req.realm is not None:
        if req.realm and (not req.realm.get("name") or req.realm.get("provider") not in ("google", "microsoft", "okta", "oidc", "saml", "*")):
            raise HTTPException(400, "A realm binding names a provider (google, microsoft, okta, oidc, saml or *) and an external group")
        g["realm"] = {"provider": req.realm["provider"], "name": req.realm["name"].strip()} if req.realm else None


@router.get("/groups")
def list_groups() -> list[dict]:
    require_user()
    users = {u["id"]: u for u in _users()}
    gs = _groups()
    return sorted(({**g, "member_names": [users[m]["username"] for m in g.get("members") or [] if m in users],
                    "effective_members": len(group_members(g, gs))} for g in gs), key=lambda g: g["name"].lower())


@router.post("/groups")
def create_group(req: GroupIn, request: Request) -> dict:
    require_admin()
    if any(g["name"].lower() == req.name.strip().lower() for g in _groups()):
        raise HTTPException(409, "A group with that name exists")
    _check_refs(req.markings, None, None)
    known = {u["id"] for u in _users()}
    g = {"id": "grp-" + uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description, "members": sorted(set(req.members) & known),
         "markings": sorted(set(req.markings)), "managers": sorted(set(req.managers or []) & known), "created_at": _iso()}
    _group_extras(g, req, known)
    _put_record("groups", g)
    audit("group_created", None, g["name"], request)
    return g


@router.put("/groups/{group_id}")
def update_group(group_id: str, req: GroupIn, request: Request) -> dict:
    require_admin()
    g = next((x for x in _groups() if x["id"] == group_id), None)
    if not g:
        raise HTTPException(404, "Group not found")
    _check_refs(req.markings, None, None)
    known = {u["id"] for u in _users()}
    g.update(name=req.name.strip(), description=req.description, members=sorted(set(req.members) & known), markings=sorted(set(req.markings)))
    if req.managers is not None:
        g["managers"] = sorted(set(req.managers) & known)
    _group_extras(g, req, known)
    _put_record("groups", g)
    audit("group_updated", None, g["name"], request)
    return g


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, request: Request) -> dict:
    require_admin()
    with _lock, _db() as con:
        con.execute("DELETE FROM groups WHERE id = ?", (group_id,))
    _cache.clear()
    audit("group_deleted", None, group_id, request)
    return {"deleted": group_id}


# -- organizations --


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    color: str = "#2f6fdf"
    # guest members: users of other organizations who also hold this organization's marking
    guests: Optional[list[str]] = None
    # "user:<id>" / "group:<id>": who may add the organization to resources (its members may too), and who may
    # expand access (remove it, or add other organizations); None keeps them
    apply: Optional[list[str]] = None
    expand_access: Optional[list[str]] = None


def _org_view(o: dict, counts: dict[str, int]) -> dict:
    return {**o, "marking": org_marking(o["id"]), "members": counts.get(o["id"], 0), "guests": o.get("guests") or [],
            "apply": o.get("apply") or [], "expand_access": o.get("expand_access") or []}


def _org_people(o: dict, req: OrgIn) -> None:
    if req.guests is not None:
        users = {u["id"]: u for u in _users()}
        bad = [g for g in req.guests if g not in users]
        if bad:
            raise HTTPException(400, f"Unknown user {bad[0]}")
        o["guests"] = sorted({g for g in req.guests if users[g].get("organization_id") != o["id"]})
    if req.apply is not None:
        o["apply"] = _clean_principals(req.apply)
    if req.expand_access is not None:
        o["expand_access"] = _clean_principals(req.expand_access)


@router.get("/organizations")
def list_orgs() -> list[dict]:
    require_user()
    counts: dict[str, int] = {}
    for u in _users():
        if u.get("organization_id"):
            counts[u["organization_id"]] = counts.get(u["organization_id"], 0) + 1
    return sorted((_org_view(o, counts) for o in _orgs()), key=lambda o: o["name"].lower())


@router.post("/organizations")
def create_org(req: OrgIn, request: Request) -> dict:
    require_admin()
    if any(o["name"].lower() == req.name.strip().lower() for o in _orgs()):
        raise HTTPException(409, "An organization with that name exists")
    o = {"id": uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description, "color": req.color, "created_at": _iso()}
    _org_people(o, req)
    _put_record("organizations", o)
    audit("organization_created", None, o["name"], request)
    return _org_view(o, {})


@router.put("/organizations/{org_id}")
def update_org(org_id: str, req: OrgIn) -> dict:
    require_admin()
    o = next((x for x in _orgs() if x["id"] == org_id), None)
    if not o:
        raise HTTPException(404, "Organization not found")
    o.update(name=req.name.strip(), description=req.description, color=req.color)
    _org_people(o, req)
    _put_record("organizations", o)
    audit("organization_changed", None, f"{o['name']}: guests {o.get('guests') or []}, apply {o.get('apply') or []}, expand access {o.get('expand_access') or []}")
    return _org_view(o, {})


@router.delete("/organizations/{org_id}")
def delete_org(org_id: str, request: Request) -> dict:
    require_admin()
    if any(u.get("organization_id") == org_id for u in _users()):
        raise HTTPException(409, "Move the organization's users to another organization first")
    with _db() as con:
        used = sum(1 for own, inh in con.execute("SELECT own, inherited FROM item_markings").fetchall() if org_marking(org_id) in json.loads(own) + json.loads(inh))
    if used:
        raise HTTPException(409, f"{used} item{'s are' if used != 1 else ' is'} restricted to this organization")
    with _lock, _db() as con:
        con.execute("DELETE FROM organizations WHERE id = ?", (org_id,))
    audit("organization_deleted", None, org_id, request)
    return {"deleted": org_id}


# -- sign-in activity --


@router.get("/audit")
def audit_log(user_id: Optional[str] = None, event: Optional[str] = None, limit: int = 200) -> list[dict]:
    """Sign-ins, failures, sign-outs and account changes, newest first."""
    require_admin()
    where, params = [], []
    if user_id:
        where.append("user_id = ?")
        params.append(user_id)
    if event:
        where.append("event = ?")
        params.append(event)
    sql = "SELECT at, event, user_id, username, actor, ip, detail FROM audit" + (f" WHERE {' AND '.join(where)}" if where else "") + " ORDER BY id DESC LIMIT ?"
    with _db() as con:
        rows = con.execute(sql, (*params, max(1, min(limit, 2000)))).fetchall()
    return [dict(zip(("at", "event", "user_id", "username", "actor", "ip", "detail"), r)) for r in rows]


# -- marking categories --

# every marking without a category is in this one (conjunctive, visible); organizations form their own disjunctive one
DEFAULT_CATEGORY = "cat-general"
ORG_CATEGORY = "cat-organizations"


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = ""
    # conjunctive: a user needs every marking of the category on a resource; disjunctive: any one of them;
    # hierarchical (classification-based access controls): markings are levels, holding a level satisfies it and
    # every lower one (UNCLASSIFIED < CONFIDENTIAL < SECRET …)
    kind: str = Field("conjunctive", pattern="^(conjunctive|disjunctive|hierarchical)$")
    # hidden: only category viewers / administrators and holders of its markings know it exists
    visibility: str = Field("visible", pattern="^(visible|hidden)$")
    administrators: list[str] = Field(default_factory=list)
    viewers: list[str] = Field(default_factory=list)
    # restricted to one organization: never visible outside it
    organization_id: Optional[str] = None


def _categories() -> list[dict]:
    with _db() as con:
        rows = [json.loads(r) for (r,) in con.execute("SELECT record FROM marking_categories").fetchall()]
    if not any(c["id"] == DEFAULT_CATEGORY for c in rows):
        rows.insert(0, {"id": DEFAULT_CATEGORY, "name": "General", "description": "Markings without a category", "kind": "conjunctive",
                        "visibility": "visible", "administrators": [], "viewers": [], "organization_id": None, "builtin": True})
    rows.append({"id": ORG_CATEGORY, "name": "Organizations", "description": "Each organization is a marking its members hold; a resource in "
                 "several organizations is open to members of any of them", "kind": "disjunctive", "visibility": "visible",
                 "administrators": [], "viewers": [], "organization_id": None, "builtin": True})
    return rows


_disj_cache: tuple[float, Any] = (0.0, ({}, {}))


def _category_index() -> tuple[dict[str, str], dict[str, tuple[str, int]]]:
    """({marking: category} of disjunctive categories, organizations included; {marking: (category, level)} of
    hierarchical ones)."""
    global _disj_cache
    if time.time() - _disj_cache[0] < 5:
        return _disj_cache[1]
    cats = {c["id"]: c for c in _categories()}
    disj: dict[str, str] = {}
    hier: dict[str, tuple[str, int]] = {}
    for m in _markings():
        cid = m.get("category_id") or DEFAULT_CATEGORY
        kind = (cats.get(cid) or {}).get("kind")
        if kind == "disjunctive":
            disj[m["id"]] = cid
        elif kind == "hierarchical":
            hier[m["id"]] = (cid, int(m.get("level") or 0))
    disj.update({org_marking(o["id"]): ORG_CATEGORY for o in _orgs()})
    _disj_cache = (time.time(), (disj, hier))
    return disj, hier


def _disjunctive_index() -> dict[str, str]:
    return _category_index()[0]


def missing_markings(need: Any, held: Any) -> set[str]:
    """The markings of `need` a holder of `held` does not satisfy. Conjunctive markings are each required; within a
    disjunctive category (organizations, or one an administrator made disjunctive) holding any one of the category's
    markings on the resource satisfies all of them; in a hierarchical category (classifications) holding a level at
    least as high satisfies it."""
    need, held = set(need or ()), set(held or ())
    lacking = need - held
    if not lacking:
        return set()
    disj, hier = _category_index()
    satisfied = {disj[m] for m in need & held if m in disj}
    top: dict[str, int] = {}
    for m in held:
        if m in hier:
            c, lv = hier[m]
            top[c] = max(top.get(c, -1), lv)
    out = set()
    for m in lacking:
        if m in disj and disj[m] in satisfied:
            continue
        if m in hier and top.get(hier[m][0], -1) >= hier[m][1]:
            continue
        out.add(m)
    return out


def satisfies(need: Any, held: Any) -> bool:
    return not missing_markings(need, held)


def _principal_keys(p: dict) -> set[str]:
    return {f"user:{p.get('id')}"} | {f"group:{g}" for g in p.get("groups") or []}


def marking_labels() -> dict[str, str]:
    """{marking id: name} as the caller may see them (hidden categories masked), organizations included."""
    return {k: v["name"] for k, v in _marking_info().items()}


def _clean_principals(values: list[str]) -> list[str]:
    users, groups = {u["id"] for u in _users()}, {g["id"] for g in _groups()}
    out = set()
    for v in values:
        t, _, i = str(v).partition(":")
        if not i:  # a bare id is a user
            t, i = "user", t
        if (t == "user" and i in users) or (t == "group" and i in groups):
            out.add(f"{t}:{i}")
        else:
            raise HTTPException(400, f"Unknown user or group {v}")
    return sorted(out)


def _is_admin(p: Optional[dict]) -> bool:
    return not enabled() or p is None or bool(p.get("service")) or p.get("role") == "admin"


def category_role(cat: dict, p: Optional[dict] = None) -> Optional[str]:
    """administrator / viewer of a category, or None."""
    p = p if p is not None else current()
    if _is_admin(p):
        return "administrator"
    keys = _principal_keys(p)
    if keys & set(cat.get("administrators") or []):
        return "administrator"
    if keys & set(cat.get("viewers") or []):
        return "viewer"
    return None


def marking_permissions(m: dict, p: Optional[dict] = None) -> dict[str, bool]:
    """What a user may do with a marking: member (sees what it protects), manage (its permissions, members and
    metadata), apply (put it on resources), remove (take it off; needs apply too). Platform administrators manage
    every marking. Markings made before these permissions existed let their members apply (not remove) them."""
    p = p if p is not None else current()
    member = p is None or not enabled() or m["id"] in (p.get("markings") or set())
    if _is_admin(p):
        return {"member": member, "manage": True, "apply": True, "remove": True}
    keys = _principal_keys(p)
    manage = p.get("id") in (m.get("managers") or []) or bool(keys & set(m.get("manage") or []))
    apply = manage or bool(keys & set(m.get("apply") or [])) or ("apply" not in m and member)
    remove = apply and (manage or bool(keys & set(m.get("remove") or [])))
    return {"member": member, "manage": manage, "apply": apply, "remove": remove}


def _marking_visible(m: dict, cats: dict[str, dict], p: Optional[dict]) -> bool:
    cat = cats.get(m.get("category_id") or DEFAULT_CATEGORY) or {}
    if _is_admin(p):
        return True
    if cat.get("organization_id") and cat["organization_id"] != p.get("organization_id"):
        return False
    if cat.get("visibility") != "hidden" or category_role(cat, p):
        return True
    in_cat = {x["id"] for x in _markings() if (x.get("category_id") or DEFAULT_CATEGORY) == cat.get("id")}
    perms = marking_permissions(m, p)
    return bool(in_cat & set(p.get("markings") or set())) or perms["manage"] or perms["remove"]


@router.get("/marking-categories")
def list_categories() -> list[dict]:
    p = require_user()
    out = []
    for c in _categories():
        if c["id"] != ORG_CATEGORY and not _is_admin(p):
            if c.get("organization_id") and c["organization_id"] != p.get("organization_id"):
                continue
            if c.get("visibility") == "hidden" and not category_role(c, p):
                mine = {m["id"] for m in _markings() if (m.get("category_id") or DEFAULT_CATEGORY) == c["id"]}
                if not mine & set(p.get("markings") or set()):
                    continue
        out.append({**c, "my_role": category_role(c, p)})
    return out


def _save_category(c: dict) -> None:
    global _disj_cache
    with _lock, _db() as con:
        con.execute("INSERT INTO marking_categories (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
                    (c["id"], json.dumps(c)))
    _disj_cache = (0.0, {})


@router.post("/marking-categories")
def create_category(req: CategoryIn, request: Request) -> dict:
    """New marking category (administrators); its creator administers it. Categories cannot be deleted."""
    me_ = require_admin()
    if any(c["name"].lower() == req.name.strip().lower() for c in _categories()):
        raise HTTPException(409, "A category with that name exists")
    if req.organization_id and req.organization_id not in {o["id"] for o in _orgs()}:
        raise HTTPException(400, "Unknown organization")
    creator = [] if me_.get("id") in (None, "local") else ["user:" + me_["id"]]
    c = {"id": "cat-" + uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description, "kind": req.kind, "visibility": req.visibility,
         "administrators": _clean_principals(req.administrators) or creator, "viewers": _clean_principals(req.viewers),
         "organization_id": req.organization_id, "created_at": _iso()}
    _save_category(c)
    audit("marking_category_created", None, f"{c['name']} ({c['kind']}, {c['visibility']})", request)
    return c


@router.put("/marking-categories/{category_id}")
def update_category(category_id: str, req: CategoryIn, request: Request) -> dict:
    """Change a category (its administrators). Its kind changes how access to every marking in it is decided."""
    require_user()
    c = next((x for x in _categories() if x["id"] == category_id), None)
    if not c:
        raise HTTPException(404, "Category not found")
    if category_id == ORG_CATEGORY:
        raise HTTPException(400, "The organizations category is built in")
    if category_role(c) != "administrator":
        raise HTTPException(403, "Only the category's administrators can change it")
    if req.organization_id and req.organization_id not in {o["id"] for o in _orgs()}:
        raise HTTPException(400, "Unknown organization")
    c = {**{k: v for k, v in c.items() if k != "builtin"}, "name": req.name.strip(), "description": req.description, "kind": req.kind,
         "visibility": req.visibility, "administrators": _clean_principals(req.administrators), "viewers": _clean_principals(req.viewers),
         "organization_id": req.organization_id, "updated_at": _iso()}
    _save_category(c)
    audit("marking_category_changed", None, f"{c['name']} ({c['kind']}, {c['visibility']})", request)
    return c


# -- markings --


class MarkingIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = ""
    color: str = "#c0392b"
    # users who manage the marking (review its access requests in Approvals); None keeps them
    managers: Optional[list[str]] = None
    category_id: Optional[str] = None
    # the level of a classification marking (hierarchical categories): higher levels satisfy lower ones
    level: Optional[int] = Field(None, ge=0, le=1000)
    # users / groups ("user:<id>", "group:<id>") who manage / may apply / may remove the marking; None keeps them
    manage: Optional[list[str]] = None
    apply: Optional[list[str]] = None
    remove: Optional[list[str]] = None


@router.get("/markings")
def list_markings() -> list[dict]:
    p = require_user()
    members: dict[str, int] = {}
    for u in _users():
        for m in user_markings(u):
            members[m] = members.get(m, 0) + 1
    with _db() as con:
        uses: dict[str, int] = {}
        for own, inh in con.execute("SELECT own, inherited FROM item_markings").fetchall():
            for m in set(json.loads(own)) | set(json.loads(inh)):
                uses[m] = uses.get(m, 0) + 1
    cats = {c["id"]: c for c in _categories()}
    out = []
    for m in _markings():
        if not _marking_visible(m, cats, p):
            continue
        cat = cats.get(m.get("category_id") or DEFAULT_CATEGORY) or {}
        out.append({**m, "category_id": m.get("category_id") or DEFAULT_CATEGORY, "category": cat.get("name"), "category_kind": cat.get("kind"),
                    "members": members.get(m["id"], 0), "items": uses.get(m["id"], 0), "permissions": marking_permissions(m, p)})
    return sorted(out, key=lambda m: m["name"].lower())


def _check_category_for(category_id: Optional[str], p: dict) -> str:
    cats = {c["id"]: c for c in _categories()}
    cid = category_id or DEFAULT_CATEGORY
    if cid not in cats or cid == ORG_CATEGORY:
        raise HTTPException(400, "Unknown marking category")
    if category_role(cats[cid], p) != "administrator":
        raise HTTPException(403, "Creating a marking in this category needs administering the category")
    return cid


@router.post("/markings")
def create_marking(req: MarkingIn) -> dict:
    """New marking (platform administrators, or administrators of its category). Its creator manages it and holds it."""
    global _disj_cache
    me_ = require_user()
    cid = _check_category_for(req.category_id, me_)
    if any(m["name"].lower() == req.name.strip().lower() for m in _markings()):
        raise HTTPException(409, "A marking with that name exists")
    creator = [] if me_.get("id") in (None, "local") else ["user:" + me_["id"]]
    m = {"id": "mk-" + uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description, "color": req.color,
         "managers": sorted(set(req.managers or []) & {u["id"] for u in _users()}), "category_id": cid,
         "manage": sorted(set(_clean_principals(req.manage or [])) | set(creator)), "apply": _clean_principals(req.apply or []),
         "remove": _clean_principals(req.remove or []), "created_at": _iso()}
    if req.level is not None:
        m["level"] = req.level
    with _lock, _db() as con:
        con.execute("INSERT INTO markings (id, record) VALUES (?, ?)", (m["id"], json.dumps(m)))
    _disj_cache = (0.0, {})
    # whoever creates a marking holds it
    u = _user(me_["id"]) if me_["id"] not in ("local",) else None
    if u:
        u["markings"] = sorted(set(u.get("markings") or []) | {m["id"]})
        _save_user(u)
    audit("marking_created", None, m["name"])
    return m


@router.put("/markings/{marking_id}")
def update_marking(marking_id: str, req: MarkingIn) -> dict:
    """Change a marking's metadata and permissions (those who manage it). Its category cannot change."""
    global _disj_cache
    require_user()
    ms = {m["id"]: m for m in _markings()}
    if marking_id not in ms:
        raise HTTPException(404, "Marking not found")
    if not marking_permissions(ms[marking_id])["manage"]:
        raise HTTPException(403, "Only those who manage this marking can change it")
    if req.category_id and req.category_id != (ms[marking_id].get("category_id") or DEFAULT_CATEGORY):
        raise HTTPException(400, "A marking cannot move to another category")
    m = {**ms[marking_id], "name": req.name.strip(), "description": req.description, "color": req.color}
    if req.level is not None:
        m["level"] = req.level
    if req.managers is not None:
        m["managers"] = sorted(set(req.managers) & {u["id"] for u in _users()})
    for k in ("manage", "apply", "remove"):
        v = getattr(req, k)
        if v is not None:
            m[k] = _clean_principals(v)
    with _lock, _db() as con:
        con.execute("UPDATE markings SET record = ? WHERE id = ?", (json.dumps(m), marking_id))
    _disj_cache = (0.0, {})
    audit("marking_changed", None, f"{m['name']}: manage {m.get('manage')}, apply {m.get('apply')}, remove {m.get('remove')}")
    return m


@router.delete("/markings/{marking_id}")
def delete_marking(marking_id: str) -> dict:
    require_admin()
    with _db() as con:
        used = sum(1 for own, inh in con.execute("SELECT own, inherited FROM item_markings").fetchall() if marking_id in json.loads(own) + json.loads(inh))
    if used:
        raise HTTPException(409, f"The marking is on {used} item{'s' if used != 1 else ''}: remove it from them first")
    with _lock, _db() as con:
        con.execute("DELETE FROM markings WHERE id = ?", (marking_id,))
    for u in _users():
        if marking_id in (u.get("markings") or []):
            u["markings"] = [x for x in u["markings"] if x != marking_id]
            _save_user(u)
    return {"deleted": marking_id}


# -- markings on items --


class ItemMarkingsIn(BaseModel):
    markings: list[str]


def _item_markings_view(item_id: str) -> dict:
    own, inherited = _item_row(item_id)
    names = _marking_info()
    try:
        import db

        chain = [p for p in db.drive_path(item_id) if p["id"] != item_id]
    except Exception:  # noqa: BLE001
        chain = []
    from_folders = []
    for p in chain:
        o, i = _item_row(p["id"])
        for m in o + i:
            from_folders.append({"marking": m, "folder": p["name"], "folder_id": p["id"]})
    describe = lambda ids: [{"id": i, "name": names.get(i, {}).get("name", i), "color": names.get(i, {}).get("color"), "kind": names.get(i, {}).get("kind", "marking")} for i in ids]  # noqa: E731
    return {"item_id": item_id, "own": describe(own), "inherited": describe(inherited), "from_folders": [{**f, **describe([f["marking"]])[0]} for f in from_folders],
            "effective": describe(sorted(effective_markings(item_id))), "can_access": can_access(item_id)}


@router.get("/items/{item_id}/markings")
def get_item_markings(item_id: str) -> dict:
    require_user()
    return _item_markings_view(item_id)


def item_project(item_id: str) -> Optional[str]:
    """The Project of a Files item, or of a resource outside Files ("<kind>:<id>") that sits in one."""
    if ":" in item_id:
        kind, _, rid = item_id.partition(":")
        return resource_project(kind, rid)
    return project_of(item_id)


def _org_permission(org_id: str, p: dict, what: str) -> bool:
    """Apply organization (its members, or those given Apply) / Expand access (removing it: those given Expand access)."""
    if _is_admin(p):
        return True
    o = next((x for x in _orgs() if x["id"] == org_id), None) or {}
    keys = _principal_keys(p)
    if what == "apply":
        return p.get("organization_id") == org_id or bool(keys & set(o.get("apply") or [])) or bool(keys & set(o.get("expand_access") or []))
    return bool(keys & set(o.get("expand_access") or []))


def check_marking_change(item_id: str, added: set[str], removed: set[str], p: Optional[dict] = None) -> None:
    """Applying a marking needs its Apply permission and the Owner role on the resource ("Update markings on
    resource"); removing one needs Apply and Remove (Expand access for an organization) and the Owner role."""
    p = p if p is not None else current()
    if not enabled() or p is None or p.get("service") or not (added or removed):
        return
    if "markings" not in operations_for(item_project(item_id), p):
        project = item_project(item_id)
        raise HTTPException(403, "Changing the markings of a resource needs the Owner role on it",
                            headers=access_header("project", project_id=project, project=_project_name(project), role="owner") if project else None)
    ms = {m["id"]: m for m in _markings()}
    for mid in sorted(added | removed):
        if mid.startswith("org:") or mid not in ms:
            org_id = mid.partition(":")[2]
            ok = _org_permission(org_id, p, "apply") and (mid in added or _org_permission(org_id, p, "remove"))
        else:
            perms = marking_permissions(ms[mid], p)
            ok = perms["apply"] and (mid in added or perms["remove"])
        if not ok:
            verb = "apply" if mid in added else "remove"
            raise HTTPException(403, f"You do not have permission to {verb} the marking {', '.join(_marking_names([mid]))}"
                                     + ("" if verb == "apply" else " (removing a marking opens the resource to more people: it needs the Remove permission)"))


@router.put("/items/{item_id}/markings")
def set_item_markings(item_id: str, req: ItemMarkingsIn) -> dict:
    """Apply or remove markings on an item (Owner role, and the markings' Apply / Remove permissions). Inherited
    markings change at their source."""
    require_user()
    if not can_access(item_id):
        raise HTTPException(403, "You cannot access this item")
    known = _known_markings()
    want = set(req.markings)
    if want - known:
        raise HTTPException(400, "Unknown marking")
    own, inherited = _item_row(item_id)
    check_marking_change(item_id, want - set(own), set(own) - want)
    if want - set(own):
        why = constraint_violation(item_id, (effective_markings(item_id) - set(own)) | want)
        if why:
            raise HTTPException(409, why)
    _set_item(item_id, own=sorted(want))
    if item_id.startswith("connection:") and want - set(own):
        # the datasets already synced from this connection carry its new markings at once (not only from its next run)
        try:
            import datasources

            datasources.backfill_markings(dry_run=False, connection_id=item_id.split(":", 1)[1])
        except Exception:  # noqa: BLE001 - logged; the next run of each sync marks its dataset before anything else
            log.exception("marking the datasets synced from %s failed", item_id)
    audit("markings_changed", None, f"{item_id}: {', '.join(_marking_names(sorted(want))) or 'none'}")
    return _item_markings_view(item_id)


@router.get("/access")
def access_check(item_id: str, user_id: Optional[str] = None) -> dict:
    """Whether a user (default: me) can access an item, and which markings they lack."""
    p = require_user()
    if user_id and user_id != p["id"]:
        require_admin()
        u = _user(user_id)
        p = {**_public_user(u), "markings": user_markings(u), "service": False}
    need = effective_markings(item_id)
    lacking = sorted(missing_markings(need, p["markings"]))
    project = item_project(item_id)
    return {"can_access": has_operation(item_id, "read", p), "required": _marking_names(sorted(need)), "lacking": _marking_names(lacking),
            "file_markings_lacking": _marking_names(sorted(missing_markings(file_markings(item_id), p["markings"]))),
            "project_id": project, "role": role_for(project, p) if project else None, "operations": sorted(operations_for(project, p)),
            "can_discover": has_operation(item_id, "discover", p), "can_download": has_operation(item_id, "download", p),
            "can_edit": has_operation(item_id, "edit", p), "outside_projects_allowed": outside_projects_allowed(item_id, p)}


# ------------------------------------------------------------------------------------------------
# project roles
# ------------------------------------------------------------------------------------------------

ROLES = ("discoverer", "viewer", "editor", "owner")
ROLE_LABEL = {"discoverer": "Discoverer", "viewer": "Viewer", "editor": "Editor", "owner": "Owner"}
# what roles allow on a Project's resources: a role is a set of operations
OPERATIONS = {
    "discover": "See that a resource exists and its metadata (name, schema, lineage)",
    "read": "Read its data (previews, queries, use as an input)",
    "download": "Download or export its data",
    "edit": "Change it (files, pipelines, schedules, builds)",
    "markings": "Change its markings",
    "manage": "Manage the Project's roles",
}
DEFAULT_ROLE_OPS: dict[str, frozenset[str]] = {
    "discoverer": frozenset({"discover"}),
    "viewer": frozenset({"discover", "read", "download"}),
    "editor": frozenset({"discover", "read", "download", "edit"}),
    "owner": frozenset(OPERATIONS),
}
# the operation that makes a set of operations count as a default role (role_for, _rank)
KEY_OP = {"discoverer": "discover", "viewer": "read", "editor": "edit", "owner": "manage"}


def _rank(role: Optional[str]) -> int:
    return ROLES.index(role) + 1 if role in ROLES else 0


_custom_cache: tuple[float, list[dict]] = (0.0, [])


def custom_roles() -> list[dict]:
    """Roles administrators defined (Control Panel → Roles): {id, name, description, operations}."""
    global _custom_cache
    if time.time() - _custom_cache[0] < 5:
        return _custom_cache[1]
    with _db() as con:
        out = [json.loads(r) for (r,) in con.execute("SELECT record FROM custom_roles").fetchall()]
    _custom_cache = (time.time(), out)
    return out


def _custom_cache_reset() -> None:
    global _custom_cache
    _custom_cache = (0.0, [])


def role_operations(role: Optional[str]) -> frozenset[str]:
    if role in DEFAULT_ROLE_OPS:
        return DEFAULT_ROLE_OPS[role]
    hit = next((r for r in custom_roles() if r["id"] == role), None) if role else None
    return frozenset(hit.get("operations") or []) & frozenset(OPERATIONS) if hit else frozenset()


def role_label(role: Optional[str]) -> str:
    if role in ROLE_LABEL:
        return ROLE_LABEL[role]
    hit = next((r for r in custom_roles() if r["id"] == role), None) if role else None
    return hit["name"] if hit else str(role)


_project_cache: dict[str, tuple[float, Optional[str], Any]] = {}
_NO_ROOT = object()


def _root(item_id: str) -> tuple[Optional[str], Any]:
    """(the Project a Files item is in, or None; for an item outside Projects, the creator of its top-level item —
    None when unknown, _NO_ROOT when it is not a Files item)."""
    hit = _project_cache.get(item_id)
    if hit and time.time() - hit[0] < 10:
        return hit[1], hit[2]
    project, creator = None, _NO_ROOT
    try:
        import db

        chain = db.drive_path(item_id)
        if chain:
            root = db.drive_get(chain[0]["id"])
            if root and root.get("kind") == "project":
                project = root["id"]
            elif root:
                creator = root.get("created_by")
    except Exception:  # noqa: BLE001 - no database
        pass
    if len(_project_cache) > 20000:
        _project_cache.clear()
    _project_cache[item_id] = (time.time(), project, creator)
    return project, creator


def project_of(item_id: Optional[str]) -> Optional[str]:
    """The Project a Files item is in (itself, for a Project); None for top-level items and anything not in Files."""
    if not item_id or ":" in item_id:
        return None
    return _root(item_id)[0]


def outside_projects_allowed(item_id: Optional[str], p: Optional[dict]) -> bool:
    """Files items outside any Project are their creator's (and administrators'); with the setting "everyone" every
    signed-in user's, as before 2026-10-12. Items whose creator is unknown are administrators' only."""
    if not item_id or ":" in item_id or not enabled() or p is None or p.get("service") or p.get("role") == "admin":
        return True
    project, creator = _root(item_id)
    if project or creator is _NO_ROOT:
        return True
    if settings().get("files_outside_projects") == "everyone":
        return True
    # Files records the creator's username (drive.configure)
    return bool(creator) and creator in (p.get("username"), p.get("id"))


_roles_cache: dict[str, tuple[float, list[dict]]] = {}


def project_roles(project_id: str) -> list[dict]:
    hit = _roles_cache.get(project_id)
    if hit and time.time() - hit[0] < 5:
        return hit[1]
    with _db() as con:
        rows = con.execute("SELECT principal_type, principal_id, role FROM project_roles WHERE project_id = ?", (project_id,)).fetchall()
    out = [{"principal_type": t, "principal_id": i, "role": r} for t, i, r in rows]
    if len(_roles_cache) > 5000:
        _roles_cache.clear()
    _roles_cache[project_id] = (time.time(), out)
    return out


def operations_for(project_id: Optional[str], principal: Optional[dict] = None) -> frozenset[str]:
    """What the caller may do on a Project: the operations of every role granted to them, their groups and everyone.
    A Project without any roles is closed (administrators only); administrators, the system and sign-in off may do
    everything; resources outside Projects are governed by markings alone."""
    p = principal if principal is not None else current()
    if not project_id or not enabled() or p is None or p.get("service") or p.get("role") == "admin":
        return DEFAULT_ROLE_OPS["owner"]
    if p.get("project_scope") is not None and project_id not in p["project_scope"]:
        return frozenset()  # an application limited to other Projects
    rows = list(project_roles(project_id))
    sp = _space(project_id)
    if sp:
        # a space's access requirements: one of its organizations; its inherited roles apply to every Project in it
        orgs = sp.get("organizations") or []
        if orgs and not any(org_marking(o) in (p.get("markings") or set()) for o in orgs):
            # a Project made discoverable across organizations (Compass) shows that its resources exist
            try:
                import compass

                return frozenset({"discover"}) if compass.discoverable_across_orgs(project_id) else frozenset()
            except Exception:  # noqa: BLE001
                return frozenset()
        rows += sp.get("inherited_roles") or []
    groups = set(p.get("groups") or [])
    ops: set[str] = set()
    for r in rows:
        if (r["principal_type"] == "everyone" or (r["principal_type"] == "user" and r["principal_id"] == p.get("id"))
                or (r["principal_type"] == "group" and r["principal_id"] in groups)):
            ops |= role_operations(r["role"])
    if sp and sp.get("locked"):
        # a locked Marketplace Project: managed by the Marketplace, so no role edits it (administrators unlock it)
        ops &= {"discover", "read", "download"}
    return frozenset(ops)


# -- role grants on folders and files: a role granted on a folder (or a file) of a Project adds to the Project's roles
# for everything inside it; it never takes access away. Projects stay the boundary to prefer — grants serve a Project
# whose stages share one tree (Data Sampel BPJS: Arsip Sumber → Data Mentah → Data Bersih → Siap Analisis).

_grants_cache: tuple[float, dict[str, list[dict]]] = (0.0, {})


def _grant_index() -> dict[str, list[dict]]:
    """{folder or file id: [{principal_type, principal_id, role}]}: every grant (few), read at most every 5 s."""
    global _grants_cache
    if time.time() - _grants_cache[0] < 5:
        return _grants_cache[1]
    out: dict[str, list[dict]] = {}
    with _db() as con:
        for i, t, pid, r in con.execute("SELECT item_id, principal_type, principal_id, role FROM item_roles").fetchall():
            out.setdefault(i, []).append({"principal_type": t, "principal_id": pid, "role": r})
    _grants_cache = (time.time(), out)
    return out


def _grants_reset() -> None:
    global _grants_cache
    _grants_cache = (0.0, {})


def _grant_matches(r: dict, p: dict) -> bool:
    return (r["principal_type"] == "everyone" or (r["principal_type"] == "user" and r["principal_id"] == p.get("id"))
            or (r["principal_type"] == "group" and r["principal_id"] in set(p.get("groups") or [])))


def granted_operations(item_id: Optional[str], principal: Optional[dict] = None) -> frozenset[str]:
    """What the roles granted on a Files item and on the folders above it (below its Project) allow the caller. The
    Project's boundaries still hold: an application limited to other Projects, the space's organizations, a locked
    Marketplace Project."""
    p = principal if principal is not None else current()
    if not item_id or ":" in item_id or p is None:
        return frozenset()
    index = _grant_index()
    # most callers hold no grant at all: no path walk for them
    if not any(_grant_matches(r, p) for rows in index.values() for r in rows):
        return frozenset()
    project = project_of(item_id)
    if not project or (p.get("project_scope") is not None and project not in p["project_scope"]):
        return frozenset()
    sp = _space(project)
    orgs = (sp or {}).get("organizations") or []
    if orgs and not any(org_marking(o) in (p.get("markings") or set()) for o in orgs):
        return frozenset()
    try:
        import db

        chain = [x["id"] for x in db.drive_path(item_id)] or [item_id]
    except Exception:  # noqa: BLE001 - no database: the item alone
        chain = [item_id]
    ops: set[str] = set()
    for i in chain:
        if i != project:
            for r in index.get(i, ()):
                if _grant_matches(r, p):
                    ops |= role_operations(r["role"])
    if sp and sp.get("locked"):
        ops &= {"discover", "read", "download"}
    return frozenset(ops)


def grant_source(item_id: str, op: str, principal: dict) -> Optional[dict]:
    """The nearest grant on the item or a folder above it that gives the caller `op`: {item_id, item, role} (for an
    explanation such as "Viewer on the folder gold")."""
    index = _grant_index()
    try:
        import db

        chain = db.drive_path(item_id) or [{"id": item_id, "name": item_id}]
    except Exception:  # noqa: BLE001
        chain = [{"id": item_id, "name": item_id}]
    for c in reversed(chain):
        for r in index.get(c["id"], ()):
            if _grant_matches(r, principal) and op in role_operations(r["role"]):
                return {"item_id": c["id"], "item": c["name"], "role": r["role"], "role_label": role_label(r["role"])}
    return None


# the space a Project is in (governance_model.py): fn(project id) -> {organizations, inherited_roles, role_set}
SPACE_HOOK = None


def _space(project_id: str) -> Optional[dict]:
    if SPACE_HOOK is None:
        return None
    try:
        return SPACE_HOOK(project_id)
    except Exception:  # noqa: BLE001
        return None


def role_for(project_id: Optional[str], principal: Optional[dict] = None) -> Optional[str]:
    """The caller's role on a Project as a default role: the highest whose key operation they hold (a custom role
    that reads counts as Viewer, one that edits as Editor). None: no access."""
    ops = operations_for(project_id, principal)
    for name in ("owner", "editor", "viewer", "discoverer"):
        if KEY_OP[name] in ops:
            return name
    return None


def _project_name(project_id: str) -> str:
    try:
        import db

        return (db.drive_get(project_id) or {}).get("name") or "this Project"
    except Exception:  # noqa: BLE001
        return "this Project"


def check_project(project_id: Optional[str], need: str = "viewer") -> None:
    """403 unless the caller has at least the role `need` on the Project (no Project: nothing to check)."""
    if not project_id:
        return
    if KEY_OP.get(need, need) not in operations_for(project_id):
        have = role_for(project_id)
        name = _project_name(project_id)
        raise HTTPException(403, f"You need the {ROLE_LABEL[need]} role on {name}" + (f" (you are a {ROLE_LABEL[have]})" if have else ""),
                            headers=access_header("project", project_id=project_id, project=name, role=need))


def check_item_id(item_id: Optional[str], need: str = "viewer") -> None:
    """check_item for an item id (pipelines, schedules and builds name the pipeline's Files item)."""
    if not item_id:
        return
    check_item({"id": item_id}, need)


def project_created(project_id: str) -> None:
    """A new Project: its creator is an Owner and everyone gets the default role (Control Panel → Security)."""
    p = current()
    if not enabled() or p is None or p.get("service") or p.get("id") in (None, "local"):
        return
    default = settings()["project_default_role"]
    with _lock, _db() as con:
        con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'user', ?, 'owner') ON CONFLICT DO NOTHING",
                    (project_id, p["id"]))
        if default in ("discoverer", "viewer", "editor"):
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'everyone', '*', ?) ON CONFLICT DO NOTHING",
                        (project_id, default))
    _project_cache.clear()
    _roles_cache.clear()


class RoleIn(BaseModel):
    principal_type: str = Field(pattern="^(user|group|everyone)$")
    principal_id: str = "*"
    # a default role (discoverer, viewer, editor, owner) or a custom role's id
    role: str = Field(min_length=1, max_length=40)


class RolesIn(BaseModel):
    roles: list[RoleIn]


def _roles_view_rows(rows: list[dict]) -> list[dict]:
    users = {u["id"]: u for u in _users()}
    groups = {g["id"]: g for g in _groups()}
    out = []
    for r in rows:
        if r["principal_type"] == "user":
            u = users.get(r["principal_id"])
            name = (u.get("display_name") or u["username"]) if u else "(deleted user)"
        elif r["principal_type"] == "group":
            name = groups.get(r["principal_id"], {}).get("name", "(deleted group)")
        else:
            name = "Everyone"
        out.append({**r, "name": name, "role_label": role_label(r["role"])})
    return out


def _roles_view(project_id: str) -> dict:
    users = {u["id"]: u for u in _users()}
    groups = {g["id"]: g for g in _groups()}
    out = []
    for r in project_roles(project_id):
        if r["principal_type"] == "user":
            u = users.get(r["principal_id"])
            name = (u.get("display_name") or u["username"]) if u else "(deleted user)"
        elif r["principal_type"] == "group":
            name = groups.get(r["principal_id"], {}).get("name", "(deleted group)")
        else:
            name = "Everyone"
        out.append({**r, "name": name, "role_label": role_label(r["role"]), "operations": sorted(role_operations(r["role"]))})
    me_ = current()
    return {"project_id": project_id, "roles": sorted(out, key=lambda r: (-_rank(r["role"]), r["name"].lower())), "open": not out,
            "my_role": role_for(project_id, me_), "my_operations": sorted(operations_for(project_id, me_)),
            "can_manage": "manage" in operations_for(project_id, me_),
            "available_roles": [{"id": k, "name": v, "operations": sorted(DEFAULT_ROLE_OPS[k])} for k, v in ROLE_LABEL.items()]
            + [{"id": c["id"], "name": c["name"], "operations": sorted(c.get("operations") or []), "custom": True} for c in custom_roles()],
            "inherited": _roles_view_rows((_space(project_id) or {}).get("inherited_roles") or []),
            "space": {k: (_space(project_id) or {}).get(k) for k in ("id", "name", "role_set", "organizations")}}


class CustomRoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field("", max_length=500)
    operations: list[str]


@router.get("/roles")
def list_roles() -> dict:
    """The roles Projects can grant: the default ones and those administrators defined, with their operations."""
    require_user()
    uses: dict[str, int] = {}
    with _db() as con:
        for (r,) in con.execute("SELECT role FROM project_roles UNION ALL SELECT role FROM item_roles").fetchall():
            uses[r] = uses.get(r, 0) + 1
    return {"operations": [{"id": k, "description": v} for k, v in OPERATIONS.items()],
            "roles": [{"id": k, "name": v, "operations": sorted(DEFAULT_ROLE_OPS[k]), "default": True, "grants": uses.get(k, 0)} for k, v in ROLE_LABEL.items()]
            + [{**c, "default": False, "grants": uses.get(c["id"], 0)} for c in custom_roles()]}


def _clean_ops(ops: list[str]) -> list[str]:
    bad = set(ops) - set(OPERATIONS)
    if bad:
        raise HTTPException(400, f"Unknown operation {', '.join(sorted(bad))}")
    if not ops:
        raise HTTPException(400, "A role allows at least one operation")
    out = set(ops) | {"discover"}  # every role sees what it is granted on
    if out & {"download", "edit"}:
        out.add("read")
    return sorted(out)


@router.post("/roles")
def create_role(req: CustomRoleIn, request: Request) -> dict:
    """A custom role (administrators): a name and the operations it allows, e.g. a Viewer without Download."""
    require_admin()
    if req.name.strip().lower() in {v.lower() for v in ROLE_LABEL.values()} | {c["name"].lower() for c in custom_roles()}:
        raise HTTPException(409, "A role with that name exists")
    r = {"id": "role-" + uuid.uuid4().hex[:8], "name": req.name.strip(), "description": req.description, "operations": _clean_ops(req.operations),
         "created_at": _iso()}
    with _lock, _db() as con:
        con.execute("INSERT INTO custom_roles (id, record) VALUES (?, ?)", (r["id"], json.dumps(r)))
    _custom_cache_reset()
    audit("role_created", None, f"{r['name']}: {', '.join(r['operations'])}", request)
    return r


@router.put("/roles/{role_id}")
def update_role(role_id: str, req: CustomRoleIn, request: Request) -> dict:
    require_admin()
    cur = next((c for c in custom_roles() if c["id"] == role_id), None)
    if not cur:
        raise HTTPException(404, "Custom role not found (default roles cannot change)")
    r = {**cur, "name": req.name.strip(), "description": req.description, "operations": _clean_ops(req.operations), "updated_at": _iso()}
    with _lock, _db() as con:
        con.execute("UPDATE custom_roles SET record = ? WHERE id = ?", (json.dumps(r), role_id))
    _roles_cache.clear()
    _custom_cache_reset()
    audit("role_changed", None, f"{r['name']}: {', '.join(r['operations'])}", request)
    return r


@router.delete("/roles/{role_id}")
def delete_role(role_id: str, request: Request) -> dict:
    require_admin()
    with _db() as con:
        (n,) = con.execute("SELECT COUNT(*) FROM project_roles WHERE role = ?", (role_id,)).fetchone()
        (m,) = con.execute("SELECT COUNT(*) FROM item_roles WHERE role = ?", (role_id,)).fetchone()
        n += m
    if n:
        raise HTTPException(409, f"The role is granted on Projects {n} time{'s' if n != 1 else ''}: change those grants first")
    with _lock, _db() as con:
        con.execute("DELETE FROM custom_roles WHERE id = ?", (role_id,))
    _custom_cache_reset()
    audit("role_deleted", None, role_id, request)
    return {"deleted": role_id}


@router.get("/projects/{project_id}/roles")
def get_project_roles(project_id: str) -> dict:
    """Who has which role on a Project (Viewers and up can see it)."""
    require_user()
    check_project(project_id, "viewer")
    return _roles_view(project_id)


@router.put("/projects/{project_id}/roles")
def set_project_roles(project_id: str, req: RolesIn, request: Request) -> dict:
    """Replace a Project's roles (Owners and administrators). It keeps at least one Owner; an empty list (administrators
    only) can only be set by an administrator."""
    p = require_user()
    check_project(project_id, "owner")
    try:
        import db

        item = db.drive_get(project_id)
    except Exception:  # noqa: BLE001
        item = None
    if not item or item.get("kind") != "project":
        raise HTTPException(404, "Project not found")
    roles = {(r.principal_type, "*" if r.principal_type == "everyone" else r.principal_id): r.role for r in req.roles}
    known_roles = set(ROLES) | {c["id"] for c in custom_roles()}
    role_set = set((_space(project_id) or {}).get("role_set") or [])
    for r in roles.values():
        if r not in known_roles:
            raise HTTPException(400, f"Unknown role {r}")
        if role_set and r not in role_set:
            raise HTTPException(400, f"The Project's space does not allow the role {role_label(r)} (its role set)")
    manages = lambda r: "manage" in role_operations(r)  # noqa: E731
    if roles and not any(manages(r) and t != "everyone" for (t, _), r in roles.items()):
        raise HTTPException(400, "Keep at least one Owner (a user or a group)")
    if not roles and enabled() and p.get("role") != "admin":
        raise HTTPException(400, "Keep at least one Owner: a Project without roles is open to administrators only")
    known_users, known_groups = {u["id"] for u in _users()}, {g["id"] for g in _groups()}
    for (t, i), _r in roles.items():
        if (t == "user" and i not in known_users) or (t == "group" and i not in known_groups):
            raise HTTPException(400, f"Unknown {t} {i}")
    # an Owner who is not an administrator cannot take the Owner role away from themselves
    if roles and enabled() and p.get("role") != "admin":
        mine = [r for (t, i), r in roles.items() if t == "everyone" or (t == "user" and i == p["id"]) or (t == "group" and i in set(p.get("groups") or []))]
        if not any(manages(r) for r in mine):
            raise HTTPException(400, "You would lose the Owner role: keep yourself (or a group you are in) as an Owner")
    with _lock, _db() as con:
        con.execute("DELETE FROM project_roles WHERE project_id = ?", (project_id,))
        for (t, i), r in roles.items():
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)", (project_id, t, i, r))
    _project_cache.clear()
    _roles_cache.clear()
    audit("project_roles_changed", None, f"{item['name']}: " + (", ".join(f"{t}:{i}={r}" for (t, i), r in roles.items()) or "no roles: administrators only"), request)
    return _roles_view(project_id)


def _item_roles_view(item_id: str) -> dict:
    """The roles of a folder or a file: its own grants, those of the folders above it (below the Project), and what
    the caller may do there — in the shape of a Project's roles (the same panel shows both)."""
    import db

    project = project_of(item_id)
    index = _grant_index()
    chain = db.drive_path(item_id) or [{"id": item_id, "name": item_id}]
    above = [(c, r) for c in chain[:-1] if c["id"] != project for r in index.get(c["id"], ())]
    me_ = current()
    ops = (operations_for(project, me_) if project else frozenset()) | granted_operations(item_id, me_)
    view = _roles_view(project) if project else {"available_roles": [], "space": {}}
    own = _roles_view_rows(index.get(item_id, []))
    return {"project_id": project, "item_id": item_id, "item": chain[-1]["name"], "project": _project_name(project) if project else None,
            "roles": [{**r, "operations": sorted(role_operations(r["role"]))} for r in sorted(own, key=lambda r: (-_rank(r["role"]), r["name"].lower()))],
            "open": False, "my_role": next((k for k in reversed(ROLES) if KEY_OP[k] in ops), None), "my_operations": sorted(ops),
            "can_manage": bool(project) and "manage" in (operations_for(project, me_)),
            "available_roles": view["available_roles"], "space": view["space"],
            "from_project": view.get("roles", []),
            "from_folders": [{**_roles_view_rows([r])[0], "item_id": c["id"], "item": c["name"]} for c, r in above]}


@router.get("/items/{item_id}/roles")
def get_item_roles(item_id: str) -> dict:
    """Roles granted on a folder or a file of a Project, on the folders above it, and the Project's own."""
    require_user()
    check_item({"id": item_id}, "discoverer")
    return _item_roles_view(item_id)


@router.put("/items/{item_id}/roles")
def set_item_roles(item_id: str, req: RolesIn, request: Request) -> dict:
    """Replace the roles granted on a folder or a file (Owners of its Project and administrators). They add to the
    Project's roles for everything inside it; an empty list removes them."""
    require_user()
    import db

    item = db.drive_get(item_id)
    project = project_of(item_id)
    if not item or not project:
        raise HTTPException(400, "Only folders and files inside a Project take roles of their own")
    if project == item_id:
        raise HTTPException(400, "A Project's roles are set on the Project")
    check_project(project, "owner")
    roles = {(r.principal_type, "*" if r.principal_type == "everyone" else r.principal_id): r.role for r in req.roles}
    known_roles = set(ROLES) | {c["id"] for c in custom_roles()}
    role_set = set((_space(project) or {}).get("role_set") or [])
    known_users, known_groups = {u["id"] for u in _users()}, {g["id"] for g in _groups()}
    for (t, i), r in roles.items():
        if r not in known_roles:
            raise HTTPException(400, f"Unknown role {r}")
        if role_set and r not in role_set:
            raise HTTPException(400, f"The Project's space does not allow the role {role_label(r)} (its role set)")
        if (t == "user" and i not in known_users) or (t == "group" and i not in known_groups):
            raise HTTPException(400, f"Unknown {t} {i}")
    with _lock, _db() as con:
        con.execute("DELETE FROM item_roles WHERE item_id = ?", (item_id,))
        for (t, i), r in roles.items():
            con.execute("INSERT INTO item_roles (item_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)", (item_id, t, i, r))
    _grants_reset()
    audit("item_roles_changed", None, f"{item['name']} ({_project_name(project)}): " + (", ".join(f"{t}:{i}={r}" for (t, i), r in roles.items()) or "none"), request)
    return _item_roles_view(item_id)


# ------------------------------------------------------------------------------------------------
# markings on resources outside Files
# ------------------------------------------------------------------------------------------------

RESOURCE_KINDS = {"stream": "ingest stream", "stream_sync": "streaming sync", "object_type": "object type", "vector_index": "vector index",
                  "code_repo": "code repository", "timeseries_sync": "time series sync", "map": "map",
                  "connection": "data source connection"}


def resource_id(kind: str, rid: str) -> str:
    return f"{kind}:{rid}"


# markings a resource gets from elsewhere, by kind: kind -> fn(resource id) -> marking ids (an object type inherits its
# backing dataset's markings, ontology_security.py)
RESOURCE_MARKING_HOOKS: dict = {}
# resources outside Files that sit in a Project, by kind: kind -> fn(resource id) -> Project id or None (a code
# repository, code_repos.repo_project); the Project's roles apply: Viewer reads, Editor changes
RESOURCE_PROJECT_HOOKS: dict = {}


def _safe(fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 - a missing resource has nothing
        return None


# the Files item a resource's data comes from, for Project-limited applications: kind -> fn(resource id) -> item id
# (an object type's backing dataset, ontology_security.py)
RESOURCE_SOURCE_HOOKS: dict = {}


def _in_app_scope(kind: str, rid: str, p: dict) -> bool:
    """An application limited to Projects reaches a resource outside Files only when its Project (or its data's
    Project) is one of them."""
    scope = p.get("project_scope")
    if scope is None:
        return True
    proj = resource_project(kind, rid)
    if not proj and kind in RESOURCE_SOURCE_HOOKS:
        src = _safe(RESOURCE_SOURCE_HOOKS[kind], rid)
        proj = project_of(src) if src else None
    return bool(proj) and proj in scope


def resource_project(kind: str, rid: str) -> Optional[str]:
    hook = RESOURCE_PROJECT_HOOKS.get(kind)
    return _safe(hook, rid) if hook else None


def resource_effective(kind: str, rid: str) -> set[str]:
    """A resource's markings: its own, plus what it inherits (RESOURCE_MARKING_HOOKS)."""
    out = set(effective_markings(resource_id(kind, rid)))
    hook = RESOURCE_MARKING_HOOKS.get(kind)
    if hook:
        try:
            out |= set(hook(rid) or ())
        except Exception:  # noqa: BLE001 - a missing resource inherits nothing
            pass
    return out


def check_resource(kind: str, rid: str, role: str = "viewer") -> None:
    """403 when the caller lacks a marking on a stream, streaming sync, object type, vector index or code repository."""
    p = current()
    if not enabled() or p is None or p.get("service"):
        return
    need = resource_effective(kind, rid)
    missing = sorted(missing_markings(need, p.get("markings")))
    if missing:
        raise HTTPException(403, f"You need the marking{'s' if len(missing) > 1 else ''} {', '.join(_marking_names(missing))} to access this "
                                 f"{RESOURCE_KINDS.get(kind, kind)}", headers=access_header("marking", markings=missing))
    if not _in_app_scope(kind, rid, p):
        raise HTTPException(403, f"This application is limited to other Projects than this {RESOURCE_KINDS.get(kind, kind)}'s")
    check_project(resource_project(kind, rid), role)


def visible_resources(kind: str, items: list[dict], key: str = "id") -> list[dict]:
    """The resources of a listing the caller holds every marking of."""
    p = current()
    if not enabled() or p is None or p.get("service"):
        return items
    return [i for i in items if satisfies(resource_effective(kind, str(i.get(key))), p.get("markings")) and _in_app_scope(kind, str(i.get(key)), p)
            and _rank(role_for(resource_project(kind, str(i.get(key))), p)) >= 1]


def resource_markings(kind: str, rid: str) -> list[str]:
    return sorted(resource_effective(kind, rid))


# ------------------------------------------------------------------------------------------------
# job tokens (transform builds acting for a user)
# ------------------------------------------------------------------------------------------------


def issue_job_token(user_id: Optional[str] = None, seconds: int = 900, label: str = "") -> Optional[str]:
    """A token for code a user started (a transform build): it calls the API as that user, markings and Project roles
    included, until it expires or is revoked. None when there is no signed-in user (sign-in off, the system)."""
    if not enabled():
        return None
    if user_id is None:
        p = current()
        if p is None or p.get("service") or p.get("id") in (None, "local"):
            return None
        user_id = p["id"]
    token = JOB_PREFIX + secrets.token_urlsafe(32)
    with _lock, _db() as con:
        con.execute("DELETE FROM job_tokens WHERE expires_at < ?", (_iso(),))
        con.execute("INSERT INTO job_tokens (token_hash, user_id, expires_at, label) VALUES (?, ?, ?, ?)",
                    (_sha(token), user_id, _iso(_now() + timedelta(seconds=seconds)), label[:200]))
    return token


def revoke_job_token(token: Optional[str]) -> None:
    if token:
        with _lock, _db() as con:
            con.execute("DELETE FROM job_tokens WHERE token_hash = ?", (_sha(token),))


def service_headers() -> dict[str, str]:
    """Headers for calling this API from the web server's runner."""
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


def summary() -> dict[str, Any]:
    return {"enabled": enabled(), "users": len(_users()), "markings": len(_markings())}
