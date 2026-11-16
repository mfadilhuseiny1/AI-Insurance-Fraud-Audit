"""Calls the build runner makes for a build, outside the pipeline endpoints: checked as the build's identity.

The runner sends every call it makes for a build with the service token and `X-Bsai-Build: <build id>`
(pipeline_runtime "the identity a build runs as"). The pipeline endpoints check the build's identity from that
header; this module does the same for the other endpoints a build reads or writes through — data source tables,
Views, ingest streams, time series syncs and the Ontology (object types, objects, actions) — so a build whose user
lost a marking or a role is refused there too, with the same reason ("The build runs as …, who no longer holds the
marking …"). Calls without the header (users' own calls, checked as themselves; the platform's own jobs with the
service token) are unchanged.

Past those checks, the Ontology object and action calls (objects list / get / delete, Object Explorer search and
export, Object View, applying an action) run as the build's identity (`acting_for`): the objects and properties its
user's object / property security policies, restricted views and mandatory controls let them see, an action under
their permissions and submission criteria — exactly what the user's own request would see and do.

A check is (op, kind, id, label): op "read" / "write"; kind one of pipeline_runtime.ACCESS_KINDS ("item", "folder",
"pipeline", "datasource", "stream", "ingest", "connection"), "resource:<auth resource kind>" (markings and Project of
a resource outside Files, e.g. "resource:timeseries_sync"), "object_type" (its markings and the ontology role:
Viewer reads, Editor writes), "action_type" (applying an action: its object type's markings and Viewer, as for a
user) or "ontology" (creating in an ontology: Editor); label: a name the reason may show (never the name of
something the build may not see).
"""

from __future__ import annotations

import contextlib
from typing import Iterator, Optional

from fastapi import HTTPException, Request

import auth

Check = tuple[str, str, Optional[str], Optional[str]]

_KIND_NAMES = {"timeseries_sync": "time series sync"}


def build_of(request: Optional[Request]) -> Optional[dict]:
    """The build this call is made for (service token + X-Bsai-Build, sign-in on); None for any other call."""
    if request is None or not auth.enabled():
        return None
    import pipeline_runtime as rt

    build_id = request.headers.get(rt.BUILD_HEADER)
    p = auth.current()
    if not build_id or not (p and p.get("service")):
        return None
    try:
        return rt._build(build_id)
    except HTTPException:
        raise HTTPException(403, "The build this call is made for does not exist") from None


def enforce(request: Optional[Request], *checks: Check) -> None:
    """403 with the reason when the call is made for a build whose identity may not do one of the checks."""
    rec = build_of(request)
    if rec is None:
        return
    why = denies(rec, [c for c in checks if c])
    if why:
        raise HTTPException(403, why[:1].upper() + why[1:])


def allowed(request: Optional[Request], *checks: Check) -> bool:
    """Whether the call (made for a build or not) passes the checks: for filtering listings."""
    rec = build_of(request)
    return rec is None or denies(rec, list(checks)) is None


@contextlib.contextmanager
def acting_for(request: Optional[Request]) -> Iterator[Optional[dict]]:
    """Run the block as the build's identity when the call is made for a build (run_as.acting_as with its
    principal): everything the block checks against the current principal — object security policies (and the
    restricted views applied as them), property policies, mandatory controls, an action's permissions and submission
    criteria, ontology roles — then applies to the build's user exactly as to a request of their own. A 403 raised
    inside says whose limits refused it ("The build runs as …: <the reason>"). A system build, a call not made for a
    build, sign-in off: unchanged (yields None).

    Call `enforce` first: it words the markings / role reasons for the build and refuses an owner who is gone."""
    import pipeline_runtime as rt
    import run_as as acting

    rec = build_of(request)
    if rec is None:
        yield None
        return
    try:
        mode, p, who = rt._identity(rec)
    except acting.OwnerUnavailable as e:
        raise HTTPException(403, str(e)[:1].upper() + str(e)[1:]) from None
    if mode == "system":
        yield None
        return
    if p is None:
        # a Project-scoped schedule whose owner is gone: no principal to judge object-level security with
        raise HTTPException(403, f"The build runs with the markings of the schedule's owner {who or '(none)'}, who is no longer active: "
                                 "an Editor holding the markings must take it over (edit and save it)")
    runs = f"The build runs with the roles and markings of the schedule's owner {who}" if mode == "project" else f"The build runs as {who}"
    with acting.acting_as(p):
        try:
            yield p
        except HTTPException as e:
            if e.status_code == 403 and isinstance(e.detail, str) and not e.detail.startswith("The build "):
                # the reason verbatim (an action's failure message is its author's text)
                raise type(e)(*_exc_args(e, f"{runs}: {e.detail}")) from None
            raise


def _exc_args(e: HTTPException, detail: str) -> tuple:
    """Arguments to rebuild an HTTPException (or ontology_actions.ActionFailure, which adds a category) with a new detail."""
    if hasattr(e, "category"):
        return (e.status_code, detail, getattr(e, "category"))
    return (e.status_code, detail)


def denies(rec: dict, checks: list[Check]) -> Optional[str]:
    """Why the build may not do the first of `checks` it fails; None: it may do them all."""
    import pipeline_runtime as rt
    import run_as as acting

    if not checks or not auth.enabled():
        return None
    if rec.get("status") not in ("queued", "running"):
        return f"the build is {rec.get('status')}: it no longer reads or writes data"
    try:
        ident = rt._identity(rec)
    except acting.OwnerUnavailable as e:
        return str(e)
    for op, kind, rid, label in checks:
        if kind.startswith("resource:"):
            why = _resource_denies(rec, ident, op, kind[len("resource:"):], rid, label)
        elif kind in ("object_type", "action_type", "ontology"):
            why = _ontology_denies(rec, ident, op, kind, rid, label)
        else:
            why = rt.build_denies(rec, op, kind, rid, label, ident)
        if why:
            return why
    return None


def _kind_name(kind: str) -> str:
    return _KIND_NAMES.get(kind) or auth.RESOURCE_KINDS.get(kind, kind.replace("_", " "))


def _what(kind: str, label: Optional[str]) -> str:
    return f'the {_kind_name(kind)} "{label}"' if label else f"the {_kind_name(kind)}"


def _plural(names: list[str]) -> str:
    return f"marking{'s' if len(names) > 1 else ''} {', '.join(names)}"


def _markings_denied(rec: dict, ident: tuple, need: set, what: str) -> Optional[str]:
    """The markings part, worded as pipeline_runtime.build_denies words it."""
    mode, p, who = ident
    if not need:
        return None
    if mode == "project" and p is None:
        owner = rec.get("markings_of")
        if not owner:
            return f"{what} is marked and the schedule has no owner whose markings the build can run with: an Editor holding the markings must save it"
        status = (auth.user_label(owner) or {}).get("status", "deleted")
        return f"{what} is marked and the schedule's owner {who} is {status}: an Editor holding the markings must take it over (edit and save it)"
    missing = auth.missing_markings(need, (p or {}).get("markings"))
    if not missing:
        return None
    names = _plural(auth._marking_names(sorted(missing)))
    if mode == "project":
        return f"the build runs with the markings of the schedule's owner {who}, who no longer holds the {names} that {what} carries"
    return f"the build runs as {who}, who no longer holds the {names} that {what} carries"


def _resource_denies(rec: dict, ident: tuple, op: str, kind: str, rid: Optional[str], label: Optional[str]) -> Optional[str]:
    """A resource outside Files (a time series sync, …): its markings, and the role on its Project (Viewer reads,
    Editor writes; a Project-scoped schedule writes only inside its Projects)."""
    import pipeline_runtime as rt

    mode, p, who = ident
    if mode == "system" or not rid:
        return None
    what = _what(kind, label)
    why = _markings_denied(rec, ident, auth.resource_effective(kind, rid), what)
    if why:
        return why
    proj = auth.resource_project(kind, rid)
    if mode == "project":
        if op == "write" and proj is not None:
            import pipeline_schedules as ps

            scope = set(rec.get("scope_projects") or [])
            if proj not in scope:
                names = ", ".join(ps._project_name(x) for x in scope) or "the top level of Files"
                return f"{what} is written in {ps._project_name(proj)}, outside the schedule's Projects ({names})"
        return None
    if proj and auth._rank(auth.role_for(proj, p)) < auth._rank("viewer" if op == "read" else "editor"):
        if op == "read":
            return f"the build runs as {who}, who has no role that reads {what} (Viewer on {rt._project_label(proj)})"
        return f"the build runs as {who}, who is not an Editor of {rt._project_label(proj)}, where {what} is written"
    return None


def _ontology_role(oid: Optional[str], resource: Optional[dict], p: dict) -> Optional[str]:
    """ontology_model.role_of for the build's principal instead of the caller."""
    import ontology_model as om

    o = om.get_ontology(oid)
    if p.get("role") == "admin":
        return "owner"
    if not om._member(o, p):
        return None
    grants = list(o.get("roles") or []) + list((resource or {}).get("roles") or [])
    if not grants:
        return "editor"
    level = om._granted(grants, p)
    return om.ROLES[level] if level >= 0 else None


def _ontology_denies(rec: dict, ident: tuple, op: str, kind: str, rid: Optional[str], label: Optional[str]) -> Optional[str]:
    """An object type (its markings — its own and its backing dataset's — and the ontology role), an action type
    (its object type's markings and Viewer, as a user applying it) or an ontology (Editor, to create in it)."""
    import ontology

    mode, p, who = ident
    if mode == "system":
        return None
    resource, oid, need = None, rid, set()
    # applying an action needs what a user applying it needs: the markings and Viewer (its rules decide the rest)
    want = "editor" if op == "write" and kind != "action_type" else "viewer"
    if kind == "action_type":
        try:
            a = ontology._get("action-types", rid or "", "action type")
        except HTTPException:
            return None  # the call itself fails
        what = f'the action "{label}"' if label else "the action"
        if a.get("object_type_id"):
            rid, kind = a["object_type_id"], "object_type"
        else:
            resource, oid = a, a.get("ontology_id")
    else:
        what = _what("object_type", label) if kind == "object_type" else "the ontology"
    if kind == "object_type":
        try:
            resource = ontology._get("object-types", rid or "", "object type")
        except HTTPException:
            return None
        oid = resource.get("ontology_id")
        need = auth.resource_effective("object_type", rid or "")
    why = _markings_denied(rec, ident, need, what)
    if why:
        return why
    if "read" not in ontology.MODEL_HOOKS:
        return None  # no ontology roles (ontology_model not loaded)
    if p is None:
        owner = rec.get("markings_of")
        status = (auth.user_label(owner) or {}).get("status", "deleted") if owner else None
        return (f"{what} needs an ontology role and the schedule's owner {who} is {status}: an Editor must take it over (edit and save it)" if owner
                else f"{what} needs an ontology role and the schedule has no owner whose roles the build can run with: an Editor must save it")
    import ontology_model as om

    try:
        have = _ontology_role(oid, resource, p)
        name = om.get_ontology(oid)["name"]
    except HTTPException:
        return None
    if have is None or om.ROLES.index(have) < om.ROLES.index(want):
        runs = f"the build runs with the roles of the schedule's owner {who}" if mode == "project" else f"the build runs as {who}"
        # an ontology the identity is no member of is not named (it may not see it)
        return f"{runs}, who does not have the {want} role on {name if have is not None else 'the ontology'} that {what} needs"
    return None
