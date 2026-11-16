"""Custom widgets (Application Building → Custom widgets): widget sets of custom frontend code embedded in Workshop.

A widget set is a Files item (`<name>.widgetset`, application/vnd.bluesandai.widget-set+json) in a Project, whose
roles govern it (viewers use its widgets, editors release versions). A release is a production build: the files of
a .zip upload (`.palantir/widgets.config.json` names the version and each widget's entrypoint, parameters, events
and requested permissions) or widgets written in the platform's editor (one HTML / CSS / JavaScript source each).
Releases are immutable; Workshop modules pin a version.

Widgets run in iframes with an opaque origin (sandbox without allow-same-origin): they reach no platform API and no
cookie. Their files are served from signed, expiring URLs (/api/widget-assets/<token>/<path>, no sign-in), and they
talk to the host through postMessage with the widget client (/api/widget-assets/<token>/__bluesandai/widget-client.js,
`window.BluesandaiWidget`): parameters in, events out, and Ontology calls the host makes for them with the viewer's
permissions — only to the resources configured for the widget set, and only once Ontology APIs are enabled
(administrators: the Information Security Officer role).

Dev mode is per user and expires after 24 hours: the user's widgets load from their development server's URL.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/widget-sets", tags=["custom-widgets"])
assets = APIRouter(prefix="/api/widget-assets", tags=["custom-widgets"])
SET_TYPE = "application/vnd.bluesandai.widget-set+json"
DIR = Path("data/widget-sets")
RID = "ri.widgetregistry..widget-set."
MAX_ZIP = 50 * 1024 * 1024
MAX_WIDGETS = 50
MAX_PARAMS = 50
PARAM_TYPES = {"boolean", "date", "number", "string", "timestamp", "objectSet", "scenario", "array"}
SUB_TYPES = {"boolean", "date", "number", "string", "timestamp"}
PERMISSIONS = {"camera", "microphone", "autoplay", "allow-downloads", "allow-forms", "allow-popups"}
CAMEL = re.compile(r"^[a-z][A-Za-z0-9]*$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "widget-sets"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "local"


def _secret() -> bytes:
    p = DIR / ".secret"
    if not p.exists():
        DIR.mkdir(parents=True, exist_ok=True)
        p.write_bytes(secrets.token_bytes(32))
    return p.read_bytes()


def _dir(set_id: str) -> Path:
    if not re.fullmatch(r"ws-[0-9a-f]{12}", set_id):
        raise HTTPException(404, "widget set not found")
    return DIR / set_id


def _read(p: Path) -> Optional[dict]:
    try:
        return json.loads(p.read_text("utf-8"))
    except FileNotFoundError:
        return None


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


def _meta(set_id: str) -> dict:
    m = _read(_dir(set_id) / "meta.json")
    if not m:
        raise HTTPException(404, "widget set not found")
    return m


def _save(m: dict) -> None:
    _write(_dir(m["id"]) / "meta.json", m)


def _access(m: dict, need: str = "viewer") -> dict:
    return drive._item(m["item_id"], need=need)


def _all() -> list[dict]:
    return [m for p in DIR.glob("ws-*/meta.json") if (m := _read(p))] if DIR.exists() else []


def _vkey(v: str) -> tuple:
    core, _, pre = v.partition("-")
    return (*[int(x) for x in core.split(".")], pre == "", pre)


def _summary(m: dict) -> dict:
    rel = sorted(m.get("releases") or [], key=lambda r: _vkey(r["version"]), reverse=True)
    return {k: m.get(k) for k in ("id", "rid", "name", "description", "item_id", "created_at", "created_by", "osdk", "installed_from")} | {
        "latest": rel[0]["version"] if rel else None, "versions": [r["version"] for r in rel],
        "widgets": sorted({w for r in rel[:1] for w in r["manifest"]["widgets"]}),
    }


# ------------------------------------------------------------------------------------------------
# manifests
# ------------------------------------------------------------------------------------------------


def check_manifest(man: Any, files: set[str]) -> dict:
    """A widgets.config.json manifest, normalized: {version, widgets: {id: {id, name, description, type, entrypointJs,
    entrypointCss, html, parameters, events, permissions, refreshHostDataOnAction}}}."""
    if not isinstance(man, dict) or not isinstance(man.get("widgets"), dict):
        raise HTTPException(422, ".palantir/widgets.config.json needs a widgets object")
    version = str(man.get("version") or "")
    if not SEMVER.match(version):
        raise HTTPException(422, f"the manifest version {version!r} is not a semantic version (x.y.z)")
    if not man["widgets"]:
        raise HTTPException(422, "the manifest has no widgets")
    if len(man["widgets"]) > MAX_WIDGETS:
        raise HTTPException(422, f"a widget set holds at most {MAX_WIDGETS} widgets")
    out: dict = {}
    for wid, w in man["widgets"].items():
        if not CAMEL.match(str(wid)) and not re.fullmatch(r"[A-Za-z][\w-]*", str(wid)):
            raise HTTPException(422, f"widget id {wid!r} is not valid")
        if not isinstance(w, dict):
            raise HTTPException(422, f"widget {wid} is not an object")
        params = w.get("parameters") or {}
        events = w.get("events") or {}
        if len(params) > MAX_PARAMS or len(events) > MAX_PARAMS:
            raise HTTPException(422, f"widget {wid}: at most {MAX_PARAMS} parameters and {MAX_PARAMS} events")
        for pid, p in params.items():
            if not CAMEL.match(pid):
                raise HTTPException(422, f"widget {wid}: parameter id {pid} must be camelCase")
            t = (p or {}).get("type")
            if t not in PARAM_TYPES:
                raise HTTPException(422, f"widget {wid}: parameter {pid} has the unsupported type {t!r}")
            if t == "array" and (p.get("subType") not in SUB_TYPES):
                raise HTTPException(422, f"widget {wid}: array parameter {pid} needs a primitive subType")
        for eid, e in events.items():
            if not CAMEL.match(eid):
                raise HTTPException(422, f"widget {wid}: event id {eid} must be camelCase")
            bad = [x for x in (e or {}).get("parameterUpdateIds") or [] if x not in params]
            if bad:
                raise HTTPException(422, f"widget {wid}: event {eid} updates unknown parameters {', '.join(bad)}")
        perms = [str(x) for x in w.get("permissions") or []]
        if set(perms) - PERMISSIONS:
            raise HTTPException(422, f"widget {wid}: unknown permissions {', '.join(sorted(set(perms) - PERMISSIONS))}")
        js = [x["path"] if isinstance(x, dict) else str(x) for x in w.get("entrypointJs") or []]
        css = [x["path"] if isinstance(x, dict) else str(x) for x in w.get("entrypointCss") or []]
        html = w.get("html") or w.get("entrypoint") or ("index.html" if not js and "index.html" in files else None)
        for f in [*js, *css, *([html] if html else [])]:
            if f.lstrip("/") not in files:
                raise HTTPException(422, f"widget {wid}: the entrypoint {f} is not in the release")
        if not js and not html:
            raise HTTPException(422, f"widget {wid} has no entrypoint (entrypointJs or an html file)")
        out[wid] = {"id": wid, "name": w.get("name") or wid, "description": w.get("description") or "", "type": w.get("type") or "workshop",
                    "entrypointJs": [x.lstrip("/") for x in js], "entrypointCss": [x.lstrip("/") for x in css], "html": html.lstrip("/") if html else None,
                    "parameters": params, "events": events, "permissions": perms, "refreshHostDataOnAction": bool(w.get("refreshHostDataOnAction", True))}
    return {"version": version, "widgets": out}


# iframe permissions a release turns on that a checkpoint can ask about (checkpoints.py)
PERMISSION_CHECKPOINTS = {"allow-downloads": "custom_widgets_allow_downloads", "camera": "custom_widgets_enable_camera",
                          "microphone": "custom_widgets_enable_microphone"}


def _permission_checkpoints(m: dict, manifest: dict) -> None:
    """Enabling allow-downloads, camera or microphone (a release whose widgets ask for it when no earlier release of
    the set did) passes the matching checkpoints first."""
    import checkpoints

    before = {p for r in m.get("releases") or [] for w in (r.get("manifest") or {}).get("widgets", {}).values() for p in w.get("permissions") or []}
    for perm, ctype in PERMISSION_CHECKPOINTS.items():
        widgets = sorted(w["id"] for w in manifest["widgets"].values() if perm in (w.get("permissions") or []))
        if widgets and perm not in before:
            checkpoints.gate(ctype, checkpoints._ctx([{"type": "widget-set", "id": m["id"], "name": m.get("name")}],
                                                     detail=f"{perm} for {', '.join(widgets)}"))


def _store_release(m: dict, manifest: dict, files: dict[str, bytes], source: str, sources: Optional[dict] = None) -> dict:
    v = manifest["version"]
    if any(r["version"] == v for r in m.get("releases") or []):
        raise HTTPException(409, f"version {v} is already released (releases cannot change: bump the version)")
    _permission_checkpoints(m, manifest)
    base = _dir(m["id"]) / "releases" / v
    for path, data in files.items():
        target = base / "files" / PurePosixPath(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    rel = {"version": v, "manifest": manifest, "files": sorted(files), "size": sum(len(x) for x in files.values()), "source": source,
           "released_at": _now(), "released_by": _me(), **({"sources": sources} if sources else {})}
    m.setdefault("releases", []).append(rel)
    return rel


def _safe_path(name: str) -> Optional[str]:
    p = PurePosixPath(name.replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts or not p.parts:
        return None
    return str(p)


# ------------------------------------------------------------------------------------------------
# widget sets
# ------------------------------------------------------------------------------------------------


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    description: str = Field("", max_length=2000)


@router.get("")
def list_sets() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (SET_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"]: i for i in auth.visible(items)}
    return sorted((_summary(m) | {"path": drive._with_path(visible[m["item_id"]]).get("path")} for m in _all() if m["item_id"] in visible),
                  key=lambda s: s.get("created_at") or "", reverse=True)


@router.post("")
def create_set(req: SetIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "create the widget set in a Project or a folder")
    with _lock:
        hexid = uuid.uuid4().hex[:12]
        set_id = f"ws-{hexid}"
        name = req.name.strip()
        body = json.dumps({"widget_set_id": set_id}).encode()
        item = drive._store(folder["id"], drive._clean_name(name if name.endswith(".widgetset") else f"{name}.widgetset"), io.BytesIO(body), len(body), SET_TYPE)
        m = {"id": set_id, "rid": RID + hexid, "name": name.removesuffix(".widgetset"), "description": req.description, "item_id": item["id"],
             "created_at": _now(), "created_by": _me(), "releases": [], "drafts": {},
             "osdk": {"object_types": [], "action_types": [], "functions": [], "ontology_apis": False}, "dev": {}}
        _save(m)
    return get_set(set_id)


@router.get("/{set_id}")
def get_set(set_id: str) -> dict:
    m = _meta(set_id)
    item = _access(m)
    try:
        _access(m, "editor")
        editor = True
    except HTTPException:
        editor = False
    rel = sorted(m.get("releases") or [], key=lambda r: _vkey(r["version"]), reverse=True)
    dev = (m.get("dev") or {}).get(_me())
    if dev and datetime.fromisoformat(dev["expires"]) < datetime.now(timezone.utc):
        dev = None
    return {**_summary(m), "path": drive._with_path(item).get("path"), "can_edit": editor, "releases": rel,
            "drafts": m.get("drafts") or {} if editor else {}, "dev": dev}


@router.delete("/{set_id}")
def delete_set(set_id: str) -> dict:
    m = _meta(set_id)
    drive.trash(_access(m, "editor")["id"])
    return {"trashed": set_id}


@router.post("/{set_id}/releases/upload")
async def upload_release(set_id: str, file: UploadFile = File(...)) -> dict:
    """A production build as a .zip (no extra top folder): .palantir/widgets.config.json, index.html, assets/…"""
    m = _meta(set_id)
    _access(m, "editor")
    data = await file.read()
    if len(data) > MAX_ZIP:
        raise HTTPException(413, f"releases are limited to {MAX_ZIP // 1024 // 1024} MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(422, "not a .zip archive") from None
    files: dict[str, bytes] = {}
    for info in zf.infolist():
        if info.is_dir():
            continue
        p = _safe_path(info.filename)
        if not p:
            raise HTTPException(422, f"unsafe path in the archive: {info.filename}")
        files[p] = zf.read(info)
    if ".palantir/widgets.config.json" not in files:
        tops = {p.split("/")[0] for p in files}
        hint = f" (the archive has a top folder {next(iter(tops))}/: zip the build's contents, not the folder)" if len(tops) == 1 else ""
        raise HTTPException(422, f"the release has no .palantir/widgets.config.json manifest{hint}")
    try:
        manifest = check_manifest(json.loads(files[".palantir/widgets.config.json"]), set(files))
    except ValueError:
        raise HTTPException(422, "the manifest is not valid JSON") from None
    with _lock:
        m = _meta(set_id)
        rel = _store_release(m, manifest, files, "upload")
        _save(m)
    return rel


class SourceWidget(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    html: str = Field("", max_length=500_000)
    css: str = Field("", max_length=500_000)
    js: str = Field("", max_length=2_000_000)
    parameters: dict[str, dict] = Field(default_factory=dict)
    events: dict[str, dict] = Field(default_factory=dict)
    permissions: list[str] = Field(default_factory=list)


class DraftIn(BaseModel):
    widgets: dict[str, SourceWidget]


@router.put("/{set_id}/drafts")
def save_drafts(set_id: str, req: DraftIn) -> dict:
    """The widgets written in the platform's editor (unreleased)."""
    with _lock:
        m = _meta(set_id)
        _access(m, "editor")
        m["drafts"] = {k: v.model_dump() for k, v in req.widgets.items()}
        _save(m)
    return {"drafts": m["drafts"]}


class ReleaseIn(BaseModel):
    version: str = Field(pattern=SEMVER.pattern)


def _page(w: dict) -> str:
    return (f"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{w['name']}</title><link rel=\"stylesheet\" href=\"index.css\"></head><body>{w['html']}"
            "<script src=\"index.js\"></script></body></html>")


@router.post("/{set_id}/releases")
def release_drafts(set_id: str, req: ReleaseIn) -> dict:
    """Release the editor's widgets as a version (each widget: <id>/index.html, index.css, index.js)."""
    with _lock:
        m = _meta(set_id)
        _access(m, "editor")
        drafts = m.get("drafts") or {}
        if not drafts:
            raise HTTPException(400, "write a widget first (or upload a .zip release)")
        files: dict[str, bytes] = {}
        widgets = {}
        for wid, w in drafts.items():
            files[f"{wid}/index.html"] = _page(w).encode()
            files[f"{wid}/index.css"] = w["css"].encode()
            files[f"{wid}/index.js"] = w["js"].encode()
            widgets[wid] = {"name": w["name"], "description": w["description"], "type": "workshop", "html": f"{wid}/index.html", "parameters": w["parameters"],
                            "events": w["events"], "permissions": w["permissions"]}
        raw = {"version": req.version, "widgets": widgets}
        manifest = check_manifest(raw, set(files))
        files[".palantir/widgets.config.json"] = json.dumps(raw, indent=1).encode()
        rel = _store_release(m, manifest, files, "editor", sources=drafts)
        _save(m)
    return rel


class OsdkIn(BaseModel):
    object_types: list[str] = Field(default_factory=list)
    action_types: list[str] = Field(default_factory=list)
    functions: list[str] = Field(default_factory=list)


PRODUCT = "bluesandai.widget-set.product"


@router.get("/{set_id}/package")
def package(set_id: str, version: Optional[str] = None) -> dict:
    """A Marketplace product with the widget set: one release (the latest, or `version`) with its files, the manifest
    and the Ontology resources of its SDK (to map at installation)."""
    import ontology

    m = _meta(set_id)
    _access(m)
    rels = m.get("releases") or []
    if not rels:
        raise HTTPException(400, "release a version first: a product packages a released widget set")
    rel = next((r for r in rels if r["version"] == version), None) if version else max(rels, key=lambda r: _vkey(r["version"]))
    if not rel:
        raise HTTPException(404, f"version {version} not found")
    base = _dir(set_id) / "releases" / rel["version"] / "files"
    files = {p: base64.b64encode((base / PurePosixPath(p)).read_bytes()).decode() for p in rel["files"]}
    o = m.get("osdk") or {}
    deps = {"object_type": list(o.get("object_types") or []), "action_type": list(o.get("action_types") or []), "function": list(o.get("functions") or [])}
    names, errors = {}, []
    for kind, ids in deps.items():
        for rid in ids:
            try:
                names[rid] = ontology._object_type(rid)["display_name"] if kind == "object_type" else ontology._action_type(rid)["display_name"] if kind == "action_type" else rid
            except HTTPException:
                errors.append(f"the {kind.replace('_', ' ')} {rid} no longer exists")
    if errors:
        raise HTTPException(400, "fix the SDK resources first: " + "; ".join(errors[:3]))
    return {"kind": PRODUCT, "version": 1, "name": m["name"], "description": m.get("description") or "", "packaged_at": _now(), "packaged_by": _me(),
            "release": {"version": rel["version"], "manifest": rel["manifest"], "files": files}, "dependencies": deps, "names": names,
            "ontology_apis": bool(o.get("ontology_apis"))}


class InstallIn(BaseModel):
    package: dict
    folder_id: str
    name: Optional[str] = None
    # dependency mapping: packaged id → id in this environment
    mapping: dict[str, str] = {}


@router.post("/install")
def install(req: InstallIn) -> dict:
    """Install a packaged widget set: a new widget set in the chosen folder with the packaged release and its SDK
    resources mapped to resources here. Ontology APIs stay off until an administrator enables them."""
    import ontology

    pk = req.package
    rel = pk.get("release") or {}
    if pk.get("kind") != PRODUCT or not isinstance(rel.get("files"), dict) or not isinstance(rel.get("manifest"), dict):
        raise HTTPException(400, "not a widget set product package")
    files: dict[str, bytes] = {}
    for name, data in rel["files"].items():
        p = _safe_path(name)
        if not p:
            raise HTTPException(422, f"unsafe path in the package: {name}")
        try:
            files[p] = base64.b64decode(data, validate=True)
        except Exception:  # noqa: BLE001
            raise HTTPException(422, f"{name}: not base64") from None
    if sum(len(x) for x in files.values()) > MAX_ZIP:
        raise HTTPException(413, f"releases are limited to {MAX_ZIP // 1024 // 1024} MB")
    manifest = check_manifest(rel["manifest"], set(files))
    mapped: dict[str, list[str]] = {}
    missing = []
    for kind, key in (("object_type", "object_types"), ("action_type", "action_types"), ("function", "functions")):
        out = []
        for rid in (pk.get("dependencies") or {}).get(kind) or []:
            dst = req.mapping.get(rid) or rid
            try:
                if kind == "object_type":
                    ontology._object_type(dst)
                elif kind == "action_type":
                    ontology._action_type(dst)
                out.append(dst)
            except HTTPException:
                missing.append(f"{kind.replace('_', ' ')} {(pk.get('names') or {}).get(rid) or rid}")
        mapped[key] = out
    if missing:
        raise HTTPException(400, "map these dependencies to resources here: " + ", ".join(missing[:6]))
    created = create_set(SetIn(name=(req.name or pk.get("name") or "Installed widget set").strip(), folder_id=req.folder_id, description=pk.get("description") or ""))
    with _lock:
        m = _meta(created["id"])
        _store_release(m, manifest, files, "marketplace")
        m["osdk"] = {**m["osdk"], **mapped, "ontology_apis": False}
        m["installed_from"] = {"name": pk.get("name"), "packaged_at": pk.get("packaged_at"), "version": rel.get("version")}
        _save(m)
    return get_set(m["id"])


@router.put("/{set_id}/osdk")
def configure_osdk(set_id: str, req: OsdkIn) -> dict:
    """The Ontology resources the widget set's OSDK reaches (Configure SDK)."""
    with _lock:
        m = _meta(set_id)
        _access(m, "editor")
        import ontology

        for t in req.object_types:
            ontology._object_type(t)
        m["osdk"] = {**(m.get("osdk") or {}), "object_types": req.object_types, "action_types": req.action_types, "functions": req.functions}
        _save(m)
    return m["osdk"]


class ApisIn(BaseModel):
    enabled: bool


@router.put("/{set_id}/ontology-apis")
def ontology_apis(set_id: str, req: ApisIn) -> dict:
    """Enable Ontology APIs for the widget set: administrators (the Information Security Officer role)."""
    auth.require_admin()
    with _lock:
        m = _meta(set_id)
        m.setdefault("osdk", {})["ontology_apis"] = req.enabled
        m["osdk"]["enabled_by"] = _me()
        _save(m)
    return m["osdk"]


class DevIn(BaseModel):
    # the development server, e.g. http://localhost:5173 (its widget entrypoints by widget id, else /<id>.html)
    url: Optional[str] = Field(None, pattern=r"^https?://[^\s]+$")
    paused: bool = False


@router.put("/{set_id}/dev")
def dev_mode(set_id: str, req: DevIn) -> dict:
    """Start, pause or stop dev mode for the caller (expires after 24 hours; other users keep the published version)."""
    with _lock:
        m = _meta(set_id)
        _access(m, "editor")
        dev = m.setdefault("dev", {})
        if not req.url:
            dev.pop(_me(), None)
        else:
            dev[_me()] = {"url": req.url.rstrip("/"), "paused": req.paused, "started_at": _now(),
                          "expires": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(timespec="seconds")}
        _save(m)
    return {"dev": dev.get(_me())}


# ------------------------------------------------------------------------------------------------
# loading a widget (host side) and its signed assets
# ------------------------------------------------------------------------------------------------


def _sign(set_id: str, version: str, hours: int = 12) -> str:
    payload = f"{set_id}|{version}|{int(time.time()) + hours * 3600}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()[:18]
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=") + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def _verify(token: str) -> tuple[str, str]:
    try:
        p, s = token.split(".")
        payload = base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)).decode()
        sig = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except Exception:  # noqa: BLE001
        raise HTTPException(403, "invalid widget asset link") from None
    if not hmac.compare_digest(sig, hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()[:18]):
        raise HTTPException(403, "invalid widget asset link")
    set_id, version, exp = payload.split("|")
    if int(exp) < time.time():
        raise HTTPException(403, "the widget asset link expired: reload the page")
    return set_id, version


@router.get("/{set_id}/load")
def load_widget(set_id: str, widget: str, version: Optional[str] = None) -> dict:
    """What a host needs to render a widget: its manifest entry, the signed URL of its document, the requested
    permissions, the OSDK resources; with dev mode on for the caller, the development server's URL instead."""
    m = _meta(set_id)
    _access(m)
    rel = sorted(m.get("releases") or [], key=lambda r: _vkey(r["version"]), reverse=True)
    r = next((x for x in rel if x["version"] == version), None) if version else (rel[0] if rel else None)
    if not r:
        raise HTTPException(404, f"no release {version or ''} of {m['name']}".replace("  ", " "))
    w = r["manifest"]["widgets"].get(widget)
    if not w:
        raise HTTPException(404, f"no widget {widget} in {m['name']} {r['version']}")
    token = _sign(set_id, r["version"])
    base = f"/api/widget-assets/{token}/"
    doc = base + (w["html"] if w["html"] else f"__bluesandai/entry/{widget}.html")
    dev = (m.get("dev") or {}).get(_me())
    if dev and (dev.get("paused") or datetime.fromisoformat(dev["expires"]) < datetime.now(timezone.utc)):
        dev = {**dev, "active": False}
    elif dev:
        dev = {**dev, "active": True, "document": f"{dev['url']}/{widget}.html"}
    return {"widget_set": {"id": m["id"], "rid": m["rid"], "name": m["name"]}, "version": r["version"], "widget": w, "document": doc, "dev": dev,
            "osdk": m.get("osdk") or {}}


CLIENT_JS = r"""/* BluesandAI widget client: the host bridge for custom widgets (parameters, events, Ontology calls). */
(function () {
  var listeners = [], pending = {}, seq = 0;
  var api = {
    parameters: { values: {}, state: "loading" },
    onParameters: function (cb) { listeners.push(cb); if (api.parameters.state === "loaded") cb(api.parameters.values); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; },
    emitEvent: function (eventId, payload) { parent.postMessage({ __bsaiWidget: true, type: "emitEvent", eventId: eventId, parameterUpdates: (payload && payload.parameterUpdates) || {} }, "*"); },
    request: function (op, args) {
      return new Promise(function (resolve, reject) { var id = ++seq; pending[id] = [resolve, reject]; parent.postMessage({ __bsaiWidget: true, type: "osdk", id: id, op: op, args: args || {} }, "*"); });
    },
    osdk: {
      currentUser: function () { return api.request("currentUser"); },
      objects: function (objectType, opts) { return api.request("objects", Object.assign({ objectType: objectType }, opts || {})); },
      object: function (objectType, primaryKey) { return api.request("object", { objectType: objectType, primaryKey: primaryKey }); },
      objectSet: function (param) { return api.request("objectSet", { objectSet: param }); },
      applyAction: function (actionType, parameters) { return api.request("applyAction", { actionType: actionType, parameters: parameters }); },
      executeFunction: function (fn, inputs) { return api.request("executeFunction", { function: fn, inputs: inputs }); }
    }
  };
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.__bsaiHost) return;
    if (d.type === "parameters") { api.parameters = { values: d.values || {}, state: "loaded" }; listeners.forEach(function (cb) { try { cb(api.parameters.values); } catch (err) { console.error(err); } }); }
    if (d.type === "osdkResult" && pending[d.id]) { var p = pending[d.id]; delete pending[d.id]; d.ok ? p[0](d.data) : p[1](new Error(d.error)); }
  });
  try { localStorage; } catch (e) { /* no persistent browser storage in widgets */ }
  function size() { parent.postMessage({ __bsaiWidget: true, type: "resize", height: document.body.scrollHeight, width: document.body.scrollWidth }, "*"); }
  window.addEventListener("load", function () { size(); if (window.ResizeObserver) new ResizeObserver(size).observe(document.body); parent.postMessage({ __bsaiWidget: true, type: "ready" }, "*"); });
  window.BluesandaiWidget = api;
})();
"""

CSP = ("default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src blob: 'self'; frame-ancestors *")


@assets.get("/{token}/{path:path}")
def asset(token: str, path: str) -> Response:
    """A release's file for its widget iframe (signed link, no sign-in; a restrictive content security policy)."""
    set_id, version = _verify(token)
    # module scripts from an opaque-origin document are CORS requests; the link itself is the credential
    headers = {"Content-Security-Policy": CSP, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*"}
    if path == "__bluesandai/widget-client.js":
        return Response(CLIENT_JS, media_type="text/javascript", headers=headers)
    m = _meta(set_id)
    rel = next((r for r in m.get("releases") or [] if r["version"] == version), None)
    if not rel:
        raise HTTPException(404, "release not found")
    entry = re.fullmatch(r"__bluesandai/entry/(.+)\.html", path)
    if entry:
        # a bundle widget without its own html: a page loading its entrypoint scripts and styles
        w = rel["manifest"]["widgets"].get(entry.group(1))
        if not w:
            raise HTTPException(404, "widget not found")
        up = "../../"
        page = ("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                "<meta name=\"color-scheme\" content=\"light dark\">"
                + "".join(f'<link rel="stylesheet" href="{up}{c}">' for c in w["entrypointCss"])
                + f'</head><body><div id="root"></div><script src="{up}__bluesandai/widget-client.js"></script>'
                + "".join(f'<script type="module" src="{up}{j}"></script>' for j in w["entrypointJs"]) + "</body></html>")
        return Response(page, media_type="text/html", headers=headers)
    p = _safe_path(path)
    if not p or p not in rel["files"]:
        raise HTTPException(404, "file not found")
    data = (_dir(set_id) / "releases" / version / "files" / PurePosixPath(p)).read_bytes()
    if p.endswith(".html"):
        # every widget document gets the host bridge before its own scripts
        text = data.decode("utf-8", errors="replace")
        depth = "../" * p.count("/")
        # the widget client, and the host's color scheme for the iframe's canvas (prefers-color-scheme follows it)
        tag = f'<meta name="color-scheme" content="light dark"><script src="{depth}__bluesandai/widget-client.js"></script>'
        if "widget-client.js" not in text:
            text = re.sub(r"(<head[^>]*>)", r"\1" + tag, text, count=1, flags=re.I) if re.search(r"<head[^>]*>", text, re.I) else tag + text
        data = text.encode()
    mt = mimetypes.guess_type(p)[0] or "application/octet-stream"
    if p.endswith(".js") or p.endswith(".mjs"):
        mt = "text/javascript"
    return Response(data, media_type=mt, headers=headers)


# ------------------------------------------------------------------------------------------------
# the host's Ontology calls for a widget (only configured resources, only with Ontology APIs enabled)
# ------------------------------------------------------------------------------------------------


class OsdkCall(BaseModel):
    op: Literal["currentUser", "objects", "object", "objectSet", "applyAction", "executeFunction"]
    args: dict = Field(default_factory=dict)


@router.post("/{set_id}/osdk-call")
def osdk_call(set_id: str, req: OsdkCall) -> Any:
    m = _meta(set_id)
    _access(m)
    o = m.get("osdk") or {}
    a = req.args
    if req.op == "currentUser":
        u = auth.current() or {}
        return {"id": u.get("id"), "username": u.get("username"), "displayName": u.get("display_name"), "email": u.get("email")}
    if not o.get("ontology_apis"):
        raise HTTPException(403, "Ontology APIs are not enabled for this widget set (an administrator enables them on its page)")
    import ontology
    import workshop

    def allowed(kind: str, rid: str) -> None:
        if rid not in (o.get(kind) or []):
            raise HTTPException(403, f"{rid} is not among the widget set's SDK resources (Configure SDK)")

    # a scenario parameter's value (a scenario id, or {scenarioId}): reads and actions happen in that scenario
    sc = a.get("scenario")
    sid = str((sc.get("scenarioId") or sc.get("id") or "") if isinstance(sc, dict) else sc or "") or None
    if req.op in ("objects", "object", "objectSet"):
        spec = a.get("objectSet") if req.op == "objectSet" else a
        if req.op == "objectSet":
            spec = spec or {}
        tid = str(spec.get("objectType") or spec.get("object_type_id") or "")
        allowed("object_types", tid)
        if req.op == "object":
            if sid:
                import ontology_scenarios

                with ontology_scenarios.active(sid):
                    return ontology.get_object(tid, str(a.get("primaryKey")))
            return ontology.get_object(tid, str(a.get("primaryKey")))
        filters = spec.get("filters") or []
        q = workshop.Query(source=workshop.Source(kind="object_type", id=tid), filters=filters, filter_mode=spec.get("filterMode") or "all", columns=[],
                           sort=spec.get("orderBy"), descending=bool(spec.get("descending")), limit=min(int(spec.get("pageSize") or a.get("pageSize") or 100), 1000),
                           scenario_id=sid)
        r = workshop.query(q)
        return {"data": r.get("rows") or [], "totalCount": r.get("total")}
    if req.op == "applyAction":
        allowed("action_types", str(a.get("actionType")))
        if sid:
            import ontology_scenarios

            return ontology_scenarios.apply_in_scenario(sid, str(a["actionType"]), ontology_scenarios.ApplyIn(parameters=a.get("parameters") or {}))
        return ontology.apply_action(str(a["actionType"]), ontology.ApplyAction(parameters=a.get("parameters") or {}))
    if req.op == "executeFunction":
        allowed("functions", str(a.get("function")))
        import functions_registry

        return functions_registry.execute(str(a["function"]), a.get("inputs") or {}, None, "custom-widget")
    raise HTTPException(400, "unknown call")
