"""Ontology branching, proposals and migration, modelled on Foundry's Ontology Manager.

A branch is cut from main and holds changes to ontology resources (object types, action types, link types,
interfaces and shared properties): each changed resource keeps the version it was based on and its branch version
(or a deletion). Resources the branch has not touched read through to main, so main's updates to them flow in. A
resource changed on both main (since the branch's base) and the branch is a conflict: rebasing loads main's
latest versions and asks for each conflict whether to use main's changes, keep the branch's or apply a custom
version; finishing the rebase moves the base to main's latest.

A proposal is created on a branch with a title, description and reviewers. Each changed resource is a task that
reviewers approve or reject (comments may be left on the proposal or a task); only reviews by editors or owners of a
resource count towards its approval, and a newly promoted object type needs an owner's approval. Merge checks
require no conflicts, valid resources and every task approved; merging writes the branch versions to main (where
protected resources accept them) and marks the proposal merged. Branches can be closed without merging. The
Proposals page lists my proposals, those assigned to me, in review, merged and closed.

Permissions (Foundry "Proposal permissions"; sign-in on): a branch's name, description and its proposal's title are
discoverable to everyone with access to the ontology, but its changes only to those who can view each resource — the
Viewer role on it and every marking of its object type (its backing datasets' too; an action type follows its object
type, a link type both ends), for each version (base, main, branch). Changes, tasks, diffs, conflicts, main updates,
changelog and comments on a resource the caller cannot see are left out (only their number is given). Viewers may
suggest changes; the branch's author or an ontology editor / owner creates and edits the proposal and closes the
branch; changing a resource's roles, security policies, datasource markings or protection needs an owner's approval
(like promotion), and stopping a datasource marking's inheritance needs that marking's Remove permission (saver and
merger). Anyone who can view every change may merge an approved proposal — and only while its approvals still count:
each counted review by a user who is still active, still an editor / owner of the resource and can still see it, and
the branch's author still active (a branch made while sign-in was off has no author to merge for). Otherwise nothing
is merged and the proposal records why (`merge_refused`). Rebasing moves a change's base to main's latest; a change
whose base moved needs a fresh review. Merges and rebases run in the request, as the person who asked.

Migration moves resources between ontologies with their connected resources (the link types between moved object
types, their action types, implemented interfaces and shared properties in use); object types created in a private
ontology cannot move to the default ontology. Edits and objects move with them.

Records are JSON files under data/ontology/branches/. Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import contextlib
import json
from typing import Any, Iterator, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
import run_as
from ontology import _all, _get, _lock, _new_id, _now, _path, _put, _read, _write

router = APIRouter(prefix="/api/ontology")

FOLDER = om.FOLDER
# fields that only describe a record's bookkeeping: changes to them are not changes
NOISE = ("updated_at", "created_at")


def _key(kind: str, rid: str) -> str:
    if kind not in FOLDER:
        raise HTTPException(404, "unknown resource kind")
    return f"{kind}:{rid}"


def _split(key: str) -> tuple[str, str]:
    kind, rid = key.split(":", 1)
    return kind, rid


def _main(key: str) -> Optional[dict]:
    kind, rid = _split(key)
    return _read(_path(FOLDER[kind], rid))


def _clean(rec: Optional[dict]) -> Optional[dict]:
    if rec is None:
        return None
    return {k: v for k, v in rec.items() if k not in NOISE}


def _same(a: Optional[dict], b: Optional[dict]) -> bool:
    return json.dumps(_clean(a), sort_keys=True) == json.dumps(_clean(b), sort_keys=True)


def _diff(a: Optional[dict], b: Optional[dict]) -> list[str]:
    """The top-level fields that differ (properties by API name)."""
    if a is None or b is None:
        return []
    out = []
    for k in sorted(set(a) | set(b)):
        if k in NOISE or json.dumps(a.get(k), sort_keys=True) == json.dumps(b.get(k), sort_keys=True):
            continue
        if k == "properties" and isinstance(a.get(k), list) and isinstance(b.get(k), list):
            pa = {p.get("api_name"): p for p in a[k]}
            pb = {p.get("api_name"): p for p in b[k]}
            for n in sorted(set(pa) | set(pb)):
                if json.dumps(pa.get(n), sort_keys=True) != json.dumps(pb.get(n), sort_keys=True):
                    out.append(f"properties.{n}" + (" (added)" if n not in pa else " (removed)" if n not in pb else ""))
        else:
            out.append(k)
    return out


def _who() -> str:
    p = auth.current() or {}
    return p.get("id") or "local"


def _branch(branch_id: str) -> dict:
    b = _get("branches", branch_id, "branch")
    om.require_role(b.get("ontology_id"), "discoverer", what="see this branch")
    return b


def _save(b: dict) -> dict:
    return _put("branches", b)


# ------------------------------------------------------------------------------------------------
# who sees which change (markings, ontology roles)
# ------------------------------------------------------------------------------------------------
# fields whose change needs an ontology owner's approval (they change who may see or edit the resource)
OWNER_FIELDS = ("roles", "security", "datasource_markings", "protected")


def _viewer() -> Optional[dict]:
    """The signed-in caller whose markings apply (None: sign-in off or the platform)."""
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return None
    return p


def _role_at_least(oid: Optional[str], rec: Optional[dict], need: str) -> bool:
    try:
        have = om.role_of(oid, rec)
    except HTTPException:
        return False
    return have is not None and om.ROLES.index(have) >= om.ROLES.index(need)


def _source_markings(rec: dict) -> set[str]:
    """The markings of a (branch) object type version's backing datasets."""
    ids = [(rec.get("backing_dataset") or {}).get("dataset_id")] + [d.get("dataset_id") for d in rec.get("additional_datasources") or []]
    out: set[str] = set()
    for i in ids:
        if i:
            out |= set(auth.effective_markings(i))
    return out


def _sees_version(b: dict, kind: str, rid: str, rec: Optional[dict]) -> bool:
    """Whether the caller may view one version of a resource: the Viewer role on it, and for an object type its
    markings (main's, and the backing datasets' of this version); an action type follows its object type, a link
    type both its ends (as the branch sees them)."""
    if rec is None:
        return True
    if not _role_at_least(rec.get("ontology_id") or b["ontology_id"], rec, "viewer"):
        return False
    if kind == "object_type":
        if not auth.visible_resources("object_type", [{"id": rid}]):
            return False
        p = _viewer()
        return p is None or auth.satisfies(_source_markings(rec), p.get("markings"))
    if kind == "action_type" and rec.get("object_type_id"):
        return _sees(b, f"object_type:{rec['object_type_id']}")
    if kind == "link_type":
        ends = [(rec.get(side) or {}).get("object_type_id") for side in ("source", "target")]
        return all(_sees(b, f"object_type:{e}") for e in ends if e)
    return True


def _sees(b: dict, key: str) -> bool:
    """Whether the caller may view a resource on this branch: every version of it (base, main, branch)."""
    kind, rid = _split(key)
    versions = [_main(key)]
    if key in b["base"]:
        versions.append(b["base"][key])
    if key in b["changes"]:
        versions.append(b["changes"][key])
    return all(_sees_version(b, kind, rid, v) for v in versions)


def _visible_keys(b: dict) -> set[str]:
    return {k for k in b["changes"] if _sees(b, k)}


def _require_sees(b: dict, key: str, rec: Optional[dict] = None) -> None:
    """403 unless the caller may view the resource (and, when given, the version they are saving)."""
    kind, rid = _split(key)
    if _sees(b, key) and _sees_version(b, kind, rid, rec):
        return
    if kind == "object_type" and _main(key):
        # the marking message (with the access request header), when it is a marking that is missing
        auth.check_resource("object_type", rid)
    raise HTTPException(403, f"You cannot view this {om.KIND_LABEL[kind]} (its markings or your ontology role): it cannot be changed or reviewed by you")


def _owner_fields(base: Optional[dict], rec: Optional[dict]) -> list[str]:
    """The fields of a change that need an ontology owner (who may see or edit the resource)."""
    if rec is None:
        return []
    a = base or {}
    return [f for f in OWNER_FIELDS if json.dumps(a.get(f), sort_keys=True) != json.dumps(rec.get(f), sort_keys=True) and (base is not None or rec.get(f))]


def _stopped(rec: Optional[dict]) -> set[str]:
    return set(((rec or {}).get("datasource_markings") or {}).get("stop_inheriting") or [])


def _check_inheritance(key: str, base: Optional[dict], rec: Optional[dict]) -> None:
    """Stopping (or restarting) a datasource marking's inheritance changes the object type's markings: the caller
    needs that marking's Remove (Apply) permission, as on main (ontology_security.set_datasource_markings)."""
    kind, rid = _split(key)
    if kind != "object_type" or rec is None:
        return
    before, after = _stopped(base), _stopped(rec)
    if before != after:
        auth.check_marking_change(f"object_type:{rid}", before - after, after - before)


# ------------------------------------------------------------------------------------------------
# running on a branch: Workshop, AIP Logic, actions and functions in the branch's context
# ------------------------------------------------------------------------------------------------
# A branch's object data is a persisted Ontology scenario owned by the branch (its "data scenario", made on first
# use): reads see main with the branch's edits on top, actions applied on the branch write there and never to main.
# Requests carry it in the scenario header (x-bluesandai-scenario), and functions run there use the branch's
# branched pre-releases (functions_registry.current_branch). Like Foundry, action edits on a branch are for testing:
# they are not merged into main, and the data scenario ends when the branch merges or closes.

DATA_TTL_DAYS = 3650


def _data_scenario(b: dict) -> str:
    """The branch's data scenario (made when missing or expired)."""
    import ontology_scenarios as osc
    from datetime import datetime, timedelta, timezone

    sid = b.get("data_scenario")
    if sid:
        sc = _read(osc._path(sid))
        if sc and not osc._expired(sc) and sc.get("global_branch") == b["id"]:
            return sid
    sc = osc.create_scenario(osc.ScenarioIn(name=f"Branch {b['name']}"[:200], description=f"Object data of the global branch {b['name']} (edits stay on the branch)",
                                            persisted=True))
    rec = _read(osc._path(sc["id"]))
    rec["global_branch"] = b["id"]
    rec["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=DATA_TTL_DAYS)).isoformat(timespec="seconds")
    osc._save(rec)
    b["data_scenario"] = sc["id"]
    _save(b)
    return sc["id"]


def _end_data(b: dict) -> None:
    """The branch merged or closed: its object edits end with it (they never reach main)."""
    import ontology_scenarios as osc

    sid = b.get("data_scenario")
    sc = _read(osc._path(sid)) if sid else None
    if sc:
        sc["expires_at"] = _now()
        sc["status"] = "draft"
        osc._save(sc)


@contextlib.contextmanager
def branch_context(branch_id: str) -> Iterator[dict]:
    """Run on an open branch: object reads and edits in its data scenario, functions at its branched versions."""
    import functions_registry

    with _lock:
        b = _branch(branch_id)
        _open(b)
        sid = _data_scenario(b)
    t_branch = functions_registry.BRANCH.set(branch_id)
    t_scn = ontology.SCENARIO.set(sid)
    try:
        yield b
    finally:
        ontology.SCENARIO.reset(t_scn)
        functions_registry.BRANCH.reset(t_branch)


def _function_status(branch_id: str) -> dict:
    try:
        import functions_registry

        repos = functions_registry.branch_status(branch_id)
    except Exception:  # noqa: BLE001 - the functions registry is optional here
        repos = []
    return {"repos": repos, "rebase_available": any(r["rebase_available"] for r in repos),
            "stale_targets": [{"repo_id": r["repo_id"], "repository": r["repository"], "target": t} for r in repos for t in r["stale_targets"]]}


def _label(key: str, rec: Optional[dict]) -> str:
    kind, rid = _split(key)
    return (rec or {}).get("display_name") or (rec or {}).get("api_name") or rid


def _changes(b: dict) -> list[dict]:
    out = []
    for key, rec in b["changes"].items():
        base = b["base"].get(key)
        main = _main(key)
        kind, rid = _split(key)
        op = "delete" if rec is None else "create" if base is None else "modify"
        out.append({"key": key, "kind": kind, "id": rid, "op": op, "name": _label(key, rec or base or main),
                    "fields": _diff(base, rec) if op == "modify" else [],
                    "main_changed": not _same(base, main), "conflict": _conflict(b, key)})
    return out


def _conflict(b: dict, key: str) -> bool:
    if key not in b["changes"]:
        return False
    base, main, mine = b["base"].get(key), _main(key), b["changes"][key]
    return not _same(base, main) and not _same(main, mine)


def _main_updates(b: dict) -> list[dict]:
    """Resources main changed since the branch's base (for changed resources) or since the last rebase (the rest)."""
    since = b.get("rebased_at") or b["created_at"]
    out = []
    for kind, folder in FOLDER.items():
        for rec in _all(folder):
            if rec.get("ontology_id", "default") != b["ontology_id"] and kind != "action_type":
                continue
            key = f"{kind}:{rec['id']}"
            if key in b["changes"]:
                if not _same(b["base"].get(key), rec):
                    out.append({"key": key, "name": _label(key, rec), "updated_at": rec.get("updated_at"), "on_branch": True})
            elif (rec.get("updated_at") or "") > since:
                out.append({"key": key, "name": _label(key, rec), "updated_at": rec.get("updated_at"), "on_branch": False})
    for key, base in b["base"].items():
        if base is not None and _main(key) is None:
            out.append({"key": key, "name": _label(key, base), "updated_at": None, "deleted_on_main": True, "on_branch": key in b["changes"]})
    return out


def view(b: dict, kind: str) -> list[dict]:
    """Main's resources of a kind as the branch sees them."""
    rows = {r["id"]: r for r in _all(FOLDER[kind])}
    for key, rec in b["changes"].items():
        k, rid = _split(key)
        if k != kind:
            continue
        if rec is None:
            rows.pop(rid, None)
        else:
            rows[rid] = rec
    return list(rows.values())


def _record(b: dict, key: str) -> Optional[dict]:
    return b["changes"][key] if key in b["changes"] else _main(key)


def _summary(b: dict) -> dict:
    """The branch as the caller may see it: changes, tasks, diffs, main updates, changelog and comments on resources
    they cannot view are left out (`hidden_changes` counts them); merge checks are computed on every change."""
    changes = _changes(b)
    p = b.get("proposal")
    tasks = _tasks(b) if p else []
    checks = _checks(b, changes, tasks) if p else None
    seen = _visible_keys(b)
    hidden = len(b["changes"]) - len(seen)
    shown = [c for c in changes if c["key"] in seen]
    out = {**b, "base": {k: v for k, v in b["base"].items() if k in seen}, "changes": {k: v for k, v in b["changes"].items() if k in seen},
           "changelog": [x for x in b.get("changelog") or [] if not x.get("key") or x["key"] in seen or (x["key"] not in b["changes"] and _sees(b, x["key"]))],
           "change_list": shown, "conflicts": [c["key"] for c in shown if c["conflict"]], "hidden_changes": hidden,
           "main_updates": [u for u in _main_updates(b) if _sees(b, u["key"])], "tasks": [t for t in tasks if t["key"] in seen],
           "author": auth.user_label(b.get("created_by")) if b.get("created_by") not in (None, "local") else {"username": "local"}}
    out["proposal"] = _proposal_row(b, seen)
    if checks is not None:
        out["checks"] = {**checks, "conflicts": [k for k in checks["conflicts"] if k in seen], "errors": [e for e in checks["errors"] if e["key"] in seen],
                         "unapproved": [k for k in checks["unapproved"] if k in seen],
                         "lapsed_approvals": [x for x in checks["lapsed_approvals"] if x["key"] in seen], "hidden_conflicts": len([k for k in checks["conflicts"] if k not in seen]),
                         "hidden_errors": len([e for e in checks["errors"] if e["key"] not in seen]),
                         "hidden_unapproved": len([k for k in checks["unapproved"] if k not in seen])}
        if hidden:
            out["checks"]["mergeable"] = False
            out["checks"]["merge_blocked"] = _hidden_reason(hidden)
    else:
        out["checks"] = None
    return out


def _proposal_row(b: dict, seen: set[str]) -> Optional[dict]:
    """The proposal without the reviews and comments of changes the caller cannot view."""
    p = b.get("proposal")
    if not p:
        return None
    return {**p, "reviews": {k: v for k, v in (p.get("reviews") or {}).items() if k in seen},
            "comments": [c for c in p.get("comments") or [] if not c.get("key") or c["key"] in seen]}


def _hidden_reason(n: int) -> str:
    return (f"{n} change{'s' if n > 1 else ''} on this branch {'are' if n > 1 else 'is'} on resources you cannot view (markings or ontology roles): "
            "someone who can view every change must merge it")


# ------------------------------------------------------------------------------------------------
# validation of branch versions
# ------------------------------------------------------------------------------------------------


def _validate(b: dict, key: str, rec: Optional[dict]) -> None:
    """A branch version must be valid against the branch's other versions (and main for the rest)."""
    kind, rid = _split(key)
    if rec is None:
        main = _main(key)
        if main and main.get("status") in ("active", "promoted"):
            raise HTTPException(400, f"an {main['status']} {om.KIND_LABEL[kind]} cannot be deleted")
        return
    rec["id"] = rid
    rec.setdefault("ontology_id", b["ontology_id"])
    if kind == "object_type":
        ontology._check_properties(rec["properties"], rec["primary_key"], rec["title_property"])
        if not ontology.IDENT.match(rec.get("api_name") or ""):
            raise HTTPException(400, "invalid API name")
        base = b["base"].get(key) or _main(key)
        if base and base.get("status") in ("active", "promoted") and base["api_name"] != rec["api_name"]:
            raise HTTPException(400, "the API name of an active object type cannot change")
        if base:
            kept = {p["api_name"] for p in rec["properties"]}
            gone = [p["api_name"] for p in base["properties"] if p["api_name"] not in kept and p.get("status") == "active"]
            if gone:
                raise HTTPException(400, f"active properties cannot be deleted: {', '.join(gone)}")
    elif kind == "action_type":
        t = _record(b, f"object_type:{rec.get('object_type_id')}")
        if not t:
            raise HTTPException(400, "the action type's object type does not exist on this branch")
        ontology._check_parameters(t, rec["kind"], rec["parameters"])
    elif kind == "link_type":
        for side in ("source", "target"):
            if not _record(b, f"object_type:{rec[side]['object_type_id']}"):
                raise HTTPException(400, "a link type's object types must exist on this branch")
    elif kind == "interface":
        names = [p.get("api_name") for p in rec.get("properties") or []]
        if len(set(names)) != len(names):
            raise HTTPException(400, "interface property API names must be unique")
    elif kind == "shared_property":
        om._check_shared(rec)


def _errors(b: dict) -> list[dict]:
    out = []
    for key, rec in b["changes"].items():
        try:
            _validate(b, key, json.loads(json.dumps(rec)) if rec else None)
        except HTTPException as e:
            out.append({"key": key, "error": e.detail})
    # resources deleted on the branch that other branch versions still use
    for key, rec in b["changes"].items():
        if rec is not None:
            continue
        kind, rid = _split(key)
        if kind == "object_type":
            users = [a["display_name"] for a in view(b, "action_type") if a["object_type_id"] == rid]
            users += [lt["display_name"] for lt in view(b, "link_type") if rid in (lt["source"]["object_type_id"], lt["target"]["object_type_id"])]
            if users:
                out.append({"key": key, "error": f"still used by {', '.join(users[:3])}"})
    return out


# ------------------------------------------------------------------------------------------------
# branches
# ------------------------------------------------------------------------------------------------


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=4000)
    ontology_id: Optional[str] = None


@router.get("/branches")
def list_branches(ontology_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    with _lock:
        out = []
        for b in _all("branches"):
            if ontology_id and b["ontology_id"] != ontology_id:
                continue
            if status and b["status"] != status:
                continue
            if om.role_of(b["ontology_id"]) is None:
                continue
            seen = _visible_keys(b)
            out.append({k: v for k, v in b.items() if k not in ("base", "changes", "changelog", "proposal")}
                       | {"proposal": _proposal_row(b, seen), "change_count": len(seen), "hidden_changes": len(b["changes"]) - len(seen),
                          "conflict_count": sum(_conflict(b, k) for k in seen)})
        return sorted(out, key=lambda b: b.get("updated_at", ""), reverse=True)


@router.post("/branches")
def create_branch(req: BranchIn) -> dict:
    with _lock:
        oid = req.ontology_id or "default"
        om.require_role(oid, "viewer", what="create branches")
        b = {"id": _new_id("br"), "name": req.name.strip(), "description": req.description.strip(), "ontology_id": oid,
             "status": "open", "created_by": _who(), "created_at": _now(), "rebased_at": None,
             "base": {}, "changes": {}, "changelog": [], "proposal": None}
        return _summary(_save(b))


@router.get("/branches/{branch_id}")
def get_branch(branch_id: str) -> dict:
    with _lock:
        return _summary(_branch(branch_id))


def _context(b: dict, sid: Optional[str]) -> dict:
    sc = _read(_path("scenarios", sid)) if sid else None
    edits = sum(len(v) for v in ((sc or {}).get("objects") or {}).values())
    links = sum(len(v.get("add") or []) + len(v.get("remove") or []) for v in ((sc or {}).get("links") or {}).values())
    return {"branch_id": b["id"], "branch_name": b["name"], "branch_status": b["status"], "ontology_id": b["ontology_id"],
            "scenario_id": sid, "scenario_rid": (sc or {}).get("rid"), "object_edits": edits, "link_edits": links,
            "functions": _function_status(b["id"])}


@router.post("/branches/{branch_id}/context")
def enter_context(branch_id: str) -> dict:
    """Work on the branch (Workshop opened on it, AIP Logic, actions): the data scenario its requests send in the
    scenario header, its object edits so far and its functions' state (rebase available, stale version targets)."""
    with _lock:
        b = _branch(branch_id)
        _open(b)
        return _context(b, _data_scenario(b))


@router.get("/branches/{branch_id}/context")
def get_context(branch_id: str) -> dict:
    with _lock:
        b = _branch(branch_id)
        return _context(b, b.get("data_scenario") if b["status"] == "open" else None)


class BranchLogicRun(BaseModel):
    inputs: dict[str, Any] = {}
    apply: bool = False


@router.post("/branches/{branch_id}/logic/{logic_id}/run")
def run_logic_on_branch(branch_id: str, logic_id: str, req: BranchLogicRun) -> dict:
    """AIP Logic on the branch: reads the branch's objects, applied edits go to the branch (never to main), and
    function-backed actions run the branch's function versions."""
    return run_logic_on(branch_id, logic_id, req.inputs, req.apply)


def run_logic_on(branch_id: str, logic_id: str, inputs: dict, apply: bool, trigger: Optional[dict] = None) -> dict:
    """A Logic run in the branch's context; the run records the branch and the function versions that ran (the
    branch's "Branched pre-release" versions or the main versions it sees). Refused once the branch merged or closed."""
    import functions_registry

    with branch_context(branch_id) as b:
        # filled while the run goes; the run is recorded at its end, with the list complete
        ran: list[dict] = []
        t_ran = functions_registry.RAN.set(ran)
        try:
            return ontology.run_logic(logic_id, inputs, apply, trigger=trigger,
                                      scenario={"id": ontology.SCENARIO.get(), "name": f"Branch {b['name']}", "branch_id": b["id"], "branch_name": b["name"],
                                                "functions": ran})
        finally:
            functions_registry.RAN.reset(t_ran)


def _open(b: dict) -> None:
    if b["status"] != "open":
        raise HTTPException(400, f"this branch is {b['status']}")


def _log(b: dict, key: str, op: str, fields: Optional[list[str]] = None) -> None:
    b["changelog"].append({"at": _now(), "user": _who(), "key": key, "op": op, "fields": fields or []})
    # a change after reviews: the task needs a fresh review
    if b.get("proposal"):
        b["proposal"]["reviews"].pop(key, None)


@router.get("/branches/{branch_id}/resources/{kind}")
def branch_resources(branch_id: str, kind: str) -> list[dict]:
    with _lock:
        b = _branch(branch_id)
        _key(kind, "x")
        # only the resources the caller may view (markings, ontology roles)
        return [r for r in view(b, kind) if _sees(b, f"{kind}:{r['id']}")]


@router.get("/branches/{branch_id}/resources/{kind}/{rid}")
def branch_resource(branch_id: str, kind: str, rid: str) -> dict:
    with _lock:
        b = _branch(branch_id)
        key = _key(kind, rid)
        rec = _record(b, key)
        if rec is None:
            raise HTTPException(404, f"{om.KIND_LABEL[kind]} not found on this branch")
        _require_sees(b, key)
        return {"record": rec, "main": _main(key), "changed": key in b["changes"], "conflict": _conflict(b, key)}


class ResourceIn(BaseModel):
    record: dict


@router.put("/branches/{branch_id}/resources/{kind}/{rid}")
def save_branch_resource(branch_id: str, kind: str, rid: str, req: ResourceIn) -> dict:
    """Save a resource's branch version ("new" creates one)."""
    with _lock:
        b = _branch(branch_id)
        _open(b)
        if rid == "new":
            rid = _new_id({"object_type": "ot", "action_type": "act", "link_type": "lt", "interface": "if", "shared_property": "sp"}[kind])
        key = _key(kind, rid)
        main = _main(key)
        # viewers may suggest changes on a branch; editing main still needs the editor role
        om.require_role(b["ontology_id"], "viewer", main, "suggest changes")
        # …of resources they may view (every version: main, the branch's base and its current version)
        _require_sees(b, key)
        rec = {**(b["changes"].get(key) or main or {}), **req.record}
        rec["id"] = rid
        rec.setdefault("created_at", _now())
        if kind == "object_type":
            rec.setdefault("ontology_id", b["ontology_id"])
            rec.setdefault("status", "experimental")
            rec.setdefault("plural_name", f"{rec.get('display_name', '')}s")
            rec.setdefault("api_name", ontology._api_name(rec.get("display_name") or "Item", True))
            rec.setdefault("primary_key", (rec.get("properties") or [{}])[0].get("api_name"))
            rec.setdefault("title_property", rec.get("primary_key"))
            rec.setdefault("icon", "cube")
            rec.setdefault("description", "")
            rec.setdefault("generate_primary_key", True)
            rec["properties"] = [ontology.dump_property(ontology.Property(**p)) for p in rec.get("properties") or []]
        _validate(b, key, rec)
        # the new version too (its backing datasets' markings, an action type's object type, a link type's ends)
        _require_sees(b, key, rec)
        _check_inheritance(key, b["base"].get(key) if key in b["changes"] else main, rec)
        if key not in b["changes"]:
            b["base"][key] = main
        if _same(rec, b["base"].get(key)):
            # back to its base: no longer a change
            b["changes"].pop(key, None)
            b["base"].pop(key, None)
        else:
            fields = _diff(b["changes"].get(key) or main, rec)
            b["changes"][key] = rec
            _log(b, key, "create" if main is None else "modify", fields)
        _save(b)
        return {"record": rec, "branch": _summary(b)}


@router.delete("/branches/{branch_id}/resources/{kind}/{rid}")
def delete_branch_resource(branch_id: str, kind: str, rid: str, discard: bool = False) -> dict:
    """Delete the resource on the branch, or (discard) drop the branch's change to it."""
    with _lock:
        b = _branch(branch_id)
        _open(b)
        key = _key(kind, rid)
        # as saving: viewers of the resource may suggest (deleting it, dropping the branch's change)
        om.require_role(b["ontology_id"], "viewer", _main(key) or b["changes"].get(key), "suggest changes")
        _require_sees(b, key)
        if discard:
            b["changes"].pop(key, None)
            b["base"].pop(key, None)
            b["changelog"].append({"at": _now(), "user": _who(), "key": key, "op": "discard", "fields": []})
        else:
            main = _main(key)
            if main is None and key not in b["changes"]:
                raise HTTPException(404, "not found")
            _validate(b, key, None)
            if key not in b["changes"]:
                b["base"][key] = main
            if main is None:
                b["changes"].pop(key, None)
                b["base"].pop(key, None)
            else:
                b["changes"][key] = None
            _log(b, key, "delete")
        _save(b)
        return _summary(b)


class RebaseIn(BaseModel):
    # key → "main" | "branch" | {"custom": record}
    resolutions: dict[str, Any] = {}


@router.post("/branches/{branch_id}/rebase")
def rebase(branch_id: str, req: RebaseIn) -> dict:
    """Bring in main's latest changes. Conflicts stay until each is resolved (main, branch or a custom version)."""
    with _lock:
        b = _branch(branch_id)
        _open(b)
        # rebasing changes the branch: those who may suggest changes on it (viewers of the ontology)
        om.require_role(b["ontology_id"], "viewer", None, "rebase branches")
        conflicts = [k for k in b["changes"] if _conflict(b, k)]
        unresolved = [k for k in conflicts if k not in req.resolutions]
        for k in req.resolutions:
            if k in b["changes"]:
                # resolving a conflict is a change to that resource
                _require_sees(b, k)
        if unresolved:
            seen = [k for k in unresolved if _sees(b, k)]
            return {"status": "conflicts", "conflicts": [{"key": k, "name": _label(k, b["changes"][k] or _main(k)), "base": b["base"].get(k),
                                                          "main": _main(k), "branch": b["changes"][k], "fields_main": _diff(b["base"].get(k), _main(k)),
                                                          "fields_branch": _diff(b["base"].get(k), b["changes"][k])} for k in seen],
                    "hidden_conflicts": len(unresolved) - len(seen), "branch": _summary(b)}
        for k, how in req.resolutions.items():
            if k not in b["changes"]:
                continue
            if how == "main":
                b["changes"].pop(k)
                b["base"].pop(k, None)
                b["changelog"].append({"at": _now(), "user": _who(), "key": k, "op": "use main", "fields": []})
                continue
            if isinstance(how, dict) and "custom" in how:
                rec = {**(_main(k) or {}), **how["custom"]}
                _validate(b, k, rec)
                _require_sees(b, k, rec)
                _check_inheritance(k, _main(k), rec)
                b["changes"][k] = rec
                _log(b, k, "custom resolution")
        for k in list(b["changes"]):
            new_base = _main(k)
            if not _same(b["base"].get(k), new_base) and b.get("proposal") and k in b["proposal"]["reviews"]:
                # the change now overwrites a newer main version than the one reviewed: it needs a fresh review
                b["proposal"]["reviews"].pop(k, None)
                b["changelog"].append({"at": _now(), "user": _who(), "key": k, "op": "rebased (reviews reset)", "fields": _diff(b["base"].get(k), new_base)})
            b["base"][k] = new_base
            if _same(b["changes"][k], b["base"][k]):
                b["changes"].pop(k)
                b["base"].pop(k)
        errors = _errors(b)
        b["rebased_at"] = _now()
        _save(b)
        shown = [e for e in errors if _sees(b, e["key"])]
        return {"status": "errors" if errors else "rebased", "errors": shown, "hidden_errors": len(errors) - len(shown), "branch": _summary(b)}


# ------------------------------------------------------------------------------------------------
# proposals
# ------------------------------------------------------------------------------------------------


class ProposalIn(BaseModel):
    title: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=8000)
    reviewers: Optional[list[str]] = None


def _need(c: dict, base: Optional[dict], rec: Optional[dict]) -> str:
    """The ontology role whose approval a task needs: owner for a promotion and for changes to who may see or edit the
    resource (roles, security policies, datasource markings, protection), editor otherwise."""
    promoting = c["kind"] == "object_type" and rec and rec.get("status") == "promoted" and (base or {}).get("status") != "promoted"
    return "owner" if promoting or _owner_fields(base, rec) else "editor"


def _not_counted(b: dict, key: str, user: str, r: dict, need: str, people: dict) -> Optional[str]:
    """Why a review does not count towards approval now (None: it counts). Sign-in on: the reviewer must still be an
    active user, still hold the role the task needs on the resource and still be able to view it — checked as that
    user (run_as), every time, as an approved request is checked again when it is applied (approvals._invoke_blocked).
    Sign-in off: the role recorded with the review."""
    recorded = r.get("counts_as")
    had = bool(recorded) and om.ROLES.index(recorded) >= om.ROLES.index(need)
    if not auth.enabled():
        return None if had else f"needs an ontology {need}"
    if not had:
        return f"needs an ontology {need}"
    if not user or user in ("local", "system"):
        return "made while sign-in was off"
    if user not in people:
        people[user] = auth.principal_of(user)
    p = people[user]
    if p is None:
        return f"no longer counts: {run_as.who(user)} is {(auth.user_label(user) or {}).get('status', 'deleted')}"
    base = b["base"].get(key) or _main(key)
    with run_as.acting_as(p):
        if not _sees(b, key):
            return f"no longer counts: {run_as.who(user)} can no longer view this resource (markings or ontology role)"
        if not _role_at_least(b["ontology_id"], base, need):
            return f"no longer counts: {run_as.who(user)} is no longer an ontology {need} of this resource"
    return None


def _tasks(b: dict) -> list[dict]:
    p = b["proposal"]
    out = []
    people: dict = {}
    for c in _changes(b):
        reviews = p["reviews"].get(c["key"], {})
        rec = b["changes"].get(c["key"])
        base = b["base"].get(c["key"])
        need = _need(c, base, rec)
        rows = []
        for u, r in reviews.items():
            why = _not_counted(b, c["key"], u, r, need, people)
            rows.append({"user": u, **r, "counts": why is None, **({"not_counted": why} if why else {})})
        counted = [r for r in rows if r["counts"]]
        status = "rejected" if any(r["decision"] == "reject" for r in counted) else "approved" if any(r["decision"] == "approve" for r in counted) else "in_progress"
        out.append({**c, "status": status, "needs": need, "owner_fields": _owner_fields(base, rec), "reviews": rows})
    return out


def _author_problem(b: dict) -> Optional[str]:
    """Why the branch's changes cannot be merged for its author now (None: they can): sign-in on, the author must
    still be an active user — a merge applies the author's changes on the strength of the approvals."""
    if not auth.enabled():
        return None
    uid = b.get("created_by")
    if not uid or uid in ("local", "system"):
        return "the branch was made while sign-in was off and has no author it can be merged for: make the changes on a new branch"
    if auth.principal_of(uid) is None:
        return f"its author {run_as.who(uid)} is {(auth.user_label(uid) or {}).get('status', 'deleted')}"
    return None


def _checks(b: dict, changes: list[dict], tasks: list[dict]) -> dict:
    conflicts = [c["key"] for c in changes if c["conflict"]]
    errors = _errors(b)
    pending = [t["key"] for t in tasks if t["status"] != "approved"]
    # the design review's merge blocking (ontology_design.py): new high-severity findings on the branch
    design = ontology.MODEL_HOOKS["design_blocking"](b) if "design_blocking" in ontology.MODEL_HOOKS else []
    # functions published on the branch whose version target main released meanwhile: pick a new target first
    stale = ontology.MODEL_HOOKS["branch_function_checks"](b["id"]) if "branch_function_checks" in ontology.MODEL_HOOKS else []
    author = _author_problem(b)
    # approvals that stopped counting (reviewer deactivated, deleted, lost the role or a marking)
    lapsed = [{"key": t["key"], "name": t["name"], "user": r["user"], "reason": r["not_counted"]} for t in tasks for r in t["reviews"]
              if (r.get("not_counted") or "").startswith("no longer counts") or r.get("not_counted") == "made while sign-in was off"]
    return {"conflicts": conflicts, "errors": errors, "unapproved": pending, "design_findings": design, "function_targets": stale, "has_changes": bool(changes),
            "author": author, "lapsed_approvals": lapsed,
            "mergeable": bool(changes) and not conflicts and not errors and not pending and not design and not stale and not author}


def _require_author_or_editor(b: dict, what: str) -> None:
    """The branch's author (still a viewer of the ontology) or an editor / owner of the ontology."""
    if _role_at_least(b["ontology_id"], None, "editor"):
        return
    me = _who()
    if me == b.get("created_by") and me not in ("local", "system") and _role_at_least(b["ontology_id"], None, "viewer"):
        return
    o = om.get_ontology(b["ontology_id"])
    raise HTTPException(403, f"Only the branch's author or an editor of {o['name']} may {what}")


@router.post("/branches/{branch_id}/proposal")
def create_proposal(branch_id: str, req: ProposalIn) -> dict:
    with _lock:
        b = _branch(branch_id)
        _open(b)
        _require_author_or_editor(b, "create or edit this branch's proposal")
        if not b["changes"]:
            raise HTTPException(400, "the branch has no changes to propose")
        if b.get("proposal"):
            p = b["proposal"]
            if req.title is not None:
                p["title"] = req.title.strip() or p["title"]
            if req.description is not None:
                p["description"] = req.description.strip()
            if req.reviewers is not None:
                p["reviewers"] = sorted(set(req.reviewers))
        else:
            b["proposal"] = {"id": _new_id("prop"), "title": (req.title or b["name"]).strip(), "description": (req.description or b["description"]).strip(),
                             "reviewers": sorted(set(req.reviewers or [])), "reviews": {}, "comments": [], "created_at": _now(), "created_by": _who(),
                             "status": "in_review"}
        _save(b)
        return _summary(b)


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    # the tasks reviewed; empty: every task
    keys: list[str] = []
    comment: Optional[str] = Field(None, max_length=4000)


@router.post("/branches/{branch_id}/reviews")
def review(branch_id: str, req: ReviewIn) -> dict:
    with _lock:
        b = _branch(branch_id)
        _open(b)
        p = b.get("proposal")
        if not p:
            raise HTTPException(400, "create a proposal first")
        user = _who()
        # every task the caller may view (the others are not shown to them)
        keys = req.keys or sorted(_visible_keys(b))
        if not keys:
            raise HTTPException(403 if b["changes"] else 400, "the changes on this branch are on resources you cannot view (markings or ontology roles)"
                                if b["changes"] else "the branch has no changes")
        for k in keys:
            if k not in b["changes"] or not _sees(b, k):
                # a change on a resource the caller cannot view is not there for them
                raise HTTPException(404, f"{k} is not changed on this branch")
        for k in keys:
            base = b["base"].get(k) or _main(k)
            # anyone who may view the resource may review; only editors and owners of it count towards approval
            try:
                role = om.role_of(b["ontology_id"], base)
            except HTTPException:
                role = None
            counts = role if role in ("editor", "owner") else None
            p["reviews"].setdefault(k, {})[user] = {"decision": req.decision, "at": _now(), "counts_as": counts}
        if req.comment:
            p["comments"].append({"id": _new_id("c"), "key": keys[0] if len(keys) == 1 else None, "user": user, "text": req.comment.strip(), "at": _now()})
        tasks = _tasks(b)
        p["status"] = "approved" if tasks and all(t["status"] == "approved" for t in tasks) else "in_review"
        _save(b)
        return _summary(b)


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    key: Optional[str] = None


@router.post("/branches/{branch_id}/comments")
def comment(branch_id: str, req: CommentIn) -> dict:
    with _lock:
        b = _branch(branch_id)
        if not b.get("proposal"):
            raise HTTPException(400, "create a proposal first")
        om.require_role(b["ontology_id"], "viewer", None, "comment on proposals")
        if req.key and (req.key not in b["changes"] or not _sees(b, req.key)):
            raise HTTPException(404, f"{req.key} is not changed on this branch")
        b["proposal"]["comments"].append({"id": _new_id("c"), "key": req.key, "user": _who(), "text": req.text.strip(), "at": _now()})
        _save(b)
        return _summary(b)


def _write_main(key: str, rec: Optional[dict]) -> None:
    kind, rid = _split(key)
    folder = FOLDER[kind]
    if rec is None:
        if kind == "object_type":
            ontology.delete_object_type(rid)
        elif kind == "action_type":
            ontology.delete_action_type(rid)
        elif kind == "link_type":
            om.delete_link_type(rid)
        elif kind == "interface":
            om.delete_interface(rid)
        else:
            om.delete_shared_property(rid)
        return
    old = _main(key)
    if kind == "object_type":
        om._check_type(rec)
        if old is None:
            ontology.ensure_objects(rid)
            rec.setdefault("origin_ontology_id", rec.get("ontology_id", "default"))
    elif kind == "link_type":
        om._check_link_type(rec)
        if rec["kind"] == "join_table" and not (ontology.DIR / "links" / f"{rid}.json").exists():
            _write(ontology.DIR / "links" / f"{rid}.json", [])
    elif kind == "interface":
        om._check_interface(rec)
    _put(folder, rec)
    if kind == "object_type":
        om._on_status_changed(rec, old)
    if kind == "shared_property":
        om._propagate_shared(rec)


def _refuse_merge(b: dict, why: str, code: int) -> None:
    """Nothing is merged: the proposal records why (shown on the proposal and in Approvals) and the caller is told."""
    b["proposal"]["merge_refused"] = {"at": _now(), "by": _who(), "reason": why}
    b["changelog"].append({"at": _now(), "user": _who(), "key": None, "op": "merge refused", "fields": [], "reason": why})
    _save(b)
    raise HTTPException(code, f"The proposal cannot merge: {why}. Nothing was merged")


@router.post("/branches/{branch_id}/merge")
def merge(branch_id: str) -> dict:
    with _lock:
        b = _branch(branch_id)
        _open(b)
        if not b.get("proposal"):
            raise HTTPException(400, "create a proposal and get it approved first")
        # anyone who can view the branch's changes may merge an approved proposal (Foundry: "anyone who can view the
        # branch can merge the proposal as long as all the required approvals are obtained")
        om.require_role(b["ontology_id"], "viewer", None, "merge proposals")
        hidden = len(b["changes"]) - len(_visible_keys(b))
        if hidden:
            _refuse_merge(b, _hidden_reason(hidden), 403)
        changes = _changes(b)
        tasks = _tasks(b)
        checks = _checks(b, changes, tasks)
        if not checks["mergeable"]:
            lapsed = checks["lapsed_approvals"]
            why = (f"its author can no longer merge it: {checks['author']}" if checks["author"]
                   else "conflicts with main: rebase first" if checks["conflicts"] else "invalid resources: " + "; ".join(e["error"] for e in checks["errors"][:3])
                   if checks["errors"] else f"{len(checks['unapproved'])} tasks are not approved" + (
                       f" (approvals that no longer count: {'; '.join(sorted({x['reason'] for x in lapsed}))})" if lapsed else "") if checks["unapproved"]
                   else "new high-severity design review findings: " + "; ".join(f["label"] for f in checks["design_findings"][:3]) if checks["design_findings"]
                   else "function version targets released on main meanwhile (rebase the functions with new targets): "
                   + ", ".join(f"{s['repository']} {s['target']}" for s in checks["function_targets"][:3]) if checks["function_targets"]
                   else "no changes")
            _refuse_merge(b, why, 400)
        # stopping a datasource marking's inheritance removes it from the object type: the merger needs that permission too
        for key, rec in b["changes"].items():
            _check_inheritance(key, _main(key), rec)
        token = om.MERGING.set(True)
        try:
            # object types first (others refer to them), deletions last
            order = {"shared_property": 0, "interface": 1, "object_type": 2, "link_type": 3, "action_type": 4}
            items = sorted(b["changes"].items(), key=lambda kv: (kv[1] is None, order[_split(kv[0])[0]] if kv[1] is not None else -order[_split(kv[0])[0]]))
            for key, rec in items:
                _write_main(key, json.loads(json.dumps(rec)) if rec else None)
        finally:
            om.MERGING.reset(token)
        b["status"] = "merged"
        b["proposal"]["status"] = "merged"
        b["proposal"].pop("merge_refused", None)
        b["merged_at"] = _now()
        b["merged_by"] = _who()
        _save(b)
        # action edits made on the branch are for testing: they do not merge into main
        _end_data(b)
    # functions published on the branch: their version targets are published on main (functions_registry.py)
    if "branch_merged" in ontology.MODEL_HOOKS:
        published = ontology.MODEL_HOOKS["branch_merged"](branch_id)
        if published:
            with _lock:
                b = _branch(branch_id)
                b["functions_published"] = published
                _save(b)
    with _lock:
        return _summary(_branch(branch_id))


@router.post("/branches/{branch_id}/close")
def close(branch_id: str) -> dict:
    with _lock:
        b = _branch(branch_id)
        _open(b)
        _require_author_or_editor(b, "close this branch")
        b["status"] = "closed"
        if b.get("proposal"):
            b["proposal"]["status"] = "closed"
        _save(b)
        _end_data(b)
    if "branch_closed" in ontology.MODEL_HOOKS:
        ontology.MODEL_HOOKS["branch_closed"](branch_id)
    with _lock:
        return _summary(_branch(branch_id))


@router.get("/proposals")
def proposals(tab: Literal["mine", "assigned", "review", "merged", "closed", "all"] = "all", ontology_id: Optional[str] = None) -> list[dict]:
    me = _who()
    with _lock:
        out = []
        for b in _all("branches"):
            p = b.get("proposal")
            if not p or (ontology_id and b["ontology_id"] != ontology_id) or om.role_of(b["ontology_id"]) is None:
                continue
            if tab == "mine" and b.get("created_by") != me:
                continue
            if tab == "assigned" and me not in p["reviewers"]:
                continue
            if tab == "review" and p["status"] not in ("in_review", "approved"):
                continue
            if tab in ("merged", "closed") and p["status"] != tab:
                continue
            # title and description are discoverable; changes (and comments on them) only to those who may view them
            seen = _visible_keys(b)
            row = _proposal_row(b, seen) or {}
            out.append({"branch_id": b["id"], "branch": b["name"], "ontology_id": b["ontology_id"], **{k: v for k, v in row.items() if k != "reviews"},
                        "change_count": len(seen), "hidden_changes": len(b["changes"]) - len(seen), "created_by": b.get("created_by"), "updated_at": b.get("updated_at")})
        return sorted(out, key=lambda r: r.get("updated_at") or "", reverse=True)


# ------------------------------------------------------------------------------------------------
# migration between ontologies
# ------------------------------------------------------------------------------------------------


class MigrateIn(BaseModel):
    target_ontology_id: str
    # "object_type:<id>", "link_type:<id>", …
    resources: list[str]


def _connected(keys: set[str]) -> dict[str, list[str]]:
    """Resources that must move along with the selection: key → why."""
    need: dict[str, list[str]] = {}
    types = {_split(k)[1] for k in keys if k.startswith("object_type:")}
    for lt in _all("link-types"):
        ends = {lt["source"]["object_type_id"], lt["target"]["object_type_id"]} | ({lt["backing"]["object_type_id"]} if lt.get("backing") else set())
        if ends & types:
            need.setdefault(f"link_type:{lt['id']}", []).append(f"links {', '.join(sorted(ends & types))}")
            for e in ends - types:
                need.setdefault(f"object_type:{e}", []).append(f"linked through {lt['display_name']}")
        if f"link_type:{lt['id']}" in keys:
            for e in ends - types:
                need.setdefault(f"object_type:{e}", []).append(f"an end of {lt['display_name']}")
    for a in _all("action-types"):
        if a["object_type_id"] in types:
            need.setdefault(f"action_type:{a['id']}", []).append("acts on a moved object type")
        if f"action_type:{a['id']}" in keys and a["object_type_id"] not in types:
            need.setdefault(f"object_type:{a['object_type_id']}", []).append(f"the object type of {a['display_name']}")
    for t in _all("object-types"):
        if t["id"] not in types:
            continue
        for imp in t.get("implements") or []:
            need.setdefault(f"interface:{imp['interface_id']}", []).append(f"implemented by {t['display_name']}")
        for p in t["properties"]:
            if p.get("shared_property_id"):
                need.setdefault(f"shared_property:{p['shared_property_id']}", []).append(f"used by {t['display_name']}.{p['api_name']}")
    return {k: v for k, v in need.items() if k not in keys}


@router.post("/migrate/preview")
def migrate_preview(req: MigrateIn) -> dict:
    with _lock:
        target = om.get_ontology(req.target_ontology_id)
        keys = set(req.resources)
        missing: dict[str, list[str]] = {}
        frontier = set(keys)
        # connected resources, transitively
        while True:
            more = _connected(frontier | set(missing))
            new = {k: v for k, v in more.items() if k not in missing}
            if not new:
                break
            missing.update(new)
        problems = []
        rows = []
        for k in sorted(keys | set(missing)):
            rec = _main(k)
            if not rec:
                problems.append(f"{k} does not exist")
                continue
            src = rec.get("ontology_id", "default")
            if k.startswith("object_type:") and target["kind"] == "default" and src != "default" and rec.get("origin_ontology_id", src) != "default":
                problems.append(f"{rec['display_name']} was created in a private ontology: it cannot move to the default ontology")
            if src == target["id"]:
                problems.append(f"{_label(k, rec)} is already in {target['name']}")
            rows.append({"key": k, "name": _label(k, rec), "from": src, "selected": k in keys, "required_by": missing.get(k, [])})
        return {"target": target, "resources": rows, "missing": sorted(missing), "problems": problems, "ok": not missing and not problems}


@router.post("/migrate")
def migrate(req: MigrateIn) -> dict:
    """Move resources (with every connected resource selected) to another ontology; objects and edits move along."""
    with _lock:
        preview = migrate_preview(req)
        if preview["missing"]:
            raise HTTPException(400, "select the connected resources too: " + ", ".join(preview["missing"][:6]))
        if preview["problems"]:
            raise HTTPException(400, "; ".join(preview["problems"][:4]))
        target = req.target_ontology_id
        for k in req.resources:
            rec = _main(k)
            om.require_role(rec.get("ontology_id"), "owner", rec, "migrate resources")
            om.require_role(target, "editor", None, "receive migrated resources")
        token = om.MERGING.set(True)
        try:
            for k in req.resources:
                kind, rid = _split(k)
                rec = _main(k)
                if kind != "action_type":
                    rec["ontology_id"] = target
                    _put(FOLDER[kind], rec)
        finally:
            om.MERGING.reset(token)
        return {"migrated": req.resources, "target_ontology_id": target}
