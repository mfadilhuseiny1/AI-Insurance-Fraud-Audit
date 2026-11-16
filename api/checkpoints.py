"""Checkpoints (Security & Governance → Checkpoints): purpose justification for sensitive interactions.

A checkpoint configuration names checkpoint types (TYPES: downloads, uploads, security changes, login and other
interactions), a scope (an organization — its members — or a Project — resources in it), optional conditions
(locations, the submitting user or group, a selected user or group, markings, an action type, an object type; each
can be an exemption with NOT), the language shown (title, Markdown prompt and description), the justification kind
(acknowledgment checkbox, free-text response with a validation regex, dropdown with optional / required free text,
or reauthentication with the user's password and two-factor code) with recent justifications, and for Login a
frequency.

Enforcement is on the server: middleware() maps API requests to checkpoint types (BINDINGS) and, when a configuration
applies and the request carries no justification, answers 428 {"code": "checkpoint_required", "checkpoints": [...],
"context": <token>}. The web app's fetch shows the prompts, POSTs /api/checkpoints/records with the responses and the
context token, and retries the request with the one-time pass it gets back (header X-Bluesandai-Checkpoint, or
`_checkpoint=` in the URL for downloads opened as links, which are sent to the /checkpoint page first).
Non-interactive clients (API tokens) send the justification with the request in X-Bluesandai-Justification (text, or
JSON {config id: response}); Submit action checkpoints apply only to actions submitted from the user interface, and
reauthentication can only be answered interactively.

Each submitted checkpoint is a record (who, when, type, the language as shown, the justification, the checkpointed
items with their markings, the configuration) — written to the audit.3 log as userJustify + requestCreate. Records
are reviewable by their creator, administrators (data governance officers), and Owners of the Project holding a
checkpointed item; items the reviewer cannot access are redacted.

Mounted by server.py under /api/checkpoints.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

import audit3
import auth

log = logging.getLogger("bluesandai.checkpoints")
router = APIRouter(prefix="/api/checkpoints", tags=["checkpoints"])
# POST /api/frontend-exports/export: asked by the browser before it saves data it already shows (not under the open
# /api/checkpoints/ prefix, so the checkpoint middleware and download controls apply to it)
exports_router = APIRouter(prefix="/api/frontend-exports", tags=["checkpoints"])
# the request being handled (set by the middleware): gate() prompts from inside an endpoint
_request: contextvars.ContextVar[Optional[Request]] = contextvars.ContextVar("checkpoint_request", default=None)
DIR = Path("data/checkpoints")
RID = "ri.checkpoints.main.checkpoint."
CONFIG_RID = "ri.checkpoints.main.checkpoint-config."
PASS_TTL = 120
CONTEXT_TTL = 900
_lock = threading.RLock()
_contexts: dict[str, dict] = {}
_passes: dict[str, dict] = {}

R, U, S, M, A, O = "location", "user", "selected", "marking", "action_type", "object_type"
# id: (name, group, application, supported condition kinds, involves resources (Project scope possible))
TYPES: dict[str, tuple[str, str, str, set, bool]] = {
    "compass_export": ("Compass export", "Download", "Files", {R, U, M}, True),
    "dataset_export": ("Dataset export", "Download", "Dataset Preview", {R, U, M}, True),
    "media_set_export": ("Media set export", "Download", "Media Sets", {R, U, M}, True),
    "notepad_export": ("Notepad export", "Download", "Notepad", {R, U, M}, True),
    "report_export": ("Report export", "Download", "Reports", {R, U, M}, True),
    "contour_export": ("Contour export", "Download", "Contour", {R, U, M}, True),
    "quiver_export": ("Quiver export", "Download", "Quiver", {R, U, M}, True),
    "slate_export": ("Slate export", "Download", "Slate", {R, U, M}, True),
    "object_set_export": ("Object set export", "Download", "Object Explorer, Workshop", {U, O}, False),
    "attachment_export": ("Attachment export", "Download", "Actions", {R, U, M}, True),
    "model_export": ("Model export", "Download", "Code Workspaces", {U}, False),
    "export_to_code_workspace": ("Export to Code Workspace", "Download", "Code Workspaces", {R, U, M}, True),
    "api_export": ("API export", "Download", "Developer Console", {U}, False),
    "build_log_export": ("Build log export", "Download", "Builds", {U}, False),
    "frontend_export": ("Frontend export", "Download", "Insight, SQL, Pipeline Builder, Slate", {R, U, M}, True),
    "custom_widgets_allow_downloads": ("Custom Widgets enable allow downloads", "Download", "Workshop", {U}, False),
    "compass_import": ("Compass import", "Upload", "Files", {R, U, M}, True),
    "attachment_import": ("Attachment import", "Upload", "Actions", {U}, False),
    "media_set_import": ("Media set import", "Upload", "Media Sets", {R, U, M}, True),
    "cipher_encrypt": ("Cipher encrypt", "Manage security", "Cipher", {U}, False),
    "cipher_decrypt": ("Cipher decrypt", "Manage security", "Cipher", {U}, False),
    "group_member_addition": ("Group member addition", "Manage security", "Groups", {U, S}, False),
    "group_member_removal": ("Group member removal", "Manage security", "Groups", {U, S}, False),
    "marking_member_addition": ("Marking member addition", "Manage security", "Markings", {U, S, M}, False),
    "marking_member_removal": ("Marking member removal", "Manage security", "Markings", {U, S, M}, False),
    "role_grant_addition": ("Role grant addition", "Manage security", "Projects", {R, U, S}, True),
    "role_grant_removal": ("Role grant removal", "Manage security", "Projects", {R, U, S}, True),
    "reset_two_factor": ("Reset two-factor authentication method", "Manage security", "Platform Settings", {U, S}, False),
    "rotate_oauth_client_secret": ("Rotate OAuth client secret", "Manage security", "Third-party applications", {U}, False),
    "token_create": ("Token create", "Manage security", "Tokens", {U}, False),
    "notepad_lock_data": ("Notepad lock data", "Manage security", "Notepad", {R, U, M}, True),
    "group_membership_expiration_update": ("Group membership expiration update", "Manage security", "Groups", {U, S}, False),
    "update_group_membership_expiration_config": ("Update group membership expiration config", "Manage security", "Groups", {U}, False),
    "project_marking_authorization_addition": ("Project marking authorization addition", "Manage security", "Projects", {R, U, M}, True),
    "project_marking_authorization_removal": ("Project marking authorization removal", "Manage security", "Projects", {R, U, M}, True),
    "project_reference_addition": ("Project reference addition", "Manage security", "Projects", {R, U}, True),
    "project_reference_removal": ("Project reference removal", "Manage security", "Projects", {R, U}, True),
    "custom_widgets_enable_camera": ("Custom Widgets enable camera", "Manage security", "Workshop", {U}, False),
    "custom_widgets_enable_microphone": ("Custom Widgets enable microphone", "Manage security", "Workshop", {U}, False),
    "login": ("Login", "Login", "Platform", {U}, False),
    "code_repository_build": ("Code Repository build", "Other", "Code Repositories", {R, U}, False),
    "code_repository_merge_pull_request": ("Code Repository merge pull request", "Other", "Code Repositories", {U}, False),
    "code_workbook_build": ("Code Workbook build", "Other", "Code Workbook", {R, U, M}, True),
    "contour_create": ("Contour create", "Other", "Contour", {R, U}, True),
    "create_issue": ("Create issue", "Other", "Issues", {R, U, M}, True),
    "data_connection_sync_create": ("Data Connection sync create", "Other", "Data Connection", {U}, False),
    "data_connection_sync_edit": ("Data Connection sync edit", "Other", "Data Connection", {U}, False),
    "deploy_pipeline": ("Deploy pipeline", "Other", "Pipeline Builder", {U}, False),
    "object_explorer_search": ("Object Explorer search", "Other", "Object Explorer", {U, O}, False),
    "retention_policy_application": ("Retention policy application", "Other", "Retention Policies", {R, U, M}, True),
    "run_build": ("Run build", "Other", "Builds", {U}, False),
    "schedule_create": ("Schedule create", "Other", "Schedules", {U}, False),
    "schedule_delete": ("Schedule delete", "Other", "Schedules", {U}, False),
    "schedule_modify": ("Schedule modify", "Other", "Schedules", {U}, False),
    "schedule_run": ("Schedule run", "Other", "Schedules", {U}, False),
    "submit_action": ("Submit action", "Other", "Actions", {U, A, O}, False),
}
# principals that are not a person at a browser: API tokens, application tokens, transform job tokens, schedules
NON_INTERACTIVE = {"token", "oauth", "schedule"}


def interactive(p: Optional[dict]) -> bool:
    return bool(p) and not p.get("service") and p.get("method") not in NON_INTERACTIVE


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "checkpoints"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


_cfg_cache: tuple[float, list[dict]] = (-1.0, [])
# login checkpoints answered: (config id, session id) and the last answer per (config id, user id)
_login_sids: set[tuple[str, str]] = set()
_login_last: dict[tuple[str, str], str] = {}
_login_loaded = False


def _configs() -> list[dict]:
    """Configurations (re-read when the file changes: middleware() asks on every request)."""
    global _cfg_cache
    p = DIR / "configs.json"
    try:
        m = p.stat().st_mtime
    except FileNotFoundError:
        return []
    if m != _cfg_cache[0]:
        _cfg_cache = (m, audit3._read(p, []))
    return _cfg_cache[1]


def _save_configs(rows: list[dict]) -> None:
    global _cfg_cache
    audit3._write(DIR / "configs.json", rows)
    _cfg_cache = (-1.0, [])


def _records() -> list[dict]:
    p = DIR / "records.jsonl"
    if not p.exists():
        return []
    out = []
    with p.open(encoding="utf-8") as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def _append_record(rec: dict) -> None:
    with _lock, (DIR / "records.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    if rec["type"] == "login":
        _note_login(rec)


def _note_login(rec: dict) -> None:
    if rec.get("sid"):
        _login_sids.add((rec["config_id"], rec["sid"]))
    key = (rec["config_id"], rec["user_id"])
    _login_last[key] = max(_login_last.get(key, ""), rec["created_at"])


def _load_logins() -> None:
    global _login_loaded
    if not _login_loaded:
        _login_loaded = True
        for r in _records():
            if r["type"] == "login":
                _note_login(r)


# ------------------------------------------------------------------------------------------------
# interaction context: what a request does
# ------------------------------------------------------------------------------------------------


def _item(rid: str, kind: str = "item") -> dict:
    out = {"type": kind, "id": rid}
    try:
        import db

        it = db.drive_get(rid)
        if it:
            out["name"] = it["name"]
    except Exception:  # noqa: BLE001
        pass
    return out


def _ctx(items: Optional[list[dict]] = None, **kw: Any) -> dict:
    return {"items": items or [], "selected": kw.get("selected") or [], "markings": kw.get("markings") or [], "action_type": kw.get("action_type"),
            "object_types": kw.get("object_types") or [], "detail": kw.get("detail") or ""}


def _p(name: str) -> Any:
    return lambda req, p, body: _ctx([_item(p[name])]) if p.get(name) else _ctx()


def _drive_content(req: Request, p: dict, body: dict) -> Optional[dict]:
    if req.query_params.get("disposition") == "inline":
        return None  # viewing in the browser is not an export
    if req.headers.get("sec-fetch-dest") in ("image", "video", "audio", "track", "iframe", "embed", "object", "frame"):
        return None  # an image, video or PDF shown inside a page
    return _ctx([_item(p["item_id"])])


def _zip(req: Request, p: dict, body: dict) -> dict:
    return _ctx([_item(x) for x in (req.query_params.get("ids") or "").split(",") if x])


def _upload(req: Request, p: dict, body: dict) -> dict:
    parent = req.query_params.get("parent_id") or (body.get("parent_id") if isinstance(body, dict) else None)
    return _ctx([_item(parent, "folder")] if parent else [], detail="upload")


def _explorer(req: Request, p: dict, body: dict) -> dict:
    ot = body.get("object_type_id") if isinstance(body, dict) else None
    return _ctx([], object_types=[ot] if ot else [], detail=(body or {}).get("q", "") if isinstance(body, dict) else "")


def _action(req: Request, p: dict, body: dict) -> Optional[dict]:
    pr = auth.current() or {}
    if not interactive(pr):
        return None  # API calls and the Ontology SDK are not prompted (as in the reference)
    aid = p.get("action_id")
    ot = None
    try:
        import ontology

        ot = ontology._action_type(aid).get("object_type_id")
    except Exception:  # noqa: BLE001
        pass
    return _ctx([{"type": "action-type", "id": aid}], action_type=aid, object_types=[ot] if ot else [])


def _group_diff(add: bool):
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        new = set((body or {}).get("members") or [])
        cur = next((g for g in auth._groups() if g["id"] == p.get("group_id")), None)
        old = set((cur or {}).get("members") or [])
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([{"type": "group", "id": p.get("group_id"), "name": (cur or {}).get("name")}], selected=[{"type": "user", "id": u} for u in sorted(diff)])
    return f


def _group_markings(add: bool):
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        cur = next((g for g in auth._groups() if g["id"] == p.get("group_id")), None)
        old, new = set((cur or {}).get("markings") or []), set((body or {}).get("markings") or [])
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([{"type": "marking", "id": m} for m in sorted(diff)], selected=[{"type": "group", "id": p.get("group_id")}], markings=sorted(diff))
    return f


def _user_markings(add: bool):
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        if not isinstance(body, dict) or body.get("markings") is None:
            return None
        try:
            old = set(auth._user(p["user_id"]).get("markings") or [])
        except HTTPException:
            return None
        new = set(body["markings"])
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([{"type": "marking", "id": m} for m in sorted(diff)], selected=[{"type": "user", "id": p["user_id"]}], markings=sorted(diff))
    return f


def _user_groups(add: bool):
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        if not isinstance(body, dict) or body.get("groups") is None:
            return None
        old = {g["id"] for g in auth._groups() if p["user_id"] in (g.get("members") or [])}
        new = set(body["groups"])
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([{"type": "group", "id": g} for g in sorted(diff)], selected=[{"type": "user", "id": p["user_id"]}])
    return f


def _roles(add: bool):
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        pid = p.get("project_id")
        key = lambda r: (r.get("principal_type"), r.get("principal_id") or "*", r.get("role"))  # noqa: E731
        old = {key(r) for r in auth.project_roles(pid)}
        new = {key(r) for r in (body or {}).get("roles") or []}
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([_item(pid, "project")], selected=[{"type": t, "id": i, "role": r} for t, i, r in sorted(diff)])
    return f


def _cipher(op: str):
    """Single-value Cipher operations (Operational User licenses); a license that bypasses checkpoints is not
    prompted for callers that cannot show one (functions, API calls)."""
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        want = (body or {}).get("operation")
        if (want == "decrypt") != (op == "decrypt"):
            return None
        try:
            import cipher

            r = cipher._find(p["lid"])
        except Exception:  # noqa: BLE001
            return None
        if r.get("bypass_checkpoints") and not interactive(auth.current()):
            return None
        return _ctx([{"type": "cipher-license", "id": cipher.RID + r["id"], "name": r["name"]}], detail=(body or {}).get("context") or "")
    return f


def _plain(req: Request, p: dict, body: dict) -> dict:
    return _ctx([{"type": k.removesuffix("_id"), "id": str(v)} for k, v in p.items()])


def _expiry_diff(req: Request, p: dict, body: dict) -> Optional[dict]:
    """Members whose expiry a group change sets, moves or clears."""
    if not isinstance(body, dict) or body.get("member_expiry") is None:
        return None
    cur = next((g for g in auth._groups() if g["id"] == p.get("group_id")), None) or {}
    old, new = cur.get("member_expiry") or {}, {k: v for k, v in (body.get("member_expiry") or {}).items() if v}
    changed = sorted(u for u in set(old) | set(new) if old.get(u) != new.get(u))
    if not changed:
        return None
    return _ctx([{"type": "group", "id": p.get("group_id"), "name": cur.get("name")}], selected=[{"type": "user", "id": u} for u in changed])


def _expiry_config(req: Request, p: dict, body: dict) -> Optional[dict]:
    if not isinstance(body, dict) or body.get("expiry_policy") is None:
        return None
    cur = next((g for g in auth._groups() if g["id"] == p.get("group_id")), None) or {}
    old = cur.get("expiry_policy") or {}
    new = {k: v for k, v in (body.get("expiry_policy") or {}).items() if v}
    if {k: v for k, v in old.items() if v} == new:
        return None
    return _ctx([{"type": "group", "id": p.get("group_id"), "name": cur.get("name")}], detail=json.dumps(new))


def _authorizations(add: bool):
    """Markings added to (or removed from) the allowed list of a Project's constraints."""
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        import governance_model

        pid = p.get("project_id")
        c = governance_model.project_record(pid).get("constraints") or {}
        old = set(c.get("markings") or []) if c.get("mode") == "allowed" else set()
        new = set((body or {}).get("markings") or []) if (body or {}).get("mode") == "allowed" else set()
        diff = (new - old) if add else (old - new)
        if not diff:
            return None
        return _ctx([_item(pid, "project")], markings=sorted(diff), selected=[{"type": "marking", "id": m} for m in sorted(diff)])
    return f


def _frontend(ctype: str):
    """POST /api/frontend-exports/export: the browser asks before saving data it already shows (a CSV of query
    results, a pivot table, a Slate table) — {type, item_id, detail}."""
    def f(req: Request, p: dict, body: dict) -> Optional[dict]:
        if (body or {}).get("type", "frontend_export") != ctype:
            return None
        return _ctx([_item(body["item_id"])] if body.get("item_id") else [], detail=str(body.get("detail") or "")[:200])
    return f


# (methods, route template regex, checkpoint type, context builder (None result: not this interaction))
BINDINGS: list[tuple[set, re.Pattern, str, Any]] = [
    ({"GET"}, re.compile(r"^/api/drive/items/\{item_id\}/content$"), "compass_export", _drive_content),
    ({"GET"}, re.compile(r"^/api/drive/zip$"), "compass_export", _zip),
    ({"GET"}, re.compile(r"^/api/dataset-preview/\{item_id\}/download$"), "dataset_export", _p("item_id")),
    ({"GET"}, re.compile(r"^/api/media-sets/items/\{item_id\}/content$"), "media_set_export", _p("item_id")),
    ({"GET"}, re.compile(r"^/api/notepad/documents/\{item_id\}/export$"), "notepad_export", _p("item_id")),
    ({"GET"}, re.compile(r"^/api/reports/\{item_id\}/(pdf|widgets/\{widget_id\}/csv)$"), "report_export", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/reports/\{item_id\}/pptx$"), "report_export", _p("item_id")),
    ({"GET"}, re.compile(r"^/api/developer-console/apps/\{app_id\}/sdk/\{version\}(/package\.tgz)?$"), "api_export", _plain),
    ({"GET"}, re.compile(r"^/api/pipeline/builds/\{build_id\}/logs\.txt$"), "build_log_export", _plain),
    ({"POST"}, re.compile(r"^/api/frontend-exports/export$"), "frontend_export", _frontend("frontend_export")),
    ({"POST"}, re.compile(r"^/api/frontend-exports/export$"), "slate_export", _frontend("slate_export")),
    ({"GET"}, re.compile(r"^/api/contour/analyses/\{item_id\}/paths/.*/csv$"), "contour_export", _p("item_id")),
    ({"GET"}, re.compile(r"^/api/quiver-tables/\{aid\}/cards/\{cid\}/csv$"), "quiver_export", _plain),
    ({"GET"}, re.compile(r"^/api/slate/apps/\{app_id\}/export$"), "slate_export", _plain),
    ({"POST"}, re.compile(r"^/api/ontology/explorer/export$"), "object_set_export", _explorer),
    ({"GET"}, re.compile(r"^/api/(ontology/attachments/\{item_id\}/content|v2/ontologies/attachments/\{rid\}/content)$"), "attachment_export", _plain),
    ({"GET"}, re.compile(r"^/api/code-workspaces/\{wid\}/pod/models/\{alias\}/download$"), "model_export", _plain),
    ({"POST"}, re.compile(r"^/api/code-workspaces/\{wid\}/datasets$"), "export_to_code_workspace",
     lambda req, p, b: _ctx([_item(b["item_id"])]) if isinstance(b, dict) and b.get("item_id") else None),
    ({"POST"}, re.compile(r"^/api/drive/(files|import/.*)$"), "compass_import", _upload),
    ({"POST"}, re.compile(r"^/api/dataset-preview/\{item_id\}/upload$"), "compass_import", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/(ontology/attachments|v2/ontologies/attachments/upload)$"), "attachment_import", _plain),
    ({"POST"}, re.compile(r"^/api/media-sets/\{fid\}/items$"), "media_set_import", _p("fid")),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "group_member_addition", _group_diff(True)),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "group_member_removal", _group_diff(False)),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "marking_member_addition", _group_markings(True)),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "marking_member_removal", _group_markings(False)),
    ({"PUT"}, re.compile(r"^/api/auth/users/\{user_id\}$"), "marking_member_addition", _user_markings(True)),
    ({"PUT"}, re.compile(r"^/api/auth/users/\{user_id\}$"), "marking_member_removal", _user_markings(False)),
    ({"PUT"}, re.compile(r"^/api/auth/users/\{user_id\}$"), "group_member_addition", _user_groups(True)),
    ({"PUT"}, re.compile(r"^/api/auth/users/\{user_id\}$"), "group_member_removal", _user_groups(False)),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "group_membership_expiration_update", _expiry_diff),
    ({"PUT"}, re.compile(r"^/api/auth/groups/\{group_id\}$"), "update_group_membership_expiration_config", _expiry_config),
    ({"PUT"}, re.compile(r"^/api/governance/projects/\{project_id\}/constraints$"), "project_marking_authorization_addition", _authorizations(True)),
    ({"PUT"}, re.compile(r"^/api/governance/projects/\{project_id\}/constraints$"), "project_marking_authorization_removal", _authorizations(False)),
    ({"POST"}, re.compile(r"^/api/project-references$"), "project_reference_addition",
     lambda req, p, b: _ctx([_item(b["project_id"], "project"), _item(b.get("item_id") or "")]) if isinstance(b, dict) and b.get("project_id") else None),
    ({"DELETE"}, re.compile(r"^/api/project-references/\{project_id\}/\{item_id\}$"), "project_reference_removal",
     lambda req, p, b: _ctx([_item(p["project_id"], "project"), _item(p["item_id"])])),
    ({"PUT"}, re.compile(r"^/api/auth/projects/\{project_id\}/roles$"), "role_grant_addition", _roles(True)),
    ({"PUT"}, re.compile(r"^/api/auth/projects/\{project_id\}/roles$"), "role_grant_removal", _roles(False)),
    ({"DELETE"}, re.compile(r"^/api/auth/users/\{user_id\}/mfa$"), "reset_two_factor",
     lambda req, p, b: _ctx([], selected=[{"type": "user", "id": p["user_id"]}])),
    ({"POST"}, re.compile(r"^/api/developer-console/apps/\{app_id\}/secret$"), "rotate_oauth_client_secret", _plain),
    ({"POST"}, re.compile(r"^/api/auth/tokens$"), "token_create", lambda req, p, b: _ctx([], detail=(b or {}).get("name", "") if isinstance(b, dict) else "")),
    ({"POST"}, re.compile(r"^/api/cipher/licenses/\{lid\}/operate$"), "cipher_encrypt", _cipher("encrypt")),
    ({"POST"}, re.compile(r"^/api/cipher/visual/decrypt$"), "cipher_decrypt",
     lambda req, p, b: _ctx([_item(b["item_id"])], detail="decrypt selected areas") if isinstance(b, dict) and b.get("item_id") else None),
    ({"POST"}, re.compile(r"^/api/cipher/inline-edit$"), "cipher_encrypt",
     lambda req, p, b: _ctx([], object_types=[b.get("object_type_id")], detail=f"in-line edit of {b.get('property')}") if isinstance(b, dict) else None),
    ({"POST"}, re.compile(r"^/api/cipher/licenses/\{lid\}/operate$"), "cipher_decrypt", _cipher("decrypt")),
    ({"POST"}, re.compile(r"^/api/notepad/documents/\{item_id\}/lock$"), "notepad_lock_data", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/code-repos/\{repo_id\}/build$"), "code_repository_build", _plain),
    ({"POST"}, re.compile(r"^/api/code-repos/\{repo_id\}/(merge|pulls/\{pr_id\}/merge)$"), "code_repository_merge_pull_request", _plain),
    ({"POST"}, re.compile(r"^/api/code-workbooks/\{item_id\}/build$"), "code_workbook_build", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/contour/analyses$"), "contour_create", lambda req, p, b: _ctx([_item(b["folder_id"], "folder")]) if isinstance(b, dict) and b.get("folder_id") else _ctx()),
    ({"POST"}, re.compile(r"^/api/dataset-preview/\{item_id\}/issues$"), "create_issue", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/datasources/sources$"), "data_connection_sync_create", _plain),
    ({"PUT"}, re.compile(r"^/api/datasources/sources/\{source_id\}$"), "data_connection_sync_edit", _plain),
    ({"POST"}, re.compile(r"^/api/pipeline/datasets/deploy$"), "deploy_pipeline", _plain),
    ({"POST"}, re.compile(r"^/api/ontology/explorer/search$"), "object_explorer_search", _explorer),
    ({"PUT"}, re.compile(r"^/api/pipeline/datasets/\{item_id\}/retention$"), "retention_policy_application", _p("item_id")),
    # Data Lifetime: applying or removing a deletion policy, and overrides
    ({"POST"}, re.compile(r"^/api/data-lifetime/policies/\{pid\}/apply$"), "retention_policy_application",
     lambda req, p, b: _ctx([_item(b["dataset_id"])]) if isinstance(b, dict) and b.get("dataset_id") else None),
    ({"DELETE"}, re.compile(r"^/api/data-lifetime/policies/\{pid\}/datasets/\{item_id\}$"), "retention_policy_application", _p("item_id")),
    ({"PUT", "DELETE"}, re.compile(r"^/api/data-lifetime/datasets/\{item_id\}/override$"), "retention_policy_application", _p("item_id")),
    ({"POST"}, re.compile(r"^/api/(pipeline/builds|lineage/builds/run|pipeline/builds/\{build_id\}/rerun)$"), "run_build", _plain),
    ({"POST"}, re.compile(r"^/api/code-repos/\{repo_id\}/schedules$"), "schedule_create", _plain),
    ({"PUT"}, re.compile(r"^/api/code-repos/\{repo_id\}/schedules/\{sched_id\}$"), "schedule_modify", _plain),
    ({"DELETE"}, re.compile(r"^/api/(code-repos/\{repo_id\}/schedules/\{sched_id\}|pipeline/schedules/\{pipeline_id\}/\{schedule_id\})$"), "schedule_delete", _plain),
    ({"POST"}, re.compile(r"^/api/(code-repos/\{repo_id\}/schedules/\{sched_id\}|pipeline/schedules/\{pipeline_id\}/\{schedule_id\})/run$"), "schedule_run", _plain),
    ({"POST"}, re.compile(r"^/api/ontology/action-types/\{action_id\}/apply(-batch)?$"), "submit_action", _action),
]
# requests never interrupted (so a checkpoint can always be answered)
OPEN = re.compile(r"^/api/(checkpoints/|auth/(status|policy|me|logout|heartbeat|login|setup|password/|invitations/|sso/)|presence/|audit/)")


# ------------------------------------------------------------------------------------------------
# which configurations apply
# ------------------------------------------------------------------------------------------------


def _ancestry(item_id: str) -> set[str]:
    try:
        import db

        return {x["id"] for x in db.drive_path(item_id)}
    except Exception:  # noqa: BLE001
        return {item_id}


def _item_markings(ctx: dict) -> set[str]:
    out = set(ctx.get("markings") or [])
    for it in ctx["items"]:
        if it.get("type") in ("item", "folder", "project"):
            try:
                out |= auth.effective_markings(it["id"])
            except Exception:  # noqa: BLE001
                pass
    return out


def _user_groups_of(uid: str) -> set[str]:
    return auth.groups_of(uid)


def _cond(c: dict, ctx: dict, user: dict) -> bool:
    ids = set(c.get("ids") or [])
    kind = c["kind"]
    if kind == R:
        return any(_ancestry(it["id"]) & ids for it in ctx["items"] if it.get("type") in ("item", "folder", "project"))
    if kind == U:
        return user.get("id") in ids or bool(_user_groups_of(user.get("id") or "") & ids)
    if kind == S:
        for s in ctx["selected"]:
            if s["id"] in ids:
                return True
            if s.get("type") == "user" and c.get("member_groups") and _user_groups_of(s["id"]) & ids:
                return True
        return False
    if kind == M:
        return bool(_item_markings(ctx) & ids)
    if kind == A:
        return ctx.get("action_type") in ids
    if kind == O:
        return bool(set(ctx.get("object_types") or []) & ids)
    return False


def applies(cfg: dict, ctype: str, ctx: dict, user: dict) -> bool:
    if not cfg.get("enabled", True) or ctype not in cfg["types"]:
        return False
    scope = cfg.get("scope") or {"kind": "organization", "id": "*"}
    if scope["kind"] == "organization":
        org = user.get("organization_id") or audit3.DEFAULT_ORG
        if scope["id"] not in ("*", org):
            return False
    elif scope["kind"] == "project":
        if not any(auth.project_of(it["id"]) == scope["id"] or it["id"] == scope["id"] for it in ctx["items"] if it.get("type") in ("item", "folder", "project")):
            return False
    for c in cfg.get("conditions") or []:
        hit = _cond(c, ctx, user)
        if hit == bool(c.get("negate")):
            return False
    return True


def _prompt(cfg: dict, user_id: str) -> dict:
    j = cfg["justification"]
    out = {"config_id": cfg["id"], "config_rid": CONFIG_RID + cfg["id"], "title": cfg["title"], "prompt": cfg["prompt"], "description": cfg.get("description_text") or "",
           "justification": j}
    if j.get("recent") and j["kind"] in ("response", "dropdown"):
        out["recent"] = recent(cfg["id"], user_id)
    return out


def recent(config_id: str, user_id: str) -> list[str]:
    cut = _iso(_now() - timedelta(days=30))
    seen: list[str] = []
    for r in reversed(_records()):
        if r["config_id"] == config_id and r["user_id"] == user_id and r["created_at"] >= cut:
            text = (r.get("justification") or {}).get("response")
            if text and text not in seen:
                seen.append(text)
        if len(seen) >= 5:
            break
    return seen


def _fingerprint(user_id: str, ctype: str, ctx: dict, method: str, path: str) -> str:
    key = json.dumps([user_id, ctype, sorted(i["id"] for i in ctx["items"] if i.get("id")), sorted(s["id"] for s in ctx["selected"]), method, path])
    return hashlib.sha256(key.encode()).hexdigest()


def _gc() -> None:
    now = time.time()
    for d in (_contexts, _passes):
        for k in [k for k, v in d.items() if v["exp"] < now]:
            d.pop(k, None)


def _login_pending(user: dict, sid: Optional[str]) -> list[dict]:
    """Login checkpoints this session still has to answer."""
    cfgs = [c for c in _configs() if "login" in c["types"]]
    if not cfgs:
        return []
    _load_logins()
    out = []
    for cfg in cfgs:
        if not applies(cfg, "login", _ctx(), user):
            continue
        if sid and (cfg["id"], sid) in _login_sids:
            continue
        freq = cfg.get("frequency_minutes")
        if freq and _login_last.get((cfg["id"], user["id"]), "") >= _iso(_now() - timedelta(minutes=freq)):
            continue
        out.append(cfg)
    return out


def _sid(request: Request) -> Optional[str]:
    c = request.cookies.get(auth.COOKIE)
    return auth._session_id(auth._sha(c)) if c else None


def check(request: Request, template: str, params: dict, body: Any) -> list[tuple[str, dict, list[dict]]]:
    """[(checkpoint type, context, applicable configurations)] for a request."""
    p = auth.current()
    if not p or p.get("service"):
        return []
    user = {**p}
    out = []
    for methods, pattern, ctype, build in BINDINGS:
        if request.method not in methods or not pattern.search(template):
            continue
        try:
            ctx = build(request, params, body if isinstance(body, dict) else {})
        except Exception:  # noqa: BLE001 - a context that cannot be read is not checkpointed
            log.exception("checkpoint context %s", ctype)
            ctx = None
        if ctx is None:
            continue
        cfgs = [c for c in _configs() if applies(c, ctype, ctx, user)]
        if cfgs:
            out.append((ctype, ctx, cfgs))
    return out


DOWNLOAD_ROUTES = [b for b in BINDINGS if TYPES[b[2]][1] == "Download"]
# paths that can be a download (a cheap test before routing the request)
DOWNLOAD_HINT = re.compile(r"/(content|zip|download|export|csv|pdf|pptx|datasets)$")


_FILES_ID = re.compile(r"\b[0-9a-f]{16}\b")
_TYPE_ID = re.compile(r"\bot-[0-9a-f]{12}\b")


def _backing_datasets(type_ids: set[str]) -> set[str]:
    import ontology

    out: set[str] = set()
    for tid in type_ids:
        try:
            t = ontology._read(ontology._path("object-types", tid)) or {}
        except Exception:  # noqa: BLE001
            continue
        if (t.get("backing_dataset") or {}).get("dataset_id"):
            out.add(t["backing_dataset"]["dataset_id"])
        for ds in t.get("additional_datasources") or []:
            if isinstance(ds, dict) and ds.get("dataset_id"):
                out.add(ds["dataset_id"])
    return out


def export_sources(item_id: str) -> set[str]:
    """The datasets an exported resource reads (an analysis, report, Quiver or Slate app): Files datasets it names,
    and the backing datasets of the object types it names."""
    import db
    import drive

    item = db.drive_get(item_id) if db.enabled() else None
    if not item or item.get("kind") != "file" or int(item.get("size_bytes") or 0) > 5_000_000:
        return set()
    try:
        text = drive.read_bytes(item).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return set()
    if not text.lstrip().startswith(("{", "[")):
        return set()  # a dataset or file itself, not a record of an analysis
    out = {i for i in _FILES_ID.findall(text) if i != item_id}
    out = {i for i in out if (db.drive_get(i) or {}).get("kind") == "file"}
    return out | _backing_datasets(set(_TYPE_ID.findall(text)))


def download_refusal(request: Request, template: str, params: dict, body: Any = None) -> Optional[str]:
    """Download controls: an export needs a role with the Download operation on what it exports — the Files resource
    itself, the datasets an analysis / report / app reads, and the backing datasets of exported object types (the
    Discoverer role, and custom roles without Download, cannot export)."""
    for methods, pattern, ctype, build in DOWNLOAD_ROUTES:
        if request.method not in methods or not pattern.search(template):
            continue
        try:
            ctx = build(request, params, body if isinstance(body, dict) else {})
        except Exception:  # noqa: BLE001
            ctx = None
        ctx = ctx or {}
        ids: list[tuple[str, str]] = []
        for it in ctx.get("items") or []:
            if it.get("type") in ("item", "folder", "project") or _FILES_ID.fullmatch(str(it.get("id") or "")):
                ids.append((it["id"], it.get("name") or "this resource"))
                ids += [(s, "a dataset it reads") for s in export_sources(it["id"])]
        ids += [(s, "the data of the exported objects") for s in _backing_datasets(set(ctx.get("object_types") or []))]
        for rid, label in ids:
            if not auth.has_operation(rid, "download"):
                return f"Your role does not allow downloading {label} (the Download operation)"
    return None


async def middleware(request: Request, call_next):  # noqa: ANN001, ANN201
    path = request.url.path
    _request.set(request)
    if not path.startswith("/api/") or request.method in ("OPTIONS", "HEAD") or OPEN.match(path):
        return await call_next(request)
    p = auth.current()
    if p and not p.get("service") and auth.enabled() and request.method in ("GET", "POST") and DOWNLOAD_HINT.search(path):
        template, params = _route(request)
        dl_body: Any = {}
        if template and request.method == "POST" and "json" in (request.headers.get("content-type") or ""):
            try:
                dl_body = json.loads(await request.body() or b"{}")
            except ValueError:
                dl_body = {}
        why = download_refusal(request, template, params, dl_body) if template else None
        if why:
            return JSONResponse({"detail": why, "code": "download_not_allowed"}, status_code=403)
    if not p or p.get("service") or not _configs():
        return await call_next(request)
    sid = _sid(request)
    # login checkpoints: an interactive session answers them before anything else
    if interactive(p):
        pending = _login_pending(p, sid)
        if pending:
            return _required(request, p, [("login", _ctx(), pending)], login=True)
    # the route template is known only after routing: match the path against the app's routes
    template, params = _route(request)
    if template is None:
        return await call_next(request)
    body: Any = {}
    if request.method in ("POST", "PUT", "PATCH") and "json" in (request.headers.get("content-type") or ""):
        try:
            body = json.loads(await request.body() or b"{}")
        except ValueError:
            body = {}
    hits = check(request, template, params, body)
    if not hits:
        return await call_next(request)
    token = request.headers.get("x-bluesandai-checkpoint") or request.query_params.get("_checkpoint")
    _gc()
    if token and token in _passes:
        ps = _passes[token]
        want = {_fingerprint(p["id"], t, c, request.method, path) for t, c, _ in hits}
        if ps["user_id"] == p["id"] and want <= set(ps["fingerprints"]):
            _passes.pop(token, None)
            return await call_next(request)
    inline = request.headers.get("x-bluesandai-justification")
    if inline:
        try:
            _answer_inline(request, p, hits, inline)
            return await call_next(request)
        except HTTPException as e:
            return JSONResponse({"detail": e.detail, "code": "checkpoint_rejected"}, status_code=e.status_code)
    return _required(request, p, hits)


def gate(ctype: str, ctx: dict) -> None:
    """A checkpoint for an interaction the middleware cannot see from the request (inside an uploaded release, a
    browser-side export): answered like any other — a one-time pass from the retried request, or an inline
    justification header; otherwise a 428 whose `detail` is the checkpoint payload."""
    request, p = _request.get(), auth.current()
    if request is None or not p or p.get("service") or not _configs():
        return
    cfgs = [c for c in _configs() if applies(c, ctype, ctx, p)]
    if not cfgs:
        return
    hits = [(ctype, ctx, cfgs)]
    token = request.headers.get("x-bluesandai-checkpoint") or request.query_params.get("_checkpoint")
    _gc()
    if token and token in _passes:
        ps = _passes[token]
        if ps["user_id"] == p["id"] and _fingerprint(p["id"], ctype, ctx, request.method, request.url.path) in set(ps["fingerprints"]):
            _passes.pop(token, None)
            return
    inline = request.headers.get("x-bluesandai-justification")
    if inline:
        _answer_inline(request, p, hits, inline)
        return
    resp = _required(request, p, hits)
    raise HTTPException(428, json.loads(resp.body) if isinstance(resp, JSONResponse) else "A checkpoint asks for a justification first")


class FrontendExportIn(BaseModel):
    # frontend_export, or slate_export for a Slate app's own downloads
    type: Literal["frontend_export", "slate_export"] = "frontend_export"
    item_id: Optional[str] = None
    detail: str = Field("", max_length=200)


@exports_router.post("/export")
def frontend_export(req: FrontendExportIn) -> dict:
    """Asked before the browser saves data it shows (query results, a preview, a Slate table): checkpoints and
    download controls apply in the middleware; the answer only says the browser may go on."""
    auth.require_user()
    return {"ok": True}


def _route(request: Request) -> tuple[Optional[str], dict]:
    """The route template and path parameters of a request (routing happens after the middleware)."""
    from starlette.routing import Match

    def walk(routes: Any) -> tuple[Optional[str], dict]:
        for r in routes:
            # newer FastAPI keeps included routers nested: their effective routes carry the full path
            cands = getattr(r, "effective_candidates", None)
            if callable(cands):
                hit = walk(cands())
                if hit[0]:
                    return hit
                continue
            try:
                m, child = r.matches(request.scope)
            except Exception:  # noqa: BLE001
                continue
            if m == Match.FULL:
                return getattr(r, "path", None) or None, child.get("path_params", {})
        return None, {}

    app = request.scope.get("app")
    return walk(getattr(getattr(app, "router", None), "routes", []))


def _required(request: Request, p: dict, hits: list, login: bool = False) -> Any:
    ctx_id = secrets.token_urlsafe(18)
    _contexts[ctx_id] = {"user_id": p["id"], "exp": time.time() + CONTEXT_TTL, "sid": _sid(request), "login": login,
                         "hits": [{"type": t, "ctx": c, "configs": [x["id"] for x in cfgs], "fingerprint": _fingerprint(p["id"], t, c, request.method, request.url.path)}
                                  for t, c, cfgs in hits]}
    prompts = []
    seen = set()
    for t, c, cfgs in hits:
        for cfg in cfgs:
            if cfg["id"] not in seen:
                seen.add(cfg["id"])
                prompts.append({**_prompt(cfg, p["id"]), "type": t, "type_name": TYPES[t][0]})
    payload = {"detail": "A checkpoint asks for a justification first", "code": "checkpoint_required", "context": ctx_id, "checkpoints": prompts,
               "types": sorted({t for t, _, _ in hits}), "items": [i for _, c, _ in hits for i in c["items"]][:20]}
    nav = request.method == "GET" and (request.headers.get("sec-fetch-mode") == "navigate" or "text/html" in (request.headers.get("accept") or ""))
    if nav:
        return RedirectResponse(f"{auth.web_url()}/checkpoint?context={ctx_id}&next={quote(str(request.url), safe='')}", status_code=303)
    return JSONResponse(payload, status_code=428)


# ------------------------------------------------------------------------------------------------
# answering
# ------------------------------------------------------------------------------------------------


class Answer(BaseModel):
    acknowledged: bool = False
    response: str = ""
    selected: list[str] = Field(default_factory=list)
    password: str = ""
    code: str = ""


def _validate(cfg: dict, a: Answer, user: dict, interactive: bool = True) -> dict:
    j = cfg["justification"]
    kind = j["kind"]
    if kind == "acknowledgment":
        if not a.acknowledged:
            raise HTTPException(400, f'"{cfg["title"]}": tick the acknowledgment')
        return {"kind": kind, "acknowledged": True, "checkbox_text": j.get("checkbox_text") or ""}
    if kind == "response":
        text = a.response.strip()
        if not text:
            raise HTTPException(400, f'"{cfg["title"]}": a justification is required')
        if j.get("validation") and not re.fullmatch(j["validation"], text):
            raise HTTPException(400, f'"{cfg["title"]}": the justification does not have the required format')
        return {"kind": kind, "response": text}
    if kind == "dropdown":
        opts = j.get("options") or []
        sel = [s for s in a.selected if s in opts]
        if not sel:
            raise HTTPException(400, f'"{cfg["title"]}": choose a justification')
        if len(sel) > 1 and not j.get("multiple"):
            raise HTTPException(400, f'"{cfg["title"]}": choose one justification')
        text = a.response.strip()
        if j.get("free_text") == "required" and not text:
            raise HTTPException(400, f'"{cfg["title"]}": add a written justification')
        return {"kind": kind, "selected": sel, **({"response": text} if text and j.get("free_text") in ("optional", "required") else {})}
    if kind == "reauthentication":
        if not interactive:
            raise HTTPException(428, f'"{cfg["title"]}" asks you to sign in again: answer it in the platform')
        with auth._db() as con:
            row = con.execute("SELECT pw_hash, record FROM users WHERE id = ?", (user["id"],)).fetchone()
        if row and row[0] in (None, "!") or (row and not a.password and json.loads(row[1]).get("sso_only")):
            # a single sign-on account: its authenticator code, or a single sign-on in the last few minutes
            u = json.loads(row[1])
            if u.get("mfa_enabled") and a.code:
                auth._check_mfa(u, a.code, "")
                return {"kind": kind, "reauthenticated": True, "method": "two-factor code"}
            with auth._db() as con:
                (last,) = con.execute("SELECT MAX(created_at) FROM sessions WHERE user_id = ? AND method = 'sso'", (user["id"],)).fetchone()
            if last and last >= _iso(_now() - timedelta(minutes=SSO_REAUTH_MINUTES)):
                return {"kind": kind, "reauthenticated": True, "method": "single sign-on"}
            raise HTTPException(400, f"This account signs in with single sign-on: sign in again with it (Sign in again below), then submit within "
                                     f"{SSO_REAUTH_MINUTES} minutes" + (", or enter your two-factor code" if u.get("mfa_enabled") else ""))
        if not row:
            raise HTTPException(400, "Reauthentication needs a password")
        if not auth.verify_password(a.password, row[0]):
            audit3.emit("CHECKPOINTS_REAUTHENTICATE", ["authenticationCheck"], {"authenticationCheckTargets": [user.get("username")]},
                        {"authenticationCheckResult": False, "authenticationCheckResultMessage": "wrong password at a checkpoint"}, result="UNAUTHORIZED",
                        product="checkpoints")
            raise HTTPException(401, "The password is wrong")
        u = json.loads(row[1])
        if u.get("mfa_enabled"):
            auth._check_mfa(u, a.code, "")
        return {"kind": kind, "reauthenticated": True}
    raise HTTPException(400, "unknown justification kind")


# a single sign-on this recent answers a reauthentication prompt of an account without a password
SSO_REAUTH_MINUTES = 5


def _record(cfg: dict, ctype: str, ctx: dict, just: dict, user: dict, sid: Optional[str]) -> dict:
    rid = uuid.uuid4().hex
    marks = sorted(_item_markings(ctx))
    rec = {"id": rid, "rid": RID + rid, "config_id": cfg["id"], "config_rid": CONFIG_RID + cfg["id"], "config_name": cfg["name"], "type": ctype,
           "user_id": user["id"], "username": user.get("username"), "org": user.get("organization_id") or audit3.DEFAULT_ORG, "created_at": _iso(),
           "title": cfg["title"], "prompt": cfg["prompt"], "description": cfg.get("description_text") or "", "justification": just,
           "items": ctx["items"], "selected": ctx["selected"], "markings": marks, "action_type": ctx.get("action_type"),
           "object_types": ctx.get("object_types") or [], "projects": sorted({p for it in ctx["items"] if (p := auth.project_of(it.get("id")))}), "sid": sid}
    _append_record(rec)
    text = just.get("response") or ", ".join(just.get("selected") or []) or ("acknowledged" if just.get("acknowledged") else just["kind"])
    audit3.emit("CHECKPOINTS_SUBMIT_CHECKPOINT", ["userJustify", "requestCreate"],
                {"userJustifyId": user["id"], "userJustification": [text], "createdRequestAffectedResources": ctx["items"],
                 "createdRequestDescription": f"{TYPES[ctype][0]} checkpoint"}, {"createdRequestIds": [rec["rid"]]}, product="checkpoints", uid=user["id"])
    return rec


class Submit(BaseModel):
    context: str
    answers: dict[str, Answer]


@router.post("/records")
def submit(req: Submit, request: Request) -> dict:
    """Answer the checkpoints of a 428 response: one record per configuration and checkpointed interaction, and a
    one-time pass for retrying the request (X-Bluesandai-Checkpoint, or ?_checkpoint= on a link)."""
    p = auth.require_user()
    _gc()
    c = _contexts.get(req.context)
    if not c or c["user_id"] != p["id"]:
        raise HTTPException(410, "This checkpoint expired: try the interaction again")
    cfgs = {x["id"]: x for x in _configs()}
    just: dict[str, dict] = {}
    for cid in {cid for h in c["hits"] for cid in h["configs"]}:
        cfg = cfgs.get(cid)
        if not cfg:
            continue
        a = req.answers.get(cid)
        if not a:
            raise HTTPException(400, f'"{cfg["title"]}" is not answered')
        just[cid] = _validate(cfg, a, p)
    records = []
    for h in c["hits"]:
        for cid in h["configs"]:
            if cid in just:
                records.append(_record(cfgs[cid], h["type"], h["ctx"], just[cid], p, c.get("sid") or _sid(request)))
    _contexts.pop(req.context, None)
    token = secrets.token_urlsafe(18)
    _passes[token] = {"user_id": p["id"], "fingerprints": [h["fingerprint"] for h in c["hits"]], "exp": time.time() + PASS_TTL}
    return {"pass": token, "records": [r["rid"] for r in records]}


def _answer_inline(request: Request, p: dict, hits: list, header: str) -> None:
    """X-Bluesandai-Justification: a text answer for every checkpoint, or JSON {config id: {acknowledged, response, selected}}."""
    try:
        parsed = json.loads(header)
    except ValueError:
        parsed = None
    for t, ctx, cfgs in hits:
        for cfg in cfgs:
            if isinstance(parsed, dict):
                raw = parsed.get(cfg["id"]) or {}
                a = Answer(**raw) if isinstance(raw, dict) else Answer(response=str(raw), acknowledged=True)
            else:
                a = Answer(acknowledged=True, response=header, selected=[header])
            _record(cfg, t, ctx, _validate(cfg, a, p, interactive=False), p, _sid(request))


@router.get("/context/{ctx_id}")
def context(ctx_id: str) -> dict:
    """The prompts of a pending checkpoint (the /checkpoint page for downloads opened as links)."""
    p = auth.require_user()
    c = _contexts.get(ctx_id)
    if not c or c["user_id"] != p["id"]:
        raise HTTPException(410, "This checkpoint expired: try the interaction again")
    cfgs = {x["id"]: x for x in _configs()}
    prompts, seen = [], set()
    for h in c["hits"]:
        for cid in h["configs"]:
            if cid in cfgs and cid not in seen:
                seen.add(cid)
                prompts.append({**_prompt(cfgs[cid], p["id"]), "type": h["type"], "type_name": TYPES[h["type"]][0]})
    return {"context": ctx_id, "checkpoints": prompts, "items": [i for h in c["hits"] for i in h["ctx"]["items"]][:20]}


# ------------------------------------------------------------------------------------------------
# configurations
# ------------------------------------------------------------------------------------------------


class Condition(BaseModel):
    kind: Literal["location", "user", "selected", "marking", "action_type", "object_type"]
    ids: list[str] = Field(min_length=1)
    negate: bool = False
    member_groups: bool = False


class Justification(BaseModel):
    kind: Literal["acknowledgment", "response", "dropdown", "reauthentication"]
    checkbox_text: str = "I acknowledge"
    validation: str = ""
    options: list[str] = Field(default_factory=list)
    multiple: bool = False
    free_text: Literal["none", "optional", "required"] = "none"
    recent: bool = False


class Scope(BaseModel):
    kind: Literal["organization", "project"]
    id: str


class ConfigIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    types: list[str] = Field(min_length=1)
    scope: Scope
    conditions: list[Condition] = Field(default_factory=list)
    title: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=4000)
    description_text: str = Field("", max_length=4000)
    justification: Justification
    frequency_minutes: Optional[int] = Field(None, ge=1, le=525600)
    enabled: bool = True


def _check_config(req: ConfigIn) -> None:
    bad = [t for t in req.types if t not in TYPES]
    if bad:
        raise HTTPException(400, f"unknown checkpoint type(s): {', '.join(bad)}")
    common = set.intersection(*(TYPES[t][3] for t in req.types))
    kinds = [c.kind for c in req.conditions]
    if len(kinds) != len(set((c.kind, c.negate) for c in req.conditions)):
        raise HTTPException(400, "one matcher of each kind (and one exemption of each kind)")
    for k in kinds:
        if k not in common:
            raise HTTPException(400, f"the {k.replace('_', ' ')} condition is not available for {', '.join(TYPES[t][0] for t in req.types)}")
    if req.scope.kind == "project" and not all(TYPES[t][4] for t in req.types):
        raise HTTPException(400, "a Project scope needs checkpoint types that involve resources")
    if req.justification.kind == "reauthentication" and "login" in req.types:
        raise HTTPException(400, "reauthentication is not available for Login checkpoints")
    if req.justification.kind == "dropdown" and not req.justification.options:
        raise HTTPException(400, "a dropdown needs at least one option")
    if req.justification.validation:
        try:
            re.compile(req.justification.validation)
        except re.error as e:
            raise HTTPException(400, f"the response validation is not a valid regular expression: {e}") from None
    if req.frequency_minutes and req.types != ["login"]:
        raise HTTPException(400, "a frequency is only for Login checkpoints")


def _may_configure(scope: Scope) -> None:
    p = auth.require_user()
    if not auth.enabled() or p.get("role") == "admin":
        return
    if scope.kind == "project" and auth.role_for(scope.id) == "owner":
        return
    raise HTTPException(403, "Configuring checkpoints needs administrator (data governance officer) rights, or the Owner role on the scoped Project")


@router.get("/types")
def types() -> list[dict]:
    auth.require_user()
    return [{"id": k, "name": v[0], "group": v[1], "application": v[2], "conditions": sorted(v[3]), "resources": v[4]} for k, v in TYPES.items()]


@router.get("/configs")
def list_configs() -> list[dict]:
    p = auth.require_user()
    rows = _configs()
    if auth.enabled() and p.get("role") != "admin":
        rows = [c for c in rows if c["scope"]["kind"] == "project" and auth.role_for(c["scope"]["id"]) == "owner"]
    return [{**c, "rid": CONFIG_RID + c["id"]} for c in rows]


@router.post("/configs")
def create_config(req: ConfigIn) -> dict:
    _may_configure(req.scope)
    _check_config(req)
    p = auth.current() or {}
    cfg = {"id": uuid.uuid4().hex[:12], **req.model_dump(), "created_by": p.get("username"), "created_at": _iso(), "updated_at": _iso()}
    with _lock:
        _save_configs([*_configs(), cfg])
    audit3.emit("CHECKPOINTS_CREATE_CONFIG", ["appConfigCreate"], {"createAppConfigDescription": f"checkpoint configuration {req.name}"},
                {"createdAppConfigIds": [CONFIG_RID + cfg["id"]]}, product="checkpoints")
    return {**cfg, "rid": CONFIG_RID + cfg["id"]}


@router.put("/configs/{cid}")
def update_config(cid: str, req: ConfigIn) -> dict:
    _may_configure(req.scope)
    _check_config(req)
    with _lock:
        rows = _configs()
        cur = next((c for c in rows if c["id"] == cid), None)
        if not cur:
            raise HTTPException(404, "checkpoint configuration not found")
        _may_configure(Scope(**cur["scope"]))
        cur.update(req.model_dump(), updated_at=_iso())
        _save_configs(rows)
    audit3.emit("CHECKPOINTS_UPDATE_CONFIG", ["appConfigUpdate"], {"updatedAppConfigIds": [CONFIG_RID + cid], "updateAppConfigDescription": req.name}, product="checkpoints")
    return {**cur, "rid": CONFIG_RID + cid}


# -- Marketplace: a configuration packaged as a product, installed in a Project --


def _packaging_problems(c: dict) -> list[str]:
    out = []
    if len(c["types"]) != 1:
        out.append("only configurations with one checkpoint type can be packaged")
    for cond in c.get("conditions") or []:
        if cond["kind"] == "marking":
            out.append("configurations with marking matchers cannot be packaged")
        if cond["kind"] in ("user", "selected") and not cond.get("member_groups") and len(cond.get("ids") or []) == 1 and not str(cond["ids"][0]).startswith("grp-"):
            out.append("a condition naming one user cannot be packaged (use a group)")
    return out


@router.get("/configs/{cid}/package")
def package_config(cid: str) -> dict:
    """A Marketplace product with this configuration (refused for what the reference cannot package: several types,
    marking matchers, single-user conditions). Its location conditions become installation inputs."""
    cur = next((c for c in _configs() if c["id"] == cid), None)
    if not cur:
        raise HTTPException(404, "checkpoint configuration not found")
    _may_configure(Scope(**cur["scope"]))
    problems = _packaging_problems(cur)
    if problems:
        raise HTTPException(400, "; ".join(problems))
    keep = {k: cur[k] for k in ("name", "description", "types", "conditions", "title", "prompt", "description_text", "justification", "frequency_minutes", "enabled")}
    inputs = sorted({i for c in keep["conditions"] if c["kind"] == "location" for i in c["ids"]})
    return {"kind": "bluesandai.checkpoints.product", "version": 1, "name": cur["name"], "packaged_at": _iso(),
            "packaged_by": (auth.current() or {}).get("username"), "configuration": keep, "inputs": inputs}


class InstallIn(BaseModel):
    package: dict
    # the installation's Project: the configuration's scope, and its location matcher when the package has none
    project_id: str
    # packaged location ids -> resources here (inputs of the installation)
    mapping: dict[str, str] = Field(default_factory=dict)


@router.post("/install")
def install_config(req: InstallIn) -> dict:
    """Install a packaged configuration: scoped to the installation Project, limited to it (or to the mapped
    resources), a new id."""
    pk = req.package
    if pk.get("kind") != "bluesandai.checkpoints.product" or not isinstance(pk.get("configuration"), dict):
        raise HTTPException(400, "not a checkpoint configuration product")
    cfg = dict(pk["configuration"])
    conds = []
    for c in cfg.get("conditions") or []:
        if c["kind"] == "location":
            ids = [req.mapping.get(i) for i in c["ids"]]
            if not all(ids):
                raise HTTPException(400, "map every location input of the package to a resource here")
            c = {**c, "ids": ids}
        conds.append(c)
    if not any(c["kind"] == "location" and not c.get("negate") for c in conds):
        conds.append({"kind": "location", "ids": [req.project_id], "negate": False, "member_groups": False})
    body = ConfigIn(**{**cfg, "conditions": conds, "scope": {"kind": "project", "id": req.project_id}})
    out = create_config(body)
    audit3.emit("CHECKPOINTS_INSTALL_CONFIG", ["appConfigCreate"], {"createAppConfigDescription": f"installed {pk.get('name')}"},
                {"createdAppConfigIds": [out["rid"]]}, product="checkpoints")
    return {**out, "installed_from": {"name": pk.get("name"), "packaged_at": pk.get("packaged_at")}}


@router.delete("/configs/{cid}")
def delete_config(cid: str) -> dict:
    with _lock:
        rows = _configs()
        cur = next((c for c in rows if c["id"] == cid), None)
        if not cur:
            raise HTTPException(404, "checkpoint configuration not found")
        _may_configure(Scope(**cur["scope"]))
        _save_configs([c for c in rows if c["id"] != cid])
    audit3.emit("CHECKPOINTS_DELETE_CONFIG", ["appConfigDelete"], {"deletedAppConfigIds": [CONFIG_RID + cid], "deleteAppConfigDescription": cur["name"]},
                product="checkpoints")
    return {"deleted": cid}


class PreviewIn(BaseModel):
    type: str
    items: list[str] = Field(default_factory=list)
    user_id: Optional[str] = None
    action_type: Optional[str] = None
    object_type: Optional[str] = None
    selected: list[str] = Field(default_factory=list)


@router.post("/evaluate")
def evaluate(req: PreviewIn) -> dict:
    """The checkpoints an interaction would show (a user's own, or any user's for administrators): for application
    forms that show the prompts inline, and for testing configurations."""
    p = auth.require_user()
    user = p
    if req.user_id and req.user_id != p.get("id"):
        auth.require_admin()
        u = auth._user(req.user_id)
        user = {**auth._public_user(u)}
    if req.type not in TYPES:
        raise HTTPException(400, "unknown checkpoint type")
    ctx = _ctx([_item(i) for i in req.items], action_type=req.action_type, object_types=[req.object_type] if req.object_type else [],
               selected=[{"type": "group" if s.startswith("g-") else "user", "id": s} for s in req.selected])
    cfgs = [c for c in _configs() if applies(c, req.type, ctx, user)]
    return {"checkpoints": [{**_prompt(c, user["id"]), "type": req.type, "type_name": TYPES[req.type][0], "name": c["name"]} for c in cfgs]}


@router.get("/login")
def login_status(request: Request) -> dict:
    """Login checkpoints the signed-in session still has to answer (the web app shows them right after sign-in)."""
    p = auth.require_user()
    pending = _login_pending(p, _sid(request)) if interactive(p) else []
    if not pending:
        return {"checkpoints": []}
    return json.loads(_required(request, p, [("login", _ctx(), pending)], login=True).body)


# ------------------------------------------------------------------------------------------------
# reviewing records
# ------------------------------------------------------------------------------------------------


def _can_review(p: dict, rec: dict) -> bool:
    if not auth.enabled() or p.get("role") == "admin" or rec["user_id"] == p.get("id"):
        return True
    return any(auth.role_for(pid) == "owner" for pid in rec.get("projects") or [])


def _redact(p: dict, rec: dict) -> dict:
    out = dict(rec)
    items = []
    for it in rec.get("items") or []:
        if it.get("type") in ("item", "folder", "project") and not auth.can_access(it["id"]):
            items.append({"type": it.get("type"), "id": "redacted", "name": "(redacted)"})
        else:
            items.append(it)
    out["items"] = items
    out.pop("sid", None)
    return out


@router.get("/records")
def records(type: Optional[str] = None, user_id: Optional[str] = None, org: Optional[str] = None, project: Optional[str] = None,  # noqa: A002
            resource: Optional[str] = None, start: Optional[str] = None, end: Optional[str] = None, mine: bool = False, limit: int = 500) -> dict:
    p = auth.require_user()
    rows = []
    for r in reversed(_records()):
        if mine and r["user_id"] != p.get("id"):
            continue
        if type and r["type"] != type or user_id and r["user_id"] != user_id or org and r.get("org") != org:
            continue
        if project and project not in (r.get("projects") or []):
            continue
        if resource and resource not in {i.get("id") for i in r.get("items") or []}:
            continue
        if start and r["created_at"] < start or end and r["created_at"] > end:
            continue
        if not _can_review(p, r):
            continue
        rows.append(_redact(p, r))
    audit3.emit("CHECKPOINTS_SEARCH_RECORDS", ["requestSearch"], {"requestSearchQuery": json.dumps({"type": type, "user": user_id, "resource": resource})},
                {"requestSearchResults": [r["rid"] for r in rows[:50]]}, product="checkpoints")
    return {"total": len(rows), "records": rows[: max(1, min(limit, 5000))]}


@router.get("/recent/{cid}")
def my_recent(cid: str) -> list[str]:
    p = auth.require_user()
    return recent(cid, p["id"])
