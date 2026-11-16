"""Sensitive Data Scanner (Security & Governance → Sensitive Data Scanner): find sensitive data and act on it.

Match conditions:
  built-in   e-mail addresses, phone numbers, payment card numbers (Luhn), IBANs, IPv4 addresses, US SSNs and the
             Indonesian NIK, NPWP and BPJS Kesehatan card numbers
  regex      a content regex (with an optional threshold: the percentage of a column's non-empty cells that must
             match) and / or a column name regex, combined as content, column, both or either
  overlap    exact values of a column of a reference dataset (a list of names, say)
  llm        a language model asked whether a column's name and / or sample values are what a prompt describes
             (examples and counter examples); media items' extracted text too
Match actions:
  apply_markings  markings put on matched datasets / media sets (not re-applied after someone removed them unless
                  reapply is set); reversible
  create_issues   an issue per matched column (assignees, text, label, severity, notify the dataset's creator, no new
                  issue when an earlier one was archived / closed); reversible (the issues are deleted)
  obfuscate       a new "<dataset> (obfuscated)" dataset next to each matched one, with the matched column, rows,
                  cells or segments encrypted or hashed through a Cipher Admin license; not reversible

A scan selects datasets and media sets in included folders / Projects / datasets minus excluded ones (the most
specific wins), only source datasets (uploads, syncs, manual entry) or all, by markings (include / exclude), all rows
or a random sample, and runs once or on a schedule (daily 00:00 UTC, weekly Tuesday, monthly the 1st, or
continuously on every new transaction), optionally scanning everything once first. Media sets are scanned
incrementally (new items only), text from PDFs, OCR of images and transcription of audio. Results per resource list
the matching conditions with their columns and counts; masked samples only. Inactive scans of the past seven days can
get additional actions or have their actions reversed.

Permissions (as in the reference's permission model): administrators (data governance officers) and Owners of every
included Project configure conditions / actions and run, cancel and manage scans; anyone who can see an included
resource sees a scan's status and results for the resources they can see.

Mounted by server.py under /api/sds.
"""

from __future__ import annotations

import io
import json
import logging
import random
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

log = logging.getLogger("bluesandai.sds")
router = APIRouter(prefix="/api/sds", tags=["sensitive-data-scanner"])
DIR = Path("data/sds")
_lock = threading.RLock()
_running: dict[str, threading.Event] = {}
_started = False
MAX_ROWS = 200_000
SOURCE_KINDS = ("upload", "sync", "manual", "import", "drive")


def _luhn(s: str) -> bool:
    d = [int(c) for c in re.sub(r"\D", "", s)]
    if not 13 <= len(d) <= 19:
        return False
    tot = 0
    for i, n in enumerate(reversed(d)):
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        tot += n
    return tot % 10 == 0


BUILT_IN: list[dict] = [
    {"id": "builtin-email", "name": "E-mail address", "kind": "regex", "content_regex": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
     "column_regex": r"(?i)e-?mail", "logic": "content", "threshold": None},
    {"id": "builtin-phone", "name": "Phone number", "kind": "regex", "content_regex": r"(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,5}",
     "column_regex": r"(?i)(phone|telp|telepon|hp|mobile|ponsel|wa)", "logic": "both", "threshold": 50},
    {"id": "builtin-card", "name": "Payment card number", "kind": "regex", "content_regex": r"\b(?:\d[ -]?){13,19}\b", "column_regex": "", "logic": "content",
     "threshold": None, "check": "luhn"},
    {"id": "builtin-iban", "name": "IBAN", "kind": "regex", "content_regex": r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b", "column_regex": "", "logic": "content", "threshold": None},
    {"id": "builtin-ipv4", "name": "IPv4 address", "kind": "regex", "content_regex": r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b",
     "column_regex": "", "logic": "content", "threshold": None},
    {"id": "builtin-ssn", "name": "US Social Security number", "kind": "regex", "content_regex": r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b",
     "column_regex": "", "logic": "content", "threshold": None},
    {"id": "builtin-nik", "name": "Indonesian NIK (KTP number)", "kind": "regex", "content_regex": r"\b\d{6}(?:[0-6]\d|[4-7]\d)(?:0[1-9]|1[0-2])\d{2}\d{4}\b",
     "column_regex": r"(?i)\b(nik|ktp|no_?ktp)\b", "logic": "either", "threshold": 50},
    {"id": "builtin-npwp", "name": "Indonesian NPWP", "kind": "regex", "content_regex": r"\b\d{2}\.?\d{3}\.?\d{3}\.?\d-?\d{3}\.?\d{3}\b",
     "column_regex": r"(?i)npwp", "logic": "either", "threshold": 50},
    {"id": "builtin-bpjs", "name": "BPJS Kesehatan card number", "kind": "regex", "content_regex": r"\b000\d{10}\b",
     "column_regex": r"(?i)(bpjs|no_?kartu|jkn)", "logic": "both", "threshold": 50},
]


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "sds"
    (DIR / "scans").mkdir(parents=True, exist_ok=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _read(name: str, default: Any) -> Any:
    return audit3._read(DIR / name, default)


def _write(name: str, value: Any) -> None:
    audit3._write(DIR / name, value)


def _conditions() -> list[dict]:
    return [{**c, "builtin": True} for c in BUILT_IN] + _read("conditions.json", [])


def _actions() -> list[dict]:
    return _read("actions.json", [])


def _scan(sid: str) -> dict:
    s = audit3._read(DIR / "scans" / f"{sid}.json", None) if re.fullmatch(r"[0-9a-f]{12}", sid or "") else None
    if not s:
        raise HTTPException(404, "scan not found")
    return s


def _save_scan(s: dict) -> None:
    audit3._write(DIR / "scans" / f"{s['id']}.json", s)


def _scans() -> list[dict]:
    return [s for p in sorted((DIR / "scans").glob("*.json")) if (s := audit3._read(p, None))]


# ------------------------------------------------------------------------------------------------
# permissions
# ------------------------------------------------------------------------------------------------


def _governor(p: Optional[dict] = None) -> bool:
    p = p or auth.current()
    return not auth.enabled() or bool(p and (p.get("role") == "admin" or p.get("service")))


def _may_manage(include: list[str]) -> None:
    """Administrators, or Owners of every included Project (resources outside Projects need an administrator)."""
    p = auth.require_user()
    if _governor(p):
        return
    projects = {auth.project_of(i) for i in include}
    if not include or None in projects or any(auth.role_for(pid) != "owner" for pid in projects):
        raise HTTPException(403, "Running and managing scans needs administrator (data governance officer) rights, or the Owner role on every included Project")


def _may_configure() -> None:
    p = auth.require_user()
    if _governor(p):
        return
    # Project Owners configure conditions and actions too (they are shared, like a space's)
    try:
        import db

        if any(auth.role_for(x["id"]) == "owner" for x in db.drive_list(None) if x["kind"] == "project"):
            return
    except Exception:  # noqa: BLE001
        pass
    raise HTTPException(403, "Configuring match conditions and actions needs administrator rights or the Owner role on a Project")


# ------------------------------------------------------------------------------------------------
# match conditions and actions
# ------------------------------------------------------------------------------------------------


class ConditionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["regex", "overlap", "llm"]
    description: str = ""
    content_regex: str = ""
    column_regex: str = ""
    logic: Literal["content", "column", "both", "either"] = "content"
    threshold: Optional[float] = Field(None, gt=0, le=100)
    overlap_dataset: Optional[str] = None
    overlap_column: Optional[str] = None
    model: str = ""
    prompt: str = ""
    column_prompt: str = ""
    examples: list[str] = Field(default_factory=list)
    counter_examples: list[str] = Field(default_factory=list)


def _check_condition(c: ConditionIn) -> None:
    if c.kind == "regex":
        if not c.content_regex and not c.column_regex:
            raise HTTPException(400, "give a content regex, a column name regex, or both")
        for r in (c.content_regex, c.column_regex):
            if r:
                try:
                    re.compile(r)
                except re.error as e:
                    raise HTTPException(400, f"not a valid regular expression: {r} ({e})") from None
        if c.logic in ("both", "either") and not (c.content_regex and c.column_regex):
            raise HTTPException(400, f'"{c.logic}" needs both a content and a column name regex')
    elif c.kind == "overlap":
        if not c.overlap_dataset or not c.overlap_column:
            raise HTTPException(400, "choose the overlap dataset and column")
    elif not (c.prompt or c.column_prompt):
        raise HTTPException(400, "describe what the language model should detect")


@router.get("/conditions")
def list_conditions() -> list[dict]:
    auth.require_user()
    return _conditions()


@router.post("/conditions")
def create_condition(req: ConditionIn) -> dict:
    _may_configure()
    _check_condition(req)
    c = {"id": uuid.uuid4().hex[:12], **req.model_dump(), "created_by": (auth.current() or {}).get("username"), "created_at": _iso()}
    with _lock:
        _write("conditions.json", [*_read("conditions.json", []), c])
    return c


@router.put("/conditions/{cid}")
def update_condition(cid: str, req: ConditionIn) -> dict:
    _may_configure()
    _check_condition(req)
    with _lock:
        rows = _read("conditions.json", [])
        c = next((x for x in rows if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "custom match condition not found (built-in conditions cannot be edited)")
        c.update(req.model_dump(), updated_at=_iso())
        _write("conditions.json", rows)
    return c


@router.delete("/conditions/{cid}")
def delete_condition(cid: str) -> dict:
    _may_configure()
    with _lock:
        _write("conditions.json", [x for x in _read("conditions.json", []) if x["id"] != cid])
    return {"deleted": cid}


class TestIn(BaseModel):
    condition: ConditionIn
    column: str = "value"
    values: list[str]


@router.post("/conditions/test")
def test_condition(req: TestIn) -> dict:
    """Try a condition on sample values before scanning (the reference recommends testing conditions first)."""
    auth.require_user()
    _check_condition(req.condition)
    cond = {"id": "test", **req.condition.model_dump()}
    hit = _evaluate(cond, req.column, req.values, {})
    return {"match": bool(hit), **(hit or {})}


class GenerateIn(BaseModel):
    description: str = Field(min_length=3, max_length=500)


@router.post("/conditions/generate-regex")
def generate_regex(req: GenerateIn) -> dict:
    """Regex generation with AIP: a content regex and examples for a description ("all email addresses")."""
    auth.require_user()
    import pipeline_ai

    schema = {"type": "object", "properties": {"regex": {"type": "string"}, "matches": {"type": "array", "items": {"type": "string"}},
                                               "non_matches": {"type": "array", "items": {"type": "string"}}}, "required": ["regex", "matches", "non_matches"]}
    out = pipeline_ai.chat(pipeline_ai.DEFAULT_TEXT_MODEL, "You write Python regular expressions (re module) that find sensitive data inside text cells. "
                           "Answer with the regex (no anchors, no flags), 3 to 5 example strings it matches and 3 it must not match.", req.description, schema=schema)
    try:
        rx = re.compile(out["regex"])
    except (re.error, KeyError, TypeError):
        raise HTTPException(502, "the model did not return a valid regular expression; try again or write it yourself") from None
    return {"regex": out["regex"], "matches": [m for m in out.get("matches") or [] if rx.search(m)], "non_matches": out.get("non_matches") or []}


class ActionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["apply_markings", "create_issues", "obfuscate"]
    markings: list[str] = Field(default_factory=list)
    reapply_removed: bool = False
    assignees: list[str] = Field(default_factory=list)
    issue_text: str = "Sensitive Data Scanner found {condition} in column {column} of {dataset}."
    label: str = "sensitive-data"
    severity: Literal["low", "medium", "high", "critical"] = "medium"
    notify_creator: bool = False
    skip_if_archived: bool = True
    skip_if_closed: bool = False
    license: Optional[str] = None
    mode: Literal["column", "row", "cell", "segments"] = "column"


@router.get("/actions")
def list_actions() -> list[dict]:
    auth.require_user()
    return _actions()


@router.post("/actions")
def create_action(req: ActionIn) -> dict:
    _may_configure()
    if req.kind == "apply_markings":
        known = auth._known_markings()
        if not req.markings or set(req.markings) - known:
            raise HTTPException(400, "choose known markings to apply")
    if req.kind == "obfuscate":
        import cipher

        if not req.license:
            raise HTTPException(400, "choose a Cipher Admin license")
        r = cipher._find(req.license)
        if r.get("kind") != "admin":
            raise HTTPException(400, "obfuscation needs a Cipher Admin license (it needs key access)")
        if cipher._channel(r["channel_id"])["algorithm"] == "VISUAL":
            raise HTTPException(400, "visual obfuscation channels are not supported by Sensitive Data Scanner")
    a = {"id": uuid.uuid4().hex[:12], **req.model_dump(), "created_by": (auth.current() or {}).get("username"), "created_at": _iso()}
    with _lock:
        _write("actions.json", [*_actions(), a])
    return a


@router.delete("/actions/{aid}")
def delete_action(aid: str) -> dict:
    _may_configure()
    with _lock:
        _write("actions.json", [x for x in _actions() if x["id"] != aid])
    return {"deleted": aid}


# ------------------------------------------------------------------------------------------------
# evaluating a column
# ------------------------------------------------------------------------------------------------


def _mask(v: str) -> str:
    v = str(v)
    return v[:2] + "•" * max(1, min(8, len(v) - 4)) + v[-2:] if len(v) > 4 else "•" * len(v)


_overlap_cache: dict[str, tuple[float, set]] = {}


def _overlap_values(c: dict) -> set:
    key = f"{c['overlap_dataset']}:{c['overlap_column']}"
    hit = _overlap_cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    table = _read_table(c["overlap_dataset"], None)
    vals = {str(v).strip().lower() for v in table.get(c["overlap_column"], []) if v not in (None, "")} if table else set()
    _overlap_cache[key] = (time.monotonic() + 300, vals)
    return vals


def _llm_yes(c: dict, what: str, payload: str) -> bool:
    import pipeline_ai

    ex = "".join(f"\nExample that matches: {e}" for e in c.get("examples") or []) + "".join(f"\nCounter example: {e}" for e in c.get("counter_examples") or [])
    prompt = (c.get("column_prompt") if what == "column" and c.get("column_prompt") else c.get("prompt")) or c.get("column_prompt") or ""
    system = ("You classify data for a data protection team. Answer true when the input is what the description describes, false otherwise." + ex)
    user = f"Description: {prompt}\n\n{'Column name' if what == 'column' else 'Values'}:\n{payload}"
    try:
        return bool(pipeline_ai.chat(c.get("model") or pipeline_ai.DEFAULT_TEXT_MODEL, system, user, schema={"type": "boolean"}))
    except Exception as e:  # noqa: BLE001
        log.warning("language model condition failed: %s", e)
        return False


def _evaluate(c: dict, column: str, values: list, stats: dict) -> Optional[dict]:
    """Whether a column matches a condition: {matched, scanned, samples} or None."""
    texts = [str(v) for v in values if v is not None and str(v).strip() != ""]
    if c["kind"] == "regex":
        col_ok = bool(c.get("column_regex")) and bool(re.search(c["column_regex"], column))
        logic = c.get("logic") or "content"
        if logic == "column":
            return {"matched": len(texts), "scanned": len(texts), "samples": []} if col_ok else None
        # the column name is checked before reading content (the reference's compute optimization)
        if logic == "both" and not col_ok:
            return None
        hits = []
        if c.get("content_regex"):
            rx = re.compile(c["content_regex"])
            for t in texts:
                m = rx.search(t)
                if m and (c.get("check") != "luhn" or _luhn(m.group(0))):
                    hits.append(m.group(0))
        content_ok = bool(hits) and (not c.get("threshold") or len(hits) * 100 / max(1, len(texts)) >= float(c["threshold"]))
        ok = content_ok if logic in ("content", "both") else (content_ok or col_ok)
        return {"matched": len(hits), "scanned": len(texts), "samples": [_mask(h) for h in hits[:3]]} if ok else None
    if c["kind"] == "overlap":
        ref = _overlap_values(c)
        hits = [t for t in texts if t.strip().lower() in ref]
        return {"matched": len(hits), "scanned": len(texts), "samples": [_mask(h) for h in hits[:3]]} if hits else None
    # language model: the column name and / or up to 20 sample values
    stats["llm_calls"] = stats.get("llm_calls", 0)
    logic = c.get("logic") or "content"
    col_ok = content_ok = False
    if logic in ("column", "both", "either"):
        stats["llm_calls"] += 1
        col_ok = _llm_yes(c, "column", column)
    if logic in ("content", "both", "either") and texts and not (logic == "both" and not col_ok) and not (logic == "either" and col_ok):
        stats["llm_calls"] += 1
        content_ok = _llm_yes(c, "content", "\n".join(t[:200] for t in random.sample(texts, min(20, len(texts)))))
    ok = {"content": content_ok, "column": col_ok, "both": col_ok and content_ok, "either": col_ok or content_ok}[logic]
    return {"matched": len(texts) if ok else 0, "scanned": len(texts), "samples": []} if ok else None


# ------------------------------------------------------------------------------------------------
# resources
# ------------------------------------------------------------------------------------------------


_VT_TYPE = "application/vnd.bluesandai.virtual-table+json"  # virtual_tables.VT_TYPE


def _arrow(item: dict) -> Optional[pa.Table]:
    """A dataset (Parquet or CSV) or a virtual table (through its connection) as an Arrow table."""
    import drive

    if item.get("content_type") == _VT_TYPE:
        import virtual_tables

        return virtual_tables.read(virtual_tables.record(item))
    name = item["name"].lower()
    if name.endswith(".parquet"):
        import pyarrow.parquet as pq

        return pq.read_table(io.BytesIO(drive.read_bytes(item)))
    if name.endswith((".csv", ".tsv")):
        import pyarrow.csv as pacsv

        return pacsv.read_csv(io.BytesIO(drive.read_bytes(item)), parse_options=pacsv.ParseOptions(delimiter="\t" if name.endswith(".tsv") else ","))
    return None


def _read_table(item_id: str, sample: Optional[int]) -> Optional[dict]:
    """A dataset's or virtual table's columns as {name: [values]}, sampled when asked."""
    import db

    item = db.drive_get(item_id)
    if not item or item.get("trashed_at") or item["kind"] != "file":
        return None
    t = _arrow(item)
    if t is None:
        return None
    if t.num_rows > MAX_ROWS:
        t = t.slice(0, MAX_ROWS)
    rows = t.num_rows
    idx = sorted(random.sample(range(rows), sample)) if sample and rows > sample else None
    out = {}
    for col in t.column_names:
        vals = t.column(col).to_pylist()
        out[col] = [vals[i] for i in idx] if idx is not None else vals
    return out


def _source_kind(item_id: str) -> str:
    import dataset_versions

    hist = dataset_versions.history(item_id)
    kinds = {(tx.get("kind") or (tx.get("source") or {}).get("kind") or "") for tx in hist}
    if not hist:
        return "upload"
    if kinds & {"build"}:
        return "derived"
    return next(iter(kinds)) or "upload"


def _resources(scan: dict) -> list[dict]:
    """Datasets and media sets a scan covers: included folders' contents and included items, minus exclusions; the
    most specific inclusion or exclusion wins."""
    import db
    import drive

    out: dict[str, dict] = {}
    types = set(scan.get("resource_types") or ["datasets"])

    def depth_rule(item_id: str) -> Optional[bool]:
        chain = [x["id"] for x in db.drive_path(item_id)]
        for anc in reversed(chain):
            if anc in scan["exclude"]:
                return False
            if anc in scan["include"]:
                return True
        return None

    def visit(item: dict) -> None:
        if item.get("trashed_at"):
            return
        if item["kind"] in drive.CONTAINERS:
            is_media = False
            if "media_sets" in types:
                try:
                    import media_sets

                    is_media = media_sets.is_media_set(item["id"])
                except Exception:  # noqa: BLE001
                    is_media = False
            if is_media:
                if depth_rule(item["id"]) is not False:
                    out[item["id"]] = {"id": item["id"], "name": item["name"], "type": "media_set"}
                return
            for child in db.drive_list(item["id"]):
                visit(child)
        elif item["kind"] == "file" and item.get("content_type") == _VT_TYPE:
            # a virtual table: read through its connection (the data stays in the external system)
            if "virtual_tables" in types and depth_rule(item["id"]) is not False:
                out[item["id"]] = {"id": item["id"], "name": item["name"], "type": "virtual_table"}
        elif item["kind"] == "file" and "datasets" in types and item["name"].lower().endswith((".parquet", ".csv", ".tsv")):
            if depth_rule(item["id"]) is not False:
                out[item["id"]] = {"id": item["id"], "name": item["name"], "type": "dataset"}

    for rid in scan["include"]:
        it = db.drive_get(rid)
        if it:
            visit(it)
    res = []
    for r in out.values():
        marks = auth.effective_markings(r["id"])
        if scan.get("include_markings") and not marks & set(scan["include_markings"]):
            continue
        if scan.get("exclude_markings") and marks & set(scan["exclude_markings"]):
            continue
        if r["type"] == "dataset" and scan.get("strategy") == "source_only":
            kind = _source_kind(r["id"])
            allowed = set(scan.get("source_kinds") or SOURCE_KINDS)
            if kind == "derived" or (kind not in allowed and kind in SOURCE_KINDS):
                continue
        res.append(r)
    return res


def _media_texts(item_id: str, seen: set) -> list[tuple[str, str, str]]:
    """(media item id, name, extracted text) for the media set's items not scanned before."""
    import db
    import pipeline_ai

    out = []
    for it in db.drive_list(item_id):
        if it["kind"] != "file" or it.get("trashed_at") or it["id"] in seen:
            continue
        n = it["name"].lower()
        method = "raw" if n.endswith(".pdf") else "image_text" if n.endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp")) else \
            "transcribe" if n.endswith((".mp3", ".wav", ".m4a", ".ogg", ".flac", ".mp4")) else None
        if n.endswith((".txt", ".md", ".csv", ".json", ".eml")):
            import drive

            out.append((it["id"], it["name"], drive.read_bytes(it).decode("utf-8", "replace")[:500_000]))
            continue
        if not method:
            continue
        r = pipeline_ai._run_media(pipeline_ai.MediaCall(key=it["id"], item_id=it["id"], method=method, max_pages=20))
        text = r.get("value")
        if isinstance(text, (list, dict)):
            text = json.dumps(text, ensure_ascii=False)
        out.append((it["id"], it["name"], str(text or "")))
    return out


# ------------------------------------------------------------------------------------------------
# match actions
# ------------------------------------------------------------------------------------------------


def _apply_markings(a: dict, res: dict, scan: dict, effects: list) -> None:
    own, _ = auth._item_row(res["id"])
    # a marking a scan applied (not reversed by a scan) that is gone now was removed by someone: not re-applied
    # unless the action says so
    removed = {e["marking"] for x in [*_scans(), {"effects": effects}] for e in x.get("effects") or []
               if e.get("kind") == "marking" and e.get("item") == res["id"] and not e.get("reversed") and e["marking"] not in own}
    add = [m for m in a["markings"] if m not in own and (a.get("reapply_removed") or m not in removed)]
    if not add:
        return
    auth._set_item(res["id"], own=sorted(set(own) | set(add)))
    for m in add:
        effects.append({"kind": "marking", "item": res["id"], "marking": m, "action": a["id"], "at": _iso()})
    auth.audit("markings_changed", None, f"{res['id']}: +{', '.join(auth._marking_names(add))} (Sensitive Data Scanner {scan['name']})")


def _create_issues(a: dict, res: dict, matches: list, scan: dict, effects: list) -> None:
    import dataset_preview

    if res["type"] == "media_set":
        cols = [None]  # one issue per media set (aggregated)
    else:
        cols = sorted({col for m in matches for col in m["columns"]})
    meta = dataset_preview._meta(res["id"])
    for col in cols:
        prior = [i for i in meta["issues"] if i.get("sds_action") == a["id"] and i.get("column") == col]
        if any(i["status"] == "open" for i in prior):
            continue
        if a.get("skip_if_archived") and any(i["status"] == "archived" for i in prior) or a.get("skip_if_closed") and any(i["status"] == "resolved" for i in prior):
            continue
        conds = ", ".join(sorted({m["condition_name"] for m in matches if col is None or col in m["columns"]}))
        text = (a.get("issue_text") or "").format(condition=conds, column=col or "(media)", dataset=res["name"])
        issue = {"id": uuid.uuid4().hex[:10], "column": col, "title": f"Sensitive data: {conds}", "description": text, "status": "open", "author": "Sensitive Data Scanner",
                 "author_id": None, "created_at": _iso(), "comments": [], "assignee": (a.get("assignees") or [None])[0], "watchers": list(a.get("assignees") or []),
                 "labels": [a.get("label") or "sensitive-data"], "severity": a.get("severity"), "sds_action": a["id"], "sds_scan": scan["id"]}
        meta["issues"].append(issue)
        effects.append({"kind": "issue", "item": res["id"], "issue": issue["id"], "action": a["id"], "at": _iso()})
        try:
            import notify

            for u in a.get("assignees") or []:
                notify.deliver(u, issue["title"], text, link=f"/datasets/{res['id']}?tab=issues", source="sensitive-data-scanner")
            if a.get("notify_creator"):
                creator = _creator(res["id"])
                if creator:
                    notify.deliver(creator, f"Sensitive data found in {res['name']}", text, link=f"/datasets/{res['id']}?tab=issues", source="sensitive-data-scanner")
        except Exception:  # noqa: BLE001
            log.exception("SDS issue notification failed")
    dataset_preview._save_meta(res["id"], meta)


def _creator(item_id: str) -> Optional[str]:
    import dataset_versions

    hist = dataset_versions.history(item_id)
    by = (hist[0].get("source") or {}).get("by") if hist else None
    if not by:
        return None
    return next((u["id"] for u in auth._users() if u["username"] == by), None)


def _obfuscate(a: dict, res: dict, matches: list, scan: dict, effects: list) -> None:
    """A new dataset next to the matched one with the matched data encrypted or hashed (Cipher Admin license)."""
    if res["type"] not in ("dataset", "virtual_table"):
        return
    import cipher
    import cipher_crypto as cc
    import db
    import model_deployments
    import pyarrow as pa
    import pyarrow.parquet as pq
    import drive

    r = cipher._find(a["license"])
    cipher._check(r, "encrypt", ("admin",))
    lic_project, res_project = auth.project_of(r.get("item_id")), auth.project_of(res["id"])
    if lic_project != res_project:
        raise HTTPException(400, f"{res['name']}: the Cipher license must be in the same Project as the scanned dataset")
    op = cc.Operator(cipher._material(cipher._channel(r["channel_id"])))
    item = db.drive_get(res["id"])
    # a virtual table's obfuscated copy is a managed dataset next to it (the external table is not rewritten)
    t = _arrow(item)
    data = {c: t.column(c).to_pylist() for c in t.column_names}
    cols = sorted({col for m in matches for col in m["columns"]})
    conds = {m["condition_id"]: m for m in matches}
    regexes = [c.get("content_regex") for c in _conditions() if c["id"] in conds and c.get("kind") == "regex" and c.get("content_regex")]
    mode = a.get("mode") or "column"

    def hit(v: Any) -> bool:
        return v is not None and any(re.search(rx, str(v)) for rx in regexes) if regexes else v is not None

    if mode == "column":
        for c in cols:
            data[c] = [op.encrypt(None if v is None else str(v)) for v in data[c]]
    elif mode == "row":
        rows = {i for c in cols for i, v in enumerate(data[c]) if hit(v)}
        for c in data:
            data[c] = [op.encrypt(None if v is None else str(v)) if i in rows else v for i, v in enumerate(data[c])]
    elif mode == "cell":
        for c in cols:
            data[c] = [op.encrypt(str(v)) if hit(v) else v for v in data[c]]
    else:
        for c in cols:
            data[c] = [cc.all_matches(None if v is None else str(v), "|".join(f"(?:{rx})" for rx in regexes), op.encrypt) if regexes else op.encrypt(None if v is None else str(v))
                       for v in data[c]]
    out = pa.table({c: pa.array([None if v is None else (v if c not in cols and mode != "row" else str(v)) for v in vals]) for c, vals in data.items()})
    buf = io.BytesIO()
    pq.write_table(out, buf)
    stem = item["name"].rsplit(".", 1)[0]
    w = model_deployments.write_dataset(item["parent_id"], f"{stem} (obfuscated)", buf.getvalue(), {"kind": "sensitive_data_scanner", "scan": scan["id"], "source": res["id"]})
    effects.append({"kind": "obfuscated", "item": res["id"], "output": w["item_id"], "action": a["id"], "at": _iso()})


def _act(scan: dict, res: dict, matches: list, action_ids: list[str], effects: list) -> list[str]:
    errors = []
    acts = {a["id"]: a for a in _actions()}
    for aid in action_ids:
        a = acts.get(aid)
        if not a:
            continue
        try:
            if a["kind"] == "apply_markings":
                _apply_markings(a, res, scan, effects)
            elif a["kind"] == "create_issues":
                _create_issues(a, res, matches, scan, effects)
            else:
                _obfuscate(a, res, matches, scan, effects)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{a['name']} on {res['name']}: {getattr(e, 'detail', None) or e}")
    return errors


# ------------------------------------------------------------------------------------------------
# running a scan
# ------------------------------------------------------------------------------------------------


def _scan_resource(scan: dict, res: dict, conds: list[dict], stats: dict, full: bool = False) -> dict:
    out = {"id": res["id"], "name": res["name"], "type": res["type"], "matches": [], "scanned_rows": 0, "at": _iso()}
    if res["type"] in ("dataset", "virtual_table"):
        table = _read_table(res["id"], scan.get("sample_rows") if scan.get("rows") == "sample" else None)
        if table is None:
            out["error"] = "unreadable"
            return out
        out["scanned_rows"] = len(next(iter(table.values()), []))
        for c in conds:
            cols, n, samples = [], 0, []
            for col, vals in table.items():
                hit = _evaluate(c, col, vals, stats)
                if hit:
                    cols.append(col)
                    n += hit["matched"]
                    samples += hit["samples"]
            if cols:
                out["matches"].append({"condition_id": c["id"], "condition_name": c["name"], "columns": cols, "count": n, "samples": samples[:3]})
    else:
        seen = set() if full else set((scan.get("media_seen") or {}).get(res["id"], []))
        texts = _media_texts(res["id"], seen)
        if scan.get("rows") == "sample" and scan.get("sample_rows") and len(texts) > scan["sample_rows"]:
            texts = random.sample(texts, scan["sample_rows"])
        out["scanned_rows"] = len(texts)
        out["incremental"] = bool(seen)
        for c in conds:
            if c["kind"] == "overlap" or (c["kind"] == "regex" and (c.get("logic") == "column" or not c.get("content_regex"))):
                continue  # media sets: content conditions only
            items = [(mid, name) for mid, name, text in texts if _evaluate({**c, "logic": "content"}, "text", [text], stats)]
            if items:
                out["matches"].append({"condition_id": c["id"], "condition_name": c["name"], "columns": [], "count": len(items),
                                       "items": [{"id": i, "name": n} for i, n in items[:10]], "samples": []})
        scan.setdefault("media_seen", {})[res["id"]] = sorted(seen | {mid for mid, _, _ in texts})
    return out


def run_scan(sid: str, only: Optional[list[str]] = None, full: bool = False, trigger: str = "manual") -> dict:
    """Scan the resources (or `only` those), apply the scan's match actions, record the run."""
    stop = _running.setdefault(sid, threading.Event())
    stop.clear()
    s = _scan(sid)
    run = {"id": uuid.uuid4().hex[:10], "started_at": _iso(), "trigger": trigger, "status": "running", "resources": 0, "matched": 0, "errors": []}
    with _lock:
        s["runs"] = [run, *(s.get("runs") or [])][:50]
        s["status_detail"] = "running"
        _save_scan(s)
    stats: dict = {}
    conds = [c for c in _conditions() if c["id"] in s["conditions"]]
    results = {r["id"]: r for r in s.get("results") or []}
    effects = list(s.get("effects") or [])
    try:
        resources = _resources(s)
        if only is not None:
            resources = [r for r in resources if r["id"] in only]
        for res in resources:
            if stop.is_set():
                run["status"] = "cancelled"
                break
            try:
                r = _scan_resource(s, res, conds, stats, full)
            except Exception as e:  # noqa: BLE001
                r = {"id": res["id"], "name": res["name"], "type": res["type"], "matches": [], "error": str(e)[:300], "at": _iso()}
            prev = results.get(res["id"])
            if prev and res["type"] == "media_set" and r.get("incremental"):
                # incremental: keep earlier matches, add the new ones
                merged = {m["condition_id"]: m for m in prev.get("matches") or []}
                for m in r["matches"]:
                    merged[m["condition_id"]] = {**m, "count": m["count"] + merged.get(m["condition_id"], {}).get("count", 0)}
                r["matches"] = list(merged.values())
            r["history"] = [{"at": r["at"], "scanned": r.get("scanned_rows", 0), "conditions": [m["condition_name"] for m in r["matches"]],
                             "incremental": bool(r.get("incremental"))}, *((prev or {}).get("history") or [])][:20]
            results[res["id"]] = r
            run["resources"] += 1
            if r["matches"]:
                run["matched"] += 1
                run["errors"] += _act(s, res, r["matches"], s["actions"], effects)
        else:
            run["status"] = "succeeded" if not run["errors"] else "succeeded with errors"
    except Exception as e:  # noqa: BLE001
        log.exception("scan %s failed", sid)
        run["status"] = "failed"
        run["errors"].append(str(getattr(e, "detail", None) or e)[:500])
    run["finished_at"] = _iso()
    run["llm_calls"] = stats.get("llm_calls", 0)
    with _lock:
        cur = _scan(sid)
        cur["results"] = list(results.values())
        cur["effects"] = effects
        cur["media_seen"] = s.get("media_seen") or cur.get("media_seen") or {}
        cur["runs"] = [run if x["id"] == run["id"] else x for x in cur.get("runs") or []]
        cur["status_detail"] = run["status"]
        cur["last_run_at"] = run["finished_at"]
        if cur["schedule"] == "once":
            cur["active"] = False
        _save_scan(cur)
    audit3.emit("SDS_RUN_SCAN", ["dataLoad", "monitorRun"], {"loadedResources": [{"type": r["type"], "id": r["id"]} for r in results.values()][:100],
                                                             "runMonitorTargets": [{"type": "sds-scan", "id": sid}]},
                {"matched": run["matched"], "status": run["status"]}, product="sensitive-data-scanner")
    return run


class ScanIn(BaseModel):
    name: str = Field("", max_length=120)
    description: str = ""
    resource_types: list[Literal["datasets", "media_sets", "virtual_tables"]] = Field(default_factory=lambda: ["datasets"])
    include: list[str] = Field(min_length=1)
    exclude: list[str] = Field(default_factory=list)
    strategy: Literal["source_only", "all"] = "source_only"
    source_kinds: list[str] = Field(default_factory=lambda: list(SOURCE_KINDS))
    rows: Literal["all", "sample"] = "all"
    sample_rows: Optional[int] = Field(None, ge=1, le=MAX_ROWS)
    schedule: Literal["once", "daily", "weekly", "monthly", "continuous"] = "once"
    initial_scan: bool = True
    include_markings: list[str] = Field(default_factory=list)
    exclude_markings: list[str] = Field(default_factory=list)
    conditions: list[str] = Field(min_length=1)
    actions: list[str] = Field(default_factory=list)


def _check_scan(req: ScanIn) -> None:
    _may_manage(req.include)
    known = {c["id"] for c in _conditions()}
    if set(req.conditions) - known:
        raise HTTPException(400, "unknown match condition")
    if set(req.actions) - {a["id"] for a in _actions()}:
        raise HTTPException(400, "unknown match action")
    if req.rows == "sample" and not req.sample_rows:
        raise HTTPException(400, "give the number of rows to sample")


@router.post("/scans/preview")
def preview(req: ScanIn) -> dict:
    """Review and run: the resources the scan would cover (and a rough compute estimate)."""
    _check_scan(req)
    res = _resources({**req.model_dump(), "id": "preview"})
    return {"resources": res[:500], "count": len(res), "datasets": sum(1 for r in res if r["type"] == "dataset"),
            "media_sets": sum(1 for r in res if r["type"] == "media_set"), "virtual_tables": sum(1 for r in res if r["type"] == "virtual_table"),
            "llm_conditions": sum(1 for c in _conditions() if c["id"] in req.conditions and c["kind"] == "llm")}


@router.post("/scans")
def create_scan(req: ScanIn) -> dict:
    _check_scan(req)
    p = auth.require_user()
    s = {"id": uuid.uuid4().hex[:12], **req.model_dump(), "name": req.name.strip() or f"Scan {_iso()[:16].replace('T', ' ')}", "created_by": p.get("username"),
         "created_by_id": p.get("id"), "created_at": _iso(), "active": True, "runs": [], "results": [], "effects": [], "status_detail": "created"}
    with _lock:
        _save_scan(s)
    audit3.emit("SDS_CREATE_SCAN", ["monitorCreate"], {"createdMonitorDescription": s["name"]}, {"createdMonitorResources": [{"type": "sds-scan", "id": s["id"]}]},
                product="sensitive-data-scanner")
    if req.schedule == "once" or req.initial_scan:
        threading.Thread(target=run_scan, args=(s["id"],), kwargs={"trigger": "initial" if req.schedule != "once" else "one-time"}, daemon=True).start()
    return s


def _visible_results(s: dict) -> list[dict]:
    return [r for r in s.get("results") or [] if auth.can_access(r["id"])]


def _view(s: dict, full: bool = True) -> dict:
    can_manage = True
    try:
        _may_manage(s["include"])
    except HTTPException:
        can_manage = False
    created = datetime.fromisoformat(s["created_at"])
    out = {k: v for k, v in s.items() if k not in ("results", "effects", "media_seen")}
    out.update(can_manage=can_manage, results=_visible_results(s) if full else None, matched=sum(1 for r in _visible_results(s) if r["matches"]),
               effects=len(s.get("effects") or []), adjustable=not s.get("active") and _now() - created < timedelta(days=7))
    if not full:
        out.pop("results")
    return out


@router.get("/scans")
def list_scans() -> list[dict]:
    auth.require_user()
    out = []
    for s in _scans():
        if _governor() or any(auth.can_access(i) for i in s["include"]):
            out.append(_view(s, full=False))
    return sorted(out, key=lambda s: s["created_at"], reverse=True)


@router.get("/scans/{sid}")
def get_scan(sid: str) -> dict:
    auth.require_user()
    s = _scan(sid)
    if not (_governor() or any(auth.can_access(i) for i in s["include"])):
        raise HTTPException(403, "You cannot see this scan's resources")
    return _view(s)


@router.post("/scans/{sid}/run")
def run_now(sid: str, full: bool = False, resource: Optional[str] = None) -> dict:
    s = _scan(sid)
    _may_manage(s["include"])
    threading.Thread(target=run_scan, args=(sid,), kwargs={"only": [resource] if resource else None, "full": full, "trigger": "manual"}, daemon=True).start()
    return {"started": True}


@router.post("/scans/{sid}/cancel")
def cancel(sid: str) -> dict:
    s = _scan(sid)
    _may_manage(s["include"])
    _running.setdefault(sid, threading.Event()).set()
    return {"cancelling": True}


class ScanChange(BaseModel):
    active: Optional[bool] = None
    actions: Optional[list[str]] = None
    name: Optional[str] = None
    description: Optional[str] = None


@router.patch("/scans/{sid}")
def update_scan(sid: str, req: ScanChange) -> dict:
    with _lock:
        s = _scan(sid)
        _may_manage(s["include"])
        if req.active is not None:
            s["active"] = req.active and s["schedule"] != "once"
        if req.actions is not None:
            if set(req.actions) - {a["id"] for a in _actions()}:
                raise HTTPException(400, "unknown match action")
            s["actions"] = req.actions
        if req.name is not None:
            s["name"] = req.name
        if req.description is not None:
            s["description"] = req.description
        _save_scan(s)
    audit3.emit("SDS_UPDATE_SCAN", ["monitorUpdate"], {"updatedMonitorResources": [{"type": "sds-scan", "id": sid}], "updatedMonitorDescription": json.dumps(req.model_dump(exclude_none=True))},
                product="sensitive-data-scanner")
    return _view(s)


class ActionsIn(BaseModel):
    actions: list[str] = Field(min_length=1)


def _adjustable(s: dict) -> None:
    if s.get("active"):
        raise HTTPException(400, "deactivate the scan first: additional or reversed actions apply to inactive scans")
    if _now() - datetime.fromisoformat(s["created_at"]) >= timedelta(days=7):
        raise HTTPException(400, "only scans created within the past seven days can be adjusted")


@router.post("/scans/{sid}/apply-actions")
def apply_more(sid: str, req: ActionsIn) -> dict:
    """Additional match actions on what the scan found so far."""
    with _lock:
        s = _scan(sid)
        _may_manage(s["include"])
        _adjustable(s)
        effects = list(s.get("effects") or [])
        errors: list[str] = []
        for r in s.get("results") or []:
            if r["matches"]:
                errors += _act(s, {"id": r["id"], "name": r["name"], "type": r["type"]}, r["matches"], req.actions, effects)
        s["effects"] = effects
        s.setdefault("adjustments", []).append({"at": _iso(), "kind": "applied", "actions": req.actions, "errors": errors})
        _save_scan(s)
    return {"errors": errors, "effects": len(effects)}


@router.post("/scans/{sid}/reverse-actions")
def reverse(sid: str, req: ActionsIn) -> dict:
    """Undo markings and issues a scan's actions made (obfuscated datasets stay: delete them by hand)."""
    import dataset_preview

    with _lock:
        s = _scan(sid)
        _may_manage(s["include"])
        _adjustable(s)
        undone, kept = 0, 0
        for e in s.get("effects") or []:
            if e["action"] not in req.actions or e.get("reversed"):
                continue
            if e["kind"] == "marking":
                own, _ = auth._item_row(e["item"])
                auth._set_item(e["item"], own=[m for m in own if m != e["marking"]])
                e["reversed"] = _iso()
                undone += 1
            elif e["kind"] == "issue":
                m = dataset_preview._meta(e["item"])
                m["issues"] = [i for i in m["issues"] if i["id"] != e["issue"]]
                dataset_preview._save_meta(e["item"], m)
                e["reversed"] = _iso()
                undone += 1
            else:
                kept += 1
        s.setdefault("adjustments", []).append({"at": _iso(), "kind": "reversed", "actions": req.actions, "undone": undone, "not_reversible": kept})
        _save_scan(s)
    return {"undone": undone, "not_reversible": kept}


@router.delete("/scans/{sid}")
def delete_scan(sid: str) -> dict:
    s = _scan(sid)
    _may_manage(s["include"])
    (DIR / "scans" / f"{sid}.json").unlink(missing_ok=True)
    audit3.emit("SDS_DELETE_SCAN", ["monitorDelete"], {"deletedMonitorResources": [{"type": "sds-scan", "id": sid}]}, product="sensitive-data-scanner")
    return {"deleted": sid}


# ------------------------------------------------------------------------------------------------
# schedules
# ------------------------------------------------------------------------------------------------


def _due(s: dict, now: datetime) -> bool:
    if not s.get("active") or s["schedule"] in ("once", "continuous"):
        return False
    last = datetime.fromisoformat(s["last_run_at"]) if s.get("last_run_at") else datetime.fromisoformat(s["created_at"])
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if s["schedule"] == "daily":
        slot = midnight
    elif s["schedule"] == "weekly":
        slot = midnight - timedelta(days=(midnight.weekday() - 1) % 7)  # Tuesdays
    else:
        slot = midnight.replace(day=1)
    return last < slot <= now


def on_transaction(item_id: str) -> None:
    """Continuous scans: a dataset with new data is scanned (dataset_versions hook)."""
    for s in _scans():
        if s.get("active") and s["schedule"] == "continuous":
            try:
                if any(r["id"] == item_id for r in _resources(s)):
                    threading.Thread(target=run_scan, args=(s["id"],), kwargs={"only": [item_id], "trigger": "continuous"}, daemon=True).start()
            except Exception:  # noqa: BLE001
                log.exception("continuous scan %s", s["id"])


def _loop() -> None:
    while True:
        time.sleep(60)
        now = _now()
        for s in _scans():
            try:
                if _due(s, now):
                    run_scan(s["id"], trigger=s["schedule"])
            except Exception:  # noqa: BLE001
                log.exception("scheduled scan %s", s.get("id"))


def startup() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="sds-schedules", daemon=True).start()
