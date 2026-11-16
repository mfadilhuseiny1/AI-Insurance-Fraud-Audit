"""Foundry's Iceberg REST catalog (the Apache Iceberg REST catalog spec), mounted by server.py at /api/iceberg — the
`uri` external clients (PyIceberg, Spark, Snowflake, Trino...) and Python transforms are configured with.

- Authentication: a personal API token (`token`), or OAuth2 client credentials exchanged at /api/iceberg/v1/oauth/tokens
  (`oauth2-server-uri` + `credential: client_id:client_secret`, optional `scope: api:iceberg-read api:iceberg-write`)
  for an application registered in the Iceberg app; such a client acts with the permissions of the user who registered
  it, limited to its scope.
- Namespaces are Files paths: `Project.Folder` (levels separated by %1F in URLs) is /Project/Folder; `foundry` is the
  root. Tables are named by namespace + name, by RID (`ri.tables.main.table.<id>`, also as a name in any namespace) or
  by Files path (`/Project/Folder/table`, as Spark passes back-ticked paths).
- `X-PLTR-Branch: <branch>` scopes every read and write to that branch with Foundry's branch isolation (see
  iceberg_catalog.py); privileged endpoints (drop / update namespace, drop / rename table, multi-table commits,
  views) cannot be called from a branch. `X-PLTR-Job` is set by Python transforms: the build's commits are staged.
- `X-Iceberg-Access-Delegation: vended-credentials` returns a BYOB location's FileIO credentials in the table config
  when the location allows it; Foundry-managed storage is the server's disk (no credentials).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import threading
import time
import uuid
from typing import Any, Optional
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

import auth
import db
import drive
import iceberg_catalog as C

router = APIRouter(prefix="/api/iceberg")
log = logging.getLogger("bluesandai.iceberg_rest")
SEP = "\x1f"
WRITE_SCOPE = "api:iceberg-write"
READ_SCOPE = "api:iceberg-read"
EXCLUDED_ON_BRANCH = "cannot be called from a Foundry branch (X-PLTR-Branch: {branch}): {what} is a privileged operation"
_lock = threading.Lock()


def _err(e: C.CatalogError) -> JSONResponse:
    return JSONResponse({"error": {"message": e.message, "type": e.kind, "code": e.status}}, status_code=e.status)


def _call(fn, *a, **kw) -> Any:
    try:
        return fn(*a, **kw)
    except C.CatalogError as e:
        return _err(e)
    except ValueError as e:  # pydantic ValidationError: a malformed request
        return _err(C.bad_request(f"malformed request: {e}"[:2000]))
    except Exception as e:  # noqa: BLE001 - the spec's error model, not a bare 500
        log.exception("Iceberg REST request failed")
        return _err(C.CatalogError(500, "ServiceFailureException", f"{type(e).__name__}: {e}"[:2000]))


def _ns(ns: str) -> list[str]:
    ns = unquote(ns)
    return [p for p in (ns.split(SEP) if SEP in ns else ns.split(".")) if p != ""]


def _branch(request: Request) -> Optional[str]:
    return C.canonical_branch(request.headers.get("x-pltr-branch"))


def _job(request: Request) -> Optional[str]:
    return request.headers.get("x-pltr-job") or None


def _no_branch(request: Request, what: str) -> None:
    b = _branch(request)
    if b:
        raise C.bad_request(EXCLUDED_ON_BRANCH.format(branch=b, what=what))


# ------------------------------------------------------------------------------------------------
# OAuth2 applications and scopes
# ------------------------------------------------------------------------------------------------


def _oauth() -> dict:
    return C._json(C.DIR / "oauth.json", {"clients": [], "tokens": {}})


def _save_oauth(d: dict) -> None:
    now = time.time()
    d["tokens"] = {k: v for k, v in d["tokens"].items() if v.get("expires", 0) > now}
    C._write(C.DIR / "oauth.json", d)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def create_client(name: str, scopes: list[str]) -> dict:
    """Register an application for the client credentials grant; its secret is shown once."""
    p = auth.require_user()
    bad = [s for s in scopes if s not in (READ_SCOPE, WRITE_SCOPE)]
    if bad or not scopes:
        raise C.bad_request(f"scopes must be {READ_SCOPE} and/or {WRITE_SCOPE}")
    cid = uuid.uuid4().hex
    secret = secrets.token_urlsafe(32)
    rec = {"client_id": cid, "name": name.strip()[:80] or "Iceberg client", "secret_hash": _sha(secret), "owner_id": p["id"],
           "owner": p.get("username"), "scopes": sorted(set(scopes)), "created_at": C._now(), "last_used_at": None}
    with _lock:
        d = _oauth()
        d["clients"].append(rec)
        _save_oauth(d)
    return {**{k: v for k, v in rec.items() if k != "secret_hash"}, "client_secret": secret}


def list_clients() -> list[dict]:
    p = auth.require_user()
    admin = not auth.enabled() or p.get("role") == "admin"
    return [{k: v for k, v in c.items() if k != "secret_hash"} for c in _oauth()["clients"] if admin or c["owner_id"] == p["id"]]


def delete_client(client_id: str) -> None:
    p = auth.require_user()
    with _lock:
        d = _oauth()
        c = next((c for c in d["clients"] if c["client_id"] == client_id), None)
        if not c:
            raise C.CatalogError(404, "NotFoundException", "no such application")
        if auth.enabled() and c["owner_id"] != p["id"] and p.get("role") != "admin":
            raise C.forbidden("only the application's owner or an administrator can delete it")
        d["clients"] = [x for x in d["clients"] if x["client_id"] != client_id]
        for h, t in list(d["tokens"].items()):
            if t["client_id"] == client_id:
                d["tokens"].pop(h)
                _revoke_hash(h)
        _save_oauth(d)


def _revoke_hash(token_hash: str) -> None:
    """Revoke an issued access token (job tokens are stored by the same SHA-256 hash)."""
    if auth.enabled():
        with auth._lock, auth._db() as con:
            con.execute("DELETE FROM job_tokens WHERE token_hash = ?", (token_hash,))


def _scope(request: Request) -> Optional[set[str]]:
    """The scopes of an OAuth2 token the request carries (None: not an OAuth2 token — a user's full access)."""
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        return None
    t = _oauth()["tokens"].get(_sha(h[7:].strip()))
    if not t:
        return None
    return set(t["scope"].split())


def _require_write(request: Request) -> None:
    s = _scope(request)
    if s is not None and WRITE_SCOPE not in s:
        raise C.forbidden(f"this OAuth2 token was issued without the {WRITE_SCOPE} scope")


def _require_read(request: Request) -> None:
    s = _scope(request)
    if s is not None and not s & {READ_SCOPE, WRITE_SCOPE}:
        raise C.forbidden(f"this OAuth2 token has no {READ_SCOPE} scope")


@router.post("/v1/oauth/tokens")
async def oauth_tokens(request: Request) -> Response:
    """The client credentials grant (an Iceberg-flavoured authorization server, as Foundry's)."""
    form = dict(await request.form())
    cid, secret = form.get("client_id"), form.get("client_secret")
    h = request.headers.get("authorization", "")
    if h.lower().startswith("basic "):
        try:
            cid, secret = base64.b64decode(h[6:]).decode().split(":", 1)
        except ValueError:
            pass
    if form.get("grant_type") != "client_credentials":
        return JSONResponse({"error": "unsupported_grant_type", "error_description": "only client_credentials is supported"}, status_code=400)
    d = _oauth()
    c = next((c for c in d["clients"] if c["client_id"] == cid), None)
    if not c or not secret or not secrets.compare_digest(c["secret_hash"], _sha(str(secret))):
        return JSONResponse({"error": "invalid_client", "error_description": "unknown client or wrong secret"}, status_code=401)
    asked = set(str(form.get("scope") or "").split()) - {"catalog"}
    scope = (asked & set(c["scopes"])) if asked else set(c["scopes"])
    if asked and not scope:
        return JSONResponse({"error": "invalid_scope", "error_description": f"allowed scopes: {' '.join(c['scopes'])}"}, status_code=400)
    seconds = 3600
    token = auth.issue_job_token(c["owner_id"], seconds, f"Iceberg OAuth2 client {c['name']}") or ("bsai_ice_" + secrets.token_urlsafe(32))
    with _lock:
        d = _oauth()
        for x in d["clients"]:
            if x["client_id"] == cid:
                x["last_used_at"] = C._now()
        d["tokens"][_sha(token)] = {"client_id": cid, "scope": " ".join(sorted(scope)), "expires": time.time() + seconds}
        _save_oauth(d)
    return JSONResponse({"access_token": token, "token_type": "bearer", "expires_in": seconds,
                         "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "scope": " ".join(sorted(scope))})


# ------------------------------------------------------------------------------------------------
# config and namespaces
# ------------------------------------------------------------------------------------------------


@router.get("/v1/config")
def config(warehouse: Optional[str] = None) -> dict:
    return {"defaults": {}, "overrides": {"namespace-separator": "%1F"},
            "endpoints": [
                "GET /v1/{prefix}/namespaces", "POST /v1/{prefix}/namespaces", "GET /v1/{prefix}/namespaces/{namespace}",
                "HEAD /v1/{prefix}/namespaces/{namespace}", "DELETE /v1/{prefix}/namespaces/{namespace}",
                "POST /v1/{prefix}/namespaces/{namespace}/properties", "GET /v1/{prefix}/namespaces/{namespace}/tables",
                "POST /v1/{prefix}/namespaces/{namespace}/tables", "GET /v1/{prefix}/namespaces/{namespace}/tables/{table}",
                "HEAD /v1/{prefix}/namespaces/{namespace}/tables/{table}", "POST /v1/{prefix}/namespaces/{namespace}/tables/{table}",
                "DELETE /v1/{prefix}/namespaces/{namespace}/tables/{table}", "POST /v1/{prefix}/namespaces/{namespace}/register",
                "POST /v1/{prefix}/tables/rename", "POST /v1/{prefix}/transactions/commit",
                "POST /v1/{prefix}/namespaces/{namespace}/tables/{table}/metrics",
                "GET /v1/{prefix}/namespaces/{namespace}/tables/{table}/credentials",
            ]}


def _ns_props() -> dict:
    return C._json(C.DIR / "namespaces.json", {})


def _ns_info(folder: Optional[dict], names: list[str]) -> dict:
    props = {"foundry.path": "/" + "/".join(names)}
    if folder:
        props.update({"foundry.rid": f"ri.compass.main.folder.{folder['id']}", **_ns_props().get(folder["id"], {})})
    return {"namespace": names, "properties": props}


def _visible_children(parent: Optional[str]) -> list[dict]:
    return auth.visible([c for c in db.drive_list(parent) if c["kind"] in ("project", "folder")])


@router.get("/v1/namespaces")
def list_namespaces(request: Request, parent: Optional[str] = None) -> Any:
    def go() -> dict:
        _require_read(request)
        names = _ns(parent) if parent else []
        folder = C.namespace_folder(names) if names else None
        return {"namespaces": [[*names, c["name"]] for c in _visible_children(folder["id"] if folder else None)]}

    return _call(go)


@router.post("/v1/namespaces")
async def create_namespace(request: Request) -> Any:
    body = await request.json()

    def go() -> dict:
        _require_write(request)
        names = [n for n in body.get("namespace") or [] if n]
        if not names:
            raise C.bad_request("namespace is empty")
        try:
            if C._folder_by_names(names):
                raise C.CatalogError(409, "AlreadyExistsException", f"Namespace already exists: {'.'.join(names)}")
            parent = C._folder_by_names(names[:-1]) if len(names) > 1 else None
            if len(names) > 1 and not parent:
                raise C.no_namespace(".".join(names[:-1]))
            if parent is None:
                raise C.forbidden("top-level namespaces are Projects: create the Project in Files first")
            drive._folder_id(parent["id"])
            fid = drive._ensure_folders(parent["id"], names[-1:])
        except HTTPException as e:
            raise C.forbidden(str(e.detail)) from None
        if body.get("properties"):
            d = _ns_props()
            d[fid] = {str(k): str(v) for k, v in body["properties"].items()}
            C._write(C.DIR / "namespaces.json", d)
        return _ns_info(db.drive_get(fid), names)

    return _call(go)


@router.get("/v1/namespaces/{namespace}")
def load_namespace(namespace: str, request: Request) -> Any:
    def go() -> dict:
        _require_read(request)
        names = _ns(namespace)
        folder = C.namespace_folder(names)
        if folder and not auth.can_access(folder["id"]):
            raise C.no_namespace(".".join(names))
        return _ns_info(folder, names)

    return _call(go)


@router.head("/v1/namespaces/{namespace}")
def namespace_exists(namespace: str, request: Request) -> Response:
    r = load_namespace(namespace, request)
    return Response(status_code=r.status_code if isinstance(r, Response) else 204)


@router.delete("/v1/namespaces/{namespace}")
def drop_namespace(namespace: str, request: Request) -> Response:
    def go() -> Response:
        _no_branch(request, "dropNamespace")
        _require_write(request)
        names = _ns(namespace)
        folder = C.namespace_folder(names)
        if folder is None or folder["kind"] == "project":
            raise C.forbidden("Projects cannot be dropped through the Iceberg catalog")
        if db.drive_list(folder["id"]):
            raise C.CatalogError(409, "NamespaceNotEmptyException", f"Namespace is not empty: {'.'.join(names)}")
        try:
            drive.trash(folder["id"])
        except HTTPException as e:
            raise C.forbidden(str(e.detail)) from None
        return Response(status_code=204)

    return _call(go)


@router.post("/v1/namespaces/{namespace}/properties")
async def update_namespace(namespace: str, request: Request) -> Any:
    body = await request.json()

    def go() -> dict:
        _no_branch(request, "updateNamespace")
        _require_write(request)
        folder = C.namespace_folder(_ns(namespace))
        if folder is None:
            raise C.forbidden("the root namespace has no properties")
        try:
            drive._folder_id(folder["id"])
        except HTTPException as e:
            raise C.forbidden(str(e.detail)) from None
        d = _ns_props()
        cur = d.get(folder["id"], {})
        removals = [str(k) for k in body.get("removals") or []]
        updates = {str(k): str(v) for k, v in (body.get("updates") or {}).items()}
        removed = [k for k in removals if k in cur]
        missing = [k for k in removals if k not in cur]
        for k in removed:
            cur.pop(k)
        cur.update(updates)
        d[folder["id"]] = cur
        C._write(C.DIR / "namespaces.json", d)
        return {"updated": list(updates), "removed": removed, "missing": missing}

    return _call(go)


# ------------------------------------------------------------------------------------------------
# tables
# ------------------------------------------------------------------------------------------------


def _table_config(request: Request, item_id: str) -> dict:
    cfg: dict[str, str] = {}
    if (request.headers.get("x-iceberg-access-delegation") or "").find("vended-credentials") >= 0:
        b = C.bucket(C.record(item_id).get("storage"))
        if b.get("access_delegation") == "vended-credentials":
            cfg.update({k: str(v) for k, v in C.fileio_properties(b).items()})
    return cfg


def _load_result(request: Request, item_id: str, loc: str, md) -> dict:
    return {"metadata-location": loc, "metadata": C.metadata_json(md), "config": _table_config(request, item_id)}


@router.get("/v1/namespaces/{namespace}/tables")
def list_tables(namespace: str, request: Request) -> Any:
    def go() -> dict:
        _require_read(request)
        names = _ns(namespace)
        folder = C.namespace_folder(names)
        kids = auth.visible([c for c in db.drive_list(folder["id"] if folder else None) if C.is_table(c)])
        return {"identifiers": [{"namespace": names, "name": c["name"]} for c in kids]}

    return _call(go)


@router.post("/v1/namespaces/{namespace}/tables")
async def create_table(namespace: str, request: Request) -> Any:
    from pyiceberg.catalog.rest import CreateTableRequest

    body = await request.json()

    def go() -> dict:
        _require_write(request)
        req = CreateTableRequest.model_validate({"location": None, "partition-spec": None, "write-order": None, **body})
        names = _ns(namespace)
        name = req.name
        folder = C.namespace_folder(names)
        if name.startswith("/"):
            parts = [p for p in name.split("/") if p]
            folder = C._folder_by_names(parts[:-1]) if len(parts) > 1 else None
            if len(parts) > 1 and folder is None:
                raise C.no_namespace("/".join(parts[:-1]))
            name = parts[-1]
        branch = _branch(request) or (C.job(_job(request)) or {}).get("branch")
        if req.stage_create:
            return _staged(request, folder, name, req, branch)
        item = C.create_table(folder["id"] if folder else None, name, req.table_schema, req.partition_spec, req.write_order,
                              req.properties, branch=branch)
        loc, md = C.load(item["id"], branch, _job(request))
        return _load_result(request, item["id"], loc, md)

    return _call(go)


def _staged(request: Request, folder: Optional[dict], name: str, req, branch: Optional[str]) -> dict:
    """stage-create (CREATE TABLE AS SELECT, createOrReplace): the table is created empty now, so the client's
    later commit (assert-create + the table's metadata) applies to it."""
    item = C.create_table(folder["id"] if folder else None, name, req.table_schema, req.partition_spec, req.write_order, req.properties, branch=branch)
    rec = C.record(item["id"])
    rec["staged_create"] = True
    C.save_record(rec)
    loc, md = C.load(item["id"], branch, _job(request))
    return {"metadata-location": None, "metadata": C.metadata_json(md), "config": _table_config(request, item["id"])}


@router.post("/v1/namespaces/{namespace}/tables/{table}/metrics")
async def report_metrics(namespace: str, table: str, request: Request) -> Response:
    await request.body()
    return Response(status_code=204)


@router.get("/v1/namespaces/{namespace}/tables/{table}/credentials")
def load_credentials(namespace: str, table: str, request: Request) -> Any:
    def go() -> dict:
        _require_read(request)
        item = C.resolve(_ns(namespace), unquote(table))
        b = C.bucket(C.record(item["id"]).get("storage"))
        creds = []
        if b.get("access_delegation") == "vended-credentials":
            creds.append({"prefix": C._base_uri(b), "config": {k: str(v) for k, v in C.fileio_properties(b).items()}})
        return {"storage-credentials": creds}

    return _call(go)


@router.get("/v1/namespaces/{namespace}/tables/{table:path}")
def load_table(namespace: str, table: str, request: Request, snapshots: Optional[str] = None) -> Any:
    def go() -> dict:
        _require_read(request)
        item = C.resolve(_ns(namespace), unquote(table))
        loc, md = C.load(item["id"], _branch(request), _job(request))
        return _load_result(request, item["id"], loc, md)

    return _call(go)


@router.head("/v1/namespaces/{namespace}/tables/{table:path}")
def table_exists(namespace: str, table: str, request: Request) -> Response:
    try:
        _require_read(request)
        C.resolve(_ns(namespace), unquote(table))
        return Response(status_code=204)
    except C.CatalogError as e:
        return Response(status_code=e.status)




def _commit_one(request: Request, item: dict, body: dict) -> tuple[str, Any]:
    from pyiceberg.table import CommitTableRequest
    from pyiceberg.table.update import AssertCreate

    req = CommitTableRequest.model_validate({**body, "identifier": body.get("identifier") or {"namespace": [], "name": item["name"]}})
    reqs = tuple(r for r in req.requirements if not isinstance(r, AssertCreate))
    if len(reqs) != len(req.requirements):
        rec = C.record(item["id"])
        if not rec.get("staged_create"):
            raise C.CatalogError(409, "AlreadyExistsException", f"Table already exists: {item['name']}")
        rec.pop("staged_create", None)
        C.save_record(rec)
        # the client's create-table updates (schema, spec, properties...) apply on top of the empty table
    return C.commit(item["id"], reqs, tuple(req.updates), _branch(request), _job(request))


@router.post("/v1/namespaces/{namespace}/tables/{table:path}")
async def update_table(namespace: str, table: str, request: Request) -> Any:
    body = await request.json()

    def go() -> dict:
        _require_write(request)
        item = C.resolve(_ns(namespace), unquote(table))
        C.table_item(item["id"], need="editor")
        loc, md = _commit_one(request, item, body)
        return {"metadata-location": loc, "metadata": C.metadata_json(md)}

    return _call(go)


@router.delete("/v1/namespaces/{namespace}/tables/{table:path}")
def drop_table(namespace: str, table: str, request: Request, purgeRequested: bool = False) -> Response:  # noqa: N803 - spec name
    def go() -> Response:
        _no_branch(request, "dropTable")
        _require_write(request)
        item = C.resolve(_ns(namespace), unquote(table))
        C.drop_table(item["id"])
        return Response(status_code=204)

    return _call(go)


@router.post("/v1/namespaces/{namespace}/register")
async def register_table(namespace: str, request: Request) -> Response:
    return _err(C.CatalogError(406, "UnsupportedOperationException",
                               "registering existing metadata is not supported: Foundry-managed tables are created through the catalog"))


@router.post("/v1/tables/rename")
async def rename_table(request: Request) -> Response:
    body = await request.json()

    def go() -> Response:
        _no_branch(request, "renameTable")
        _require_write(request)
        src, dst = body.get("source") or {}, body.get("destination") or {}
        item = C.resolve(src.get("namespace") or [], src.get("name") or "")
        C.table_item(item["id"], need="editor")
        folder = C.namespace_folder(dst.get("namespace") or [])
        try:
            drive.update_item(item["id"], drive.ItemChange(name=dst.get("name") or item["name"],
                                                           move_to=(folder["id"] if folder else "root") if folder is None or folder["id"] != item["parent_id"] else None))
        except HTTPException as e:
            raise C.CatalogError(e.status_code, "BadRequestException" if e.status_code != 403 else "ForbiddenException", str(e.detail)) from None
        return Response(status_code=204)

    return _call(go)


@router.post("/v1/transactions/commit")
async def commit_transaction(request: Request) -> Response:
    body = await request.json()

    def go() -> Response:
        _no_branch(request, "commitTransaction")
        _require_write(request)
        changes = body.get("table-changes") or []
        items = []
        for ch in changes:
            ident = ch.get("identifier") or {}
            item = C.resolve(ident.get("namespace") or [], ident.get("name") or "")
            C.table_item(item["id"], need="editor")
            items.append((item, ch))
        # all tables commit together: a job transaction makes the multi-table commit atomic
        jid = f"tx-{uuid.uuid4().hex[:10]}"
        C.begin_job(jid, None, "multi-table commit")
        try:
            for item, ch in items:
                C.commit(item["id"], *_parsed(ch, item), None, jid, writer={"kind": "external", "label": "multi-table commit"})
            C.commit_job(jid)
        except Exception:
            C.abort_job(jid)
            raise
        return Response(status_code=204)

    return _call(go)


def _parsed(ch: dict, item: dict) -> tuple[tuple, tuple]:
    from pyiceberg.table import CommitTableRequest

    req = CommitTableRequest.model_validate({**ch, "identifier": ch.get("identifier") or {"namespace": [], "name": item["name"]}})
    return tuple(req.requirements), tuple(req.updates)


# views: not supported by Foundry Iceberg

_NO_VIEWS = C.CatalogError(400, "BadRequestException", "Iceberg views are not supported in Foundry")


@router.get("/v1/namespaces/{namespace}/views")
def list_views(namespace: str) -> dict:
    return {"identifiers": []}


@router.api_route("/v1/namespaces/{namespace}/views/{view}", methods=["GET", "HEAD", "POST", "DELETE"])
def view_ops(namespace: str, view: str, request: Request) -> Response:
    if request.method == "HEAD":
        return Response(status_code=404)
    if request.method in ("POST", "DELETE") and _branch(request):
        return _err(C.bad_request(EXCLUDED_ON_BRANCH.format(branch=_branch(request), what="createView/dropView")))
    return _err(_NO_VIEWS)


@router.post("/v1/namespaces/{namespace}/views")
def create_view(namespace: str, request: Request) -> Response:
    if _branch(request):
        return _err(C.bad_request(EXCLUDED_ON_BRANCH.format(branch=_branch(request), what="createView")))
    return _err(_NO_VIEWS)


@router.post("/v1/views/rename")
def rename_view(request: Request) -> Response:
    if _branch(request):
        return _err(C.bad_request(EXCLUDED_ON_BRANCH.format(branch=_branch(request), what="renameView")))
    return _err(_NO_VIEWS)

