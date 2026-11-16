"""Use Cases [Sunset] (Application Building → Use Cases): a builder's view of one workflow Project.

A use case is backed by a Project (a new one, or an existing Project migrated to a use case). It shows:
- applications: the Project's application resources (Slate, Carbon, custom widget sets, Developer Console apps, Pilot,
  Autopilot, Solution Designer, Workflow Lineage / Builder graphs, Notepad, Fusion, Contour, Quiver, Reports…) plus the
  Workshop modules whose Files item is in the Project (and modules of other Projects added by hand), each with a description;
- Ontology components: the object types and action types those applications reference (from Workflow Lineage's index
  and the applications' own records), plus ones added by hand; status tags, "Local" when the backing dataset lives
  in the Project, and a warning when a Local type is also used outside the use case;
- backing data: each object type's backing dataset and what updates it (Data Lineage producers);
- other resources: everything else in the Project.
Metadata (name, description, Markdown documentation, technical / business owners — users or groups —, status) is
governed by use case roles (Use Case Owner manages roles and edits, Use Case Editor edits); it is visible to everyone in
the organization. Resources keep their own permissions (the Project's roles, Ontology permissions).
"""

from __future__ import annotations

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
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/use-cases", tags=["use-cases"])
DIR = Path("data/use_cases")
STATUSES = ("active", "experimental", "deprecated")
_lock = threading.RLock()
APP_TYPES = {
    "slate": "Slate application", "carbon": "Carbon workspace", "widget-set": "Custom widget set", "developer-console": "Developer Console application",
    "pilot": "Pilot application", "autopilot": "Autopilot workbench", "solution-diagram": "Solution Designer diagram", "workflow-lineage": "Workflow Lineage graph",
    "workflow-builder": "Workflow Builder graph", "notepad": "Notepad document", "fusion": "Fusion spreadsheet", "contour": "Contour analysis", "quiver": "Quiver analysis",
    "report": "Report", "vertex": "Vertex graph", "map": "Map", "machinery": "Machinery process", "forms": "Form", "logic-flow": "Logic flow",
}
APP_HREF = {"slate": "/slate", "carbon": "/carbon", "widget-set": "/custom-widgets", "developer-console": "/developer-console", "pilot": "/pilot", "autopilot": "/autopilot",
            "solution-diagram": "/solution-designer", "workflow-lineage": "/workflow-lineage", "workflow-builder": "/workflow-builder", "notepad": "/notepad",
            "fusion": "/fusion", "contour": "/analytics", "quiver": "/quiver", "report": "/reports", "vertex": "/vertex", "map": "/map/new", "machinery": "/machinery", "forms": "/forms"}
ID_RE = re.compile(r"^(ot|act)-[0-9a-f]{6,}$")


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "use_cases"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    return auth.current() or {"id": "local", "username": "local", "role": "admin", "groups": []}


def _rd(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _wr(p: Path, data: Any) -> None:
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


def _path(uid: str) -> Path:
    if not re.fullmatch(r"uc-[0-9a-f]{12}", uid):
        raise HTTPException(404, "use case not found")
    return DIR / f"{uid}.json"


def _get(uid: str) -> dict:
    u = _rd(_path(uid))
    if not u:
        raise HTTPException(404, "use case not found")
    return u


def _all() -> list[dict]:
    return [u for p in DIR.glob("uc-*.json") if (u := _rd(p))]


def _role(u: dict) -> Optional[str]:
    """The caller's use case role: owner, editor, or None (metadata is still visible to everyone)."""
    me = _me()
    if not auth.enabled() or me.get("role") == "admin":
        return "owner"
    mine = {f"user:{me.get('id')}"} | {f"group:{g}" for g in me.get("groups") or []}
    best = None
    for r in u.get("roles") or []:
        if r["principal"] in mine:
            if r["role"] == "owner":
                return "owner"
            best = "editor"
    return best


def _need(u: dict, role: str) -> None:
    have = _role(u)
    if role == "owner" and have != "owner" or role == "editor" and have not in ("owner", "editor"):
        raise HTTPException(403, f"you need the Use Case {role.title()} role")


def _name_of(principal: str) -> str:
    kind, _, pid = principal.partition(":")
    try:
        if kind == "user":
            x = auth._user(pid)
            return x.get("display_name") or x.get("username") or pid
        if kind == "group":
            g = next((g for g in auth._groups() if g["id"] == pid), None)
            return (g or {}).get("name") or pid
    except HTTPException:
        pass
    return pid


def _people(xs: list[str]) -> list[dict]:
    return [{"principal": x, "name": _name_of(x)} for x in xs]


# ------------------------------------------------------------------------------------------------
# what the Project holds
# ------------------------------------------------------------------------------------------------


def _items(project_id: str) -> list[dict]:
    """Every file in the Project (any depth) that the caller can see, with its folder path."""
    out, stack, seen = [], [project_id], set()
    while stack and len(seen) < 3000:
        fid = stack.pop()
        if fid in seen:
            continue
        seen.add(fid)
        for i in auth.visible(db.drive_query("parent_id = %s AND trashed_at IS NULL", (fid,), limit=3000)):
            if i["kind"] in ("folder", "project"):
                stack.append(i["id"])
            else:
                out.append(i)
    return out


def _app_type(item: dict) -> Optional[str]:
    ct = item.get("content_type") or ""
    if not ct.startswith("application/vnd.bluesandai."):
        return None
    key = ct.removeprefix("application/vnd.bluesandai.").removesuffix("+json")
    return next((k for k in APP_TYPES if key == k or key.startswith(k)), None)


def _records_by_item() -> dict[str, dict]:
    """The records behind Files-backed applications (to find the Ontology resources they reference)."""
    import importlib

    out: dict[str, dict] = {}
    for mod in ("autopilot", "carbon", "pilot", "solution_designer", "workflow_builder", "slate", "custom_widgets", "developer_console"):
        try:
            d = importlib.import_module(mod).DIR
        except Exception:  # noqa: BLE001
            continue
        for n, p in enumerate(Path(d).rglob("*.json")):
            if n > 4000:
                break
            if p.stat().st_size > 3_000_000:
                continue
            rec = _rd(p)
            if isinstance(rec, dict) and rec.get("item_id"):
                out.setdefault(rec["item_id"], {}).update(rec)
    return out


def _ids(obj: Any, out: Optional[set] = None) -> set[str]:
    out = set() if out is None else out
    if isinstance(obj, dict):
        for v in obj.values():
            _ids(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _ids(v, out)
    elif isinstance(obj, str) and ID_RE.match(obj):
        out.add(obj)
    return out


def _resolve(u: dict) -> dict:
    """Applications, Ontology components, backing data and other resources of a use case."""
    import ontology
    import workshop

    items = _items(u["project_id"])
    records = _records_by_item()
    try:
        import workflow_lineage

        idx = workflow_lineage.build_index()
    except Exception:  # noqa: BLE001
        idx = {"nodes": [], "edges": []}
    by_item = {n["item_id"]: n["key"] for n in idx["nodes"] if n.get("item_id")}
    upstream: dict[str, set] = {}
    for e in idx["edges"]:
        upstream.setdefault(e["to"], set()).add(e["from"])

    def refs_of(key: Optional[str], rec: Optional[dict]) -> set[str]:
        out: set[str] = set()
        if key:
            stack, seen = [key], set()
            while stack:
                k = stack.pop()
                for up in upstream.get(k, ()):
                    if up not in seen:
                        seen.add(up)
                        kind, _, rid = up.partition(":")
                        if kind in ("object_type", "action_type"):
                            out.add(rid)
                        if kind in ("action_type", "function", "logic", "widget_set"):
                            stack.append(up)
        if rec:
            out |= _ids(rec)
        return out

    apps, others, datasets = [], [], []
    mods = {m["id"]: m for m in workshop.list_modules()}
    # Workshop modules are Files items: those in the Project belong to the use case (besides the ones added by hand)
    mod_by_item = {m["item_id"]: m for m in mods.values() if m.get("item_id")}
    found: list[str] = []
    for i in items:
        t = _app_type(i)
        if i.get("content_type") == workshop.WORKSHOP_TYPE:
            if i["id"] in mod_by_item:
                found.append(mod_by_item[i["id"]]["id"])
            continue
        if t:
            refs = refs_of(by_item.get(i["id"]), records.get(i["id"]))
            apps.append({"key": f"item:{i['id']}", "item_id": i["id"], "type": t, "type_label": APP_TYPES[t], "name": re.sub(r"\.[a-z]+$", "", i["name"]),
                         "updated_at": str(i.get("updated_at") or ""), "href": _item_href(t, i, records.get(i["id"])), "refs": sorted(refs),
                         "description": (u.get("app_descriptions") or {}).get(f"item:{i['id']}", "")})
        elif (i.get("content_type") or "").endswith("parquet") or i["name"].endswith((".parquet", ".csv")):
            datasets.append(i)
        else:
            others.append({"item_id": i["id"], "name": i["name"], "content_type": i.get("content_type"), "updated_at": str(i.get("updated_at") or ""),
                           "href": f"/files/{i.get('parent_id') or ''}"})
    linked = [x for x in u.get("workshop_modules") or [] if x not in found]
    for mid in found + linked:
        m = mods.get(mid)
        if not m:
            continue
        refs = refs_of(f"workshop:{mid}", {"widgets": m.get("widgets")})
        apps.append({"key": f"workshop:{mid}", "workshop_id": mid, "type": "workshop", "type_label": "Workshop module", "name": m["name"], "updated_at": m.get("updated_at"),
                     "href": f"/workshop/{mid}", "refs": sorted(refs), "description": (u.get("app_descriptions") or {}).get(f"workshop:{mid}", ""),
                     # in the Project (discovered) or in another Project and added by hand
                     "in_project": mid in found, "item_id": m.get("item_id")})
    apps.sort(key=lambda a: a.get("updated_at") or "", reverse=True)

    types = {t["id"]: t for t in ontology.list_object_types()}
    acts = {a["id"]: a for a in ontology.list_action_types()}
    used_by: dict[str, list[str]] = {}
    for a in apps:
        for r in a["refs"]:
            used_by.setdefault(r, []).append(a["name"])
    # used outside this use case: any edge from the type to an application not in it
    mine = {a.get("item_id") for a in apps} | {a.get("workshop_id") for a in apps}
    app_kinds = {"workshop", "slate", "widget_set", "osdk_app"}
    node_item = {n["key"]: n.get("item_id") or n["id"] for n in idx["nodes"]}
    elsewhere: dict[str, list[str]] = {}
    names = {n["key"]: n["name"] for n in idx["nodes"]}
    for e in idx["edges"]:
        kind, _, rid = e["from"].partition(":")
        if kind == "object_type" and e["to"].split(":")[0] in app_kinds and node_item.get(e["to"]) not in mine:
            elsewhere.setdefault(rid, []).append(names.get(e["to"], e["to"]))
    project_items = {i["id"] for i in items}
    obj_rows = []
    for tid in sorted(set(r for r in used_by if r in types) | set(u.get("manual_object_types") or [])):
        t = types.get(tid)
        if not t:
            continue
        full = _full_type(tid)
        backing = (full.get("backing_dataset") or {})
        local = bool(backing.get("dataset_id") and backing["dataset_id"] in project_items)
        obj_rows.append({"id": tid, "name": t["display_name"], "status": t.get("status"), "manual": tid in (u.get("manual_object_types") or []) and tid not in used_by,
                         "used_by": used_by.get(tid, []), "local": local, "used_elsewhere": sorted(set(elsewhere.get(tid, [])))[:10] if local else [],
                         "backing_dataset": backing.get("name"), "backing_dataset_id": backing.get("dataset_id"), "properties": len(t.get("properties") or [])})
    act_rows = []
    for aid in sorted(set(r for r in used_by if r in acts) | set(u.get("manual_action_types") or [])):
        a = acts.get(aid)
        if not a:
            continue
        act_rows.append({"id": aid, "name": a["display_name"], "status": a.get("status"), "object_type": types.get(a.get("object_type_id") or "", {}).get("display_name"),
                         "manual": aid in (u.get("manual_action_types") or []) and aid not in used_by, "used_by": used_by.get(aid, [])})
    backing_rows = _backing(obj_rows, project_items)
    warn = u.get("status") == "active" and any(r.get("status") in ("experimental", "deprecated") for r in obj_rows + act_rows)
    return {"applications": apps, "object_types": obj_rows, "action_types": act_rows, "backing_data": backing_rows,
            "other_resources": others + [{"item_id": d["id"], "name": d["name"], "content_type": d.get("content_type"), "updated_at": str(d.get("updated_at") or ""),
                                          "href": f"/datasets/{d['id']}"} for d in datasets if d["id"] not in {b.get("dataset_id") for b in backing_rows}],
            "status_warning": warn}


def _full_type(tid: str) -> dict:
    import ontology

    try:
        return ontology._object_type(tid)
    except HTTPException:
        return {}


def _backing(obj_rows: list[dict], project_items: set) -> list[dict]:
    """Each object type's input datasource and writeback dataset, and what updates the datasource (Data Lineage)."""
    try:
        import lineage

        g = lineage.graph()
        prod = {n.get("item_id"): n.get("producers") or [] for n in g["nodes"] if n.get("item_id")}
    except Exception:  # noqa: BLE001
        prod = {}
    out = []
    for r in obj_rows:
        full = _full_type(r["id"])
        b = full.get("backing_dataset") or {}
        wb = full.get("writeback_dataset") or full.get("writeback") or {}
        out.append({"object_type_id": r["id"], "object_type": r["name"], "status": r.get("status"), "dataset_id": b.get("dataset_id"), "dataset": b.get("name"),
                    "synced_at": b.get("synced_at"), "in_project": b.get("dataset_id") in project_items,
                    "writeback": (wb or {}).get("name") if isinstance(wb, dict) else None,
                    "update_via": [{"kind": p.get("kind"), "name": p.get("name")} for p in prod.get(b.get("dataset_id"), [])][:5],
                    "extra": [d.get("name") for d in full.get("additional_datasources") or []]})
    return out


def _item_href(t: str, item: dict, rec: Optional[dict]) -> str:
    rid = (rec or {}).get("id")
    if t in ("slate", "carbon", "autopilot", "solution-diagram", "workflow-lineage", "workflow-builder") and rid:
        return f"{APP_HREF[t]}/{rid}"
    return APP_HREF.get(t, f"/files/{item.get('parent_id') or ''}")


def _summary(u: dict) -> dict:
    try:
        proj = db.drive_get(u["project_id"]) or {}
    except Exception:  # noqa: BLE001
        proj = {}
    return {"id": u["id"], "name": u["name"], "description": u.get("description", ""), "status": u.get("status", "experimental"), "project_id": u["project_id"],
            "project": proj.get("name"), "technical_owners": _people(u.get("technical_owners") or []), "business_owners": _people(u.get("business_owners") or []),
            "updated_at": u.get("updated_at"), "created_at": u.get("created_at")}


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class CreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=4000)
    project_id: Optional[str] = None
    new_project: Optional[str] = Field(None, max_length=200)


@router.get("")
def list_use_cases(q: str = "") -> list[dict]:
    """Every use case of the organization (metadata is visible to everyone)."""
    ql = q.strip().lower()
    out = [_summary(u) for u in _all()]
    if ql:
        out = [x for x in out if ql in f"{x['name']} {x['description']} {x.get('project') or ''}".lower()]
    return sorted(out, key=lambda x: x.get("updated_at") or "", reverse=True)


@router.post("")
def create(req: CreateIn) -> dict:
    """A use case on a new Project, or on an existing one (migrating it)."""
    if req.new_project:
        proj = drive.create_folder(drive.NewFolder(name=req.new_project, kind="project"))
    elif req.project_id:
        proj = drive._item(req.project_id, need="editor")
        if proj["kind"] != "project":
            raise HTTPException(400, "a use case is backed by a Project")
        if any(u["project_id"] == proj["id"] for u in _all()):
            raise HTTPException(409, "this Project already backs a use case")
    else:
        raise HTTPException(422, "choose a Project or name a new one")
    me = _me()
    u = {"id": f"uc-{uuid.uuid4().hex[:12]}", "name": req.name.strip(), "description": req.description, "status": "experimental", "project_id": proj["id"],
         "technical_owners": [f"user:{me.get('id')}"], "business_owners": [], "roles": [{"principal": f"user:{me.get('id')}", "role": "owner"}],
         "documentation": "", "workshop_modules": [], "manual_object_types": [], "manual_action_types": [], "app_descriptions": {},
         "created_by": me.get("id"), "created_at": _now(), "updated_at": _now()}
    with _lock:
        _wr(_path(u["id"]), u)
    return get_use_case(u["id"])


@router.get("/{uid}")
def get_use_case(uid: str) -> dict:
    u = _get(uid)
    try:
        drive._item(u["project_id"], need="viewer")
        can_view_project = True
    except HTTPException:
        can_view_project = False
    res = _resolve(u) if can_view_project else {"applications": [], "object_types": [], "action_types": [], "backing_data": [], "other_resources": [], "status_warning": False}
    return {**_summary(u), "documentation": u.get("documentation", ""), "my_role": _role(u), "can_view_project": can_view_project,
            "roles": [{"principal": r["principal"], "name": _name_of(r["principal"]), "role": r["role"]} for r in u.get("roles") or []], **res}


class MetaIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=4000)
    documentation: Optional[str] = Field(None, max_length=200_000)
    status: Optional[str] = None
    technical_owners: Optional[list[str]] = None
    business_owners: Optional[list[str]] = None
    app_description: Optional[dict] = None


@router.patch("/{uid}")
def update(uid: str, req: MetaIn) -> dict:
    with _lock:
        u = _get(uid)
        _need(u, "editor")
        if req.status is not None and req.status not in STATUSES:
            raise HTTPException(422, f"status is one of {', '.join(STATUSES)}")
        for k in ("name", "description", "documentation", "status", "technical_owners", "business_owners"):
            v = getattr(req, k)
            if v is not None:
                if k.endswith("owners") and not all(re.fullmatch(r"(user|group):[\w.-]+", x) for x in v):
                    raise HTTPException(422, "owners are user:<id> or group:<id>")
                u[k] = v.strip() if isinstance(v, str) and k == "name" else v
        if req.app_description:
            u.setdefault("app_descriptions", {})[str(req.app_description.get("key"))] = str(req.app_description.get("description") or "")[:4000]
        u["updated_at"] = _now()
        _wr(_path(uid), u)
    return get_use_case(uid)


class RolesIn(BaseModel):
    roles: list[dict] = Field(max_length=200)


@router.put("/{uid}/roles")
def set_roles(uid: str, req: RolesIn) -> dict:
    with _lock:
        u = _get(uid)
        _need(u, "owner")
        roles = []
        for r in req.roles:
            if not re.fullmatch(r"(user|group):[\w.-]+", str(r.get("principal") or "")) or r.get("role") not in ("owner", "editor"):
                raise HTTPException(422, "a role is {principal: user:<id> | group:<id>, role: owner | editor}")
            roles.append({"principal": r["principal"], "role": r["role"]})
        if not any(r["role"] == "owner" for r in roles):
            raise HTTPException(422, "a use case keeps at least one owner")
        u["roles"] = roles
        u["updated_at"] = _now()
        _wr(_path(uid), u)
    return get_use_case(uid)


class ResourceIn(BaseModel):
    kind: str = Field(pattern="^(object_type|action_type)$")
    id: str
    add: bool = True


@router.post("/{uid}/ontology")
def manual_resource(uid: str, req: ResourceIn) -> dict:
    """Add or remove an object type or action type by hand (removing works only when no application uses it)."""
    with _lock:
        u = _get(uid)
        _need(u, "editor")
        key = "manual_object_types" if req.kind == "object_type" else "manual_action_types"
        cur = set(u.get(key) or [])
        if req.add:
            cur.add(req.id)
        else:
            cur.discard(req.id)
        u[key] = sorted(cur)
        u["updated_at"] = _now()
        _wr(_path(uid), u)
    return get_use_case(uid)


class AppIn(BaseModel):
    kind: str = Field(pattern="^(workshop|slate|quiver)$")
    name: str = Field(min_length=1, max_length=200)


@router.post("/{uid}/applications")
def new_application(uid: str, req: AppIn) -> dict:
    """Create a Workshop module, Slate application or Quiver analysis for the use case (in its Project)."""
    u = _get(uid)
    _need(u, "editor")
    drive._item(u["project_id"], need="editor")
    if req.kind == "workshop":
        import workshop

        # a Files item in the use case's Project, so the use case finds it there
        m = workshop.create_module(workshop.ModuleIn(name=req.name, folder_id=u["project_id"]))
        if not m.get("item_id"):
            with _lock:
                u = _get(uid)
                u.setdefault("workshop_modules", []).append(m["id"])
                u["updated_at"] = _now()
                _wr(_path(uid), u)
        return {"href": f"/workshop/{m['id']}", "id": m["id"]}
    if req.kind == "slate":
        import slate

        app = slate.create_app(slate.AppIn(name=req.name, folder_id=u["project_id"]))
        return {"href": f"/slate/{app['id']}", "id": app["id"]}
    return {"href": "/quiver", "id": None}


class LinkIn(BaseModel):
    workshop_id: str
    add: bool = True


@router.post("/{uid}/applications/workshop")
def link_workshop(uid: str, req: LinkIn) -> dict:
    """Add a Workshop module kept in another Project to the use case, or take it out (modules in the use case's
    Project are found from their Files items)."""
    import workshop

    workshop._module(req.workshop_id)
    with _lock:
        u = _get(uid)
        _need(u, "editor")
        cur = [m for m in u.get("workshop_modules") or [] if m != req.workshop_id]
        u["workshop_modules"] = cur + ([req.workshop_id] if req.add else [])
        u["updated_at"] = _now()
        _wr(_path(uid), u)
    return get_use_case(uid)


@router.delete("/{uid}")
def delete(uid: str) -> dict:
    """Delete the use case (its Project and resources stay)."""
    u = _get(uid)
    _need(u, "owner")
    _path(uid).unlink(missing_ok=True)
    return {"deleted": uid}


@router.get("/{uid}/object-types/{tid}")
def object_type(uid: str, tid: str) -> dict:
    """An object type's details in the use case: properties, datasources, the applications that use it."""
    import ontology

    u = _get(uid)
    t = ontology.get_object_type(tid)
    full = _full_type(tid)
    res = _resolve(u)
    return {"id": tid, "name": t["display_name"], "description": t.get("description"), "status": t.get("status"), "primary_key": t.get("primary_key"),
            "properties": [{"api_name": p["api_name"], "display_name": p.get("display_name"), "type": p.get("type")} for p in t.get("properties") or []],
            "backing_dataset": full.get("backing_dataset"), "additional_datasources": [d.get("name") for d in full.get("additional_datasources") or []],
            "applications": [a for a in res["applications"] if tid in a["refs"]]}
