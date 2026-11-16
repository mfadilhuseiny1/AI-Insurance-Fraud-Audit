"""Restricted views (Security & Governance docs 03 / 04 "Restricted views", "Manage restricted views").

A restricted view is a read layer on a backing dataset: a granular policy (the same conditions as object security
policies, ontology_security.py — the user's ID, groups, organization, markings or attributes compared with the row's
column values or constants, in all / any groups; NOT conditions refused) decides which rows each reader sees. It is a
resource of its own (`restricted_view:<id>`): it sits in a Project (Viewer reads, Editor changes, as code
repositories), inherits the backing dataset's markings (removing one — "Stop propagating" — needs that marking's
Remove permission, as a removal), and keeps its policy history as transactions.

Like Foundry it cannot feed batch derivations: it is not a Files dataset, so pipelines, transforms and Code
Workbooks cannot take it as an input (an integrity property — the policy filters reads, it does not follow the rows
into exports or function results). It is read here (rows, SQL Studio as `ri.foundry.main.restricted-view.<id>`).

Creating one needs Viewer on the backing dataset and Editor on the Project it goes in.
Store: data/restricted-views/<id>.json. Mounted by server.py under /api/restricted-views.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/restricted-views", tags=["restricted-views"])
log = logging.getLogger("bluesandai.restricted_views")
DIR = Path("data/restricted-views")
RID = "ri.foundry.main.restricted-view."
_lock = threading.RLock()
KIND = "restricted_view"


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "restricted-views"
    DIR.mkdir(parents=True, exist_ok=True)
    auth.RESOURCE_KINDS[KIND] = "restricted view"
    auth.RESOURCE_MARKING_HOOKS[KIND] = inherited_markings
    auth.RESOURCE_PROJECT_HOOKS[KIND] = lambda rid: (_read(rid) or {}).get("project_id")
    if not any(k == KIND for _, k in auth.RESOURCE_PATHS):
        auth.RESOURCE_PATHS = (*auth.RESOURCE_PATHS, (re.compile(r"^/api/restricted-views/([0-9a-f]{12})(?:/|$)"), KIND))
    try:
        _install_branch_hooks()
    except Exception:  # noqa: BLE001 - the ontology may be configured later; branching is optional
        log.exception("restricted view branch hooks")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _path(rid: str) -> Path:
    if not rid.replace("-", "").isalnum():
        raise HTTPException(404, "restricted view not found")
    return DIR / f"{rid}.json"


def _read(rid: str) -> Optional[dict]:
    try:
        return json.loads(_path(rid).read_text("utf-8"))
    except (OSError, ValueError, HTTPException):
        return None


def _write(rec: dict) -> dict:
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        tmp = _path(rec["id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, indent=1), "utf-8")
        tmp.replace(_path(rec["id"]))
    return rec


def _all() -> list[dict]:
    out = []
    for p in DIR.glob("*.json"):
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return out


def backing_item_id(rec: dict) -> str:
    """The dataset the view reads: the backing dataset, or its copy on the view's branch."""
    branch = rec.get("branch")
    if not branch or branch == "master":
        return rec["backing_item_id"]
    import dataset_preview
    import db

    item = db.drive_get(rec["backing_item_id"]) or {"id": rec["backing_item_id"], "kind": "file", "name": ""}
    hit = next((b for b in dataset_preview.branches(item) if b["branch"] == branch), None)
    if not hit:
        raise HTTPException(409, f'the backing dataset has no branch "{branch}" (any more)')
    return hit["item_id"]


def inherited_markings(rid: str) -> list[str]:
    """The backing dataset's markings (with its folders' and inputs'), less those this view stops propagating."""
    rec = _read(rid)
    if not rec:
        return []
    try:
        src = backing_item_id(rec)
    except HTTPException:
        src = rec["backing_item_id"]
    return sorted((auth.effective_markings(src) | auth.effective_markings(rec["backing_item_id"])) - set(rec.get("stop_propagating") or []))


def _get(rid: str, need: str = "viewer") -> dict:
    rec = _read(rid)
    if not rec:
        raise HTTPException(404, "restricted view not found")
    auth.check_resource(KIND, rid, need)
    return rec


def _backing_table(rec: dict) -> pa.Table:
    """The backing dataset's rows (read as the system: the view's own markings and policy decide what a reader sees).
    Readers need the view (its Project role and markings, checked by _get), not a role on the backing dataset's Project."""
    import dataset_preview
    import run_as

    with run_as.acting_as({"id": "system", "username": "system", "role": "service", "markings": None, "service": True}):
        item, kind = dataset_preview._dataset(backing_item_id(rec))
        return dataset_preview.table(item, kind)


def _user() -> dict:
    p = auth.current() or {}
    return {"id": p.get("id"), "groups": p.get("groups") or [], "organization_id": p.get("organization_id"),
            "markings": sorted(p.get("markings") or []), "attributes": p.get("attributes") or {}}


def visible_table(rec: dict, user: Optional[dict] = None) -> pa.Table:
    """The rows of the backing dataset this reader's attributes pass the policy for (the system sees every row)."""
    import ontology_security as osec

    t = _backing_table(rec)
    p = auth.current()
    if user is None and (not auth.enabled() or p is None or p.get("service")):
        return t
    u = user or _user()
    rows = t.to_pylist()
    keep = [i for i, r in enumerate(rows) if osec.evaluate(rec.get("policy"), u, r)]
    return t.take(pa.array(keep, type=pa.int64())) if len(keep) != t.num_rows else t


def _view(rec: dict) -> dict:
    import db

    item = db.drive_get(rec["backing_item_id"]) or {}
    marks = inherited_markings(rec["id"])
    return {**{k: v for k, v in rec.items() if k != "history"}, "rid": RID + rec["id"], "backing_name": item.get("name"),
            "markings": [{"id": m, "name": n} for m, n in zip(marks, auth._marking_names(marks))],
            "stop_propagating_names": auth._marking_names(sorted(rec.get("stop_propagating") or [])),
            "transactions": len(rec.get("history") or []), "my_role": auth.role_for(rec.get("project_id")) if rec.get("project_id") else None}


class ViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    project_id: str
    backing_item_id: str
    # a granular policy: {kind: and|or, children: [...]} / {kind: condition, op, left, right}; sides compare the user
    # (user_id, user_groups, user_organization, user_markings, user_attribute) with a column ("property") or a value
    policy: dict
    stop_propagating: list[str] = Field(default_factory=list)
    # a branch of the backing dataset (its copy built on that branch); default master
    branch: Optional[str] = None


class ViewChange(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=2000)
    policy: Optional[dict] = None
    stop_propagating: Optional[list[str]] = None
    branch: Optional[str] = None


def _check_policy(policy: dict, columns: set[str]) -> None:
    import ontology_security as osec

    if not policy:
        raise HTTPException(400, "A restricted view needs a policy (rows nobody's attributes match stay hidden)")
    osec._check_node(policy, columns, "restricted view policy")
    if osec._weight(policy) > 25:
        raise HTTPException(400, "The policy has more than 25 comparisons")


def _check_unmark(rid: str, backing: str, before: set[str], after: set[str]) -> None:
    """Stopping a marking's propagation removes it from the view (Remove permission); restarting applies it."""
    marks = auth.effective_markings(backing)
    if after - marks:
        raise HTTPException(400, "Only markings the backing dataset carries can stop propagating")
    auth.check_marking_change(auth.resource_id(KIND, rid), before - after, after - before)


@router.get("")
def list_views(project_id: Optional[str] = None) -> list[dict]:
    rows = [r for r in _all() if project_id is None or r.get("project_id") == project_id]
    return sorted((_view(r) for r in auth.visible_resources(KIND, rows)), key=lambda r: r["name"].lower())


@router.post("")
def create_view(req: ViewIn, request: Request) -> dict:
    """A restricted view on a dataset (Viewer on the dataset, Editor on the Project it goes in)."""
    import db

    auth.require_user()
    auth.check_item_id(req.backing_item_id, "viewer")
    proj = db.drive_get(req.project_id)
    if not proj or proj.get("kind") != "project":
        raise HTTPException(400, "Choose a Project for the restricted view")
    auth.check_project(req.project_id, "editor")
    rid = uuid.uuid4().hex[:12]
    rec = {"id": rid, "name": req.name.strip(), "description": req.description, "project_id": req.project_id, "backing_item_id": req.backing_item_id,
           "policy": req.policy, "stop_propagating": [], "created_at": _now(), "created_by": auth.actor_id(), "history": [],
           "branch": (req.branch or "master").strip() or "master"}
    auth.check_item_id(backing_item_id(rec), "viewer")
    _check_policy(req.policy, set(_backing_table(rec).column_names))
    if req.stop_propagating:
        _check_unmark(rid, req.backing_item_id, set(), set(req.stop_propagating))
        rec["stop_propagating"] = sorted(set(req.stop_propagating))
    rec["history"].append({"at": _now(), "by": auth.actor_id(), "policy": req.policy, "stop_propagating": rec["stop_propagating"]})
    _write(rec)
    auth.audit("restricted_view_created", None, f"{rec['name']} on {req.backing_item_id}", request)
    return _view(rec)


@router.get("/{rid}")
def get_view(rid: str) -> dict:
    rec = _get(rid)
    out = _view(rec)
    # the policy's statements are shown to those who edit the view (Edit restricted view)
    if "edit" not in auth.operations_for(rec.get("project_id")):
        out.pop("policy", None)
    return out


@router.put("/{rid}")
def update_view(rid: str, req: ViewChange, request: Request) -> dict:
    """Change the name, policy or stopped markings (Editor); every policy change is a transaction."""
    rec = _get(rid, "editor")
    changed = False
    if req.name is not None:
        rec["name"] = req.name.strip()
    if req.description is not None:
        rec["description"] = req.description
    if req.branch is not None and (req.branch or "master") != rec.get("branch", "master"):
        rec["branch"], changed = req.branch or "master", True
        auth.check_item_id(backing_item_id(rec), "viewer")
    policy_change = req.policy is not None and json.dumps(req.policy, sort_keys=True) != json.dumps(rec.get("policy"), sort_keys=True)
    marks_change = req.stop_propagating is not None and sorted(req.stop_propagating) != sorted(rec.get("stop_propagating") or [])
    if rec.get("protected") and (policy_change or marks_change):
        raise HTTPException(409, "This view's main branch is protected: change its policy or markings on a global branch and merge them")
    if req.policy is not None:
        _check_policy(req.policy, set(_backing_table(rec).column_names))
        rec["policy"], changed = req.policy, True
    if req.stop_propagating is not None:
        before, after = set(rec.get("stop_propagating") or []), set(req.stop_propagating)
        if before != after:
            _check_unmark(rid, rec["backing_item_id"], before, after)
            rec["stop_propagating"], changed = sorted(after), True
    if changed:
        rec.setdefault("history", []).append({"at": _now(), "by": auth.actor_id(), "policy": rec["policy"], "stop_propagating": rec["stop_propagating"],
                                              "branch": rec.get("branch", "master")})
    rec["updated_at"] = _now()
    _write(rec)
    if req.policy is not None:
        # object types backed by this view follow its policy (apply_to_object_type linked them)
        for tid in list(rec.get("object_types") or []):
            try:
                apply_to_object_type(rid, ObjectTypeIn(object_type_id=tid), request)
            except HTTPException as e:
                log.warning("restricted view %s: object type %s not updated: %s", rid, tid, e.detail)
    auth.audit("restricted_view_changed", None, rec["name"], request)
    return _view(rec)


@router.get("/{rid}/transactions")
def transactions(rid: str) -> list[dict]:
    rec = _get(rid, "editor")
    return list(reversed(rec.get("history") or []))


@router.get("/{rid}/rows")
def rows(rid: str, limit: int = 200, offset: int = 0, request: Request = None) -> dict:  # type: ignore[assignment]
    """The rows the caller may see (their attributes against the policy); for a build, the rows its user may see."""
    import build_calls

    build_calls.enforce(request, ("read", f"resource:{KIND}", rid, None))
    with build_calls.acting_for(request):
        return _rows(rid, limit, offset)


def _rows(rid: str, limit: int, offset: int) -> dict:
    import dataset_reader as R

    rec = _get(rid)
    t = visible_table(rec)
    page = t.slice(max(0, offset), max(1, min(limit, 5000)))
    return {"columns": [{"name": f.name, "type": str(f.type)} for f in t.schema], "rows": R.json_rows(page), "total_rows": t.num_rows}


class PreviewIn(BaseModel):
    policy: dict
    # a user to evaluate for (administrators); default: me
    user_id: Optional[str] = None
    backing_item_id: Optional[str] = None


@router.post("/{rid}/preview")
def preview(rid: str, req: PreviewIn) -> dict:
    """How many rows an (unsaved) policy shows a user (Editor; another user's view: administrators)."""
    rec = dict(_get(rid, "editor"))
    _check_policy(req.policy, set(_backing_table(rec).column_names))
    rec["policy"] = req.policy
    user = None
    if req.user_id:
        auth.require_admin()
        u = auth._user(req.user_id)
        pub = auth._public_user(u)
        user = {"id": u["id"], "groups": pub["groups"], "organization_id": u.get("organization_id"), "markings": sorted(auth.user_markings(u)),
                "attributes": u.get("attributes") or {}}
    t = visible_table(rec, user or _user())
    return {"visible_rows": t.num_rows, "total_rows": _backing_table(rec).num_rows}


@router.delete("/{rid}")
def delete_view(rid: str, request: Request) -> dict:
    rec = _get(rid, "editor")
    _path(rid).unlink(missing_ok=True)
    auth.audit("restricted_view_deleted", None, rec["name"], request)
    return {"deleted": rid}


# ------------------------------------------------------------------------------------------------
# Marketplace (marketplace.py): a view's policy packaged; its backing dataset (and the groups it names) are inputs
# ------------------------------------------------------------------------------------------------


def _sides(node: Any) -> list[tuple[dict, dict]]:
    if not isinstance(node, dict):
        return []
    if node.get("kind") == "condition":
        return [(node.get("left") or {}, node.get("right") or {})]
    return [x for ch in node.get("children") or [] for x in _sides(ch)] + _sides(node.get("child"))


def packaging_problems(policy: dict) -> list[str]:
    """What the Marketplace cannot package: constants other than strings and booleans, constants compared to anything
    but a column or the user's groups, and several column–constant comparisons on the same column."""
    out, seen = [], set()
    for left, right in _sides(policy):
        for a, b in ((left, right), (right, left)):
            if a.get("kind") != "static":
                continue
            vals = a.get("value") if isinstance(a.get("value"), list) else [a.get("value")]
            if any(not isinstance(v, (str, bool)) for v in vals):
                out.append("only string and boolean constants can be packaged")
            if b.get("kind") not in ("property", "user_groups"):
                out.append("constants can only be compared to columns or the user's groups")
            if b.get("kind") == "property":
                if b.get("property") in seen:
                    out.append(f"several comparisons of the column {b.get('property')} with constants cannot be packaged")
                seen.add(b.get("property"))
    return sorted(set(out))


def package(rid: str) -> dict:
    rec = _get(rid, "editor")
    problems = packaging_problems(rec["policy"])
    if problems:
        raise HTTPException(400, "; ".join(problems))
    groups = sorted({str(v) for left, right in _sides(rec["policy"]) for a, b in ((left, right), (right, left))
                     if a.get("kind") == "static" and b.get("kind") == "user_groups"
                     for v in (a.get("value") if isinstance(a.get("value"), list) else [a.get("value")]) if str(v).startswith("grp-")})
    return {"kind": "bluesandai.restricted-view.product", "version": 1, "name": rec["name"], "packaged_at": _now(),
            "packaged_by": (auth.current() or {}).get("username"),
            "view": {"name": rec["name"], "description": rec.get("description") or "", "policy": rec["policy"],
                     "columns": list(_backing_table(rec).column_names)},
            "backing": rec["backing_item_id"], "inputs": [rec["backing_item_id"], *groups]}


def _map_groups(node: Any, mapping: dict[str, str]) -> Any:
    if isinstance(node, dict):
        if node.get("kind") == "static":
            v = node.get("value")
            return {**node, "value": [mapping.get(x, x) for x in v] if isinstance(v, list) else mapping.get(v, v) if isinstance(v, str) else v}
        return {k: _map_groups(v, mapping) for k, v in node.items()}
    if isinstance(node, list):
        return [_map_groups(x, mapping) for x in node]
    return node


def install(pk: dict, project_id: str, name: Optional[str], mapping: dict[str, str]) -> dict:
    """A packaged view in a Project here: on the dataset its backing input is mapped to (it needs the packaged
    columns), with the groups it names mapped too (unmapped ones are kept)."""
    if pk.get("kind") != "bluesandai.restricted-view.product" or not isinstance(pk.get("view"), dict):
        raise HTTPException(400, "not a restricted view product")
    backing = mapping.get(pk.get("backing") or "")
    if not backing:
        raise HTTPException(400, "map the package's backing dataset to a dataset here")
    view = pk["view"]
    return create_view(ViewIn(name=(name or view["name"]).strip(), description=view.get("description") or "", project_id=project_id,
                              backing_item_id=backing, policy=_map_groups(view["policy"], mapping)), None)


class ObjectTypeIn(BaseModel):
    object_type_id: str


def _translate(node: Any, mapping: dict[str, str]) -> Any:
    """A row policy over columns as an object policy over the properties they are mapped to."""
    if not isinstance(node, dict):
        return node
    out = dict(node)
    if node.get("kind") in ("and", "or"):
        out["children"] = [_translate(c, mapping) for c in node.get("children") or []]
        return out
    for side in ("left", "right"):
        s = node.get(side)
        if isinstance(s, dict) and s.get("kind") == "property":
            if s.get("property") not in mapping:
                raise HTTPException(400, f"the column {s.get('property')} is not mapped to a property of the object type")
            out[side] = {**s, "property": mapping[s["property"]]}
    return out


@router.post("/{rid}/object-type")
def apply_to_object_type(rid: str, req: ObjectTypeIn, request: Request) -> dict:
    """Back an object type with the view's row policy: an object type whose backing dataset is the view's gets the
    view's policy as its object security policy (columns become the properties they are mapped to), so Object
    Explorer, Workshop and the OSDK show each user only the objects of the rows they may see (owners of the object
    type; its other markings and property policies stay)."""
    import ontology
    import ontology_security as osec

    rec = _get(rid, "editor")
    t = ontology._object_type(req.object_type_id)
    b = t.get("backing_dataset") or {}
    if b.get("dataset_id") not in (rec["backing_item_id"], backing_item_id(rec)):
        raise HTTPException(400, f"{t['display_name']} is not backed by {rec['name']}'s dataset")
    granular = _translate(rec["policy"], b.get("columns") or {})
    cur = (t.get("security") or {})
    op = {**(cur.get("object_policy") or {}), "granular": granular}
    out = osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=cur.get("property_policies") or []))
    rec.setdefault("object_types", [])
    if t["id"] not in rec["object_types"]:
        rec["object_types"].append(t["id"])
    _write(rec)
    auth.audit("restricted_view_applied", None, f"{rec['name']} → object type {t['display_name']}", request)
    return out


def table_for_ref(ref: str) -> tuple[pa.Table, dict]:
    """SQL Studio: `ri.foundry.main.restricted-view.<id>` as the caller sees it."""
    rid = ref[len(RID):] if ref.startswith(RID) else ref
    rec = _get(rid)
    return visible_table(rec), rec


# ------------------------------------------------------------------------------------------------
# Global Branching: a view on a global branch (Ontology branches) keeps the main version it started from (base) and
# its branch version (policy and stopped markings); it reads the backing dataset's branch of the same name. Editors
# add it to a branch (and build it there), owners change its policy and markings there; owners review; a rebase
# picks main's or the branch's version per part; merging writes the branch version to main — by itself, or when the
# global branch merges (approved and rebased only). A protected view's main changes only through a branch.
# ------------------------------------------------------------------------------------------------

UNITS = ("policy", "stop_propagating")


def _bpath(branch_id: str, rid: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", branch_id):
        raise HTTPException(404, "branch not found")
    _path(rid)
    return DIR / "branches" / branch_id / f"{rid}.json"


def _gbranch(branch_id: str) -> dict:
    import ontology

    _install_branch_hooks()
    b = ontology._read(ontology._path("branches", branch_id)) if re.fullmatch(r"[A-Za-z0-9_-]+", branch_id) else None
    if not b:
        raise HTTPException(404, "branch not found")
    return b


def _snap(rec: dict) -> dict:
    return {"policy": rec.get("policy"), "stop_propagating": sorted(rec.get("stop_propagating") or [])}


def _bread(branch_id: str, rid: str) -> Optional[dict]:
    try:
        return json.loads(_bpath(branch_id, rid).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _bwrite(branch_id: str, rid: str, st: dict) -> dict:
    p = _bpath(branch_id, rid)
    with _lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(st, indent=1), "utf-8")
    return st


def _on_branch(rec: dict, st: dict, gb: dict) -> dict:
    """The view as it reads on the branch: the branch version, over the backing dataset's branch of that name."""
    return {**rec, **st["branch"], "branch": gb["name"]}


def _needs_rebase(rec: dict, st: dict) -> bool:
    return json.dumps(_snap(rec), sort_keys=True) != json.dumps(st["base"], sort_keys=True)


def _approved(st: dict) -> bool:
    reviews = (st.get("reviews") or {}).values()
    return any(r["decision"] == "approve" and r.get("counts") for r in reviews) and not any(r["decision"] == "reject" for r in reviews)


def _bview(rec: dict, st: dict, gb: dict) -> dict:
    main = _snap(rec)
    changed = [u for u in UNITS if json.dumps(st["branch"][u], sort_keys=True) != json.dumps(st["base"][u], sort_keys=True)]
    conflicts = [u for u in changed if json.dumps(main[u], sort_keys=True) != json.dumps(st["base"][u], sort_keys=True)]
    approvals = sum(1 for r in (st.get("reviews") or {}).values() if r["decision"] == "approve" and r.get("counts"))
    return {"branch_id": gb["id"], "branch_name": gb["name"], "branch_status": gb.get("status"), "status": st.get("status", "open"),
            "main": main, "base": st["base"], "branch": st["branch"], "changed": changed, "conflicts": conflicts,
            "needs_rebase": _needs_rebase(rec, st), "approved": _approved(st), "approvals": approvals, "reviews": st.get("reviews") or {},
            "added_by": st.get("added_by"), "added_at": st.get("added_at"), "built_at": st.get("built_at"), "reindexed": st.get("reindexed") or [],
            "can_edit_policy": _is_owner(rec)}


def _is_owner(rec: dict) -> bool:
    p = auth.current()
    return p is None or not auth.enabled() or auth._is_admin(p) or auth.role_for(rec.get("project_id"), p) == "owner"


def _build_on_branch(rec: dict, st: dict, gb: dict) -> None:
    """Build the view on the branch: its backing dataset's branch must exist (and its policy apply to its columns);
    object types it backs get the branch policy on the branch (re-indexed there)."""
    rv = _on_branch(rec, st, gb)
    cols = set(_backing_table(rv).column_names)
    _check_policy(rv["policy"], cols)
    st["built_at"] = _now()
    st["reindexed"] = []
    for tid in rec.get("object_types") or []:
        try:
            st["reindexed"].append(_reindex_on_branch(rv, tid, gb["id"]))
        except HTTPException as e:
            log.warning("restricted view %s: object type %s not re-indexed on %s: %s", rec["id"], tid, gb["id"], e.detail)


def _reindex_on_branch(rv: dict, tid: str, branch_id: str) -> str:
    import ontology
    import ontology_branches as ob

    with ontology._lock:
        b = ob._branch(branch_id)
        t = ob._record(b, ob._key("object_type", tid)) or ontology._object_type(tid)
    bd = t.get("backing_dataset") or {}
    granular = _translate(rv["policy"], bd.get("columns") or {})
    sec = dict(t.get("security") or {})
    sec["object_policy"] = {**(sec.get("object_policy") or {}), "granular": granular}
    ob.save_branch_resource(branch_id, "object_type", tid, ob.ResourceIn(record={**t, "security": sec}))
    return tid


@router.put("/{rid}/protection")
def set_protection(rid: str, req: dict, request: Request) -> dict:
    """Protect the view's main branch (owners): its policy and markings then change only through a global branch."""
    rec = _get(rid, "editor")
    if not _is_owner(rec):
        raise HTTPException(403, "Only owners of the view's Project protect it")
    rec["protected"] = bool(req.get("protected"))
    _write(rec)
    auth.audit("restricted_view_protection", None, f"{rec['name']}: {'protected' if rec['protected'] else 'unprotected'}", request)
    return _view(rec)


@router.get("/{rid}/branches")
def view_branches(rid: str) -> list[dict]:
    rec = _get(rid)
    out = []
    d = DIR / "branches"
    for f in d.glob(f"*/{rid}.json") if d.exists() else []:
        st = _bread(f.parent.name, rid)
        try:
            gb = _gbranch(f.parent.name)
        except HTTPException:
            continue
        if st:
            out.append(_bview(rec, st, gb))
    return out


class BranchEditIn(BaseModel):
    policy: Optional[dict] = None
    stop_propagating: Optional[list[str]] = None


@router.post("/{rid}/branches/{branch_id}")
def add_to_branch(rid: str, branch_id: str, req: BranchEditIn, request: Request) -> dict:
    """Add the view to a global branch (editors; owners may change its policy and markings at the same time): it is
    built there, and object types it backs are re-indexed on the branch."""
    rec = _get(rid, "editor")
    gb = _gbranch(branch_id)
    if gb.get("status") != "open":
        raise HTTPException(400, f"the branch is {gb.get('status')}")
    if _bread(branch_id, rid):
        return edit_on_branch(rid, branch_id, req, request)
    st = {"base": _snap(rec), "branch": _snap(rec), "added_by": auth.actor_id(), "added_at": _now(), "reviews": {}, "status": "open"}
    _apply_edit(rec, st, req)
    _build_on_branch(rec, st, gb)
    _bwrite(branch_id, rid, st)
    auth.audit("restricted_view_branched", None, f"{rec['name']} on {gb['name']}", request)
    return _bview(rec, st, gb)


def _apply_edit(rec: dict, st: dict, req: BranchEditIn) -> None:
    if req.policy is None and req.stop_propagating is None:
        return
    if not _is_owner(rec):
        raise HTTPException(403, "Only owners change a view's policy or markings on a branch (editors build it)")
    if req.policy is not None:
        st["branch"]["policy"] = req.policy
    if req.stop_propagating is not None:
        marks = auth.effective_markings(rec["backing_item_id"])
        if set(req.stop_propagating) - marks:
            raise HTTPException(400, "Only markings the backing dataset carries can stop propagating")
        st["branch"]["stop_propagating"] = sorted(set(req.stop_propagating))
    # a change after reviews: they no longer count
    st["reviews"] = {}


@router.put("/{rid}/branches/{branch_id}")
def edit_on_branch(rid: str, branch_id: str, req: BranchEditIn, request: Request) -> dict:
    """Change the view on a branch (owners; it is added to the branch if it is not yet) and rebuild it there."""
    rec = _get(rid, "editor")
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    if not st:
        return add_to_branch(rid, branch_id, req, request)
    if st.get("status") == "merged" or gb.get("status") != "open":
        raise HTTPException(400, "the view's branch changes are merged or the branch is closed")
    _apply_edit(rec, st, req)
    _build_on_branch(rec, st, gb)
    _bwrite(branch_id, rid, st)
    auth.audit("restricted_view_branch_edit", None, f"{rec['name']} on {gb['name']}", request)
    return _bview(rec, st, gb)


@router.get("/{rid}/branches/{branch_id}")
def on_branch(rid: str, branch_id: str) -> dict:
    """The view on a branch (anyone who can view it): its versions, what changed, conflicts, reviews."""
    rec = _get(rid)
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    if not st:
        # not added: the branch reads the view from main
        return {"branch_id": branch_id, "branch_name": gb["name"], "added": False, "main": _snap(rec)}
    return {**_bview(rec, st, gb), "added": True}


@router.get("/{rid}/branches/{branch_id}/rows")
def rows_on_branch(rid: str, branch_id: str, limit: int = 200, request: Request = None) -> dict:  # type: ignore[assignment]
    """The rows you see on the branch (its policy over the backing dataset's branch); main's when not added. For a
    build, the rows its user may see."""
    import build_calls

    build_calls.enforce(request, ("read", f"resource:{KIND}", rid, None))
    with build_calls.acting_for(request):
        return _rows_on_branch(rid, branch_id, limit)


def _rows_on_branch(rid: str, branch_id: str, limit: int) -> dict:
    rec = _get(rid)
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    rv = _on_branch(rec, st, gb) if st else rec
    t = visible_table(rv)
    return {"columns": t.column_names, "rows": t.slice(0, max(1, min(limit, 1000))).to_pylist(), "total": t.num_rows, "on_branch": bool(st)}


@router.delete("/{rid}/branches/{branch_id}")
def remove_from_branch(rid: str, branch_id: str, request: Request) -> dict:
    """Remove the view from a branch: its branch-only changes are discarded (cannot be undone); the branch reads it
    from main again. Main is unaffected."""
    rec = _get(rid, "editor")
    p = _bpath(branch_id, rid)
    if not p.exists():
        raise HTTPException(404, "the view is not on this branch")
    p.unlink()
    auth.audit("restricted_view_unbranched", None, f"{rec['name']} from {branch_id}", request)
    return {"removed": True}


class BranchRebaseIn(BaseModel):
    # per part (policy, stop_propagating): "main" or "branch"
    choices: dict[str, Literal["main", "branch"]] = Field(default_factory=dict)


@router.post("/{rid}/branches/{branch_id}/rebase")
def rebase_on_branch(rid: str, branch_id: str, req: BranchRebaseIn, request: Request) -> dict:
    """Rebase onto main's latest: for each part changed on both, keep main's or the branch's version (no finer
    merging); parts only main changed take main's; the base moves to main's latest. Reviews start over."""
    rec = _get(rid, "editor")
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    if not st:
        raise HTTPException(404, "the view is not on this branch")
    main = _snap(rec)
    same = lambda a, b: json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)  # noqa: E731
    for u in UNITS:
        br_changed, main_changed = not same(st["branch"][u], st["base"][u]), not same(main[u], st["base"][u])
        if main_changed and br_changed:
            if u not in req.choices:
                raise HTTPException(400, f"choose main's or the branch's version of the {u.replace('_', ' ')}")
            if req.choices[u] == "main":
                st["branch"][u] = main[u]
        elif main_changed:
            st["branch"][u] = main[u]
    st["base"] = main
    st["reviews"] = {}
    _build_on_branch(rec, st, gb)
    _bwrite(branch_id, rid, st)
    auth.audit("restricted_view_rebased", None, f"{rec['name']} on {gb['name']}", request)
    return _bview(rec, st, gb)


class BranchReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = Field("", max_length=2000)


@router.post("/{rid}/branches/{branch_id}/review")
def review_on_branch(rid: str, branch_id: str, req: BranchReviewIn, request: Request) -> dict:
    """Review the branch changes (anyone who can view; an owner's review counts). A rebase comes first."""
    rec = _get(rid)
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    if not st:
        raise HTTPException(404, "the view is not on this branch")
    if _needs_rebase(rec, st):
        raise HTTPException(409, "Rebase the branch onto main first")
    uid = auth.actor_id() or "local"
    st.setdefault("reviews", {})[uid] = {"decision": req.decision, "comment": req.comment, "at": _now(), "counts": _is_owner(rec)}
    _bwrite(branch_id, rid, st)
    return _bview(rec, st, gb)


def _merge(rec: dict, st: dict, note: str) -> None:
    rec["policy"], rec["stop_propagating"] = st["branch"]["policy"], st["branch"]["stop_propagating"]
    rec.setdefault("history", []).append({"at": _now(), "by": auth.actor_id(), "policy": rec["policy"], "stop_propagating": rec["stop_propagating"],
                                          "branch": rec.get("branch", "master"), "note": note})
    rec["updated_at"] = _now()
    _write(rec)
    for tid in list(rec.get("object_types") or []):
        try:
            apply_to_object_type(rec["id"], ObjectTypeIn(object_type_id=tid), None)
        except HTTPException as e:
            log.warning("restricted view %s: object type %s not updated: %s", rec["id"], tid, e.detail)
    st["status"] = "merged"
    st["merged_at"] = _now()


@router.post("/{rid}/branches/{branch_id}/merge")
def merge_on_branch(rid: str, branch_id: str, request: Request) -> dict:
    """Merge the view's branch changes into main (owners): approved and rebased."""
    rec = _get(rid, "editor")
    if not _is_owner(rec):
        raise HTTPException(403, "Only owners merge a view's changes")
    gb = _gbranch(branch_id)
    st = _bread(branch_id, rid)
    if not st:
        raise HTTPException(404, "the view is not on this branch")
    if _needs_rebase(rec, st):
        raise HTTPException(409, "Rebase the branch onto main first")
    if not _approved(st):
        raise HTTPException(409, "The changes need an owner's approval")
    _merge(rec, st, f"Merged from {gb['name']}")
    _bwrite(branch_id, rid, st)
    auth.audit("restricted_view_merged", None, f"{rec['name']} from {gb['name']}", request)
    return _bview(rec, st, gb)


def _on_global_merge(branch_id: str) -> list[str]:
    """A global branch merged: its approved, rebased view changes merge too; the others stay (marked)."""
    done = []
    d = DIR / "branches" / branch_id
    for f in d.glob("*.json") if d.exists() else []:
        rid = f.stem
        rec, st = _read(rid), _bread(branch_id, rid)
        if not rec or not st or st.get("status") == "merged":
            continue
        if _approved(st) and not _needs_rebase(rec, st):
            _merge(rec, st, "Merged with the global branch")
            done.append(rid)
        else:
            st["status"] = "not merged (" + ("rebase needed" if _approved(st) else "not approved") + ")"
        _bwrite(branch_id, rid, st)
    return done


def _in_chain(h: Any, attr: str, depth: int = 0) -> bool:
    """Whether a hook (or one it wraps) is ours: other modules chain or replace the branch hooks."""
    if h is None or depth > 8:
        return False
    if getattr(h, attr, False):
        return True
    cells = []
    for c in getattr(h, "__closure__", None) or []:
        try:
            cells.append(c.cell_contents)
        except ValueError:
            pass
    return any(callable(x) and _in_chain(x, attr, depth + 1) for x in cells)


def _install_branch_hooks() -> None:
    """Chain the global branch hooks (merged: merge approved view changes; closed: mark them closed); called at
    start-up and again by the branch routes, since other modules replace the hooks when they configure."""
    import ontology

    prev_m = ontology.MODEL_HOOKS.get("branch_merged")
    if not _in_chain(prev_m, "_rv_hook"):
        def merged(branch_id: str) -> Any:
            res = prev_m(branch_id) if prev_m else None
            try:
                _on_global_merge(branch_id)
            except Exception:  # noqa: BLE001 - view merges never break a branch merge
                log.exception("restricted views on merged branch %s", branch_id)
            return res

        merged._rv_hook = True  # type: ignore[attr-defined]
        ontology.MODEL_HOOKS["branch_merged"] = merged
    prev_c = ontology.MODEL_HOOKS.get("branch_closed")
    if not _in_chain(prev_c, "_rv_hook"):
        def closed(branch_id: str) -> Any:
            res = prev_c(branch_id) if prev_c else None
            d = DIR / "branches" / branch_id
            for f in d.glob("*.json") if d.exists() else []:
                st = json.loads(f.read_text("utf-8"))
                if st.get("status") != "merged":
                    st["status"] = "closed"
                    f.write_text(json.dumps(st, indent=1), "utf-8")
            return res

        closed._rv_hook = True  # type: ignore[attr-defined]
        ontology.MODEL_HOOKS["branch_closed"] = closed
