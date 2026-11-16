"""Carbon (Application Building → Carbon): curated workspaces for operational users.

A workspace is a Files item (`<name>.carbon`, application/vnd.bluesandai.carbon+json) in a Project, whose roles
govern it (viewers open it, editors configure it). Its configuration follows Carbon's YAML model:
- displayMetadata: title, description;
- general: navigation out of Carbon (enabled / disabled), external links, discoverable modules (offered in
  Object Explorer's Open in menu for their object type);
- moduleShortcuts: primary (tabs in the menu bar) and secondary (the "more" menu) shortcuts to modules — Workshop
  modules, Slate applications, Object Explorer searches, objects and object types, Notepad documents, Quiver,
  Vertex, Map, or a link — with icons, colors and parameter values;
- homePage: the internal home page (logo, welcome text, search bar over chosen object types, columns of sections
  shown as cards or a list: custom items, object types, all menu bar items) or a module as the home page;
- access: promote to the organization's Navigation Menu, default workspace for groups, Carbon as the landing page;
- updates: "What's New" walkthrough pages (title, description, media, documentation link; archive, delete).
Every save is a version (preview, restore). The YAML editor reads and writes the same configuration.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/carbon", tags=["carbon"])
CARBON_TYPE = "application/vnd.bluesandai.carbon+json"
DIR = Path("data/carbon")
MODULE_TYPES = ("workshop", "slate", "object_explorer", "object", "object_type", "notepad", "quiver", "vertex", "map", "search", "url", "developer_app")
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "carbon"
    (DIR / "workspaces").mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    return auth.current() or {"id": "local", "username": "local", "role": "admin", "groups": []}


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


def _path(wid: str) -> Path:
    if not re.fullmatch(r"cw-[0-9a-f]{12}", wid):
        raise HTTPException(404, "workspace not found")
    return DIR / "workspaces" / f"{wid}.json"


def _ws(wid: str) -> dict:
    w = _read(_path(wid))
    if not w:
        raise HTTPException(404, "workspace not found")
    return w


def _all() -> list[dict]:
    return [w for p in (DIR / "workspaces").glob("cw-*.json") if (w := _read(p))] if (DIR / "workspaces").exists() else []


def _access(w: dict, need: str = "viewer") -> dict:
    return drive._item(w["item_id"], need=need)


def _can(w: dict, need: str) -> bool:
    try:
        _access(w, need)
        return True
    except HTTPException:
        return False


def _org() -> dict:
    return _read(DIR / "org.json", {"promoted": [], "external_links": [], "landing": False})


def default_config(title: str) -> dict:
    return {
        "displayMetadata": {"title": title, "description": ""},
        "general": {"navigationOutOfCarbon": "enabled", "externalLinks": [], "discoverableModules": []},
        "moduleShortcuts": {"primary": [], "secondary": []},
        "homePage": {"type": "internal", "internal": {"logo": None, "welcomeText": f"Welcome to {title}", "hideSearchBar": False, "searchObjectTypes": [],
                                                       "columns": [{"sections": [{"title": "Object types", "displayAs": "LIST", "contents": {"type": "objectTypes", "objectTypes": []}}]},
                                                                   {"sections": [{"title": "Modules", "displayAs": "CARD", "contents": {"type": "menuItems"}}]}]},
                     "module": None},
        "access": {"promoted": False, "defaultForGroups": [], "landing": False},
        "updates": [],
    }


def _check(cfg: dict) -> dict:
    if not isinstance(cfg, dict):
        raise HTTPException(422, "a workspace configuration is an object")
    out = default_config((cfg.get("displayMetadata") or {}).get("title") or "Workspace")
    for k in out:
        if k in cfg and cfg[k] is not None:
            out[k] = cfg[k]
    nav = (out["general"] or {}).get("navigationOutOfCarbon", "enabled")
    if nav not in ("enabled", "disabled"):
        raise HTTPException(422, "general.navigationOutOfCarbon is enabled or disabled")

    def module(m: Any, where: str) -> None:
        if not isinstance(m, dict) or m.get("type") not in MODULE_TYPES:
            raise HTTPException(422, f"{where}: a module has a type among {', '.join(MODULE_TYPES)}")
        if m["type"] == "url" and not re.match(r"^(https?://|/)", str(m.get("url") or "")):
            raise HTTPException(422, f"{where}: a link needs an http(s) or / URL")

    for side in ("primary", "secondary"):
        for i, s in enumerate((out["moduleShortcuts"] or {}).get(side) or []):
            if not s.get("title"):
                raise HTTPException(422, f"moduleShortcuts.{side}[{i}] needs a title")
            module(s.get("module"), f"moduleShortcuts.{side}[{i}]")
    for i, m in enumerate((out["general"] or {}).get("discoverableModules") or []):
        module(m, f"general.discoverableModules[{i}]")
    hp = out["homePage"] or {}
    if hp.get("type") not in ("internal", "module"):
        raise HTTPException(422, "homePage.type is internal or module")
    if hp["type"] == "module":
        module(hp.get("module"), "homePage.module")
    for ci, col in enumerate(((hp.get("internal") or {}).get("columns")) or []):
        for si, sec in enumerate(col.get("sections") or []):
            c = sec.get("contents") or {}
            if c.get("type") not in ("custom", "objectTypes", "menuItems"):
                raise HTTPException(422, f"homePage columns[{ci}].sections[{si}]: contents are custom, objectTypes or menuItems")
            for ii, it in enumerate(c.get("items") or []):
                module(it, f"homePage columns[{ci}].sections[{si}].items[{ii}]")
    if len(json.dumps(out)) > 1_000_000:
        raise HTTPException(413, "workspace configurations are limited to 1 MB (link large images from Files)")
    return out


def _summary(w: dict) -> dict:
    return {"id": w["id"], "rid": w["rid"], "item_id": w["item_id"], "title": w["config"]["displayMetadata"]["title"],
            "description": w["config"]["displayMetadata"].get("description") or "", "version": w["version"], "updated_at": w.get("updated_at"),
            "promoted": w["id"] in _org()["promoted"]}


# ------------------------------------------------------------------------------------------------
# workspaces
# ------------------------------------------------------------------------------------------------


class WorkspaceIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    folder_id: str
    description: str = Field("", max_length=2000)
    config: Optional[dict] = None


@router.get("/workspaces")
def list_workspaces() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (CARBON_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return [_summary(w) | {"can_edit": _can(w, "editor")} for w in _all() if w["item_id"] in visible]


@router.post("/workspaces")
def create_workspace(req: WorkspaceIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "store the workspace in a Project or a folder")
    cfg = _check(req.config or default_config(req.title.strip()))
    cfg["displayMetadata"]["title"] = req.title.strip()
    cfg["displayMetadata"]["description"] = req.description
    with _lock:
        hexid = uuid.uuid4().hex[:12]
        wid = f"cw-{hexid}"
        body = json.dumps({"carbon_workspace_id": wid}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{req.title.strip()}.carbon"), io.BytesIO(body), len(body), CARBON_TYPE)
        w = {"id": wid, "rid": f"ri.carbon.main.workspace.{hexid}", "item_id": item["id"], "version": 1, "config": cfg,
             "history": [{"version": 1, "at": _now(), "by": _me()["id"], "description": "Created", "config": cfg}], "created_at": _now(), "updated_at": _now()}
        _write(_path(wid), w)
    return get_workspace(wid)


@router.get("/workspaces/{wid}")
def get_workspace(wid: str, version: Optional[int] = None) -> dict:
    w = _ws(wid)
    _access(w)
    cfg = w["config"]
    if version:
        h = next((x for x in w["history"] if x["version"] == version), None)
        if not h:
            raise HTTPException(404, "version not found")
        cfg = h["config"]
    org = _org()
    nav = [_summary(x) for x in (_ws(p) for p in org["promoted"] if _path(p).exists()) if _can(x, "viewer")]
    return {**_summary(w), "config": cfg, "previewing": version, "can_edit": _can(w, "editor"), "navigation": nav,
            "org_external_links": org["external_links"], "versions": [{k: h[k] for k in ("version", "at", "by", "description")} for h in reversed(w["history"])][:50]}


class SaveIn(BaseModel):
    config: dict
    base_version: int
    description: str = Field("", max_length=500)


@router.put("/workspaces/{wid}")
def save_workspace(wid: str, req: SaveIn) -> dict:
    """Save (and publish) a new version."""
    with _lock:
        w = _ws(wid)
        _access(w, "editor")
        if req.base_version != w["version"]:
            raise HTTPException(409, f"version {w['version']} was saved after you opened version {req.base_version}: reload")
        cfg = _check(req.config)
        acc = cfg.get("access") or {}
        if acc.get("promoted") != (w["id"] in _org()["promoted"]):
            if auth.enabled() and _me().get("role") != "admin":
                raise HTTPException(403, "only Carbon administrators (organization administrators) promote workspaces")
            org = _org()
            org["promoted"] = [x for x in org["promoted"] if x != w["id"]] + ([w["id"]] if acc.get("promoted") else [])
            _write(DIR / "org.json", org)
        w["version"] += 1
        w["config"] = cfg
        w["updated_at"] = _now()
        w["history"].append({"version": w["version"], "at": _now(), "by": _me()["id"], "description": req.description, "config": cfg})
        w["history"] = w["history"][-100:]
        _write(_path(wid), w)
    return get_workspace(wid)


@router.post("/workspaces/{wid}/versions/{version}/republish")
def republish(wid: str, version: int) -> dict:
    w = _ws(wid)
    h = next((x for x in w["history"] if x["version"] == version), None)
    if not h:
        raise HTTPException(404, "version not found")
    return save_workspace(wid, SaveIn(config=h["config"], base_version=w["version"], description=f"Republished version {version}"))


@router.delete("/workspaces/{wid}")
def delete_workspace(wid: str) -> dict:
    w = _ws(wid)
    drive.trash(_access(w, "editor")["id"])
    with _lock:
        org = _org()
        org["promoted"] = [x for x in org["promoted"] if x != wid]
        _write(DIR / "org.json", org)
    return {"trashed": wid}


@router.get("/workspaces/{wid}/yaml")
def get_yaml(wid: str) -> PlainTextResponse:
    """The configuration as YAML (Carbon's code editing)."""
    w = _ws(wid)
    _access(w, "editor")
    import yaml

    return PlainTextResponse(yaml.safe_dump(w["config"], sort_keys=False, allow_unicode=True), media_type="text/yaml")


class YamlIn(BaseModel):
    yaml: str = Field(max_length=1_000_000)
    base_version: int


@router.put("/workspaces/{wid}/yaml")
def put_yaml(wid: str, req: YamlIn) -> dict:
    import yaml

    try:
        cfg = yaml.safe_load(req.yaml)
    except yaml.YAMLError as e:  # noqa: BLE001
        raise HTTPException(422, f"the YAML does not parse: {str(e)[:300]}") from None
    return save_workspace(wid, SaveIn(config=cfg, base_version=req.base_version, description="Edited as YAML"))


# ------------------------------------------------------------------------------------------------
# the organization: promoted workspaces, external links, landing page; defaults per user
# ------------------------------------------------------------------------------------------------


class OrgIn(BaseModel):
    promoted: Optional[list[str]] = None
    external_links: Optional[list[dict]] = None
    landing: Optional[bool] = None


@router.get("/org")
def get_org() -> dict:
    org = _org()
    return {**org, "workspaces": [_summary(_ws(x)) for x in org["promoted"] if _path(x).exists()], "can_admin": not auth.enabled() or _me().get("role") == "admin"}


@router.put("/org")
def put_org(req: OrgIn) -> dict:
    auth.require_admin()
    with _lock:
        org = _org()
        if req.promoted is not None:
            for x in req.promoted:
                _ws(x)
            org["promoted"] = list(dict.fromkeys(req.promoted))
        if req.external_links is not None:
            for link in req.external_links:
                if not link.get("title") or not re.match(r"^(https?://|/)", str(link.get("url") or "")):
                    raise HTTPException(422, "external links have a title and an http(s) or / URL")
            org["external_links"] = req.external_links
        if req.landing is not None:
            org["landing"] = req.landing
        _write(DIR / "org.json", org)
    return get_org()


@router.get("/me")
def my_default() -> dict:
    """The caller's default workspace (the first workspace defaulting one of their groups), and whether Carbon is
    the landing page."""
    me = _me()
    groups = set(me.get("groups") or [])
    best = None
    for w in sorted(_all(), key=lambda x: x.get("created_at") or ""):
        acc = w["config"].get("access") or {}
        if groups & set(acc.get("defaultForGroups") or []) and _can(w, "viewer"):
            best = w
            break
    org = _org()
    landing = bool(best and (org.get("landing") or (best["config"].get("access") or {}).get("landing")))
    return {"default": _summary(best) if best else None, "landing": landing}


class SeenIn(BaseModel):
    ids: list[str]


@router.post("/workspaces/{wid}/updates/seen")
def seen(wid: str, req: SeenIn) -> dict:
    """Mark What's New pages as seen by the caller."""
    w = _ws(wid)
    _access(w)
    p = DIR / "seen" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', _me()['id'])}.json"
    with _lock:
        d = _read(p, {})
        d[wid] = sorted(set(d.get(wid, [])) | set(req.ids))
        _write(p, d)
    return {"seen": d[wid]}


@router.get("/workspaces/{wid}/updates/unseen")
def unseen(wid: str) -> list[dict]:
    w = _ws(wid)
    _access(w)
    p = DIR / "seen" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', _me()['id'])}.json"
    done = set(_read(p, {}).get(wid, []))
    return [u for u in w["config"].get("updates") or [] if not u.get("archived") and u.get("id") not in done]


@router.get("/discoverable")
def discoverable(object_type_id: str) -> list[dict]:
    """Modules of the workspaces the caller can see that are discoverable for this object type (Object Explorer's
    Open in menu)."""
    out = []
    for w in _all():
        if not _can(w, "viewer"):
            continue
        for m in (w["config"].get("general") or {}).get("discoverableModules") or []:
            if not m.get("objectTypeId") or m.get("objectTypeId") == object_type_id:
                out.append({"workspace": _summary(w), "module": m})
    return out
