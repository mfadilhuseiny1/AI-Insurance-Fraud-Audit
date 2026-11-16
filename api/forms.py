"""Forms [Sunset] (Analytics doc 10 "Forms"): guided data entry written to Fusion or the Ontology.

A form is a Files item (content type FORM_MIME): a main sheet and subsheets of fields, a destination and settings.
Editors save a draft and publish versions; respondents fill the published version. The server is the single source of
truth for the form's behavior: `evaluate` applies the transforms (hide / show / disable / update configuration /
change field type, on conditions over other fields combined with all / any / not), computes auto-populating fields
and runs the validators (required, regex, range, length); `submit` does the same before writing.

Fields: text, text area, numeric, slider, dropdown (values / labels, multiple, other values), radio, checkboxes, date
picker (min / max, no past / future), URL, callout (Markdown with {{field}} references; never stored), user dropdown,
object dropdown, object property dropdown, dataset value dropdown (with a filter on another field's value), objects
provider and object property display (read only), calculation (a formula over other fields: Fusion's formula
functions), created at, created by, generated primary key (UUID), template (text with {{field}}), attachments (files
uploaded to a folder; the field stores their Files IDs).

Multiplicity: a subsheet can be "free" (the respondent adds instances) or "parameterized" (one instance per value of
a field, e.g. per selected object); each instance becomes a row / object with the main sheet's shared values.

Destinations: a Fusion table region (rows appended, or updated by the key column), an Ontology object type (objects
created, or edited from an object's form: Edit object form and bulk edit), or none. Every submission is also kept in
the form's response log, which editors review and edit (the edit is written to the destination too). Subscribers get
an inbox notification per submission.

Mounted by server.py under /api/forms.
"""

from __future__ import annotations

import copy
import json
import re
import secrets
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/forms")

FORM_MIME = "application/vnd.bluesandai.form+json"
FIELD_TYPES = ("text", "textarea", "numeric", "slider", "dropdown", "radio", "checkboxes", "date", "url", "callout", "user_dropdown",
               "object_dropdown", "object_property_dropdown", "dataset_value_dropdown", "objects_provider", "object_property_display",
               "calculation", "created_at", "created_by", "primary_key", "template", "attachments", "map_picker", "resource_picker",
               "user_properties")
READ_ONLY = ("callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "primary_key", "template",
             "user_properties")
NOT_STORED = ("callout", "objects_provider", "object_property_display", "user_properties")
USER_PROPERTIES = ("display_name", "username", "email", "first_name", "last_name", "organization", "last_first")
DIR = Path()
_lock = threading.RLock()


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "forms"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    me = auth.current() or {}
    return {"id": me.get("id") or "local", "username": me.get("username") or "local"}


def _blank(title: str) -> dict:
    main = {"id": "main", "title": title, "columns": 1, "fields": [
        {"id": "name", "type": "text", "label": "Name", "column": "name", "validators": [{"kind": "required"}], "transforms": []}]}
    return {"title": title, "description": "", "sheets": [main], "destination": {"kind": "none"},
            "settings": {"allow_without_permissions": True, "submit_label": "Submit"}, "versions": [], "published": None, "subscribers": []}


# ------------------------------------------------------------------ storage


# per-user sharing of one form, beyond its Project's roles: respondent < viewer < editor
SHARE_ROLES = ("respondent", "viewer", "editor")


def _shares_path() -> Path:
    return DIR / "collaborators.json"


def _shares() -> dict[str, list[dict]]:
    p = _shares_path()
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _shared_role(item_id: str) -> Optional[str]:
    """The signed-in user's role on the form from per-user sharing (None: not shared with them)."""
    me = (auth.current() or {}).get("id")
    if not me:
        return None
    return next((c["role"] for c in _shares().get(item_id) or [] if c["user_id"] == me), None)


def _form_item(item_id: str) -> dict:
    import db

    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or item.get("kind") != "file" or item.get("content_type") != FORM_MIME:
        raise HTTPException(404, "form not found")
    return item


def _item(item_id: str, need: str = "viewer") -> dict:
    """The form with the Project role `need`, or shared with the user with at least that role (the form's markings
    still apply)."""
    import drive

    try:
        item = drive._item(item_id, need=need)
    except HTTPException as e:
        role = _shared_role(item_id) if e.status_code in (403, 404) else None
        if not role or SHARE_ROLES.index(role) < SHARE_ROLES.index(need if need in SHARE_ROLES else "viewer"):
            raise
        item = _form_item(item_id)
        p = auth.current() or {}
        if auth.enabled() and auth.missing_markings(auth.effective_markings(item_id), p.get("markings")):
            raise HTTPException(403, "this form carries markings you do not hold") from None
        return item
    if item.get("kind") != "file" or item.get("content_type") != FORM_MIME:
        raise HTTPException(404, "form not found")
    return item


def _respondent_item(item_id: str, link: Optional[str]) -> dict:
    """The form for a respondent: with a respondent link (signed-in users who have it fill the published form without
    access to the form's Project), else the user's own access — the Project's roles or per-user sharing, where the
    respondent role fills the form. Links do not open marked forms."""
    if not link:
        try:
            return _item(item_id)
        except HTTPException as e:
            if e.status_code not in (403, 404) or _shared_role(item_id) != "respondent":
                raise
            item = _form_item(item_id)
            p = auth.current() or {}
            if auth.enabled() and auth.missing_markings(auth.effective_markings(item_id), p.get("markings")):
                raise HTTPException(403, "this form carries markings you do not hold") from None
            return item
    import db

    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or item.get("kind") != "file" or item.get("content_type") != FORM_MIME:
        raise HTTPException(404, "form not found")
    if auth.enabled() and auth.effective_markings(item["id"]):
        raise HTTPException(403, "this form carries markings: respondent links do not open marked forms")
    now = _now()
    hit = next((x for x in _load(item).get("links") or [] if secrets.compare_digest(x["token"], link)), None)
    if not hit:
        raise HTTPException(404, "this respondent link does not exist or was turned off")
    if hit.get("expires_at") and hit["expires_at"] < now:
        raise HTTPException(410, "this respondent link has expired")
    return item


def _load(item: dict) -> dict:
    import drive

    try:
        return json.loads(drive.read_bytes(item).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(500, "the form is not readable") from None


def _store(item: dict, form: dict) -> None:
    import pipeline_datasets

    pipeline_datasets._replace_content(item, json.dumps(form, ensure_ascii=False).encode("utf-8"), FORM_MIME)


def _responses_path(item_id: str) -> Path:
    return DIR / f"{item_id}.responses.json"


def _responses(item_id: str) -> list[dict]:
    p = _responses_path(item_id)
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _save_responses(item_id: str, rows: list[dict]) -> None:
    _responses_path(item_id).write_text(json.dumps(rows, ensure_ascii=False, default=str), "utf-8")


# ------------------------------------------------------------------ definition checks


def _fields(defn: dict) -> list[tuple[dict, dict]]:
    return [(s, f) for s in defn["sheets"] for f in s.get("fields") or []]


def _multi_ids(defn: dict) -> set[str]:
    """Fields of multiplicity subsheets: validated per instance, not with the shared fields."""
    return {f["id"] for s in defn["sheets"][1:] if s.get("multiplicity") for f in s.get("fields") or []}


def _check(defn: dict) -> None:
    if not defn.get("sheets") or defn["sheets"][0].get("multiplicity"):
        raise HTTPException(400, "a form starts with a main sheet (without multiplicity)")
    ids = [f["id"] for _, f in _fields(defn)]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "field IDs must be unique")
    for s, f in _fields(defn):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", f["id"]):
            raise HTTPException(400, f"{f['id']!r} is not a valid field ID")
        if f["type"] not in FIELD_TYPES:
            raise HTTPException(400, f"{f['id']}: unknown field type {f['type']}")
        up = f.get("url_param")
        if up is not None and up != "":
            if not isinstance(up, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.\-]{0,63}", up) or up in EMBED_PARAMS:
                raise HTTPException(400, f"{f['id']}: {up!r} is not a usable URL parameter")
            if sum(1 for _, x in _fields(defn) if x.get("url_param") == up) > 1:
                raise HTTPException(400, f"URL parameter {up} is used by more than one field")
        for v in f.get("validators") or []:
            if v.get("kind") == "regex":
                try:
                    re.compile(v.get("pattern") or "")
                except re.error as e:
                    raise HTTPException(400, f"{f['id']}: the regular expression does not compile ({e})") from None
        for t in f.get("transforms") or []:
            if t.get("kind") not in ("hide", "show", "disable", "update", "change_type"):
                raise HTTPException(400, f"{f['id']}: unknown transform {t.get('kind')}")
            if t.get("kind") == "change_type" and t.get("type") not in FIELD_TYPES:
                raise HTTPException(400, f"{f['id']}: change field type to an unknown type")
    for s in defn["sheets"][1:]:
        m = s.get("multiplicity")
        if m and m.get("kind") == "parameterized" and m.get("param_field") not in ids:
            raise HTTPException(400, f"sheet {s.get('title')}: parameterized multiplicity needs a shared field")
    d = defn.get("destination") or {}
    if d.get("kind") not in ("none", "fusion", "object_type"):
        raise HTTPException(400, "the destination is none, a Fusion table or an object type")


# ------------------------------------------------------------------ behavior: transforms, auto fields, validators


def _empty(v: Any) -> bool:
    return v is None or v == "" or v == []


def _cond(c: Optional[dict], values: dict) -> bool:
    if not c:
        return True
    if "all" in c:
        return all(_cond(x, values) for x in c["all"])
    if "any" in c:
        return any(_cond(x, values) for x in c["any"])
    if "not" in c:
        return not _cond(c["not"], values)
    v = values.get(c.get("field"))
    op = c.get("op") or "is"
    target = c.get("value")
    if op == "has_value":
        return not _empty(v)
    if op == "no_value":
        return _empty(v)
    if op == "contains":
        return isinstance(v, list) and target in v or isinstance(v, str) and str(target) in v
    eq = (str(v) == str(target)) if not isinstance(v, list) else (target in v)
    return eq if op == "is" else not eq


def effective(defn: dict, values: dict) -> dict[str, dict]:
    """Each field as the respondent sees it now: transforms applied in order (the last one wins)."""
    out = {}
    for _, f in _fields(defn):
        eff = {**f, "hidden": bool(f.get("hidden")), "disabled": bool(f.get("readonly")) or f["type"] in READ_ONLY}
        shows = [t for t in f.get("transforms") or [] if t["kind"] == "show"]
        if shows:
            eff["hidden"] = True
        for t in f.get("transforms") or []:
            hit = _cond(t.get("condition"), values)
            if t["kind"] == "hide" and hit:
                eff["hidden"] = True
            elif t["kind"] == "show" and hit:
                eff["hidden"] = False
            elif t["kind"] == "disable" and hit:
                eff["disabled"] = True
            elif t["kind"] == "update" and hit:
                patch = {k: v for k, v in (t.get("patch") or {}).items() if k not in ("id", "type", "column")}
                eff.update(patch)
            elif t["kind"] == "change_type" and hit:
                eff["type"] = t["type"]
        out[f["id"]] = eff
    return out


def _calc(formula: str, values: dict, f: dict) -> Any:
    """A calculation: a formula over other fields ({field} or bare field IDs), Fusion's formula functions."""
    import fusion_formula as F

    def sub(m: re.Match) -> str:
        v = values.get(m.group(1))
        if _empty(v):
            v = (f.get("missing") or {}).get(m.group(1), 0)
        try:
            return repr(float(v))
        except (TypeError, ValueError):
            return "'" + str(v).replace("'", "''") + "'"

    expr = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", sub, formula or "")
    try:
        ev = F.Evaluator({"sheets": [{"id": "f", "name": "f", "cells": {}}]})
        v = F.plain(ev.eval(F.parse(expr)))
    except (F.FusionError, ZeroDivisionError, ValueError, TypeError, OverflowError):
        return f.get("on_error")
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return f.get("on_error")
        if f.get("precision") is not None:
            v = round(v, int(f["precision"]))
    return v


def _template(text: str, values: dict) -> str:
    return re.sub(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", lambda m: "" if _empty(values.get(m.group(1))) else
                  (", ".join(map(str, values[m.group(1)])) if isinstance(values[m.group(1)], list) else str(values[m.group(1)])), text or "")


def auto_values(defn: dict, values: dict, eff: dict, opened_at: Optional[str] = None) -> dict:
    out = dict(values)
    me = _me()
    for fid, f in eff.items():
        t = f["type"]
        if t == "created_at":
            out[fid] = opened_at if f.get("on_open") and opened_at else _now()
        elif t == "created_by":
            out[fid] = me["id"]
        elif t == "primary_key":
            out[fid] = out.get(fid) or uuid.uuid4().hex
    for _ in range(3):  # calculations and templates may refer to each other
        for fid, f in eff.items():
            if f["type"] == "calculation":
                out[fid] = _calc(f.get("formula") or "", out, f)
            elif f["type"] == "template":
                out[fid] = _template(f.get("text") or "", out)
    return out


def validate(eff: dict, values: dict) -> dict[str, str]:
    errors = {}
    for fid, f in eff.items():
        if f["hidden"] or f["type"] in READ_ONLY:
            continue
        v = values.get(fid)
        for val in f.get("validators") or []:
            k = val.get("kind")
            if k == "required" and _empty(v):
                errors[fid] = val.get("message") or f"{f.get('label') or fid} is required"
            elif _empty(v):
                continue
            elif k == "regex" and not re.fullmatch(val.get("pattern") or ".*", str(v)):
                errors[fid] = val.get("message") or f"{f.get('label') or fid} has the wrong format"
            elif k == "range":
                try:
                    x = float(v)
                except (TypeError, ValueError):
                    errors[fid] = f"{f.get('label') or fid} must be a number"
                    continue
                if (val.get("min") is not None and x < float(val["min"])) or (val.get("max") is not None and x > float(val["max"])):
                    errors[fid] = val.get("message") or f"{f.get('label') or fid} must be between {val.get('min', '−∞')} and {val.get('max', '∞')}"
            elif k == "length":
                n = len(v) if isinstance(v, (str, list)) else len(str(v))
                if (val.get("min") is not None and n < int(val["min"])) or (val.get("max") is not None and n > int(val["max"])):
                    errors[fid] = val.get("message") or f"{f.get('label') or fid} must have {val.get('min', 0)}–{val.get('max', '∞')} characters"
            if fid in errors:
                break
        if fid in errors:
            continue
        t = f["type"]
        if t == "numeric" and not _empty(v):
            try:
                float(v)
            except (TypeError, ValueError):
                errors[fid] = f"{f.get('label') or fid} must be a number"
        elif t == "date" and not _empty(v):
            try:
                d = date.fromisoformat(str(v)[:10])
            except ValueError:
                errors[fid] = f"{f.get('label') or fid} is not a date"
                continue
            today = date.today()
            if f.get("min") and d < date.fromisoformat(f["min"]) or f.get("max") and d > date.fromisoformat(f["max"]):
                errors[fid] = f"{f.get('label') or fid} is outside the allowed dates"
            elif f.get("no_past") and d < today or f.get("no_future") and d > today:
                errors[fid] = f"{f.get('label') or fid}: {'past' if f.get('no_past') else 'future'} dates are not allowed"
        elif t == "map_picker" and not _empty(v):
            import geo

            try:
                lat, lon = geo.lat_lon(v)
                values[fid] = f"{lat:g},{lon:g}"
            except Exception as e:  # noqa: BLE001
                errors[fid] = f"{f.get('label') or fid}: {getattr(e, 'args', [''])[0] or 'not a location'}"
        elif t == "resource_picker" and not _empty(v):
            import drive

            try:
                it = drive._item(str(v))
            except HTTPException:
                errors[fid] = f"{f.get('label') or fid}: the resource does not exist or you cannot open it"
                continue
            allow = f.get("allow") or "any"
            is_ds = it.get("kind") == "file" and str(it.get("name", "")).endswith(".parquet")
            if (allow == "folders" and it.get("kind") not in ("folder", "project")) or (allow == "datasets" and not is_ds):
                errors[fid] = f"{f.get('label') or fid}: choose {'a folder' if allow == 'folders' else 'a dataset'}"
        elif t == "url" and not _empty(v) and not re.match(r"^https?://\S+$", str(v)):
            errors[fid] = f.get("url_message") or f"{f.get('label') or fid} is not a URL"
        elif t in ("dropdown", "radio") and not _empty(v) and not f.get("allow_other"):
            allowed = [str(o.get("value")) for o in f.get("options") or []]
            vals = v if isinstance(v, list) else [v]
            if allowed and any(str(x) not in allowed for x in vals):
                errors[fid] = f"{f.get('label') or fid}: choose one of the options"
    return errors


# ------------------------------------------------------------------ data-backed options


def options(f: dict, values: dict) -> list[dict]:
    """The choices of a data-backed field (filtered by another field's value when configured)."""
    import ontology
    import ontology_explorer as ox

    t = f["type"]
    flt_val = values.get(f.get("filter_field")) if f.get("filter_field") else None
    if t == "dataset_value_dropdown":
        import fusion

        cols, rows, _ = fusion._datasets(f.get("dataset") or "")
        col = f.get("dataset_column")
        if col not in cols:
            raise HTTPException(400, f"the dataset has no column {col}")
        rows = [r for r in rows if not f.get("filter_column") or _empty(flt_val) or str(r.get(f["filter_column"])) == str(flt_val)]
        return [{"value": v, "label": str(v)} for v in dict.fromkeys(r.get(col) for r in rows if r.get(col) is not None)][:2000]
    if t in ("object_dropdown", "object_property_dropdown", "objects_provider"):
        tid = f.get("object_type_id") or ""
        filters = []
        if f.get("filter_property") and not _empty(flt_val):
            filters.append(ox.Filter(property=f["filter_property"], op="eq", value=flt_val))
        try:
            res = ox.search(ox.SearchIn(object_type_id=tid, filters=filters, limit=int(f.get("max_objects") or 500), histograms=False, resource="forms"))
        except HTTPException as e:
            raise HTTPException(e.status_code, f"{f.get('label') or f['id']}: {e.detail}") from None
        if t == "object_property_dropdown":
            prop = f.get("property")
            return [{"value": v, "label": str(v)} for v in dict.fromkeys(o["properties"].get(prop) for o in res["objects"] if o["properties"].get(prop) is not None)]
        return [{"value": o["primary_key"], "label": o["title"], "object_type_id": tid} for o in res["objects"]]
    if t == "user_dropdown":
        users = [u for u in auth._users() if not u.get("disabled")] if auth.enabled() else [{"id": "local", "username": "local"}]
        if f.get("only_groups"):
            members = {m for g in auth._groups() if g["id"] in f["only_groups"] for m in auth.group_members(g)}
            users = [u for u in users if u["id"] in members]
        return [{"value": u["id"], "label": u.get("display_name") or u["username"]} for u in users]
    if t == "user_properties":
        src = values.get(f.get("source_field")) if f.get("source_field") else f.get("user_id")
        if _empty(src):
            return [{"value": None, "label": f.get("none_message") or "No user selected"}]
        users = {u["id"]: u for u in auth._users()} if auth.enabled() else {"local": {"id": "local", "username": "local"}}
        prop = f.get("property") or "display_name"
        out = []
        for uid in (src if isinstance(src, list) else [src]):
            u = users.get(str(uid))
            if not u:
                out.append({"value": None, "label": f.get("missing_message") or "missing"})
                continue
            if prop == "last_first":
                v = ", ".join(x for x in (u.get("last_name"), u.get("first_name")) if x) or u.get("display_name") or u["username"]
            elif prop == "organization":
                v = u.get("organization_id")
            else:
                v = u.get(prop)
            out.append({"value": v if v not in (None, "") else None, "label": f.get("empty_message") or "—" if v in (None, "") else str(v)})
        return out
    if t == "object_property_display":
        src = values.get(f.get("source_field")) if f.get("source_field") else f.get("primary_key")
        if _empty(src):
            return []
        out = []
        for pk in (src if isinstance(src, list) else [src]):
            try:
                o = ontology.get_object(f.get("object_type_id") or "", str(pk))
                out.append({"value": o["properties"].get(f.get("property")), "label": o["title"]})
            except HTTPException:
                out.append({"value": None, "label": f.get("missing_message") or "missing"})
        return out
    return f.get("options") or []


# ------------------------------------------------------------------ writing


def _rows(defn: dict, values: dict, entries: dict[str, list[dict]]) -> list[dict]:
    """The rows a submission writes: one per multiplicity instance (with the shared values), else one."""
    main_ids = {f["id"] for f in defn["sheets"][0].get("fields") or []}
    shared = {k: v for k, v in values.items() if k in main_ids}
    rows = []
    for s in defn["sheets"][1:]:
        if not s.get("multiplicity"):
            shared.update({f["id"]: values.get(f["id"]) for f in s.get("fields") or []})
            continue
        for inst in entries.get(s["id"]) or []:
            rows.append({**shared, **inst})
    return rows or [{**shared, **{k: v for k, v in values.items() if k not in shared}}]


def _columns(defn: dict, row: dict) -> dict:
    out = {}
    for _, f in _fields(defn):
        if f["type"] in NOT_STORED or f["id"] not in row:
            continue
        out[f.get("column") or f["id"]] = row[f["id"]]
    return out


def _write(defn: dict, rows: list[dict], edit_key: Optional[str] = None) -> list[dict]:
    d = defn.get("destination") or {}
    out = []
    if d.get("kind") == "fusion":
        import fusion

        item = fusion._item(d["document_id"], "editor")
        doc = fusion._load(item)
        sheet, t = fusion._find_table(doc, d["table"])
        import fusion_formula as F

        r0, c0, _, _ = fusion._table_bounds(t)
        headers = [F.to_text((sheet["cells"].get(F.addr(r0, c0 + j)) or {}).get("input")) for j in range(t["columns"])]
        for row in rows:
            cols = _columns(defn, row)
            vals = [cols.get(h) for h in headers]
            vals = [", ".join(map(str, v)) if isinstance(v, list) else v for v in vals]
            key = vals[0] if d.get("key_first_column") else None
            fusion._run(doc, {"__kind__": "action", "action": "submit_to_region", "table": t["name"], "values": vals}, [], []) if key not in (None, "") \
                else fusion._append_row(sheet, t, vals)
            out.append({"fusion": t["name"]})
        fusion._save(item, doc, "Form submission")
    elif d.get("kind") == "object_type":
        import ontology

        t = ontology._object_type(d["object_type_id"])
        edits = []
        for row in rows:
            cols = {k: v for k, v in _columns(defn, row).items() if any(p["api_name"] == k for p in t["properties"])}
            pk = str(edit_key or cols.get(t["primary_key"]) or uuid.uuid4().hex)
            if edit_key:
                cols.pop(t["primary_key"], None)  # an edit never changes the object's key
            else:
                cols.setdefault(t["primary_key"], pk)
            edits.append({"op": "modify" if edit_key else "create", "object_type_id": t["id"], "primary_key": pk, "properties": cols})
        with ontology._lock:
            written = ontology.apply_edits(edits, source="forms")
        out.extend({"object_type_id": w["object_type_id"], "primary_key": w["primary_key"]} for w in written)
    return out


# ------------------------------------------------------------------ routes


class NewFormIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None


@router.get("")
def list_forms() -> list[dict]:
    import db
    import drive

    drive._require_db()
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (FORM_MIME,), order="updated_at DESC", limit=500)
    out = []
    seen = set()
    for i in auth.visible(items):
        seen.add(i["id"])
        role = _shared_role(i["id"])
        out.append({**drive._with_path(i), "responses": len(_responses(i["id"])), **({"shared_role": role} if role else {})})
    # forms shared with the user one by one
    for i in items:
        if i["id"] not in seen and _shared_role(i["id"]):
            out.append({**i, "path": [], "shared_role": _shared_role(i["id"]), "responses": len(_responses(i["id"]))})
    return out


class ShareIn(BaseModel):
    # [{user_id or username, role: respondent | viewer | editor}]
    collaborators: list[dict] = Field([], max_length=500)


@router.get("/{item_id}/collaborators")
def get_collaborators(item_id: str) -> list[dict]:
    """The users this form is shared with and their roles (editors see them)."""
    _item(item_id, "editor")
    out = []
    for c in _shares().get(item_id) or []:
        label = auth.user_label(c["user_id"]) if hasattr(auth, "user_label") else None
        out.append({**c, "user": label})
    return out


@router.put("/{item_id}/collaborators")
def set_collaborators(item_id: str, req: ShareIn) -> list[dict]:
    """Share the form with users: respondents fill it, viewers also open the form's definition, editors edit and
    publish it and see its responses. Only editors through the form's Project (not shared editors) change the list."""
    import drive

    drive._item(item_id, need="editor")
    _form_item(item_id)
    clean, seen = [], set()
    for c in req.collaborators:
        uid, role = str(c.get("user_id") or ""), c.get("role")
        if not uid and c.get("username"):
            hit = next((u for u in auth._users() if u.get("username", "").lower() == str(c["username"]).strip().lower()), None)
            if not hit:
                raise HTTPException(400, f"no user named {c['username']}")
            uid = hit["id"]
        if role not in SHARE_ROLES:
            raise HTTPException(400, f"a role is one of {', '.join(SHARE_ROLES)}")
        if not uid or uid in seen:
            continue
        if auth.enabled() and not auth.principal_of(uid):
            raise HTTPException(400, f"no active user {uid}")
        seen.add(uid)
        clean.append({"user_id": uid, "role": role, "added_by": _me()["id"], "at": _now()})
    with _lock:
        allx = _shares()
        if clean:
            allx[item_id] = clean
        else:
            allx.pop(item_id, None)
        _shares_path().write_text(json.dumps(allx, ensure_ascii=False), "utf-8")
    return get_collaborators(item_id)


@router.post("")
def create_form(req: NewFormIn) -> dict:
    import drive

    form = _blank(req.title.strip())
    name = drive._clean_name(req.title.strip())[:240] + ".form"
    item = drive.save_bytes(drive._folder_id(req.parent_id) if req.parent_id else drive.default_folder("documents"), name,
                            json.dumps(form, ensure_ascii=False).encode("utf-8"), FORM_MIME)
    return get_form(item["id"])


def _view(item: dict, form: dict) -> dict:
    import drive

    try:
        drive._item(item["id"], need="editor")
        can_edit = True
    except HTTPException:
        can_edit = _shared_role(item["id"]) == "editor"
    # respondent links are for editors to hand out
    shown = form if can_edit else {k: v for k, v in form.items() if k != "links"}
    return {"item": drive._with_path(item), "form": shown, "can_edit": can_edit, "responses": len(_responses(item["id"]))}


class LinkIn(BaseModel):
    # 1, 7, 30 or 90 days; None: until turned off
    expires_days: Optional[int] = None
    label: str = Field("", max_length=200)


@router.post("/{item_id}/links")
def create_link(item_id: str, req: LinkIn) -> dict:
    """A respondent link: signed-in users who have it can fill the published form (editors make them)."""
    item = _item(item_id, "editor")
    if req.expires_days not in (None, 1, 7, 30, 90):
        raise HTTPException(400, "expires_days is 1, 7, 30, 90 or empty")
    link = {"token": secrets.token_urlsafe(18), "label": req.label, "created_at": _now(), "by": _me()["username"],
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=req.expires_days)).isoformat(timespec="seconds") if req.expires_days else None}
    with _lock:
        form = _load(item)
        form["links"] = [*(form.get("links") or []), link]
        _store(item, form)
    return link


@router.get("/{item_id}/links")
def list_links(item_id: str) -> list[dict]:
    return _load(_item(item_id, "editor")).get("links") or []


@router.delete("/{item_id}/links/{token}")
def delete_link(item_id: str, token: str) -> dict:
    item = _item(item_id, "editor")
    with _lock:
        form = _load(item)
        form["links"] = [x for x in form.get("links") or [] if x["token"] != token]
        _store(item, form)
    return {"deleted": token}


@router.get("/{item_id}")
def get_form(item_id: str) -> dict:
    item = _item(item_id)
    return _view(item, _load(item))


class SaveIn(BaseModel):
    # the draft definition: title, description, sheets, destination, settings
    form: dict


@router.put("/{item_id}")
def save_form(item_id: str, req: SaveIn) -> dict:
    item = _item(item_id, "editor")
    with _lock:
        cur = _load(item)
        new = {**cur, **{k: req.form[k] for k in ("title", "description", "sheets", "destination", "settings") if k in req.form}}
        _check(new)
        _store(item, new)
        return _view(item, new)


@router.get("/{item_id}/code")
def get_code(item_id: str) -> dict:
    """The Code Editor: the draft form as YAML."""
    import yaml

    form = _load(_item(item_id))
    body = {k: form[k] for k in ("title", "description", "sheets", "destination", "settings") if k in form}
    return {"yaml": yaml.safe_dump(body, sort_keys=False, allow_unicode=True, width=120)}


class CodeIn(BaseModel):
    yaml: str = Field(max_length=2_000_000)


@router.put("/{item_id}/code")
def put_code(item_id: str, req: CodeIn) -> dict:
    """Save the draft from YAML (checked like the visual editor's saves)."""
    import yaml

    try:
        body = yaml.safe_load(req.yaml)
    except yaml.YAMLError as e:
        raise HTTPException(400, f"not valid YAML: {str(e).splitlines()[0]}") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "the YAML must be a mapping with title, sheets, …")
    return save_form(item_id, SaveIn(form=body))


class PublishIn(BaseModel):
    name: str = Field("", max_length=200)


@router.post("/{item_id}/publish")
def publish(item_id: str, req: PublishIn) -> dict:
    """Publish the draft as a new version: respondents fill the published version."""
    item = _item(item_id, "editor")
    with _lock:
        form = _load(item)
        _check(form)
        d = form.get("destination") or {}
        if d.get("kind") == "fusion":
            import fusion

            fusion._find_table(fusion._load(fusion._item(d.get("document_id") or "", "editor")), d.get("table") or "")
        elif d.get("kind") == "object_type":
            import ontology

            ontology._object_type(d.get("object_type_id") or "")
        n = len(form["versions"]) + 1
        form["versions"].append({"n": n, "name": req.name or f"Version {n}", "at": _now(), "by": _me()["username"],
                                 "definition": {k: copy.deepcopy(form[k]) for k in ("title", "description", "sheets", "destination", "settings")}})
        form["published"] = n
        _store(item, form)
        return _view(item, form)


@router.post("/{item_id}/subscribe")
def subscribe(item_id: str, on: bool = True) -> dict:
    item = _item(item_id)
    with _lock:
        form = _load(item)
        me = _me()["id"]
        subs = [s for s in form.get("subscribers") or [] if s != me] + ([me] if on else [])
        form["subscribers"] = subs
        _store(item, form)
        return {"subscribed": on}


def _published(form: dict) -> dict:
    if not form.get("published"):
        raise HTTPException(400, "the form has no published version")
    return next(v for v in form["versions"] if v["n"] == form["published"])["definition"]


class EvaluateIn(BaseModel):
    values: dict[str, Any] = {}
    # the draft instead of the published version (the editor's preview)
    draft: bool = False


@router.post("/{item_id}/evaluate")
def evaluate_route(item_id: str, req: EvaluateIn, link: Optional[str] = Query(None)) -> dict:
    """What the respondent sees for these values: each field after transforms, auto values, options, errors."""
    item = _respondent_item(item_id, link)
    form = _load(item)
    if req.draft and link:
        raise HTTPException(403, "a respondent link opens the published form only")
    defn = form if req.draft else _published(form)
    eff = effective(defn, req.values)
    vals = auto_values(defn, req.values, eff)
    opts = {}
    for fid, f in eff.items():
        if f["type"] in ("dataset_value_dropdown", "object_dropdown", "object_property_dropdown", "objects_provider", "user_dropdown", "object_property_display",
                         "user_properties") and not f["hidden"]:
            try:
                opts[fid] = options(f, vals)
            except HTTPException as e:
                opts[fid] = [{"value": None, "label": f"⚠ {e.detail}"}]
    return {"definition": {k: defn[k] for k in ("title", "description", "sheets", "settings")}, "fields": eff, "values": vals,
            "options": opts, "errors": {k: v for k, v in validate(eff, vals).items() if k not in _multi_ids(defn)}, "callouts": {fid: _template(f.get("text") or "", vals) for fid, f in eff.items() if f["type"] == "callout"}}


# ------------------------------------------------------------------ embedding: prefilled values (doc "Slate", "Object Explorer")

# the fill page's own URL parameters: never field values
EMBED_PARAMS = ("embed", "embedded", "noHeader", "progressOnly", "forceDarkMode", "link", "object_type", "pk")
_MISSING = object()


def _prefill_object(object_type: Optional[str], pk: Optional[str], ignored: dict[str, str]) -> Optional[dict]:
    """The object a form is embedded for (an object view's section), when the user can open it."""
    if _empty(object_type) and _empty(pk):
        return None
    if _empty(object_type) or _empty(pk):
        ignored["object"] = "an object needs both object_type and pk"
        return None
    import ontology

    try:
        return ontology.get_object(str(object_type), str(pk))
    except HTTPException as e:
        ignored["object"] = str(e.detail)
        return None


def _coerce(f: dict, raw: Any, values: dict) -> Any:
    """A prefilled value as the field stores it; raises ValueError (with the reason) when the field cannot take it."""
    t = f["type"]
    label = f.get("label") or f["id"]
    if t == "attachments":
        raise ValueError(f"{label}: attachments cannot be prefilled")
    if t in READ_ONLY:
        raise ValueError(f"{label} is filled in by the form")
    many = bool(f.get("multiple")) or t == "checkboxes"
    if isinstance(raw, (dict, tuple, set)):
        raise ValueError(f"{label}: not a value")
    if isinstance(raw, list):
        if any(isinstance(x, (dict, list)) for x in raw):
            raise ValueError(f"{label}: not a value")
        items = [x for x in raw if not _empty(x)]
    elif many and isinstance(raw, str):
        items = [x.strip() for x in raw.split(",") if x.strip()]
    else:
        items = [raw]
    if not many and len(items) > 1:
        raise ValueError(f"{label} takes one value")
    if any(isinstance(x, str) and len(x) > 10_000 for x in items):
        raise ValueError(f"{label}: the value is too long")

    def one(x: Any) -> Any:
        if t in ("numeric", "slider"):
            if isinstance(x, bool):
                raise ValueError(f"{label} must be a number")
            try:
                n = float(x)
            except (TypeError, ValueError):
                raise ValueError(f"{label} must be a number") from None
            if n != n or n in (float("inf"), float("-inf")):
                raise ValueError(f"{label} must be a number")
            if t == "slider" and not float(f.get("min") or 0) <= n <= float(f.get("max") if f.get("max") is not None else 100):
                raise ValueError(f"{label} is outside the slider's range")
            return int(n) if n == int(n) and not (isinstance(x, str) and "." in x) else n
        if t in ("dropdown", "radio", "checkboxes"):
            hit = next((o.get("value") for o in f.get("options") or [] if str(o.get("value")) == str(x)), _MISSING)
            if hit is not _MISSING:
                return hit
            if f.get("allow_other") and t != "checkboxes":
                return x
            raise ValueError(f"{label}: choose one of the options")
        if t == "object_dropdown":
            import ontology

            try:
                return ontology.get_object(f.get("object_type_id") or "", str(x))["primary_key"]
            except HTTPException:
                raise ValueError(f"{label}: no such object") from None
        if t in ("user_dropdown", "object_property_dropdown", "dataset_value_dropdown"):
            try:
                opts = options(f, values)
            except HTTPException as e:
                raise ValueError(f"{label}: {e.detail}") from None
            hit = next((o["value"] for o in opts if str(o["value"]) == str(x)), _MISSING)
            if hit is _MISSING:
                raise ValueError(f"{label}: not one of the choices")
            return hit
        if t == "date":
            return str(x)[:10]
        return x if isinstance(x, (str, int, float)) and not isinstance(x, bool) else str(x)

    out = [one(x) for x in items]
    return out if many else (out[0] if out else None)


def prefill(defn: dict, params: dict[str, Any], obj: Optional[dict], ignored: dict[str, str]) -> dict:
    """The starting values of an embedded form: from the object it is embedded for, then from URL parameters
    (`field.<id>`, a field's `url_param`, or a field ID). Each value is coerced to its field and validated like a
    submitted value; what does not pass is left out and reported in `ignored` (parameter → reason)."""
    multi = _multi_ids(defn)
    by_id = {f["id"]: f for _, f in _fields(defn)}
    by_param = {f["url_param"]: f for f in by_id.values() if f.get("url_param")}
    props = (obj or {}).get("properties") or {}
    # candidates: field id → (the parameter it came from, the raw value); URL parameters win over the object's values
    cand: dict[str, tuple[str, Any]] = {}
    if obj:
        d = defn.get("destination") or {}
        for fid, f in by_id.items():
            if fid in multi:
                continue
            if f["type"] == "object_dropdown" and f.get("object_type_id") == obj["object_type_id"]:
                cand[fid] = ("object", obj["primary_key"])
            elif d.get("kind") == "object_type" and d.get("object_type_id") == obj["object_type_id"] and f["type"] not in NOT_STORED \
                    and f["type"] != "attachments" and not _empty(props.get(f.get("column") or fid)):
                cand[fid] = ("object", props[f.get("column") or fid])
    for key, raw in params.items():
        if key in EMBED_PARAMS:
            continue
        name = key[6:] if key.startswith("field.") else key
        f = (by_id.get(name) or by_param.get(name)) if key.startswith("field.") else (by_param.get(name) or by_id.get(name))
        if not f:
            ignored[key] = f"the form has no field {name}"
            continue
        if f["id"] in multi:
            ignored[key] = f"{f.get('label') or f['id']} is filled in per entry"
            continue
        # {{property}} takes the value from the object the form is embedded for
        if isinstance(raw, str) and "{{" in raw:
            if not obj:
                ignored[key] = "{{property}} needs an object (object_type and pk)"
                continue
            whole = re.fullmatch(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", raw)
            raw = props.get(whole.group(1)) if whole else _template(raw, props)
        if _empty(raw):
            continue
        cand[f["id"]] = (key, raw)
    values: dict[str, Any] = {}
    for fid, (key, raw) in cand.items():
        f = by_id[fid]
        if key == "object" and f["type"] in ("primary_key", "created_at", "created_by"):
            values[fid] = raw  # the edited object keeps its key and its creation columns
            continue
        try:
            v = _coerce(f, raw, values)
        except ValueError as e:
            if key != "object":
                ignored[key] = str(e)
            continue
        if not _empty(v):
            values[fid] = v
    eff = effective(defn, values)
    for fid, msg in validate({k: eff[k] for k in values if k in eff}, values).items():
        key = cand[fid][0]
        values.pop(fid, None)
        if key != "object":
            ignored[key] = msg
    return values


class PrefillIn(BaseModel):
    # URL parameter → value (a list when the parameter is repeated)
    params: dict[str, Any] = {}
    object_type: Optional[str] = None
    pk: Optional[str] = None


@router.post("/{item_id}/prefill")
def prefill_route(item_id: str, req: PrefillIn, link: Optional[str] = Query(None)) -> dict:
    """The values an embedded form starts with (`?embed=1&object_type=…&pk=…&field.<id>=…`): validated like submitted
    values; the ones that do not pass are left out and listed in `ignored`. `edits_object`: the form writes to the
    object's own type, so submitting edits that object (Edit object form) instead of creating one."""
    if len(req.params) > 500:
        raise HTTPException(400, "at most 500 prefilled values")
    item = _respondent_item(item_id, link)
    defn = _published(_load(item))
    ignored: dict[str, str] = {}
    obj = _prefill_object(req.object_type, req.pk, ignored)
    values = prefill(defn, req.params, obj, ignored)
    d = defn.get("destination") or {}
    return {"values": values, "ignored": ignored,
            "object": {"object_type_id": obj["object_type_id"], "primary_key": obj["primary_key"], "title": obj.get("title")} if obj else None,
            "edits_object": bool(obj and d.get("kind") == "object_type" and d.get("object_type_id") == obj["object_type_id"])}


class SubmitIn(BaseModel):
    values: dict[str, Any] = {}
    # subsheet id → instances (field id → value) for multiplicity sheets
    entries: dict[str, list[dict[str, Any]]] = {}
    opened_at: Optional[str] = None
    # where the form was filled: {embedded, object_type, pk}; a form on the object's own type edits that object
    source: Optional[dict[str, Any]] = None


@router.post("/{item_id}/submit")
def submit(item_id: str, req: SubmitIn, link: Optional[str] = Query(None)) -> dict:
    import notify

    item = _respondent_item(item_id, link)
    form = _load(item)
    defn = _published(form)
    eff = effective(defn, req.values)
    vals = auto_values(defn, req.values, eff, req.opened_at)
    errors = {k: v for k, v in validate(eff, vals).items() if k not in _multi_ids(defn)}
    for sid, insts in req.entries.items():
        sheet = next((s for s in defn["sheets"] if s["id"] == sid), None)
        if not sheet:
            raise HTTPException(400, f"unknown sheet {sid}")
        ids = {f["id"] for f in sheet.get("fields") or []}
        for i, inst in enumerate(insts):
            merged = {**vals, **inst}
            sub = {fid: f for fid, f in effective(defn, merged).items() if fid in ids}
            for fid, msg in validate(sub, merged).items():
                errors[f"{sid}[{i}].{fid}"] = msg
    if errors:
        raise HTTPException(400, {"errors": errors})
    base = _rows(defn, vals, req.entries)
    # each row (multiplicity instance) gets its own generated primary key
    pk_ids = {fid for fid, f in eff.items() if f["type"] == "primary_key"} if len(base) > 1 else set()
    rows = [auto_values(defn, {k: v for k, v in r.items() if k not in pk_ids}, eff, req.opened_at) for r in base]
    src = req.source or {}
    source = {k: (bool(src[k]) if k == "embedded" else str(src[k])[:500]) for k in ("embedded", "object_type", "pk") if not _empty(src.get(k))}
    edit_key = None
    d = defn.get("destination") or {}
    if source.get("object_type") and source.get("pk") and d.get("kind") == "object_type" and d.get("object_type_id") == source["object_type"]:
        import ontology

        try:
            edit_key = ontology.get_object(source["object_type"], source["pk"])["primary_key"]
        except HTTPException as e:
            raise HTTPException(400, f"the object this form edits cannot be opened: {e.detail}") from None
        if len(rows) != 1:
            raise HTTPException(400, "a form that edits an object writes one entry")
        source["edited"] = True
    with _lock:
        written = _write(defn, rows, edit_key=edit_key)
        log = _responses(item_id)
        rid = uuid.uuid4().hex[:12]
        stored = [{k: v for k, v in r.items() if eff.get(k, {}).get("type") not in NOT_STORED} for r in rows]
        log.append({"id": rid, "at": _now(), "by": _me()["username"], "version": form["published"], "rows": stored, "written": written,
                    **({"source": source} if source else {})})
        _save_responses(item_id, log)
    for uid in form.get("subscribers") or []:
        try:
            notify.deliver(uid, f"New response to {form['title']}", f"{_me()['username']} submitted {len(rows)} entr{'y' if len(rows) == 1 else 'ies'}.",
                           f"/forms/{item_id}?tab=responses", "Open responses", "forms")
        except Exception:  # noqa: BLE001 - a notification never fails the submission
            pass
    return {"response_id": rid, "form_id": item_id, "rows": len(rows), "written": written, "edited_object": bool(edit_key)}


@router.get("/{item_id}/responses")
def responses(item_id: str) -> list[dict]:
    _item(item_id, "editor")
    return list(reversed(_responses(item_id)))


class EditIn(BaseModel):
    row: int = 0
    values: dict[str, Any]


@router.put("/{item_id}/responses/{response_id}")
def edit_response(item_id: str, response_id: str, req: EditIn) -> dict:
    """Edit a response: validated like a submission, written to the destination (object edited / row updated)."""
    item = _item(item_id, "editor")
    form = _load(item)
    defn = _published(form)
    with _lock:
        log = _responses(item_id)
        r = next((x for x in log if x["id"] == response_id), None)
        if not r or not 0 <= req.row < len(r["rows"]):
            raise HTTPException(404, "response not found")
        new = {**r["rows"][req.row], **req.values}
        eff = effective(defn, new)
        new = auto_values(defn, new, {k: f for k, f in eff.items() if f["type"] in ("calculation", "template")})
        errors = validate(eff, new)
        if errors:
            raise HTTPException(400, {"errors": errors})
        d = defn.get("destination") or {}
        key = None
        if d.get("kind") == "object_type":
            w = (r.get("written") or [])[req.row] if req.row < len(r.get("written") or []) else None
            key = (w or {}).get("primary_key")
        _write(defn, [new], edit_key=key) if d.get("kind") != "fusion" or d.get("key_first_column") else None
        r["rows"][req.row] = new
        r.setdefault("edits", []).append({"at": _now(), "by": _me()["username"], "row": req.row})
        _save_responses(item_id, log)
        return r


class BulkIn(BaseModel):
    primary_keys: list[str] = Field(min_length=1, max_length=1000)
    values: dict[str, Any]


@router.post("/{item_id}/bulk-edit")
def bulk_edit(item_id: str, req: BulkIn) -> dict:
    """Override the given fields on many objects (object-type forms): Object Explorer's "Edit N objects in this form"."""
    import ontology

    item = _item(item_id)
    defn = _published(_load(item))
    d = defn.get("destination") or {}
    if d.get("kind") != "object_type":
        raise HTTPException(400, "bulk edit needs a form on an object type")
    eff = effective(defn, req.values)
    errors = {k: v for k, v in validate(eff, req.values).items() if k in req.values}
    if errors:
        raise HTTPException(400, {"errors": errors})
    t = ontology._object_type(d["object_type_id"])
    cols = {k: v for k, v in _columns(defn, req.values).items() if any(p["api_name"] == k for p in t["properties"]) and k != t["primary_key"]}
    with ontology._lock:
        written = ontology.apply_edits([{"op": "modify", "object_type_id": t["id"], "primary_key": pk, "properties": cols} for pk in req.primary_keys], source="forms")
    return {"edited": len(written)}


class AttachIn(BaseModel):
    filename: str
    data: str  # base64
    media_type: Optional[str] = None
    folder_id: Optional[str] = None


@router.post("/{item_id}/attachments")
def attach(item_id: str, req: AttachIn, link: Optional[str] = Query(None)) -> dict:
    """Upload a file for an attachments field (to the field's folder, else next to the form)."""
    import base64
    import binascii
    import mimetypes

    import drive

    item = _respondent_item(item_id, link)
    if link and req.folder_id:
        req.folder_id = None  # a respondent link uploads next to the form only
    try:
        data = base64.b64decode(req.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "data is not base64") from None
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "at most 25 MB per file")
    saved = drive.save_bytes(req.folder_id or item.get("parent_id"), req.filename, data, req.media_type or mimetypes.guess_type(req.filename)[0] or "application/octet-stream")
    return {"id": saved["id"], "name": saved["name"]}
