"""Developer Console (Application Building → OSDK React applications): applications built on the Ontology SDK.

An application is a Files item (`<name>.devconsole`, application/vnd.bluesandai.developer-console+json) in a
Project, whose roles govern it. It has:
- an OAuth2 client: client-facing (public, authorization code with PKCE, for browser apps) or backend (confidential,
  a client secret, authorization code or client credentials); redirect URLs, and the origins its browser code calls
  the API from (CORS on /api/v2 and the token endpoint);
- scopes: the object types, action types and functions its tokens reach (osdk_api.py enforces them; the user's own
  permissions still apply on top);
- SDK versions: a generated TypeScript package (typed object types, actions, queries, a small client and OAuth
  helpers) downloadable as an npm .tgz, with docs;
- website hosting: static builds (.zip) released as versions, one live, served at /api/dc-hosting/<slug>/ with a
  content security policy (connect-src 'self' plus the domains configured).

OAuth2 (/api/oauth2): GET authorize (sends the user to the consent page), POST authorize/approve (the signed-in user
grants the application), POST token (authorization_code with PKCE, refresh_token, client_credentials), POST revoke.
Access tokens (bsai_oat_…, an hour) and refresh tokens (30 days) are stored hashed; auth.py resolves access tokens
through `resolve` and limits them to the OSDK API.
A backend application can have a service user (a user without a password, named after the application): its client
credentials tokens then act as that user — granted roles and markings like anyone — instead of as its creator.
Users review the applications they granted (/api/oauth2/my-grants) and revoke their own grants.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import mimetypes
import os
import re
import secrets
import tarfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Optional
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/developer-console", tags=["developer-console"])
oauth = APIRouter(prefix="/api/oauth2", tags=["oauth2"])
hosting = APIRouter(prefix="/api/dc-hosting", tags=["developer-console"])
APP_TYPE = "application/vnd.bluesandai.developer-console+json"
DIR = Path("data/developer-console")
ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
CODE_TTL = 600
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "developer-console"
    (DIR / "apps").mkdir(parents=True, exist_ok=True)
    auth.OAUTH_HOOK = resolve
    auth.APP_RESTRICTIONS_HOOK = restrictions
    _move_site_redirects()


def site_url(slug: str) -> str:
    """A hosted website's address, on the hosting origin (auth.hosting_url)."""
    return f"{auth.hosting_url()}/api/dc-hosting/{slug}/"


def _move_site_redirects() -> None:
    """Redirect URLs and allowed origins that pointed at sites hosted on the API's own origin now point at the
    hosting origin (once, when the origins differ)."""
    old, new = auth.api_public_url(), auth.hosting_url()
    if old == new:
        return
    for m in _all():
        uris = [new + u[len(old):] if u.startswith(old + "/api/dc-hosting/") else u for u in m.get("redirect_uris") or []]
        origins = list(m.get("allowed_origins") or [])
        if uris != (m.get("redirect_uris") or []):
            m["redirect_uris"] = uris
            if new not in origins:
                origins.append(new)
            m["allowed_origins"] = origins
            _save(m)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "local"


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _read(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except FileNotFoundError:
        return default


def _write(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


def _path(app_id: str) -> Path:
    if not re.fullmatch(r"dca-[0-9a-f]{12}", app_id):
        raise HTTPException(404, "application not found")
    return DIR / "apps" / f"{app_id}.json"


def _app(app_id: str) -> dict:
    m = _read(_path(app_id))
    if not m:
        raise HTTPException(404, "application not found")
    return m


def _save(m: dict) -> None:
    _write(_path(m["id"]), m)


def _all() -> list[dict]:
    return [m for p in (DIR / "apps").glob("dca-*.json") if (m := _read(p))] if (DIR / "apps").exists() else []


def _access(m: dict, need: str = "viewer") -> dict:
    return drive._item(m["item_id"], need=need)


def _alive(m: dict) -> bool:
    item = db.drive_get(m["item_id"])
    return bool(item and not item.get("trashed_at"))


def _public(m: dict) -> dict:
    out = {k: v for k, v in m.items() if k not in ("secret_hash", "hosting_files")} | {"has_secret": bool(m.get("secret_hash"))}
    if (m.get("hosting") or {}).get("slug"):
        out["hosting"] = {**m["hosting"], "url": site_url(m["hosting"]["slug"])}
    return out


def app_resources(app_id: str) -> dict:
    """The resources an application's tokens reach (osdk_api.py)."""
    try:
        m = _app(app_id)
    except HTTPException:
        return {"object_types": [], "action_types": [], "functions": []}
    return m.get("resources") or {}


# ------------------------------------------------------------------------------------------------
# applications
# ------------------------------------------------------------------------------------------------


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    kind: Literal["client", "backend"] = "client"
    description: str = Field("", max_length=2000)
    redirect_uris: list[str] = Field(default_factory=lambda: ["http://localhost:8080/auth/callback"])


def _check_uris(uris: list[str]) -> list[str]:
    out = []
    for u in uris:
        p = urlparse(u.strip())
        if p.scheme not in ("http", "https") or not p.netloc or p.fragment:
            raise HTTPException(422, f"{u} is not a valid redirect URL (http(s), no fragment)")
        if p.scheme == "http" and p.hostname not in ("localhost", "127.0.0.1"):
            raise HTTPException(422, f"{u}: plain http redirect URLs are for localhost only")
        out.append(u.strip())
    return out


@router.get("/apps")
def list_apps() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (APP_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return sorted((_public(m) for m in _all() if m["item_id"] in visible), key=lambda m: m["created_at"], reverse=True)


@router.post("/apps")
def create_app(req: AppIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "create the application in a Project or a folder")
    uris = _check_uris(req.redirect_uris)
    with _lock:
        hexid = uuid.uuid4().hex[:12]
        app_id = f"dca-{hexid}"
        name = req.name.strip()
        body = json.dumps({"developer_console_app_id": app_id}).encode()
        item = drive._store(folder["id"], drive._clean_name(name if name.endswith(".devconsole") else f"{name}.devconsole"), io.BytesIO(body), len(body), APP_TYPE)
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50] or "app"
        taken = {x.get("hosting", {}).get("slug") for x in _all()}
        while slug in taken or len(slug) < 2:
            slug = f"{slug}-{secrets.token_hex(2)}"
        m = {"id": app_id, "rid": f"ri.third-party-applications.main.application.{hexid}", "name": name.removesuffix(".devconsole"), "description": req.description,
             "item_id": item["id"], "kind": req.kind, "client_id": secrets.token_hex(16), "secret_hash": None, "redirect_uris": uris,
             "allowed_origins": sorted({f"{urlparse(u).scheme}://{urlparse(u).netloc}" for u in uris}),
             "resources": {"object_types": [], "action_types": [], "functions": []}, "sdk": [], "package": f"@{slug}/sdk",
             "hosting": {"slug": slug, "releases": [], "live": None, "csp_domains": []}, "created_at": _now(), "created_by": _me()}
        secret = None
        if req.kind == "backend":
            secret = "bsai_cs_" + secrets.token_urlsafe(32)
            m["secret_hash"] = _sha(secret)
        _save(m)
    return {**_public(m), **({"client_secret": secret} if secret else {})}


@router.get("/apps/{app_id}")
def get_app(app_id: str) -> dict:
    m = _app(app_id)
    _access(m)
    return _public(m)


class SettingsIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    redirect_uris: Optional[list[str]] = None
    allowed_origins: Optional[list[str]] = None


@router.put("/apps/{app_id}")
def update_app(app_id: str, req: SettingsIn) -> dict:
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        if req.name is not None:
            m["name"] = req.name.strip()
        if req.description is not None:
            m["description"] = req.description
        if req.redirect_uris is not None:
            m["redirect_uris"] = _check_uris(req.redirect_uris)
        if req.allowed_origins is not None:
            for o in req.allowed_origins:
                p = urlparse(o)
                if p.scheme not in ("http", "https") or not p.netloc or p.path not in ("", "/"):
                    raise HTTPException(422, f"{o} is not an origin (scheme://host[:port])")
            m["allowed_origins"] = [o.rstrip("/") for o in req.allowed_origins]
        _save(m)
    return _public(m)


@router.post("/apps/{app_id}/secret")
def rotate_secret(app_id: str) -> dict:
    """A new client secret for a backend application (shown once; the old one stops working)."""
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        if m["kind"] != "backend":
            raise HTTPException(400, "client-facing applications are public clients: they use PKCE, not a secret")
        secret = "bsai_cs_" + secrets.token_urlsafe(32)
        m["secret_hash"] = _sha(secret)
        _save(m)
    return {"client_secret": secret}


class ResourcesIn(BaseModel):
    object_types: list[str] = Field(default_factory=list)
    action_types: list[str] = Field(default_factory=list)
    functions: list[str] = Field(default_factory=list)


@router.put("/apps/{app_id}/resources")
def set_resources(app_id: str, req: ResourcesIn) -> dict:
    """The application's scopes. Action types bring the object types they edit (dependencies resolve automatically)."""
    import ontology

    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        types = list(dict.fromkeys(req.object_types))
        for a in req.action_types:
            at = ontology._action_type(a)
            if at.get("object_type_id") and at["object_type_id"] not in types:
                types.append(at["object_type_id"])
        for t in types:
            ontology._object_type(t)
        m["resources"] = {"object_types": types, "action_types": req.action_types, "functions": req.functions}
        _save(m)
    return _public(m)


@router.delete("/apps/{app_id}")
def delete_app(app_id: str) -> dict:
    m = _app(app_id)
    drive.trash(_access(m, "editor")["id"])
    _revoke_app(app_id)
    return {"trashed": app_id}


# ------------------------------------------------------------------------------------------------
# the generated SDK
# ------------------------------------------------------------------------------------------------


TS = {"string": "string", "integer": "number", "double": "number", "long": "number", "short": "number", "float": "number", "decimal": "number",
      "boolean": "boolean", "date": "string", "timestamp": "string", "string_array": "string[]", "media": "string", "geopoint": "{ latitude: number; longitude: number }"}


def _ident(s: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_]", "_", s)
    return ("_" + out) if out[:1].isdigit() else out


def _sdk_files(m: dict, version: str) -> dict[str, str]:
    import ontology

    res = m.get("resources") or {}
    types = []
    for tid in res.get("object_types") or []:
        try:
            types.append(ontology._object_type(tid))
        except HTTPException:
            continue
    actions = []
    for aid in res.get("action_types") or []:
        try:
            actions.append(ontology._action_type(aid))
        except HTTPException:
            continue
    try:
        import functions_registry

        fns = [f for f in functions_registry.list_functions("", None) if f["id"] in (res.get("functions") or []) and f.get("api_name")]
    except Exception:  # noqa: BLE001
        fns = []
    js = [f"""/* {m['package']} {version}: the Ontology SDK of the Developer Console application {m['name']} (generated). */
export const $ontologyRid = "ri.ontology.main.ontology.default";
export const $clientId = "{m['client_id']}";
"""]
    dts = [f"""/* {m['package']} {version}: types of the application's object types, actions and queries. */
export declare const $ontologyRid: string;
export declare const $clientId: string;
export type WhereClause<T> = {{ [K in keyof T]?: T[K] | {{ $eq?: T[K]; $ne?: T[K]; $gt?: T[K]; $gte?: T[K]; $lt?: T[K]; $lte?: T[K]; $in?: T[K][]; $isNull?: boolean; $contains?: string; $startsWith?: string }} }} & {{ $and?: WhereClause<T>[]; $or?: WhereClause<T>[]; $not?: WhereClause<T> }};
export interface Page<T> {{ data: T[]; nextPageToken?: string; totalCount: string }}
export type DerivedProperty = {{ link: string; aggregation: "count" | "sum" | "avg" | "min" | "max" | "approximateDistinct" | "exactDistinct" | "collectList" | "collectSet" | "selectProperty"; property?: string }};
export interface ObjectSet<T> {{
  where(clause: WhereClause<T>): ObjectSet<T>;
  /** derived properties: aggregates over a link, computed for each object (usable in where and orderBy) */
  withProperties<D extends Record<string, DerivedProperty>>(derived: D): ObjectSet<T & {{ [K in keyof D]: unknown }}>;
  fetchPage(opts?: {{ pageSize?: number; nextPageToken?: string; orderBy?: {{ [K in keyof T]?: "asc" | "desc" }}; select?: (keyof T)[] }}): Promise<Page<T>>;
  fetchOne(primaryKey: string | number): Promise<T>;
  aggregate(opts: {{ select: Record<string, "count" | "sum" | "avg" | "min" | "max" | "approximateDistinct">; groupBy?: {{ [K in keyof T]?: "exact" }} }}): Promise<unknown>;
  asyncIter(): AsyncIterable<T>;
}}
export interface ActionValidation {{
  result: "VALID" | "INVALID";
  submissionCriteria: {{ configuredFailureMessage?: string; result: "VALID" | "INVALID" }}[];
  parameters: Record<string, {{ result: "VALID" | "INVALID"; required: boolean; evaluatedConstraints: {{ type: string; message?: string }}[] }}>;
}}
export interface Attachment {{ rid: string; filename: string; sizeBytes: number; mediaType: string }}
export interface Client {{
  <T>(type: {{ type: "object"; apiName: string; __t?: T }}): ObjectSet<T>;
  <P>(action: {{ type: "action"; apiName: string; __p?: P }}): {{
    /** $validateOnly: check parameters, submission criteria and rules without applying; $returnEdits: false omits the edits. */
    applyAction(parameters: P, options?: {{ $validateOnly?: boolean; $returnEdits?: boolean }}): Promise<{{ validation: ActionValidation; edits?: unknown }}>;
    validate(parameters: Partial<P>): Promise<ActionValidation>;
  }};
  <P, R>(query: {{ type: "query"; apiName: string; __p?: P; __r?: R }}): {{ executeFunction(parameters: P): Promise<R> }};
  currentUser(): Promise<{{ id: string; username: string; email?: string }}>;
  attachments: {{
    upload(data: Blob | ArrayBuffer | Uint8Array, filename: string): Promise<Attachment>;
    get(rid: string): Promise<Attachment>;
    content(rid: string): Promise<Blob>;
  }};
  media: {{
    upload(type: {{ type: "object"; apiName: string }}, property: string, data: Blob | ArrayBuffer | Uint8Array, path: string): Promise<{{ mimeType: string; mediaItemRid: string; sizeBytes: number; reference: unknown }}>;
    metadata(type: {{ type: "object"; apiName: string }}, primaryKey: string | number, property: string): Promise<{{ path: string; sizeBytes: number; mediaType: string }}>;
    content(type: {{ type: "object"; apiName: string }}, primaryKey: string | number, property: string): Promise<Blob>;
  }};
  /** The same client inside an Ontology scenario: reads see its edits, actions write to it (main is untouched). */
  withScenario(scenarioId: string): Client;
}}
export declare function createClient(baseUrl: string, ontologyRid: string, tokenProvider: () => Promise<string>, options?: {{ scenario?: string }}): Client;
export declare function createPublicOauthClient(clientId: string, baseUrl: string, redirectUrl: string): (() => Promise<string>) & {{ signIn(): Promise<void>; signOut(): void }};
export declare function createConfidentialOauthClient(clientId: string, clientSecret: string, baseUrl: string): () => Promise<string>;
"""]
    for t in types:
        name = _ident(t.get("api_name") or t["id"])
        props = "\n".join(f"  {_ident(p['api_name'])}: {TS.get(p['type'], 'unknown')} | null;" for p in t["properties"])
        dts.append(f"/** {t['display_name']}: {t.get('description') or ''} */\nexport interface {name} {{\n  $apiName: \"{t.get('api_name') or t['id']}\";\n  $primaryKey: string;\n{props}\n}}\nexport declare const {name}: {{ type: \"object\"; apiName: \"{t.get('api_name') or t['id']}\"; primaryKey: \"{t['primary_key']}\"; __t?: {name} }};\n")
        js.append(f"export const {name} = {{ type: \"object\", apiName: {json.dumps(t.get('api_name') or t['id'])}, primaryKey: {json.dumps(t['primary_key'])} }};\n")
    for a in actions:
        name = _ident(a.get("api_name") or a["id"])
        params = "; ".join(f"{_ident(p['id'])}{'' if p.get('required') else '?'}: {TS.get(p.get('type', ''), 'unknown') if p.get('type') != 'object' else 'string'}" for p in a.get("parameters") or [])
        dts.append(f"/** {a['display_name']} */\nexport declare const {name}: {{ type: \"action\"; apiName: \"{a.get('api_name') or a['id']}\"; __p?: {{ {params} }} }};\n")
        js.append(f"export const {name} = {{ type: \"action\", apiName: {json.dumps(a.get('api_name') or a['id'])} }};\n")
    for f in fns:
        name = _ident(f["api_name"])
        params = "; ".join(f"{_ident(i['name'])}: unknown" for i in f.get("inputs") or [])
        dts.append(f"/** {f['name']} */\nexport declare const {name}: {{ type: \"query\"; apiName: \"{f['api_name']}\"; __p?: {{ {params} }}; __r?: unknown }};\n")
        js.append(f"export const {name} = {{ type: \"query\", apiName: {json.dumps(f['api_name'])} }};\n")
    js.append(CLIENT_JS)
    pkg = {"name": m["package"], "version": version, "description": f"Ontology SDK of {m['name']}", "type": "module", "main": "index.js", "types": "index.d.ts",
           "files": ["index.js", "index.d.ts", "README.md"], "license": "UNLICENSED"}
    readme = f"""# {m['package']}

The Ontology SDK of the Developer Console application **{m['name']}** (version {version}).

```bash
npm install ./{m['package'].replace('@', '').replace('/', '-')}-{version}.tgz
```

```ts
import {{ createClient, createPublicOauthClient, $ontologyRid, $clientId{''.join(', ' + _ident(t.get('api_name') or t['id']) for t in types[:2])} }} from "{m['package']}";

const auth = createPublicOauthClient($clientId, "<platform API URL>", "<redirect URL>");
const client = createClient("<platform API URL>", $ontologyRid, auth);
{f"const page = await client({_ident(types[0].get('api_name') or types[0]['id'])}).where({{}}).fetchPage({{ pageSize: 30 }});" if types else ""}
```
Backend applications use `createConfidentialOauthClient(clientId, clientSecret, baseUrl)` (client credentials).
"""
    return {"package/package.json": json.dumps(pkg, indent=2), "package/index.js": "".join(js), "package/index.d.ts": "".join(dts), "package/README.md": readme}


CLIENT_JS = r"""
function where(c) {
  if (!c || !Object.keys(c).length) return undefined;
  const parts = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === "$and") parts.push({ type: "and", value: v.map(where).filter(Boolean) });
    else if (k === "$or") parts.push({ type: "or", value: v.map(where).filter(Boolean) });
    else if (k === "$not") parts.push({ type: "not", value: where(v) });
    else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [op, x] of Object.entries(v)) {
        const t = { $eq: "eq", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte", $in: "in", $isNull: "isNull", $contains: "contains", $startsWith: "startsWith" }[op];
        if (op === "$ne") parts.push({ type: "not", value: { type: "eq", field: k, value: x } });
        else if (t) parts.push({ type: t, field: k, value: x });
      }
    } else parts.push({ type: "eq", field: k, value: v });
  }
  return parts.length === 1 ? parts[0] : { type: "and", value: parts };
}
function toObject(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === "__apiName" ? "$apiName" : k === "__primaryKey" ? "$primaryKey" : k === "__rid" ? "$rid" : k, v])); }
export function createClient(baseUrl, ontologyRid, tokenProvider, options) {
  const scenario = options && options.scenario;
  const base = baseUrl.replace(/\/$/, "") + "/api/v2";
  const o = encodeURIComponent(ontologyRid);
  async function call(method, path, body) {
    const token = await tokenProvider();
    const res = await fetch(base + path, { method, headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}), ...(scenario ? { "x-bluesandai-scenario": scenario } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error((data.detail && (data.detail.message || data.detail.errorName)) || data.detail || res.statusText); e.status = res.status; e.body = data; throw e; }
    return data;
  }
  function objectSet(type, clause, derived) {
    return {
      where: (c) => objectSet(type, clause ? { $and: [clause, c] } : c, derived),
      withProperties: (d) => objectSet(type, clause, { ...(derived || {}), ...d }),
      fetchPage: async (opts = {}) => {
        const r = await call("POST", `/ontologies/${o}/objects/${type.apiName}/search`, { where: where(clause), pageSize: opts.pageSize || 1000, pageToken: opts.nextPageToken,
          orderBy: opts.orderBy ? { fields: Object.entries(opts.orderBy).map(([field, direction]) => ({ field, direction })) } : undefined, select: opts.select || [], derivedProperties: derived || {} });
        return { data: r.data.map(toObject), nextPageToken: r.nextPageToken || undefined, totalCount: r.totalCount };
      },
      fetchOne: async (pk) => toObject(await call("GET", `/ontologies/${o}/objects/${type.apiName}/${encodeURIComponent(pk)}`)),
      aggregate: (opts) => call("POST", `/ontologies/${o}/objects/${type.apiName}/aggregate`, {
        where: where(clause),
        aggregation: Object.entries(opts.select).map(([k, kind]) => { const [field, name] = k.includes(":") ? k.split(":") : [k === "$count" ? undefined : k, k]; return { type: k === "$count" ? "count" : kind, field, name }; }),
        groupBy: Object.keys(opts.groupBy || {}).map((field) => ({ type: "exact", field })),
      }),
      asyncIter: async function* () { let t; do { const p = await this.fetchPage({ nextPageToken: t }); yield* p.data; t = p.nextPageToken; } while (t); },
    };
  }
  async function raw(method, path, body, type) {
    const token = await tokenProvider();
    const res = await fetch(base + path, { method, headers: { authorization: "Bearer " + token, ...(body ? { "content-type": type || "application/octet-stream" } : {}) }, body });
    if (!res.ok) { const data = await res.json().catch(() => ({})); const e = new Error((data.detail && (data.detail.message || data.detail.errorName)) || res.statusText); e.status = res.status; e.body = data; throw e; }
    return res;
  }
  const client = (x) => x.type === "object" ? objectSet(x) : x.type === "action"
    ? {
        // options: { $validateOnly: true } checks parameters, criteria and rules without applying; { $returnEdits: false }
        applyAction: (parameters, options) => call("POST", `/ontologies/${o}/actions/${x.apiName}/apply`, { parameters,
          options: { mode: options && options.$validateOnly ? "VALIDATE_ONLY" : "VALIDATE_AND_EXECUTE", returnEdits: options && options.$returnEdits === false ? "NONE" : "ALL" } }),
        validate: async (parameters) => (await call("POST", `/ontologies/${o}/actions/${x.apiName}/apply`, { parameters, options: { mode: "VALIDATE_ONLY" } })).validation,
      }
    : { executeFunction: async (parameters) => (await call("POST", `/ontologies/${o}/queries/${x.apiName}/execute`, { parameters })).value };
  client.currentUser = () => call("GET", "/admin/users/getCurrent");
  // attachments: upload a Blob / File → { rid, filename, sizeBytes, mediaType }; read its metadata and content
  client.attachments = {
    upload: async (data, filename) => (await raw("POST", `/ontologies/attachments/upload?filename=${encodeURIComponent(filename)}`, data, data && data.type)).json(),
    get: (rid) => call("GET", `/ontologies/attachments/${encodeURIComponent(rid)}`),
    content: async (rid) => (await raw("GET", `/ontologies/attachments/${encodeURIComponent(rid)}/content`)).blob(),
  };
  // media reference properties: upload for a property (pass the returned mediaItemRid to an action), read an object's media
  client.media = {
    upload: async (type, property, data, path) => (await raw("POST", `/ontologies/${o}/objectTypes/${type.apiName}/media/${property}/upload?mediaItemPath=${encodeURIComponent(path)}`, data, data && data.type)).json(),
    metadata: (type, pk, property) => call("GET", `/ontologies/${o}/objects/${type.apiName}/${encodeURIComponent(pk)}/media/${property}/metadata`),
    content: async (type, pk, property) => (await raw("GET", `/ontologies/${o}/objects/${type.apiName}/${encodeURIComponent(pk)}/media/${property}/content`)).blob(),
  };
  // the same client inside an Ontology scenario: reads see its edits, actions write to it
  client.withScenario = (id) => createClient(baseUrl, ontologyRid, tokenProvider, { scenario: id });
  return client;
}
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export function createPublicOauthClient(clientId, baseUrl, redirectUrl) {
  const api = baseUrl.replace(/\/$/, "");
  const key = "osdk.token." + clientId;
  const load = () => { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; } };
  const store = (t) => sessionStorage.setItem(key, JSON.stringify({ ...t, at: Date.now() }));
  async function exchange(body) {
    const res = await fetch(api + "/api/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const t = await res.json();
    if (!res.ok) throw new Error(t.error_description || t.error || "token request failed");
    store(t);
    return t;
  }
  async function signIn() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    sessionStorage.setItem(key + ".pkce", JSON.stringify({ verifier, state, back: location.href }));
    location.assign(api + "/api/oauth2/authorize?" + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUrl, code_challenge: challenge, code_challenge_method: "S256", state }));
    await new Promise(() => {});
  }
  const provider = async () => {
    const url = new URL(location.href);
    const pk = JSON.parse(sessionStorage.getItem(key + ".pkce") || "null");
    if (url.searchParams.get("code") && pk && url.searchParams.get("state") === pk.state) {
      sessionStorage.removeItem(key + ".pkce");
      await exchange({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: redirectUrl, client_id: clientId, code_verifier: pk.verifier });
      history.replaceState({}, "", pk.back && pk.back.startsWith(location.origin) ? pk.back : redirectUrl);
    }
    let t = load();
    if (t && Date.now() - t.at > (t.expires_in - 60) * 1000) t = t.refresh_token ? await exchange({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId }).catch(() => null) : null;
    if (!t) await signIn();
    return t.access_token;
  };
  provider.signIn = signIn;
  provider.signOut = () => sessionStorage.removeItem(key);
  return provider;
}
export function createConfidentialOauthClient(clientId, clientSecret, baseUrl) {
  let t = null;
  return async () => {
    if (t && Date.now() < t.until) return t.access_token;
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/api/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }) });
    const x = await res.json();
    if (!res.ok) throw new Error(x.error_description || x.error);
    t = { ...x, until: Date.now() + (x.expires_in - 60) * 1000 };
    return t.access_token;
  };
}
"""


class SdkIn(BaseModel):
    version: Optional[str] = Field(None, pattern=r"^\d+\.\d+\.\d+$")


@router.post("/apps/{app_id}/sdk")
def generate_sdk(app_id: str, req: SdkIn) -> dict:
    """Generate an SDK version from the application's current scopes."""
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        prev = m.get("sdk") or []
        if req.version:
            version = req.version
        elif prev:
            a, b, c = (int(x) for x in prev[-1]["version"].split("."))
            version = f"{a}.{b}.{c + 1}"
        else:
            version = "0.1.0"
        if any(s["version"] == version for s in prev):
            raise HTTPException(409, f"SDK version {version} exists")
        files = _sdk_files(m, version)
        _write(DIR / "sdk" / m["id"] / f"{version}.json", files)
        entry = {"version": version, "generated_at": _now(), "generated_by": _me(), "resources": m.get("resources"),
                 "object_types": len((m.get("resources") or {}).get("object_types") or []), "size": sum(len(x) for x in files.values())}
        m.setdefault("sdk", []).append(entry)
        _save(m)
    return entry


@router.get("/apps/{app_id}/sdk/{version}")
def sdk_files(app_id: str, version: str) -> dict:
    m = _app(app_id)
    _access(m)
    files = _read(DIR / "sdk" / m["id"] / f"{version}.json")
    if not files:
        raise HTTPException(404, "SDK version not found")
    return {"version": version, "package": m["package"], "files": files}


@router.get("/apps/{app_id}/sdk/{version}/package.tgz")
def sdk_tgz(app_id: str, version: str) -> Response:
    """The SDK as an npm package (npm install ./<file>.tgz)."""
    files = sdk_files(app_id, version)["files"]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = int(time.time())
            tf.addfile(info, io.BytesIO(data))
    m = _app(app_id)
    fname = f"{m['package'].replace('@', '').replace('/', '-')}-{version}.tgz"
    return Response(buf.getvalue(), media_type="application/gzip", headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# ------------------------------------------------------------------------------------------------
# website hosting
# ------------------------------------------------------------------------------------------------


class HostingIn(BaseModel):
    slug: Optional[str] = None
    csp_domains: Optional[list[str]] = None


@router.put("/apps/{app_id}/hosting")
def set_hosting(app_id: str, req: HostingIn) -> dict:
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        h = m.setdefault("hosting", {"releases": [], "live": None, "csp_domains": []})
        if req.slug is not None and req.slug != h.get("slug"):
            if not SLUG.match(req.slug):
                raise HTTPException(422, "a site name holds lowercase letters, digits and dashes")
            if any(x["id"] != m["id"] and (x.get("hosting") or {}).get("slug") == req.slug for x in _all()):
                raise HTTPException(409, f"{req.slug} is taken")
            h["slug"] = req.slug
        if req.csp_domains is not None:
            for d in req.csp_domains:
                if not re.fullmatch(r"https://[A-Za-z0-9.*-]+(:\d+)?", d):
                    raise HTTPException(422, f"{d}: CSP domains are https://host[:port]")
            h["csp_domains"] = req.csp_domains
        _save(m)
    return _public(m)


@router.post("/apps/{app_id}/hosting/releases")
async def upload_site(app_id: str, version: str = Form(...), file: UploadFile = File(...)) -> dict:
    """A static build (.zip with index.html at its root) as a site version; the first one goes live."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise HTTPException(422, "the version is x.y.z")
    m = _app(app_id)
    _access(m, "editor")
    data = await file.read()
    if len(data) > 100 * 1024 * 1024:
        raise HTTPException(413, "sites are limited to 100 MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(422, "not a .zip archive") from None
    files: dict[str, bytes] = {}
    for info in zf.infolist():
        if info.is_dir():
            continue
        p = PurePosixPath(info.filename.replace("\\", "/"))
        if p.is_absolute() or ".." in p.parts:
            raise HTTPException(422, f"unsafe path in the archive: {info.filename}")
        files[str(p)] = zf.read(info)
    if "index.html" not in files:
        raise HTTPException(422, "the site has no index.html at its root (zip the build's contents, e.g. dist/*)")
    with _lock:
        m = _app(app_id)
        h = m["hosting"]
        if any(r["version"] == version for r in h["releases"]):
            raise HTTPException(409, f"site version {version} exists")
        base = DIR / "sites" / m["id"] / version
        for path, b in files.items():
            t = base / PurePosixPath(path)
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(b)
        h["releases"].append({"version": version, "files": len(files), "size": len(data), "uploaded_at": _now(), "uploaded_by": _me()})
        if not h.get("live"):
            h["live"] = version
        _save(m)
    return _public(m)


class LiveIn(BaseModel):
    version: Optional[str] = None


@router.put("/apps/{app_id}/hosting/live")
def set_live(app_id: str, req: LiveIn) -> dict:
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        if req.version and not any(r["version"] == req.version for r in m["hosting"]["releases"]):
            raise HTTPException(404, "site version not found")
        m["hosting"]["live"] = req.version
        _save(m)
    return _public(m)


@hosting.get("/{slug}/{path:path}")
def serve_site(slug: str, request: Request, path: str = "") -> Response:
    """A hosted application's live version (an SPA: unknown paths serve index.html), with its content security policy.
    Only on the hosting origin: anywhere else it redirects there, so a site's scripts never share the platform's origin."""
    hosting_host = auth._netloc(auth.hosting_url())
    if auth._hosting_separate() and (request.headers.get("host") or "").lower() != hosting_host:
        q = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(f"{auth.hosting_url()}/api/dc-hosting/{slug}/{path}{q}")
    m = next((x for x in _all() if (x.get("hosting") or {}).get("slug") == slug), None)
    if not m or not _alive(m) or not m["hosting"].get("live"):
        raise HTTPException(404, "no live site here")
    base = (DIR / "sites" / m["id"] / m["hosting"]["live"]).resolve()
    p = PurePosixPath(path or "index.html")
    if ".." in p.parts:
        raise HTTPException(404, "not found")
    f = (base / p).resolve()
    if not str(f).startswith(str(base)) or not f.is_file():
        f = base / "index.html"
    extra = " ".join(m["hosting"].get("csp_domains") or [])
    api = auth.api_public_url()
    csp = (f"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: {extra}; "
           f"font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' {api}/api/v2/ {api}/api/oauth2/ {extra}; frame-ancestors 'none'; "
           f"form-action 'self' {api}/api/oauth2/; base-uri 'self'")
    mt = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if f.suffix in (".js", ".mjs"):
        mt = "text/javascript"
    return Response(f.read_bytes(), media_type=mt, headers={"Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff",
                                                          "Cache-Control": "no-cache" if f.name == "index.html" else "public, max-age=3600"})


@hosting.get("/{slug}")
def serve_site_root(slug: str) -> Response:
    return RedirectResponse(f"/api/dc-hosting/{slug}/")


# ------------------------------------------------------------------------------------------------
# OAuth2
# ------------------------------------------------------------------------------------------------


def _tokens() -> dict:
    return _read(DIR / "tokens.json", {"codes": {}, "access": {}, "refresh": {}})


def _save_tokens(t: dict) -> None:
    now = time.time()
    for k in ("codes", "access", "refresh"):
        t[k] = {h: v for h, v in t[k].items() if v["exp"] > now}
    _write(DIR / "tokens.json", t)


def resolve(access_token: str) -> Optional[tuple[str, str]]:
    """(user id, app id) of a live access token (auth.py)."""
    v = _tokens()["access"].get(_sha(access_token))
    if not v or v["exp"] < time.time():
        return None
    try:
        m = _app(v["app_id"])
    except HTTPException:
        return None
    if not _alive(m) or m.get("disabled"):
        return None
    return v["user_id"], v["app_id"]


def restrictions(app_id: str) -> dict:
    """What an application's tokens may reach beyond the user's own access (auth.APP_RESTRICTIONS_HOOK): the Projects
    and the markings it is limited to (None: unrestricted)."""
    try:
        m = _app(app_id)
    except HTTPException:
        return {"projects": [], "markings": []}
    return {"projects": m.get("project_scope"), "markings": m.get("marking_scope")}


def _revoke_app(app_id: str) -> None:
    with _lock:
        t = _tokens()
        for k in ("codes", "access", "refresh"):
            t[k] = {h: v for h, v in t[k].items() if v.get("app_id") != app_id}
        _save_tokens(t)


def _by_client(client_id: str) -> dict:
    m = next((x for x in _all() if x["client_id"] == client_id), None)
    if not m or not _alive(m):
        raise HTTPException(400, {"error": "invalid_client", "error_description": "unknown client_id"})
    if m.get("disabled"):
        raise HTTPException(400, {"error": "unauthorized_client", "error_description": "the application is disabled"})
    return m


class EnablementIn(BaseModel):
    enabled: bool = True
    # the Projects / markings the application's tokens are limited to (None: unrestricted)
    project_scope: Optional[list[str]] = None
    marking_scope: Optional[list[str]] = None
    # organizations whose users are authorized without the consent screen (organization level consent)
    org_consent: list[str] = Field(default_factory=list)


@router.put("/apps/{app_id}/enablement")
def set_enablement(app_id: str, req: EnablementIn) -> dict:
    """Enablement settings (administrators): enable or disable the application (disabling revokes every token and
    authorization: users authorize it again after it is re-enabled), limit what its tokens reach to Projects and
    markings (on top of the user's own access), and authorize it for whole organizations."""
    auth.require_admin()
    import db as _db

    with _lock:
        m = _app(app_id)
        for pid in req.project_scope or []:
            it = _db.drive_get(pid)
            if not it or it.get("kind") != "project":
                raise HTTPException(400, f"{pid} is not a Project")
        if req.marking_scope is not None and set(req.marking_scope) - {x["id"] for x in auth._markings()}:
            raise HTTPException(400, "Unknown marking")
        if set(req.org_consent) - {o["id"] for o in auth._orgs()}:
            raise HTTPException(400, "Unknown organization")
        was = not m.get("disabled")
        m.update(disabled=not req.enabled, project_scope=req.project_scope, marking_scope=req.marking_scope, org_consent=sorted(set(req.org_consent)))
        _save(m)
    if was and not req.enabled:
        _revoke_app(app_id)
    auth.audit("application_enablement", None, f"{m['name']}: {'enabled' if req.enabled else 'disabled'}, projects {req.project_scope}, "
                                                f"markings {req.marking_scope}, organization consent {req.org_consent}")
    return _public(m)


def _web_url() -> str:
    return (os.environ.get("BLUESANDAI_WEB_URL") or (os.environ.get("BLUESANDAI_WEB_ORIGINS") or "http://localhost:8888").split(",")[0]).rstrip("/")


@oauth.get("/authorize")
def authorize(request: Request) -> Response:
    """Validate the request, then send the user to the consent page (the web app; it signs them in first)."""
    q = dict(request.query_params)
    m = _by_client(q.get("client_id", ""))
    if q.get("redirect_uri") not in m["redirect_uris"]:
        raise HTTPException(400, "redirect_uri is not one of the application's redirect URLs")
    if q.get("response_type") != "code":
        return RedirectResponse(q["redirect_uri"] + ("&" if "?" in q["redirect_uri"] else "?") + urlencode({"error": "unsupported_response_type", "state": q.get("state", "")}))
    if m["kind"] == "client" and (not q.get("code_challenge") or q.get("code_challenge_method") != "S256"):
        return RedirectResponse(q["redirect_uri"] + ("&" if "?" in q["redirect_uri"] else "?") + urlencode({"error": "invalid_request", "error_description": "client-facing applications use PKCE (S256)", "state": q.get("state", "")}))
    # organization level consent: users of those organizations are authorized without the consent screen
    p = auth.current()
    if p and not p.get("service") and p.get("organization_id") and p["organization_id"] in (m.get("org_consent") or []):
        out = approve(ApproveIn(client_id=m["client_id"], redirect_uri=q["redirect_uri"], state=q.get("state", ""),
                                code_challenge=q.get("code_challenge"), code_challenge_method=q.get("code_challenge_method")))
        return RedirectResponse(out["redirect"])
    return RedirectResponse(f"{_web_url()}/oauth/authorize?{urlencode(q)}")


@oauth.get("/clients/{client_id}")
def client_info(client_id: str) -> dict:
    """What the consent page shows: the application, its owner's Project, the resources it asks for."""
    auth.require_user()
    import ontology

    m = _by_client(client_id)
    res = m.get("resources") or {}

    def names(kind: str, ids: list[str]) -> list[str]:
        out = []
        for i in ids:
            try:
                out.append((ontology._object_type(i)["display_name"]) if kind == "object" else ontology._action_type(i)["display_name"] if kind == "action" else i)
            except HTTPException:
                continue
        return out

    return {"name": m["name"], "description": m.get("description"), "kind": m["kind"], "redirect_uris": m["redirect_uris"],
            "object_types": names("object", res.get("object_types") or []), "action_types": names("action", res.get("action_types") or []),
            "functions": len(res.get("functions") or [])}


class ApproveIn(BaseModel):
    client_id: str
    redirect_uri: str
    state: str = ""
    code_challenge: Optional[str] = None
    code_challenge_method: Optional[str] = None
    deny: bool = False


@oauth.post("/authorize/approve")
def approve(req: ApproveIn) -> dict:
    """The signed-in user grants (or denies) the application: the redirect with a one-time code."""
    u = auth.require_user()
    m = _by_client(req.client_id)
    if req.redirect_uri not in m["redirect_uris"]:
        raise HTTPException(400, "redirect_uri is not one of the application's redirect URLs")
    sep = "&" if "?" in req.redirect_uri else "?"
    if req.deny:
        return {"redirect": req.redirect_uri + sep + urlencode({"error": "access_denied", "state": req.state})}
    code = secrets.token_urlsafe(32)
    with _lock:
        t = _tokens()
        t["codes"][_sha(code)] = {"app_id": m["id"], "user_id": u["id"], "redirect_uri": req.redirect_uri, "challenge": req.code_challenge,
                                  "method": req.code_challenge_method, "exp": time.time() + CODE_TTL}
        _save_tokens(t)
    return {"redirect": req.redirect_uri + sep + urlencode({"code": code, "state": req.state})}


def _issue(t: dict, app_id: str, user_id: str, refresh: bool = True) -> dict:
    access = auth.OAUTH_PREFIX + secrets.token_urlsafe(32)
    t["access"][_sha(access)] = {"app_id": app_id, "user_id": user_id, "exp": time.time() + ACCESS_TTL, "issued": _now()}
    out = {"access_token": access, "token_type": "bearer", "expires_in": ACCESS_TTL,
           "scope": "api:ontologies-read api:ontologies-write" + (" api:audit-read" if audit_read(app_id) else "")}
    if refresh:
        r = "bsai_ort_" + secrets.token_urlsafe(32)
        t["refresh"][_sha(r)] = {"app_id": app_id, "user_id": user_id, "exp": time.time() + REFRESH_TTL}
        out["refresh_token"] = r
    return out


def _err(code: str, desc: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": code, "error_description": desc}, status_code=status)


@oauth.post("/token")
async def token(request: Request) -> Response:
    """authorization_code (PKCE for public clients, the secret for confidential ones), refresh_token, client_credentials."""
    ct = request.headers.get("content-type", "")
    body = dict(await request.form()) if "form" in ct else (await request.json() if "json" in ct else {})
    basic = request.headers.get("authorization", "")
    if basic.lower().startswith("basic "):
        cid, _, csec = base64.b64decode(basic[6:]).decode().partition(":")
        body.setdefault("client_id", cid)
        body.setdefault("client_secret", csec)
    try:
        m = _by_client(str(body.get("client_id", "")))
    except HTTPException:
        return _err("invalid_client", "unknown client_id", 401)
    confidential = m["kind"] == "backend"
    if confidential and _sha(str(body.get("client_secret", ""))) != m.get("secret_hash"):
        return _err("invalid_client", "the client secret is wrong", 401)
    grant = body.get("grant_type")
    with _lock:
        t = _tokens()
        if grant == "authorization_code":
            c = t["codes"].pop(_sha(str(body.get("code", ""))), None)
            if not c or c["exp"] < time.time() or c["app_id"] != m["id"]:
                _save_tokens(t)
                return _err("invalid_grant", "the code is invalid, used or expired")
            if body.get("redirect_uri") != c["redirect_uri"]:
                _save_tokens(t)
                return _err("invalid_grant", "redirect_uri does not match the authorization request")
            if c.get("challenge"):
                v = str(body.get("code_verifier", ""))
                calc = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip("=")
                if calc != c["challenge"]:
                    _save_tokens(t)
                    return _err("invalid_grant", "the PKCE code_verifier does not match")
            elif not confidential:
                return _err("invalid_request", "public clients use PKCE")
            out = _issue(t, m["id"], c["user_id"])
        elif grant == "refresh_token":
            r = t["refresh"].pop(_sha(str(body.get("refresh_token", ""))), None)
            if not r or r["exp"] < time.time() or r["app_id"] != m["id"]:
                _save_tokens(t)
                return _err("invalid_grant", "the refresh token is invalid or expired")
            out = _issue(t, m["id"], r["user_id"])
        elif grant == "client_credentials":
            if not confidential:
                return _err("unauthorized_client", "client credentials are for backend applications")
            # a backend application acts as its service user (when it has one), else as the user who created it
            out = _issue(t, m["id"], m.get("service_user_id") or m["created_by"], refresh=False)
        else:
            return _err("unsupported_grant_type", f"{grant!r} is not supported")
        _save_tokens(t)
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


@oauth.post("/revoke")
async def revoke(request: Request) -> Response:
    ct = request.headers.get("content-type", "")
    body = dict(await request.form()) if "form" in ct else (await request.json() if "json" in ct else {})
    h = _sha(str(body.get("token", "")))
    with _lock:
        t = _tokens()
        t["access"].pop(h, None)
        t["refresh"].pop(h, None)
        _save_tokens(t)
    return Response(status_code=200)


class ServiceUserIn(BaseModel):
    enabled: bool


@router.put("/apps/{app_id}/service-user")
def set_service_user(app_id: str, req: ServiceUserIn) -> dict:
    """Give a backend application its own service user (client credentials tokens act as it), or go back to acting as
    the creator (the service user is deactivated; turning it on again reactivates it)."""
    with _lock:
        m = _app(app_id)
        _access(m, "editor")
        me = auth.current() or {}
        if auth.enabled() and me.get("role") != "admin":
            raise HTTPException(403, "only administrators create service users")
        if m["kind"] != "backend":
            raise HTTPException(400, "service users are for backend applications (client credentials)")
        uid = m.get("service_user_id") or m.get("service_user_was")
        if req.enabled:
            if uid:
                u = auth._user(uid)
                u["disabled"] = False
                auth._save_user(u)
            else:
                base = "svc-" + (re.sub(r"[^a-z0-9]+", "-", m["name"].lower()).strip("-")[:40] or "app")
                name, n = base, 1
                while any(x["username"] == name for x in auth._users()):
                    n += 1
                    name = f"{base}-{n}"
                u = auth._new_user(name, None, "user", display_name=f"{m['name']} (service user)", attributes={"service_user_of": [app_id]})
                uid = u["id"]
            m["service_user_id"] = uid
            m.pop("service_user_was", None)
        elif m.get("service_user_id"):
            u = auth._user(m["service_user_id"])
            u["disabled"] = True
            auth._save_user(u)
            m["service_user_was"] = m.pop("service_user_id")
        _save(m)
    _revoke_app(app_id)
    return {"service_user": service_user(m)}


class AuditReadIn(BaseModel):
    enabled: bool


@router.put("/apps/{app_id}/audit-read")
def set_audit_read(app_id: str, req: AuditReadIn) -> dict:
    """Audit-read access (Security auditing): the application's tokens carry the api:audit-read scope and may call the
    audit log files API (/api/v2/audit, audit3.py). Its user still needs an organization's audit log reader permission."""
    auth.require_admin()
    with _lock:
        m = _app(app_id)
        m["audit_read"] = req.enabled
        _save(m)
    _revoke_app(app_id)
    return {"audit_read": req.enabled}


def audit_read(app_id: str) -> bool:
    """Whether an application was given audit-read access (api:audit-read)."""
    try:
        return bool(_app(app_id).get("audit_read"))
    except HTTPException:
        return False


def service_user(m: dict) -> Optional[dict]:
    if not m.get("service_user_id"):
        return None
    try:
        u = auth._user(m["service_user_id"])
    except HTTPException:
        return None
    return {"id": u["id"], "username": u["username"], "display_name": u.get("display_name"), "disabled": bool(u.get("disabled"))}


@oauth.get("/my-grants")
def my_grants() -> list[dict]:
    """The applications the signed-in user granted access to (they hold a live access or refresh token for them)."""
    u = auth.require_user()
    t = _tokens()
    now = time.time()
    by: dict[str, dict] = {}
    for kind in ("access", "refresh"):
        for v in t[kind].values():
            if v["user_id"] != u["id"] or v["exp"] < now:
                continue
            g = by.setdefault(v["app_id"], {"app_id": v["app_id"], "access_tokens": 0, "refresh_tokens": 0, "last_issued": None, "expires": 0})
            g[f"{kind}_tokens"] += 1
            g["expires"] = max(g["expires"], v["exp"])
            if v.get("issued") and (g["last_issued"] is None or v["issued"] > g["last_issued"]):
                g["last_issued"] = v["issued"]
    out = []
    for app_id, g in by.items():
        try:
            m = _app(app_id)
        except HTTPException:
            continue
        info = client_info(m["client_id"])
        out.append({**g, "expires": datetime.fromtimestamp(g["expires"], timezone.utc).isoformat(timespec="seconds"), "name": m["name"], "kind": m["kind"], "description": m.get("description") or "",
                    "object_types": info["object_types"], "action_types": info["action_types"], "functions": info["functions"]})
    return sorted(out, key=lambda x: x["name"].lower())


@oauth.delete("/my-grants/{app_id}")
def revoke_my_grant(app_id: str) -> dict:
    """Revoke the signed-in user's own grant: their tokens for the application stop working."""
    u = auth.require_user()
    with _lock:
        t = _tokens()
        n = 0
        for kind in ("access", "refresh", "codes"):
            for h in [h for h, v in t[kind].items() if v.get("app_id") == app_id and v.get("user_id") == u["id"]]:
                t[kind].pop(h)
                n += 1
        _save_tokens(t)
    return {"revoked": n}


@router.get("/apps/{app_id}/grants")
def grants(app_id: str) -> dict:
    m = _app(app_id)
    _access(m, "editor")
    t = _tokens()
    users = sorted({v["user_id"] for v in [*t["access"].values(), *t["refresh"].values()] if v["app_id"] == app_id})
    return {"users": users, "active_tokens": sum(1 for v in t["access"].values() if v["app_id"] == app_id), "service_user": service_user(m)}


@router.delete("/apps/{app_id}/grants")
def revoke_grants(app_id: str) -> dict:
    m = _app(app_id)
    _access(m, "editor")
    _revoke_app(app_id)
    return {"revoked": True}


# ------------------------------------------------------------------------------------------------
# CORS for registered origins (the OSDK API and the token endpoint)
# ------------------------------------------------------------------------------------------------


async def cors(request: Request, call_next):  # noqa: ANN001, ANN201
    origin = request.headers.get("origin")
    path = request.url.path
    if not origin or not path.startswith(("/api/v2/", "/api/oauth2/token", "/api/oauth2/revoke")):
        return await call_next(request)
    # hosted websites (their own origin, bearer tokens only) and each application's registered origins
    allowed = (auth._hosting_separate() and origin.rstrip("/") == auth.hosting_url()) or any(origin in (m.get("allowed_origins") or []) for m in _all())
    if not allowed:
        return await call_next(request)
    headers = {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type",
               "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Max-Age": "600"}
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=headers)
    response = await call_next(request)
    for k, v in headers.items():
        response.headers[k] = v
    return response
