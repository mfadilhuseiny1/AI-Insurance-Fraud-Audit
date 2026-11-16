"""Debugging Pipeline Builder builds (Palantir's "Optimizing and debugging pipelines"):

* Builds: every build of every pipeline, filtered (status, pipeline, branch, trigger, kind, time range).
* Compare a build with the last successful build of the same pipeline and branch: input versions, logic
  version and hash (with the nodes that changed between the two), parameters, row counts and durations.
* Download a build's (or streaming job's) logs as text.
* Rerun a build — with the same outputs, or an earlier saved version of the logic.
* Explain a failed build with AI (Code Repositories' AIP Assist error mode, given the failing logic).

Mounted by server.py under /api/pipeline.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import auth
import drive
import pipeline_runtime as rt
import pipeline_schedules as ps

router = APIRouter()


def _parse(at: Optional[str]) -> Optional[datetime]:
    if not at:
        return None
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _seconds(b: dict) -> Optional[float]:
    a, z = _parse(b.get("started_at")), _parse(b.get("finished_at"))
    return round((z - a).total_seconds(), 1) if a and z else None


def _slim(b: dict) -> dict:
    """A build for lists: no logs, with counts."""
    outs = [o for j in b.get("jobs") or [] for o in j.get("outputs") or []]
    return {
        **{k: v for k, v in b.items() if k not in ("logs", "output_sigs", "input_versions", "jobs", "schedule_cfg")},
        "jobs_count": len(b.get("jobs") or []),
        "profile": ((b.get("jobs") or [{}])[0]).get("profile"),
        "outputs_built": [{"id": o["id"], "name": o.get("name"), "status": o.get("status"), "rows": o.get("rows")} for o in outs],
        "errors": sum(1 for log in b.get("logs") or [] if log.get("level") == "error"),
        "seconds": _seconds(b),
    }


@router.get("/build-search")
def search_builds(
    status: Optional[str] = None,
    pipeline_id: Optional[str] = None,
    branch: Optional[str] = None,
    trigger: Optional[str] = None,
    kind: Optional[str] = None,
    q: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = 200,
    tests: bool = False,
) -> dict:
    """Builds across pipelines, newest first. trigger: manual | schedule | retry | restart | rerun (a substring
    of the trigger); kind: batch | streaming; q: in the pipeline name, build id or error. Builds of test pipelines
    (test_space.py) only with tests=true (or when the pipeline is asked for by id); `hidden_tests` counts the rest."""
    import test_space

    rows = rt._builds(pipeline_id, 3000)
    lo, hi = _parse(since), _parse(until)
    out = []
    pipelines: dict[str, str] = {}
    readable: dict[str, bool] = {}
    testy: dict[str, bool] = {}
    hidden_tests = 0
    for b in rows:
        # builds are seen with their pipeline (markings, a role on its Project)
        if b["pipeline_id"] not in readable:
            readable[b["pipeline_id"]] = auth.can_access(b["pipeline_id"])
            testy[b["pipeline_id"]] = test_space.is_test_id(b["pipeline_id"]) or test_space.is_test_name(b.get("pipeline_name"))
        if not readable[b["pipeline_id"]]:
            continue
        if testy[b["pipeline_id"]] and not tests and not pipeline_id:
            hidden_tests += 1
            continue
        pipelines.setdefault(b["pipeline_id"], b.get("pipeline_name") or b["pipeline_id"])
        if status and b["status"] != status:
            continue
        if branch and (b.get("branch") or "main") != branch:
            continue
        if trigger and trigger.lower() not in (b.get("trigger") or "").lower():
            continue
        if kind and (kind == "streaming") != bool(b.get("streaming")):
            continue
        at = _parse(b["created_at"])
        if (lo and at and at < lo) or (hi and at and at > hi):
            continue
        if q and q.lower() not in f"{b.get('pipeline_name')} {b['id']} {b.get('error') or ''}".lower():
            continue
        out.append(_slim(b))
        if len(out) >= max(1, min(limit, 1000)):
            break
    return {"builds": out, "pipelines": [{"id": k, "name": v} for k, v in sorted(pipelines.items(), key=lambda x: x[1].lower())],
            "hidden_tests": hidden_tests}


def _content(b: dict, version_id: Optional[str] = None) -> Optional[dict]:
    try:
        raw = json.loads(drive.read_bytes(drive._item(b["pipeline_id"])))
    except Exception:  # noqa: BLE001
        return None
    return ps.branch_content(raw, b.get("branch") or "main", version_id)


def _node_changes(before: Optional[dict], after: Optional[dict]) -> list[dict]:
    """Nodes and outputs added, removed or changed between two versions of the logic (positions ignored)."""
    if not before or not after:
        return []
    skip = ("x", "y", "color", "folder", "description", "deployed")
    out = []
    for group, key in (("node", "nodes"), ("output", "outputs")):
        b = {n["id"]: n for n in before.get(key) or []}
        a = {n["id"]: n for n in after.get(key) or []}
        clean = lambda n: json.dumps({k: v for k, v in n.items() if k not in skip}, sort_keys=True, default=str)  # noqa: E731
        for i, n in a.items():
            if i not in b:
                out.append({"kind": group, "name": n.get("name") or i, "change": "added"})
            elif clean(n) != clean(b[i]):
                out.append({"kind": group, "name": n.get("name") or i, "change": "changed"})
        for i, n in b.items():
            if i not in a:
                out.append({"kind": group, "name": n.get("name") or i, "change": "removed"})
    for key in ("parameters", "functions", "subgraphs", "buildSettings"):
        if json.dumps(before.get(key), sort_keys=True, default=str) != json.dumps(after.get(key), sort_keys=True, default=str):
            out.append({"kind": "setting", "name": key, "change": "changed"})
    return out


@router.get("/builds/{build_id}/compare")
def compare(build_id: str, with_id: Optional[str] = None) -> dict:
    """The build next to the last successful build of the same pipeline, branch and run setup before it
    (or the build given): what each started from and what each produced."""
    b = rt._check_build(rt._build(build_id))
    if with_id:
        prev = rt._check_build(rt._build(with_id))
    else:
        setup = (b.get("run_setup") or {}).get("id")
        prev = next((x for x in rt._builds(b["pipeline_id"], 500) if x["id"] != b["id"] and x["status"] == "succeeded" and bool(x.get("streaming")) == bool(b.get("streaming"))
                     and (x.get("branch") or "main") == (b.get("branch") or "main") and (x.get("run_setup") or {}).get("id") == setup and x["created_at"] <= b["created_at"]), None)
    if not prev:
        return {"build": _slim(b), "previous": None}
    ids = sorted(set(b.get("input_versions") or {}) | set(prev.get("input_versions") or {}))
    inputs = []
    for i in ids:
        now_v, old_v = (b.get("input_versions") or {}).get(i) or {}, (prev.get("input_versions") or {}).get(i) or {}
        inputs.append({"id": i, "name": now_v.get("name") or old_v.get("name") or i, "kind": now_v.get("kind") or old_v.get("kind"),
                       "version": now_v.get("version"), "previous": old_v.get("version"),
                       "change": "added" if not old_v else "removed" if not now_v else "changed" if now_v.get("version") != old_v.get("version") else "same"})
    outs: dict[str, dict] = {}
    for which, rec in (("now", b), ("previous", prev)):
        for j in rec.get("jobs") or []:
            for o in j.get("outputs") or []:
                e = outs.setdefault(o["id"], {"id": o["id"], "name": o.get("name")})
                e[which] = {"status": o.get("status"), "rows": o.get("rows"), "seconds": o.get("seconds"), "error": o.get("error")}
    for e in outs.values():
        r1, r0 = (e.get("now") or {}).get("rows"), (e.get("previous") or {}).get("rows")
        e["rows_delta"] = r1 - r0 if isinstance(r1, int) and isinstance(r0, int) else None
    lv, plv = b.get("logic_version") or {}, prev.get("logic_version") or {}
    logic_changed = bool(b.get("logic_hash") and prev.get("logic_hash") and b["logic_hash"] != prev["logic_hash"])
    changes = _node_changes(_content(prev, plv.get("id")), _content(b, lv.get("id"))) if logic_changed and lv.get("id") and plv.get("id") else []
    params = sorted(set(b.get("parameters") or {}) | set(prev.get("parameters") or {}))
    return {
        "build": _slim(b),
        "previous": _slim(prev),
        "logic": {"hash": b.get("logic_hash"), "previous_hash": prev.get("logic_hash"), "changed": logic_changed,
                  "version": lv or None, "previous_version": plv or None, "changes": changes},
        "inputs": inputs,
        "outputs": list(outs.values()),
        "parameters": [{"name": k, "value": (b.get("parameters") or {}).get(k), "previous": (prev.get("parameters") or {}).get(k)} for k in params],
        "seconds": {"now": _seconds(b), "previous": _seconds(prev)},
    }


@router.get("/builds/{build_id}/logs.txt", response_class=PlainTextResponse)
def download_logs(build_id: str) -> PlainTextResponse:
    """The build's (or streaming job's) record and logs as a text file."""
    b = rt._check_build(rt._build(build_id))
    lines = [
        f"Build {b['id']} · {b.get('pipeline_name')} ({b['pipeline_id']})",
        f"Branch {b.get('branch') or 'main'} · trigger {b.get('trigger')} · {'streaming job' if b.get('streaming') else 'batch build'}",
        f"Status {b['status']}{' (' + b['failure_type'] + ')' if b.get('failure_type') else ''} · queued {b['created_at']} · started {b.get('started_at') or '-'} · finished {b.get('finished_at') or '-'}",
    ]
    if b.get("logic_version"):
        lines.append(f"Logic version {b['logic_version'].get('id')} saved {b['logic_version'].get('at')} · hash {b.get('logic_hash')}")
    if b.get("parameters"):
        lines.append("Parameters " + ", ".join(f"{k}={v}" for k, v in b["parameters"].items()))
    if b.get("error"):
        lines.append(f"Error: {b['error']}")
    for v in b.get("validation") or []:
        lines.append(f"Validation {v.get('level')}: {v.get('message')}")
    lines.append("")
    lines.append("== Jobs ==")
    for j in b.get("jobs") or []:
        lines.append(f"{j.get('name')} · profile {j.get('profile')} · {j.get('status')} · {j.get('started_at') or '-'} → {j.get('finished_at') or '-'}")
        for o in j.get("outputs") or []:
            lines.append(f"  {o.get('name')} [{o.get('kind')}] {o.get('status')}{' · ' + str(o['rows']) + ' rows' if o.get('rows') is not None else ''}{' · ' + o['path'] if o.get('path') else ''}")
            if o.get("error"):
                lines.append(f"    error: {o['error']}")
            for e in o.get("expectations") or []:
                lines.append(f"    expectation {'ok  ' if e.get('ok') else 'FAIL'} {e.get('message')}{' (warn only)' if e.get('mode') == 'warn' else ''}")
        for log in j.get("logs") or []:
            lines.append(f"  {log.get('at')} {str(log.get('level', '')).upper():5} {log.get('msg')}")
    for p in b.get("preconditions") or []:
        lines.append(f"Pre-condition on {p.get('input')}: {'ok' if p.get('ok') else 'FAIL'} {p.get('message')}")
    lines.append("")
    lines.append("== Logs ==")
    for log in b.get("logs") or []:
        lines.append(f"{log.get('at')} {str(log.get('level', '')).upper():5} {log.get('msg')}")
    name = f"{(b.get('pipeline_name') or 'pipeline').replace(' ', '_')}-{b['id']}.log"
    return PlainTextResponse("\n".join(lines) + "\n", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/builds/{build_id}/versions")
def logic_versions(build_id: str) -> list[dict]:
    """Saved versions of the logic on the build's branch, newest first (to rerun the build with one)."""
    b = rt._check_build(rt._build(build_id))
    try:
        raw = json.loads(drive.read_bytes(drive._item(b["pipeline_id"])))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"the pipeline file could not be read: {e}") from None
    branch = b.get("branch") or "main"
    current = (b.get("logic_version") or {}).get("id")
    vs = [v for v in (raw.get("vc") or {}).get("versions") or [] if v.get("branch") == branch]
    vs.sort(key=lambda v: v.get("at") or "", reverse=True)
    return [{"id": v.get("id"), "at": v.get("at"), "author": v.get("author"), "message": v.get("message"), "used_by_build": v.get("id") == current, "latest": i == 0} for i, v in enumerate(vs)]


class Rerun(BaseModel):
    # an earlier saved version of the logic (vc.versions id); none = the branch's latest
    version_id: Optional[str] = None


@router.post("/builds/{build_id}/rerun")
def rerun(build_id: str, req: Rerun) -> dict:
    """Build the same outputs again (same branch, target, parameters and run setup), optionally with an earlier
    version of the logic."""
    b = rt._build(build_id)
    auth.check_item_id(b.get("pipeline_id"), "editor")
    if b["status"] in ("queued", "running"):
        raise HTTPException(409, "the build is still running")
    rt.check_starter(b["pipeline_id"], b.get("branch") or "main", b.get("outputs") or [], req.version_id)
    label = f"rerun of {b['id'][6:]}" + (f" with logic version {req.version_id}" if req.version_id else "")
    return rt.queue_build(rt.NewBuild(pipeline_id=b["pipeline_id"], branch=b.get("branch") or "main", outputs=b.get("outputs") or [], target=b.get("target") or "single",
                                      trigger=label, schedule_id=None, parameters=b.get("parameters") or {}, run_setup=b.get("run_setup"),
                                      version_id=req.version_id, rerun_of=b["id"]))


PIPELINE_AI_SYSTEM = (
    "You are AIP Assist inside Pipeline Builder, a no-code data pipeline tool. A pipeline is a graph of nodes "
    "(source inputs, transform nodes with ordered steps such as filter, cast, aggregate, join, union, LLM calls) "
    "feeding outputs (datasets, files, object types, streams), with expectations checked before writing. "
    "You are given the failing build's errors and logs and the JSON of the nodes and outputs involved. Explain "
    "the cause in plain words, point to the node and step to fix, and say exactly what to change in the board "
    "(field values, step order, types). Answer in concise Markdown."
)


@router.post("/builds/{build_id}/explain")
def explain(build_id: str) -> dict:
    """Explain why a build failed (AIP Assist's error mode, with the logic of the failing outputs)."""
    import code_repos

    b = rt._check_build(rt._build(build_id))
    failing = [o for j in b.get("jobs") or [] for o in j.get("outputs") or [] if o.get("status") == "failed" or o.get("error")]
    errors = [f"Build error: {b['error']}"] if b.get("error") else []
    errors += [f"Validation: {v.get('message')}" for v in b.get("validation") or []]
    errors += [f'Output "{o.get("name")}": {o.get("error")}' for o in failing if o.get("error")]
    errors += [f"Pre-condition on {p.get('input')}: {p.get('message')}" for p in b.get("preconditions") or [] if not p.get("ok")]
    errors += [f"{log.get('level')}: {log.get('msg')}" for log in (b.get("logs") or [])[-40:] if log.get("level") in ("error", "warn")]
    if not errors:
        raise HTTPException(400, "the build has no error to explain")
    content = _content(b, (b.get("logic_version") or {}).get("id")) or {}
    outs = [o for o in content.get("outputs") or [] if not failing or o["id"] in {f["id"] for f in failing}]
    nodes = content.get("nodes") or []
    ids: set[str] = set()
    for o in outs:
        ids |= ps._ancestors(nodes, o.get("node") or "") | {ps._ref_node(o.get("node") or "")}
    skip = ("x", "y", "color", "folder")
    logic = {
        "nodes": [{k: v for k, v in n.items() if k not in skip} for n in nodes if n["id"] in ids],
        "outputs": [{k: v for k, v in o.items() if k not in ("x", "y", "deployed")} for o in outs],
        "inputs": {k: {"name": d.get("name"), "columns": d.get("columns"), "ref": (d.get("ref") or {}).get("kind")} for k, d in (content.get("datasets") or {}).items()},
        "parameters": content.get("parameters"),
    }
    text = json.dumps(logic, ensure_ascii=False, default=str)[:50000]
    req = code_repos.AiIn(mode="error", code=text, path=f"{b.get('pipeline_name')}.pipeline", error="\n".join(errors)[:19000])
    return {"answer": code_repos.assist(req, system=PIPELINE_AI_SYSTEM, lang="json")}
