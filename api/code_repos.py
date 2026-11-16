"""Code Repositories: Python transforms over datasets, like Foundry's Code Repositories app.

Repository model (Git-like, kept as JSON):
- branches, each with a working copy (autosaved edits) and a head commit; one default branch ("master").
  Protected branches cannot be edited or committed to directly: work on a sandbox branch and open a pull
  request. Reset discards uncommitted changes; Merge brings another branch in.
- commits (every file, a message and its parent commits), tags (immutable names for commits; the root
  `repoSettings.json` can hold {"tagNameValidation": {"regex", "errorMessage"}} and "prDescriptionTemplate").
- pull requests: source → target branch, reviews (approve / reject + comment), comments, merge as squash,
  merge commit or fast-forward (allowed modes and required approvals / checks in the repository settings).
  Merges are three-way per file; a file changed differently on both sides is a conflict to fix on the source.
- checks: run on every commit in the background (transforms load, files compile, unit tests pass).

Transforms are declared with a small `transforms.api` and run on pandas DataFrames:

    from transforms.api import transform_df, Input, Output

    @transform_df(Output("clean_customers"), customers=Input("My Project/Datapipeline/customers.parquet"))
    def compute(customers):
        return customers.drop_duplicates(["customer_id"])

`@transform(out=Output(...), src=Input(...))` gets TransformInput / TransformOutput objects (and `ctx`, a
TransformContext, when the function has a `ctx` parameter). Other kinds of transforms (see code_runner.py):
- incremental: `@incremental(semantic_version=1, snapshot_inputs=[...], require_incremental=False)` above
  @transform / @transform_df processes only rows appended to its inputs since the last build and appends to its
  output; the per-input state (rows processed + content hash) is kept per branch in incremental.json;
- media sets: `@transform(images=MediaSetInput("path"), out=Output(...), pngs=MediaSetOutput("path"))` read and
  write media sets, which are folders in Files (as Pipeline Builder's media set outputs are);
- Foundry's current Python API (code_pyapi.py): @transform.using (single node: Polars, pandas, DuckDB) and
  @transform.spark.using (PySpark), several outputs, files, parameters, data expectations, abort_job, resources
  (the memory limit is enforced here; metrics are sampled for every build), meta.yaml environments resolved by
  code_env.py, and Python libraries published by tags (python_libraries(), the Artifacts app);
- SQL: .sql files holding CREATE TABLE `/path/output` AS SELECT … FROM `/path/input` (code_sql.py, SQLite);
- Java: Foundry's Transforms Java on Spark local mode (code_java.py, api/java_api; a JDK 17 and pyspark): a
  PipelineDefiner registers high- and low-level transforms (automatic or manual registration), with incremental
  read ranges / write modes, file systems, TransformContext, @MaxAllowedDuration and JUnit tests; Java UDFs
  (YAML definitions, generated classes, examples) publish to Pipeline Builder through tags (/tools/udfs).
Unit tests are
`test_*` functions in files named `test_*.py` or `*_test.py`. An Input is a Parquet dataset in Files, by item id
or path; an Output is a dataset name (optionally with folder=...). Builds on the default branch write to
My Project / Code Repositories / <repo> (or the folder given); builds on another branch write to
<that folder> / _branches / <branch>, so a sandbox never overwrites production data. Every build is a
dataset transaction (dataset_versions.py) and is read by Data Lineage (lineage.py).

User code runs in a separate Python process (code_runner.py) with a time limit and without the API's
secrets, but it is still arbitrary code on this machine: the API must not be reachable from outside.

Also here: the SQL scratchpad (SQLite over datasets), file diffs, the Libraries list, AIP features (explain,
find bugs, error enhancer via pipeline_ai.chat) and transform schedules (every N minutes and/or when an
input dataset changes and/or on a cron expression in a time zone, with retries; scheduled builds use the default
branch's last commit and can also be started with "run now").

Data in data/code-repos/<repo id>/: repo.json, commits/<id>.json, builds.json, checks.json, prs.json, incremental.json.
Mounted under /api/code-repos.
"""

from __future__ import annotations

import logging
import difflib
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Optional
from zoneinfo import ZoneInfo

import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

import auth
import dataset_versions
import db
import drive
import ontology
import pipeline_ai
import code_env
import code_envs
import code_lint
import code_java
import code_r
import code_java_templates
import code_py_templates
import code_gradle_tasks
import media_sets
import pipeline_datasets

log = logging.getLogger("bluesandai.code_repos")
# called after a tag is created: (repo id, tag) → a release summary or None
TAG_HOOKS: list = []
router = APIRouter(prefix="/api/code-repos")
# Foundry's Artifacts API for published Python libraries (download them from outside: conda / mamba channels)
artifacts_router = APIRouter(prefix="/api/artifacts")
DIR: Path = Path()
RUNNER = Path(__file__).with_name("code_runner.py")
TIMEOUT = 300
MAX_FILE_BYTES = 512 * 1024
BUILDS_KEPT = 300
CHECKS_KEPT = 200
SQL_ROWS = 1000
SQL_SOURCE_ROWS = 200_000
SQL_SECONDS = 30
SCHEDULE_TICK = 30
MEDIA_MAX_ITEMS = 5000
MEDIA_MAX_BYTES = 2 * 1024 ** 3
PATH_OK = re.compile(r"^[A-Za-z0-9_.\- ]+(/[A-Za-z0-9_.\- ]+)*$")
BRANCH_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
_lock = threading.RLock()

DEFAULT_SETTINGS = {
    "protected_branches": [],
    "require_approval": False,
    "require_no_rejections": True,
    "require_checks": False,
    "merge_modes": ["squash", "merge", "fast_forward"],
    "require_commit_message": True,
    # repository upgrades: open upgrade pull requests and merge them once their checks pass
    "auto_merge_upgrades": False,
}

REPO_SETTINGS = """{
    "tagNameValidation": {
        "regex": "^(0|[1-9]\\\\d*)\\\\.(0|[1-9]\\\\d*)\\\\.(0|[1-9]\\\\d*)(-rc\\\\d+)?$",
        "errorMessage": "Tag name must have the format x.x.x or x.x.x-rcx"
    },
    "prDescriptionTemplate": "## What changed\\n\\n## Why\\n\\n## How it was tested\\n"
}
"""


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "code-repos"
    DIR.mkdir(parents=True, exist_ok=True)
    code_envs.configure(data_dir)
    auth.RESOURCE_PROJECT_HOOKS["code_repo"] = repo_project


def startup() -> None:
    threading.Thread(target=_scheduler, daemon=True, name="code-repo-schedules").start()
    threading.Thread(target=_migrate_quietly, daemon=True, name="code-repo-projects").start()


# ------------------------------------------------------------------------------------------------
# every repository is in a Project (Foundry: repositories live in Projects; the Project's roles govern them)
# ------------------------------------------------------------------------------------------------

# the Project repositories made before Projects (and those created through the API without one) are put in: a
# default Project (cannot be renamed or trashed) whose roles start as "Everyone → Editor", the access these
# repositories had before (markings only), until its Owners tighten them
DEFAULT_PROJECT_NAME = "Code repositories (migrated)"
DEFAULT_PROJECT_SYSTEM = "code-repos"
_default_project_id: Optional[str] = None
_default_lock = threading.Lock()


def _default_marker() -> Path:
    return DIR / "_default_project.json"


def default_project(create: bool = True) -> Optional[str]:
    """The id of the default Project for repositories; with create=False only when it is already known (no database
    call: the middleware asks this on every request)."""
    global _default_project_id
    if _default_project_id:
        return _default_project_id
    marker = ontology._read(_default_marker(), None) or {}
    if marker.get("project_id") and marker.get("system") == DEFAULT_PROJECT_SYSTEM:
        _default_project_id = marker["project_id"]
        return _default_project_id
    if not create:
        return None
    with _default_lock:
        if _default_project_id:
            return _default_project_id
        item = db.drive_by_system(DEFAULT_PROJECT_SYSTEM)
        pid = item["id"] if item else drive._insert_container(None, "project", drive._free_name(None, DEFAULT_PROJECT_NAME), DEFAULT_PROJECT_SYSTEM)
        seeded = False
        # roles once per data directory (its auth store): Everyone → Editor, as before; Owners are the administrators
        # until someone is given the Owner role in Files
        if not auth.project_roles(pid):
            with auth._lock, auth._db() as con:
                con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, 'everyone', '*', 'editor') "
                            "ON CONFLICT DO NOTHING", (pid,))
            auth._roles_cache.pop(pid, None)
            auth._project_cache.clear()
            seeded = True
        ontology._write(_default_marker(), {"project_id": pid, "system": DEFAULT_PROJECT_SYSTEM, "created_at": _now(), "roles_seeded": seeded})
        log.warning("code repositories: default Project %s%s", pid, " (roles: Everyone → Editor)" if seeded else "")
        _default_project_id = pid
        return pid


def migrate_projects() -> dict:
    """One-time and idempotent: every repository without a Project is put in the default Project (nothing else in it
    changes, its updated_at included). Returns {project_id, moved: [repo ids], already: n}."""
    pid = default_project()
    moved, already = [], 0
    with _lock:
        for p in sorted(DIR.glob("*/repo.json")):
            rec = _read(p.parent.name, "repo.json", None)
            if not rec:
                continue
            if rec.get("project_id"):
                already += 1
                continue
            rec["project_id"] = pid
            rec["project_migrated_at"] = _now()
            _write(rec["id"], "repo.json", rec)
            moved.append(rec["id"])
    if moved:
        log.warning("code repositories: %d put in the default Project %s", len(moved), pid)
    return {"project_id": pid, "moved": moved, "already": already}


def _migrate_quietly() -> None:
    for attempt in range(10):
        try:
            if not db.enabled():
                return
            migrate_projects()
            return
        except Exception:  # noqa: BLE001 - the database may still be starting
            log.exception("code repositories: Project migration failed (attempt %d)", attempt + 1)
            time.sleep(30)


# ------------------------------------------------------------------------------------------------
# repository owners (Foundry: "most settings can be adjusted by repository owners"): the Owners of the repository's
# Project, plus the owners recorded on the repository itself. Repositories put in the default Project have no Owner
# there but the administrators (its roles are Everyone → Editor), so they get owners of their own: the creator while
# still active, else the Owners of the Project. Given by migrate_owners, run by an administrator (never on its own).
# ------------------------------------------------------------------------------------------------


def _caller_owns(rec: dict, principal: Optional[dict] = None) -> bool:
    """Whether the caller is one of the owners recorded on the repository (a user, or a member of a group)."""
    p = principal if principal is not None else auth.current()
    if not p or p.get("service"):
        return False
    groups = set(p.get("groups") or [])
    for o in rec.get("owners") or []:
        if (o.get("type") == "user" and o.get("id") == p.get("id")) or (o.get("type") == "group" and o.get("id") in groups):
            return True
    return False


def can_manage(rec: dict) -> bool:
    """Owner-level actions (settings, artifacts, external systems) for the caller: an Owner of the repository's Project
    (administrators, sign-in off) or one of the repository's owners."""
    project = rec.get("project_id") or default_project(create=False)
    return _caller_owns(rec) or not project or auth.role_for(project) == "owner"


def _check_owner(rec: dict) -> None:
    """Owner-level actions, as auth.check_resource("code_repo", id, "owner"): 404 when the caller cannot see the
    repository (its markings, a role on its Project), 403 when they see it without being an owner."""
    if not auth.visible_resources("code_repo", [rec]):
        raise HTTPException(404, "repository not found")
    if _caller_owns(rec):
        return
    try:
        auth.check_resource("code_repo", rec["id"], "owner")
    except HTTPException as e:
        if e.status_code != 403 or not isinstance(e.detail, str):
            raise
        owners = ", ".join(_owner_name(o) for o in rec.get("owners") or [])
        raise HTTPException(403, f"{e.detail}. Changing a repository's settings, artifacts or external systems needs the Owner role on its "
                                 f"Project or being one of the repository's owners ({owners or 'none recorded: administrators'})",
                            headers=e.headers) from None


OWNER_SOURCES = ("creator", "first-committer", "folder-creator", "project-owners")
# audit-log events that author a repository's content (commits carry no author of their own)
_AUTHORING_EVENTS = {"CODE_REPOSITORIES_POST_CODE_REPOS_COMMITS", "CODE_REPOSITORIES_PUT_CODE_REPOS_FILES",
                     "CODE_REPOSITORIES_POST_CODE_REPOS_MERGE", "CODE_REPOSITORIES_POST_CODE_REPOS_PULLS_MERGE",
                     "CODE_REPOSITORIES_POST_CODE_REPOS_COMMITS_RESTORE"}


def _first_authors(repo_ids: set[str]) -> dict[str, tuple[str, str]]:
    """{repo id: (user id, time)}: who first committed to / saved files in each repository, from the audit log (the
    only place a commit's author is kept; it covers what happened since the audit log was kept)."""
    out: dict[str, tuple[str, str]] = {}
    try:
        import audit3

        events = audit3.lines(datetime(2000, 1, 1, tzinfo=timezone.utc), datetime.now(timezone.utc) + timedelta(days=1))
        for line in events:
            name = line.get("name") or ""
            if name not in _AUTHORING_EVENTS:
                continue
            if line.get("result") not in (None, "SUCCESS") or not line.get("uid"):
                continue
            for e in line.get("entities") or []:
                rid = e.get("id")
                if e.get("type") == "repo" and rid in repo_ids:
                    t = str(line.get("time") or "")
                    if rid not in out or t < out[rid][1]:
                        out[rid] = (line["uid"], t)
    except Exception:  # noqa: BLE001 - no audit log: the source resolves nothing
        log.exception("code repositories: reading the audit log for repository authors failed")
    return out


def _output_folders() -> dict[str, dict]:
    """{repository name: its default output folder in Files (Files & Projects/<code folder>/<name>)}: who made it."""
    try:
        root = db.drive_by_system("code") if db.enabled() else None
        return {c["name"]: c for c in db.drive_list(root["id"]) if c["kind"] == "folder" and not c.get("trashed_at")} if root else {}
    except Exception:  # noqa: BLE001 - no database: the source resolves nothing
        log.exception("code repositories: reading the output folders failed")
        return {}


def _active_user(user_id: Optional[str]) -> Optional[dict]:
    label = auth.user_label(user_id) if user_id and user_id != "local" else None
    return label if label and label["status"] == "active" else None


def _owner_plan(rec: dict, default_pid: Optional[str], authors: Optional[dict] = None, folders: Optional[dict] = None) -> dict:
    """The owners the migration gives a repository, the first source that names an active user:
    creator (repo.json created_by) → first committer (audit log: first commit / file save) → the creator of its output
    folder in Files → the Owners of its Project (users and groups with the Owner role) → none: administrators only.
    (A repository has no Files item of its own, so there is no "Files item creator" to ask.)"""
    project = rec.get("project_id") or default_pid
    tried = []
    creator = rec.get("created_by")
    label = _active_user(creator)
    if label:
        return {"owners": [{"type": "user", "id": creator}], "rule": "creator", "detail": label["username"]}
    tried.append(f"creator {auth.user_label(creator)['username']} {auth.user_label(creator)['status']}" if creator and creator != "local" else "no recorded creator")
    first = (authors or {}).get(rec["id"])
    label = _active_user(first[0]) if first else None
    if label:
        return {"owners": [{"type": "user", "id": first[0]}], "rule": "first-committer", "detail": f"{label['username']} at {first[1]}; {tried[0]}"}
    tried.append(f"first committer {first[0]} not active" if first else "no commit in the audit log")
    folder = (folders or {}).get(rec.get("name"))
    label = _active_user(folder.get("created_by")) if folder else None
    if label:
        return {"owners": [{"type": "user", "id": folder["created_by"]}], "rule": "folder-creator",
                "detail": f"{label['username']} made output folder {folder['id']}; {'; '.join(tried)}"}
    tried.append("no output folder" if not folder else "output folder without an active creator")
    roles = auth.project_roles(project) if project else []
    owners = [{"type": r["principal_type"], "id": r["principal_id"]} for r in roles
              if r["role"] == "owner" and r["principal_type"] in ("user", "group")]
    names = []
    for o in owners:
        names.append(((auth.user_label(o["id"]) or {}).get("username") or o["id"]) if o["type"] == "user" else f"group {o['id']}")
    return {"owners": owners, "rule": "project-owners" if owners else "administrators",
            "detail": f"{'; '.join(tried)}; Project owners: {', '.join(names) if names else 'none (administrators only)'}"}


def migrate_owners(dry_run: bool = True) -> dict:
    """Gives owners to the repositories in the default Project that have none (those migrated by migrate_projects or
    created there before owners were recorded). dry_run (the default) changes nothing and returns the plan:
    {default_project_id, dry_run, repos: [{id, name, project_id, created_by, owners, rule, detail}], already: n,
     by_rule: {rule: n}, unresolved: [ids left to administrators]}.
    Only adds: a repository that has owners (or was decided before: administrators only) is never changed again, and
    nothing else in repo.json changes (updated_at included). An applied run is logged (bluesandai.code_repos, one line
    per repository), recorded in code-repos/_owners_migration.json and written to the audit log."""
    default_pid = default_project(create=False)
    plan, already = [], 0
    with _lock:
        recs = []
        for p in sorted(DIR.glob("*/repo.json")):
            rec = _read(p.parent.name, "repo.json", None)
            if not rec or not rec.get("id"):
                continue
            project = rec.get("project_id")
            if project and project != default_pid:
                continue  # a repository in a Project of its own: that Project's Owners own it
            if rec.get("owners") or rec.get("owners_rule"):
                already += 1  # owners given (or decided: administrators only) before
                continue
            recs.append(rec)
        authors = _first_authors({r["id"] for r in recs}) if recs else {}
        folders = _output_folders() if recs else {}
        for rec in recs:
            o = _owner_plan(rec, default_pid, authors, folders)
            plan.append({"id": rec["id"], "name": rec.get("name"), "project_id": rec.get("project_id") or default_pid,
                         "created_by": rec.get("created_by"), "migrated_at": rec.get("project_migrated_at"), **o})
            if not dry_run:
                # updated_at stays: giving owners is not a change of the repository
                rec["owners"] = o["owners"]
                rec["owners_rule"] = o["rule"]
                rec["owners_migrated_at"] = _now()
                _write(rec["id"], "repo.json", rec)
                log.warning("code repositories: owners of %s (%s): %s by %s (%s)", rec["id"], rec.get("name"),
                            ", ".join(f"{x['type']}:{x['id']}" for x in o["owners"]) or "administrators only", o["rule"], o["detail"])
    by_rule: dict[str, int] = {}
    for x in plan:
        by_rule[x["rule"]] = by_rule.get(x["rule"], 0) + 1
    out = {"default_project_id": default_pid, "dry_run": dry_run, "repos": plan, "already": already, "by_rule": by_rule,
           "unresolved": [x["id"] for x in plan if not x["owners"]]}
    if not dry_run and plan:
        log.warning("code repositories: owners given to %d repositories (%s)", len(plan), ", ".join(f"{k} {v}" for k, v in sorted(by_rule.items())))
        record = ontology._read(DIR / "_owners_migration.json", None) or {"runs": []}
        record["runs"].append({"at": _now(), "by": auth.actor_id(), "by_rule": by_rule,
                               "repos": [{"id": x["id"], "owners": x["owners"], "rule": x["rule"]} for x in plan]})
        ontology._write(DIR / "_owners_migration.json", record)
        try:
            auth.audit("code_repo_owners_migration", None, f"{len(plan)} repositories: " + ", ".join(f"{k} {v}" for k, v in sorted(by_rule.items())))
        except Exception:  # noqa: BLE001 - auditing never fails the migration
            log.exception("code repositories: auditing the owners migration failed")
    return out


@router.post("/tools/owners-migration")
def owners_migration(dry_run: bool = True) -> dict:
    """Administrators: give owners to the repositories in the default Project (migrate_owners). dry_run=true (the
    default) only lists them."""
    auth.require_admin()
    return migrate_owners(dry_run=dry_run)


def _now() -> str:
    return ontology._now()


def _repo_dir(repo_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", repo_id):
        raise HTTPException(404, "repository not found")
    return DIR / repo_id


def _read(repo_id: str, name: str, default: Any) -> Any:
    return ontology._read(_repo_dir(repo_id) / name, default)


def _write(repo_id: str, name: str, data: Any) -> None:
    path = _repo_dir(repo_id) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    ontology._write(path, data)


def _files_hash(files: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]


def _repo(repo_id: str) -> dict:
    rec = _read(repo_id, "repo.json", None)
    if not rec:
        raise HTTPException(404, "repository not found")
    # repositories made before branches: one "master" branch holding the old working copy
    if "branches" not in rec:
        head = rec.get("commits", [{}])[0].get("id") if rec.get("commits") else None
        rec["default_branch"] = "master"
        rec["branches"] = {"master": {"name": "master", "head": head, "files": rec.pop("files", {}), "created_at": rec["created_at"],
                                      "updated_at": rec.get("updated_at")}}
        rec["commit_index"] = [{**c, "parents": [], "branch": "master"} for c in rec.pop("commits", [])]
        rec.pop("head_hash", None)
    rec.setdefault("tags", [])
    rec.setdefault("settings", dict(DEFAULT_SETTINGS))
    rec.setdefault("schedules", [])
    for k, v in DEFAULT_SETTINGS.items():
        rec["settings"].setdefault(k, v)
    return rec


def _save(rec: dict) -> dict:
    rec["updated_at"] = _now()
    _write(rec["id"], "repo.json", rec)
    return rec


def _branch(rec: dict, name: Optional[str]) -> dict:
    name = name or rec["default_branch"]
    b = rec["branches"].get(name)
    if not b:
        raise HTTPException(404, f'no branch "{name}"')
    return b


def _commit_files(repo_id: str, commit_id: Optional[str]) -> dict[str, str]:
    if not commit_id:
        return {}
    data = _read(repo_id, f"commits/{commit_id}.json", None) if re.fullmatch(r"[0-9a-f]+", commit_id) else None
    if not data:
        raise HTTPException(404, f"commit {commit_id} not found")
    return data["files"]


def _commit_meta(rec: dict, commit_id: Optional[str]) -> Optional[dict]:
    return next((c for c in rec["commit_index"] if c["id"] == commit_id), None)


def _branch_summary(rec: dict, b: dict) -> dict:
    head = _commit_meta(rec, b["head"])
    checks = _checks(rec["id"])
    check = next((c for c in checks if c["commit"] == b["head"]), None) if b["head"] else None
    committed = _commit_files(rec["id"], b["head"]) if b["head"] else {}
    open_pr = next((p for p in _prs(rec["id"]) if p["source"] == b["name"] and p["status"] == "open"), None)
    return {
        "name": b["name"],
        "head": head,
        "dirty": _files_hash(b["files"]) != _files_hash(committed),
        "protected": b["name"] in rec["settings"]["protected_branches"],
        "default": b["name"] == rec["default_branch"],
        "created_from": b.get("created_from"),
        "created_at": b.get("created_at"),
        "updated_at": b.get("updated_at"),
        "check": {k: check[k] for k in ("id", "status", "at")} if check else None,
        "pull_request": {k: open_pr[k] for k in ("id", "title", "status", "target")} if open_pr else None,
    }


def _project_for(project_id: Optional[str]) -> Optional[str]:
    """A Project to put a repository in: it must be a Project the caller edits."""
    if not project_id:
        return None
    import db

    item = db.drive_get(project_id)
    if not item or item.get("kind") != "project":
        raise HTTPException(400, "choose a Project")
    auth.check_project(project_id, "editor")
    return project_id


def repo_project(repo_id: str) -> Optional[str]:
    """The Project of a repository (auth.RESOURCE_PROJECT_HOOKS); one the migration has not reached yet is in the
    default Project already."""
    rec = _read(repo_id, "repo.json", None)
    if not rec:
        return None
    return rec.get("project_id") or default_project(create=False)


def _new_repo_project(project_id: Optional[str]) -> Optional[str]:
    """The Project a new repository goes in: the one chosen (Editor there), else the default Project (Editor there)."""
    if project_id:
        return _project_for(project_id)
    try:
        pid = default_project()
    except Exception:  # noqa: BLE001 - no database: the migration puts it in the default Project later
        log.exception("code repositories: no default Project")
        return None
    auth.check_project(pid, "editor")
    return pid


_project_names: dict[str, tuple[float, str]] = {}


def _project_name(project_id: Optional[str]) -> Optional[str]:
    if not project_id:
        return None
    hit = _project_names.get(project_id)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    try:
        name = (db.drive_get(project_id) or {}).get("name") or project_id
    except Exception:  # noqa: BLE001 - no database
        name = project_id
    _project_names[project_id] = (time.time(), name)
    return name


_owner_names: dict[str, tuple[float, str]] = {}


def _owner_name(o: dict) -> str:
    """A repository owner's username (a group: its id)."""
    if o.get("type") != "user":
        return f"group {o.get('id')}"
    hit = _owner_names.get(o["id"])
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    try:
        name = (auth.user_label(o["id"]) or {}).get("username") or o["id"]
    except Exception:  # noqa: BLE001 - no auth store
        name = o["id"]
    _owner_names[o["id"]] = (time.time(), name)
    return name


def _summary(rec: dict) -> dict:
    builds = _builds(rec["id"])
    default = rec["branches"][rec["default_branch"]]
    project = rec.get("project_id") or default_project(create=False)
    return {
        "id": rec["id"], "name": rec["name"], "description": rec.get("description", ""), "created_at": rec["created_at"],
        "project_id": project, "project_name": _project_name(project), "my_role": auth.role_for(project) if project else None,
        "owners": [{**o, "name": _owner_name(o)} for o in rec.get("owners") or []],
        "can_manage": can_manage(rec),
        "updated_at": rec.get("updated_at"), "default_branch": rec["default_branch"], "settings": rec["settings"],
        "branch_count": len(rec["branches"]), "tag_count": len(rec["tags"]),
        "open_prs": sum(1 for p in _prs(rec["id"]) if p["status"] == "open"),
        "file_count": len(default["files"]), "last_build": builds[0] if builds else None, "build_count": len(builds),
        "last_commit": _commit_meta(rec, default["head"]), "dirty": _branch_summary(rec, default)["dirty"],
        "schedules": rec["schedules"],
    }


def _repo_settings_file(files: dict[str, str]) -> dict:
    try:
        return json.loads(files.get("repoSettings.json") or "{}")
    except ValueError:
        return {}


# ------------------------------------------------------------------------------------------------
# repositories
# ------------------------------------------------------------------------------------------------


class RepoIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=2000)
    # language templates include Python, R, Java transforms, and Java libraries/UDFs
    template: Literal["python", "python-library", "r", "java", "excel", "udf", "keyed_udf", "model-training", "model-adapter-library", "model-evaluator-library",
                      "typescript-functions"] = "python"
    # the Project whose roles govern the repository (Viewer reads, Editor changes, Owner manages settings and deletes);
    # left out on create: the default Project. A repository always stays in a Project
    project_id: Optional[str] = None


def _sample_input() -> str:
    """A dataset path for the example transform: the newest Parquet file in Files, if any."""
    try:
        import workshop

        ds = workshop.datasets()
        if ds:
            return "/".join([*(p["name"] for p in ds[0].get("path") or []), ds[0]["name"]])
    except Exception:  # noqa: BLE001
        pass
    return "My Project/Datapipeline/my_dataset.parquet"


@router.get("")
def list_repos() -> list[dict]:
    out = []
    for p in DIR.glob("*/repo.json"):
        try:
            out.append(_summary(_repo(p.parent.name)))
        except HTTPException:
            pass
    out = auth.visible_resources("code_repo", out)
    return sorted(out, key=lambda r: r["updated_at"] or "", reverse=True)


@router.get("/tools/projects")
def repo_projects() -> dict:
    """The Projects a repository can be created in or moved to (Editor or Owner there), and the default Project."""
    try:
        default = default_project()
    except Exception:  # noqa: BLE001 - no database
        default = None
    out = []
    try:
        items = db.drive_list(None)
    except Exception:  # noqa: BLE001
        items = []
    for i in items:
        if i.get("kind") != "project":
            continue
        role = auth.role_for(i["id"])
        if role in ("editor", "owner"):
            out.append({"id": i["id"], "name": i["name"], "my_role": role, "default": i["id"] == default})
    return {"projects": out, "default_project_id": default}


@router.post("")
def create_repo(req: RepoIn) -> dict:
    name = (req.name or "transforms-python").strip()
    if not PATH_OK.match(name) or "/" in name:
        raise HTTPException(400, "a repository name may hold letters, digits, spaces, - _ and .")
    with _lock:
        now = _now()
        if req.template == "r":
            files = code_r.template_files(name, REPO_SETTINGS, _sample_input())
        elif req.template == "java":
            files = code_java_templates.java_files(name, REPO_SETTINGS)
        elif req.template == "udf":
            files = code_java_templates.udf_files(name, REPO_SETTINGS)
        elif req.template == "python-library":
            files = code_py_templates.library_files(name, REPO_SETTINGS)
        elif req.template in ("model-training", "model-adapter-library", "model-evaluator-library"):
            # Model Integration templates (code_model_templates.py)
            import code_model_templates

            files = (code_model_templates.model_training_files(name, REPO_SETTINGS, _sample_input()) if req.template == "model-training"
                     else code_model_templates.adapter_library_files(name, REPO_SETTINGS) if req.template == "model-adapter-library"
                     else code_model_templates.evaluator_library_files(name, REPO_SETTINGS))
        elif req.template == "keyed_udf":
            files = code_java_templates.keyed_udf_files(name, REPO_SETTINGS)
        elif req.template == "excel":
            files = code_java_templates.excel_files(name, REPO_SETTINGS)
        elif req.template == "typescript-functions":
            # TypeScript v2 functions (code_ts_templates.py; run by functions_ts.py)
            import code_ts_templates

            files = code_ts_templates.ts_functions_files(name, REPO_SETTINGS)
        else:
            files = code_py_templates.python_files(name, REPO_SETTINGS, _sample_input())
        rec = {
            "id": ontology._new_id("repo"), "name": name, "description": (req.description or "").strip(), "created_at": now,
            "default_branch": "master",
            "branches": {"master": {"name": "master", "head": None, "files": files, "created_at": now, "updated_at": now}},
            "commit_index": [], "tags": [], "settings": dict(DEFAULT_SETTINGS), "schedules": [],
            "project_id": _new_repo_project(req.project_id), "created_by": auth.actor_id(),
        }
        if req.template == "excel":
            rec["settings"]["artifacts"] = [code_java.EXCEL_BUNDLE]
        if rec["created_by"] and rec["project_id"] and rec["project_id"] == default_project(create=False):
            # the default Project has no Owners but the administrators: its creator owns a repository made there
            rec["owners"] = [{"type": "user", "id": rec["created_by"]}]
            rec["owners_rule"] = "creator"
        _save(rec)
        _commit(rec, "master", "Initial commit")
        return get_repo(rec["id"])


@router.get("/{repo_id}")
def get_repo(repo_id: str, branch: Optional[str] = None) -> dict:
    rec = _repo(repo_id)
    b = _branch(rec, branch)
    return {**_summary(rec), "branch": _branch_summary(rec, b), "files": b["files"],
            "branches": [_branch_summary(rec, x) for x in rec["branches"].values()]}


@router.patch("/{repo_id}")
def update_repo(repo_id: str, req: RepoIn) -> dict:
    with _lock:
        rec = _repo(repo_id)
        if req.name:
            rec["name"] = req.name.strip()
        if req.description is not None:
            rec["description"] = req.description.strip()
        if req.project_id is not None and req.project_id != (rec.get("project_id") or default_project(create=False)):
            if not req.project_id:
                raise HTTPException(400, "a repository stays in a Project: choose the Project to move it to")
            # moving a repository needs owning it where it is (and editing where it goes)
            auth.check_resource("code_repo", repo_id, "owner")
            rec["project_id"] = _project_for(req.project_id)
        _save(rec)
        return _summary(rec)


@router.delete("/{repo_id}")
def delete_repo(repo_id: str) -> dict:
    """Deletes the repository (Owners of its Project); datasets its builds wrote stay in Files."""
    _repo(repo_id)
    auth.check_resource("code_repo", repo_id, "owner")
    shutil.rmtree(_repo_dir(repo_id), ignore_errors=True)
    return {"deleted": repo_id}


class SettingsIn(BaseModel):
    default_branch: Optional[str] = None
    protected_branches: Optional[list[str]] = None
    require_approval: Optional[bool] = None
    require_no_rejections: Optional[bool] = None
    require_checks: Optional[bool] = None
    merge_modes: Optional[list[Literal["squash", "merge", "fast_forward"]]] = None
    require_commit_message: Optional[bool] = None
    auto_merge_upgrades: Optional[bool] = None


@router.put("/{repo_id}/settings")
def save_settings(repo_id: str, req: SettingsIn) -> dict:
    """Branch protection, merge modes, default branch: Owners of the repository's Project or the repository's owners
    (Foundry: repository owners)."""
    with _lock:
        rec = _repo(repo_id)
        _check_owner(rec)
        changes = req.model_dump(exclude_unset=True)
        if changes.get("default_branch"):
            _branch(rec, changes["default_branch"])
            rec["default_branch"] = changes.pop("default_branch")
        changes.pop("default_branch", None)
        if "merge_modes" in changes and not changes["merge_modes"]:
            raise HTTPException(400, "allow at least one merge mode")
        for k in changes.get("protected_branches") or []:
            _branch(rec, k)
        rec["settings"].update({k: v for k, v in changes.items() if v is not None})
        _save(rec)
        return _summary(rec)


# ------------------------------------------------------------------------------------------------
# branches, files and commits
# ------------------------------------------------------------------------------------------------


def _editable(rec: dict, b: dict) -> None:
    if b["name"] in rec["settings"]["protected_branches"]:
        raise HTTPException(403, f'"{b["name"]}" is a protected branch: create a branch and propose your changes in a pull request')


class FilesPut(BaseModel):
    branch: Optional[str] = None
    # the whole working copy: path -> content
    files: dict[str, str]


def _check_files(files: dict[str, str]) -> None:
    for path, content in files.items():
        if not PATH_OK.match(path) or ".." in path.split("/"):
            raise HTTPException(400, f'"{path}" is not a valid file path')
        if len(content.encode()) > MAX_FILE_BYTES:
            raise HTTPException(413, f"{path} is larger than {MAX_FILE_BYTES // 1024} KB")


@router.put("/{repo_id}/files")
def save_files(repo_id: str, req: FilesPut) -> dict:
    """Autosave of a branch's working copy (not a commit)."""
    _check_files(req.files)
    with _lock:
        rec = _repo(repo_id)
        b = _branch(rec, req.branch)
        _editable(rec, b)
        b["files"] = req.files
        b["updated_at"] = _now()
        _save(rec)
        return _branch_summary(rec, b)


class BranchIn(BaseModel):
    name: str
    # branch or commit id to start from; default the default branch
    source: Optional[str] = None


@router.post("/{repo_id}/branches")
def create_branch(repo_id: str, req: BranchIn) -> dict:
    name = req.name.strip()
    if not BRANCH_OK.match(name) or ".." in name:
        raise HTTPException(400, "a branch name may hold letters, digits, . _ - and /")
    with _lock:
        rec = _repo(repo_id)
        if name in rec["branches"]:
            raise HTTPException(409, f'branch "{name}" already exists')
        src = req.source or rec["default_branch"]
        if src in rec["branches"]:
            head = rec["branches"][src]["head"]
        elif _commit_meta(rec, src):
            head = src
        else:
            raise HTTPException(404, f'no branch or commit "{src}"')
        now = _now()
        rec["branches"][name] = {"name": name, "head": head, "files": _commit_files(repo_id, head), "created_from": src,
                                 "created_at": now, "updated_at": now}
        _save(rec)
        return _branch_summary(rec, rec["branches"][name])


@router.delete("/{repo_id}/branches/{name:path}")
def delete_branch(repo_id: str, name: str) -> dict:
    with _lock:
        rec = _repo(repo_id)
        _branch(rec, name)
        if name == rec["default_branch"]:
            raise HTTPException(400, "the default branch cannot be deleted")
        if name in rec["settings"]["protected_branches"]:
            raise HTTPException(400, "unprotect the branch before deleting it")
        del rec["branches"][name]
        _save(rec)
        return {"deleted": name}


class BranchOp(BaseModel):
    branch: str


@router.post("/{repo_id}/reset")
def reset_branch(repo_id: str, req: BranchOp) -> dict:
    """Discard uncommitted changes: the working copy becomes the branch's last commit again."""
    with _lock:
        rec = _repo(repo_id)
        b = _branch(rec, req.branch)
        b["files"] = _commit_files(repo_id, b["head"])
        b["updated_at"] = _now()
        _save(rec)
        return get_repo(repo_id, b["name"])


def _commit(rec: dict, branch: str, message: str, parents: Optional[list[str]] = None, files: Optional[dict] = None) -> dict:
    b = rec["branches"][branch]
    if files is not None:
        b["files"] = files
    c = {"id": hashlib.sha1(f"{rec['id']}{branch}{time.time_ns()}".encode()).hexdigest()[:10], "message": message, "at": _now(),
         "hash": _files_hash(b["files"]), "files": len(b["files"]), "branch": branch,
         "parents": parents if parents is not None else ([b["head"]] if b["head"] else [])}
    _write(rec["id"], f"commits/{c['id']}.json", {"commit": c, "files": b["files"]})
    rec["commit_index"] = [c, *rec["commit_index"]]
    b["head"] = c["id"]
    b["updated_at"] = c["at"]
    _save(rec)
    threading.Thread(target=_run_checks_logged, args=(rec["id"], c["id"], branch), daemon=True).start()
    return c


class CommitIn(BaseModel):
    branch: Optional[str] = None
    message: str = Field("", max_length=500)


@router.post("/{repo_id}/commits")
def commit(repo_id: str, req: CommitIn) -> dict:
    with _lock:
        rec = _repo(repo_id)
        b = _branch(rec, req.branch)
        _editable(rec, b)
        if _files_hash(b["files"]) == _files_hash(_commit_files(repo_id, b["head"])):
            raise HTTPException(400, "nothing to commit: no changes since the last commit")
        message = req.message.strip()
        if not message:
            if rec["settings"]["require_commit_message"]:
                raise HTTPException(400, "write a commit message")
            message = f"Update {', '.join(_changed_paths(_commit_files(repo_id, b['head']), b['files'])[:3])}"
        return _commit(rec, b["name"], message)


def _history(rec: dict, head: Optional[str]) -> list[dict]:
    """Commits reachable from head, newest first."""
    seen, order, queue = set(), [], [head] if head else []
    while queue:
        cid = queue.pop(0)
        if cid in seen:
            continue
        seen.add(cid)
        meta = _commit_meta(rec, cid)
        if meta:
            order.append(meta)
            queue += meta.get("parents") or []
    return sorted(order, key=lambda c: c["at"], reverse=True)


@router.get("/{repo_id}/commits")
def commits(repo_id: str, branch: Optional[str] = None) -> list[dict]:
    rec = _repo(repo_id)
    return _history(rec, _branch(rec, branch)["head"])


@router.get("/{repo_id}/commits/{commit_id}")
def get_commit(repo_id: str, commit_id: str) -> dict:
    rec = _repo(repo_id)
    if not _commit_meta(rec, commit_id):
        raise HTTPException(404, "commit not found")
    return {"commit": _commit_meta(rec, commit_id), "files": _commit_files(repo_id, commit_id)}


class RestoreIn(BaseModel):
    branch: Optional[str] = None


@router.post("/{repo_id}/commits/{commit_id}/restore")
def restore_commit(repo_id: str, commit_id: str, req: RestoreIn) -> dict:
    """Make a commit's files a branch's working copy (commit afterwards to record it)."""
    with _lock:
        rec = _repo(repo_id)
        b = _branch(rec, req.branch)
        _editable(rec, b)
        if not _commit_meta(rec, commit_id):
            raise HTTPException(404, "commit not found")
        b["files"] = _commit_files(repo_id, commit_id)
        _save(rec)
        return get_repo(repo_id, b["name"])


def _changed_paths(a: dict[str, str], b: dict[str, str]) -> list[str]:
    return sorted(p for p in set(a) | set(b) if a.get(p) != b.get(p))


def _diff(a: dict[str, str], b: dict[str, str]) -> list[dict]:
    out = []
    for p in _changed_paths(a, b):
        old, new = a.get(p), b.get(p)
        lines = list(difflib.unified_diff((old or "").splitlines(), (new or "").splitlines(), f"a/{p}", f"b/{p}", lineterm="", n=3))
        out.append({"path": p, "status": "added" if old is None else "deleted" if new is None else "modified",
                    "additions": sum(1 for x in lines if x.startswith("+") and not x.startswith("+++")),
                    "deletions": sum(1 for x in lines if x.startswith("-") and not x.startswith("---")),
                    "diff": "\n".join(lines[2:]), "old": old, "new": new})
    return out


def _resolve(rec: dict, ref: str, working: bool) -> dict[str, str]:
    """Files of a branch (its working copy, or its last commit) or of a commit / tag."""
    if ref in rec["branches"]:
        b = rec["branches"][ref]
        return b["files"] if working else _commit_files(rec["id"], b["head"])
    tag = next((t for t in rec["tags"] if t["name"] == ref), None)
    if tag:
        return _commit_files(rec["id"], tag["commit"])
    return _commit_files(rec["id"], ref)


@router.get("/{repo_id}/diff")
def diff(repo_id: str, base: str, head: str, working: bool = False) -> list[dict]:
    """File changes from base to head (refs: branch, tag or commit; working=True compares head's working copy)."""
    rec = _repo(repo_id)
    return _diff(_resolve(rec, base, False), _resolve(rec, head, working))


@router.get("/{repo_id}/changes")
def changes(repo_id: str, branch: Optional[str] = None) -> list[dict]:
    """Uncommitted changes on a branch (File changes helper)."""
    rec = _repo(repo_id)
    b = _branch(rec, branch)
    return _diff(_commit_files(repo_id, b["head"]), b["files"])


# ------------------------------------------------------------------------------------------------
# tags
# ------------------------------------------------------------------------------------------------


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # branch (its last commit) or commit id
    ref: str
    message: str = Field("", max_length=500)


@router.post("/{repo_id}/tags")
def create_tag(repo_id: str, req: TagIn) -> dict:
    with _lock:
        rec = _repo(repo_id)
        name = req.name.strip()
        if not BRANCH_OK.match(name):
            raise HTTPException(400, "a tag name may hold letters, digits, . _ - and /")
        if any(t["name"] == name for t in rec["tags"]):
            raise HTTPException(409, f'tag "{name}" already exists (tags are immutable)')
        rule = _repo_settings_file(rec["branches"][rec["default_branch"]]["files"]).get("tagNameValidation")
        if rule and rule.get("regex"):
            try:
                ok = re.search(rule["regex"], name)
            except re.error:
                ok = True
            if not ok:
                raise HTTPException(400, rule.get("errorMessage") or f"tag name must match {rule['regex']}")
        commit_id = rec["branches"][req.ref]["head"] if req.ref in rec["branches"] else req.ref
        if not _commit_meta(rec, commit_id):
            raise HTTPException(404, f'no branch or commit "{req.ref}"')
        tag = {"name": name, "commit": commit_id, "message": req.message.strip(), "at": _now()}
        rec["tags"] = [tag, *rec["tags"]]
        _save(rec)
    # a semantic version tag publishes the repository's functions (functions_registry.py)
    for hook in TAG_HOOKS:
        res = hook(repo_id, tag)
        if res:
            tag = {**tag, "functions_release": res}
    return tag


@router.get("/{repo_id}/tags")
def tags(repo_id: str) -> list[dict]:
    rec = _repo(repo_id)
    return [{**t, "commit_meta": _commit_meta(rec, t["commit"])} for t in rec["tags"]]


# ------------------------------------------------------------------------------------------------
# merging and pull requests
# ------------------------------------------------------------------------------------------------


def _ancestors(rec: dict, head: Optional[str]) -> list[str]:
    """head and its ancestors, nearest first (breadth first)."""
    order, seen, queue = [], set(), [head] if head else []
    while queue:
        cid = queue.pop(0)
        if cid in seen:
            continue
        seen.add(cid)
        order.append(cid)
        queue += (_commit_meta(rec, cid) or {}).get("parents") or []
    return order


def _merge_base(rec: dict, a: Optional[str], b: Optional[str]) -> Optional[str]:
    mine = set(_ancestors(rec, a))
    return next((c for c in _ancestors(rec, b) if c in mine), None)


def _three_way(base: dict, ours: dict, theirs: dict) -> tuple[dict, list[str]]:
    """Merge per file: a file changed on one side only takes that side; changed differently on both is a conflict."""
    out, conflicts = {}, []
    for p in sorted(set(base) | set(ours) | set(theirs)):
        b, o, t = base.get(p), ours.get(p), theirs.get(p)
        if o == t:
            v = o
        elif o == b:
            v = t
        elif t == b:
            v = o
        else:
            conflicts.append(p)
            v = o
        if v is not None:
            out[p] = v
    return out, conflicts


def merge_preview(rec: dict, source: str, target: str) -> dict:
    s, t = _branch(rec, source), _branch(rec, target)
    base = _merge_base(rec, s["head"], t["head"])
    files, conflicts = _three_way(_commit_files(rec["id"], base), _commit_files(rec["id"], t["head"]), _commit_files(rec["id"], s["head"]))
    return {
        "base": base,
        "up_to_date": s["head"] == t["head"] or s["head"] in _ancestors(rec, t["head"]),
        "fast_forward": not t["head"] or t["head"] in _ancestors(rec, s["head"]),
        "conflicts": conflicts,
        "files": files,
        "changes": _diff(_commit_files(rec["id"], t["head"]), files),
    }


def _do_merge(rec: dict, source: str, target: str, mode: str, message: str, fix_on: Optional[str] = None) -> dict:
    s, t = _branch(rec, source), _branch(rec, target)
    if _files_hash(t["files"]) != _files_hash(_commit_files(rec["id"], t["head"])):
        raise HTTPException(409, f'"{target}" has uncommitted changes: commit or reset them first')
    m = merge_preview(rec, source, target)
    if m["up_to_date"]:
        raise HTTPException(400, f'"{target}" already has every change on "{source}"')
    if m["conflicts"]:
        raise HTTPException(409, "conflicts in " + ", ".join(m["conflicts"]) + f': both branches changed them. Edit them on "{fix_on or source}"'
                                 f" so they hold the version you want, commit, and merge again")
    if mode == "fast_forward":
        if not m["fast_forward"]:
            raise HTTPException(400, f'"{target}" has commits that "{source}" does not: fast-forward is not possible')
        t["head"] = s["head"]
        t["files"] = _commit_files(rec["id"], s["head"])
        _save(rec)
        return _commit_meta(rec, s["head"])
    parents = [t["head"]] + ([s["head"]] if mode == "merge" else [])
    return _commit(rec, target, message, [p for p in parents if p], m["files"])


class MergeIn(BaseModel):
    # merge `source` into `branch` (to update a branch from another)
    branch: str
    source: str


@router.post("/{repo_id}/merge")
def merge_branch(repo_id: str, req: MergeIn) -> dict:
    with _lock:
        rec = _repo(repo_id)
        _editable(rec, _branch(rec, req.branch))
        c = _do_merge(rec, req.source, req.branch, "merge", f'Merge branch "{req.source}" into "{req.branch}"', fix_on=req.branch)
        return {"commit": c, **get_repo(repo_id, req.branch)}


def _prs(repo_id: str) -> list[dict]:
    return _read(repo_id, "prs.json", [])


def _pr(repo_id: str, pr_id: str) -> tuple[list[dict], dict]:
    prs = _prs(repo_id)
    pr = next((p for p in prs if p["id"] == pr_id), None)
    if not pr:
        raise HTTPException(404, "pull request not found")
    return prs, pr


def _pr_status(rec: dict, pr: dict) -> dict:
    """What the merge needs and whether it is met."""
    s = rec["settings"]
    reviews = pr.get("reviews", [])
    approvals = [r for r in reviews if r["verdict"] == "approve"]
    rejections = [r for r in reviews if r["verdict"] == "reject"]
    src = rec["branches"].get(pr["source"])
    check = next((c for c in _checks(rec["id"]) if src and c["commit"] == src["head"]), None)
    preview = merge_preview(rec, pr["source"], pr["target"]) if src and pr["target"] in rec["branches"] else None
    blockers = []
    if pr["status"] != "open":
        blockers.append(f"the pull request is {pr['status']}")
    if not src:
        blockers.append("the source branch was deleted")
    protected = pr["target"] in s["protected_branches"]
    if protected and s["require_approval"] and not approvals:
        blockers.append("needs at least one approval")
    if protected and s["require_no_rejections"] and rejections:
        blockers.append("a reviewer rejected the changes")
    if protected and s["require_checks"] and (not check or check["status"] != "passed"):
        blockers.append("checks must pass on the latest commit" + (f" (they {check['status']})" if check else " (not run yet)"))
    if preview and preview["conflicts"]:
        blockers.append("conflicts in " + ", ".join(preview["conflicts"]))
    if preview and preview["up_to_date"] and pr["status"] == "open":
        blockers.append("nothing to merge")
    if src and _files_hash(src["files"]) != _files_hash(_commit_files(rec["id"], src["head"])):
        blockers.append(f'"{pr["source"]}" has uncommitted changes (they are not part of the pull request until committed)')
    return {"approvals": len(approvals), "rejections": len(rejections), "check": check, "blockers": blockers,
            "can_merge": not [b for b in blockers if "uncommitted" not in b],
            "fast_forward": bool(preview and preview["fast_forward"]), "conflicts": preview["conflicts"] if preview else []}


class PrIn(BaseModel):
    source: str
    target: Optional[str] = None
    title: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=10000)


@router.get("/{repo_id}/pulls")
def list_prs(repo_id: str) -> list[dict]:
    rec = _repo(repo_id)
    return [{**p, "state": _pr_status(rec, p)} for p in sorted(_prs(repo_id), key=lambda p: p["created_at"], reverse=True)]


@router.post("/{repo_id}/pulls")
def create_pr(repo_id: str, req: PrIn) -> dict:
    with _lock:
        rec = _repo(repo_id)
        target = req.target or rec["default_branch"]
        _branch(rec, req.source)
        _branch(rec, target)
        if req.source == target:
            raise HTTPException(400, "pick a different target branch")
        prs = _prs(repo_id)
        if any(p["source"] == req.source and p["target"] == target and p["status"] == "open" for p in prs):
            raise HTTPException(409, "a pull request for these branches is already open")
        pr = {"id": str(1 + max([int(p["id"]) for p in prs] or [0])), "source": req.source, "target": target, "title": req.title.strip(),
              "description": req.description, "status": "open", "reviews": [], "comments": [], "created_at": _now(), "updated_at": _now()}
        _write(repo_id, "prs.json", [*prs, pr])
        return {**pr, "state": _pr_status(rec, pr)}


@router.get("/{repo_id}/pulls/{pr_id}")
def get_pr(repo_id: str, pr_id: str) -> dict:
    rec = _repo(repo_id)
    _, pr = _pr(repo_id, pr_id)
    src = rec["branches"].get(pr["source"])
    if pr["status"] == "merged":
        changes_ = _diff(_commit_files(repo_id, pr.get("base_commit")), _commit_files(repo_id, pr.get("merged_commit")))
        commits_ = []
    else:
        base = _merge_base(rec, src["head"], rec["branches"][pr["target"]]["head"]) if src and pr["target"] in rec["branches"] else None
        changes_ = _diff(_commit_files(repo_id, base), _commit_files(repo_id, src["head"])) if src else []
        commits_ = [c for c in _history(rec, src["head"]) if c["id"] not in set(_ancestors(rec, base))] if src else []
    return {**pr, "state": _pr_status(rec, pr), "changes": changes_, "commits": commits_}


class ReviewIn(BaseModel):
    verdict: Literal["approve", "reject", "comment"]
    comment: str = Field("", max_length=5000)
    # optional: a comment on one line of one file
    path: Optional[str] = None
    line: Optional[int] = None


@router.post("/{repo_id}/pulls/{pr_id}/reviews")
def review_pr(repo_id: str, pr_id: str, req: ReviewIn) -> dict:
    with _lock:
        prs, pr = _pr(repo_id, pr_id)
        if pr["status"] != "open":
            raise HTTPException(400, f"the pull request is {pr['status']}")
        entry = {"verdict": req.verdict, "comment": req.comment.strip(), "at": _now(), "path": req.path, "line": req.line}
        if req.verdict == "comment":
            if not entry["comment"]:
                raise HTTPException(400, "write a comment")
            pr["comments"].append(entry)
        else:
            # one standing review: a new verdict replaces the previous one
            pr["reviews"] = [entry]
            if entry["comment"]:
                pr["comments"].append(entry)
        pr["updated_at"] = _now()
        _write(repo_id, "prs.json", prs)
        return get_pr(repo_id, pr_id)


class PrMerge(BaseModel):
    mode: Literal["squash", "merge", "fast_forward"] = "squash"
    message: Optional[str] = None


@router.post("/{repo_id}/pulls/{pr_id}/merge")
def merge_pr(repo_id: str, pr_id: str, req: PrMerge) -> dict:
    with _lock:
        rec = _repo(repo_id)
        prs, pr = _pr(repo_id, pr_id)
        if req.mode not in rec["settings"]["merge_modes"]:
            raise HTTPException(400, f"merge mode {req.mode} is not allowed in this repository")
        state = _pr_status(rec, pr)
        if not state["can_merge"]:
            raise HTTPException(409, "cannot merge: " + "; ".join(state["blockers"]))
        base = rec["branches"][pr["target"]]["head"]
        c = _do_merge(rec, pr["source"], pr["target"], req.mode, (req.message or f"{pr['title']} (#{pr['id']})").strip())
        pr.update(status="merged", merged_at=_now(), merge_mode=req.mode, merged_commit=c["id"], base_commit=base, updated_at=_now())
        _write(repo_id, "prs.json", prs)
        return get_pr(repo_id, pr_id)


class PrState(BaseModel):
    status: Literal["open", "closed"]


@router.post("/{repo_id}/pulls/{pr_id}/state")
def set_pr_state(repo_id: str, pr_id: str, req: PrState) -> dict:
    with _lock:
        prs, pr = _pr(repo_id, pr_id)
        if pr["status"] == "merged":
            raise HTTPException(400, "a merged pull request cannot change")
        pr.update(status=req.status, updated_at=_now())
        _write(repo_id, "prs.json", prs)
        return get_pr(repo_id, pr_id)


@router.get("/{repo_id}/pulls/{pr_id}/impact")
def pr_impact(repo_id: str, pr_id: str) -> dict:
    """Datasets the pull request affects: outputs of transforms in changed files, with schema changes from a
    preview on the source branch against the dataset as last built (or "new" when never built)."""
    rec = _repo(repo_id)
    _, pr = _pr(repo_id, pr_id)
    src = _branch(rec, pr["source"])
    target_files = _commit_files(repo_id, rec["branches"][pr["target"]]["head"])
    changed = set(_changed_paths(target_files, _commit_files(repo_id, src["head"])))
    listed = _run(_commit_files(repo_id, src["head"]), {"mode": "list"}, rec)
    affected = []
    builds = _builds(repo_id)
    for t in listed.get("transforms", []):
        if t["file"] not in changed:
            continue
        entry: dict[str, Any] = {"transform": t["key"], "output": t["output"]["name"], "file": t["file"]}
        built = next((b for b in builds if b["transform"] == t["key"] and b["status"] == "succeeded" and b.get("branch", rec["default_branch"]) == pr["target"]), None)
        entry["dataset"] = built["output"] if built else None
        entry["stale"] = bool(built and built.get("commit") != rec["branches"][pr["target"]]["head"])
        try:
            _, items = _prepare_from(listed, t["key"])
            res = _run(_commit_files(repo_id, src["head"]), {"mode": "preview", "transform": t["key"], "limit": 5, **_input_spec(t, items)}, rec)
            new_cols = {c["name"]: c["type"] for c in res.get("columns") or []}
            old_cols = {c["name"]: c["type"] for c in (built["output"].get("columns") or [])} if built else {}
            entry["ok"] = res.get("ok", False)
            entry["error"] = res.get("error")
            entry["rows"] = res.get("rows")
            entry["schema"] = {
                "added": [c for c in new_cols if c not in old_cols],
                "removed": [c for c in old_cols if c not in new_cols],
                "changed": [c for c in new_cols if c in old_cols and old_cols[c] != new_cols[c]],
            } if built else None
        except HTTPException as e:
            entry.update(ok=False, error=str(e.detail))
        affected.append(entry)
    return {"changed_files": sorted(changed), "affected": affected, "errors": listed.get("errors", [])}


# ------------------------------------------------------------------------------------------------
# running code
# ------------------------------------------------------------------------------------------------


def resolve_dataset(ref: str) -> dict:
    """A Files dataset by item id, or by path ("My Project/Datapipeline/x.parquet", optionally starting
    with "Files & Projects/"; the .parquet extension may be left out)."""
    drive._require_db()
    ref = (ref or "").strip()
    if re.fullmatch(r"[0-9a-f]{16}", ref):
        item = db.drive_get(ref)
        if item and not item.get("trashed_at") and item["kind"] == "file":
            return item
    parts = [p for p in ref.split("/") if p]
    if parts and parts[0] == "Files & Projects":
        parts = parts[1:]
    parent: Optional[str] = None
    item = None
    for i, name in enumerate(parts):
        children = [c for c in db.drive_list(parent) if not c.get("trashed_at")]
        item = next((c for c in children if c["name"] == name), None)
        if not item and i == len(parts) - 1:
            item = next((c for c in children if c["kind"] == "file" and c["name"].rsplit(".", 1)[0] == name), None)
        if not item:
            raise ValueError(f'Input "{ref}": no "{name}" in {"/".join(parts[:i]) or "Files & Projects"}')
        parent = item["id"]
    if not item or item["kind"] != "file":
        raise ValueError(f'Input "{ref}" is not a dataset file')
    return item


def resolve_media_set(ref: str) -> dict:
    """A media set: a folder in Files, by item id or path ("My Project/Media/scans")."""
    drive._require_db()
    ref = (ref or "").strip()
    if re.fullmatch(r"[0-9a-f]{16}", ref):
        item = db.drive_get(ref)
        if item and not item.get("trashed_at") and item["kind"] in drive.CONTAINERS:
            return item
    parts = [p for p in ref.split("/") if p]
    if parts and parts[0] == "Files & Projects":
        parts = parts[1:]
    parent: Optional[str] = None
    item = None
    for i, name in enumerate(parts):
        item = next((c for c in db.drive_list(parent) if not c.get("trashed_at") and c["kind"] in drive.CONTAINERS and c["name"] == name), None)
        if not item:
            raise ValueError(f'MediaSetInput "{ref}": no folder "{name}" in {"/".join(parts[:i]) or "Files & Projects"}')
        parent = item["id"]
    if not item:
        raise ValueError(f'MediaSetInput "{ref}" names no folder')
    return item


def _media_files(folder_id: str, versions: bool = False) -> list[dict]:
    """A media set's items (virtual ones included); with `versions` also its overwritten and deleted items."""
    if media_sets.is_media_set(folder_id):
        return media_sets.list_files(folder_id) + (media_sets.versions_of(folder_id) if versions else [])
    return _plain_media_files(folder_id)


def _plain_media_files(folder_id: str) -> list[dict]:
    return sorted((c for c in db.drive_list(folder_id) if c["kind"] == "file" and not c.get("trashed_at")), key=lambda c: c["name"])


def _media_version(folder_id: str) -> str:
    """Changes when a media set's items change (for "when an input changes" schedules)."""
    items = _media_files(folder_id)
    return f"{max((str(i.get('updated_at')) for i in items), default='')}:{len(items)}"


def _folder_path(parent: Optional[str], parts: list[str]) -> str:
    for name in parts:
        found = next((c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and c["name"] == name and not c.get("trashed_at")), None)
        if not found:
            if parent is None:
                raise ValueError(f'no project "{name}"')
            found = drive._item(drive._insert_container(parent, "folder", name))
        parent = found["id"]
    return parent  # type: ignore[return-value]


def _output_folder(rec: dict, folder: Optional[str], branch: str) -> str:
    if folder:
        parts = [p for p in folder.split("/") if p]
        if parts and parts[0] == "Files & Projects":
            parts = parts[1:]
        if not parts:
            raise ValueError("an output folder must be inside a project")
        base = _folder_path(None, parts)
    else:
        root = drive.default_folder("code")
        found = next((c for c in db.drive_list(root) if c["kind"] == "folder" and c["name"] == rec["name"]), None)
        base = found["id"] if found else drive._insert_container(root, "folder", drive._free_name(root, rec["name"]))
    if branch != rec["default_branch"]:
        base = _folder_path(base, ["_branches", *branch.split("/")])
    return base


METRICS_INTERVAL = 0.5


ENV_LOCKS_KEPT = 30


def _environment(files: dict[str, str], rec: Optional[dict] = None) -> Optional[dict]:
    """The resolved conda_recipe/meta.yaml (code_env.resolve), or None without one. With the repository: library
    versions are locked per meta.yaml (env-lock.json), so an unpinned library keeps the version it was first resolved
    to until meta.yaml changes; `dedicated_status` says whether its repository environment is built."""
    path = code_env.meta_path(files)
    if not path:
        return None
    text = files[path]
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]
    locks = _read(rec["id"], "env-lock.json", {}) if rec else {}
    locked = (locks.get(digest) or {}).get("libraries")
    libs, denied = _readable_libraries(rec)
    res = code_env.resolve(text, libs, locked, denied)
    chosen = {lib["name"]: lib["version"] for lib in res.get("libraries") or []}
    if rec and chosen and not res["errors"] and chosen != locked:
        with _lock:
            locks = _read(rec["id"], "env-lock.json", {})
            locks[digest] = {"libraries": chosen, "at": _now()}
            _write(rec["id"], "env-lock.json", dict(sorted(locks.items(), key=lambda kv: kv[1].get("at") or "")[-ENV_LOCKS_KEPT:]))
    if res.get("dedicated"):
        res["dedicated_status"] = code_envs.status(res["dedicated"])
    return {**res, "file": path, "locked": bool(locked)}


def _sample(proc_pid: int, seen: dict) -> tuple[float, float]:
    """(resident memory in MB, CPU cores in use) of a process and its children. `seen` keeps the psutil handles
    between calls: CPU use is measured since the previous call on the same handle."""
    import psutil

    try:
        root = seen.get(proc_pid) or seen.setdefault(proc_pid, psutil.Process(proc_pid))
        procs = [root, *(seen.setdefault(c.pid, c) for c in root.children(recursive=True))]
    except psutil.Error:
        return 0.0, 0.0
    mem = cpu = 0.0
    for pr in procs:
        try:
            mem += pr.memory_info().rss / 1024 ** 2
            cpu += pr.cpu_percent(None) / 100
        except psutil.Error:
            pass
    return mem, cpu


def _run(files: dict[str, str], spec: dict, rec: Optional[dict] = None, on_stream: Optional[Callable[[dict], None]] = None) -> dict:
    """Run code_runner.py over a set of repository files in a temporary folder (`rec`: the repository they are from,
    whose Settings → Artifacts resolve the shared Java code its build.gradle files depend on). `on_stream` receives
    each chunk a streaming function yields, while it runs."""
    if rec is not None and code_java.project_coordinates(files):
        spec["java_deps"], spec["java_dep_errors"] = _java_deps(rec, files)
    with tempfile.TemporaryDirectory(prefix="coderepo-") as tmp:
        root = Path(tmp)
        for path, content in files.items():
            p = root / "repo" / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, "utf-8")
        # published Python libraries the repository requires (meta.yaml) go on sys.path
        lib_paths = []
        env = None
        try:
            env = _environment(files, rec)
        except Exception:  # noqa: BLE001 - a broken meta.yaml fails Checks, not the run
            env = None
        try:
            # the repository's own environment (built with uv the first time) or the API's; a debug job names an
            # earlier one (transforms_common.py)
            python = spec.pop("python_executable", None) or code_envs.python_for((env or {}).get("dedicated"))
        except code_envs.EnvError as e:
            return {"ok": False, "error": f"The repository environment could not be installed: {e}", "logs": "",
                    "environment": {k: (env or {}).get(k) for k in ("python", "libraries", "warnings", "dedicated")}}
        for lib in (env or {}).get("libraries") or []:
            d = root / "libs" / lib["name"]
            if lib.get("artifact"):
                # a Conda / PyPI package of a backing Artifacts repository: unpacked for sys.path
                import artifact_repos

                lib_paths.append(str(artifact_repos.extract_library(lib["artifact"], d / "src")))
                continue
            for path, content in _commit_files(lib["repo_id"], lib["commit"]).items():
                if path in lib["files"]:
                    f = d / path
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_text(content, "utf-8")
            lib_paths.append(str(d / "src"))
        if lib_paths:
            spec["library_paths"] = lib_paths
        # R transforms: the shared R package library and renv cache
        spec["r_library"] = str(code_envs.DIR / "r-library")
        spec["renv_root"] = str(code_envs.DIR / "renv")
        jars, _ = code_env.spark_jars(files, test=spec.get("mode") == "test")
        if jars:
            # JARs a Python dependency needs on Spark's classpath (graphframes, spark-nlp); Ivy caches the downloads
            spec["spark_jars"] = jars
            spec["ivy_dir"] = str(code_envs.DIR / "ivy")
        inputs: dict[str, str] = {}
        for name, item_id in (spec.get("input_items") or {}).items():
            dest = root / "inputs" / f"{name}.parquet"
            dest.parent.mkdir(exist_ok=True)
            dest.write_bytes(drive.read_bytes(db.drive_get(item_id)))
            inputs[name] = str(dest)
        media: dict[str, dict] = {}
        total = 0
        # transforms that list overwritten media items (deduplicate_by_path=False) get them too
        with_versions = any("deduplicate_by_path=False" in v for v in files.values())
        for name, folder_id in (spec.pop("media_folders", None) or {}).items():
            listed = _media_files(folder_id, with_versions)
            # markings per media item: a build reads only the items its user may see (as Files lists them)
            files_ = auth.visible([f for f in listed if f.get("id")]) + [f for f in listed if not f.get("id")]
            hidden = len(listed) - len(files_)
            total += sum(int(f.get("size_bytes") or 0) for f in files_)
            if len(files_) > MEDIA_MAX_ITEMS or total > MEDIA_MAX_BYTES:
                raise HTTPException(413, f"media set {name} is too large for a code build ({len(files_)} items)")
            d = root / "media" / name
            d.mkdir(parents=True)
            items = []
            for i, f in enumerate(files_):
                dest = d / str(i)
                media_sets.copy_to(f, dest)
                items.append({"id": f["id"], "path": f["name"], "file": str(dest), "size": f.get("size_bytes"),
                              "content_type": f.get("content_type"), "updated_at": str(f.get("updated_at")), "folder_id": folder_id,
                              **({"overwritten": True} if f.get("overwritten") else {})})
            media[name] = {"items": items, **({"hidden_by_markings": hidden} if hidden else {})}
        previous = spec.pop("previous_output_item", None)
        if previous:
            (root / "previous.parquet").write_bytes(drive.read_bytes(db.drive_get(previous)))
            spec["previous_output"] = str(root / "previous.parquet")
        prev_outputs = {}
        for i, (param, item_id) in enumerate((spec.pop("previous_output_items", None) or {}).items()):
            dest = root / f"previous-{i}.parquet"
            dest.write_bytes(drive.read_bytes(db.drive_get(item_id)))
            prev_outputs[param] = str(dest)
        if prev_outputs:
            spec["previous_outputs"] = prev_outputs
        timeout = int(spec.get("timeout_s") or TIMEOUT)
        mem_limit = (spec.get("resources") or {}).get("memory_mb")
        # user code calls the API as the user who started it (a schedule: its creator), for this run only
        job_token = auth.issue_job_token(spec.pop("run_as", None), timeout + 120, f"code build {spec.get('transform') or spec.get('mode')}") \
            if spec.get("mode") in ("build", "preview", "function", "invoke") else None
        api_url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000")
        spec = {**spec, "repo": str(root / "repo"), "inputs": inputs, "media_inputs": media, "out": str(root / "out.parquet"),
                "media_out": str(root / "media-out"), "api_url": spec.get("api_url") or api_url, "api_token": job_token or ""}
        (root / "spec.json").write_text(json.dumps(spec), "utf-8")
        env_vars = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        env_vars["PYTHONUTF8"] = "1"  # user code reads and writes UTF-8 by default, as on Linux
        env_vars["BLUESANDAI_API_URL"] = api_url
        if job_token:
            env_vars["BLUESANDAI_API_TOKEN"] = job_token
        if rec is not None:
            # time series queries (FoundryTS, function-backed series) are metered against the repository
            env_vars["BLUESANDAI_USAGE_RESOURCE"] = f"code_repo:{rec['id']}"
        stdout, stderr = root / "stdout.txt", root / "stderr.txt"
        samples: list[list[float]] = []
        killed = None
        started = time.monotonic()
        try:
            with open(stdout, "w", encoding="utf-8") as out_f, open(stderr, "w", encoding="utf-8") as err_f:
                proc = subprocess.Popen([python, str(RUNNER), str(root / "spec.json")], stdout=out_f, stderr=err_f, cwd=str(root), env=env_vars)
                handles: dict = {}
                _sample(proc.pid, handles)
                stream_pos = [0]

                def drain() -> None:
                    sp = root / "stream.jsonl"
                    if on_stream is None or not sp.exists():
                        return
                    with open(sp, "r", encoding="utf-8") as f:
                        f.seek(stream_pos[0])
                        while True:
                            line = f.readline()
                            if not line.endswith("\n"):
                                break
                            stream_pos[0] = f.tell()
                            try:
                                on_stream(json.loads(line))
                            except ValueError:
                                pass

                while proc.poll() is None:
                    time.sleep(0.1 if on_stream else METRICS_INTERVAL)
                    drain()
                    elapsed = time.monotonic() - started
                    mem, cpu = _sample(proc.pid, handles)
                    samples.append([round(elapsed, 2), round(mem, 1), round(cpu, 2)])
                    if elapsed > timeout:
                        killed = f"timed out after {timeout} s"
                    elif mem_limit and mem > mem_limit:
                        killed = (f"out of memory: the build used {mem:,.0f} MB, more than the {mem_limit:,} MB it requested "
                                  "(raise memory_gb / memory_mb in with_resources)")
                    if killed:
                        _kill_tree(proc.pid)
                        proc.wait(30)
                        break
                drain()
        finally:
            auth.revoke_job_token(job_token)
            if spec.get("sidecar"):
                # a killed build cannot stop its sidecar containers: remove whatever this run left
                _remove_sidecars(spec["sidecar"])
            if spec.get("container"):
                _remove_sidecars(spec["container"])
        metrics = {"interval_s": METRICS_INTERVAL, "samples": samples, "cpu_cores": (spec.get("resources") or {}).get("cpu_cores") or 2,
                   "memory_mb_limit": mem_limit, "peak_memory_mb": max((s[1] for s in samples), default=0), "peak_cores": max((s[2] for s in samples), default=0)}
        err_text = stderr.read_text("utf-8", "replace") if stderr.exists() else ""
        if killed:
            return {"ok": False, "error": killed, "logs": err_text[-4000:], "metrics": metrics, "oom": killed.startswith("out of memory")}
        result_path = root / "result.json"
        result = json.loads(result_path.read_text("utf-8")) if result_path.exists() else {
            "ok": False, "error": (err_text or "the runner stopped without a result")[-3000:]}
        result["metrics"] = metrics
        result["logs"] = (result.get("logs") or "") + (err_text[-4000:] if proc.returncode and err_text else "")
        if env:
            result["environment"] = {k: env.get(k) for k in ("python", "libraries", "warnings", "dedicated")}
        if spec["mode"] != "build":
            for o in result.get("model_outputs") or []:
                # ModelOutput preview: what publish() would create (nothing is committed)
                meta = json.loads((Path(o["dir"]) / "version.json").read_text("utf-8"))
                o["published"] = {k: meta.get(k) for k in ("model", "api", "adapter", "serializers")}
        if result.get("ok") and spec["mode"] == "build" and (root / "out.parquet").exists():
            result["parquet"] = (root / "out.parquet").read_bytes()
        if result.get("ok") and spec["mode"] == "build":
            result["media_bytes"] = {k: {"mode": v.get("mode", "modify"), "items": [(i["path"], Path(i["file"]).read_bytes(), i.get("id")) for i in v["items"]],
                                         "registrations": v.get("registrations") or []}
                                     for k, v in (result.get("media_outputs") or {}).items()}
            for o in result.get("model_outputs") or []:
                # a staged model version (model_lib.WritableModel.publish): zipped before this folder goes away
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    for f in sorted(Path(o["dir"]).rglob("*")):
                        if f.is_file():
                            z.write(f, f.relative_to(o["dir"]).as_posix())
                o["zip"] = buf.getvalue()
            for o in (result.get("multi_outputs") or {}).values():
                if o["kind"] in ("dataframe", "empty"):
                    o["bytes"] = Path(o.pop("parquet")).read_bytes()
                elif o["kind"] == "files":
                    o["files"] = [(f["path"], Path(f["file"]).read_bytes()) for f in o["files"]]
        return result


def _remove_sidecars(sc: dict) -> None:
    import container_runtime

    try:
        p = container_runtime.docker("ps", "-aq", "--filter", f"label=bluesandai.run={sc['label']}", check=False, timeout=60)
        ids = p.stdout.decode().split()
        if ids:
            container_runtime.docker("rm", "-f", *ids, check=False, timeout=120)
    except Exception:  # noqa: BLE001 - best effort
        pass
    shutil.rmtree(sc["base_dir"], ignore_errors=True)


def _kill_tree(pid: int) -> None:
    import psutil

    try:
        root = psutil.Process(pid)
        for pr in [*root.children(recursive=True), root]:
            try:
                pr.kill()
            except psutil.Error:
                pass
    except psutil.Error:
        pass


def _prepare_from(listed: dict, key: str) -> tuple[dict, dict[str, dict]]:
    t = next((x for x in listed.get("transforms", []) if x["key"] == key), None)
    if not t:
        raise HTTPException(404, f"no transform {key}; run Checks to list them")
    _require_runtime(t)
    items: dict[str, dict] = {}
    files_ok = t.get("language") == "java" or t.get("files_inputs")
    if files_ok:
        # a Java input / a Python input of Foundry's current API is a dataset, or a folder read as files
        t = {**t, "media_inputs": dict(t.get("media_inputs") or {}), "folder_inputs": []}
    for name, ref in t["inputs"].items():
        try:
            items[name] = resolve_dataset(ref)
        except ValueError as e:
            if files_ok:
                try:
                    items[name] = resolve_media_set(ref)
                    if t.get("language") == "java":
                        t["media_inputs"][name] = ref
                    else:
                        t["folder_inputs"].append(name)
                    continue
                except ValueError:
                    pass
            raise HTTPException(400, str(e)) from None
    for name, ref in (t.get("media_inputs") or {}).items():
        try:
            items[name] = resolve_media_set(ref)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
    return t, items


def _unmarked(t: dict, param: str, branch: Optional[str]) -> set[str]:
    """Markings input `param` stops propagating (stop_propagating) or requiring (stop_requiring: organizations, given
    as organization ids or org:<id> markings) on this branch."""
    out: set[str] = set()
    for rule, spec in ((t.get("unmarking") or {}).get(param) or {}).items():
        if spec.get("on_branches") is not None and branch not in spec["on_branches"]:
            continue
        for i in spec["ids"]:
            out.add(auth.org_marking(i) if rule == "stop_requiring" and not i.startswith("org:") else i)
    return out


def _input_sources(t: dict) -> list[tuple[Optional[str], str]]:
    """(input param or None for media inputs, resolved item id) of the transform's inputs: datasets, folders, media
    sets and table inputs (Iceberg and virtual tables: their markings propagate like a dataset's)."""
    out: list[tuple[Optional[str], str]] = []
    pairs = [(k, v) for k, v in (t.get("inputs") or {}).items()] + [(None, v) for v in (t.get("media_inputs") or {}).values()]
    for param, ref in pairs:
        for resolve in (resolve_dataset, resolve_media_set):
            try:
                out.append((param, resolve(ref)["id"]))
                break
            except (ValueError, HTTPException):
                continue
    for param, ref in (t.get("table_inputs") or {}).items():
        vitem = _virtual_item(ref)
        if vitem:
            out.append((param, vitem["id"]))
            continue
        try:
            out.append((param, resolve_table(ref)["id"]))
        except (ValueError, HTTPException):
            continue
    return out


def _check_unmarking(t: dict, branch: str, run_as: Optional[str] = None) -> None:
    """Removing markings in code (stop_propagating, stop_requiring, sever_permissions) is refused before the build
    writes anything unless the user running it is an administrator (markings here have no separate "remove
    marking" permission; administrators manage them)."""
    if not auth.enabled() or not (t.get("unmarking") or t.get("sever_permissions")):
        return
    removed: set[str] = set()
    for param, item_id in _input_sources(t):
        have = auth.effective_markings(item_id)
        if t.get("sever_permissions"):
            removed |= have
        elif param:
            removed |= have & _unmarked(t, param, branch)
    if not removed:
        return
    p = auth.current()
    if (p is None or p.get("service")) and run_as:
        try:
            p = auth._user(run_as)
        except HTTPException:
            p = None
    if p is not None and not p.get("service") and p.get("role") != "admin":
        names = ", ".join(auth._marking_names(sorted(removed)))
        raise ValueError(f"this transform removes the marking(s) {names} from its outputs (stop_propagating / stop_requiring / sever_permissions): "
                         "only an administrator may build it")


def _inherit_markings(output_item_id: str, t: dict, repo_id: Optional[str] = None, param: Optional[str] = None, branch: Optional[str] = None) -> None:
    """Markings propagate down the lineage: a transform's output inherits the markings of its inputs and of its
    code repository, minus what an input stops propagating / requiring; an output with sever_permissions inherits
    none of its inputs' markings."""
    sources: list[Optional[str]] = [auth.resource_id("code_repo", repo_id)] if repo_id else []
    severed = (param or t.get("output_param")) in (t.get("sever_permissions") or [])
    try:
        inherited: set[str] = set()
        for src in sources:
            inherited |= auth.effective_markings(src)
        if not severed:
            for p, item_id in _input_sources(t):
                inherited |= auth.effective_markings(item_id) - (_unmarked(t, p, branch) if p else set())
        if not t.get("unmarking") and not severed:
            auth.propagate(output_item_id, [*sources, *(i for _, i in _input_sources(t))])
        else:
            auth._set_item(output_item_id, inherited=sorted(inherited))
            auth.check_constraints(output_item_id)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - never fails the build
        log.exception("marking propagation failed for %s", output_item_id)


def _precheck_constraints(folder_id: Optional[str], existing: Optional[dict], t: dict, repo_id: Optional[str], param: Optional[str],
                          branch: Optional[str]) -> set[str]:
    """Before an output is written: the markings it would carry (its folder's and its own, and what it inherits from the
    repository and its inputs) must not violate its Project's constraints — the build is refused, nothing is written.
    Returns the markings it inherits (as _inherit_markings sets them), so the output is marked before it is written."""
    sources: list[Optional[str]] = [auth.resource_id("code_repo", repo_id)] if repo_id else []
    marks: set[str] = set()
    for src in sources:
        marks |= auth.effective_markings(src)
    if (param or t.get("output_param")) not in (t.get("sever_permissions") or []):
        for p, item_id in _input_sources(t):
            marks |= auth.effective_markings(item_id) - (_unmarked(t, p, branch) if p else set())
    target = existing["id"] if existing else folder_id
    if not target:
        return marks
    own = set(auth._item_row(existing["id"])[0]) if existing else set()
    why = auth.constraint_violation(target, marks | own | auth.file_markings(target))
    if why:
        raise HTTPException(409, f"{why}: the build is refused before writing (allow the marking, remove the input that brings it, or unmark it upstream)")
    return marks


def _write_marked_output(folder_id: str, name: str, existing: Optional[dict], data: bytes, marks: set[str]) -> dict:
    """Write a transform's dataset output so that no reader ever finds it, or reads its rows, without the markings it
    inherits (`marks`, from _precheck_constraints). An existing output first gains them (keeping the markings it
    inherited so far: its old rows were built from the old inputs) and is narrowed by _inherit_markings after the
    write. A new output's markings record is written under a fresh, unused id, then the file is stored under that id
    (as foundry_rules._create_marked_dataset does)."""
    if existing:
        auth._set_item(existing["id"], inherited=sorted(set(marks) | set(auth._item_row(existing["id"])[1])))
        pipeline_datasets._replace_content(existing, data)
        return db.drive_get(existing["id"])
    while True:
        item_id = uuid.uuid4().hex[:16]
        if not db.drive_get(item_id) and auth._item_row(item_id) == ([], []):
            break
    if marks:
        auth._set_item(item_id, inherited=sorted(marks))
    try:
        item = drive._store(folder_id, name, io.BytesIO(data), len(data), pipeline_datasets.PARQUET, item_id=item_id)
    except BaseException:
        if marks and not db.drive_get(item_id):
            auth._set_item(item_id, inherited=[])  # nothing was created: no markings record for an id nobody holds
        raise
    if item["id"] != item_id:
        # drive._store refused the id (taken meanwhile) and stored the rows under another one, unmarked: remove it at
        # once rather than leave it readable, and fail the build
        if marks:
            auth._set_item(item_id, inherited=[])
        drive._delete_contents(db.drive_delete(item["id"], drive._now()))
        raise HTTPException(500, "the transform output could not be created under its marked id: nothing was written")
    return item


# Files outputs and media set outputs are marked on BOTH levels:
# - the output folder / media set (the output resource: Foundry marks the dataset a transform writes files into and
#   the media set, never single files or items): its inherited markings cover everything in it — files the build did
#   not rewrite, a media set's virtual (registered) items and the overwritten / deleted versions it keeps, which are
#   only ever checked against the media set's markings (media_sets.resolve / _item_meta);
# - every file / media item the build writes (markings travel with the data: one moved out of the output folder keeps
#   them).
# The folder gains them before anything is written (keeping those it had: what it holds was built from the old
# inputs); it is narrowed after only when the build replaced all it held (a SNAPSHOT files output). A media set is
# never narrowed by a build: its older items and versions keep the markings of the inputs they came from.

def _gain_markings(item_id: str, marks: set[str]) -> None:
    """The item's inherited markings gain `marks` (nothing is removed)."""
    cur = set(auth._item_row(item_id)[1])
    if not set(marks) <= cur:
        auth._set_item(item_id, inherited=sorted(cur | set(marks)))


def _write_marked_file(parent: str, name: str, data: bytes, ct: str, marks: set[str], found: Optional[dict]) -> dict:
    """A file a transform writes into its files output, carrying the output's inherited markings itself: a replaced
    file gains them before its bytes change and then holds exactly them (its contents are all new); a new file is
    stored under a fresh id already carrying them."""
    import iceberg_catalog as ic

    if found:
        _gain_markings(found["id"], marks)
        pipeline_datasets._replace_content(found, data, ct)
        auth._set_item(found["id"], inherited=sorted(marks))
        return db.drive_get(found["id"]) or found
    if not marks:
        return drive._store(parent, name, io.BytesIO(data), len(data), ct)
    item_id = ic.reserve_marked_id(sorted(marks))
    try:
        item = drive._store(parent, name, io.BytesIO(data), len(data), ct, item_id=item_id)
    except BaseException:
        ic.release_marked_id(item_id)
        raise
    return ic.stored_under(item, item_id)


def _require_runtime(t: dict) -> None:
    """Language transforms are listed without their optional local runtime, but running needs it."""
    if t.get("language") == "java" and not code_java.available():
        raise HTTPException(400, code_java.NO_JDK + " (install a JDK 17 and pyspark and restart the API to build Java transforms)")
    if t.get("language") == "r" and not code_r.executable():
        raise HTTPException(400, code_r.runtime_issue())


def _input_spec(t: dict, items: dict[str, dict]) -> dict:
    """The runner spec's inputs: Parquet datasets, media set folders and folders read as files."""
    media = set(t.get("media_inputs") or {}) | set(t.get("folder_inputs") or [])
    return {"input_items": {k: v["id"] for k, v in items.items() if k not in media},
            "media_folders": {k: v["id"] for k, v in items.items() if k in media}}


def _python_spec(rec: dict, t: dict) -> dict:
    """Foundry-API Python transforms: parameters (repoSettings.json "pythonParameters": {"*": {...}, "<transform
    key>": {...}}), resources (with_resources) and the allowed run duration (@configure)."""
    params: dict = {}
    try:
        settings = json.loads(_branch(rec, None)["files"].get("repoSettings.json") or "{}")
        params = settings.get("pythonParameters") or {}
    except (ValueError, HTTPException):
        pass
    out: dict[str, Any] = {"parameters": {**(params.get("*") or {}), **(params.get(t["key"]) or {})}, "resources": t.get("resources") or {}}
    if t.get("max_duration_s"):
        out["timeout_s"] = int(t["max_duration_s"])
    elif t.get("kind") == "spark":
        out["timeout_s"] = TIMEOUT + 60
    return out


def resolve_table(ref: str) -> dict:
    """An Iceberg table by RID (ri.tables.main.table.<id>), item id or Files path ("/Project/folder/table")."""
    import iceberg_catalog as ic

    ref = (ref or "").strip()
    if ref.startswith(ic.RID_PREFIX):
        ref = ref[len(ic.RID_PREFIX):]
    if re.fullmatch(r"[0-9a-f]{16}", ref):
        item = db.drive_get(ref)
        if ic.is_table(item) and not item.get("trashed_at"):
            return item
    parts = [p for p in ref.split("/") if p]
    if parts and parts[0] == "Files & Projects":
        parts = parts[1:]
    parent: Optional[str] = None
    item = None
    for i, name in enumerate(parts):
        item = next((c for c in db.drive_list(parent) if c["name"] == name), None)
        if not item:
            raise ValueError(f'TableInput "{ref}": no "{name}" in {"/".join(parts[:i]) or "Files & Projects"}')
        parent = item["id"]
    if not ic.is_table(item):
        raise ValueError(f'TableInput "{ref}" is not an Iceberg table')
    return item


def _has_tables(t: dict) -> bool:
    return bool(t.get("table_inputs") or t.get("table_outputs"))


def _table_spec(rec: dict, t: dict, branch: str, key: str, mode: str, run_as: Optional[str] = None) -> tuple[dict, Optional[str], list[dict]]:
    """For transforms with Iceberg tables: resolves TableInput / TableOutput (a build creates missing output tables),
    and starts the job transaction its commits are staged in. Returns (runner spec, job id, table input entries for
    the build record)."""
    import iceberg_catalog as ic
    import virtual_tables as vt

    if not _has_tables(t):
        return {}, None, []
    inputs, recorded, sources = {}, [], [auth.resource_id("code_repo", rec["id"])]
    vdir = Path(tempfile.mkdtemp(prefix="vtables-"))
    virtual: dict[str, dict] = {"inputs": {}, "outputs": {}, "dir": str(vdir)}
    for param, ref in (t.get("table_inputs") or {}).items():
        vitem = _virtual_item(ref)
        if vitem:
            # a virtual table: read through its source now (Foundry-native compute)
            try:
                data = vt.read(vt.record(vitem))
            except Exception as e:  # noqa: BLE001
                raise HTTPException(400, f'TableInput "{ref}": reading the virtual table failed: {getattr(e, "detail", e)}') from None
            path = vdir / f"in-{param}.parquet"
            pq.write_table(data, path)
            virtual["inputs"][param] = {"path": str(path), "item_id": vitem["id"], "rows": data.num_rows}
            recorded.append({"name": param, "ref": ref, "item_id": vitem["id"], "item_name": vitem["name"], "updated_at": str(vitem.get("updated_at")),
                             "table": True, "virtual": True})
            sources.append(vitem["id"])
            continue
        try:
            item = resolve_table(ref)
            with ic.http_errors():
                ic.table_item(item["id"])
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        inputs[param] = {"item_id": item["id"], "rid": ic.rid(item["id"]), "namespace": ic.namespace_of(item["id"]), "name": item["name"]}
        recorded.append({"name": param, "ref": ref, "item_id": item["id"], "item_name": item["name"], "updated_at": str(item.get("updated_at")), "table": True})
        sources.append(item["id"])
    # every input's markings are recorded on the snapshots the job writes: datasets, folders and media sets too (a
    # table written from a marked media set inherits its markings); a table output the build creates carries them
    # from the moment it exists
    sources += [i for _, i in _input_sources(t)]
    markings: set[str] = set()
    for i in sources:
        markings |= auth.effective_markings(i)
    outputs = {}
    for param, o in (t.get("table_outputs") or {}).items():
        folder_id = _output_folder(rec, o.get("folder"), rec["default_branch"])
        existing = next((c for c in db.drive_list(folder_id) if c["name"] == o["name"] and not c.get("trashed_at")), None)
        if o.get("locator") or vt.is_virtual(existing):
            # a virtual table output: registered on the first build (its source and location are then fixed)
            item = existing
            if o.get("locator"):
                try:
                    item = _register_virtual_output(rec, t, folder_id, o, existing, param, branch) if mode == "build" else existing
                    if item is not None and mode != "build":
                        old = vt.record(item)
                        if old.get("locator") != o["locator"] or old.get("connection_id") != vt.connection_id(o["source"]):
                            raise vt.VirtualTableError(f'the virtual table "{o["name"]}" was created on {old.get("source")} at {old.get("locator")}: '
                                                       "its source and location cannot be changed")
                except vt.VirtualTableError as e:
                    shutil.rmtree(vdir, ignore_errors=True)
                    raise HTTPException(400, f"TableOutput {param}: {e}") from None
                except HTTPException:
                    shutil.rmtree(vdir, ignore_errors=True)
                    raise
            elif mode == "build" and not o.get("locator") and existing is None:
                raise HTTPException(400, f"TableOutput {param}: give the source and table locator to create the virtual table")
            virtual["outputs"][param] = {"path": str(vdir / f"out-{param}.parquet"), "item_id": item["id"] if item else None, "name": o["name"]}
            continue
        with ic.http_errors():
            if mode == "build" and markings and not any(c["name"] == o["name"] for c in db.drive_list(folder_id)):
                # a new table output is created already carrying the markings its snapshots will record (never
                # visible without them), once its Project's constraints allow them
                why = auth.constraint_violation(folder_id, markings | auth.file_markings(folder_id))
                if why:
                    shutil.rmtree(vdir, ignore_errors=True)
                    raise HTTPException(409, f"{why}: the build is refused before writing (allow the marking, remove the input that brings it, "
                                             "or unmark it upstream)")
                item = ic.create_table(folder_id, o["name"], branch=branch, markings=sorted(markings))
            elif mode == "build":
                item = ic.ensure_table(folder_id, o["name"], branch=branch)
            elif existing and ic.is_table(existing):
                item = existing
            else:
                item = None
            if item:
                ic.table_item(item["id"], need="editor" if mode == "build" else "viewer")
        outputs[param] = {"item_id": item["id"], "rid": ic.rid(item["id"]), "namespace": ic.namespace_of(item["id"]), "name": item["name"]} if item else None
    if mode == "build":
        # Project constraints, before the transform runs: an Iceberg output's snapshots will record `markings`, a
        # virtual table output inherits what _precheck_constraints computes for it
        try:
            for o in outputs.values():
                if o:
                    why = auth.constraint_violation(o["item_id"], markings | set(auth._item_row(o["item_id"])[0]) | auth.file_markings(o["item_id"]))
                    if why:
                        raise HTTPException(409, f"{why}: the build is refused before writing (allow the marking, remove the input that brings it, "
                                                 "or unmark it upstream)")
            for param, v in virtual["outputs"].items():
                vitem = db.drive_get(v["item_id"]) if v.get("item_id") else None
                if vitem:
                    _precheck_constraints(None, vitem, t, rec["id"], param, branch)
        except HTTPException:
            shutil.rmtree(vdir, ignore_errors=True)
            raise
    if not inputs and not outputs:
        # virtual tables only: no Iceberg job
        return {"virtual": virtual}, None, recorded
    job_id = f"build-{uuid.uuid4().hex[:12]}"
    ic.begin_job(job_id, branch, f"{rec['name']} · {t['function']}", sorted(markings),
                 {"kind": "transform", "id": f"{rec['id']}::{key}", "name": t["function"], "repo": rec["name"], "repo_id": rec["id"]},
                 [o["item_id"] for o in outputs.values() if o], run_as or auth.actor_id())
    jar = None
    if t.get("kind") == "spark":
        try:
            jar = str(code_java.iceberg_spark_jar())
        except Exception as e:  # noqa: BLE001
            ic.abort_job(job_id)
            raise HTTPException(503, f"Iceberg tables in Spark transforms need the Iceberg Spark runtime: {e}") from None
    api_url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000")
    return ({"iceberg": {"uri": f"{api_url}/api/iceberg", "job": job_id, "branch": ic.canonical_branch(branch), "inputs": inputs,
                         "outputs": outputs, "spark_jar": jar}, "virtual": virtual}, job_id, recorded)


def _register_virtual_output(rec: dict, t: dict, folder_id: str, o: dict, existing: Optional[dict], param: str, branch: str) -> dict:
    """A virtual TableOutput's item: registered on the first build, under a fresh id already carrying the markings it
    inherits (from _precheck_constraints: a Project constraint they violate refuses the build first), so it is never
    visible, nor read through its source, without them. An existing one is checked by vt.register."""
    import iceberg_catalog as ic
    import virtual_tables as vt

    if existing is not None:
        return vt.register(folder_id, o["name"], o["source"], o["locator"])
    marks = _precheck_constraints(folder_id, None, t, rec["id"], param, branch)
    if not marks:
        return vt.register(folder_id, o["name"], o["source"], o["locator"])
    # as vt.register creates it (its source and location are validated first), stored under the marked id
    conn = vt.connection_id(o["source"])
    db_, schema, table = vt.location(conn, o["locator"])
    data = json.dumps({"virtual_table": True, "connection_id": conn, "source": o["source"], "locator": o["locator"], "database": db_, "schema": schema,
                       "table": table}, indent=1).encode()
    item_id = ic.reserve_marked_id(sorted(marks))
    try:
        item = drive._store(folder_id, o["name"], io.BytesIO(data), len(data), vt.VT_TYPE, item_id=item_id)
    except BaseException:
        ic.release_marked_id(item_id)
        raise
    return db.drive_get(ic.stored_under(item, item_id)["id"])


def _virtual_item(ref: str) -> Optional[dict]:
    """The virtual table a TableInput names (a Files path, item id or ri.tables.main.table.<id>), if it is one."""
    import virtual_tables as vt

    m = re.fullmatch(r"ri\.tables\.main\.table\.([0-9a-f]{16})", (ref or "").strip())
    try:
        item = db.drive_get(m.group(1)) if m else resolve_dataset(ref)
    except (ValueError, HTTPException):
        return None
    return item if vt.is_virtual(item) else None


def _virtual_outputs(rec: dict, t: dict, b: dict, res: dict, virtual: dict) -> None:
    """After a successful build: what the transform wrote replaces each external table (through its source)."""
    import virtual_tables as vt

    b.setdefault("outputs", [])
    try:
        for param, entry in (virtual.get("outputs") or {}).items():
            path = Path(entry["path"])
            if not path.is_file():
                continue
            item = db.drive_get(entry["item_id"]) if entry.get("item_id") else None
            if not item:
                continue
            r = vt.record(item)
            # the virtual table carries the inputs' markings before its source holds the new rows (keeping those it
            # had while the old rows are replaced); narrowed to them after
            _gain_markings(item["id"], _precheck_constraints(None, item, t, rec["id"], param, b.get("branch")))
            try:
                w = vt.write(r, pq.read_table(path))
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"writing the virtual table {item['name']} to its source failed: {getattr(e, 'detail', e)}") from None
            _inherit_markings(item["id"], t, rec["id"], param, b.get("branch"))
            b["outputs"].append({"param": param, "item_id": item["id"], "name": item["name"], "path": [x["name"] for x in db.drive_path(item["id"])[:-1]],
                                 "rows": w["rows"], "columns": w["columns"], "mode": "SNAPSHOT", "table": True, "virtual": True,
                                 "location": {k: r.get(k) for k in ("database", "schema", "table")}})
            db.drive_update(item["id"], drive._now(), size_bytes=item.get("size_bytes") or 0)
        if not b.get("output"):
            first = next((o for o in b["outputs"] if o.get("virtual")), None)
            if first:
                b["output"] = {k: v for k, v in first.items() if k not in ("param", "mode")}
    finally:
        shutil.rmtree(virtual.get("dir") or "", ignore_errors=True)


def _commit_tables(job_id: Optional[str]) -> list[dict]:
    """Swap in a build's Iceberg writes (all or nothing). Raises HTTPException 409 on a conflicting concurrent change."""
    import iceberg_catalog as ic

    if not job_id:
        return []
    try:
        return ic.commit_job(job_id)
    except ic.CatalogError as e:
        raise HTTPException(e.status, e.message) from None


def _table_outputs(rec: dict, t: dict, b: dict, res: dict, committed: list[dict], outputs: dict) -> None:
    """The build record's entries for the Iceberg tables it wrote (with write_table / write_dataframe, or natively:
    PyIceberg upserts, Spark SQL MERGE INTO...); the transform becomes each table's producer (its owning job spec,
    for main branch protection)."""
    import iceberg_catalog as ic

    snaps = {c["item_id"]: c["snapshots"] for c in committed}
    b.setdefault("outputs", [])
    # virtual table outputs are written to their sources (_virtual_outputs), not to the Iceberg catalog
    reported = {k: v for k, v in (res.get("table_outputs") or {}).items() if not v.get("virtual")}
    for param, entry in (outputs or {}).items():
        if entry and param not in reported and snaps.get(entry["item_id"]):
            md = ic.raw(entry["item_id"])
            last = md.snapshot_by_id(snaps[entry["item_id"]][-1])
            total = (last.summary.additional_properties.get("total-records") if last and last.summary else None)
            reported[param] = {"item_id": entry["item_id"], "rows": int(total) if total is not None else None, "mode": "UPDATE",
                               "columns": [{"name": f.name, "type": str(f.field_type)} for f in md.schema().fields]}
    for param, w in reported.items():
        item_id = w.get("item_id")
        if not item_id:
            continue
        item = db.drive_get(item_id)
        r = ic.record(item_id)
        if not r.get("producer"):
            r["producer"] = {"kind": "transform", "id": f"{rec['id']}::{b['transform']}", "name": t["function"], "repo": rec["name"], "repo_id": rec["id"]}
            ic.save_record(r)
        b["outputs"].append({"param": param, "item_id": item_id, "name": item["name"], "path": [x["name"] for x in db.drive_path(item_id)[:-1]],
                             "rows": w.get("rows"), "columns": w.get("columns") or [], "mode": w.get("mode"), "table": True,
                             "snapshots": [str(s) for s in snaps.get(item_id, [])]})
    if not b.get("output"):
        first = next((o for o in b["outputs"] if o.get("table")), None)
        if first:
            b["output"] = {k: v for k, v in first.items() if k not in ("param", "mode")}


def _prepare(files: dict[str, str], key: str, rec: Optional[dict] = None) -> tuple[dict, dict[str, dict]]:
    listed = _run(files, {"mode": "list"}, rec)
    if not listed.get("ok"):
        raise HTTPException(400, listed.get("error") or "the repository does not load")
    return _prepare_from(listed, key)


# -- checks ---------------------------------------------------------------------------------------


def _checks(repo_id: str) -> list[dict]:
    return _read(repo_id, "checks.json", [])


def run_checks(repo_id: str, commit_id: Optional[str], branch: str, files: Optional[dict] = None) -> dict:
    """Compile, load transforms and run unit tests; recorded when it is for a commit."""
    started = time.monotonic()
    if files is None:
        files = _commit_files(repo_id, commit_id)
    rec = _repo(repo_id)
    try:
        env = _environment(files, rec)
    except Exception as e:  # noqa: BLE001
        env = {"errors": [f"the environment could not be resolved: {e}"], "packages": [], "libraries": [], "warnings": [], "python": None}
    listed = _run(files, {"mode": "list"}, rec)
    enabled, workers = code_lint.tests_enabled(files)
    tests_started = time.monotonic()
    tests = _run(files, {"mode": "test", "tests_enabled": enabled, "pytest_workers": workers}, rec) if listed.get("ok") else {"tests": []}
    tests_ms = int((time.monotonic() - tests_started) * 1000)
    failed_tests = [t for t in tests.get("tests", []) if not t["ok"] and not t.get("skipped")]
    env_errors = ((env or {}).get("errors") or []) + code_env.spark_jars(files, test=True)[1]
    try:
        lint = code_lint.run(files)
    except Exception as e:  # noqa: BLE001 - a linter that cannot run is reported, not fatal
        lint = {"tasks": [], "problems": [{"tool": "lint", "file": "", "line": 0, "column": 0, "code": "error", "message": f"the linters could not run: {e}", "severity": "warning"}]}
    lint_errors = [p for p in lint["problems"] if p["severity"] == "error"]
    ok = (bool(listed.get("ok")) and not [e for e in listed.get("errors", []) if not e.get("warning")] and not failed_tests and not tests.get("error")
          and not env_errors and not lint_errors)
    tasks = _check_tasks(files, env, started, tests, tests_ms, enabled, workers) + lint["tasks"]
    # custom checks: Gradle tasks the subprojects' build.gradle files hook into check / test / publish
    try:
        custom, custom_logs, custom_ok = code_gradle_tasks.run(files)
    except Exception as e:  # noqa: BLE001 - a build.gradle that cannot be read fails its custom checks
        custom, custom_logs, custom_ok = [{"name": "custom checks", "status": "failed", "ms": 0, "detail": str(e), "custom": True}], "", False
    tasks += custom
    ok = ok and custom_ok
    # TypeScript functions (ts-functions/src): the files compile, their unit tests (*.test.ts) pass
    ts_check = None
    try:
        import functions_ts

        if functions_ts.has_ts(files):
            ts_check = functions_ts.check(files)
    except Exception as e:  # noqa: BLE001 - a check that cannot run fails, it does not break the others
        ts_check = {"diagnostics": [], "functions": [], "tests": [], "error": f"the TypeScript checks could not run: {e}", "logs": "", "ms": 0}
    if ts_check:
        ts_tasks = functions_ts.check_tasks(ts_check)
        tasks += ts_tasks
        tests = {**tests, "tests": (tests.get("tests") or []) + ts_check["tests"]}
        lint = {**lint, "problems": lint["problems"] + [{"tool": "tsc", "file": d["file"], "line": d["line"], "column": d["column"], "code": d["code"],
                                                        "message": d["message"], "severity": "error"} for d in ts_check["diagnostics"]]}
        ok = ok and not any(t["status"] == "failed" for t in ts_tasks)
    # code scanning (code_scanning.py): SAST rules on the commit; findings fail the checks in error mode
    try:
        import code_scanning

        scan = code_scanning.scan(rec, files, commit_id)
    except Exception as e:  # noqa: BLE001 - a scanner that cannot run is reported, not fatal
        scan = {"name": "Code scan", "status": "failed", "ms": 0, "detail": f"the code scan could not run: {e}", "report": None}
    if scan:
        tasks = [{k: v for k, v in scan.items() if k != "report"}, *tasks]
        ok = ok and scan["status"] != "failed"
    check = {
        "id": ontology._new_id("check"), "commit": commit_id, "branch": branch, "at": _now(),
        "status": "passed" if ok else "failed", "ms": int((time.monotonic() - started) * 1000),
        "transforms": listed.get("transforms", []), "errors": listed.get("errors", []), "error": listed.get("error") or tests.get("error"),
        "tests": tests.get("tests", []), "logs": (listed.get("logs") or "") + (tests.get("logs") or "") + ("\n" + custom_logs if custom_logs else ""),
        "environment": {k: v for k, v in env.items() if k != "support"} if env else None,
        # the CI tasks (condaPackRun with its stages, pytest, pep8, pylint, the Spark anti-pattern linter) and lint messages
        "tasks": tasks, "lint": lint["problems"][:500], "tests_disabled": bool(tests.get("tests_disabled")),
    }
    if scan and scan.get("report"):
        check["code_scan"] = scan["report"]
        if scan["status"] == "failed" and not check["error"]:
            check["error"] = f"Code scan: {scan['detail']}"
    if ts_check and not check["error"]:
        bad_ts = [t for t in ts_check["tests"] if not t["ok"] and not t.get("skipped")]
        if ts_check["error"]:
            check["error"] = f"TypeScript functions: {ts_check['error']}"
        elif ts_check["diagnostics"]:
            d = ts_check["diagnostics"][0]
            check["error"] = f"TypeScript functions do not compile: {d['file']}:{d['line']}: {d['message']}"
        elif bad_ts:
            check["error"] = f"{len(bad_ts)} TypeScript test{'s' if len(bad_ts) != 1 else ''} failed: {bad_ts[0]['name']}: {bad_ts[0]['error']}"
    failed_custom = [t for t in custom if t["status"] == "failed"]
    if failed_custom and not check["error"]:
        check["error"] = f"Custom check {failed_custom[0]['name']} failed: {failed_custom[0]['detail']}"
    if lint_errors and not check["error"]:
        tools = sorted({p["tool"] for p in lint_errors})
        check["error"] = f"{len(lint_errors)} style problem{'s' if len(lint_errors) != 1 else ''} ({', '.join(tools)})"
    if env_errors and not check["error"]:
        check["error"] = "The environment does not resolve (" + (env or {}).get("file", "meta.yaml") + "): " + "; ".join(env_errors[:5])
    if commit_id:
        with _lock:
            _write(repo_id, "checks.json", [check, *_checks(repo_id)][:CHECKS_KEPT])
        try:
            _auto_merge_upgrade(repo_id, branch, commit_id, check["status"])
        except Exception:  # noqa: BLE001 - an upgrade that cannot merge stays open
            log.exception("automatic upgrade merge in %s", repo_id)
        # a passing commit of the default branch publishes its Java code for other repositories
        if check["status"] == "passed" and branch == rec["default_branch"] and code_java.java_subprojects(files):
            _publish_java(repo_id, commit_id)
    return check


def _check_tasks(files: dict[str, str], env: Optional[dict], started: float, tests: dict, tests_ms: int, enabled: bool, workers: Optional[int]) -> list[dict]:
    """condaPackRun (the repository environment: built in this check with its stages, cached, or the platform's) and
    pytest, named after the Python project (:transforms-python)."""
    ps = code_lint.projects(files)
    name = ps[0]["name"] if ps else ":"
    plan = (env or {}).get("dedicated")
    if plan:
        st = code_envs.status(plan)
        built = st.get("built") or {}
        fresh = bool(built.get("built_at")) and built["built_at"] >= time.time() - (time.monotonic() - started)
        pack = {"name": f"{name}:condaPackRun", "status": "passed" if st["ready"] else "failed", "ms": int((built.get("built_s") or 0) * 1000) if fresh else 0,
                "detail": "built the repository environment" if fresh else "the repository environment is up to date (cached)" if st["ready"] else (st.get("error") or "not built"),
                "stages": built.get("stages") if fresh else []}
    else:
        pack = {"name": f"{name}:condaPackRun", "status": "passed", "ms": 0, "detail": "the platform's environment has every package", "stages": []}
    results = tests.get("tests") or []
    failed = [t for t in results if not t["ok"] and not t.get("skipped")]
    if not enabled:
        test_task = {"name": f"{name}:pytest", "status": "skipped", "ms": 0, "detail": f"tests are off: apply plugin '{code_lint.PLUGIN_TESTS}' in build.gradle"}
    else:
        test_task = {"name": f"{name}:pytest", "status": "failed" if failed or tests.get("error") else "passed", "ms": tests_ms, "problems": len(failed),
                     "detail": f"{len(results)} test{'s' if len(results) != 1 else ''}" + (f" in {workers} processes" if workers and workers > 1 else "")}
    return [pack, test_task]


def _run_checks_logged(repo_id: str, commit_id: str, branch: str) -> None:
    try:
        run_checks(repo_id, commit_id, branch)
    except Exception:  # noqa: BLE001
        pass


class BranchArg(BaseModel):
    branch: Optional[str] = None


@router.post("/{repo_id}/checks")
def checks(repo_id: str, req: Optional[BranchArg] = None) -> dict:
    """Checks on a branch's working copy (not recorded; commits record theirs)."""
    rec = _repo(repo_id)
    b = _branch(rec, req.branch if req else None)
    return run_checks(repo_id, None, b["name"], b["files"])


@router.get("/{repo_id}/checks")
def list_checks(repo_id: str, branch: Optional[str] = None) -> list[dict]:
    _repo(repo_id)
    out = [c for c in _checks(repo_id) if not branch or c["branch"] == branch]
    return [{k: v for k, v in c.items() if k != "logs"} | {"logs": c.get("logs", "")[-4000:]} for c in out]


class TestIn(BaseModel):
    branch: Optional[str] = None
    # only tests in this file; all when empty
    file: Optional[str] = None


@router.post("/{repo_id}/tests")
def tests(repo_id: str, req: TestIn) -> dict:
    rec = _repo(repo_id)
    b = _branch(rec, req.branch)
    res = _run(b["files"], {"mode": "test", "file": req.file}, rec)
    return {"ok": res.get("ok", False) and all(t["ok"] for t in res.get("tests", [])), "tests": res.get("tests", []),
            "error": res.get("error"), "logs": res.get("logs", "")}


# -- preview and build ----------------------------------------------------------------------------


class RunIn(BaseModel):
    branch: Optional[str] = None
    # "<file path>::<function name>"
    transform: Optional[str] = None
    # build every transform in this file
    file: Optional[str] = None
    limit: int = 100
    # incremental transforms: ignore what earlier builds processed and rebuild from every input row
    force_snapshot: bool = False


@router.post("/{repo_id}/preview")
def preview(repo_id: str, req: RunIn) -> dict:
    rec = _repo(repo_id)
    b = _branch(rec, req.branch)
    if not req.transform:
        raise HTTPException(400, "pick a transform")
    res, t, _ = run_preview(rec, b["files"], b["name"], req.transform, req.limit)
    return {**res, "transform": t}


def _sidecar_spec(rec: dict, t: dict, label: str) -> dict:
    """A `@sidecar` transform's container (transforms.sidecar): the image from the Artifacts repositories in Settings →
    Libraries, checked against the image requirements and loaded into the container runtime. ValueError when it
    cannot run."""
    sc = t.get("sidecar")
    if not sc:
        return {}
    import container_registry
    import container_runtime

    rt = container_runtime.runtime()
    if rt["kind"] == "off":
        raise ValueError(f"@sidecar needs a container runtime: {rt['error']}")
    repo_ids = [x for x in _backing(rec) if x.startswith("art-")]
    if not repo_ids:
        raise ValueError(f"@sidecar(image='{sc['image']}'): add the Artifacts repository holding the image in Settings → Libraries")
    try:
        arec, digest, m = container_registry.find_image(repo_ids, sc["image"], sc["tag"])
    except HTTPException as e:
        raise ValueError(str(e.detail)) from None
    why = container_registry.runnable(m, sc["tag"])
    if why:
        raise ValueError(f"{sc['image']}:{sc['tag']} does not meet the image requirements: {why}")
    ref = container_runtime.local_ref(arec["slug"], sc["image"], digest)
    try:
        container_runtime.ensure_image(digest, m, ref)
    except container_runtime.RuntimeError_ as e:
        raise ValueError(str(e)) from None
    base = DIR.parent / "sidecars" / f"{label}-{uuid.uuid4().hex[:8]}"
    base.mkdir(parents=True, exist_ok=True)
    return {"sidecar": {"ref": ref, "user": m["user"], "ports": m.get("ports") or [], "volumes": sc.get("volumes") or [],
                        "docker": [*rt["base"], "docker"] if rt["kind"] == "wsl" else list(rt["base"]), "wsl": rt["kind"] == "wsl",
                        # WSL stops its VM (and every container) when no wsl.exe process is attached: the driver keeps one
                        "keepalive": [*rt["base"], "sleep", "infinity"] if rt["kind"] == "wsl" else None,
                        "base_dir": str(base.resolve()), "run_args": container_runtime.profile_args(sc.get("resource_profile")), "label": base.name,
                        "image": f"{sc['image']}:{sc['tag']}", "repository": arec["name"], "digest": digest, "resource_profile": sc.get("resource_profile")}}


def _container_spec(rec: dict, t: dict, label: str) -> dict:
    """A bring-your-own-container transform's image (byoc_slot.py): from the Artifacts repositories in Settings →
    Libraries, meeting the image requirements with user 5001, loaded into the container runtime."""
    c = t.get("container")
    if not c:
        return {}
    import container_registry
    import container_runtime

    rt = container_runtime.runtime()
    if rt["kind"] == "off":
        raise ValueError(f"with_container needs a container runtime: {rt['error']}")
    repo_ids = [x for x in _backing(rec) if x.startswith("art-")]
    if not repo_ids:
        raise ValueError(f"with_container(container_image='{c['image']}'): add the Artifacts repository holding the image in Settings → Libraries")
    try:
        arec, digest, m = container_registry.find_image(repo_ids, c["image"], c["tag"])
    except HTTPException as e:
        raise ValueError(str(e.detail)) from None
    why = container_registry.runnable(m, c["tag"])
    if why:
        raise ValueError(f"{c['image']}:{c['tag']} does not meet the image requirements: {why}")
    if str(m.get("user")) != "5001":
        raise ValueError(f"{c['image']}:{c['tag']}: bring-your-own-container images must run as user 5001 (USER 5001), not {m.get('user') or 'root'}")
    ref = container_runtime.local_ref(arec["slug"], c["image"], digest)
    try:
        container_runtime.ensure_image(digest, m, ref)
    except container_runtime.RuntimeError_ as e:
        raise ValueError(str(e)) from None
    base = DIR.parent / "sidecars" / f"byoc-{label}-{uuid.uuid4().hex[:8]}"
    base.mkdir(parents=True, exist_ok=True)
    return {"container": {"ref": ref, "docker": [*rt["base"], "docker"] if rt["kind"] == "wsl" else list(rt["base"]), "wsl": rt["kind"] == "wsl",
                          "keepalive": [*rt["base"], "sleep", "infinity"] if rt["kind"] == "wsl" else None, "base_dir": str(base.resolve()),
                          "label": base.name, "image": f"{c['image']}:{c['tag']}", "repository": arec["name"], "digest": digest}}


def _container_models_spec(t: dict, label: str, rec: Optional[dict] = None, branch: Optional[str] = None, model_version: Optional[str] = None) -> dict:
    """The model resources among the transform's ModelInputs (model_assets.py), resolved for the runner: a container
    model's images loaded into the container runtime and its adapter, or the version folder of a model trained here
    (pinned, else the latest on the ModelInput's or the build's branch). ValueError when one cannot run.
    `model_version` pins every model input (an evaluation run against a chosen version)."""
    import model_assets

    default = (rec or {}).get("default_branch") or "master"
    out = {k: model_assets.resolve_ref(m["rid"], model_version or m.get("version"), m.get("branch") or branch, label, k, default)
           for k, m in (t.get("models") or {}).items() if m.get("kind") == "container"}
    return {"container_models": out} if out else {}


def run_preview(rec: dict, files: dict[str, str], branch: str, key: str, limit: int = 100, extra: Optional[dict] = None) -> tuple[dict, dict, dict]:
    """Preview one transform (nothing is committed): (result, transform, input items). `extra` adds to the runner
    spec (datasetPreview's output files, a debug job's interpreter)."""
    t, items = _prepare(files, key, rec)
    if t.get("blocked"):
        raise HTTPException(400, t["blocked"])
    if t.get("container"):
        raise HTTPException(400, "Preview is not supported for bring-your-own-container transforms (with_container): build the transform instead")
    try:
        extra = {**(extra or {}), **_sidecar_spec(rec, t, "preview"), **_container_models_spec(t, "preview", rec, branch)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if t.get("language") == "java":
        req_java = _java_run_spec(t, items)
    elif t.get("kind") in ("lightweight", "spark"):
        req_java = _python_spec(rec, t)
    else:
        req_java = {}
    spec = {**req_java, "mode": "preview", "transform": key, "limit": max(1, min(limit, 1000)), **_input_spec(t, items), **(extra or {})}
    if t.get("incremental"):
        # Code Repositories preview always runs non-incrementally (even with require_incremental=True)
        spec.update(_incremental_spec(rec, branch, t, True, items))
    tspec, job_id, _ = _table_spec(rec, t, branch, key, "preview")
    spec.update(tspec)
    try:
        res = _run(files, spec, rec)
    finally:
        if job_id:
            # a preview never commits to Iceberg tables
            import iceberg_catalog

            iceberg_catalog.abort_job(job_id)
        # nor writes virtual tables
        shutil.rmtree((tspec.get("virtual") or {}).get("dir") or "", ignore_errors=True)
    res.pop("parquet", None)
    if res.get("incremental"):
        res["incremental"].pop("state", None)
    return res, t, items


def _incremental_states(repo_id: str) -> dict:
    return _read(repo_id, "incremental.json", {})


def _input_transactions(item_id: str) -> list[dict]:
    """The transactions of a dataset's current view, oldest first: from its last SNAPSHOT on ({id, rows, type})."""
    view = []
    for tx in dataset_versions.history(item_id):  # newest first
        src = tx.get("source") or {}
        kind = src.get("transaction") or ("APPEND" if src.get("mode") == "append" else "UPDATE" if tx.get("kind") == "rollback" else "SNAPSHOT")
        view.append({"id": tx["id"], "rows": tx.get("rows") or 0, "type": kind, "at": tx.get("at")})
        if kind == "SNAPSHOT":
            break
    view.reverse()
    if not view:
        item = db.drive_get(item_id)
        rows = None
        try:
            import pyarrow.parquet as pq

            rows = pq.ParquetFile(io.BytesIO(drive.read_bytes(item))).metadata.num_rows if item else 0
        except Exception:  # noqa: BLE001
            rows = 0
        view = [{"id": "initial", "rows": rows, "type": "SNAPSHOT", "at": str((item or {}).get("created_at"))}]
    return view


def _incremental_spec(rec: dict, branch: str, t: dict, force_snapshot: bool, items: Optional[dict] = None) -> dict:
    """What the runner needs to decide whether an incremental transform can build incrementally. The first build of
    a branch other than the default one starts from the default branch's last build (its state and outputs)."""
    states = _incremental_states(rec["id"])
    state = states.get(f"{branch}::{t['key']}")
    fallback = None
    if not state and branch != rec["default_branch"]:
        state = states.get(f"{rec['default_branch']}::{t['key']}")
        fallback = rec["default_branch"] if state else None
    spec: dict[str, Any] = {"incremental_state": state, "force_snapshot": force_snapshot, "fallback_branch": fallback}
    for name in (t.get("transaction_limits") or {}):
        if items and name in items:
            spec.setdefault("input_transactions", {})[name] = _input_transactions(items[name]["id"])
    for name in (t.get("media_inputs") or {}):
        if items and name in items:
            spec.setdefault("media_replaced", {})[name] = (media_sets.get(items[name]["id"]) or {}).get("replaced_at")
    # a transactional media set output changed outside this transform's builds: the next build is a snapshot
    for param, change in ((state or {}).get("media_outputs") or {}).items():
        out = (t.get("media_outputs") or {}).get(param)
        if not out:
            continue
        try:
            fid = _media_output_folder(rec, out, branch)
        except Exception:  # noqa: BLE001
            continue
        if not fid:
            continue
        s = media_sets.get(fid) or {}
        if s.get("transaction_policy") == "transactional" and media_sets.change_of(fid) != change:
            spec["previous_output_reason"] = f"media set output {param} was modified since the last build"
    if t.get("outputs") is not None:
        if t.get("language") == "java":
            spec.update(_java_spec(rec, t["key"]))
        if state and not force_snapshot:
            prev: dict[str, str] = {}
            for param, o in (state.get("outputs") or {}).items():
                item = db.drive_get(o["item_id"]) if o.get("item_id") else None
                if not item or item.get("trashed_at"):
                    spec["previous_output_reason"] = f"output {param} was deleted"
                elif str(item.get("updated_at")) != o.get("updated_at"):
                    spec["previous_output_reason"] = f"output {param} was changed outside incremental builds"
                elif o.get("kind") == "dataframe":
                    prev[param] = item["id"]
            spec["previous_output_items"] = prev
        return spec
    if state and not force_snapshot:
        item = db.drive_get(state["output_item_id"]) if state.get("output_item_id") else None
        if not item or item.get("trashed_at"):
            spec["previous_output_reason"] = "the output dataset was deleted"
        elif str(item.get("updated_at")) != state.get("output_updated_at"):
            spec["previous_output_reason"] = "the output dataset was changed outside incremental builds"
        else:
            spec["previous_output_item"] = item["id"]
    return spec


def _java_spec(rec: dict, key: str) -> dict:
    """TransformContext.parameters() — repoSettings.json "javaParameters": {"*": {...}, "<transform key>": {...}} —
    and the API's URL, for Java transforms."""
    params: dict = {}
    try:
        settings = json.loads(_branch(rec, None)["files"].get("repoSettings.json") or "{}")
        params = settings.get("javaParameters") or {}
    except (ValueError, HTTPException):
        pass
    return {"parameters": {**(params.get("*") or {}), **(params.get(key) or {})}, "api_url": os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000")}


def _media_output_folder(rec: dict, out: dict, branch: str) -> Optional[str]:
    """The folder of a MediaSetOutput, if it exists (branch builds write under _branches/<branch>). Never created here:
    a build creates it already marked (_marked_output_folder)."""
    parent = _output_folder(rec, out.get("folder"), branch)
    found = next((c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and c["name"] == out["name"] and not c.get("trashed_at")), None)
    return found["id"] if found else None


def _marked_output_folder(rec: dict, out: dict, branch: str, t: dict, param: str) -> tuple[str, set[str]]:
    """The folder of a files output or MediaSetOutput, carrying the markings its contents inherit (from
    _precheck_constraints: a Project constraint they violate refuses the build first) before anything is written into
    it: an existing folder gains them; a missing one is created under a fresh id already carrying them. Returns
    (folder id, markings)."""
    import iceberg_catalog as ic

    parent = _output_folder(rec, out.get("folder"), branch)
    found = next((c for c in db.drive_list(parent) if c["kind"] in drive.CONTAINERS and c["name"] == out["name"] and not c.get("trashed_at")), None)
    marks = _precheck_constraints(parent, found, t, rec["id"], param, branch)
    if found:
        _gain_markings(found["id"], marks)
        return found["id"], marks
    if not marks:
        return drive._insert_container(parent, "folder", drive._clean_name(out["name"])), marks
    item_id = ic.reserve_marked_id(sorted(marks))
    now = drive._now()
    try:
        db.drive_insert({"id": item_id, "parent_id": parent, "kind": "folder", "name": drive._clean_name(out["name"]), "size_bytes": 0,
                         "content_type": None, "stored_in": None, "created_at": now, "updated_at": now, "system": None})
    except BaseException:
        ic.release_marked_id(item_id)
        raise
    return item_id, marks


def _media_out_spec(rec: dict, t: dict, branch: str) -> dict:
    """For builds: each MediaSetOutput's folder and its items' ids by path, so put_media_item() returns real rids."""
    folders, existing, settings = {}, {}, {}
    for k, out in (t.get("media_outputs") or {}).items():
        fid = _marked_output_folder(rec, out, branch, t, k)[0]  # marked (or refused) before the transform runs
        folders[k] = fid
        existing[k] = {c["name"]: c["id"] for c in _media_files(fid) if not c.get("virtual")}
        settings[k] = media_sets.get(fid)
    return {"media_folders_out": folders, "media_existing": existing, "media_out_settings": settings}


def _write_media(rec: dict, t: dict, branch: str, media: dict[str, dict]) -> list[dict]:
    """put_media_item() results into their media set folders: an item with the same path is replaced; the others
    are kept ('modify' write mode) or removed ('replace')."""
    written = []
    for k, m in media.items():
        entries = m["items"]
        out = t["media_outputs"][k]
        # the media set (and each item written) carries the inputs' markings before anything is written or registered
        folder_id, marks = _marked_output_folder(rec, out, branch, t, k)
        if not media_sets.is_media_set(folder_id):
            # a MediaSetOutput folder becomes a media set on its first build (transactionless: builds add items)
            media_sets.note_built(folder_id, "code", policy="transactionless")
        for reg in m.get("registrations") or []:
            media_sets.register_virtual(folder_id, reg["physical"], reg["path"])
        if not media_sets.get(folder_id).get("virtual") or entries:
            # put_media_item() handed out the items' ids: each one is marked before an item is stored under it (a
            # replaced item gains them, keeping its own until its new bytes are in)
            ids = {iid for _p, _d, iid in entries if iid and re.fullmatch(r"[0-9a-f]{16}", iid)}
            before = {}
            for iid in ids:
                cur = db.drive_get(iid)
                if cur is None or cur.get("parent_id") == folder_id:
                    before[iid] = auth._item_row(iid)[1]
                    _gain_markings(iid, marks)
            try:
                n = media_sets.write_build(folder_id, entries, m.get("mode", "modify"), "code")
            except BaseException:
                for iid, inh in before.items():
                    if not db.drive_get(iid):
                        auth._set_item(iid, inherited=inh)  # nothing was stored under it: its record as it was
                raise
            for iid in before:
                cur = db.drive_get(iid)
                if cur and cur.get("parent_id") == folder_id:
                    auth._set_item(iid, inherited=sorted(marks))  # its bytes are all new: exactly the inputs' markings
        else:
            n = 0
        folder = db.drive_get(folder_id)
        written.append({"param": k, "item_id": folder_id, "name": folder["name"], "path": [p["name"] for p in db.drive_path(folder_id)[:-1]],
                        "written": n, "registered": len(m.get("registrations") or []), "items": len(_media_files(folder_id))})
    return written


class _Done(Exception):
    """A build finished early (Java transforms write their outputs themselves)."""


def _java_run_spec(t: dict, items: dict[str, dict]) -> dict:
    """Java transforms: the timeout (@MaxAllowedDuration), parameters and input file names."""
    j = t.get("java") or {}
    out: dict[str, Any] = {"input_names": {k: v["name"] for k, v in items.items()}}
    if j.get("max_duration_s"):
        out["timeout_s"] = int(j["max_duration_s"]) + 120
    else:
        out["timeout_s"] = code_java.TIMEOUT + 120
    return out


def _previous_output(rec: dict, key: str, branch: str, param: str) -> Optional[dict]:
    """The dataset or folder an output was last written to by this transform on this branch (an aborted output still
    has it: Data Lineage keeps the edge)."""
    for old in reversed(_builds(rec["id"])):
        if old["transform"] != key or (old.get("branch") or rec["default_branch"]) != branch:
            continue
        o = next((x for x in old.get("outputs") or [] if x.get("param") == param and x.get("item_id")), None)
        if o:
            item = db.drive_get(o["item_id"])
            if item and not item.get("trashed_at"):
                return {**o, "name": item["name"], "path": [x["name"] for x in db.drive_path(item["id"])[:-1]]}
    return None


def _record_aborted_outputs(rec: dict, t: dict, key: str, branch: str, commit_id: Optional[str], reason: str) -> None:
    """ctx.abort_job(): an aborted transaction in the history of every dataset the transform writes."""
    source = {"kind": "transform", "id": f"{rec['id']}::{key}", "name": t["function"], "repo": rec["name"], "commit": commit_id, "branch": branch, "reason": reason}
    if t.get("outputs") is not None:
        for param in t["outputs"]:
            prev = _previous_output(rec, key, branch, param)
            if prev and not prev.get("files"):
                dataset_versions.record_aborted(prev["item_id"], {**source, "output": param})
        return
    for old in reversed(_builds(rec["id"])):
        if old["transform"] == key and (old.get("branch") or rec["default_branch"]) == branch and (old.get("output") or {}).get("item_id"):
            if not old["output"].get("media_set"):
                dataset_versions.record_aborted(old["output"]["item_id"], source)
            return


def _write_outputs(rec: dict, t: dict, branch: str, key: str, commit_id: Optional[str], res: dict, b: dict, inc: Optional[dict]) -> None:
    """Every output a multi-output transform (Java, or Python's @transform.using / .spark.using) wrote: DataFrames
    as datasets (UPDATE appends, SNAPSHOT replaces), files into the output's folder (SNAPSHOT replaces its files,
    UPDATE adds to them); an aborted output is left unchanged; an output the transform never wrote gets an empty
    SNAPSHOT (an output that held files loses them). Records the incremental state."""
    outs = res.get("multi_outputs") or {}
    written: dict[str, dict] = {}
    b["outputs"] = []
    for param, o in outs.items():
        out = t["outputs"][param]
        if o["kind"] == "empty":
            prev = _previous_output(rec, key, branch, param)
            o = {"kind": "files", "mode": "SNAPSHOT", "files": []} if prev and prev.get("files") else {**o, "kind": "dataframe"}
            b["logs"] += f"\n{param}: the transform did not write this output: it gets an empty snapshot."
        if o["kind"] == "aborted":
            b["logs"] += f"\n{param}: the output's transaction was aborted: nothing was committed to it."
            import dataset_retention

            dataset_retention.note_aborted(None, {"kind": "transform", "id": f"{rec['id']}::{key}", "output": param, "reason": "abort"})
            prev = _previous_output(rec, key, branch, param)
            if prev and not prev.get("files"):
                dataset_versions.record_aborted(prev["item_id"], {"kind": "transform", "id": f"{rec['id']}::{key}", "name": t["function"], "repo": rec["name"],
                                                                  "commit": commit_id, "branch": branch, "output": param, "reason": "abort"})
            if prev:
                b["outputs"].append({**{k: v for k, v in prev.items() if k not in ("transaction", "mode", "aborted")}, "aborted": True, "mode": "ABORTED"})
            continue
        source = {"kind": "transform", "id": f"{rec['id']}::{key}", "name": t["function"], "repo": rec["name"], "commit": commit_id, "branch": branch,
                  "transaction": "APPEND" if o["mode"] == "UPDATE" else "SNAPSHOT", "output": param}
        if o["kind"] == "dataframe":
            folder_id = _output_folder(rec, out.get("folder"), branch)
            name = out["name"] if out["name"].endswith(".parquet") else f"{out['name']}.parquet"
            existing = next((c for c in db.drive_list(folder_id) if c["kind"] == "file" and c["name"] == name and not c.get("trashed_at")), None)
            new_rows = o.get("written") if o["mode"] == "UPDATE" else o.get("rows")
            if dataset_versions.abort_if_empty(existing["id"] if existing else None, new_rows, source):
                b["logs"] += f"\n{param}: no rows written and the dataset aborts empty transactions: nothing was committed."
                b["aborted_empty"] = True
                if existing:
                    written[param] = {"kind": "dataframe", "item_id": existing["id"], "updated_at": str(existing.get("updated_at"))}
                    b["outputs"].append({"param": param, "item_id": existing["id"], "name": existing["name"], "rows": None, "columns": [],
                                         "path": [x["name"] for x in db.drive_path(existing["id"])[:-1]], "aborted": True, "mode": "ABORTED"})
                continue
            data = o["bytes"]
            marks = _precheck_constraints(folder_id, existing, t, rec["id"], param, branch)
            item = _write_marked_output(folder_id, name, existing, data, marks)  # marked before its rows are in it
            tx = dataset_versions.record(item["id"], data, "build", {**source, "written": new_rows})
            _inherit_markings(item["id"], t, rec["id"], param, branch)
            entry = {"param": param, "item_id": item["id"], "name": item["name"], "path": [x["name"] for x in db.drive_path(item["id"])[:-1]],
                     "rows": o["rows"], "columns": o["columns"], "transaction": tx["id"], "mode": o["mode"]}
            written[param] = {"kind": "dataframe", "item_id": item["id"], "updated_at": str(item.get("updated_at"))}
        else:
            # the output folder (and each file written) carries the inputs' markings before any file is written
            folder_id, marks = _marked_output_folder(rec, {**out, "folder": out.get("folder")}, branch, t, param)
            if o["mode"] == "SNAPSHOT":
                for c in db.drive_list(folder_id):
                    if not c.get("trashed_at"):
                        drive.trash(c["id"])
            for path, data in o["files"]:
                parts = [x for x in path.split("/") if x]
                parent = _folder_path(folder_id, [drive._clean_name(x) for x in parts[:-1]]) if len(parts) > 1 else folder_id
                fname = drive._clean_name(parts[-1])
                ct = mimetypes.guess_type(fname)[0] or "application/octet-stream"
                found = next((c for c in db.drive_list(parent) if c["kind"] == "file" and c["name"] == fname and not c.get("trashed_at")), None)
                _write_marked_file(parent, fname, data, ct, marks, found)
            if o["mode"] == "SNAPSHOT":
                # everything the folder holds now was built from the current inputs: narrowed to their markings
                _inherit_markings(folder_id, t, rec["id"], param, branch)
            folder = db.drive_get(folder_id)
            entry = {"param": param, "item_id": folder_id, "name": folder["name"], "path": [x["name"] for x in db.drive_path(folder_id)[:-1]],
                     "rows": len(o["files"]), "columns": [], "files": True, "mode": o["mode"]}
            written[param] = {"kind": "files", "item_id": folder_id, "updated_at": str(folder.get("updated_at"))}
        b["outputs"].append(entry)
    committed = [o for o in b["outputs"] if not o.get("aborted")]
    primary = next((o for o in committed if o["param"] == t.get("output_param")), committed[0] if committed else None)
    if primary:
        b["output"] = {k: v for k, v in primary.items() if k not in ("param", "mode")} | ({"media_set": True} if primary.get("files") else {})
    if inc:
        with _lock:
            states = _incremental_states(rec["id"])
            prev = states.get(f"{branch}::{key}") or {}
            outputs = {**(prev.get("outputs") or {}), **written}
            states[f"{branch}::{key}"] = {**inc["state"], "outputs": outputs, "at": _now(), "build": b["id"], "mode": inc["mode"]}
            _write(rec["id"], "incremental.json", states)


def _note_media_outputs(rec: dict, b: dict, branch: str, key: str) -> None:
    """The change marker of each media set output after an incremental build, so the next build can tell whether
    someone changed a transactional output in between."""
    outs = {m["param"]: media_sets.change_of(m["item_id"]) for m in b.get("media_outputs") or []}
    if not outs:
        return
    with _lock:
        states = _incremental_states(rec["id"])
        st = states.get(f"{branch}::{key}")
        if st is not None:
            st["media_outputs"] = outs
            _write(rec["id"], "incremental.json", states)


def build_transform(rec: dict, files: dict[str, str], branch: str, key: str, trigger: str, commit_id: Optional[str],
                    listed: Optional[dict] = None, force_snapshot: bool = False, run_as: Optional[str] = None,
                    model_version: Optional[str] = None) -> dict:
    started = time.monotonic()
    b: dict[str, Any] = {"id": ontology._new_id("build"), "repo_id": rec["id"], "transform": key, "at": _now(), "branch": branch,
                         "trigger": trigger, "commit": commit_id, "uncommitted": commit_id is None, "status": "failed", "error": None,
                         "inputs": [], "output": None, "logs": ""}
    try:
        t, items = _prepare_from(listed, key) if listed else _prepare(files, key, rec)
        b["language"] = t.get("language", "python")
        media_in = t.get("media_inputs") or {}
        b["inputs"] = [{"name": k, "ref": media_in.get(k) or t["inputs"][k], "item_id": v["id"], "item_name": v["name"],
                        "updated_at": _media_version(v["id"]) if k in media_in else str(v.get("updated_at")),
                        **({"media": True} if k in media_in else {})} for k, v in items.items()]
        b["version"] = t.get("version")
        b["kind"] = t.get("kind")
        # Spark Details → Environment: the transforms version and runtime the build ran on (debug jobs compare them)
        import transforms_common

        b["environment"] = transforms_common.environment_of(rec, files, t)
        if t.get("blocked"):
            raise ValueError(t["blocked"])
        _check_unmarking(t, branch, run_as)
        spec = {"mode": "build", "transform": key, "limit": 20, **_input_spec(t, items), **_sidecar_spec(rec, t, b["id"]), **_container_spec(rec, t, b["id"]),
                **_container_models_spec(t, b["id"], rec, branch, model_version)}
        if spec.get("container_models"):
            b["models"] = [{k: m[k] for k in ("model", "rid", "version", "version_rid")} for m in spec["container_models"].values()]
        if spec.get("container"):
            b["container"] = {k: spec["container"][k] for k in ("image", "repository", "digest")}
        if spec.get("sidecar"):
            b["sidecar"] = {k: spec["sidecar"][k] for k in ("image", "repository", "digest", "resource_profile")}
        if t.get("incremental"):
            spec.update(_incremental_spec(rec, branch, t, force_snapshot, items))
        if t.get("language") == "java":
            spec.update(_java_run_spec(t, items))
        elif t.get("kind") in ("lightweight", "spark"):
            spec.update(_python_spec(rec, t))
            b["resources"] = t.get("resources") or {}
        if t.get("media_outputs"):
            spec.update(_media_out_spec(rec, t, branch))
        if run_as:
            spec["run_as"] = run_as
        # the Project's resource queue: wait for room for the build's vCPUs (resource_queues.py)
        import resource_queues

        queue_item = next(iter(items.values()), {}).get("id") if items else None
        cores = int((spec.get("resources") or t.get("resources") or {}).get("cpu_cores") or 2)
        waited = time.monotonic()
        lease_id = resource_queues.acquire(queue_item, cores, f"{rec['name']} · {key}", "transform",
                                           on_wait=lambda lease: b.update(queue={"name": lease["queue_name"], "ahead": lease["ahead"]}))
        if b.get("queue"):
            b["queue"]["waited_s"] = round(time.monotonic() - waited, 1)
        try:
            committed: list[dict] = []
            for attempt in range(2):
                tspec, job_id, table_inputs = _table_spec(rec, t, branch, key, "build", run_as)
                spec.update(tspec)
                if attempt == 0:
                    b["inputs"] += table_inputs
                try:
                    res = _run(files, spec, rec)
                    if job_id and res.get("ok") and not res.get("aborted"):
                        committed = _commit_tables(job_id)
                        job_id = None
                    break
                except HTTPException as e:
                    if e.status_code == 409 and attempt == 0 and job_id:
                        # a concurrent change (a maintenance task) made the commit fail: the build system retries the job
                        b["logs_retry"] = f"retried: {e.detail}"
                        job_id = None
                        continue
                    raise
                finally:
                    if job_id:
                        import iceberg_catalog

                        iceberg_catalog.abort_job(job_id)
        finally:
            resource_queues.release(lease_id)
        b["logs"] = res.get("logs", "")
        if b.get("queue"):
            b["logs"] = f"waited {b['queue'].get('waited_s', 0)} s in the resource queue {b['queue']['name']}\n" + b["logs"]
        if b.get("logs_retry"):
            b["logs"] = f"{b.pop('logs_retry')}\n{b['logs']}"
        b["metrics"] = res.get("metrics")
        if res.get("spark_plans"):
            # Linter reads the query plans of the DataFrames the build wrote
            b["spark_plans"] = res["spark_plans"]
        if res.get("expectations"):
            b["expectations"] = res["expectations"]
        if not res.get("ok"):
            raise ValueError(res.get("error") or "the transform failed")
        if res.get("aborted"):
            # ctx.abort_job(): the job succeeds, nothing is committed and incremental state is untouched
            b["aborted"] = True
            b["status"] = "succeeded"
            import dataset_retention

            dataset_retention.note_aborted(None, {"kind": "transform", "id": f"{rec['id']}::{key}", "reason": "abort_job"})
            _record_aborted_outputs(rec, t, key, branch, commit_id, "abort_job")
            raise _Done()
        inc = res.get("incremental")
        if inc:
            b["incremental"] = {k: v for k, v in inc.items() if k != "state"}
        if res.get("media_bytes"):
            b["media_outputs"] = _write_media(rec, t, branch, res["media_bytes"])
        if t.get("outputs") is not None:
            _write_outputs(rec, t, branch, key, commit_id, res, b, inc)
            if _has_tables(t):
                _table_outputs(rec, t, b, res, committed, (spec.get("iceberg") or {}).get("outputs") or {})
                _virtual_outputs(rec, t, b, res, spec.get("virtual") or {})
            if not b.get("output") and b.get("media_outputs"):
                m = b["media_outputs"][0]
                b["output"] = {"item_id": m["item_id"], "name": m["name"], "path": m["path"], "rows": m["items"], "columns": [], "media_set": True}
            if res.get("model_outputs") or res.get("evaluations"):
                # ModelOutput.publish() and evaluations are committed only now that the build succeeded
                import model_assets

                model_assets.commit_build(rec, t, branch, b, res)
            b["status"] = "succeeded"
            raise _Done()
        out = t["output"]
        if res.get("dataset_output", True) and "parquet" in res:
            folder_id = _output_folder(rec, out.get("folder"), branch)
            name = out["name"] if out["name"].endswith(".parquet") else f"{out['name']}.parquet"
            data = res["parquet"]
            existing = next((c for c in db.drive_list(folder_id) if c["kind"] == "file" and c["name"] == name and not c.get("trashed_at")), None)
            appended = bool(inc and inc["mode"] == "incremental" and inc["output_mode"] == "modify")
            source = {"kind": "transform", "id": f"{rec['id']}::{key}", "name": t["function"], "repo": rec["name"], "commit": commit_id, "branch": branch,
                      "transaction": "APPEND" if appended else "SNAPSHOT"}
            # an incremental build appends what it wrote; the transaction is empty when it wrote no rows
            written = inc.get("written_rows") if appended and inc else res.get("rows")
            if dataset_versions.abort_if_empty(existing["id"] if existing else None, written, source):
                # the dataset's policy aborts empty transactions: nothing is written or recorded, nothing downstream
                # triggers, and an incremental transform processes these input rows again next build
                b["output"] = None
                b["aborted_empty"] = True
                b["logs"] += "\nThe transform wrote no rows and the dataset aborts empty transactions: nothing was committed."
                inc = None
            else:
                marks = _precheck_constraints(folder_id, existing, t, rec["id"], t.get("output_param"), branch)
                item = _write_marked_output(folder_id, name, existing, data, marks)  # marked before its rows are in it
                tx = dataset_versions.record(item["id"], data, "build", {**source, "written": written})
                _inherit_markings(item["id"], t, rec["id"], t.get("output_param"), branch)
                b["output"] = {"item_id": item["id"], "name": item["name"], "path": [p["name"] for p in db.drive_path(item["id"])[:-1]],
                               "rows": res.get("rows"), "columns": res.get("columns"), "transaction": tx["id"]}
            if inc:
                with _lock:
                    states = _incremental_states(rec["id"])
                    states[f"{branch}::{key}"] = {**inc["state"], "output_item_id": item["id"], "output_updated_at": str(item.get("updated_at")),
                                                  "at": _now(), "build": b["id"], "mode": inc["mode"]}
                    _write(rec["id"], "incremental.json", states)
        elif b.get("media_outputs"):
            m = b["media_outputs"][0]
            b["output"] = {"item_id": m["item_id"], "name": m["name"], "path": m["path"], "rows": m["items"], "columns": [], "media_set": True}
        b["status"] = "succeeded"
    except _Done:
        pass
    except HTTPException as e:
        b["error"] = str(e.detail)
    except Exception as e:  # noqa: BLE001
        b["error"] = str(e)[:2000]
    if b["status"] == "succeeded" and b.get("incremental") and not b.get("aborted"):
        _note_media_outputs(rec, b, branch, key)
    b["ms"] = int((time.monotonic() - started) * 1000)
    with _lock:
        _write(rec["id"], "builds.json", [b, *_builds(rec["id"])][:BUILDS_KEPT])
    return b


@router.post("/{repo_id}/build")
def build(repo_id: str, req: RunIn) -> list[dict]:
    """Build one transform, or every transform in a file (in order), on a branch's working copy."""
    rec = _repo(repo_id)
    br = _branch(rec, req.branch)
    head_files = _commit_files(repo_id, br["head"])
    commit_id = br["head"] if _files_hash(head_files) == _files_hash(br["files"]) else None
    listed = _run(br["files"], {"mode": "list"}, rec)
    if not listed.get("ok"):
        raise HTTPException(400, listed.get("error") or "the repository does not load")
    keys = [req.transform] if req.transform else [t["key"] for t in listed["transforms"] if t["file"] == req.file]
    if not keys:
        raise HTTPException(400, "this file declares no transforms")
    return [build_transform(rec, br["files"], br["name"], k, "manual", commit_id, listed, req.force_snapshot) for k in keys]


@router.get("/{repo_id}/incremental")
def incremental_states(repo_id: str) -> list[dict]:
    """What each incremental transform has processed so far, per branch."""
    _repo(repo_id)
    out = []
    for k, v in _incremental_states(repo_id).items():
        branch, _, key = k.partition("::")
        out.append({"branch": branch, "transform": key, **v})
    return out


@router.delete("/{repo_id}/incremental")
def reset_incremental(repo_id: str, transform: str, branch: Optional[str] = None) -> dict:
    """Forget what an incremental transform processed: its next build is a snapshot over every input row."""
    with _lock:
        rec = _repo(repo_id)
        states = _incremental_states(repo_id)
        removed = states.pop(f"{_branch(rec, branch)['name']}::{transform}", None)
        _write(repo_id, "incremental.json", states)
    return {"reset": bool(removed)}


def _builds(repo_id: str) -> list[dict]:
    return _read(repo_id, "builds.json", [])


@router.get("/tools/builds")
def recent_builds(limit: int = 100, since: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    """Every repository's latest builds, newest first, for the Builds app (logs cut short)."""
    out = [b for b in all_builds() if (not since or b["at"] >= since) and (not status or b["status"] == status)]
    out.sort(key=lambda b: b["at"], reverse=True)
    return [{**b, "logs": (b.get("logs") or "")[-2000:]} for b in out[: max(1, min(limit, 500))]]


@router.get("/{repo_id}/builds")
def list_builds(repo_id: str) -> list[dict]:
    _repo(repo_id)
    return _builds(repo_id)


def all_builds() -> list[dict]:
    """Every repository's builds the caller may see (markings on the repository), for lineage and the Builds app."""
    out = []
    for p in DIR.glob("*/repo.json"):
        rec = ontology._read(p)
        if rec and auth.visible_resources("code_repo", [rec]):
            out += [{**b, "repo_name": rec["name"], "default_branch": rec.get("default_branch", "master")} for b in _builds(rec["id"])]
    return out


def all_repos() -> list[dict]:
    """Every repository the caller may see (markings): libraries, UDFs and lineage only list those."""
    out = []
    for p in DIR.glob("*/repo.json"):
        try:
            out.append(_repo(p.parent.name))
        except HTTPException:
            pass
    return auth.visible_resources("code_repo", out)


def transform_source(repo_id: str, key: str, commit_id: Optional[str] = None) -> dict:
    """The file holding a transform (at a commit, else the default branch's last commit), for Lineage's Code tab."""
    rec = _repo(repo_id)
    path, _, fn = key.partition("::")
    files = _commit_files(repo_id, commit_id) if commit_id and _commit_meta(rec, commit_id) else _commit_files(repo_id, rec["branches"][rec["default_branch"]]["head"])
    content = files.get(path)
    if content is None:
        content = rec["branches"][rec["default_branch"]]["files"].get(path, "")
    line = next((i + 1 for i, l in enumerate(content.splitlines()) if re.match(rf"\s*def {re.escape(fn)}\(", l)), None)
    return {"repo_id": repo_id, "repo": rec["name"], "path": path, "function": fn, "content": content, "line": line, "commit": commit_id}


# -- schedules ------------------------------------------------------------------------------------
# A schedule builds one transform on the default branch's last commit: every N minutes, on a cron expression
# (five fields, in a time zone), and/or when an input dataset changes. A failed build is retried `retries` times,
# `retry_delay_minutes` apart. "Run now" starts the same run (with retries) immediately.

CRON_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_running: set[str] = set()


def _cron_error(cron: str) -> Optional[str]:
    """None when `cron` is a valid five-field cron expression (numbers, *, ranges, lists and /steps)."""
    fields = cron.split()
    if len(fields) != 5:
        return "a cron expression has five fields: minute hour day-of-month month day-of-week"
    names = ["minute", "hour", "day of month", "month", "day of week"]
    for f, (lo, hi), name in zip(fields, CRON_RANGES, names):
        for part in f.split(","):
            rng, _, step = part.partition("/")
            if step and (not step.isdigit() or int(step) == 0):
                return f"bad step in the {name} field: {part}"
            if rng in ("*", ""):
                if rng == "" and not step:
                    return f"empty {name} field"
                continue
            bounds = rng.split("-", 1)
            if not all(x.isdigit() for x in bounds):
                return f"bad {name} field: {part}"
            if any(not lo <= int(x) <= hi for x in bounds):
                return f"the {name} field must be within {lo}-{hi}: {part}"
            if len(bounds) == 2 and int(bounds[0]) > int(bounds[1]):
                return f"bad range in the {name} field: {part}"
    return None


class ScheduleIn(BaseModel):
    transform: str
    every_minutes: Optional[int] = Field(None, ge=1)
    # five-field cron ("0 6 * * 1-5"), evaluated in `timezone`
    cron: Optional[str] = Field(None, max_length=120)
    timezone: str = "UTC"
    on_input_update: bool = False
    enabled: bool = True
    retries: int = Field(0, ge=0, le=10)
    retry_delay_minutes: float = Field(5, ge=0, le=1440)
    # transaction-limited inputs: build again after a successful build until the output is up to date with them
    retrigger_until_up_to_date: bool = False


RETRIGGER_MAX = 100


def _validate_schedule(s: dict) -> None:
    s["cron"] = (s.get("cron") or "").strip() or None
    if not s.get("every_minutes") and not s.get("on_input_update") and not s["cron"]:
        raise HTTPException(400, "pick an interval, a cron expression, input updates, or a combination")
    if s["cron"] and (err := _cron_error(s["cron"])):
        raise HTTPException(400, err)
    try:
        ZoneInfo(s.get("timezone") or "UTC")
    except Exception:  # noqa: BLE001
        raise HTTPException(400, f"unknown time zone {s.get('timezone')}") from None


def _next_runs(s: dict, count: int = 3) -> list[str]:
    out: list[str] = []
    if s.get("cron"):
        import pipeline_runtime

        try:
            out += pipeline_runtime.next_runs(s["cron"], s.get("timezone") or "UTC", count)
        except Exception:  # noqa: BLE001
            pass
    if s.get("every_minutes"):
        last = datetime.fromisoformat(s["last_run_at"]) if s.get("last_run_at") else None
        nxt = max(last + timedelta(minutes=s["every_minutes"]), datetime.now(timezone.utc)) if last else datetime.now(timezone.utc)
        out.append(nxt.isoformat(timespec="seconds"))
    return sorted(out, key=lambda x: datetime.fromisoformat(x))[:count]


@router.get("/{repo_id}/schedules")
def list_schedules(repo_id: str) -> list[dict]:
    rec = _repo(repo_id)
    return [{**s, "running": s["id"] in _running, "next_runs": _next_runs(s) if s.get("enabled") else [],
             "owner_user": auth.user_label(s.get("owner") or s.get("created_by"))} for s in rec["schedules"]]


@router.get("/tools/cron")
def cron_preview(cron: str, timezone_name: str = "UTC") -> dict:
    """The next times a cron expression fires in a time zone (the schedule editor shows them)."""
    _validate_schedule({"cron": cron, "timezone": timezone_name})
    return {"next": _next_runs({"cron": cron, "timezone": timezone_name}, 5)}


@router.post("/{repo_id}/schedules")
def add_schedule(repo_id: str, req: ScheduleIn) -> dict:
    s = {"id": ontology._new_id("sched"), **req.model_dump(), "created_at": _now(), "last_run_at": None,
         # scheduled builds' code calls the API as this user (job token); the last user to change it owns it
         "created_by": auth.actor_id(), "owner": auth.actor_id()}
    _validate_schedule(s)
    with _lock:
        rec = _repo(repo_id)
        rec["schedules"] = [*rec["schedules"], s]
        _save(rec)
        return s


@router.put("/{repo_id}/schedules/{sched_id}")
def update_schedule(repo_id: str, sched_id: str, req: ScheduleIn) -> dict:
    """Fields left out of the request keep their values (older clients send only some)."""
    with _lock:
        rec = _repo(repo_id)
        s = next((x for x in rec["schedules"] if x["id"] == sched_id), None)
        if not s:
            raise HTTPException(404, "schedule not found")
        changes = req.model_dump(exclude_unset=True)
        merged = {**s, **changes}
        _validate_schedule(merged)
        # a code repository schedule is user-scoped: whoever changes what it runs becomes its owner (pausing does not)
        if any(merged.get(k) != s.get(k) for k in changes if k != "enabled") and auth.actor_id():
            merged["owner"] = auth.actor_id()
        s.update(merged)
        _save(rec)
        return s


@router.delete("/{repo_id}/schedules/{sched_id}")
def delete_schedule(repo_id: str, sched_id: str) -> dict:
    with _lock:
        rec = _repo(repo_id)
        rec["schedules"] = [x for x in rec["schedules"] if x["id"] != sched_id]
        _save(rec)
        return {"deleted": sched_id}


def _set_schedule(repo_id: str, sched_id: str, **changes: Any) -> Optional[dict]:
    with _lock:
        rec = _repo(repo_id)
        s = next((x for x in rec["schedules"] if x["id"] == sched_id), None)
        if s:
            s.update(changes)
            _save(rec)
        return s


def _run_schedule(repo_id: str, sched_id: str, trigger: str) -> Optional[dict]:
    """One scheduled run: build, and retry a failed build up to `retries` times. Returns the last build."""
    b = None
    try:
        attempt = 0
        while True:
            rec = _repo(repo_id)
            s = next((x for x in rec["schedules"] if x["id"] == sched_id), None)
            if not s:
                return b
            head = rec["branches"][rec["default_branch"]]["head"]
            owner = s.get("owner") or s.get("created_by")
            if auth.enabled() and not owner:
                _set_schedule(repo_id, sched_id, last_status="failed", last_finished_at=_now(),
                              last_error="did not start: the schedule has no owner it can run as; an editor must take it over (edit and save it)")
                return b
            if auth.enabled() and owner and auth.principal_of(owner) is None:
                label = auth.user_label(owner) or {}
                _set_schedule(repo_id, sched_id, last_status="failed", last_finished_at=_now(),
                              last_error=f"did not start: the schedule's owner {label.get('display_name') or label.get('username') or owner} is "
                                         f"{label.get('status', 'deleted')}; an editor must take it over (edit and save it)")
                return b
            if auth.enabled() and owner and not auth.can_run_code(auth.principal_of(owner)):
                _set_schedule(repo_id, sched_id, last_status="failed", last_finished_at=_now(),
                              last_error="did not start: the schedule's owner may not run code on this machine (Control Panel → Security → "
                                         "Code execution); someone allowed to must take it over (edit and save it)")
                return b
            _set_schedule(repo_id, sched_id, last_status="running", attempt=attempt + 1)
            # the platform reads the inputs and writes the output as the owner too (their markings and Project roles),
            # not only the user code (its job token): a scheduler thread is otherwise the system
            token = auth._principal.set(auth.principal_of(owner) if auth.enabled() and owner else None)
            try:
                try:
                    # the repository's markings and its Project's Editor role: an owner who lost one no longer builds
                    auth.check_resource("code_repo", repo_id, "editor")
                except HTTPException as e:
                    label = auth.user_label(owner) or {}
                    _set_schedule(repo_id, sched_id, last_status="failed", last_finished_at=_now(),
                                  last_error=f"did not start: the schedule's owner {label.get('display_name') or label.get('username') or owner} "
                                             f"can no longer use this repository ({e.detail}); an editor must take it over (edit and save it)")
                    return b
                b = build_transform(rec, _commit_files(rec["id"], head), rec["default_branch"], s["transform"],
                                    trigger if not attempt else f"{trigger} (retry {attempt})", head, run_as=owner)
            finally:
                auth._principal.reset(token)
            done = b["status"] == "succeeded" or attempt >= int(s.get("retries") or 0)
            _set_schedule(repo_id, sched_id, last_status=b["status"] if done else "retrying", last_build_id=b["id"],
                          last_error=b.get("error"), last_finished_at=_now())
            behind = b["status"] == "succeeded" and (b.get("incremental") or {}).get("up_to_date") is False
            if behind and s.get("retrigger_until_up_to_date") and int(s.get("retriggered") or 0) < RETRIGGER_MAX:
                # a transaction limit left unprocessed transactions: build the next batch right away
                _set_schedule(repo_id, sched_id, retriggered=int(s.get("retriggered") or 0) + 1)
                trigger, attempt = "re-trigger (not up to date)", 0
                continue
            if done:
                _set_schedule(repo_id, sched_id, retriggered=0)
                return b
            attempt += 1
            time.sleep(float(s.get("retry_delay_minutes") or 0) * 60)
    except Exception as e:  # noqa: BLE001
        _set_schedule(repo_id, sched_id, last_status="failed", last_error=str(getattr(e, "detail", None) or e)[:500])
        return b
    finally:
        _running.discard(sched_id)


def _start_schedule(repo_id: str, sched_id: str, trigger: str, wait: bool = False) -> Optional[dict]:
    with _lock:
        if sched_id in _running:
            return None
        _running.add(sched_id)
    _set_schedule(repo_id, sched_id, last_run_at=_now(), last_status="running")
    if wait:
        return _run_schedule(repo_id, sched_id, trigger)
    threading.Thread(target=_run_schedule, args=(repo_id, sched_id, trigger), daemon=True, name=f"code-schedule-{sched_id}").start()
    return None


@router.post("/{repo_id}/schedules/{sched_id}/run")
def run_schedule(repo_id: str, sched_id: str, wait: bool = False) -> dict:
    """Run now: build the schedule's transform on the default branch's last commit (with its retries)."""
    rec = _repo(repo_id)
    if not any(x["id"] == sched_id for x in rec["schedules"]):
        raise HTTPException(404, "schedule not found")
    if sched_id in _running:
        raise HTTPException(409, "this schedule is already running")
    b = _start_schedule(repo_id, sched_id, "run now", wait)
    s = next(x for x in _repo(repo_id)["schedules"] if x["id"] == sched_id)
    return {**s, "running": sched_id in _running, "build": b}


def _inputs_changed(rec: dict, key: str) -> bool:
    """Whether an input changed since the transform's last build on the default branch (failed builds count too:
    rebuilding unchanged inputs would fail the same way, and retries are the schedule's job)."""
    last = next((b for b in _builds(rec["id"]) if b["transform"] == key and b.get("inputs")
                 and b.get("branch", rec["default_branch"]) == rec["default_branch"]), None)
    if not last:
        return True
    for i in last["inputs"]:
        if i.get("media"):
            if _media_version(i["item_id"]) != i.get("updated_at"):
                return True
            continue
        item = db.drive_get(i["item_id"])
        if item and str(item.get("updated_at")) != i.get("updated_at"):
            return True
    return False


def _due(rec: dict, s: dict, now: datetime) -> bool:
    """Whether a schedule should run now; a cron match is recorded so one minute fires once."""
    if s.get("cron"):
        import pipeline_runtime

        try:
            local = now.astimezone(ZoneInfo(s.get("timezone") or "UTC")).replace(second=0, microsecond=0)
        except Exception:  # noqa: BLE001
            local = None
        if local and pipeline_runtime.cron_matches(s["cron"], local) and s.get("last_cron") != local.isoformat():
            _set_schedule(rec["id"], s["id"], last_cron=local.isoformat())
            return True
    last = datetime.fromisoformat(s["last_run_at"]) if s.get("last_run_at") else None
    if s.get("every_minutes") and (not last or last + timedelta(minutes=s["every_minutes"]) <= now):
        return True
    if s.get("on_input_update") and (not last or last + timedelta(minutes=1) <= now):
        return _inputs_changed(rec, s["transform"])
    return False


def scheduler_tick(now: Optional[datetime] = None) -> list[str]:
    """Start every due schedule; returns their ids."""
    now = now or datetime.now(timezone.utc)
    started = []
    for rec in all_repos():
        for s in rec["schedules"]:
            if not s.get("enabled") or s["id"] in _running:
                continue
            try:
                if _due(rec, s, now):
                    _start_schedule(rec["id"], s["id"], "schedule")
                    started.append(s["id"])
            except Exception:  # noqa: BLE001
                pass
    return started


def _scheduler() -> None:
    last_upgrades = time.monotonic() - UPGRADE_EVERY_S + 120
    while True:
        time.sleep(SCHEDULE_TICK)
        try:
            scheduler_tick()
        except Exception:  # noqa: BLE001
            pass
        if time.monotonic() - last_upgrades >= UPGRADE_EVERY_S:
            last_upgrades = time.monotonic()
            try:
                upgrade_tick()
            except Exception:  # noqa: BLE001
                log.exception("repository upgrades")


# ------------------------------------------------------------------------------------------------
# repository upgrades (palantir.com/docs/foundry/code-repositories/repository-upgrades)
# ------------------------------------------------------------------------------------------------

UPGRADE_EVERY_S = 3600


def _template_kind(files: dict[str, str]) -> Optional[str]:
    plugins = set().union(*[code_lint.plugins_of(c) for p, c in files.items() if p.endswith("build.gradle")])
    if code_lint.PLUGIN_LIBRARY in plugins:
        return "python-library"
    if code_lint.PLUGIN_PYTHON in plugins:
        return "python"
    return None


def _props(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        m = re.match(r"^\s*([^#!=\s][^=]*?)\s*=\s*(.*?)\s*$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _merge_props(text: str, keys: dict[str, str]) -> str:
    """A properties file with the template's keys: their values replaced where present (the template wins), the rest
    appended; every other line is kept."""
    lines = text.splitlines()
    seen = set()
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)([^#!=\s][^=]*?)(\s*=\s*)(.*?)\s*$", line)
        if m and m.group(2) in keys:
            lines[i] = f"{m.group(1)}{m.group(2)}{m.group(3)}{keys[m.group(2)]}"
            seen.add(m.group(2))
    lines += [f"{k}={v}" for k, v in keys.items() if k not in seen]
    return "\n".join(lines) + "\n"


def upgrade_plan(files: dict[str, str]) -> dict:
    """What upgrading a branch's files to the current template version changes: overwritten files (ci.yml,
    settings.gradle; `user_changes` when the branch edited one), merged properties files (gradle.properties,
    versions.properties: the template's value wins for a common key). conda_recipe/, src/ and build.gradle files are
    never touched. `files`: the upgraded files."""
    kind = _template_kind(files)
    if not kind:
        return {"kind": None, "available": False, "changes": [],
                "reason": "only Python transforms and Python library repositories are upgraded (this template type does not support it)"}
    current = int(_props(files.get("gradle.properties") or "").get("transformsTemplateVersion") or 1)
    overwrite, merge = code_py_templates.upgrade_files(kind)
    new_files = dict(files)
    changes = []
    for path, content in overwrite.items():
        old = files.get(path)
        if old == content:
            continue
        user = old is not None and old not in code_py_templates.PAST_OVERWRITES.get(path, [])
        changes.append({"path": path, "action": "add" if old is None else "overwrite", "user_changes": user})
        new_files[path] = content
    for path, keys in merge.items():
        old = files.get(path)
        merged = _merge_props(old or "", keys)
        if merged != (old or ""):
            changes.append({"path": path, "action": "merge" if old is not None else "add", "user_changes": False, "keys": sorted(keys)})
            new_files[path] = merged
    return {"kind": kind, "current": current, "latest": code_py_templates.TEMPLATE_VERSION, "available": bool(changes), "changes": changes,
            "files": new_files}


def _open_upgrade_pr(rec: dict, target: str) -> Optional[dict]:
    prs = _prs(rec["id"])
    return next((p for p in prs if p["status"] == "open" and p["target"] == target and p.get("upgrade")), None)


@router.get("/{repo_id}/upgrade")
def get_upgrade(repo_id: str, branch: Optional[str] = None) -> dict:
    """Whether the branch can be upgraded to the current template version, and what the upgrade changes."""
    rec = _repo(repo_id)
    b = _branch(rec, branch)
    plan = upgrade_plan(_commit_files(repo_id, b["head"]) or b["files"])
    plan.pop("files", None)
    pr = _open_upgrade_pr(rec, b["name"])
    return {**plan, "branch": b["name"], "pull_request": {"id": pr["id"], "title": pr["title"], "upgrade": pr["upgrade"]} if pr else None,
            "auto_merge": bool(rec["settings"].get("auto_merge_upgrades"))}


def start_upgrade(repo_id: str, branch: Optional[str] = None) -> dict:
    """Open an upgrade pull request: a branch upgrade/template-<n>/<branch> with the upgraded files, committed (which
    runs its checks), into the branch."""
    with _lock:
        rec = _repo(repo_id)
        b = _branch(rec, branch)
        target = b["name"]
        if _open_upgrade_pr(rec, target):
            raise HTTPException(409, f"an upgrade pull request into {target} is already open")
        plan = upgrade_plan(_commit_files(repo_id, b["head"]))
        if not plan["available"]:
            raise HTTPException(400, plan.get("reason") or f"{target} is up to date (template version {plan.get('latest')})")
        name = f"upgrade/template-{plan['latest']}/{target}"
        i = 2
        while name in rec["branches"]:
            name = f"upgrade/template-{plan['latest']}/{target}-{i}"
            i += 1
        now = _now()
        rec["branches"][name] = {"name": name, "head": b["head"], "files": plan["files"], "created_from": target, "created_at": now, "updated_at": now}
        c = _commit(rec, name, f"Upgrade to template version {plan['latest']}")
        lines = [f"- `{ch['path']}`: {ch['action']}" + (" (overwrites changes made in this repository)" if ch["user_changes"] else "") for ch in plan["changes"]]
        user = [ch["path"] for ch in plan["changes"] if ch["user_changes"]]
        pr = create_pr(repo_id, PrIn(source=name, target=target, title=f"Repository upgrade: template version {plan['latest']}",
                                     description="Upgrades the repository to the latest Python transforms template.\n\n" + "\n".join(lines)))
        prs = _prs(repo_id)
        for p in prs:
            if p["id"] == pr["id"]:
                p["upgrade"] = {"version": plan["latest"], "from": plan["current"], "commit": c["id"], "user_changes": user, "manual": None}
                pr = p
        _write(repo_id, "prs.json", prs)
        return {**pr, "state": _pr_status(rec, pr)}


class UpgradeIn(BaseModel):
    branch: Optional[str] = None


@router.post("/{repo_id}/upgrade")
def upgrade(repo_id: str, req: UpgradeIn) -> dict:
    """… → Upgrade: open the upgrade pull request for a branch."""
    return start_upgrade(repo_id, req.branch)


def _auto_merge_upgrade(repo_id: str, branch: str, commit_id: str, status: str) -> None:
    """After a commit's checks: merge an open upgrade pull request from that branch when automatic upgrades are on,
    its checks passed and nothing needs a person (Foundry's cases: someone committed to the upgrade branch, the
    upgrade overwrites user-authored files, the merge is blocked)."""
    with _lock:
        rec = _repo(repo_id)
        prs = _prs(repo_id)
        pr = next((p for p in prs if p["status"] == "open" and p["source"] == branch and p.get("upgrade")), None)
        if not pr or not rec["settings"].get("auto_merge_upgrades") or status != "passed":
            return
        up = pr["upgrade"]
        reason = None
        if rec["branches"].get(branch, {}).get("head") != commit_id or commit_id != up["commit"]:
            reason = "someone committed to the upgrade branch after it was opened"
        elif up.get("user_changes"):
            reason = "it overwrites files changed in this repository: " + ", ".join(up["user_changes"])
        else:
            state = _pr_status(rec, pr)
            if not state["can_merge"]:
                reason = "; ".join(state["blockers"])
        if reason:
            up["manual"] = f"merge by hand: {reason}"
            _write(repo_id, "prs.json", prs)
            return
        mode = next((m for m in ("merge", "squash", "fast_forward") if m in rec["settings"]["merge_modes"]), "merge")
    merge_pr(repo_id, pr["id"], PrMerge(mode=mode, message=f"{pr['title']} (#{pr['id']}, merged automatically)"))


def upgrade_tick() -> None:
    """Open upgrade pull requests into the default branch of repositories with automatic upgrades on."""
    for rec in all_repos():
        if not rec["settings"].get("auto_merge_upgrades"):
            continue
        try:
            start_upgrade(rec["id"], rec["default_branch"])
        except HTTPException:
            pass


@router.get("/tools/runtimes")
def runtimes() -> dict:
    """Languages transforms can be written in on this server."""
    return {"python": sys.version.split()[0], "sql": f"SQLite {sqlite3.sqlite_version}",
            "java": {"available": code_java.available(), "version": code_java.version(), "error": None if code_java.available() else code_java.NO_JDK},
            "r": {"available": bool(code_r.executable()), "version": code_r.version(), "executable": code_r.executable(),
                  "error": None if code_r.executable() else code_r.runtime_issue()}}


# ------------------------------------------------------------------------------------------------
# SQL scratchpad, libraries, AIP features
# ------------------------------------------------------------------------------------------------


class SqlIn(BaseModel):
    query: str = Field(min_length=1, max_length=20000)


BACKTICK = re.compile(r"(?:`[^`]+`\s*\.\s*)?`([^`]+)`")


@router.post("/tools/sql")
def sql(req: SqlIn) -> dict:
    """SELECT over datasets: name each one in backticks, by path or item id (`My Project/x.parquet`). An optional
    `branch`. prefix is accepted and ignored. Runs in an in-memory SQLite database; read-only, 30 s, 1,000 rows."""
    q = req.query.strip().rstrip(";")
    if not re.match(r"(?is)^\s*(with|select)\b", q):
        raise HTTPException(400, "only SELECT (or WITH … SELECT) queries")
    con = sqlite3.connect(":memory:")
    started = time.monotonic()
    con.set_progress_handler(lambda: 1 if time.monotonic() - started > SQL_SECONDS else 0, 10_000)
    tables: dict[str, str] = {}
    try:
        def swap(m: re.Match) -> str:
            ref = m.group(1)
            if ref not in tables:
                try:
                    item = resolve_dataset(ref)
                except ValueError as e:
                    raise HTTPException(400, str(e)) from None
                import pyarrow.parquet as pq

                df = pq.read_table(io.BytesIO(drive.read_bytes(item))).slice(0, SQL_SOURCE_ROWS).to_pandas()
                for c in df.columns:
                    if df[c].dtype == object:
                        df[c] = df[c].map(lambda v: json.dumps(v, default=str) if isinstance(v, (list, dict)) else v)
                tables[ref] = f"t{len(tables)}"
                df.to_sql(tables[ref], con, index=False)
            return f'"{tables[ref]}"'

        sql_text = BACKTICK.sub(swap, q)
        con.execute("PRAGMA query_only = ON")
        cur = con.execute(sql_text)
        cols = [d[0] for d in cur.description or []]
        rows = cur.fetchmany(SQL_ROWS + 1)
        return {"columns": cols, "rows": [dict(zip(cols, r)) for r in rows[:SQL_ROWS]], "truncated": len(rows) > SQL_ROWS,
                "ms": int((time.monotonic() - started) * 1000), "tables": tables}
    except sqlite3.Error as e:
        raise HTTPException(400, "interrupted: the query took longer than 30 s" if "interrupt" in str(e) else f"SQL error: {e}") from None
    finally:
        con.close()


@router.get("/tools/libraries")
def libraries() -> list[dict]:
    """Python packages transforms can import: the API's environment, and libraries published by Python library
    repositories (source "library")."""
    from importlib import metadata

    seen: dict[str, dict] = {}
    for d in metadata.distributions():
        name = d.metadata.get("Name") or ""
        if name and name.lower() not in seen:
            seen[name.lower()] = {"name": name, "version": d.version, "summary": (d.metadata.get("Summary") or "")[:200], "source": "environment"}
    for name, versions in _readable_libraries()[0].items():
        ok = [v for v in versions if v["ok"]]
        if ok:
            seen[f"lib:{name}"] = {"name": name, "version": ok[0]["version"], "summary": f"Python library published by {ok[0]['repo_name']}",
                                   "source": "library", "repo_id": ok[0]["repo_id"], "versions": [v["version"] for v in ok]}
    return sorted(seen.values(), key=lambda x: x["name"].lower())


def _readable_libraries(rec: Optional[dict] = None) -> tuple[dict[str, list[dict]], dict[str, str]]:
    """(the libraries the caller may use, {library: repository name} of those whose repository they cannot see):
    consumers need access to a library's repository (its markings; Foundry: the Viewer role). With a repository: also
    the Conda / PyPI packages of the Artifacts repositories in its Settings → Artifacts."""
    libs = python_libraries()
    extra = _artifact_libraries(rec)
    repo_ids = {v["repo_id"] for versions in libs.values() for v in versions}
    seen = {r["id"] for r in auth.visible_resources("code_repo", [{"id": i} for i in repo_ids])}
    readable = {n: vs for n, vs in libs.items() if all(v["repo_id"] in seen for v in vs)}
    denied = {n: vs[0]["repo_name"] for n, vs in libs.items() if n not in readable}
    for n, vs in extra.items():
        readable[n] = [*readable.get(n, []), *vs] if n in readable else vs
        denied.pop(n, None)
    return readable, denied


def _artifact_libraries(rec: Optional[dict]) -> dict[str, list[dict]]:
    arts = [r for r in _backing(rec) if r.startswith("art-")] if rec else []
    if not arts:
        return {}
    import artifact_repos

    return artifact_repos.python_libraries(arts)


CONDA_PLATFORMS = ("noarch", "linux-64", "linux-aarch64", "osx-64", "osx-arm64", "win-64")


def _conda_versions(repo_id: str) -> list[dict]:
    """The published versions of a library repository (newest first), for its conda channel."""
    auth.check_resource("code_repo", repo_id)
    _repo(repo_id)
    return [v for versions in python_libraries().values() for v in versions if v["repo_id"] == repo_id and v["ok"]]


def _conda_build(repo_id: str, v: dict) -> tuple[str, bytes, dict]:
    files = _commit_files(repo_id, v["commit"])
    meta_file = code_env.meta_path(files)
    depends = code_env.parse_meta(files[meta_file])["run"] if meta_file else ["python"]
    return code_env.conda_package(v["name"], v["version"], {p: files[p] for p in v["files"] if p in files}, depends or ["python"])


@artifacts_router.get("/repositories/{repo_id}/contents/release/conda/{platform}/repodata.json")
def conda_repodata(repo_id: str, platform: str) -> dict:
    """A library repository as a conda channel: noarch lists every published version (a conda noarch: python
    package built from the tagged commit); the other platforms are empty, as conda reads both. Use it with a token:
    conda install -c https://<user>:<api token>@<host>/api/artifacts/repositories/<id>/contents/release/conda <name>, or
    curl -H "Authorization: Bearer <token>" .../repodata.json."""
    if platform not in CONDA_PLATFORMS:
        raise HTTPException(404, f"unknown platform {platform} ({', '.join(CONDA_PLATFORMS)})")
    packages = {}
    if platform == "noarch":
        for v in _conda_versions(repo_id):
            fname, _, entry = _conda_build(repo_id, v)
            packages[fname] = entry
    return {"info": {"subdir": platform}, "packages": packages, "packages.conda": {}, "removed": [], "repodata_version": 1}


@artifacts_router.get("/repositories/{repo_id}/contents/release/conda/{platform}/{package}")
def conda_download(repo_id: str, platform: str, package: str) -> Response:
    """One package of the channel (<name>-<version>-py_0.tar.bz2)."""
    if platform != "noarch":
        raise HTTPException(404, "the library's packages are noarch")
    for v in _conda_versions(repo_id):
        fname, data, _ = _conda_build(repo_id, v)
        if fname == package:
            return Response(data, media_type="application/x-tar", headers={"Content-Disposition": f'attachment; filename="{fname}"'})
    raise HTTPException(404, f"{package} is not published by this repository")


def python_libraries() -> dict[str, list[dict]]:
    """Every Python library repository's versions, newest first: {package: [{name, version, repo_id, repo_name,
    commit, tagged_at, ok, reason, files}]}. A version is a tag (SLS x.y.z) whose commit passed its checks."""
    out: dict[str, list[dict]] = {}
    recalled = _recalls()
    for rec in all_repos():
        default = rec["branches"][rec["default_branch"]]["files"]
        name = code_env.library_package_name(default, rec["name"])
        if not name:
            continue
        checks = _checks(rec["id"])
        for tag in rec.get("tags") or []:
            files = _commit_files(rec["id"], tag["commit"])
            check = next((c for c in checks if c.get("commit") == tag["commit"]), None)
            reason = None
            if not code_env.SLS_VERSION.match(tag["name"]):
                reason = "the tag is not an SLS version (x.y.z or x.y.z-rcN)"
            elif not check:
                reason = "the checks of the tagged commit have not run yet"
            elif check["status"] != "passed":
                reason = "the checks of the tagged commit failed"
            elif (recalled.get(name) or {}).get(tag["name"]):
                r = recalled[name][tag["name"]]
                reason = f"recalled: {r.get('reason') or 'no reason given'}"
            out.setdefault(name, []).append({"name": name, "version": tag["name"], "repo_id": rec["id"], "repo_name": rec["name"], "commit": tag["commit"],
                                             "tagged_at": tag.get("at"), "ok": reason is None, "reason": reason,
                                             "recalled": (recalled.get(name) or {}).get(tag["name"]),
                                             "files": sorted(code_env.library_sources(files))})
    from packaging.version import InvalidVersion, Version

    def key(v: dict):
        try:
            return Version(v["version"].split("-")[0])
        except InvalidVersion:
            return Version("0")

    return {k: sorted(v, key=key, reverse=True) for k, v in out.items()}


def _recalls() -> dict[str, dict[str, dict]]:
    """Recalled library versions: {package: {version: {reason, at, by}}} (the Artifacts app's Recall)."""
    p = DIR / "library-recalls.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


class LibraryRecallIn(BaseModel):
    name: str
    version: str
    reason: str = Field("", max_length=500)


def _set_library_recall(req: LibraryRecallIn, recall: bool) -> dict:
    """Recall (or unrecall) a published library version: a recalled version no longer resolves in meta.yaml, so
    consumers stop building with it (a locked version moves to the newest one still published)."""
    user = auth.require_user()
    name = code_env._norm(req.name)
    versions = python_libraries().get(name) or []
    v = next((x for x in versions if x["version"] == req.version), None)
    if not v:
        raise HTTPException(404, f"no published version {req.version} of {req.name}")
    # recalling (or unrecalling) a library version: Editors of the library repository's Project
    auth.check_resource("code_repo", v["repo_id"], "editor")
    if recall and not req.reason.strip():
        raise HTTPException(400, "give the reason for recalling the version")
    with _lock:
        rec = _recalls()
        if recall:
            rec.setdefault(name, {})[req.version] = {"reason": req.reason.strip(), "at": _now(), "by": user.get("username") or user.get("id")}
        else:
            (rec.get(name) or {}).pop(req.version, None)
        p = DIR / "library-recalls.json"
        p.write_text(json.dumps({k: x for k, x in rec.items() if x}, indent=1), "utf-8")
    return {"name": name, "version": req.version, "recalled": recall}


@router.post("/tools/artifacts/recall")
def recall_library(req: LibraryRecallIn) -> dict:
    return _set_library_recall(req, True)


@router.post("/tools/artifacts/unrecall")
def unrecall_library(req: LibraryRecallIn) -> dict:
    return _set_library_recall(req, False)


def _consumers(package: str) -> list[dict]:
    """Repositories whose default branch requires a package in meta.yaml."""
    out = []
    for rec in all_repos():
        files = rec["branches"][rec["default_branch"]]["files"]
        path = code_env.meta_path(files)
        if not path:
            continue
        meta = code_env.parse_meta(files[path])
        for spec in meta["run"] + meta["pip"]:
            n = re.split(r"[\s<>=!]", spec.strip(), maxsplit=1)[0]
            if code_env._norm(n) == package:
                out.append({"repo_id": rec["id"], "repo_name": rec["name"], "requested": spec})
    return out


# -- language models for transforms (palantir_models, code_models.py) ----------------------------------------


def _chat_models() -> list[dict]:
    import knowledge

    return knowledge.models()


def _embedding_models() -> list[dict]:
    import vectors

    # provider models, then registered ones (functions implementing the Embedding function interface)
    return [{"id": m["id"], "label": m.get("label", m["id"]), "vendor": m.get("vendor"), "dimension": m.get("dimension"),
             **({k: m.get(k) for k in ("registered", "version", "function_id", "repo_id", "description")} if m.get("registered") else {})}
            for m in vectors.embedding_models()]


def run_ts_function(repo_id: str, file: str, function: str, args: dict, rng: dict, branch: Optional[str] = None) -> dict:
    """A function-backed time series (ts_derived.py): run `function` of `file` on the branch's last commit with
    `args` (objects as {"__object__": {...}}); returns {ok, points: [[epoch ms, value], …]} or {ok: False, error}."""
    rec = _repo(repo_id)
    b = _branch(rec, branch)
    files = _commit_files(repo_id, b.get("head")) if b.get("head") else dict(b.get("files") or {})
    if file not in files:
        raise HTTPException(404, f"{file} is not in the {b.get('name') or branch or rec['default_branch']} branch's last commit")
    res = _run(files, {"mode": "function", "file": file, "function": function, "args": args, "range": rng, "timeout_s": 120}, rec)
    res["commit"] = b.get("head")
    return res


@router.get("/tools/models")
def language_models() -> dict:
    """The Model Catalog: chat and embedding models transforms can use, with their resource identifiers."""
    import code_models

    chat = [{**m, "kind": "chat", "rid": code_models.RID_PREFIX + m["id"],
             "inputs": ["GenericChatCompletionLanguageModelInput", "OpenAiGptChatLanguageModelInput", "AnthropicClaudeLanguageModelInput"]}
            for m in _chat_models()]
    emb = [{**m, "kind": "embedding", "rid": code_models.RID_PREFIX + m["id"], "available": True, "inputs": ["GenericEmbeddingModelInput"]}
           for m in _embedding_models()]
    return {"chat": chat, "embedding": emb, "prefix": code_models.RID_PREFIX,
            "aliases": "Foundry's model names (gpt-4_azure, text-embedding-ada-002_azure, ...) use the default chat / embedding model."}


class ChatIn(BaseModel):
    model: str
    messages: list[dict] = Field(min_length=1, max_length=200)
    max_tokens: Optional[int] = Field(None, ge=1, le=32000)
    temperature: Optional[float] = Field(None, ge=0, le=2)


class EmbedIn(BaseModel):
    model: str
    inputs: list[str] = Field(min_length=1, max_length=2048)


@router.post("/tools/models/chat")
def model_chat(req: ChatIn) -> dict:
    """One chat completion for a transform (its messages: SYSTEM / USER / ASSISTANT)."""
    ids = {m["id"] for m in _chat_models()}
    model = req.model if req.model in ids else ontology.DEFAULT_LLM
    system = "\n\n".join(str(m.get("content") or "") for m in req.messages if str(m.get("role")).upper() == "SYSTEM")
    rest = [m for m in req.messages if str(m.get("role")).upper() != "SYSTEM"]
    if len(rest) == 1:
        user = str(rest[0].get("content") or "")
    else:
        user = "\n\n".join(f"{str(m.get('role')).capitalize()}: {m.get('content')}" for m in rest) + "\n\nAssistant:"
    try:
        text = pipeline_ai.chat(model, system, user, None, req.temperature if req.temperature is not None else 0, max(req.max_tokens or 2048, 1024))  # thinking models spend small budgets before answering
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the language model is unavailable: {str(e)[:300]}") from None
    return {"content": text, "model": model}


@router.post("/tools/models/embeddings")
def model_embeddings(req: EmbedIn) -> dict:
    import vectors

    models = {m["id"]: m for m in _embedding_models()}
    model = req.model if req.model in models else next(iter(models))
    try:
        # a registered model's dimension is its own (0: whatever it answers, checked against what it answered before)
        vecs, _cost = vectors.embed(req.inputs, model, int(models[model].get("dimension") or (0 if models[model].get("registered") else 1024)))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the embedding model is unavailable: {str(e)[:300]}") from None
    return {"embeddings": vecs, "model": model}


# -- sharing Java code between repositories (Palantir's "Share code across repositories", "Artifact settings") ---------
# Every commit of a Java repository's default branch publishes its compiled code as a jar, version 0.<n>.0 (n: the
# commit's position in the branch history); a dependent repository adds the shared repository in Settings → Artifacts
# and references it in its subproject's build.gradle: compile '<SHARED_REPO_RID>:<GRADLE_SUBPROJECT>:<VERSION>'.

JAVA_RID_PREFIX = "ri.stemma.main.repository."
JAVA_VERSIONS_SHOWN = 30


def java_rid(repo_id: str) -> str:
    return JAVA_RID_PREFIX + repo_id


def _java_versions(rec: dict) -> list[dict]:
    """Published Java versions of a repository, newest first: {version, commit, at, message, subprojects, published}."""
    head = rec["branches"][rec["default_branch"]]["head"]
    history = list(reversed(_history(rec, head)))  # oldest first
    out = []
    for n, c in enumerate(history, start=1):
        if len(history) - n >= JAVA_VERSIONS_SHOWN:
            continue
        subs = code_java.java_subprojects(_commit_files(rec["id"], c["id"]))
        if not subs:
            continue
        version = f"0.{n}.0"
        out.append({"version": version, "commit": c["id"], "at": c.get("at"), "message": c.get("message"), "subprojects": subs,
                    "published": all((_java_jar_path(rec["id"], s, version)).exists() for s in subs)})
    return list(reversed(out))


def _java_jar_path(repo_id: str, sub: str, version: str) -> Path:
    return _repo_dir(repo_id) / "maven" / sub / version / f"{sub}-{version}.jar"


def _backing(rec: dict) -> list[str]:
    return list((rec.get("settings") or {}).get("artifacts") or [])


def _java_deps(rec: dict, files: dict[str, str], chain: tuple[str, ...] = ()) -> tuple[dict[str, str], dict[str, str]]:
    """Jars for the Maven coordinates the repository's build.gradle files name ({coordinate: jar}), and why the others
    cannot be resolved ({coordinate: reason}). Shared repositories must be in this repository's Settings → Artifacts;
    their own dependencies are resolved the same way (and must be listed too: adding a repository adds them)."""
    deps: dict[str, str] = {}
    errors: dict[str, str] = {}
    backing = _backing(rec)
    external: list[str] = []
    for coord in code_java.project_coordinates(files):
        group, sub, version = coord.split(":", 2)
        if code_java.is_excel_parser(coord):
            # Palantir's transforms-excel-parser (Apache POI): a built-in library behind its bundle repository
            if code_java.EXCEL_BUNDLE not in backing:
                errors[coord] = f"{coord}: add {code_java.EXCEL_BUNDLE} in Settings → Artifacts first (it backs the Excel parser library)"
                continue
            try:
                jars = code_java.excel_parser_jars()
            except (RuntimeError, ValueError) as e:
                errors[coord] = f"{coord}: {e}"
                continue
            deps[coord] = str(jars[0])
            for j in jars[1:]:
                deps[f"{coord}#{j.name}"] = str(j)
            continue
        if not group.startswith(JAVA_RID_PREFIX):
            # an external Maven artifact: the Artifacts repositories in Settings → Artifacts, then Maven Central (maven.py)
            external.append(coord)
            continue
        shared_id = group[len(JAVA_RID_PREFIX):]
        if shared_id == rec["id"] or shared_id in chain:
            errors[coord] = f"{coord}: a repository cannot depend on itself (cycle {' → '.join([*chain, rec['id'], shared_id])})"
            continue
        if shared_id not in backing:
            errors[coord] = f"{coord}: add the repository in Settings → Artifacts first (it is not a backing repository of {rec['name']})"
            continue
        try:
            jar = _java_jar(shared_id, sub, version, (*chain, rec["id"]))
        except (ValueError, HTTPException) as e:
            errors[coord] = f"{coord}: {getattr(e, 'detail', None) or e}"
            continue
        deps[coord] = str(jar)
        # what the shared code itself depends on goes on the classpath too
        shared = _repo(shared_id)
        sub_deps, sub_errors = _java_deps(shared, _commit_files(shared_id, _java_version(shared, version)["commit"]), (*chain, rec["id"]))
        for c, j in sub_deps.items():
            if c.split(":", 1)[0][len(JAVA_RID_PREFIX):] not in backing:
                errors.setdefault(coord, f"{coord} depends on {c}: add that repository in Settings → Artifacts too")
            else:
                deps.setdefault(c, j)
        for c, why in sub_errors.items():
            errors.setdefault(coord, f"{coord}: its dependency {why}")
    if external:
        import maven

        try:
            jars, why = maven.Resolver([r for r in backing if r.startswith("art-")]).resolve(external, maven.spark_provided())
        except Exception as e:  # noqa: BLE001 - a resolver failure fails the coordinates, not the request
            jars, why = {}, {c: f"{c}: {e}" for c in external}
        for c, j in jars.items():
            deps.setdefault(c, j)
        errors.update(why)
    for c in list(errors):
        for k in [k for k in deps if k == c or k.startswith(c + "#")]:
            deps.pop(k, None)
    return deps, errors


def _java_version(rec: dict, version: str) -> dict:
    v = next((x for x in _java_versions(rec) if x["version"] == version), None)
    if not v:
        latest = next(iter(_java_versions(rec)), None)
        raise ValueError(f"{rec['name']} has no published version {version}" + (f" (latest: {latest['version']})" if latest else " (it has no Java code on its default branch)"))
    return v


_jar_lock = threading.Lock()


def _java_jar(shared_id: str, sub: str, version: str, chain: tuple[str, ...] = ()) -> Path:
    """The jar of a shared repository's subproject at a version, compiled and packaged the first time it is needed."""
    shared = _repo(shared_id)
    v = _java_version(shared, version)
    if sub not in v["subprojects"]:
        raise ValueError(f"{shared['name']} {version} has no Java subproject {sub} (it has {', '.join(v['subprojects'])})")
    jar = _java_jar_path(shared_id, sub, version)
    if jar.exists():
        return jar
    if not code_java.available():
        raise ValueError(code_java.NO_JDK)
    files = _commit_files(shared_id, v["commit"])
    deps, errors = _java_deps(shared, files, chain)
    with _jar_lock:
        if jar.exists():
            return jar
        with tempfile.TemporaryDirectory(prefix="javapub-") as tmp:
            # the subproject's sources only (other subprojects of the repository publish their own jars)
            repo = _write_temp_repo({p: c for p, c in files.items() if p.startswith(f"{sub}/") or "/" not in p}, Path(tmp))
            try:
                info = code_java.compile_project(repo, deps=deps, dep_errors=errors)
            except (ValueError, RuntimeError) as e:
                raise ValueError(f"{shared['name']} {version} does not compile: {str(e)[:1500]}") from None
            code_java.package_jar(info, jar, f"{java_rid(shared_id)}:{sub}", version)
    return jar


def _publish_java(repo_id: str, commit_id: str) -> None:
    """After Checks pass on the default branch: publish the commit's jars (what Jemma does after a commit)."""
    rec = _repo(repo_id)
    v = next((x for x in _java_versions(rec) if x["commit"] == commit_id), None)
    for sub in (v or {}).get("subprojects") or []:
        try:
            _java_jar(repo_id, sub, v["version"])
        except (ValueError, HTTPException):
            pass


def _java_repo_entry(rec: dict, latest_only: bool = True) -> dict:
    versions = _java_versions(rec)
    latest = versions[0] if versions else None
    sub = (latest or {}).get("subprojects", ["transforms-java"])[0] if latest else "transforms-java"
    return {"repo_id": rec["id"], "name": rec["name"], "rid": java_rid(rec["id"]), "latest": latest["version"] if latest else None,
            "subprojects": (latest or {}).get("subprojects") or [],
            "compile": f"compile '{java_rid(rec['id'])}:{sub}:{latest['version'] if latest else '<VERSION>'}'",
            "versions": versions[:5] if latest_only else versions}


def _java_repos() -> list[dict]:
    """Repositories with Java code on their default branch (what can be shared)."""
    out = []
    for p in sorted(DIR.iterdir()) if DIR.exists() else []:
        if not (p / "repo.json").exists():
            continue
        try:
            rec = _repo(p.name)
            if code_java.java_subprojects(_branch(rec, None)["files"]):
                out.append(rec)
        except (HTTPException, KeyError, ValueError):
            continue
    return out


@router.get("/{repo_id}/artifacts")
def artifact_settings(repo_id: str) -> dict:
    """Settings → Artifacts: the backing repositories this repository can reference, and the shared Java repositories
    that can be added (those the caller can see)."""
    rec = _repo(repo_id)
    backing = []
    import container_registry

    for rid in _backing(rec):
        if rid == code_java.EXCEL_BUNDLE:
            backing.append(_excel_bundle_entry())
            continue
        if rid.startswith("art-"):
            # a Docker Artifacts repository: its images run as @sidecar containers
            try:
                d = container_registry.get(rid)
                import artifact_repos

                backing.append({"repo_id": rid, "name": d["name"], "rid": d["slug"], "docker": True, "path": d.get("path"), "versions": [], "subprojects": [], "compile": "",
                                "images": sorted(f"{i}:{t}" for i, img in (d.get("images") or {}).items() for t in img.get("tags") or {}),
                                "packages": artifact_repos.summary(rid)})
            except HTTPException:
                backing.append({"repo_id": rid, "name": rid, "rid": rid, "docker": True, "missing": True, "versions": [], "subprojects": [], "compile": "", "images": []})
            continue
        try:
            backing.append(_java_repo_entry(_repo(rid)))
        except HTTPException:
            backing.append({"repo_id": rid, "name": rid, "rid": java_rid(rid), "missing": True, "versions": [], "subprojects": [], "compile": ""})
    used = set(code_java.project_coordinates(_branch(rec, None)["files"]))
    for b in backing:
        b["referenced"] = sorted(c for c in used if c.startswith(b["rid"] + ":"))
    available = [{"repo_id": r["id"], "name": r["name"], "rid": java_rid(r["id"])}
                 for r in auth.visible_resources("code_repo", _java_repos()) if r["id"] != repo_id and r["id"] not in _backing(rec)]
    # libraries the platform provides (the Maven library panel: search "transforms-excel-parser")
    libraries = [] if code_java.EXCEL_BUNDLE in _backing(rec) else [_excel_bundle_entry()]
    docker = [{"repo_id": d["id"], "name": d["name"], "rid": d["slug"], "path": d.get("path"), "docker": True} for d in container_registry.visible() if d["id"] not in _backing(rec)]
    return {"backing": backing, "available": available, "libraries": libraries, "docker_available": docker, "prefix": JAVA_RID_PREFIX}


def _excel_bundle_entry() -> dict:
    """The built-in transforms-excel-parser-bundle (Palantir's Excel parser on Apache POI, api/java_excel)."""
    v = code_java.EXCEL_VERSION
    return {"repo_id": code_java.EXCEL_BUNDLE, "name": code_java.EXCEL_BUNDLE, "rid": code_java.EXCEL_GROUP, "builtin": True, "latest": v,
            "subprojects": [code_java.EXCEL_ARTIFACT], "library": code_java.EXCEL_ARTIFACT,
            "description": "Parse Excel files (xls, xlt, xltm, xltx, xlsx, xlsm) in Java transforms: tables, multi-row headers, forms, "
                           "several outputs from one read, an error DataFrame. Wraps Apache POI 5.2.3.",
            "compile": f"compile '{code_java.EXCEL_GROUP}:{code_java.EXCEL_ARTIFACT}:{v}'",
            "versions": [{"version": v, "commit": "", "message": "built in", "at": None, "published": True}]}


class ArtifactsIn(BaseModel):
    repos: list[str] = Field(default_factory=list, max_length=100)


@router.put("/{repo_id}/artifacts")
def save_artifact_settings(repo_id: str, req: ArtifactsIn) -> dict:
    """Set the backing repositories. A repository added brings its own backing repositories (the same access is needed
    for them); removing one can break builds of transforms that use it. Settings → Artifacts: the repository's owners."""
    with _lock:
        rec = _repo(repo_id)
        _check_owner(rec)
        wanted: list[str] = []
        queue = list(dict.fromkeys(req.repos))
        while queue:
            rid = queue.pop(0)
            if rid in wanted or rid == repo_id:
                continue
            if rid == code_java.EXCEL_BUNDLE:
                wanted.append(rid)
                continue
            if rid.startswith("art-"):
                import container_registry

                container_registry.get(rid)  # the caller can see it (Project viewer)
                wanted.append(rid)
                continue
            shared = _repo(rid)
            auth.check_resource("code_repo", rid)
            if rid not in _backing(rec) and not code_java.java_subprojects(_branch(shared, None)["files"]):
                raise HTTPException(400, f"{shared['name']} has no Java code to share")
            wanted.append(rid)
            if rid not in _backing(rec):
                queue += [x for x in _backing(shared) if x not in wanted]
        rec["settings"] = {**rec["settings"], "artifacts": wanted}
        _save(rec)
    return artifact_settings(repo_id)



# -- external transforms (doc 02 "External transforms"): Data Connection sources imported into a repository ----------


def _rest_sources() -> list[dict]:
    import webhooks

    return webhooks.ds._rows("SELECT id, name, api_name, config, code_imports, created_at FROM rest_sources ORDER BY name")


def _rest_source(ref: str) -> dict:
    import webhooks

    rows = webhooks.ds._rows("SELECT * FROM rest_sources WHERE id = %s OR api_name = %s OR name = %s", (ref, ref, ref))
    if not rows:
        raise HTTPException(404, f"no REST API source {ref}")
    return rows[0]


def _export_controls(row: dict) -> dict:
    return {"allow_foundry_inputs": bool(((row.get("config") or {}).get("export_controls") or {}).get("allow_foundry_inputs"))}


def _external_entry(row: dict) -> dict:
    import secretbox

    try:
        secrets_ = sorted((secretbox.unseal(row.get("secret")) or {}).get("additional", {}))
    except Exception:  # noqa: BLE001
        secrets_ = []
    return {"id": row["id"], "rid": f"ri.magritte..source.{row['id']}", "name": row["name"], "api_name": row.get("api_name"),
            "domains": [d["url"] for d in (row.get("config") or {}).get("domains") or []], "code_imports": bool(row.get("code_imports")),
            "export_controls": _export_controls(row), "secrets": secrets_}


@router.get("/{repo_id}/external-systems")
def external_systems_settings(repo_id: str) -> dict:
    """Settings → External systems: the sources the repository imports, and those that allow imports into code."""
    import webhooks

    rec = _repo(repo_id)
    imported = (rec.get("settings") or {}).get("external_systems") or []
    rows = {r["id"]: r for r in webhooks.ds._rows("SELECT * FROM rest_sources")}
    return {"imported": [_external_entry(rows[i]) for i in imported if i in rows],
            "available": [_external_entry(r) for r in rows.values() if r.get("code_imports") and r["id"] not in imported]}


class ExternalSystemsIn(BaseModel):
    sources: list[str] = Field(default_factory=list, max_length=50)


@router.put("/{repo_id}/external-systems")
def save_external_systems(repo_id: str, req: ExternalSystemsIn) -> dict:
    """Settings → External systems (the sources its transforms may call, their credentials included): the repository's
    owners."""
    with _lock:
        rec = _repo(repo_id)
        _check_owner(rec)
        ids = []
        for ref in dict.fromkeys(req.sources):
            row = _rest_source(ref)
            if not row.get("code_imports") and row["id"] not in ((rec.get("settings") or {}).get("external_systems") or []):
                raise HTTPException(403, f"{row['name']} does not allow imports into code repositories (Data Connection → the source's settings)")
            ids.append(row["id"])
        rec["settings"] = {**rec["settings"], "external_systems": ids}
        _save(rec)
    return external_systems_settings(repo_id)


def _imported_source(repo_id: str, ref: str) -> dict:
    rec = _repo(repo_id)
    auth.check_resource("code_repo", repo_id)
    row = _rest_source(ref)
    if row["id"] not in ((rec.get("settings") or {}).get("external_systems") or []):
        raise HTTPException(403, f"import the source {row['name']} into the repository first (Settings → External systems)")
    if not row.get("code_imports"):
        raise HTTPException(403, f"the source {row['name']} no longer allows imports into code")
    return row


class ExternalRef(BaseModel):
    source: str


@router.post("/{repo_id}/external/describe")
def external_describe(repo_id: str, req: ExternalRef) -> dict:
    row = _imported_source(repo_id, req.source)
    e = _external_entry(row)
    return {"name": e["name"], "rid": e["rid"], "domains": [{"url": u} for u in e["domains"]], "secrets": e["secrets"]}


class ExternalSecretIn(BaseModel):
    source: str
    name: str


@router.post("/{repo_id}/external/secret")
def external_secret(repo_id: str, req: ExternalSecretIn) -> dict:
    """source.get_secret(name): an additional secret of the source, for code that uses its own client."""
    import webhooks

    row = _imported_source(repo_id, req.source)
    return {"value": webhooks.Client(row).secret(req.name)}


class ExternalRequestIn(BaseModel):
    source: str
    method: str = Field("GET", pattern="^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$")
    url: str
    params: Any = None
    headers: Optional[dict] = None
    json_body: Any = Field(None, alias="json")
    form: Optional[dict] = None
    data_b64: Optional[str] = None
    timeout: Optional[float] = None
    has_inputs: bool = False

    model_config = {"populate_by_name": True}


@router.post("/{repo_id}/external/request")
def external_request(repo_id: str, req: ExternalRequestIn) -> dict:
    """A request of an external transform's source client: limited to the source's domains, egress-checked (agent proxy
    and private link routes apply), with the domain's credentials added here. A transform that reads Foundry inputs may
    only use a source whose export controls allow it."""
    import base64 as b64

    import webhooks

    row = _imported_source(repo_id, req.source)
    if req.has_inputs and not _export_controls(row)["allow_foundry_inputs"]:
        raise HTTPException(403, f"export-controlled: {row['name']} does not allow transforms that read Foundry inputs to use it "
                                 "(enable it in the source's export controls)")
    client = webhooks.Client(row)
    base = row["config"]["domains"][0]["url"]
    url = req.url if req.url.startswith(("http://", "https://")) else base.rstrip("/") + "/" + req.url.lstrip("/")
    params = list(req.params.items()) if isinstance(req.params, dict) else req.params
    kw: dict[str, Any] = {"params": params, "headers": req.headers or {}, "timeout": min(req.timeout or 60, 300)}
    if req.json_body is not None:
        kw["json"] = req.json_body
    elif req.form is not None:
        kw["data"] = req.form
    elif req.data_b64 is not None:
        kw["data"] = b64.b64decode(req.data_b64)
    try:
        r = client.request(req.method, url, **kw)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, client.scrub(f"the request failed: {e}")) from None
    return {"status": r.status_code, "reason": r.reason, "url": r.url,
            "headers": {k: v for k, v in r.headers.items() if k.lower() not in ("set-cookie", "content-encoding", "transfer-encoding", "content-length")},
            "content_b64": b64.b64encode(r.content[:50_000_000]).decode()}


class ExportControlsIn(BaseModel):
    allow_foundry_inputs: bool


@router.put("/tools/sources/{source_id}/export-controls")
def set_export_controls(source_id: str, req: ExportControlsIn) -> dict:
    """A source's export controls: whether transforms that read Foundry data may send it to the source."""
    import webhooks
    from psycopg.types.json import Jsonb

    auth.require_admin()
    row = _rest_source(source_id)
    config = {**(row.get("config") or {}), "export_controls": {"allow_foundry_inputs": req.allow_foundry_inputs}}
    webhooks.ds._exec("UPDATE rest_sources SET config = %s, updated_at = now() WHERE id = %s", (Jsonb(config), row["id"]))
    return _external_entry(_rest_source(row["id"]))

@router.get("/tools/artifacts")
def artifacts() -> dict:
    """The Artifacts app: published Python libraries (versions and consumers) and Java UDFs."""
    libs = []
    for name, versions in python_libraries().items():
        libs.append({"name": name, "repo_id": versions[0]["repo_id"], "repo_name": versions[0]["repo_name"],
                     "versions": [{k: v.get(k) for k in ("version", "commit", "tagged_at", "ok", "reason", "recalled")} | {"files": len(v["files"])} for v in versions],
                     "consumers": _consumers(name)})
    udfs = list_udfs(include_unpublished=True)
    # shared Java code: repositories with Java on their default branch, their versions and who references them
    repos = auth.visible_resources("code_repo", _java_repos())
    every = all_repos()
    java = []
    for r in repos:
        e = _java_repo_entry(r, latest_only=False)
        e["consumers"] = []
        for other in every:
            if r["id"] in _backing(other):
                refs = [c for c in code_java.project_coordinates(_branch(other, None)["files"]) if c.startswith(e["rid"] + ":")]
                e["consumers"].append({"repo_id": other["id"], "name": other["name"], "coordinates": refs})
        java.append(e)
    # the built-in Excel parser library, with the repositories that added its bundle
    excel = _excel_bundle_entry()
    excel["consumers"] = [{"repo_id": o["id"], "name": o["name"],
                           "coordinates": [c for c in code_java.project_coordinates(_branch(o, None)["files"]) if code_java.is_excel_parser(c)]}
                          for o in every if code_java.EXCEL_BUNDLE in _backing(o)]
    java.append(excel)
    return {"python_libraries": sorted(libs, key=lambda x: x["name"]), "udfs": udfs, "python": code_env.runtime_python(),
            "java_repositories": sorted(java, key=lambda x: x["name"].lower())}


@router.get("/{repo_id}/environment")
def environment(repo_id: str, branch: Optional[str] = None) -> dict:
    """The repository's resolved environment (meta.yaml) and the Python version support table."""
    b = _branch(_repo(repo_id), branch)
    env = _environment(b["files"], _repo(repo_id))
    return {"environment": env, "python": code_env.runtime_python(), "support": code_env.support_table(),
            "library": code_env.library_package_name(b["files"], _repo(repo_id)["name"]),
            "consumers": _consumers(code_env.library_package_name(b["files"], _repo(repo_id)["name"]) or "") if code_env.library_package_name(b["files"], _repo(repo_id)["name"]) else []}


class AiIn(BaseModel):
    mode: Literal["explain", "bugs", "error", "ask"]
    code: str = Field("", max_length=60000)
    path: str = ""
    selection: str = Field("", max_length=20000)
    error: str = Field("", max_length=20000)
    question: str = Field("", max_length=4000)


AI_SYSTEM = (
    "You are AIP Assist inside the Code Repositories editor of BluesandAI Hexa. Python transforms use BluesandAI Hexa's `transforms.api`: "
    "@transform.using(...) on a single node (input.polars(lazy=True) / .pandas() / ctx.duckdb(), output.write_table), "
    "@transform.spark.using(...) on PySpark (dataframe(), write_dataframe), the older transform_df / @transform on "
    "pandas, @incremental, Check(E...) data expectations and transforms.mediasets; .sql files (CREATE TABLE `/out` AS "
    "SELECT, SQLite dialect); Java transforms on Spark; models published with ModelOutput as MLflow models (open source). "
    "Answer in concise Markdown; put code in ```python blocks."
)


def assist(req: AiIn, system: str = AI_SYSTEM, lang: str = "python") -> str:
    """AIP Assist: explain code, find bugs, explain an error (also Pipeline Builder's failed builds), or answer."""
    focus = f"Selected code:\n```{lang}\n{req.selection}\n```\n\n" if req.selection.strip() else ""
    file = f"File `{req.path}`:\n```{lang}\n{req.code}\n```\n\n" if req.code.strip() else ""
    prompt = {
        "explain": f"{file}{focus}Explain what {'the selected code' if focus else 'this file'} does, step by step.",
        "bugs": f"{file}{focus}Find bugs and risky assumptions (nulls, types, empty inputs, joins). List each with a fix.",
        "error": f"{file}This error happened:\n```\n{req.error}\n```\nExplain the cause in plain words and give the corrected code.",
        "ask": f"{file}{focus}{req.question}",
    }[req.mode]
    try:
        return pipeline_ai.chat(ontology.DEFAULT_LLM, pipeline_ai.with_platform(system), prompt, None, 0.2, 4096)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"AIP Assist is unavailable: {str(e)[:300]}") from None


@router.post("/tools/ai")
def ai(req: AiIn) -> dict:
    return {"answer": assist(req)}


# ------------------------------------------------------------------------------------------------
# Java user-defined functions: published versions, runs for Pipeline Builder, Java tasks
# ------------------------------------------------------------------------------------------------

LOCKFILE = "eddie-lockfile.json"


def _write_temp_repo(files: dict[str, str], root: Path) -> Path:
    for path, content in files.items():
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
    return root


def _udf_fields(schema: dict, custom: dict) -> list[dict]:
    return [{"name": f["name"], "type": code_java.column_type(f.get("type") or {}, custom), "nullable": bool(f.get("nullable", True)),
             "field_type": (f.get("type") or {}).get("type")} for f in schema.get("fields") or []]


def _udf_summary(d: dict) -> dict:
    custom = d["custom_types"]
    return {"name": d["name"], "description": d["description"], "type": d["type"], "file": d["file"],
            "input": {"name": d["input_schema"].get("name"), "description": d["input_schema"].get("description") or "", "fields": _udf_fields(d["input_schema"], custom)},
            "output": {"name": d["output_schema"].get("name"), "description": d["output_schema"].get("description") or "", "fields": _udf_fields(d["output_schema"], custom)},
            "arguments": [{"name": k, "required": bool((a or {}).get("required")), "description": (a or {}).get("description") or "",
                           "type": code_java.column_type((a or {}).get("type") or {}, custom), "field_type": ((a or {}).get("type") or {}).get("type")}
                          for k, a in d["arguments"].items()],
            # keyed process UDFs: what records are partitioned by, their event time, and the state kept per key
            **({"key_columns": d["key_columns"], "event_time_column": d.get("event_time_column"),
                "state": {"name": d["state_schema"].get("name"), "fields": _udf_fields(d["state_schema"], custom)}} if d["type"] == "keyed_process" else {})}


@router.get("/tools/udfs")
def list_udfs(include_unpublished: bool = False) -> list[dict]:
    """Every UDF version: a tag whose commit defines the UDF, lists it in the lockfile and passed its checks
    (Pipeline Builder imports these). With include_unpublished, the others too, with why they are not published."""
    out = []
    for rec in all_repos():
        checks = _checks(rec["id"])
        for tag in rec.get("tags") or []:
            files = _commit_files(rec["id"], tag["commit"])
            try:
                defs = code_java.parse_udf_definitions(files)
            except ValueError as e:
                if include_unpublished:
                    out.append({"repo_id": rec["id"], "repo_name": rec["name"], "tag": tag["name"], "commit": tag["commit"], "error": str(e), "published": False})
                continue
            if not defs:
                continue
            try:
                lock = json.loads(files.get(LOCKFILE) or "{}").get("udfs") or {}
            except ValueError:
                lock = {}
            check = next((c for c in checks if c.get("commit") == tag["commit"]), None)
            examples = [t["example"] for t in (check or {}).get("tests") or [] if t.get("example")]
            for d in defs:
                reason = None
                if d["name"] not in lock:
                    reason = "not in the lockfile: run generateEddieLockfile, commit and tag again"
                elif not check:
                    reason = "the checks of the tagged commit have not run yet"
                elif check["status"] != "passed":
                    reason = "the checks of the tagged commit failed"
                if reason and not include_unpublished:
                    continue
                out.append({**_udf_summary(d), "id": (lock.get(d["name"]) or {}).get("id"), "repo_id": rec["id"], "repo_name": rec["name"],
                            "tag": tag["name"], "commit": tag["commit"], "tagged_at": tag.get("at"), "published": reason is None, "reason": reason,
                            "examples": [e for e in examples if e.get("udf") == d["name"]]})
    return sorted(out, key=lambda u: (u["repo_name"], u.get("name") or "", u.get("tagged_at") or ""))


class UdfCall(BaseModel):
    key: str
    repo_id: str
    tag: str
    udf: str
    config: dict[str, Any] = Field(default_factory=dict)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    # keyed process UDFs: the keyed state (state per key, timers, watermark) to start from, and whether the input is
    # bounded (a batch: every event-time timer fires at the end); a streaming job passes its checkpointed state and
    # bounded=false, and keeps the returned state for the next micro-batch
    keyed: Optional[dict[str, Any]] = None
    bounded: bool = True


class UdfCalls(BaseModel):
    calls: list[UdfCall]


@router.post("/tools/udfs/run")
def run_udfs(req: UdfCalls) -> dict:
    """Pipeline Builder's UDF steps: run a published UDF version over rows ({value: {columns, rows}} or {error} per key;
    keyed process UDFs also return value.keyed, their new keyed state)."""
    results: dict[str, dict] = {}
    for c in req.calls:
        try:
            rec = _repo(c.repo_id)
            # using a published UDF reads its repository: its markings and the Viewer role on its Project
            auth.check_resource("code_repo", c.repo_id)
            tag = next((t for t in rec.get("tags") or [] if t["name"] == c.tag), None)
            if not tag:
                raise ValueError(f"{rec['name']} has no version {c.tag}")
            files = _commit_files(rec["id"], tag["commit"])
            d = next((u for u in code_java.parse_udf_definitions(files) if u["name"] == c.udf), None)
            if not d:
                raise ValueError(f"version {c.tag} of {rec['name']} has no UDF {c.udf}")
            with tempfile.TemporaryDirectory(prefix="udf-") as tmp:
                rows, keyed, _ = code_java.udf_process(_write_temp_repo(files, Path(tmp)), c.udf, c.config, c.rows, c.keyed, c.bounded)
            columns = code_java.udf_columns(d)
            # arrays, maps and structs travel in tables as JSON text
            for r in rows:
                for k, v in r.items():
                    if isinstance(v, (dict, list)):
                        r[k] = json.dumps(v, ensure_ascii=False)
            results[c.key] = {"value": {"columns": columns, "rows": rows, **({"keyed": keyed} if keyed is not None else {})}}
        except Exception as e:  # noqa: BLE001 - one call's failure is that step's error
            results[c.key] = {"error": str(e)[:3000]}
    return {"results": results}


class TaskIn(BaseModel):
    branch: Optional[str] = None
    task: Literal["generateEddieLockfile", "generateUdfResources", "test", "install", "uninstall", "whoneeds", "formatCode", "tasks",
                  "displayTransformsList", "datasetPreview"]
    # install / uninstall: package specs ("pandas", "scipy <=1.4.0"); whoneeds: one package name
    packages: list[str] = Field(default_factory=list, max_length=50)
    # datasetPreview: --transformId, --printMode, --inputFiles / --outputFiles (<alias>:<path>, comma-separated)
    args: dict[str, str] = Field(default_factory=dict)


PY_TASKS = [
    {"id": "install", "usage": "install --packageSpecs=<spec>[,<spec>]", "help": "Add packages to meta.yaml's run requirements (a library repository's package, or one uv can install into the repository environment)."},
    {"id": "uninstall", "usage": "uninstall --packageSpecs=<name>[,<name>]", "help": "Remove packages from meta.yaml's run requirements."},
    {"id": "whoneeds", "usage": "whoneeds --packageSpec=<name>", "help": "Show which installed packages require a package."},
    {"id": "formatCode", "usage": "formatCode", "help": "Format every Python file with Black (configured by pyproject.toml [tool.black])."},
    {"id": "test", "usage": "test", "help": "Run the tests (pytest; JUnit tests and UDF examples in Java projects)."},
    {"id": "displayTransformsList", "usage": "displayTransformsList", "help": "List the transforms and the ids datasetPreview takes."},
    {"id": "datasetPreview", "usage": "datasetPreview --transformId=<id> [--printMode=table] [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]",
     "help": "Preview a transform on the platform: a link only you can open (24 hours), or the first 10 rows of each dataset."},
    {"id": "tasks", "usage": "tasks", "help": "List the tasks."},
]


def _set_file(repo_id: str, branch: Optional[str], changes: dict[str, str]) -> None:
    with _lock:
        rec = _repo(repo_id)
        br = _branch(rec, branch)
        _editable(rec, br)
        br["files"] = {**br["files"], **changes}
        br["updated_at"] = _now()
        _save(rec)


def _python_task(repo_id: str, b: dict, req: TaskIn) -> dict:
    if req.task == "tasks":
        return {"ok": True, "tasks": PY_TASKS, "logs": "\n".join(f"{t['usage']:<46} {t['help']}" for t in PY_TASKS)}
    if req.task == "whoneeds":
        if len(req.packages) != 1:
            raise HTTPException(400, "whoneeds takes one package (--packageSpec=<name>)")
        try:
            tree = code_env.whoneeds(req.packages[0])
        except ValueError as e:
            return {"ok": False, "error": str(e), "logs": str(e)}

        def lines(node: dict, depth: int = 0) -> list[str]:
            out = [f"{'  ' * depth}{'└─ ' if depth else ''}{node['name']} {node['version']}"]
            for n in node.get("needed_by", []):
                out += lines(n, depth + 1)
            return out

        return {"ok": True, "tree": tree, "logs": "\n".join(lines(tree)) + ("" if tree["needed_by"] else "\n(no installed package requires it)")}
    if req.task == "formatCode":
        changed, names, errors = code_env.format_code(b["files"])
        if changed:
            _set_file(repo_id, b["name"], changed)
        return {"ok": not errors, "changed": names, "error": "; ".join(errors) or None,
                "logs": "\n".join([*(f"reformatted {n}" for n in names), *errors, f"{len(names)} files reformatted, {sum(p.endswith('.py') for p in b['files']) - len(names) - len(errors)} files left unchanged"])}
    path = code_env.meta_path(b["files"])
    if not path:
        raise HTTPException(400, "this repository has no conda_recipe/meta.yaml")
    if not req.packages:
        raise HTTPException(400, "give package specs (--packageSpecs=pandas,scipy)")
    text = b["files"][path]
    if req.task == "install":
        libs = _readable_libraries(_repo(repo_id))[0]
        problems = []
        to_install = []
        for spec in req.packages:
            res = code_env.resolve(f"requirements:\n  run:\n    - {spec}\n", libs)
            problems += res["errors"]
            to_install += (res.get("dedicated") or {}).get("requirements") or []
        if not problems and to_install:
            # packages the platform's environment lacks: they must resolve (uv dry run) to go into meta.yaml
            why = code_envs.check_installable(to_install)
            if why:
                problems.append(why)
        if problems:
            return {"ok": False, "error": "; ".join(problems), "logs": "\n".join(problems)}
        try:
            new, added = code_env.add_packages(text, req.packages)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if added:
            _set_file(repo_id, b["name"], {path: new})
        return {"ok": True, "added": added, "logs": (f"Added to {path}: {', '.join(added)}" if added else "Already in the run requirements")}
    try:
        new, removed = code_env.remove_packages(text, req.packages)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if removed:
        _set_file(repo_id, b["name"], {path: new})
    return {"ok": True, "removed": removed, "logs": (f"Removed from {path}: {', '.join(removed)}" if removed else "None of them was in the run requirements")}


class PinIn(BaseModel):
    branch: Optional[str] = None
    package: str = Field(min_length=1, max_length=200)
    # None: unpin (the newest published version, locked per meta.yaml)
    version: Optional[str] = Field(None, max_length=100)


@router.post("/{repo_id}/libraries/pin")
def pin_library(repo_id: str, req: PinIn) -> dict:
    """The Libraries panel's settings button: pin a library to one published version in meta.yaml's run requirements
    (or unpin it). Like Foundry, nothing is installed: the next Checks resolve it."""
    rec = _repo(repo_id)
    b = _branch(rec, req.branch)
    path = code_env.meta_path(b["files"])
    if not path:
        raise HTTPException(400, "this repository has no conda_recipe/meta.yaml")
    libs, denied = _readable_libraries(rec)
    name = code_env._norm(req.package)
    if name in denied:
        raise HTTPException(403, f"{req.package} is published by the repository {denied[name]}, which you cannot access")
    if req.version is not None:
        published = [v["version"] for v in libs.get(name, []) if v["ok"]]
        if name in libs and req.version not in published:
            raise HTTPException(400, f"{req.package} {req.version} is not published (published: {', '.join(published) or 'none'})")
    try:
        new, spec = code_env.pin_package(b["files"][path], req.package, req.version)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    _set_file(repo_id, b["name"], {path: new})
    return {"ok": True, "spec": spec, "file": path}


@router.post("/{repo_id}/tasks")
def run_task(repo_id: str, req: TaskIn) -> dict:
    """Task Runner. Python: install / uninstall (meta.yaml run requirements), whoneeds, formatCode, test, tasks.
    Java: generateUdfResources compiles the project with the generated UDF classes; generateEddieLockfile gives
    each UDF its Pipeline Builder id (kept across regenerations: a renamed UDF gets a new one); test runs the JUnit
    tests and UDF examples."""
    rec = _repo(repo_id)
    b = _branch(rec, req.branch)
    if req.task in ("displayTransformsList", "datasetPreview"):
        # local preview (transforms_common.py): Foundry's Gradle tasks, run on the platform
        import transforms_common as tc

        if req.task == "displayTransformsList":
            return tc.display_transforms_list(rec, b)
        if not req.args.get("transformId"):
            raise HTTPException(400, "Usage: datasetPreview --transformId=<id> [--printMode=table] [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]")
        split = lambda k: [v for v in (req.args.get(k) or "").split(",") if v.strip()]  # noqa: E731
        return tc.dataset_preview(rec, b, tc.PreviewIn(branch=b["name"], transform_id=req.args["transformId"], print_mode=req.args.get("printMode") or "uri",
                                                       input_files=split("inputFiles"), output_files=split("outputFiles")))
    if req.task in ("install", "uninstall", "whoneeds", "formatCode", "tasks"):
        return _python_task(repo_id, b, req)
    if req.task == "test":
        res = _run(b["files"], {"mode": "test"}, rec)
        tests = res.get("tests", [])
        return {"ok": bool(res.get("ok")) and all(t["ok"] or t.get("skipped") for t in tests), "tests": tests, "logs": res.get("logs", ""), "error": res.get("error")}
    try:
        defs = code_java.parse_udf_definitions(b["files"])
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if req.task == "generateEddieLockfile":
        if not defs:
            raise HTTPException(400, "no UDF definitions (src/main/resources/udfs/definitions/*.yml)")
        try:
            lock = json.loads(b["files"].get(LOCKFILE) or "{}")
        except ValueError:
            lock = {}
        udfs = dict(lock.get("udfs") or {})
        added = [d["name"] for d in defs if d["name"] not in udfs]
        for name in added:
            udfs[name] = {"id": "ri.eddie.main.udf." + uuid.uuid4().hex, "created_at": _now()}
        text = json.dumps({"udfs": dict(sorted(udfs.items()))}, indent=2) + "\n"
        with _lock:
            rec = _repo(repo_id)
            br = _branch(rec, req.branch)
            _editable(rec, br)
            br["files"] = {**br["files"], LOCKFILE: text}
            br["updated_at"] = _now()
            _save(rec)
        return {"ok": True, "added": added, "udfs": udfs, "logs": f"{LOCKFILE}: {len(udfs)} UDFs" + (f"; new: {', '.join(added)}" if added else "")}
    if not code_java.available():
        raise HTTPException(400, code_java.NO_JDK)
    with tempfile.TemporaryDirectory(prefix="udfgen-") as tmp:
        repo = _write_temp_repo(b["files"], Path(tmp))
        try:
            info = code_java.compile_project(repo)
            problems, _ = code_java.udf_check(repo, info)
        except ValueError as e:
            return {"ok": False, "error": str(e), "generated": [], "logs": str(e)}
    return {"ok": not problems, "generated": info["generated"], "problems": problems,
            "logs": "\n".join([f"Generated {len(info['generated'])} classes for {len(defs)} UDFs", *problems])}


# -- debugger and console (code_debug.py): /api/code-repos/{repo}/debug/... ----------------------
import code_debug  # noqa: E402  (imports this module: included last)

router.include_router(code_debug.router)
