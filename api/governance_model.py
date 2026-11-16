"""Spaces, Project constraints, Project templates and Portfolios (Security & Governance docs 03 and 04).

Spaces: every Project is in one space (the "Default" space unless chosen). A space's access requirements are
organizations: a user needs at least one of them (as a member or a guest) to use any Project in it. A space can give
roles on all its Projects (inherited roles: shown on the Project, granted on top of its own) and limit which roles its
Projects can grant (its role set). Space owners manage the space and its templates; space editors create Projects in it.
What a role on the space allows is a set of workflows (SPACE_WORKFLOWS): the default roles (viewer, editor, owner) have
fixed sets, and a space's owners add custom space roles (Space permissions) with the workflows they choose, granted
to users and groups. Projects a Marketplace installation created are locked: they take the space's inherited roles
for locked Marketplace Projects instead of its regular ones, and nobody edits them except through the Marketplace
(administrators unlock one).

Project constraints: a Project's Owner limits which markings may be on its files — "allowed" (only these) or
"prohibited" (all but these). Applying a violating marking is refused; a build whose output inherits a violating
marking fails (auth.CONSTRAINT_HOOK, auth.check_constraints) — the marking stays applied, so the data stays protected.
Setting a constraint that existing files already violate is refused.

Project templates: per space; deploying one creates the Project with its folders, variables substituted into the
names of new groups and markings it creates, role grants (the creator, existing users and groups, new groups),
markings applied to the Project (new markings are granted to everyone given a role) and its constraints. Templates
that create groups or markings need an administrator to deploy them.

Portfolios: a space's Projects grouped for discovery (each Project in at most one); anyone with access to the space
sees its portfolios (not the Projects inside unless their roles allow); space editors and the portfolio's curators
change its Projects; documentation (Markdown) and promoted resources.

Classification-based access controls: with "require a classification" on (Control Panel → Security), a new Project
must be given a classification marking (a marking of a hierarchical category), applied to the Project.

Store: the auth store (auth_store.py), table gov_records (kind, id, record JSON).
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import auth_store

router = APIRouter(prefix="/api/governance", tags=["governance"])
_lock = threading.RLock()
DEFAULT_SPACE = "space-default"
SCHEMA = "CREATE TABLE IF NOT EXISTS gov_records (kind TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (kind, id));"


def configure() -> None:
    with auth_store.connect() as con:
        con.executescript(SCHEMA)
    auth.CONSTRAINT_HOOK = violation
    auth.SPACE_HOOK = space_of_project


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------------------------------------
# records
# ------------------------------------------------------------------------------------------------

_cache: dict[str, tuple[float, list[dict]]] = {}


def _all(kind: str) -> list[dict]:
    hit = _cache.get(kind)
    if hit and time.time() - hit[0] < 5:
        return hit[1]
    with auth_store.connect() as con:
        out = [json.loads(r) for (r,) in con.execute("SELECT record FROM gov_records WHERE kind = ?", (kind,)).fetchall()]
    _cache[kind] = (time.time(), out)
    return out


def _get(kind: str, rid: str) -> Optional[dict]:
    return next((r for r in _all(kind) if r["id"] == rid), None)


def _put(kind: str, rec: dict) -> dict:
    with _lock, auth_store.connect() as con:
        con.execute("INSERT INTO gov_records (kind, id, record) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET record = excluded.record",
                    (kind, rec["id"], json.dumps(rec)))
    _cache.pop(kind, None)
    auth._project_cache.clear()
    auth._roles_cache.clear()
    return rec


def _delete(kind: str, rid: str) -> None:
    with _lock, auth_store.connect() as con:
        con.execute("DELETE FROM gov_records WHERE kind = ? AND id = ?", (kind, rid))
    _cache.pop(kind, None)


def _me() -> dict:
    return auth.require_user()


def _is_admin(p: dict) -> bool:
    return auth._is_admin(p)


def _keys(p: dict) -> set[str]:
    return auth._principal_keys(p) | {"everyone"}


# ------------------------------------------------------------------------------------------------
# spaces
# ------------------------------------------------------------------------------------------------


def _default_space() -> dict:
    return {"id": DEFAULT_SPACE, "name": "Default", "description": "Projects not placed in another space", "organizations": [], "owners": [],
            "editors": ["everyone"], "viewers": [], "inherited_roles": [], "role_set": [], "builtin": True}


def spaces() -> list[dict]:
    rows = _all("space")
    if not any(s["id"] == DEFAULT_SPACE for s in rows):
        rows = [_default_space(), *rows]
    return rows


def space(sid: Optional[str]) -> dict:
    s = next((x for x in spaces() if x["id"] == (sid or DEFAULT_SPACE)), None)
    if not s:
        raise HTTPException(404, "Space not found")
    return s


def project_record(project_id: str) -> dict:
    return _get("project", project_id) or {"id": project_id, "space_id": DEFAULT_SPACE}


def space_of_project(project_id: str) -> dict:
    """The space a Project is in (auth.SPACE_HOOK): its organizations and inherited roles — for a locked Marketplace
    Project, the space's inherited roles for those (and `locked`, which leaves only discover / read / download)."""
    rec = project_record(project_id)
    s = space(rec.get("space_id"))
    if rec.get("marketplace_locked"):
        return {**s, "inherited_roles": s.get("marketplace_inherited_roles") or [], "locked": True}
    return s


def space_access(s: dict, p: Optional[dict]) -> bool:
    """Members (or guests) of at least one of the space's organizations; any user when it has none."""
    if p is None or _is_admin(p) or not s.get("organizations"):
        return True
    held = set(p.get("markings") or set())
    return any(auth.org_marking(o) in held for o in s["organizations"])


# what roles on a space allow (Space permissions); the default roles' sets are fixed, custom space roles pick theirs
SPACE_WORKFLOWS: dict[str, str] = {
    "view_space": "See the space, its Projects and portfolios",
    "create_projects": "Create Projects in the space",
    "manage_portfolios": "Create, curate and delete portfolios",
    "manage_templates": "Create, edit and delete Project templates",
    "deploy_privileged_templates": "Deploy templates that create groups or markings",
    "manage_space": "Change the space's settings, roles and inherited roles",
}
DEFAULT_WORKFLOWS: dict[str, set[str]] = {
    "viewer": {"view_space"},
    "editor": {"view_space", "create_projects", "manage_portfolios"},
    "owner": set(SPACE_WORKFLOWS),
}


def space_role(s: dict, p: dict) -> Optional[str]:
    if _is_admin(p):
        return "owner"
    if not space_access(s, p):
        return None
    keys = _keys(p)
    for role in ("owners", "editors", "viewers"):
        if keys & set(s.get(role) or []):
            return role[:-1]
    return "viewer"


def space_workflows(s: dict, p: dict) -> set[str]:
    """The workflows the caller holds on a space: their default role's, plus those of the custom space roles granted
    to them (to them, a group of theirs or everyone)."""
    if _is_admin(p):
        return set(SPACE_WORKFLOWS)
    role = space_role(s, p)
    if role is None:
        return set()
    out = set(DEFAULT_WORKFLOWS[role])
    keys = _keys(p)
    for r in s.get("custom_roles") or []:
        if keys & set(r.get("grants") or []):
            out |= set(r.get("workflows") or [])
    return out


def _check_space(s: dict, workflow: str) -> dict:
    p = _me()
    if workflow not in space_workflows(s, p):
        raise HTTPException(403, f"You need a role on the space {s['name']} that allows: {SPACE_WORKFLOWS[workflow].lower()}")
    return p


def _clean_space_principals(values: list[str]) -> list[str]:
    rest = [v for v in values if v != "everyone"]
    return (["everyone"] if "everyone" in values else []) + auth._clean_principals(rest)


class SpaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    organizations: list[str] = Field(default_factory=list)
    owners: list[str] = Field(default_factory=list)
    editors: list[str] = Field(default_factory=list)
    viewers: list[str] = Field(default_factory=list)
    # [{principal_type: user|group|everyone, principal_id, role}] granted on every Project in the space
    inherited_roles: list[dict] = Field(default_factory=list)
    # the same, for the locked Projects Marketplace installations create in the space (instead of inherited_roles)
    marketplace_inherited_roles: list[dict] = Field(default_factory=list)
    # the roles its Projects may grant ([] = every role)
    role_set: list[str] = Field(default_factory=list)
    # classification-based access controls: no file in its Projects may carry a classification above this one (a
    # marking of a hierarchical category; the cap applies within that category)
    max_classification: Optional[str] = None
    # where new files of its Projects are stored: "default" (the platform's storage), "local" or "s3"
    storage: str = Field("default", pattern="^(default|local|s3)$")
    # the resource queue its Projects use unless a queue lists them (resource_queues.py)
    resource_queue: Optional[str] = None
    # the usage account its Projects' resource usage is reported under (Resource Management)
    usage_account: str = Field("", max_length=120)
    # Maven group (identifier) of what its Projects publish: Maven packages in its Artifacts repositories start with it
    maven_group: str = Field("", max_length=200, pattern=r"^([A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)?$")
    # deletion policy: when every one of these organizations has been deleted, the space is marked for deletion
    deletion_organizations: list[str] = Field(default_factory=list)


def _check_space_in(req: SpaceIn) -> dict:
    orgs = {o["id"] for o in auth._orgs()}
    if set(req.organizations) - orgs:
        raise HTTPException(400, "Unknown organization")
    known_roles = set(auth.ROLES) | {c["id"] for c in auth.custom_roles()}
    if set(req.role_set) - known_roles:
        raise HTTPException(400, "Unknown role in the role set")
    if req.role_set and not any("manage" in auth.role_operations(r) for r in req.role_set):
        raise HTTPException(400, "The role set needs a role that manages Projects (Owner)")
    users, groups = {u["id"] for u in auth._users()}, {g["id"] for g in auth._groups()}

    def grants(rows: list[dict]) -> list[dict]:
        out = []
        for r in rows:
            t, i, role = r.get("principal_type"), r.get("principal_id") or "*", r.get("role")
            if t not in ("user", "group", "everyone") or role not in known_roles or (t == "user" and i not in users) or (t == "group" and i not in groups):
                raise HTTPException(400, f"Bad inherited role {r}")
            out.append({"principal_type": t, "principal_id": "*" if t == "everyone" else i, "role": role})
        return out

    inherited, locked_inherited = grants(req.inherited_roles), grants(req.marketplace_inherited_roles)
    if req.max_classification and req.max_classification not in auth._category_index()[1]:
        raise HTTPException(400, "The maximum classification is a marking of a hierarchical (classification) category")
    if req.resource_queue:
        import resource_queues

        if req.resource_queue not in {q["id"] for q in resource_queues._load()["queues"]}:
            raise HTTPException(400, "Unknown resource queue")
    if set(req.deletion_organizations) - orgs:
        raise HTTPException(400, "Unknown organization in the deletion policy")
    if req.storage == "s3":
        import storage

        if not storage.enabled():
            raise HTTPException(400, "S3 storage is not configured on this platform")
    return {"storage": req.storage, "resource_queue": req.resource_queue or None, "usage_account": req.usage_account.strip(),
            "maven_group": req.maven_group.strip(), "deletion_organizations": sorted(set(req.deletion_organizations)),
            "max_classification": req.max_classification or None, "name": req.name.strip(), "description": req.description, "organizations": sorted(set(req.organizations)),
            "owners": _clean_space_principals(req.owners), "editors": _clean_space_principals(req.editors),
            "viewers": _clean_space_principals(req.viewers), "inherited_roles": inherited, "marketplace_inherited_roles": locked_inherited,
            "role_set": sorted(set(req.role_set))}


def _space_view(s: dict, p: dict) -> dict:
    projects = [r["id"] for r in _all("project") if r.get("space_id") == s["id"]]
    pending = bool(s.get("deletion_organizations")) and not set(s["deletion_organizations"]) & {o["id"] for o in auth._orgs()}
    return {**s, "my_role": space_role(s, p), "my_workflows": sorted(space_workflows(s, p)),
            "project_count": len(projects) if s["id"] != DEFAULT_SPACE else None, "deletion_pending": pending}


def setting_for(project_id: Optional[str], key: str) -> Any:
    """A space setting for the Project an item is in (None outside Projects or when unset)."""
    if not project_id:
        return None
    try:
        return space_of_project(project_id).get(key)
    except HTTPException:
        return None


@router.delete("/spaces/{sid}")
def delete_space(sid: str, request: Request) -> dict:
    """Delete a space (administrators): only an empty one (move or delete its Projects first) — typically one its
    deletion policy marked (every organization of the policy deleted)."""
    auth.require_admin()
    s = space(sid)
    if s.get("builtin"):
        raise HTTPException(400, "The Default space cannot be deleted")
    if any(r.get("space_id") == sid for r in _all("project")):
        raise HTTPException(409, "The space still has Projects: move them to another space first")
    for kind in ("template", "portfolio"):
        for r in _all(kind):
            if r.get("space_id") == sid:
                _delete(kind, r["id"])
    _delete("space", sid)
    auth.audit("space_deleted", None, s["name"], request)
    return {"deleted": sid}


@router.get("/spaces")
def list_spaces() -> list[dict]:
    p = _me()
    return [_space_view(s, p) for s in spaces() if space_access(s, p)]


@router.post("/spaces")
def create_space(req: SpaceIn, request: Request) -> dict:
    """A new space (administrators)."""
    p = auth.require_admin()
    if any(s["name"].lower() == req.name.strip().lower() for s in spaces()):
        raise HTTPException(409, "A space with that name exists")
    s = {"id": "space-" + uuid.uuid4().hex[:8], **_check_space_in(req), "created_at": _now(), "created_by": p.get("id")}
    if not s["owners"] and p.get("id") not in (None, "local"):
        s["owners"] = [f"user:{p['id']}"]
    _put("space", s)
    auth.audit("space_created", None, s["name"], request)
    return _space_view(s, p)


@router.put("/spaces/{sid}")
def update_space(sid: str, req: SpaceIn, request: Request) -> dict:
    """Change a space (its owners): access requirements, roles on the space, inherited roles, role set."""
    s = space(sid)
    p = _check_space(s, "manage_space")
    if s.get("builtin") and req.organizations and not _is_admin(p):
        raise HTTPException(403, "Only administrators restrict the Default space")
    s = {**{k: v for k, v in s.items() if k != "builtin"}, **_check_space_in(req), "updated_at": _now()}
    _put("space", s)
    auth.audit("space_changed", None, f"{s['name']}: organizations {s['organizations']}, inherited {s['inherited_roles']}, role set {s['role_set']}",
               request)
    return _space_view(s, p)


class SpaceRoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    workflows: list[str] = Field(default_factory=list)
    # "user:<id>", "group:<id>" or "everyone"
    grants: list[str] = Field(default_factory=list)


@router.get("/space-workflows")
def space_workflow_list() -> dict:
    """The workflows a role on a space can allow, and those of the default roles."""
    _me()
    return {"workflows": [{"id": k, "label": v} for k, v in SPACE_WORKFLOWS.items()],
            "defaults": {r: sorted(w) for r, w in DEFAULT_WORKFLOWS.items()}}


def _space_role_in(s: dict, req: SpaceRoleIn, rid: Optional[str]) -> dict:
    bad = set(req.workflows) - set(SPACE_WORKFLOWS)
    if bad:
        raise HTTPException(400, f"Unknown workflow {sorted(bad)[0]}")
    if not req.workflows:
        raise HTTPException(400, "Pick at least one workflow")
    name = req.name.strip()
    if name.lower() in DEFAULT_WORKFLOWS or any(r["name"].lower() == name.lower() and r["id"] != rid for r in s.get("custom_roles") or []):
        raise HTTPException(409, "A role with that name exists on this space")
    return {"id": rid or "srole-" + uuid.uuid4().hex[:8], "name": name, "workflows": sorted(set(req.workflows)),
            "grants": _clean_space_principals(req.grants)}


@router.post("/spaces/{sid}/roles")
def create_space_role(sid: str, req: SpaceRoleIn, request: Request) -> dict:
    """A custom space role (Space permissions): the workflows it allows and who holds it. Frozen: later workflows
    are not added to it."""
    s = space(sid)
    p = _check_space(s, "manage_space")
    r = _space_role_in(s, req, None)
    s = {**{k: v for k, v in s.items() if k != "builtin"}, "custom_roles": [*(s.get("custom_roles") or []), r]}
    _put("space", s)
    auth.audit("space_role_created", None, f"{s['name']}: {r['name']} ({', '.join(r['workflows'])})", request)
    return _space_view(s, p)


@router.put("/spaces/{sid}/roles/{rid}")
def update_space_role(sid: str, rid: str, req: SpaceRoleIn, request: Request) -> dict:
    s = space(sid)
    p = _check_space(s, "manage_space")
    if not any(r["id"] == rid for r in s.get("custom_roles") or []):
        raise HTTPException(404, "Role not found")
    r = _space_role_in(s, req, rid)
    s = {**{k: v for k, v in s.items() if k != "builtin"}, "custom_roles": [r if x["id"] == rid else x for x in s.get("custom_roles") or []]}
    _put("space", s)
    auth.audit("space_role_changed", None, f"{s['name']}: {r['name']} ({', '.join(r['workflows'])}; {len(r['grants'])} grants)", request)
    return _space_view(s, p)


@router.delete("/spaces/{sid}/roles/{rid}")
def delete_space_role(sid: str, rid: str, request: Request) -> dict:
    s = space(sid)
    p = _check_space(s, "manage_space")
    gone = next((r for r in s.get("custom_roles") or [] if r["id"] == rid), None)
    if not gone:
        raise HTTPException(404, "Role not found")
    s = {**{k: v for k, v in s.items() if k != "builtin"}, "custom_roles": [x for x in s["custom_roles"] if x["id"] != rid]}
    _put("space", s)
    auth.audit("space_role_deleted", None, f"{s['name']}: {gone['name']}", request)
    return _space_view(s, p)


@router.get("/spaces/{sid}/projects")
def space_projects(sid: str) -> list[dict]:
    import db

    s = space(sid)
    p = _check_space(s, "view_space")
    ids = {r["id"]: r for r in _all("project")}
    out = []
    for it in db.drive_list(None):
        if it.get("kind") != "project" or it.get("trashed_at"):
            continue
        rec = ids.get(it["id"]) or {"space_id": DEFAULT_SPACE}
        if rec.get("space_id", DEFAULT_SPACE) == s["id"] and auth.can_discover(it["id"], p):
            out.append({"id": it["id"], "name": it["name"], "portfolio_id": rec.get("portfolio_id"), "role": auth.role_for(it["id"], p)})
    return sorted(out, key=lambda x: x["name"].lower())


# ------------------------------------------------------------------------------------------------
# Projects: space, constraints, classification
# ------------------------------------------------------------------------------------------------


def _project_item(project_id: str) -> dict:
    import db

    it = db.drive_get(project_id)
    if not it or it.get("kind") != "project":
        raise HTTPException(404, "Project not found")
    return it


def _names(ids: list[str]) -> list[str]:
    return auth._marking_names(sorted(ids))


def _above_max(project_id: str, marks: set[str]) -> list[str]:
    """Classifications in `marks` above the maximum of the Project's space (same category, higher level)."""
    cap = space(project_record(project_id).get("space_id")).get("max_classification")
    if not cap:
        return []
    _, hier = auth._category_index()
    if cap not in hier:
        return []
    cat, level = hier[cap]
    return sorted(m for m in marks if m in hier and hier[m][0] == cat and hier[m][1] > level)


def violation(item_id: str, markings: Optional[set[str]] = None) -> Optional[str]:
    """Why an item's markings (or the markings it would have) violate its Project's constraints or its space's maximum
    classification (auth.CONSTRAINT_HOOK)."""
    project = auth.project_of(item_id)
    if not project:
        return None
    marks_all = set(auth.effective_markings(item_id) if markings is None else markings)
    over = _above_max(project, marks_all)
    if over:
        return f"{', '.join(_names(over))} is above the maximum classification of {auth._project_name(project)}'s space"
    c = (project_record(project).get("constraints") or {})
    mode, listed = c.get("mode") or "none", set(c.get("markings") or [])
    if mode == "none":
        return None
    marks = set(auth.effective_markings(item_id) if markings is None else markings)
    marks = {m for m in marks if not m.startswith("org:")}
    bad = marks - listed if mode == "allowed" else marks & listed
    if not bad:
        return None
    pname = auth._project_name(project)
    return (f"Project constraint of {pname}: the marking{'s' if len(bad) > 1 else ''} {', '.join(_names(list(bad)))} "
            f"{'are' if len(bad) > 1 else 'is'} {'not allowed' if mode == 'allowed' else 'prohibited'} in this Project")


def violations(project_id: str, constraints: Optional[dict] = None) -> list[dict]:
    """Files in a Project whose markings (with those inherited from inputs) violate its constraints."""
    import db

    c = constraints if constraints is not None else (project_record(project_id).get("constraints") or {})
    mode, listed = c.get("mode") or "none", set(c.get("markings") or [])
    capped = bool(space(project_record(project_id).get("space_id")).get("max_classification"))
    if mode == "none" and not capped:
        return []
    out = []
    for e in db.drive_subtree(project_id):
        marks = {m for m in auth.effective_markings(e["id"]) if not m.startswith("org:")}
        bad = (marks - listed if mode == "allowed" else marks & listed if mode == "prohibited" else set()) | set(_above_max(project_id, marks))
        if bad:
            out.append({"id": e["id"], "name": e.get("name"), "path": e.get("rel"), "kind": e.get("kind"), "markings": sorted(bad),
                        "marking_names": _names(list(bad))})
    return out


def _project_view(project_id: str) -> dict:
    rec = project_record(project_id)
    s = space(rec.get("space_id"))
    pf = _get("portfolio", rec.get("portfolio_id") or "") if rec.get("portfolio_id") else None
    c = rec.get("constraints") or {"mode": "none", "markings": []}
    return {"project_id": project_id, "space": {"id": s["id"], "name": s["name"], "organizations": s.get("organizations") or [],
                                                 "max_classification": s.get("max_classification"),
                                                 "inherited_roles": auth._roles_view_rows(space_of_project(project_id).get("inherited_roles") or []),
                                                 "role_set": s.get("role_set") or []},
            "marketplace": rec.get("marketplace_locked"),
            "portfolio": {"id": pf["id"], "name": pf["name"]} if pf else None,
            "constraints": {**c, "marking_names": _names(c.get("markings") or [])},
            "classification": rec.get("classification"), "template_id": rec.get("template_id"),
            "request_excluded_groups": rec.get("request_excluded_groups") or [],
            "violations": violations(project_id)}


@router.get("/projects/{project_id}")
def get_project(project_id: str) -> dict:
    _project_item(project_id)
    auth.check_project(project_id, "discoverer")
    return _project_view(project_id)


def lock_for_marketplace(project_id: str, product: dict) -> None:
    """Mark a Project a Marketplace installation created as locked (marketplace.py, after installing into it)."""
    rec = project_record(project_id)
    _put("project", {**rec, "marketplace_locked": product})


class ExcludedIn(BaseModel):
    groups: list[str] = Field(default_factory=list)


@router.put("/projects/{project_id}/request-excluded-groups")
def set_request_excluded(project_id: str, req: ExcludedIn, request: Request) -> dict:
    """Groups hidden from this Project's access request form (its Owners): users cannot ask to join them here; a group
    can stay requestable through other Projects."""
    _project_item(project_id)
    auth.check_project(project_id, "owner")
    known = {g["id"] for g in auth._groups()}
    if set(req.groups) - known:
        raise HTTPException(400, "Unknown group")
    _put("project", {**project_record(project_id), "request_excluded_groups": sorted(set(req.groups))})
    auth.audit("project_request_form_changed", None, f"{project_id}: {len(req.groups)} groups hidden", request)
    return _project_view(project_id)


@router.post("/projects/{project_id}/unlock")
def unlock_project(project_id: str, request: Request) -> dict:
    """Unlock a Marketplace Project (administrators): its own roles and the space's regular inherited roles apply
    again, and it can be edited (later Marketplace upgrades no longer manage it)."""
    auth.require_admin()
    rec = project_record(project_id)
    if not rec.get("marketplace_locked"):
        raise HTTPException(400, "The Project is not locked")
    _put("project", {**{k: v for k, v in rec.items() if k != "marketplace_locked"}, "unlocked_from": rec["marketplace_locked"]})
    auth.audit("project_unlocked", None, f"{project_id}: {rec['marketplace_locked'].get('name', '')}", request)
    return _project_view(project_id)


class ConstraintsIn(BaseModel):
    mode: str = Field(pattern="^(none|allowed|prohibited)$")
    markings: list[str] = Field(default_factory=list)


@router.put("/projects/{project_id}/constraints")
def set_constraints(project_id: str, req: ConstraintsIn, request: Request) -> dict:
    """Project constraints (its Owners, with the Apply permission on every marking listed). Refused when files in the
    Project would violate them."""
    _project_item(project_id)
    auth.check_project(project_id, "owner")
    known = {m["id"]: m for m in auth._markings()}
    if set(req.markings) - set(known):
        raise HTTPException(400, "Unknown marking")
    for mid in req.markings:
        if not auth.marking_permissions(known[mid])["apply"]:
            raise HTTPException(403, f"Listing {known[mid]['name']} in a constraint needs its Apply permission")
    c = {"mode": req.mode, "markings": sorted(set(req.markings)) if req.mode != "none" else []}
    bad = violations(project_id, c)
    if bad:
        raise HTTPException(409, f"{len(bad)} file{'s' if len(bad) != 1 else ''} in the Project would violate this constraint, e.g. "
                                 f"{bad[0]['name']} ({', '.join(bad[0]['marking_names'])})")
    rec = {**project_record(project_id), "constraints": c, "updated_at": _now()}
    _put("project", rec)
    auth.audit("project_constraints_changed", None, f"{auth._project_name(project_id)}: {c['mode']} {', '.join(_names(c['markings']))}", request)
    return _project_view(project_id)


class MoveIn(BaseModel):
    space_id: str


@router.put("/projects/{project_id}/space")
def move_project(project_id: str, req: MoveIn, request: Request) -> dict:
    """Move a Project to another space (administrators): the new space's access requirements and inherited roles apply."""
    auth.require_admin()
    _project_item(project_id)
    s = space(req.space_id)
    rec = {**project_record(project_id), "space_id": s["id"], "portfolio_id": None}
    _put("project", rec)
    auth.audit("project_moved", None, f"{auth._project_name(project_id)} → {s['name']}", request)
    return _project_view(project_id)


class NewProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    space_id: Optional[str] = None
    template_id: Optional[str] = None
    variables: dict[str, str] = Field(default_factory=dict)
    portfolio_id: Optional[str] = None
    # a classification marking (hierarchical category): required when Control Panel → Security asks for one
    classification: Optional[str] = None


VAR = re.compile(r"\{\{\s*([A-Za-z0-9_ ]+?)\s*\}\}")


def _subst(text: str, values: dict[str, str]) -> str:
    return VAR.sub(lambda m: values.get(m.group(1).strip(), m.group(0)), text or "")


def _classification(mid: Optional[str], s: Optional[dict] = None) -> Optional[str]:
    if not mid:
        if auth.settings().get("require_project_classification"):
            raise HTTPException(400, "Choose a classification for the Project (Control Panel → Security requires one)")
        return None
    _, hier = auth._category_index()
    if mid not in hier:
        raise HTTPException(400, "A classification is a marking of a hierarchical (classification) category")
    cap = (s or {}).get("max_classification")
    if cap in hier and hier[cap][0] == hier[mid][0] and hier[mid][1] > hier[cap][1]:
        raise HTTPException(400, f"{_names([mid])[0]} is above the space's maximum classification {_names([cap])[0]}")
    return mid


@router.post("/projects")
def create_project(req: NewProjectIn, request: Request) -> dict:
    """Create a Project in a space (its editors), from a template when given: folders, roles, new groups and markings,
    markings on the Project and constraints. The creator becomes an Owner unless the template says otherwise."""
    import db
    import drive

    s = space(req.space_id)
    p = _check_space(s, "create_projects")
    t = _get("template", req.template_id) if req.template_id else None
    if req.template_id and (not t or t.get("space_id") != s["id"]):
        raise HTTPException(400, "That template is not one of this space's")
    classification = _classification(req.classification, s)
    values = {**{v: "" for v in (t or {}).get("variables") or []}, **{k: v.strip() for k, v in req.variables.items()}, "project name": req.name.strip()}
    missing = [v for v in (t or {}).get("variables") or [] if not values.get(v)]
    if missing:
        raise HTTPException(400, f"Fill in the template variable{'s' if len(missing) > 1 else ''} {', '.join(missing)}")
    if t and (t.get("new_groups") or t.get("new_markings")) and "deploy_privileged_templates" not in space_workflows(s, p):
        raise HTTPException(403, "This template creates groups or markings: an owner of the space (or a role allowing it) deploys it")
    name = drive._clean_name(_subst(req.name, values))
    if db.drive_name_taken(None, name):
        raise HTTPException(409, f'"{name}" already exists')
    pf = None
    if req.portfolio_id:
        pf = _get("portfolio", req.portfolio_id)
        if not pf or pf.get("space_id") != s["id"]:
            raise HTTPException(400, "That portfolio is not in this space")
    project_id = drive._insert_container(None, "project", name)
    # roles: the template's (the creator, users, groups, new groups, default role), else the creator as Owner
    new_groups: dict[str, str] = {}
    creator = [p["id"]] if p.get("id") not in (None, "local") else []
    for i, g in enumerate((t or {}).get("new_groups") or []):
        gname = _subst(g.get("name") or f"group {i + 1}", values)
        if any(x["name"].lower() == gname.lower() for x in auth._groups()):
            raise HTTPException(409, f"A group called {gname} exists: choose other variable values")
        rec = {"id": "grp-" + uuid.uuid4().hex[:8], "name": gname, "description": f"Made by the template {t['name']} for {name}", "members": [],
               "markings": [], "managers": creator, "created_at": _now()}
        auth._put_record("groups", rec)
        auth.audit("group_created", None, f"{gname} (template {t['name']})", request)
        new_groups[str(i)] = rec["id"]
    mg = (t or {}).get("manager_group")
    if mg is not None and str(mg) in new_groups:
        for i, gid in new_groups.items():
            if i != str(mg):
                g = next(x for x in auth._groups() if x["id"] == gid)
                g["manager_groups"] = [new_groups[str(mg)]]
                auth._put_record("groups", g)
    grants: dict[tuple[str, str], str] = {}
    creator_role = (t or {}).get("creator_role", "owner")
    if creator_role and p.get("id") not in (None, "local"):
        grants[("user", p["id"])] = creator_role
    for r in (t or {}).get("roles") or []:
        who, role = r.get("principal") or "", r.get("role")
        if who.startswith("newgroup:") and who[9:] in new_groups:
            grants[("group", new_groups[who[9:]])] = role
        elif who.startswith(("user:", "group:")):
            kind, _, rid = who.partition(":")
            grants[(kind, rid)] = role
        elif who == "everyone":
            grants[("everyone", "*")] = role
    if (t or {}).get("default_role") in ("discoverer", "viewer", "editor"):
        grants.setdefault(("everyone", "*"), t["default_role"])
    elif not t:
        default = auth.settings()["project_default_role"]
        if default in ("discoverer", "viewer", "editor"):
            grants.setdefault(("everyone", "*"), default)
    if s.get("role_set"):
        bad = {r for r in grants.values() if r not in s["role_set"]}
        if bad:
            raise HTTPException(400, f"The space's role set does not include {', '.join(auth.role_label(b) for b in bad)}")
    with auth._lock, auth._db() as con:
        for (kind, rid), role in grants.items():
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                        (project_id, kind, rid, role))
    auth._roles_cache.clear()
    auth._project_cache.clear()
    # markings: new ones (granted to everyone given a role), existing ones, the classification
    marks = list((t or {}).get("markings") or [])
    new_marks = []
    for m in (t or {}).get("new_markings") or []:
        mname = _subst(m.get("name") or "marking", values)
        if any(x["name"].lower() == mname.lower() for x in auth._markings()):
            raise HTTPException(409, f"A marking called {mname} exists: choose other variable values")
        rec = {"id": "mk-" + uuid.uuid4().hex[:8], "name": mname, "description": _subst(m.get("description") or "", values), "color": "#c0392b",
               "managers": creator, "category_id": auth.DEFAULT_CATEGORY, "manage": [f"user:{u}" for u in creator], "apply": [], "remove": [],
               "created_at": _now()}
        with auth._lock, auth._db() as con:
            con.execute("INSERT INTO markings (id, record) VALUES (?, ?)", (rec["id"], json.dumps(rec)))
        auth._disj_cache = (0.0, ({}, {}))
        auth.audit("marking_created", None, f"{mname} (template {t['name']})")
        new_marks.append(rec["id"])
    if new_marks:
        members = {rid for (kind, rid) in grants if kind == "user"}
        for gid in {rid for (kind, rid) in grants if kind == "group"}:
            g = next((x for x in auth._groups() if x["id"] == gid), None)
            if g:
                g["markings"] = sorted(set(g.get("markings") or []) | set(new_marks))
                auth._put_record("groups", g)
        for uid in members:
            try:
                u = auth._user(uid)
            except HTTPException:
                continue
            u["markings"] = sorted(set(u.get("markings") or []) | set(new_marks))
            auth._save_user(u)
    marks += new_marks
    if classification:
        marks.append(classification)
    if marks:
        auth._set_item(project_id, own=sorted(set(marks)))
    # constraints and folders
    c = dict((t or {}).get("constraints") or {"mode": "none", "markings": []})
    if c.get("mode") == "allowed":
        c["markings"] = sorted(set(c.get("markings") or []) | set(new_marks) | ({classification} if classification else set()))
    for path in (t or {}).get("folders") or []:
        parent = project_id
        for part in [x for x in _subst(path, values).split("/") if x.strip()]:
            hit = next((i for i in db.drive_list(parent) if i["name"] == part.strip() and i["kind"] == "folder"), None)
            parent = hit["id"] if hit else drive._insert_container(parent, "folder", drive._clean_name(part))
    _put("project", {"id": project_id, "space_id": s["id"], "portfolio_id": pf["id"] if pf else None, "constraints": c,
                     "classification": classification, "template_id": t["id"] if t else None, "created_at": _now()})
    if pf:
        pf["projects"] = sorted(set(pf.get("projects") or []) | {project_id})
        _put("portfolio", pf)
    auth.audit("project_created", None, f"{name} in {s['name']}" + (f" from {t['name']}" if t else ""), request)
    return {**drive._public({**db.drive_get(project_id), "items": 0}), "governance": _project_view(project_id)}


# ------------------------------------------------------------------------------------------------
# Project templates
# ------------------------------------------------------------------------------------------------


class TemplateIn(BaseModel):
    space_id: str = DEFAULT_SPACE
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    variables: list[str] = Field(default_factory=list)
    # the creator's role (None: none)
    creator_role: Optional[str] = "owner"
    # [{principal: "user:<id>" | "group:<id>" | "newgroup:<index>" | "everyone", role}]
    roles: list[dict] = Field(default_factory=list)
    default_role: Optional[str] = None
    # [{name}] created at deployment; `manager_group` (an index) is the new group whose members manage the others
    new_groups: list[dict] = Field(default_factory=list)
    manager_group: Optional[int] = None
    new_markings: list[dict] = Field(default_factory=list)
    markings: list[str] = Field(default_factory=list)
    constraints: dict = Field(default_factory=lambda: {"mode": "none", "markings": []})
    folders: list[str] = Field(default_factory=list)


def _check_template(req: TemplateIn) -> dict:
    known_roles = set(auth.ROLES) | {c["id"] for c in auth.custom_roles()}
    for r in [req.creator_role] if req.creator_role else []:
        if r not in known_roles:
            raise HTTPException(400, f"Unknown role {r}")
    for r in req.roles:
        if r.get("role") not in known_roles:
            raise HTTPException(400, f"Unknown role {r.get('role')}")
        who = str(r.get("principal") or "")
        if not (who == "everyone" or who.startswith(("user:", "group:")) or (who.startswith("newgroup:") and who[9:].isdigit() and int(who[9:]) < len(req.new_groups))):
            raise HTTPException(400, f"Unknown principal {who}")
        if who.startswith(("user:", "group:")):
            auth._clean_principals([who])
    if req.default_role not in (None, "", "discoverer", "viewer", "editor"):
        raise HTTPException(400, "The default role is discoverer, viewer or editor")
    if set(req.markings) - {m["id"] for m in auth._markings()}:
        raise HTTPException(400, "Unknown marking")
    c = req.constraints or {}
    if c.get("mode", "none") not in ("none", "allowed", "prohibited"):
        raise HTTPException(400, "Constraint mode is none, allowed or prohibited")
    used = set(VAR.findall(" ".join([*(g.get("name", "") for g in req.new_groups), *(m.get("name", "") for m in req.new_markings), *req.folders])))
    unknown = {u.strip() for u in used} - {v.strip() for v in req.variables} - {"project name"}
    if unknown:
        raise HTTPException(400, f"Undeclared variable {', '.join(sorted(unknown))}")
    if req.manager_group is not None and not 0 <= req.manager_group < len(req.new_groups):
        raise HTTPException(400, "The manager group is one of the new groups")
    return {**req.model_dump(), "constraints": {"mode": c.get("mode", "none"), "markings": sorted(set(c.get("markings") or []))}}


@router.get("/templates")
def list_templates(space_id: Optional[str] = None) -> list[dict]:
    p = _me()
    return [t for t in _all("template") if (space_id is None or t["space_id"] == space_id) and space_access(space(t["space_id"]), p)]


@router.post("/templates")
def create_template(req: TemplateIn, request: Request) -> dict:
    """A Project template of a space (its owners)."""
    _check_space(space(req.space_id), "manage_templates")
    t = {"id": "tpl-" + uuid.uuid4().hex[:8], **_check_template(req), "created_at": _now()}
    _put("template", t)
    auth.audit("project_template_created", None, t["name"], request)
    return t


@router.put("/templates/{tid}")
def update_template(tid: str, req: TemplateIn, request: Request) -> dict:
    t = _get("template", tid)
    if not t:
        raise HTTPException(404, "Template not found")
    _check_space(space(t["space_id"]), "manage_templates")
    if req.space_id != t["space_id"]:
        raise HTTPException(400, "A template stays in its space")
    t = {**t, **_check_template(req), "updated_at": _now()}
    _put("template", t)
    auth.audit("project_template_changed", None, t["name"], request)
    return t


@router.delete("/templates/{tid}")
def delete_template(tid: str, request: Request) -> dict:
    t = _get("template", tid)
    if not t:
        raise HTTPException(404, "Template not found")
    _check_space(space(t["space_id"]), "manage_templates")
    _delete("template", tid)
    auth.audit("project_template_deleted", None, t["name"], request)
    return {"deleted": tid}


# ------------------------------------------------------------------------------------------------
# Portfolios
# ------------------------------------------------------------------------------------------------


class PortfolioIn(BaseModel):
    space_id: str = DEFAULT_SPACE
    name: str = Field(min_length=1, max_length=80)
    description: str = Field("", max_length=500)
    color: str = "#2f6fdf"
    curators: list[str] = Field(default_factory=list)
    documentation: str = Field("", max_length=50000)
    # Files resources promoted in the portfolio's catalog
    promoted: list[str] = Field(default_factory=list)
    # the thumbnail: an image in Files (None: the logo color)
    thumbnail_item_id: Optional[str] = None


def _can_curate(pf: dict, p: dict) -> bool:
    return "manage_portfolios" in space_workflows(space(pf["space_id"]), p) or bool(auth._principal_keys(p) & set(pf.get("curators") or []))


def _portfolio_view(pf: dict, p: dict) -> dict:
    import db

    projects = []
    for pid in pf.get("projects") or []:
        it = db.drive_get(pid)
        if it and not it.get("trashed_at") and auth.can_discover(pid, p):
            projects.append({"id": pid, "name": (pf.get("display_names") or {}).get(pid) or it["name"], "role": auth.role_for(pid, p)})
    promoted = []
    for iid in pf.get("promoted") or []:
        it = db.drive_get(iid)
        if it and auth.can_discover(iid, p):
            promoted.append({"id": iid, "name": it["name"], "kind": it["kind"], "project_id": auth.project_of(iid)})
    return {**pf, "projects": projects, "hidden_projects": len(pf.get("projects") or []) - len(projects), "promoted": promoted,
            "can_curate": _can_curate(pf, p)}


@router.get("/portfolios")
def list_portfolios(space_id: Optional[str] = None) -> list[dict]:
    p = _me()
    return [_portfolio_view(pf, p) for pf in _all("portfolio")
            if (space_id is None or pf["space_id"] == space_id) and space_access(space(pf["space_id"]), p)]


@router.get("/portfolios/{pid}")
def get_portfolio(pid: str) -> dict:
    p = _me()
    pf = _get("portfolio", pid)
    if not pf or not space_access(space(pf["space_id"]), p):
        raise HTTPException(404, "Portfolio not found")
    return _portfolio_view(pf, p)


@router.post("/portfolios")
def create_portfolio(req: PortfolioIn, request: Request) -> dict:
    """A portfolio in a space (its editors); its creator curates it."""
    s = space(req.space_id)
    p = _check_space(s, "manage_portfolios")
    if any(x["space_id"] == s["id"] and x["name"].lower() == req.name.strip().lower() for x in _all("portfolio")):
        raise HTTPException(409, "A portfolio with that name exists in this space")
    curators = auth._clean_principals(req.curators)
    if p.get("id") not in (None, "local"):
        curators = sorted(set(curators) | {f"user:{p['id']}"})
    pf = {"id": "pf-" + uuid.uuid4().hex[:8], "space_id": s["id"], "name": req.name.strip(), "description": req.description, "color": req.color,
          "curators": curators, "documentation": req.documentation, "promoted": [], "projects": [], "display_names": {}, "created_at": _now()}
    _put("portfolio", pf)
    auth.audit("portfolio_created", None, pf["name"], request)
    return _portfolio_view(pf, p)


@router.put("/portfolios/{pid}")
def update_portfolio(pid: str, req: PortfolioIn) -> dict:
    """Name, description, logo color, curators, documentation and promoted resources (curators). A portfolio stays in
    its space."""
    p = _me()
    pf = _get("portfolio", pid)
    if not pf:
        raise HTTPException(404, "Portfolio not found")
    if not _can_curate(pf, p):
        raise HTTPException(403, "Only the portfolio's curators and the space's editors change it")
    if req.space_id != pf["space_id"]:
        raise HTTPException(400, "Portfolios cannot move between spaces")
    for iid in req.promoted:
        auth.check_item_id(iid, "discoverer")
    if req.thumbnail_item_id:
        import db

        auth.check_item_id(req.thumbnail_item_id, "viewer")
        if not str((db.drive_get(req.thumbnail_item_id) or {}).get("content_type") or "").startswith("image/"):
            raise HTTPException(400, "The thumbnail is an image")
    pf.update(name=req.name.strip(), description=req.description, color=req.color, curators=auth._clean_principals(req.curators),
              documentation=req.documentation, promoted=list(dict.fromkeys(req.promoted)), thumbnail_item_id=req.thumbnail_item_id, updated_at=_now())
    _put("portfolio", pf)
    return _portfolio_view(pf, p)


class PortfolioProjectsIn(BaseModel):
    projects: list[str]
    # optional display names per Project in this portfolio
    display_names: dict[str, str] = Field(default_factory=dict)


@router.put("/portfolios/{pid}/projects")
def set_portfolio_projects(pid: str, req: PortfolioProjectsIn, request: Request) -> dict:
    """The portfolio's Projects (curators): Projects of the same space; a Project leaves any other portfolio."""
    p = _me()
    pf = _get("portfolio", pid)
    if not pf:
        raise HTTPException(404, "Portfolio not found")
    if not _can_curate(pf, p):
        raise HTTPException(403, "Only the portfolio's curators and the space's editors change its Projects")
    want = list(dict.fromkeys(req.projects))
    for proj in want:
        _project_item(proj)
        if project_record(proj).get("space_id", DEFAULT_SPACE) != pf["space_id"]:
            raise HTTPException(400, f"{auth._project_name(proj)} is in another space")
    for other in _all("portfolio"):
        if other["id"] != pid and set(other.get("projects") or []) & set(want):
            other["projects"] = [x for x in other.get("projects") or [] if x not in want]
            _put("portfolio", other)
    for proj in set(pf.get("projects") or []) - set(want):
        rec = project_record(proj)
        if rec.get("portfolio_id") == pid:
            _put("project", {**rec, "portfolio_id": None})
    for proj in want:
        _put("project", {**project_record(proj), "portfolio_id": pid})
    pf.update(projects=want, display_names={k: v.strip() for k, v in req.display_names.items() if k in want and v.strip()}, updated_at=_now())
    _put("portfolio", pf)
    auth.audit("portfolio_projects_changed", None, f"{pf['name']}: {len(want)} projects", request)
    return _portfolio_view(pf, p)


@router.delete("/portfolios/{pid}")
def delete_portfolio(pid: str, request: Request) -> dict:
    p = _me()
    pf = _get("portfolio", pid)
    if not pf:
        raise HTTPException(404, "Portfolio not found")
    if "manage_portfolios" not in space_workflows(space(pf["space_id"]), p):
        raise HTTPException(403, "Only the space's editors (or a role allowing it) delete portfolios")
    for proj in pf.get("projects") or []:
        rec = project_record(proj)
        if rec.get("portfolio_id") == pid:
            _put("project", {**rec, "portfolio_id": None})
    _delete("portfolio", pid)
    auth.audit("portfolio_deleted", None, pf["name"], request)
    return {"deleted": pid}
