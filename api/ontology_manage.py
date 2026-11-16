"""Ontology Manager's advanced tools, modelled on Palantir's "Export, edit, and import an Ontology" and "Ontology cleanup".

Export: an ontology's working state as JSON — object types, link types, action types, interfaces, shared properties
and value types (definitions only: no objects, links or edits). The format may change; do not depend on it.

Import: a previously exported (and possibly hand-edited) document, previewed first — each resource created, updated
(with the fields that change) or unchanged — then applied, every resource checked by the same validation as Ontology
Manager. Importing into another ontology copies the resources with new IDs and rewrites the references between them
(link type ends, action types, interface implementations, shared properties, value types). A subset of the document
can be imported.

Cleanup: object types that may be ready to go, each with the flags it triggers and their priority — past its
deprecation date, its datasource trashed or not updated in N days, no description, the display name matching a
pattern (default: "[test]", "[deprecated]", "(test)"), no objects, nothing uses it (no links, actions, interfaces or
automations). Flags and snoozes are per user. Deprecate (with a reason and deadline) or delete them; an object type
whose objects have user edits can only be deprecated, as in Foundry.

Mounted by server.py under /api/ontology.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _lock, _now, _read, _write

router = APIRouter(prefix="/api/ontology")

KINDS = {"object_types": "object-types", "link_types": "link-types", "action_types": "action-types", "interfaces": "interfaces",
         "shared_properties": "shared-properties", "value_types": "value-types"}
RUNTIME = ("created_at", "updated_at", "object_count", "backing_dataset", "edits_config", "security", "version")
FORMAT = 1
DEFAULT_FLAGS = {"past_deprecation": {"on": True, "priority": 1}, "trashed_datasource": {"on": True, "priority": 1},
                 "stale_datasource": {"on": True, "priority": 3, "days": 90}, "description_missing": {"on": True, "priority": 4},
                 "name_pattern": {"on": True, "priority": 2, "pattern": r"\[(test|deprecated)\]|\((test|deprecated)\)"},
                 "no_objects": {"on": True, "priority": 3}, "unused": {"on": True, "priority": 4}}


def configure() -> None:
    (ontology.DIR / "cleanup").mkdir(parents=True, exist_ok=True)


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


def _in_ontology(rec: dict, ontology_id: str) -> bool:
    return (rec.get("ontology_id") or "default") == (ontology_id or "default")


# ------------------------------------------------------------------------------------------------
# export / import
# ------------------------------------------------------------------------------------------------


def _clean(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k not in RUNTIME}


@router.get("/export")
def export(ontology_id: str = "default") -> dict:
    o = om.get_ontology(ontology_id)
    om.require_role(o["id"], "viewer", None, "export the ontology")
    doc: dict[str, Any] = {"format": FORMAT, "exported_at": _now(), "exported_by": _who(), "ontology": {"id": o["id"], "name": o["name"]}}
    for key, folder in KINDS.items():
        doc[key] = [_clean(r) for r in ontology._all(folder) if _in_ontology(r, o["id"])]
    return doc


class ImportIn(BaseModel):
    document: dict
    target_ontology_id: str = "default"
    # only these resource ids from the document ([] = all)
    resource_ids: list[str] = []
    apply: bool = False


def _rewrite(obj: Any, ids: dict[str, str]) -> Any:
    """Replace every id string that maps to a new id (deep)."""
    if isinstance(obj, str):
        return ids.get(obj, obj)
    if isinstance(obj, list):
        return [_rewrite(x, ids) for x in obj]
    if isinstance(obj, dict):
        return {k: _rewrite(v, ids) for k, v in obj.items()}
    return obj


def _validate(kind: str, rec: dict) -> None:
    if kind == "object_types":
        ontology._check_properties(rec["properties"], rec["primary_key"], rec["title_property"])
        om._check_type(rec)
    elif kind == "link_types":
        om._check_link_type(rec)
    elif kind == "action_types":
        ontology._hook("check_action", rec)
    elif kind == "interfaces":
        om._check_interface(rec)
    elif kind == "shared_properties":
        om._check_shared(rec)


ORDER = ("value_types", "shared_properties", "interfaces", "object_types", "link_types", "action_types")
PREFIX = {"object_types": "ot", "link_types": "lt", "action_types": "act", "interfaces": "if", "shared_properties": "sp", "value_types": "vt"}


@router.post("/import")
def import_ontology(req: ImportIn) -> dict:
    """Preview (apply=false) or apply an exported Ontology document."""
    doc = req.document
    if doc.get("format") != FORMAT:
        raise HTTPException(400, "not an Ontology export (or an export of another format version)")
    target = om.get_ontology(req.target_ontology_id)
    om.require_role(target["id"], "editor", None, "import into this ontology")
    source = (doc.get("ontology") or {}).get("id") or "default"
    copy = source != target["id"]
    wanted = set(req.resource_ids)
    items = [(k, r) for k in ORDER for r in doc.get(k) or [] if not wanted or r.get("id") in wanted]
    for k, r in items:
        if not r.get("id"):
            raise HTTPException(400, f"a {k[:-1].replace('_', ' ')} in the document has no id")
    ids = {r["id"]: f"{PREFIX[k]}-{uuid.uuid4().hex[:12]}" for k, r in items} if copy else {}
    changes = []
    with _lock:
        for k, r in items:
            new = _rewrite(json.loads(json.dumps(r)), ids) if copy else json.loads(json.dumps(r))
            cur = _read(ontology._path(KINDS[k], new["id"]))
            # the default ontology is stored as "default" or as no ontology at all: keep what is there
            new["ontology_id"] = (cur or {}).get("ontology_id") if target["id"] == "default" and cur else (None if target["id"] == "default" else target["id"])
            name = new.get("display_name") or new.get("api_name") or new["id"]
            if cur and not _in_ontology(cur, target["id"]):
                raise HTTPException(400, f"{name} ({new['id']}) belongs to another ontology: import into that one, or copy (export from a different ontology)")
            if cur:
                before = _clean(cur)
                fields = sorted(f for f in set(before) | set(new) if json.dumps(before.get(f), sort_keys=True, default=str) != json.dumps(new.get(f), sort_keys=True, default=str))
                op = "update" if fields else "unchanged"
            else:
                fields, op = [], "create"
            changes.append({"kind": k, "id": new["id"], "source_id": r["id"], "name": name, "op": op, "fields": fields, "record": new, "current": cur})
        if not req.apply:
            return {"target_ontology_id": target["id"], "copy": copy, "changes": [{k: v for k, v in c.items() if k not in ("record", "current")} for c in changes],
                    "counts": {op: sum(1 for c in changes if c["op"] == op) for op in ("create", "update", "unchanged")}}
        # validate everything before writing anything: the new definitions see each other
        written = []
        try:
            for c in changes:
                if c["op"] == "unchanged":
                    continue
                rec = {**(c["current"] or {}), **c["record"]}
                rec.setdefault("created_at", _now())
                if c["kind"] == "object_types" and not c["current"]:
                    ontology.save_objects(rec["id"], {})
                if c["kind"] == "link_types" and rec.get("kind") == "join_table" and not (ontology.DIR / "links" / f"{rec['id']}.json").exists():
                    _write(ontology.DIR / "links" / f"{rec['id']}.json", [])
                prev = _read(ontology._path(KINDS[c["kind"]], rec["id"]))
                ontology._put(KINDS[c["kind"]], rec)
                written.append((KINDS[c["kind"]], rec["id"], prev))
            for c in changes:
                if c["op"] != "unchanged":
                    _validate(c["kind"], _read(ontology._path(KINDS[c["kind"]], c["id"])))
        except HTTPException as e:
            for folder, rid, prev in reversed(written):
                if prev is None:
                    ontology._path(folder, rid).unlink(missing_ok=True)
                else:
                    _write(ontology._path(folder, rid), prev)
            raise HTTPException(400, f"the import was not applied: {e.detail}") from None
    return {"target_ontology_id": target["id"], "copy": copy, "applied": len(written),
            "changes": [{k: v for k, v in c.items() if k not in ("record", "current")} for c in changes]}


# ------------------------------------------------------------------------------------------------
# cleanup
# ------------------------------------------------------------------------------------------------


def _settings_path():
    return ontology.DIR / "cleanup" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', _who())}.json"


def settings() -> dict:
    s = _read(_settings_path(), {}) or {}
    flags = {k: {**v, **(s.get("flags") or {}).get(k, {})} for k, v in DEFAULT_FLAGS.items()}
    return {"flags": flags, "snoozed": s.get("snoozed") or {}}


class SettingsIn(BaseModel):
    flags: dict[str, dict]


@router.put("/cleanup/settings")
def save_settings(req: SettingsIn) -> dict:
    bad = [k for k in req.flags if k not in DEFAULT_FLAGS]
    if bad:
        raise HTTPException(400, f"unknown flags: {', '.join(bad)}")
    if "name_pattern" in req.flags and req.flags["name_pattern"].get("pattern"):
        try:
            re.compile(req.flags["name_pattern"]["pattern"])
        except re.error as e:
            raise HTTPException(400, f"the name pattern does not compile: {e}") from None
    s = _read(_settings_path(), {}) or {}
    s["flags"] = req.flags
    _write(_settings_path(), s)
    return settings()


def _dataset_state(dataset_id: str) -> tuple[bool, Optional[str]]:
    """(trashed, last updated) of a backing dataset in Files."""
    try:
        import db

        if not db.enabled():
            return False, None
        item = db.drive_get(dataset_id)
    except Exception:  # noqa: BLE001 - no Files: no datasource flags
        return False, None
    if not item:
        return True, None
    return bool(item.get("trashed_at")), str(item.get("updated_at") or "") or None


@router.get("/cleanup")
def candidates(ontology_id: str = "default", include_snoozed: bool = False) -> dict:
    st = settings()
    flags = st["flags"]
    now = datetime.now(timezone.utc)
    links = ontology._all("link-types")
    actions = ontology._all("action-types")
    autos = ontology._all("automations")
    import ontology_edits

    out = []
    for t in ontology._all("object-types"):
        if not _in_ontology(t, ontology_id):
            continue
        hits = []

        def flag(key: str, detail: str) -> None:
            if flags[key]["on"]:
                hits.append({"flag": key, "priority": flags[key]["priority"], "detail": detail})

        dep = (t.get("deprecation") or {}).get("deadline")
        if t.get("status") == "deprecated" and dep and str(dep) < now.date().isoformat():
            flag("past_deprecation", f"deprecated, deadline {dep}")
        b = t.get("backing_dataset")
        if b:
            trashed, updated = _dataset_state(b["dataset_id"])
            if trashed:
                flag("trashed_datasource", f"{b.get('name')} is trashed")
            elif updated:
                try:
                    age = (now - datetime.fromisoformat(updated.replace("Z", "+00:00"))).days
                except ValueError:
                    age = 0
                if age > int(flags["stale_datasource"].get("days") or 90):
                    flag("stale_datasource", f"{b.get('name')} not updated for {age} days")
        if not (t.get("description") or "").strip():
            flag("description_missing", "no description")
        pat = flags["name_pattern"].get("pattern")
        if pat and re.search(pat, t["display_name"], re.IGNORECASE):
            flag("name_pattern", f"name matches {pat}")
        n = len(ontology.stored_objects(t["id"]))
        if n == 0:
            flag("no_objects", "no objects")
        uses = sum(1 for lt in links if t["id"] in (lt["source"]["object_type_id"], lt["target"]["object_type_id"])) \
            + sum(1 for a in actions if a.get("object_type_id") == t["id"]) \
            + sum(1 for a in autos if (a.get("condition") or {}).get("object_type_id") == t["id"]) + len(t.get("implements") or [])
        if uses == 0:
            flag("unused", "no link types, action types, interfaces or automations")
        if not hits:
            continue
        snoozed_until = st["snoozed"].get(t["id"])
        if snoozed_until and snoozed_until > now.isoformat() and not include_snoozed:
            continue
        edited = bool(ontology_edits.layer(t["id"]))
        out.append({"object_type_id": t["id"], "display_name": t["display_name"], "status": t.get("status"), "objects": n, "user_edits": edited,
                    "can_delete": not edited and t.get("status") not in ("active", "promoted"), "flags": sorted(hits, key=lambda h: h["priority"]),
                    "priority": min(h["priority"] for h in hits), "snoozed_until": snoozed_until})
    out.sort(key=lambda r: (r["priority"], -len(r["flags"]), r["display_name"]))
    return {"settings": st, "candidates": out}


class SnoozeIn(BaseModel):
    object_type_ids: list[str] = Field(min_length=1)
    days: int = Field(30, ge=1, le=365)


@router.post("/cleanup/snooze")
def snooze(req: SnoozeIn) -> dict:
    s = _read(_settings_path(), {}) or {}
    until = (datetime.now(timezone.utc) + timedelta(days=req.days)).isoformat(timespec="seconds")
    s.setdefault("snoozed", {}).update({tid: until for tid in req.object_type_ids})
    _write(_settings_path(), s)
    return {"snoozed": req.object_type_ids, "until": until}


class DeprecateIn(BaseModel):
    object_type_ids: list[str] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=500)
    deadline: Optional[str] = None
    replaced_by: Optional[str] = None


@router.post("/cleanup/deprecate")
def deprecate(req: DeprecateIn) -> dict:
    done = []
    for tid in req.object_type_ids:
        ontology.update_object_type(tid, ontology.ObjectTypeIn(status="deprecated", deprecation={"reason": req.reason, "deadline": req.deadline, "replaced_by": req.replaced_by}))
        done.append(tid)
    return {"deprecated": done}


class DeleteIn(BaseModel):
    object_type_ids: list[str] = Field(min_length=1)


@router.post("/cleanup/delete")
def delete(req: DeleteIn) -> dict:
    """Delete object types (and their objects); ones whose objects have user edits must be deprecated instead."""
    import ontology_edits

    refused = []
    for tid in req.object_type_ids:
        t = ontology._object_type(tid)
        if ontology_edits.layer(tid):
            refused.append({"object_type_id": tid, "reason": f"{t['display_name']} has objects with user edits: deprecate it instead"})
    if refused:
        raise HTTPException(400, refused[0]["reason"])
    for tid in req.object_type_ids:
        ontology.delete_object_type(tid)
    return {"deleted": req.object_type_ids}

