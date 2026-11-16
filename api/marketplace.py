"""Marketplace (DevOps): a store of products other users install — Workshop modules, Slate applications, custom widget
sets, checkpoint configurations and Cipher channels — instead of passing package files around.

A product has versions; each version is a package made by its application's packager (workshop.package,
slate.package, custom_widgets.package, checkpoints.package_config, cipher.package_channel), so the same linting and
limits apply. Publishing needs what packaging needs (Editor of the module or app, Owner of the channel…) and makes the
publisher the product's maintainer (they and administrators publish new versions or delete it). Every signed-in user
browses the store; installing a version calls the application's installer with the target folder or Project, the
installation inputs and the dependency mapping, so what installing needs is checked there. Installing into a new
Project (`new_project`) creates it in the chosen space and locks it: it takes the space's inherited roles for locked
Marketplace Projects, and no role edits it until an administrator unlocks it (governance_model.py).

Store: data/marketplace/products/<id>.json. Mounted under /api/marketplace.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/marketplace", tags=["marketplace"])
DIR = Path("data/marketplace")
_lock = threading.Lock()

# product kind -> (label, packager(resource id) -> package, installer(package, target, name, inputs, mapping))
KINDS: dict[str, dict[str, Any]] = {}


def _register() -> None:
    import checkpoints
    import cipher
    import custom_widgets
    import restricted_views
    import slate
    import workshop

    KINDS.update({
        "bluesandai.workshop.product": {
            "label": "Workshop module", "resource": "module",
            "package": lambda rid: workshop.package(rid),
            "install": lambda pk, target, name, inputs, mapping: workshop.install(workshop.InstallIn(package=pk, folder_id=target, name=name, inputs=inputs, mapping=mapping)),
        },
        "bluesandai.slate.product": {
            "label": "Slate application", "resource": "app",
            "package": lambda rid: slate.package(rid),
            "install": lambda pk, target, name, inputs, mapping: slate.install(slate.InstallIn(package=pk, folder_id=target, name=name, inputs=inputs, mapping=mapping)),
        },
        "bluesandai.widget-set.product": {
            "label": "Custom widget set", "resource": "widget set",
            "package": lambda rid: custom_widgets.package(rid),
            "install": lambda pk, target, name, inputs, mapping: custom_widgets.install(custom_widgets.InstallIn(package=pk, folder_id=target, name=name, mapping=mapping)),
        },
        "bluesandai.checkpoints.product": {
            "label": "Checkpoint configuration", "resource": "configuration",
            "package": lambda rid: checkpoints.package_config(rid),
            "install": lambda pk, target, name, inputs, mapping: checkpoints.install_config(checkpoints.InstallIn(package=pk, project_id=target, mapping=mapping)),
        },
        "bluesandai.restricted-view.product": {
            "label": "Restricted view", "resource": "restricted view",
            "package": lambda rid: restricted_views.package(rid),
            "install": lambda pk, target, name, inputs, mapping: restricted_views.install(pk, target, name, mapping),
        },
        "bluesandai.cipher.product": {
            "label": "Cipher channel", "resource": "channel",
            "package": lambda rid: cipher.package_channel(rid),
            "install": lambda pk, target, name, inputs, mapping: cipher.install_channel(cipher.CipherInstallIn(package=pk, folder_id=target, name=name)),
        },
    })


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "marketplace"
    (DIR / "products").mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _path(pid: str) -> Path:
    if not pid.replace("-", "").isalnum():
        raise HTTPException(404, "product not found")
    return DIR / "products" / f"{pid}.json"


def _get(pid: str) -> dict:
    try:
        return json.loads(_path(pid).read_text("utf-8"))
    except (OSError, ValueError):
        raise HTTPException(404, "product not found") from None


def _put(p: dict) -> dict:
    with _lock:
        _path(p["id"]).parent.mkdir(parents=True, exist_ok=True)
        _path(p["id"]).write_text(json.dumps(p), "utf-8")
    return p


def _summary(p: dict) -> dict:
    me = auth.current() or {}
    return {**{k: v for k, v in p.items() if k != "versions"}, "label": (KINDS.get(p["kind"]) or {}).get("label", p["kind"]),
            "versions": [{k: v for k, v in ver.items() if k != "package"} for ver in p["versions"]],
            "latest": p["versions"][-1]["version"] if p["versions"] else None,
            "dependencies": (p["versions"][-1]["package"].get("dependencies") if p["versions"] else None) or {},
            "parameters": (p["versions"][-1]["package"].get("parameters") if p["versions"] else None) or [],
            "inputs": (p["versions"][-1]["package"].get("inputs") if p["versions"] else None) or [],
            "can_maintain": auth._is_admin(me) or me.get("id") in p.get("maintainers", [])}


@router.get("/kinds")
def kinds() -> list[dict]:
    if not KINDS:
        _register()
    return [{"kind": k, "label": v["label"], "resource": v["resource"]} for k, v in KINDS.items()]


@router.get("/products")
def list_products(q: str = "") -> list[dict]:
    auth.require_user()
    out = []
    for f in sorted((DIR / "products").glob("*.json")):
        try:
            p = json.loads(f.read_text("utf-8"))
        except ValueError:
            continue
        if q and q.lower() not in (p["name"] + " " + p.get("description", "")).lower():
            continue
        out.append(_summary(p))
    return sorted(out, key=lambda p: p.get("updated_at") or "", reverse=True)


@router.get("/products/{pid}")
def get_product(pid: str) -> dict:
    auth.require_user()
    return _summary(_get(pid))


class PublishIn(BaseModel):
    kind: str
    # package the resource now (its application's packager) …
    resource_id: Optional[str] = None
    # … or publish a package made earlier (a downloaded product file)
    package: Optional[dict] = None
    name: Optional[str] = Field(None, max_length=120)
    description: str = Field("", max_length=4000)
    # a new version of an existing product (its maintainers)
    product_id: Optional[str] = None
    version: Optional[str] = Field(None, max_length=40)


@router.post("/products")
def publish(req: PublishIn) -> dict:
    """Publish a product (or a new version of one)."""
    if not KINDS:
        _register()
    me = auth.require_user()
    k = KINDS.get(req.kind)
    if not k:
        raise HTTPException(400, f"Unknown product kind {req.kind}")
    if req.resource_id:
        pk = k["package"](req.resource_id)
    elif req.package:
        pk = req.package
    else:
        raise HTTPException(400, "Choose a resource to package, or a package")
    if pk.get("kind") != req.kind:
        raise HTTPException(400, "The package is not of that kind")
    if req.product_id:
        p = _get(req.product_id)
        if not (auth._is_admin(me) or me.get("id") in p.get("maintainers", [])):
            raise HTTPException(403, "Only the product's maintainers publish new versions")
        if p["kind"] != req.kind:
            raise HTTPException(400, "A product keeps its kind")
    else:
        p = {"id": "prod-" + uuid.uuid4().hex[:10], "kind": req.kind, "name": (req.name or pk.get("name") or "Product").strip(), "description": req.description,
             "maintainers": [me["id"]] if me.get("id") not in (None, "local") else [], "versions": [], "created_at": _now(), "installs": 0}
    version = (req.version or "").strip() or f"{len(p['versions']) + 1}.0.0"
    if any(v["version"] == version for v in p["versions"]):
        raise HTTPException(409, f"Version {version} exists")
    p["versions"].append({"version": version, "package": pk, "published_at": _now(), "published_by": me.get("username")})
    if req.description:
        p["description"] = req.description
    p["updated_at"] = _now()
    _put(p)
    auth.audit("marketplace_published", None, f"{p['name']} {version} ({k['label']})")
    return _summary(p)


class InstallIn(BaseModel):
    version: Optional[str] = None
    # a folder (Workshop, Slate, widget sets, Cipher) or a Project (checkpoint configurations)
    target_id: Optional[str] = None
    # or a new locked Project: {name, space_id}
    new_project: Optional[dict] = None
    name: Optional[str] = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    mapping: dict[str, str] = Field(default_factory=dict)


@router.post("/products/{pid}/install")
def install(pid: str, req: InstallIn) -> dict:
    """Install a version (default: the latest) with its application's installer."""
    if not KINDS:
        _register()
    auth.require_user()
    p = _get(pid)
    ver = next((v for v in p["versions"] if v["version"] == req.version), None) if req.version else (p["versions"][-1] if p["versions"] else None)
    if not ver:
        raise HTTPException(404, "version not found")
    target = req.target_id
    if req.new_project:
        import governance_model

        made = governance_model.create_project(governance_model.NewProjectIn(name=str(req.new_project.get("name") or p["name"]),
                                                                              space_id=req.new_project.get("space_id")), None)
        target = made["id"]
    if not target:
        raise HTTPException(400, "Choose where to install: a folder or Project, or a new Project")
    out = KINDS[p["kind"]]["install"](ver["package"], target, req.name, req.inputs, req.mapping)
    if req.new_project:
        governance_model.lock_for_marketplace(target, {"product": p["id"], "name": p["name"], "version": ver["version"]})
    p["installs"] = int(p.get("installs") or 0) + 1
    _put(p)
    auth.audit("marketplace_installed", None, f"{p['name']} {ver['version']} into {target}" + (" (new locked Project)" if req.new_project else ""))
    return {"product": p["id"], "version": ver["version"], "installed": out, "project_id": target if req.new_project else None}


@router.delete("/products/{pid}")
def delete_product(pid: str) -> dict:
    me = auth.require_user()
    p = _get(pid)
    if not (auth._is_admin(me) or me.get("id") in p.get("maintainers", [])):
        raise HTTPException(403, "Only the product's maintainers delete it")
    _path(pid).unlink(missing_ok=True)
    auth.audit("marketplace_deleted", None, p["name"])
    return {"deleted": pid}
