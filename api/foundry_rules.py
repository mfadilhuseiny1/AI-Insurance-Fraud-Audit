"""Foundry Rules, modelled on Palantir's Foundry Rules: point-and-click rules over Ontology objects and datasets.

A workflow (the workflow configuration) names the inputs rule authors may use (object types and Files datasets),
the outputs every rule writes to (an object type — alert objects — or a Files dataset), each output's fields with
their permitted and default values (column values: any, none or a selection of columns; static values: any, none, a
selection, a numeric / date range or users; required; string templates), the custom properties rules carry (e.g.
severity, assignee), the logic boards authors may use, who may edit rules, and whether changes go through
proposals.

A rule is metadata (name, description, author, status, custom properties) and logic: an input, a list of logic
blocks — filter (conditions, all / any), expression (a new column from a safe expression over columns), aggregation
(group by and count / sum / avg / min / max / distinct), join (another input, inner or left), window (partition,
order, row_number / rank / lag / lead / running sum / count), select columns, union (another input), link (the
properties of objects linked through a link type) — and the rule output: an output and how each field is filled
(a column, a static value, or a template like "{faskes}: {count} klaim"). Each block can be previewed.

Proposals: creating, editing or deleting a rule makes a proposal (old and new values, the diff of the changed
fields, author, time); a reviewer approves (the change is applied) or rejects it. Running a workflow evaluates every
active rule and replaces the outputs: alert objects in the output object type (one per output row, keyed by rule and
row) and / or the output dataset in Files. A workflow can run on a schedule.

Stale proposals: an edit or delete proposal records the rule version it was made against (base_version; the editor
sends the version it opened, and a submit against a rule that has changed since is refused). Approving a proposal
whose rule has moved on (another proposal approved, a direct save) or was deleted is refused with 409 — approving it
would silently overwrite the newer version; the reviewer rejects it and the author proposes again from the current
rule (the Foundry Rules docs describe no rebase or merge). Proposals saved before base_version was recorded: such a
proposal counts as current when the rule's name, description, status, custom properties and logic still equal the
proposal's "old" values (what it was made against), and as stale otherwise. Create proposals are never stale.
Open proposals are listed with "stale", "stale_reason" and "current_version".

Contour import: a Contour path (and the paths it starts from) becomes a draft rule's logic — filter boards, simple
aggregations and kept columns as blocks, with notes on what has no rule equivalent.

Records are JSON files under data/ontology/foundry-rules/. Mounted by server.py under /api/foundry-rules.
"""

from __future__ import annotations

import ast
import hashlib
import io
import json
import math
import operator
import re
import threading
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _lock, _now, _read

router = APIRouter(prefix="/api/foundry-rules")

BOARDS = ("filter", "expression", "aggregation", "join", "window", "select", "union", "link")
MAX_ROWS = 100_000
PREVIEW_ROWS = 50


def configure() -> None:
    for name in ("foundry-rules", "foundry-rules-rules", "foundry-rules-proposals"):
        (ontology.DIR / name).mkdir(parents=True, exist_ok=True)


def startup() -> None:
    threading.Thread(target=_scheduler, daemon=True, name="foundry-rules").start()


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


# ------------------------------------------------------------------------------------------------
# workflows
# ------------------------------------------------------------------------------------------------


class OutputField(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    type: Literal["string", "integer", "double", "boolean", "date", "timestamp"] = "string"
    required: bool = False
    column_values: Literal["any", "none", "selection"] = "any"
    columns: list[str] = []
    static_values: Literal["any", "none", "selection", "range", "users"] = "any"
    values: list[Any] = []
    min: Optional[float] = None
    max: Optional[float] = None
    template: bool = False
    default: Optional[dict] = None  # {kind: column|static|template, ...}


class WorkflowOutput(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")
    name: str
    object_type_id: Optional[str] = None  # alert objects
    dataset_name: Optional[str] = None  # a Files dataset (created on the first run)
    dataset_id: Optional[str] = None
    fields: list[OutputField] = Field(min_length=1)


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    inputs: list[dict] = Field(min_length=1)  # [{kind: object_type|dataset, id}]
    outputs: list[WorkflowOutput] = Field(min_length=1)
    custom_properties: list[dict] = []  # [{name, type, values?}]
    boards: list[str] = list(BOARDS)
    editors: list[str] = []  # user ids who may edit rules ([]: everyone)
    reviewers: list[str] = []  # user ids who may approve proposals ([]: everyone but the author)
    require_proposals: bool = True
    schedule_minutes: Optional[int] = Field(None, ge=5, le=10080)


def _check_workflow(w: dict) -> None:
    for i in w["inputs"]:
        if i.get("kind") == "object_type":
            ontology._object_type(i.get("id") or "")
        elif i.get("kind") != "dataset" or not i.get("id"):
            raise HTTPException(400, "an input is an object type or a Files dataset")
    for o in w["outputs"]:
        if o.get("object_type_id"):
            t = ontology._object_type(o["object_type_id"])
            names = {p["api_name"] for p in t["properties"]}
            missing = [f["name"] for f in o["fields"] if f["name"] not in names]
            if missing:
                raise HTTPException(400, f"{o['name']}: {t['display_name']} has no properties {', '.join(missing)}")
        elif not o.get("dataset_name") and not o.get("dataset_id"):
            raise HTTPException(400, f"{o['name']}: write to an object type or a dataset")
    bad = [b for b in w["boards"] if b not in BOARDS]
    if bad:
        raise HTTPException(400, f"unknown logic boards: {', '.join(bad)}")


def _workflow(wid: str) -> dict:
    return ontology._get("foundry-rules", wid, "workflow")


@router.get("/workflows")
def list_workflows() -> list[dict]:
    out = []
    for w in ontology._all("foundry-rules"):
        rules = [r for r in ontology._all("foundry-rules-rules") if r["workflow_id"] == w["id"]]
        props = [p for p in ontology._all("foundry-rules-proposals") if p["workflow_id"] == w["id"] and p["status"] == "open"]
        out.append({**w, "rules": len(rules), "active_rules": sum(1 for r in rules if r["status"] == "active"), "open_proposals": len(props)})
    return out


@router.post("/workflows")
def create_workflow(req: WorkflowIn) -> dict:
    w = {"id": f"frw-{uuid.uuid4().hex[:12]}", **req.model_dump(), "owner": _who(), "created_at": _now(), "last_run": None}
    _check_workflow(w)
    with _lock:
        return ontology._put("foundry-rules", w)


@router.get("/workflows/{wid}")
def get_workflow(wid: str) -> dict:
    return _workflow(wid)


@router.put("/workflows/{wid}")
def save_workflow(wid: str, req: WorkflowIn) -> dict:
    with _lock:
        w = _workflow(wid)
        if w.get("owner") not in (None, _who()) and auth.enabled():
            raise HTTPException(403, "only the workflow owner changes its configuration")
        w.update(req.model_dump())
        _check_workflow(w)
        return ontology._put("foundry-rules", w)


# ------------------------------------------------------------------------------------------------
# data
# ------------------------------------------------------------------------------------------------


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def load_input(inp: dict) -> list[dict]:
    if inp.get("kind") == "object_type":
        t = ontology._object_type(inp["id"])
        rows = [{**{k: _jsonable(v) for k, v in (o.get("properties") or {}).items() if not isinstance(v, (list, dict))}, "__pk": pk}
                for pk, o in ontology._objects(t["id"]).items() if ontology._can_see(t, o)]
    else:
        import ontology_datasources

        _, _, raw = ontology_datasources._read(inp["id"])
        rows = [{k: _jsonable(v) for k, v in r.items()} for r in raw]
    if len(rows) > MAX_ROWS:
        raise HTTPException(400, f"the input has {len(rows):,} rows; rules run on at most {MAX_ROWS:,} here")
    return rows


# ------------------------------------------------------------------------------------------------
# expressions (a safe subset of Python: columns, numbers, strings, arithmetic, comparisons, and / or / not, functions)
# ------------------------------------------------------------------------------------------------


def _date(v: Any) -> Optional[datetime]:
    if v in (None, ""):
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


FUNCS = {
    "abs": abs, "round": lambda x, n=0: round(x, int(n)) if x is not None else None, "lower": lambda s: str(s).lower() if s is not None else None,
    "upper": lambda s: str(s).upper() if s is not None else None, "len": lambda s: len(s) if s is not None else None,
    "coalesce": lambda *xs: next((x for x in xs if x not in (None, "")), None), "concat": lambda *xs: "".join("" if x is None else str(x) for x in xs),
    "contains": lambda s, sub: sub is not None and s is not None and str(sub).lower() in str(s).lower(),
    "days_between": lambda a, b: ((_date(b) - _date(a)).total_seconds() / 86400) if _date(a) and _date(b) else None,
    "if_else": lambda c, a, b: a if c else b, "number": lambda x: float(x) if x not in (None, "") else None,
    "min": lambda *xs: min((x for x in xs if x is not None), default=None), "max": lambda *xs: max((x for x in xs if x is not None), default=None),
}
BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Mod: operator.mod, ast.Pow: operator.pow}
CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge}


def compile_expr(text: str) -> ast.AST:
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as e:
        raise HTTPException(400, f"expression {text!r}: {e.msg}") from None
    for node in ast.walk(tree):
        ok = isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.Name, ast.Constant, ast.Call, ast.Load,
                               ast.And, ast.Or, ast.Not, ast.USub, ast.UAdd, ast.IfExp)) or type(node) in BIN or type(node) in CMP
        if not ok:
            raise HTTPException(400, f"expression {text!r}: {type(node).__name__} is not allowed")
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in FUNCS):
            raise HTTPException(400, f"expression {text!r}: unknown function (use {', '.join(sorted(FUNCS))})")
    return tree


def evaluate(tree: ast.AST, row: dict) -> Any:
    def ev(n: ast.AST) -> Any:
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, ast.Name):
            return {"true": True, "false": False, "null": None}.get(n.id, row.get(n.id))
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return (not v) if isinstance(n.op, ast.Not) else (None if v is None else -v if isinstance(n.op, ast.USub) else v)
        if isinstance(n, ast.BoolOp):
            vals = [ev(x) for x in n.values]
            return all(vals) if isinstance(n.op, ast.And) else any(vals)
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            if a is None or b is None:
                return None
            try:
                return BIN[type(n.op)](a, b)
            except (TypeError, ZeroDivisionError):
                return None
        if isinstance(n, ast.Compare):
            left = ev(n.left)
            for op, right in zip(n.ops, n.comparators):
                r = ev(right)
                if left is None or r is None:
                    return False
                try:
                    if not CMP[type(op)](left, r):
                        return False
                except TypeError:
                    return False
                left = r
            return True
        if isinstance(n, ast.IfExp):
            return ev(n.body) if ev(n.test) else ev(n.orelse)
        if isinstance(n, ast.Call):
            return FUNCS[n.func.id](*[ev(a) for a in n.args])
        raise HTTPException(400, "unsupported expression")
    return ev(tree)


# ------------------------------------------------------------------------------------------------
# logic blocks
# ------------------------------------------------------------------------------------------------


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _cond(row: dict, c: dict) -> bool:
    v, op, x = row.get(c.get("column")), c.get("op", "eq"), c.get("value")
    if op == "is_null":
        return v in (None, "")
    if op == "not_null":
        return v not in (None, "")
    if op == "contains":
        return x is not None and v is not None and str(x).lower() in str(v).lower()
    if op == "in":
        return str(v) in {str(y) for y in (x if isinstance(x, list) else str(x).split(","))}
    a, b = _num(v), _num(x)
    if a is not None and b is not None:
        cmp = (a > b) - (a < b)
    elif v is None:
        return False
    else:
        cmp = (str(v) > str(x)) - (str(v) < str(x))
    return {"eq": cmp == 0, "neq": cmp != 0, "gt": cmp > 0, "gte": cmp >= 0, "lt": cmp < 0, "lte": cmp <= 0}.get(op, False)


def run_block(b: dict, rows: list[dict], workflow: dict) -> list[dict]:
    k = b.get("kind")
    if k not in workflow.get("boards", BOARDS):
        raise HTTPException(400, f"the {k} board is not enabled for this workflow")
    if k == "filter":
        conds = b.get("conditions") or []
        fn = all if b.get("combine", "all") == "all" else any
        return [r for r in rows if fn(_cond(r, c) for c in conds)] if conds else rows
    if k == "expression":
        tree = compile_expr(b.get("expression") or "None")
        if b.get("as"):
            return [{**r, b["as"]: evaluate(tree, r)} for r in rows]
        return [r for r in rows if evaluate(tree, r)]
    if k == "aggregation":
        groups: dict[tuple, list[dict]] = defaultdict(list)
        by = b.get("group_by") or []
        for r in rows:
            groups[tuple(r.get(c) for c in by)].append(r)
        out = []
        for key, rs in groups.items():
            row = dict(zip(by, key))
            for a in b.get("aggregations") or [{"fn": "count", "as": "count"}]:
                vals = [r.get(a.get("column")) for r in rs]
                nums = [n for v in vals if (n := _num(v)) is not None]
                fn = a.get("fn", "count")
                row[a.get("as") or f"{fn}_{a.get('column') or ''}".rstrip("_")] = (
                    len(rs) if fn == "count" else len({str(v) for v in vals if v is not None}) if fn == "distinct"
                    else (sum(nums) if fn == "sum" else sum(nums) / len(nums) if fn == "avg" and nums else min(nums) if fn == "min" and nums
                          else max(nums) if fn == "max" and nums else None))
            out.append(row)
        return out
    if k in ("join", "union"):
        other = load_input(b.get("input") or {})
        if k == "union":
            return rows + other
        idx: dict[str, list[dict]] = defaultdict(list)
        prefix = b.get("prefix", "")
        for r in other:
            idx[str(r.get(b.get("right_on")))].append(r)
        out = []
        for r in rows:
            matches = idx.get(str(r.get(b.get("left_on"))), [])
            if not matches and b.get("how", "inner") == "left":
                out.append(r)
            for m in matches:
                out.append({**r, **{f"{prefix}{c}": v for c, v in m.items() if c != "__pk"}})
        return out
    if k == "link":
        lt = ontology._get("link-types", b.get("link_type_id", ""), "link type")
        direction = b.get("direction", "forward")
        reach = om.side_of(lt, direction)[1]
        other_t = ontology._object_type(reach["object_type_id"])
        objs = ontology._objects(other_t["id"])
        m = om.linked_map(lt, direction, {str(r.get("__pk")) for r in rows})
        prefix = b.get("prefix") or f"{reach.get('api_name') or 'linked'}_"
        out = []
        for r in rows:
            for pk in m.get(str(r.get("__pk")), []) or ([None] if b.get("how") == "left" else []):
                o = (objs.get(pk) or {}).get("properties") or {}
                out.append({**r, **{f"{prefix}{c}": _jsonable(v) for c, v in o.items() if not isinstance(v, (list, dict))}})
        return out
    if k == "window":
        parts: dict[tuple, list[dict]] = defaultdict(list)
        for r in rows:
            parts[tuple(r.get(c) for c in b.get("partition_by") or [])].append(r)
        out = []
        fn, col, name = b.get("fn", "row_number"), b.get("column"), b.get("as") or b.get("fn", "row_number")
        order = b.get("order_by")
        for rs in parts.values():
            rs = sorted(rs, key=lambda r: (r.get(order) is None, str(r.get(order)) if _num(r.get(order)) is None else _num(r.get(order)))) if order else rs
            if b.get("descending"):
                rs = rs[::-1]
            running = 0.0
            for i, r in enumerate(rs):
                if fn == "row_number" or fn == "rank":
                    v: Any = i + 1
                elif fn == "lag":
                    v = rs[i - 1].get(col) if i > 0 else None
                elif fn == "lead":
                    v = rs[i + 1].get(col) if i + 1 < len(rs) else None
                elif fn == "running_sum":
                    running += _num(r.get(col)) or 0
                    v = running
                else:  # count in partition
                    v = len(rs)
                out.append({**r, name: v})
        return out
    if k == "select":
        cols = b.get("columns") or []
        return [{c: r.get(c) for c in cols + ["__pk"] if c in r or c != "__pk"} for r in rows]
    raise HTTPException(400, f"unknown logic block {k}")


def _check_output(workflow: dict, logic: dict) -> dict:
    out = next((o for o in workflow["outputs"] if o["id"] == (logic.get("output") or {}).get("output_id")), None)
    if not out:
        raise HTTPException(400, "pick the rule output")
    mapping = (logic.get("output") or {}).get("mapping") or {}
    for f in out["fields"]:
        m = mapping.get(f["name"]) or f.get("default")
        if not m:
            if f.get("required"):
                raise HTTPException(400, f"the output field {f['name']} is required")
            continue
        if m.get("kind") == "column":
            if f.get("column_values") == "none":
                raise HTTPException(400, f"{f['name']} only accepts static values")
            if f.get("column_values") == "selection" and m.get("column") not in (f.get("columns") or []):
                raise HTTPException(400, f"{f['name']} only accepts the columns {', '.join(f.get('columns') or [])}")
        elif m.get("kind") == "static":
            v = m.get("value")
            sv = f.get("static_values", "any")
            if sv == "none":
                raise HTTPException(400, f"{f['name']} only accepts column values")
            if sv == "selection" and v not in (f.get("values") or []):
                raise HTTPException(400, f"{f['name']} must be one of {', '.join(map(str, f.get('values') or []))}")
            if sv == "range" and (_num(v) is None or (f.get("min") is not None and _num(v) < f["min"]) or (f.get("max") is not None and _num(v) > f["max"])):
                raise HTTPException(400, f"{f['name']} must be between {f.get('min')} and {f.get('max')}")
            if sv == "users" and f.get("values") and v not in f["values"]:
                raise HTTPException(400, f"{f['name']} must be one of the permitted users")
        elif m.get("kind") == "template":
            if f["type"] != "string":
                raise HTTPException(400, f"{f['name']}: only string fields take templates")
        else:
            raise HTTPException(400, f"{f['name']}: map a column, a static value or a template")
    return out


def _cast(v: Any, typ: str) -> Any:
    if v is None:
        return None
    try:
        if typ == "integer":
            return int(float(v))
        if typ == "double":
            return float(v)
        if typ == "boolean":
            return bool(v) if not isinstance(v, str) else v.lower() in ("true", "1", "yes", "ya")
        return str(v)
    except (TypeError, ValueError):
        return None


def evaluate_rule(rule: dict, workflow: dict, upto: Optional[int] = None) -> dict:
    """Run a rule's logic (optionally only up to a block, for previews) and map its output rows."""
    logic = rule.get("logic") or {}
    inp = logic.get("input") or {}
    if not any(inp.get("kind") == i["kind"] and inp.get("id") == i["id"] for i in workflow["inputs"]):
        raise HTTPException(400, "the rule's input is not one of the workflow's inputs")
    rows = load_input(inp)
    blocks = logic.get("blocks") or []
    for i, b in enumerate(blocks):
        if upto is not None and i > upto:
            break
        rows = run_block(b, rows, workflow)
    if upto is not None and upto < len(blocks):
        return {"rows": rows[:PREVIEW_ROWS], "count": len(rows), "columns": sorted({c for r in rows[:200] for c in r if c != "__pk"})}
    out = _check_output(workflow, logic)
    mapping = (logic.get("output") or {}).get("mapping") or {}
    result = []
    for r in rows:
        row = {}
        for f in out["fields"]:
            m = mapping.get(f["name"]) or f.get("default") or {}
            if m.get("kind") == "column":
                v = r.get(m.get("column"))
            elif m.get("kind") == "static":
                v = m.get("value")
            elif m.get("kind") == "template":
                v = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda x: "" if r.get(x.group(1)) is None else str(r.get(x.group(1))), str(m.get("value") or ""))
            else:
                v = None
            row[f["name"]] = _cast(v, f["type"])
        result.append({"row": row, "source_pk": r.get("__pk")})
    return {"output_id": out["id"], "rows": result, "count": len(result)}


# ------------------------------------------------------------------------------------------------
# rules and proposals
# ------------------------------------------------------------------------------------------------


class RuleIn(BaseModel):
    workflow_id: str
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    status: Literal["active", "disabled"] = "active"
    custom: dict[str, Any] = {}
    logic: dict
    version: Optional[int] = None  # the rule version the editor opened (edits): refused when the rule changed since


_FIELDS = ("name", "description", "status", "custom", "logic")


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def stale_reason(p: dict, rule: Optional[dict] = None, *, look_up: bool = True) -> Optional[str]:
    """Why an edit / delete proposal no longer applies to its rule (None: it is current). `rule` is the current
    rule record (looked up when not given and look_up is on)."""
    if p.get("kind") == "create" or not p.get("rule_id"):
        return None
    if rule is None and look_up:
        rule = _read(ontology._path("foundry-rules-rules", p["rule_id"]))
    name = (p.get("old") or {}).get("name") or (p.get("new") or {}).get("name") or p["rule_id"]
    if not rule:
        return f"the rule “{name}” was deleted after this proposal was made"
    base, now = p.get("base_version"), int(rule.get("version") or 0)
    if base is not None:
        if int(base) != now:
            return f"made against version {base} of “{name}”, which is now version {now}: the rule changed since"
        return None
    # legacy (no base_version recorded): stale when the rule no longer matches what the proposal was made against
    old = p.get("old") or {}
    changed = [k for k in _FIELDS if not _same(old.get(k), rule.get(k))]
    if changed:
        return f"made against an earlier version of “{name}” (now version {now}; changed since: {', '.join(changed)})"
    return None


def _can_edit(w: dict) -> None:
    if w.get("editors") and _who() not in w["editors"] and auth.enabled():
        raise HTTPException(403, "you are not one of this workflow's rule editors")


def _diff(old: Optional[dict], new: Optional[dict]) -> list[dict]:
    out = []
    for k in ("name", "description", "status", "custom", "logic"):
        a, b = (old or {}).get(k), (new or {}).get(k)
        if json.dumps(a, sort_keys=True, default=str) != json.dumps(b, sort_keys=True, default=str):
            out.append({"field": k, "old": a, "new": b})
    return out


def _apply(p: dict) -> Optional[dict]:
    if p["kind"] == "delete":
        ontology._path("foundry-rules-rules", p["rule_id"]).unlink(missing_ok=True)
        return None
    rec = _read(ontology._path("foundry-rules-rules", p["rule_id"])) if p.get("rule_id") else None
    rec = {**(rec or {"id": p.get("rule_id") or f"rule-{uuid.uuid4().hex[:12]}", "created_at": _now(), "author": p["author"], "version": 0}), **p["new"]}
    rec["version"] = int(rec.get("version") or 0) + 1
    ontology._put("foundry-rules-rules", rec)
    p["rule_id"] = rec["id"]
    return rec


def _propose(kind: str, w: dict, rule_id: Optional[str], new: Optional[dict], comment: str = "", opened: Optional[int] = None) -> dict:
    _can_edit(w)
    old = _read(ontology._path("foundry-rules-rules", rule_id)) if rule_id else None
    if rule_id and not old:
        raise HTTPException(404, "rule not found")
    base = int(old.get("version") or 0) if old else None
    if old and opened is not None and int(opened) != base:
        raise HTTPException(409, f"“{old.get('name')}” changed since you opened it (you edited version {opened}, it is now version {base}): reload the rule and make the change again")
    if new is not None:
        wf = w if new.get("workflow_id") == w["id"] else _workflow(new["workflow_id"])
        evaluate_rule({**(old or {}), **new}, wf)  # the rule must run
    p = {"id": f"prop-{uuid.uuid4().hex[:12]}", "workflow_id": w["id"], "rule_id": rule_id, "kind": kind, "author": _who(), "created_at": _now(),
         "status": "open", "comment": comment, "old": {k: old.get(k) for k in ("name", "description", "status", "custom", "logic")} if old else None,
         "new": new, "diff": _diff(old, new), "reviewer": None, "reviewed_at": None, "base_version": base}
    if not w.get("require_proposals"):
        p.update(status="approved", reviewer=p["author"], reviewed_at=_now(), note="applied directly (proposals are off)")
        _apply(p)
    return ontology._put("foundry-rules-proposals", p)


@router.get("/workflows/{wid}/rules")
def list_rules(wid: str) -> list[dict]:
    return sorted((r for r in ontology._all("foundry-rules-rules") if r["workflow_id"] == wid), key=lambda r: r["name"])


@router.post("/rules")
def propose_create(req: RuleIn) -> dict:
    w = _workflow(req.workflow_id)
    with _lock:
        return _propose("create", w, None, req.model_dump(exclude={"version"}))


@router.put("/rules/{rid}")
def propose_edit(rid: str, req: RuleIn) -> dict:
    w = _workflow(req.workflow_id)
    with _lock:
        return _propose("edit", w, rid, req.model_dump(exclude={"version"}), opened=req.version)


@router.delete("/rules/{rid}")
def propose_delete(rid: str) -> dict:
    r = ontology._get("foundry-rules-rules", rid, "rule")
    w = _workflow(r["workflow_id"])
    with _lock:
        return _propose("delete", w, rid, None)


@router.get("/workflows/{wid}/proposals")
def list_proposals(wid: str, status: Optional[str] = None) -> list[dict]:
    ps = [p for p in ontology._all("foundry-rules-proposals") if p["workflow_id"] == wid and (not status or p["status"] == status)]
    rules = {r["id"]: r for r in ontology._all("foundry-rules-rules") if r["workflow_id"] == wid}
    out = []
    for p in ps:
        if p["status"] == "open" and p.get("kind") != "create" and p.get("rule_id"):
            rule = rules.get(p["rule_id"]) or _read(ontology._path("foundry-rules-rules", p["rule_id"]))  # a rule moved to another workflow
            why = stale_reason(p, rule, look_up=False)
            p = {**p, "stale": bool(why), "stale_reason": why, "current_version": int(rule.get("version") or 0) if rule else None}
        out.append(p)
    return sorted(out, key=lambda p: p["created_at"], reverse=True)


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str = ""


@router.post("/proposals/{pid}/review")
def review(pid: str, req: ReviewIn) -> dict:
    with _lock:
        p = ontology._get("foundry-rules-proposals", pid, "proposal")
        if p["status"] != "open":
            raise HTTPException(400, f"this proposal is already {p['status']}")
        w = _workflow(p["workflow_id"])
        me = _who()
        if auth.enabled() and ((w.get("reviewers") and me not in w["reviewers"]) or (not w.get("reviewers") and me == p["author"])):
            raise HTTPException(403, "a reviewer other than the author approves or rejects proposals")
        if req.decision == "approve":
            why = stale_reason(p)
            if why:
                raise HTTPException(409, f"This proposal is stale — {why}. Approving it would overwrite the newer version: reject it and propose the change again from the current rule.")
            if p["kind"] != "delete":
                evaluate_rule({**(p["old"] or {}), **p["new"]}, _workflow(p["new"]["workflow_id"]))
            _apply(p)
        p.update(status="approved" if req.decision == "approve" else "rejected", reviewer=me, reviewed_at=_now(), review_comment=req.comment)
        return ontology._put("foundry-rules-proposals", p)


class PreviewIn(BaseModel):
    rule: dict
    upto: Optional[int] = None


@router.post("/preview")
def preview(req: PreviewIn) -> dict:
    """The rows after a logic block (upto) or the rule's output rows, without writing anything."""
    w = _workflow(req.rule.get("workflow_id") or "")
    with _lock:
        res = evaluate_rule(req.rule, w, req.upto)
    if req.upto is None:
        res["rows"] = res["rows"][:PREVIEW_ROWS]
    return res


# ------------------------------------------------------------------------------------------------
# running a workflow
# ------------------------------------------------------------------------------------------------


def run_workflow(wid: str) -> dict:
    """Evaluate every active rule and replace the outputs (alert objects and / or a Files dataset)."""
    w = _workflow(wid)
    started = time.monotonic()
    per_output: dict[str, list[dict]] = defaultdict(list)
    report = []
    for r in list_rules(wid):
        if r["status"] != "active":
            continue
        try:
            with _lock:
                res = evaluate_rule(r, w)
            for i, x in enumerate(res["rows"]):
                per_output[res["output_id"]].append({**x["row"], "__rule_id": r["id"], "__rule": r["name"], "__key": f"{r['id']}|{x.get('source_pk') or i}",
                                                     **{f"__custom_{k}": v for k, v in (r.get("custom") or {}).items()}})
            report.append({"rule_id": r["id"], "rule": r["name"], "rows": res["count"], "status": "succeeded"})
        except HTTPException as e:
            report.append({"rule_id": r["id"], "rule": r["name"], "rows": 0, "status": "failed", "error": str(e.detail), "code": e.status_code})
    import run_as

    denied = [x for x in report if x.get("code") == 403]
    if denied:
        # whoever the run acts for (a scheduled run: the workflow's owner) cannot read a rule's input: replacing the
        # outputs now would drop that rule's results, so nothing is written
        raise HTTPException(403, f"the rule {denied[0]['rule']} cannot read its input as {run_as.who(auth.actor_id()) if auth.actor_id() else 'the system'} "
                                 f"({denied[0]['error']}): nothing was written")
    import pipeline_datasets

    # the outputs will carry the inputs' markings (_inherit_markings): whoever the run acts for must hold them, or
    # they could not read what they write
    p = auth.current()
    lacking = sorted(auth.missing_markings(_input_markings(w), p.get("markings"))) if auth.enabled() and p and not p.get("service") else []
    if lacking:
        names = auth._marking_names(lacking)
        raise HTTPException(403, f"the workflow's inputs carry the marking{'s' if len(names) > 1 else ''} {', '.join(names)} that "
                                 f"{run_as.who(auth.actor_id())} does not hold, which its outputs would carry: nothing was written")
    for o in w["outputs"]:
        if o.get("object_type_id"):
            ontology._object_type(o["object_type_id"])  # its markings and ontology roles (403 before any write)
        item = pipeline_datasets._live_file(o.get("dataset_id")) if o.get("dataset_id") else None
        missing = run_as.missing_marking_names(item["id"], auth.current()) if item else []
        if missing:
            # the output dataset sits in the platform's own folder (_write_dataset): the run's user needs its markings
            raise HTTPException(403, f"the output dataset {item['name']} carries the marking{'s' if len(missing) > 1 else ''} {', '.join(missing)} that "
                                     f"{run_as.who(auth.actor_id())} does not hold: nothing was written")
    outputs = []
    for o in w["outputs"]:
        rows = per_output.get(o["id"], [])
        if o.get("object_type_id"):
            # marked before its objects are written: users without the inputs' markings never see them; narrowed to
            # the inputs' current markings only once the objects built from the old inputs are replaced
            target = auth.resource_id("object_type", o["object_type_id"])
            _inherit_markings(w, target, before_write=True)
            outputs.append({"output": o["name"], **_write_objects(o, rows)})
            _inherit_markings(w, target)
        if o.get("dataset_name") or o.get("dataset_id"):
            outputs.append({"output": o["name"], **_write_dataset(w, o, rows)})
    run = {"at": _now(), "ms": int((time.monotonic() - started) * 1000), "rules": report, "outputs": outputs, "by": _who()}
    _record_run(wid, run)
    return run


def _record_run(wid: str, run: dict) -> None:
    with _lock:
        w = _workflow(wid)
        w["last_run"] = run
        w.setdefault("runs", []).append(run)
        w["runs"] = w["runs"][-20:]
        ontology._put("foundry-rules", w)


def _input_markings(w: dict) -> set[str]:
    """The markings of every input of the workflow: a dataset's (its own, inherited, its folders'), an object type's
    (its own and its backing datasets')."""
    out: set[str] = set()
    for i in w.get("inputs") or []:
        if not i.get("id"):
            continue
        out |= set(auth.resource_effective("object_type", i["id"]) if i.get("kind") == "object_type" else auth.effective_markings(i["id"]))
    return out


def _inherit_markings(w: dict, target: str, *, before_write: bool = False, exists: bool = True) -> None:
    """A rule output carries the markings of the workflow's inputs, as a Pipeline Builder output does (auth.propagate):
    users without them cannot read the output dataset, or see the output object type and its objects. Recomputed on
    every run (inherited markings only: markings set on the output by hand stay).

    Never a moment with fewer markings than its contents need: before a write (before_write) the output keeps the
    markings it inherited so far and gains the inputs' current ones (its old rows were built from the old inputs);
    after the write it is narrowed to the inputs' current markings. All of them are set in one write of its markings
    record (not the dataset inputs' first and the object type inputs' after, as auth.propagate then a second set
    would). A dataset the run is about to create (exists=False) is marked under its id before it exists: it never
    exists unmarked. The Project's marking constraints (409) are checked once it exists."""
    marks = _input_markings(w)
    if before_write:
        marks |= set(auth._item_row(target)[1])
    auth._set_item(target, inherited=sorted(marks))
    if ":" in target or not exists:
        return  # an object type (a resource outside Files), or a dataset not created yet
    datasets = [i["id"] for i in w.get("inputs") or [] if i.get("kind") != "object_type" and i.get("id")]
    if before_write:
        try:
            import dataset_versions

            dataset_versions.note_inputs(target, datasets)  # the lineage note auth.propagate makes
        except Exception:  # noqa: BLE001 - an audit aid, never the write itself
            pass
    auth.check_constraints(target)


def _write_objects(o: dict, rows: list[dict]) -> dict:
    """Replace the rule-made objects of the output object type (objects made otherwise are kept)."""
    t = ontology._object_type(o["object_type_id"])
    pk_prop = t["primary_key"]
    names = {p["api_name"] for p in t["properties"]}
    want = {}
    for r in rows:
        pk = r.get(pk_prop) if r.get(pk_prop) not in (None, "") else "FR-" + hashlib.sha1(r["__key"].encode()).hexdigest()[:12]
        props = {k: v for k, v in r.items() if k in names}
        props[pk_prop] = pk
        for extra, src in (("rule_id", "__rule_id"), ("rule_name", "__rule")):
            if extra in names:
                props[extra] = r[src]
        want[str(pk)] = props
    with _lock:
        cur = ontology.stored_objects(t["id"])
        ours = {pk for pk, x in cur.items() if str((x.get("properties") or {}).get("rule_id") or "").startswith("rule-") or pk.startswith("FR-")}
        edits = [{"op": "delete", "object_type_id": t["id"], "primary_key": pk} for pk in ours if pk not in want]
        for pk, props in want.items():
            if pk in cur:
                if {k: (cur[pk].get("properties") or {}).get(k) for k in props} != props:
                    edits.append({"op": "modify", "object_type_id": t["id"], "primary_key": pk, "properties": {k: v for k, v in props.items() if k != pk_prop}})
            else:
                edits.append({"op": "create", "object_type_id": t["id"], "primary_key": pk, "properties": props})
    if edits:
        ontology.apply_edits(edits, source="foundry-rules")
    return {"object_type_id": t["id"], "objects": len(want), "created": sum(1 for e in edits if e["op"] == "create"),
            "modified": sum(1 for e in edits if e["op"] == "modify"), "deleted": sum(1 for e in edits if e["op"] == "delete")}


def _write_dataset(w: dict, o: dict, rows: list[dict]) -> dict:
    import pipeline_datasets
    import pyarrow as pa

    cols = [f["name"] for f in o["fields"]] + ["rule_id", "rule_name"]
    data = [{**{c: r.get(c) for c in cols[:-2]}, "rule_id": r["__rule_id"], "rule_name": r["__rule"]} for r in rows]
    typ = {"integer": pa.int64(), "double": pa.float64(), "boolean": pa.bool_()}
    schema = pa.schema([(f["name"], typ.get(f["type"], pa.string())) for f in o["fields"]] + [("rule_id", pa.string()), ("rule_name", pa.string())])
    table = pa.Table.from_pylist(data, schema=schema)
    content = pipeline_datasets._parquet_bytes(table)
    item = pipeline_datasets._live_file(o.get("dataset_id")) if o.get("dataset_id") else None
    if item:
        _inherit_markings(w, item["id"], before_write=True)  # before the new rows are in it
        pipeline_datasets._replace_content(item, content)
        _inherit_markings(w, item["id"])
    else:
        item = _create_marked_dataset(w, f"{o.get('dataset_name') or o['name']}.parquet", content)
        with _lock:
            wf = _workflow(w["id"])
            for x in wf["outputs"]:
                if x["id"] == o["id"]:
                    x["dataset_id"] = item["id"]
            ontology._put("foundry-rules", wf)
        try:
            import dataset_versions

            dataset_versions.note_inputs(item["id"], [i["id"] for i in w.get("inputs") or [] if i.get("kind") != "object_type" and i.get("id")])
        except Exception:  # noqa: BLE001 - an audit aid
            pass
        # recorded as the output first: a Project constraint it violates (409) fails this run, and the next run
        # replaces this dataset rather than making another one
        auth.check_constraints(item["id"])
    return {"dataset_id": item["id"], "rows": table.num_rows}


def _create_marked_dataset(w: dict, name: str, content: bytes) -> dict:
    """Create a rule output dataset already carrying its inputs' markings: the markings record is written under a
    fresh, unused item id first, then the file is stored under that id (drive._store takes the id; save_bytes does
    not), so no reader ever finds it in Files, or reads its rows, without the markings. Created by the platform in
    its own Ontology folder (the run's user is not an Editor there): as the system."""
    import db
    import drive
    import pipeline_datasets
    import run_as

    drive._require_db()
    while True:
        item_id = uuid.uuid4().hex[:16]
        if not db.drive_get(item_id) and auth._item_row(item_id) == ([], []):
            break
    _inherit_markings(w, item_id, exists=False)
    try:
        with run_as.acting_as(None):
            folder = drive._folder_id(drive.default_folder("ontology"))
            item = drive._public(drive._store(folder, drive._clean_name(name), io.BytesIO(content), len(content), pipeline_datasets.PARQUET, item_id=item_id))
    except BaseException:
        auth._set_item(item_id, inherited=[])  # nothing was created: no markings record for an id nobody holds
        raise
    if item["id"] != item_id:
        # drive._store refused the id (taken meanwhile) and stored the rows under another one, unmarked: remove it
        # at once rather than leave it readable, and fail the run
        auth._set_item(item_id, inherited=[])
        drive._delete_contents(db.drive_delete(item["id"], drive._now()))
        raise HTTPException(500, "the rule output dataset could not be created under its marked id: nothing was written")
    return item


@router.post("/workflows/{wid}/run")
def run_route(wid: str) -> dict:
    return run_workflow(wid)


def _scheduler() -> None:
    while True:
        time.sleep(60)
        try:
            run_due()
        except Exception:  # noqa: BLE001 - the scheduler keeps running
            continue


def run_due(only: Optional[str] = None) -> list[dict]:
    """Run every workflow whose schedule is due (or only `only`), each as its owner, never as the system (run_as.py):
    when the owner is gone, deactivated or lost access, the run is recorded as failed with the reason (retried at
    the next slot)."""
    import run_as

    ran = []
    for w in ontology._all("foundry-rules"):
        every = w.get("schedule_minutes")
        if not every or (only and w["id"] != only):
            continue
        last = (w.get("last_run") or {}).get("at")
        if not only and last and (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() < every * 60:
            continue
        try:
            with run_as.as_owner(w.get("owner") if str(w.get("owner") or "").startswith("u-") else None, "the workflow"):
                ran.append(run_workflow(w["id"]))
        except Exception as e:  # noqa: BLE001 - recorded on the workflow; retried at the next slot
            err = f"did not run: {e}" if isinstance(e, run_as.OwnerUnavailable) else f"failed: {getattr(e, 'detail', None) or e}"
            run = {"at": _now(), "ms": 0, "rules": [], "outputs": [], "by": None, "status": "failed", "error": str(err)[:800]}
            _record_run(w["id"], run)
            ran.append(run)
    return ran


# ------------------------------------------------------------------------------------------------
# Contour import: a Contour path as rule logic (a draft for the rule editor)
# ------------------------------------------------------------------------------------------------

_AGG = re.compile(r"^\s*(sum|avg|min|max|count)\s*\(\s*(distinct\s+)?(\*|\"?([^\"()]+?)\"?)\s*\)\s*$", re.I)
_CONTOUR_OPS = {"eq": "eq", "neq": "neq", "gt": "gt", "gte": "gte", "lt": "lt", "lte": "lte", "is_null": "is_null", "not_null": "not_null", "contains": "contains", "in": "in"}


def _contour_conditions(conds: list[dict], notes: list[str]) -> list[dict]:
    out = []
    for c in conds:
        op = c.get("op") or "is"
        vals = c.get("values") if c.get("values") is not None else [c.get("value")]
        vals = [v for v in (vals or []) if v not in (None, "")]
        if c.get("negate"):
            notes.append(f"the negated condition on {c.get('column')} was left out (rules have no NOT on a condition)")
            continue
        if any(isinstance(v, str) and v.startswith("$") for v in vals):
            notes.append(f"the condition on {c.get('column')} uses a Contour parameter: set its value in the rule")
        if op == "is":
            out.append({"column": c["column"], "op": "eq" if len(vals) == 1 else "in", "value": vals[0] if len(vals) == 1 else vals})
        elif op == "between":
            lo, hi = (vals + [None, None])[:2]
            out += [{"column": c["column"], "op": "gte", "value": lo}, {"column": c["column"], "op": "lte", "value": hi}]
        elif op in _CONTOUR_OPS:
            if op == "contains" and len(vals) > 1:
                notes.append(f"only the first value of contains on {c['column']} was kept")
            out.append({"column": c["column"], "op": _CONTOUR_OPS[op], "value": vals if op == "in" else (vals[0] if vals else None)})
        else:
            notes.append(f"the {op} condition on {c.get('column')} (wildcards / regular expressions) was left out")
    return out


def contour_to_logic(analysis: dict, path_id: str, notes: list[str], depth: int = 0) -> dict:
    """{input, blocks} for a Contour path; boards rules cannot express are skipped with a note."""
    path = next((p for p in analysis["paths"] if p["id"] == path_id), None)
    if not path or depth > 10:
        raise HTTPException(400, "no such path")
    src = path.get("source") or {}
    if src.get("kind") == "path":
        logic = contour_to_logic(analysis, src["id"], notes, depth + 1)
    elif src.get("kind") in ("dataset", "object_type"):
        logic = {"input": {"kind": src["kind"], "id": src["id"]}, "blocks": []}
    else:
        raise HTTPException(400, "the path's source cannot be a rule input")
    for b in path.get("boards") or []:
        t, c = b.get("type"), b.get("config") or {}
        label = b.get("title") or t
        if t == "filter":
            if c.get("remove"):
                notes.append(f"{label}: a filter that removes matching rows was left out")
                continue
            conds = _contour_conditions(c.get("conditions") or [], notes)
            if c.get("expression"):
                notes.append(f"{label}: the SQL filter expression was left out — add it as an expression block")
            if conds:
                logic["blocks"].append({"kind": "filter", "combine": "any" if c.get("mode") == "any" else "all", "conditions": conds})
        elif t == "expression" and (c.get("mode") or "column") == "aggregate":
            aggs = []
            for a in c.get("aggregates") or [{"name": c.get("name") or "value", "expr": c.get("expr") or ""}]:
                m = _AGG.match(a.get("expr") or "")
                if not m:
                    notes.append(f"{label}: the aggregate {a.get('expr')} was left out (only sum / avg / min / max / count of a column)")
                    continue
                fn = m.group(1).lower()
                col = None if m.group(3) == "*" else m.group(4).strip()
                aggs.append({"fn": "distinct" if m.group(2) else fn, "column": col, "as": a.get("name")})
            if aggs:
                logic["blocks"].append({"kind": "aggregation", "group_by": c.get("group_by") or [], "aggregations": aggs})
        elif t == "edit_columns" and c.get("keep") and not c.get("rename") and not c.get("casts"):
            logic["blocks"].append({"kind": "select", "columns": c["keep"]})
        elif t in ("sort", "table", "histogram", "distribution", "time_series", "chart", "heatmap", "pivot", "calculation", "map", "export"):
            continue  # display boards: nothing to carry over
        else:
            notes.append(f"{label}: the {t} board has no rule equivalent and was left out")
    return logic


class ContourImportIn(BaseModel):
    workflow_id: str
    analysis_id: str
    path_id: str


@router.post("/import-contour")
def import_contour(req: ContourImportIn) -> dict:
    """A Contour path as a draft rule's logic: its source as the input (it must be one of the workflow's inputs),
    filters, simple aggregations and kept columns as blocks; notes list what was left out."""
    import contour

    w = _workflow(req.workflow_id)
    a = contour._load(contour._item(req.analysis_id))
    notes: list[str] = []
    logic = contour_to_logic(a, req.path_id, notes)
    if not any(logic["input"]["kind"] == i["kind"] and logic["input"]["id"] == i["id"] for i in w["inputs"]):
        raise HTTPException(400, "the path's source is not one of this workflow's inputs")
    allowed = set(w.get("boards") or BOARDS)
    for b in logic["blocks"]:
        if b["kind"] not in allowed:
            raise HTTPException(400, f"the path needs the {b['kind']} board, which this workflow does not enable")
    path = next(p for p in a["paths"] if p["id"] == req.path_id)
    return {"name": path.get("name") or a.get("name") or "Imported rule", "description": f"Imported from the Contour analysis {a.get('name') or req.analysis_id}",
            "logic": logic, "notes": notes}
