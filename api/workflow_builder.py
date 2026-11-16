"""Workflow Builder (Application Building → Workflow Builder): Ontology workflows built as graphs of nodes.

A graph is a Files item (`<name>.wbgraph`, application/vnd.bluesandai.workflow-builder+json) holding one or more
workflows. Each starts at a trigger (objects of a type added or modified — optionally only when a property changes —,
a schedule, or manual) or at a subgraph start, and runs node by node:
- compute: run a published function, or build a transform (named expressions) without code;
- use LLM: a prompt template sent to a language model with a typed output and Ontology tools — object queries,
  functions and actions. Tools either run before the call (their results go in the prompt) or, with tool calling, the
  model decides: it answers with tool calls (several at once run independently) or the final answer, each call's
  result goes back to it, up to max_tool_calls calls (actions really apply; in previews they land in the sandbox).
  Native provider tool calling (OpenRouter tools / tool_calls, Gemini function declarations) where the model has it,
  JSON turns otherwise (registered models); previews and executions can stream the model's turns (…/stream, SSE);
- fork: cases with conditions (the first true one is taken, else "Otherwise"), joined again at the fork's after-fork;
- effect: apply an action, send a notification, or do nothing;
- loop: iterate over a list (element and index variables), continuing at the loop's after-loop;
- call subgraph: run a subgraph of the same graph with inputs.
Values are templates ("Tarif {{object.tarif_rs}}") or expressions ("= object.tarif_rs - object.tarif_inacbg"), over the
trigger's `object`, earlier nodes' outputs (by output name), loop variables and the graph's reusable `params`.

Previews run real objects through a workflow inside a hidden staged-writes scenario (ontology_scenarios.py): actions
really run, but their edits land in the sandbox, and the preview lists them; nothing reaches main. Deployed workflows
run on their triggers (object edits through ontology.MODEL_HOOKS["edits"], schedules from a background thread) as the
user who deployed them; every run is recorded (path, node values, edits, errors). Saves are versions (restore).
"""

from __future__ import annotations

import ast
import contextvars
import io
import json
import logging
import math
import operator
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth
import db
import drive

log = logging.getLogger("bluesandai.workflow_builder")
router = APIRouter(prefix="/api/workflow-builder", tags=["workflow-builder"])
WB_TYPE = "application/vnd.bluesandai.workflow-builder+json"
DIR = Path("data/workflow_builder")
NODE_TYPES = ("trigger", "subgraph", "compute", "llm", "fork", "after_fork", "effect", "loop", "after_loop", "call_subgraph")
MAX_STEPS = 2000
_lock = threading.RLock()
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="workflow-builder")
_running: contextvars.ContextVar[int] = contextvars.ContextVar("wb_running", default=0)


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "workflow_builder"
    (DIR / "graphs").mkdir(parents=True, exist_ok=True)
    (DIR / "runs").mkdir(parents=True, exist_ok=True)
    _install_hook()
    threading.Thread(target=_scheduler, name="workflow-builder-schedules", daemon=True).start()
    threading.Thread(target=lambda: [_seed(g, s) for g in _all() for s, d in (g.get("deployed") or {}).items() if d.get("enabled")], daemon=True).start()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    return auth.current() or {"id": "local", "username": "local", "role": "admin", "groups": []}


def _rd(p: Path, default: Any = None) -> Any:
    try:
        return json.loads(p.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


def _wr(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, default=str), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


# ------------------------------------------------------------------------------------------------
# expressions and templates
# ------------------------------------------------------------------------------------------------

_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
        ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b}
_FUNCS = {"len": len, "str": str, "int": int, "float": float, "round": round, "abs": abs, "min": min, "max": max, "sum": sum, "bool": bool,
          "lower": lambda s: str(s).lower(), "upper": lambda s: str(s).upper(), "contains": lambda a, b: str(b).lower() in str(a).lower(),
          "now": lambda: _now(), "today": lambda: datetime.now(timezone.utc).date().isoformat(), "coalesce": lambda *a: next((x for x in a if x not in (None, "")), None),
          "split": lambda s, sep=",": [x.strip() for x in str(s).split(sep)], "join": lambda xs, sep=", ": sep.join(map(str, xs)), "ceil": math.ceil, "floor": math.floor}


def _num(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            return v
    return v


def evaluate(expr: str, scope: dict) -> Any:
    """A small safe expression language (Python syntax): names, attribute / index access on objects, arithmetic,
    comparisons, and / or / not, conditionals, lists and a few functions."""
    try:
        tree = ast.parse(expr.strip(), mode="eval")
    except SyntaxError as e:
        raise ValueError(f"cannot read the expression {expr!r}: {e.msg}") from None

    def ev(n: ast.AST) -> Any:
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, ast.Name):
            if n.id in ("true", "True"):
                return True
            if n.id in ("false", "False"):
                return False
            if n.id in ("null", "None"):
                return None
            if n.id not in scope:
                raise ValueError(f"unknown name {n.id!r}")
            return scope[n.id]
        if isinstance(n, ast.Attribute):
            base = ev(n.value)
            return base.get(n.attr) if isinstance(base, dict) else None
        if isinstance(n, ast.Subscript):
            base, key = ev(n.value), ev(n.slice)
            try:
                return base[key]
            except (KeyError, IndexError, TypeError):
                return None
        if isinstance(n, ast.BinOp) and type(n.op) in _BIN:
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Add) and (isinstance(a, str) or isinstance(b, str)) and not (isinstance(_num(a), (int, float)) and isinstance(_num(b), (int, float))):
                return f"{'' if a is None else a}{'' if b is None else b}"
            return _BIN[type(n.op)](_num(a) or 0, _num(b) or 0)
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return (not v) if isinstance(n.op, ast.Not) else (-_num(v) if isinstance(n.op, ast.USub) else v)
        if isinstance(n, ast.BoolOp):
            vals = [ev(v) for v in n.values]
            return all(vals) if isinstance(n.op, ast.And) else next((v for v in vals if v), vals[-1] if vals else None)
        if isinstance(n, ast.Compare):
            left = ev(n.left)
            for op, c in zip(n.ops, n.comparators):
                right = ev(c)
                a, b = (_num(left), _num(right)) if not isinstance(op, (ast.In, ast.NotIn)) else (left, right)
                try:
                    ok = _CMP[type(op)](a, b)
                except TypeError:
                    ok = _CMP[type(op)](str(a), str(b))
                if not ok:
                    return False
                left = right
            return True
        if isinstance(n, ast.IfExp):
            return ev(n.body) if ev(n.test) else ev(n.orelse)
        if isinstance(n, (ast.List, ast.Tuple)):
            return [ev(x) for x in n.elts]
        if isinstance(n, ast.Dict):
            return {ev(k): ev(v) for k, v in zip(n.keys, n.values) if k is not None}
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS:
            return _FUNCS[n.func.id](*[ev(a) for a in n.args])
        raise ValueError(f"not allowed in an expression: {ast.dump(n)[:60]}")

    return ev(tree)


_TPL = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def value_of(v: Any, scope: dict) -> Any:
    """'= expr' evaluates; a lone '{{expr}}' keeps its type; other strings interpolate; the rest is literal."""
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("="):
            return evaluate(s[1:], scope)
        m = _TPL.fullmatch(s)
        if m:
            return evaluate(m.group(1), scope)
        if "{{" in s:
            return _TPL.sub(lambda m: _text(evaluate(m.group(1), scope)), v)
    if isinstance(v, dict):
        return {k: value_of(x, scope) for k, x in v.items()}
    if isinstance(v, list):
        return [value_of(x, scope) for x in v]
    return v


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, default=str)
    return str(v)


# ------------------------------------------------------------------------------------------------
# graphs
# ------------------------------------------------------------------------------------------------


def _gpath(gid: str) -> Path:
    if not re.fullmatch(r"wb-[0-9a-f]{12}", gid):
        raise HTTPException(404, "graph not found")
    return DIR / "graphs" / f"{gid}.json"


def _graph(gid: str) -> dict:
    g = _rd(_gpath(gid))
    if not g:
        raise HTTPException(404, "graph not found")
    return g


def _access(g: dict, need: str = "viewer") -> dict:
    return drive._item(g["item_id"], need=need)


def _can(g: dict, need: str) -> bool:
    try:
        _access(g, need)
        return True
    except HTTPException:
        return False


def empty() -> dict:
    return {"nodes": [], "edges": [], "params": [], "watchlist": []}


def check(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise HTTPException(422, "a workflow graph is an object")
    out = empty()
    ids = set()
    for n in doc.get("nodes") or []:
        if not isinstance(n, dict) or n.get("type") not in NODE_TYPES or not n.get("id"):
            raise HTTPException(422, f"a node needs an id and a type among {', '.join(NODE_TYPES)}")
        if n["id"] in ids:
            raise HTTPException(422, f"two nodes share the id {n['id']}")
        ids.add(n["id"])
        out["nodes"].append({**n, "config": n.get("config") or {}})
    for n in out["nodes"]:
        if n["type"] in ("after_fork", "after_loop") and n["config"].get("of") not in ids:
            raise HTTPException(422, f"{n['id']}: an {n['type'].replace('_', ' ')} node belongs to a {n['type'].split('_')[1]} node")
    for e in doc.get("edges") or []:
        if isinstance(e, dict) and e.get("from") in ids and e.get("to") in ids:
            out["edges"].append({"from": e["from"], "to": e["to"], "port": str(e.get("port") or "next")})
    out["params"] = [{"name": str(p.get("name") or ""), "value": p.get("value")} for p in doc.get("params") or [] if isinstance(p, dict) and re.fullmatch(r"[A-Za-z_]\w*", str(p.get("name") or ""))]
    out["watchlist"] = [str(x) for x in doc.get("watchlist") or []][:500]
    if len(out["nodes"]) > 1000:
        raise HTTPException(422, "a graph holds at most 1000 nodes")
    return out


def _summary(g: dict) -> dict:
    item = _safe(lambda: db.drive_get(g["item_id"]), {}) or {}
    return {"id": g["id"], "item_id": g["item_id"], "name": (item.get("name") or g.get("name") or "").removesuffix(".wbgraph"), "version": g["version"],
            "workflows": sum(1 for n in g["doc"]["nodes"] if n["type"] == "trigger"), "deployed": sum(1 for d in (g.get("deployed") or {}).values() if d.get("enabled")),
            "updated_at": g["updated_at"], "folder_id": item.get("parent_id")}


def _safe(f, default):
    try:
        return f()
    except Exception:  # noqa: BLE001
        return default


def _all() -> list[dict]:
    return [g for p in (DIR / "graphs").glob("wb-*.json") if (g := _rd(p))]


class GraphIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    folder_id: str
    doc: Optional[dict] = None


@router.get("/graphs")
def list_graphs() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (WB_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return sorted((_summary(g) for g in _all() if g["item_id"] in visible), key=lambda x: x["updated_at"], reverse=True)


@router.post("/graphs")
def create_graph(req: GraphIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "store the graph in a Project or a folder")
    doc = check(req.doc or empty())
    with _lock:
        gid = f"wb-{uuid.uuid4().hex[:12]}"
        body = json.dumps({"workflow_builder_graph_id": gid}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{req.name.strip()}.wbgraph"), io.BytesIO(body), len(body), WB_TYPE)
        g = {"id": gid, "item_id": item["id"], "name": req.name.strip(), "version": 1, "doc": doc, "deployed": {},
             "history": [{"version": 1, "at": _now(), "by": _me().get("id"), "doc": doc, "description": "Created"}], "created_at": _now(), "updated_at": _now()}
        _wr(_gpath(gid), g)
    return get_graph(gid)


@router.get("/graphs/{gid}")
def get_graph(gid: str, version: Optional[int] = None) -> dict:
    g = _graph(gid)
    _access(g)
    doc = g["doc"]
    if version:
        h = next((x for x in g["history"] if x["version"] == version), None)
        if not h:
            raise HTTPException(404, "version not found")
        doc = h["doc"]
    return {**_summary(g), "doc": doc, "previewing": version, "deployed": g.get("deployed") or {}, "can_edit": _can(g, "editor"),
            "versions": [{"version": h["version"], "at": h["at"], "by": _who(h.get("by")), "description": h.get("description", ""), "nodes": len(h["doc"]["nodes"])} for h in reversed(g["history"])][:100]}


def _who(uid: Optional[str]) -> Optional[str]:
    if not uid or not str(uid).startswith("u-"):
        return uid
    try:
        u = auth._user(uid)
        return u.get("display_name") or u.get("username")
    except HTTPException:
        return uid


class SaveIn(BaseModel):
    doc: dict
    base_version: int
    description: str = Field("", max_length=500)


@router.put("/graphs/{gid}")
def save_graph(gid: str, req: SaveIn) -> dict:
    with _lock:
        g = _graph(gid)
        _access(g, "editor")
        if req.base_version != g["version"]:
            raise HTTPException(409, f"version {g['version']} was saved after you opened version {req.base_version}: reload")
        doc = check(req.doc)
        g["version"] += 1
        g["doc"] = doc
        g["updated_at"] = _now()
        g["history"].append({"version": g["version"], "at": _now(), "by": _me().get("id"), "doc": doc, "description": req.description})
        g["history"] = g["history"][-100:]
        _wr(_gpath(gid), g)
    return get_graph(gid)


@router.post("/graphs/{gid}/versions/{version}/restore")
def restore(gid: str, version: int) -> dict:
    g = _graph(gid)
    h = next((x for x in g["history"] if x["version"] == version), None)
    if not h:
        raise HTTPException(404, "version not found")
    return save_graph(gid, SaveIn(doc=h["doc"], base_version=g["version"], description=f"Restored version {version}"))


@router.delete("/graphs/{gid}")
def delete_graph(gid: str) -> dict:
    g = _graph(gid)
    drive.trash(_access(g, "editor")["id"])
    with _lock:
        g["deployed"] = {}
        _wr(_gpath(gid), g)
    return {"trashed": gid}


# ------------------------------------------------------------------------------------------------
# the engine
# ------------------------------------------------------------------------------------------------


class Run:
    def __init__(self, doc: dict, params: dict):
        self.doc = doc
        self.nodes = {n["id"]: n for n in doc["nodes"]}
        self.out: dict[str, list[dict]] = {}
        for e in doc["edges"]:
            self.out.setdefault(e["from"], []).append(e)
        self.path: list[dict] = []
        self.steps = 0
        self.params = params

    def next_of(self, nid: str, port: str = "next") -> Optional[str]:
        return next((e["to"] for e in self.out.get(nid, []) if e["port"] == port), None)

    def after(self, nid: str, kind: str) -> Optional[str]:
        return next((n["id"] for n in self.doc["nodes"] if n["type"] == kind and n["config"].get("of") == nid), None)

    def chain(self, nid: Optional[str], scope: dict) -> Any:
        last = None
        while nid:
            self.steps += 1
            if self.steps > MAX_STEPS:
                raise RuntimeError(f"the run took more than {MAX_STEPS} steps (a loop that does not end?)")
            n = self.nodes[nid]
            t0 = time.monotonic()
            step: dict[str, Any] = {"node": nid, "type": n["type"], "at": _now()}
            self.path.append(step)
            if self.cancel is not None and self.cancel.is_set():
                step["error"] = "stopped: the preview was closed"
                raise RuntimeError(step["error"])
            self._emit("node", {"node": nid, "type": n["type"], "status": "running"})
            try:
                if n["type"] == "fork":
                    taken = None
                    for c in n["config"].get("cases") or []:
                        if c.get("condition") and evaluate(str(c["condition"]).lstrip("="), scope):
                            taken = c
                            break
                    port = f"case:{taken['id']}" if taken else "default"
                    step["value"] = taken["name"] if taken else "Otherwise"
                    step["ms"] = round((time.monotonic() - t0) * 1000)
                    self._emit_step(step)
                    self.chain(self.next_of(nid, port), scope)
                    nid = self.next_of(self.after(nid, "after_fork") or "", "next")
                    continue
                if n["type"] == "loop":
                    items = value_of(n["config"].get("list") or "", scope)
                    items = items if isinstance(items, list) else ([] if items is None else [items])
                    el, ix = n["config"].get("element") or "item", n["config"].get("index") or "index"
                    step["value"] = f"{len(items)} items"
                    self._emit_step(step)
                    for i, x in enumerate(items[:1000]):
                        self.chain(self.next_of(nid, "body"), {**scope, el: x, ix: i})
                    nid = self.next_of(self.after(nid, "after_loop") or "", "next")
                    continue
                self.calls = []
                self.llm_info = {}
                self.node_id = nid
                try:
                    value = self.execute(n, scope)
                finally:
                    if self.calls:
                        step["tool_calls"] = self.calls
                        self.calls = []
                    if self.llm_info:
                        step.update(self.llm_info)
                        self.llm_info = {}
                if n["type"] not in ("trigger", "subgraph", "after_fork", "after_loop"):
                    name = n["config"].get("output") or n.get("name") or nid
                    scope[name] = value
                    step["value"] = value
                    last = value
            except Exception as e:  # noqa: BLE001
                step["error"] = getattr(e, "detail", None) or str(e)
                step["ms"] = round((time.monotonic() - t0) * 1000)
                self._emit_step(step)
                raise
            step["ms"] = round((time.monotonic() - t0) * 1000)
            self._emit_step(step)
            nid = self.next_of(nid, "next")
        return last

    def execute(self, n: dict, scope: dict) -> Any:
        import ontology

        c = n["config"]
        t = n["type"]
        if t in ("trigger", "subgraph", "after_fork", "after_loop"):
            return None
        if t == "compute":
            if c.get("mode") == "function":
                import functions_registry

                inputs = {k: value_of(v, scope) for k, v in (c.get("inputs") or {}).items()}
                res = functions_registry.execute(c.get("function_id") or "", inputs, c.get("version"), "workflow-builder")
                if isinstance(res, dict) and res.get("error"):
                    raise RuntimeError(res["error"])
                return res.get("value") if isinstance(res, dict) and "value" in res else res
            out = {}
            local = dict(scope)
            for a in c.get("assignments") or []:
                if a.get("name"):
                    v = value_of(a.get("expr") if str(a.get("expr") or "").startswith(("=", "{{")) else f"={a.get('expr') or 'None'}", local)
                    out[a["name"]] = v
                    local[a["name"]] = v
            return out if len(out) != 1 else next(iter(out.values()))
        if t == "llm" and c.get("tool_calling"):
            return self.llm_tools(c, scope)
        if t == "llm":
            import pipeline_ai

            context = []
            for tool in c.get("tools") or []:
                if tool.get("kind") == "object_query" and tool.get("object_type_id"):
                    q = value_of(tool.get("query") or "", scope)
                    rows = ontology.list_objects(tool["object_type_id"], str(q or ""), int(tool.get("limit") or 20))["objects"]
                    name = tool.get("name") or "objects"
                    context.append(f"[{name}: {len(rows)} objects]\n" + json.dumps([r["properties"] for r in rows], ensure_ascii=False, default=str)[:12000])
                if tool.get("kind") == "function" and tool.get("function_id"):
                    import functions_registry

                    res = functions_registry.execute(tool["function_id"], value_of(tool.get("inputs") or {}, scope), None, "workflow-builder")
                    context.append(f"[{tool.get('name') or 'function'} result]\n{_text(res.get('value') if isinstance(res, dict) else res)[:8000]}")
            prompt = _text(value_of(c.get("prompt") or "", scope))
            if context:
                prompt += "\n\nTools results:\n" + "\n\n".join(context)
            schema = {"string": None, "boolean": {"type": "boolean"}, "integer": {"type": "integer"}, "double": {"type": "number"},
                      "string_array": {"type": "array", "items": {"type": "string"}}}.get(c.get("output_type") or "string")
            if c.get("output_type") == "struct":
                fields = [f for f in c.get("fields") or [] if f.get("name")]
                schema = {"type": "object", "properties": {f["name"]: {"type": {"integer": "integer", "double": "number", "boolean": "boolean"}.get(f.get("type"), "string")} for f in fields},
                          "required": [f["name"] for f in fields]}
            model, system = c.get("model") or ontology.DEFAULT_LLM, _text(value_of(c.get("system") or "", scope))
            if schema is None and self.emit is not None:
                # a streamed run: the text answer streams as "model" events (one turn), and a closed stream stops it
                self.llm_info = {"turns": []}
                return self._turn(model, system, [{"role": "user", "text": prompt}], None, c)["text"]
            return pipeline_ai.chat(model, system, prompt, schema, float(c.get("temperature") or 0), int(c.get("max_tokens") or 2000))
        if t == "effect":
            mode = c.get("mode") or "nothing"
            if mode == "nothing":
                return "did nothing"
            if mode == "action":
                params = {k: value_of(v, scope) for k, v in (c.get("parameters") or {}).items()}
                res = ontology.apply_action(c.get("action_type_id") or "", ontology.ApplyAction(parameters=params))
                return {"applied": c.get("action_type_id"), "edits": len((res or {}).get("edits") or [])}
            if mode == "notification":
                import notify

                to = value_of(c.get("to") or [], scope)
                to = [to] if isinstance(to, str) else to
                subject, body = _text(value_of(c.get("subject") or "", scope)), _text(value_of(c.get("body") or "", scope))
                for u in to or []:
                    if self.preview:
                        continue
                    notify.deliver(str(u), subject, body, source="workflow-builder")
                return {"notified": to, "subject": subject, "sent": not self.preview}
            raise ValueError(f"unknown effect {mode}")
        if t == "call_subgraph":
            start = c.get("subgraph")
            sg = self.nodes.get(start or "")
            if not sg or sg["type"] != "subgraph":
                raise ValueError("choose a subgraph to call")
            inner = {"params": self.params, **{k: value_of(v, scope) for k, v in (c.get("inputs") or {}).items()}}
            return self.chain(self.next_of(sg["id"], "next"), inner)
        raise ValueError(f"unknown node type {t}")

    preview = False
    calls: list = []
    llm_info: dict = {}
    node_id: Optional[str] = None
    # streaming: emit(kind, payload) gets the nodes, the model's turns and the tool calls as they happen
    emit: Any = None
    # a threading.Event set when the reader of a streamed preview went away (the run stops at the next node or turn)
    cancel: Any = None

    def _emit(self, kind: str, payload: dict) -> None:
        if self.emit is not None:
            try:
                self.emit(kind, payload)
            except Exception:  # noqa: BLE001 - a reader's trouble never breaks a run
                log.debug("workflow-builder: emit failed", exc_info=True)

    def _emit_step(self, step: dict) -> None:
        if self.emit is not None:
            self._emit("step", {**step, "value": _clip(step.get("value")), "status": "failed" if step.get("error") else "done"})

    # ------------------------------------------------------------------ LLM tool calling

    def _tools(self, c: dict) -> list[dict]:
        """The node's tools as the model sees them: a name, what it does and its arguments."""
        import ontology

        out = []
        for i, tool in enumerate(c.get("tools") or []):
            k = tool.get("kind")
            name = re.sub(r"\W+", "_", str(tool.get("name") or f"{k}_{i + 1}")).strip("_") or f"tool_{i + 1}"
            if k == "object_query" and tool.get("object_type_id"):
                t = ontology._object_type(tool["object_type_id"])
                out.append({"name": name, "kind": k, "spec": tool, "args": {"query": "search text (empty: any)"},
                            "schema": {"type": "object", "properties": {"query": {"type": "string", "description": "search text (empty: any object)"}}},
                            "about": f"search {t['display_name']} objects (properties: {', '.join(p['api_name'] for p in t['properties'][:40])}); returns up to {int(tool.get('limit') or 20)}"})
            elif k == "function" and tool.get("function_id"):
                info = ontology._hook("function_info", tool["function_id"], tool.get("version")) or {}
                fixed = set((tool.get("inputs") or {}).keys())
                ins = [i for i in info.get("inputs") or [] if i["name"] not in fixed]
                out.append({"name": name, "kind": k, "spec": tool, "args": {i["name"]: i["type"] for i in ins},
                            "schema": {"type": "object", "properties": {i["name"]: _json_type(i.get("type")) for i in ins},
                                       "required": [i["name"] for i in ins if i.get("required", True)]},
                            "about": f"run the function {info.get('name') or tool['function_id']} (returns {info.get('output')})"})
            elif k == "action" and tool.get("action_type_id"):
                a = ontology._action_type(tool["action_type_id"])
                fixed = set((tool.get("parameters") or {}).keys())
                ps = [p for p in a.get("parameters") or [] if p["id"] not in fixed]
                out.append({"name": name, "kind": k, "spec": tool, "args": {p["id"]: f"{p.get('type')}{' (required)' if p.get('required') else ''}" for p in ps},
                            "schema": {"type": "object", "properties": {p["id"]: _json_type(p.get("type"), p.get("display_name")) for p in ps},
                                       "required": [p["id"] for p in ps if p.get("required")]},
                            "about": f"apply the action {a['display_name']}: it edits the Ontology"})
        return out

    def _call_tool(self, tool: dict, args: dict, scope: dict) -> Any:
        import ontology

        spec = tool["spec"]
        if tool["kind"] == "object_query":
            rows = ontology.list_objects(spec["object_type_id"], str(args.get("query") or value_of(spec.get("query") or "", scope) or ""), int(spec.get("limit") or 20))["objects"]
            return [r["properties"] for r in rows]
        if tool["kind"] == "function":
            import functions_registry

            inputs = {**{k: value_of(v, scope) for k, v in (spec.get("inputs") or {}).items()}, **args}
            res = functions_registry.execute(spec["function_id"], inputs, spec.get("version"), "workflow-builder")
            if isinstance(res, dict) and not res.get("ok", True):
                raise RuntimeError(str(res.get("error") or "the function failed"))
            return res.get("value") if isinstance(res, dict) else res
        params = {**{k: value_of(v, scope) for k, v in (spec.get("parameters") or {}).items()}, **args}
        res = ontology.apply_action(spec["action_type_id"], ontology.ApplyAction(parameters=params))
        return {"applied": spec["action_type_id"], "edits": len((res or {}).get("edits") or [])}

    def llm_tools(self, c: dict, scope: dict) -> Any:
        """The model calls the node's tools in a loop, then answers; the answer is shaped to the output type.

        Native tool calling where the provider has it (OpenAI-compatible tools / tool_calls through OpenRouter, Gemini
        function declarations): the tools' JSON schemas are declared, the model's calls come back as tool calls and
        their results go back as tool messages. Registered models (function:…), routes without tool use, and nodes set
        to tool_mode "json" use JSON turns instead: each turn the model answers {"tool", "args"}, {"calls": [...]} or
        {"answer"} in its text; nodes set to tool_mode "native" never fall back (the node fails instead). Either way
        several calls in one turn run independently (object queries and functions in parallel, then actions one at a
        time, in order), every call and result is recorded in order, and past
        max_tool_calls the model must answer (if it still asks for tools the loop stops)."""
        import ontology
        import pipeline_ai

        tools = self._tools(c)
        model = c.get("model") or ontology.DEFAULT_LLM
        limit = max(1, min(20, int(c.get("max_tool_calls") or 6)))
        prompt = _text(value_of(c.get("prompt") or "", scope))
        system = _text(value_of(c.get("system") or "", scope)) if c.get("system") else ""
        transcript: list[str] = []
        self.llm_info = {"turns": []}
        result: Optional[tuple[Any, bool]] = None
        mode = c.get("tool_mode") or "auto"
        if mode == "native" and model.startswith("function:"):
            raise ValueError(f"native tool calling: {model} is a registered model, it takes no tool declarations (set the node's tool mode to auto or JSON-in-text)")
        if mode != "json" and not model.startswith("function:"):
            try:
                result = self._native_loop(c, scope, tools, model, limit, system, prompt, transcript)
                self.llm_info["tool_mode"] = "native"
            except pipeline_ai.ToolsUnsupported as e:
                if mode == "native":  # no fallback to JSON turns: the node fails with the provider's refusal
                    raise ValueError(f"native tool calling: {e}") from e
                if self.calls:
                    raise
                self.llm_info["fallback"] = str(e)[:300]
        if result is None:
            self.llm_info["tool_mode"] = "json"
            self.llm_info["turns"] = []
            result = self._json_loop(c, scope, tools, model, limit, system, prompt, transcript)
        answer, done = result
        if not done:
            self.llm_info["stopped"] = f"stopped: the model still asked for tools after {limit} tool calls"
        out_type = c.get("output_type") or "string"
        if out_type == "string":
            if answer is None:
                return None
            return answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False, default=str)
        # a typed output: shape the final answer with the output schema
        schema = {"boolean": {"type": "boolean"}, "integer": {"type": "integer"}, "double": {"type": "number"}, "string_array": {"type": "array", "items": {"type": "string"}}}.get(out_type)
        if out_type == "struct":
            fields = [f for f in c.get("fields") or [] if f.get("name")]
            schema = {"type": "object", "properties": {f["name"]: {"type": {"integer": "integer", "double": "number", "boolean": "boolean"}.get(f.get("type"), "string")} for f in fields},
                      "required": [f["name"] for f in fields]}
        return pipeline_ai.chat(model, "Give the final answer in the requested form.", f"{prompt}\n\nTool calls:\n" + "\n".join(transcript) + f"\n\nDraft answer: {json.dumps(answer, ensure_ascii=False, default=str)}", schema, 0.0, int(c.get("max_tokens") or 2000))


    def _turn(self, model: str, system: str, messages: list[dict], decls: Optional[list[dict]], c: dict, choice: str = "auto") -> dict:
        """One model turn; with a reader its text streams as "model" events."""
        import pipeline_ai

        nid, turn = self.node_id, len(self.llm_info["turns"]) + 1
        on_text = (lambda text: self._emit("model", {"node": nid, "turn": turn, "text": text})) if self.emit is not None else None
        if self.cancel is not None and self.cancel.is_set():
            raise RuntimeError("stopped: the preview was closed")
        try:
            res = pipeline_ai.chat_tools(model, system, messages, decls, float(c.get("temperature") or 0), int(c.get("max_tokens") or 2000), choice,
                                         on_text=on_text, cancel=self.cancel)
        except pipeline_ai.StreamCancelled as e:  # the reader went away in the middle of the model's answer
            raise RuntimeError("stopped: the preview was closed") from e
        self.llm_info["turns"].append({"turn": turn, "text": (res.get("text") or "")[:4000], "tool_calls": [t["name"] for t in res.get("tool_calls") or []]})
        return res

    def _native_loop(self, c: dict, scope: dict, tools: list[dict], model: str, limit: int, system: str, prompt: str, transcript: list[str]) -> tuple[Any, bool]:
        decls = [{"name": t["name"], "description": t["about"], "parameters": t["schema"]} for t in tools] or None
        by = {t["name"]: t for t in tools}
        messages: list[dict] = [{"role": "user", "text": prompt}]
        used = 0
        for turn in range(limit + 1):
            last = used >= limit or turn == limit
            if last and used:
                messages.append({"role": "user", "text": "You used every tool call: give your final answer now, without tools."})
            res = self._turn(model, system, messages, decls, c, "none" if last and decls else "auto")
            if not res["tool_calls"]:
                return res["text"], True
            if last:
                return (res["text"] or None), False
            messages.append(res["message"])
            calls = self._run_calls([{"id": t["id"], "name": t["name"], "args": t["args"], "raw_args": t.get("raw_args")} for t in res["tool_calls"]],
                                    by, scope, limit - used, transcript)
            used += len(calls)
            for t, call in zip(res["tool_calls"], calls):
                payload: Any = {"error": call["error"]} if "error" in call else call.pop("_full", call.get("result"))
                s = json.dumps(payload, ensure_ascii=False, default=str)
                messages.append({"role": "tool", "id": t["id"], "provider_id": t.get("provider_id"), "name": t["name"],
                                 "result": payload if len(s) <= 12000 else {"result (cut)": s[:12000]}})
        return None, False

    def _json_loop(self, c: dict, scope: dict, tools: list[dict], model: str, limit: int, system: str, prompt: str, transcript: list[str]) -> tuple[Any, bool]:
        by = {t["name"]: t for t in tools}
        system = (system + "\n\n" if system else "") + (
            "You can call tools before answering. Reply with JSON only, one of:\n"
            '{"tool": "<tool name>", "args": {...}}  to call a tool (you will get its result),\n'
            '{"calls": [{"tool": "<tool name>", "args": {...}}, ...]}  to call several independent tools at once, or\n'
            '{"answer": <your final answer>}  when you are done.\nTools:\n'
            + "\n".join(f"- {t['name']}: {t['about']}; args {json.dumps(t['args'], ensure_ascii=False)}" for t in tools))
        used = 0
        for turn in range(limit + 1):
            text = prompt + ("\n\nTool calls so far:\n" + "\n".join(transcript) if transcript else "")
            if used >= limit:
                text += "\n\nYou used every tool call: answer now."
            raw = self._turn(model, system, [{"role": "user", "text": text}], None, c)["text"]
            msg = _json_reply(raw)
            if not isinstance(msg, dict) or not ({"tool", "calls", "answer"} & msg.keys()):
                return raw, True
            if "answer" in msg:
                return msg.get("answer", raw), True
            if used >= limit or turn == limit:
                return None, False
            asked = msg["calls"] if isinstance(msg.get("calls"), list) else [msg]
            pending = []
            for i, x in enumerate(asked[:20]):
                x = x if isinstance(x, dict) else {}
                args = x.get("args", {})
                pending.append({"id": f"json-{turn + 1}-{i + 1}", "name": str(x.get("tool") or ""), "args": args if isinstance(args, dict) else None,
                                "raw_args": json.dumps(args, ensure_ascii=False, default=str)})
            used += len(self._run_calls(pending, by, scope, limit - used, transcript))
        return None, False

    def _run_calls(self, asked: list[dict], by: dict, scope: dict, remaining: int, transcript: list[str]) -> list[dict]:
        """The tool calls of one model turn. Unknown tools, arguments that are not a JSON object or name unknown
        arguments, and calls past the node's limit are refused (not run; the model gets the error). The others run
        independently — object queries and functions in parallel, then actions one at a time (in the preview sandbox
        when previewing) — and are recorded in the order the model asked for them."""
        turn = len(self.llm_info.get("turns") or [])
        calls: list[dict] = []
        for i, a in enumerate(asked):
            args = a.get("args")
            call: dict[str, Any] = {"tool": a["name"], "args": args if isinstance(args, dict) else a.get("raw_args"), "turn": turn}
            if len(asked) > 1:
                call["parallel"] = len(asked)
            tool = by.get(a["name"])
            if i >= remaining:
                call["error"] = "refused: over the node's limit of tool calls"
            elif not tool:
                call["error"] = f'refused: "{a["name"]}" is not one of the tools ({", ".join(by) or "none"})'
            elif not isinstance(args, dict):
                call["error"] = f"refused: the arguments are not a JSON object: {str(a.get('raw_args') or '')[:200]}"
            else:
                extra = [k for k in args if k not in (tool["schema"].get("properties") or {})]
                if extra:
                    call["error"] = f"refused: unknown arguments {', '.join(extra)} (allowed: {', '.join(tool['schema'].get('properties') or {}) or 'none'})"
            calls.append(call)

        def run_one(call: dict) -> None:
            t0 = time.monotonic()
            try:
                result = self._call_tool(by[call["tool"]], call["args"], scope)
                call["result"] = _clip(result)
                call["_full"] = result
            except Exception as e:  # noqa: BLE001 - the model sees the error and may try again
                call["error"] = str(getattr(e, "detail", None) or e)[:500]
            call["ms"] = round((time.monotonic() - t0) * 1000)

        ok = [x for x in calls if "error" not in x]
        reads = [x for x in ok if by[x["tool"]]["kind"] != "action"]
        if len(reads) > 1:
            # each call in a copy of this thread's context: the user, the preview sandbox and the request's audit follow it
            ctxs = [contextvars.copy_context() for _ in reads]
            with ThreadPoolExecutor(max_workers=min(4, len(reads)), thread_name_prefix="wb-tool") as ex:
                list(ex.map(lambda p: p[0].run(run_one, p[1]), zip(ctxs, reads)))
        else:
            for x in reads:
                run_one(x)
        for x in ok:
            if by[x["tool"]]["kind"] == "action":
                run_one(x)
        nid = self.node_id
        for call in calls:
            shown = json.dumps(call["args"], ensure_ascii=False, default=str)
            if "error" in call:
                transcript.append(f"{call['tool']}({shown}) → ERROR {call['error']}")
            else:
                transcript.append(f"{call['tool']}({shown}) → {json.dumps(call.get('_full'), ensure_ascii=False, default=str)[:6000]}")
            self.calls.append({k: v for k, v in call.items() if k != "_full"})
            self._emit("tool_call", {"node": nid, "call": self.calls[-1]})
        return calls


def _json_type(t: Any, label: Any = None) -> dict:
    """A function input's or action parameter's type → the JSON Schema the model sees."""
    s = str(t or "string").strip()
    low = s.lower()
    m = re.fullmatch(r"(?:array|list|set)\s*[<\[(]\s*(.+?)\s*[>\])]", low) or re.fullmatch(r"(.+)\[\]", low)
    if m:
        return {"type": "array", "items": _json_type(m.group(1))}
    if low in ("integer", "int", "long", "short", "byte"):
        out: dict[str, Any] = {"type": "integer"}
    elif low in ("double", "float", "decimal", "number"):
        out = {"type": "number"}
    elif low in ("boolean", "bool"):
        out = {"type": "boolean"}
    elif low == "object" or low.startswith("object"):
        out = {"type": "string", "description": f"the primary key of the {label or 'object'}"}
    elif low in ("string", "str", "text"):
        out = {"type": "string"}
    else:
        out = {"type": "string", "description": s}
    if label and "description" not in out:
        out["description"] = str(label)
    return out


def _json_reply(raw: Any) -> Any:
    """A model's JSON reply (also inside ``` fences or with text around it), else None."""
    if isinstance(raw, (dict, list)):
        return raw
    t = str(raw or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    for cand in (t, t[t.find("{"): t.rfind("}") + 1] if "{" in t else ""):
        try:
            return json.loads(cand)
        except ValueError:
            continue
    return None


def _obj(type_id: str, pk: str) -> dict:
    import ontology

    o = ontology.get_object(type_id, pk)
    return {**o["properties"], "__pk": o["primary_key"], "primaryKey": o["primary_key"], "__title": o.get("title")}


def run_workflow(doc: dict, start: str, inputs: dict, preview: bool, emit: Any = None, cancel: Any = None) -> dict:
    """One run from a trigger or subgraph node. Preview: inside a hidden staged-writes scenario, edits listed, nothing on main.
    emit(kind, payload), when given, gets the run as it happens ("node", "step", "model" text so far, "tool_call");
    cancel (a threading.Event) stops it at the next node or model turn."""
    r = Run(doc, {p["name"]: p["value"] for p in doc.get("params") or []})
    r.preview = preview
    r.emit, r.cancel = emit, cancel
    node = r.nodes.get(start)
    if not node or node["type"] not in ("trigger", "subgraph"):
        raise HTTPException(422, "a run starts at a trigger or a subgraph node")
    scope: dict[str, Any] = {"params": r.params, **inputs}
    t0 = time.monotonic()
    out: dict[str, Any] = {"id": f"run-{uuid.uuid4().hex[:10]}", "at": _now(), "start": start, "inputs": {k: (v.get("__pk") if isinstance(v, dict) else v) for k, v in inputs.items()},
                           "preview": preview, "status": "succeeded", "error": None}
    token = _running.set(_running.get() + 1)
    sid = None
    try:
        if preview:
            import ontology_scenarios

            sid = ontology_scenarios.staged_begin(None)["id"]
            try:
                with ontology_scenarios.active(sid):
                    r.chain(r.next_of(start), scope)
            finally:
                out["edits"] = _staged_edits(sid)
        else:
            r.chain(r.next_of(start), scope)
    except Exception as e:  # noqa: BLE001
        out["status"], out["error"] = "failed", getattr(e, "detail", None) or str(e)
    finally:
        _running.reset(token)
        if sid:
            import ontology_scenarios

            _safe(lambda: ontology_scenarios.staged_end(sid), None)
    out["path"] = [{**s, "value": _clip(s.get("value"))} for s in r.path]
    out["ms"] = round((time.monotonic() - t0) * 1000)
    return out


def _clip(v: Any) -> Any:
    s = json.dumps(v, ensure_ascii=False, default=str)
    return v if len(s) < 4000 else s[:4000] + "…"


def _staged_edits(sid: str) -> list[dict]:
    """The sandbox's edits against main (read outside the scenario, through the caller's property policies)."""
    import ontology
    import ontology_scenarios

    sc = _safe(lambda: ontology_scenarios._load(sid), {}) or {}
    out = []
    for tid, objs in (sc.get("objects") or {}).items():
        t = _safe(lambda tid=tid: ontology._object_type(tid), {}) or {}
        for pk, o in (objs or {}).items():
            op = (o or {}).get("op") or "modify"
            before = _safe(lambda tid=tid, pk=pk: ontology.get_object(tid, pk)["properties"], {}) if op != "create" else {}
            changes = {k: {"from": before.get(k), "to": v} for k, v in ((o or {}).get("properties") or {}).items() if op == "create" or k in before}
            out.append({"object_type_id": tid, "object_type": t.get("display_name"), "primary_key": pk, "op": op, "changes": changes})
    return out


# ------------------------------------------------------------------------------------------------
# previews and runs
# ------------------------------------------------------------------------------------------------


class PreviewIn(BaseModel):
    doc: dict
    start: str
    primary_keys: list[str] = Field(default_factory=list, max_length=25)
    inputs: dict = Field(default_factory=dict)


@router.post("/graphs/{gid}/preview")
def preview(gid: str, req: PreviewIn) -> list[dict]:
    """Run the (unsaved) graph on real objects in a sandbox; each object's path, node values and the edits it would make."""
    g = _graph(gid)
    _access(g)
    doc = check(req.doc)
    return [run_workflow(doc, req.start, inp, True) for inp in _preview_targets(doc, req)]


def _preview_targets(doc: dict, req: PreviewIn) -> list[dict]:
    start = next((n for n in doc["nodes"] if n["id"] == req.start), None)
    if not start:
        raise HTTPException(404, "start node not found")
    tid = start["config"].get("object_type_id")
    if start["type"] == "trigger" and tid and req.primary_keys:
        return [{"object": _obj(tid, pk)} for pk in req.primary_keys]
    return [dict(req.inputs)]


def _stream_runs(request: Request, targets: list[dict], one: Any) -> Any:
    """Runs as server-sent events (the SSE helper of solution_designer.py): per run "run_start", then its "node" / "step"
    events as each node starts and ends, "model" with a Use LLM turn's text as the model writes it and "tool_call" as each
    call returns (all carrying the run's index), "run" when it ends; then "result", the list the plain route returns."""
    import solution_designer

    def work(emit: Any, cancel: Any, _hold: dict) -> list[dict]:
        out = []
        for i, inp in enumerate(targets):
            emit("run_start", {"index": i, "inputs": {k: (v.get("__pk") if isinstance(v, dict) else v) for k, v in inp.items()}})
            r = one(inp, lambda kind, payload, i=i: emit(kind, {**payload, "index": i}), cancel)
            emit("run", {"index": i, "result": r})
            out.append(r)
        return out

    return solution_designer._sse(request, work)


@router.post("/graphs/{gid}/preview/stream")
def preview_stream(gid: str, req: PreviewIn, request: Request) -> Any:
    """The preview, streamed (see _stream_runs). Closing the stream stops the runs at their next node or model turn; their
    sandboxes are dropped as always."""
    g = _graph(gid)
    _access(g)
    doc = check(req.doc)
    targets = _preview_targets(doc, req)
    return _stream_runs(request, targets, lambda inp, emit, cancel: run_workflow(doc, req.start, inp, True, emit, cancel))


def _runs_path(gid: str) -> Path:
    return DIR / "runs" / f"{gid}.json"


def _record(gid: str, run: dict) -> None:
    with _lock:
        runs = _rd(_runs_path(gid), []) or []
        runs.insert(0, run)
        _wr(_runs_path(gid), runs[:500])


@router.get("/graphs/{gid}/runs")
def runs(gid: str) -> list[dict]:
    g = _graph(gid)
    _access(g)
    return _rd(_runs_path(gid), []) or []


class ExecIn(BaseModel):
    start: str
    primary_keys: list[str] = Field(default_factory=list, max_length=100)
    inputs: dict = Field(default_factory=dict)


@router.post("/graphs/{gid}/execute")
def execute(gid: str, req: ExecIn) -> list[dict]:
    """Run the saved workflow for real (on main), now, on objects or inputs."""
    g = _graph(gid)
    _access(g, "editor")
    start = next((n for n in g["doc"]["nodes"] if n["id"] == req.start), None)
    if not start:
        raise HTTPException(404, "start node not found")
    out = []
    tid = start["config"].get("object_type_id")
    targets = [{"object": _obj(tid, pk)} for pk in req.primary_keys] if tid and req.primary_keys else [dict(req.inputs)]
    for inp in targets:
        run = run_workflow(g["doc"], req.start, inp, False) | {"trigger": "manual", "by": _me().get("id"), "version": g["version"]}
        _record(gid, run)
        out.append(run)
    return out


@router.post("/graphs/{gid}/execute/stream")
def execute_stream(gid: str, req: ExecIn, request: Request) -> Any:
    """Workflow execution, streamed (see _stream_runs). A run on main is not stopped when the stream closes: it finishes
    and is recorded."""
    g = _graph(gid)
    _access(g, "editor")
    start = next((n for n in g["doc"]["nodes"] if n["id"] == req.start), None)
    if not start:
        raise HTTPException(404, "start node not found")
    tid = start["config"].get("object_type_id")
    targets = [{"object": _obj(tid, pk)} for pk in req.primary_keys] if tid and req.primary_keys else [dict(req.inputs)]
    by = _me().get("id")

    def one(inp: dict, emit: Any, _cancel: Any) -> dict:
        run = run_workflow(g["doc"], req.start, inp, False, emit) | {"trigger": "manual", "by": by, "version": g["version"]}
        _record(gid, run)
        return run

    return _stream_runs(request, targets, one)


class DeployIn(BaseModel):
    start: str
    enabled: bool


@router.post("/graphs/{gid}/deploy")
def deploy(gid: str, req: DeployIn) -> dict:
    """Turn a workflow's trigger on or off (it runs as you, on the saved version)."""
    with _lock:
        g = _graph(gid)
        _access(g, "editor")
        start = next((n for n in g["doc"]["nodes"] if n["id"] == req.start and n["type"] == "trigger"), None)
        if not start:
            raise HTTPException(404, "trigger node not found")
        mode = start["config"].get("mode") or "manual"
        if req.enabled and mode == "manual":
            raise HTTPException(422, "a manual trigger runs only from Workflow execution: choose objects or a schedule to deploy it")
        if req.enabled and mode == "object" and not start["config"].get("object_type_id"):
            raise HTTPException(422, "choose the trigger's object type")
        g.setdefault("deployed", {})[req.start] = {"enabled": req.enabled, "by": _me().get("id"), "at": _now(), "version": g["version"], "last_scheduled": None}
        _wr(_gpath(gid), g)
    if req.enabled:
        _seed(g, req.start)
    return get_graph(gid)


# ------------------------------------------------------------------------------------------------
# live triggers
# ------------------------------------------------------------------------------------------------


def _principal(user_id: str) -> Optional[dict]:
    try:
        u = auth._user(user_id)
    except HTTPException:
        return None
    if u.get("disabled"):
        return None
    return {**auth._public_user(u), "markings": auth.user_markings(u), "service": False}


def _hidden_from_owner(g: dict, start: str, inputs: dict) -> Optional[str]:
    """Why the current principal (the deployer) may not see what an object trigger fired for; None: it may."""
    import ontology

    node = next((n for n in g["doc"]["nodes"] if n["id"] == start), None)
    c = (node or {}).get("config") or {}
    if c.get("mode") != "object" or not c.get("object_type_id"):
        return None
    try:
        t = ontology._object_type(c["object_type_id"])
    except HTTPException as e:
        return f"the trigger's deployer can no longer see the object type it watches ({e.detail}): deploy it again as someone who may"
    obj = inputs.get("object") or {}
    if obj and not ontology._can_see(t, {"properties": {k: v for k, v in obj.items() if k not in ("__pk", "primaryKey")}}):
        return "the trigger's deployer may not see the object that changed (its control properties or security policy)"
    return None


def _run_as(gid: str, start: str, inputs: dict, trigger: str, user_id: str) -> None:
    who = _principal(user_id) if user_id and user_id != "local" else None
    if who is None and auth.enabled():
        # whoever deployed the trigger no longer exists or is deactivated: the run never falls back to the system
        import run_as

        try:
            run_as.owner_principal(user_id or None, "the deployed trigger")
            why = "the deployed trigger's owner cannot be acted for: deploy it again"
        except run_as.OwnerUnavailable as e:
            why = str(e).replace("an Editor must take it over (edit and save it)", "deploy it again as someone who may run it")
        _record(gid, {"id": f"run-{uuid.uuid4().hex[:10]}", "at": _now(), "start": start, "inputs": {k: (v.get("__pk") if isinstance(v, dict) else v) for k, v in inputs.items()},
                      "preview": False, "status": "failed", "error": f"did not run: {why}", "trigger": trigger, "by": user_id})
        return
    token = auth._principal.set(who) if who else None
    try:
        g = _graph(gid)
        hidden = _hidden_from_owner(g, start, inputs) if who else None
        if hidden:
            # an object trigger fired for an object (or object type) the deployer can no longer see: its properties
            # are never handed to the run
            _record(gid, {"id": f"run-{uuid.uuid4().hex[:10]}", "at": _now(), "start": start, "inputs": {}, "preview": False, "status": "failed",
                          "error": f"did not run: {hidden}", "trigger": trigger, "by": user_id})
            return
        run = run_workflow(g["doc"], start, inputs, False) | {"trigger": trigger, "by": user_id, "version": g["version"]}
        _record(gid, run)
    except Exception as e:  # noqa: BLE001
        log.exception("workflow-builder: run failed to start")
        try:
            _record(gid, {"id": f"run-{uuid.uuid4().hex[:10]}", "at": _now(), "start": start, "inputs": {}, "preview": False, "status": "failed",
                          "error": f"did not run: {getattr(e, 'detail', None) or e}", "trigger": trigger, "by": user_id})
        except Exception:  # noqa: BLE001
            pass
    finally:
        if token is not None:
            auth._principal.reset(token)


_last_values: dict[tuple, dict[str, str]] = {}


def _seed(g: dict, start: str) -> None:
    """Remember the watched property's current values, so the first edit after a deploy or a restart compares to them."""
    import ontology

    node = next((n for n in g["doc"]["nodes"] if n["id"] == start), None)
    c = (node or {}).get("config") or {}
    if c.get("mode") != "object" or not c.get("property") or not c.get("object_type_id"):
        return
    objs = _safe(lambda: ontology.load_objects(c["object_type_id"]), {}) or {}
    _last_values[(g["id"], start)] = {str(pk): json.dumps((o.get("properties") or {}).get(c["property"]), default=str) for pk, o in objs.items()}


def on_edits(written: list[dict]) -> None:
    """Object edits on main fire the deployed object triggers that match them (not while a workflow run is editing)."""
    if _running.get() > 0 or not written:
        return
    for g in _all():
        for start, dep in (g.get("deployed") or {}).items():
            if not dep.get("enabled"):
                continue
            node = next((n for n in g["doc"]["nodes"] if n["id"] == start and n["type"] == "trigger"), None)
            c = (node or {}).get("config") or {}
            if not node or c.get("mode") != "object":
                continue
            kinds = set(c.get("on") or ["added", "modified"])
            for w in written:
                if w.get("object_type_id") != c.get("object_type_id"):
                    continue
                op = "added" if w.get("op") == "create" else "modified" if w.get("op") == "modify" else None
                if op not in kinds:
                    continue
                pk = str(w.get("primary_key"))
                if c.get("property"):
                    # only when the property's value changed (the last value seen per object is remembered)
                    seen = _last_values.setdefault((g["id"], start), {})
                    val = json.dumps((w.get("properties") or {}).get(c["property"]), default=str)
                    if op == "modified" and seen.get(pk, None) == val:
                        continue
                    seen[pk] = val
                obj = {**(w.get("properties") or {}), "__pk": pk, "primaryKey": pk}
                _pool.submit(_run_as, g["id"], start, {"object": obj}, f"object {op}", dep.get("by") or "")


def _in_chain(h: Any, depth: int = 0) -> bool:
    """Whether our trigger hook is the edits hook or wrapped inside it (other modules chain the previous hook)."""
    if h is None or depth > 8:
        return False
    if getattr(h, "_workflow_builder", False):
        return True
    return any(callable(c.cell_contents) and _in_chain(c.cell_contents, depth + 1) for c in (getattr(h, "__closure__", None) or []) if _cell_ok(c))


def _cell_ok(c: Any) -> bool:
    try:
        c.cell_contents
        return True
    except ValueError:
        return False


def _install_hook() -> None:
    """Chain into ontology.MODEL_HOOKS["edits"]. Some modules set that slot at startup without chaining, so this runs again
    from the scheduler until our hook is in the chain."""
    import ontology

    prev = ontology.MODEL_HOOKS.get("edits")
    if _in_chain(prev):
        return

    def hook(written: list[dict]) -> Any:
        res = prev(written) if prev else None
        try:
            on_edits(written)
        except Exception:  # noqa: BLE001 - triggers never break an edit
            log.exception("workflow-builder: trigger dispatch failed")
        return res

    hook._workflow_builder = True  # type: ignore[attr-defined]
    hook._peering = getattr(prev, "_peering", False)  # type: ignore[attr-defined]
    ontology.MODEL_HOOKS["edits"] = hook


def _scheduler() -> None:
    time.sleep(3)
    while True:
        _safe(_install_hook, None)
        try:
            now = datetime.now(timezone.utc)
            for g in _all():
                changed = False
                for start, dep in (g.get("deployed") or {}).items():
                    node = next((n for n in g["doc"]["nodes"] if n["id"] == start and n["type"] == "trigger"), None)
                    c = (node or {}).get("config") or {}
                    if not dep.get("enabled") or c.get("mode") != "schedule":
                        continue
                    every = max(1, int(c.get("every_minutes") or 60))
                    last = dep.get("last_scheduled")
                    if last and datetime.fromisoformat(last) + timedelta(minutes=every) > now:
                        continue
                    dep["last_scheduled"] = now.isoformat(timespec="seconds")
                    changed = True
                    _pool.submit(_run_as, g["id"], start, {}, "schedule", dep.get("by") or "")
                if changed:
                    with _lock:
                        cur = _rd(_gpath(g["id"])) or g
                        cur["deployed"] = {**(cur.get("deployed") or {}), **{k: v for k, v in g["deployed"].items()}}
                        _wr(_gpath(g["id"]), cur)
        except Exception:  # noqa: BLE001
            log.exception("workflow-builder: scheduler")
        time.sleep(30)


# ------------------------------------------------------------------------------------------------
# workflow objects and the catalogs the editor needs
# ------------------------------------------------------------------------------------------------


@router.get("/graphs/{gid}/objects")
def workflow_objects(gid: str, type_id: str, q: str = "", limit: int = 200) -> dict:
    import ontology

    g = _graph(gid)
    _access(g)
    res = ontology.list_objects(type_id, q, max(1, min(limit, 1000)))
    last: dict[str, dict] = {}
    for r in _rd(_runs_path(gid), []) or []:
        pk = str((r.get("inputs") or {}).get("object") or "")
        if pk and pk not in last:
            last[pk] = {"at": r["at"], "status": r["status"], "path": [s["node"] for s in r.get("path") or []]}
    return {"total": res["total"], "objects": [{"primary_key": o["primary_key"], "title": o.get("title"), "properties": o["properties"], "last_run": last.get(str(o["primary_key"]))} for o in res["objects"]]}


@router.get("/catalog")
def catalog() -> dict:
    import knowledge
    import ontology

    types = ontology.list_object_types()
    acts = ontology.list_action_types()
    fns = _safe(lambda: __import__("functions_registry").list_functions(), [])
    users = [{"id": u["id"], "name": u.get("display_name") or u.get("username")} for u in auth._users() if not u.get("disabled")]
    return {"object_types": [{"id": t["id"], "name": t["display_name"], "properties": [{"api_name": p["api_name"], "name": p.get("display_name"), "type": p.get("type")} for p in t["properties"]]} for t in types],
            "action_types": [{"id": a["id"], "name": a["display_name"], "object_type_id": a.get("object_type_id"), "parameters": [{"id": p["id"], "name": p.get("display_name"), "type": p.get("type"), "required": p.get("required")} for p in a.get("parameters") or []]} for a in acts],
            "functions": [{"id": f["id"], "name": f.get("api_name") or f["name"], "inputs": f.get("inputs"), "output": f.get("output"), "version": f.get("version")} for f in fns],
            "models": [m for m in knowledge.models() if m.get("available")], "users": users}

