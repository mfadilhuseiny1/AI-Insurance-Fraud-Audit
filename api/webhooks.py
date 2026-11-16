"""REST API sources and webhooks, as Data Connection's REST API source and outbound webhooks.

A REST API source holds the minimal connection details: one or more domains (base URLs), the
authentication of each (none, bearer token, basic, API key in a header or query parameter) and
additional secrets. Secrets are encrypted (secretbox) and never returned.

A webhook is a structured request — or a chain of requests — to a source's domains:
  inputs   typed parameters passed when the webhook is executed
  calls    method, relative path, query parameters, headers and a body; any text can reference
           {{input}}, {{json input}} (the value as JSON), {{secret.NAME}} (an additional secret) and
           {{call_id.key.0.key}} (a value from an earlier call's JSON response)
  outputs  values taken from a call's response (the whole response, or by keys / indexes)
  limits   a time limit (default 20 s, at most 180 s), a concurrency limit and a rate limit

A webhook is a Read API when every call is safe (GET, HEAD, OPTIONS, or marked read-only); a
chain may contain at most one call that can change the external system. Requests only go to the
source's domains (paths are relative). Executions are kept in a history with the inputs and, unless
"store responses" is off, the responses.

Mounted by server.py under /api/rest-sources and /api/webhooks.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from urllib.parse import urlencode, urljoin, urlparse

import requests
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import datasources as ds
import db
import rate_limits
import secretbox

log = logging.getLogger("bluesandai.webhooks")
sources_router = APIRouter(prefix="/api/rest-sources")
router = APIRouter(prefix="/api/webhooks")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
MAX_TIMEOUT_S = 180
DEFAULT_TIMEOUT_S = 20
MAX_RESPONSE_BYTES = 2_000_000
STORED_RESPONSE_CHARS = 20_000
HISTORY_KEPT = 200

SCHEMA = """
CREATE TABLE IF NOT EXISTS rest_sources (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    api_name      text,
    config        jsonb NOT NULL,
    secret        bytea,
    code_imports  boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
    id          text PRIMARY KEY,
    source_id   text NOT NULL REFERENCES rest_sources(id) ON DELETE CASCADE,
    name        text NOT NULL,
    api_name    text NOT NULL,
    definition  jsonb NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_history (
    id           text PRIMARY KEY,
    webhook_id   text NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    status       text NOT NULL,
    inputs       jsonb,
    outputs      jsonb,
    calls        jsonb,
    error        text,
    changed_external boolean,
    duration_ms  integer,
    at           timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_history_by_webhook ON webhook_history (webhook_id, at DESC);
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def startup() -> None:
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(SCHEMA)


API_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
PARAM_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_\-]{0,63}$")


# --------------------------------------------------------------------------------------------
# REST API sources
# --------------------------------------------------------------------------------------------


class Domain(BaseModel):
    url: str
    auth: Literal["none", "bearer", "basic", "api_key_header", "api_key_query"] = "none"
    # the header or query parameter that carries an API key
    key_name: Optional[str] = None


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    api_name: Optional[str] = None
    domains: list[Domain] = Field(min_length=1, max_length=10)
    # per domain index: {"token" | "username" | "password" | "api_key": value}; blank keeps the saved one
    credentials: dict[str, dict[str, str]] = {}
    # additional secrets by name (referenced as {{secret.NAME}}); blank keeps the saved one
    secrets: dict[str, str] = {}
    # names of additional secrets to delete
    remove_secrets: list[str] = []


def _domain_url(url: str) -> str:
    u = urlparse(url.strip())
    if u.scheme not in ("https", "http") or not u.hostname:
        raise HTTPException(400, f'"{url}" is not an http(s) URL')
    if u.username or u.password:
        raise HTTPException(400, "Put credentials in the authentication fields, not in the URL")
    return f"{u.scheme}://{u.netloc}{u.path.rstrip('/')}"


def _source_row(source_id: str) -> dict:
    rows = ds._rows("SELECT * FROM rest_sources WHERE id = %s", (source_id,))
    if not rows:
        raise HTTPException(404, "REST API source not found")
    return rows[0]


def _public_source(row: dict) -> dict:
    secrets = secretbox.unseal(row.get("secret"))
    creds = secrets.get("credentials", {})
    hooks = ds._rows("SELECT id, name, api_name FROM webhooks WHERE source_id = %s ORDER BY name", (row["id"],))
    return {
        "id": row["id"],
        "name": row["name"],
        "api_name": row.get("api_name"),
        "domains": row["config"]["domains"],
        # which credentials and secrets are set (never their values)
        "credentials_set": {i: sorted(k for k, v in c.items() if v) for i, c in creds.items()},
        "secrets": sorted(secrets.get("additional", {})),
        "code_imports": bool(row.get("code_imports")),
        "export_controls": {"allow_foundry_inputs": bool((row["config"].get("export_controls") or {}).get("allow_foundry_inputs"))},
        "webhooks": hooks,
        "created_at": ds._iso(row["created_at"]),
        "updated_at": ds._iso(row["updated_at"]),
    }


def _merge_secrets(req: SourceIn, saved: dict) -> dict:
    creds = {k: dict(v) for k, v in saved.get("credentials", {}).items()}
    for i, values in req.credentials.items():
        cur = creds.setdefault(str(i), {})
        for k, v in values.items():
            if k not in ("token", "username", "password", "api_key"):
                raise HTTPException(400, f"unknown credential {k}")
            if v:
                cur[k] = v
    additional = dict(saved.get("additional", {}))
    for k, v in req.secrets.items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", k):
            raise HTTPException(400, f'"{k}" is not a valid secret name (letters, digits, _)')
        if v:
            additional[k] = v
    for k in req.remove_secrets:
        additional.pop(k, None)
    # credentials of domains that no longer exist are dropped
    creds = {k: v for k, v in creds.items() if k.isdigit() and int(k) < len(req.domains)}
    return {"credentials": creds, "additional": additional}


def _check_source(req: SourceIn) -> dict:
    if req.api_name and not API_NAME.fullmatch(req.api_name):
        raise HTTPException(400, "The API name starts with a letter and holds letters, digits and _")
    domains = []
    for d in req.domains:
        if d.auth in ("api_key_header", "api_key_query") and not (d.key_name or "").strip():
            raise HTTPException(400, "Name the header or query parameter that carries the API key")
        domains.append({"url": _domain_url(d.url), "auth": d.auth, "key_name": (d.key_name or "").strip() or None})
    return {"domains": domains}


@sources_router.get("")
def list_sources() -> list[dict]:
    ds._require()
    return [_public_source(r) for r in ds._rows("SELECT * FROM rest_sources ORDER BY updated_at DESC")]


@sources_router.get("/{source_id}")
def get_source(source_id: str) -> dict:
    ds._require()
    return _public_source(_source_row(source_id))


@sources_router.post("")
def create_source(req: SourceIn) -> dict:
    ds._require()
    config = _check_source(req)
    secrets = _merge_secrets(req, {})
    now = _now()
    sid = uuid.uuid4().hex[:16]
    ds._exec(
        "INSERT INTO rest_sources (id, name, api_name, config, secret, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (sid, req.name.strip(), req.api_name, Jsonb(config), secretbox.seal(secrets), now, now),
    )
    return get_source(sid)


@sources_router.put("/{source_id}")
def update_source(source_id: str, req: SourceIn) -> dict:
    ds._require()
    row = _source_row(source_id)
    config = _check_source(req)
    secrets = _merge_secrets(req, secretbox.unseal(row.get("secret")))
    ds._exec(
        "UPDATE rest_sources SET name = %s, api_name = %s, config = %s, secret = %s, updated_at = %s WHERE id = %s",
        (req.name.strip(), req.api_name, Jsonb(config), secretbox.seal(secrets), _now(), source_id),
    )
    return get_source(source_id)


class SourceSettings(BaseModel):
    code_imports: Optional[bool] = None


@sources_router.put("/{source_id}/settings")
def source_settings(source_id: str, req: SourceSettings) -> dict:
    ds._require()
    _source_row(source_id)
    if req.code_imports is not None:
        ds._exec("UPDATE rest_sources SET code_imports = %s, updated_at = %s WHERE id = %s", (req.code_imports, _now(), source_id))
    return get_source(source_id)


@sources_router.delete("/{source_id}")
def delete_source(source_id: str) -> dict:
    ds._require()
    _source_row(source_id)
    ds._exec("DELETE FROM rest_sources WHERE id = %s", (source_id,))
    return {"deleted": source_id}


@sources_router.post("/{source_id}/test")
def test_source(source_id: str) -> dict:
    """Reaches every domain (a GET of its base URL with the source's authentication)."""
    ds._require()
    row = _source_row(source_id)
    session = Client(row)
    out = []
    for i, d in enumerate(row["config"]["domains"]):
        t = time.monotonic()
        try:
            r = session.request("GET", d["url"], domain=i, timeout=10)
            out.append({"url": d["url"], "ok": True, "status": r.status_code, "ms": round((time.monotonic() - t) * 1000)})
        except requests.RequestException as e:
            out.append({"url": d["url"], "ok": False, "error": session.scrub(f"{type(e).__name__}: {e}"), "ms": round((time.monotonic() - t) * 1000)})
    return {"ok": all(d["ok"] for d in out), "domains": out}


class Client:
    """A requests session limited to a source's domains, adding each domain's authentication.
    (Also what external transforms get from Source(...).get_https_connection().get_client().)"""

    def __init__(self, row: dict):
        self.row = row
        self.domains = row["config"]["domains"]
        sec = secretbox.unseal(row.get("secret"))
        self.creds = sec.get("credentials", {})
        self.additional = sec.get("additional", {})
        self.session = requests.Session()

    def secret(self, name: str) -> str:
        if name not in self.additional:
            raise HTTPException(400, f'The source has no secret "{name}"')
        return self.additional[name]

    def scrub(self, text: str) -> str:
        values = [v for c in self.creds.values() for v in c.values() if v] + [v for v in self.additional.values() if v]
        for v in sorted(values, key=len, reverse=True):
            if len(v) >= 4:
                text = text.replace(v, "****")
        return text

    def domain_of(self, url: str) -> int:
        for i, d in enumerate(self.domains):
            base = d["url"]
            if url == base or url.startswith(base + "/") or url.startswith(base + "?"):
                return i
        raise HTTPException(400, f"{url} is not on one of the source's domains ({', '.join(d['url'] for d in self.domains)})")

    def request(self, method: str, url: str, domain: Optional[int] = None, **kw: Any) -> requests.Response:
        import network

        u = urlparse(url)
        try:
            network.check_egress(u.hostname, u.port or (443 if u.scheme == "https" else 80), f"{self.row['name']}")
        except network.EgressDenied as e:
            raise HTTPException(403, str(e)) from None
        i = self.domain_of(url) if domain is None else domain
        d = self.domains[i]
        c = self.creds.get(str(i), {})
        headers = dict(kw.pop("headers", None) or {})
        params = kw.pop("params", None)
        if d["auth"] == "bearer" and c.get("token"):
            headers.setdefault("Authorization", f"Bearer {c['token']}")
        elif d["auth"] == "basic":
            kw["auth"] = (c.get("username", ""), c.get("password", ""))
        elif d["auth"] == "api_key_header" and c.get("api_key"):
            headers.setdefault(d["key_name"], c["api_key"])
        elif d["auth"] == "api_key_query" and c.get("api_key"):
            params = [*(params or []), (d["key_name"], c["api_key"])]
        return self.session.request(method, url, headers=headers, params=params, allow_redirects=False, **kw)


# --------------------------------------------------------------------------------------------
# webhooks: definition
# --------------------------------------------------------------------------------------------

INPUT_TYPES = ["String", "Integer", "Long", "Double", "Boolean", "Date", "Timestamp", "List", "Record"]
OUTPUT_TYPES = ["String", "Integer", "Long", "Double", "Boolean", "List", "Record"]


class InputParam(BaseModel):
    id: str
    type: Literal["String", "Integer", "Long", "Double", "Boolean", "Date", "Timestamp", "List", "Record"] = "String"
    required: bool = True
    # String parameters constrained to these values
    options: list[str] = []
    description: str = ""


class Call(BaseModel):
    id: str
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] = "GET"
    # which domain of the source (index)
    domain: int = 0
    path: str = ""
    query: list[tuple[str, str]] = []
    headers: list[tuple[str, str]] = []
    body_type: Literal["none", "json", "form", "form_urlencoded", "text", "xml", "html"] = "none"
    body: str = ""
    form: list[tuple[str, str]] = []
    # a POST that does not change the external system (a token endpoint, a search) may be marked read-only
    read_only: Optional[bool] = None


class OutputParam(BaseModel):
    id: str
    type: Literal["String", "Integer", "Long", "Double", "Boolean", "List", "Record"] = "String"
    call: str
    # keys (and list indexes) into the call's JSON response; empty = the whole response
    path: list[str] = []


class Limits(BaseModel):
    timeout_s: int = Field(DEFAULT_TIMEOUT_S, ge=1, le=MAX_TIMEOUT_S)
    concurrency: Optional[int] = Field(None, ge=1, le=100)
    rate_count: Optional[int] = Field(None, ge=1, le=100_000)
    rate_per: Literal["second", "minute", "hour", "day"] = "minute"


class WebhookIn(BaseModel):
    source_id: str
    name: str = Field(min_length=1, max_length=120)
    api_name: str
    description: str = ""
    inputs: list[InputParam] = []
    calls: list[Call] = Field(min_length=1, max_length=10)
    outputs: list[OutputParam] = []
    limits: Limits = Limits()
    store_responses: bool = True
    # published as a function (Logic, Workshop, actions)
    function: bool = False
    retryable_status_codes: list[int] = []


def _safe(call: Call) -> bool:
    return call.read_only if call.read_only is not None else call.method in SAFE_METHODS


def _validate(req: WebhookIn, source: dict) -> dict:
    if not API_NAME.fullmatch(req.api_name):
        raise HTTPException(400, "The webhook API name starts with a letter and holds letters, digits and _")
    ids = [p.id for p in req.inputs]
    for i in ids:
        if not PARAM_ID.fullmatch(i):
            raise HTTPException(400, f'"{i}" is not a valid input id')
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Input ids must be unique")
    call_ids = [c.id for c in req.calls]
    if len(set(call_ids)) != len(call_ids) or any(not PARAM_ID.fullmatch(c) for c in call_ids):
        raise HTTPException(400, "Each call needs a unique id (letters, digits, _ and -)")
    if set(call_ids) & set(ids):
        raise HTTPException(400, "A call and an input cannot share an id")
    for c in req.calls:
        if c.domain >= len(source["config"]["domains"]):
            raise HTTPException(400, f'Call "{c.id}": the source has no domain #{c.domain + 1}')
        if re.match(r"^[a-z]+://", c.path.strip(), re.I) or c.path.strip().startswith("//"):
            raise HTTPException(400, f'Call "{c.id}": the path is relative to the source domain (no scheme or host)')
    unsafe = [c.id for c in req.calls if not _safe(c)]
    if len(unsafe) > 1:
        raise HTTPException(400, f"A webhook may make at most one call that changes the external system (write API); {', '.join(unsafe)} are — mark token or search calls as read-only")
    for o in req.outputs:
        if o.call not in call_ids:
            raise HTTPException(400, f'Output "{o.id}" reads call "{o.call}", which does not exist')
    d = req.model_dump()
    d.pop("source_id")
    d["kind"] = "write" if unsafe else "read"
    return d


def _hook_row(hook_id: str) -> dict:
    rows = ds._rows("SELECT * FROM webhooks WHERE id = %s", (hook_id,))
    if not rows:
        raise HTTPException(404, "Webhook not found")
    return rows[0]


def _public_hook(row: dict) -> dict:
    src = ds._rows("SELECT id, name, api_name, config FROM rest_sources WHERE id = %s", (row["source_id"],))
    last = ds._rows("SELECT status, at FROM webhook_history WHERE webhook_id = %s ORDER BY at DESC LIMIT 1", (row["id"],))
    return {
        "id": row["id"],
        "source": {"id": row["source_id"], "name": src[0]["name"] if src else "?", "api_name": src[0]["api_name"] if src else None, "domains": src[0]["config"]["domains"] if src else []},
        "name": row["name"],
        "api_name": row["api_name"],
        **{k: v for k, v in row["definition"].items() if k not in ("name", "api_name")},
        "last": {"status": last[0]["status"], "at": ds._iso(last[0]["at"])} if last else None,
        "created_at": ds._iso(row["created_at"]),
        "updated_at": ds._iso(row["updated_at"]),
    }


@router.get("")
def list_hooks(source_id: Optional[str] = None) -> list[dict]:
    ds._require()
    rows = ds._rows("SELECT * FROM webhooks WHERE (%s::text IS NULL OR source_id = %s) ORDER BY updated_at DESC", (source_id, source_id))
    return [_public_hook(r) for r in rows]


@router.get("/{hook_id}")
def get_hook(hook_id: str) -> dict:
    ds._require()
    return _public_hook(_hook_row(hook_id))


@router.post("")
def create_hook(req: WebhookIn) -> dict:
    ds._require()
    source = _source_row(req.source_id)
    d = _validate(req, source)
    if ds._rows("SELECT 1 FROM webhooks WHERE source_id = %s AND api_name = %s", (req.source_id, req.api_name)):
        raise HTTPException(409, f'The source already has a webhook with the API name "{req.api_name}"')
    now = _now()
    hid = uuid.uuid4().hex[:16]
    ds._exec(
        "INSERT INTO webhooks (id, source_id, name, api_name, definition, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (hid, req.source_id, req.name.strip(), req.api_name, Jsonb(d), now, now),
    )
    return get_hook(hid)


@router.put("/{hook_id}")
def update_hook(hook_id: str, req: WebhookIn) -> dict:
    ds._require()
    row = _hook_row(hook_id)
    if req.source_id != row["source_id"]:
        raise HTTPException(400, "A webhook cannot move to another source")
    d = _validate(req, _source_row(req.source_id))
    if ds._rows("SELECT 1 FROM webhooks WHERE source_id = %s AND api_name = %s AND id <> %s", (req.source_id, req.api_name, hook_id)):
        raise HTTPException(409, f'The source already has a webhook with the API name "{req.api_name}"')
    if row["definition"].get("function") and not req.function:
        raise HTTPException(400, "Publishing a webhook as a function cannot be undone")
    ds._exec("UPDATE webhooks SET name = %s, api_name = %s, definition = %s, updated_at = %s WHERE id = %s", (req.name.strip(), req.api_name, Jsonb(d), _now(), hook_id))
    return get_hook(hook_id)


@router.post("/{hook_id}/duplicate")
def duplicate_hook(hook_id: str) -> dict:
    ds._require()
    row = _hook_row(hook_id)
    taken = {r["api_name"] for r in ds._rows("SELECT api_name FROM webhooks WHERE source_id = %s", (row["source_id"],))}
    api_name = next(f"{row['api_name']}Copy{'' if k == 1 else k}" for k in range(1, 1000) if f"{row['api_name']}Copy{'' if k == 1 else k}" not in taken)
    d = {**row["definition"], "function": False}
    now = _now()
    hid = uuid.uuid4().hex[:16]
    ds._exec(
        "INSERT INTO webhooks (id, source_id, name, api_name, definition, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (hid, row["source_id"], f"{row['name']} (copy)", api_name, Jsonb(d), now, now),
    )
    return get_hook(hid)


@router.delete("/{hook_id}")
def delete_hook(hook_id: str) -> dict:
    ds._require()
    _hook_row(hook_id)
    ds._exec("DELETE FROM webhooks WHERE id = %s", (hook_id,))
    return {"deleted": hook_id}


@router.get("/{hook_id}/history")
def history(hook_id: str, limit: int = 50) -> list[dict]:
    ds._require()
    _hook_row(hook_id)
    rows = ds._rows("SELECT * FROM webhook_history WHERE webhook_id = %s ORDER BY at DESC LIMIT %s", (hook_id, max(1, min(limit, HISTORY_KEPT))))
    return [{**{k: ds._iso(v) for k, v in r.items()}} for r in rows]


# --------------------------------------------------------------------------------------------
# webhooks: execution
# --------------------------------------------------------------------------------------------

_TEMPLATE = re.compile(r"\{\{\s*(json\s+)?([A-Za-z_][\w\-]*(?:\.[\w\-]+)*)\s*\}\}")


def _coerce_input(p: dict, v: Any) -> Any:
    t = p["type"]
    if v is None or v == "":
        if p.get("required", True):
            raise HTTPException(400, f'Input "{p["id"]}" is required')
        return None
    try:
        if t == "String":
            v = str(v)
            if p.get("options") and v not in p["options"]:
                raise HTTPException(400, f'Input "{p["id"]}" must be one of {", ".join(p["options"])}')
            return v
        if t in ("Integer", "Long"):
            return int(v)
        if t == "Double":
            return float(v)
        if t == "Boolean":
            return v if isinstance(v, bool) else str(v).lower() in ("true", "1", "yes")
        if t == "Date":
            return datetime.fromisoformat(str(v)[:10]).date().isoformat()
        if t == "Timestamp":
            return datetime.fromisoformat(str(v).replace("Z", "+00:00")).isoformat()
        if t == "List":
            v = json.loads(v) if isinstance(v, str) else v
            if not isinstance(v, list):
                raise ValueError("not a list")
            return v
        if t == "Record":
            v = json.loads(v) if isinstance(v, str) else v
            if not isinstance(v, dict):
                raise ValueError("not a record")
            return v
    except (TypeError, ValueError, json.JSONDecodeError) as e:
        raise HTTPException(400, f'Input "{p["id"]}" is not a valid {t}: {e}') from None
    return v


def _dig(value: Any, path: list[str]) -> Any:
    for key in path:
        if isinstance(value, list):
            try:
                value = value[int(key)]
            except (ValueError, IndexError):
                return None
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def _render(text: str, scope: dict, client: Client, as_json: bool = False) -> str:
    """Fills {{name}}, {{json name}}, {{secret.NAME}} and {{call.key.0}} references."""

    def sub(m: re.Match) -> str:
        json_mode, ref = bool(m.group(1)), m.group(2)
        parts = ref.split(".")
        if parts[0] == "secret" and len(parts) == 2:
            v: Any = client.secret(parts[1])
        elif parts[0] in scope:
            v = _dig(scope[parts[0]], parts[1:]) if len(parts) > 1 else scope[parts[0]]
        else:
            raise HTTPException(400, f'Unknown reference {{{{{ref}}}}} (inputs: {", ".join(k for k in scope if not k.startswith("_")) or "none"})')
        if json_mode or (as_json and not isinstance(v, str)):
            return json.dumps(v)
        return "" if v is None else v if isinstance(v, str) else json.dumps(v)

    return _TEMPLATE.sub(sub, text)


def _convert_output(o: dict, v: Any) -> Any:
    t = o["type"]
    if v is None:
        return None
    if t == "String":
        return v if isinstance(v, str) else json.dumps(v)
    if t == "Record":
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except json.JSONDecodeError:
                raise HTTPException(502, f'Output "{o["id"]}": the value is not a JSON record') from None
        if not isinstance(v, dict):
            raise HTTPException(502, f'Output "{o["id"]}": the value is not a record')
        return v
    if t == "List":
        if not isinstance(v, list):
            raise HTTPException(502, f'Output "{o["id"]}": the value is not a list')
        return v
    if t == "Double" and isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if t in ("Integer", "Long") and isinstance(v, int) and not isinstance(v, bool):
        return v
    if t == "Boolean" and isinstance(v, bool):
        return v
    raise HTTPException(502, f'Output "{o["id"]}": expected {t}, got {type(v).__name__}')


class _Limiter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active: dict[str, int] = {}

    def acquire(self, hook_id: str, limits: dict) -> None:
        """Concurrency is per API process; the rate limit is shared by every process through PostgreSQL
        (rate_limits.take), falling back to this process's own count when the database is not available."""
        per = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[limits.get("rate_per") or "minute"]
        too_many = f"Rate limit: at most {limits.get('rate_count')} executions per {limits.get('rate_per') or 'minute'}"
        with self.lock:
            if limits.get("concurrency") and self.active.get(hook_id, 0) >= limits["concurrency"]:
                raise HTTPException(429, f"Concurrency limit: {limits['concurrency']} executions of this webhook are already running")
            self.active[hook_id] = self.active.get(hook_id, 0) + 1
        try:
            if limits.get("rate_count") and not rate_limits.take(f"webhook:{hook_id}", int(limits["rate_count"]), per):
                raise HTTPException(429, too_many)
        except BaseException:
            self.release(hook_id)
            raise

    def release(self, hook_id: str) -> None:
        with self.lock:
            self.active[hook_id] = max(0, self.active.get(hook_id, 1) - 1)


_limiter = _Limiter()


class Execute(BaseModel):
    inputs: dict[str, Any] = {}


def execute(hook_id: str, inputs: dict[str, Any]) -> dict:
    """Runs the webhook's calls in order; returns {outputs, calls}. Raises HTTPException on errors
    (with whether the external system may have changed)."""
    row = _hook_row(hook_id)
    d = row["definition"]
    source = _source_row(row["source_id"])
    client = Client(source)
    limits = d.get("limits") or {}
    deadline = time.monotonic() + min(limits.get("timeout_s") or DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S)
    started = time.monotonic()
    scope: dict[str, Any] = {}
    for p in d.get("inputs", []):
        scope[p["id"]] = _coerce_input(p, inputs.get(p["id"]))
    unknown = set(inputs) - {p["id"] for p in d.get("inputs", [])}
    if unknown:
        raise HTTPException(400, f"Unknown inputs: {', '.join(sorted(unknown))}")
    trace: list[dict] = []
    changed = False
    _limiter.acquire(hook_id, limits)
    error: Optional[str] = None
    outputs: dict[str, Any] = {}
    try:
        for call in d["calls"]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(504, f"Time limit: the webhook ran longer than {limits.get('timeout_s') or DEFAULT_TIMEOUT_S} s")
            base = source["config"]["domains"][call.get("domain", 0)]["url"]
            path = _render(call.get("path") or "", scope, client).lstrip("/")
            url = urljoin(base + "/", path) if path else base
            client.domain_of(url)  # never leaves the source's domains
            params = [(_render(k, scope, client), _render(v, scope, client)) for k, v in call.get("query") or []]
            headers = {_render(k, scope, client): _render(v, scope, client) for k, v in call.get("headers") or []}
            kw: dict[str, Any] = {}
            bt = call.get("body_type") or "none"
            if bt == "json":
                text = _render(call.get("body") or "", scope, client, as_json=True)
                try:
                    kw["json"] = json.loads(text) if text.strip() else None
                except json.JSONDecodeError as e:
                    raise HTTPException(400, f'Call "{call["id"]}": the body is not valid JSON after filling references ({e})') from None
            elif bt in ("form", "form_urlencoded"):
                pairs = [(_render(k, scope, client), _render(v, scope, client)) for k, v in call.get("form") or []]
                if bt == "form":
                    kw["files"] = [(k, (None, v)) for k, v in pairs]
                else:
                    kw["data"] = urlencode(pairs)
                    headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
            elif bt in ("text", "xml", "html"):
                kw["data"] = _render(call.get("body") or "", scope, client).encode()
                headers.setdefault("Content-Type", {"text": "text/plain", "xml": "application/xml", "html": "text/html"}[bt])
            safe = call.get("read_only") if call.get("read_only") is not None else call["method"] in SAFE_METHODS
            t = time.monotonic()
            attempts = 0
            while True:
                attempts += 1
                try:
                    r = client.request(call["method"], url, domain=call.get("domain", 0), params=params or None, headers=headers, timeout=max(1.0, deadline - time.monotonic()), stream=True, **kw)
                    body = r.raw.read(MAX_RESPONSE_BYTES + 1, decode_content=True)
                except requests.Timeout:
                    # a write request that timed out may have reached the system
                    changed = changed or not safe
                    raise HTTPException(504, f'Call "{call["id"]}" timed out') from None
                except requests.RequestException as e:
                    changed = changed or (not safe and not isinstance(e, requests.ConnectionError))
                    raise HTTPException(502, f'Call "{call["id"]}" failed: {client.scrub(str(e))}') from None
                if r.status_code in (d.get("retryable_status_codes") or []) and attempts < 3 and deadline - time.monotonic() > 1:
                    time.sleep(min(1.0 * attempts, max(0.0, deadline - time.monotonic() - 1)))
                    continue
                break
            if len(body) > MAX_RESPONSE_BYTES:
                raise HTTPException(502, f'Call "{call["id"]}": the response is larger than {MAX_RESPONSE_BYTES // 1_000_000} MB')
            text = body.decode(r.encoding or "utf-8", errors="replace")
            try:
                parsed: Any = json.loads(text) if text.strip() else None
            except json.JSONDecodeError:
                parsed = text
            trace.append({"id": call["id"], "method": call["method"], "url": client.scrub(url), "status": r.status_code, "ms": round((time.monotonic() - t) * 1000), "response": parsed})
            # a write call may have changed the external system unless it answered 400–431
            if not safe:
                changed = changed or not (400 <= r.status_code <= 431)
            if r.status_code >= 400:
                raise HTTPException(502, f'Call "{call["id"]}" answered HTTP {r.status_code}: {client.scrub(text[:300])}')
            scope[call["id"]] = parsed
        for o in d.get("outputs", []):
            outputs[o["id"]] = _convert_output(o, _dig(scope.get(o["call"]), o.get("path") or []))
        return {"outputs": outputs, "calls": trace, "kind": d.get("kind"), "ms": round((time.monotonic() - started) * 1000)}
    except HTTPException as e:
        error = str(e.detail)
        raise HTTPException(e.status_code, {"message": error, "calls": trace, "external_system_changed": changed}) from None
    finally:
        _limiter.release(hook_id)
        _record(row, scope, inputs, outputs, trace, error, changed, round((time.monotonic() - started) * 1000))


def _record(row: dict, scope: dict, inputs: dict, outputs: dict, trace: list[dict], error: Optional[str], changed: bool, ms: int) -> None:
    store = row["definition"].get("store_responses", True)
    calls = [{**c, "response": (json.dumps(c["response"]) if not isinstance(c["response"], str) else c["response"])[:STORED_RESPONSE_CHARS] if store else None} for c in trace]
    try:
        ds._exec(
            "INSERT INTO webhook_history (id, webhook_id, status, inputs, outputs, calls, error, changed_external, duration_ms, at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (uuid.uuid4().hex[:16], row["id"], "failed" if error else "succeeded", Jsonb(inputs), Jsonb(outputs if store else {}), Jsonb(calls), error, changed, ms, _now()),
        )
        ds._exec(
            "DELETE FROM webhook_history WHERE webhook_id = %s AND id NOT IN (SELECT id FROM webhook_history WHERE webhook_id = %s ORDER BY at DESC LIMIT %s)",
            (row["id"], row["id"], HISTORY_KEPT),
        )
    except Exception:
        log.exception("could not record webhook history")


@router.post("/{hook_id}/execute")
def execute_hook(hook_id: str, req: Execute) -> dict:
    ds._require()
    return execute(hook_id, req.inputs)


def execute_by_name(source_api: str, hook_api: str, inputs: dict[str, Any]) -> dict:
    """A published webhook function: source API name + webhook API name."""
    rows = ds._rows(
        "SELECT w.id, w.definition FROM webhooks w JOIN rest_sources s ON s.id = w.source_id WHERE s.api_name = %s AND w.api_name = %s",
        (source_api, hook_api),
    )
    if not rows:
        raise HTTPException(404, f"No webhook {source_api}.{hook_api}")
    return execute(rows[0]["id"], inputs)


# --------------------------------------------------------------------------------------------
# cURL import
# --------------------------------------------------------------------------------------------


class CurlIn(BaseModel):
    source_id: str
    command: str


@router.post("/import-curl")
def import_curl(req: CurlIn) -> dict:
    """A call from a cURL command (-X, -H, -d / --data*, --json, -G, -u is refused: use the source's auth)."""
    ds._require()
    source = _source_row(req.source_id)
    try:
        args = shlex.split(req.command.replace("\\\n", " "))
    except ValueError as e:
        raise HTTPException(400, f"Could not read the command: {e}") from None
    if not args or args[0] != "curl":
        raise HTTPException(400, "Paste a command starting with curl")
    method, url, headers, data, get = None, None, [], None, False
    i = 1
    while i < len(args):
        a = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else None
        if a in ("-X", "--request"):
            method, i = (nxt or "GET").upper(), i + 2
        elif a in ("-H", "--header"):
            if nxt and ":" in nxt:
                k, v = nxt.split(":", 1)
                headers.append((k.strip(), v.strip()))
            i += 2
        elif a in ("-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json"):
            data = nxt if data is None else f"{data}&{nxt}"
            if a == "--json":
                headers.append(("Content-Type", "application/json"))
            i += 2
        elif a in ("-G", "--get"):
            get, i = True, i + 1
        elif a in ("-u", "--user"):
            raise HTTPException(400, "Credentials go in the source's authentication, not in the call — remove -u")
        elif a in ("--url",):
            url, i = nxt, i + 2
        elif a.startswith("-"):
            i += 2 if a in ("-o", "--output", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-m", "--max-time") else 1
        else:
            url, i = a, i + 1
    if not url:
        raise HTTPException(400, "The command has no URL")
    u = urlparse(url)
    full = f"{u.scheme}://{u.netloc}{u.path}"
    client = Client(source)
    domain = client.domain_of(full)
    base = source["config"]["domains"][domain]["url"]
    path = full[len(base):].lstrip("/")
    query = [tuple(p.split("=", 1)) if "=" in p else (p, "") for p in u.query.split("&") if p]
    method = method or ("POST" if data is not None and not get else "GET")
    body_type, body, form = "none", "", []
    ctype = next((v for k, v in headers if k.lower() == "content-type"), "")
    if data is not None and get:
        query += [tuple(p.split("=", 1)) if "=" in p else (p, "") for p in data.split("&") if p]
    elif data is not None:
        stripped = data.strip()
        if "json" in ctype or stripped.startswith(("{", "[")):
            body_type, body = "json", data
        elif "x-www-form-urlencoded" in ctype or (not ctype and "=" in data):
            body_type, form = "form_urlencoded", [tuple(p.split("=", 1)) if "=" in p else (p, "") for p in data.split("&") if p]
        else:
            body_type, body = "text", data
    headers = [(k, v) for k, v in headers if k.lower() not in ("authorization", "content-length")]
    return {
        "id": "call1",
        "method": method,
        "domain": domain,
        "path": path,
        "query": query,
        "headers": headers,
        "body_type": body_type,
        "body": body,
        "form": form,
    }
