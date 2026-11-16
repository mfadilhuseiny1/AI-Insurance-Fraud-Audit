"""Pilot (Application Building → Pilot): applications and custom widgets built from natural language.

A Pilot session is a Files item (`<name>.pilot`, application/vnd.bluesandai.pilot+json) in a Project. Each prompt
runs specialized agents (language models through pipeline_ai.chat, JSON answers):
- ontology architect: the object types, action types and links the application needs — reusing existing entities,
  within the session's ontology permissions (may it create new types; may it modify each existing one);
- designer: a design specification (palette, typography, layout, interaction patterns);
- seed data generator: sample rows per object type, kept in the session (agents never read real data);
- app builder: the application's files (index.html, style.css, app.js on the generated SDK through pilot.js) or a
  widget's HTML / CSS / JavaScript on window.BluesandaiWidget.
Plan mode answers with a plan and waits for approval. Every finished turn is a version (restorable).

The preview runs the files against the seed data: an OSDK API over the session's rows at
/api/pilot/preview/<token>/api/v2/… (searches, aggregates, actions editing the seed rows), no real data involved.
Deploying an application promotes the proposed ontology entities (object types with their API names, create /
modify / delete action types, foreign-key links; optionally the seed rows as starting objects), creates a Developer
Console application with those scopes, generates its SDK, runs checks (references to SDK exports, a JavaScript
syntax check with Node when present) and releases the site; a widget goes to a widget set release (and a Workshop
module embedding it, on request).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/pilot", tags=["pilot"])
PILOT_TYPE = "application/vnd.bluesandai.pilot+json"
DIR = Path("data/pilot")
TYPES = ("string", "integer", "double", "boolean", "date", "timestamp")
_lock = threading.RLock()
_running: dict[str, threading.Thread] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "pilot"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    p = auth.current() or {}
    return {"id": p.get("id") or "local", "username": p.get("username") or "local"}


def _secret() -> bytes:
    p = DIR / ".secret"
    if not p.exists():
        DIR.mkdir(parents=True, exist_ok=True)
        p.write_bytes(secrets.token_bytes(32))
    return p.read_bytes()


def _path(sid: str) -> Path:
    if not re.fullmatch(r"pil-[0-9a-f]{12}", sid):
        raise HTTPException(404, "Pilot session not found")
    return DIR / f"{sid}.json"


def _read(sid: str) -> dict:
    try:
        return json.loads(_path(sid).read_text("utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "Pilot session not found") from None


def _write(s: dict) -> None:
    p = _path(s["id"])
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, p)


def _all() -> list[dict]:
    out = []
    for p in DIR.glob("pil-*.json") if DIR.exists() else []:
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _access(s: dict, need: str = "viewer") -> dict:
    return drive._item(s["item_id"], need=need)


def _summary(s: dict) -> dict:
    return {k: s.get(k) for k in ("id", "name", "kind", "item_id", "model", "mode", "status", "created_at", "created_by", "updated_at", "deployment")} | {
        "versions": len(s.get("versions") or []), "messages": len(s.get("messages") or [])}


# ------------------------------------------------------------------------------------------------
# sessions
# ------------------------------------------------------------------------------------------------


class SessionIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=8000)
    folder_id: str
    kind: Literal["application", "widget"] = "application"
    name: Optional[str] = Field(None, max_length=200)
    model: Optional[str] = None
    mode: Literal["act", "plan"] = "act"
    allow_create: bool = True
    default_edit: Literal["allow", "deny"] = "deny"
    attachments: list[dict] = Field(default_factory=list)


@router.get("/models")
def models() -> list[dict]:
    import knowledge

    return [m for m in knowledge.models() if m.get("available")]


@router.get("/sessions")
def list_sessions() -> list[dict]:
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (PILOT_TYPE,), order="updated_at DESC", limit=2000)
    visible = {i["id"] for i in auth.visible(items)}
    return sorted((_summary(s) for s in _all() if s["item_id"] in visible), key=lambda s: s.get("updated_at") or "", reverse=True)


@router.post("/sessions")
def create_session(req: SessionIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "save Pilot sessions in a Project or a folder")
    import ontology

    name = (req.name or re.sub(r"\s+", " ", req.prompt).strip()[:60]).strip() or "Pilot application"
    with _lock:
        sid = "pil-" + uuid.uuid4().hex[:12]
        body = json.dumps({"pilot_session_id": sid}).encode()
        item = drive._store(folder["id"], drive._clean_name(f"{name}.pilot"), io.BytesIO(body), len(body), PILOT_TYPE)
        s = {"id": sid, "name": name, "kind": req.kind, "item_id": item["id"], "folder_id": folder["id"], "model": req.model or ontology.DEFAULT_LLM,
             "mode": req.mode, "status": "idle", "permissions": {"allow_create": req.allow_create, "default": req.default_edit, "entities": {}},
             "attachments": req.attachments, "messages": [], "plan": {"object_types": [], "action_types": [], "link_types": []}, "design": None, "seed": {},
             "files": {}, "widget": None, "versions": [], "logs": [], "preview_token": secrets.token_urlsafe(18), "created_at": _now(), "created_by": _me()["id"],
             "updated_at": _now(), "deployment": None}
        _write(s)
    _start(sid, req.prompt)
    return get_session(sid)


@router.get("/sessions/{sid}")
def get_session(sid: str) -> dict:
    s = _read(sid)
    _access(s)
    out = {k: v for k, v in s.items() if k != "preview_token"}
    out["preview_url"] = f"/api/pilot/preview/{_preview_token(s)}/"
    out["existing"] = _existing_summary()
    return out


class PromptIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    mode: Optional[Literal["act", "plan"]] = None
    model: Optional[str] = None
    attachments: list[dict] = Field(default_factory=list)


@router.post("/sessions/{sid}/prompt")
def prompt(sid: str, req: PromptIn) -> dict:
    with _lock:
        s = _read(sid)
        _access(s, "editor")
        if s["status"] == "running":
            raise HTTPException(409, "Pilot is still working on the previous prompt")
        if req.mode:
            s["mode"] = req.mode
        if req.model:
            s["model"] = req.model
        if req.attachments:
            s["attachments"] = [*s.get("attachments", []), *req.attachments]
        _write(s)
    _start(sid, req.prompt)
    return get_session(sid)


@router.post("/sessions/{sid}/approve")
def approve(sid: str) -> dict:
    """Run the plan Pilot proposed in plan mode."""
    with _lock:
        s = _read(sid)
        _access(s, "editor")
        pending = s.get("pending_plan")
        if not pending:
            raise HTTPException(400, "there is no plan waiting for approval")
        s["pending_plan"] = None
        _write(s)
    _start(sid, pending["prompt"], approved_plan=pending["plan"])
    return get_session(sid)


class PermissionsIn(BaseModel):
    allow_create: bool
    default: Literal["allow", "deny"]
    entities: dict[str, Literal["allow", "deny"]] = Field(default_factory=dict)


@router.put("/sessions/{sid}/permissions")
def set_permissions(sid: str, req: PermissionsIn) -> dict:
    with _lock:
        s = _read(sid)
        _access(s, "editor")
        s["permissions"] = req.model_dump()
        _write(s)
    return get_session(sid)


class FilesIn(BaseModel):
    files: dict[str, str]


@router.put("/sessions/{sid}/files")
def save_files(sid: str, req: FilesIn) -> dict:
    """Edits from the Code tab (a new version)."""
    with _lock:
        s = _read(sid)
        _access(s, "editor")
        if s["kind"] == "widget":
            w = dict(s.get("widget") or {})
            for k in ("html", "css", "js"):
                if f"widget.{k}" in req.files:
                    w[k] = req.files[f"widget.{k}"]
            if "widget.config.json" in req.files:
                try:
                    cfg = json.loads(req.files["widget.config.json"])
                except ValueError:
                    raise HTTPException(422, "widget.config.json is not valid JSON") from None
                w.update({k: cfg[k] for k in ("parameters", "events", "name", "description") if k in cfg})
            s["widget"] = w
        else:
            for k, v in req.files.items():
                if k not in ("index.html", "style.css", "app.js") and not re.fullmatch(r"[\w-]+\.(js|css|html)", k):
                    raise HTTPException(422, f"{k}: files are index.html, style.css, app.js and other top-level .js / .css / .html")
            s["files"] = {**s["files"], **req.files}
        _snapshot(s, "Edited in the Code tab")
        _write(s)
    return get_session(sid)


@router.post("/sessions/{sid}/versions/{n}/restore")
def restore(sid: str, n: int) -> dict:
    with _lock:
        s = _read(sid)
        _access(s, "editor")
        v = next((x for x in s["versions"] if x["n"] == n), None)
        if not v:
            raise HTTPException(404, "version not found")
        for k in ("plan", "design", "seed", "files", "widget"):
            s[k] = v["state"][k]
        _snapshot(s, f"Restored version {n}")
        _write(s)
    return get_session(sid)


@router.delete("/sessions/{sid}")
def delete_session(sid: str) -> dict:
    s = _read(sid)
    drive.trash(_access(s, "editor")["id"])
    return {"trashed": sid}


def _snapshot(s: dict, label: str) -> None:
    n = (s["versions"][-1]["n"] + 1) if s.get("versions") else 1
    s.setdefault("versions", []).append({"n": n, "at": _now(), "label": label[:200],
                                         "state": json.loads(json.dumps({k: s.get(k) for k in ("plan", "design", "seed", "files", "widget")}))})
    s["versions"] = s["versions"][-30:]
    s["updated_at"] = _now()


# ------------------------------------------------------------------------------------------------
# the agents
# ------------------------------------------------------------------------------------------------


def _existing_summary() -> list[dict]:
    import ontology

    out = []
    try:
        types = ontology.list_object_types()
    except Exception:  # noqa: BLE001
        return out
    actions = ontology.list_action_types()
    for t in types[:80]:
        try:
            full = ontology._object_type(t["id"])
        except HTTPException:
            continue
        out.append({"id": full["id"], "apiName": full.get("api_name"), "displayName": full["display_name"], "primaryKey": full["primary_key"],
                    "properties": [{"apiName": p["api_name"], "type": p["type"]} for p in full["properties"]][:40],
                    "actions": [{"id": a["id"], "apiName": a.get("api_name"), "displayName": a["display_name"], "kind": a["kind"]} for a in actions if a.get("object_type_id") == full["id"]][:10]})
    return out


def _log(sid: str, agent: str, text: str) -> None:
    with _lock:
        s = _read(sid)
        s.setdefault("logs", []).append({"at": _now(), "agent": agent, "text": text[:4000]})
        s["logs"] = s["logs"][-400:]
        _write(s)


def _say(sid: str, role: str, text: str, agent: Optional[str] = None, extra: Optional[dict] = None) -> None:
    with _lock:
        s = _read(sid)
        s.setdefault("messages", []).append({"at": _now(), "role": role, "agent": agent, "text": text, **(extra or {})})
        _write(s)


def _llm(model: str, system: str, user: str, schema: dict, max_tokens: int = 8000) -> Any:
    import pipeline_ai

    return pipeline_ai.chat(model, pipeline_ai.with_platform(system), user, schema, 0.2, max_tokens)


def _start(sid: str, text: str, approved_plan: Optional[str] = None) -> None:
    with _lock:
        s = _read(sid)
        s["status"] = "running"
        s.setdefault("messages", []).append({"at": _now(), "role": "user", "text": text})
        _write(s)
    who = auth.current()
    t = threading.Thread(target=_run, args=(sid, text, approved_plan, who), daemon=True)
    _running[sid] = t
    t.start()


PLAN_SCHEMA = {"type": "object", "properties": {"plan": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}}}, "required": ["plan", "steps"]}
ONTOLOGY_SCHEMA = {
    "type": "object",
    "properties": {
        "rationale": {"type": "string"},
        "object_types": {"type": "array", "items": {"type": "object", "properties": {
            "apiName": {"type": "string"}, "displayName": {"type": "string"}, "existingId": {"type": "string"}, "primaryKey": {"type": "string"},
            "titleProperty": {"type": "string"}, "description": {"type": "string"},
            "properties": {"type": "array", "items": {"type": "object", "properties": {"apiName": {"type": "string"}, "displayName": {"type": "string"}, "dataType": {"type": "string"}},
                                                     "required": ["apiName", "dataType"]}}},
            "required": ["apiName", "displayName", "primaryKey", "properties"]}},
        "action_types": {"type": "array", "items": {"type": "object", "properties": {"apiName": {"type": "string"}, "displayName": {"type": "string"}, "objectType": {"type": "string"},
                                                                                      "kind": {"type": "string"}, "existingId": {"type": "string"}}, "required": ["apiName", "displayName", "objectType", "kind"]}},
        "link_types": {"type": "array", "items": {"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "foreignKey": {"type": "string"}, "displayName": {"type": "string"}},
                                                  "required": ["from", "to", "foreignKey"]}},
    },
    "required": ["rationale", "object_types", "action_types", "link_types"],
}
DESIGN_SCHEMA = {"type": "object", "properties": {
    "summary": {"type": "string"},
    "palette": {"type": "object", "properties": {k: {"type": "string"} for k in ("background", "surface", "text", "muted", "accent", "good", "warn", "bad")}},
    "typography": {"type": "object", "properties": {"family": {"type": "string"}, "base": {"type": "string"}, "heading": {"type": "string"}}},
    "layout": {"type": "string"}, "patterns": {"type": "array", "items": {"type": "string"}}}, "required": ["summary", "palette", "layout"]}
# rows as JSON strings: free-form objects are not portable across model providers' schema dialects
SEED_SCHEMA = {"type": "object", "properties": {"tables": {"type": "array", "items": {"type": "object", "properties": {"objectType": {"type": "string"}, "rows": {"type": "array", "items": {"type": "string"}}},
                                                                                   "required": ["objectType", "rows"]}}}, "required": ["tables"]}
APP_SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}, "files": {"type": "object", "properties": {"index.html": {"type": "string"}, "style.css": {"type": "string"}, "app.js": {"type": "string"}},
                                                                                     "required": ["index.html", "style.css", "app.js"]}}, "required": ["summary", "files"]}
WIDGET_SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"}, "html": {"type": "string"},
                                                  "css": {"type": "string"}, "js": {"type": "string"}, "parametersJson": {"type": "string"}, "eventsJson": {"type": "string"}},
                 "required": ["summary", "html", "css", "js", "parametersJson", "eventsJson"]}


def _obj(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    try:
        x = json.loads(v or "{}")
        return x if isinstance(x, dict) else {}
    except (TypeError, ValueError):
        return {}


def _ident(s: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_]", "_", s)
    return ("_" + out) if out[:1].isdigit() else out


def _camel(s: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", s.strip())
    out = "".join(p[:1].upper() + p[1:] for p in parts if p)
    return (out[:1].lower() + out[1:]) or "item"


def _clean_plan(s: dict, plan: dict) -> dict:
    """Keep the architect inside the permissions: no new types when creation is off; no schema changes to locked types."""
    perms = s["permissions"]
    existing = {e["id"]: e for e in _existing_summary()}
    by_api = {e["apiName"]: e for e in existing.values()}
    types = []
    for t in plan.get("object_types") or []:
        ex = existing.get(t.get("existingId") or "") or by_api.get(t.get("apiName") or "")
        props = [{"apiName": _camel(p["apiName"]) if not ex else p["apiName"], "displayName": p.get("displayName") or p["apiName"],
                  "type": (p.get("dataType") or p.get("type")) if (p.get("dataType") or p.get("type")) in TYPES else "string"} for p in t.get("properties") or [] if p.get("apiName")]
        if ex:
            allowed = perms["entities"].get(ex["id"], perms["default"]) == "allow"
            known = {p["apiName"] for p in ex["properties"]}
            added = [p for p in props if p["apiName"] not in known]
            types.append({"apiName": ex["apiName"], "displayName": ex["displayName"], "existingId": ex["id"], "primaryKey": ex["primaryKey"],
                          "properties": [{"apiName": p["apiName"], "displayName": p["apiName"], "type": p["type"]} for p in ex["properties"]] + (added if allowed else []),
                          "added": [p["apiName"] for p in added] if allowed else [], "status": "existing"})
        elif perms["allow_create"]:
            api = re.sub(r"[^A-Za-z0-9]", "", t["apiName"][:1].upper() + t["apiName"][1:]) or "Item"
            pk = _camel(t.get("primaryKey") or (props[0]["apiName"] if props else "id"))
            if not any(p["apiName"] == pk for p in props):
                props.insert(0, {"apiName": pk, "displayName": pk, "type": "string"})
            types.append({"apiName": api, "displayName": t.get("displayName") or api, "primaryKey": pk, "titleProperty": _camel(t.get("titleProperty") or pk),
                          "description": t.get("description") or "", "properties": props, "status": "proposed"})
    names = {t["apiName"] for t in types}
    actions = []
    for a in plan.get("action_types") or []:
        ot = a.get("objectType")
        if ot not in names:
            continue
        t = next(x for x in types if x["apiName"] == ot)
        if a.get("existingId") and a["existingId"] in {x["id"] for e in existing.values() for x in e["actions"]}:
            actions.append({**a, "status": "existing"})
        elif perms["allow_create"] and (t["status"] == "proposed" or perms["entities"].get(t.get("existingId", ""), perms["default"]) == "allow"):
            actions.append({"apiName": _camel(a["apiName"]), "displayName": a.get("displayName") or a["apiName"], "objectType": ot,
                            "kind": a.get("kind") if a.get("kind") in ("create", "modify", "delete") else "modify", "status": "proposed"})
    # link types follow their object types: a new link needs a proposed side, or modifications allowed on both existing sides
    def may_link(api: str) -> bool:
        t = next(x for x in types if x["apiName"] == api)
        return t["status"] == "proposed" or (perms["allow_create"] and perms["entities"].get(t.get("existingId", ""), perms["default"]) == "allow")

    links = [x for x in plan.get("link_types") or [] if x.get("from") in names and x.get("to") in names and may_link(x["from"]) and may_link(x["to"])]
    return {"rationale": plan.get("rationale") or "", "object_types": types, "action_types": actions, "link_types": links}


def _sdk_for_plan(plan: dict) -> tuple[str, str]:
    """index.js and a short API list for the agent: constants per object type / action, and the generic client."""
    import developer_console

    js = ['/* Generated for the Pilot preview from the session\'s ontology plan. */\nexport const $ontologyRid = "ri.ontology.main.ontology.default";\nexport const $clientId = "pilot-preview";\n']
    doc = []
    for t in plan["object_types"]:
        n = _ident(t["apiName"])
        js.append(f"export const {n} = {{ type: \"object\", apiName: {json.dumps(t['apiName'])}, primaryKey: {json.dumps(t['primaryKey'])} }};\n")
        doc.append(f"- {n} (object type {t['displayName']}): primary key {t['primaryKey']}; properties " + ", ".join(f"{p['apiName']}: {p['type']}" for p in t["properties"]))
    for a in plan["action_types"]:
        n = _ident(a["apiName"])
        js.append(f"export const {n} = {{ type: \"action\", apiName: {json.dumps(a['apiName'])} }};\n")
        doc.append(f"- {n} ({a['kind']} action on {a['objectType']}): applyAction({{ {'object: <primary key>, ' if a['kind'] != 'create' else ''}<property>: value, … }})")
    js.append(developer_console.CLIENT_JS)
    return "".join(js), "\n".join(doc)


PILOT_JS = """// pilot.js (provided by the platform; do not edit): the SDK client for this application.
import { createClient, createPublicOauthClient, $ontologyRid, $clientId } from "./sdk/index.js";
export * from "./sdk/index.js";
const cfg = window.PILOT_CONFIG || {};
const API = cfg.apiUrl || location.origin;
const auth = cfg.mode === "seed" ? async () => "seed" : createPublicOauthClient(cfg.clientId || $clientId, API, location.origin + location.pathname);
export const client = createClient(cfg.osdkBase || API, $ontologyRid, auth);
export const signOut = () => auth.signOut && auth.signOut();
"""

APP_CONTRACT = """Write a single-page application in plain modern JavaScript (ES modules, no build step, no npm packages, no external
network requests) with three files: index.html (loads ./style.css and <script type="module" src="./app.js">), style.css and
app.js. app.js imports from "./pilot.js" — the only data access:
  import { client, signOut, <ObjectTypeOrAction constants> } from "./pilot.js";
  const page = await client(Type).where({ prop: value, other: { $gt: 3 } }).fetchPage({ pageSize: 50, orderBy: { prop: "desc" } });
     // page.data: objects with their properties plus $primaryKey; page.totalCount (string); where supports $eq $ne $gt $gte $lt $lte $in $isNull $contains $startsWith $and $or $not
  const one = await client(Type).fetchOne(primaryKey);
  const agg = await client(Type).aggregate({ select: { $count: "count", "prop:total": "sum" }, groupBy: { status: "exact" } });
     // agg.data: [{ group: { status: "…" }, metrics: [{ name, value }, …] }]
  await client(SomeAction).applyAction({ object: primaryKey, prop: value });   // modify / delete actions take `object`; create actions take the properties
  const me = await client.currentUser();
Render everything with DOM APIs (no frameworks). Handle loading and errors visibly. Use the design specification's palette
and typography as CSS custom properties. Make the decision the user came for easy: show what needs attention, let them act
with the actions, refresh after an action. Keep it under ~400 lines of JavaScript."""

WIDGET_CONTRACT = """Write a Workshop custom widget in plain JavaScript (no frameworks, no network): html (body content), css and js.
The js uses window.BluesandaiWidget:
  const w = window.BluesandaiWidget;
  w.onParameters((values) => { … });        // values by parameter id
  w.emitEvent("eventId", { parameterUpdates: { paramId: value } });
  const page = await w.osdk.objectSet(values.someObjectSetParam);   // { data: [rows with their properties and __pk], totalCount }
  const rows = (await w.osdk.objects("<objectTypeApiName>", { filters: [{ column, op: "eq", value }], pageSize: 100 })).data;
  await w.osdk.applyAction("<actionApiName>", { object: pk, … });
Return parametersJson and eventsJson as JSON strings. Declare parameters ({id: {displayName, type}} with types boolean, date, number, string, timestamp, objectSet, array (+subType))
and events ({id: {displayName, parameterUpdateIds: [...]}}), camelCase ids. Support dark and light themes with
@media (prefers-color-scheme: dark). Fill the iframe (html, body height 100%)."""


def _run(sid: str, text: str, approved_plan: Optional[str], who: Optional[dict]) -> None:
    token = auth._principal.set(who) if hasattr(auth, "_principal") and who is not None else None
    try:
        s = _read(sid)
        model = s["model"]
        existing = _existing_summary()
        attached = [a for a in s.get("attachments") or []]
        history = "\n".join(f"{m['role']}: {m['text'][:1500]}" for m in s["messages"][-12:] if m["role"] in ("user", "assistant"))
        ctx = (f"Application kind: {s['kind']}.\nConversation so far:\n{history}\n\nExisting ontology (reuse these when they fit; refer to them by existingId):\n"
               f"{json.dumps(existing, ensure_ascii=False)[:24000]}\n\nAttached context: {json.dumps(attached, ensure_ascii=False)[:8000]}\n"
               f"Ontology permissions: may create new entities: {s['permissions']['allow_create']}; existing entities default to "
               f"{'allow' if s['permissions']['default'] == 'allow' else 'no'} modifications, overrides {json.dumps(s['permissions']['entities'])}.\n"
               f"Current ontology plan: {json.dumps(s['plan'], ensure_ascii=False)[:12000]}\n")
        if s["mode"] == "plan" and approved_plan is None:
            _log(sid, "planner", "planning")
            p = _llm(model, "You are Pilot, an application builder on an Ontology platform. Propose a concise plan for the user's request: "
                            "the ontology entities to create or reuse, the design, the screens and interactions. Do not build yet.", ctx + f"\nRequest: {text}", PLAN_SCHEMA, 3000)
            with _lock:
                s = _read(sid)
                s["pending_plan"] = {"prompt": text, "plan": p["plan"] + "\n" + "\n".join(f"{i + 1}. {x}" for i, x in enumerate(p.get("steps") or []))}
                s["messages"].append({"at": _now(), "role": "assistant", "agent": "planner", "text": s["pending_plan"]["plan"], "awaiting_approval": True})
                s["status"] = "idle"
                _write(s)
            return
        instructions = text + (f"\n\nApproved plan:\n{approved_plan}" if approved_plan else "")
        # 1. ontology architect
        _log(sid, "ontology architect", "designing the data model")
        raw = _llm(model, "You are Pilot's ontology architect. Define the object types (properties typed string, integer, double, boolean, date or "
                          "timestamp, given as dataType; a string primary key), action types (kind create, modify or delete on an object type) and foreign-key links the "
                          "application needs. Reuse existing object types and actions (set existingId) instead of duplicating them. Respect the "
                          "permissions. Keep the model small and purposeful. apiName: object types PascalCase, properties and actions camelCase.",
                   ctx + f"\nRequest: {instructions}", ONTOLOGY_SCHEMA, 6000)
        plan = _clean_plan(_read(sid), raw)
        _say(sid, "assistant", plan["rationale"] or "Ontology updated", "ontology architect",
             {"entities": [f"{t['status']}: {t['displayName']}" for t in plan["object_types"]] + [f"{a['status']}: {a['displayName']}" for a in plan["action_types"]]})
        with _lock:
            s = _read(sid)
            old_types = {t["apiName"]: [p["apiName"] for p in t["properties"]] for t in s["plan"]["object_types"]}
            s["plan"] = plan
            _write(s)
        # 2. designer (first build, or when asked)
        if not s.get("design") or re.search(r"\b(design|color|colour|theme|font|layout|warna|tema|tampilan)\b", text, re.I):
            _log(sid, "designer", "writing the design specification")
            design = _llm(model, "You are Pilot's designer. Produce a design specification for an operational application: an accessible palette with "
                                 "semantic status colors (hex), typography, the layout of the main views and interaction patterns.",
                          ctx + f"\nRequest: {instructions}\nOntology: {json.dumps(plan, ensure_ascii=False)[:8000]}", DESIGN_SCHEMA, 2500)
            with _lock:
                s = _read(sid)
                s["design"] = design
                _write(s)
            _say(sid, "assistant", design.get("summary") or "Design specification ready", "designer")
        # 3. seed data, for types that are new or changed
        need = [t for t in plan["object_types"] if old_types.get(t["apiName"]) != [p["apiName"] for p in t["properties"]] or t["apiName"] not in (_read(sid).get("seed") or {})]
        if need:
            _log(sid, "seed data generator", f"generating sample rows for {', '.join(t['apiName'] for t in need)}")
            seed = _llm(model, "You are Pilot's seed data generator. Write realistic, varied sample rows (10 to 15 per object type; each row one JSON object encoded as a string) for the object types "
                               "given, matching every property's type (dates YYYY-MM-DD, timestamps ISO 8601), unique primary keys, and foreign keys that "
                               "point at rows of the linked type. Invent the data: never real or famous people (no politicians, celebrities or public figures), invented names only.",
                        json.dumps({"object_types": need, "link_types": plan["link_types"], "request": instructions}, ensure_ascii=False)[:16000], SEED_SCHEMA, 12000)
            with _lock:
                s = _read(sid)
                for tbl in seed.get("tables") or []:
                    t = next((x for x in plan["object_types"] if x["apiName"] == tbl.get("objectType")), None)
                    if not t:
                        continue
                    props = {p["apiName"] for p in t["properties"]}
                    rows = []
                    for r in tbl.get("rows") or []:
                        if isinstance(r, str):
                            try:
                                r = json.loads(r)
                            except ValueError:
                                continue
                        if not isinstance(r, dict):
                            continue
                        row = {k: v for k, v in r.items() if k in props}
                        if row.get(t["primaryKey"]) in (None, ""):
                            row[t["primaryKey"]] = uuid.uuid4().hex[:8]
                        rows.append(row)
                    s["seed"][t["apiName"]] = rows[:200]
                _write(s)
            _say(sid, "assistant", "Seed data: " + ", ".join(f"{k} ({len(v)})" for k, v in _read(sid)["seed"].items()), "seed data generator")
        # 4. app builder
        s = _read(sid)
        _, api_doc = _sdk_for_plan(plan)
        if s["kind"] == "application":
            _log(sid, "app builder", "writing the application")
            out = _llm(model, "You are Pilot's frontend architect. " + APP_CONTRACT,
                       f"Request: {instructions}\nConversation:\n{history}\n\nDesign specification: {json.dumps(s['design'], ensure_ascii=False)}\n\n"
                       f"SDK exports available from ./pilot.js:\n{api_doc}\n\nCurrent files (update them; keep what still works):\n"
                       f"{json.dumps(s['files'], ensure_ascii=False)[:30000]}", APP_SCHEMA, 16000)
            files = {k: str(v) for k, v in (out.get("files") or {}).items() if k in ("index.html", "style.css", "app.js")}
            with _lock:
                s = _read(sid)
                s["files"] = {**s["files"], **files}
                _snapshot(s, text)
                s["status"] = "idle"
                _write(s)
        else:
            _log(sid, "app builder", "writing the widget")
            out = _llm(model, "You are Pilot's widget builder. " + WIDGET_CONTRACT,
                       f"Request: {instructions}\nConversation:\n{history}\n\nDesign specification: {json.dumps(s['design'], ensure_ascii=False)}\n\n"
                       f"Ontology (object type and action apiNames to use):\n{api_doc}\n\nCurrent widget: {json.dumps(s.get('widget'), ensure_ascii=False)[:20000]}",
                       WIDGET_SCHEMA, 14000)
            with _lock:
                s = _read(sid)
                s["widget"] = {"name": out.get("name") or s["name"], "description": out.get("description") or "", "html": out.get("html") or "", "css": out.get("css") or "",
                               "js": out.get("js") or "", "parameters": _obj(out.get("parametersJson") or out.get("parameters")), "events": _obj(out.get("eventsJson") or out.get("events"))}
                _snapshot(s, text)
                s["status"] = "idle"
                _write(s)
        _say(sid, "assistant", out.get("summary") or "Done", "app builder")
    except Exception as e:  # noqa: BLE001
        _log(sid, "pilot", traceback.format_exc()[-3000:])
        with _lock:
            s = _read(sid)
            s["status"] = "failed"
            s["messages"].append({"at": _now(), "role": "assistant", "agent": "pilot", "text": f"Something went wrong: {str(e)[:500]}. Fix with Pilot: send the prompt again or describe the problem.", "error": True})
            _write(s)
    finally:
        if token is not None:
            auth._principal.reset(token)
        _running.pop(sid, None)


# ------------------------------------------------------------------------------------------------
# preview (seed data only)
# ------------------------------------------------------------------------------------------------


def _preview_token(s: dict) -> str:
    payload = f"{s['id']}|{s['preview_token']}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()[:24]
    return base64.urlsafe_b64encode(s["id"].encode()).decode().rstrip("=") + "." + sig


def _by_preview(token: str) -> dict:
    try:
        p, sig = token.split(".")
        sid = base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)).decode()
        s = _read(sid)
    except Exception:  # noqa: BLE001
        raise HTTPException(404, "preview not found") from None
    if not hmac.compare_digest(sig, hmac.new(_secret(), f"{s['id']}|{s['preview_token']}".encode(), hashlib.sha256).hexdigest()[:24]):
        raise HTTPException(404, "preview not found")
    return s


PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors *"


def _widget_preview(s: dict) -> str:
    """A widget with a stand-in host: parameters from the seed data, Ontology calls over the seed rows (no network)."""
    w = s.get("widget") or {}
    seed = s.get("seed") or {}
    first = next(iter(seed), None)
    values = {}
    for k, p in (w.get("parameters") or {}).items():
        t = (p or {}).get("type")
        values[k] = {"objectType": first, "filters": []} if t == "objectSet" and first else ([] if t == "array" else 0 if t == "number" else False if t == "boolean" else "")
    stub = f"""<script>
(function () {{
  var seed = {json.dumps(seed)}, values = {json.dumps(values)}, listeners = [];
  function rows(type, filters) {{ return (seed[type] || []).filter(function (r) {{ return (filters || []).every(function (f) {{ return f.op === "eq" ? String(r[f.column]) === String(f.value) : true; }}); }}).map(function (r, i) {{ return Object.assign({{ __pk: String(r[Object.keys(r)[0]] ?? i) }}, r); }}); }}
  var log = function (m) {{ parent.postMessage({{ __pilotPreview: true, text: m }}, "*"); }};
  window.BluesandaiWidget = {{
    parameters: {{ values: values, state: "loaded" }},
    onParameters: function (cb) {{ listeners.push(cb); setTimeout(function () {{ cb(values); }}, 0); }},
    emitEvent: function (id, p) {{ var u = (p && p.parameterUpdates) || {{}}; Object.assign(values, u); log("event " + id + " " + JSON.stringify(u)); listeners.forEach(function (cb) {{ cb(values); }}); }},
    osdk: {{
      currentUser: function () {{ return Promise.resolve({{ id: "seed-user", username: "seed user" }}); }},
      objectSet: function (os) {{ var d = rows(os && os.objectType, os && os.filters); return Promise.resolve({{ data: d, totalCount: d.length }}); }},
      objects: function (t, o) {{ var d = rows(t, o && o.filters); return Promise.resolve({{ data: d, totalCount: d.length }}); }},
      object: function (t, pk) {{ return Promise.resolve(rows(t).find(function (r) {{ return r.__pk === String(pk); }})); }},
      applyAction: function (a, params) {{ log("action " + a + " " + JSON.stringify(params)); return Promise.resolve({{ edits: [] }}); }},
      executeFunction: function () {{ return Promise.reject(new Error("functions are not available in the seed preview")); }}
    }}
  }};
}})();
</script>"""
    return (f"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"light dark\"><style>{w.get('css') or ''}</style>{stub}</head>"
            f"<body>{w.get('html') or ''}<script>{w.get('js') or ''}</script></body></html>")


def _seed_type(s: dict, api_name: str) -> dict:
    t = next((x for x in s["plan"]["object_types"] if x["apiName"] == api_name), None)
    if not t:
        raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectTypeNotFound", "parameters": {"objectType": api_name}})
    return t


def _seed_rows(s: dict, t: dict) -> list[dict]:
    return [{**r, "__pk": str(r.get(t["primaryKey"]))} for r in (s.get("seed") or {}).get(t["apiName"], [])]


def _seed_obj(t: dict, r: dict) -> dict:
    return {"__apiName": t["apiName"], "__primaryKey": r["__pk"], **{k: v for k, v in r.items() if k != "__pk"}}


@router.api_route("/preview/{token}/api/v2/{rest:path}", methods=["GET", "POST"])
async def seed_api(token: str, rest: str, request: Request) -> Response:
    """The OSDK API over the session's seed rows (actions edit them)."""
    import osdk_api

    s = _by_preview(token)
    body = await request.json() if request.method == "POST" and request.headers.get("content-length", "0") != "0" else {}
    parts = rest.split("/")
    if rest == "admin/users/getCurrent":
        return JSONResponse({"id": "seed-user", "username": "seed user", "email": "seed@example.org"})
    if len(parts) >= 4 and parts[0] == "ontologies" and parts[2] == "objects":
        t = _seed_type(s, parts[3])
        rows = _seed_rows(s, t)
        if len(parts) == 5 and parts[4] == "search":
            rows = [r for r in rows if osdk_api._match(r, body.get("where"))]
            rows = osdk_api._sorted(rows, [(f["field"], str(f.get("direction", "asc")).lower() == "desc") for f in (body.get("orderBy") or {}).get("fields") or []])
            page, nxt = osdk_api._page(rows, body.get("pageSize") or 1000, body.get("pageToken"))
            return JSONResponse({"data": [_seed_obj(t, r) for r in page], "nextPageToken": nxt, "totalCount": str(len(rows))})
        if len(parts) == 5 and parts[4] == "aggregate":
            req = osdk_api.AggregateIn(**body)
            groups: dict = {}
            keys = [g["field"] for g in req.groupBy]
            for r in [r for r in rows if osdk_api._match(r, req.where)]:
                groups.setdefault(tuple(r.get(k) for k in keys), []).append(r)
            data = []
            for gk, rs in groups.items():
                metrics = []
                for a in req.aggregation or [{"type": "count"}]:
                    vals = [r.get(a.get("field")) for r in rs if isinstance(r.get(a.get("field")), (int, float))]
                    k = a.get("type")
                    v = len(rs) if k == "count" else sum(vals) if k == "sum" else (sum(vals) / len(vals) if vals else None) if k == "avg" else (min(vals) if vals else None) if k == "min" else (max(vals) if vals else None) if k == "max" else len({json.dumps(r.get(a.get("field")), default=str) for r in rs})
                    metrics.append({"name": a.get("name") or k, "value": v})
                data.append({"group": dict(zip(keys, gk)), "metrics": metrics})
            return JSONResponse({"accuracy": "ACCURATE", "data": data})
        if len(parts) == 4:
            page, nxt = osdk_api._page(rows, int(request.query_params.get("pageSize") or 1000), request.query_params.get("pageToken"))
            return JSONResponse({"data": [_seed_obj(t, r) for r in page], "nextPageToken": nxt, "totalCount": str(len(rows))})
        if len(parts) == 5:
            r = next((x for x in rows if x["__pk"] == parts[4]), None)
            if not r:
                raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectNotFound"})
            return JSONResponse(_seed_obj(t, r))
    if len(parts) == 5 and parts[0] == "ontologies" and parts[2] == "actions" and parts[4] == "apply":
        a = next((x for x in s["plan"]["action_types"] if x["apiName"] == parts[3]), None)
        if not a:
            raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ActionTypeNotFound"})
        t = _seed_type(s, a["objectType"])
        params = dict(body.get("parameters") or {})
        with _lock:
            s = _read(s["id"])
            rows = s["seed"].setdefault(t["apiName"], [])
            pk = params.pop("object", None)
            if a["kind"] == "create":
                row = {p["apiName"]: params.get(p["apiName"]) for p in t["properties"]}
                row[t["primaryKey"]] = row.get(t["primaryKey"]) or uuid.uuid4().hex[:8]
                rows.append(row)
            else:
                hit = next((r for r in rows if str(r.get(t["primaryKey"])) == str(pk)), None)
                if not hit:
                    raise HTTPException(404, {"errorCode": "NOT_FOUND", "errorName": "ObjectNotFound", "parameters": {"primaryKey": pk}})
                if a["kind"] == "delete":
                    rows.remove(hit)
                else:
                    hit.update({k: v for k, v in params.items() if any(p["apiName"] == k for p in t["properties"]) and k != t["primaryKey"]})
            s.setdefault("logs", []).append({"at": _now(), "agent": "preview", "text": f"{a['apiName']} on the seed data: {json.dumps(body.get('parameters'))[:300]}"})
            _write(s)
        return JSONResponse({"validation": {"result": "VALID"}, "edits": {"type": "edits", "edits": []}})
    if len(parts) >= 4 and parts[2] == "queries":
        raise HTTPException(400, {"errorCode": "INVALID_ARGUMENT", "errorName": "QueryNotAvailable", "parameters": {}, "message": "functions are not available in the seed preview"})
    if rest.endswith("objectTypes"):
        return JSONResponse({"data": [{"apiName": t["apiName"], "displayName": t["displayName"], "primaryKey": t["primaryKey"]} for t in s["plan"]["object_types"]]})
    raise HTTPException(404, "not found")


@router.get("/preview/{token}/{path:path}")
def preview(token: str, path: str = "") -> Response:
    s = _by_preview(token)
    headers = {"Content-Security-Policy": PREVIEW_CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if s["kind"] == "widget":
        return Response(_widget_preview(s), media_type="text/html", headers={**headers, "Content-Security-Policy": PREVIEW_CSP.replace("default-src 'self'", "default-src 'none'")})
    if path in ("", "index.html"):
        html = s["files"].get("index.html") or "<!doctype html><title>Pilot</title><p>Pilot is building…</p>"
        cfg = f"<script>window.PILOT_CONFIG = {{ mode: 'seed', osdkBase: location.origin + '/api/pilot/preview/{token}' }};</script>"
        html = re.sub(r"(<head[^>]*>)", r"\1" + cfg, html, count=1, flags=re.I) if re.search(r"<head[^>]*>", html, re.I) else cfg + html
        return Response(html, media_type="text/html", headers=headers)
    if path == "pilot.js":
        return Response(PILOT_JS, media_type="text/javascript", headers=headers)
    if path == "sdk/index.js":
        return Response(_sdk_for_plan(s["plan"])[0], media_type="text/javascript", headers=headers)
    if path in s["files"]:
        mt = "text/javascript" if path.endswith(".js") else "text/css" if path.endswith(".css") else "text/html"
        return Response(s["files"][path], media_type=mt, headers=headers)
    raise HTTPException(404, "not found")


# ------------------------------------------------------------------------------------------------
# deploy
# ------------------------------------------------------------------------------------------------


class DeployIn(BaseModel):
    load_seed: bool = False
    slug: Optional[str] = None
    workshop_module: bool = True


def _checks(s: dict, sdk_js: str) -> list[dict]:
    """CI checks: the app references only SDK exports; its JavaScript parses (Node --check, when installed)."""
    out = []
    if s["kind"] == "application":
        exports = set(re.findall(r"export const (\w+)", sdk_js)) | {"client", "signOut"}
        app = s["files"].get("app.js", "")
        m = re.search(r"import\s*\{([^}]*)\}\s*from\s*[\"']\./pilot\.js[\"']", app)
        names = [x.strip().split(" as ")[0] for x in (m.group(1).split(",") if m else []) if x.strip()]
        missing = [n for n in names if n not in exports]
        out.append({"check": "SDK references", "ok": not missing and bool(m), "detail": f"unknown imports: {', '.join(missing)}" if missing else ("imports ./pilot.js" if m else "app.js does not import ./pilot.js")})
        out.append({"check": "Files", "ok": all(k in s["files"] for k in ("index.html", "app.js")), "detail": ", ".join(sorted(s["files"]))})
        code = app
    else:
        w = s.get("widget") or {}
        code = w.get("js") or ""
        try:
            import custom_widgets

            custom_widgets.check_manifest({"version": "1.0.0", "widgets": {"w": {"name": w.get("name") or "w", "html": "w/index.html", "parameters": w.get("parameters") or {},
                                                                                 "events": w.get("events") or {}}}}, {"w/index.html"})
            out.append({"check": "Widget configuration", "ok": True, "detail": f"{len(w.get('parameters') or {})} parameters, {len(w.get('events') or {})} events"})
        except HTTPException as e:
            out.append({"check": "Widget configuration", "ok": False, "detail": str(e.detail)})
    node = shutil.which("node")
    if node:
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "app.mjs"
            f.write_text(code, "utf-8")
            p = subprocess.run([node, "--check", str(f)], capture_output=True, text=True, timeout=30)
            out.append({"check": "JavaScript syntax", "ok": p.returncode == 0, "detail": (p.stderr or "ok").strip()[-600:]})
    else:
        out.append({"check": "JavaScript syntax", "ok": True, "detail": "Node is not installed: skipped"})
    return out


@router.post("/sessions/{sid}/checks")
def run_checks(sid: str) -> list[dict]:
    s = _read(sid)
    _access(s)
    return _checks(s, _sdk_for_plan(s["plan"])[0])


def _promote(s: dict, load_seed: bool, steps: list[str]) -> tuple[dict, dict]:
    """Proposed object types, properties and actions into the ontology: (object type ids by apiName, action ids by apiName)."""
    import ontology
    import ontology_model

    type_ids: dict[str, str] = {}
    action_ids: dict[str, str] = {}
    for t in s["plan"]["object_types"]:
        if t["status"] == "existing":
            type_ids[t["apiName"]] = t["existingId"]
            if t.get("added"):
                full = ontology._object_type(t["existingId"])
                props = [ontology.Property(**{k: p[k] for k in ("api_name", "display_name", "type") if k in p}) for p in full["properties"]]
                props += [ontology.Property(api_name=p["apiName"], display_name=p["displayName"], type=p["type"]) for p in t["properties"] if p["apiName"] in t["added"]]
                ontology.update_object_type(t["existingId"], ontology.ObjectTypeIn(properties=props))
                steps.append(f"Added {', '.join(t['added'])} to {t['displayName']}")
            continue
        found = next((x for x in ontology.list_object_types() if x.get("api_name") == t["apiName"]), None)
        if found:
            type_ids[t["apiName"]] = found["id"]
            steps.append(f"Reused {t['displayName']} (already promoted)")
            continue
        r = ontology.create_object_type(ontology.ObjectTypeIn(display_name=t["displayName"], api_name=t["apiName"], description=t.get("description") or f"Created by Pilot ({s['name']})",
                                                              properties=[ontology.Property(api_name=p["apiName"], display_name=p["displayName"], type=p["type"]) for p in t["properties"]],
                                                              primary_key=t["primaryKey"], title_property=t.get("titleProperty") or t["primaryKey"]))
        type_ids[t["apiName"]] = r["id"]
        steps.append(f"Created the object type {t['displayName']}")
    for lk in s["plan"]["link_types"]:
        try:
            ontology_model.create_link_type(ontology_model.LinkTypeIn(display_name=lk.get("displayName") or f"{lk['from']} → {lk['to']}", kind="foreign_key", cardinality="many_to_one",
                                                                      source=ontology_model.LinkSide(object_type_id=type_ids[lk["from"]]), target=ontology_model.LinkSide(object_type_id=type_ids[lk["to"]]),
                                                                      foreign_key=lk["foreignKey"]))
            steps.append(f"Linked {lk['from']} to {lk['to']} by {lk['foreignKey']}")
        except HTTPException as e:
            steps.append(f"Link {lk['from']} → {lk['to']} not created: {e.detail}")
    for a in s["plan"]["action_types"]:
        if a["status"] == "existing":
            action_ids[a["apiName"]] = a["existingId"]
            continue
        tid = type_ids[a["objectType"]]
        hit = next((x for x in ontology.list_action_types(tid) if x.get("api_name") == a["apiName"] or (x["display_name"] == a["displayName"] and x["kind"] == a["kind"])), None)
        if hit:
            action_ids[a["apiName"]] = hit["id"]
            continue
        r = ontology.create_action_type(ontology.ActionTypeIn(display_name=a["displayName"], object_type_id=tid, kind=a["kind"]))
        action_ids[a["apiName"]] = r["id"]
        steps.append(f"Created the action {a['displayName']}")
    if load_seed:
        for t in s["plan"]["object_types"]:
            if t["status"] != "proposed":
                continue
            tid = type_ids[t["apiName"]]
            create = next((x for x in ontology.list_action_types(tid) if x["kind"] == "create"), None) or ontology.create_action_type(
                ontology.ActionTypeIn(display_name=f"Create {t['displayName']}", object_type_id=tid, kind="create"))
            params = {p["property"]: p["id"] for p in ontology._action_type(create["id"])["parameters"] if p.get("property")}
            n = 0
            for row in (s.get("seed") or {}).get(t["apiName"], []):
                try:
                    ontology.apply_action(create["id"], ontology.ApplyAction(parameters={params[k]: v for k, v in row.items() if k in params and v is not None}))
                    n += 1
                except HTTPException:
                    continue
            steps.append(f"Loaded {n} seed rows into {t['displayName']} (seed data, not real records)")
    return type_ids, action_ids


@router.post("/sessions/{sid}/deploy")
def deploy(sid: str, req: DeployIn) -> dict:
    s = _read(sid)
    _access(s, "editor")
    if s["status"] == "running":
        raise HTTPException(409, "Pilot is still building")
    sdk_js = _sdk_for_plan(s["plan"])[0]
    checks = _checks(s, sdk_js)
    if not all(c["ok"] for c in checks):
        raise HTTPException(400, {"message": "checks failed", "checks": checks})
    steps: list[str] = []
    type_ids, action_ids = _promote(s, req.load_seed, steps)
    dep = dict(s.get("deployment") or {})
    if s["kind"] == "application":
        import developer_console as dc

        api = os.environ.get("BLUESANDAI_API_URL", "http://localhost:8000").rstrip("/")
        if dep.get("app_id"):
            app = dc._app(dep["app_id"])
        else:
            app = dc.create_app(dc.AppIn(name=s["name"], folder_id=s["folder_id"], kind="client", description=f"Built with Pilot: {s['name']}",
                                         redirect_uris=["http://localhost:8080/auth/callback"]))
            steps.append("Created the Developer Console application")
        slug = req.slug or app["hosting"]["slug"]
        dc.set_hosting(app["id"], dc.HostingIn(slug=slug))
        site = dc.site_url(slug)
        dc.update_app(app["id"], dc.SettingsIn(redirect_uris=[site]))
        dc.set_resources(app["id"], dc.ResourcesIn(object_types=list(type_ids.values()), action_types=list(action_ids.values()), functions=[]))
        sdk = dc.generate_sdk(app["id"], dc.SdkIn())
        files = dc.sdk_files(app["id"], sdk["version"])["files"]
        steps.append(f"Generated SDK {sdk['version']}")
        cfg = f"<script>window.PILOT_CONFIG = {{ mode: 'live', apiUrl: {json.dumps(api)}, clientId: {json.dumps(app['client_id'])} }};</script>"
        html = s["files"]["index.html"]
        html = re.sub(r"(<head[^>]*>)", r"\1" + cfg, html, count=1, flags=re.I) if re.search(r"<head[^>]*>", html, re.I) else cfg + html
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("index.html", html)
            for k, v in s["files"].items():
                if k != "index.html":
                    z.writestr(k, v)
            z.writestr("pilot.js", PILOT_JS)
            z.writestr("sdk/index.js", files["package/index.js"])
        rel = dc._app(app["id"])["hosting"]["releases"]
        version = f"1.0.{len(rel)}"
        base = dc.DIR / "sites" / app["id"] / version
        zf = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
        for info in zf.infolist():
            t = base / info.filename
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_bytes(zf.read(info))
        with dc._lock:
            m = dc._app(app["id"])
            m["hosting"]["releases"].append({"version": version, "files": len(zf.infolist()), "size": len(buf.getvalue()), "uploaded_at": _now(), "uploaded_by": _me()["id"]})
            m["hosting"]["live"] = version
            dc._save(m)
        steps.append(f"Released site {version}")
        dep = {"kind": "application", "app_id": app["id"], "url": site, "version": version, "sdk": sdk["version"], "at": _now()}
    else:
        import custom_widgets as cw

        w = s["widget"] or {}
        wid = _camel(w.get("name") or "widget")
        if dep.get("widget_set_id"):
            ws = cw.get_set(dep["widget_set_id"])
        else:
            ws = cw.create_set(cw.SetIn(name=f"{s['name']} widgets", folder_id=s["folder_id"]))
            steps.append("Created the widget set")
        cw.save_drafts(ws["id"], cw.DraftIn(widgets={wid: cw.SourceWidget(name=w.get("name") or wid, description=w.get("description") or "", html=w.get("html") or "", css=w.get("css") or "",
                                                                          js=w.get("js") or "", parameters=w.get("parameters") or {}, events=w.get("events") or {})}))
        latest = cw.get_set(ws["id"])["latest"]
        if latest:
            a, b, c = (int(x) for x in latest.split("-")[0].split("."))
            version = f"{a}.{b}.{c + 1}"
        else:
            version = "1.0.0"
        cw.release_drafts(ws["id"], cw.ReleaseIn(version=version))
        cw.configure_osdk(ws["id"], cw.OsdkIn(object_types=list(type_ids.values()), action_types=list(action_ids.values()), functions=[]))
        if (auth.current() or {}).get("role") == "admin" or not auth.enabled():
            cw.ontology_apis(ws["id"], cw.ApisIn(enabled=True))
            steps.append("Enabled Ontology APIs for the widget set")
        steps.append(f"Released widget set {version}")
        dep = {"kind": "widget", "widget_set_id": ws["id"], "widget": wid, "version": version, "at": _now()}
        if req.workshop_module:
            import workshop

            params = {}
            for k, p in (w.get("parameters") or {}).items():
                if (p or {}).get("type") == "objectSet" and type_ids:
                    params[k] = {"kind": "objectSet", "object_type_id": next(iter(type_ids.values()))}
            mod = workshop.create_module(workshop.ModuleIn(name=f"{s['name']} (Pilot)", widgets=[{"id": "w1", "type": "custom", "title": w.get("name") or wid, "x": 0, "y": 0, "w": 12, "h": 9,
                                                                                                   "config": {"custom_set_id": ws["id"], "custom_widget_id": wid, "custom_version": version, "custom_params": params}}]))
            dep["module_id"] = mod["id"]
            steps.append("Embedded the widget in a Workshop module")
    with _lock:
        s = _read(sid)
        s["deployment"] = {**dep, "steps": steps, "checks": checks}
        s["messages"].append({"at": _now(), "role": "assistant", "agent": "deploy", "text": "Deployed:\n" + "\n".join(f"- {x}" for x in steps)})
        _write(s)
    return s["deployment"]
