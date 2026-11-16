"""Object and property security policies, modelled on Foundry's "Object and property security policies".

An object type's security (`object-types/<id>.security`) holds:
- an object security policy (row-level security): a granular policy — conditions comparing the current user (ID,
  groups, organization, markings, attributes) with the object's property values or constants, combined with all /
  any — and markings every viewer needs on top of the object type's own;
- property security policies (column-level security): named sets of properties with their own granular policy and
  markings. A viewer must pass the object policy to see the object at all, and a property policy too to see its
  properties (cell-level security); a property they cannot see reads as null and is listed in `hidden_properties`.

Rules from Foundry: a property policy needs an object policy; the primary key cannot be in a property policy; a
property is in at most one property policy; `not` conditions on groups, markings or organizations are refused
(scoped tokens may lack the attribute, which would grant access); only owners of the object type edit policies.
Policies are enforced when objects are read (listings, Object Explorer, Object Views, actions, exports); like
Foundry, they do not follow data downstream. With sign-in off (development) and for the platform's own background
work every object is visible. The test endpoint evaluates a saved or unsaved policy for any user on a stored or
hypothetical object.

Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth
import ontology
from ontology import _lock

router = APIRouter(prefix="/api/ontology")

USER_SIDES = ("user_id", "user_groups", "user_organization", "user_markings", "user_attribute")
SIDES = USER_SIDES + ("property", "static")
OPS = ("equals", "intersects", "contains_all", "is_empty", "is_not_empty")
# combined comparison weight of an object policy and one property policy (Foundry's granular policy limit)
MAX_WEIGHT = 10


def configure() -> None:
    ontology.MODEL_HOOKS.update({"object_policy": object_visible, "property_policy": hidden_properties, "security_schema": _schema_changed,
                                 "property_markings": property_markings})
    auth.RESOURCE_MARKING_HOOKS["object_type"] = inherited_markings
    auth.RESOURCE_SOURCE_HOOKS["object_type"] = lambda tid: ((ontology._read(ontology._path("object-types", tid)) or {}).get("backing_dataset") or {}).get("dataset_id")


def inherited_markings(type_id: str) -> set[str]:
    """The markings an object type inherits from its backing dataset (and additional datasources), minus the ones its
    security configuration stops inheriting."""
    t = ontology._read(ontology._path("object-types", type_id))
    if not t:
        return set()
    ids = [(t.get("backing_dataset") or {}).get("dataset_id")] + [d.get("dataset_id") for d in t.get("additional_datasources") or []]
    out: set[str] = set()
    for i in ids:
        if i:
            out |= set(auth.effective_markings(i))
    return out - set((t.get("datasource_markings") or {}).get("stop_inheriting") or [])


def _schema_changed(old: dict, new: dict) -> None:
    if {p["api_name"] for p in old["properties"]} != {p["api_name"] for p in new["properties"]}:
        _require_owner(new)
        check_security(new, new["security"])


# ------------------------------------------------------------------------------------------------
# validation
# ------------------------------------------------------------------------------------------------


def _weight(node: Optional[dict]) -> int:
    if not node:
        return 0
    if node.get("kind") in ("and", "or"):
        return sum(_weight(c) for c in node.get("children") or [])
    return 1


def _check_node(node: dict, names: set[str], where: str) -> None:
    kind = node.get("kind")
    if kind == "not":
        raise HTTPException(400, f"{where}: NOT conditions are a misconfiguration (scoped tokens may lack the attribute and pass); "
                                 "write the condition positively")
    if kind in ("and", "or"):
        if not node.get("children"):
            raise HTTPException(400, f"{where}: an all / any group needs conditions")
        for c in node["children"]:
            _check_node(c, names, where)
        return
    if kind != "condition":
        raise HTTPException(400, f"{where}: a granular policy is conditions in all / any groups")
    if node.get("op") not in OPS:
        raise HTTPException(400, f"{where}: unknown comparison {node.get('op')}")
    sides = [node.get("left") or {}] + ([node.get("right") or {}] if node["op"] not in ("is_empty", "is_not_empty") else [])
    for s in sides:
        if s.get("kind") not in SIDES:
            raise HTTPException(400, f"{where}: compare the user, a property or a value")
        if s["kind"] == "property" and s.get("property") not in names:
            raise HTTPException(400, f"{where}: unknown property {s.get('property')}")
        if s["kind"] == "user_attribute" and not s.get("attribute"):
            raise HTTPException(400, f"{where}: name the user attribute")
    if not any(s.get("kind") in USER_SIDES for s in sides) and node["op"] not in ("is_empty", "is_not_empty"):
        raise HTTPException(400, f"{where}: a condition compares something about the user")


def check_security(t: dict, sec: dict) -> dict:
    names = {p["api_name"] for p in t["properties"]}
    op = sec.get("object_policy")
    pps = sec.get("property_policies") or []
    if pps and not op:
        raise HTTPException(400, "create the object security policy before property security policies")
    if op and op.get("granular"):
        _check_node(op["granular"], names, "object security policy")
    seen: dict[str, str] = {}
    for i, pp in enumerate(pps):
        name = (pp.get("name") or "").strip() or f"Policy {i + 1}"
        pp["name"] = name
        pp.setdefault("id", f"psp-{i + 1}")
        if not pp.get("properties"):
            raise HTTPException(400, f"{name}: pick the properties it secures")
        for prop in pp["properties"]:
            if prop not in names:
                raise HTTPException(400, f"{name}: unknown property {prop}")
            if prop == t["primary_key"]:
                raise HTTPException(400, f"{name}: the primary key cannot be in a property security policy")
            if prop in seen:
                raise HTTPException(400, f"{prop} is already in {seen[prop]}: a property is in at most one property security policy")
            seen[prop] = name
        if pp.get("granular"):
            _check_node(pp["granular"], names, name)
        if _weight(op.get("granular")) + _weight(pp.get("granular")) > MAX_WEIGHT:
            raise HTTPException(400, f"{name}: the object and property policies together have more than {MAX_WEIGHT} comparisons")
    return {"object_policy": op or None, "property_policies": pps}


# ------------------------------------------------------------------------------------------------
# evaluation
# ------------------------------------------------------------------------------------------------


def _values(side: dict, user: dict, props: dict) -> list:
    k = side.get("kind")
    if k == "user_id":
        v: Any = user.get("id")
    elif k == "user_groups":
        v = list(user.get("groups") or [])
    elif k == "user_organization":
        v = user.get("organization_id")
    elif k == "user_markings":
        v = list(user.get("markings") or [])
    elif k == "user_attribute":
        v = (user.get("attributes") or {}).get(side.get("attribute"))
    elif k == "property":
        v = props.get(side.get("property"))
    else:
        v = side.get("value")
    if v is None or v == "":
        return []
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]


def evaluate(node: Optional[dict], user: dict, props: dict) -> bool:
    if not node:
        return True
    if node.get("kind") == "and":
        return all(evaluate(c, user, props) for c in node.get("children") or [])
    if node.get("kind") == "or":
        return any(evaluate(c, user, props) for c in node.get("children") or [])
    left = _values(node.get("left") or {}, user, props)
    op = node.get("op")
    if op == "is_empty":
        return not left
    if op == "is_not_empty":
        return bool(left)
    right = _values(node.get("right") or {}, user, props)
    if op == "equals":
        return bool(left) and sorted(left) == sorted(right)
    if op == "intersects":
        return bool(set(left) & set(right))
    if op == "contains_all":
        # every value on the right is held on the left (e.g. the user's markings contain the object's markings)
        return set(right) <= set(left)
    return False


def _passes(policy: Optional[dict], user: dict, props: dict) -> bool:
    if not policy:
        return True
    if auth.missing_markings(policy.get("markings") or [], user.get("markings") or []):
        return False
    return evaluate(policy.get("granular"), user, props)


def _viewer() -> Optional[dict]:
    """The user policies are evaluated for, or None when they do not apply (sign-in off, platform work)."""
    p = auth.current()
    if p is None or p.get("service") or not auth.enabled():
        return None
    return p


def object_visible(t: dict, obj: dict, user: Optional[dict] = None) -> bool:
    sec = t.get("security") or {}
    if not sec.get("object_policy"):
        return True
    user = user or _viewer()
    if user is None:
        return True
    return _passes(sec["object_policy"], user, obj.get("properties") or {})


def hidden_properties(t: dict, obj: dict, user: Optional[dict] = None) -> list[str]:
    sec = t.get("security") or {}
    pps = sec.get("property_policies") or []
    if not pps:
        return []
    user = user or _viewer()
    if user is None:
        return []
    props = obj.get("properties") or {}
    return [p for pp in pps if not _passes(pp, user, props) for p in pp["properties"]]


def _policy_markings(policy: Optional[dict], props: dict) -> set[str]:
    """The markings a policy requires: its own, and the values of the marking columns it compares the user's
    markings with (a marking-backed policy)."""
    if not policy:
        return set()
    out = set(policy.get("markings") or [])

    def walk(n: Any) -> None:
        if not isinstance(n, dict):
            return
        if n.get("kind") == "condition":
            sides = [n.get("left") or {}, n.get("right") or {}]
            if any(s.get("kind") == "user_markings" for s in sides):
                for s in sides:
                    if s.get("kind") == "property":
                        out.update(_values(s, {}, props))
            return
        for ch in n.get("children") or []:
            walk(ch)
        walk(n.get("child"))

    walk(policy.get("granular"))
    return out


def property_markings(t: dict, obj: dict) -> dict[str, list[dict]]:
    """Property security markings (Workshop's "Show security markings"): for each property, the markings its
    property security policy requires, or the object security policy's for properties outside one — informational
    only (what the viewer sees was already checked). Unsupported base types (geoshape, vectors, time series, media
    and attachment arrays) get none."""
    sec = t.get("security") or {}
    if not sec.get("object_policy") and not sec.get("property_policies"):
        return {}
    props = obj.get("properties") or {}
    labels = auth.marking_labels()
    known = set(labels)
    skip = {p["api_name"] for p in t["properties"] if p.get("type") in ("geoshape", "vector", "timeseries", "time_series", "geotemporal")
            or (p.get("array") and p.get("type") in ("cipher", "media", "attachment", "media_reference"))}

    def view(ids: set[str]) -> list[dict]:
        return [{"id": m, "name": labels.get(m, m)} for m in sorted(ids & known)]

    out: dict[str, list[dict]] = {}
    covered: set[str] = set()
    for pp in sec.get("property_policies") or []:
        marks = view(_policy_markings(pp, props))
        for p in pp.get("properties") or []:
            covered.add(p)
            if marks and p not in skip:
                out[p] = marks
    base = view(_policy_markings(sec.get("object_policy"), props))
    if base:
        for p in t["properties"]:
            if p["api_name"] not in covered and p["api_name"] not in skip:
                out[p["api_name"]] = base
    return out


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class SecurityIn(BaseModel):
    # {granular: condition tree, markings: [marking ids]}
    object_policy: Optional[dict] = None
    # [{id, name, properties: [...], granular, markings}]
    property_policies: list[dict] = []


def _require_owner(t: dict) -> None:
    import ontology_model as om

    om.require_role(t.get("ontology_id"), "owner", t, "edit security policies")


@router.get("/object-types/{type_id}/security")
def get_security(type_id: str) -> dict:
    t = ontology._object_type(type_id)
    sec = t.get("security") or {}
    return {"object_policy": sec.get("object_policy"), "property_policies": sec.get("property_policies") or []}


@router.put("/object-types/{type_id}/security")
def set_security(type_id: str, req: SecurityIn) -> dict:
    with _lock:
        t = ontology._object_type(type_id)
        _require_owner(t)
        sec = check_security(t, req.model_dump())
        t["security"] = sec if (sec["object_policy"] or sec["property_policies"]) else None
        if t["security"] is None:
            t.pop("security")
        ontology._put("object-types", t)
    return get_security(type_id)


class TestUser(BaseModel):
    id: str = "test-user"
    groups: list[str] = []
    organization_id: Optional[str] = None
    markings: list[str] = []
    attributes: dict[str, Any] = {}


class TestIn(BaseModel):
    # a real user (their groups and markings), or a hypothetical one
    user_id: Optional[str] = None
    user: Optional[TestUser] = None
    # a stored object, optionally with property values changed to test hypothetical objects
    primary_key: Optional[str] = None
    properties: dict[str, Any] = {}
    # an unsaved policy to test; the saved one when left out
    security: Optional[SecurityIn] = None
    mode: Literal["view"] = "view"


@router.post("/object-types/{type_id}/security/test")
def test_security(type_id: str, req: TestIn) -> dict:
    """Which properties of an object a user could view under the (saved or unsaved) policies."""
    with _lock:
        t = ontology._object_type(type_id)
        if req.security is not None:
            t = {**t, "security": check_security(t, req.security.model_dump())}
        if req.user_id:
            u = auth._user(req.user_id)
            user = {**auth._public_user(u), "markings": sorted(auth.user_markings(u))}
        elif req.user:
            user = req.user.model_dump()
        else:
            raise HTTPException(400, "pick a user to test")
        props: dict[str, Any] = {}
        if req.primary_key:
            stored = ontology.stored_objects(type_id).get(str(req.primary_key))
            if stored is None:
                raise HTTPException(404, f"{t['display_name']} {req.primary_key} not found")
            props = dict(stored.get("properties") or {})
        props.update(req.properties)
        obj = {"properties": props}
        visible = object_visible(t, obj, user)
        hidden = set(hidden_properties(t, obj, user)) if visible else {p["api_name"] for p in t["properties"]}
    return {"user": {k: user.get(k) for k in ("id", "username", "groups", "organization_id", "markings")}, "object_visible": visible,
            "properties": [{"api_name": p["api_name"], "display_name": p["display_name"], "visible": p["api_name"] not in hidden,
                            "policy": next((pp["name"] for pp in (t.get("security") or {}).get("property_policies") or [] if p["api_name"] in pp["properties"]), None)}
                           for p in t["properties"]]}


class InheritIn(BaseModel):
    # marking ids no longer inherited from the datasources (users without them can then see the objects)
    stop_inheriting: list[str] = []


def _marking_view(ids: set[str] | list[str]) -> list[dict]:
    names = {m["id"]: m for m in auth._marking_info().values()} if hasattr(auth, "_marking_info") else {}
    return [{"id": i, "name": (names.get(i) or {}).get("name", i)} for i in sorted(ids)]


@router.get("/object-types/{type_id}/datasource-markings")
def get_datasource_markings(type_id: str) -> dict:
    """What the object type inherits from its datasources, and what it stops inheriting."""
    t = ontology._object_type(type_id)
    ids = [(t.get("backing_dataset") or {}).get("dataset_id")] + [d.get("dataset_id") for d in t.get("additional_datasources") or []]
    from_sources: set[str] = set()
    for i in ids:
        if i:
            from_sources |= set(auth.effective_markings(i))
    stopped = set((t.get("datasource_markings") or {}).get("stop_inheriting") or [])
    return {"from_datasources": _marking_view(from_sources), "stop_inheriting": _marking_view(stopped),
            "inherited": _marking_view(from_sources - stopped)}


@router.put("/object-types/{type_id}/datasource-markings")
def set_datasource_markings(type_id: str, req: InheritIn) -> dict:
    """Start or stop inheriting datasource markings (owners of the object type, holding every marking they change)."""
    with _lock:
        t = ontology._object_type(type_id)
        _require_owner(t)
        before = set((t.get("datasource_markings") or {}).get("stop_inheriting") or [])
        after = set(req.stop_inheriting)
        # stopping inheritance removes the marking from the object type (Remove permission); restarting applies it
        auth.check_marking_change(f"object_type:{type_id}", before - after, after - before)
        if after:
            t["datasource_markings"] = {"stop_inheriting": sorted(after)}
        else:
            t.pop("datasource_markings", None)
        ontology._put("object-types", t)
    return get_datasource_markings(type_id)
