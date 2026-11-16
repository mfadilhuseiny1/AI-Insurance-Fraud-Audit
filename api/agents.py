"""AIP Agent Studio: chat assistants grounded in the ontology (see ontology.py), like Foundry's app.

An agent has a model, instructions, retrieval context and tools:
- context: object types. "Full object retrieval" puts every object of the type in the prompt (up to
  FULL_CONTEXT_CHARS; past that the agent is told to use its tools); "Tools only" lists just the schema.
- tools: semantic search (Ontology semantic search over embeddings, fused with keyword search), search objects
  (filters, text search, sort), aggregate (count / sum / avg / min / max, grouped),
  get one object, apply chosen action types, and run chosen AIP Logic functions.

Each turn is a loop: the model answers in JSON with either a tool call or the final answer, tool results
go back into the conversation, at most MAX_STEPS times. Answers cite objects as [[<object type API
name>:<primary key>]]; the citations are resolved to objects so the UI can link them. Sessions keep the
messages with the steps taken. Records are JSON files in data/ontology/agents/ and agent-sessions/.

Mounted by server.py under /api/agents.
"""

from __future__ import annotations

import contextvars
import json
import logging
import math
import queue
import re
import threading
import time
from datetime import date, datetime
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import pipeline_ai

log = logging.getLogger("bluesandai.agents")
router = APIRouter(prefix="/api/agents")

MAX_STEPS = 8
FULL_CONTEXT_CHARS = 60_000
TOOL_RESULT_CHARS = 12_000
HISTORY_MESSAGES = 20
SEARCH_LIMIT = 50
CITE = re.compile(r"\[\[([A-Za-z][A-Za-z0-9_]*):([^\]\n]{1,200})\]\]")
OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null")
TOOLS = {
    "search_objects": "Find objects of a type. Arguments: {object_type, query?, filters?: [{property, op, value}], "
    "sort_by?, descending?, limit? (max 50), properties?: [names to return]}. op is one of " + ", ".join(OPS) + ".",
    "aggregate": "Compute over objects of a type. Arguments: {object_type, metric: count|sum|avg|min|max|distinct, "
    "property? (not for count), group_by?, filters?}. Returns the value, or one value per group (top 50).",
    "get_object": "One object with all its properties. Arguments: {object_type, primary_key}.",
    "semantic_search": "Find the objects whose meaning is closest to a natural-language query (k nearest neighbors on an embedding, "
    "fused with keyword search). Arguments: {object_type, query, k? (max 50)}. Results are most relevant first; put quotes around the query text.",
    "apply_action": "Create, modify or delete objects. Arguments: {action, parameters: {parameter id: value}}.",
    "run_logic": "Run an AIP Logic function. Arguments: {function, inputs: {input name: value}}.",
    "set_variable": "Set a writable Workshop variable of the user's application (the module shows the new value). "
    "Arguments: {variable, value} — the value in the variable's type.",
}


def _dir(name: str):
    d = ontology.DIR / name
    d.mkdir(parents=True, exist_ok=True)
    return d


# ------------------------------------------------------------------------------------------------
# agents
# ------------------------------------------------------------------------------------------------


class AgentIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    model: Optional[str] = None
    instructions: Optional[str] = Field(None, max_length=20000)
    # [{object_type_id, mode: full | tools}]
    contexts: Optional[list[dict]] = None
    # {search: bool, aggregate: bool, actions: [action type ids], logic: [function ids], apply_logic_edits: bool,
    #  semantic: [{object_type_id, vector_property?, k?, mode?}] (the "Ontology semantic search" tool)}
    tools: Optional[dict] = None
    citations: Optional[bool] = None
    temperature: Optional[float] = Field(None, ge=0, le=2)
    starters: Optional[list[str]] = None


def _agent(agent_id: str, need: str = "viewer") -> dict:
    """An agent the caller has the role `need` on (the roles of its ontology, as object types)."""
    rec = ontology._get("agents", agent_id, "agent")
    _role(rec, need)
    return rec


def _role(rec: dict, need: str) -> None:
    import ontology_model

    ontology_model.require_role(rec.get("ontology_id"), need, rec, "edit this agent" if need != "viewer" else "use this agent")


def _mine(s: dict) -> bool:
    """A conversation is its creator's (those made before owners were recorded are everyone's)."""
    owner = s.get("created_by")
    return not owner or not auth.enabled() or owner == auth.actor_id() or (auth.current() or {}).get("service")


def _check(rec: dict) -> None:
    for c in rec["contexts"]:
        ontology._object_type(c.get("object_type_id") or "")
        if c.get("mode") not in ("full", "tools"):
            c["mode"] = "full"
    for a in rec["tools"].get("actions", []):
        ontology._action_type(a)
    for f in rec["tools"].get("logic", []):
        ontology._logic(f)
    for x in rec["tools"].get("semantic", []) or []:
        t = ontology._object_type(x.get("object_type_id") or "")
        if not any(p["type"] == "vector" for p in t["properties"]):
            raise HTTPException(400, f"{t['display_name']} has no vector (embedding) property for semantic search")


def _summary(rec: dict) -> dict:
    sessions = list((_dir("agent-sessions") / rec["id"]).glob("*.json")) if (_dir("agent-sessions") / rec["id"]).exists() else []
    return {**rec, "session_count": len(sessions)}


@router.get("")
def list_agents() -> list[dict]:
    _dir("agents")
    import ontology_model

    return [_summary(a) for a in ontology._all("agents") if ontology_model.discoverable(a)]


@router.post("")
def create_agent(req: AgentIn) -> dict:
    _dir("agents")
    rec = {
        "id": ontology._new_id("agent"),
        "name": (req.name or "Untitled agent").strip(),
        "description": (req.description or "").strip(),
        "model": req.model or ontology.DEFAULT_LLM,
        "instructions": req.instructions or "",
        "contexts": req.contexts or [],
        "tools": req.tools or {"search": True, "aggregate": True, "actions": [], "logic": [], "apply_logic_edits": False},
        "citations": True if req.citations is None else req.citations,
        "temperature": req.temperature or 0,
        "starters": req.starters or [],
        "created_at": ontology._now(),
        "created_by": auth.actor_id(),
    }
    _role(rec, "editor")
    _check(rec)
    return _summary(ontology._put("agents", rec))


@router.get("/{agent_id}")
def get_agent(agent_id: str) -> dict:
    return _summary(_agent(agent_id))


@router.put("/{agent_id}")
def save_agent(agent_id: str, req: AgentIn) -> dict:
    rec = _agent(agent_id, "editor")
    for k, v in req.model_dump(exclude_unset=True).items():
        if v is not None:
            rec[k] = v.strip() if isinstance(v, str) and k != "instructions" else v
    _check(rec)
    return _summary(ontology._put("agents", rec))


@router.delete("/{agent_id}")
def delete_agent(agent_id: str) -> dict:
    _agent(agent_id, "editor")
    ontology._path("agents", agent_id).unlink(missing_ok=True)
    folder = _dir("agent-sessions") / agent_id
    if folder.exists():
        for p in folder.glob("*.json"):
            p.unlink()
        folder.rmdir()
    return {"deleted": agent_id}


# ------------------------------------------------------------------------------------------------
# sessions
# ------------------------------------------------------------------------------------------------


def _session_path(agent_id: str, session_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", session_id):
        raise HTTPException(404, "session not found")
    folder = _dir("agent-sessions") / agent_id
    folder.mkdir(exist_ok=True)
    return folder / f"{session_id}.json"


def _session(agent_id: str, session_id: str) -> dict:
    _agent(agent_id)
    s = ontology._read(_session_path(agent_id, session_id))
    if not s or not _mine(s):
        raise HTTPException(404, "session not found")
    return s


@router.get("/{agent_id}/sessions")
def list_sessions(agent_id: str) -> list[dict]:
    _agent(agent_id)
    folder = _dir("agent-sessions") / agent_id
    out = [ontology._read(p) for p in folder.glob("*.json")] if folder.exists() else []
    return sorted(({k: s[k] for k in ("id", "title", "created_at", "updated_at")} | {"messages": len(s["messages"])} for s in out if s and _mine(s)),
                  key=lambda s: s["updated_at"], reverse=True)


@router.post("/{agent_id}/sessions")
def create_session(agent_id: str) -> dict:
    _agent(agent_id)
    now = ontology._now()
    s = {"id": ontology._new_id("chat"), "agent_id": agent_id, "title": "New conversation", "messages": [], "created_at": now, "updated_at": now,
         "created_by": auth.actor_id()}
    ontology._write(_session_path(agent_id, s["id"]), s)
    return s


@router.get("/{agent_id}/sessions/{session_id}")
def get_session(agent_id: str, session_id: str) -> dict:
    return _session(agent_id, session_id)


@router.delete("/{agent_id}/sessions/{session_id}")
def delete_session(agent_id: str, session_id: str) -> dict:
    _session(agent_id, session_id)
    _session_path(agent_id, session_id).unlink(missing_ok=True)
    return {"deleted": session_id}


class Message(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    # application state: the values of the Workshop variables the widget shares, {name: {value, description, type?,
    # writable?}}; the agent may propose new values for the writable ones (set_variable), checked against their type
    app_state: Optional[dict] = None


def _turn_saved(agent_id: str, session_id: str, s: dict, user: dict, reply: dict) -> None:
    s["messages"] += [user, reply]
    if s["title"] == "New conversation":
        s["title"] = user["content"][:80]
    s["updated_at"] = ontology._now()
    ontology._write(_session_path(agent_id, session_id), s)


@router.post("/{agent_id}/sessions/{session_id}/messages")
def send_message(agent_id: str, session_id: str, req: Message) -> dict:
    agent = _agent(agent_id)
    s = _session(agent_id, session_id)
    user = {"role": "user", "content": req.content.strip(), "at": ontology._now()}
    reply = respond(agent, s["messages"], user["content"], req.app_state)
    _turn_saved(agent_id, session_id, s, user, reply)
    return reply


@router.post("/{agent_id}/sessions/{session_id}/messages/stream")
def send_message_stream(agent_id: str, session_id: str, req: Message) -> Any:
    """The turn as server-sent events while it happens: "step" after each tool call ({tool, arguments, ok}),
    "variable" for each variable value the agent set ({name, value}), "chunk" with each new piece of the answer as the
    model writes it, "reset" when the answer starts again (the text so far is void), then "result" (the saved reply, as
    the non-streaming route returns it)."""
    from fastapi.responses import StreamingResponse

    agent = _agent(agent_id)
    s = _session(agent_id, session_id)  # 404 / 403 before the stream starts
    user = {"role": "user", "content": req.content.strip(), "at": ontology._now()}
    q: "queue.Queue" = queue.Queue()

    def work() -> None:
        try:
            reply = respond(agent, s["messages"], user["content"], req.app_state, on_event=lambda kind, payload: q.put((kind, payload)))
            _turn_saved(agent_id, session_id, s, user, reply)
            q.put(("result", reply))
        except Exception as e:  # noqa: BLE001
            log.exception("agent %s stream failed", agent_id)
            q.put(("result", {"role": "assistant", "content": "", "error": str(e)[:500], "steps": [], "citations": [], "at": ontology._now()}))

    # the request's context (the signed-in user, its audit record) goes along to the worker thread
    threading.Thread(target=contextvars.copy_context().run, args=(work,), daemon=True).start()

    def events() -> Any:
        while True:
            kind, payload = q.get()
            yield f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
            if kind == "result":
                break

    return StreamingResponse(events(), media_type="text/event-stream")


# ------------------------------------------------------------------------------------------------
# the agent loop
# ------------------------------------------------------------------------------------------------


def _types_by_api() -> dict[str, dict]:
    return {t["api_name"]: t for t in auth.visible_resources("object_type", ontology._all("object-types"))}


def _type_arg(args: dict, allowed: set[str]) -> dict:
    name = str(args.get("object_type") or "")
    t = _types_by_api().get(name) or next((x for x in _types_by_api().values() if x["display_name"].lower() == name.lower()), None)
    if not t or t["id"] not in allowed:
        raise ValueError(f'unknown object type "{name}"; use one of: {", ".join(sorted(_api_names(allowed)))}')
    return t


def _api_names(allowed: set[str]) -> list[str]:
    return [t["api_name"] for t in _types_by_api().values() if t["id"] in allowed]


def _num(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None and v != "" and not isinstance(v, bool) else None
    except (TypeError, ValueError):
        return None


def _match(props: dict, f: dict) -> bool:
    v, op, want = props.get(f.get("property")), f.get("op", "eq"), f.get("value")
    if op == "is_null":
        return v in (None, "")
    if op == "not_null":
        return v not in (None, "")
    if op == "contains":
        return str(want).lower() in str(v if v is not None else "").lower()
    a, b = _num(v), _num(want)
    if op in ("gt", "gte", "lt", "lte"):
        if a is None or b is None:
            x, y = str(v if v is not None else ""), str(want)
        else:
            x, y = a, b
        return {"gt": x > y, "gte": x >= y, "lt": x < y, "lte": x <= y}[op]
    same = (a == b) if a is not None and b is not None else str(v).lower() == str(want).lower()
    return same if op == "eq" else not same


def _rows(t: dict, args: dict) -> list[dict]:
    rows = [ontology._public_object(t, pk, o) for pk, o in ontology._objects(t["id"]).items()]
    for f in args.get("filters") or []:
        if f.get("property") not in {p["api_name"] for p in t["properties"]}:
            raise ValueError(f'{t["api_name"]} has no property "{f.get("property")}"')
        rows = [r for r in rows if _match(r["properties"], f)]
    q = str(args.get("query") or "").strip().lower()
    if q:
        rows = [r for r in rows if any(q in str(v).lower() for v in r["properties"].values())]
    return rows


def _compact(t: dict, r: dict, only: Optional[list] = None) -> dict:
    props = {k: v for k, v in r["properties"].items() if not only or k in only}
    for p in t["properties"]:
        v = props.get(p["api_name"])
        if isinstance(v, str) and len(v) > 1500:
            props[p["api_name"]] = v[:1500] + f"… ({len(v)} chars; get_object for all)"
    return {"primary_key": r["primary_key"], **props}


def _tool(agent: dict, name: str, args: dict, cited: dict) -> Any:
    tools = agent["tools"]
    allowed = {c["object_type_id"] for c in agent["contexts"]} | {x["object_type_id"] for x in tools.get("semantic") or []}
    if name == "search_objects" and tools.get("search", True):
        t = _type_arg(args, allowed)
        rows = _rows(t, args)
        key = args.get("sort_by")
        if key:
            # objects without the value go last, whichever the direction
            have = [r for r in rows if r["properties"].get(key) not in (None, "")]
            empty = [r for r in rows if r["properties"].get(key) in (None, "")]
            numeric = all(_num(r["properties"][key]) is not None for r in have)
            have.sort(key=lambda r: _num(r["properties"][key]) if numeric else str(r["properties"][key]).lower(),
                      reverse=bool(args.get("descending")))
            rows = have + empty
        limit = max(1, min(int(args.get("limit") or 20), SEARCH_LIMIT))
        for r in rows[:limit]:
            cited[(t["api_name"], r["primary_key"])] = r
        return {"total": len(rows), "objects": [_compact(t, r, args.get("properties")) for r in rows[:limit]]}
    if name == "semantic_search" and tools.get("semantic"):
        import ontology_semantic

        t = _type_arg(args, allowed)
        cfg = next((x for x in tools["semantic"] if x.get("object_type_id") == t["id"]), None)
        if not cfg:
            raise ValueError(f"semantic search is not enabled on {t['api_name']}")
        k = max(1, min(int(args.get("k") or cfg.get("k") or 5), SEARCH_LIMIT))
        # semantic mode with a current ANN index reads only the top hits' records (rank_type / knn_fast)
        found, _ = ontology_semantic.rank_type(t, str(args.get("query") or ""), cfg.get("mode") or "hybrid", k, cfg.get("vector_property"))
        for r in found:
            cited[(t["api_name"], r["primary_key"])] = r
        return {"objects": [{**_compact(t, {**r, "properties": {k2: v for k2, v in r["properties"].items() if not isinstance(v, list) or len(v) < 64}}),
                             "relevance": r["relevance"]} for r in found]}
    if name == "aggregate" and tools.get("aggregate", True):
        t = _type_arg(args, allowed)
        rows = _rows(t, args)
        metric, prop, group = args.get("metric", "count"), args.get("property"), args.get("group_by")

        def calc(rs: list[dict]) -> Any:
            if metric == "count":
                return len(rs)
            vals = [r["properties"].get(prop) for r in rs if r["properties"].get(prop) not in (None, "")]
            if metric == "distinct":
                return len({json.dumps(v, sort_keys=True, default=str) for v in vals})
            nums = [n for n in (_num(v) for v in vals) if n is not None]
            if metric in ("min", "max") and not nums:
                return (min if metric == "min" else max)(map(str, vals)) if vals else None
            if not nums:
                return None
            return {"sum": sum(nums), "avg": sum(nums) / len(nums), "min": min(nums), "max": max(nums)}[metric]

        if metric != "count" and prop not in {p["api_name"] for p in t["properties"]}:
            raise ValueError(f'{t["api_name"]} has no property "{prop}"')
        if not group:
            return {"metric": metric, "property": prop, "value": calc(rows), "objects": len(rows)}
        groups: dict[str, list[dict]] = {}
        for r in rows:
            groups.setdefault(str(r["properties"].get(group)), []).append(r)
        out = sorted(({"group": g, "value": calc(rs), "objects": len(rs)} for g, rs in groups.items()),
                     key=lambda x: (_num(x["value"]) is None, -(_num(x["value"]) or 0)))
        return {"metric": metric, "property": prop, "group_by": group, "groups": out[:50], "group_count": len(out)}
    if name == "get_object" and (tools.get("search", True) or tools.get("aggregate", True)):
        t = _type_arg(args, allowed)
        key, o = ontology._find(t, args.get("primary_key"))
        r = ontology._public_object(t, key, o)
        cited[(t["api_name"], key)] = r
        return {"primary_key": key, **r["properties"]}
    if name == "apply_action":
        action = next((ontology._action_type(a) for a in tools.get("actions", []) if a == args.get("action")
                       or ontology._action_type(a)["api_name"] == args.get("action")
                       or ontology._action_type(a)["display_name"] == args.get("action")), None)
        if not action:
            raise ValueError("that action is not one of this agent's tools")
        # submission criteria, side effects and the action log apply as when a user submits the action
        edits = ontology.run_action(action, args.get("parameters") or {})
        for e in edits:
            if e["op"] != "delete":
                cited[(ontology._object_type(e["object_type_id"])["api_name"], e["primary_key"])] = e
        return {"applied": [{"op": e["op"], "primary_key": e["primary_key"]} for e in edits]}
    if name == "run_logic":
        fn = next((ontology._logic(f) for f in tools.get("logic", []) if f == args.get("function")
                   or ontology._logic(f)["name"] == args.get("function")), None)
        if not fn:
            raise ValueError("that function is not one of this agent's tools")
        res = ontology.run_logic(fn["id"], args.get("inputs") or {}, bool(tools.get("apply_logic_edits")),
                                 trigger={"automation_id": agent["id"], "automation": f"Agent · {agent['name']}"})
        if res["status"] != "succeeded":
            raise ValueError(res["error"])
        return {"output": res.get("output"), "edits": len(res.get("edits") or []), "applied": len(res.get("applied") or [])}
    raise ValueError(f'"{name}" is not one of the available tools')


def _schema_text(agent: dict) -> tuple[str, list[str]]:
    """The ontology part of the system prompt, and the tool names the agent can use."""
    parts: list[str] = []
    budget = FULL_CONTEXT_CHARS
    for c in agent["contexts"]:
        t = ontology._object_type(c["object_type_id"])
        props = ", ".join(f'{p["api_name"]} ({p["type"]}{", primary key" if p["api_name"] == t["primary_key"] else ""}) — {p["display_name"]}'
                          for p in t["properties"])
        objs = ontology._objects(t["id"])
        parts.append(f'## Object type {t["api_name"]} — "{t["display_name"]}" ({len(objs)} objects)\n'
                     + (f'{t["description"]}\n' if t["description"] else "") + f"Properties: {props}")
        if c.get("mode", "full") == "full" and objs:
            rows = [_compact(t, ontology._public_object(t, pk, o)) for pk, o in objs.items()]
            text = "\n".join(json.dumps(r, ensure_ascii=False, default=str) for r in rows)
            if len(text) <= budget:
                parts.append(f"All {len(rows)} {t['api_name']} objects (JSON lines):\n{text}")
                budget -= len(text)
            else:
                parts.append(f"Too many {t['api_name']} objects to list here: use the tools to look them up.")
    tools = []
    if agent["tools"].get("search", True):
        tools += ["search_objects", "get_object"]
    if agent["tools"].get("aggregate", True):
        tools.append("aggregate")
        if "get_object" not in tools:
            tools.append("get_object")
    if agent["tools"].get("semantic"):
        tools.append("semantic_search")
        if "get_object" not in tools:
            tools.append("get_object")
        parts.append("Semantic search is available on: " + ", ".join(ontology._object_type(x["object_type_id"])["api_name"] for x in agent["tools"]["semantic"]) + ".")
    if agent["tools"].get("actions"):
        tools.append("apply_action")
        acts = [ontology._action_type(a) for a in agent["tools"]["actions"]]
        parts.append("Actions you may apply:\n" + "\n".join(
            f'- "{a["display_name"]}" ({a["kind"]} {ontology._object_type(a["object_type_id"])["api_name"]}): parameters '
            + ", ".join(f'{p["id"]} ({p["type"]}{", required" if p["required"] else ""})' for p in a["parameters"]) for a in acts))
    if agent["tools"].get("logic"):
        tools.append("run_logic")
        fns = [ontology._logic(f) for f in agent["tools"]["logic"]]
        parts.append("AIP Logic functions you may run:\n" + "\n".join(
            f'- "{f["name"]}": {f["description"] or "no description"}; inputs '
            + ", ".join(f'{i["name"]} ({i["type"]}{" primary key" if i["type"] == "object" else ""})' for i in f["inputs"]) for f in fns))
    return "\n\n".join(parts), tools


def _system(agent: dict) -> tuple[str, list[str]]:
    ontology_text, tools = _schema_text(agent)
    cite = ("Cite the objects your answer relies on right after the fact, as [[ObjectTypeApiName:primaryKey]], "
            "e.g. [[Customer:CUST039346]]. Only cite objects you saw in the context or in tool results.\n"
            if agent.get("citations", True) else "")
    tool_text = "\n".join(f"- {n}: {TOOLS[n]}" for n in tools) or "(none)"
    return (
        f"{__import__('pipeline_ai').PLATFORM}\n\n"
        f"You are {agent['name']}, an assistant that answers questions about the user's ontology data.\n"
        + (f"\n# Instructions\n{agent['instructions']}\n" if agent["instructions"].strip() else "")
        + f"\n# Ontology\n{ontology_text or '(no object types in context)'}\n"
        + f"\n# Tools\n{tool_text}\n"
        + "\n# How to answer\nReply with JSON only: {\"tool\": name or \"answer\", \"arguments\": JSON text of the tool's "
        "arguments (\"{}\" when answering), \"answer\": your final answer in Markdown (\"\" when calling a tool)}. "
        "Call one tool at a time and wait for its result. Compute with the aggregate tool rather than in your head "
        "when the data is not all in the context. Do not invent data; say so when the data does not answer the question.\n"
        + cite,
        tools,
    )


ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"tool": {"type": "string"}, "arguments": {"type": "string"}, "answer": {"type": "string"}},
    "required": ["tool", "arguments", "answer"],
}


# Workshop variable types an agent may write (set_variable), and how a value of each is given
WRITABLE_TYPES = {
    "string": "text", "number": "a number", "boolean": "true or false", "date": 'a date "YYYY-MM-DD"',
    "timestamp": "an ISO 8601 timestamp", "object": "an object's primary key", "object_set": "a list of primary keys",
    "array": "a list of texts / numbers / booleans", "struct": "a JSON object", "struct_array": "a list of JSON objects",
}


def _kind(v: Any) -> str:
    return ("null" if v is None else "true / false" if isinstance(v, bool) else "a number" if isinstance(v, (int, float))
            else "text" if isinstance(v, str) else "a list" if isinstance(v, list) else "a JSON object" if isinstance(v, dict) else type(v).__name__)


def check_variable_value(vtype: str, value: Any) -> Any:
    """A value an agent proposes for a Workshop variable of this type: the value to set (primary keys as text; null
    clears the variable), or ValueError when the type does not match."""
    if vtype not in WRITABLE_TYPES:
        raise ValueError(f"{vtype} variables cannot be set by an agent")
    if value is None:
        return None
    scalar = lambda x: x is None or isinstance(x, (str, bool)) or (isinstance(x, (int, float)) and math.isfinite(x))  # noqa: E731
    key = lambda x: isinstance(x, str) or (isinstance(x, int) and not isinstance(x, bool))  # noqa: E731
    good = {
        "string": lambda: isinstance(value, str),
        "number": lambda: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
        "boolean": lambda: isinstance(value, bool),
        "date": lambda: isinstance(value, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)),
        "timestamp": lambda: isinstance(value, str) and bool(re.match(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", value)),
        "object": lambda: key(value),
        "object_set": lambda: isinstance(value, list) and all(key(x) for x in value),
        "array": lambda: isinstance(value, list) and all(scalar(x) for x in value),
        "struct": lambda: isinstance(value, dict),
        "struct_array": lambda: isinstance(value, list) and all(isinstance(x, dict) for x in value),
    }[vtype]()
    if good and vtype == "date":
        try:
            date.fromisoformat(value)
        except ValueError:
            good = False
    if good and vtype == "timestamp":
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            good = False
    if not good:
        raise ValueError(f"a {vtype} variable takes {WRITABLE_TYPES[vtype]}, not {_kind(value)} ({json.dumps(value, ensure_ascii=False, default=str)[:80]})")
    if vtype == "object":
        return str(value)
    if vtype == "object_set":
        return [str(x) for x in value]
    return value


def _partial_answer(text: str) -> Optional[str]:
    """The final answer read from a JSON reply as it streams: the "answer" string so far (escapes decoded, a cut
    escape left out) once the reply says {"tool": "answer"}; None before that."""
    if not re.search(r'"tool"\s*:\s*"answer"', text):
        return None
    m = re.search(r'"answer"\s*:\s*"', text)
    if not m:
        return None
    out: list[str] = []
    i = m.end()
    esc = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", '"': '"', "\\": "\\", "/": "/"}
    while i < len(text):
        ch = text[i]
        if ch == '"':
            break
        if ch == "\\":
            if i + 1 >= len(text):
                break
            nxt = text[i + 1]
            if nxt == "u":
                hexa = text[i + 2:i + 6]
                if len(hexa) < 4:
                    break
                try:
                    out.append(chr(int(hexa, 16)))
                except ValueError:
                    pass
                i += 6
                continue
            out.append(esc.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _json_reply(text: str) -> Optional[dict]:
    """A whole JSON reply ({tool, arguments, answer}) from a text answer (```json fences allowed), or None."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[A-Za-z]*\s*|\s*```$", "", t)
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        out = json.loads(t[a:b + 1])
    except ValueError:
        return None
    return out if isinstance(out, dict) and ({"tool", "answer"} & out.keys()) else None


def _model_turn(agent: dict, system: str, convo: str, temperature: float, on_event: Optional[Callable[[str, Any], None]]) -> Any:
    """One turn of the loop. Streaming: the model answers in text (the same JSON) and the final answer's text is sent
    as "chunk" events while it is written; a reply that is not JSON is asked again with the answer schema."""
    if on_event is None:
        return pipeline_ai.chat(agent["model"], system, convo, ANSWER_SCHEMA, temperature, 8192)
    sent = [""]

    def so_far(text: str) -> None:
        part = _partial_answer(text)
        if part is None:
            if sent[0]:
                on_event("reset", {})
                sent[0] = ""
            return
        if not part.startswith(sent[0]):
            on_event("reset", {})
            sent[0] = ""
        if len(part) > len(sent[0]):
            on_event("chunk", part[len(sent[0]):])
            sent[0] = part

    out: Any = None
    try:
        res = pipeline_ai.chat_tools(agent["model"], system, [{"role": "user", "text": convo}], None, temperature, 8192, on_text=so_far)
        out = _json_reply(res.get("text") or "")
    except Exception as e:  # noqa: BLE001 - asked again without streaming
        log.info("agent %s: streamed turn failed (%s); asking with the answer schema", agent["id"], e)
    if out is None:
        out = pipeline_ai.chat(agent["model"], system, convo, ANSWER_SCHEMA, temperature, 8192)
    final = str(out.get("answer") or "").strip() if isinstance(out, dict) and str(out.get("tool") or "answer").strip() == "answer" else ""
    if sent[0] and sent[0].strip() != final:
        on_event("reset", {})
        sent[0] = ""
    if final and not sent[0]:
        on_event("chunk", final)
    return out


def respond(agent: dict, history: list[dict], question: str, app_state: Optional[dict] = None,
            on_event: Optional[Callable[[str, Any], None]] = None) -> dict:
    """One turn. on_event (streaming) gets ("step", {tool, arguments, ok}) after each tool call, ("variable", {name,
    value}) for each variable set, ("chunk", text) / ("reset", {}) as the answer is written."""
    started = time.monotonic()
    system, tools = _system(agent)
    state = {k: dict(v) for k, v in (app_state or {}).items() if isinstance(v, dict)}
    writable = {k: v for k, v in state.items() if v.get("writable")}
    if state:
        # Workshop's application state: the variables' values (and what they mean) for this turn
        shown = {k: {f: v.get(f) for f in ("value", "description", "type") if f in v} | ({"writable": True} if v.get("writable") else {})
                 for k, v in state.items()}
        system += "\n\nApplication state (the user's current Workshop variables): " + json.dumps(shown, ensure_ascii=False, default=str)[:8000]
    if writable:
        tools = [*tools, "set_variable"]
        system += ("\n\n# Workshop variables you may set\n- set_variable: " + TOOLS["set_variable"] + "\n"
                   + "\n".join(f'- {k} ({v.get("type") or "string"}: {WRITABLE_TYPES.get(v.get("type") or "string", "not settable")})'
                               + (f': {v["description"]}' if v.get("description") else "") for k, v in writable.items())
                   + "\nSet a variable only when the user's request calls for it; the other variables are read-only.")
    convo: list[str] = []
    for m in history[-HISTORY_MESSAGES:]:
        convo.append(f"[{m['role']}]\n{m['content']}")
    convo.append(f"[user]\n{question}")
    steps: list[dict] = []
    cited: dict[tuple[str, str], dict] = {}
    written: dict[str, Any] = {}
    answer = ""
    error = None
    temperature = float(agent.get("temperature") or 0)
    try:
        for _ in range(MAX_STEPS):
            out = _model_turn(agent, system, "\n\n".join(convo), temperature, on_event)
            if not isinstance(out, dict):
                raise RuntimeError("the model did not answer in the expected format")
            name = str(out.get("tool") or "answer").strip()
            if name == "answer" or name not in tools:
                answer = str(out.get("answer") or "").strip()
                if answer or name == "answer":
                    break
            args: dict = {}
            try:
                raw = out.get("arguments")
                args = raw if isinstance(raw, dict) else json.loads(raw or "{}")
                if not isinstance(args, dict):
                    args = {}
                    raise ValueError("arguments must be a JSON object")
                if name == "set_variable":
                    var = str(args.get("variable") or "")
                    if var not in writable:
                        raise ValueError(f'refused: "{var}" is not a writable variable (writable: {", ".join(writable)})')
                    value = check_variable_value(writable[var].get("type") or "string", args.get("value"))
                    written[var] = value
                    writable[var]["value"] = value
                    if on_event:
                        on_event("variable", {"name": var, "value": value})
                    result: Any = {"set": var, "value": value}
                else:
                    result = _tool(agent, name, args, cited)
                ok = True
            except HTTPException as e:
                result, ok = {"error": str(e.detail)}, False
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:500]
                result, ok = {"error": msg if name != "set_variable" or msg.startswith("refused") else f"refused: {msg}"}, False
            text = json.dumps(result, ensure_ascii=False, default=str)
            if len(text) > TOOL_RESULT_CHARS:
                text = text[:TOOL_RESULT_CHARS] + " …(truncated; narrow the search)"
            steps.append({"tool": name, "arguments": args, "ok": ok, "result": text[:3000]})
            if on_event:
                on_event("step", {"tool": name, "arguments": args, "ok": ok, "result": text[:600]})
            convo.append(f"[assistant → {name}]\n{json.dumps(args, ensure_ascii=False)}")
            convo.append(f"[tool result: {name}]\n{text}")
        else:
            convo.append("[system]\nYou have used all your tool calls: answer now with what you have.")
            out = _model_turn(agent, system, "\n\n".join(convo), 0, on_event)
            answer = str((out or {}).get("answer") or "").strip() if isinstance(out, dict) else ""
    except Exception as e:  # noqa: BLE001
        log.exception("agent %s failed", agent["id"])
        error = str(e)[:500]
    reply = {
        "role": "assistant",
        "content": answer or ("" if error else "I could not find an answer."),
        "error": error,
        "steps": steps,
        "citations": _citations(answer, cited) if agent.get("citations", True) else [],
        "model": agent["model"],
        "ms": int((time.monotonic() - started) * 1000),
        "at": ontology._now(),
    }
    if written:
        reply["variables"] = written
    return reply


def _citations(answer: str, seen: dict[tuple[str, str], dict]) -> list[dict]:
    """Resolve [[Type:pk]] markers to objects (from tool results, else looked up)."""
    types = _types_by_api()
    out: list[dict] = []
    for api, pk in dict.fromkeys(CITE.findall(answer)):
        t = types.get(api)
        if not t:
            continue
        obj = seen.get((api, pk.strip()))
        if obj is None:
            o = ontology._objects(t["id"]).get(pk.strip())
            if o is None:
                continue
            obj = ontology._public_object(t, pk.strip(), o)
        out.append({"object_type": api, "object_type_id": t["id"], "primary_key": pk.strip(),
                    "title": obj.get("title") or pk, "type_name": t["display_name"]})
    return out
