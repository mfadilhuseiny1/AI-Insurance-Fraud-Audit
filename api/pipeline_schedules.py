"""Pipeline Builder schedules (Palantir's "Scheduling" docs: triggers, targets, run history, retries).

A schedule lives in its pipeline file (`schedules`); this module evaluates it every scheduler tick and
keeps what the file cannot: run history, edit history, trigger latches, failure counts and pauses
(SQLite next to the builds, in data/pipeline/runtime.sqlite).

Triggers form a tree of AND / OR conditions over events:
  time      a cron expression in a time zone
  data      an input of the pipeline was updated (all inputs, or the chosen ones)
  logic     the pipeline's logic changed (and stayed unchanged for 2 minutes)
  job       a build of a pipeline succeeded (optionally: one that built a given output)
  schedule  another schedule ran (its builds finished, optionally only when they succeeded)
An event latches its condition until the schedule runs; AND needs every child latched, OR any. Older
schedules (cron / onDataUpdate / onLogicUpdate + combine) are read as such a tree.

When a schedule fires it is *ignored* while paused or while its previous run is still in progress
(unless overlapping runs are allowed). Otherwise it builds its outputs (the target expanded, minus the
excluded outputs) once per run setup (parameter values; parallel setups build side by side), leaving out
outputs that are already up to date — no input version or logic change since their last successful
build — unless Force build is on; a run where every output is up to date is *skipped*. Failed builds are
retried (count + delay); after N failed runs in a row the schedule pauses until resumed.

Mounted under /api/pipeline by pipeline_runtime.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import db
import auth
import drive
import pipeline_datasets as pdata
import pipeline_runtime as rt
import run_as as acting

log = logging.getLogger("bluesandai.pipeline_schedules")
router = APIRouter()

# how long a logic change must stay unchanged before "logic updated" fires (edits are autosaved)
LOGIC_SETTLE = timedelta(minutes=2)


def configure() -> None:
    with rt._db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, schedule_id TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS schedule_runs_by ON schedule_runs (pipeline_id, schedule_id, at);
            CREATE TABLE IF NOT EXISTS schedule_versions (pipeline_id TEXT NOT NULL, schedule_id TEXT NOT NULL, at TEXT NOT NULL, hash TEXT NOT NULL, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS schedule_versions_by ON schedule_versions (pipeline_id, schedule_id, at);
            """
        )


# ------------------------------------------------------------------------------------------------
# pipeline graph helpers (the same rules as web/src/lib/deploy.ts selectOutputs)
# ------------------------------------------------------------------------------------------------


def branch_content(content: dict, branch: str = "main", version_id: Optional[str] = None) -> dict:
    """What a build on the branch reads: its last saved version (or a chosen one), else its working copy."""
    vc = content.get("vc") or {}
    b = branch or "main"
    versions = [v for v in vc.get("versions") or [] if v.get("branch") == b]
    if version_id:
        versions = [v for v in vc.get("versions") or [] if v.get("id") == version_id]
    saved = max(versions, key=lambda v: v.get("at") or "")["content"] if versions else None
    working = None if b == "main" else ((vc.get("branches") or {}).get(b) or {}).get("content")
    logic = saved or working
    if not logic:
        return content
    return {**content, **logic, "datasets": content.get("datasets"), "vc": content.get("vc")}


def _ref_node(ref: str) -> str:
    return ref[: -len("#false")] if ref.endswith("#false") else ref


def _inputs_of(n: dict) -> list[str]:
    kind = n.get("kind")
    if kind in ("transform", "split", "llm", "model"):
        return [n.get("input") or ""]
    if kind == "join":
        return [n.get("left") or "", n.get("right") or ""]
    if kind in ("union", "subgraph"):
        return list(n.get("inputs") or [])
    return []


def _ancestors(nodes: list[dict], ref: str) -> set[str]:
    by_id = {n["id"]: n for n in nodes}
    out: set[str] = set()
    stack = [_ref_node(ref)]
    while stack:
        n = by_id.get(stack.pop())
        if not n:
            continue
        for i in _inputs_of(n):
            up = _ref_node(i)
            if up and up not in out:
                out.add(up)
                stack.append(up)
    return out


def select_outputs(content: dict, wanted: list[str], target: str) -> list[dict]:
    outs = content.get("outputs") or []
    if not wanted:
        return list(outs)
    nodes = content.get("nodes") or []
    chosen = [o for o in outs if o["id"] in wanted]
    if target == "single":
        return chosen
    node_of = lambda o: _ref_node(o.get("node") or "")  # noqa: E731
    anc = {o["id"]: _ancestors(nodes, node_of(o)) for o in outs}
    result = {o["id"] for o in chosen}
    if target in ("withUpstream", "between"):
        for c in chosen:
            ups = _ancestors(nodes, node_of(c))
            result |= {o["id"] for o in outs if node_of(o) in ups}
    if target in ("downstream", "between"):
        for c in chosen:
            result |= {o["id"] for o in outs if node_of(c) in anc[o["id"]]}
    if target == "between" and len(chosen) >= 2:
        first, last = node_of(chosen[0]), node_of(chosen[-1])
        last_up = _ancestors(nodes, last)
        between = [o for o in outs if first in anc[o["id"]] and node_of(o) in last_up]
        seen: dict[str, dict] = {o["id"]: o for o in chosen}
        for o in between:
            seen.setdefault(o["id"], o)
        return list(seen.values())
    return [o for o in outs if o["id"] in result]


def output_inputs(content: dict, output: dict) -> list[str]:
    """Dataset ids of the inputs an output reads (directly or through other nodes)."""
    nodes = content.get("nodes") or []
    ids = _ancestors(nodes, output.get("node") or "") | {_ref_node(output.get("node") or "")}
    return [n["datasetId"] for n in nodes if n["id"] in ids and n.get("kind") == "source" and n.get("datasetId")]


def _output_logic(content: dict, output: dict) -> str:
    nodes = content.get("nodes") or []
    ids = _ancestors(nodes, output.get("node") or "") | {_ref_node(output.get("node") or "")}
    part = [{k: v for k, v in n.items() if k not in ("x", "y", "color", "folder", "description")} for n in nodes if n["id"] in ids]
    out = {k: v for k, v in output.items() if k not in ("x", "y", "deployed")}
    return hashlib.sha1(json.dumps([part, out, content.get("parameters"), content.get("functions"), content.get("subgraphs")], sort_keys=True, default=str).encode()).hexdigest()


def output_signatures(content: dict, parameters: Optional[dict] = None) -> dict[str, dict]:
    """Per output: the versions of the inputs it reads and a hash of its logic, as of now. An output built
    with the same signature since is up to date."""
    datasets = content.get("datasets") or {}
    versions: dict[str, Optional[str]] = {}
    out = {}
    for o in content.get("outputs") or []:
        inputs = output_inputs(content, o)
        for d in inputs:
            if d not in versions:
                ref = (datasets.get(d) or {}).get("ref")
                # manual data lives in the file: its version is its content
                versions[d] = rt._ref_version(ref) if ref else hashlib.sha1(json.dumps(datasets.get(d), sort_keys=True, default=str).encode()).hexdigest()[:12]
        out[o["id"]] = {
            "inputs": {d: versions[d] for d in inputs},
            "logic": _output_logic(content, o),
            "parameters": parameters or {},
        }
    return out


def _sig_hash(sig: dict) -> str:
    return hashlib.sha1(json.dumps(sig, sort_keys=True, default=str).encode()).hexdigest()


def variant_suffix(branch: str, setup: Optional[dict]) -> str:
    return ("" if not branch or branch == "main" else f"@{branch}") + (f"#{setup['id']}" if setup else "")


def record_built(rec: dict) -> None:
    """After a successful build: its succeeded outputs are up to date with the signature taken when queued."""
    sigs = rec.get("output_sigs") or {}
    suffix = variant_suffix(rec.get("branch") or "main", rec.get("run_setup"))
    for job in rec.get("jobs") or []:
        for o in job.get("outputs") or []:
            if o.get("status") == "succeeded" and o["id"] in sigs:
                rt.set_state(rec["pipeline_id"], f"built:{o['id']}{suffix}", {"sig": _sig_hash(sigs[o["id"]]), "build": rec["id"], "at": rt._now()})


def up_to_date(pid: str, content: dict, output: dict, sigs: dict, suffix: str) -> Optional[str]:
    """Why the output needs no build (its last build), or None when it must be built."""
    built = rt.get_state(pid, f"built:{output['id']}{suffix}")
    if not built or output["id"] not in sigs:
        return None
    if built.get("sig") != _sig_hash(sigs[output["id"]]):
        return None
    return f"up to date: no input or logic change since build {str(built.get('build', ''))[6:]}"


# ------------------------------------------------------------------------------------------------
# warnings: inputs and outputs in the trash
# ------------------------------------------------------------------------------------------------


def trash_warnings(pid: str, content: dict, outputs: Optional[list[dict]] = None) -> list[str]:
    out = []
    datasets = content.get("datasets") or {}
    wanted_inputs: Optional[set[str]] = None
    if outputs is not None:
        wanted_inputs = {d for o in outputs for d in output_inputs(content, o)}
    for did, d in datasets.items():
        if wanted_inputs is not None and did not in wanted_inputs:
            continue
        ref = (d or {}).get("ref") or {}
        item_id = ref.get("itemId") if ref.get("kind") == "drive" else ref.get("folderId") if ref.get("kind") == "media" else None
        if item_id:
            item = db.drive_get(item_id)
            if item and item.get("trashed_at"):
                out.append(f'Input "{d.get("name") or item["name"]}" is in the trash')
            elif not item:
                out.append(f'Input "{d.get("name") or item_id}" was deleted')
    state = rt.read_state(pid)
    for o in outputs if outputs is not None else content.get("outputs") or []:
        for key in (f"output:{o['id']}",):
            item_id = (state.get(key) or {}).get("itemId")
            item = db.drive_get(item_id) if item_id else None
            if item and item.get("trashed_at"):
                out.append(f'Output "{o.get("name")}" is in the trash')
        loc = (o.get("location") or {}).get("id")
        folder = db.drive_get(loc) if loc else None
        if folder and folder.get("trashed_at"):
            out.append(f'The folder of output "{o.get("name")}" is in the trash')
    return out


# ------------------------------------------------------------------------------------------------
# triggers
# ------------------------------------------------------------------------------------------------


def trigger_of(s: dict) -> dict:
    """The schedule's trigger tree; older schedules' flat conditions become one AND / OR group."""
    if s.get("trigger"):
        return s["trigger"]
    items = []
    if s.get("cron"):
        items.append({"id": "cron", "kind": "time", "cron": s["cron"], "timezone": s.get("timezone") or "UTC"})
    if s.get("onDataUpdate"):
        items.append({"id": "data", "kind": "data"})
    if s.get("onLogicUpdate"):
        items.append({"id": "logic", "kind": "logic"})
    return {"id": "root", "kind": "and" if s.get("combine") == "all" else "or", "items": items}


def _leaves(t: dict) -> list[dict]:
    if t.get("kind") in ("and", "or"):
        return [x for i in t.get("items") or [] for x in _leaves(i)]
    return [t]


def describe_trigger(t: dict, outputs_by_pipeline: Optional[dict] = None) -> str:
    kind = t.get("kind")
    if kind in ("and", "or"):
        parts = [describe_trigger(i, outputs_by_pipeline) for i in t.get("items") or []]
        parts = [p for p in parts if p]
        if not parts:
            return ""
        joined = f" {kind.upper()} ".join(parts)
        return f"({joined})" if len(parts) > 1 else joined
    if kind == "time":
        return f"cron {t.get('cron')} ({t.get('timezone') or 'UTC'})"
    if kind == "data":
        return "data updated"
    if kind == "logic":
        return "logic updated"
    if kind == "job":
        return f"job succeeded ({t.get('pipelineName') or t.get('pipelineId')}{' · ' + t['outputName'] if t.get('outputName') else ''})"
    if kind == "schedule":
        return f"schedule ran ({t.get('scheduleName') or t.get('scheduleId')}{', succeeded' if t.get('status', 'succeeded') == 'succeeded' else ''})"
    return kind or ""


def _satisfied(t: dict, latched: dict) -> bool:
    kind = t.get("kind")
    if kind == "and":
        items = t.get("items") or []
        return bool(items) and all(_satisfied(i, latched) for i in items)
    if kind == "or":
        return any(_satisfied(i, latched) for i in t.get("items") or [])
    return t.get("id") in latched


def _latest_build(pipeline_id: str, pred) -> Optional[dict]:
    for b in rt._builds(pipeline_id, 50):
        if b.get("finished_at") and pred(b):
            return b
    return None


def _check_leaf(leaf: dict, pid: str, content: dict, logic: str, book: dict, now: datetime) -> Optional[str]:
    """Whether the leaf's event happened since it was last checked (a reason), updating its bookkeeping."""
    lid = leaf.get("id") or leaf.get("kind")
    mark = book.setdefault("marks", {})
    kind = leaf.get("kind")
    if kind == "time" and leaf.get("cron"):
        try:
            zone = ZoneInfo(leaf.get("timezone") or "UTC")
        except Exception:  # noqa: BLE001
            zone = ZoneInfo("UTC")
        local = now.astimezone(zone).replace(second=0, microsecond=0)
        stamp = local.isoformat()
        if rt.cron_matches(leaf["cron"], local) and mark.get(lid) != stamp:
            mark[lid] = stamp
            return "time"
        return None
    if kind == "data":
        datasets = content.get("datasets") or {}
        chosen = leaf.get("inputs") or []
        refs = [d["ref"] for k, d in datasets.items() if isinstance(d, dict) and d.get("ref") and (not chosen or k in chosen)]
        sig = hashlib.sha1(json.dumps([rt._ref_version(r) for r in refs]).encode()).hexdigest()
        prev = mark.get(lid)
        mark[lid] = sig
        return "data updated" if prev is not None and prev != sig else None
    if kind == "logic":
        st = mark.setdefault(lid, {})
        if st.get("hash") is None:
            st["hash"] = logic
        elif logic != st["hash"]:
            if st.get("pending") != logic:
                st["pending"], st["seen"] = logic, now.isoformat()
            elif now - datetime.fromisoformat(st["seen"]) >= LOGIC_SETTLE:
                st["hash"] = logic
                st.pop("pending", None)
                return "logic updated"
        return None
    if kind == "job" and leaf.get("pipelineId"):
        out_id = leaf.get("outputId")

        def ok(b: dict) -> bool:
            if b["status"] != "succeeded":
                return False
            return not out_id or any(o["id"] == out_id and o.get("status") == "succeeded" for j in b.get("jobs") or [] for o in j.get("outputs") or [])

        b = _latest_build(leaf["pipelineId"], ok)
        at = b["finished_at"] if b else ""
        prev = mark.get(lid)
        mark[lid] = at
        return f"job succeeded ({b['pipeline_name']})" if prev is not None and at and at != prev else None
    if kind == "schedule" and leaf.get("pipelineId") and leaf.get("scheduleId"):
        want = leaf.get("status", "succeeded")
        b = _latest_build(leaf["pipelineId"], lambda b: b.get("schedule_id") == leaf["scheduleId"] and b["status"] in (("succeeded",) if want == "succeeded" else ("succeeded", "failed", "cancelled")))
        at = b["finished_at"] if b else ""
        prev = mark.get(lid)
        mark[lid] = at
        return f"schedule ran ({leaf.get('scheduleName') or leaf['scheduleId']})" if prev is not None and at and at != prev else None
    return None


# ------------------------------------------------------------------------------------------------
# runs
# ------------------------------------------------------------------------------------------------


def _book_key(sid: str) -> str:
    return f"schedule:{sid}"


def _save_run(run: dict) -> dict:
    with rt._lock, rt._db() as con:
        con.execute("INSERT OR REPLACE INTO schedule_runs (id, pipeline_id, schedule_id, at, record) VALUES (?, ?, ?, ?, ?)",
                    (run["id"], run["pipeline_id"], run["schedule_id"], run["at"], json.dumps(run, ensure_ascii=False)))
    return run


def _run(run_id: str) -> Optional[dict]:
    with rt._db() as con:
        row = con.execute("SELECT record FROM schedule_runs WHERE id = ?", (run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _runs(pid: str, sid: str, limit: int = 100) -> list[dict]:
    with rt._db() as con:
        rows = con.execute("SELECT record FROM schedule_runs WHERE pipeline_id = ? AND schedule_id = ? ORDER BY at DESC LIMIT ?", (pid, sid, limit)).fetchall()
    return [json.loads(r[0]) for r in rows]


def _setups(s: dict) -> list[Optional[dict]]:
    """Parallel run setups: one build each, with its parameter values over the schedule's."""
    base = {k: v for k, v in (s.get("parameters") or {}).items() if v not in (None, "")}
    runs = [r for r in s.get("runSetups") or [] if r.get("id")]
    if not runs:
        return [{"id": None, "name": None, "parameters": base}] if base else [None]
    return [{"id": r["id"], "name": r.get("name") or r["id"], "parameters": {**base, **{k: v for k, v in (r.get("parameters") or {}).items() if v not in (None, "")}}} for r in runs]


# ------------------------------------------------------------------------------------------------
# build scope and ownership (doc 08 "Create a schedule" → Build scope; "Schedule permissions")
# ------------------------------------------------------------------------------------------------

SCOPES = ("project", "user")
# what an edit of a schedule compares: not the server-kept owner, nor pausing (a pause does not change what runs)
_NOT_DEFINITION = ("owner", "enabled", "enabledAt")


def scope_of(s: dict) -> str:
    return s.get("scope") if s.get("scope") in SCOPES else "project"


def scope_projects(pid: str, s: dict) -> list[str]:
    """The Projects a Project-scoped schedule may build in: the chosen ones, else the pipeline's own Project."""
    chosen = [p for p in s.get("scopeProjects") or [] if p]
    if chosen:
        return chosen
    own = auth.project_of(pid)
    return [own] if own else []


def _output_folder(content: dict, o: dict) -> Optional[str]:
    """Where the runner writes an output (its location, else the pipeline's; None: the top level)."""
    return ((o.get("location") or content.get("location") or {}) or {}).get("id")


def _project_name(project_id: Optional[str]) -> str:
    if not project_id:
        return "the top level of Files"
    return (db.drive_get(project_id) or {}).get("name") or project_id


def check_manage(pid: str, content: dict, s: dict) -> None:
    """Editing, pausing, running or deleting a schedule: Editor on the pipeline, on the Projects it is scoped to and
    on its targets' Projects (403 otherwise)."""
    auth.check_item_id(pid, "editor")
    if scope_of(s) == "project":
        for proj in scope_projects(pid, s):
            auth.check_project(proj, "editor")
    try:
        outputs = select_outputs(branch_content(content, s.get("branch") or "main"), s.get("outputs") or [], s.get("target") or "single")
    except Exception:  # noqa: BLE001 - a schedule naming outputs that no longer exist
        outputs = []
    for proj in {auth.project_of(_output_folder(content, o)) for o in outputs if _output_folder(content, o)}:
        auth.check_project(proj, "editor")


def _validate_scope(s: dict) -> None:
    if s.get("scope") is not None and s["scope"] not in SCOPES:
        raise HTTPException(400, f"schedule {s.get('name') or s.get('id')}: scope must be project or user")
    for proj in s.get("scopeProjects") or []:
        it = db.drive_get(proj)
        if not it or it.get("kind") != "project" or it.get("trashed_at"):
            raise HTTPException(400, f"schedule {s.get('name') or s.get('id')}: {proj} is not a Project")


def _definition(s: dict) -> dict:
    return {k: v for k, v in s.items() if k not in _NOT_DEFINITION}


def _stamp(v: Any) -> float:
    """When a schedule was last turned on or off (enabledAt, ISO) as a timestamp; 0 when never stamped."""
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0.0
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()


def _check_setter(pid: str, content: dict, s: dict) -> None:
    """Whoever creates, changes or turns on a schedule must be able to build what it builds themselves (read its
    inputs, write its outputs): a Project-scoped schedule otherwise builds, as the system, from inputs its author
    cannot read (403)."""
    rt.check_starter(pid, s.get("branch") or "main", s.get("outputs") or [], raw=content)


def on_save(pid: str, old: dict, new: dict) -> None:
    """Called before a pipeline file is saved: who may add, change or delete its schedules, and their owners. The
    owner is server-kept: the last user to create or change the schedule (what the client sends is ignored)."""
    before = {s["id"]: s for s in old.get("schedules") or [] if s.get("id")}
    after = {s["id"]: s for s in new.get("schedules") or [] if s.get("id")}
    for sid, s in before.items():
        if sid not in after:
            check_manage(pid, old, s)
    for sid, s in after.items():
        prev = before.get(sid)
        if prev and _stamp(s.get("enabledAt")) < _stamp(prev.get("enabledAt")):
            # the schedule was turned on or off after this copy was loaded (Build Schedules, or another editor): a
            # stale autosave does not undo that
            s["enabled"], s["enabledAt"] = prev.get("enabled"), prev["enabledAt"]
        _validate_scope(s)
        if prev and _definition(prev) == _definition(s):
            if prev.get("owner"):
                s["owner"] = prev["owner"]
            else:
                s.pop("owner", None)
            if prev.get("enabled") != s.get("enabled"):
                check_manage(pid, new, s)
                if s.get("enabled"):
                    _check_setter(pid, new, s)
            continue
        check_manage(pid, new, s)
        if s.get("enabled", True):
            _check_setter(pid, new, s)
        s["owner"] = auth.actor_id() or (prev or {}).get("owner")
        if not s["owner"]:
            s.pop("owner", None)


def _schedule_inputs(content: dict, s: dict) -> list[str]:
    """Files items the schedule's builds read: the inputs of its branch's logic and of the stored file."""
    try:
        logic = branch_content(content, s.get("branch") or "main")
    except Exception:  # noqa: BLE001 - an unreadable branch: the stored file's inputs
        logic = content
    return list(dict.fromkeys(pdata.content_input_items(logic) + pdata.content_input_items(content)))


def _markings_block(pid: str, content: dict, s: dict, outputs: list[dict], p: Optional[dict], who: str) -> Optional[str]:
    """Why the schedule cannot start with the owner's markings (None: it holds every marking it needs). A scheduled
    build reads the pipeline and its inputs and writes into its outputs' folders as its owner would: each one's
    markings (own, inherited from inputs, and the folders above) must be held. Inputs are not named — the run
    record is read by everyone who views the pipeline."""
    checks = [(pid, "the pipeline")] + [(iid, "an input of the pipeline") for iid in _schedule_inputs(content, s)]
    checks += [(f, f"the folder of the output {o.get('name') or o['id']}") for o in outputs if (f := _output_folder(content, o))]
    for item_id, what in checks:
        if not auth.effective_markings(item_id):
            continue
        if p is None:
            return f"{what} is marked and the schedule has no owner whose markings it can run with: an Editor holding the markings must save it"
        missing = acting.missing_marking_names(item_id, p)
        if missing:
            return f"the schedule's owner {who} no longer holds the marking{'s' if len(missing) > 1 else ''} {', '.join(missing)} that {what} carries"
    return None


def resolve_scope(pid: str, content: dict, s: dict, outputs: list[dict]) -> tuple[list[dict], list[dict], Optional[str], Optional[str]]:
    """Which outputs this run may build: (outputs, [{id, name, reason}] left out, why it cannot start, who it runs as).
    Project scope builds only outputs written inside the schedule's Projects, whoever edited it last — but markings
    are a user's, never a Project's: it reads and writes only with the markings of its owner (the user who last set
    it up), re-checked every time it fires. User scope builds only what the owner may build, and does not start
    when the owner is deactivated or lost access to the pipeline or an input."""
    if not auth.enabled():
        return outputs, [], None, s.get("owner")
    left_out: list[dict] = []
    owner = s.get("owner")
    who = acting.who(owner) if owner else "its owner"
    if scope_of(s) == "project":
        allowed = set(scope_projects(pid, s))
        keep = []
        for o in outputs:
            proj = auth.project_of(_output_folder(content, o))
            if (proj in allowed) if allowed else proj is None:
                keep.append(o)
            else:
                names = ", ".join(_project_name(p) for p in allowed) or "the top level of Files"
                left_out.append({"id": o["id"], "name": o.get("name"),
                                 "reason": f"written in {_project_name(proj)}, outside the schedule's Projects ({names})"})
        p = auth.principal_of(owner) if owner else None
        blocked = _markings_block(pid, content, s, keep, p, who)
        if blocked and owner and p is None:
            status = (auth.user_label(owner) or {}).get("status", "deleted")
            blocked = f"its data is marked and the schedule's owner {who} is {status}: an Editor holding the markings must take it over (edit and save it)"
        return ([], [], blocked, None) if blocked else (keep, left_out, None, None)
    label = auth.user_label(owner)
    if not owner:
        return [], [], "the schedule has no owner: an Editor must save it (or scope it to Projects)", None
    p = auth.principal_of(owner)
    if p is None:
        return [], [], f"the schedule's owner {who} is {(label or {}).get('status', 'deleted')}: an Editor must take it over (edit and save it) or scope it to Projects", owner
    if not auth.can_access(pid, p) or auth._rank(auth.role_for(auth.project_of(pid), p)) < auth._rank("editor"):
        return [], [], f"the schedule's owner {who} can no longer edit this pipeline (Editor on {_project_name(auth.project_of(pid))})", owner
    for iid in _schedule_inputs(content, s):
        if not auth.can_access(iid, p):
            missing = acting.missing_marking_names(iid, p)
            why = f"it needs the marking{'s' if len(missing) > 1 else ''} {', '.join(missing)}" if missing else "no role that reads its Project's data"
            return [], [], f"the schedule's owner {who} can no longer read an input of the pipeline ({why})", owner
    keep = []
    for o in outputs:
        folder = _output_folder(content, o)
        proj = auth.project_of(folder)
        if folder and not auth.can_access(folder, p):
            left_out.append({"id": o["id"], "name": o.get("name"), "reason": f"{who} cannot access its folder"})
        elif auth._rank(auth.role_for(proj, p)) < auth._rank("editor"):
            left_out.append({"id": o["id"], "name": o.get("name"), "reason": f"{who} is not an Editor of {_project_name(proj)}"})
        else:
            keep.append(o)
    return keep, left_out, None, owner


def fire(pid: str, item: dict, content: dict, s: dict, reasons: list[str], manual: bool = False, force: Optional[bool] = None) -> dict:
    """Runs the schedule now (or records why it did not): one build per run setup."""
    sid = s["id"]
    book = rt.get_state(pid, _book_key(sid), {}) or {}
    branch = s.get("branch") or "main"
    run = {
        "id": "srun-" + uuid.uuid4().hex[:12],
        "pipeline_id": pid,
        "pipeline_name": item["name"].removesuffix(pdata.PIPELINE_EXT),
        "schedule_id": sid,
        "schedule_name": s.get("name"),
        "at": rt._now(),
        "trigger": "run now" if manual else ", ".join(reasons),
        "outcome": "started",
        "reason": None,
        "builds": [],
        "skipped_outputs": [],
        "warnings": [],
    }
    if book.get("paused") and not manual:
        run.update(outcome="ignored", reason=f"paused: {book['paused'].get('reason')}")
        return _save_run(run)
    if not s.get("allowOverlap"):
        running = [b for b in rt._builds(pid, 50) if b.get("schedule_id") == sid and b["status"] in ("queued", "running")]
        if running:
            run.update(outcome="ignored", reason=f"the previous run is still in progress (build {running[0]['id'][6:]}); overlapping runs are not allowed")
            return _save_run(run)
    logic_content = branch_content(content, branch)
    target = s.get("target") or "single"
    excluded = set(s.get("excluded") or [])
    selected = select_outputs(logic_content, s.get("outputs") or [], target)
    outputs = [o for o in selected if o["id"] not in excluded]
    run["excluded_outputs"] = [{"id": o["id"], "name": o.get("name")} for o in selected if o["id"] in excluded]
    run["warnings"] = trash_warnings(pid, logic_content, outputs)
    if not outputs:
        run.update(outcome="skipped", reason="every output it builds is excluded")
        return _save_run(run)
    outputs, out_of_scope, blocked, run_as = resolve_scope(pid, content, s, outputs)
    run["scope"] = {"kind": scope_of(s), "projects": scope_projects(pid, s) if scope_of(s) == "project" else [], "run_as": run_as}
    if scope_of(s) == "project" and auth.enabled():
        # Project roles come from the scope, markings from the user who set the schedule up
        run["scope"]["markings_of"] = s.get("owner")
    run["out_of_scope"] = out_of_scope
    if blocked:
        run.update(outcome="failed", reason=f"did not start: {blocked}")
        return _save_run(run)
    if not outputs:
        run.update(outcome="skipped", reason="no output it builds is within its build scope: " + "; ".join(f"{o.get('name') or o['id']} {o['reason']}" for o in out_of_scope))
        return _save_run(run)
    force = bool(s.get("force")) if force is None else force
    streaming = logic_content.get("type") == "streaming"
    for setup in _setups(s):
        params = (setup or {}).get("parameters") or {}
        suffix = variant_suffix(branch, setup if setup and setup.get("id") else None)
        build_outputs = outputs
        if not force and not streaming:
            sigs = output_signatures(logic_content, params)
            fresh = {o["id"]: up_to_date(pid, logic_content, o, sigs, suffix) for o in outputs}
            for o in outputs:
                if fresh[o["id"]]:
                    run["skipped_outputs"].append({"id": o["id"], "name": o.get("name"), "setup": (setup or {}).get("name"), "reason": fresh[o["id"]]})
            build_outputs = [o for o in outputs if not fresh[o["id"]]]
        if not build_outputs:
            continue
        b = rt.queue_build(rt.NewBuild(
            pipeline_id=pid, branch=branch, outputs=[o["id"] for o in build_outputs], target="single",
            trigger=("schedule run now" if manual else f"schedule ({run['trigger']})") + (f" · {setup['name']}" if setup and setup.get("name") else ""),
            schedule_id=sid, parameters=params, run_setup={"id": setup["id"], "name": setup["name"]} if setup and setup.get("id") else None,
            schedule_run=run["id"], schedule_cfg={"retries": s.get("retries") or {}, "autoPauseAfter": s.get("autoPauseAfter")},
            run_as=run_as, scope=scope_of(s),
            # a Project-scoped build writes only in its Projects, with its owner's markings — checked at every read
            # and write of the build (pipeline_runtime "the identity a build runs as")
            markings_of=s.get("owner") if scope_of(s) == "project" else None,
            scope_projects=scope_projects(pid, s) if scope_of(s) == "project" else [],
        ))
        run["builds"].append(b["id"])
    if not run["builds"]:
        run.update(outcome="skipped", reason="every output is up to date (turn on Force build to build anyway)")
    return _save_run(run)


def on_build_finished(rec: dict) -> None:
    """Retries, failure counts and auto-pause of the schedule a build belongs to; up-to-date marks."""
    if rec["status"] == "succeeded":
        record_built(rec)
    sid = rec.get("schedule_id")
    if not sid or rec["status"] not in ("succeeded", "failed"):
        return
    pid = rec["pipeline_id"]
    cfg = rec.get("schedule_cfg") or {}
    retries = cfg.get("retries") or {}
    attempt = int(rec.get("attempt") or 1)
    retry = rec["status"] == "failed" and not rec.get("cancel") and rec.get("failure_type") != "immediate" and attempt <= int(retries.get("count") or 0)
    if retry and _not_retried(rec, _retry_blocked(rec)):
        retry = False
    if retry:
        delay = max(0.0, float(retries.get("delayMinutes") or 0)) * 60

        def again() -> None:
            try:
                # a retry is the schedule building again: its owner's access is checked again (it may have been
                # taken away during the retry delay)
                if delay and _not_retried(rec, _retry_blocked(rec)):
                    _count_run(rec)
                    return
                b = rt.queue_build(rt.NewBuild(pipeline_id=pid, branch=rec.get("branch") or "main", outputs=rec.get("outputs") or [], target=rec.get("target") or "single",
                                               trigger=f"retry {attempt} of {retries.get('count')} · {rec['trigger']}", schedule_id=sid, parameters=rec.get("parameters") or {},
                                               run_setup=rec.get("run_setup"), schedule_run=rec.get("schedule_run"), schedule_cfg=cfg, attempt=attempt + 1, retry_of=rec["id"],
                                               scope=rec.get("scope"), run_as=rec.get("run_as"), markings_of=rec.get("markings_of"),
                                               scope_projects=rec.get("scope_projects") or []))
                run = _run(rec.get("schedule_run") or "")
                if run:
                    run["builds"].append(b["id"])
                    _save_run(run)
            except Exception:  # noqa: BLE001
                log.exception("retrying build %s failed", rec["id"])

        rec["logs"].append({"at": rt._now(), "level": "warn", "msg": f"Retrying (attempt {attempt + 1} of {int(retries.get('count')) + 1}){f' in {int(delay // 60)} minutes' if delay else ''}"})
        rt._save_build(rec)
        if delay:
            threading.Timer(delay, again).start()
        else:
            again()
        return
    _count_run(rec)


def _not_retried(rec: dict, blocked: Optional[str]) -> bool:
    """Records on the build and its schedule run that a failed build is not retried (blocked: why); False when it may be."""
    if not blocked:
        return False
    cur = rt._build(rec["id"])
    cur["logs"].append({"at": rt._now(), "level": "error", "msg": f"Not retried: {blocked}"})
    rt._save_build(cur)
    rec["logs"] = cur["logs"]
    run = _run(rec.get("schedule_run") or "")
    if run:
        run.update(outcome="failed", reason=f"retry did not start: {blocked}")
        _save_run(run)
    return True


def _count_run(rec: dict) -> None:
    """Failure count and auto-pause of the schedule a finished build belongs to."""
    pid, sid = rec["pipeline_id"], rec["schedule_id"]
    cfg = rec.get("schedule_cfg") or {}
    book = rt.get_state(pid, _book_key(sid), {}) or {}
    if rec["status"] == "succeeded":
        book["failures_in_row"] = 0
    else:
        book["failures_in_row"] = int(book.get("failures_in_row") or 0) + 1
        limit = int(cfg.get("autoPauseAfter") or 0)
        if limit and book["failures_in_row"] >= limit and not book.get("paused"):
            book["paused"] = {"at": rt._now(), "reason": f"{book['failures_in_row']} failed runs in a row", "build": rec["id"]}
            log.warning("schedule %s of %s paused after %s failures", sid, pid, book["failures_in_row"])
    rt.set_state(pid, _book_key(sid), book)


def _retry_blocked(rec: dict) -> Optional[str]:
    """Why a failed scheduled build may not be retried now (its schedule's build scope, as when it fires); None: it may."""
    if not auth.enabled():
        return None
    try:
        item = db.drive_get(rec["pipeline_id"])
        content = json.loads(drive.read_bytes(item)) if item and not item.get("trashed_at") else None
    except Exception:  # noqa: BLE001
        content = None
    s = next((x for x in (content or {}).get("schedules") or [] if x.get("id") == rec.get("schedule_id")), None)
    if not s:
        return "the schedule or its pipeline no longer exists"
    wanted = set(rec.get("outputs") or [])
    outputs = [o for o in branch_content(content, rec.get("branch") or "main").get("outputs") or [] if o.get("id") in wanted]
    keep, left_out, blocked, _ = resolve_scope(rec["pipeline_id"], content, s, outputs)
    if blocked:
        return blocked
    if left_out:
        return "; ".join(f"{o.get('name') or o['id']} {o['reason']}" for o in left_out)
    return None


def _record_version(pid: str, s: dict) -> None:
    body = json.dumps({k: v for k, v in s.items() if k not in ("lastRun",)}, sort_keys=True, default=str)
    h = hashlib.sha1(body.encode()).hexdigest()
    with rt._db() as con:
        row = con.execute("SELECT hash FROM schedule_versions WHERE pipeline_id = ? AND schedule_id = ? ORDER BY at DESC LIMIT 1", (pid, s["id"])).fetchone()
    if row and row[0] == h:
        return
    with rt._lock, rt._db() as con:
        con.execute("INSERT INTO schedule_versions (pipeline_id, schedule_id, at, hash, record) VALUES (?, ?, ?, ?, ?)", (pid, s["id"], rt._now(), h, body))


def _pipeline_items() -> list[dict]:
    return db.drive_query("d.kind = 'file' AND d.trashed_at IS NULL AND lower(d.name) LIKE %s", (f"%{pdata.PIPELINE_EXT}",), limit=1000)


def tick() -> None:
    now = datetime.now(timezone.utc)
    for item in _pipeline_items():
        content = rt._pipeline_content(item)
        if not content or not content.get("schedules"):
            continue
        pid = item["id"]
        for s in content["schedules"]:
            if not s.get("id"):
                continue
            try:
                _record_version(pid, s)
            except Exception:  # noqa: BLE001
                log.exception("recording schedule version failed")
            if not s.get("enabled"):
                continue
            sid = s["id"]
            book = rt.get_state(pid, _book_key(sid), {}) or {}
            tree = trigger_of(s)
            logic = rt._logic_hash(branch_content(content, s.get("branch") or "main"))
            latched = book.setdefault("latched", {})
            for leaf in _leaves(tree):
                why = _check_leaf(leaf, pid, content, logic, book, now)
                if why:
                    latched[leaf.get("id") or leaf.get("kind")] = {"at": now.isoformat(), "reason": why}
            fires = _satisfied(tree, latched)
            reasons = [v["reason"] for v in latched.values()] if fires else []
            if fires:
                book["latched"] = {}
            rt.set_state(pid, _book_key(sid), book)
            if fires:
                try:
                    fire(pid, item, content, s, reasons)
                except Exception:  # noqa: BLE001
                    log.exception("schedule %s of %s failed to start", sid, pid)


# ------------------------------------------------------------------------------------------------
# endpoints
# ------------------------------------------------------------------------------------------------


def _find(pid: str, sid: str) -> tuple[dict, dict, dict]:
    drive._require_db()
    item = pdata._pipeline_item(pid)
    content = json.loads(drive.read_bytes(item))
    s = next((x for x in content.get("schedules") or [] if x.get("id") == sid), None)
    if not s:
        raise HTTPException(404, "schedule not found")
    return item, content, s


def _next_runs(tree: dict) -> list[str]:
    times = []
    for leaf in _leaves(tree):
        if leaf.get("kind") == "time" and leaf.get("cron"):
            try:
                times += rt.next_runs(leaf["cron"], leaf.get("timezone") or "UTC", 3)
            except Exception:  # noqa: BLE001
                pass
    return sorted(times, key=lambda t: datetime.fromisoformat(t))[:3]


def _with_builds(run: dict) -> dict:
    builds = []
    for bid in run.get("builds") or []:
        try:
            b = rt._build(bid)
            builds.append({"id": bid, "status": b["status"], "trigger": b["trigger"], "finished_at": b.get("finished_at"), "error": b.get("error"), "run_setup": b.get("run_setup")})
        except HTTPException:
            builds.append({"id": bid, "status": "deleted"})
    run["build_status"] = builds
    if run["outcome"] == "started" and builds:
        st = [b["status"] for b in builds]
        # retries replace their failed attempt: the run's result is its last build per setup
        last: dict[Any, str] = {}
        for b in builds:
            last[(b.get("run_setup") or {}).get("id")] = b["status"]
        final = list(last.values())
        run["status"] = "running" if any(x in ("queued", "running") for x in st) else "failed" if "failed" in final else "cancelled" if "cancelled" in final else "succeeded"
    return run


def summary(pid: str, item: dict, content: dict, s: dict) -> dict:
    book = rt.get_state(pid, _book_key(s["id"]), {}) or {}
    tree = trigger_of(s)
    runs = _runs(pid, s["id"], 1)
    try:
        warnings = trash_warnings(pid, branch_content(content, s.get("branch") or "main"), select_outputs(content, s.get("outputs") or [], s.get("target") or "single"))
    except Exception:  # noqa: BLE001
        warnings = []
    return {
        "pipeline_id": pid,
        "pipeline_name": item["name"].removesuffix(pdata.PIPELINE_EXT),
        "path": [p["name"] for p in (drive._with_path(item).get("path") or [])],
        "pipeline_type": content.get("type", "batch"),
        "schedule": s,
        "scope": scope_of(s),
        "scope_projects": [{"id": p, "name": _project_name(p)} for p in scope_projects(pid, s)] if scope_of(s) == "project" else [],
        "owner": auth.user_label(s.get("owner")),
        "trigger": describe_trigger(tree),
        "paused": book.get("paused"),
        "failures_in_row": int(book.get("failures_in_row") or 0),
        "latched": book.get("latched") or {},
        "last_run": _with_builds(runs[0]) if runs else None,
        "next_runs": _next_runs(tree) if s.get("enabled") and not book.get("paused") else [],
        "warnings": warnings,
    }


@router.get("/schedules")
def list_schedules(pipeline_id: Optional[str] = None) -> list[dict]:
    """Every schedule of every pipeline (or of one), with its state, last run, next runs and warnings."""
    drive._require_db()
    out = []
    for item in _pipeline_items():
        if pipeline_id and item["id"] != pipeline_id:
            continue
        if not auth.can_access(item["id"]):
            continue
        content = rt._pipeline_content(item) or {}
        for s in content.get("schedules") or []:
            if s.get("id"):
                out.append(summary(item["id"], item, content, s))
    return out


@router.get("/schedules-report")
def schedules_report() -> dict:
    """Usage hygiene: schedules that build the same outputs of the same pipeline and branch (duplicates when their
    triggers match too), and time schedules that fire within five minutes of each other on the same outputs."""
    found: list[dict] = []
    enabled = [x for x in list_schedules() if x["schedule"].get("enabled") and not x.get("paused")]
    for i, a in enumerate(enabled):
        for b in enabled[i + 1:]:
            if a["pipeline_id"] != b["pipeline_id"] or (a["schedule"].get("branch") or "main") != (b["schedule"].get("branch") or "main"):
                continue
            oa, ob = set(a["schedule"].get("outputs") or []), set(b["schedule"].get("outputs") or [])
            shared = "all outputs" if not oa or not ob else ", ".join(sorted(oa & ob))
            if oa and ob and not (oa & ob):
                continue
            pair = {"pipeline_id": a["pipeline_id"], "pipeline_name": a["pipeline_name"],
                    "schedules": [{"id": x["schedule"]["id"], "name": x["schedule"].get("name") or x["schedule"]["id"], "trigger": x["trigger"]} for x in (a, b)],
                    "outputs": shared}
            if a["trigger"] == b["trigger"]:
                found.append({**pair, "kind": "duplicate", "message": "Same trigger and outputs: every run is built twice. Remove one."})
                continue
            close = [(x, y) for x in a["next_runs"] for y in b["next_runs"]
                     if abs((datetime.fromisoformat(x) - datetime.fromisoformat(y)).total_seconds()) <= 300]
            if close:
                found.append({**pair, "kind": "overlapping", "message": f"Both fire around {close[0][0][:16].replace('T', ' ')}: the later run finds the outputs up to date or waits. Merge them or shift one."})
            else:
                found.append({**pair, "kind": "shared_outputs", "message": "Two schedules build the same outputs: check both are needed."})
    return {"schedules": len(enabled), "findings": found}


class RunNow(BaseModel):
    force: Optional[bool] = None


@router.post("/schedules/{pipeline_id}/{schedule_id}/run")
def run_now(pipeline_id: str, schedule_id: str, req: RunNow) -> dict:
    """Run the schedule now with its own configuration (targets, exclusions, run setups, force build). Schedules
    are run, paused, changed and deleted by Editors of the pipeline's Project."""
    item, content, s = _find(pipeline_id, schedule_id)
    check_manage(pipeline_id, content, s)
    # started by a user: they must be able to build it themselves (read its inputs, write its outputs)
    rt.check_starter(pipeline_id, s.get("branch") or "main", s.get("outputs") or [])
    return _with_builds(fire(pipeline_id, item, content, s, [], manual=True, force=req.force))


@router.post("/schedules/{pipeline_id}/{schedule_id}/resume")
def resume(pipeline_id: str, schedule_id: str) -> dict:
    _, content, s = _find(pipeline_id, schedule_id)
    check_manage(pipeline_id, content, s)
    book = rt.get_state(pipeline_id, _book_key(schedule_id), {}) or {}
    book.pop("paused", None)
    book["failures_in_row"] = 0
    rt.set_state(pipeline_id, _book_key(schedule_id), book)
    item, content, s = _find(pipeline_id, schedule_id)
    return summary(pipeline_id, item, content, s)


class SchedulePatch(BaseModel):
    enabled: Optional[bool] = None


def _write(item: dict, content: dict) -> None:
    pdata._replace_content(item, json.dumps(content).encode(), pdata.PIPELINE)


@router.patch("/schedules/{pipeline_id}/{schedule_id}")
def patch_schedule(pipeline_id: str, schedule_id: str, req: SchedulePatch) -> dict:
    """Turn a schedule on or off from outside the pipeline editor (Build Schedules)."""
    item, content, s = _find(pipeline_id, schedule_id)
    check_manage(pipeline_id, content, s)
    if req.enabled:
        _check_setter(pipeline_id, content, s)
    if req.enabled is not None:
        s["enabled"] = req.enabled
        s["enabledAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    _write(item, content)
    return summary(pipeline_id, drive._item(pipeline_id), content, s)


@router.delete("/schedules/{pipeline_id}/{schedule_id}")
def delete_schedule(pipeline_id: str, schedule_id: str) -> dict:
    item, content, s = _find(pipeline_id, schedule_id)
    check_manage(pipeline_id, content, s)
    content["schedules"] = [x for x in content.get("schedules") or [] if x.get("id") != schedule_id]
    _write(item, content)
    return {"deleted": schedule_id}


@router.get("/schedules/{pipeline_id}/{schedule_id}/runs")
def schedule_runs(pipeline_id: str, schedule_id: str, limit: int = 100) -> list[dict]:
    """Run history: started runs with their builds, and runs that were skipped or ignored, with the reason."""
    pdata._pipeline_item(pipeline_id)  # seen with the pipeline (markings, a role on its Project)
    return [_with_builds(r) for r in _runs(pipeline_id, schedule_id, max(1, min(limit, 500)))]


@router.get("/schedules/{pipeline_id}/{schedule_id}/versions")
def schedule_versions(pipeline_id: str, schedule_id: str) -> list[dict]:
    """Edit history: every saved definition of the schedule, newest first, with the fields that changed."""
    pdata._pipeline_item(pipeline_id)  # seen with the pipeline (markings, a role on its Project)
    with rt._db() as con:
        rows = con.execute("SELECT at, record FROM schedule_versions WHERE pipeline_id = ? AND schedule_id = ? ORDER BY at", (pipeline_id, schedule_id)).fetchall()
    out = []
    prev: dict = {}
    for at, body in rows:
        cur = json.loads(body)
        changed = sorted(k for k in set(cur) | set(prev) if cur.get(k) != prev.get(k)) if prev else []
        out.append({"at": at, "schedule": cur, "changed": changed, "trigger": describe_trigger(trigger_of(cur))})
        prev = cur
    return list(reversed(out))


def _input_node_id(pid: str, did: str, d: dict) -> str:
    """The Data Lineage node id of a pipeline input (as lineage.build_graph names it)."""
    ref = d.get("ref") or {}
    kind = ref.get("kind")
    if kind == "drive" and ref.get("itemId"):
        return f"dataset:{ref['itemId']}"
    if kind == "datasource" and ref.get("id"):
        return f"datasource:{ref['id']}"
    if kind == "virtual":
        return f"virtual:{ref.get('connectionId')}:{ref.get('database')}.{ref.get('schema')}.{ref.get('table')}"
    if kind == "stream":
        return f"stream:{ref.get('streamId')}"
    return f"manual:{pid}:{d.get('id') or did}"


@router.get("/schedules/{pipeline_id}/{schedule_id}/resolve")
def resolve(pipeline_id: str, schedule_id: str) -> dict:
    """The schedule resolved on the lineage graph: the inputs it reads, the outputs it builds (intermediates
    feed another output it builds; targets do not), the outputs it excludes, and the pipeline (job)."""
    item, content, s = _find(pipeline_id, schedule_id)
    logic = branch_content(content, s.get("branch") or "main")
    selected = select_outputs(logic, s.get("outputs") or [], s.get("target") or "single")
    excluded_ids = set(s.get("excluded") or [])
    built = [o for o in selected if o["id"] not in excluded_ids]
    state = rt.read_state(pipeline_id)
    nodes = logic.get("nodes") or []

    def dataset_node(o: dict) -> Optional[str]:
        item_id = (state.get(f"output:{o['id']}") or {}).get("itemId") or (o.get("deployed") or {}).get("itemId")
        return f"dataset:{item_id}" if item_id else None

    roles: dict[str, str] = {f"pipeline:{pipeline_id}": "job"}
    datasets = logic.get("datasets") or {}
    for d_id in {d for o in built for d in output_inputs(logic, o)}:
        if d_id in datasets:
            roles[_input_node_id(pipeline_id, d_id, datasets[d_id])] = "input"
    unbuilt = []
    for o in built:
        nid = dataset_node(o)
        if not nid:
            unbuilt.append(o.get("name"))
            continue
        node = _ref_node(o.get("node") or "")
        feeds = any(node in _ancestors(nodes, x.get("node") or "") for x in built if x is not o)
        roles[nid] = "intermediate" if feeds else "output"
    for o in selected:
        if o["id"] in excluded_ids and dataset_node(o):
            roles[dataset_node(o)] = "excluded"
    return {"pipeline_id": pipeline_id, "schedule": s, "roles": roles, "never_built": unbuilt}
