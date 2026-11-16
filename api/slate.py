"""Slate (Application Building → Slate): low-code applications with pages, widgets, queries, functions, variables,
events and styles, stored as versioned documents.

An application is a Files item (`<name>.slate`, application/vnd.bluesandai.slate+json) in a Project: the item's
Project roles and markings govern it (viewers open published or tagged versions, editors save, publish and tag).
Its versions live under data/slate/<app id>/ (meta.json, versions/<n>.json); every save makes a new version, and a
save whose base is not the latest version is refused with the latest document so the editor can merge.

The document is JSON the browser runs (web/src/lib/slateRuntime.ts): Handlebars templates over variables, queries,
functions and widget state; JavaScript functions in a worker; events wiring triggers to actions. What needs the
server is here:
- queries: `foundry_sql` (read-only SQL over datasets, the SQL Studio engine, with the viewer's permissions) and
  `http_json` (a Data Connection REST API source the editor added to the application; egress and credentials are
  applied by the source, `..` in paths is refused);
- public applications (type "public", created by administrators): the published version is served without sign-in
  at /api/slate/public/apps/<permalink>, and secure upload channels / tokens let anonymous users upload JSON blobs
  into a Files folder;
- user storage: a per-user JSON value per application (`sl_user_storage`).
"""

from __future__ import annotations

import io
import json
import os
import re
import secrets
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/slate", tags=["slate"])
SLATE_TYPE = "application/vnd.bluesandai.slate+json"
DIR = Path("data/slate")
MAX_DOC_BYTES = 2 * 1024 * 1024
PERMALINK = re.compile(r"^[a-z0-9][a-z0-9-]{1,79}$")
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "slate"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    p = auth.current() or {}
    return {"id": p.get("id") or "local", "name": p.get("display_name") or p.get("username") or "local"}


def _app_dir(app_id: str) -> Path:
    if not re.fullmatch(r"sl-[0-9a-f]{12}", app_id):
        raise HTTPException(404, "Slate application not found")
    return DIR / app_id


def _read_json(p: Path) -> Optional[dict]:
    try:
        return json.loads(p.read_text("utf-8"))
    except FileNotFoundError:
        return None


def _write_json(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:  # Windows: a reader holds the file for a moment
            import time

            time.sleep(0.05)
    os.replace(tmp, p)


def _meta(app_id: str) -> dict:
    m = _read_json(_app_dir(app_id) / "meta.json")
    if not m:
        raise HTTPException(404, "Slate application not found")
    return m


def _save_meta(m: dict) -> None:
    _write_json(_app_dir(m["id"]) / "meta.json", m)


def _version_doc(app_id: str, n: int) -> dict:
    v = _read_json(_app_dir(app_id) / "versions" / f"{n}.json")
    if not v:
        raise HTTPException(404, f"version {n} not found")
    return v


def _access(m: dict, need: str = "viewer") -> dict:
    """The application's Files item when the caller has `need` on it (Project roles and markings)."""
    return drive._item(m["item_id"], need=need)


def _can_edit(m: dict) -> bool:
    try:
        _access(m, "editor")
        return True
    except HTTPException:
        return False


def _summary(m: dict) -> dict:
    return {k: m.get(k) for k in ("id", "name", "description", "permalink", "type", "item_id", "latest", "published", "auto_publish", "tags",
                                  "created_at", "created_by", "updated_at", "updated_by", "sources", "installed_from")}


def empty_document(name: str) -> dict:
    return {
        "schema": 1,
        "pages": [{"id": "page1", "name": "home", "widgets": []}],
        "toolbar": [],
        "queries": [],
        "functions": [],
        "library": "",
        "objectSets": [],
        "objectContexts": [],
        "foundryFunctions": [],
        "variables": [],
        "events": [],
        "styles": {"css": "", "theme": "dark"},
        "title": name,
    }


def _check_doc(doc: dict) -> bytes:
    if not isinstance(doc, dict) or not isinstance(doc.get("pages"), list) or not doc["pages"]:
        raise HTTPException(422, "a Slate document has at least one page")
    names: dict[str, str] = {}

    def claim(name: Any, what: str) -> None:
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name):
            raise HTTPException(422, f"{what} name {name!r} must be an identifier (letters, digits, _ and $)")
        if name in names:
            raise HTTPException(422, f"the name {name} is used by both {names[name]} and {what}: names are unique across the application")
        names[name] = what

    def widgets(ws: list, where: str) -> None:
        for w in ws or []:
            claim(w.get("id"), f"widget ({where})")
            widgets(w.get("children") or [], where)

    for p in doc["pages"]:
        widgets(p.get("widgets") or [], f"page {p.get('name')}")
    widgets(doc.get("toolbar") or [], "toolbar")
    for kind in ("queries", "functions", "objectSets", "objectContexts", "foundryFunctions", "variables"):
        for x in doc.get(kind) or []:
            claim(x.get("name"), kind[:-1] if kind != "queries" else "query")
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) > MAX_DOC_BYTES:
        raise HTTPException(413, "Slate applications are limited to 2 MB (put large data in datasets or objects)")
    return data


def _new_version(m: dict, doc: dict, message: str = "", base: Optional[int] = None) -> dict:
    _check_doc(doc)
    n = int(m.get("latest") or 0) + 1
    me = _me()
    _write_json(_app_dir(m["id"]) / "versions" / f"{n}.json", {"version": n, "document": doc, "message": message, "saved_at": _now(),
                                                               "saved_by": me["id"], "saved_by_name": me["name"], "base": base})
    m["latest"] = n
    m["updated_at"], m["updated_by"] = _now(), me["id"]
    m.setdefault("history", []).append({"version": n, "saved_at": m["updated_at"], "saved_by": me["id"], "saved_by_name": me["name"], "message": message})
    if m.get("auto_publish") and m.get("type") != "public":
        m["published"] = n
    return m


# ------------------------------------------------------------------------------------------------
# applications
# ------------------------------------------------------------------------------------------------


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    type: Literal["integrated", "public"] = "integrated"
    permalink: Optional[str] = None
    description: str = Field("", max_length=2000)
    document: Optional[dict] = None


def _permalink(name: str, wanted: Optional[str], skip: Optional[str] = None) -> str:
    base = (wanted or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "slate-app")[:70]
    if wanted and not PERMALINK.match(wanted):
        raise HTTPException(422, "a permalink holds lowercase letters, digits and dashes (2–80 characters)")
    taken = {m.get("permalink") for m in _all() if m["id"] != skip}
    if wanted and wanted in taken:
        raise HTTPException(409, f"the permalink {wanted} is taken")
    out, i = base if len(base) > 1 else f"{base}-app", 2
    while out in taken:
        out, i = f"{base}-{i}", i + 1
    return out


def _all() -> list[dict]:
    out = []
    if DIR.exists():
        for p in DIR.glob("sl-*/meta.json"):
            m = _read_json(p)
            if m:
                out.append(m)
    return out


def _create(req: AppIn, doc: Optional[dict] = None) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "create the Slate application in a Project or a folder")
    if req.type == "public":
        if auth.enabled() and (auth.current() or {}).get("role") != "admin":
            raise HTTPException(403, "creating public applications needs the Manage public Slate applications permission (administrators)")
        if folder["kind"] != "project" and not (folder.get("path") or drive._with_path(folder).get("path")):
            raise HTTPException(400, "public applications are created in Projects")
    with _lock:
        app_id = "sl-" + uuid.uuid4().hex[:12]
        name = req.name.strip()
        body = json.dumps({"slate_app_id": app_id}).encode()
        item = drive._store(folder["id"], drive._clean_name(name if name.endswith(".slate") else f"{name}.slate"), io.BytesIO(body), len(body), SLATE_TYPE)
        me = _me()
        m = {"id": app_id, "name": name.removesuffix(".slate"), "description": req.description, "type": req.type,
             "permalink": _permalink(name, req.permalink), "item_id": item["id"], "latest": 0, "published": None,
             "auto_publish": req.type != "public", "tags": {}, "sources": [], "created_at": _now(), "created_by": me["id"], "history": []}
        _new_version(m, doc or req.document or empty_document(m["name"]), "Created")
        _save_meta(m)
    return get_app(app_id)


@router.get("/apps")
def list_apps() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (SLATE_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"]: i for i in auth.visible(items)}
    out = []
    for m in _all():
        if m["item_id"] in visible:
            out.append({**_summary(m), "path": drive._with_path(visible[m["item_id"]]).get("path")})
    return sorted(out, key=lambda r: r.get("updated_at") or "", reverse=True)


@router.post("/apps")
def create_app(req: AppIn) -> dict:
    return _create(req)


def _resolve(m: dict, version: Optional[int], tag: Optional[str], editor: bool) -> int:
    """Which version a caller opens: editors any version (default the latest); viewers the published or a tagged one."""
    if tag:
        if tag == "published":
            if not m.get("published"):
                raise HTTPException(404, "this application has no published version")
            return int(m["published"])
        if tag not in (m.get("tags") or {}):
            raise HTTPException(404, f"no version is tagged {tag}")
        return int(m["tags"][tag])
    if version:
        if not editor and version != m.get("published") and version not in (m.get("tags") or {}).values():
            raise HTTPException(403, "viewers open the published version or a tagged one")
        return int(version)
    if editor:
        return int(m["latest"])
    if not m.get("published"):
        raise HTTPException(404, "this application has no published version yet")
    return int(m["published"])


@router.get("/apps/{app_id}")
def get_app(app_id: str, version: Optional[int] = None, tag: Optional[str] = None) -> dict:
    m = _meta(app_id)
    item = _access(m)
    editor = _can_edit(m)
    n = _resolve(m, version, tag, editor)
    v = _version_doc(app_id, n)
    return {"app": {**_summary(m), "path": drive._with_path(item).get("path")}, "version": n, "document": v["document"], "can_edit": editor,
            "saved_at": v.get("saved_at"), "saved_by_name": v.get("saved_by_name")}


@router.get("/by-permalink/{permalink}")
def by_permalink(permalink: str, tag: Optional[str] = None) -> dict:
    m = next((x for x in _all() if x.get("permalink") == permalink), None)
    if not m:
        raise HTTPException(404, f"no Slate application at {permalink}")
    return get_app(m["id"], tag=tag)


class SaveIn(BaseModel):
    document: dict
    base_version: int
    message: str = Field("", max_length=500)
    # overwrite: save over a newer version (the editor chose Overwrite after a conflict)
    overwrite: bool = False


@router.put("/apps/{app_id}")
def save_app(app_id: str, req: SaveIn) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        if req.base_version != m["latest"] and not req.overwrite:
            latest = _version_doc(app_id, m["latest"])
            raise HTTPException(409, {"code": "conflict", "message": f"{latest.get('saved_by_name') or 'Someone'} saved version {m['latest']} after you opened "
                                                                     f"version {req.base_version}", "latest_version": m["latest"],
                                      "latest": latest["document"], "base": _version_doc(app_id, req.base_version)["document"]})
        _new_version(m, req.document, req.message, req.base_version)
        _save_meta(m)
    return {"app": _summary(m), "version": m["latest"]}


@router.get("/apps/{app_id}/versions")
def versions(app_id: str) -> list[dict]:
    m = _meta(app_id)
    _access(m, "editor")
    tags = {}
    for t, n in (m.get("tags") or {}).items():
        tags.setdefault(n, []).append(t)
    return [{**h, "published": h["version"] == m.get("published"), "tags": tags.get(h["version"], [])} for h in reversed(m.get("history") or [])]


class PublishIn(BaseModel):
    version: int


@router.post("/apps/{app_id}/publish")
def publish(app_id: str, req: PublishIn) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        _version_doc(app_id, req.version)
        m["published"] = req.version
        _save_meta(m)
    return _summary(m)


@router.post("/apps/{app_id}/unpublish")
def unpublish(app_id: str) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        m["published"] = None
        m["auto_publish"] = False
        _save_meta(m)
    return _summary(m)


@router.put("/apps/{app_id}/tags/{tag}")
def set_tag(app_id: str, tag: str, req: PublishIn) -> dict:
    if tag == "published" or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", tag):
        raise HTTPException(422, "pick another tag name (published is reserved; letters, digits, . _ -)")
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        _version_doc(app_id, req.version)
        m.setdefault("tags", {})[tag] = req.version
        _save_meta(m)
    return _summary(m)


@router.delete("/apps/{app_id}/tags/{tag}")
def delete_tag(app_id: str, tag: str) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        (m.get("tags") or {}).pop(tag, None)
        _save_meta(m)
    return _summary(m)


@router.post("/apps/{app_id}/revert")
def revert(app_id: str, req: PublishIn) -> dict:
    """Save a historic version as the newest one."""
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        _new_version(m, _version_doc(app_id, req.version)["document"], f"Reverted to version {req.version}", m["latest"])
        _save_meta(m)
    return {"app": _summary(m), "version": m["latest"]}


class SettingsIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    permalink: Optional[str] = None
    auto_publish: Optional[bool] = None
    # Data Connection REST API sources the application's HTTP JSON queries may use (ids)
    sources: Optional[list[str]] = None


@router.put("/apps/{app_id}/settings")
def settings(app_id: str, req: SettingsIn) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        if req.name is not None:
            m["name"] = req.name.strip()
        if req.description is not None:
            m["description"] = req.description
        if req.permalink is not None and req.permalink != m.get("permalink"):
            m["permalink"] = _permalink(m["name"], req.permalink, skip=m["id"])
        if req.auto_publish is not None:
            if req.auto_publish and m.get("type") == "public":
                raise HTTPException(400, "public applications are published by hand")
            m["auto_publish"] = req.auto_publish
            if req.auto_publish:
                m["published"] = m["latest"]
        if req.sources is not None:
            known = {r["id"] for r in _rest_sources()}
            missing = [s for s in req.sources if s not in known]
            if missing:
                raise HTTPException(404, f"no REST API source {', '.join(missing)}")
            m["sources"] = req.sources
        _save_meta(m)
    return _summary(m)


@router.delete("/apps/{app_id}")
def delete_app(app_id: str) -> dict:
    """Moves the application's Files item to the trash; its versions stay until it is deleted for good."""
    m = _meta(app_id)
    item = _access(m, "editor")
    drive.trash(item["id"])
    return {"trashed": app_id}


@router.get("/apps/{app_id}/export")
def export(app_id: str, version: Optional[int] = None) -> dict:
    m = _meta(app_id)
    _access(m, "editor")
    n = version or m["latest"]
    return {"format": "slate.json", "version": 1, "name": m["name"], "permalink": m["permalink"], "type": m["type"],
            "exported_version": n, "document": _version_doc(app_id, n)["document"]}


class ImportIn(BaseModel):
    file: dict
    folder_id: Optional[str] = None


@router.post("/import")
def import_app(req: ImportIn) -> dict:
    """A .slate.json export: a new version of the application with its permalink, else a new application in folder_id."""
    f = req.file
    doc = f.get("document")
    if not isinstance(doc, dict):
        raise HTTPException(422, "not a Slate export (no document)")
    m = next((x for x in _all() if f.get("permalink") and x.get("permalink") == f.get("permalink")), None)
    if m:
        with _lock:
            _access(m, "editor")
            _new_version(m, doc, "Imported JSON", m["latest"])
            _save_meta(m)
        return {"created": False, **get_app(m["id"])}
    if not req.folder_id:
        raise HTTPException(400, {"code": "location_needed", "message": f"the permalink {f.get('permalink')} is new: choose a location"})
    return {"created": True, **_create(AppIn(name=f.get("name") or "Imported application", folder_id=req.folder_id, type=f.get("type") or "integrated",
                                             permalink=f.get("permalink") if f.get("permalink") and PERMALINK.match(f["permalink"]) else None), doc)}


class SaveAsIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: Optional[str] = None
    # overwrite this other application (a new version of it) instead of creating one
    target_app_id: Optional[str] = None


@router.post("/apps/{app_id}/save-as")
def save_as(app_id: str, req: SaveAsIn) -> dict:
    m = _meta(app_id)
    _access(m)
    doc = _version_doc(app_id, m["latest"])["document"]
    if req.target_app_id:
        t = _meta(req.target_app_id)
        with _lock:
            _access(t, "editor")
            _new_version(t, doc, f"Overwritten from {m['name']}", t["latest"])
            _save_meta(t)
        return get_app(t["id"])
    if not req.folder_id:
        raise HTTPException(400, "choose a location")
    return _create(AppIn(name=req.name, folder_id=req.folder_id, type="integrated"), doc)


# ------------------------------------------------------------------------------------------------
# queries that need the server
# ------------------------------------------------------------------------------------------------


def _rest_sources() -> list[dict]:
    try:
        import webhooks
    except ImportError:
        return []
    try:
        return webhooks.ds._rows("SELECT * FROM rest_sources ORDER BY name")
    except Exception:  # noqa: BLE001 - no Data Connection database
        return []


@router.get("/sources")
def sources() -> list[dict]:
    """Data sources for queries: the Foundry SQL source, this platform's API, and Data Connection REST API sources."""
    out = [{"id": "foundry", "name": "Foundry datasets (SQL)", "kind": "foundry_sql"},
           {"id": "api-gateway", "name": "API Gateway (this platform's REST API)", "kind": "api_gateway"}]
    out += [{"id": r["id"], "name": r["name"], "api_name": r.get("api_name"), "kind": "http_json",
             "domains": [d["url"] for d in (r.get("config") or {}).get("domains") or []]} for r in _rest_sources()]
    return out


class QueryIn(BaseModel):
    kind: Literal["foundry_sql", "http_json"]
    sql: Optional[str] = Field(None, max_length=200_000)
    source: Optional[str] = None
    # http_json: {path, method, queryParams, bodyJson, headers}
    request: Optional[dict] = None
    limit: int = Field(10_000, ge=1, le=100_000)


READ_ONLY = re.compile(r"^\s*(\(\s*)*(select|with|values|table|show|describe|explain)\b", re.I)


def _columns(rows: list[dict], columns: list[str]) -> dict:
    """Rows as Slate's column-oriented JSON ({column: [values…]})."""
    return {c: [r.get(c) for r in rows] for c in columns}


@router.post("/apps/{app_id}/queries/run")
def run_query(app_id: str, req: QueryIn) -> dict:
    m = _meta(app_id)
    _access(m)
    if req.kind == "foundry_sql":
        if not req.sql or not READ_ONLY.match(req.sql):
            raise HTTPException(400, "Foundry queries in Slate are read-only: SELECT / WITH statements")
        import sql_studio

        out = sql_studio.run(req.sql, "data", 10_000 if req.limit > 1_000 else 1_000)
        cols = [c["name"] if isinstance(c, dict) else str(c) for c in out.get("columns") or []]
        rows = out.get("rows") or []
        if rows and isinstance(rows[0], list):
            rows = [dict(zip(cols, r)) for r in rows]
        return {"data": _columns(rows, cols), "row_count": out.get("row_count", len(rows)), "truncated": out.get("truncated", False), "ms": out.get("ms")}
    r = req.request or {}
    if req.source not in (m.get("sources") or []):
        raise HTTPException(403, "add the REST API source to the application (Queries → Data sources) before querying it")
    row = next((x for x in _rest_sources() if x["id"] == req.source), None)
    if not row:
        raise HTTPException(404, "the REST API source no longer exists")
    path = str(r.get("path") or "")
    if ".." in path.split("?")[0]:
        raise HTTPException(400, "'..' is not allowed in a query path")
    method = str(r.get("method") or "GET").upper()
    if method not in ("GET", "POST", "PUT", "DELETE"):
        raise HTTPException(400, "HTTP JSON queries use GET, POST, PUT or DELETE")
    for k, v in (r.get("pathParams") or {}).items():
        path = path.replace("{" + k + "}", str(v))
    import webhooks

    client = webhooks.Client(row)
    base = row["config"]["domains"][0]["url"]
    url = path if path.startswith(("http://", "https://")) else base.rstrip("/") + "/" + path.lstrip("/")
    kw: dict = {"params": r.get("queryParams") or None, "headers": {str(k): str(v) for k, v in (r.get("headers") or {}).items()}, "timeout": 60}
    if r.get("bodyJson") is not None and method != "GET":
        kw["json"] = r["bodyJson"]
    try:
        resp = client.request(method, url, **kw)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, client.scrub(f"the request failed: {e}")) from None
    try:
        body: Any = resp.json()
    except ValueError:
        body = resp.text[:2_000_000]
    if resp.status_code >= 400:
        raise HTTPException(502, client.scrub(f"the source answered {resp.status_code}: {str(body)[:500]}"))
    return {"status": resp.status_code, "body": body}


# ------------------------------------------------------------------------------------------------
# user storage
# ------------------------------------------------------------------------------------------------


def _storage_path(app_id: str) -> Path:
    uid = re.sub(r"[^A-Za-z0-9_-]", "_", _me()["id"])
    return _app_dir(app_id) / "user-storage" / f"{uid}.json"


@router.get("/apps/{app_id}/user-storage")
def get_user_storage(app_id: str) -> dict:
    _access(_meta(app_id))
    return {"value": (_read_json(_storage_path(app_id)) or {}).get("value", {})}


class StorageIn(BaseModel):
    value: Any


@router.put("/apps/{app_id}/user-storage")
def put_user_storage(app_id: str, req: StorageIn) -> dict:
    _access(_meta(app_id))
    data = json.dumps(req.value)
    if len(data) > 256 * 1024:
        raise HTTPException(413, "user storage holds up to 256 KB")
    _write_json(_storage_path(app_id), {"value": req.value, "at": _now()})
    return {"value": req.value}


# ------------------------------------------------------------------------------------------------
# Marketplace packaging: a product package with the application, its dependencies and its parameters
# ------------------------------------------------------------------------------------------------

_REF = {"object_type": re.compile(r"\bot-[0-9a-f]{12}\b"), "action_type": re.compile(r"\bact-[0-9a-f]{12}\b"), "function": re.compile(r"\bfn-[0-9a-f]{12}\b"),
        "logic": re.compile(r"\blogic-[0-9a-f]{12}\b")}
PRODUCT = "bluesandai.slate.product"


def _dependencies(m: dict, doc: dict) -> dict[str, list[str]]:
    """What the document references: Ontology resources by id, datasets named in SQL (`<id>`), REST API sources."""
    text = json.dumps(doc)
    out = {k: sorted(set(rx.findall(text))) for k, rx in _REF.items()}
    sql = " ".join(str(q.get("template") or "") for q in doc.get("queries") or [] if q.get("source") == "foundry")
    out["dataset"] = sorted(set(re.findall(r"`([0-9a-f]{16})`", sql)))
    out["source"] = sorted({str(q.get("source")) for q in doc.get("queries") or [] if q.get("source") not in ("foundry", "api-gateway", None, "")})
    return out


def _dep_exists(kind: str, rid: str) -> bool:
    import ontology

    try:
        if kind == "object_type":
            ontology._object_type(rid)
        elif kind == "action_type":
            ontology._action_type(rid)
        elif kind == "logic":
            ontology._get("logic", rid, "logic function")
        elif kind == "dataset":
            return bool(db.drive_get(rid))
        elif kind == "function":
            return bool(ontology._hook("function_info", rid, None))
        return True
    except HTTPException:
        return False


def _parameters(doc: dict) -> list[dict]:
    """Marketplace parameters: local variables marked {marketplace: {type: string | boolean}}."""
    out = []
    for v in doc.get("variables") or []:
        mp = v.get("marketplace")
        if isinstance(mp, dict) and v.get("scope") != "shared":
            out.append({"name": v["name"], "type": "boolean" if mp.get("type") == "boolean" else "string", "default": v.get("default"), "description": mp.get("description") or ""})
    return out


def _packaged_doc(m: dict) -> dict:
    return _version_doc(m["id"], m.get("published") or m["latest"])["document"]


@router.get("/apps/{app_id}/lint")
def lint(app_id: str) -> dict:
    """What packaging the application needs (its dependencies) and what blocks it (references to resources that are
    gone, shared variables marked as parameters)."""
    m = _meta(app_id)
    _access(m)
    doc = _packaged_doc(m)
    deps = _dependencies(m, doc)
    errors, warnings = [], []
    for kind, ids in deps.items():
        for rid in ids:
            if kind == "source":
                warnings.append({"kind": kind, "id": rid, "message": f"the REST API source {rid} is not packaged: map it to a source at installation"})
            elif not _dep_exists(kind, rid):
                errors.append({"kind": kind, "id": rid, "message": f"the {kind.replace('_', ' ')} {rid} no longer exists: replace or remove the reference"})
    for v in doc.get("variables") or []:
        if v.get("marketplace") and v.get("scope") == "shared":
            errors.append({"kind": "parameter", "id": v["name"], "message": f"{v['name']}: only local variables can be Marketplace parameters"})
    if re.search(r"https?://[^\s\"']+\.(js|css)", json.dumps(doc)):
        warnings.append({"kind": "cdn", "id": "", "message": "libraries loaded from CDN links stay as they are: the installer's content security policy must allow them"})
    return {"dependencies": deps, "parameters": _parameters(doc), "errors": errors, "warnings": warnings, "packageable": not errors}


@router.get("/apps/{app_id}/package")
def package(app_id: str) -> dict:
    """A Marketplace product with the application: its published document (all pages), dependencies to map at
    installation and the parameters (local variables marked as Marketplace parameters)."""
    import ontology

    m = _meta(app_id)
    _access(m)
    lt = lint(app_id)
    if lt["errors"]:
        raise HTTPException(400, "fix the packaging errors first: " + "; ".join(e["message"] for e in lt["errors"][:3]))
    names = {}
    for kind, ids in lt["dependencies"].items():
        for rid in ids:
            try:
                names[rid] = (ontology._object_type(rid)["display_name"] if kind == "object_type" else ontology._action_type(rid)["display_name"] if kind == "action_type"
                              else (db.drive_get(rid) or {}).get("name") if kind == "dataset" else (ontology._hook("function_info", rid, None) or {}).get("name") if kind == "function" else rid) or rid
            except HTTPException:
                names[rid] = rid
    return {"kind": PRODUCT, "version": 1, "name": m["name"], "description": m.get("description") or "", "packaged_at": _now(), "packaged_by": _me()["id"],
            "application_version": m.get("published") or m["latest"], "document": _packaged_doc(m), "dependencies": lt["dependencies"], "names": names, "parameters": lt["parameters"]}


class InstallIn(BaseModel):
    package: dict
    folder_id: str
    name: Optional[str] = None
    # installation inputs: parameter name → value; dependency mapping: packaged id → id in this environment
    inputs: dict[str, Any] = {}
    mapping: dict[str, str] = {}


@router.post("/install")
def install(req: InstallIn) -> dict:
    """Install a packaged application: a new application in the chosen folder, its dependencies mapped (ids replaced)
    and the parameters' values as the defaults of their variables."""
    pk = req.package
    if pk.get("kind") != PRODUCT or not isinstance(pk.get("document"), dict):
        raise HTTPException(400, "not a Slate product package")
    text = json.dumps(pk["document"])
    for src, dst in req.mapping.items():
        if dst and re.fullmatch(r"[A-Za-z0-9_.-]+", src) and re.fullmatch(r"[A-Za-z0-9_.-]+", dst):
            text = re.sub(rf"(?<![A-Za-z0-9_-]){re.escape(src)}(?![A-Za-z0-9_-])", dst, text)
    doc = json.loads(text)
    missing = [f"{k} {pk.get('names', {}).get(rid) or rid}" for k, ids in (pk.get("dependencies") or {}).items() for rid in ids
               if k in ("object_type", "action_type", "logic", "dataset", "function") and not _dep_exists(k, req.mapping.get(rid) or rid)]
    if missing:
        raise HTTPException(400, "map these dependencies to resources here: " + ", ".join(missing[:6]))
    params = {p["name"]: p for p in pk.get("parameters") or []}
    for v in doc.get("variables") or []:
        if v["name"] in params and v["name"] in req.inputs:
            val = req.inputs[v["name"]]
            v["default"] = json.dumps((str(val).lower() in ("true", "1", "yes")) if params[v["name"]]["type"] == "boolean" else str(val))
    app = _create(AppIn(name=(req.name or pk.get("name") or "Installed application").strip(), folder_id=req.folder_id, description=pk.get("description") or "", document=doc))
    with _lock:
        m = _meta(app["app"]["id"] if "app" in app else app["id"])
        m["installed_from"] = {"name": pk.get("name"), "packaged_at": pk.get("packaged_at"), "application_version": pk.get("application_version")}
        _save_meta(m)
    return get_app(m["id"])


# ------------------------------------------------------------------------------------------------
# shareable views
# ------------------------------------------------------------------------------------------------


class ViewIn(BaseModel):
    # {widgets: {<widget id>: {<interaction property>: value}}, variables: {<local variable>: value}}
    state: dict


@router.post("/apps/{app_id}/views")
def save_view(app_id: str, req: ViewIn) -> dict:
    """Save the application's current state (widget interaction properties, local variables) as a shareable view:
    anyone who can open the application loads it by its id (`?view=<id>`), on any version of the application."""
    _access(_meta(app_id))
    data = json.dumps(req.state)
    if len(data) > 512 * 1024:
        raise HTTPException(413, "a shareable view holds up to 512 KB")
    vid = "view-" + secrets.token_urlsafe(9)
    _write_json(_app_dir(app_id) / "views" / f"{vid}.json", {"id": vid, "state": req.state, "created_at": _now(), "created_by": _me()["id"]})
    return {"id": vid}


@router.get("/apps/{app_id}/views/{view_id}")
def get_view(app_id: str, view_id: str) -> dict:
    _access(_meta(app_id))
    if not re.fullmatch(r"view-[A-Za-z0-9_-]{6,40}", view_id):
        raise HTTPException(404, "view not found")
    v = _read_json(_app_dir(app_id) / "views" / f"{view_id}.json")
    if not v:
        raise HTTPException(404, "view not found")
    return v


# ------------------------------------------------------------------------------------------------
# public applications and secure upload
# ------------------------------------------------------------------------------------------------


@router.get("/public/apps/{permalink}")
def public_app(permalink: str) -> dict:
    """A public application's published version, for anyone with the link (no sign-in)."""
    m = next((x for x in _all() if x.get("permalink") == permalink and x.get("type") == "public"), None)
    item = db.drive_get(m["item_id"]) if m else None
    if not m or not item or item.get("trashed_at") or not m.get("published"):
        raise HTTPException(404, "no published public application at this link")
    v = _version_doc(m["id"], int(m["published"]))
    return {"app": {k: m.get(k) for k in ("id", "name", "permalink", "type")}, "version": m["published"], "document": v["document"]}


class ChannelIn(BaseModel):
    channel_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,80}$")
    # the Files folder uploaded blobs land in (one JSON file each)
    folder_id: str
    max_blob_size: int = Field(1_000_000, ge=1, le=10_000_000)


@router.put("/apps/{app_id}/upload-channels")
def put_channel(app_id: str, req: ChannelIn) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        if m.get("type") != "public":
            raise HTTPException(400, "secure upload is for public applications")
        folder = drive._item(req.folder_id, need="editor")
        if folder["kind"] not in ("project", "folder"):
            raise HTTPException(400, "uploads land in a folder")
        m.setdefault("channels", {})[req.channel_id] = {"folder_id": folder["id"], "max_blob_size": req.max_blob_size, "created_at": _now(),
                                                        "created_by": _me()["id"]}
        _save_meta(m)
    return {"channelId": req.channel_id, **m["channels"][req.channel_id]}


class TokenIn(BaseModel):
    channel: str
    expiry: str
    count: int = Field(1, ge=1, le=1_000_000)


@router.post("/apps/{app_id}/upload-tokens")
def create_token(app_id: str, req: TokenIn) -> dict:
    with _lock:
        m = _meta(app_id)
        _access(m, "editor")
        if req.channel not in (m.get("channels") or {}):
            raise HTTPException(404, f"no channel {req.channel}")
        try:
            exp = datetime.fromisoformat(req.expiry.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, "expiry is an ISO-8601 time") from None
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            raise HTTPException(422, "the expiry is in the past")
        if (exp - datetime.now(timezone.utc)).days > 366:
            raise HTTPException(422, "tokens expire within a year")
        token = "slup_" + secrets.token_urlsafe(24)
        m.setdefault("tokens", {})[token] = {"channel": req.channel, "expiry": exp.isoformat(timespec="seconds"), "remaining": req.count,
                                             "created_at": _now()}
        _save_meta(m)
    return {"token": token, "expiry": m["tokens"][token]["expiry"], "count": req.count}


class BlobIn(BaseModel):
    data: Any


@router.post("/public/upload/{token}")
def public_upload(token: str, req: BlobIn) -> dict:
    """An anonymous upload from a public application: one JSON blob into the token's channel folder."""
    with _lock:
        m = next((x for x in _all() if token in (x.get("tokens") or {})), None)
        if not m:
            raise HTTPException(403, "unknown upload token")
        t = m["tokens"][token]
        if datetime.fromisoformat(t["expiry"]) <= datetime.now(timezone.utc):
            raise HTTPException(403, "the upload token expired")
        if t["remaining"] <= 0:
            raise HTTPException(403, "the upload token was used up")
        ch = (m.get("channels") or {}).get(t["channel"])
        if not ch:
            raise HTTPException(403, "the channel was removed")
        data = json.dumps(req.data, ensure_ascii=False).encode()
        if len(data) > ch["max_blob_size"]:
            raise HTTPException(413, f"blobs on this channel are limited to {ch['max_blob_size']} bytes")
        t["remaining"] -= 1
        _save_meta(m)
    name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}.json"
    item = drive._store(ch["folder_id"], name, io.BytesIO(data), len(data), "application/json")
    return {"stored": item["id"], "name": name, "remaining": t["remaining"]}
