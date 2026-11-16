"""Approvals (Security & Governance → Approvals): request a change you may not make yourself; eligible reviewers
approve it, and the change is applied (invoked) once every task is approved.

A request holds tasks:
  group_membership   add users to a group                     reviewers: administrators
  project_access     give a user or group a role on a Project  reviewers: the Project's Owners (and administrators)
  marking_access     give a user a marking                     reviewers: administrators
  add_reference      add a reference to a resource in a Project reviewers: the Project's Editors and Owners
Ontology proposals (ontology_branches.py) are listed in the inbox too, as requests whose task opens Ontology Manager,
where they are reviewed and merged.

Request states: pending (tasks in review), changes_requested, action_required (every task approved but required
checkpoints are not answered), completed (invoked), closed, rejected_closed. Task states: review, approved, rejected
(a later approval by an eligible reviewer overrides a rejection while the request is open). The requester or an
eligible reviewer edits or closes a request; only eligible reviewers approve, reject, request changes or reject and
close, each for the tasks they may review. Reviewers can be invited (being invited gives no rights). Comments are on
the request or a task, with links and Files attachments.

Required checkpoints: tasks whose change has a checkpoint type (group / marking member addition, role grant
addition) carry the checkpoint configurations that apply; the requester answers them when creating the request (or
later), or a reviewer on their behalf; records go to Checkpoints.

Notifications (inbox, and email when set up): added as reviewer, request created, invocation succeeded, request
closed, reviewer nudge. Every step is written to audit.3 (requestCreate / requestApprove / requestDisapprove /
requestUpdate / requestCancel / requestExecute / requestAccess / requestSearch).

Mounted by server.py under /api/approvals.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

log = logging.getLogger("bluesandai.approvals")
router = APIRouter(prefix="/api/approvals", tags=["approvals"])
DIR = Path("data/approvals")
RID = "ri.approvals.main.request."
_lock = threading.RLock()
OPEN_STATES = ("pending", "changes_requested", "action_required")
TASK_LABEL = {"group_membership": "Group membership", "project_access": "Project access request", "marking_access": "Marking access request",
              "add_reference": "Add reference request", "ontology_proposal": "Ontology proposal"}
CHECKPOINT_TYPE = {"group_membership": "group_member_addition", "marking_access": "marking_member_addition", "project_access": "role_grant_addition"}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "approvals"
    (DIR / "requests").mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _path(rid: str) -> Path:
    if not rid.replace("-", "").isalnum():
        raise HTTPException(404, "request not found")
    return DIR / "requests" / f"{rid}.json"


def _get(rid: str) -> dict:
    r = audit3._read(_path(rid), None)
    if not r:
        raise HTTPException(404, "request not found")
    return r


def _save(r: dict) -> None:
    r["updated_at"] = _now()
    audit3._write(_path(r["id"]), r)


def _all() -> list[dict]:
    return [r for p in sorted((DIR / "requests").glob("*.json")) if (r := audit3._read(p, None))]


def _me() -> dict:
    return auth.require_user()


def _uid(p: dict) -> str:
    return p.get("id") or "local"


# ------------------------------------------------------------------------------------------------
# tasks: who may review them, and how they are applied
# ------------------------------------------------------------------------------------------------


def _name(kind: str, rid: str) -> str:
    try:
        if kind == "user":
            u = auth._user(rid)
            return u.get("display_name") or u["username"]
        if kind == "group":
            return next((g["name"] for g in auth._groups() if g["id"] == rid), rid)
        if kind == "marking":
            return auth.marking_labels().get(rid, rid)
        if kind in ("project", "item"):
            import db

            it = db.drive_get(rid)
            return it["name"] if it else rid
    except Exception:  # noqa: BLE001
        pass
    return rid


def _label(t: dict) -> str:
    p = t["params"]
    if t["kind"] == "group_membership":
        return f"Add {', '.join(_name('user', u) for u in p['users'])} to the group {_name('group', p['group_id'])}"
    if t["kind"] == "project_access":
        return f"Give {_name(p['principal_type'], p['principal_id'])} the {p['role'].capitalize()} role on {_name('project', p['project_id'])}"
    if t["kind"] == "marking_access":
        return f"Give {_name('user', p['user_id'])} the marking {_name('marking', p['marking_id'])}"
    if t["kind"] == "add_reference":
        return f"Reference {_name('item', p['item_id'])} in {_name('project', p['project_id'])}"
    return t["kind"]


def eligible(t: dict, p: Optional[dict]) -> bool:
    """Whether a user may review a task: users who could make the change themselves."""
    if not auth.enabled():
        return True
    if not p or p.get("service"):
        return False
    if p.get("role") == "admin":
        return True
    params = t["params"]
    if t["kind"] == "project_access":
        return auth.role_for(params["project_id"], p) == "owner"
    if t["kind"] == "add_reference":
        return auth.role_for(params["project_id"], p) in ("editor", "owner")
    # group and marking managers (set by administrators in Control Panel) review requests for theirs
    if t["kind"] == "group_membership":
        g = next((x for x in auth._groups() if x["id"] == params["group_id"]), None)
        pol = (g or {}).get("approval_policy") or {}
        if pol.get("reviewers"):
            # the group's approval policy names its reviewers (users, groups)
            return bool(auth._principal_keys(p) & set(pol["reviewers"]))
        # managers: users, and members of the group's manager groups (a template's owner group)
        return bool(g) and (p.get("id") in (g.get("managers") or []) or bool(set(g.get("manager_groups") or []) & set(p.get("groups") or [])))
    if t["kind"] == "marking_access":
        m = next((x for x in auth._markings() if x["id"] == params["marking_id"]), None)
        return bool(m) and p.get("id") in (m.get("managers") or [])
    return False


def _eligible_users(t: dict) -> list[str]:
    out = []
    for u in auth._users():
        if u.get("disabled"):
            continue
        pr = {**auth._public_user(u), "markings": auth.user_markings(u), "service": False}
        if eligible(t, pr):
            out.append(u["id"])
    return out


def _validate_task(kind: str, params: dict) -> dict:
    if kind == "group_membership":
        if not any(g["id"] == params.get("group_id") for g in auth._groups()):
            raise HTTPException(400, "unknown group")
        users = params.get("users") or []
        if not users:
            raise HTTPException(400, "name the users to add to the group")
        for u in users:
            auth._user(u)
        return {"group_id": params["group_id"], "users": sorted(set(users))}
    if kind == "project_access":
        import db

        it = db.drive_get(params.get("project_id") or "")
        if not it or it.get("kind") != "project":
            raise HTTPException(400, "unknown Project")
        role = params.get("role")
        if role not in auth.ROLES:
            raise HTTPException(400, "the role is viewer, editor or owner")
        ptype = params.get("principal_type") or "user"
        if ptype == "user":
            auth._user(params.get("principal_id") or "")
        elif ptype == "group" and not any(g["id"] == params.get("principal_id") for g in auth._groups()):
            raise HTTPException(400, "unknown group")
        return {"project_id": it["id"], "principal_type": ptype, "principal_id": params["principal_id"], "role": role}
    if kind == "marking_access":
        if params.get("marking_id") not in auth._known_markings():
            raise HTTPException(400, "unknown marking")
        auth._user(params.get("user_id") or "")
        return {"marking_id": params["marking_id"], "user_id": params["user_id"]}
    if kind == "add_reference":
        import db

        it = db.drive_get(params.get("project_id") or "")
        ref = db.drive_get(params.get("item_id") or "")
        if not it or it.get("kind") != "project" or not ref:
            raise HTTPException(400, "unknown Project or resource")
        return {"project_id": it["id"], "item_id": ref["id"]}
    raise HTTPException(400, f"unknown task kind {kind}")


def _invoke_task(t: dict) -> None:
    """Apply an approved task's change (as the platform: the reviewers' approvals are the authorization)."""
    p = t["params"]
    if t["kind"] == "group_membership":
        g = next(g for g in auth._groups() if g["id"] == p["group_id"])
        g["members"] = sorted(set(g.get("members") or []) | set(p["users"]))
        auth._put_record("groups", g)
    elif t["kind"] == "marking_access":
        u = auth._user(p["user_id"])
        u["markings"] = sorted(set(u.get("markings") or []) | {p["marking_id"]})
        auth._save_user(u)
    elif t["kind"] == "project_access":
        with auth._lock, auth._db() as con:
            con.execute("DELETE FROM project_roles WHERE project_id = ? AND principal_type = ? AND principal_id = ?", (p["project_id"], p["principal_type"], p["principal_id"]))
            con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)",
                        (p["project_id"], p["principal_type"], p["principal_id"], p["role"]))
        auth._project_cache.clear()
        auth._roles_cache.clear()
    elif t["kind"] == "add_reference":
        import project_references as pr

        with pr._lock:
            data = pr._read()
            refs = data.setdefault(p["project_id"], [])
            if not any(r["item_id"] == p["item_id"] for r in refs):
                refs.append({"item_id": p["item_id"], "by": "approvals", "at": _now()})
            pr.PATH.write_text(json.dumps(data, indent=1), "utf-8")
    auth.audit("approval_invoked", None, f"{t['kind']}: {t['label']}")


def _checkpoints_for(kind: str, params: dict, requester: dict) -> list[dict]:
    ctype = CHECKPOINT_TYPE.get(kind)
    if not ctype:
        return []
    try:
        import checkpoints as cp
    except Exception:  # noqa: BLE001
        return []
    if kind == "group_membership":
        ctx = cp._ctx([{"type": "group", "id": params["group_id"]}], selected=[{"type": "user", "id": u} for u in params["users"]])
    elif kind == "marking_access":
        ctx = cp._ctx([{"type": "marking", "id": params["marking_id"]}], selected=[{"type": "user", "id": params["user_id"]}], markings=[params["marking_id"]])
    else:
        ctx = cp._ctx([cp._item(params["project_id"], "project")], selected=[{"type": params["principal_type"], "id": params["principal_id"], "role": params["role"]}])
    out = []
    for c in cp._configs():
        if cp.applies(c, ctype, ctx, requester):
            out.append({"config_id": c["id"], "title": c["title"], "type": ctype, "record": None, "ctx": ctx})
    return out


# ------------------------------------------------------------------------------------------------
# request state
# ------------------------------------------------------------------------------------------------


def _refresh(r: dict) -> None:
    if r["status"] in ("completed", "closed", "rejected_closed"):
        return
    states = [t["state"] for t in r["tasks"]]
    if any(s == "rejected" for s in states) and r["status"] == "changes_requested":
        return
    if all(s == "approved" for s in states):
        if any(c["record"] is None for t in r["tasks"] for c in t.get("checkpoints") or []):
            r["status"] = "action_required"
            return
        blocked = _invoke_blocked(r)
        if blocked:
            # nothing is applied: the request waits for approvals that count (or is closed)
            r["status"] = "pending"
            r["error"] = blocked
            _history(r, "system", f"not invoked: {blocked}")
            _notify(({u for t in r["tasks"] if t["state"] != "approved" for u in t.get("reviewers") or []} | {r["created_by"]}),
                    f"Not applied: {r['title']}", blocked, r)
            return
        _invoke(r)
    elif r["status"] == "action_required":
        r["status"] = "pending"


def _valid_approvers(t: dict) -> set[str]:
    """The approvals that still count (sign-in on): by users who are still active and still eligible reviewers of the
    task. An approval by someone since deleted, deactivated or no longer eligible (lost the Project Owner role, the
    administrator role, or left the group's / marking's reviewers) does not authorize the change."""
    out = _approvers(t)
    if not auth.enabled():
        return out
    return {u for u in out if (p := auth.principal_of(u)) is not None and eligible(t, p)}


def _invoke_blocked(r: dict) -> Optional[str]:
    """Why an approved request must not be applied now (None: it may). The platform applies the change on the
    strength of the request and its approvals, so both are checked again when it is applied (as background jobs
    re-check their owner, run_as.py): the requester must still be an active user, and each task needs enough
    approvals from reviewers who are still active and eligible — a task short of them goes back to review."""
    if not auth.enabled():
        return None
    uid = r.get("created_by")
    if not uid or uid in ("local", "system"):
        return "the request was made while sign-in was off and has no requester it can be applied for: ask again. Nothing was applied"
    if auth.principal_of(uid) is None:
        status = (auth.user_label(uid) or {}).get("status", "deleted")
        return f"the requester {_name('user', uid)} is {status}. Nothing was applied"
    reasons = []
    for t in r["tasks"]:
        if t.get("invoked_at"):
            continue
        need = int((_policy(t) or {}).get("min_approvals") or 1)
        valid = _valid_approvers(t)
        if len(valid) < need:
            gone = sorted(_approvers(t) - valid)
            t["state"] = "review"
            t["error"] = (f"approval{'s' if len(gone) > 1 else ''} by {', '.join(_name('user', u) for u in gone)} no longer count"
                          f"{'s' if len(gone) == 1 else ''} (deactivated, deleted or no longer an eligible reviewer): "
                          f"{len(valid)} of {need} needed")
            reasons.append(f"{t['label']}: {t['error']}")
    return f"{'; '.join(reasons)}. Nothing was applied" if reasons else None


def _invoke(r: dict) -> None:
    errors = []
    for t in r["tasks"]:
        if t.get("invoked_at"):
            continue
        try:
            _invoke_task(t)
            t["invoked_at"] = _now()
            t.pop("error", None)
        except Exception as e:  # noqa: BLE001
            t["error"] = str(getattr(e, "detail", None) or e)[:300]
            errors.append(t["error"])
    if errors:
        r["status"] = "action_required"
        r["error"] = "; ".join(errors)
        return
    r["status"] = "completed"
    r["completed_at"] = _now()
    r.pop("error", None)
    _history(r, "system", "invoked")
    audit3.emit("APPROVALS_INVOKE_REQUEST", ["requestExecute"], {"executedRequestIds": [RID + r["id"]]},
                {"executeRequestAffectedResources": [{"type": t["kind"], "id": json.dumps(t["params"], sort_keys=True)} for t in r["tasks"]]}, product="approvals")
    _notify(_reviewers_of(r) | {r["created_by"]}, f"Request completed: {r['title']}", "Every task was approved and the changes were applied.", r)


def _history(r: dict, who: str, what: str, task: Optional[str] = None) -> None:
    r.setdefault("history", []).append({"at": _now(), "by": who, "what": what, **({"task": task} if task else {})})


def _reviewers_of(r: dict) -> set[str]:
    out = set(r.get("invited") or [])
    for t in r["tasks"]:
        out |= set(t.get("reviewers") or [])
    return out


def _notify(users: set, subject: str, body: str, r: dict) -> None:
    try:
        import notify

        for u in users:
            if u and u != "local":
                notify.deliver(u, subject, body, link=f"/approvals/{r['id']}", link_label="Open request", source="approvals", email=True)
    except Exception:  # noqa: BLE001
        log.exception("approval notification failed")


def _can_view(r: dict, p: dict) -> bool:
    if not auth.enabled() or p.get("role") == "admin":
        return True
    uid = _uid(p)
    return uid == r["created_by"] or uid in _reviewers_of(r) or any(eligible(t, p) for t in r["tasks"])


def _policy(t: dict) -> Optional[dict]:
    """A group membership task's approval policy (the group's): approvals needed and its reviewers."""
    if t["kind"] != "group_membership":
        return None
    g = next((x for x in auth._groups() if x["id"] == t["params"]["group_id"]), None) or {}
    pol = g.get("approval_policy") or {}
    limit = auth.expiry_limit(g)
    if not pol and not limit:
        return None
    n = int(pol.get("min_approvals") or 1)
    parts = []
    if pol:
        parts.append(f"needs {n} approval{'' if n == 1 else 's'}" + (" from the group's policy reviewers" if pol.get("reviewers") else ""))
    if limit:
        parts.append(f"membership ends by {limit[:10]}")
    return {"min_approvals": n, "reviewers": pol.get("reviewers") or [], "expires_by": limit, "text": " · ".join(parts)}


def _approvers(t: dict) -> set[str]:
    """Distinct reviewers who approved since the task's last rejection."""
    out: set[str] = set()
    for rv in t.get("reviews") or []:
        if rv["decision"] == "approve":
            out.add(rv["by"])
        else:
            out = set()
    return out


def _view(r: dict, p: dict) -> dict:
    uid = _uid(p)
    tasks = []
    for t in r["tasks"]:
        tasks.append({**t, "policy": _policy(t), "approvals": len(_valid_approvers(t)), "can_review": eligible(t, p) and r["status"] in OPEN_STATES,
                      "checkpoints": [{k: v for k, v in c.items() if k != "ctx"} for c in t.get("checkpoints") or []],
                      "reviewer_names": [_name("user", u) for u in t.get("reviewers") or []]})
    return {**r, "rid": RID + r["id"], "tasks": tasks, "created_by_name": _name("user", r["created_by"]),
            "invited_names": [_name("user", u) for u in r.get("invited") or []],
            "can_edit": r["status"] in OPEN_STATES and (uid == r["created_by"] or any(eligible(t, p) for t in r["tasks"])),
            "is_creator": uid == r["created_by"]}


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


class TaskIn(BaseModel):
    kind: Literal["group_membership", "project_access", "marking_access", "add_reference"]
    params: dict[str, Any]


class RequestIn(BaseModel):
    title: str = Field("", max_length=200)
    description: str = Field("", max_length=8000)
    tasks: list[TaskIn] = Field(min_length=1, max_length=20)


@router.post("/requests")
def create_request(req: RequestIn) -> dict:
    p = _me()
    uid = _uid(p)
    tasks = []
    for t in req.tasks:
        params = _validate_task(t.kind, t.params)
        task = {"id": uuid.uuid4().hex[:8], "kind": t.kind, "params": params, "state": "review", "reviews": []}
        task["label"] = _label(task)
        task["reviewers"] = _eligible_users(task)
        task["checkpoints"] = _checkpoints_for(t.kind, params, p)
        tasks.append(task)
    r = {"id": uuid.uuid4().hex[:12], "title": req.title.strip() or "; ".join(t["label"] for t in tasks)[:200], "description": req.description,
         "created_by": uid, "created_at": _now(), "status": "pending", "tasks": tasks, "invited": [], "comments": [], "history": []}
    _history(r, p.get("username") or uid, "created")
    with _lock:
        _save(r)
    audit3.emit("APPROVALS_CREATE_REQUEST", ["requestCreate"], {"createdRequestAffectedResources": [{"type": t["kind"], "id": json.dumps(t["params"], sort_keys=True)}
                                                                                                  for t in tasks], "createdRequestDescription": r["title"]},
                {"createdRequestIds": [RID + r["id"]]}, product="approvals")
    _notify({uid}, f"Request created: {r['title']}", "Your request was sent to its reviewers.", r)
    _notify(_reviewers_of(r) - {uid}, f"Added as reviewer: {r['title']}", f"{p.get('username') or uid} asks for: {r['title']}", r)
    return _view(r, p)


@router.get("/projects/{project_id}/request-options")
def request_options(project_id: str) -> dict:
    """The Project access request form: the groups with a role on the Project that users may ask to join (less the
    ones its Owners excluded), with their access request categories (group attributes "access-request:<category>")
    and approval policies; or the role itself."""
    import governance_model

    _me()
    excluded = set(governance_model.project_record(project_id).get("request_excluded_groups") or [])
    groups = {g["id"]: g for g in auth._groups()}
    out = []
    for r in auth.project_roles(project_id):
        g = groups.get(r["principal_id"]) if r["principal_type"] == "group" else None
        if not g or g["id"] in excluded:
            continue
        cats = {k.split(":", 1)[1].strip(): v for k, v in (g.get("attributes") or {}).items() if k.lower().startswith("access-request:") and k.split(":", 1)[1].strip()}
        pol = _policy({"kind": "group_membership", "params": {"group_id": g["id"]}})
        out.append({"id": g["id"], "name": g["name"], "role": r["role"], "categories": cats, "policy": (pol or {}).get("text") or "",
                    "contact": g.get("contact")})
    return {"groups": sorted(out, key=lambda x: x["name"].lower()), "categories": sorted({c for x in out for c in x["categories"]})}


@router.get("/requests")
def list_requests(filter: Literal["inbox", "created", "all"] = "inbox", status: Optional[str] = None, kind: Optional[str] = None,  # noqa: A002
                  creator: Optional[str] = None, q: str = "") -> list[dict]:
    p = _me()
    uid = _uid(p)
    out = []
    for r in _all():
        if not _can_view(r, p):
            continue
        # the inbox: open requests with a task waiting for this user's review, or that they were invited to
        if filter == "inbox" and not (r["status"] in OPEN_STATES and (any(t["state"] != "approved" and eligible(t, p) for t in r["tasks"])
                                                                     or uid in (r.get("invited") or []))):
            continue
        if filter == "created" and r["created_by"] != uid:
            continue
        if status and r["status"] != status or kind and not any(t["kind"] == kind for t in r["tasks"]) or creator and r["created_by"] != creator:
            continue
        if q and q.lower() not in (r["title"] + " " + r.get("description", "")).lower():
            continue
        v = _view(r, p)
        out.append({k: v[k] for k in ("id", "rid", "title", "status", "created_by", "created_by_name", "created_at", "updated_at")} |
                   {"tasks": [{"kind": t["kind"], "label": t["label"], "state": t["state"], "can_review": t["can_review"]} for t in v["tasks"]]})
    out.extend(_ontology_proposals(p, filter, status, kind, q))
    out.sort(key=lambda r: r.get("updated_at") or r["created_at"], reverse=True)
    audit3.emit("APPROVALS_SEARCH_REQUESTS", ["requestSearch"], {"requestSearchQuery": json.dumps({"filter": filter, "status": status, "kind": kind, "q": q})},
                {"requestSearchResults": [x["rid"] for x in out[:50]]}, product="approvals")
    return out


def _ontology_proposals(p: dict, filter: str, status: Optional[str], kind: Optional[str], q: str) -> list[dict]:
    """Ontology proposals as requests: reviewed and merged in Ontology Manager."""
    if kind and kind != "ontology_proposal":
        return []
    try:
        import ontology_branches as ob

        rows = ob.proposals("assigned" if filter == "inbox" else "mine" if filter == "created" else "all")
    except Exception:  # noqa: BLE001
        return []
    mapping = {"draft": "pending", "in_review": "pending", "approved": "pending", "changes_requested": "changes_requested", "merged": "completed", "closed": "closed"}
    out = []
    for x in rows:
        st = mapping.get(x.get("status") or "", "pending")
        if filter == "inbox" and st not in OPEN_STATES or status and st != status:
            continue
        title = x.get("title") or x.get("branch") or "Ontology proposal"
        if q and q.lower() not in title.lower():
            continue
        out.append({"id": f"ontology-{x['branch_id']}", "rid": f"ri.ontology.main.proposal.{x['branch_id']}", "title": title, "status": st,
                    "created_by": x.get("created_by"), "created_by_name": _name("user", x.get("created_by") or ""), "created_at": x.get("created_at") or x.get("updated_at") or "",
                    "updated_at": x.get("updated_at"),
                    "tasks": [{"kind": "ontology_proposal", "label": f"{x.get('change_count', 0)} Ontology change(s) on {x.get('branch')}", "state": "approved" if x.get("status") in ("approved", "merged") else "review", "can_review": st in OPEN_STATES}]})
    return out


# -- Ontology proposals, reviewed here (their changes are tasks; merging applies them to main) --


def _branch_id(rid: str) -> Optional[str]:
    return rid[len("ontology-"):] if rid.startswith("ontology-") else None


def _proposal_view(bid: str, p: dict) -> dict:
    import ontology_branches as ob

    b = ob.get_branch(bid)
    prop = b.get("proposal")
    if not prop:
        raise HTTPException(404, "This branch has no proposal")
    status = "completed" if b["status"] == "merged" else "closed" if b["status"] != "open" else \
        "changes_requested" if any(t["status"] == "rejected" for t in b["tasks"]) else "pending"
    tasks = []
    for t in b["tasks"]:
        tasks.append({"id": t["key"], "kind": "ontology_proposal", "params": {"key": t["key"]},
                      "label": f"{t.get('op') or 'change'} {str(t.get('kind') or '').replace('_', ' ')} {t.get('name') or t['key']} (needs an ontology {t['needs']})",
                      "state": {"approved": "approved", "rejected": "rejected"}.get(t["status"], "review"),
                      "reviews": [{"by": r["user"], "by_name": _name("user", r["user"] or ""), "decision": r["decision"], "at": r["at"], "comment": ""} for r in t["reviews"]],
                      "reviewers": prop.get("reviewers") or [], "reviewer_names": [_name("user", u) for u in prop.get("reviewers") or []], "checkpoints": [],
                      "can_review": status in ("pending", "changes_requested")})
    checks = b.get("checks") or {}
    return {"id": f"ontology-{bid}", "rid": f"ri.ontology.main.proposal.{bid}", "kind": "ontology_proposal", "title": prop.get("title") or b.get("name"),
            "description": prop.get("description") or "", "status": status, "created_by": b.get("created_by") or "", "created_by_name": _name("user", b.get("created_by") or ""),
            "created_at": prop.get("created_at") or "", "updated_at": b.get("updated_at"), "tasks": tasks, "invited": [], "invited_names": [],
            "comments": [{"id": c["id"], "task_id": c.get("key"), "by": c["user"], "by_name": _name("user", c["user"] or ""), "at": c["at"], "text": c["text"], "attachments": []}
                         for c in prop.get("comments") or []],
            "history": [{"at": x["at"], "by": _name("user", x.get("user") or ""), "what": x["op"], "task": x.get("key")} for x in (b.get("changelog") or [])[-50:]],
            "can_edit": False, "is_creator": _uid(p) == b.get("created_by"), "external_link": f"/ontology?branch={bid}",
            "mergeable": bool(checks.get("mergeable")) and status == "pending", "checks": checks}


@router.post("/requests/{rid}/merge")
def merge_proposal(rid: str) -> dict:
    """Merge an approved Ontology proposal into main (as Ontology Manager does)."""
    bid = _branch_id(rid)
    if not bid:
        raise HTTPException(400, "Only Ontology proposals are merged")
    import ontology_branches as ob

    ob.merge(bid)
    audit3.emit("APPROVALS_MERGE_PROPOSAL", ["requestApprove"], {"approvedRequestIds": [f"ri.ontology.main.proposal.{bid}"], "approveRequestUserId": _uid(_me())},
                product="approvals")
    return _proposal_view(bid, _me())


@router.get("/requests/{rid}")
def get_request(rid: str) -> dict:
    p = _me()
    if _branch_id(rid):
        return _proposal_view(_branch_id(rid), p)
    r = _get(rid)
    if not _can_view(r, p):
        raise HTTPException(403, "You are not a requester or reviewer of this request")
    audit3.emit("APPROVALS_GET_REQUEST", ["requestAccess"], {"accessedRequestIds": [RID + rid]}, product="approvals")
    return _view(r, p)


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject", "request_changes", "reject_and_close"]
    task_ids: Optional[list[str]] = None  # none: every task the reviewer is eligible for
    comment: str = Field("", max_length=4000)


@router.post("/requests/{rid}/review")
def review(rid: str, req: ReviewIn) -> dict:
    p = _me()
    uid = _uid(p)
    bid = _branch_id(rid)
    if bid:
        import ontology_branches as ob

        ob.review(bid, ob.ReviewIn(decision="approve" if req.decision == "approve" else "reject", keys=req.task_ids or [], comment=req.comment or None))
        return _proposal_view(bid, p)
    with _lock:
        r = _get(rid)
        if r["status"] not in OPEN_STATES:
            raise HTTPException(400, f"The request is {r['status'].replace('_', ' ')}")
        mine = [t for t in r["tasks"] if eligible(t, p) and (req.task_ids is None or t["id"] in req.task_ids)]
        if not mine:
            raise HTTPException(403, "You are not an eligible reviewer of these tasks")
        for t in mine:
            t["reviews"].append({"by": uid, "by_name": p.get("username") or uid, "decision": req.decision, "at": _now(), "comment": req.comment})
            need = int((_policy(t) or {}).get("min_approvals") or 1)
            # a group's approval policy may need several distinct approvers before the task is approved
            # only approvals that still count (_valid_approvers: active, still eligible reviewers)
            t["state"] = ("approved" if len(_valid_approvers(t)) >= need else "review") if req.decision == "approve" else "rejected"
            _history(r, p.get("username") or uid, req.decision, t["id"])
        if req.comment:
            r["comments"].append({"id": uuid.uuid4().hex[:8], "task_id": mine[0]["id"] if len(mine) == 1 else None, "by": uid, "by_name": p.get("username") or uid,
                                  "at": _now(), "text": req.comment, "attachments": []})
        if req.decision == "reject_and_close":
            r["status"] = "rejected_closed"
            r["closed_at"] = _now()
        elif req.decision == "request_changes":
            r["status"] = "changes_requested"
        elif req.decision == "reject":
            r["status"] = "pending"
        else:
            if r["status"] == "changes_requested" and all(t["state"] == "approved" for t in r["tasks"]):
                r["status"] = "pending"
            _refresh(r)
        _save(r)
    cat = "requestApprove" if req.decision == "approve" else "requestDisapprove"
    field = {"requestApprove": ("approvedRequestIds", "approveRequestUserId"), "requestDisapprove": ("disapprovedRequestIds", "disapproveRequestUserId")}[cat]
    audit3.emit(f"APPROVALS_{req.decision.upper()}", [cat] + (["requestCancel"] if req.decision == "reject_and_close" else []),
                {field[0]: [RID + rid], field[1]: uid, **({"canceledRequestIds": [RID + rid]} if req.decision == "reject_and_close" else {})}, product="approvals")
    if r["status"] in ("rejected_closed",):
        _notify(_reviewers_of(r) | {r["created_by"]}, f"Request closed: {r['title']}", f"{p.get('username')} rejected and closed the request.", r)
    elif req.decision == "request_changes":
        _notify({r["created_by"]}, f"Changes requested: {r['title']}", req.comment or f"{p.get('username')} requested changes.", r)
    return _view(r, p)


class EditIn(BaseModel):
    title: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=8000)
    # task id -> new parameters (for example another role); the task goes back to review
    tasks: Optional[dict[str, dict[str, Any]]] = None


@router.patch("/requests/{rid}")
def edit(rid: str, req: EditIn) -> dict:
    p = _me()
    with _lock:
        r = _get(rid)
        v = _view(r, p)
        if not v["can_edit"]:
            raise HTTPException(403, "Only the requester or an eligible reviewer edits an open request")
        if req.title is not None:
            r["title"] = req.title.strip() or r["title"]
        if req.description is not None:
            r["description"] = req.description
        for tid, params in (req.tasks or {}).items():
            t = next((x for x in r["tasks"] if x["id"] == tid), None)
            if not t:
                raise HTTPException(404, "task not found")
            t["params"] = _validate_task(t["kind"], {**t["params"], **params})
            t["label"] = _label(t)
            t["state"] = "review"
            t["reviewers"] = _eligible_users(t)
            t["checkpoints"] = _checkpoints_for(t["kind"], t["params"], auth.principal_of(r["created_by"]) or p)
        if r["status"] == "changes_requested":
            r["status"] = "pending"
        _history(r, p.get("username") or _uid(p), "edited")
        _refresh(r)
        _save(r)
    audit3.emit("APPROVALS_UPDATE_REQUEST", ["requestUpdate"], {"updatedRequestIds": [RID + rid], "updatedRequestDescription": "edited"}, product="approvals")
    return _view(r, p)


@router.post("/requests/{rid}/close")
def close(rid: str) -> dict:
    p = _me()
    with _lock:
        r = _get(rid)
        if not _view(r, p)["can_edit"]:
            raise HTTPException(403, "Only the requester or an eligible reviewer closes an open request")
        r["status"] = "closed"
        r["closed_at"] = _now()
        _history(r, p.get("username") or _uid(p), "closed")
        _save(r)
    audit3.emit("APPROVALS_CLOSE_REQUEST", ["requestCancel"], {"canceledRequestIds": [RID + rid]}, product="approvals")
    _notify(_reviewers_of(r) | {r["created_by"]}, f"Request closed: {r['title']}", f"{p.get('username')} closed the request.", r)
    return _view(r, p)


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    task_id: Optional[str] = None
    attachments: list[str] = Field(default_factory=list)  # Files item ids


@router.post("/requests/{rid}/comments")
def comment(rid: str, req: CommentIn) -> dict:
    p = _me()
    bid = _branch_id(rid)
    if bid:
        import ontology_branches as ob

        ob.comment(bid, ob.CommentIn(text=req.text))
        return _proposal_view(bid, p)
    with _lock:
        r = _get(rid)
        if not _can_view(r, p):
            raise HTTPException(403, "You are not a requester or reviewer of this request")
        atts = []
        for a in req.attachments:
            import drive

            it = drive._item(a)
            atts.append({"id": it["id"], "name": it["name"]})
        r["comments"].append({"id": uuid.uuid4().hex[:8], "task_id": req.task_id, "by": _uid(p), "by_name": p.get("username") or _uid(p), "at": _now(),
                              "text": req.text, "attachments": atts})
        _save(r)
    _notify((_reviewers_of(r) | {r["created_by"]}) - {_uid(p)}, f"New comment: {r['title']}", req.text[:300], r)
    return _view(r, p)


class InviteIn(BaseModel):
    users: list[str] = Field(min_length=1)


@router.post("/requests/{rid}/reviewers")
def invite(rid: str, req: InviteIn) -> dict:
    p = _me()
    with _lock:
        r = _get(rid)
        if not _can_view(r, p):
            raise HTTPException(403, "You are not a requester or reviewer of this request")
        for u in req.users:
            auth._user(u)
        new = set(req.users) - set(r.get("invited") or [])
        r["invited"] = sorted(set(r.get("invited") or []) | new)
        _history(r, p.get("username") or _uid(p), f"invited {', '.join(_name('user', u) for u in new)}")
        _save(r)
    _notify(new, f"Added as reviewer: {r['title']}", f"{p.get('username')} asked you to review this request.", r)
    return _view(r, p)


@router.post("/requests/{rid}/nudge")
def nudge(rid: str) -> dict:
    p = _me()
    r = _get(rid)
    if _uid(p) != r["created_by"] and not _can_view(r, p):
        raise HTTPException(403, "You are not a requester or reviewer of this request")
    waiting = {u for t in r["tasks"] if t["state"] != "approved" for u in t.get("reviewers") or []} | set(r.get("invited") or [])
    _notify(waiting, f"Reminder: review {r['title']}", f"{p.get('username')} is waiting for your review.", r)
    return {"nudged": len(waiting)}


class CheckpointAnswersIn(BaseModel):
    answers: dict[str, dict[str, Any]]


@router.post("/requests/{rid}/tasks/{tid}/checkpoints")
def answer_checkpoints(rid: str, tid: str, req: CheckpointAnswersIn) -> dict:
    """Answer a task's required checkpoints: the requester, or an eligible reviewer on their behalf."""
    import checkpoints as cp

    p = _me()
    with _lock:
        r = _get(rid)
        t = next((x for x in r["tasks"] if x["id"] == tid), None)
        if not t:
            raise HTTPException(404, "task not found")
        if _uid(p) != r["created_by"] and not eligible(t, p):
            raise HTTPException(403, "The requester or an eligible reviewer answers required checkpoints")
        cfgs = {c["id"]: c for c in cp._configs()}
        for c in t.get("checkpoints") or []:
            if c["record"] or c["config_id"] not in req.answers:
                continue
            cfg = cfgs.get(c["config_id"])
            if not cfg:
                c["record"] = "configuration removed"
                continue
            just = cp._validate(cfg, cp.Answer(**req.answers[c["config_id"]]), p)
            rec = cp._record(cfg, c["type"], c["ctx"], {**just, "on_behalf_of": r["created_by"]} if _uid(p) != r["created_by"] else just, p, None)
            c["record"] = rec["rid"]
        _refresh(r)
        _save(r)
    return _view(r, p)
