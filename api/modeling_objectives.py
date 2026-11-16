"""Model lifecycle workspaces, reflecting the Foundry Modeling Objectives workflow.

Objectives hold submissions, evaluation evidence, checks, releases and deployments. A submission is a
version of a model resource (model_assets.py: trained in a transform, container-backed or externally
hosted); releases go to staging and are marked as production; live and batch deployments of a release
run (model_deployments.py), and automatic evaluation builds inference and metrics per submission
(model_evaluation.py). The older free-text candidates (/candidates, /deploy, /functions) remain as
records only: they name no model version, so nothing can run for them.
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import ontology

router = APIRouter(prefix="/api/modeling-objectives")
_lock = threading.RLock()
SOURCES = ("in_platform", "imported_file", "container", "external_api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _folder() -> Path:
    folder = ontology.DIR / "modeling-objectives"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _path(objective_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", objective_id):
        raise HTTPException(404, "Modeling objective not found")
    return _folder() / f"{objective_id}.json"


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return None


def _write(record: dict) -> dict:
    record["updated_at"] = _now()
    path = _path(record["id"])
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, path)
    return record


def _get(objective_id: str, need: Optional[str] = "viewer") -> dict:
    """The objective; the caller needs the role `need` on it (viewer reads, editor changes, owner shares and deletes).
    Background jobs, the system and sign-in off pass every check."""
    rec = _read(_path(objective_id))
    if rec is None:
        raise HTTPException(404, "Modeling objective not found")
    if need:
        _require(rec, need)
    return rec


# -- sharing: viewer / editor / owner grants to users, groups or everyone ------------------------------------------
# The grant format and principal keys are the Ontology's (ontology_model.py: [{principal: "user:<id>" | "group:<id>" |
# "everyone", role}]), principals are checked against the user directory (auth._clean_principals), and the roles of
# the objective's Project (auth.role_for) apply on top. An objective without grants (made before sharing existed) is
# open to everyone; a new one starts with its creator as owner.

SHARE_ROLES = ("viewer", "editor", "owner")


def _caller() -> Optional[dict]:
    """The signed-in user; None for sign-in off, the system and services (they may do everything)."""
    import auth

    p = auth.current()
    if not auth.enabled() or p is None or p.get("service"):
        return None
    return p


def _role(rec: dict, p: Optional[dict] = None, *, anyone: bool = False) -> Optional[str]:
    """The caller's role on an objective (or `p`'s when `anyone` is False and p is given): owner for administrators
    and open objectives, else the best of their grants (user, groups, everyone) and their Project role."""
    if p is None and not anyone:
        p = _caller()
    if p is None or p.get("role") == "admin":
        return "owner"
    grants = rec.get("roles") or []
    if not grants and not rec.get("project_id"):
        return "owner"  # open: made before sharing existed, in no Project (in one, its roles decide)
    import auth

    who = {"everyone"} | auth._principal_keys(p)
    best = max((SHARE_ROLES.index(g["role"]) for g in grants if g.get("principal") in who and g.get("role") in SHARE_ROLES), default=-1)
    if rec.get("project_id"):
        try:
            pr = auth.role_for(rec["project_id"], p)
        except Exception:  # noqa: BLE001 - a Project that is gone grants nothing
            pr = None
        if pr in SHARE_ROLES:
            best = max(best, SHARE_ROLES.index(pr))
    return SHARE_ROLES[best] if best >= 0 else None


_NEED_WHAT = {"viewer": "open it", "editor": "change it", "owner": "share or delete it"}


def _require(rec: dict, need: str) -> None:
    have = _role(rec)
    if have is None:
        raise HTTPException(404, "Modeling objective not found")  # no role: it does not show that it exists
    if SHARE_ROLES.index(have) < SHARE_ROLES.index(need):
        raise HTTPException(403, f"You need the {need} role on {rec['name']} to {_NEED_WHAT.get(need, 'do this')} (you are a {have})")


def _initial_roles() -> list[dict]:
    p = _caller()
    return [{"principal": f"user:{p['id']}", "role": "owner"}] if p and p.get("id") not in (None, "local", "system") else []


def _candidate(rec: dict, candidate_id: str) -> dict:
    candidate = next((item for item in rec["candidates"] if item["id"] == candidate_id), None)
    if candidate is None:
        raise HTTPException(404, "Model candidate not found")
    return candidate


class ObjectiveIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    success_metric: str = Field(min_length=1, max_length=100)
    metric_direction: Literal["maximize", "minimize"] = "maximize"
    threshold: Optional[float] = None
    ontology_object_type_id: Optional[str] = None
    # the Files Project the objective is saved in: its roles apply to the objective, review attachments are stored there
    project_id: Optional[str] = Field(default=None, max_length=64)


class CandidateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=100)
    source: Literal["in_platform", "imported_file", "container", "external_api"]
    source_uri: str = Field(min_length=1, max_length=2000)
    description: str = Field(default="", max_length=2000)
    model_artifact: Optional[dict] = None
    adapter: Optional[dict] = None
    metadata: dict = Field(default_factory=dict)


class EvaluationIn(BaseModel):
    value: float
    notes: str = Field(default="", max_length=2000)
    dataset_id: Optional[str] = Field(default=None, max_length=300)
    metrics: dict[str, float] = Field(default_factory=dict)


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: Optional[str] = Field(default=None, max_length=300)
    dataset_name: Optional[str] = Field(default=None, max_length=300)
    parameters: dict = Field(default_factory=dict)
    metrics: dict[str, float] = Field(default_factory=dict)


class DeploymentIn(BaseModel):
    version: str = Field(min_length=1, max_length=100)
    environment_tag: str = Field(min_length=1, max_length=80)
    release_note: str = Field(default="", max_length=2000)
    deployment_type: Literal["batch", "live"] = "batch"
    input_dataset_id: Optional[str] = Field(default=None, max_length=300)
    output_dataset_id: Optional[str] = Field(default=None, max_length=300)
    endpoint_name: Optional[str] = Field(default=None, max_length=200)


class ModelFunctionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    api_name: str = Field(min_length=1, max_length=100)
    ontology_object_type_id: str = Field(min_length=1, max_length=100)
    inputs: dict = Field(default_factory=dict)
    outputs: dict = Field(default_factory=dict)


class FeedbackIn(BaseModel):
    value: float
    notes: str = Field(default="", max_length=2000)


@router.get("")
def list_objectives() -> list[dict]:
    folder = _folder()
    with _lock:
        return sorted(
            (_view(record) for path in folder.glob("*.json") if (record := _read(path)) is not None and _role(record) is not None),
            key=lambda item: item.get("updated_at", ""),
            reverse=True,
        )


# -- the Model Library (the list of objectives) and an objective's overview page ----------------------------------


def _released_candidate(rec: dict) -> tuple[Optional[dict], Optional[dict]]:
    """(submission, release) that describes the objective: its production release, else staging, else the newest
    submission that is not archived (no release)."""
    for env in ("production", "staging"):
        rel = _current_release(rec, env)
        c = rel and next((x for x in rec["candidates"] if x.get("submission_id") == rel["submission_id"]), None)
        if c:
            return c, rel
    live = [c for c in rec["candidates"] if not c.get("archived")]
    return (live[-1] if live else None), None


def _api_fields(candidate: Optional[dict]) -> dict[str, list[dict]]:
    """The model API of a submission as flat fields: the columns of tabular inputs / outputs, and parameters."""
    out: dict[str, list[dict]] = {"inputs": [], "outputs": []}
    for side in out:
        for item in ((candidate or {}).get("api") or {}).get(side) or []:
            if item.get("type") == "tabular" and item.get("columns"):
                out[side] += [{"name": c["name"], "type": c.get("type") or "any", "of": item["name"]} for c in item["columns"]]
            else:
                out[side].append({"name": item["name"], "type": item.get("value_type") or item.get("type") or "any", "of": None})
    return out


def _mapping(rec: dict, deps: list[dict]) -> dict[str, dict]:
    """Model field → Ontology property: what the overview's editor saved, else (inputs) the object binding of a
    deployment's model function."""
    saved = rec.get("api_mapping") or {}
    out = {"inputs": dict(saved.get("inputs") or {}), "outputs": dict(saved.get("outputs") or {})}
    if not saved.get("inputs"):
        for d in deps:
            b = (d.get("function") or {}).get("object_binding") or {}
            if b.get("object_type_id") and b.get("properties"):
                out["inputs"] = {col: {"object_type_id": b["object_type_id"], "property": prop} for col, prop in b["properties"].items()}
                break
    return out


def _resolve_mapping(fields: list[dict], mapping: dict) -> list[dict]:
    """Each field with its mapped property's names and type (None when unmapped or the property is gone)."""
    types: dict[str, Optional[dict]] = {}
    out = []
    for f in fields:
        m = mapping.get(f["name"])
        target = None
        if m:
            tid = m.get("object_type_id")
            if tid not in types:
                try:
                    types[tid] = ontology._object_type(tid)
                except HTTPException:
                    types[tid] = None
            t = types[tid]
            p = t and next((p for p in t["properties"] if p["api_name"] == m.get("property")), None)
            if t and p:
                target = {"object_type_id": tid, "object_type": t["display_name"], "icon": t.get("icon"), "color": t.get("color"),
                          "property": p["api_name"], "property_name": p.get("display_name") or p["api_name"], "type": p["type"]}
        out.append({**f, "mapping": target})
    return out


def _side_summary(fields: list[dict]) -> Optional[dict]:
    """A library row's Inputs / Outputs cell: the mapped object types and how many properties are mapped."""
    mapped = [f["mapping"] for f in fields if f.get("mapping")]
    if not mapped:
        return None
    seen: dict[str, dict] = {}
    for m in mapped:
        seen.setdefault(m["object_type_id"], {"id": m["object_type_id"], "name": m["object_type"], "icon": m.get("icon"), "color": m.get("color")})
    return {"object_types": list(seen.values()), "properties": len(mapped)}


def _model_path(candidate: Optional[dict]) -> list[str]:
    """The Files location (Project first) of a submission's model; [] when it is gone or hidden."""
    if not candidate or not candidate.get("model_id"):
        return []
    try:
        import model_assets

        return model_assets._item_path(model_assets._get(candidate["model_id"])[0])
    except Exception:  # noqa: BLE001 - a deleted or hidden model only loses the location
        return []


def _deployments_of(objective_id: str) -> list[dict]:
    try:
        import model_deployments

        return [d for d in model_deployments._all() if d.get("objective_id") == objective_id]
    except Exception:  # noqa: BLE001
        return []


def _status(rec: dict, deps: list[dict]) -> str:
    if any(d.get("status") == "running" for d in deps):
        return "deployed"
    return "in_progress" if any(not c.get("archived") for c in rec["candidates"]) else "not_started"


def _linked_type(rec: dict, cache: dict) -> Optional[dict]:
    """The objective's own Ontology object type (ontology_object_type_id) with its icon and color; None when unset or gone."""
    tid = rec.get("ontology_object_type_id")
    if not tid:
        return None
    if tid not in cache:
        try:
            t = ontology._object_type(tid)
            cache[tid] = {"id": tid, "name": t["display_name"], "icon": t.get("icon"), "color": t.get("color")}
        except HTTPException:
            cache[tid] = None
    return cache[tid]


def _library_row(rec: dict, types: Optional[dict] = None) -> dict:
    deps = _deployments_of(rec["id"])
    candidate, release = _released_candidate(rec)
    fields, mapping = _api_fields(candidate), _mapping(rec, deps)
    path = _model_path(candidate)
    last = (rec.get("releases") or [None])[-1]
    own = _project_info(rec)  # the Project the objective is saved in, else the one its model is in
    return {"id": rec["id"], "name": rec["name"], "description": rec.get("description") or "", "favorite": _me() in (rec.get("favorited_by") or []),
            "project": (own or {}).get("name") or (path[0] if path else None), "project_id": own and own["id"], "path": path,
            "my_role": _role(rec), "shared": bool(rec.get("roles")),
            "inputs": _side_summary(_resolve_mapping(fields["inputs"], mapping["inputs"])), "input_fields": len(fields["inputs"]),
            "outputs": _side_summary(_resolve_mapping(fields["outputs"], mapping["outputs"])), "output_fields": len(fields["outputs"]),
            "model": candidate and {"name": candidate["name"], "model_id": candidate.get("model_id"), "version": candidate.get("version"),
                                    "release": release and release["version"], "environment": release and release["environment"]},
            "last_updated": {"kind": "released", "at": last["created_at"]} if last else {"kind": "updated", "at": rec.get("updated_at") or rec["created_at"]},
            "status": _status(rec, deps), "models": sum(1 for c in rec["candidates"] if not c.get("archived")), "deployments": len(deps),
            "object_type": _linked_type(rec, types if types is not None else {}), "required_reviews": int(rec.get("required_reviews") or 0)}


@router.get("/library")
def library() -> dict:
    """The Model Library: every objective with its mapped inputs / outputs, production (else staging) model, last
    release and status — not started (no submissions), in progress (models, no running deployment) or deployed."""
    folder = _folder()
    with _lock:
        recs = [r for path in folder.glob("*.json") if (r := _read(path)) is not None and _role(r) is not None]
    linked: dict[str, Optional[dict]] = {}
    rows = sorted((_library_row(r, linked) for r in recs), key=lambda r: (not r["favorite"], r["name"].lower()))
    types: dict[str, dict] = {}
    for r in rows:
        for side in ("inputs", "outputs"):
            for t in (r[side] or {}).get("object_types") or []:
                types[t["id"]] = t
    return {"objectives": rows, "projects": sorted({r["project"] for r in rows if r["project"]}),
            "object_types": sorted(types.values(), key=lambda t: t["name"].lower())}


class FavoriteIn(BaseModel):
    favorite: bool = True


@router.put("/{objective_id}/favorite")
def set_favorite(objective_id: str, req: FavoriteIn) -> dict:
    """Star an objective for the current user (starred objectives lead the Model Library)."""
    me = _me()
    with _lock:
        rec = _get(objective_id)
        favs = [u for u in rec.get("favorited_by") or [] if u != me]
        rec["favorited_by"] = favs + [me] if req.favorite else favs
        path = _path(rec["id"])  # not _write: starring is not an update of the objective
        tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, path)
    return {"id": objective_id, "favorite": req.favorite}


class RelevantLink(BaseModel):
    # the overview's side cards: Relevant files (Files items), Modules (Workshop), Graphs (Vertex), Chained Models
    kind: Literal["file", "module", "graph", "model"]
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=300)


class MappingTarget(BaseModel):
    object_type_id: str = Field(min_length=1, max_length=200)
    property: str = Field(min_length=1, max_length=200)


class OverviewIn(BaseModel):
    # Markdown shown on the Objective page (prediction goal, data sources, production deployment …)
    overview: Optional[str] = Field(default=None, max_length=20_000)
    relevant: Optional[list[RelevantLink]] = Field(default=None, max_length=60)
    # the Modeling objective API: model field → Ontology property, per side
    api_mapping: Optional[dict[Literal["inputs", "outputs"], dict[str, MappingTarget]]] = None


def _relevant(rec: dict) -> list[dict]:
    """The linked resources; Files items with their current name and location (dropped from view when gone or hidden)."""
    out = []
    for link in rec.get("relevant") or []:
        item = dict(link)
        if link["kind"] == "file":
            try:
                import db
                import drive

                it = drive._item(link["id"])
                item.update(name=it["name"], path=[x["name"] for x in db.drive_path(it["id"])[:-1]], content_type=it.get("content_type"), item_kind=it["kind"],
                            missing=bool(it.get("trashed_at")))
            except Exception:  # noqa: BLE001 - deleted, or not visible to this user
                item["missing"] = True
        elif link["kind"] == "model":
            try:
                import model_assets

                m = model_assets._get(link["id"])[0]
                item.update(name=m["name"], path=model_assets._item_path(m), model_kind=m.get("kind", "container"))
            except Exception:  # noqa: BLE001
                item["missing"] = True
        out.append(item)
    return out


def _overview(rec: dict) -> dict:
    deps = _deployments_of(rec["id"])
    candidate, release = _released_candidate(rec)
    fields, mapping = _api_fields(candidate), _mapping(rec, deps)
    last = (rec.get("releases") or [None])[-1]
    latest = None
    if last:
        c = next((x for x in rec["candidates"] if x.get("submission_id") == last["submission_id"]), None)
        envs = [env for env in ENVIRONMENTS if (cur := _current_release(rec, env)) and cur["submission_id"] == last["submission_id"]]
        by = None
        try:
            import auth

            u = auth.user_label(last.get("created_by")) if last.get("created_by") not in (None, "system") else None
            by = u and (u.get("display_name") or u.get("username"))
        except Exception:  # noqa: BLE001
            pass
        latest = {"version": last["version"], "environments": envs, "environment": last["environment"], "at": last["created_at"], "by": by,
                  "note": last.get("release_note") or "", "model": c and c["name"], "model_id": c and c.get("model_id"), "model_version": c and c.get("version"),
                  "deployments": len(deps)}
    return {"id": rec["id"], "name": rec["name"], "description": rec.get("description") or "", "overview": rec.get("overview") or "",
            "favorite": _me() in (rec.get("favorited_by") or []), "path": _model_path(candidate), "status": _status(rec, deps),
            "api": {"model": candidate and {"name": candidate["name"], "version": candidate.get("version"), "release": release and release["version"],
                                            "environment": release and release["environment"]},
                    "inputs": _resolve_mapping(fields["inputs"], mapping["inputs"]), "outputs": _resolve_mapping(fields["outputs"], mapping["outputs"]),
                    "saved": bool(rec.get("api_mapping"))},
            "latest_release": latest, "relevant": _relevant(rec)}


@router.get("/{objective_id}/models-meta")
def models_meta(objective_id: str) -> dict:
    """Per submission, what the Models tables show beside the objective's own record: the model version's size and
    who submitted it (a name), and how many reviews (check approvals, rejections and comments) it has."""
    with _lock:
        rec = _get(objective_id)
    out: dict[str, dict] = {}
    names: dict[str, Optional[str]] = {}
    for c in rec["candidates"]:
        size = None
        try:
            import model_assets

            m = model_assets._get(c["model_id"])[0]
            v = next((x for x in m.get("versions") or [] if x["id"] == c.get("model_version_id")), None)
            size = v and v.get("size_bytes")
        except Exception:  # noqa: BLE001 - an older record, or a model that is gone or hidden
            pass
        uid = c.get("submitted_by")
        if uid not in names:
            try:
                import auth

                u = auth.user_label(uid) if uid not in (None, "system") else None
                names[uid] = u and (u.get("display_name") or u.get("username"))
            except Exception:  # noqa: BLE001
                names[uid] = None
        out[c["id"]] = {"size_bytes": size, "owner": names[uid],
                        "reviews": len(c.get("reviews") or []) + sum(len(s.get("events") or []) for s in (c.get("checks") or {}).values() if isinstance(s, dict)),
                        "review_status": _review_status(c)}
    return out


def _review_status(c: dict) -> Optional[str]:
    """"rejected" when any reviewer's latest decision rejects the model, "accepted" when at least one accepts and none
    rejects, None while there are only comments."""
    latest: dict[str, str] = {}
    for r in c.get("reviews") or []:
        if r["action"] in ("accept", "reject"):
            latest[r["by"]] = r["action"]
    if "reject" in latest.values():
        return "rejected"
    return "accepted" if latest else None


def _review_gate(rec: dict, c: dict) -> dict:
    """The objective's review requirement for one submission: `required` approving reviewers (each reviewer's latest
    decision counts once) and no reviewer whose latest decision rejects the model (changes requested). With no
    requirement (0) every submission meets it."""
    required = int(rec.get("required_reviews") or 0)
    latest: dict[str, str] = {}
    for r in c.get("reviews") or []:
        if r.get("action") in ("accept", "reject"):
            latest[r["by"]] = r["action"]
    approvals = sum(1 for a in latest.values() if a == "accept")
    rejections = sum(1 for a in latest.values() if a == "reject")
    met = required == 0 or (approvals >= required and rejections == 0)
    message = None
    if not met:
        parts = []
        if approvals < required:
            parts.append(f"{approvals} of {required} approving review{'s' if required != 1 else ''}")
        if rejections:
            parts.append(f"{rejections} reviewer{'s' if rejections != 1 else ''} requested changes")
        message = (f"{c.get('name') or 'This model'} cannot be released: this objective requires {required} approving "
                   f"review{'s' if required != 1 else ''} and no outstanding requested changes ({'; '.join(parts)})")
    return {"required": required, "approvals": approvals, "rejections": rejections, "met": met, "message": message}


def _require_reviews(rec: dict, c: dict) -> None:
    gate = _review_gate(rec, c)
    if not gate["met"]:
        raise HTTPException(409, gate["message"])


class ReviewIn(BaseModel):
    # Leave comment (feedback without a decision), Accept (approve the model to be tagged as a release) or Reject
    action: Literal["comment", "accept", "reject"] = "comment"
    # Markdown (bold, italic, lists, links, code): stored as written, shown by an HTML-escaping renderer
    text: str = Field(default="", max_length=5000)
    # attachments uploaded by the reviewer (POST /{objective_id}/attachments) and not used by another review yet
    attachments: list[str] = Field(default_factory=list, max_length=5)


# -- tagging users and groups in reviews: "@[Name](user:<id>)" / "@[Name](group:<id>)" in the Markdown -----------------
# Only users and groups that can read the objective may be tagged (GET /mentionable lists them); the names in the text
# are replaced by the directory's on save, and the tagged users and the members of tagged groups who can read the
# objective are notified (notify.deliver: the in-app inbox, email by their notification settings).

MENTION_RE = re.compile(r"@\[([^\]\n]{1,100})\]\(((?:user|group):[\w.@-]{1,80})\)")
MENTION_SOURCE = "modeling-objectives"


def _group_reader(gid: str, groups: list[dict]) -> dict:
    """A principal standing for "a member of this group and nothing else": the group and the groups it is nested in."""
    out = {gid}
    changed = True
    while changed:
        changed = False
        for g in groups:
            if g["id"] not in out and set(g.get("member_groups") or []) & out:
                out.add(g["id"])
                changed = True
    return {"id": None, "username": None, "role": "user", "groups": sorted(out), "markings": set(), "service": False}


def _mentionable(rec: dict) -> dict:
    """{users, groups} that can read the objective (active users with a role on it, groups whose members get one
    through the group alone), names only."""
    import auth

    try:
        users, groups = auth._users(), auth._groups()
    except Exception:  # noqa: BLE001 - no user directory
        return {"users": [], "groups": []}
    out_users = []
    for u in users:
        if u.get("disabled") or u.get("invited"):
            continue
        p = auth.principal_of(u["id"])
        if p is not None and _role(rec, p) is not None:
            out_users.append({"id": u["id"], "label": u.get("display_name") or u["username"], "username": u["username"]})
    out_groups = [{"id": g["id"], "label": g["name"]} for g in groups if _role(rec, _group_reader(g["id"], groups)) is not None]
    key = lambda x: x["label"].lower()  # noqa: E731
    return {"users": sorted(out_users, key=key), "groups": sorted(out_groups, key=key)}


@router.get("/{objective_id}/mentionable")
def mentionable(objective_id: str) -> dict:
    """Whom a review can tag: users and groups that can read the objective (readers of the objective only)."""
    with _lock:
        rec = _get(objective_id)
    return _mentionable(rec)


def _resolve_mentions(rec: dict, text: str) -> tuple[str, list[dict]]:
    """The review text with each tag's name replaced by the directory's, and the tags; 400 for a user or group that
    cannot read the objective (or does not exist)."""
    if not MENTION_RE.search(text):
        return text, []
    who = _mentionable(rec)
    names = {f"user:{u['id']}": u["label"] for u in who["users"]} | {f"group:{g['id']}": g["label"] for g in who["groups"]}
    tags: dict[str, dict] = {}

    def swap(m: re.Match) -> str:
        principal = m.group(2)
        if principal not in names:
            raise HTTPException(400, f"@{m.group(1)} cannot open this objective: share it with them first, or remove the tag")
        name = re.sub(r"[\]\n]", " ", names[principal])[:100]
        tags.setdefault(principal, {"principal": principal, "kind": principal.split(":")[0], "name": name})
        return f"@[{name}]({principal})"

    return MENTION_RE.sub(swap, text), list(tags.values())


def _mention_recipients(rec: dict, review: dict) -> dict[str, str]:
    """{user id: "you" | "your group <name>"}: the tagged users and the members of tagged groups who can read the
    objective, not the author."""
    import auth

    try:
        groups = auth._groups()
    except Exception:  # noqa: BLE001
        groups = []
    by_id = {g["id"]: g for g in groups}
    why: dict[str, str] = {}
    for t in review["mentions"]:
        kind, _, pid = t["principal"].partition(":")
        if kind == "user":
            why[pid] = "you"
        elif pid in by_id:
            for uid in auth.group_members(by_id[pid], groups):
                why.setdefault(uid, f"your group {t['name']}")
    why.pop(review["by"], None)
    out = {}
    for uid, whom in why.items():
        p = auth.principal_of(uid)
        if p is not None and _role(rec, p) is not None:  # not deactivated users, nor group members who cannot open it
            out[uid] = whom
    return out


def _notify_mentions(rec: dict, c: dict, review: dict, recipients: dict[str, str]) -> None:
    """Through the platform's notifications (notify.deliver): the inbox, email when the user's settings say so."""
    if not recipients:
        return
    import notify

    link = f"/modeling-objectives?id={rec['id']}&view=models&model={c['id']}&review={review['id']}"
    excerpt = MENTION_RE.sub(lambda m: "@" + m.group(1), review.get("text") or "")
    excerpt = excerpt if len(excerpt) <= 300 else excerpt[:300].rstrip() + "…"
    model = c.get("name") or "a model"
    for uid, whom in recipients.items():
        try:
            notify.deliver(uid, f"{review['by_name']} mentioned {whom} in a review of {model}",
                           f"{review['by_name']} mentioned {whom} in a review of {model} in the modeling objective {rec['name']}:\n\n{excerpt}",
                           link=link, link_label="Open the review", source=MENTION_SOURCE)
        except Exception:  # noqa: BLE001 - a notification never fails the review
            pass


@router.post("/{objective_id}/candidates/{candidate_id}/reviews")
def add_review(objective_id: str, candidate_id: str, req: ReviewIn) -> dict:
    """A review of a submission. A comment needs text (or an attachment); a rejection needs a reason. Users and groups
    tagged in the text are notified."""
    text = req.text.strip().replace("\x00", "").replace("\x01", "")
    if (req.action == "reject" or (req.action == "comment" and not req.attachments)) and not text:
        raise HTTPException(400, "write the comment" if req.action == "comment" else "say why the model is rejected")
    me = _me()
    name = None
    try:
        import auth

        u = auth.user_label(me) if me != "system" else None
        name = u and (u.get("display_name") or u.get("username"))
    except Exception:  # noqa: BLE001
        pass
    with _lock:
        rec = _get(objective_id)
        c = _candidate(rec, candidate_id)
        if c.get("archived"):
            raise HTTPException(409, "an archived model cannot be reviewed")
        text, mentions = _resolve_mentions(rec, text)
        review_id = f"review-{uuid.uuid4().hex[:10]}"
        files = []
        for aid in dict.fromkeys(req.attachments):
            a = (rec.get("attachments") or {}).get(aid)
            if not a or a.get("by") != me:
                raise HTTPException(400, "attach files you uploaded to this objective")
            if a.get("review_id"):
                raise HTTPException(409, f"{a['name']} is already attached to another review")
            a.update(review_id=review_id, candidate_id=c["id"])
            files.append(_attachment_public(a))
        review = {"id": review_id, "at": _now(), "by": me, "by_name": name or me, "action": req.action, "text": text, "attachments": files}
        recipients: dict[str, str] = {}
        if mentions:
            review["mentions"] = mentions
            recipients = _mention_recipients(rec, review)
            review["notified"] = len(recipients)
        c.setdefault("reviews", []).append(review)
        out = _view(_write(rec))
    _notify_mentions(rec, c, review, recipients)
    return out


@router.get("/{objective_id}/overview")
def get_overview(objective_id: str) -> dict:
    """The Objective page: overview text, the Modeling objective API with its Ontology mapping, the latest release
    and the linked files, modules, graphs and chained models."""
    with _lock:
        rec = _get(objective_id)
    return _overview(rec)


@router.put("/{objective_id}/overview")
def put_overview(objective_id: str, req: OverviewIn) -> dict:
    with _lock:
        rec = _get(objective_id, "editor")
        if req.overview is not None:
            rec["overview"] = req.overview
        if req.relevant is not None:
            seen: set[tuple[str, str]] = set()
            links = []
            for link in req.relevant:
                if (link.kind, link.id) in seen:
                    continue
                seen.add((link.kind, link.id))
                if link.kind == "file":
                    import drive

                    drive._item(link.id)  # 404 / 403 for a file that does not exist or the user cannot see
                elif link.kind == "model":
                    import model_assets

                    model_assets._get(link.id)
                links.append(link.model_dump())
            rec["relevant"] = links
        if req.api_mapping is not None:
            fields = _api_fields(_released_candidate(rec)[0])
            saved: dict[str, dict] = {"inputs": {}, "outputs": {}}
            for side, entries in req.api_mapping.items():
                known = {f["name"] for f in fields[side]}
                for name, target in entries.items():
                    if known and name not in known:
                        raise HTTPException(400, f"{name} is not one of the model's {side}")
                    t = ontology._object_type(target.object_type_id)
                    if not any(p["api_name"] == target.property for p in t["properties"]):
                        raise HTTPException(400, f"{t['display_name']} has no property {target.property}")
                    saved[side][name] = target.model_dump()
            rec["api_mapping"] = saved
        _write(rec)
    return _overview(rec)


@router.post("")
def create_objective(req: ObjectiveIn) -> dict:
    if req.ontology_object_type_id:
        try:
            ontology._object_type(req.ontology_object_type_id)
        except HTTPException:
            raise HTTPException(400, "The selected Ontology object type was not found") from None
    project_id = _check_project(req.project_id) if req.project_id else None
    record = {
        "id": f"objective-{uuid.uuid4().hex[:12]}",
        "project_id": project_id,
        "roles": _initial_roles(),
        "name": req.name.strip(),
        "description": req.description.strip(),
        "success_metric": req.success_metric.strip(),
        "metric_direction": req.metric_direction,
        "threshold": req.threshold,
        "ontology_object_type_id": req.ontology_object_type_id,
        "status": "active",
        "candidates": [],
        "created_at": _now(),
    }
    with _lock:
        return _write(record)


@router.delete("/{objective_id}")
def delete_objective(objective_id: str) -> dict:
    with _lock:
        _get(objective_id, "owner")
        _path(objective_id).unlink(missing_ok=True)
    return {"deleted": objective_id}


@router.post("/{objective_id}/candidates")
def add_candidate(objective_id: str, req: CandidateIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = {
            "id": f"candidate-{uuid.uuid4().hex[:12]}",
            "name": req.name.strip(),
            "version": req.version.strip(),
            "source": req.source,
            "source_uri": req.source_uri.strip(),
            "description": req.description.strip(),
            "status": "candidate",
            "evaluations": [],
            "experiments": [],
            "deployments": [],
            "functions": [],
            "model_artifact": req.model_artifact,
            "adapter": req.adapter,
            "metadata": req.metadata,
            "submission_id": f"submission-{uuid.uuid4().hex[:12]}",
            "submitted_at": _now(),
            "created_at": _now(),
            "deployed_at": None,
        }
        record["candidates"].append(candidate)
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/evaluate")
def evaluate_candidate(objective_id: str, candidate_id: str, req: EvaluationIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if candidate["status"] not in ("candidate", "evaluating", "rejected", "review"):
            raise HTTPException(409, "Only an unevaluated or rejected candidate can be evaluated")
        if record["threshold"] is None:
            raise HTTPException(400, "Set a success threshold on the objective before evaluating candidates")
        passed = req.value >= record["threshold"] if record["metric_direction"] == "maximize" else req.value <= record["threshold"]
        evaluation = {
            "id": f"evaluation-{uuid.uuid4().hex[:12]}",
            "metric": record["success_metric"],
            "value": req.value,
            "threshold": record["threshold"],
            "direction": record["metric_direction"],
            "passed": passed,
            "notes": req.notes.strip(),
            "dataset_id": req.dataset_id,
            "metrics": req.metrics,
            "evaluated_at": _now(),
        }
        candidate["evaluations"].append(evaluation)
        candidate["status"] = "review" if passed else "rejected"
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/experiments")
def log_experiment(objective_id: str, candidate_id: str, req: ExperimentIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        candidate.setdefault("experiments", []).append({
            "id": f"experiment-{uuid.uuid4().hex[:12]}",
            "name": req.name.strip(),
            "dataset_id": req.dataset_id,
            "dataset_name": req.dataset_name,
            "parameters": req.parameters,
            "metrics": req.metrics,
            "created_at": _now(),
        })
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/approve")
def approve_candidate(objective_id: str, candidate_id: str) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if candidate["status"] != "review" or not candidate["evaluations"][-1]["passed"]:
            raise HTTPException(409, "A passing evaluation is required before approval")
        candidate["status"] = "approved"
        candidate["approved_at"] = _now()
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/deploy")
def deploy_candidate(objective_id: str, candidate_id: str, req: DeploymentIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if candidate["status"] != "approved":
            raise HTTPException(409, "Approve the candidate before recording a release")
        _require_reviews(record, candidate)
        if req.deployment_type == "batch" and (not req.input_dataset_id or not req.output_dataset_id):
            raise HTTPException(400, "Batch deployments need input and output dataset references")
        if req.deployment_type == "live" and not req.endpoint_name:
            raise HTTPException(400, "Live deployments need an endpoint name")
        for other in record["candidates"]:
            if other["status"] == "deployed":
                other["status"] = "superseded"
        candidate["status"] = "deployed"
        candidate["deployed_at"] = _now()
        candidate["release"] = {
            "id": f"release-{uuid.uuid4().hex[:12]}",
            "submission_id": candidate["submission_id"],
            "version": req.version.strip(),
            "environment_tag": req.environment_tag.strip(),
            "release_note": req.release_note.strip(),
            "created_at": candidate["deployed_at"],
        }
        deployment = {
            "id": f"deployment-{uuid.uuid4().hex[:12]}",
            "type": req.deployment_type,
            "status": "configured",
            "release_id": candidate["release"]["id"],
            "input_dataset_id": req.input_dataset_id,
            "output_dataset_id": req.output_dataset_id,
            "endpoint_name": req.endpoint_name.strip() if req.endpoint_name else None,
            "recorded_at": candidate["deployed_at"],
            "note": "Deployment configuration recorded; no compute job or live serving runtime was provisioned.",
        }
        candidate.setdefault("deployments", []).append(deployment)
        candidate["deployment"] = deployment
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/functions")
def publish_model_function(objective_id: str, candidate_id: str, req: ModelFunctionIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if not any(item.get("type") == "live" for item in candidate.get("deployments", [])):
            raise HTTPException(409, "Configure a live deployment before registering a model function")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", req.api_name):
            raise HTTPException(400, "Function API name must start with a letter and contain only letters, digits, or underscores")
        try:
            ontology._object_type(req.ontology_object_type_id)
        except HTTPException:
            raise HTTPException(400, "The selected Ontology object type was not found") from None
        fn = {
            "id": f"model-function-{uuid.uuid4().hex[:12]}",
            "name": req.name.strip(),
            "api_name": req.api_name,
            "ontology_object_type_id": req.ontology_object_type_id,
            "inputs": req.inputs,
            "outputs": req.outputs,
            "release_id": candidate["release"]["id"],
            "status": "registered",
            "created_at": _now(),
            "note": "Function metadata is registered; inference is not invoked by this application.",
        }
        candidate.setdefault("functions", []).append(fn)
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/retire")
def retire_candidate(objective_id: str, candidate_id: str) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if candidate["status"] not in ("deployed", "approved", "superseded"):
            raise HTTPException(409, "Only an approved or released candidate can be retired")
        candidate["status"] = "retired"
        candidate["retired_at"] = _now()
        return _write(record)


@router.post("/{objective_id}/candidates/{candidate_id}/feedback")
def record_feedback(objective_id: str, candidate_id: str, req: FeedbackIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if candidate["status"] != "deployed":
            raise HTTPException(409, "Production feedback can only be added to the current released candidate")
        observations = candidate.setdefault("feedback", [])
        observations.append({
            "id": f"feedback-{uuid.uuid4().hex[:12]}",
            "metric": record["success_metric"],
            "value": req.value,
            "notes": req.notes.strip(),
            "recorded_at": _now(),
        })
        candidate["feedback"] = observations[-200:]
        return _write(record)


# ------------------------------------------------------------------------------------------------
# submissions of model resource versions, custom metadata, checks, releases, deployments that run
# ------------------------------------------------------------------------------------------------

ENVIRONMENTS = ("staging", "production")


class MetadataField(BaseModel):
    id: str = Field(min_length=1, max_length=60, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    name: str = Field(min_length=1, max_length=120)
    type: Literal["string", "number", "boolean", "date", "select"] = "string"
    required: bool = False
    options: list[str] = Field(default_factory=list)


class SettingsIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=2000)
    threshold: Optional[float] = None
    # custom model metadata asked for on every submission
    metadata_fields: Optional[list[MetadataField]] = None
    # approving reviews a submission needs (and no requested changes) before it is released or deployed; 0 = none
    required_reviews: Optional[int] = Field(default=None, ge=0, le=20)


@router.get("/{objective_id}")
def get_objective(objective_id: str) -> dict:
    with _lock:
        return _view(_get(objective_id))


def _view(rec: dict) -> dict:
    """The objective with each submission's current release environments."""
    current = {env: r["submission_id"] for env in ENVIRONMENTS if (r := _current_release(rec, env))}
    out = {**rec, "required_reviews": int(rec.get("required_reviews") or 0),
           "candidates": [{**c, "released_in": [env for env, sid in current.items() if sid == c.get("submission_id")], "review_gate": _review_gate(rec, c)}
                          for c in rec["candidates"]]}
    out["current_releases"] = {env: _current_release(rec, env) for env in ENVIRONMENTS}
    out.pop("attachments", None)  # the uploads' Files items: reached through the reviews (GET .../attachments/{id})
    out.pop("access_requests", None)  # owners see the pending ones in the sharing (GET .../sharing)
    out["my_role"] = _role(rec)
    out["project"] = _project_info(rec)
    return out


@router.put("/{objective_id}")
def update_objective(objective_id: str, req: SettingsIn) -> dict:
    with _lock:
        rec = _get(objective_id, "editor")
        if req.name is not None:
            rec["name"] = req.name.strip()
        if req.description is not None:
            rec["description"] = req.description.strip()
        if "threshold" in req.model_fields_set:
            rec["threshold"] = req.threshold
        if req.metadata_fields is not None:
            ids = [f.id for f in req.metadata_fields]
            if len(set(ids)) != len(ids):
                raise HTTPException(400, "metadata field ids must be unique")
            rec["metadata_fields"] = [f.model_dump() for f in req.metadata_fields]
        if req.required_reviews is not None:
            rec["required_reviews"] = req.required_reviews
        return _view(_write(rec))


class SubmissionIn(BaseModel):
    model_id: str
    # a version id, rid or number; default the model's latest version
    version: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=200)
    description: str = Field(default="", max_length=2000)
    metadata: dict = Field(default_factory=dict)


def _check_metadata(rec: dict, values: dict) -> dict:
    out = {}
    for f in rec.get("metadata_fields") or []:
        v = values.get(f["id"])
        if v in (None, ""):
            if f.get("required"):
                raise HTTPException(400, f"the metadata field {f['name']} is required")
            continue
        if f["type"] == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
            raise HTTPException(400, f"{f['name']} is a number")
        if f["type"] == "boolean" and not isinstance(v, bool):
            raise HTTPException(400, f"{f['name']} is true or false")
        if f["type"] == "select" and f.get("options") and v not in f["options"]:
            raise HTTPException(400, f"{f['name']} is one of {', '.join(f['options'])}")
        out[f["id"]] = v
    return {**{k: v for k, v in values.items() if k not in {f["id"] for f in rec.get("metadata_fields") or []}}, **out}


@router.post("/{objective_id}/submissions")
def submit_model(objective_id: str, req: SubmissionIn) -> dict:
    """Submit a version of a model resource (trained in a transform, container-backed or externally hosted)."""
    import model_assets

    m, _ = model_assets._get(req.model_id)
    v = model_assets._version(m, req.version)
    with _lock:
        record = _get(objective_id, "editor")
        if any(c.get("model_version_rid") == v["rid"] and not c.get("archived") for c in record["candidates"]):
            raise HTTPException(409, f"{m['name']} {v['version']} is already submitted to this objective")
        kind = m.get("kind", "container")
        candidate = {
            "id": f"candidate-{uuid.uuid4().hex[:12]}", "name": (req.name or m["name"]).strip(), "version": v["version"],
            "source": "container" if kind == "container" else "external_api" if m.get("external") else "in_platform",
            "source_uri": v["rid"], "description": req.description.strip(), "status": "candidate", "evaluations": [], "experiments": [],
            "deployments": [], "functions": [], "model_artifact": None, "adapter": {k: (v.get("adapter") or {}).get(k) for k in ("module", "class")},
            "metadata": _check_metadata(record, req.metadata), "model_id": m["id"], "model_rid": m["rid"], "model_version_id": v["id"],
            "model_version_rid": v["rid"], "api": v.get("api") or {}, "checks": {},
            "submission_id": f"submission-{uuid.uuid4().hex[:12]}", "submitted_at": _now(), "submitted_by": _me(), "created_at": _now(), "deployed_at": None,
        }
        record["candidates"].append(candidate)
        out = _view(_write(record))
    try:
        import model_evaluation

        model_evaluation.on_submission(objective_id, candidate["id"])
    except ImportError:
        pass
    return out


def _me() -> str:
    import auth

    return (auth.current() or {}).get("id") or "system"


@router.post("/{objective_id}/candidates/{candidate_id}/archive")
def archive_candidate(objective_id: str, candidate_id: str, undo: bool = False) -> dict:
    """Archived submissions leave the Models view and cannot be released; released submissions cannot be archived."""
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, candidate_id)
        if not undo and any(r["submission_id"] == candidate.get("submission_id") for r in record.get("releases") or []):
            raise HTTPException(409, "a model that has been released cannot be archived")
        candidate["archived"] = not undo
        candidate["archived_at"] = None if undo else _now()
        return _view(_write(record))


# -- checks -----------------------------------------------------------------------------------------


class CheckIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    # user or group ids that may approve; empty: anyone who can open the objective
    approvers: list[str] = Field(default_factory=list)
    # an evaluation-based check: its status follows a metric of the evaluation dashboard
    evaluation: Optional[dict] = None


def _check_evaluation(e: Optional[dict]) -> Optional[dict]:
    if not e:
        return None
    for k in ("dataset_id", "library_id", "metric", "op", "value"):
        if e.get(k) in (None, ""):
            raise HTTPException(400, f"an evaluation-based check needs {k}")
    if e["op"] not in (">", ">=", "<", "<=", "=="):
        raise HTTPException(400, "the metric requirement compares with >, >=, <, <= or ==")
    return {"dataset_id": str(e["dataset_id"]), "library_id": str(e["library_id"]), "metric": str(e["metric"]), "op": e["op"],
            "value": float(e["value"]), "subset": str(e.get("subset") or "Overall")}


@router.post("/{objective_id}/checks")
def add_check(objective_id: str, req: CheckIn) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        record.setdefault("checks", []).append({"id": f"check-{uuid.uuid4().hex[:10]}", "name": req.name.strip(), "description": req.description.strip(),
                                                "approvers": req.approvers, "evaluation": _check_evaluation(req.evaluation), "archived": False,
                                                "created_at": _now()})
        return _view(_write(record))


@router.put("/{objective_id}/checks/{check_id}")
def update_check(objective_id: str, check_id: str, req: CheckIn, archived: Optional[bool] = None) -> dict:
    with _lock:
        record = _get(objective_id, "editor")
        chk = next((x for x in record.get("checks") or [] if x["id"] == check_id), None)
        if not chk:
            raise HTTPException(404, "check not found")
        chk.update(name=req.name.strip(), description=req.description.strip(), approvers=req.approvers, evaluation=_check_evaluation(req.evaluation))
        if archived is not None:
            chk["archived"] = archived
        return _view(_write(record))


class CheckAction(BaseModel):
    action: Literal["approve", "reject", "comment"]
    text: str = Field(default="", max_length=4000)


def _may_approve(chk: dict) -> bool:
    import auth

    if not chk.get("approvers") or not auth.enabled():
        return True
    me = auth.current() or {}
    mine = {me.get("id"), me.get("username"), *(me.get("groups") or [])}
    return bool(mine & set(chk["approvers"])) or me.get("role") == "admin"


@router.post("/{objective_id}/candidates/{candidate_id}/checks/{check_id}")
def act_on_check(objective_id: str, candidate_id: str, check_id: str, req: CheckAction) -> dict:
    """Approve, reject or comment on a check of a submission (its discussion thread)."""
    with _lock:
        record = _get(objective_id)
        candidate = _candidate(record, candidate_id)
        chk = next((x for x in record.get("checks") or [] if x["id"] == check_id), None)
        if not chk:
            raise HTTPException(404, "check not found")
        if req.action != "comment":
            if chk.get("evaluation"):
                raise HTTPException(400, "this check follows an evaluation metric: its status is not set by hand")
            if not _may_approve(chk):
                raise HTTPException(403, "you are not among this check's approvers")
        elif not req.text.strip():
            raise HTTPException(400, "write a comment")
        state = candidate.setdefault("checks", {}).setdefault(check_id, {"status": "pending", "events": []})
        state["events"].append({"at": _now(), "by": _me(), "action": req.action, "text": req.text.strip()})
        if req.action != "comment":
            state["status"] = "approved" if req.action == "approve" else "rejected"
        return _view(_write(record))


# -- releases ---------------------------------------------------------------------------------------


def _current_release(rec: dict, environment: str) -> Optional[dict]:
    return next((r for r in reversed(rec.get("releases") or []) if r["environment"] == environment), None)


def release_target(objective_id: str, environment: str) -> tuple[str, str]:
    """(model id, version id) of the objective's current release in an environment (model_deployments). Running
    deployments resolve their release whoever calls them: no role on the objective is needed here."""
    with _lock:
        rec = _get(objective_id, None)
    rel = _current_release(rec, environment)
    if not rel:
        raise HTTPException(409, f"{rec['name']} has no {environment} release")
    c = next((x for x in rec["candidates"] if x.get("submission_id") == rel["submission_id"]), None)
    if not c or not c.get("model_id"):
        raise HTTPException(409, f"the {environment} release of {rec['name']} is not a model resource version, so it cannot be deployed")
    return c["model_id"], c["model_version_id"]


class ReleaseIn(BaseModel):
    candidate_id: str
    version: str = Field(min_length=1, max_length=100)
    release_note: str = Field(default="", max_length=2000)


def _release(record: dict, candidate: dict, environment: str, version: str, note: str, promoted_from: Optional[str] = None) -> dict:
    prev = _current_release(record, environment)
    rel = {"id": f"release-{uuid.uuid4().hex[:12]}", "submission_id": candidate["submission_id"], "candidate_id": candidate["id"],
           "model": candidate["name"], "model_version": candidate.get("version"), "version": version.strip(), "environment": environment,
           "environment_tag": environment, "release_note": note.strip(), "created_at": _now(), "created_by": _me(),
           "replaces": prev and prev["id"], "promoted_from": promoted_from,
           # the model API changed from the release this one replaces: functions on its deployments need a new version
           "api_changed": bool(prev and (pc := next((x for x in record["candidates"] if x.get("submission_id") == prev["submission_id"]), None))
                               and pc.get("api") and candidate.get("api") and pc["api"] != candidate["api"])}
    record.setdefault("releases", []).append(rel)
    candidate["status"] = "deployed"
    candidate["deployed_at"] = rel["created_at"]
    candidate["release"] = rel
    live = {r["submission_id"] for env in ENVIRONMENTS if (r := _current_release(record, env))}
    for other in record["candidates"]:
        if other["status"] == "deployed" and other.get("submission_id") not in live:
            other["status"] = "superseded"
    return rel


@router.post("/{objective_id}/releases")
def create_release(objective_id: str, req: ReleaseIn) -> dict:
    """Release a submission to staging (it replaces the staging release; staging deployments upgrade)."""
    with _lock:
        record = _get(objective_id, "editor")
        candidate = _candidate(record, req.candidate_id)
        if candidate.get("archived"):
            raise HTTPException(409, "an archived model cannot be released")
        _require_reviews(record, candidate)
        _release(record, candidate, "staging", req.version, req.release_note)
        out = _view(_write(record))
    _notify_release(objective_id, "staging")
    return out


@router.post("/{objective_id}/releases/{release_id}/promote")
def promote_release(objective_id: str, release_id: str) -> dict:
    """Mark a staging release as production (production deployments upgrade)."""
    with _lock:
        record = _get(objective_id, "editor")
        rel = next((r for r in record.get("releases") or [] if r["id"] == release_id), None)
        if not rel:
            raise HTTPException(404, "release not found")
        if rel["environment"] != "staging" or (_current_release(record, "staging") or {}).get("id") != release_id:
            raise HTTPException(409, "only the current staging release can be marked as production")
        candidate = next((x for x in record["candidates"] if x.get("submission_id") == rel["submission_id"]), None)
        if not candidate:
            raise HTTPException(404, "the released submission no longer exists")
        _require_reviews(record, candidate)
        _release(record, candidate, "production", rel["version"], rel["release_note"], promoted_from=rel["id"])
        out = _view(_write(record))
    _notify_release(objective_id, "production")
    return out


def _notify_release(objective_id: str, environment: str) -> None:
    try:
        import model_deployments

        model_deployments.on_release(objective_id, environment)
    except ImportError:
        pass


# -- deployments ------------------------------------------------------------------------------------


class ObjectiveDeploymentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    type: Literal["live", "batch"] = "live"
    environment: Literal["staging", "production"] = "staging"
    # batch: the dataset to run through the model, and where the output dataset goes
    input_dataset_id: Optional[str] = None
    output_folder_id: Optional[str] = None
    output_name: Optional[str] = Field(default=None, max_length=120)
    min_replicas: int = Field(1, ge=0, le=32)
    max_replicas: int = Field(1, ge=1, le=32)
    cpu: float = Field(1, gt=0, le=64)
    memory_gb: float = Field(2, gt=0, le=512)
    profiles: list[str] = Field(default_factory=list)
    # batch: rebuild the output when the input dataset updates (always on a new release)
    rebuild_on_input: bool = True


@router.post("/{objective_id}/deployments")
def create_deployment(objective_id: str, req: ObjectiveDeploymentIn) -> dict:
    """A live or batch deployment of the objective's staging or production release. It runs: a live deployment serves
    the release over its endpoint, a batch deployment writes its output dataset."""
    import drive
    import model_deployments

    with _lock:
        _get(objective_id, "editor")
    release_target(objective_id, req.environment)  # 409 without a deployable release in that environment
    with _lock:
        rec = _get(objective_id, "editor")
        rel = _current_release(rec, req.environment)
        released = next((x for x in rec["candidates"] if x.get("submission_id") == rel["submission_id"]), None) if rel else None
        if released:
            _require_reviews(rec, released)  # the requirement may have been raised, or a reviewer rejected, after the release
    cfg = model_deployments.ConfigIn(min_replicas=req.min_replicas, max_replicas=req.max_replicas, cpu=req.cpu, memory_gb=req.memory_gb,
                                     profiles=req.profiles)
    if req.type == "batch":
        if not req.input_dataset_id or not req.output_folder_id or not (req.output_name or "").strip():
            raise HTTPException(400, "a batch deployment needs an input dataset, and a folder and name for the output dataset")
        item = drive._item(req.input_dataset_id)
        if item["kind"] != "file" or not item["name"].endswith(".parquet"):
            raise HTTPException(400, "the input of a batch deployment is a dataset")
        drive._item(req.output_folder_id, need="editor")
        return model_deployments.create_for_objective(objective_id, req.environment, req.name.strip(), req.description.strip(), "batch", cfg,
                                                      input_item_id=item["id"], input_name=item["name"], output_folder_id=req.output_folder_id,
                                                      output_name=req.output_name.strip(), rebuild_on_input=req.rebuild_on_input)
    return model_deployments.create_for_objective(objective_id, req.environment, req.name.strip(), req.description.strip(), "objective", cfg)


@router.get("/{objective_id}/deployments")
def list_deployments(objective_id: str) -> list[dict]:
    import model_deployments

    _get(objective_id)
    return model_deployments.list_deployments(objective_id=objective_id)


# -- the objective's Project, sharing ---------------------------------------------------------------------------------


def _project_info(rec: dict) -> Optional[dict]:
    """{id, name, missing} of the Files Project the objective is saved in; None when it is in none."""
    pid = rec.get("project_id")
    if not pid:
        return None
    try:
        import db

        it = db.drive_get(pid) if db.enabled() else None
    except Exception:  # noqa: BLE001 - no database
        it = None
    if not it or it.get("kind") != "project" or it.get("trashed_at"):
        return {"id": pid, "name": None, "missing": True}
    return {"id": pid, "name": it["name"], "missing": False}


def _check_project(project_id: str) -> str:
    """A Project the caller may save the objective in (the Editor role on it)."""
    import auth
    import db

    it = db.drive_get(project_id) if db.enabled() else None
    if not it or it.get("kind") != "project" or it.get("trashed_at"):
        raise HTTPException(400, "Choose a Project (a top-level Files project) to save the objective in")
    auth.check_project(project_id, "editor")
    return project_id


def _group_names() -> dict[str, str]:
    import auth

    try:
        return {g["id"]: g["name"] for g in auth.list_groups()}
    except Exception:  # noqa: BLE001 - no user directory
        return {}


def _grant_view(g: dict, groups: dict[str, str]) -> dict:
    import auth

    kind, _, pid = g["principal"].partition(":")
    if kind == "user":
        u = auth.user_label(pid) or {}
        name = u.get("display_name") or u.get("username") or pid
        if u.get("status") == "deleted":
            name = "(deleted user)"
    elif kind == "group":
        name = groups.get(pid, "(deleted group)")
    else:
        kind, name = "everyone", "Everyone"
    return {"principal": g["principal"], "role": g["role"], "kind": kind, "name": name}


def _sharing(rec: dict) -> dict:
    import auth

    role = _role(rec)
    groups = _group_names()
    project = _project_info(rec)
    project_role = None
    if project and not project["missing"]:
        try:
            project_role = auth.role_for(project["id"]) if _caller() else "owner"
        except Exception:  # noqa: BLE001
            project_role = None
    out = {"id": rec["id"], "name": rec["name"], "roles": [_grant_view(g, groups) for g in rec.get("roles") or []], "open": not rec.get("roles"),
           "my_role": role, "can_share": role == "owner", "project": project, "project_role": project_role, "directory": None}
    if role == "owner":
        # whom the owner can share with: active users (names only) and groups
        try:
            import recipes

            users = recipes.people()
        except Exception:  # noqa: BLE001
            users = []
        out["directory"] = {"users": users, "groups": sorted(({"id": k, "label": v} for k, v in groups.items()), key=lambda x: x["label"].lower())}
        out["requests"] = [{k: r.get(k) for k in ("id", "by", "by_name", "at", "reason", "role")} for r in rec.get("access_requests") or []
                           if r.get("status") == "pending"]
    return out


class Grant(BaseModel):
    # "user:<id>", "group:<id>" or "everyone"
    principal: str = Field(min_length=1, max_length=120)
    role: Literal["viewer", "editor", "owner"]


class SharingIn(BaseModel):
    roles: list[Grant] = Field(max_length=200)


@router.get("/{objective_id}/sharing")
def get_sharing(objective_id: str) -> dict:
    """Who has which role on the objective (viewer opens and reviews it, editor submits, releases and deploys, owner
    also shares and deletes it), the caller's own role and the Project's; for owners also whom they can share with."""
    with _lock:
        rec = _get(objective_id)
    return _sharing(rec)


@router.put("/{objective_id}/sharing")
def put_sharing(objective_id: str, req: SharingIn) -> dict:
    """Replace the objective's grants (owners only). An objective keeps at least one owner, and an owner cannot take
    their own owner role away (an administrator can)."""
    import auth

    roles: dict[str, str] = {}
    for g in req.roles:
        key = g.principal.strip()
        if key != "everyone":
            if not re.fullmatch(r"(user|group):[\w.@-]+", key):
                raise HTTPException(400, 'share with "everyone", "user:<id>" or "group:<id>"')
            key = auth._clean_principals([key])[0]  # 400 for a user or group that does not exist
        roles[key] = g.role
    grants = [{"principal": k, "role": v} for k, v in roles.items()]
    if not any(g["role"] == "owner" and g["principal"] != "everyone" for g in grants):
        raise HTTPException(400, "Keep at least one user or group as owner of the objective")
    with _lock:
        rec = _get(objective_id, "owner")
        before = rec.get("roles") or []
        rec["roles"] = grants
        p = _caller()
        if p is not None and p.get("role") != "admin" and _role(rec, p) != "owner":
            rec["roles"] = before
            raise HTTPException(400, "You would no longer be an owner of this objective: keep your own owner role (or a group's that you are in)")
        _write(rec)
    return _sharing(rec)


class ProjectIn(BaseModel):
    project_id: Optional[str] = Field(default=None, max_length=64)


@router.put("/{objective_id}/project")
def put_project(objective_id: str, req: ProjectIn) -> dict:
    """Save the objective in a Project (owners of the objective who are editors of the Project), or take it out of
    one (null). The Project's roles apply to the objective on top of its own grants."""
    project_id = _check_project(req.project_id) if req.project_id else None
    with _lock:
        rec = _get(objective_id, "owner")
        rec["project_id"] = project_id
        if not rec.get("roles"):
            rec["roles"] = _initial_roles()  # an open objective stays its mover's, not the Project's alone or everyone's
        return _view(_write(rec))


# -- link sharing: links to an objective, a submission or a review open for those with a role; everyone else gets the
# same "no access" answer whether or not the objective exists, and may request access (its owners are notified and
# grant or decline it in the Share dialog).

ACCESS_REQUEST_RENOTIFY_SECONDS = 3600


class AccessRequestIn(BaseModel):
    reason: str = Field(default="", max_length=1000)
    role: Literal["viewer", "editor"] = "viewer"


def _save_quiet(rec: dict) -> None:
    """Save without touching updated_at: an access request does not change the objective."""
    path = _path(rec["id"])
    tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, path)


def _owners(rec: dict) -> list[str]:
    """Active users who are owners of the objective: through its grants and its Project; administrators only when no
    one else is."""
    import auth

    try:
        users = [u for u in auth._users() if not u.get("disabled") and not u.get("invited")]
    except Exception:  # noqa: BLE001
        return []
    owners, admins = [], []
    for u in users:
        p = auth.principal_of(u["id"])
        if p is None:
            continue
        if p.get("role") == "admin":
            admins.append(u["id"])
        elif _role(rec, p) == "owner":
            owners.append(u["id"])
    return owners or admins


_REQUESTED = {"requested": True, "message": "If this modeling objective exists, its owners have been asked to give you access."}


@router.post("/{objective_id}/access-requests")
def request_access(objective_id: str, req: AccessRequestIn) -> dict:
    """Ask the owners of an objective for a role on it. The answer is the same whether or not the objective exists
    (someone without a role cannot tell); someone who already has a role is told so."""
    import auth

    p = _caller()
    if p is None or not p.get("id") or p.get("id") in ("local", "system"):
        raise HTTPException(400, "Sign in to request access")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", objective_id):
        return _REQUESTED
    notify_owners = False
    with _lock:
        rec = _read(_path(objective_id))
        if rec is None:
            return _REQUESTED
        if _role(rec) is not None:
            raise HTTPException(409, "You already have access to this objective")
        u = auth.user_label(p["id"]) or {}
        now = datetime.now(timezone.utc)
        reqs = rec.setdefault("access_requests", [])
        mine = next((r for r in reqs if r.get("by") == p["id"] and r.get("status") == "pending"), None)
        if mine is None:
            mine = {"id": f"access-{uuid.uuid4().hex[:10]}", "by": p["id"], "status": "pending"}
            reqs.append(mine)
            notify_owners = True
        else:
            last = mine.get("notified_at")
            notify_owners = not last or (now - datetime.fromisoformat(last)).total_seconds() >= ACCESS_REQUEST_RENOTIFY_SECONDS
        mine.update(by_name=u.get("display_name") or u.get("username") or p["id"], at=_now(), reason=req.reason.strip(), role=req.role)
        if notify_owners:
            mine["notified_at"] = _now()
        del reqs[:-200]
        _save_quiet(rec)
    if notify_owners:
        import notify

        for uid in _owners(rec):
            try:
                notify.deliver(uid, f"{mine['by_name']} requests access to {rec['name']}",
                               f"{mine['by_name']} asks for the {req.role} role on the modeling objective {rec['name']}."
                               + (f"\n\nReason: {mine['reason']}" if mine["reason"] else ""),
                               link=f"/modeling-objectives?id={rec['id']}&share=1", link_label="Review the request", source=MENTION_SOURCE)
            except Exception:  # noqa: BLE001
                pass
    return _REQUESTED


class AccessDecisionIn(BaseModel):
    grant: bool
    role: Optional[Literal["viewer", "editor", "owner"]] = None


@router.post("/{objective_id}/access-requests/{request_id}")
def decide_access(objective_id: str, request_id: str, req: AccessDecisionIn) -> dict:
    """Grant (the role asked for, or another) or decline an access request (owners). The requester is notified."""
    with _lock:
        rec = _get(objective_id, "owner")
        r = next((x for x in rec.get("access_requests") or [] if x["id"] == request_id and x.get("status") == "pending"), None)
        if r is None:
            raise HTTPException(404, "access request not found (it may have been decided already)")
        role = req.role or r.get("role") or "viewer"
        if req.grant:
            key = f"user:{r['by']}"
            grants = rec.get("roles") or _initial_roles()
            have = next((g for g in grants if g["principal"] == key), None)
            if have is None:
                grants.append({"principal": key, "role": role})
            elif SHARE_ROLES.index(role) > SHARE_ROLES.index(have["role"]):
                have["role"] = role
            rec["roles"] = grants
        r.update(status="granted" if req.grant else "declined", decided_at=_now(), decided_by=_me(), granted_role=role if req.grant else None)
        _write(rec)
    try:
        import notify

        notify.deliver(r["by"], f"Access to {rec['name']} {'granted' if req.grant else 'declined'}",
                       f"You were given the {role} role on the modeling objective {rec['name']}." if req.grant
                       else f"Your request for access to the modeling objective {rec['name']} was declined.",
                       link=f"/modeling-objectives?id={rec['id']}" if req.grant else None, link_label="Open the objective", source=MENTION_SOURCE)
    except Exception:  # noqa: BLE001
        pass
    return _sharing(rec)


# -- review attachments: Files items, read through the objective ------------------------------------------------------

ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
ATTACHMENT_FOLDER = "Modeling objective attachments"
# extension → content type; images and PDFs must also start with their format's signature, text must be UTF-8
ATTACHMENT_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
                    ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json",
                    ".md": "text/markdown"}
_SIGNATURES = {"image/png": (b"\x89PNG\r\n\x1a\n",), "image/jpeg": (b"\xff\xd8\xff",), "image/gif": (b"GIF87a", b"GIF89a"), "application/pdf": (b"%PDF-",)}
INLINE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")


def _attachment_type(name: str, data: bytes) -> str:
    ext = Path(name).suffix.lower()
    ctype = ATTACHMENT_TYPES.get(ext)
    if not ctype:
        raise HTTPException(415, f"{name}: attach an image (PNG, JPEG, GIF, WebP), a PDF or a text file (TXT, CSV, JSON, MD, LOG)")
    if ctype == "image/webp":
        ok = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    elif ctype in _SIGNATURES:
        ok = data.startswith(_SIGNATURES[ctype])
    else:
        try:
            data.decode("utf-8")
            ok = b"\x00" not in data
        except UnicodeDecodeError:
            ok = False
    if not ok:
        raise HTTPException(415, f"{name} is not a {ext[1:].upper()} file")
    return ctype


def _attachment_public(a: dict) -> dict:
    return {k: a.get(k) for k in ("id", "name", "size", "content_type", "by", "at")}


def _attachment_folder(rec: dict) -> str:
    """Where an upload goes: the objective's Project (folder "Modeling objective attachments/<objective>") when the
    uploader may write there, else the uploader's own top-level folder of that name (Files items outside Projects are
    their creator's). Either way, others read it through the objective."""
    import auth
    import db
    import drive

    project = _project_info(rec)
    if project and not project["missing"]:
        p = _caller()
        try:
            writable = p is None or auth.role_for(project["id"], p) in ("editor", "owner")
        except Exception:  # noqa: BLE001
            writable = False
        if writable:
            name = re.sub(r"[\\/\x00-\x1f]+", "_", rec["name"]).strip()[:200] or rec["id"]
            return drive._ensure_folders(project["id"], [ATTACHMENT_FOLDER, name])
    me = (auth.current() or {}).get("username")
    mine = next((i for i in db.drive_list(None) if i["kind"] == "folder" and i["name"] == ATTACHMENT_FOLDER and i.get("created_by") == me
                 and not i.get("trashed_at")), None)
    return mine["id"] if mine else drive._insert_container(None, "folder", drive._free_name(None, ATTACHMENT_FOLDER))


@router.post("/{objective_id}/attachments")
async def upload_attachment(objective_id: str, file: UploadFile = File(...)) -> dict:
    """Upload a file to attach to a review (anyone who can open the objective may review it): images, PDFs and text
    files up to 10 MB. It is stored as a Files item and readable by those who can read the objective."""
    import db
    import drive

    if not db.enabled():
        raise HTTPException(503, "Attachments are stored in Files, which needs the database")
    with _lock:
        rec = _get(objective_id)
    name = Path((file.filename or "").replace("\\", "/")).name.strip()
    if not name:
        raise HTTPException(400, "the file has no name")
    data = await file.read(ATTACHMENT_MAX_BYTES + 1)
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise HTTPException(413, f"{name} is larger than {ATTACHMENT_MAX_BYTES // (1024 * 1024)} MB")
    if not data:
        raise HTTPException(400, f"{name} is empty")
    ctype = _attachment_type(name, data)
    clean = re.sub(r"[\\/\x00-\x1f]+", "_", name)[:200]
    import io

    item = drive._store(_attachment_folder(rec), clean, io.BytesIO(data), len(data), ctype)
    a = {"id": f"att-{uuid.uuid4().hex[:12]}", "item_id": item["id"], "name": clean, "size": len(data), "content_type": ctype,
         "by": _me(), "at": _now(), "review_id": None}
    with _lock:
        rec = _get(objective_id)
        rec.setdefault("attachments", {})[a["id"]] = a
        path = _path(rec["id"])  # not _write: an upload alone does not change the objective
        tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, path)
    return _attachment_public(a)


@router.get("/{objective_id}/attachments/{attachment_id}", response_model=None)
def get_attachment(objective_id: str, attachment_id: str, download: bool = False) -> Response:
    """An attachment's contents, for those who can read the objective and hold the markings its Files item has.
    Images open inline (unless download=true); everything else downloads."""
    import auth
    import db
    import drive

    with _lock:
        rec = _get(objective_id)
    a = (rec.get("attachments") or {}).get(attachment_id)
    if not a or (not a.get("review_id") and a.get("by") != _me()):
        raise HTTPException(404, "attachment not found")
    item = db.drive_get(a["item_id"]) if db.enabled() else None
    if not item or item.get("trashed_at"):
        raise HTTPException(404, f"{a['name']} was deleted from Files")
    p = _caller()
    if p is not None:
        missing = auth.missing_markings(auth.effective_markings(item["id"]), p.get("markings"))
        if missing:
            raise HTTPException(403, f"You need the markings of {a['name']} to open it")
    if item["stored_in"] == "s3":
        import storage

        data = storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{item['id']}")["Body"].read()
    else:
        data = (drive.LOCAL_DIR / item["id"]).read_bytes()
    inline = a["content_type"] in INLINE_TYPES and not download
    from urllib.parse import quote

    return Response(data, media_type=a["content_type"], headers={
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(a['name'])}",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store"})
