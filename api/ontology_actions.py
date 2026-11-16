"""Action types, modelled on Foundry's action types: rules, parameters, submission criteria, side effects and logs.

A rule-based action type (kind "rules") turns parameters into Ontology edits and effects with rules: create, modify,
create-or-modify and delete objects; create and delete (many-to-many) links; create, modify and delete objects of an
interface; a function rule (an Ontology edit function, alone); notifications; webhooks (a writeback before the edits,
or side effects after them); and schedule builds. Property values come from a parameter, a property of an object
parameter, a static value, the current user or time, a writeback webhook's response, a schedule run or an object
created by an earlier rule. Rules compile to one edit per object: an object cannot be modified before it is created,
created twice, or deleted after being created or modified in the same submission.

Parameters are typed (any property base type, object and interface references, object types, users, groups, lists
of them) with a description, visibility (normal, disabled, hidden), a default (static, current user or time, a
property of an earlier object parameter, another parameter), allowed values (a list, or the values of a property in
an object set) and object dropdown filters (properties matching static values, parameters or object properties; a
starting set and Search Arounds). Overrides change visibility, requiredness, defaults and allowed values when their
conditions on earlier parameters hold (the first matching block wins). Sections group parameters in one or two
columns, collapsible, hidden by overrides.

Submission criteria are trees of conditions on the current user (ID, groups, attributes), parameters (values,
object properties, list lengths) and the execution context, combined with all / any / none, each root with a
failure message. Security: who may apply the action, read authorization (the markings an action may read) and
write authorization (the minimum markings of what it writes). An object type may require action logs.

Applying an action: permissions and criteria; the writeback webhook; schedule builds; the edits (atomically, at most
10,000 objects of 50 object types); the action log (a log object per submission, with a summary, parameter values and
edited objects); notifications (in-platform and email, to static users / groups, parameter users or object
properties, with recipients' access checked) and side effect webhooks. Each submission is recorded with its
duration and failure category (action metrics, p95, monitors with alerts), and can be reverted by the user who
applied it while every edited object is unchanged since. Test runs evaluate everything without writing. Inline edits
apply an object type's per-property edit action to one value; batches apply many requests at once.

Mounted by server.py under /api/ontology (actions) and /api/notifications.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _all, _get, _lock, _new_id, _now, _path, _put, _read, _write

router = APIRouter(prefix="/api/ontology")
notes_router = APIRouter(prefix="/api/notifications")

OBJECT_RULES = ("create_object", "modify_object", "create_or_modify_object", "delete_object")
LINK_RULES = ("create_link", "delete_link")
INTERFACE_RULES = ("create_interface_object", "modify_interface_object", "delete_interface_object", "create_interface_link", "delete_interface_link")
EFFECT_RULES = ("notification", "webhook", "schedule")
# apply_scenario: merge an Ontology scenario's edits (the scenario parameter), scoped to object and link types
RULE_KINDS = OBJECT_RULES + LINK_RULES + INTERFACE_RULES + ("function", "apply_scenario") + EFFECT_RULES
REF_TYPES = ("object", "interface", "object_type", "user", "group")
VALUE_REFS = ("parameter", "object_property", "static", "current_user", "current_time", "writeback_response", "schedule_run", "new_object")
SINGLE_OPS = ("is", "is_not", "matches", "lt", "lte", "gt", "gte")
MULTI_OPS = ("includes", "includes_any", "included_in", "each_is", "each_is_not")
LIMITS = {"objects": 10_000, "object_types": 50, "list": 10_000, "object_list": 1_000, "criteria_list": 1_000, "batch": 10_000,
          "batch_function": 20, "recipients": 500, "subject": 250, "body": 1_000, "html": 51_200}
FAILURES = ("invalid_parameter", "scale_limit", "authentication", "side_effect", "function", "user_facing_function", "conflict", "unclassified")
RUNS_KEPT_DAYS = 30
OPTIONS_LIMIT = 200


class ActionFailure(HTTPException):
    """An action that cannot be applied, with its metrics category."""

    def __init__(self, status: int, detail: str, category: str) -> None:
        super().__init__(status, detail)
        self.category = category


def configure() -> None:
    for name in ("action-runs", "notifications"):
        (ontology.DIR / name).mkdir(parents=True, exist_ok=True)
    ontology.MODEL_HOOKS.update({"check_action": check_action, "action_edits": _edits_only, "apply_action": apply_action_hook})


# ------------------------------------------------------------------------------------------------
# configuration checks
# ------------------------------------------------------------------------------------------------


def _params(action: dict) -> dict[str, dict]:
    return {p["id"]: p for p in action.get("parameters") or []}


def _check_ref(ref: Any, params: dict[str, dict], where: str) -> None:
    if not isinstance(ref, dict) or ref.get("kind") not in VALUE_REFS:
        raise HTTPException(400, f"{where}: a value comes from a parameter, an object parameter's property, a static value, the current user or time")
    if ref["kind"] in ("parameter", "object_property") and ref.get("parameter") not in params:
        raise HTTPException(400, f"{where}: unknown parameter {ref.get('parameter')}")
    if ref["kind"] == "object_property" and params[ref["parameter"]].get("type") not in ("object", "interface"):
        raise HTTPException(400, f"{where}: {ref['parameter']} is not an object parameter")


def _check_condition(node: dict, params: dict[str, dict], where: str, before: Optional[set[str]] = None) -> None:
    kind = node.get("kind")
    if kind in ("and", "or", "not"):
        for c in node.get("children") or []:
            _check_condition(c, params, where, before)
        return
    if kind != "condition":
        raise HTTPException(400, f"{where}: a criterion is a condition or an all / any / none group")
    left = node.get("left") or {}
    if left.get("kind") not in ("current_user_id", "current_user_groups", "current_user_attribute", "parameter", "execution_context"):
        raise HTTPException(400, f"{where}: compare the current user, a parameter or the execution context")
    for side in (left, node.get("value") or {}):
        if side.get("kind") == "parameter":
            pid = side.get("parameter")
            if pid not in params:
                raise HTTPException(400, f"{where}: unknown parameter {pid}")
            if before is not None and pid not in before:
                raise HTTPException(400, f"{where}: overrides can only use parameters above this one")
            if params[pid].get("type") == "attachment":
                raise HTTPException(400, f"{where}: attachment parameters cannot be used in conditions")
    if node.get("op") not in SINGLE_OPS + MULTI_OPS:
        raise HTTPException(400, f"{where}: unknown operator {node.get('op')}")
    if node.get("op") == "matches":
        try:
            re.compile(str((node.get("value") or {}).get("value") or ""))
        except re.error as e:
            raise HTTPException(400, f"{where}: the regular expression does not compile ({e})") from None


def check_action(rec: dict) -> None:
    """Validate a rule-based action type's parameters, rules, sections and criteria (and the shared settings of all
    action types)."""
    params = _params(rec)
    order = [p["id"] for p in rec.get("parameters") or []]
    for i, p in enumerate(rec.get("parameters") or []):
        where = f"parameter {p['id']}"
        if p.get("type") in ("object", "interface", "object_type") and rec.get("kind") == "rules":
            if p["type"] == "object" and not p.get("object_type_id"):
                raise HTTPException(400, f"{where}: pick the object type it references")
            if p["type"] in ("interface", "object_type") and not p.get("interface_id"):
                raise HTTPException(400, f"{where}: pick the interface")
        if p.get("visibility") not in (None, "normal", "hidden", "disabled"):
            raise HTTPException(400, f"{where}: visibility is normal, disabled or hidden")
        d = p.get("default")
        if d and d.get("kind") not in ("static", "current_user", "current_time", "object_property", "parameter"):
            raise HTTPException(400, f"{where}: unknown default")
        if d and d.get("kind") in ("object_property", "parameter") and d.get("parameter") not in order[:i]:
            raise HTTPException(400, f"{where}: a default can only come from a parameter above it")
        for j, block in enumerate(p.get("overrides") or []):
            for c in block.get("conditions") or []:
                _check_condition(c, params, f"{where} override {j + 1}", set(order[:i]))
        for f in (p.get("object_filter") or {}).get("filters") or []:
            if not f.get("property"):
                raise HTTPException(400, f"{where}: a dropdown filter needs a property")
    if rec.get("kind") != "rules":
        for c in rec.get("submission_criteria") or []:
            _check_condition(c, params, "submission criteria")
        return
    rules = rec.get("rules") or []
    if any(r.get("kind") == "function" for r in rules) and len([r for r in rules if r.get("kind") not in EFFECT_RULES]) > 1:
        raise HTTPException(400, "a function rule cannot be combined with other Ontology rules")
    writebacks = [r for r in rules if r.get("kind") == "webhook" and r.get("mode") == "writeback"]
    if len(writebacks) > 1:
        raise HTTPException(400, "only one webhook can be a writeback")
    for i, r in enumerate(rules):
        where = f"rule {i + 1} ({r.get('kind')})"
        k = r.get("kind")
        if k not in RULE_KINDS:
            raise HTTPException(400, f"{where}: unknown rule")
        if k in OBJECT_RULES:
            t = ontology._object_type(r.get("object_type_id") or rec.get("object_type_id") or "")
            r["object_type_id"] = t["id"]
            if k != "create_object" and (r.get("object_param") not in params or params[r["object_param"]].get("type") != "object"):
                raise HTTPException(400, f"{where}: pick the object parameter")
            names = {p["api_name"]: p for p in t["properties"]}
            for prop, ref in (r.get("properties") or {}).items():
                if prop not in names:
                    raise HTTPException(400, f"{where}: {t['display_name']} has no property {prop}")
                if names[prop].get("derived"):
                    raise HTTPException(400, f"{where}: {prop} is derived and cannot be written")
                if k in ("modify_object",) and prop == t["primary_key"]:
                    raise HTTPException(400, f"{where}: actions cannot modify a primary key")
                _check_ref(ref, params, f"{where} {prop}")
            for ln in r.get("links") or []:
                lt = _get("link-types", ln.get("link_type_id", ""), "link type")
                if lt["kind"] != "join_table":
                    raise HTTPException(400, f"{where}: only many-to-many links are added by a rule; edit the foreign key instead")
                _check_ref(ln.get("target"), params, f"{where} link")
        elif k in LINK_RULES:
            lt = _get("link-types", r.get("link_type_id", ""), "link type")
            if lt["kind"] != "join_table":
                raise HTTPException(400, f"{where}: create one-to-many links by modifying the foreign key with a Modify object rule")
            _check_ref(r.get("source"), params, f"{where} source")
            _check_ref(r.get("target"), params, f"{where} target")
        elif k in INTERFACE_RULES:
            iface = _get("interfaces", r.get("interface_id") or rec.get("interface_id") or "", "interface")
            r["interface_id"] = iface["id"]
            names = {p["api_name"] for p in om.interface_properties(iface)}
            if k == "create_interface_object" and params.get(r.get("object_type_param") or "", {}).get("type") != "object_type":
                raise HTTPException(400, f"{where}: pick the Object type parameter")
            if k in ("modify_interface_object", "delete_interface_object") and params.get(r.get("interface_param") or "", {}).get("type") != "interface":
                raise HTTPException(400, f"{where}: pick the interface reference parameter")
            for prop, ref in (r.get("properties") or {}).items():
                if prop not in names:
                    raise HTTPException(400, f"{where}: {iface['display_name']} has no property {prop}")
                _check_ref(ref, params, f"{where} {prop}")
            if k in ("create_interface_link", "delete_interface_link"):
                lcs = {c["api_name"] for c in om.interface_link_constraints(iface)}
                if r.get("link_constraint") not in lcs:
                    raise HTTPException(400, f"{where}: pick a link type constraint of {iface['display_name']}")
                _check_ref(r.get("source"), params, f"{where} source")
                _check_ref(r.get("target"), params, f"{where} target")
        elif k == "function":
            if not r.get("function_id"):
                raise HTTPException(400, f"{where}: pick an Ontology edit function")
            hook = ontology.MODEL_HOOKS.get("function_info")
            if hook:
                info = hook(r["function_id"], r.get("version"))
                if not info.get("edits") and info.get("edits") is not None:
                    raise HTTPException(400, f"{where}: {info['name']} is not an Ontology edit function (declare edits=[...])")
                if r.get("batched"):
                    ins = info.get("inputs") or []
                    if len(ins) != 1 or not str(ins[0].get("type") or "").startswith(("array<", "list")):
                        raise HTTPException(400, f"{where}: batched execution needs a function with a single input that is a list of structs")
                    r["batch_input"] = ins[0]["name"]
            for name, ref in (r.get("inputs") or {}).items():
                _check_ref(ref, params, f"{where} input {name}")
        elif k == "notification":
            if not r.get("recipients") and not r.get("recipients_function"):
                raise HTTPException(400, f"{where}: add recipients")
            for key in ("content_function", "recipients_function"):
                fn = r.get(key)
                if fn:
                    if not fn.get("function_id"):
                        raise HTTPException(400, f"{where}: pick the {key.split('_')[0]} function")
                    ontology._hook("check_function_ref", fn["function_id"], fn.get("version"))
                    for name, ref in (fn.get("inputs") or {}).items():
                        _check_ref(ref, params, f"{where} {key} input {name}")
            if len(str(r.get("subject") or "")) > LIMITS["subject"] or len(str(r.get("body") or "")) > LIMITS["body"]:
                raise HTTPException(400, f"{where}: the subject is at most 250 characters and the body 1,000")
            for rc in r.get("recipients") or []:
                if rc.get("kind") in ("parameter", "object_property") and rc.get("parameter") not in params:
                    raise HTTPException(400, f"{where}: unknown parameter {rc.get('parameter')}")
        elif k == "webhook":
            if r.get("mode") not in ("writeback", "side_effect"):
                raise HTTPException(400, f"{where}: a webhook runs as a writeback or a side effect")
            if not r.get("webhook_id"):
                raise HTTPException(400, f"{where}: pick a webhook")
            for name, ref in (r.get("inputs") or {}).items():
                _check_ref(ref, params, f"{where} input {name}")
        elif k == "schedule":
            if not r.get("pipeline_id") or not r.get("schedule_id"):
                raise HTTPException(400, f"{where}: pick a schedule")
        elif k == "apply_scenario":
            if params.get(r.get("scenario_param") or "", {}).get("type") != "string":
                raise HTTPException(400, f"{where}: pick the Scenario parameter (a string holding the scenario RID)")
            for tid in r.get("object_type_ids") or []:
                ontology._object_type(tid)
            for lid in r.get("link_type_ids") or []:
                _get("link-types", lid, "link type")
            if not (r.get("object_type_ids") or r.get("link_type_ids")):
                raise HTTPException(400, f"{where}: add the object types and link types the scenario may change")
    for c in rec.get("submission_criteria") or []:
        _check_condition(c, params, "submission criteria")
    seen: set[str] = set()
    for s in rec.get("sections") or []:
        for pid in s.get("parameters") or []:
            if pid not in params:
                raise HTTPException(400, f"section {s.get('title')}: unknown parameter {pid}")
            if pid in seen:
                raise HTTPException(400, f"parameter {pid} is in two sections")
            seen.add(pid)
        if s.get("columns", 1) not in (1, 2):
            raise HTTPException(400, "a section has one or two columns")


# ------------------------------------------------------------------------------------------------
# parameter values and form state
# ------------------------------------------------------------------------------------------------


def _user() -> dict:
    p = auth.current()
    if p is None or p.get("service") or not auth.enabled():
        return {"id": (p or {}).get("id") or "local", "username": (p or {}).get("username") or "local", "groups": [], "attributes": {},
                "organization_id": None, "markings": None}
    return p


def _obj_of(type_id: str, pk: Any) -> dict:
    t = ontology._object_type(type_id)
    key, o = ontology._find(t, pk)
    return ontology._public_object(t, key, o)


def _ref_value(v: Any) -> tuple[Optional[str], Optional[str]]:
    """(object type id, primary key) from {object_type_id, primary_key}, "type:pk" or a bare primary key."""
    if isinstance(v, dict):
        return v.get("object_type_id"), None if v.get("primary_key") is None else str(v.get("primary_key"))
    if isinstance(v, str) and ":" in v and v.split(":", 1)[0].startswith("ot-"):
        a, b = v.split(":", 1)
        return a, b
    return None, None if v in (None, "") else str(v)


def _norm_one(p: dict, raw: Any, action: dict) -> Any:
    label = p.get("display_name") or p["id"]
    if raw is None or raw == "":
        return None
    t = p.get("type")
    if t == "object":
        tid, pk = _ref_value(raw)
        type_id = p.get("object_type_id") or tid or action.get("object_type_id")
        try:
            return _obj_of(type_id, pk)
        except HTTPException:
            raise ActionFailure(400, f"{label}: {pk} was not found", "invalid_parameter") from None
    if t == "interface":
        tid, pk = _ref_value(raw)
        if not tid:
            raise ActionFailure(400, f"{label}: pick an object (its type and primary key)", "invalid_parameter")
        ot = ontology._object_type(tid)
        if p.get("interface_id") not in {i["interface_id"] for i in ot.get("implements") or []} and p.get("interface_id") not in \
                {a["id"] for i in ot.get("implements") or [] for a in om._ancestors({"extends": [i["interface_id"]]})}:
            raise ActionFailure(400, f"{label}: {ot['display_name']} does not implement the interface", "invalid_parameter")
        return _obj_of(tid, pk)
    if t == "object_type":
        ot = ontology._object_type(str(raw))
        if p.get("interface_id") and p["interface_id"] not in {i["interface_id"] for i in ot.get("implements") or []}:
            raise ActionFailure(400, f"{label}: {ot['display_name']} does not implement the interface", "invalid_parameter")
        return ot["id"]
    if t in ("user", "group"):
        return str(raw)
    try:
        v = ontology.coerce_property({"api_name": p["id"], "type": t, "struct_fields": p.get("struct_fields"), "vector_dimension": p.get("vector_dimension")}, raw, label)
    except HTTPException as e:
        raise ActionFailure(400, str(e.detail), "invalid_parameter") from None
    if v is not None and p.get("value_type_id"):
        try:
            ontology._hook("value_type", p["value_type_id"], v, label)
        except HTTPException as e:
            raise ActionFailure(400, str(e.detail), "invalid_parameter") from None
    return v


def _norm(p: dict, raw: Any, action: dict) -> Any:
    if p.get("property") and action.get("object_type_id") and p.get("type") != "object":
        # a parameter writing a property (legacy actions): the property's own definition coerces it
        t = _read(_path("object-types", action["object_type_id"])) or {}
        prop = next((x for x in t.get("properties") or [] if x["api_name"] == p["property"]), None)
        if prop:
            try:
                return ontology.coerce_property({**prop, "value_type_id": p.get("value_type_id") or prop.get("value_type_id")}, raw, p.get("display_name"))
            except HTTPException as e:
                raise ActionFailure(400, str(e.detail), "invalid_parameter") from None
    if p.get("array") or p.get("multiple"):
        if raw in (None, ""):
            return []
        items = raw if isinstance(raw, list) else [raw]
        limit = LIMITS["object_list"] if p.get("type") in ("object", "interface") else LIMITS["list"]
        if len(items) > limit:
            raise ActionFailure(400, f"{p.get('display_name') or p['id']}: at most {limit:,} values", "scale_limit")
        out = [_norm_one(p, x, action) for x in items]
        return [x for x in out if x is not None]
    return _norm_one(p, raw, action)


def _field(v: Any, prop: Optional[str]) -> Any:
    """A parameter value for comparisons and property mappings: objects become a property (or their primary key)."""
    if isinstance(v, list):
        return [_field(x, prop) for x in v]
    if isinstance(v, dict) and "primary_key" in v and "properties" in v:
        return v["properties"].get(prop) if prop else v["primary_key"]
    return v


def _empty(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, list) and not v)


def _side(side: dict, values: dict, user: dict) -> Any:
    k = side.get("kind")
    if k == "current_user_id":
        return user.get("id")
    if k == "current_user_groups":
        return list(user.get("groups") or [])
    if k == "current_user_attribute":
        attr = side.get("attribute") or ""
        if attr in ("organization", "organization_id"):
            return [user.get("organization_id")] if user.get("organization_id") else []
        v = (user.get("attributes") or {}).get(attr)
        return v if isinstance(v, list) else ([] if v is None else [v])
    if k == "execution_context":
        return "scenario" if ontology.SCENARIO.get() else "main"
    if k == "parameter":
        v = _field(values.get(side.get("parameter")), side.get("property"))
        if side.get("length"):
            return len(v) if isinstance(v, list) else (0 if v is None else 1)
        return v
    if k == "static":
        return side.get("value")
    return None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _eq(a: Any, b: Any) -> bool:
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None:
        return na == nb
    return str(a) == str(b)


def _test(node: dict, values: dict, user: dict) -> bool:
    k = node.get("kind")
    if k == "and":
        return all(_test(c, values, user) for c in node.get("children") or [])
    if k == "or":
        return any(_test(c, values, user) for c in node.get("children") or [])
    if k == "not":
        return not any(_test(c, values, user) for c in node.get("children") or [])
    left = _side(node.get("left") or {}, values, user)
    vside = node.get("value") or {"kind": "no_value"}
    op = node.get("op")
    if vside.get("kind") == "no_value":
        empty = _empty(left)
        return empty if op in ("is", "each_is", "included_in") else not empty
    right = _side(vside, values, user)
    lefts = left if isinstance(left, list) else [left]
    rights = right if isinstance(right, list) else [right]
    if op == "is":
        return _eq(left, right) if not isinstance(left, list) else sorted(map(str, left)) == sorted(map(str, rights))
    if op == "is_not":
        return not _test({**node, "op": "is"}, values, user)
    if op == "matches":
        return left is not None and re.search(str(right), str(left)) is not None
    if op in ("lt", "lte", "gt", "gte"):
        a, b = _num(left), _num(right)
        if a is None or b is None:
            a, b = str(left), str(right)  # type: ignore[assignment]
            if left is None or right is None:
                return False
        return {"lt": a < b, "lte": a <= b, "gt": a > b, "gte": a >= b}[op]  # type: ignore[operator]
    if op == "includes":
        return any(_eq(x, r) for x in lefts for r in rights[:1])
    if op == "includes_any":
        return any(_eq(x, r) for x in lefts for r in rights)
    if op == "included_in":
        return all(any(_eq(x, r) for r in rights) for x in lefts) and bool(lefts)
    if op == "each_is":
        return all(_eq(x, rights[0] if rights else None) for x in lefts)
    if op == "each_is_not":
        return all(not _eq(x, rights[0] if rights else None) for x in lefts)
    return False


def criteria_failures(action: dict, values: dict, user: dict) -> list[str]:
    out = []
    for node in action.get("submission_criteria") or []:
        if not _test(node, values, user):
            out.append(node.get("failure_message") or "You cannot submit this action with these values")
    return out


def _default(p: dict, values: dict, user: dict) -> Any:
    d = p.get("default") or {}
    k = d.get("kind")
    if k == "static":
        return d.get("value")
    if k == "current_user":
        return user.get("id")
    if k == "current_time":
        return _now()
    if k == "parameter":
        return values.get(d.get("parameter"))
    if k == "object_property":
        obj = values.get(d.get("parameter"))
        return _field(obj, d.get("property")) if obj else None
    if ontology._has_class(p, "prefill_current_user") or p.get("prefill") == "current_user":
        return user.get("id")
    return None


def _object_options(p: dict, values: dict, limit: int = OPTIONS_LIMIT) -> list[dict]:
    """Objects an object parameter's dropdown offers: the starting set, its Search Arounds and filters."""
    f = p.get("object_filter") or {}
    start = f.get("starting") or {}
    if start.get("kind") == "parameter":
        objs = values.get(start.get("parameter"))
        rows = objs if isinstance(objs, list) else [objs] if objs else []
        tid = rows[0]["object_type_id"] if rows else p.get("object_type_id")
    else:
        tid = start.get("object_type_id") or p.get("object_type_id")
        t = ontology._object_type(tid)
        rows = [ontology._public_object(t, pk, o) for pk, o in ontology._objects(tid).items() if ontology._can_see(t, o)]
    for sa in f.get("search_around") or []:
        lt = _get("link-types", sa["link_type_id"], "link type")
        reached = om.linked_map(lt, sa.get("direction", "forward"), {r["primary_key"] for r in rows})
        tid = om.side_of(lt, sa.get("direction", "forward"))[1]["object_type_id"]
        t = ontology._object_type(tid)
        objs = ontology._objects(tid)
        rows = [ontology._public_object(t, x, objs[x]) for x in sorted({y for v in reached.values() for y in v}) if x in objs]
    for flt in f.get("filters") or []:
        allowed = []
        for src in flt.get("values") or []:
            v = src.get("value") if src.get("kind") == "static" else _field(values.get(src.get("parameter")), src.get("property"))
            allowed.extend(v if isinstance(v, list) else [v])
        allowed = [a for a in allowed if a is not None]
        if not allowed:
            continue
        rows = [r for r in rows if any(_eq(r["properties"].get(flt["property"]), a) for a in allowed)]
    return rows[:limit]


class FormIn(BaseModel):
    parameters: dict[str, Any] = {}
    # which parameters the user set (others take defaults)
    touched: Optional[list[str]] = None
    with_options: bool = True


def resolve_form(action: dict, raw: dict, user: dict, touched: Optional[set[str]] = None, with_options: bool = True) -> dict:
    """Parameter states (visible, disabled, required, value, options) after defaults and overrides, section states
    and the submission criteria — what an action form shows."""
    values: dict[str, Any] = {}
    states = []
    errors: dict[str, str] = {}
    for p in action.get("parameters") or []:
        st = {"id": p["id"], "visible": p.get("visibility") != "hidden", "disabled": p.get("visibility") == "disabled",
              "required": bool(p.get("required")), "allowed": p.get("allowed")}
        default_cfg = p.get("default")
        for block in p.get("overrides") or []:
            if all(_test(c, values, user) for c in block.get("conditions") or []):
                then = block.get("then") or {}
                if "visibility" in then:
                    st["visible"], st["disabled"] = then["visibility"] != "hidden", then["visibility"] == "disabled"
                if "required" in then:
                    st["required"] = bool(then["required"])
                if "default" in then:
                    default_cfg = then["default"]
                if "allowed" in then:
                    st["allowed"] = then["allowed"]
                st["override"] = block.get("name") or True
                break
        given = p["id"] in raw and (touched is None or p["id"] in touched or raw.get(p["id"]) not in (None, "", []))
        source = raw.get(p["id"]) if given else _default({**p, "default": default_cfg}, values, user)
        try:
            v = _norm(p, source, action)
        except HTTPException as e:
            v = None
            errors[p["id"]] = str(e.detail)
        allowed = st.get("allowed") or {}
        if allowed.get("kind") == "values" and v not in (None, []):
            opts = [str(x) for x in allowed.get("values") or []]
            for x in (v if isinstance(v, list) else [v]):
                if str(x) not in opts:
                    errors[p["id"]] = f"{p.get('display_name') or p['id']}: {x!r} is not an allowed value"
        values[p["id"]] = v
        st["value"] = [_wire(x) for x in v] if isinstance(v, list) else _wire(v)
        if with_options:
            if allowed.get("kind") == "values":
                st["options"] = [{"value": x, "label": str(x)} for x in allowed.get("values") or []]
            elif allowed.get("kind") == "object_set_property":
                ot = ontology._object_type(allowed["object_type_id"])
                rows = [o.get("properties", {}).get(allowed["property"]) for o in ontology._objects(ot["id"]).values()]
                distinct = sorted({str(x) for x in rows if x not in (None, "")})[:OPTIONS_LIMIT]
                st["options"] = [{"value": x, "label": x} for x in distinct]
            if p.get("type") == "object" and (p.get("object_filter") or p.get("object_type_id")):
                try:
                    st["options"] = [{"value": r["primary_key"], "label": r["title"], "object_type_id": r["object_type_id"]} for r in _object_options(p, values)]
                except HTTPException:
                    st["options"] = []
        if st["required"] and st["visible"] and _empty(v) and p["id"] not in errors:
            st["missing"] = True
        states.append(st)
    sections = []
    for s in action.get("sections") or []:
        hidden = bool(s.get("hidden"))
        for block in s.get("overrides") or []:
            if all(_test(c, values, user) for c in block.get("conditions") or []):
                hidden = bool((block.get("then") or {}).get("hidden", hidden))
                break
        sections.append({"id": s.get("id"), "title": s.get("title"), "description": s.get("description"), "columns": s.get("columns", 1),
                         "collapsible": bool(s.get("collapsible")), "collapsed": bool(s.get("collapsed")), "hidden": hidden, "parameters": s.get("parameters") or []})
    failures = criteria_failures(action, values, user)
    return {"parameters": states, "sections": sections, "errors": errors, "criteria": {"passed": not failures, "failures": failures},
            "values": values}


def _wire(v: Any) -> Any:
    if isinstance(v, dict) and "primary_key" in v and "properties" in v:
        return {"object_type_id": v["object_type_id"], "primary_key": v["primary_key"], "title": v["title"]}
    return v


# ------------------------------------------------------------------------------------------------
# rules → edits
# ------------------------------------------------------------------------------------------------


class _Ctx:
    def __init__(self, action: dict, values: dict, user: dict) -> None:
        self.action, self.values, self.user = action, values, user
        self.now = _now()
        self.writeback: dict = {}
        self.schedule_run: Optional[str] = None
        self.created: dict[int, str] = {}
        self.edits: dict[tuple[str, str], dict] = {}
        self.order: list[tuple[str, str]] = []
        self.links: list[dict] = []
        self.webhooks: list[dict] = []
        # function rule results, computed before the edits are compiled under the ontology lock
        self.function_results: dict[int, dict] = {}
        # scenarios merged by apply_scenario rules
        self.scenarios: list[str] = []

    def value(self, ref: dict) -> Any:
        k = ref.get("kind")
        if k == "parameter":
            return self.values.get(ref.get("parameter"))
        if k == "object_property":
            return _field(self.values.get(ref.get("parameter")), ref.get("property"))
        if k == "static":
            return ref.get("value")
        if k == "current_user":
            return self.user.get("id")
        if k == "current_time":
            return self.now
        if k == "writeback_response":
            return self.writeback.get(ref.get("field")) if ref.get("field") else self.writeback
        if k == "schedule_run":
            return self.schedule_run
        if k == "new_object":
            return self.created.get(int(ref.get("rule") or 0))
        return None

    def add(self, op: str, type_id: str, pk: str, props: Optional[dict] = None) -> None:
        key = (type_id, pk)
        cur = self.edits.get(key)
        if cur is None:
            self.edits[key] = {"op": op, "object_type_id": type_id, "primary_key": pk, "properties": dict(props or {})}
            self.order.append(key)
            return
        if cur["op"] == "delete":
            raise ActionFailure(400, f"{pk} is deleted by this action and cannot be edited again", "invalid_parameter")
        if op == "create":
            raise ActionFailure(400, f"{pk} cannot be created twice in one submission", "invalid_parameter")
        if op == "delete":
            raise ActionFailure(400, f"{pk} cannot be deleted after it is created or modified in the same submission", "invalid_parameter")
        cur["properties"].update(props or {})


def _props(t: dict, mapping: dict, ctx: _Ctx, skip_pk: bool = False, current: Optional[dict] = None) -> dict:
    by = {p["api_name"]: p for p in t["properties"]}
    out = {}
    for prop, ref in (mapping or {}).items():
        if prop not in by and "." in prop:
            # a struct field mapped to an interface property: merged into the struct (the object's current value kept)
            sp, sf = prop.split(".", 1)
            fld = next((f for f in (by.get(sp) or {}).get("struct_fields") or [] if f["api_name"] == sf), None)
            if not fld:
                raise ActionFailure(400, f"{t['display_name']} has no struct field {prop}", "invalid_parameter")
            base = out.get(sp) or dict(((current or {}).get("properties") or {}).get(sp) or {})
            try:
                base[sf] = ontology._coerce(fld["type"], _field(ctx.value(ref), None), prop)
            except HTTPException as e:
                raise ActionFailure(400, str(e.detail), "invalid_parameter") from None
            out[sp] = base
            continue
        if skip_pk and prop == t["primary_key"]:
            raise ActionFailure(400, f"actions cannot modify the primary key {prop}", "invalid_parameter")
        raw = ctx.value(ref)
        raw = _field(raw, None) if isinstance(raw, (dict, list)) and by[prop]["type"] not in ("struct", "geoshape", "vector") else raw
        try:
            out[prop] = ontology.coerce_property(by[prop], raw, by[prop]["display_name"])
        except HTTPException as e:
            raise ActionFailure(400, str(e.detail), "invalid_parameter") from None
    return out


def _objects_of(v: Any) -> list[dict]:
    return [x for x in (v if isinstance(v, list) else [v]) if isinstance(x, dict) and "primary_key" in x]


def _create(t: dict, pk_ref: Optional[dict], props: dict, ctx: _Ctx, rule_index: int) -> str:
    pk = props.get(t["primary_key"])
    if pk_ref and pk in (None, ""):
        pk = _field(ctx.value(pk_ref), None)
    if pk in (None, ""):
        if not t.get("generate_primary_key") or ontology._ptype(t, t["primary_key"]) != "string":
            raise ActionFailure(400, f"{t['primary_key']} (the primary key of {t['display_name']}) is required", "invalid_parameter")
        pk = str(uuid.uuid4())
    props[t["primary_key"]] = pk
    missing = [x["display_name"] for x in t["properties"] if x.get("required") and not x.get("derived") and x["api_name"] != t["primary_key"]
               and ontology._empty(x, props.get(x["api_name"]))]
    if missing:
        raise ActionFailure(400, f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} required on every {t['display_name']}", "invalid_parameter")
    if str(pk) in ontology._objects(t["id"]):
        raise ActionFailure(409, f'{t["display_name"]} "{pk}" already exists', "conflict")
    ctx.add("create", t["id"], str(pk), props)
    ctx.created[rule_index] = str(pk)
    return str(pk)


def _impl(t: dict, iface_id: str) -> dict:
    for imp in t.get("implements") or []:
        if imp["interface_id"] == iface_id or iface_id in {a["id"] for a in om._ancestors({"extends": [imp["interface_id"]]})}:
            if imp.get("actions_disabled"):
                raise ActionFailure(403, f"interface actions are disabled for {t['display_name']}", "authentication")
            return imp
    raise ActionFailure(400, f"{t['display_name']} does not implement the interface", "invalid_parameter")


def compile_rules(action: dict, values: dict, ctx: _Ctx, raw: dict) -> None:
    """Run the Ontology rules into ctx.edits / ctx.links (nothing written)."""
    if action.get("kind") != "rules":
        with _lock:
            edits = ontology.action_edits({**action, "kind": action["kind"]}, raw)
        for e in edits:
            ctx.add(e["op"], e["object_type_id"], str(e["primary_key"]), e.get("properties"))
        return
    for i, r in enumerate(action.get("rules") or []):
        k = r["kind"]
        if k == "create_object":
            t = ontology._object_type(r["object_type_id"])
            pk = _create(t, r.get("primary_key"), _props(t, r.get("properties") or {}, ctx), ctx, i)
            for ln in r.get("links") or []:
                for target in _objects_of(ctx.value(ln["target"])) or [{"primary_key": _field(ctx.value(ln["target"]), None)}]:
                    lt = _get("link-types", ln["link_type_id"], "link type")
                    src_is_new = lt["source"]["object_type_id"] == t["id"]
                    ctx.links.append({"op": "add", "link_type_id": lt["id"], "source": pk if src_is_new else target["primary_key"],
                                      "target": target["primary_key"] if src_is_new else pk})
        elif k in ("modify_object", "delete_object", "create_or_modify_object"):
            t = ontology._object_type(r["object_type_id"])
            objs = _objects_of(values.get(r.get("object_param")))
            if k == "create_or_modify_object" and not objs:
                _create(t, r.get("primary_key"), _props(t, r.get("properties") or {}, ctx), ctx, i)
                continue
            if not objs:
                raise ActionFailure(400, f"{r.get('object_param')} is required", "invalid_parameter")
            for o in objs:
                if o["object_type_id"] != t["id"]:
                    raise ActionFailure(400, f"{o['title']} is not a {t['display_name']}", "invalid_parameter")
                if k == "delete_object":
                    ctx.add("delete", t["id"], o["primary_key"])
                else:
                    ctx.add("modify", t["id"], o["primary_key"], _props(t, r.get("properties") or {}, ctx, skip_pk=True))
        elif k in LINK_RULES:
            srcs = _objects_of(ctx.value(r["source"])) or [{"primary_key": _field(ctx.value(r["source"]), None)}]
            tgts = _objects_of(ctx.value(r["target"])) or [{"primary_key": _field(ctx.value(r["target"]), None)}]
            for s in srcs:
                for tg in tgts:
                    if s["primary_key"] in (None, "") or tg["primary_key"] in (None, ""):
                        raise ActionFailure(400, "both ends of the link are required", "invalid_parameter")
                    ctx.links.append({"op": "add" if k == "create_link" else "remove", "link_type_id": r["link_type_id"],
                                      "source": str(s["primary_key"]), "target": str(tg["primary_key"])})
        elif k == "create_interface_object":
            t = ontology._object_type(values.get(r["object_type_param"]) or "")
            imp = _impl(t, r["interface_id"])
            mapping = imp.get("mapping") or {}
            local = {}
            for iprop, ref in (r.get("properties") or {}).items():
                if iprop not in mapping:
                    continue
                local[mapping[iprop]] = ref
            props = _props(t, local, ctx)
            if t["primary_key"] not in props:
                raise ActionFailure(400, f"{t['display_name']}'s primary key is not mapped to an interface property in this rule", "invalid_parameter")
            _create(t, None, props, ctx, i)
        elif k in ("modify_interface_object", "delete_interface_object"):
            for o in _objects_of(values.get(r["interface_param"])):
                t = ontology._object_type(o["object_type_id"])
                imp = _impl(t, r["interface_id"])
                if k == "delete_interface_object":
                    ctx.add("delete", t["id"], o["primary_key"])
                    continue
                mapping = imp.get("mapping") or {}
                local = {mapping[ip]: ref for ip, ref in (r.get("properties") or {}).items() if ip in mapping}
                cur = ontology._objects(t["id"]).get(str(o["primary_key"]))
                ctx.add("modify", t["id"], o["primary_key"], _props(t, local, ctx, skip_pk=True, current=cur))
        elif k in ("create_interface_link", "delete_interface_link"):
            for s in _objects_of(ctx.value(r["source"])):
                t = ontology._object_type(s["object_type_id"])
                imp = _impl(t, r["interface_id"])
                lt_id = (imp.get("links") or {}).get(r["link_constraint"])
                if not lt_id:
                    raise ActionFailure(400, f"{t['display_name']} has no link type for {r['link_constraint']}", "invalid_parameter")
                lt = _get("link-types", lt_id, "link type")
                for tg in _objects_of(ctx.value(r["target"])) or [{"primary_key": _field(ctx.value(r["target"]), None)}]:
                    src_side = lt["source"]["object_type_id"] == t["id"]
                    if lt["kind"] == "join_table":
                        ctx.links.append({"op": "add" if k == "create_interface_link" else "remove", "link_type_id": lt_id,
                                          "source": s["primary_key"] if src_side else str(tg["primary_key"]),
                                          "target": str(tg["primary_key"]) if src_side else s["primary_key"]})
                    elif lt["kind"] == "foreign_key":
                        holder_type, holder, value = (t["id"], s["primary_key"], tg["primary_key"]) if src_side else (lt["source"]["object_type_id"], str(tg["primary_key"]), s["primary_key"])
                        ctx.add("modify", holder_type, holder, {lt["foreign_key"]: None if k == "delete_interface_link" else value})
        elif k == "apply_scenario":
            if ontology.SCENARIO.get():
                raise ActionFailure(400, "a scenario cannot be merged from inside a scenario", "invalid_parameter")
            hook = ontology.MODEL_HOOKS.get("scenario_merge_edits")
            if not hook:
                raise ActionFailure(500, "scenarios are not available", "unclassified")
            sid = _field(values.get(r["scenario_param"]), None)
            try:
                edits, links = hook(sid, r.get("object_type_ids") or [], r.get("link_type_ids") or [])
            except HTTPException as e:
                raise ActionFailure(e.status_code, str(e.detail), "conflict" if e.status_code == 409 else "invalid_parameter") from None
            for e in edits:
                ctx.add(e["op"], e["object_type_id"], e["primary_key"], e.get("properties"))
            ctx.links.extend(links)
            ctx.scenarios.append(sid)
        elif k == "function":
            res = ctx.function_results.get(i) or _run_function_rule(action, r, ctx)
            if not res.get("ok"):
                raise ActionFailure(400, res.get("error") or "the function failed", "user_facing_function" if res.get("user_facing") else "function")
            declared = set(res.get("declared_types") or [])
            for e in res.get("edits") or []:
                if e.get("kind") == "link":
                    ctx.links.append({"op": e["op"], "link_type_id": e["link_type_id"], "source": str(e["source"]), "target": str(e["target"])})
                    continue
                if declared and e["object_type_id"] not in declared:
                    raise ActionFailure(400, f"the function edited {e['object_type_id']}, which it does not declare in edits=[...]", "function")
                ctx.add(e["op"], e["object_type_id"], str(e["primary_key"]), e.get("properties"))


def _function_inputs(r: dict, ctx: _Ctx) -> dict:
    """A function rule's inputs for one request (for a batched function: one entry of its list input)."""
    inputs = {}
    for name, ref in (r.get("inputs") or {}).items():
        v = ctx.value(ref)
        inputs[name] = [_wire(x) for x in v] if isinstance(v, list) else _wire(v)
    return inputs


def _call_function(action: dict, r: dict, entries: list[dict]) -> dict:
    run = ontology.MODEL_HOOKS.get("run_function")
    if not run:
        raise ActionFailure(500, "functions are not available", "function")
    inputs = {r.get("batch_input") or "batch": entries} if r.get("batched") else entries[0]
    return run(r["function_id"], r.get("version"), inputs, {"batched": bool(r.get("batched")), "resource": f"action:{action['id']}"})


def _run_function_rule(action: dict, r: dict, ctx: _Ctx) -> dict:
    """Call a function rule's Ontology edit function (outside the ontology lock: it reads through the API). A batched
    function gets a list with this request's single entry."""
    return _call_function(action, r, [_function_inputs(r, ctx)])


def _check_limits(ctx: _Ctx) -> None:
    if len(ctx.edits) + len(ctx.links) > LIMITS["objects"]:
        raise ActionFailure(400, f"an action edits at most {LIMITS['objects']:,} objects", "scale_limit")
    if len({k[0] for k in ctx.edits}) > LIMITS["object_types"]:
        raise ActionFailure(400, f"an action edits at most {LIMITS['object_types']} object types", "scale_limit")


def _check_authorizations(action: dict, values: dict, ctx: _Ctx) -> None:
    a = action.get("authorizations") or {}
    read = set(a.get("read_markings") or [])
    if read:
        for v in values.values():
            for o in _objects_of(v):
                need = auth.effective_markings(f"object_type:{o['object_type_id']}")
                if need - read:
                    raise ActionFailure(403, f"{o['title']} is above this action's read authorization", "authentication")
    write = set(a.get("write_markings") or [])
    if write:
        for type_id, _ in ctx.edits:
            have = auth.effective_markings(f"object_type:{type_id}")
            if write - have:
                t = _read(_path("object-types", type_id)) or {}
                raise ActionFailure(403, f"{t.get('display_name', type_id)} is below this action's write authorization", "authentication")
    for type_id, _ in ctx.edits:
        t = _read(_path("object-types", type_id)) or {}
        if t.get("require_action_log") and not ((action.get("capabilities") or {}).get("action_log") or {}).get("enabled"):
            raise ActionFailure(400, f"Action Log required but not enabled: {t.get('display_name')} only accepts action types with action logs", "invalid_parameter")


def _can_apply(action: dict, user: dict) -> None:
    who = (action.get("permissions") or {}).get("apply") or []
    if who and not auth.enabled():
        return
    if who:
        mine = {"everyone", f"user:{user.get('id')}"} | {f"group:{g}" for g in user.get("groups") or []}
        if user.get("role") != "admin" and not mine & set(who):
            raise ActionFailure(403, "You are not allowed to apply this action", "authentication")
    oid = action.get("ontology_id")
    if action.get("object_type_id"):
        t = _read(_path("object-types", action["object_type_id"])) or {}
        oid = t.get("ontology_id")
    if om.role_of(oid) is None:
        raise ActionFailure(403, "You have no role on this ontology", "authentication")


# ------------------------------------------------------------------------------------------------
# side effects
# ------------------------------------------------------------------------------------------------

HANDLEBAR = re.compile(r"\{\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}\}")


def _render(text: str, ctx: _Ctx, recipient: Optional[dict] = None) -> str:
    def sub(m: re.Match) -> str:
        path = m.group(1).split(".")
        head = path[0]
        if head in ("currentUser", "current_user"):
            v: Any = ctx.user.get(path[1] if len(path) > 1 else "username") or ctx.user.get("id")
        elif head == "recipient":
            v = (recipient or {}).get(path[1] if len(path) > 1 else "display_name") or (recipient or {}).get("username")
        elif head in ctx.values:
            v = ctx.values[head]
            if len(path) > 1:
                v = _field(v, path[1])
            elif isinstance(v, list):
                v = [x["title"] if isinstance(x, dict) and "title" in x else x for x in v]
            elif isinstance(v, dict) and "title" in v:
                v = v["title"]
        else:
            return m.group(0)
        if isinstance(v, list):
            v = ", ".join(str(_wire(x).get("title") if isinstance(x, dict) else x) for x in v)
        return "" if v is None else str(v)

    return HANDLEBAR.sub(sub, text or "")


def _recipients(rule: dict, ctx: _Ctx) -> list[str]:
    ids: list[str] = []
    groups = {g["id"]: g for g in auth._groups()} if auth.enabled() else {}
    for rc in rule.get("recipients") or []:
        k = rc.get("kind")
        vals: list[Any] = []
        if k == "static":
            vals = list(rc.get("users") or []) + [f"group:{g}" for g in rc.get("groups") or []]
        elif k == "parameter":
            v = ctx.values.get(rc.get("parameter"))
            vals = v if isinstance(v, list) else [v]
        elif k == "object_property":
            v = _field(ctx.values.get(rc.get("parameter")), rc.get("property"))
            for x in v if isinstance(v, list) else [v]:
                vals.extend(x if isinstance(x, list) else [x])
        elif k == "current_user":
            vals = [ctx.user.get("id")]
        for v in vals:
            if v in (None, ""):
                continue
            v = str(v)
            gid = v[6:] if v.startswith("group:") else v if v in groups else None
            if gid and gid in groups:
                ids.extend(sorted(auth.group_members(groups[gid])))
            else:
                ids.append(v)
    out = list(dict.fromkeys(ids))
    if len(out) > LIMITS["recipients"]:
        raise ActionFailure(400, f"a notification goes to at most {LIMITS['recipients']} recipients", "side_effect")
    return out


def _can_view(user_id: str, ctx: _Ctx) -> bool:
    if not auth.enabled():
        return True
    principal = auth.principal_of(user_id)
    if not principal:
        return False
    have = principal.get("markings") or set()
    for v in ctx.values.values():
        for o in _objects_of(v):
            if auth.effective_markings(f"object_type:{o['object_type_id']}") - set(have):
                return False
    return True


def _notification_function(action: dict, fn: dict, ctx: _Ctx) -> Any:
    """A function-backed notification: the function returns the content (a Notification) or the recipients."""
    inputs = {}
    for name, ref in (fn.get("inputs") or {}).items():
        v = ctx.value(ref)
        inputs[name] = [_wire(x) for x in v] if isinstance(v, list) else _wire(v)
    run = ontology.MODEL_HOOKS.get("run_function")
    if not run:
        raise ActionFailure(500, "functions are not available", "side_effect")
    res = run(fn["function_id"], fn.get("version"), inputs, {"resource": f"action:{action['id']}"})
    if not res.get("ok"):
        raise ActionFailure(400, f"the notification function failed: {res.get('error')}", "side_effect")
    return res.get("value")


def _principals(value: Any) -> list[str]:
    """User IDs from a recipients function's output (Principals, user / group IDs; groups expand to members)."""
    groups = {g["id"]: g for g in auth._groups()} if auth.enabled() else {}
    out: list[str] = []
    for x in value if isinstance(value, list) else [value]:
        if x in (None, ""):
            continue
        pid, kind = (x.get("id"), x.get("kind", "user")) if isinstance(x, dict) else (str(x), "group" if str(x).startswith("group:") else "user")
        pid = str(pid)[6:] if str(pid).startswith("group:") else str(pid)
        if kind == "group" or pid in groups:
            out.extend(sorted(auth.group_members(groups[pid])) if pid in groups else [])
        else:
            out.append(pid)
    return out


def _notifications(action: dict, ctx: _Ctx, applied: list[dict]) -> list[dict]:
    """Render and deliver the notification rules (recipients' access checked first)."""
    out = []
    policy = (action.get("permissions") or {}).get("notification_permissions") or "all"
    for r in action.get("rules") or []:
        if r.get("kind") != "notification":
            continue
        users = _recipients(r, ctx) if r.get("recipients") else []
        if r.get("recipients_function"):
            users = list(dict.fromkeys(users + _principals(_notification_function(action, r["recipients_function"], ctx))))
        content = _notification_function(action, r["content_function"], ctx) if r.get("content_function") else None
        if content is not None and not isinstance(content, dict):
            raise ActionFailure(400, "the notification function must return a Notification", "side_effect")
        allowed = [u for u in users if _can_view(u, ctx)]
        if policy == "all" and len(allowed) != len(users):
            raise ActionFailure(403, "some notification recipients cannot view the objects in this action", "side_effect")
        link = None
        ln = r.get("link") or {}
        if ln.get("kind") == "object_param":
            o = next(iter(_objects_of(ctx.values.get(ln.get("parameter")))), None)
            if o:
                link = f"/ontology/objects/{o['object_type_id']}/{o['primary_key']}"
        elif ln.get("kind") == "new_object":
            created = [e for e in applied if e.get("op") == "create"]
            if created:
                link = f"/ontology/objects/{created[0]['object_type_id']}/{created[0]['primary_key']}"
        elif ln.get("kind") == "url":
            link = _render(ln.get("url") or "", ctx)
        for uid in allowed:
            label = auth.user_label(uid) if auth.enabled() else {"id": uid, "username": uid}
            rec = label or {"username": uid}
            if content is not None:
                short = content.get("platform_notification") or {}
                email = content.get("email_notification") or {}
                subject = str(short.get("heading") or email.get("subject") or action["display_name"])[: LIMITS["subject"]]
                body = str(short.get("content") or email.get("body") or "")
                if short.get("links") and not link:
                    first = short["links"][0]
                    link = first.get("url") if isinstance(first, dict) else str(first)
            else:
                subject = _render(r.get("subject") or action["display_name"], ctx, rec)[: LIMITS["subject"]]
                body = _render(r.get("body") or "", ctx, rec)
            if len(body) > LIMITS["body"]:
                body = body[: LIMITS["body"] - 3] + "..."
            note = {"id": _new_id("ntf"), "at": _now(), "subject": subject, "body": body, "link": link, "link_label": ln.get("label") or "Open",
                    "action_type_id": action["id"], "from": ctx.user.get("username"), "read": False}
            _deliver(uid, note, r, ctx, rec)
            out.append({"user": uid, "id": note["id"]})
    return out


_notes_lock = threading.Lock()


def _deliver(user_id: str, note: dict, rule: dict, ctx: _Ctx, recipient: dict) -> None:
    with _notes_lock:
        path = ontology.DIR / "notifications" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', user_id)}.json"
        rows = _read(path, []) or []
        rows.append(note)
        _write(path, rows[-300:])
    try:
        import mailer

        email = None
        if auth.enabled():
            u = auth._user(user_id)
            prefs = (u.get("attributes") or {}).get("notification_email")
            email = u.get("email") if prefs not in (["off"], "off") else None
        if email and mailer.configured():
            html = _render(rule.get("email_html"), ctx, recipient)[: LIMITS["html"]] if rule.get("email_html") else \
                mailer.html_message(note["subject"], [note["body"]], (note["link_label"], auth.web_url() + note["link"]) if note.get("link") else None)
            threading.Thread(target=mailer.send, args=(email, note["subject"], note["body"], html), daemon=True).start()
    except Exception:  # noqa: BLE001 - a failed email never fails the action
        pass


def _webhook(rule: dict, ctx: _Ctx) -> dict:
    import webhooks

    inputs = {}
    for name, ref in (rule.get("inputs") or {}).items():
        v = ctx.value(ref)
        inputs[name] = _field(v, None) if isinstance(v, dict) and "primary_key" in v else [_field(x, None) for x in v] if isinstance(v, list) else v
    payloads = inputs.pop("__payloads__", None)
    results = []
    for inp in payloads if isinstance(payloads, list) else [inputs]:
        res = webhooks.execute(rule["webhook_id"], inp)
        results.append(res)
    return results[0] if len(results) == 1 else {"status": "succeeded" if all(r.get("status") == "succeeded" for r in results) else "failed", "runs": results}


def _schedule(rule: dict, ctx: _Ctx) -> Optional[str]:
    import pipeline_schedules

    res = pipeline_schedules.run_now(rule["pipeline_id"], rule["schedule_id"], pipeline_schedules.RunNow())
    builds = res.get("builds") or res.get("build_ids") or []
    rid = res.get("run_id") or (builds[0].get("id") if builds and isinstance(builds[0], dict) else builds[0] if builds else None)
    return f"ri.schedules.main.run.{rid or uuid.uuid4().hex[:12]}"


# ------------------------------------------------------------------------------------------------
# runs: log, metrics, monitors, reverts
# ------------------------------------------------------------------------------------------------

_runs_lock = threading.Lock()


def _runs_path(action_id: str):
    return ontology.DIR / "action-runs" / f"{action_id}.json"


def _runs(action_id: str) -> dict:
    return _read(_runs_path(action_id), None) or {"runs": [], "alerts": []}


def _save_runs(action_id: str, data: dict) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RUNS_KEPT_DAYS)).isoformat()
    data["runs"] = [r for r in data["runs"] if r["at"] >= cutoff][-2000:]
    data["alerts"] = data.get("alerts", [])[-200:]
    _write(_runs_path(action_id), data)


def _record(action: dict, run: dict) -> None:
    with _runs_lock:
        data = _runs(action["id"])
        data["runs"].append(run)
        _monitor(action, data)
        _save_runs(action["id"], data)


def _p95(xs: list[float]) -> Optional[float]:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]


def _monitor(action: dict, data: dict) -> None:
    now = datetime.now(timezone.utc)
    for m in action.get("monitors") or []:
        window = now - timedelta(minutes=int(m.get("window_minutes") or 60))
        recent = [r for r in data["runs"] if r["at"] >= window.isoformat()]
        if m.get("kind") == "p95_ms":
            v = _p95([r["ms"] for r in recent if r["status"] == "succeeded"])
            fired = v is not None and v > float(m.get("threshold") or 0)
        else:
            v = sum(1 for r in recent if r["status"] == "failed")
            fired = v > int(m.get("threshold") or 0)
        last = next((a for a in reversed(data["alerts"]) if a["monitor"] == m.get("kind")), None)
        if fired and (not last or last.get("resolved_at")):
            data["alerts"].append({"id": _new_id("alr"), "monitor": m.get("kind"), "value": v, "threshold": m.get("threshold"), "at": now.isoformat(), "resolved_at": None})
        elif not fired and last and not last.get("resolved_at"):
            last["resolved_at"] = now.isoformat()


def _log_object(action: dict, run: dict, values: dict) -> None:
    """The action log: one object per successful submission in the action's log object type."""
    cfg = (action.get("capabilities") or {}).get("action_log") or {}
    if not cfg.get("enabled") or not cfg.get("object_type_id") or ontology.SCENARIO.get():
        # action logs record what happened on main; scenario edits keep their own list
        return
    t = _read(_path("object-types", cfg["object_type_id"]))
    if not t:
        return
    ctx = _Ctx(action, values, {"username": run["user"], "id": run["user"]})
    props = {"actionRid": run["rid"], "actionTypeRid": action["id"], "actionTypeVersion": int(action.get("version") or 1), "timestamp": run["at"],
             "user": run["user"], "editedObjects": [f"{e['object_type_id']}:{e['primary_key']}" for e in run["edited"]],
             "summary": _render(cfg.get("summary") or "", ctx)[:1000], "reverted": False}
    names = {p["api_name"] for p in t["properties"]}
    if cfg.get("log_parameters", True):
        for pid, v in values.items():
            key = f"param_{pid}"
            if key in names:
                w = _field(v, None)
                props[key] = json.dumps(w) if isinstance(w, (list, dict)) else w
    for lp in cfg.get("log_properties") or []:
        key = f"{lp['parameter']}_{lp['property']}"
        if key in names:
            props[key] = _field(values.get(lp["parameter"]), lp["property"])
    props = {k: v for k, v in props.items() if k in names}
    objs = ontology._objects(t["id"])
    objs[run["rid"]] = {"properties": props, "created_at": run["at"], "updated_at": run["at"]}
    ontology.save_objects(t["id"], objs, [run["rid"]])


def _apply_links(links: list[dict]) -> list[dict]:
    sid = ontology.SCENARIO.get()
    if sid and "scenario_link_write" in ontology.MODEL_HOOKS:
        return ontology.MODEL_HOOKS["scenario_link_write"](sid, links)
    done = []
    for ln in links:
        path = ontology.DIR / "links" / f"{ln['link_type_id']}.json"
        pairs = [tuple(map(str, p)) for p in _read(path, []) or []]
        pair = (str(ln["source"]), str(ln["target"]))
        if ln["op"] == "add" and pair not in pairs:
            pairs.append(pair)
            done.append(ln)
        elif ln["op"] == "remove" and pair in pairs:
            pairs.remove(pair)
            done.append(ln)
        _write(path, [list(p) for p in pairs])
    if done:
        # join table links changed (Peer Manager sends them at once)
        ontology._hook("links", sorted({ln["link_type_id"] for ln in done}))
        # dataset-backed join tables keep users' link edits apart (ontology_link_datasets.py)
        for lt_id in sorted({ln["link_type_id"] for ln in done}):
            ontology._hook("link_edits", lt_id, [ln for ln in done if ln["link_type_id"] == lt_id])
    return done


def _fingerprint(obj: Optional[dict]) -> Optional[str]:
    """An object's state (any later edit changes it, even within the same second)."""
    if obj is None:
        return None
    import hashlib

    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def execute(action: dict, raw: dict, mode: Literal["apply", "validate"] = "apply", source: Optional[str] = None, depth: int = 0,
            user: Optional[dict] = None, preset: Optional[dict[int, dict]] = None) -> dict:
    """Apply (or test run) an action with raw parameter values. `preset`: function rule results already computed
    (batched execution), by rule index; those functions are not called again."""
    started = time.monotonic()
    user = user or _user()
    rid = f"ri.actions.main.action.{uuid.uuid4().hex[:16]}"
    run: dict[str, Any] = {"rid": rid, "at": _now(), "user": user.get("id") or user.get("username"), "status": "failed", "category": None,
                           "error": None, "ms": 0, "edited": [], "links": [], "version": int(action.get("version") or 1)}
    try:
        _can_apply(action, user)
        known = _params(action)
        unknown = [k for k in raw if k not in known]
        if unknown and action.get("kind") == "rules":
            raise ActionFailure(400, f"unknown parameter {unknown[0]}", "invalid_parameter")
        with _lock:
            form = resolve_form(action, raw, user, None, with_options=False)
        if form["errors"]:
            raise ActionFailure(400, next(iter(form["errors"].values())), "invalid_parameter")
        missing = [s["id"] for s in form["parameters"] if s.get("missing")]
        if missing:
            p = known[missing[0]]
            raise ActionFailure(400, f"{p.get('display_name') or p['id']} is required", "invalid_parameter")
        values = form["values"]
        if not form["criteria"]["passed"]:
            raise ActionFailure(403, form["criteria"]["failures"][0], "authentication")
        ctx = _Ctx(action, values, user)
        rules = action.get("rules") or []
        result: dict[str, Any] = {"action_rid": rid, "mode": mode}
        if mode == "apply":
            for r in rules:
                if r["kind"] == "webhook" and r.get("mode") == "writeback":
                    res = _webhook(r, ctx)
                    if res.get("status") != "succeeded":
                        raise ActionFailure(502, f"the writeback webhook failed: {res.get('error') or res.get('status')}", "side_effect")
                    ctx.writeback = res.get("outputs") or {}
                    result["writeback"] = {"status": "succeeded"}
            for r in rules:
                if r["kind"] == "schedule":
                    ctx.schedule_run = _schedule(r, ctx)
                    result["schedule_run"] = ctx.schedule_run
        for i, r in enumerate(rules):
            if r["kind"] == "function":
                result.setdefault("function_inputs", {})[i] = _function_inputs(r, ctx)
                ctx.function_results[i] = preset[i] if preset is not None and i in preset else _run_function_rule(action, r, ctx)
        with _lock:
            compile_rules(action, values, ctx, {k: v for k, v in raw.items()})
            _check_limits(ctx)
            _check_authorizations(action, values, ctx)
            edits = [ctx.edits[k] for k in ctx.order]
            if mode == "validate":
                run["ms"] = int((time.monotonic() - started) * 1000)
                return {**result, "valid": True, "criteria": form["criteria"], "edits": edits, "links": ctx.links,
                        "side_effects": [{"kind": r["kind"], "mode": r.get("mode")} for r in rules if r["kind"] in EFFECT_RULES], "ms": run["ms"]}
            import ontology_edits

            before, user_edits_before = {}, {}
            for e in edits:
                o = ontology._objects(e["object_type_id"]).get(e["primary_key"])
                before[f"{e['object_type_id']}|{e['primary_key']}"] = json.loads(json.dumps(o)) if o else None
                # the objects' user edits before the run, so a revert restores them too (not only the objects)
                user_edits_before[f"{e['object_type_id']}|{e['primary_key']}"] = ontology_edits.layer(e["object_type_id"]).get(str(e["primary_key"]))
            written = ontology.apply_edits(edits, source=source, depth=depth) if edits else []
            links_done = _apply_links(ctx.links)
            after = {f"{e['object_type_id']}|{e['primary_key']}": _fingerprint(ontology._objects(e["object_type_id"]).get(e["primary_key"])) for e in edits}
        if any(e["object_type_id"] for e in edits):
            ontology._hook("query", "action", sorted({e["object_type_id"] for e in edits}), max(1, len(edits)))
        if ctx.scenarios and "scenario_merged" in ontology.MODEL_HOOKS:
            for sid in ctx.scenarios:
                ontology.MODEL_HOOKS["scenario_merged"](sid, rid)
        run.update(status="succeeded", edited=[{"op": w["op"], "object_type_id": w["object_type_id"], "primary_key": w["primary_key"]} for w in written],
                   links=links_done, before=before, after=after, user_edits_before=user_edits_before, scenario=ontology.SCENARIO.get(),
                   revertible=(action.get("capabilities") or {}).get("revertible", True) and not ontology.SCENARIO.get(),
                   parameters={k: _wire(v) if not isinstance(v, list) else [_wire(x) for x in v] for k, v in values.items()})
        result["edits"] = written
        result["links"] = links_done
        try:
            result["notifications"] = _notifications(action, ctx, written)
        except ActionFailure as e:
            run["side_effect_error"] = e.detail
            result["notification_error"] = e.detail
        hooks = []
        for r in rules:
            if r["kind"] == "webhook" and r.get("mode") == "side_effect":
                try:
                    res = _webhook(r, ctx)
                    hooks.append({"webhook_id": r["webhook_id"], "status": res.get("status")})
                except Exception as e:  # noqa: BLE001 - side effects never fail the action
                    hooks.append({"webhook_id": r["webhook_id"], "status": "failed", "error": str(e)[:200]})
        result["webhooks"] = hooks
        run["webhooks"] = hooks
        run["notified"] = [n["user"] for n in result.get("notifications") or []]
        with _lock:
            _log_object(action, run, values)
        result["revertible"] = bool(run["revertible"]) and bool(written)
        return result
    except ActionFailure as e:
        run.update(category=e.category, error=e.detail)
        raise
    except HTTPException as e:
        run.update(category="conflict" if e.status_code == 409 else "invalid_parameter" if e.status_code == 400 else "unclassified", error=str(e.detail))
        raise
    except Exception as e:  # noqa: BLE001
        run.update(category="unclassified", error=str(e)[:500])
        raise HTTPException(500, f"the action failed: {e}") from None
    finally:
        if mode == "apply":
            run["ms"] = int((time.monotonic() - started) * 1000)
            _record(action, run)


def _edits_only(action: dict, values: dict) -> list[dict]:
    """ontology.action_edits for rule-based action types (Logic previews, derived series)."""
    user = _user()
    form = resolve_form(action, values, user, None, with_options=False)
    if form["errors"]:
        raise HTTPException(400, next(iter(form["errors"].values())))
    if not form["criteria"]["passed"]:
        raise HTTPException(403, form["criteria"]["failures"][0])
    ctx = _Ctx(action, form["values"], user)
    compile_rules(action, form["values"], ctx, values)
    return [ctx.edits[k] for k in ctx.order]


def apply_action_hook(action: dict, values: dict, source: Optional[str] = None, depth: int = 0) -> dict:
    return execute(action, values or {}, "apply", source, depth)


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


@router.post("/action-types/{action_id}/form")
def action_form(action_id: str, req: FormIn) -> dict:
    """The action form's state for the current values: parameters, sections, options and submission criteria."""
    with _lock:
        action = ontology._action_type(action_id)
        user = _user()
        out = resolve_form(action, req.parameters, user, set(req.touched) if req.touched is not None else None, req.with_options)
    out.pop("values", None)
    out["revertible"] = (action.get("capabilities") or {}).get("revertible", True)
    return out


class TestIn(BaseModel):
    parameters: dict[str, Any] = {}


@router.post("/action-types/{action_id}/test")
def test_run(action_id: str, req: TestIn) -> dict:
    """A test run: permissions, criteria and rules evaluated, the edits it would make — nothing written or sent."""
    action = ontology._action_type(action_id)
    try:
        return execute(action, req.parameters, "validate")
    except HTTPException as e:
        return {"valid": False, "error": e.detail, "category": getattr(e, "category", None)}


class BatchIn(BaseModel):
    requests: list[dict[str, Any]] = Field(min_length=1)


@router.post("/action-types/{action_id}/apply-batch")
def apply_batch(action_id: str, req: BatchIn) -> dict:
    """Apply an action many times at once (inline edits, Automate): every request is validated first, then the edits
    are written together."""
    action = ontology._action_type(action_id)
    fn = next((r for r in action.get("rules") or [] if r.get("kind") == "function"), None)
    limit = LIMITS["batch_function"] if fn and not fn.get("batched") else LIMITS["batch"]
    if len(req.requests) > limit:
        raise HTTPException(400, f"this action can be applied at most {limit:,} times in a batch")
    if fn and fn.get("batched"):
        return _apply_batched(action, req.requests)
    for r in req.requests:
        execute(action, r, "validate")
    results = [execute(action, r, "apply") for r in req.requests]
    return {"applied": len(results), "edits": sum(len(r["edits"]) for r in results), "action_rids": [r["action_rid"] for r in results]}


def _apply_batched(action: dict, requests: list[dict]) -> dict:
    """Batched execution: every request is validated (without calling the function), the function runs once with
    one list entry per request, and its edits are applied together by the first request — one atomic group for the
    edit limits. The other requests are recorded (and run their side effects) without edits of their own."""
    rules = action.get("rules") or []
    fi = next(i for i, r in enumerate(rules) if r.get("kind") == "function")
    skip = {fi: {"ok": True, "edits": []}}
    entries = [execute(action, r, "validate", preset=skip)["function_inputs"][fi] for r in requests]
    res = _call_function(action, rules[fi], entries)
    results = [execute(action, r, "apply", preset={fi: res if n == 0 else {"ok": True, "edits": []}}) for n, r in enumerate(requests)]
    return {"applied": len(results), "edits": sum(len(r["edits"]) for r in results), "action_rids": [r["action_rid"] for r in results],
            "function_calls": 1}


class InlineEditIn(BaseModel):
    object_type_id: str
    primary_key: str
    property: str
    value: Any = None


def _inline_action(t: dict, prop: str) -> tuple[dict, dict, dict]:
    p = next((x for x in t["properties"] if x["api_name"] == prop), None)
    if not p or not p.get("inline_edit_action_id"):
        raise HTTPException(400, f"{prop} has no inline edit action")
    action = ontology._action_type(p["inline_edit_action_id"])
    obj_params = [x for x in action["parameters"] if x.get("type") == "object" and (x.get("object_type_id") or action.get("object_type_id")) == t["id"]]
    if len(obj_params) != 1:
        raise HTTPException(400, "an inline edit action has exactly one object parameter of this object type")
    if any(r.get("kind") in ("notification", "webhook") and r.get("mode") != "writeback" for r in action.get("rules") or []):
        raise HTTPException(400, "inline edit actions cannot have side effect notifications or webhooks")
    if action.get("kind") == "rules":
        target = next((x for x in action["parameters"] if (x.get("default") or {}).get("kind") == "object_property"
                       and (x.get("default") or {}).get("property") == prop), None)
        if not target:
            target = next((x for r in action.get("rules") or [] if r.get("kind") == "modify_object"
                           for k, ref in (r.get("properties") or {}).items() if k == prop and ref.get("kind") == "parameter"
                           for x in action["parameters"] if x["id"] == ref.get("parameter")), None)
    else:
        target = next((x for x in action["parameters"] if x.get("property") == prop), None)
    if not target:
        raise HTTPException(400, f"the inline edit action does not write {prop}")
    return action, obj_params[0], target


@router.post("/actions/inline-edit")
def inline_edit(req: InlineEditIn) -> dict:
    """Edit one property value in place with the property's inline edit action; the other parameters take their
    defaults from the object."""
    t = ontology._object_type(req.object_type_id)
    action, obj_param, target = _inline_action(t, req.property)
    with _lock:
        obj = _obj_of(t["id"], req.primary_key)
    values: dict[str, Any] = {obj_param["id"]: req.primary_key, target["id"]: req.value}
    if action.get("kind") != "rules":
        # legacy modify actions: keep the other properties as they are
        for p in action["parameters"]:
            if p.get("property") and p["id"] not in values:
                values[p["id"]] = obj["properties"].get(p["property"])
    return execute(action, values, "apply")


@router.get("/action-types/{action_id}/metrics")
def action_metrics(action_id: str, days: int = 30) -> dict:
    """Success and failure counts (by failure category), p95 duration and runs per day over the last days."""
    action = ontology._action_type(action_id)
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, min(days, RUNS_KEPT_DAYS)))).isoformat()
    data = _runs(action_id)
    runs = [r for r in data["runs"] if r["at"] >= since]
    by_day: dict[str, dict] = {}
    for r in runs:
        d = by_day.setdefault(r["at"][:10], {"day": r["at"][:10], "succeeded": 0, "failed": 0})
        d[r["status"]] += 1
    cats: dict[str, int] = {}
    for r in runs:
        if r["status"] == "failed":
            cats[r.get("category") or "unclassified"] = cats.get(r.get("category") or "unclassified", 0) + 1
    return {"action_type_id": action["id"], "days": days, "succeeded": sum(r["status"] == "succeeded" for r in runs),
            "failed": sum(r["status"] == "failed" for r in runs), "failures_by_category": cats,
            "p95_ms": _p95([r["ms"] for r in runs if r["status"] == "succeeded"]), "by_day": sorted(by_day.values(), key=lambda d: d["day"]),
            "alerts": list(reversed(data.get("alerts") or []))[:50]}


@router.get("/action-types/{action_id}/runs")
def action_runs(action_id: str, days: int = 7) -> list[dict]:
    """Run history of the last days (newest first)."""
    ontology._action_type(action_id)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    return [{k: v for k, v in r.items() if k not in ("before", "after", "user_edits_before")} for r in reversed(_runs(action_id)["runs"]) if r["at"] >= since][:500]


@router.get("/action-types/{action_id}/log")
def action_log(action_id: str) -> dict:
    """The action log objects of an action type (successful submissions) and its configuration status."""
    action = ontology._action_type(action_id)
    cfg = (action.get("capabilities") or {}).get("action_log") or {}
    status = "disabled"
    rows: list[dict] = []
    if cfg.get("enabled"):
        t = _read(_path("object-types", cfg.get("object_type_id") or "x")) if cfg.get("object_type_id") else None
        if not t:
            status = "Associated object type is missing. Logs are not being recorded."
        else:
            status = "enabled"
            rows = [ontology._public_object(t, pk, o) for pk, o in ontology._objects(t["id"]).items()]
            rows.sort(key=lambda r: r["properties"].get("timestamp") or "", reverse=True)
    return {"status": status, "config": cfg, "objects": rows[:500]}


@router.post("/action-types/{action_id}/log/generate")
def generate_log_type(action_id: str) -> dict:
    """Generate the action log object type for an action type (required values, its parameters, and the property
    values of its single object parameters) and enable logging."""
    action = ontology._action_type(action_id)
    props = [ontology.Property(api_name="actionRid", display_name="Action RID", type="string", status="active"),
             ontology.Property(api_name="actionTypeRid", display_name="Action type RID", type="string"),
             ontology.Property(api_name="actionTypeVersion", display_name="Action type version", type="integer"),
             ontology.Property(api_name="timestamp", display_name="Timestamp", type="timestamp"),
             ontology.Property(api_name="user", display_name="User", type="string", value_formatting={"kind": "user"}),
             ontology.Property(api_name="editedObjects", display_name="Edited objects", type="string", array=True),
             ontology.Property(api_name="summary", display_name="Summary", type="string", render_hints=["long_text", "searchable"]),
             ontology.Property(api_name="reverted", display_name="Reverted", type="boolean"),
             ontology.Property(api_name="revertedBy", display_name="Reverted by", type="string"),
             ontology.Property(api_name="revertedAt", display_name="Reverted at", type="timestamp")]
    for p in action.get("parameters") or []:
        if p.get("type") in ("media",):
            continue
        props.append(ontology.Property(api_name=f"param_{p['id']}", display_name=f"Parameter: {p.get('display_name') or p['id']}", type="string"))
    t = ontology.create_object_type(ontology.ObjectTypeIn(display_name=f"{action['display_name']} Log", plural_name=f"{action['display_name']} Logs",
                                                         description=f"Action log of the {action['display_name']} action type: one object per submission.",
                                                         properties=props, primary_key="actionRid", title_property="summary", generate_primary_key=False))
    with _lock:
        a = ontology._action_type(action_id)
        caps = dict(a.get("capabilities") or {})
        caps["action_log"] = {**(caps.get("action_log") or {}), "enabled": True, "object_type_id": t["id"],
                              "summary": (caps.get("action_log") or {}).get("summary") or f"{{{{currentUser}}}} applied {a['display_name']}"}
        a["capabilities"] = caps
        _put("action-types", a)
    return {"object_type": t, "capabilities": caps}


@router.get("/actions/log-for/{type_id}/{pk}")
def log_for_object(type_id: str, pk: str) -> list[dict]:
    """Action log entries (and action runs) that edited one object — the action log timeline."""
    ontology._object_type(type_id)
    key = f"{type_id}:{pk}"
    out = []
    for a in _all("action-types"):
        for r in _runs(a["id"])["runs"]:
            if r["status"] == "succeeded" and any(f"{e['object_type_id']}:{e['primary_key']}" == key for e in r.get("edited") or []):
                out.append({"action_type_id": a["id"], "action_type": a["display_name"], "rid": r["rid"], "at": r["at"], "user": r["user"],
                            "reverted": bool(r.get("reverted_at")), "logged": bool(((a.get("capabilities") or {}).get("action_log") or {}).get("enabled"))})
    return sorted(out, key=lambda x: x["at"], reverse=True)[:100]


@router.post("/actions/runs/{rid}/revert")
def revert(rid: str) -> dict:
    """Undo an action: only its user, only if reverts are on (then and now) and no edited object changed since."""
    user = _user()
    with _lock, _runs_lock:
        for a in _all("action-types"):
            data = _runs(a["id"])
            run = next((r for r in data["runs"] if r["rid"] == rid), None)
            if not run:
                continue
            if run["status"] != "succeeded":
                raise HTTPException(400, "only successful actions can be reverted")
            if run.get("reverted_at"):
                raise HTTPException(400, "this action was already reverted")
            if run["user"] != (user.get("id") or user.get("username")):
                raise HTTPException(403, "only the user who applied an action can revert it")
            if not run.get("revertible") or not (a.get("capabilities") or {}).get("revertible", True):
                raise HTTPException(400, "reverts are turned off for this action type")
            for key, stamp in (run.get("after") or {}).items():
                tid, pk = key.split("|", 1)
                cur = ontology._objects(tid).get(pk)
                if _fingerprint(cur) != stamp:
                    raise HTTPException(409, f"{pk} changed after the action: an action can only be reverted while it is the latest edit")
            restore: dict[str, dict] = {}
            reverted: list[dict] = []
            for key, prev in (run.get("before") or {}).items():
                tid, pk = key.split("|", 1)
                objs = restore.setdefault(tid, ontology._objects(tid))
                rec = {"object_type_id": tid, "primary_key": pk, "before": ((objs.get(pk) or {}).get("properties")), "after": (prev or {}).get("properties") if prev else None}
                if key in (run.get("user_edits_before") or {}):
                    rec["user_edits"] = run["user_edits_before"][key]
                reverted.append(rec)
                if prev is None:
                    objs.pop(pk, None)
                else:
                    objs[pk] = prev
            for tid, objs in restore.items():
                ontology.save_objects(tid, objs)
            import ontology_edits

            ontology_edits.revert(reverted)
            _apply_links([{**ln, "op": "remove" if ln["op"] == "add" else "add"} for ln in reversed(run.get("links") or [])])
            run["reverted_at"] = _now()
            run["reverted_by"] = user.get("id") or user.get("username")
            _save_runs(a["id"], data)
            cfg = (a.get("capabilities") or {}).get("action_log") or {}
            if cfg.get("enabled") and cfg.get("object_type_id"):
                logs = ontology._objects(cfg["object_type_id"])
                if rid in logs:
                    logs[rid]["properties"].update(reverted=True, revertedBy=run["reverted_by"], revertedAt=run["reverted_at"])
                    ontology.save_objects(cfg["object_type_id"], logs, [rid])
            ontology._hook("edits", [{"op": "revert", "object_type_id": r["object_type_id"], "primary_key": r["primary_key"],
                                      "properties": {k: None for k in ontology_edits.changed_keys(r["before"], r["after"])}} for r in reverted])
            return {"reverted": rid, "objects": len(run.get("before") or {}), "links": len(run.get("links") or [])}
    raise HTTPException(404, "action run not found")


# ------------------------------------------------------------------------------------------------
# notifications inbox
# ------------------------------------------------------------------------------------------------


def _inbox_path():
    me = _user()
    return ontology.DIR / "notifications" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', str(me.get('id') or 'local'))}.json"


@notes_router.get("")
def my_notifications() -> dict:
    rows = list(reversed(_read(_inbox_path(), []) or []))
    return {"unread": sum(not r.get("read") for r in rows), "notifications": rows[:200]}


@notes_router.post("/{note_id}/read")
def read_note(note_id: str) -> dict:
    with _notes_lock:
        path = _inbox_path()
        rows = _read(path, []) or []
        for r in rows:
            if r["id"] == note_id or note_id == "all":
                r["read"] = True
        _write(path, rows)
    return {"ok": True}
