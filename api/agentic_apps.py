"""Agentic Apps: the organisation's own apps in the Applications Portal, listed beside the platform apps.

Application Building → "Curating apps in Applications Portal": the portal shows the platform apps and the custom apps an
organisation makes available. Here they form one category, "Agentic Apps", with nothing setting them apart from the
platform's own. The list is kept on the server (data/agentic-apps/apps.json), so everyone sees the same portal.

- GET  /api/agentic-apps          the apps the caller can see (an app built on a resource shows when that resource
                                  does: its Developer Console application or its Workshop module)
- POST /api/agentic-apps/new      make a new integrated app and list it: an OSDK app (a Developer Console application
                                  whose scopes are the chosen object types, action types and functions; Application
                                  Building → OSDK React applications) or a Workshop app (a module on the Ontology)
- POST /api/agentic-apps          list an existing page or resource
- DELETE /api/agentic-apps/{id}   take an app off the portal (its resource is kept)
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/agentic-apps", tags=["agentic-apps"])
DIR = Path("data/agentic-apps")
_lock = threading.Lock()
HOME = "Agentic Apps"  # the Project where new apps' resources are made


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "agentic-apps"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read() -> list[dict]:
    try:
        return json.loads((DIR / "apps.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _write(apps: list[dict]) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = DIR / f"apps.json.{uuid.uuid4().hex[:8]}.tmp"  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(apps, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(DIR / "apps.json")


def _who() -> str:
    return (auth.current() or {}).get("username") or "local"


def _visible(app: dict) -> bool:
    """An app built on a resource is listed for those who can see the resource."""
    try:
        if app.get("kind") == "osdk" and app.get("resource_id"):
            import developer_console as dc

            dc._access(dc._app(app["resource_id"]))
        elif app.get("kind") == "workshop" and app.get("resource_id"):
            import workshop

            return any(m["id"] == app["resource_id"] for m in workshop.list_modules())
        return True
    except HTTPException:
        return False


def _href(app: dict) -> Optional[str]:
    """Where the app opens: its own page; an OSDK app's live hosted site, else its Developer Console application."""
    if app.get("href"):
        return app["href"]
    if app.get("kind") == "osdk" and app.get("resource_id"):
        try:
            import developer_console as dc

            m = dc._app(app["resource_id"])
            hosting = m.get("hosting") or {}
            if hosting.get("live"):
                return dc.site_url(hosting["slug"])
        except HTTPException:
            pass
        return f"/developer-console?id={app['resource_id']}"
    if app.get("kind") == "workshop" and app.get("resource_id"):
        return f"/workshop/{app['resource_id']}"
    return None


@router.get("")
def list_apps() -> list[dict]:
    return [{**a, "href": _href(a)} for a in _read() if _visible(a)]


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=600)
    icon: str = "cube"
    href: Optional[str] = Field(None, max_length=500)
    kind: Literal["osdk", "workshop", "page"] = "page"
    resource_id: Optional[str] = None
    collection: Optional[str] = None
    tags: list[str] = Field(default_factory=list)


def register(req: AppIn, app_id: Optional[str] = None) -> dict:
    """List an app (or update the one with this id / the same resource)."""
    with _lock:
        apps = _read()
        cur = next((a for a in apps if (app_id and a["id"] == app_id) or (req.resource_id and a.get("resource_id") == req.resource_id)
                    or (req.href and a.get("href") == req.href)), None)
        rec = {**(cur or {"id": app_id or f"aga-{uuid.uuid4().hex[:10]}", "created_at": _now(), "created_by": _who()}),
               **req.model_dump(), "owner": (cur or {}).get("owner") or _who(), "updated_at": _now()}
        apps = [a for a in apps if a is not cur] + [rec]
        _write(apps)
    return {**rec, "href": _href(rec)}


@router.post("")
def add_app(req: AppIn, replace: bool = False) -> dict:
    """List an app. A listing for the same resource or link already exists: 409 naming it, unless replace=true (the
    Applications Portal asks first; register() keeps merging silently for the demo builds)."""
    auth.require_user()
    if not replace:
        dup = next((a for a in _read() if (req.resource_id and a.get("resource_id") == req.resource_id) or (req.href and a.get("href") == req.href)), None)
        if dup:
            raise HTTPException(409, {"code": "duplicate_listing", "message": f'"{dup["name"]}" already lists this app: replace it, or choose another link',
                                      "existing": {"id": dup["id"], "name": dup["name"]}})
    return register(req)


@router.delete("/{app_id}")
def remove_app(app_id: str) -> dict:
    auth.require_user()
    with _lock:
        apps = _read()
        if not any(a["id"] == app_id for a in apps):
            raise HTTPException(404, "app not found")
        _write([a for a in apps if a["id"] != app_id])
    return {"removed": app_id}


class NewAppIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=600)
    kind: Literal["osdk", "workshop"]
    icon: str = "cube"
    folder_id: Optional[str] = None
    object_types: list[str] = Field(default_factory=list)
    action_types: list[str] = Field(default_factory=list)
    functions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


def _home_folder() -> str:
    import db
    import drive

    found = next((c for c in db.drive_list(None) if c["name"] == HOME and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
    return found["id"] if found else drive._insert_container(None, "project", HOME)


@router.post("/new")
def new_app(req: NewAppIn) -> dict:
    """Make the app's resource on the Ontology and list it under Agentic Apps."""
    auth.require_user()
    folder = req.folder_id or _home_folder()
    if req.kind == "osdk":
        import developer_console as dc

        made = dc.create_app(dc.AppIn(name=req.name, folder_id=folder, description=req.description))
        if req.object_types or req.action_types or req.functions:
            dc.set_resources(made["id"], dc.ResourcesIn(object_types=req.object_types, action_types=req.action_types, functions=req.functions))
        resource = made["id"]
    else:
        import workshop

        widgets = []
        if req.object_types:
            # a starting point on the first chosen object type: a title, a table and its object view
            src = {"kind": "object_type", "id": req.object_types[0]}
            widgets = [{"id": "w1", "type": "text", "title": "", "x": 0, "y": 0, "w": 12, "h": 1, "config": {"text": f"**{req.name}** — {req.description}"}},
                       {"id": "w2", "type": "table", "title": "Objek", "x": 0, "y": 1, "w": 8, "h": 8, "config": {"source": src, "limit": 200}},
                       {"id": "w3", "type": "property_list", "title": "Detail", "x": 8, "y": 1, "w": 4, "h": 8, "config": {"source": src}}]
        made = workshop.create_module(workshop.ModuleIn(name=req.name, description=req.description, widgets=widgets, folder_id=folder))
        resource = made["id"]
    return register(AppIn(name=req.name, description=req.description, icon=req.icon, kind=req.kind, resource_id=resource, tags=req.tags,
                          collection="Aplikasi OSDK" if req.kind == "osdk" else "Aplikasi Workshop"))
