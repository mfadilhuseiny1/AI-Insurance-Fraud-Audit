"""Linter (palantir.com/docs/foundry/linter): sweeps the platform's state for anti-patterns and recommends fixes.

- Rules run against resource metadata: Pipeline Builder schedules and builds, Code Repositories (settings, pull
  requests, transforms' code and builds), datasets (transactions, files, sizes) and Data Lineage. Each rule belongs to
  a mode: Resource Savings (with an estimate of the compute it would save, from what ran in the last 30 days) or
  Pipeline Resilience. Rules about applications this platform does not have (Code Workbook, Contour projections) or
  schedule settings it does not have are listed as not applicable, with the reason.
- Sweep schedules (the Linter configuration): a resource scope (all Projects, or chosen ones; there are no spaces
  here) and a rule scope (presets, then rules added, then rules excluded), run every N hours (a background tick) or
  on demand. Each sweep is recorded (status, queue / start / end times, error, counts); the last 10 are shown.
- Recommendations: one per rule and resource, visible to those who can see the resource. States: default, snoozed
  (reason, until), snooze expired; an assignee. Selecting one the first time makes it Under investigation and
  snapshots it; open recommendations that a later sweep no longer finds disappear, investigated ones become resolved.
- Impact tracking: resolved recommendations, their estimated monthly impact, and the verified impact (compute in the
  week before the fix minus the week after, normalized to 30 days) once a week has passed.
- Fix proposals: for some rules the fix is a setting Linter can apply when a user accepts it (protect the default
  branch, allow squash merges, merge upgrade pull requests automatically, turn retries on, name a schedule).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import db

log = logging.getLogger("bluesandai.linter")
router = APIRouter(prefix="/api/linter")
DB_PATH: Optional[Path] = None
_lock = threading.RLock()
RATE = 0.5  # compute-seconds per vCPU-second (resource_usage.rate(1, 1))


def configure(data_dir: Path) -> None:
    global DB_PATH
    d = data_dir / "linter"
    d.mkdir(parents=True, exist_ok=True)
    DB_PATH = d / "linter.sqlite"
    with _db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS recommendations (id TEXT PRIMARY KEY, rule TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sweep_schedules (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sweeps (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, queued_at TEXT NOT NULL, record TEXT NOT NULL);
            """
        )
        if not con.execute("SELECT 1 FROM sweep_schedules LIMIT 1").fetchone():
            s = {"id": "sweep-default", "name": "Default sweep", "description": "Every rule over every Project.", "projects": [], "presets": ["ALL_RULES"],
                 "rules": [], "exclude": [], "interval_hours": 24, "paused": False, "created_at": _iso(), "created_by": "system"}
            con.execute("INSERT INTO sweep_schedules (id, record) VALUES (?, ?)", (s["id"], json.dumps(s)))


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    if DB_PATH is None:
        raise HTTPException(503, "Linter is not configured")
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _parse(at: Any) -> Optional[datetime]:
    if not at:
        return None
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


# ------------------------------------------------------------------------------------------------
# what a sweep looks at
# ------------------------------------------------------------------------------------------------


class Ctx:
    """The platform's state, gathered once per sweep (lazily, per kind of resource)."""

    def __init__(self, projects: list[str]) -> None:
        self.scope = set(projects)
        self._cache: dict[str, Any] = {}

    def get(self, key: str, fn: Callable[[], Any]) -> Any:
        if key not in self._cache:
            try:
                self._cache[key] = fn()
            except Exception as e:  # noqa: BLE001 - one missing store does not stop the sweep
                log.warning("linter: gathering %s failed: %s", key, e)
                self._cache[key] = None
        return self._cache[key]

    def in_scope(self, projects: list[dict]) -> bool:
        return not self.scope or any(p["id"] in self.scope for p in projects)

    # -- gatherers --
    def schedules(self) -> list[dict]:
        import pipeline_schedules as ps

        return self.get("schedules", ps.list_schedules) or []

    def pipeline_contents(self) -> dict[str, dict]:
        def load() -> dict:
            import pipeline_runtime as rt
            import pipeline_schedules as ps

            return {it["id"]: rt._pipeline_content(it) or {} for it in ps._pipeline_items()}

        return self.get("pipeline_contents", load) or {}

    def pipeline_builds(self) -> list[dict]:
        def load() -> list:
            import pipeline_runtime as rt

            since = _iso(_now() - timedelta(days=31))
            return [b for b in rt._builds(limit=20000) if (b.get("created_at") or "") >= since]

        return self.get("pipeline_builds", load) or []

    def usage(self) -> dict:
        def load() -> dict:
            import resource_usage

            return {p["id"]: p for p in resource_usage.usage(30).get("pipelines") or []}

        return self.get("usage", load) or {}

    def repos(self) -> list[dict]:
        def load() -> list:
            import code_repos

            return code_repos.all_repos()

        return self.get("repos", load) or []

    def lineage(self):
        def load():
            import lineage

            return lineage.build_graph()

        return self.get("lineage", load)


def project_of(item_id: Optional[str]) -> list[dict]:
    if not item_id:
        return []
    try:
        path = db.drive_path(item_id)
    except Exception:  # noqa: BLE001
        return []
    return [{"id": path[0]["id"], "name": path[0]["name"]}] if path else []


def _repo_projects(rec: dict) -> list[dict]:
    """A code repository's Projects: those of the datasets its builds wrote (else its default output folder's)."""
    import code_repos

    seen: dict[str, dict] = {}
    for b in code_repos._builds(rec["id"])[:50]:
        for o in [b.get("output") or {}, *(b.get("outputs") or [])]:
            for p in project_of(o.get("item_id")):
                seen[p["id"]] = p
    return list(seen.values())


def _repo_files(rec: dict) -> dict[str, str]:
    import code_repos

    try:
        return code_repos._branch(rec, rec.get("default_branch"))["files"]
    except HTTPException:
        return {}


def _hours(cs: float) -> float:
    return round(cs / 3600, 1)


# ------------------------------------------------------------------------------------------------
# rules
# ------------------------------------------------------------------------------------------------

SAVINGS, RESILIENCE = "resource_savings", "pipeline_resilience"
RULES: dict[str, dict] = {}


def rule(rid: str, name: str, mode: str, resource: str, logic: str, why: str, recommendation: str, presets: tuple = (), savings: str = "",
         fix: Optional[str] = None, na: Optional[str] = None):
    def wrap(fn: Optional[Callable] = None):
        RULES[rid] = {"id": rid, "name": name, "mode": mode, "resource": resource, "logic": logic, "why": why, "recommendation": recommendation,
                      "presets": ["ALL_RULES", *presets], "savings": savings, "fix": fix, "applicable": na is None, "not_applicable": na, "check": fn}
        return fn

    return wrap


def finding(resource: dict, projects: list[dict], detail: str, evidence: Optional[list[str]] = None, impact_cs: float = 0.0, key: str = "") -> dict:
    return {"resource": resource, "projects": projects, "detail": detail, "evidence": evidence or [], "impact_cs": impact_cs, "key": key}


def _sched_resource(x: dict) -> dict:
    s = x["schedule"]
    return {"type": "schedule", "id": f"{x['pipeline_id']}/{s['id']}", "name": s.get("name") or f"Unnamed schedule ({s['id']})",
            "subtitle": x["pipeline_name"], "href": f"/pipeline/{x['pipeline_id']}?panel=schedules", "pipeline_id": x["pipeline_id"], "schedule_id": s["id"]}


def _schedules(ctx: Ctx) -> list[tuple[dict, list[dict]]]:
    out = []
    for x in ctx.schedules():
        projects = project_of(x["pipeline_id"])
        if ctx.in_scope(projects):
            out.append((x, projects))
    return out


def _pipeline_cs(ctx: Ctx, pipeline_id: str) -> float:
    return float((ctx.usage().get(pipeline_id) or {}).get("compute_seconds") or 0)


@rule("schedule_always_fails", "Schedule always fails", SAVINGS, "schedule",
      "The schedule has not succeeded in the past 30 days. The datasets that failed to build in that time are listed.",
      "In each run, the schedule tries to rebuild a dataset that never succeeded in the last 30 days, indicating a waste of resources.",
      "Pause the schedule, apply fixes to the failing dataset(s), or remove the failing dataset(s) from the schedule.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "Sum of the compute of the schedule's failed builds over the last 30 days.")
def _always_fails(ctx: Ctx) -> list[dict]:
    out = []
    builds = ctx.pipeline_builds()
    for x, projects in _schedules(ctx):
        sid = x["schedule"]["id"]
        mine = [b for b in builds if b.get("schedule_id") == sid and b["pipeline_id"] == x["pipeline_id"] and b["status"] in ("succeeded", "failed")]
        if mine and not any(b["status"] == "succeeded" for b in mine):
            import resource_usage

            cs = sum(resource_usage.batch_usage(b, _now())[1] for b in mine)
            failed = sorted({o.get("name") for b in mine for j in b.get("jobs") or [] for o in j.get("outputs") or [] if o.get("status") == "failed" and o.get("name")})
            out.append(finding(_sched_resource(x), projects, f"{len(mine)} runs in 30 days, none succeeded", [f"failed: {', '.join(failed) or 'see the builds'}"], cs))
    return out


@rule("schedule_builds_trashed_dataset", "Schedule builds trashed dataset", RESILIENCE, "schedule",
      "The dataset is in the trash.", "Even though a dataset is placed into the trash, the schedule is attempting to build it.",
      "Investigate why the dataset is still in the schedule and either remove it from the trash or update the schedule.", ("SCHEDULE_RULES",))
def _trashed(ctx: Ctx) -> list[dict]:
    return [finding(_sched_resource(x), p, x["warnings"][0], x["warnings"]) for x, p in _schedules(ctx) if x.get("warnings")]


@rule("schedule_no_built_datasets", "Schedule has no built datasets", RESILIENCE, "schedule",
      "The schedule does not build any datasets.", "The schedule is potentially a waste of resources and generating noise for monitoring.",
      "Investigate whether the schedule is useful, and decide whether to delete or remove it from the monitoring scope.", ("SCHEDULE_RULES",))
def _no_outputs(ctx: Ctx) -> list[dict]:
    import pipeline_schedules as ps

    out = []
    contents = ctx.pipeline_contents()
    for x, projects in _schedules(ctx):
        s = x["schedule"]
        content = contents.get(x["pipeline_id"]) or {}
        try:
            built = ps.select_outputs(ps.branch_content(content, s.get("branch") or "main"), s.get("outputs") or [], s.get("target") or "single")
        except Exception:  # noqa: BLE001
            continue
        excluded = set(s.get("excluded") or [])
        if not [o for o in built if o.get("id") not in excluded]:
            out.append(finding(_sched_resource(x), projects, "no output to build (every output is excluded, or the pipeline has none)"))
    return out


@rule("schedule_missing_name", "Schedule missing name", RESILIENCE, "schedule", "The schedule does not have a name.", "",
      "Generate a name based on the dataset names and paths in the build. This can be automatically generated.", ("SCHEDULE_RULES",), fix="name_schedule")
def _no_name(ctx: Ctx) -> list[dict]:
    return [finding(_sched_resource(x), p, "unnamed") for x, p in _schedules(ctx) if not (x["schedule"].get("name") or "").strip()]


@rule("schedule_on_branch", "Schedule on branch", SAVINGS, "schedule", "A schedule is running on a branch that is not master (main in Pipeline Builder).",
      "The master branch is the canonical version of data. Schedules set up on branches often keep running longer than needed.",
      "Understand if the schedule on the branch is needed, and consider pausing or deleting it, or reducing its trigger frequency.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "The pipeline's compute over the last month, in the ratio of its builds on this branch to all its builds.")
def _on_branch(ctx: Ctx) -> list[dict]:
    out = []
    builds = ctx.pipeline_builds()
    for x, projects in _schedules(ctx):
        br = x["schedule"].get("branch") or "main"
        if br not in ("main", "master") and x["schedule"].get("enabled"):
            mine = [b for b in builds if b["pipeline_id"] == x["pipeline_id"]]
            on = [b for b in mine if (b.get("branch") or "main") == br]
            cs = _pipeline_cs(ctx, x["pipeline_id"]) * (len(on) / len(mine) if mine else 0)
            out.append(finding(_sched_resource(x), projects, f"runs on branch {br}", [f"{len(on)} of {len(mine)} builds in 30 days on {br}"], cs))
    return out


@rule("schedule_retries_disabled", "Schedule retries disabled", RESILIENCE, "schedule", "The schedule does not have retries enabled.",
      "Certain failures, such as ones caused by environment setup issues, usually do not appear in the second run.",
      "Enable retries. We recommend setting three retry attempts.", ("SCHEDULE_RULES", "PIPELINE_RESILIENCE_RULES"), fix="enable_retries")
def _no_retries(ctx: Ctx) -> list[dict]:
    return [finding(_sched_resource(x), p, "no retries") for x, p in _schedules(ctx) if x["schedule"].get("enabled") and not int((x["schedule"].get("retries") or {}).get("count") or 0)]


@rule("schedule_triggers_too_often", "Schedule triggers too often", SAVINGS, "schedule", "Schedule has multiple trigger conditions (OR).",
      "A schedule with two inputs that each update once an hour can run twice an hour.",
      "Consider changing the schedule to use AND triggers rather than OR, or switching to a time-based trigger.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "Half of the pipeline's compute over the last month (one run instead of two).")
def _too_often(ctx: Ctx) -> list[dict]:
    import pipeline_schedules as ps

    out = []
    for x, projects in _schedules(ctx):
        t = ps.trigger_of(x["schedule"])
        events = [leaf for leaf in ps._leaves(t) if leaf.get("type") in ("data", "logic", "job", "schedule")]
        if (t.get("op") or t.get("type")) in ("or", "OR") and len(events) > 1:
            out.append(finding(_sched_resource(x), projects, f"{len(events)} event triggers combined with OR: {x['trigger']}", [], _pipeline_cs(ctx, x["pipeline_id"]) / 2))
    return out


@rule("schedule_unnecessary_force_builds", "Schedule unnecessary force builds", SAVINGS, "schedule",
      "The schedule is using the force build setting even though it is not a Data Connection ingest schedule.",
      "Force build runs a transform regardless of whether its inputs changed, repeatedly producing the same result.",
      "Check for untracked external dependencies (API calls) that need it. If there are none, remove the setting.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "The pipeline's compute over the last month times the share of its builds whose inputs had not changed (estimated at 50%).")
def _force(ctx: Ctx) -> list[dict]:
    return [finding(_sched_resource(x), p, "Force build is on", [], _pipeline_cs(ctx, x["pipeline_id"]) / 2) for x, p in _schedules(ctx) if x["schedule"].get("force")]


@rule("user_scoped_schedule", "User-scoped schedule", RESILIENCE, "schedule", "The schedule is not project-scoped.", "",
      "Modify the schedule to run on scoped token mode; by default, the scope is the Projects of the built datasets.", ("SCHEDULE_RULES",))
def _user_scoped(ctx: Ctx) -> list[dict]:
    return [finding(_sched_resource(x), p, f"runs as {x.get('owner') or 'its owner'}") for x, p in _schedules(ctx) if x.get("scope") == "user"]


@rule("overlapping_schedules", "Overlapping schedules", SAVINGS, "schedule", "The schedule builds a dataset that is also built by another schedule.",
      "The same dataset is built by two different schedules, potentially causing compute waste, queueing, and unreliable latency.",
      "Change the build action of the schedule(s) to eliminate overlap.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "Half of the pipeline's compute over the last month.")
def _overlap(ctx: Ctx) -> list[dict]:
    import pipeline_schedules as ps

    out = []
    by_id = {(x["pipeline_id"], x["schedule"]["id"]): x for x in ctx.schedules()}
    for f in (ctx.get("schedules_report", ps.schedules_report) or {}).get("findings") or []:
        a = by_id.get((f["pipeline_id"], f["schedules"][0]["id"]))
        if not a:
            continue
        projects = project_of(f["pipeline_id"])
        if ctx.in_scope(projects):
            out.append(finding(_sched_resource(a), projects, f"{f['message']} (with {f['schedules'][1]['name']})", [f"outputs: {f['outputs']}"],
                               _pipeline_cs(ctx, f["pipeline_id"]) / 2, key=f["schedules"][1]["id"]))
    return out


@rule("schedule_trigger_not_input", "Schedule trigger is not input", RESILIENCE, "schedule", "The schedule declares a dataset as a trigger but not as an input.", "",
      "Modify the connecting build action to either remove the dataset from triggers or add it to inputs.", ("SCHEDULE_RULES",))
def _trigger_not_input(ctx: Ctx) -> list[dict]:
    import pipeline_schedules as ps

    out = []
    contents = ctx.pipeline_contents()
    for x, projects in _schedules(ctx):
        s = x["schedule"]
        content = contents.get(x["pipeline_id"]) or {}
        try:
            logic = ps.branch_content(content, s.get("branch") or "main")
            built = ps.select_outputs(logic, s.get("outputs") or [], s.get("target") or "single")
            used = {i for o in built for i in ps.output_inputs(logic, o)}
        except Exception:  # noqa: BLE001
            continue
        for leaf in ps._leaves(ps.trigger_of(s)):
            if leaf.get("type") == "data":
                missing = [i for i in leaf.get("inputs") or [] if i not in used]
                if missing:
                    out.append(finding(_sched_resource(x), projects, f"triggered by {', '.join(missing)}, which the built outputs do not read"))
    return out


@rule("schedule_potentially_unused", "Schedule potentially unused", SAVINGS, "schedule",
      "The lineage of all resources in the schedule is checked for recent downstream usage: pipelines, code transforms, object types, Workshop "
      "modules, AIP Logic or automations reading its outputs.",
      "It is not beneficial to spend resources calculating results that will never be used.",
      "Pause the unused schedule, or remove its unused outputs.", ("PIPELINE_COST_RULES", "SCHEDULE_RULES"),
      "The pipeline's compute over the last calendar month.")
def _unused(ctx: Ctx) -> list[dict]:
    g = ctx.lineage()
    if g is None:
        return []
    out = []
    consumers: dict[str, set[str]] = {}
    for (a, b) in g.edges:
        consumers.setdefault(a, set()).add(b)
    for x, projects in _schedules(ctx):
        if not x["schedule"].get("enabled"):
            continue
        pnode = f"pipeline:{x['pipeline_id']}"
        outs = [b for b in consumers.get(pnode, set()) if b.startswith("dataset:") or b.startswith("stream:")]
        if outs and not any(consumers.get(o) for o in outs):
            out.append(finding(_sched_resource(x), projects, f"nothing reads its {len(outs)} output(s)", [g.nodes[o]["name"] for o in outs][:10], _pipeline_cs(ctx, x["pipeline_id"])))
    return out


@rule("schedule_inputs_unscheduled", "Schedule inputs unscheduled", RESILIENCE, "schedule",
      "The schedule has buildable, unscheduled input datasets (built by a pipeline or code transform that no schedule runs).", "",
      "Schedule the flagged dataset, or remove its code to make it raw. If it must stay buildable but unscheduled, snooze this recommendation.", ("SCHEDULE_RULES",))
def _inputs_unscheduled(ctx: Ctx) -> list[dict]:
    g = ctx.lineage()
    if g is None:
        return []
    out = []
    producers: dict[str, list[str]] = {}
    for (a, b) in g.edges:
        if g.nodes.get(a, {}).get("kind") in ("pipeline", "transform"):
            producers.setdefault(b, []).append(a)
    scheduled_pipelines = {x["pipeline_id"] for x in ctx.schedules() if x["schedule"].get("enabled")}
    repo_sched = {r["id"]: [s for s in (r.get("schedules") or []) if s.get("enabled", True)] for r in ctx.repos()}
    for x, projects in _schedules(ctx):
        pnode = f"pipeline:{x['pipeline_id']}"
        ins = [a for (a, b) in g.edges if b == pnode and a.startswith("dataset:")]
        flagged = []
        for i in ins:
            for p in producers.get(i, []):
                n = g.nodes[p]
                if n["kind"] == "pipeline" and n.get("item_id") not in scheduled_pipelines and n.get("item_id") != x["pipeline_id"]:
                    flagged.append(f"{g.nodes[i]['name']} (pipeline {n['name']})")
                elif n["kind"] == "transform" and not repo_sched.get(n.get("repo_id")):
                    flagged.append(f"{g.nodes[i]['name']} (code transform {n['name']})")
        if flagged:
            out.append(finding(_sched_resource(x), projects, f"{len(flagged)} input(s) built by unscheduled logic", flagged[:10]))
    return out


# -- code repositories --


def _repo_resource(rec: dict) -> dict:
    return {"type": "code_repository", "id": rec["id"], "name": rec["name"], "href": f"/code-repositories/{rec['id']}", "repo_id": rec["id"]}


def _repos(ctx: Ctx) -> list[tuple[dict, list[dict]]]:
    out = []
    for rec in ctx.repos():
        projects = ctx.get(f"repo_projects:{rec['id']}", lambda rec=rec: _repo_projects(rec)) or []
        if ctx.in_scope(projects):
            out.append((rec, projects))
    return out


@rule("default_branch_unprotected", "Default branch unprotected", RESILIENCE, "code_repository", "The default branch of the code repository is not protected.",
      "Protecting default branches is important for tracking changes, version control, and protecting against accidental changes.",
      "Add the default branch to the list of protected branches in the repository settings.", ("REPOSITORY_RULES", "PIPELINE_RESILIENCE_RULES"), fix="protect_branch")
def _unprotected(ctx: Ctx) -> list[dict]:
    return [finding(_repo_resource(r), p, f"{r.get('default_branch', 'master')} is not protected") for r, p in _repos(ctx)
            if r.get("default_branch", "master") not in ((r.get("settings") or {}).get("protected_branches") or [])]


@rule("repository_squash_merge", "Repository should only allow squash and merge", RESILIENCE, "code_repository",
      "In this repository, the Squash and merge git behavior is not the only one enabled.", "Squash merges keep one commit per pull request on the default branch.",
      "Enable Squash and merge (only) in the repository settings.", ("REPOSITORY_RULES",), fix="squash_only")
def _squash(ctx: Ctx) -> list[dict]:
    return [finding(_repo_resource(r), p, f"merge modes: {', '.join((r.get('settings') or {}).get('merge_modes') or [])}") for r, p in _repos(ctx)
            if ((r.get("settings") or {}).get("merge_modes") or []) != ["squash"]]


@rule("repository_upgrades_disabled", "Repository upgrades disabled", RESILIENCE, "code_repository",
      "A code repository's settings have disabled the automatic merging of upgrade pull requests.",
      "Repository upgrades keep pipelines on the latest functionality; repositories that are not current can cause pipeline failures over time.",
      "Use the fix to allow upgrade pull requests to merge automatically (Settings → Repository → Upgrades).", ("REPOSITORY_RULES", "PIPELINE_RESILIENCE_RULES"),
      fix="enable_upgrades")
def _upgrades_off(ctx: Ctx) -> list[dict]:
    return [finding(_repo_resource(r), p, "automatic upgrade merges are off") for r, p in _repos(ctx) if not (r.get("settings") or {}).get("auto_merge_upgrades")]


@rule("repository_upgrade_blocked", "Repository upgrade blocked", RESILIENCE, "code_repository", "The code repository has an open repository upgrade PR that cannot be merged.",
      "Repositories that are not current can cause pipeline failures over time.", "Investigate why the PR is not merging, and fix the upgrade.",
      ("REPOSITORY_RULES", "PIPELINE_RESILIENCE_RULES"))
def _upgrade_blocked(ctx: Ctx) -> list[dict]:
    import code_repos

    out = []
    for r, p in _repos(ctx):
        for pr in code_repos._prs(r["id"]):
            if pr.get("status") == "open" and pr.get("upgrade"):
                state = code_repos._pr_status(r, pr)
                reason = (pr["upgrade"].get("manual") or "; ".join(state.get("blockers") or [])) if not state.get("can_merge") or pr["upgrade"].get("manual") else None
                if reason:
                    out.append(finding(_repo_resource(r), p, f"upgrade pull request #{pr['id']} cannot merge: {reason}", key=str(pr["id"])))
    return out


def _transforms(ctx: Ctx) -> list[tuple[dict, list[dict], str, str, str]]:
    """(repository, projects, file path, function, decorator block + body) of each Python transform function, by
    reading the default branch's source (no code runs)."""
    out = []
    for r, p in _repos(ctx):
        for path, text in _repo_files(r).items():
            if not path.endswith(".py") or "@" not in text:
                continue
            for m in re.finditer(r"((?:^@[^\n]*(?:\n(?!def )[^\n]*)*\n)+)def (\w+)\(", text, re.M):
                start = m.end()
                nxt = re.search(r"^(?:@|def |class )", text[start:], re.M)
                body = text[start: start + nxt.start()] if nxt else text[start:]
                block = m.group(1)
                if "transform" in block or "configure" in block:
                    out.append((r, p, path, m.group(2), block + "\n" + body))
    return out


def _tf_resource(r: dict, path: str, fn: str) -> dict:
    return {"type": "transform", "id": f"{r['id']}::{path}::{fn}", "name": fn, "subtitle": f"{r['name']} · {path}", "href": f"/code-repositories/{r['id']}?file={path}", "repo_id": r["id"]}


def _profiles(block: str) -> list[str]:
    m = re.search(r"@configure\(\s*(?:profile\s*=\s*)?(\[[^\]]*\]|\"[^\"]+\"|'[^']+')", block)
    return re.findall(r"[\"']([A-Z0-9_]+)[\"']", m.group(1)) if m else []


def _repo_cs(r: dict, transform_key: Optional[str] = None, days: int = 30) -> float:
    import code_repos

    since = _iso(_now() - timedelta(days=days))
    cs = 0.0
    for b in code_repos._builds(r["id"]):
        if b["at"] < since or (transform_key and b["transform"] != transform_key):
            continue
        cores = ((b.get("metrics") or {}).get("cpu_cores") or 1)
        cs += (b.get("ms") or 0) / 1000 * cores * RATE
    return cs


@rule("executor_high_memory_ratio", "Executor high memory ratio", SAVINGS, "transform",
      "The transform uses a memory-to-core ratio higher than the default of 7.5 GB per core.",
      "Exceeding the default memory-to-core ratio increases costs; memory is often raised for problems memory does not solve.",
      "Align the EXECUTOR_MEMORY_X Spark profile with the EXECUTOR_CORES_X profile; if that leads to memory issues, partition inputs more finely or raise "
      "shuffle partitions.", ("PIPELINE_COST_RULES",), "Last month's compute of the transform minus what it would use at 7.5 GB per core.")
def _mem_ratio(ctx: Ctx) -> list[dict]:
    import code_pyapi

    out = []
    for r, p, path, fn, block in _transforms(ctx):
        prof = _profiles(block)
        if not prof:
            continue
        try:
            s = code_pyapi.spark_settings(prof)
        except ValueError:
            continue
        mem, cores = s.get("executor_memory_mb"), s.get("executor_cores") or 1
        if mem and mem / cores > 7.5 * 1024:
            ratio = mem / cores / 1024
            cs = _repo_cs(r, f"{path}::{fn}") * (1 - 7.5 / ratio)
            out.append(finding(_tf_resource(r, path, fn), p, f"{ratio:.1f} GB per core ({', '.join(prof)})", [], cs))
    return out


@rule("dataset_native_acceleration", "Dataset should use native acceleration", SAVINGS, "transform",
      "Transforms associated with the datasets contain an executor memory based profile in their @configure block, and are not already associated with Velox.",
      "", "Switching to the Velox backend may save compute; check the resources consumed to validate the savings.", ("PIPELINE_COST_RULES",))
def _velox(ctx: Ctx) -> list[dict]:
    return [finding(_tf_resource(r, path, fn), p, f"profiles {', '.join(_profiles(block))} without backend=ComputeBackend.VELOX")
            for r, p, path, fn, block in _transforms(ctx) if any(x.startswith("EXECUTOR_MEMORY") for x in _profiles(block)) and "VELOX" not in block]


SPARK_USE = re.compile(r"\bspark_session\b|\bpyspark\b|\bF\.\w+\(|\.withColumn\(|\.groupBy\(|\.rdd\b|\bwrite_dataframe\(|\.dataframe\(\)\.(?:join|select|filter|where)")


@rule("transform_should_be_lightweight", "Transform should be lightweight", SAVINGS, "transform",
      "Transforms associated with these datasets do not use Spark context or Spark dataframes, or are pandas based.", "",
      "Switch these transforms to lightweight transforms (@transform.using); check the resources consumed to validate the savings.", ("PIPELINE_COST_RULES",),
      "Half of the transform's compute over the last month.")
def _lightweight(ctx: Ctx) -> list[dict]:
    out = []
    for r, p, path, fn, block in _transforms(ctx):
        spark = "transform.spark" in block or "@configure" in block
        if spark and not SPARK_USE.search(block.split("def ", 1)[-1] if "def " in block else block) and ".pandas()" in block:
            out.append(finding(_tf_resource(r, path, fn), p, "a Spark transform that only uses pandas", [], _repo_cs(r, f"{path}::{fn}") / 2))
        elif spark and not SPARK_USE.search(block):
            out.append(finding(_tf_resource(r, path, fn), p, "a Spark transform that uses no Spark API", [], _repo_cs(r, f"{path}::{fn}") / 2))
    return out


NONDETERMINISTIC = [(r"monotonically_increasing_id", "monotonically_increasing_id() depends on partitioning"),
                    (r"\bF\.rand\(|\bF\.randn\(|\brand\(\)", "rand() / randn() without a seed"),
                    (r"\bF\.uuid\(|uuid\.uuid4\(", "uuid generation"),
                    (r"\bF\.(first|last)\(", "first() / last() aggregations depend on row order"),
                    (r"\bcurrent_timestamp\(|\bF\.now\(", "the current time"),
                    (r"\.dropDuplicates\([^)]*\)\s*\.(?!orderBy)", "dropDuplicates keeps an arbitrary row")]


PLAN_NONDETERMINISTIC = [(r"monotonically_increasing_id\(", "monotonically_increasing_id() depends on partitioning"),
                         (r"\brandn?\(", "rand() / randn()"), (r"\buuid\(", "uuid()"),
                         (r"\b(first|last)\([^)]*\)", "first() / last() aggregations depend on row order"),
                         (r"current_timestamp\(|now\(\)", "the current time"), (r"\bDeduplicate\b", "dropDuplicates keeps an arbitrary row"),
                         (r"\bSample\b", "sampling")]


def _last_plans(r: dict, key: str) -> list[dict]:
    """The query plans the transform's last successful build wrote (code_runner records them)."""
    import code_repos

    last = next((b for b in code_repos._builds(r["id"]) if b["transform"] == key and b["status"] == "succeeded"), None)
    return (last or {}).get("spark_plans") or []


@rule("spark_plan_nondeterministic", "Spark plan potentially non-deterministic", RESILIENCE, "transform",
      "A query plan with potentially non-deterministic logic was detected for a dataset built by Spark (the optimized plan of its last build, or a scan of the transform's code when it has not been built).",
      "Several edge cases in Spark query plans may lead to inconsistent, non-deterministic, or otherwise unstable data.",
      "Investigate and fix the logic backing the dataset.", ("PIPELINE_RESILIENCE_RULES",))
def _nondeterministic(ctx: Ctx) -> list[dict]:
    out = []
    for r, p, path, fn, block in _transforms(ctx):
        plans = _last_plans(r, f"{path}::{fn}")
        if plans:
            text = "\n".join(x.get("logical") or "" for x in plans)
            hits = [why for pat, why in PLAN_NONDETERMINISTIC if re.search(pat, text)]
            if hits:
                out.append(finding(_tf_resource(r, path, fn), p, f"{hits[0]} (in the query plan)", hits))
            continue
        hits = [why for pat, why in NONDETERMINISTIC if re.search(pat, block)]
        if hits and ("spark" in block or "F." in block):
            out.append(finding(_tf_resource(r, path, fn), p, hits[0], hits))
    return out


@rule("spark_plan_cartesian_product", "Spark plan with a cartesian product", SAVINGS, "transform",
      "The physical plan of the dataset's last build joins with a cartesian product or a broadcast nested loop join.",
      "Every row of one side is compared with every row of the other: the cost grows with the product of the inputs' sizes.",
      "Join on equality conditions (or bucket the inputs) so Spark can use a hash or sort-merge join.", ("PIPELINE_COST_RULES",))
def _cartesian(ctx: Ctx) -> list[dict]:
    out = []
    for r, p, path, fn, _block in _transforms(ctx):
        text = "\n".join(x.get("physical") or "" for x in _last_plans(r, f"{path}::{fn}"))
        kinds = [k for k in ("CartesianProduct", "BroadcastNestedLoopJoin") if k in text]
        if kinds:
            out.append(finding(_tf_resource(r, path, fn), p, f"{kinds[0]} in the physical plan", kinds, _repo_cs(r, f"{path}::{fn}") / 2))
    return out


def _item_size(item_id: str) -> int:
    it = db.drive_get(item_id)
    return int((it or {}).get("size") or 0)


@rule("transform_should_build_locally", "Transform should build locally", SAVINGS, "transform",
      "The transform uses dataset(s) that are small in size (300 MB or less) but runs on Spark.", "Distributed computation uses more resources than local computation.",
      "Run it as a lightweight (single-node) transform, or with the KUBERNETES_NO_EXECUTORS Spark profile.", ("PIPELINE_COST_RULES",),
      "The transform's compute over the last month times the share of cores it would no longer use (4 of 5).")
def _build_locally(ctx: Ctx) -> list[dict]:
    import code_repos

    out = []
    for r, p, path, fn, block in _transforms(ctx):
        spark = "transform.spark" in block or "@configure" in block or "@sidecar" in block
        if not spark or "KUBERNETES_NO_EXECUTORS" in block:
            continue
        last = next((b for b in code_repos._builds(r["id"]) if b["transform"] == f"{path}::{fn}" and b["status"] == "succeeded"), None)
        if not last or not last.get("inputs"):
            continue
        size = sum(_item_size(i["item_id"]) for i in last["inputs"] if i.get("item_id"))
        if size <= 300 * 1024 * 1024:
            out.append(finding(_tf_resource(r, path, fn), p, f"inputs total {size / 1024 / 1024:.1f} MB", [], _repo_cs(r, f"{path}::{fn}") * 0.8))
    return out


@rule("dataset_code_out_of_date", "Dataset code out of date", RESILIENCE, "transform",
      "The dataset's last build commit is different from the latest commit of the default branch of the repository.",
      "The build of the dataset does not reflect the latest logic in the repository.",
      "Remove the dataset from the schedule, or rebuild it from the latest commit of the default branch.", ("PIPELINE_RESILIENCE_RULES",))
def _out_of_date(ctx: Ctx) -> list[dict]:
    import code_repos

    out = []
    for r, p in _repos(ctx):
        try:
            head = code_repos._branch(r, r.get("default_branch"))["head"]
        except HTTPException:
            continue
        seen = set()
        for b in code_repos._builds(r["id"]):
            if b["transform"] in seen or (b.get("branch") or r.get("default_branch")) != r.get("default_branch") or b["status"] != "succeeded":
                continue
            seen.add(b["transform"])
            if b.get("commit") and head and b["commit"] != head:
                path, _, fn = b["transform"].partition("::")
                out.append(finding(_tf_resource(r, path, fn), p, f"built from commit {b['commit'][:10]}; the default branch is at {head[:10]}"))
    return out


@rule("dataset_build_time_exceeds_threshold", "Dataset build time exceeds threshold", SAVINGS, "pipeline",
      "The percentage of time spent with jobs actively running for this resource over the last seven days has exceeded 70%.",
      "Datasets constantly building can be a large source of usage.", "Consider reducing build frequency.", ("PIPELINE_COST_RULES",),
      "The total resource usage of the last month.")
def _build_time(ctx: Ctx) -> list[dict]:
    out = []
    since = _now() - timedelta(days=7)
    busy: dict[str, float] = {}
    for b in ctx.pipeline_builds():
        if b.get("streaming"):
            continue
        s, f = _parse(b.get("started_at")), _parse(b.get("finished_at")) or _now()
        if s and s >= since:
            busy[b["pipeline_id"]] = busy.get(b["pipeline_id"], 0) + (f - s).total_seconds()
    for pid, secs in busy.items():
        share = secs / (7 * 86400)
        if share > 0.7:
            projects = project_of(pid)
            if ctx.in_scope(projects):
                name = (ctx.usage().get(pid) or {}).get("name") or pid
                out.append(finding({"type": "pipeline", "id": pid, "name": name, "href": f"/pipeline/{pid}"}, projects, f"building {share:.0%} of the last 7 days", [], _pipeline_cs(ctx, pid)))
    return out


@rule("over_provisioned_cores", "Snapshot / incremental over-provisioned cores", SAVINGS, "transform",
      "The transform requests a fixed number of cores and the parallelism of its recent jobs is lower than 70% of them.",
      "Statically provisioned resources sit idle while waiting for other tasks.",
      "Request fewer cores (with_resources), or use dynamic allocation (DYNAMIC_ALLOCATION_MAX_N) on Spark.", ("PIPELINE_COST_RULES",),
      "The transform's compute over the last month times the idle share of its cores.")
def _over_cores(ctx: Ctx) -> list[dict]:
    import code_repos

    out = []
    for r, p in _repos(ctx):
        per: dict[str, list[float]] = {}
        for b in code_repos._builds(r["id"])[:200]:
            m = b.get("metrics") or {}
            # only cores the transform asked for (with_resources); the runner's default is not a request
            req = float((b.get("resources") or {}).get("cpu_cores") or 0)
            if b["status"] == "succeeded" and req > 1 and m.get("peak_cores") is not None:
                per.setdefault(b["transform"], []).append(min(1.0, m["peak_cores"] / req))
        for key, ps in per.items():
            par = sum(ps[:10]) / len(ps[:10])
            if par < 0.7:
                path, _, fn = key.partition("::")
                out.append(finding(_tf_resource(r, path, fn), p, f"used {par:.0%} of its requested cores in its last {len(ps[:10])} builds", [], _repo_cs(r, key) * (1 - par)))
    return out


def _history(item_id: str) -> list[dict]:
    import dataset_versions

    try:
        return dataset_versions.history(item_id)
    except Exception:  # noqa: BLE001
        return []


def _tx_kind(tx: dict) -> str:
    src = tx.get("source") or {}
    return src.get("transaction") or ("APPEND" if src.get("mode") == "append" else "SNAPSHOT")


@rule("transform_should_build_incrementally", "Transform should build incrementally", SAVINGS, "transform",
      "The dataset builds as a SNAPSHOT but is directly downstream of at least one incremental dataset that purely appends new data.",
      "A SNAPSHOT transaction processes all historic data; an incremental one only the new data.",
      "Convert the transform to an incremental transform (@incremental).", ("PIPELINE_COST_RULES",),
      "Last month's compute of the transform times the share of its input that is not new data in each build.")
def _incremental(ctx: Ctx) -> list[dict]:
    import code_repos

    out = []
    for r, p in _repos(ctx):
        seen = set()
        for b in code_repos._builds(r["id"]):
            if b["transform"] in seen or b["status"] != "succeeded" or b.get("incremental"):
                continue
            seen.add(b["transform"])
            appenders = []
            for i in b.get("inputs") or []:
                h = _history(i.get("item_id") or "")
                if len(h) >= 3 and all(_tx_kind(t) == "APPEND" for t in h[:-1]):
                    appenders.append(i.get("item_name") or i.get("name"))
            if appenders:
                path, _, fn = b["transform"].partition("::")
                out.append(finding(_tf_resource(r, path, fn), p, f"rebuilds everything from append-only input(s): {', '.join(appenders)}", [], _repo_cs(r, b["transform"]) * 0.5))
    return out


@rule("dataset_should_be_view", "Dataset should be view", SAVINGS, "transform",
      "The statistics of the input and output datasets of a transform indicate that there is no logic being applied (same rows and columns).",
      "Resources are used reading a dataset into Spark and writing it back out.",
      "Turn this dataset into a view (Files → New → View) to decrease pipeline runtime, data duplication, and cost.", ("PIPELINE_COST_RULES",),
      "The total resource usage of the transform over the last month.")
def _should_be_view(ctx: Ctx) -> list[dict]:
    import io

    import pyarrow.parquet as pq

    import code_repos
    import drive

    out = []
    for r, p in _repos(ctx):
        seen = set()
        for b in code_repos._builds(r["id"]):
            if b["transform"] in seen or b["status"] != "succeeded" or len(b.get("inputs") or []) != 1 or not b.get("output"):
                continue
            seen.add(b["transform"])
            try:
                it = db.drive_get(b["inputs"][0]["item_id"])
                meta = pq.ParquetFile(io.BytesIO(drive.read_bytes(it))).metadata
                cols = {c["name"] for c in b["output"].get("columns") or []}
                in_cols = {meta.schema.column(i).name for i in range(meta.num_columns)}
            except Exception:  # noqa: BLE001
                continue
            if meta.num_rows == b["output"].get("rows") and cols == in_cols and meta.num_rows > 0:
                path, _, fn = b["transform"].partition("::")
                out.append(finding(_tf_resource(r, path, fn), p, f"copies {meta.num_rows} rows and the same {len(cols)} columns from its input", [], _repo_cs(r, b["transform"])))
    return out


@rule("dataset_too_many_files", "Snapshot / incremental dataset too many files", SAVINGS, "dataset",
      "The dataset (a folder of files) has a suboptimal average file size: many files under 16 MB, or files over 1 GB.",
      "Per-file overhead dominates small files; large files strain memory in downstream reads.",
      "Compact the dataset: write fewer, larger files (repartition before writing, or a periodic snapshot rewrite).", ("PIPELINE_COST_RULES",))
def _too_many_files(ctx: Ctx) -> list[dict]:
    out = []
    try:
        folders = db.drive_query("d.kind = 'folder' AND d.trashed_at IS NULL", (), limit=2000)
    except Exception:  # noqa: BLE001
        return []
    for f in folders:
        projects = project_of(f["id"])
        if not ctx.in_scope(projects):
            continue
        kids = [c for c in db.drive_list(f["id"]) if c["kind"] == "file" and c["name"].lower().endswith(".parquet") and not c.get("trashed_at")]
        if len(kids) < 50:
            continue
        sizes = [int(c.get("size") or 0) for c in kids]
        avg = sum(sizes) / len(sizes)
        if avg < 16 * 1024 * 1024 or max(sizes) > 1024**3:
            out.append(finding({"type": "dataset", "id": f["id"], "name": f["name"], "href": f"/datasets/{f['id']}"}, projects,
                               f"{len(kids)} files, {avg / 1024 / 1024:.1f} MB on average"))
    return out


def _contour_scheduled(ctx: Ctx) -> list[dict]:
    """Saved datasets a Contour analysis rebuilds on a schedule."""
    import contour

    out = []
    try:
        items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (contour.CONTOUR_MIME,), limit=2000)
    except Exception:  # noqa: BLE001
        return []
    for item in items:
        projects = project_of(item["id"])
        if not ctx.in_scope(projects):
            continue
        try:
            a = contour._load(item)
        except Exception:  # noqa: BLE001 - an unreadable analysis is not this rule's finding
            continue
        paths = {p["id"]: p.get("name") or p["id"] for p in a.get("paths") or []}
        for pid, saved in (a.get("saved") or {}).items():
            sch = saved.get("schedule") or {}
            if not sch.get("every_hours") or not saved.get("dataset_id"):
                continue
            title = a.get("title") or item["name"]
            evidence = [f"Path: {paths.get(pid, pid)}", f"Every {sch['every_hours']:g} hours", f"Rows at the last build: {saved.get('rows')}"]
            if saved.get("last_status") == "failed":
                evidence.append(f"The last scheduled build failed: {saved.get('last_error') or ''}"[:300])
            out.append(finding({"type": "dataset", "id": saved["dataset_id"], "name": saved.get("name") or "Contour dataset", "subtitle": f"Contour · {title}",
                                "href": f"/analytics/{item['id']}"}, projects,
                               f"rebuilt every {sch['every_hours']:g} hours by the Contour analysis {title}", evidence, key=f"{item['id']}:{pid}"))
    return out


rule("schedule_builds_contour", "Schedule builds Contour analysis", SAVINGS, "dataset",
     "A dataset saved from a Contour analysis is rebuilt on a schedule.",
     "Contour reads its whole inputs into memory on every build and its analyses are edited interactively: a scheduled production dataset is "
     "cheaper and safer as a pipeline, with checks, lineage and incremental builds.",
     "Move the path to Pipeline Builder (the path's menu: Export to Pipeline Builder) or a transform, schedule that, and turn the analysis' schedule off.",
     ("PIPELINE_COST_RULES",))(_contour_scheduled)


# rules about applications or settings this platform does not have
for _rid, _name, _why in [
    ("code_workbook_crosses_schedules", "Code workbook pipeline crosses schedules", "Code Workbook datasets are built on demand here (Build in the workbook): no schedule builds them."),
    ("schedule_builds_code_workbook", "Schedule builds Code Workbook", "Code Workbook datasets are built on demand here (Build in the workbook): no schedule builds them."),
    ("dataset_filtered_projection", "Dataset has a filtered projection", "Datasets have no projections here."),
    ("schedule_no_abort_on_failure", "Schedule does not abort on failure", "Pipeline Builder schedules have no abort-on-failure setting: failed outputs end their run."),
    ("schedule_exceeded_duration_disabled", "Schedule exceeded duration mode disabled", "Schedules have no exceeded-duration mode here."),
    ("schedule_ignores_irrelevant_datasets", "Schedule ignores irrelevant datasets", "Schedules have no ignore list here (excluded outputs are part of the build action)."),
    ("schedule_inputs_disconnected", "Schedule inputs disconnected", "Pipeline Builder schedules build a pipeline's outputs; they declare no separate inputs."),
    ("schedule_outputs_not_targets", "Schedule outputs not targets", "A schedule's targets are its outputs by construction here."),
    ("schedule_scope_invalid", "Schedule scope invalid", "Project-scoped schedules are checked when they run (out-of-scope outputs are reported on the run)."),
    ("schedule_triggers_itself", "Schedule triggers itself", "A pipeline cannot read its own output dataset as an input here."),
    ("schedule_missing_description", "Schedule missing description", "Schedules have no description field here."),
]:
    rule(_rid, _name, RESILIENCE if "Schedule" in _name and "Contour" not in _name and "Workbook" not in _name else SAVINGS, "schedule", "", "", "", na=_why)()


PRESETS = {
    "ALL_RULES": "Every applicable rule",
    "PIPELINE_COST_RULES": "Rules that reduce compute cost",
    "PIPELINE_RESILIENCE_RULES": "Rules that make pipelines more stable",
    "SCHEDULE_RULES": "Schedule hygiene",
    "REPOSITORY_RULES": "Code repository settings",
}


# ------------------------------------------------------------------------------------------------
# sweeps
# ------------------------------------------------------------------------------------------------


def rule_scope(s: dict) -> list[str]:
    """Presets first, then rules added, then rules excluded (applicable rules only)."""
    ids = [r["id"] for r in RULES.values() if r["applicable"] and set(r["presets"]) & set(s.get("presets") or [])]
    ids += [x for x in s.get("rules") or [] if x in RULES and RULES[x]["applicable"] and x not in ids]
    return [x for x in ids if x not in set(s.get("exclude") or [])]


def _rec_id(rule_id: str, f: dict) -> str:
    return hashlib.sha1(f"{rule_id}|{f['resource']['type']}|{f['resource']['id']}|{f.get('key', '')}".encode()).hexdigest()[:16]


def _load_recs(where: str = "", args: tuple = ()) -> list[dict]:
    with _db() as con:
        return [json.loads(r) for (r,) in con.execute(f"SELECT record FROM recommendations {where}", args).fetchall()]


def _save_rec(rec: dict, con: Optional[sqlite3.Connection] = None) -> None:
    def put(c: sqlite3.Connection) -> None:
        c.execute("INSERT OR REPLACE INTO recommendations (id, rule, status, record) VALUES (?, ?, ?, ?)", (rec["id"], rec["rule"], rec["status"], json.dumps(rec)))

    if con is not None:
        put(con)
    else:
        with _db() as c:
            put(c)


def run_sweep(schedule_id: str, trigger: str = "schedule") -> dict:
    s = _schedule(schedule_id)
    sweep = {"id": "sw-" + uuid.uuid4().hex[:10], "schedule_id": schedule_id, "trigger": trigger, "status": "running", "queued_at": _iso(), "started_at": _iso(),
             "finished_at": None, "error": None, "rules": rule_scope(s), "projects": s.get("projects") or [], "found": 0, "new": 0, "removed": 0, "resolved": 0,
             "rule_errors": {}}
    _save_sweep(sweep)
    ctx = Ctx(s.get("projects") or [])
    now = _iso()
    try:
        found: dict[str, dict] = {}
        for rid in sweep["rules"]:
            r = RULES[rid]
            try:
                for f in r["check"](ctx) or []:
                    found[_rec_id(rid, f)] = {**f, "rule": rid}
            except Exception as e:  # noqa: BLE001 - a broken rule does not stop the sweep
                log.exception("linter rule %s failed", rid)
                sweep["rule_errors"][rid] = str(e)[:300]
        with _lock, _db() as con:
            existing = {json.loads(r)["id"]: json.loads(r) for (r,) in con.execute("SELECT record FROM recommendations WHERE rule IN (%s)" % ",".join("?" * len(sweep["rules"])),
                                                                                    sweep["rules"]).fetchall()} if sweep["rules"] else {}
            for rec_id, f in found.items():
                cur = existing.get(rec_id)
                rule_ = RULES[f["rule"]]
                rec = {**(cur or {"id": rec_id, "first_seen": now, "status": "open", "state": "default", "assignee": None, "snooze": None}),
                       "rule": f["rule"], "mode": rule_["mode"], "title": rule_["name"], "resource": f["resource"], "projects": f["projects"], "detail": f["detail"],
                       "evidence": f["evidence"], "impact": {"compute_hours_month": _hours(f["impact_cs"])} if rule_["mode"] == SAVINGS else None,
                       "last_seen": now, "sweep_id": sweep["id"], "fix": rule_["fix"]}
                if rec["status"] == "resolved":
                    rec.update(status="open", resolved_at=None)
                if not cur:
                    sweep["new"] += 1
                _save_rec(rec, con)
            # recommendations of these rules (and these Projects) that the sweep no longer finds
            for rec_id, cur in existing.items():
                if rec_id in found or cur["status"] == "resolved":
                    continue
                if s.get("projects") and not any(p["id"] in s["projects"] for p in cur.get("projects") or []):
                    continue
                # a sweep run by a user sees only their resources (code repositories: markings and a Project role):
                # it does not resolve or remove what it could not look at
                if not _visible(cur):
                    continue
                if cur["status"] == "under_investigation":
                    cur.update(status="resolved", resolved_at=now)
                    _save_rec(cur, con)
                    sweep["resolved"] += 1
                else:
                    con.execute("DELETE FROM recommendations WHERE id = ?", (rec_id,))
                    sweep["removed"] += 1
        sweep.update(status="succeeded", found=len(found))
    except Exception as e:  # noqa: BLE001
        log.exception("linter sweep failed")
        sweep.update(status="failed", error=str(e)[:500])
    sweep["finished_at"] = _iso()
    _save_sweep(sweep)
    s["last_sweep"] = {k: sweep[k] for k in ("id", "status", "finished_at", "found")}
    _put_schedule(s)
    return sweep


def _save_sweep(sw: dict) -> None:
    with _db() as con:
        con.execute("INSERT OR REPLACE INTO sweeps (id, schedule_id, queued_at, record) VALUES (?, ?, ?, ?)", (sw["id"], sw["schedule_id"], sw["queued_at"], json.dumps(sw)))


def _schedule(sid: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM sweep_schedules WHERE id = ?", (sid,)).fetchone()
    if not row:
        raise HTTPException(404, "no such sweep schedule")
    return json.loads(row[0])


def _put_schedule(s: dict) -> None:
    with _db() as con:
        con.execute("INSERT OR REPLACE INTO sweep_schedules (id, record) VALUES (?, ?)", (s["id"], json.dumps(s)))


def tick() -> None:
    """Run the sweep schedules that are due; expire snoozes; verify the impact of resolved recommendations."""
    with _db() as con:
        scheds = [json.loads(r) for (r,) in con.execute("SELECT record FROM sweep_schedules").fetchall()]
    now = _now()
    for s in scheds:
        last = _parse((s.get("last_sweep") or {}).get("finished_at"))
        if not s.get("paused") and (not last or last + timedelta(hours=s.get("interval_hours") or 24) <= now):
            run_sweep(s["id"])
    with _lock, _db() as con:
        for (r,) in con.execute("SELECT record FROM recommendations WHERE status != 'resolved'").fetchall():
            rec = json.loads(r)
            if rec.get("state") == "snoozed" and (rec.get("snooze") or {}).get("until", "9") <= _iso():
                rec["state"] = "snooze_expired"
                _save_rec(rec, con)
    _verify()


def _verify() -> None:
    """Verified impact: compute in the week before the fix minus the week after, normalized to 30 days."""
    for rec in _load_recs("WHERE status = 'resolved'"):
        resolved = _parse(rec.get("resolved_at"))
        if not resolved or rec.get("verified") or _now() < resolved + timedelta(days=7):
            continue
        before = _resource_cs(rec["resource"], resolved - timedelta(days=7), resolved)
        after = _resource_cs(rec["resource"], resolved, resolved + timedelta(days=7))
        rec["verified"] = {"before_hours": _hours(before), "after_hours": _hours(after), "monthly_hours": _hours((before - after) * 30 / 7), "at": _iso()}
        _save_rec(rec)


def _resource_cs(res: dict, start: datetime, end: datetime) -> float:
    """Compute of a resource between two times (pipelines and schedules: their pipeline's builds; transforms and
    repositories: their code builds)."""
    cs = 0.0
    try:
        if res.get("pipeline_id") or res["type"] == "pipeline":
            import pipeline_runtime as rt
            import resource_usage

            pid = res.get("pipeline_id") or res["id"]
            for b in rt._builds(limit=20000):
                t = _parse(b.get("created_at"))
                if b["pipeline_id"] == pid and t and start <= t < end:
                    cs += resource_usage.batch_usage(b, _now())[1]
        elif res.get("repo_id"):
            import code_repos

            key = res["id"].split("::", 1)[1] if res["type"] == "transform" else None
            for b in code_repos._builds(res["repo_id"]):
                t = _parse(b.get("at"))
                if t and start <= t < end and (not key or b["transform"] == key):
                    cs += (b.get("ms") or 0) / 1000 * ((b.get("metrics") or {}).get("cpu_cores") or 1) * RATE
    except Exception:  # noqa: BLE001
        pass
    return cs


_ticker = {"started": False}


def start() -> None:
    if _ticker["started"]:
        return
    _ticker["started"] = True

    def loop() -> None:
        time.sleep(120)
        while True:
            try:
                tick()
            except Exception:  # noqa: BLE001
                log.exception("linter tick failed")
            time.sleep(600)

    threading.Thread(target=loop, daemon=True, name="linter").start()


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


def _visible(rec: dict) -> bool:
    res = rec["resource"]
    try:
        if res.get("pipeline_id") or res["type"] in ("pipeline", "dataset"):
            return auth.can_access(res.get("pipeline_id") or res["id"])
        if res.get("repo_id"):
            import code_repos

            return bool(auth.visible_resources("code_repo", [code_repos._repo(res["repo_id"])]))
    except Exception:  # noqa: BLE001
        return False
    return True


def _public_rule(r: dict) -> dict:
    return {k: v for k, v in r.items() if k != "check"}


@router.get("/rules")
def rules() -> dict:
    return {"rules": [_public_rule(r) for r in RULES.values()], "presets": PRESETS, "modes": {SAVINGS: "Resource Savings", RESILIENCE: "Pipeline Resilience"}}


@router.get("/recommendations")
def recommendations(mode: Optional[str] = None, include_snoozed: bool = True) -> list[dict]:
    out = [r for r in _load_recs("WHERE status != 'resolved'") if (not mode or r["mode"] == mode) and _visible(r)]
    if not include_snoozed:
        out = [r for r in out if r.get("state") != "snoozed"]
    out.sort(key=lambda r: (-((r.get("impact") or {}).get("compute_hours_month") or 0), r["title"], r["resource"]["name"]))
    return out


def _rec(rec_id: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM recommendations WHERE id = ?", (rec_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no such recommendation (a newer sweep may have removed it)")
    rec = json.loads(row[0])
    if not _visible(rec):
        raise HTTPException(404, "no such recommendation")
    return rec


@router.post("/recommendations/{rec_id}/open")
def open_rec(rec_id: str) -> dict:
    """Selecting a recommendation the first time makes it Under investigation (tracked in impact tracking)."""
    with _lock:
        rec = _rec(rec_id)
        if rec["status"] == "open":
            rec.update(status="under_investigation", investigated_at=_iso(), investigated_by=_me(),
                       snapshot={k: rec.get(k) for k in ("detail", "evidence", "impact")})
            _save_rec(rec)
    return {**rec, "rule_info": _public_rule(RULES[rec["rule"]])}


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: str  # snooze | unsnooze | assign
    until: Optional[str] = None
    reason: str = ""
    assignee: Optional[str] = None


@router.post("/recommendations/bulk")
def bulk(req: BulkIn) -> list[dict]:
    if req.action not in ("snooze", "unsnooze", "assign"):
        raise HTTPException(400, "action: snooze, unsnooze or assign")
    if req.action == "snooze":
        until = _parse(req.until)
        if not until or until <= _now():
            raise HTTPException(400, "snooze until a time in the future")
    out = []
    with _lock:
        for rid in req.ids:
            rec = _rec(rid)
            if req.action == "snooze":
                rec.update(state="snoozed", snooze={"until": _iso(_parse(req.until)), "reason": req.reason.strip(), "by": _me(), "at": _iso()})
            elif req.action == "unsnooze":
                rec.update(state="default", snooze=None)
            else:
                rec["assignee"] = req.assignee or None
            _save_rec(rec)
            out.append(rec)
    return out


FIXES: dict[str, Callable[[dict], str]] = {}
# fixes that change a code repository's settings
REPO_SETTING_FIXES = ("protect_branch", "squash_only", "enable_upgrades")


def _fix(name: str):
    def wrap(fn):
        FIXES[name] = fn
        return fn

    return wrap


@_fix("protect_branch")
def _f_protect(rec: dict) -> str:
    import code_repos

    repo = code_repos._repo(rec["resource"]["repo_id"])
    branches = sorted({*(repo["settings"].get("protected_branches") or []), repo.get("default_branch", "master")})
    code_repos.save_settings(repo["id"], code_repos.SettingsIn(protected_branches=branches))
    return f"protected {repo.get('default_branch', 'master')}"


@_fix("squash_only")
def _f_squash(rec: dict) -> str:
    import code_repos

    code_repos.save_settings(rec["resource"]["repo_id"], code_repos.SettingsIn(merge_modes=["squash"]))
    return "merge modes: squash only"


@_fix("enable_upgrades")
def _f_upgrades(rec: dict) -> str:
    import code_repos

    code_repos.save_settings(rec["resource"]["repo_id"], code_repos.SettingsIn(auto_merge_upgrades=True))
    return "upgrade pull requests merge automatically"


def _edit_schedule(rec: dict, change: Callable[[dict, dict], str]) -> str:
    import pipeline_schedules as ps

    pid, sid = rec["resource"]["pipeline_id"], rec["resource"]["schedule_id"]
    item, content, s = ps._find(pid, sid)
    ps.check_manage(pid, content, s)
    msg = change(s, content)
    ps._write(item, content)
    return msg


@_fix("enable_retries")
def _f_retries(rec: dict) -> str:
    def change(s: dict, _: dict) -> str:
        s["retries"] = {**(s.get("retries") or {}), "count": 3, "delayMinutes": (s.get("retries") or {}).get("delayMinutes") or 1}
        return "retries: 3 attempts"

    return _edit_schedule(rec, change)


@_fix("name_schedule")
def _f_name(rec: dict) -> str:
    import pipeline_schedules as ps

    def change(s: dict, content: dict) -> str:
        outs = ps.select_outputs(ps.branch_content(content, s.get("branch") or "main"), s.get("outputs") or [], s.get("target") or "single")
        names = [o.get("name") or o.get("id") for o in outs][:3]
        s["name"] = f"Build {', '.join(names)}" if names else f"{rec['resource'].get('subtitle') or 'Pipeline'} schedule"
        return f"named {s['name']!r}"

    return _edit_schedule(rec, change)


@router.post("/recommendations/{rec_id}/fix")
def apply_fix(rec_id: str) -> dict:
    """Accept the fix proposal: Linter applies the setting (as the caller, with their permissions)."""
    rec = _rec(rec_id)
    if not rec.get("fix") or rec["fix"] not in FIXES:
        raise HTTPException(400, "this recommendation has no fix proposal")
    if rec["fix"] in REPO_SETTING_FIXES:
        # a repository's settings (branch protection, merge modes, upgrades): Owners of its Project, as in
        # Code Repositories → Settings
        auth.check_resource("code_repo", rec["resource"]["repo_id"], "owner")
    msg = FIXES[rec["fix"]](rec)
    with _lock:
        rec = _rec(rec_id)
        if rec["status"] == "open":
            rec.update(status="under_investigation", investigated_at=_iso(), investigated_by=_me(), snapshot={k: rec.get(k) for k in ("detail", "evidence", "impact")})
        rec["fixed"] = {"at": _iso(), "by": _me(), "result": msg}
        _save_rec(rec)
    return {"applied": msg, "recommendation": rec}


@router.get("/assignees")
def assignees() -> list[dict]:
    """People a recommendation can be assigned to (names only)."""
    try:
        users = auth._users()
    except Exception:  # noqa: BLE001
        return []
    return sorted(({"id": u["id"], "label": u.get("display_name") or u["username"]} for u in users if not u.get("disabled")), key=lambda u: u["label"].lower())


@router.get("/impact")
def impact(days: int = 90, rule: Optional[str] = None, project: Optional[str] = None) -> dict:
    since = _iso(_now() - timedelta(days=max(1, min(days, 365))))
    recs = [r for r in _load_recs("WHERE status IN ('resolved', 'under_investigation')") if _visible(r)]
    recs = [r for r in recs if (r.get("resolved_at") or r.get("investigated_at") or "") >= since and (not rule or r["rule"] == rule)
            and (not project or any(p["id"] == project for p in r.get("projects") or []))]
    resolved = [r for r in recs if r["status"] == "resolved"]
    return {"resolved": len(resolved), "under_investigation": len(recs) - len(resolved),
            "estimated_hours": round(sum(((r.get("snapshot") or {}).get("impact") or {}).get("compute_hours_month") or 0 for r in resolved), 1),
            "verified_hours": round(sum((r.get("verified") or {}).get("monthly_hours") or 0 for r in resolved), 1),
            "pending_verification": sum(1 for r in resolved if not r.get("verified")),
            "recommendations": sorted(recs, key=lambda r: r.get("resolved_at") or r.get("investigated_at") or "", reverse=True)}


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    projects: list[str] = Field(default_factory=list)
    presets: list[str] = Field(default_factory=lambda: ["ALL_RULES"])
    rules: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)
    interval_hours: int = Field(24, ge=1, le=24 * 30)
    paused: bool = False


def _check_admin() -> None:
    p = auth.current()
    if auth.enabled() and p and not p.get("service") and p.get("role") != "admin":
        raise HTTPException(403, "only administrators change sweep schedules (Control Panel → Linter configuration)")


def _check_schedule(req: ScheduleIn) -> None:
    bad = [x for x in req.presets if x not in PRESETS] + [x for x in [*req.rules, *req.exclude] if x not in RULES]
    if bad:
        raise HTTPException(400, f"unknown presets or rules: {', '.join(bad)}")


@router.get("/sweep-schedules")
def list_schedules() -> list[dict]:
    with _db() as con:
        scheds = [json.loads(r) for (r,) in con.execute("SELECT record FROM sweep_schedules").fetchall()]
        for s in scheds:
            s["recent_sweeps"] = [json.loads(r) for (r,) in con.execute("SELECT record FROM sweeps WHERE schedule_id = ? ORDER BY queued_at DESC LIMIT 10", (s["id"],)).fetchall()]
            s["rule_scope"] = rule_scope(s)
    return scheds


@router.post("/sweep-schedules")
def create_schedule(req: ScheduleIn) -> dict:
    _check_admin()
    _check_schedule(req)
    s = {"id": "sweep-" + uuid.uuid4().hex[:10], **req.model_dump(), "created_at": _iso(), "created_by": _me()}
    _put_schedule(s)
    return s


@router.put("/sweep-schedules/{sid}")
def update_schedule(sid: str, req: ScheduleIn) -> dict:
    _check_admin()
    _check_schedule(req)
    s = {**_schedule(sid), **req.model_dump(), "updated_at": _iso()}
    _put_schedule(s)
    return s


@router.delete("/sweep-schedules/{sid}")
def delete_schedule(sid: str) -> dict:
    _check_admin()
    _schedule(sid)
    with _db() as con:
        con.execute("DELETE FROM sweep_schedules WHERE id = ?", (sid,))
    return {"deleted": sid}


@router.post("/sweep-schedules/{sid}/run")
def trigger(sid: str) -> dict:
    """Run a sweep now (in the background); returns the queued sweep."""
    _schedule(sid)
    principal = auth.current()

    def work() -> None:
        token = auth._principal.set(principal)
        try:
            run_sweep(sid, "manual")
        finally:
            auth._principal.reset(token)

    threading.Thread(target=work, daemon=True).start()
    return {"queued": sid, "at": _iso()}
