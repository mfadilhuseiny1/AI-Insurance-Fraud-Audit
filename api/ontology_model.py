"""The Ontology's model around object types, modelled on Foundry's Ontology Manager and Value Types apps.

Ontologies: every resource belongs to one ontology (`ontology_id`). The default ontology always exists; private
ontologies belong to one organization and shared ontologies to several, so only members (and guest members) of
those organizations reach their resources. Ontology roles (owner, editor, viewer, discoverer) are granted to users,
groups or everyone on an ontology or on one resource; an ontology without any role grants keeps the platform's
open model (everyone edits). Discoverers see the definitions, viewers the objects, editors change resources and
owners manage roles and apply the `promoted` status. Resource protection (a protected resource, or every resource of
an ontology that protects main) moves changes onto branches with proposals (ontology_branches.py).

Link types relate two object types: a foreign key (one-to-one or many-to-one: the source type holds the target's
primary key), a join table (many-to-many: the links are stored here; the table is generated) or a backing object
type (each link object points at a source and a target object). Each side has its own display and API name and
visibility; statuses cascade from the object types and foreign key properties. Shared properties are properties
reused across object types: attached properties inherit their base type and metadata (type classes are united) and
deleting one detaches it. Interfaces describe a shape (properties, optionally shared ones, and link constraints;
interfaces extend others) that object types implement by mapping properties. Value types wrap a base type with
constraints (enum, range, regex, RID, UUID, array uniqueness and nested element constraints, struct field value
types) and a failure message; constraint edits make new versions and are checked against the values already
stored. Object type groups label object types.

Usage metering follows Foundry's 2026 Ontology Query Compute model: a base query costs 2 compute-seconds, a Search
Around 5, an aggregation 5, an Ontology SQL query 5, an advanced query 10, a derived property query 10 and an
action 18 plus 1 per object edited beyond the first, attributed to the resource that ran it (Object Explorer, a
Workshop module, …) and to the object types queried. Ontology volume is sampled hourly per object type (objects
and join table links) and averaged into GB-months; indexing compute counts the work of writing edits and imports.

Records are JSON files under data/ontology/. Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import os
import re
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import ontology
from ontology import IDENT, _all, _get, _hook, _lock, _new_id, _now, _path, _put, _read, _write

router = APIRouter(prefix="/api/ontology")

ROLES = ("discoverer", "viewer", "editor", "owner")
RESOURCE_KINDS = ("object_type", "action_type", "link_type", "interface", "shared_property")
FOLDER = {"object_type": "object-types", "action_type": "action-types", "link_type": "link-types",
          "interface": "interfaces", "shared_property": "shared-properties"}
KIND_LABEL = {"object_type": "object type", "action_type": "action type", "link_type": "link type",
              "interface": "interface", "shared_property": "shared property"}
LINK_KINDS = ("foreign_key", "join_table", "object_backed")
CARDINALITIES = ("one_to_one", "many_to_one", "many_to_many")
# Ontology Query Compute (2026): minimum compute-seconds per query
QUERY_COST = {"base": 2, "search_around": 5, "aggregation": 5, "sql": 5, "advanced": 10, "derived": 10, "action": 18}
DEFAULT_ONTOLOGY = {"id": "default", "name": "Default ontology", "description": "The ontology every resource belongs to unless moved.",
                    "kind": "default", "organization_ids": [], "roles": [], "protect_main": False}

# set while a proposal merges: protected resources accept the change
MERGING: contextvars.ContextVar[bool] = contextvars.ContextVar("ontology_merging", default=False)
# the resource a query runs for (Object Explorer, a Workshop module, …) for usage attribution
RESOURCE: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("ontology_resource", default=None)
_usage_lock = threading.Lock()


def configure() -> None:
    for name in ("link-types", "links", "interfaces", "shared-properties", "value-types", "branches", "explorations", "edit-log"):
        (ontology.DIR / name).mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS.update({
        "guard": _guard, "check_type": _check_type, "derive": _derive, "edits": _on_edits, "query": record_query,
        "value_type": _validate_value_type_hook, "status_changed": _on_status_changed, "deleted": _on_deleted,
        "read": _check_read, "indexed": record_indexing, "discoverable": discoverable,
    })
    import ontology_edits

    if _note_changes not in ontology_edits.LISTENERS:
        ontology_edits.LISTENERS.append(_note_changes)


def startup() -> None:
    threading.Thread(target=_volume_loop, daemon=True, name="ontology-volume").start()


# ------------------------------------------------------------------------------------------------
# ontologies and roles
# ------------------------------------------------------------------------------------------------


def _ontologies_raw() -> list[dict]:
    rows = _read(ontology.DIR / "ontologies.json", None)
    if not rows:
        rows = [{**DEFAULT_ONTOLOGY, "created_at": _now()}]
        _write(ontology.DIR / "ontologies.json", rows)
    return rows


def get_ontology(ontology_id: Optional[str]) -> dict:
    for o in _ontologies_raw():
        if o["id"] == (ontology_id or "default"):
            return o
    raise HTTPException(404, "ontology not found")


def _principal() -> Optional[dict]:
    p = auth.current()
    if p is None or p.get("service") or not auth.enabled():
        return None
    return p


def _is_admin(p: Optional[dict]) -> bool:
    return p is None or p.get("role") == "admin"


def _member(o: dict, p: Optional[dict]) -> bool:
    """Private and shared ontologies: only members of their organizations."""
    if _is_admin(p) or o["kind"] == "default" or not o.get("organization_ids"):
        return True
    return p.get("organization_id") in o["organization_ids"]


def _granted(grants: list[dict], p: Optional[dict]) -> int:
    best = -1
    who = {"everyone"}
    if p:
        who |= {f"user:{p['id']}"} | {f"group:{g}" for g in p.get("groups") or []}
    for g in grants or []:
        if g.get("principal") in who and g.get("role") in ROLES:
            best = max(best, ROLES.index(g["role"]))
    return best


def role_of(ontology_id: Optional[str], resource: Optional[dict] = None) -> Optional[str]:
    """The caller's ontology role on an ontology (and a resource in it): None when they have none."""
    o = get_ontology(ontology_id)
    p = _principal()
    if _is_admin(p):
        return "owner"
    if not _member(o, p):
        return None
    grants = list(o.get("roles") or []) + list((resource or {}).get("roles") or [])
    if not grants:
        return "editor"
    level = _granted(grants, p)
    return ROLES[level] if level >= 0 else None


def require_role(ontology_id: Optional[str], need: str, resource: Optional[dict] = None, what: str = "this") -> None:
    have = role_of(ontology_id, resource)
    if have is None or ROLES.index(have) < ROLES.index(need):
        o = get_ontology(ontology_id)
        raise HTTPException(403, f"You need the {need} role on {o['name']} to {what}")


def _check_read(t: dict) -> None:
    require_role(t.get("ontology_id"), "viewer", t, "view these objects")


def discoverable(rec: dict) -> bool:
    try:
        return role_of(rec.get("ontology_id"), rec) is not None
    except HTTPException:
        return False


class OntologyIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    kind: Optional[Literal["private", "shared"]] = None
    organization_ids: Optional[list[str]] = None
    # [{principal: "user:<id>" | "group:<id>" | "everyone", role}]
    roles: Optional[list[dict]] = None
    protect_main: Optional[bool] = None


def _ontology_summary(o: dict) -> dict:
    counts = defaultdict(int)
    for kind in RESOURCE_KINDS:
        for r in _all(FOLDER[kind]):
            if (r.get("ontology_id") or "default") == o["id"]:
                counts[kind] += 1
    return {**o, "counts": dict(counts), "your_role": role_of(o["id"])}


@router.get("/ontologies")
def list_ontologies() -> list[dict]:
    with _lock:
        p = _principal()
        return [_ontology_summary(o) for o in _ontologies_raw() if _member(o, p)]


def _check_grants(grants: list[dict]) -> None:
    for g in grants:
        if g.get("role") not in ROLES:
            raise HTTPException(400, f"a role is one of {', '.join(ROLES)}")
        if not re.fullmatch(r"everyone|user:[\w.-]+|group:[\w.-]+", str(g.get("principal", ""))):
            raise HTTPException(400, 'grant roles to "everyone", "user:<id>" or "group:<id>"')


@router.post("/ontologies")
def create_ontology(req: OntologyIn) -> dict:
    auth.require_admin()
    if not req.name:
        raise HTTPException(400, "name the ontology")
    orgs = req.organization_ids or []
    kind = req.kind or ("shared" if len(orgs) > 1 else "private")
    if kind == "private" and len(orgs) > 1:
        raise HTTPException(400, "a private ontology belongs to one organization: make it shared for more")
    if kind == "shared" and len(orgs) < 2:
        raise HTTPException(400, "a shared ontology has two or more organizations")
    _check_grants(req.roles or [])
    with _lock:
        rows = _ontologies_raw()
        if any(o["name"].lower() == req.name.strip().lower() for o in rows):
            raise HTTPException(409, "an ontology with that name exists")
        p = auth.current() or {}
        roles = req.roles if req.roles is not None else ([{"principal": f"user:{p['id']}", "role": "owner"}] if p.get("id") not in (None, "local", "system") else [])
        o = {"id": _new_id("ont"), "name": req.name.strip(), "description": (req.description or "").strip(), "kind": kind,
             "organization_ids": orgs, "roles": roles, "protect_main": bool(req.protect_main), "created_at": _now()}
        rows.append(o)
        _write(ontology.DIR / "ontologies.json", rows)
        return _ontology_summary(o)


@router.patch("/ontologies/{ontology_id}")
def update_ontology(ontology_id: str, req: OntologyIn) -> dict:
    with _lock:
        rows = _ontologies_raw()
        o = get_ontology(ontology_id)
        require_role(ontology_id, "owner", what="manage this ontology")
        changes = req.model_dump(exclude_unset=True)
        if "roles" in changes:
            _check_grants(changes["roles"] or [])
        if o["kind"] == "default":
            changes.pop("kind", None)
            changes.pop("organization_ids", None)
        for k, v in changes.items():
            if v is not None:
                o[k] = v.strip() if isinstance(v, str) else v
        if o["kind"] == "private" and len(o.get("organization_ids") or []) > 1:
            raise HTTPException(400, "a private ontology belongs to one organization")
        _write(ontology.DIR / "ontologies.json", [o if x["id"] == o["id"] else x for x in rows])
        return _ontology_summary(o)


@router.delete("/ontologies/{ontology_id}")
def delete_ontology(ontology_id: str) -> dict:
    auth.require_admin()
    with _lock:
        o = get_ontology(ontology_id)
        if o["kind"] == "default":
            raise HTTPException(400, "the default ontology cannot be deleted")
        if any(_ontology_summary(o)["counts"].values()):
            raise HTTPException(400, "migrate or delete the ontology's resources first")
        _write(ontology.DIR / "ontologies.json", [x for x in _ontologies_raw() if x["id"] != ontology_id])
        return {"deleted": ontology_id}


class RolesIn(BaseModel):
    roles: list[dict]


@router.put("/resources/{kind}/{rid}/roles")
def set_resource_roles(kind: str, rid: str, req: RolesIn) -> dict:
    """Ontology roles granted on one resource (on top of the ontology's)."""
    if kind not in RESOURCE_KINDS:
        raise HTTPException(404, "unknown resource kind")
    _check_grants(req.roles)
    with _lock:
        rec = _get(FOLDER[kind], rid, KIND_LABEL[kind])
        require_role(rec.get("ontology_id"), "owner", rec, f"manage roles on this {KIND_LABEL[kind]}")
        rec["roles"] = req.roles
        return _put(FOLDER[kind], rec)


def _protected(rec: Optional[dict]) -> bool:
    if not rec:
        return False
    if rec.get("protected"):
        return True
    try:
        return bool(get_ontology(rec.get("ontology_id")).get("protect_main"))
    except HTTPException:
        return False


def _guard(kind: str, rid: str, op: str, old: Optional[dict], new: Optional[dict]) -> None:
    """Every change to main: the editor role, resource protection (changes go through a branch) and the owner-only
    promoted status."""
    rec = new or old or {}
    if kind == "action_type" and "ontology_id" not in rec:
        if rec.get("object_type_id"):
            t = _read(_path("object-types", rec["object_type_id"]), {}) or {}
        else:
            t = _read(_path("interfaces", rec.get("interface_id") or "x"), {}) or {}
        rec = {**rec, "ontology_id": t.get("ontology_id"), "protected": rec.get("protected") or t.get("protected")}
    oid = rec.get("ontology_id")
    if new and new.get("ontology_id") and old and old.get("ontology_id") != new.get("ontology_id") and not MERGING.get():
        raise HTTPException(400, "move resources between ontologies with Migrate resources")
    if new and new.get("ontology_id"):
        get_ontology(new["ontology_id"])
    if MERGING.get():
        return
    require_role(oid, "editor", old or rec, f"edit this {KIND_LABEL.get(kind, kind)}")
    if _protected(old) or (op == "create" and _protected(rec)):
        raise HTTPException(409, f"This {KIND_LABEL.get(kind, kind)} is protected: save the change to a branch and merge it with a proposal")
    if new and new.get("status") == "promoted" and (old or {}).get("status") != "promoted":
        if role_of(oid, old or rec) != "owner":
            raise HTTPException(403, "Only ontology owners can promote an object type: propose it on a branch for an owner to approve")


# ------------------------------------------------------------------------------------------------
# object type groups
# ------------------------------------------------------------------------------------------------


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field("", max_length=1000)
    ontology_id: Optional[str] = None


def _groups() -> list[dict]:
    return _read(ontology.DIR / "groups.json", []) or []


@router.get("/groups")
def list_groups() -> list[dict]:
    with _lock:
        types = _all("object-types")
        return [{**g, "object_type_ids": [t["id"] for t in types if g["id"] in (t.get("groups") or [])]} for g in _groups()]


@router.post("/groups")
def create_group(req: GroupIn) -> dict:
    with _lock:
        require_role(req.ontology_id, "editor", what="create groups")
        rows = _groups()
        if any(g["name"].lower() == req.name.strip().lower() for g in rows):
            raise HTTPException(409, "a group with that name exists")
        g = {"id": _new_id("grp"), "name": req.name.strip(), "description": req.description.strip(), "ontology_id": req.ontology_id or "default", "created_at": _now()}
        _write(ontology.DIR / "groups.json", rows + [g])
        return g


@router.delete("/groups/{group_id}")
def delete_group(group_id: str) -> dict:
    with _lock:
        rows = _groups()
        g = next((x for x in rows if x["id"] == group_id), None)
        if not g:
            raise HTTPException(404, "group not found")
        require_role(g.get("ontology_id"), "editor", what="delete groups")
        _write(ontology.DIR / "groups.json", [x for x in rows if x["id"] != group_id])
        for t in _all("object-types"):
            if group_id in (t.get("groups") or []):
                t["groups"] = [x for x in t["groups"] if x != group_id]
                _put("object-types", t)
        return {"deleted": group_id}


# ------------------------------------------------------------------------------------------------
# value types
# ------------------------------------------------------------------------------------------------

VALUE_BASE_TYPES = ("string", "integer", "long", "short", "double", "float", "decimal", "boolean", "date", "timestamp", "array", "struct")
RID = re.compile(r"^ri\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9-]+\.[A-Za-z0-9._-]+$")
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class ValueTypeIn(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    api_name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    base_type: Optional[str] = None
    # for array value types: the element base type
    element_type: Optional[str] = None
    # {enum: {values, case_sensitive}, range: {min, max}, regex: {pattern, partial}, rid: true, uuid: true,
    #  unique: true, element: {...constraints}, fields: {field: value type id}}
    constraints: Optional[dict] = None
    failure_message: Optional[str] = Field(None, max_length=500)
    example: Optional[str] = Field(None, max_length=500)
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    ontology_id: Optional[str] = None
    # apply a constraint change that stored values fail
    force: bool = False


def _check_constraints(base: str, c: dict, element: Optional[str] = None) -> None:
    allowed = {"enum", "range", "regex", "rid", "uuid", "unique", "element", "fields"}
    unknown = set(c) - allowed
    if unknown:
        raise HTTPException(400, f"unknown constraint {sorted(unknown)[0]}")
    if "enum" in c:
        if base not in ("string", "boolean", "decimal", "double", "float", "integer", "short"):
            raise HTTPException(400, f"enum constraints do not apply to {base}")
        if not (c["enum"] or {}).get("values"):
            raise HTTPException(400, "list the allowed values")
    if "range" in c:
        if base not in ("decimal", "double", "float", "integer", "short", "long", "date", "timestamp", "string", "array"):
            raise HTTPException(400, f"range constraints do not apply to {base}")
        r = c["range"] or {}
        if r.get("min") is None and r.get("max") is None:
            raise HTTPException(400, "a range needs a minimum, a maximum or both")
    if any(k in c for k in ("regex", "rid", "uuid")) and base != "string":
        raise HTTPException(400, "regex, RID and UUID constraints apply to strings")
    if "regex" in c:
        try:
            re.compile((c["regex"] or {}).get("pattern") or "")
        except re.error as e:
            raise HTTPException(400, f"the regex does not compile: {e}") from None
    if any(k in c for k in ("unique", "element")) and base != "array":
        raise HTTPException(400, "uniqueness and element constraints apply to arrays")
    if "element" in c:
        _check_constraints(element or "string", c["element"] or {})
    if "fields" in c:
        if base != "struct":
            raise HTTPException(400, "field constraints apply to structs")
        for vt_id in (c["fields"] or {}).values():
            _get("value-types", vt_id, "value type")


def _num(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _violations(base: str, c: dict, value: Any, element: Optional[str] = None) -> Optional[str]:
    """Why a value fails the constraints (None when it passes)."""
    if value is None:
        return None
    if "enum" in c:
        e = c["enum"] or {}
        vals = e.get("values") or []
        if base == "string" and not e.get("case_sensitive", True):
            ok = str(value).lower() in {str(v).lower() for v in vals}
        elif base in ("string", "boolean"):
            ok = str(value).lower() in {str(v).lower() for v in vals} if base == "boolean" else str(value) in {str(v) for v in vals}
        else:
            ok = _num(value) in {_num(v) for v in vals}
        if not ok:
            return f"must be one of {', '.join(map(str, vals))}"
    if "range" in c:
        r = c["range"] or {}
        if base == "string":
            n: Any = len(str(value))
        elif base == "array":
            n = len(value) if isinstance(value, list) else 0
        elif base in ("date", "timestamp"):
            n = str(value)
        else:
            n = _num(value)
        lo, hi = r.get("min"), r.get("max")
        if base in ("date", "timestamp"):
            lo, hi = (str(lo) if lo is not None else None), (str(hi) if hi is not None else None)
        elif lo is not None or hi is not None:
            lo, hi = (_num(lo) if lo is not None else None), (_num(hi) if hi is not None else None)
        if n is None or (lo is not None and n < lo) or (hi is not None and n > hi):
            what = "length" if base == "string" else "size" if base == "array" else "value"
            return f"{what} must be within [{'' if lo is None else lo}, {'' if hi is None else hi}]"
    if "regex" in c:
        rx = c["regex"] or {}
        pat = re.compile(rx.get("pattern") or "")
        if not (pat.search(str(value)) if rx.get("partial") else pat.fullmatch(str(value))):
            return f"must match {rx.get('pattern')}"
    if c.get("rid") and not RID.match(str(value)):
        return "must be a valid RID"
    if c.get("uuid") and not UUID.match(str(value)):
        return "must be a valid UUID"
    if base == "array" and isinstance(value, list):
        if c.get("unique") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            return "elements must be unique"
        if c.get("element"):
            for v in value:
                why = _violations(element or "string", c["element"], v)
                if why:
                    return f"element {v!r}: {why}"
    if base == "struct" and isinstance(value, dict):
        for f, vt_id in (c.get("fields") or {}).items():
            vt = _read(_path("value-types", vt_id))
            if vt and value.get(f) is not None:
                why = value_type_error(vt, value.get(f))
                if why:
                    return f"{f}: {why}"
    return None


def value_type_error(vt: dict, value: Any) -> Optional[str]:
    cur = vt["versions"][-1]
    why = _violations(vt["base_type"], cur.get("constraints") or {}, value, vt.get("element_type"))
    return (cur.get("failure_message") or why) if why else None


def _compatible(vt: dict, prop_type: str, array: bool) -> bool:
    base = vt["base_type"]
    if base == "array":
        return array and (vt.get("element_type") in (None, prop_type) or prop_type == "string_array")
    if array:
        # an element value type applies to each item of the array
        pass
    if base in ("integer", "short", "long"):
        return prop_type in ("integer", "short", "long", "byte")
    if base in ("double", "float", "decimal"):
        return prop_type in ("double", "float", "decimal")
    return base == prop_type


def _validate_value_type_hook(vt_id: str, value: Any, label: str) -> None:
    vt = _read(_path("value-types", vt_id))
    if not vt:
        raise HTTPException(400, f"{label}: value type {vt_id} not found")
    if value is None:
        return
    items = value if isinstance(value, list) and vt["base_type"] != "array" else [value]
    for v in items:
        why = value_type_error(vt, v)
        if why:
            raise HTTPException(400, f"{label}: {why}")


def _value_type_consumers(vt_id: str) -> list[dict]:
    out = []
    for t in _all("object-types"):
        for p in t["properties"]:
            if p.get("value_type_id") == vt_id:
                out.append({"kind": "property", "object_type_id": t["id"], "object_type": t["display_name"], "property": p["api_name"]})
    for sp in _all("shared-properties"):
        if sp.get("value_type_id") == vt_id:
            out.append({"kind": "shared_property", "shared_property_id": sp["id"], "property": sp["api_name"]})
    for a in _all("action-types"):
        for p in a["parameters"]:
            if p.get("value_type_id") == vt_id:
                out.append({"kind": "parameter", "action_type_id": a["id"], "action_type": a["display_name"], "parameter": p["id"]})
    return out


def _stored_failures(vt: dict, consumers: list[dict], limit: int = 5) -> tuple[int, list[str]]:
    count, samples = 0, []
    for c in consumers:
        if c["kind"] != "property":
            continue
        for pk, o in ontology.load_objects(c["object_type_id"]).items():
            v = o.get("properties", {}).get(c["property"])
            items = v if isinstance(v, list) and vt["base_type"] != "array" else [v]
            for x in items:
                why = value_type_error(vt, x)
                if why:
                    count += 1
                    if len(samples) < limit:
                        samples.append(f"{c['object_type']} {pk}.{c['property']} = {x!r}: {why}")
    return count, samples


def _vt_summary(vt: dict) -> dict:
    return {**vt, "version": vt["versions"][-1]["version"], "constraints": vt["versions"][-1].get("constraints") or {},
            "failure_message": vt["versions"][-1].get("failure_message") or "", "consumers": _value_type_consumers(vt["id"])}


@router.get("/value-types")
def list_value_types(ontology_id: Optional[str] = None) -> list[dict]:
    with _lock:
        return [_vt_summary(v) for v in _all("value-types") if (not ontology_id or v.get("ontology_id", "default") == ontology_id) and discoverable(v)]


@router.get("/value-types/{vt_id}")
def get_value_type(vt_id: str) -> dict:
    with _lock:
        return _vt_summary(_get("value-types", vt_id, "value type"))


@router.post("/value-types")
def create_value_type(req: ValueTypeIn) -> dict:
    if not req.display_name or not req.base_type:
        raise HTTPException(400, "a value type needs a name and a base type")
    if req.base_type not in VALUE_BASE_TYPES:
        raise HTTPException(400, f"the base type is one of {', '.join(VALUE_BASE_TYPES)}")
    with _lock:
        require_role(req.ontology_id, "editor", what="create value types")
        api = req.api_name or ontology._api_name(req.display_name, False)
        if not IDENT.match(api):
            raise HTTPException(400, "the API name may hold letters, digits and _ and must start with a letter")
        if any(v["api_name"].lower() == api.lower() for v in _all("value-types")):
            raise HTTPException(409, f'a value type with the API name "{api}" exists')
        _check_constraints(req.base_type, req.constraints or {}, req.element_type)
        rec = {"id": _new_id("vt"), "api_name": api, "display_name": req.display_name.strip(), "description": (req.description or "").strip(),
               "base_type": req.base_type, "element_type": req.element_type if req.base_type == "array" else None, "example": req.example or "",
               "status": req.status or "experimental", "ontology_id": req.ontology_id or "default",
               "versions": [{"version": 1, "constraints": req.constraints or {}, "failure_message": (req.failure_message or "").strip(), "created_at": _now()}],
               "created_at": _now()}
        if req.example:
            why = value_type_error(rec, req.example)
            if why:
                raise HTTPException(400, f"the example value fails the constraints: {why}")
        return _vt_summary(_put("value-types", rec))


@router.patch("/value-types/{vt_id}")
def update_value_type(vt_id: str, req: ValueTypeIn) -> dict:
    """Name, description and API name change freely; the base type is immutable; new constraints or a new failure
    message make a new version that every consumer uses (rejected when stored values fail it, unless forced)."""
    with _lock:
        vt = _get("value-types", vt_id, "value type")
        require_role(vt.get("ontology_id"), "editor", vt, "edit value types")
        if req.base_type and req.base_type != vt["base_type"]:
            raise HTTPException(400, "the base type of a value type cannot change: create a new value type")
        for k in ("display_name", "description", "example", "status"):
            v = getattr(req, k)
            if v is not None:
                vt[k] = v.strip() if isinstance(v, str) else v
        if req.api_name and req.api_name != vt["api_name"]:
            if not IDENT.match(req.api_name):
                raise HTTPException(400, "invalid API name")
            vt["api_name"] = req.api_name
        cur = vt["versions"][-1]
        cons = req.constraints if req.constraints is not None else cur.get("constraints") or {}
        msg = req.failure_message if req.failure_message is not None else cur.get("failure_message") or ""
        if cons != (cur.get("constraints") or {}) or msg != (cur.get("failure_message") or ""):
            _check_constraints(vt["base_type"], cons, vt.get("element_type"))
            candidate = {**vt, "versions": [*vt["versions"], {"version": cur["version"] + 1, "constraints": cons, "failure_message": msg.strip(), "created_at": _now()}]}
            failures, samples = _stored_failures(candidate, _value_type_consumers(vt_id))
            if failures and not req.force:
                raise HTTPException(409, f"{failures} stored value{'s' if failures > 1 else ''} fail the new constraints (a breaking change: "
                                         f"deprecate this value type and create a new one, or force it): " + "; ".join(samples))
            vt = candidate
        return _vt_summary(_put("value-types", vt))


@router.delete("/value-types/{vt_id}")
def delete_value_type(vt_id: str) -> dict:
    with _lock:
        vt = _get("value-types", vt_id, "value type")
        require_role(vt.get("ontology_id"), "editor", vt, "delete value types")
        used = _value_type_consumers(vt_id)
        if used:
            raise HTTPException(400, f"{len(used)} properties or parameters use this value type: remove it from them first")
        _path("value-types", vt_id).unlink(missing_ok=True)
        return {"deleted": vt_id}


class ValidateIn(BaseModel):
    value: Any = None


@router.post("/value-types/{vt_id}/validate")
def validate_value(vt_id: str, req: ValidateIn) -> dict:
    vt = _get("value-types", vt_id, "value type")
    why = value_type_error(vt, req.value)
    return {"valid": why is None, "message": why}


# ------------------------------------------------------------------------------------------------
# shared properties
# ------------------------------------------------------------------------------------------------

# metadata a property inherits from its shared property
INHERITED = ("type", "array", "struct_fields", "vector_dimension", "value_type_id", "value_formatting", "render_hints", "visibility", "description")


class SharedPropertyIn(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    api_name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    type: Optional[str] = None
    array: Optional[bool] = None
    struct_fields: Optional[list[dict]] = None
    vector_dimension: Optional[int] = None
    value_type_id: Optional[str] = None
    value_formatting: Optional[dict] = None
    render_hints: Optional[list[str]] = None
    type_classes: Optional[list[str]] = None
    visibility: Optional[Literal["prominent", "normal", "hidden"]] = None
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    ontology_id: Optional[str] = None
    protected: Optional[bool] = None


def _sp_usage(sp_id: str) -> list[dict]:
    return [{"object_type_id": t["id"], "object_type": t["display_name"], "property": p["api_name"]}
            for t in _all("object-types") for p in t["properties"] if p.get("shared_property_id") == sp_id]


def _sp_summary(sp: dict) -> dict:
    ifaces = [i["id"] for i in _all("interfaces") if any(p.get("shared_property_id") == sp["id"] for p in i.get("properties") or [])]
    return {**sp, "usage": _sp_usage(sp["id"]), "interface_ids": ifaces}


def _check_shared(rec: dict) -> None:
    probe = {"api_name": rec["api_name"], "display_name": rec["display_name"], **{k: rec.get(k) for k in INHERITED if rec.get(k) is not None},
             "type_classes": rec.get("type_classes")}
    ontology._check_property({k: v for k, v in probe.items() if v is not None})
    if rec.get("value_type_id"):
        vt = _get("value-types", rec["value_type_id"], "value type")
        if not _compatible(vt, rec["type"], bool(rec.get("array"))):
            raise HTTPException(400, f"the value type {vt['display_name']} ({vt['base_type']}) does not fit a {rec['type']} property")


def _apply_shared(p: dict, sp: dict) -> dict:
    out = {**p}
    for k in INHERITED:
        if sp.get(k) is not None:
            out[k] = sp[k]
        elif k in out and k not in ("description",):
            out.pop(k)
    out["type_classes"] = sorted(set(p.get("type_classes") or []) | set(sp.get("type_classes") or []))
    if not out["type_classes"]:
        out.pop("type_classes")
    if not out.get("display_name"):
        out["display_name"] = sp["display_name"]
    return out


def _propagate_shared(sp: dict) -> None:
    for t in _all("object-types"):
        changed = False
        props = []
        for p in t["properties"]:
            if p.get("shared_property_id") == sp["id"]:
                p = _apply_shared(p, sp)
                changed = True
            props.append(p)
        if changed:
            t["properties"] = props
            _put("object-types", t)


@router.get("/shared-properties")
def list_shared_properties(ontology_id: Optional[str] = None) -> list[dict]:
    with _lock:
        return [_sp_summary(s) for s in _all("shared-properties") if (not ontology_id or s.get("ontology_id", "default") == ontology_id) and discoverable(s)]


@router.get("/shared-properties/{sp_id}")
def get_shared_property(sp_id: str) -> dict:
    with _lock:
        return _sp_summary(_get("shared-properties", sp_id, "shared property"))


def new_shared_property(req: SharedPropertyIn, rid: Optional[str] = None) -> dict:
    if not req.display_name or not req.type:
        raise HTTPException(400, "a shared property needs a name and a base type")
    api = req.api_name or ontology._api_name(req.display_name, False)
    if any(s["api_name"].lower() == api.lower() and s["id"] != rid for s in _all("shared-properties")):
        raise HTTPException(409, f'a shared property with the API name "{api}" exists')
    rec = {"id": rid or _new_id("sp"), **{k: v for k, v in req.model_dump(exclude_none=True).items()}, "api_name": api,
           "display_name": req.display_name.strip(), "status": req.status or "experimental", "ontology_id": req.ontology_id or "default",
           "protected": bool(req.protected), "created_at": _now()}
    _check_shared(rec)
    return rec


@router.post("/shared-properties")
def create_shared_property(req: SharedPropertyIn) -> dict:
    with _lock:
        rec = new_shared_property(req)
        _guard("shared_property", rec["id"], "create", None, rec)
        return _sp_summary(_put("shared-properties", rec))


def update_shared_record(sp: dict, req: SharedPropertyIn) -> dict:
    changes = req.model_dump(exclude_unset=True)
    if sp.get("status") == "active" and changes.get("api_name") not in (None, sp["api_name"]):
        raise HTTPException(400, "the API name of an active shared property cannot change")
    if changes.get("type") not in (None, sp["type"]) and _sp_usage(sp["id"]):
        raise HTTPException(400, "the base type of a shared property in use cannot change")
    out = {**sp, **{k: v for k, v in changes.items() if v is not None}}
    _check_shared(out)
    return out


@router.patch("/shared-properties/{sp_id}")
def update_shared_property(sp_id: str, req: SharedPropertyIn) -> dict:
    with _lock:
        sp = _get("shared-properties", sp_id, "shared property")
        new = update_shared_record(sp, req)
        _guard("shared_property", sp_id, "update", sp, new)
        _put("shared-properties", new)
        _propagate_shared(new)
        return _sp_summary(new)


def detach_shared(sp_id: str) -> None:
    for t in _all("object-types"):
        if any(p.get("shared_property_id") == sp_id for p in t["properties"]):
            t["properties"] = [{k: v for k, v in p.items() if k != "shared_property_id"} for p in t["properties"]]
            _put("object-types", t)
    for i in _all("interfaces"):
        if any(p.get("shared_property_id") == sp_id for p in i.get("properties") or []):
            i["properties"] = [{k: v for k, v in p.items() if k != "shared_property_id"} for p in i["properties"]]
            _put("interfaces", i)


@router.delete("/shared-properties/{sp_id}")
def delete_shared_property(sp_id: str) -> dict:
    """Deleting a shared property detaches it: the properties that used it keep their current metadata."""
    with _lock:
        sp = _get("shared-properties", sp_id, "shared property")
        if sp.get("status") == "active":
            raise HTTPException(400, "an active shared property cannot be deleted: make it experimental or deprecated first")
        _guard("shared_property", sp_id, "delete", sp, None)
        detach_shared(sp_id)
        _path("shared-properties", sp_id).unlink(missing_ok=True)
        return {"deleted": sp_id, "detached": len(_sp_usage(sp_id))}


# ------------------------------------------------------------------------------------------------
# interfaces
# ------------------------------------------------------------------------------------------------


class InterfaceIn(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    api_name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    icon: Optional[str] = None
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    # [{api_name, display_name, description, type, array?, required, shared_property_id?, primary_key_constraint:
    #   "must" | "cannot" | None, type_classes, render_hints, visibility}]
    properties: Optional[list[dict]] = None
    extends: Optional[list[str]] = None
    # [{api_name, display_name, description, target_kind: interface|object_type, target_interface_id? | target_object_type_id?,
    #   cardinality: one|many, required}]
    link_constraints: Optional[list[dict]] = None
    # [{api_name, display_name, description, required, parameters: [{api_name, display_name, type, list, required}]}]
    action_type_constraints: Optional[list[dict]] = None
    # searchable interfaces load or search all their objects at once (at most 75 implementations; others 1,000)
    searchable: Optional[bool] = None
    ontology_id: Optional[str] = None
    protected: Optional[bool] = None


SEARCHABLE_LIMIT = 75
IMPLEMENTATION_LIMIT = 1000
ACTION_PARAM_TYPES = ("string", "integer", "long", "double", "decimal", "boolean", "date", "timestamp", "object", "interface", "object_set",
                      "attachment", "media", "struct", "geopoint", "geoshape", "user")


def interface_link_constraints(iface: dict) -> list[dict]:
    """An interface's link type constraints with those inherited through extensions."""
    out = {c["api_name"]: c for c in iface.get("link_constraints") or []}
    for parent in _ancestors(iface):
        for c in parent.get("link_constraints") or []:
            out.setdefault(c["api_name"], {**c, "inherited_from": parent["id"]})
    return list(out.values())


def interface_action_constraints(iface: dict) -> list[dict]:
    """An interface's action type constraints with those inherited through extensions."""
    out = {c["api_name"]: c for c in iface.get("action_type_constraints") or []}
    for parent in _ancestors(iface):
        for c in parent.get("action_type_constraints") or []:
            out.setdefault(c["api_name"], {**c, "inherited_from": parent["id"]})
    return list(out.values())


def interface_properties(iface: dict, seen: Optional[set] = None) -> list[dict]:
    """An interface's properties with those of the interfaces it extends."""
    seen = seen or set()
    if iface["id"] in seen:
        return []
    seen.add(iface["id"])
    out = {p["api_name"]: p for p in iface.get("properties") or []}
    for parent_id in iface.get("extends") or []:
        parent = _read(_path("interfaces", parent_id))
        if parent:
            for p in interface_properties(parent, seen):
                out.setdefault(p["api_name"], p)
    return list(out.values())


def _check_interface(rec: dict) -> None:
    names = [p.get("api_name") for p in rec.get("properties") or []]
    if len(set(names)) != len(names) or not all(n and IDENT.match(n) for n in names):
        raise HTTPException(400, "interface property API names must be valid and unique")
    props = []
    for p in rec.get("properties") or []:
        if p.get("shared_property_id"):
            sp = _get("shared-properties", p["shared_property_id"], "shared property")
            p = {**p, "type": sp["type"], "array": sp.get("array"), "display_name": p.get("display_name") or sp["display_name"]}
        if p.get("type") not in ontology.PROPERTY_TYPES:
            raise HTTPException(400, f"{p['api_name']}: unknown base type")
        props.append(p)
    rec["properties"] = props
    for parent in rec.get("extends") or []:
        if parent == rec["id"]:
            raise HTTPException(400, "an interface cannot extend itself")
        _get("interfaces", parent, "interface")
    if rec["id"] in {i["id"] for i in _ancestors(rec)}:
        raise HTTPException(400, "interfaces cannot extend each other in a cycle")
    for p in props:
        if p.get("primary_key_constraint") not in (None, "must", "cannot"):
            raise HTTPException(400, f"{p['api_name']}: the primary key constraint is must, cannot or none")
    for lc in rec.get("link_constraints") or []:
        if not IDENT.match(lc.get("api_name") or ""):
            raise HTTPException(400, "link constraints need a valid API name")
        if lc.get("cardinality", "many") not in ("one", "many"):
            raise HTTPException(400, "a link constraint's cardinality is one or many")
        if not (lc.get("target_interface_id") or lc.get("target_object_type_id")):
            raise HTTPException(400, "a link constraint targets an interface or an object type")
        lc["target_kind"] = "interface" if lc.get("target_interface_id") else "object_type"
        if lc.get("target_interface_id"):
            _get("interfaces", lc["target_interface_id"], "target interface")
        else:
            _get("object-types", lc["target_object_type_id"], "target object type")
    names = [c.get("api_name") for c in rec.get("action_type_constraints") or []]
    if len(set(names)) != len(names) or not all(n and IDENT.match(n) for n in names):
        raise HTTPException(400, "action type constraint API names must be valid and unique")
    for c in rec.get("action_type_constraints") or []:
        pnames = [p.get("api_name") for p in c.get("parameters") or []]
        if len(set(pnames)) != len(pnames) or not all(n and IDENT.match(n) for n in pnames):
            raise HTTPException(400, f"{c['api_name']}: parameter constraint API names must be valid and unique")
        for p in c.get("parameters") or []:
            if p.get("type") not in ACTION_PARAM_TYPES:
                raise HTTPException(400, f"{c['api_name']}.{p['api_name']}: unknown parameter type {p.get('type')}")


def _ancestors(rec: dict) -> list[dict]:
    out, todo, seen = [], list(rec.get("extends") or []), set()
    while todo:
        i = todo.pop()
        if i in seen:
            continue
        seen.add(i)
        r = _read(_path("interfaces", i))
        if r:
            out.append(r)
            todo.extend(r.get("extends") or [])
    return out


def implementations(iface_id: str, types: Optional[list[dict]] = None, ifaces: Optional[list[dict]] = None) -> list[tuple[dict, dict]]:
    """(object type, implements entry) for every object type implementing the interface or one extending it. A caller
    summarizing many interfaces passes the object types and interfaces it read once (every type file per call)."""
    ids = {iface_id} | {i["id"] for i in (ifaces if ifaces is not None else _all("interfaces")) if iface_id in {a["id"] for a in _ancestors(i)}}
    out = []
    for t in types if types is not None else _all("object-types"):
        for imp in t.get("implements") or []:
            if imp.get("interface_id") in ids:
                out.append((t, imp))
                break
    return out


def _iface_summary(i: dict, types: Optional[list[dict]] = None, ifaces: Optional[list[dict]] = None) -> dict:
    return {**i, "all_properties": interface_properties(i), "all_link_constraints": interface_link_constraints(i),
            "all_action_constraints": interface_action_constraints(i), "searchable": i.get("searchable", True),
            "implemented_by": [{"object_type_id": t["id"], "display_name": t["display_name"]} for t, _ in implementations(i["id"], types, ifaces)]}


@router.get("/interfaces")
def list_interfaces(ontology_id: Optional[str] = None) -> list[dict]:
    with _lock:
        ifaces = _all("interfaces")
        shown = [i for i in ifaces if (not ontology_id or i.get("ontology_id", "default") == ontology_id) and discoverable(i)]
        # the object types once for all interfaces, not once per interface (53 × 7.6 MB of JSON took 25 s)
        types = _all("object-types") if shown else []
        return [_iface_summary(i, types, ifaces) for i in shown]


@router.get("/interfaces/{iface_id}")
def get_interface(iface_id: str) -> dict:
    with _lock:
        return _iface_summary(_get("interfaces", iface_id, "interface"))


def new_interface(req: InterfaceIn, rid: Optional[str] = None) -> dict:
    if not req.display_name:
        raise HTTPException(400, "name the interface")
    api = req.api_name or ontology._api_name(req.display_name, True)
    if not IDENT.match(api):
        raise HTTPException(400, "invalid API name")
    if any(i["api_name"].lower() == api.lower() and i["id"] != rid for i in _all("interfaces")):
        raise HTTPException(409, f'an interface with the API name "{api}" exists')
    rec = {"id": rid or _new_id("if"), "api_name": api, "display_name": req.display_name.strip(), "description": (req.description or "").strip(),
           "icon": req.icon or "layers", "status": req.status or "experimental", "properties": req.properties or [], "extends": req.extends or [],
           "link_constraints": req.link_constraints or [], "action_type_constraints": req.action_type_constraints or [],
           "searchable": True if req.searchable is None else bool(req.searchable),
           "ontology_id": req.ontology_id or "default", "protected": bool(req.protected), "created_at": _now()}
    _check_interface(rec)
    return rec


@router.post("/interfaces")
def create_interface(req: InterfaceIn) -> dict:
    with _lock:
        rec = new_interface(req)
        _guard("interface", rec["id"], "create", None, rec)
        return _iface_summary(_put("interfaces", rec))


def update_interface_record(rec: dict, req: InterfaceIn) -> dict:
    changes = req.model_dump(exclude_unset=True)
    if rec.get("status") == "active" and changes.get("api_name") not in (None, rec["api_name"]):
        raise HTTPException(400, "the API name of an active interface cannot change")
    out = {**rec, **{k: v for k, v in changes.items() if v is not None}}
    _check_interface(out)
    return out


@router.patch("/interfaces/{iface_id}")
def update_interface(iface_id: str, req: InterfaceIn) -> dict:
    with _lock:
        rec = _get("interfaces", iface_id, "interface")
        new = update_interface_record(rec, req)
        _guard("interface", iface_id, "update", rec, new)
        # implementations must still satisfy the interface
        _put("interfaces", new)
        try:
            for t, _ in implementations(iface_id):
                _check_implements(t)
        except HTTPException:
            _put("interfaces", rec)
            raise
        return _iface_summary(new)


@router.delete("/interfaces/{iface_id}")
def delete_interface(iface_id: str) -> dict:
    with _lock:
        rec = _get("interfaces", iface_id, "interface")
        if rec.get("status") == "active":
            raise HTTPException(400, "an active interface cannot be deleted")
        if implementations(iface_id):
            raise HTTPException(400, "object types implement this interface: remove the implementations first")
        if any(iface_id in (i.get("extends") or []) for i in _all("interfaces")):
            raise HTTPException(400, "other interfaces extend this one")
        _guard("interface", iface_id, "delete", rec, None)
        _path("interfaces", iface_id).unlink(missing_ok=True)
        return {"deleted": iface_id}


def _check_implements(t: dict) -> None:
    by = {p["api_name"]: p for p in t["properties"]}
    for imp in t.get("implements") or []:
        iface = _get("interfaces", imp.get("interface_id", ""), "interface")
        count = len({x["id"] for x, _ in implementations(iface["id"])} | {t["id"]})
        limit = SEARCHABLE_LIMIT if iface.get("searchable", True) else IMPLEMENTATION_LIMIT
        if count > limit:
            raise HTTPException(400, f"{iface['display_name']} is {'searchable' if limit == SEARCHABLE_LIMIT else 'not searchable'}: at most {limit} object types implement it")
        mapping = dict(imp.get("mapping") or {})
        for ip in interface_properties(iface):
            local = mapping.get(ip["api_name"])
            if not local and ip.get("shared_property_id"):
                local = next((p["api_name"] for p in t["properties"] if p.get("shared_property_id") == ip["shared_property_id"]), None)
            if not local and ip["api_name"] in by and by[ip["api_name"]]["type"] == ip.get("type"):
                local = ip["api_name"]
            if not local:
                if ip.get("required"):
                    raise HTTPException(400, f"{t['display_name']} implements {iface['display_name']}: map its required property {ip['api_name']}")
                continue
            if local not in by and "." in local:
                # a struct field ("prop.field") implements a scalar interface property
                sp, sf = local.split(".", 1)
                fld = next((f for f in (by.get(sp) or {}).get("struct_fields") or [] if f["api_name"] == sf), None)
                if by.get(sp, {}).get("type") != "struct" or not fld:
                    raise HTTPException(400, f"{t['display_name']} implements {iface['display_name']}: {local} is not a struct field")
                if fld["type"] != ip.get("type") or ip.get("array"):
                    raise HTTPException(400, f"{iface['display_name']}.{ip['api_name']} is a {ip.get('type')}{' array' if ip.get('array') else ''}: "
                                             f"the struct field {local} is a {fld['type']}")
                if ip.get("primary_key_constraint") == "must":
                    raise HTTPException(400, f"{iface['display_name']}.{ip['api_name']} must be mapped to {t['display_name']}'s primary key")
                mapping[ip["api_name"]] = local
                continue
            if local not in by:
                raise HTTPException(400, f"{t['display_name']} implements {iface['display_name']}: {local} is not a property")
            lp = by[local]
            if lp["type"] != ip.get("type") or bool(lp.get("array")) != bool(ip.get("array")):
                raise HTTPException(400, f"{iface['display_name']}.{ip['api_name']} is a {ip.get('type')}{' array' if ip.get('array') else ''}: "
                                         f"{local} is a {lp['type']}{' array' if lp.get('array') else ''}")
            if ip.get("primary_key_constraint") == "must" and local != t["primary_key"]:
                raise HTTPException(400, f"{iface['display_name']}.{ip['api_name']} must be mapped to {t['display_name']}'s primary key")
            if ip.get("primary_key_constraint") == "cannot" and local == t["primary_key"]:
                raise HTTPException(400, f"{iface['display_name']}.{ip['api_name']} cannot be mapped to the primary key")
            mapping[ip["api_name"]] = local
        for lc in interface_link_constraints(iface):
            lt_id = (imp.get("links") or {}).get(lc["api_name"])
            if lc.get("required") and not lt_id:
                raise HTTPException(400, f"{t['display_name']} implements {iface['display_name']}: choose the link type for {lc['api_name']}")
            if lt_id:
                lt = _get("link-types", lt_id, "link type")
                if t["id"] not in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]):
                    raise HTTPException(400, f"link type {lt['display_name']} does not involve {t['display_name']}")
                other = lt["target"]["object_type_id"] if lt["source"]["object_type_id"] == t["id"] else lt["source"]["object_type_id"]
                if lc.get("target_object_type_id") and other != lc["target_object_type_id"]:
                    raise HTTPException(400, f"{lc['api_name']} links to {lc['target_object_type_id']}: {lt['display_name']} links elsewhere")
                if lc.get("target_interface_id"):
                    ot = _read(_path("object-types", other)) or {}
                    impl_ids = {i["interface_id"] for i in ot.get("implements") or []}
                    impl_ids |= {a["id"] for i in list(impl_ids) for a in _ancestors({"extends": [i]})}
                    if lc["target_interface_id"] not in impl_ids:
                        raise HTTPException(400, f"{lc['api_name']} links to objects of an interface that {ot.get('display_name', other)} does not implement")
                if lc.get("cardinality") == "one":
                    one = (lt["kind"] == "foreign_key" and lt["source"]["object_type_id"] == t["id"]) or lt["cardinality"] == "one_to_one"
                    if not one:
                        raise HTTPException(400, f"{lc['api_name']} has cardinality one: use a link where each {t['display_name']} links to one object")
        actions = dict(imp.get("actions") or {})
        for ac in interface_action_constraints(iface):
            m = actions.get(ac["api_name"])
            if not m or not m.get("action_type_id"):
                if ac.get("required"):
                    raise HTTPException(400, f"{t['display_name']} implements {iface['display_name']}: map the action type constraint {ac['api_name']}")
                continue
            a = _read(_path("action-types", m["action_type_id"]))
            if not a:
                raise HTTPException(400, f"{ac['api_name']}: the mapped action type no longer exists")
            params = {p["id"]: p for p in a.get("parameters") or []}
            used: set[str] = set()
            for pc in ac.get("parameters") or []:
                target = (m.get("parameters") or {}).get(pc["api_name"])
                if not target:
                    if pc.get("required"):
                        raise HTTPException(400, f"{ac['api_name']}: map the required parameter constraint {pc['api_name']}")
                    continue
                if target not in params:
                    raise HTTPException(400, f"{ac['api_name']}.{pc['api_name']}: {a['display_name']} has no parameter {target}")
                if target in used:
                    raise HTTPException(400, f"{ac['api_name']}: {target} cannot satisfy two parameter constraints")
                used.add(target)
                ap = params[target]
                kind = ap.get("type")
                compatible = kind == pc["type"] or (pc["type"] == "object_set" and kind == "object" and (ap.get("array") or ap.get("multiple")))
                if not compatible or bool(pc.get("list")) != bool(ap.get("array") or ap.get("multiple")) and pc["type"] != "object_set":
                    raise HTTPException(400, f"{ac['api_name']}.{pc['api_name']} is a {pc['type']}{' list' if pc.get('list') else ''}: {target} is a {kind}")
                if pc.get("required") and not ap.get("required"):
                    raise HTTPException(400, f"{ac['api_name']}.{pc['api_name']} is required: map it to a required parameter")
        known = {c["api_name"] for c in interface_action_constraints(iface)}
        stale = [k for k in actions if k not in known]
        if stale:
            raise HTTPException(400, f"the action type constraint {stale[0]} no longer exists on {iface['display_name']}")
        imp["mapping"] = mapping


def iface_value(props: dict, local: str) -> Any:
    """The value an implementing property (or struct field "prop.field") holds for an interface property."""
    if local in props or "." not in local:
        return props.get(local)
    sp, sf = local.split(".", 1)
    v = props.get(sp)
    return v.get(sf) if isinstance(v, dict) else None


@router.get("/interfaces/{iface_id}/objects/{type_id}/{pk}/links/{constraint}")
def interface_object_links(iface_id: str, type_id: str, pk: str, constraint: str, request: Request = None) -> dict:  # type: ignore[assignment]
    """Follow an interface link type constraint from one object through its type's concrete link type (for a build: as
    the build's identity)."""
    import build_calls

    build_calls.enforce(request, ("read", "object_type", type_id, None))
    with build_calls.acting_for(request):
        return _interface_object_links(iface_id, type_id, pk, constraint)


def _interface_object_links(iface_id: str, type_id: str, pk: str, constraint: str) -> dict:
    with _lock:
        iface = _get("interfaces", iface_id, "interface")
        lc = next((c for c in interface_link_constraints(iface) if c["api_name"] == constraint), None)
        if not lc:
            raise HTTPException(404, "link type constraint not found")
        t = ontology._object_type(type_id)
        ontology._find(t, pk)  # an object the caller may not see has no links to show
        imp = next((i for i in t.get("implements") or [] if i["interface_id"] == iface_id
                    or iface_id in {a["id"] for a in _ancestors({"extends": [i["interface_id"]]})}), None)
        lt_id = ((imp or {}).get("links") or {}).get(constraint)
        if not lt_id:
            return {"constraint": lc, "objects": []}
        lt = _get("link-types", lt_id, "link type")
        direction = "forward" if lt["source"]["object_type_id"] == type_id else "reverse"
        other = ontology._object_type(side_of(lt, direction)[1]["object_type_id"])
        objs = ontology._objects(other["id"])
        pks = linked_map(lt, direction, {str(pk)}).get(str(pk), [])
        rows = [ontology._public_object(other, x, objs[x]) for x in pks if x in objs and ontology._can_see(other, objs[x])]
        return {"constraint": lc, "link_type_id": lt_id, "objects": rows[: 1 if lc.get("cardinality") == "one" else 500]}


@router.get("/interfaces/{iface_id}/objects")
def interface_objects(iface_id: str, q: str = "", limit: int = 200) -> dict:
    """Objects of every implementing object type, with their properties under the interface's names."""
    with _lock:
        iface = _get("interfaces", iface_id, "interface")
        rows = []
        for t, imp in implementations(iface_id):
            try:
                t = ontology._object_type(t["id"])
            except HTTPException:
                continue
            mapping = imp.get("mapping") or {}
            for pk, o in ontology._objects(t["id"]).items():
                if not ontology._can_see(t, o):
                    continue
                pub = ontology._public_object(t, pk, o)
                pub["interface_properties"] = {ip: iface_value(pub["properties"], local) for ip, local in mapping.items()}
                rows.append(pub)
    record_query("base", [t["id"] for t, _ in implementations(iface_id)], len(rows))
    needle = q.strip().lower()
    if needle:
        rows = [r for r in rows if needle in r["title"].lower() or any(needle in str(v).lower() for v in r["interface_properties"].values())]
    return {"interface": _iface_summary(iface), "total": len(rows), "objects": rows[: max(1, min(limit, 5000))]}


# ------------------------------------------------------------------------------------------------
# link types
# ------------------------------------------------------------------------------------------------


class LinkSide(BaseModel):
    object_type_id: str
    # how this side's objects are named from the other side ("Employees" from a Department)
    display_name: Optional[str] = Field(None, max_length=200)
    plural_display_name: Optional[str] = Field(None, max_length=200)
    api_name: Optional[str] = Field(None, max_length=100)
    visibility: Literal["prominent", "normal", "hidden"] = "normal"
    # "kind:name" type classes on this side, e.g. vertex:link_primary_direction (Vertex points edge arrows at it)
    type_classes: list[str] = Field(default_factory=list, max_length=20)


class LinkTypeIn(BaseModel):
    display_name: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    kind: Optional[Literal["foreign_key", "join_table", "object_backed"]] = None
    cardinality: Optional[Literal["one_to_one", "many_to_one", "many_to_many"]] = None
    # foreign key: the source side holds the property; the target side is referenced by its primary key
    source: Optional[LinkSide] = None
    target: Optional[LinkSide] = None
    foreign_key: Optional[str] = None
    # object backed: {object_type_id, source_property, target_property}
    backing: Optional[dict] = None
    status: Optional[Literal["experimental", "active", "deprecated", "example"]] = None
    type_classes: Optional[list[str]] = None
    ontology_id: Optional[str] = None
    protected: Optional[bool] = None


STATUS_RANK = {"deprecated": 0, "example": 1, "experimental": 2, "active": 3, "promoted": 3}


def _forced_status(lt: dict) -> Optional[str]:
    """The status a link type must take from its object types and foreign key."""
    statuses = []
    for side in ("source", "target"):
        t = _read(_path("object-types", lt[side]["object_type_id"])) or {}
        statuses.append(t.get("status", "experimental"))
    if lt.get("kind") == "foreign_key":
        t = _read(_path("object-types", lt["source"]["object_type_id"])) or {}
        fk = next((p for p in t.get("properties", []) if p["api_name"] == lt.get("foreign_key")), None)
        if fk and fk.get("status"):
            statuses.append(fk["status"])
    for s in ("deprecated", "example", "experimental"):
        if s in statuses:
            return s
    return None


def _check_link_type(lt: dict) -> None:
    src = _get("object-types", lt["source"]["object_type_id"], "source object type")
    tgt = _get("object-types", lt["target"]["object_type_id"], "target object type")
    if (src.get("ontology_id") or "default") != (tgt.get("ontology_id") or "default"):
        raise HTTPException(400, "both object types of a link type belong to the same ontology")
    lt["ontology_id"] = src.get("ontology_id") or "default"
    if lt["kind"] not in LINK_KINDS:
        raise HTTPException(400, "a link type is a foreign key, join table or object backed link")
    if lt["kind"] == "foreign_key":
        if lt["cardinality"] not in ("one_to_one", "many_to_one"):
            raise HTTPException(400, "foreign key links are one-to-one or many-to-one")
        fk = next((p for p in src["properties"] if p["api_name"] == lt.get("foreign_key")), None)
        if not fk:
            raise HTTPException(400, f"pick the property of {src['display_name']} holding {tgt['display_name']}'s primary key")
        pk_type = ontology._ptype(tgt, tgt["primary_key"])
        if fk.get("array") or (fk["type"] not in ontology.PK_TYPES) or ((fk["type"] == "string") != (pk_type == "string")):
            raise HTTPException(400, f"the foreign key {fk['api_name']} ({fk['type']}) does not match {tgt['display_name']}'s primary key ({pk_type})")
    elif lt["kind"] == "join_table":
        if lt["cardinality"] != "many_to_many":
            raise HTTPException(400, "join table links are many-to-many")
    else:
        b = lt.get("backing") or {}
        bt = _get("object-types", b.get("object_type_id", ""), "backing object type")
        names = {p["api_name"] for p in bt["properties"]}
        if b.get("source_property") not in names or b.get("target_property") not in names:
            raise HTTPException(400, f"pick the properties of {bt['display_name']} holding the source and target primary keys")
        lt["cardinality"] = lt.get("cardinality") or "many_to_many"
    for side, t, other in (("source", src, tgt), ("target", tgt, src)):
        s = lt[side]
        many = side == "source" or lt["cardinality"] == "many_to_many"
        s["display_name"] = (s.get("display_name") or (t["plural_name"] if many else t["display_name"])).strip()
        s["plural_display_name"] = s.get("plural_display_name") or t["plural_name"]
        s["api_name"] = s.get("api_name") or ontology._api_name(s["display_name"], False)
        if not IDENT.match(s["api_name"]):
            raise HTTPException(400, f"{s['api_name']} is not a valid API name")
        # this side's API name is how `other` reaches it: unique among other's links
        for x in _all("link-types"):
            if x["id"] == lt["id"]:
                continue
            for xs, xo in (("source", "target"), ("target", "source")):
                if x[xo]["object_type_id"] == other["id"] and x[xs]["api_name"].lower() == s["api_name"].lower():
                    raise HTTPException(409, f"{other['display_name']} already reaches {s['api_name']} through {x['display_name']}")
    if lt["source"]["object_type_id"] == lt["target"]["object_type_id"] and lt["source"]["api_name"] == lt["target"]["api_name"]:
        raise HTTPException(400, "the two sides of a link type between the same object type need different API names")
    forced = _forced_status(lt)
    if forced and STATUS_RANK[lt.get("status", "experimental")] > STATUS_RANK[forced]:
        lt["status"] = forced


def new_link_type(req: LinkTypeIn, rid: Optional[str] = None) -> dict:
    if not req.source or not req.target or not req.kind:
        raise HTTPException(400, "a link type needs two object types and a relationship type")
    lt = {"id": rid or _new_id("lt"), "kind": req.kind, "cardinality": req.cardinality or ("many_to_many" if req.kind != "foreign_key" else "many_to_one"),
          "source": req.source.model_dump(exclude_none=True), "target": req.target.model_dump(exclude_none=True),
          "foreign_key": req.foreign_key, "backing": req.backing, "status": req.status or "experimental", "description": (req.description or "").strip(),
          "type_classes": req.type_classes or [], "protected": bool(req.protected), "created_at": _now()}
    _check_link_type(lt)
    lt["display_name"] = (req.display_name or f"{lt['target']['display_name']} ↔ {lt['source']['display_name']}").strip()
    return lt


def update_link_record(lt: dict, req: LinkTypeIn) -> dict:
    changes = req.model_dump(exclude_unset=True)
    out = json.loads(json.dumps(lt))
    for side in ("source", "target"):
        if changes.get(side):
            if changes[side]["object_type_id"] != lt[side]["object_type_id"]:
                raise HTTPException(400, "a link type's object types cannot change: create a new link type")
            new_api = changes[side].get("api_name")
            if lt.get("status") == "active" and new_api and new_api != lt[side]["api_name"]:
                raise HTTPException(400, "the API names of an active link type cannot change")
            out[side] = {**lt[side], **{k: v for k, v in changes[side].items() if v is not None}}
    for k in ("display_name", "description", "status", "type_classes", "foreign_key", "backing", "protected", "cardinality"):
        if changes.get(k) is not None:
            out[k] = changes[k]
    if changes.get("kind") not in (None, lt["kind"]):
        raise HTTPException(400, "a link type's relationship type cannot change")
    _check_link_type(out)
    return out


def _lt_summary(lt: dict) -> dict:
    return {**lt, "link_count": len(_read(ontology.DIR / "links" / f"{lt['id']}.json", []) or []) if lt["kind"] == "join_table" else None}


@router.get("/link-types")
def list_link_types(object_type_id: Optional[str] = None, ontology_id: Optional[str] = None) -> list[dict]:
    with _lock:
        out = []
        for lt in _all("link-types"):
            if object_type_id and object_type_id not in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]):
                continue
            if ontology_id and lt.get("ontology_id", "default") != ontology_id:
                continue
            if discoverable(lt):
                out.append(_lt_summary(lt))
        return out


@router.get("/link-types/{lt_id}")
def get_link_type(lt_id: str) -> dict:
    with _lock:
        return _lt_summary(_get("link-types", lt_id, "link type"))


@router.post("/link-types")
def create_link_type(req: LinkTypeIn) -> dict:
    with _lock:
        lt = new_link_type(req)
        _guard("link_type", lt["id"], "create", None, lt)
        _put("link-types", lt)
        if lt["kind"] == "join_table":
            _write(ontology.DIR / "links" / f"{lt['id']}.json", [])
        return _lt_summary(lt)


@router.patch("/link-types/{lt_id}")
def update_link_type(lt_id: str, req: LinkTypeIn) -> dict:
    with _lock:
        lt = _get("link-types", lt_id, "link type")
        new = update_link_record(lt, req)
        _guard("link_type", lt_id, "update", lt, new)
        return _lt_summary(_put("link-types", new))


@router.delete("/link-types/{lt_id}")
def delete_link_type(lt_id: str) -> dict:
    with _lock:
        lt = _get("link-types", lt_id, "link type")
        if lt.get("status") == "active":
            raise HTTPException(400, "an active link type cannot be deleted: make it experimental or deprecated first")
        _guard("link_type", lt_id, "delete", lt, None)
        _path("link-types", lt_id).unlink(missing_ok=True)
        (ontology.DIR / "links" / f"{lt_id}.json").unlink(missing_ok=True)
        return {"deleted": lt_id}


def _pairs(lt: dict) -> list[tuple[str, str]]:
    """(source pk, target pk) of every link."""
    if lt["kind"] == "join_table":
        return [(str(a), str(b)) for a, b in ontology.stored_links(lt["id"])]
    if lt["kind"] == "foreign_key":
        import ontology_live

        if ontology_live.is_live(lt["source"]["object_type_id"]):
            # a live source is read with one query (refused above ontology_live.SMALL objects: no pair list of millions)
            return [(a, b) for a, bs in ontology_live.linked_map_fk(lt, "forward").items() for b in bs]
        objs = ontology.stored_objects(lt["source"]["object_type_id"])
        return [(pk, str(v)) for pk, o in objs.items() if (v := o.get("properties", {}).get(lt["foreign_key"])) not in (None, "")]
    b = lt["backing"]
    objs = ontology.stored_objects(b["object_type_id"])
    return [(str(s), str(t)) for o in objs.values()
            if (s := o.get("properties", {}).get(b["source_property"])) not in (None, "") and (t := o.get("properties", {}).get(b["target_property"])) not in (None, "")]


def linked_map(lt: dict, direction: str, pks: Optional[set[str]] = None) -> dict[str, list[str]]:
    """From each starting pk to the linked pks on the other side: forward goes source → target."""
    import ontology_live

    if lt["kind"] == "foreign_key" and (ontology_live.is_live(lt["source"]["object_type_id"]) or ontology_live.is_live(lt["target"]["object_type_id"])):
        # a live side: resolved with queries (a facility profile → its millions of claims never loads them all)
        return defaultdict(list, ontology_live.linked_map_fk(lt, direction, pks))
    out: dict[str, list[str]] = defaultdict(list)
    other = ontology.stored_objects(lt["target" if direction == "forward" else "source"]["object_type_id"])
    for s, t in _pairs(lt):
        a, b = (s, t) if direction == "forward" else (t, s)
        if (pks is None or a in pks) and b in other:
            out[a].append(b)
    return out


def side_of(lt: dict, direction: str) -> tuple[dict, dict]:
    """(the starting side, the side reached) for a direction."""
    return (lt["source"], lt["target"]) if direction == "forward" else (lt["target"], lt["source"])


def links_of(type_id: str) -> list[tuple[dict, str]]:
    """(link type, direction) for every way out of an object type."""
    out = []
    for lt in _all("link-types"):
        if lt["source"]["object_type_id"] == type_id:
            out.append((lt, "forward"))
        if lt["target"]["object_type_id"] == type_id and (lt["source"]["object_type_id"] != type_id or lt["source"]["api_name"] != lt["target"]["api_name"]):
            out.append((lt, "reverse"))
    return out


class LinkEditIn(BaseModel):
    op: Literal["add", "remove"]
    source: str
    target: str


@router.post("/link-types/{lt_id}/links")
def edit_link(lt_id: str, req: LinkEditIn, request: Request = None) -> dict:  # type: ignore[assignment]
    """Add or remove one link of a join table link type (foreign key and object backed links change through edits);
    for a build, as the build's identity (it may write both object types)."""
    import build_calls

    with _lock:
        lt = _get("link-types", lt_id, "link type")
    build_calls.enforce(request, ("write", "object_type", lt["source"]["object_type_id"], None),
                        ("write", "object_type", lt["target"]["object_type_id"], None))
    with build_calls.acting_for(request):
        return _edit_link(lt_id, req)


def _edit_link(lt_id: str, req: LinkEditIn) -> dict:
    with _lock:
        lt = _get("link-types", lt_id, "link type")
        if lt["kind"] != "join_table":
            raise HTTPException(400, "only join table links are added directly: edit the foreign key or backing object instead")
        src = ontology._object_type(lt["source"]["object_type_id"])
        tgt = ontology._object_type(lt["target"]["object_type_id"])
        require_role(lt.get("ontology_id"), "editor", lt, "edit links")
        ontology._find(src, req.source)
        ontology._find(tgt, req.target)
        if ontology.SCENARIO.get() and "scenario_link_write" in ontology.MODEL_HOOKS:
            ontology.MODEL_HOOKS["scenario_link_write"](ontology.SCENARIO.get(), [{"op": req.op, "link_type_id": lt_id, "source": str(req.source), "target": str(req.target)}])
            return {"link_count": len(ontology.stored_links(lt_id))}
        path = ontology.DIR / "links" / f"{lt_id}.json"
        pairs = [tuple(map(str, p)) for p in _read(path, []) or []]
        pair = (str(req.source), str(req.target))
        if req.op == "add" and pair not in pairs:
            pairs.append(pair)
        elif req.op == "remove":
            pairs = [p for p in pairs if p != pair]
        _write(path, [list(p) for p in pairs])
        ontology._hook("link_edits", lt_id, [{"op": req.op, "link_type_id": lt_id, "source": str(req.source), "target": str(req.target)}])
    record_indexing(lt["source"]["object_type_id"], 1)
    _hook("links", [lt_id])
    return {"link_count": len(pairs)}


@router.get("/object-types/{type_id}/objects/{pk}/links")
def object_links(type_id: str, pk: str, limit: int = 50, request: Request = None) -> list[dict]:  # type: ignore[assignment]
    """The objects linked to one object, by link type and direction (for a build: as the build's identity, so linked
    objects follow its user's object security)."""
    import build_calls

    build_calls.enforce(request, ("read", "object_type", type_id, None))
    with build_calls.acting_for(request):
        return _object_links(type_id, pk, limit)


def _object_links(type_id: str, pk: str, limit: int = 50) -> list[dict]:
    with _lock:
        # the object itself first: an object the caller may not see has no links to show (they would confirm it exists
        # and what it is linked to, as the end-to-end tests of AIP found for a policy-hidden claim, 2026-10-22)
        ontology._find(ontology._object_type(type_id), pk)
        out = []
        for lt, direction in links_of(type_id):
            start, reach = side_of(lt, direction)
            if start["object_type_id"] != type_id:
                continue
            try:
                other = ontology._object_type(reach["object_type_id"])
            except HTTPException:
                continue
            pks = linked_map(lt, direction, {str(pk)}).get(str(pk), [])
            objs = ontology._objects(other["id"])
            total = None
            if hasattr(objs, "prefetch"):
                # a live type: the shown objects read in one query; the count is the links' (the dataset holds every row)
                total, pks = len(pks), sorted(pks)[:limit]
                objs.prefetch(pks)
            rows = [ontology._public_object(other, x, objs[x]) for x in pks if x in objs and ontology._can_see(other, objs[x])]
            out.append({"link_type_id": lt["id"], "link_type": lt["display_name"], "direction": direction, "name": reach["display_name"],
                        "api_name": reach["api_name"], "visibility": reach.get("visibility", "normal"), "object_type_id": other["id"],
                        "object_type": other["display_name"], "many": direction == "reverse" or lt["cardinality"] == "many_to_many",
                        "editable": lt["kind"] == "join_table", "count": len(rows) if total is None else total, "objects": rows[:limit]})
    record_query("search_around", [type_id], len(out))
    return out


def _on_status_changed(t: dict, old: Optional[dict]) -> None:
    """Statuses cascade from object types (and foreign keys) to their link types."""
    for lt in _all("link-types"):
        if t["id"] in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]):
            forced = _forced_status(lt)
            if forced and STATUS_RANK[lt.get("status", "experimental")] > STATUS_RANK[forced]:
                lt["status"] = forced
                _put("link-types", lt)


def _on_deleted(kind: str, rid: str) -> None:
    if kind != "object_type":
        return
    for lt in _all("link-types"):
        if rid in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]) or (lt.get("backing") or {}).get("object_type_id") == rid:
            _path("link-types", lt["id"]).unlink(missing_ok=True)
            (ontology.DIR / "links" / f"{lt['id']}.json").unlink(missing_ok=True)


# ------------------------------------------------------------------------------------------------
# object type checks, derived properties and reducers
# ------------------------------------------------------------------------------------------------

DERIVED_AGGS = ("none", "count", "sum", "avg", "min", "max", "collect_list", "collect_set", "approximate_cardinality")


def _check_type(t: dict) -> None:
    """Shared properties, value types, groups, derived properties and interfaces of an object type being saved."""
    props = []
    for p in t["properties"]:
        if p.get("shared_property_id"):
            sp = _get("shared-properties", p["shared_property_id"], "shared property")
            p = _apply_shared(p, sp)
        if p.get("value_type_id"):
            vt = _get("value-types", p["value_type_id"], "value type")
            if not _compatible(vt, p["type"], bool(p.get("array"))):
                raise HTTPException(400, f"{p['api_name']}: the value type {vt['display_name']} ({vt['base_type']}) does not fit a {p['type']} property")
        if p.get("derived"):
            _check_derived(t, p)
        props.append(p)
    t["properties"] = props
    known = {g["id"] for g in _groups()}
    bad = [g for g in t.get("groups") or [] if g not in known]
    if bad:
        raise HTTPException(400, f"unknown object type group {bad[0]}")
    get_ontology(t.get("ontology_id"))
    _check_implements(t)
    # existing values must pass newly applied value types
    objs = ontology.load_objects(t["id"])
    for p in props:
        if p.get("value_type_id") and objs:
            vt = _read(_path("value-types", p["value_type_id"]))
            for pk, o in objs.items():
                v = o.get("properties", {}).get(p["api_name"])
                for x in (v if isinstance(v, list) and vt["base_type"] != "array" else [v]):
                    why = value_type_error(vt, x)
                    if why:
                        raise HTTPException(400, f"{p['api_name']} of {pk} fails the value type {vt['display_name']} ({why}): the object type would fail to index")


def _check_derived(t: dict, p: dict) -> None:
    d = p["derived"]
    hops = d.get("links") or []
    if not 1 <= len(hops) <= 3:
        raise HTTPException(400, f"{p['api_name']}: a derived property follows one to three link types")
    cur = t["id"]
    for h in hops:
        lt = _get("link-types", h.get("link_type_id", ""), "link type")
        direction = h.get("direction", "forward")
        start, reach = side_of(lt, direction)
        if start["object_type_id"] != cur:
            raise HTTPException(400, f"{p['api_name']}: {lt['display_name']} does not start from the previous object type")
        cur = reach["object_type_id"]
    target = _get("object-types", cur, "object type")
    agg = d.get("aggregation", "none")
    if agg not in DERIVED_AGGS:
        raise HTTPException(400, f"{p['api_name']}: the aggregation is one of {', '.join(DERIVED_AGGS)}")
    if agg != "count":
        src = next((x for x in target["properties"] if x["api_name"] == d.get("property")), None)
        if not src:
            raise HTTPException(400, f"{p['api_name']}: pick a property of {target['display_name']} to derive")
        if agg in ("sum", "avg") and src["type"] not in ("integer", "long", "short", "byte", "double", "float", "decimal"):
            raise HTTPException(400, f"{p['api_name']}: {agg} needs a numeric property")
        many = any(_get("link-types", h["link_type_id"], "link type")["cardinality"] == "many_to_many" or h.get("direction", "forward") == "reverse" for h in hops)
        if agg == "none" and many:
            raise HTTPException(400, f"{p['api_name']}: the link path reaches many objects: aggregate them")
    p["edit_only"] = False


def _derived_value(t: dict, pk: str, p: dict) -> Any:
    d = p["derived"]
    pks = {pk}
    for h in d.get("links") or []:
        lt = _read(_path("link-types", h["link_type_id"]))
        if not lt:
            return None
        m = linked_map(lt, h.get("direction", "forward"), pks)
        pks = {x for v in m.values() for x in v}
        cur = side_of(lt, h.get("direction", "forward"))[1]["object_type_id"]
    agg = d.get("aggregation", "none")
    if agg == "count":
        return len(pks)
    objs = ontology.stored_objects(cur)
    vals = [objs[x].get("properties", {}).get(d.get("property")) for x in sorted(pks) if x in objs]
    vals = [v for v in vals if v is not None]
    if agg == "none":
        return vals[0] if vals else None
    if agg in ("collect_list", "collect_set"):
        if agg == "collect_set":
            seen, out = set(), []
            for v in vals:
                key = json.dumps(v, sort_keys=True)
                if key not in seen:
                    seen.add(key)
                    out.append(v)
            vals = out
        return vals[: int(d.get("limit") or 100)]
    if agg == "approximate_cardinality":
        return len({json.dumps(v, sort_keys=True) for v in vals})
    if not vals:
        return None
    if agg in ("min", "max"):
        return (min if agg == "min" else max)(vals)
    nums = [n for v in vals if (n := _num(v)) is not None]
    if not nums:
        return None
    return sum(nums) if agg == "sum" else sum(nums) / len(nums)


def _reduce(p: dict, value: Any) -> Any:
    """The one element of an array a reducer picks (first reducer wins; later ones break ties)."""
    if not isinstance(value, list) or not value:
        return None
    items = list(value)
    for r in reversed(p["reducers"]):
        field = r.get("field")
        key = (lambda v, f=field: (v or {}).get(f) if isinstance(v, dict) else v)
        present = [v for v in items if key(v) is not None]
        missing = [v for v in items if key(v) is None]
        present.sort(key=lambda v: (str(type(key(v))), key(v)), reverse=r.get("order", "desc") == "desc")
        items = present + missing
    return items[0]


def _derive(t: dict, pk: str, props: dict) -> dict:
    out: dict[str, Any] = {}
    reduced: dict[str, Any] = {}
    for p in t["properties"]:
        if p.get("derived"):
            try:
                out[p["api_name"]] = _derived_value(t, pk, p)
            except Exception:  # noqa: BLE001
                out[p["api_name"]] = None
        if p.get("reducers"):
            reduced[p["api_name"]] = _reduce(p, props.get(p["api_name"]))
    if reduced:
        out["__reduced"] = reduced
    return out


# ------------------------------------------------------------------------------------------------
# edits: link cleanup, edit history and indexing compute
# ------------------------------------------------------------------------------------------------

EDIT_LOG_KEPT = 200
# (object type, primary key) -> the properties a modify really changed, from the user-edit records of the write in
# progress (ontology_edits.record runs before the "edits" hook): the edit log lists those, not every property
_CHANGED: dict[tuple[str, str], list[str]] = {}


def _note_changes(records: list[dict], who: str, now: str) -> None:
    for r in records:
        if r["op"] == "modify":
            before, after = r.get("before") or {}, r.get("after") or {}
            _CHANGED[(r["object_type_id"], str(r["primary_key"]))] = sorted(k for k in r.get("changed") or {} if before.get(k) != after.get(k))


def _on_edits(written: list[dict]) -> None:
    if not written:
        return
    by_type: dict[str, list[dict]] = defaultdict(list)
    for w in written:
        by_type[w["object_type_id"]].append(w)
    who = (auth.current() or {}).get("username") or "system"
    for tid, ws in by_type.items():
        deleted = {w["primary_key"] for w in ws if w["op"] == "delete"}
        if deleted:
            for lt in _all("link-types"):
                if lt["kind"] != "join_table" or tid not in (lt["source"]["object_type_id"], lt["target"]["object_type_id"]):
                    continue
                path = ontology.DIR / "links" / f"{lt['id']}.json"
                pairs = _read(path, []) or []
                keep = [p for p in pairs if not ((lt["source"]["object_type_id"] == tid and str(p[0]) in deleted)
                                                 or (lt["target"]["object_type_id"] == tid and str(p[1]) in deleted))]
                if len(keep) != len(pairs):
                    _write(path, keep)
        path = ontology.DIR / "edit-log" / f"{tid}.json"
        log = _read(path, []) or []
        now = _now()
        for w in ws:
            props = _CHANGED.pop((tid, str(w["primary_key"])), None) if w["op"] == "modify" else None
            log.append({"at": now, "user": who, "op": w["op"], "primary_key": w["primary_key"],
                        "properties": [] if w["op"] == "delete" else props if props is not None else sorted((w.get("properties") or {}).keys())})
        _write(path, log[-EDIT_LOG_KEPT:])
        record_indexing(tid, len(ws))


@router.get("/object-types/{type_id}/objects/{pk}/history")
def object_history(type_id: str, pk: str) -> list[dict]:
    with _lock:
        ontology._object_type(type_id)
        log = _read(ontology.DIR / "edit-log" / f"{type_id}.json", []) or []
        return [e for e in reversed(log) if e["primary_key"] == str(pk)][:50]


# ------------------------------------------------------------------------------------------------
# usage metering
# ------------------------------------------------------------------------------------------------

USAGE_DAYS = 90


def _hour(at: Optional[datetime] = None) -> str:
    return (at or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H")


# Metering is batched: queries add to in-memory counts (under _usage_lock) that a background thread folds into
# usage.json every USAGE_FLUSH_SECONDS, or at once when USAGE_FLUSH_COUNT records are waiting, and at exit. A flush
# re-reads the file and adds the deltas (compute) / overrides the samples (volume), so other processes' writes are
# kept; the write is atomic (ontology._write: temp file + replace, retried on Windows PermissionError). Readers merge
# the unflushed counts, so the usage page stays exact. A corrupt usage.json is moved aside (usage.json.corrupt-<time>)
# and metering starts over instead of failing every query.
USAGE_FLUSH_SECONDS = 5.0
USAGE_FLUSH_COUNT = 500
_usage_flush_lock = threading.Lock()  # one flush at a time; taken before _usage_lock, never inside it
_pending: dict[str, dict[str, float]] = {"compute": {}, "volume": {}}
_pending_n = 0
_pending_dir: Optional[Any] = None  # the data dir the pending counts belong to (tests reconfigure ontology.DIR)
_flusher: Optional[threading.Thread] = None
_usage_log = logging.getLogger("bluesandai.ontology_usage")


def _usage_file(base: Optional[Any] = None) -> dict:
    """usage.json as stored; a file that does not parse is kept aside and an empty one returned."""
    p = (base or ontology.DIR) / "usage.json"
    try:
        for attempt in range(40):  # Windows: the file is briefly unopenable while another process replaces it
            try:
                u = _read(p, None) or {}
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.005 if attempt < 4 else 0.05)
        if not isinstance(u, dict) or not isinstance(u.get("compute", {}), dict) or not isinstance(u.get("volume", {}), dict):
            raise ValueError("not a usage document")
    except (ValueError, UnicodeDecodeError) as e:  # json.JSONDecodeError is a ValueError
        aside = p.with_name(f"usage.json.corrupt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}")
        try:
            os.replace(p, aside)
            _usage_log.error("usage.json unreadable (%s): kept as %s, metering starts over", e, aside.name)
        except OSError:
            _usage_log.exception("usage.json unreadable (%s) and could not be moved aside", e)
            raise
        u = {}
    u.setdefault("compute", {})
    u.setdefault("volume", {})
    return u


def _merge_pending(u: dict, pending: dict) -> dict:
    for key, v in pending["compute"].items():
        u["compute"][key] = round(u["compute"].get(key, 0) + v, 4)
    u["volume"].update(pending["volume"])
    return u


def _usage() -> dict:
    """The stored usage plus the counts not flushed yet."""
    with _usage_flush_lock:  # no flush half-done: the file and the pending counts never both hold a record
        u = _usage_file()
        with _usage_lock:
            if _pending_dir == ontology.DIR:
                _merge_pending(u, _pending)
    return u


def flush_usage() -> None:
    """Fold the pending counts into usage.json (re-read, add, prune old hours, atomic write). On failure the counts
    go back to pending for the next flush."""
    global _pending, _pending_n, _pending_dir
    with _usage_flush_lock:
        with _usage_lock:
            if not _pending_n:
                return
            batch, n, base = _pending, _pending_n, _pending_dir
            _pending, _pending_n = {"compute": {}, "volume": {}}, 0
        try:
            u = _merge_pending(_usage_file(base), batch)
            cutoff = _hour(datetime.now(timezone.utc) - timedelta(days=USAGE_DAYS))
            for k in ("compute", "volume"):
                u[k] = {key: v for key, v in u[k].items() if key.split("|", 1)[0] >= cutoff}
            _write(base / "usage.json", u)
        except BaseException:
            with _usage_lock:  # keep the counts: newer ones were added on top meanwhile
                for key, v in batch["compute"].items():
                    _pending["compute"][key] = _pending["compute"].get(key, 0) + v
                for key, v in batch["volume"].items():
                    _pending["volume"].setdefault(key, v)
                _pending_n += n
                _pending_dir = base
            raise
        with _usage_lock:
            if not _pending_n:
                _pending_dir = None


def _flush_loop() -> None:
    while True:
        time.sleep(USAGE_FLUSH_SECONDS)
        try:
            flush_usage()
        except Exception:  # noqa: BLE001
            _usage_log.exception("usage flush failed; retrying")


def _flush_at_exit() -> None:
    try:
        flush_usage()
    except Exception:  # noqa: BLE001
        _usage_log.exception("usage not flushed at exit")


atexit.register(_flush_at_exit)


def _record(compute: Optional[dict[str, float]] = None, volume: Optional[dict[str, int]] = None) -> None:
    global _pending_n, _pending_dir, _flusher
    if _pending_dir is not None and _pending_dir != ontology.DIR:
        flush_usage()  # the data dir changed: the old counts go to the old dir's file
    with _usage_lock:
        for key, v in (compute or {}).items():
            _pending["compute"][key] = _pending["compute"].get(key, 0) + v
        _pending["volume"].update(volume or {})
        _pending_n += 1
        _pending_dir = ontology.DIR
        due = _pending_n >= USAGE_FLUSH_COUNT
        if _flusher is None or not _flusher.is_alive():
            _flusher = threading.Thread(target=_flush_loop, daemon=True, name="ontology-usage-flush")
            _flusher.start()
    if due:
        try:
            flush_usage()
        except Exception:  # noqa: BLE001  the counts stay pending; the query itself succeeded
            _usage_log.exception("usage flush failed; retrying")


def _ontology_of(type_id: str) -> str:
    t = _read(_path("object-types", type_id)) if re.fullmatch(r"[A-Za-z0-9_-]+", type_id or "") else None
    return (t or {}).get("ontology_id") or "default"


def query_cost(kind: str, objects: int = 1) -> float:
    base = QUERY_COST.get(kind, 2)
    if kind == "action":
        return base + max(0, objects - 1)
    return base


def record_query(kind: str, type_ids: list[str], objects: int = 1) -> float:
    """Compute-seconds of one query, split across the object types it ran on and attributed to the resource."""
    cost = query_cost(kind, objects)
    resource = RESOURCE.get() or "unattributed"
    ids = [t for t in type_ids if t] or ["none"]
    h = _hour()
    compute: dict[str, float] = {}
    for tid in ids:
        key = f"{h}|{_ontology_of(tid)}|query:{kind}|{resource}|{tid}"
        compute[key] = compute.get(key, 0) + cost / len(ids)
    _record(compute=compute)
    return cost


def record_indexing(type_id: str, objects: int) -> float:
    """Indexing compute: max(vCPU, GiB / 7.5) × runtime for a driver and two executors, the runtime growing with the
    objects indexed (an edit export or a full re-index)."""
    runtime = max(1.0, objects / 5000)
    cost = round(3 * runtime, 3)
    _record(compute={f"{_hour()}|{_ontology_of(type_id)}|indexing|{RESOURCE.get() or 'indexing'}|{type_id}": cost})
    return cost


def sample_volume() -> None:
    """Ontology volume now: the indexed size of each object type's objects and join table links."""
    sizes: dict[str, int] = {}
    for t in _all("object-types"):
        st = ontology.objects_stat(t["id"])
        sizes[t["id"]] = st["size"] if st else 0
    for lt in _all("link-types"):
        p = ontology.DIR / "links" / f"{lt['id']}.json"
        if p.exists():
            sizes[lt["source"]["object_type_id"]] = sizes.get(lt["source"]["object_type_id"], 0) + p.stat().st_size
    h = _hour()
    _record(volume={f"{h}|{_ontology_of(tid)}|{tid}": b for tid, b in sizes.items()})


def _volume_loop() -> None:
    while True:
        try:
            with _lock:
                sample_volume()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(600)


@router.get("/usage")
def usage(days: int = 30, ontology_id: Optional[str] = None) -> dict:
    """Ontology volume (average GB and GB-months), indexing compute and query compute (by query type, resource and
    object type, per day) over the last days."""
    days = max(1, min(days, USAGE_DAYS))
    since = _hour(datetime.now(timezone.utc) - timedelta(days=days))
    u = _usage()
    names = {t["id"]: t["display_name"] for t in _all("object-types")}
    by_kind: dict[str, float] = defaultdict(float)
    by_resource: dict[str, float] = defaultdict(float)
    by_type: dict[str, float] = defaultdict(float)
    by_day: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for key, v in u["compute"].items():
        hour, oid, kind, resource, tid = key.split("|", 4)
        if hour < since or (ontology_id and oid != ontology_id):
            continue
        by_kind[kind] += v
        by_resource[resource] += v
        by_type[tid] += v
        by_day[hour[:10]]["indexing" if kind == "indexing" else "query"] += v
    vol_hours: dict[str, dict[str, int]] = defaultdict(dict)
    for key, b in u["volume"].items():
        hour, oid, tid = key.split("|", 2)
        if hour < since or (ontology_id and oid != ontology_id):
            continue
        vol_hours[tid][hour] = b
    volume = []
    for tid, hours in vol_hours.items():
        avg_gb = sum(hours.values()) / len(hours) / 1e9
        # each hourly sample counts 1/730 of a month
        gb_month = sum(hours.values()) / 1e9 / 730
        latest = hours[max(hours)]
        volume.append({"object_type_id": tid, "object_type": names.get(tid, tid), "bytes": latest, "average_gb": avg_gb, "gb_months": gb_month})
    volume.sort(key=lambda r: -r["bytes"])
    return {
        "days": days,
        "query_costs": QUERY_COST,
        "compute_seconds": round(sum(by_kind.values()), 3),
        "by_kind": {k: round(v, 3) for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1])},
        "by_resource": [{"resource": r, "compute_seconds": round(v, 3)} for r, v in sorted(by_resource.items(), key=lambda kv: -kv[1])],
        "by_object_type": [{"object_type_id": t, "object_type": names.get(t, t), "compute_seconds": round(v, 3)} for t, v in sorted(by_type.items(), key=lambda kv: -kv[1])],
        "by_day": [{"day": d, **{k: round(x, 3) for k, x in v.items()}} for d, v in sorted(by_day.items())],
        "volume": volume,
        "volume_bytes": sum(v["bytes"] for v in volume),
        "gb_months": sum(v["gb_months"] for v in volume),
    }

