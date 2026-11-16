"""Versions of a Jupyter Code Workspace's files: checkpoints kept 30 days, and the workspace's Git repository.

Checkpoints (Foundry: "safe checkpoints of its notebook's contents for 30 days"): a saved state of a notebook or file.
An explicit save (Ctrl+S, the Save button) always makes one, autosaves at most one every AUTO_MINUTES; an upload,
a restore or a delete first keeps the state it replaces. A checkpoint equal to the latest one is not
repeated. They live in data/code-workspaces/<id>/.checkpoints (index.json + blobs), follow renames, outlive deletes
(so a deleted file can be brought back) and are dropped after RETENTION_DAYS.

Git (Foundry: workspaces are "fully backed by" a repository, with branches and the permanent record of the code): the
workspace's files folder is a Git repository (git on PATH, as for Code Repositories' remotes). The Git panel shows the
changes, diffs (a notebook as its cells' sources, not its JSON), commits them as the signed-in user, lists the
history of the workspace or of a file, restores a file from any commit, and creates and switches branches.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import code_workspaces as cw

router = APIRouter(prefix="/api/code-workspaces/{wid}/lab", tags=["code-workspaces"])
RETENTION_DAYS = 30
AUTO_MINUTES = 10
MAX_PER_FILE = 200
_locks: dict[str, threading.RLock] = {}


def _lock(wid: str) -> threading.RLock:
    return _locks.setdefault(wid, threading.RLock())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _files(wid: str) -> Path:
    import code_workspace_lab as lab

    return lab.files_dir(wid).resolve()


def _rel_ok(wid: str, path: str) -> tuple[Path, str]:
    import code_workspace_lab as lab

    p = lab._resolve(wid, path)
    return p, p.relative_to(_files(wid)).as_posix()


# ------------------------------------------------------------------------------------------------ checkpoints


def _cp_dir(wid: str) -> Path:
    d = cw.DIR / wid / ".checkpoints"
    (d / "blobs").mkdir(parents=True, exist_ok=True)
    return d


def _index(wid: str) -> dict[str, list[dict]]:
    f = _cp_dir(wid) / "index.json"
    try:
        return json.loads(f.read_text("utf-8")) if f.exists() else {}
    except ValueError:
        return {}


def _save_index(wid: str, idx: dict) -> None:
    f = _cp_dir(wid) / "index.json"
    tmp = f.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(idx, indent=1), "utf-8")
    os.replace(tmp, f)


def _prune(wid: str, idx: dict) -> dict:
    cutoff = (_now() - timedelta(days=RETENTION_DAYS)).isoformat()
    keep: dict[str, list[dict]] = {}
    dropped = []
    for path, cps in idx.items():
        fresh = [c for c in cps if c["at"] >= cutoff]
        dropped += [c for c in cps if c not in fresh]
        if len(fresh) > MAX_PER_FILE:
            dropped += fresh[:-MAX_PER_FILE]
            fresh = fresh[-MAX_PER_FILE:]
        if fresh:
            keep[path] = fresh
    used = {c["blob"] for cps in keep.values() for c in cps}
    for c in dropped:
        if c["blob"] not in used:
            (_cp_dir(wid) / "blobs" / c["blob"]).unlink(missing_ok=True)
    return keep


def checkpoint(wid: str, rel: str, data: bytes, kind: str, force: bool = False) -> Optional[dict]:
    """Keep this content of the file as a checkpoint (kind: save, auto, before-restore, …), whatever its size (a blob is
    stored once per content); None when it is not kept."""
    digest = hashlib.sha256(data).hexdigest()
    with _lock(wid):
        idx = _prune(wid, _index(wid))
        cps = idx.setdefault(rel, [])
        last = cps[-1] if cps else None
        if last and last["sha256"] == digest:
            return None
        if not force and last and kind == "auto" and last["at"] > (_now() - timedelta(minutes=AUTO_MINUTES)).isoformat():
            return None
        blob = _cp_dir(wid) / "blobs" / digest
        if not blob.exists():
            blob.write_bytes(data)
        c = {"id": uuid.uuid4().hex[:12], "at": _now().isoformat(timespec="seconds"), "kind": kind, "size": len(data), "sha256": digest, "blob": digest,
             "by": (auth.current() or {}).get("username") or cw._me()}
        cps.append(c)
        _save_index(wid, idx)
        return c


def on_saved(wid: str, rel: str, explicit: bool) -> None:
    """After a save: an explicit save always keeps a checkpoint, autosaves one every AUTO_MINUTES."""
    p = _files(wid) / rel
    if p.is_file():
        checkpoint(wid, rel, p.read_bytes(), "save" if explicit else "auto", force=explicit)


def before_overwrite(wid: str, rel: str, kind: str) -> None:
    """Keep the state about to be replaced (an upload, a restore), unless it is the latest checkpoint already."""
    p = _files(wid) / rel
    if p.is_file():
        checkpoint(wid, rel, p.read_bytes(), kind, force=True)


def keep_first(wid: str, rel: str) -> None:
    """Before a file's first save here, keep the state it had (created elsewhere, uploaded, from a branch)."""
    p = _files(wid) / rel
    if p.is_file() and not _index(wid).get(rel):
        checkpoint(wid, rel, p.read_bytes(), "original", force=True)


def on_renamed(wid: str, old: str, new: str) -> None:
    with _lock(wid):
        idx = _index(wid)
        moved = {}
        for path in list(idx):
            if path == old or path.startswith(old + "/"):
                moved[new + path[len(old):]] = idx.pop(path)
        if moved:
            for k, v in moved.items():
                idx[k] = idx.get(k, []) + v
            _save_index(wid, idx)


def _find(wid: str, rel: str, cid: str) -> dict:
    c = next((c for c in _index(wid).get(rel, []) if c["id"] == cid), None)
    if not c:
        raise HTTPException(404, "this checkpoint no longer exists")
    return c


def _public_cp(c: dict) -> dict:
    return {k: c[k] for k in ("id", "at", "kind", "size", "by") if k in c}


@router.get("/checkpoints")
def list_checkpoints(wid: str, path: str) -> list[dict]:
    """The file's checkpoints, newest first."""
    cw._get(wid)
    _, rel = _rel_ok(wid, path)
    with _lock(wid):
        idx = _prune(wid, _index(wid))
        _save_index(wid, idx)
    return [_public_cp(c) for c in reversed(idx.get(rel, []))]


@router.get("/checkpoints/{cid}")
def get_checkpoint(wid: str, cid: str, path: str) -> dict:
    cw._get(wid)
    _, rel = _rel_ok(wid, path)
    c = _find(wid, rel, cid)
    data = (_cp_dir(wid) / "blobs" / c["blob"]).read_bytes()
    out = _public_cp(c)
    try:
        text = data.decode("utf-8")
        out["content"] = json.loads(text) if rel.endswith(".ipynb") else text
    except (UnicodeDecodeError, ValueError):
        out["content"] = None
    return out


@router.post("/checkpoints/{cid}/restore")
def restore_checkpoint(wid: str, cid: str, path: str) -> dict:
    """Bring the file back to this checkpoint (its current state is kept as a checkpoint first)."""
    cw._get(wid, "editor")
    p, rel = _rel_ok(wid, path)
    c = _find(wid, rel, cid)
    before_overwrite(wid, rel, "before-restore")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes((_cp_dir(wid) / "blobs" / c["blob"]).read_bytes())
    return {"restored": cid, "path": rel}


@router.get("/checkpoints-diff/{cid}")
def diff_checkpoint(wid: str, cid: str, path: str) -> dict:
    """What changed between the checkpoint and the file as it is now."""
    cw._get(wid)
    p, rel = _rel_ok(wid, path)
    c = _find(wid, rel, cid)
    old = (_cp_dir(wid) / "blobs" / c["blob"]).read_bytes()
    new = p.read_bytes() if p.is_file() else None
    return {"path": rel, "diff": _diff(rel, old, new, f"checkpoint {c['at']}", "current")}


# ------------------------------------------------------------------------------------------------ diffs


def _as_text(rel: str, data: Optional[bytes]) -> Optional[list[str]]:
    """A file as diffable lines; a notebook as its cells' sources (as nbdime and jupyterlab-git show them)."""
    if data is None:
        return []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if rel.endswith(".ipynb"):
        try:
            nb = json.loads(text or "{}")
        except ValueError:
            return text.splitlines()
        out: list[str] = []
        for i, c in enumerate(nb.get("cells") or []):
            src = c.get("source", "")
            src = "".join(src) if isinstance(src, list) else str(src)
            kind = c.get("cell_type", "code")
            out.append(f"# ── cell {i + 1} ({kind}) " + "─" * 20)
            out += src.splitlines() or [""]
        return out
    return text.splitlines()


def _diff(rel: str, old: Optional[bytes], new: Optional[bytes], a: str, b: str) -> dict:
    lo, ln = _as_text(rel, old), _as_text(rel, new)
    if lo is None or ln is None:
        return {"binary": True, "lines": [], "added": 0, "removed": 0}
    lines = list(difflib.unified_diff(lo, ln, fromfile=a, tofile=b, lineterm="", n=3))
    return {"binary": False, "lines": lines[:5000], "truncated": len(lines) > 5000,
            "added": sum(1 for x in lines if x.startswith("+") and not x.startswith("+++")),
            "removed": sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))}


# ------------------------------------------------------------------------------------------------ git


def _git_exe() -> str:
    exe = shutil.which("git")
    if not exe:
        raise HTTPException(500, "git is not installed on the server")
    return exe


def _git(wid: str, *args: str, check: bool = True, author: bool = False) -> subprocess.CompletedProcess:
    cfg = ["-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "init.defaultBranch=master", "-c", "commit.gpgsign=false"]
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    if author:
        u = auth.current() or {}
        name = u.get("display_name") or u.get("username") or "BluesandAI"
        email = next((i.get("email") for i in u.get("identities") or [] if i.get("email")), None) or f"{u.get('username') or 'system'}@bluesandai.local"
        env.update(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email)
    r = subprocess.run([_git_exe(), *cfg, "-C", str(_files(wid)), *args], capture_output=True, env=env)
    if check and r.returncode != 0:
        raise HTTPException(409, (r.stderr or r.stdout).decode("utf-8", "replace").strip()[:600] or f"git {args[0]} failed")
    return r


def ensure_repo(wid: str) -> None:
    root = _files(wid)
    if (root / ".git").exists():
        return
    with _lock(wid):
        if (root / ".git").exists():
            return
        _git(wid, "init", "-q", "-b", "master")
        ignore = root / ".gitignore"
        if not ignore.exists():
            ignore.write_text(".ipynb_checkpoints/\n__pycache__/\n*.pyc\n", "utf-8")


def _has_commits(wid: str) -> bool:
    return _git(wid, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode == 0


def _branch(wid: str) -> str:
    return _git(wid, "symbolic-ref", "--short", "-q", "HEAD", check=False).stdout.decode().strip() or "(detached)"


_STATUS = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "?": "untracked", "U": "conflict"}


def _changes(wid: str) -> list[dict]:
    raw = _git(wid, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout.decode("utf-8", "replace")
    out, parts, i = [], raw.split("\0"), 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        xy, path = item[:2], item[3:]
        if "R" in xy:
            i += 1  # the rename's source follows
        code = next((c for c in xy if c != " "), "?")
        out.append({"path": path, "status": _STATUS.get(code, "modified")})
    return out


@router.get("/git/status")
def git_status(wid: str) -> dict:
    cw._get(wid)
    ensure_repo(wid)
    branches = _git(wid, "branch", "--format=%(refname:short)").stdout.decode().split()
    return {"branch": _branch(wid), "branches": branches, "has_commits": _has_commits(wid), "changes": _changes(wid)}


class CommitIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    paths: Optional[list[str]] = None


@router.post("/git/commit")
def git_commit(wid: str, req: CommitIn) -> dict:
    """Commit the changes (all, or these paths) as the signed-in user."""
    cw._get(wid, "editor")
    ensure_repo(wid)
    with _lock(wid):
        if req.paths:
            rels = [_rel_ok(wid, p)[1] for p in req.paths]
            _git(wid, "add", "-A", "--", *rels)
            files = ["--", *rels]
        else:
            _git(wid, "add", "-A")
            files = []
        if _git(wid, "diff", "--cached", "--quiet", *files, check=False).returncode == 0:
            raise HTTPException(400, "nothing to commit")
        _git(wid, "commit", "-q", "-m", req.message.strip(), *files, author=True)
    return git_log(wid)[0]


@router.get("/git/log")
def git_log(wid: str, path: Optional[str] = None, limit: int = 100) -> list[dict]:
    cw._get(wid)
    ensure_repo(wid)
    if not _has_commits(wid):
        return []
    args = ["log", f"-n{max(1, min(limit, 500))}", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"]
    if path:
        args += ["--follow", "--", _rel_ok(wid, path)[1]]
    out = []
    for line in _git(wid, *args).stdout.decode("utf-8", "replace").splitlines():
        sha, short, author_name, at, subject = (line.split("\x1f") + [""] * 5)[:5]
        out.append({"sha": sha, "short": short, "author": author_name, "at": at, "message": subject})
    return out


@router.get("/git/commits/{sha}")
def git_commit_files(wid: str, sha: str) -> dict:
    """The files a commit changed."""
    cw._get(wid)
    if not re.fullmatch(r"[0-9a-f]{4,40}", sha):
        raise HTTPException(400, "invalid commit")
    raw = _git(wid, "show", "--name-status", "--format=%H%x1f%an%x1f%aI%x1f%B%x1e", sha).stdout.decode("utf-8", "replace")
    head, _, files = raw.partition("\x1e")
    full, author_name, at, body = (head.split("\x1f") + [""] * 4)[:4]
    changed = []
    for line in files.strip().splitlines():
        bits = line.split("\t")
        if len(bits) >= 2:
            changed.append({"status": _STATUS.get(bits[0][:1], "modified"), "path": bits[-1]})
    return {"sha": full, "author": author_name, "at": at, "message": body.strip(), "files": changed}


def _show(wid: str, sha: str, rel: str) -> Optional[bytes]:
    r = _git(wid, "show", f"{sha}:{rel}", check=False)
    return r.stdout if r.returncode == 0 else None


@router.get("/git/diff")
def git_diff(wid: str, path: str, sha: Optional[str] = None) -> dict:
    """A file's change: in a commit (against its parent), or not committed yet (working copy against HEAD)."""
    cw._get(wid)
    ensure_repo(wid)
    p, rel = _rel_ok(wid, path)
    if sha:
        if not re.fullmatch(r"[0-9a-f]{4,40}", sha):
            raise HTTPException(400, "invalid commit")
        parent = _git(wid, "rev-parse", "-q", "--verify", f"{sha}^", check=False).stdout.decode().strip()
        old = _show(wid, parent, rel) if parent else None
        return {"path": rel, "diff": _diff(rel, old, _show(wid, sha, rel), f"{sha[:7]}^", sha[:7])}
    old = _show(wid, "HEAD", rel) if _has_commits(wid) else None
    return {"path": rel, "diff": _diff(rel, old, p.read_bytes() if p.is_file() else None, "HEAD", "working copy")}


class RestoreIn(BaseModel):
    path: str
    sha: str = "HEAD"


@router.post("/git/restore")
def git_restore(wid: str, req: RestoreIn) -> dict:
    """The file as it was in a commit (HEAD: discard its uncommitted changes); the replaced state becomes a checkpoint."""
    cw._get(wid, "editor")
    ensure_repo(wid)
    if req.sha != "HEAD" and not re.fullmatch(r"[0-9a-f]{4,40}", req.sha):
        raise HTTPException(400, "invalid commit")
    p, rel = _rel_ok(wid, req.path)
    with _lock(wid):
        data = _show(wid, req.sha, rel) if _has_commits(wid) else None
        before_overwrite(wid, rel, "before-restore")
        if data is None:
            if req.sha != "HEAD":
                raise HTTPException(404, f"{rel} is not in that commit")
            p.unlink(missing_ok=True)  # a new file: discarding it removes it (a checkpoint keeps it)
            return {"path": rel, "deleted": True}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return {"path": rel, "restored": req.sha}


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    create: bool = False


@router.post("/git/checkout")
def git_checkout(wid: str, req: BranchIn) -> dict:
    """Switch to a branch (or create it from the current commit). Uncommitted changes must be committed first."""
    cw._get(wid, "editor")
    ensure_repo(wid)
    if ".." in req.name or req.name.endswith((".lock", "/", ".")):
        raise HTTPException(400, "invalid branch name")
    with _lock(wid):
        if not _has_commits(wid):
            raise HTTPException(409, "commit once before creating or switching branches")
        if req.create:
            _git(wid, "checkout", "-q", "-b", req.name)
        else:
            if _changes(wid):
                raise HTTPException(409, "commit or discard your changes before switching branches")
            _git(wid, "checkout", "-q", req.name)
    return git_status(wid)

