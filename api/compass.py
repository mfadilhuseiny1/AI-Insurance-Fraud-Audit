"""Compass (Security & Governance → Compass): the filesystem's discovery and curation layer over Files.

- Quicksearch: GET /search ranks apps (Files items of application types, plus the client's platform apps), objects
  (on at most 250 object types: active ones first; prominent before normal before experimental; deprecated and
  hidden types are left out), datasets (by name and column names) and files (by name, path, description, tags),
  boosted when promoted and by their views; only what the caller may see.
- Tags: categories (visible to the organizations they are restricted to) of tags, applied to resources by users with
  the "Apply tags to resources" permission (administrators, or the users and groups given it) who can edit the
  resource. Tags do not add security.
- Resource status: Promoted (Editors of the resource who are resource curators) — a checkmark, a search boost and
  the Promoted items quick filter.
- Documentation: a folder's README.md (rendered in place) and a Project's cover page, description and point of
  contact.
- Project details: activity of the last month (audit.3 lines naming the Project's resources), an access graph
  (markings, the roles of users and groups, and the groups' members), views.
- Data Catalog: collections of curated resources (managed by administrators and the catalog managers they name),
  with tags as filters; everyone sees collections and their descriptions, and the resources they can access.

Mounted by server.py under /api/compass.
"""

from __future__ import annotations

import math
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

router = APIRouter(prefix="/api/compass", tags=["compass"])
DIR = Path("data/compass")
_lock = threading.RLock()
APP_EXT = {".workshop": "Workshop module", ".slate": "Slate application", ".carbon": "Carbon workspace", ".quiver": "Quiver analysis", ".contour": "Contour analysis",
           ".notepad": "Notepad document", ".fusion": "Fusion spreadsheet", ".report": "Report", ".vertex": "Vertex graph", ".machinery": "Machinery process",
           ".widgets": "Custom widget set", ".developer-console": "Developer Console application", ".pipeline": "Pipeline", ".cipher-channel": "Cipher Channel",
           ".cipher-license": "Cipher License"}
DATASET_EXT = (".parquet", ".csv", ".tsv", ".xlsx", ".xls")
_cols_cache: dict[str, tuple[str, list[str]]] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "compass"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _get(name: str, default: Any) -> Any:
    return audit3._read(DIR / name, default)


def _put(name: str, value: Any) -> None:
    audit3._write(DIR / name, value)


def _settings() -> dict:
    s = _get("settings.json", {})
    for k in ("curators", "taggers", "catalog_managers"):
        s.setdefault(k, [])
    return s


def _is_admin(p: Optional[dict] = None) -> bool:
    p = p or auth.current()
    return not auth.enabled() or bool(p and p.get("role") == "admin")


def _in(p: dict, principals: list[str]) -> bool:
    return p.get("id") in principals or bool(set(p.get("groups") or []) & set(principals)) or "*" in principals


def _item(item_id: str, need: str = "viewer") -> dict:
    import drive

    return drive._item(item_id, need=need)


# ------------------------------------------------------------------------------------------------
# tags
# ------------------------------------------------------------------------------------------------


def _tags_doc() -> dict:
    d = _get("tags.json", {})
    d.setdefault("categories", [])
    d.setdefault("items", {})
    return d


def _visible_category(c: dict, p: Optional[dict] = None) -> bool:
    p = p or auth.current() or {}
    return _is_admin(p) or not c.get("orgs") or (p.get("organization_id") or audit3.DEFAULT_ORG) in c["orgs"]


def _tag_index() -> dict[str, dict]:
    out = {}
    for c in _tags_doc()["categories"]:
        for t in c["tags"]:
            out[t["id"]] = {**t, "category": c["name"], "category_id": c["id"]}
    return out


@router.get("/tags")
def tags() -> list[dict]:
    auth.require_user()
    return [c for c in _tags_doc()["categories"] if _visible_category(c)]


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    orgs: Optional[list[str]] = None  # None: the creator's organization


@router.post("/tags/categories")
def create_category(req: CategoryIn) -> dict:
    p = auth.require_admin()
    with _lock:
        d = _tags_doc()
        if any(c["name"].lower() == req.name.lower() for c in d["categories"]):
            raise HTTPException(409, "a tag category with that name exists")
        c = {"id": uuid.uuid4().hex[:10], "name": req.name.strip(), "orgs": req.orgs if req.orgs is not None else [p.get("organization_id") or audit3.DEFAULT_ORG],
             "tags": [], "created_at": _now()}
        d["categories"].append(c)
        _put("tags.json", d)
    return c


@router.put("/tags/categories/{cid}")
def update_category(cid: str, req: CategoryIn) -> dict:
    auth.require_admin()
    with _lock:
        d = _tags_doc()
        c = next((x for x in d["categories"] if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "tag category not found")
        c["name"] = req.name.strip()
        if req.orgs is not None:
            c["orgs"] = req.orgs
        _put("tags.json", d)
    return c


@router.delete("/tags/categories/{cid}")
def delete_category(cid: str) -> dict:
    auth.require_admin()
    with _lock:
        d = _tags_doc()
        c = next((x for x in d["categories"] if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "tag category not found")
        gone = {t["id"] for t in c["tags"]}
        d["categories"] = [x for x in d["categories"] if x["id"] != cid]
        d["items"] = {k: [t for t in v if t not in gone] for k, v in d["items"].items()}
        _put("tags.json", d)
    return {"deleted": cid}


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.post("/tags/categories/{cid}/tags")
def add_tag(cid: str, req: TagIn) -> dict:
    auth.require_admin()
    with _lock:
        d = _tags_doc()
        c = next((x for x in d["categories"] if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "tag category not found")
        if any(t["name"].lower() == req.name.lower() for t in c["tags"]):
            raise HTTPException(409, "the category has that tag already")
        t = {"id": uuid.uuid4().hex[:10], "name": req.name.strip()}
        c["tags"].append(t)
        _put("tags.json", d)
    return t


@router.delete("/tags/{tid}")
def delete_tag(tid: str) -> dict:
    auth.require_admin()
    with _lock:
        d = _tags_doc()
        for c in d["categories"]:
            c["tags"] = [t for t in c["tags"] if t["id"] != tid]
        d["items"] = {k: [t for t in v if t != tid] for k, v in d["items"].items()}
        _put("tags.json", d)
    return {"deleted": tid}


class ItemTagsIn(BaseModel):
    tags: list[str]


@router.put("/items/{item_id}/tags")
def set_item_tags(item_id: str, req: ItemTagsIn) -> dict:
    p = auth.require_user()
    if not _is_admin(p) and not _in(p, _settings()["taggers"]):
        raise HTTPException(403, 'Applying tags needs the "Apply tags to resources" permission (an administrator grants it in Compass settings)')
    _item(item_id, "editor")
    idx = _tag_index()
    if set(req.tags) - set(idx):
        raise HTTPException(400, "unknown tag")
    with _lock:
        d = _tags_doc()
        d["items"][item_id] = sorted(set(req.tags))
        _put("tags.json", d)
    audit3.emit("COMPASS_SET_TAGS", ["metaDataUpdate"], {"updatedMetaDataResources": [{"type": "item", "id": item_id}],
                                                         "updatedMetaDataDescription": "tags: " + ", ".join(idx[t]["name"] for t in req.tags)}, product="compass")
    return meta(item_id)


# ------------------------------------------------------------------------------------------------
# status, views, metadata
# ------------------------------------------------------------------------------------------------


class StatusIn(BaseModel):
    status: Optional[str] = Field(None, pattern="^promoted$")


@router.put("/items/{item_id}/status")
def set_status(item_id: str, req: StatusIn) -> dict:
    """Promote a resource (Editors of it who are resource curators), or remove the status."""
    p = auth.require_user()
    _item(item_id, "editor")
    if not _is_admin(p) and not _in(p, _settings()["curators"]):
        raise HTTPException(403, "Promoting resources needs the Resource Curator role (an administrator grants it in Compass settings)")
    with _lock:
        st = _get("status.json", {})
        if req.status:
            st[item_id] = {"status": req.status, "by": p.get("username"), "at": _now()}
        else:
            st.pop(item_id, None)
        _put("status.json", st)
    return meta(item_id)


@router.post("/items/{item_id}/view")
def record_view(item_id: str) -> dict:
    auth.require_user()
    with _lock:
        v = _get("views.json", {})
        v[item_id] = v.get(item_id, 0) + 1
        _put("views.json", v)
    return {"views": v[item_id]}


@router.get("/items/{item_id}/meta")
def meta(item_id: str) -> dict:
    """Compass metadata of a resource: tags, status, collections, views."""
    p = auth.require_user()
    _item(item_id)
    idx = _tag_index()
    cats = {c["id"]: c for c in _tags_doc()["categories"]}
    tags_ = [idx[t] for t in _tags_doc()["items"].get(item_id, []) if t in idx and _visible_category(cats[idx[t]["category_id"]], p)]
    st = _get("status.json", {}).get(item_id)
    cols = [{"id": c["id"], "name": c["name"]} for c in _get("collections.json", []) if item_id in c["items"]]
    s = _settings()
    return {"item_id": item_id, "tags": tags_, "status": st, "collections": cols, "views": _get("views.json", {}).get(item_id, 0),
            "can_tag": _is_admin(p) or _in(p, s["taggers"]), "can_promote": _is_admin(p) or _in(p, s["curators"]),
            "can_curate": _is_admin(p) or _in(p, s["catalog_managers"])}


class SettingsIn(BaseModel):
    curators: Optional[list[str]] = None
    taggers: Optional[list[str]] = None
    catalog_managers: Optional[list[str]] = None


@router.get("/settings")
def get_settings() -> dict:
    auth.require_user()
    return _settings()


@router.put("/settings")
def put_settings(req: SettingsIn) -> dict:
    auth.require_admin()
    with _lock:
        s = _settings()
        s.update(req.model_dump(exclude_none=True))
        _put("settings.json", s)
    audit3.emit("COMPASS_SETTINGS", ["managementPermissions"], {"resourcesWithPermissionsChanges": [{"type": "compass", "id": "settings"}],
                                                                "permissionChangeContext": str(req.model_dump(exclude_none=True))}, product="compass")
    return s


# ------------------------------------------------------------------------------------------------
# documentation and Project details
# ------------------------------------------------------------------------------------------------


@router.get("/folders/{folder_id}/readme")
def readme(folder_id: str) -> dict:
    """A folder's README.md (rendered in place)."""
    import db
    import drive

    _item(folder_id)
    f = next((c for c in db.drive_list(folder_id) if c["kind"] == "file" and c["name"].lower() == "readme.md" and not c.get("trashed_at")), None)
    if not f or not auth.can_access(f["id"]):
        return {"item_id": None, "text": None}
    return {"item_id": f["id"], "text": drive.read_bytes(f).decode("utf-8", "replace")[:200_000]}


class ReadmeIn(BaseModel):
    text: str = Field(max_length=200_000)


@router.put("/folders/{folder_id}/readme")
def save_readme(folder_id: str, req: ReadmeIn) -> dict:
    """Add description: write the folder's README.md."""
    import db
    import drive
    import pipeline_datasets

    _item(folder_id, "editor")
    data = req.text.encode()
    f = next((c for c in db.drive_list(folder_id) if c["kind"] == "file" and c["name"].lower() == "readme.md" and not c.get("trashed_at")), None)
    if f:
        pipeline_datasets._replace_content(f, data, "text/markdown")
    else:
        drive.save_bytes(folder_id, "README.md", data, "text/markdown")
    return readme(folder_id)


class ProjectIn(BaseModel):
    description: Optional[str] = Field(None, max_length=5000)
    point_of_contact: Optional[str] = None
    cover: Optional[str] = Field(None, max_length=200_000)
    # discoverable across organizations: users outside the Project's space organizations see that its resources
    # exist (the Discover operation, auth.operations_for), not their data
    discoverable: Optional[bool] = None


def discoverable_across_orgs(pid: str) -> bool:
    return bool(_get("projects.json", {}).get(pid, {}).get("discoverable"))


def _project(pid: str, need: str = "viewer") -> dict:
    it = _item(pid, need)
    if it["kind"] != "project":
        raise HTTPException(400, "not a Project")
    return it


def _contact(poc: Optional[str]) -> Optional[dict]:
    """A Project's point of contact: a user, or a group ("group:<id>") with its contact details (email or Issues)."""
    if not poc:
        return None
    if poc.startswith("group:"):
        g = next((x for x in auth._groups() if x["id"] == poc[6:]), None)
        return {"id": poc, "name": g["name"] if g else "(deleted group)", "contact": (g or {}).get("contact")}
    u = auth.user_label(poc) or {}
    return {"id": poc, "name": u.get("display_name") or u.get("username"), "contact": {"kind": "email", "value": u["email"]} if u.get("email") else None}


@router.get("/projects/{pid}")
def project(pid: str) -> dict:
    p = auth.require_user()
    it = _project(pid)
    d = _get("projects.json", {}).get(pid, {})
    return {"id": pid, "rid": f"ri.compass.main.folder.{pid}", "name": it["name"], "description": d.get("description") or "", "cover": d.get("cover") or "",
            "point_of_contact": _contact(d.get("point_of_contact")),
            "discoverable": bool(d.get("discoverable")), "can_edit": not auth.enabled() or _is_admin(p) or auth.role_for(pid, p) == "owner",
            "role": auth.role_for(pid, p), "views": _get("views.json", {}).get(pid, 0), "created": str(it.get("created_at")), "modified": str(it.get("updated_at"))}


@router.put("/projects/{pid}")
def update_project(pid: str, req: ProjectIn) -> dict:
    _project(pid, "owner")
    if req.point_of_contact and req.point_of_contact.startswith("group:") and not any(g["id"] == req.point_of_contact[6:] for g in auth._groups()):
        raise HTTPException(400, "Unknown group")
    with _lock:
        all_ = _get("projects.json", {})
        d = all_.setdefault(pid, {})
        d.update({k: v for k, v in req.model_dump().items() if v is not None})
        _put("projects.json", all_)
    return project(pid)


# ------------------------------------------------------------------------------------------------
# Autosaved: files made from an existing resource (an analysis of a dataset, a preparation of it) start in the
# Project's Autosaved section — visible to everyone with access to the Project — until they are saved somewhere
# ------------------------------------------------------------------------------------------------


def autosave_folder(source_id: Optional[str]) -> Optional[str]:
    """The Autosaved folder of the Project a source is in (made on first use), for a caller who may edit there;
    None outside Projects (the caller's default folder is used)."""
    import db
    import drive

    pid = auth.project_of(source_id) if source_id else None
    if not pid or not auth.has_operation(pid, "edit"):
        return None
    with _lock:
        known = _get("autosaved.json", {})
        fid = known.get(pid)
        it = db.drive_get(fid) if fid else None
        if not it or it.get("trashed_at") or it.get("parent_id") != pid:
            fid = drive._insert_container(pid, "folder", drive._free_name(pid, "Autosaved"))
            known[pid] = fid
            _put("autosaved.json", known)
    return fid


def is_autosaved(item: dict) -> bool:
    return bool(item.get("parent_id")) and item.get("parent_id") in set(_get("autosaved.json", {}).values())


@router.get("/projects/{pid}/autosaved")
def autosaved(pid: str) -> list[dict]:
    """The Project's autosaved files (labelled Autosaved), newest first."""
    import db
    import drive

    _project(pid)
    fid = _get("autosaved.json", {}).get(pid)
    if not fid or not db.drive_get(fid):
        return []
    rows = [drive._public(i) for i in db.drive_list(fid) if not i.get("trashed_at") and auth.can_discover(i["id"])]
    return sorted(rows, key=lambda r: str(r.get("updated_at") or ""), reverse=True)


class SaveAutosavedIn(BaseModel):
    folder_id: str
    name: Optional[str] = None


@router.post("/autosaved/{item_id}/save")
def save_autosaved(item_id: str, req: SaveAutosavedIn) -> dict:
    """Save an autosaved file: it moves to a folder of the Files section (Editor on both ends)."""
    import drive

    item = _item(item_id, "editor")
    if not is_autosaved(item):
        raise HTTPException(400, "The file is not in an Autosaved section")
    folder = drive._folder_id(req.folder_id)
    _item(folder, "editor")
    name = drive._clean_name(req.name or item["name"])
    out = drive.update_item(item_id, drive.ItemChange(move_to=folder, name=drive._free_name(folder, name) if folder != item.get("parent_id") else name))
    audit3.emit("COMPASS_SAVE_AUTOSAVED", ["dataUpdate"], {"updatedResourceIds": [item_id]}, product="compass")
    return out


@router.get("/projects/{pid}/activity")
def activity(pid: str, days: int = 30) -> list[dict]:
    """Changes and use of the Project's resources in the last month (from audit.3)."""
    _project(pid)
    import db

    ids_in: dict[str, bool] = {}

    def inside(i: str) -> bool:
        if i not in ids_in:
            ids_in[i] = i == pid or (bool(re.fullmatch(r"[0-9a-f]{16}", i)) and auth.project_of(i) == pid)
        return ids_in[i]

    t1 = datetime.now(timezone.utc)
    out = []
    for x in audit3.lines(t1 - timedelta(days=max(1, min(days, 31))), t1 + timedelta(minutes=1)):
        ents = [e for e in x.get("entities") or [] if inside(str(e.get("id")))]
        if not ents:
            continue
        out.append({"time": x["time"], "uid": x.get("uid"), "name": x["name"], "categories": x["categories"], "resources": ents, "result": x.get("result")})
    out.sort(key=lambda r: r["time"], reverse=True)
    names = audit3._user_names({r["uid"] for r in out[:500]})
    items: dict[str, str] = {}
    for r in out[:500]:
        r["user"] = names.get(r["uid"]) or r["uid"]
        for e in r["resources"]:
            if e["id"] not in items:
                it = db.drive_get(e["id"])
                items[e["id"]] = it["name"] if it else e["id"]
            e["name"] = items[e["id"]]
    return out[:500]


@router.get("/projects/{pid}/access-graph")
def access_graph(pid: str) -> dict:
    """Markings on the Project, the users and groups with a role, and the groups' members."""
    _project(pid)
    nodes = [{"id": f"project:{pid}", "kind": "project", "name": _item(pid)["name"]}]
    edges = []
    names = auth.marking_labels()
    for m in sorted(auth.effective_markings(pid)):
        nodes.append({"id": f"marking:{m}", "kind": "marking", "name": names.get(m, m)})
        edges.append({"from": f"marking:{m}", "to": f"project:{pid}", "label": "required"})
    groups = {g["id"]: g for g in auth._groups()}
    users = {u["id"]: u for u in auth._users()}
    for r in auth.project_roles(pid):
        if r["principal_type"] == "everyone":
            nodes.append({"id": "everyone", "kind": "everyone", "name": "Everyone"})
            edges.append({"from": "everyone", "to": f"project:{pid}", "label": r["role"]})
        elif r["principal_type"] == "group" and r["principal_id"] in groups:
            g = groups[r["principal_id"]]
            nodes.append({"id": f"group:{g['id']}", "kind": "group", "name": g["name"]})
            edges.append({"from": f"group:{g['id']}", "to": f"project:{pid}", "label": r["role"]})
            for m in g.get("members") or []:
                if m in users:
                    nodes.append({"id": f"user:{m}", "kind": "user", "name": users[m].get("display_name") or users[m]["username"]})
                    edges.append({"from": f"user:{m}", "to": f"group:{g['id']}", "label": "member"})
        elif r["principal_type"] == "user" and r["principal_id"] in users:
            u = users[r["principal_id"]]
            nodes.append({"id": f"user:{u['id']}", "kind": "user", "name": u.get("display_name") or u["username"]})
            edges.append({"from": f"user:{u['id']}", "to": f"project:{pid}", "label": r["role"]})
    uniq = {n["id"]: n for n in nodes}
    return {"nodes": list(uniq.values()), "edges": edges, "open_to_everyone": not auth.project_roles(pid)}


# ------------------------------------------------------------------------------------------------
# Data Catalog
# ------------------------------------------------------------------------------------------------


def _may_curate() -> dict:
    p = auth.require_user()
    if not _is_admin(p) and not _in(p, _settings()["catalog_managers"]):
        raise HTTPException(403, "Adding and removing resources in collections needs the catalog manager permission")
    return p


class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""


@router.get("/collections")
def collections() -> list[dict]:
    auth.require_user()
    import db

    out = []
    for c in _get("collections.json", []):
        visible = [i for i in c["items"] if auth.can_access(i) and db.drive_get(i)]
        out.append({**c, "items": visible, "hidden": len(c["items"]) - len(visible)})
    return out


@router.post("/collections")
def create_collection(req: CollectionIn) -> dict:
    p = _may_curate()
    c = {"id": uuid.uuid4().hex[:10], "name": req.name.strip(), "description": req.description, "items": [], "created_by": p.get("username"), "created_at": _now()}
    with _lock:
        _put("collections.json", [*_get("collections.json", []), c])
    return c


@router.put("/collections/{cid}")
def update_collection(cid: str, req: CollectionIn) -> dict:
    _may_curate()
    with _lock:
        rows = _get("collections.json", [])
        c = next((x for x in rows if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "collection not found")
        c.update(name=req.name.strip(), description=req.description)
        _put("collections.json", rows)
    return c


@router.delete("/collections/{cid}")
def delete_collection(cid: str) -> dict:
    _may_curate()
    with _lock:
        _put("collections.json", [x for x in _get("collections.json", []) if x["id"] != cid])
    return {"deleted": cid}


class CollectionItemsIn(BaseModel):
    items: list[str] = Field(min_length=1)


@router.post("/collections/{cid}/items")
def add_items(cid: str, req: CollectionItemsIn) -> dict:
    _may_curate()
    for i in req.items:
        _item(i)
    with _lock:
        rows = _get("collections.json", [])
        c = next((x for x in rows if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "collection not found")
        c["items"] = list(dict.fromkeys([*c["items"], *req.items]))
        _put("collections.json", rows)
    return c


@router.delete("/collections/{cid}/items/{item_id}")
def remove_item(cid: str, item_id: str) -> dict:
    _may_curate()
    with _lock:
        rows = _get("collections.json", [])
        c = next((x for x in rows if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "collection not found")
        c["items"] = [i for i in c["items"] if i != item_id]
        _put("collections.json", rows)
    return c


@router.get("/catalog")
def catalog(collection: Optional[str] = None, tags: str = "", kind: Optional[str] = None) -> dict:
    """The Data Catalog's curated resources (every collection, or one), with tags for filtering and grouping."""
    auth.require_user()
    import db

    cols = _get("collections.json", [])
    if collection:
        cols = [c for c in cols if c["id"] == collection]
    ids = list(dict.fromkeys(i for c in cols for i in c["items"]))
    want = {t for t in tags.split(",") if t}
    idx = _tag_index()
    tagmap = _tags_doc()["items"]
    out = []
    for i in ids:
        it = db.drive_get(i)
        if not it or it.get("trashed_at") or not auth.can_access(i):
            continue
        t = [idx[x] for x in tagmap.get(i, []) if x in idx]
        if want and not want <= {x["id"] for x in t}:
            continue
        k = _kind(it)
        if kind and k != kind:
            continue
        out.append({"id": i, "name": it["name"], "kind": k, "tags": t, "collections": [c["name"] for c in cols if i in c["items"]], "updated_at": str(it.get("updated_at")),
                    "path": [p["name"] for p in db.drive_path(i)[:-1]]})
    return {"items": out}


# ------------------------------------------------------------------------------------------------
# Quicksearch
# ------------------------------------------------------------------------------------------------


def _kind(it: dict) -> str:
    n = it["name"].lower()
    if it["kind"] in ("project", "folder"):
        return it["kind"]
    if n.endswith(DATASET_EXT):
        return "dataset"
    if any(n.endswith(e) for e in APP_EXT):
        return "app"
    return "file"


def _columns(it: dict) -> list[str]:
    import dataset_versions

    key = str(it.get("updated_at"))
    hit = _cols_cache.get(it["id"])
    if hit and hit[0] == key:
        return hit[1]
    cur = dataset_versions.current(it["id"]) or {}
    cols = list(cur.get("columns") or [])
    _cols_cache[it["id"]] = (key, cols)
    return cols


def _score(text: str, q: str) -> float:
    t, q = text.lower(), q.lower()
    if not q:
        return 0
    if t == q:
        return 10
    if t.startswith(q):
        return 6
    if re.search(rf"\b{re.escape(q)}", t):
        return 4
    return 2 if q in t else 0


@router.get("/search")
def search(q: str = "", type: str = "all", tags: str = "", project: Optional[str] = None, path: str = "",  # noqa: A002
           promoted: bool = False, limit: int = 50, jump: bool = False, creator: str = "") -> dict:
    """Quicksearch. jump=true: titles only (the jump-to dropdown); otherwise names, descriptions, column names and paths.
    creator (or "creator:<username>" in the query): items that user created (items from before creators were recorded
    have none)."""
    auth.require_user()
    import db

    m = re.search(r"(?:^|\s)creator:(\S+)", q)
    if m:
        creator = creator or m.group(1)
        q = (q[:m.start()] + q[m.end():])
    q = q.strip()
    creator = creator.strip().lstrip("@")
    limit = max(1, min(limit, 200))
    status = _get("status.json", {})
    views = _get("views.json", {})
    tagmap = _tags_doc()["items"]
    idx = _tag_index()
    want_tags = {t for t in tags.split(",") if t}
    results: list[dict] = []
    if type in ("all", "apps", "datasets", "files"):
        if q:
            like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            rows = db.drive_query("trashed_at IS NULL AND name ILIKE %s", (like,), limit=1000)
        else:
            rows = db.drive_query("trashed_at IS NULL AND lower(created_by) = lower(%s)", (creator,), order="updated_at DESC", limit=1000) if creator else \
                db.drive_query("trashed_at IS NULL", (), order="updated_at DESC", limit=300) if (promoted or want_tags or project) else []
        seen = {r["id"] for r in rows}
        if q and not jump and type in ("all", "datasets"):
            # datasets whose column names match
            for it in db.drive_query("trashed_at IS NULL AND kind = 'file' AND (name ILIKE %s OR name ILIKE %s)", ("%.parquet", "%.csv"), limit=3000):
                if it["id"] not in seen and any(q.lower() in c.lower() for c in _columns(it)):
                    rows.append(it)
                    seen.add(it["id"])
        if promoted:
            for pid in status:
                if pid not in seen:
                    it = db.drive_get(pid)
                    if it and not it.get("trashed_at"):
                        rows.append(it)
                        seen.add(pid)
        for it in rows:
            k = _kind(it)
            group = "datasets" if k == "dataset" else "apps" if k == "app" else "files"
            if type != "all" and group != type:
                continue
            if not auth.can_access(it["id"]):
                continue
            if project and auth.project_of(it["id"]) != project:
                continue
            item_tags = [idx[t] for t in tagmap.get(it["id"], []) if t in idx]
            if want_tags and not want_tags <= {t["id"] for t in item_tags}:
                continue
            if promoted and it["id"] not in status:
                continue
            if creator and (it.get("created_by") or "").lower() != creator.lower():
                continue
            chain = db.drive_path(it["id"]) if not jump else []
            ptxt = "/".join(p["name"] for p in chain[:-1])
            if path and path.lower() not in ptxt.lower():
                continue
            s = _score(it["name"], q) if q else 1
            matched_cols = []
            if not jump and q and k == "dataset":
                matched_cols = [c for c in _columns(it) if q.lower() in c.lower()][:5]
                if not s and matched_cols:
                    s = 3
            if not jump and q and not s:
                s = 1 if q.lower() in ptxt.lower() or any(q.lower() in t["name"].lower() for t in item_tags) else 0
            if q and not s:
                continue
            s += 5 if it["id"] in status else 0
            s += math.log1p(views.get(it["id"], 0))
            results.append({"group": group, "kind": k, "id": it["id"], "parent_id": it.get("parent_id"), "name": it["name"], "type_label": next((v for e, v in APP_EXT.items() if it["name"].lower().endswith(e)), k),
                            "path": ptxt, "updated_at": str(it.get("updated_at")), "promoted": it["id"] in status, "views": views.get(it["id"], 0), "tags": item_tags,
                            "columns": matched_cols, "score": round(s, 2), "markings": len(auth.effective_markings(it["id"])),
                            "created_by": it.get("created_by")})
    if type in ("all", "objects") and q and not creator:
        results += _object_results(q, limit, jump)
    results.sort(key=lambda r: -r["score"])
    groups: dict[str, int] = {}
    for r in results:
        groups[r["group"]] = groups.get(r["group"], 0) + 1
    if q and not jump:
        audit3.emit("COMPASS_SEARCH", ["dataSearch"], {"dataSearchQuery": q, "dataSearchContext": [{"type": type, **({"creator": creator} if creator else {})}]},
                    {"dataSearchResults": [{"type": r["kind"], "id": r["id"]} for r in results[:20]]}, product="compass")
    return {"query": q, "creator": creator or None, "total": len(results), "groups": groups, "results": results[:limit]}


def _object_results(q: str, limit: int, jump: bool) -> list[dict]:
    """Object types and objects: at most 250 object types (active, then prominent / normal / experimental)."""
    try:
        import ontology
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    try:
        types = ontology.list_object_types()
    except Exception:  # noqa: BLE001
        return []
    rank = {"active": 0, "experimental": 2}
    vis = {"prominent": 0, "normal": 1, "hidden": 9}
    types = [t for t in types if (t.get("status") or "active") != "deprecated" and (t.get("visibility") or "normal") != "hidden"]
    types.sort(key=lambda t: (rank.get(t.get("status") or "active", 1), vis.get(t.get("visibility") or "normal", 1)))
    for t in types[:250]:
        s = _score(t.get("display_name") or "", q)
        if s:
            out.append({"group": "objects", "kind": "object_type", "id": t["id"], "name": t.get("display_name"), "type_label": "Object type", "path": "",
                        "promoted": False, "views": 0, "tags": [], "columns": [], "score": s + 1, "href": f"/ontology/object-types/{t['id']}"})
        if len(out) >= limit:
            break
        try:
            res = ontology.list_objects(t["id"], q=q if not jump else "", limit=20)
        except Exception:  # noqa: BLE001
            continue
        for o in res.get("objects") or []:
            title = str(o.get("title") or o.get("primary_key"))
            s2 = _score(title, q)
            if jump and not s2:
                continue
            out.append({"group": "objects", "kind": "object", "id": f"{t['id']}:{o['primary_key']}", "name": title, "type_label": t.get("display_name"), "path": "",
                        "promoted": False, "views": 0, "tags": [], "columns": [], "score": (s2 or 1) + 0.5,
                        "href": f"/object-explorer?type={t['id']}&object={o['primary_key']}"})
        if len(out) >= limit * 2:
            break
    return out
