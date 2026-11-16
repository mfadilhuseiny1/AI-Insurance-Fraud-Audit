"""Git remotes for Code Repositories: `git clone` / `fetch` / `push` over smart HTTP (Palantir's "Work locally").

URL: <API>/api/git/<repo id>.git — the user name is anything, the password a personal API token (Account → API
tokens; "Work locally" creates one that expires in 7 days, as Foundry's clone tokens do).

Each repository keeps a bare Git mirror (data/code-repos/<id>/git.git) of its JSON commit store (code_repos.py):
- before a fetch or push, commits the mirror does not have yet are written with `git fast-import` (one Git commit per
  repository commit, same parents, message and time; the mapping is git-map.json), and every branch ref is set to its
  head;
- after a push, the new Git commits of each updated branch become repository commits in order (their parents mapped,
  merge commits keep both parents), the branch moves to the pushed head and checks run on each commit; a new branch
  is created; a deleted branch is deleted (not the default one). Protected branches refuse direct pushes (open a pull
  request instead). Repository files are text: binary files pushed are stored with undecodable bytes replaced.
The Git protocol itself is served by `git http-backend` (Git for Windows / Linux), which must be on PATH.

Mounted by server.py under /api/git.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response

import auth
import code_repos as cr

log = logging.getLogger("bluesandai.code_git")
router = APIRouter(prefix="/api/git")
ZERO = "0" * 40
_locks: dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()


def _lock(repo_id: str) -> threading.Lock:
    with _locks_lock:
        return _locks.setdefault(repo_id, threading.Lock())


def _git_exe() -> str:
    exe = shutil.which("git")
    if not exe:
        raise HTTPException(503, "git is not installed on this server")
    return exe


def _bare(repo_id: str) -> Path:
    return cr.DIR / repo_id / "git.git"


def _git(repo: Path, *args: str, input: Optional[bytes] = None, env: Optional[dict] = None) -> bytes:
    r = subprocess.run([_git_exe(), "--git-dir", str(repo), *args], input=input, capture_output=True, env={**os.environ, **(env or {})})
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {r.stderr.decode('utf-8', 'replace')[-800:]}")
    return r.stdout


def _map(repo_id: str) -> dict:
    p = cr.DIR / repo_id / "git-map.json"
    return json.loads(p.read_text("utf-8")) if p.is_file() else {"to_git": {}, "to_repo": {}}


def _save_map(repo_id: str, m: dict) -> None:
    (cr.DIR / repo_id / "git-map.json").write_text(json.dumps(m, indent=1), "utf-8")


def _ensure_bare(repo_id: str) -> Path:
    bare = _bare(repo_id)
    if not (bare / "HEAD").is_file():
        bare.mkdir(parents=True, exist_ok=True)
        subprocess.run([_git_exe(), "init", "--bare", "-q", str(bare)], check=True, capture_output=True)
        _git(bare, "config", "http.receivepack", "true")
        _git(bare, "config", "core.autocrlf", "false")
    return bare


def _epoch(iso: str) -> int:
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return int(datetime.now(timezone.utc).timestamp())


def _data(text: str) -> bytes:
    raw = text.encode("utf-8")
    return b"data %d\n" % len(raw) + raw + b"\n"


# --------------------------------------------------------------------------------------------
# repository → Git (before fetch / push)
# --------------------------------------------------------------------------------------------


def export(repo_id: str) -> Path:
    """Write the commits the mirror lacks and point every branch ref at its head."""
    rec = cr._repo(repo_id)
    bare = _ensure_bare(repo_id)
    m = _map(repo_id)
    to_git = m["to_git"]
    # every commit reachable from a branch head, parents before children
    order: list[dict] = []
    seen: set[str] = set()

    def visit(cid: Optional[str]) -> None:
        stack = [(cid, False)]
        while stack:
            c, done = stack.pop()
            if not c or (c in seen and not done):
                continue
            meta = cr._commit_meta(rec, c)
            if not meta:
                continue
            if done:
                order.append(meta)
                continue
            seen.add(c)
            stack.append((c, True))
            for p in reversed(meta.get("parents") or []):
                if p not in seen:
                    stack.append((p, False))

    for b in rec["branches"].values():
        visit(b.get("head"))
    new = [c for c in order if c["id"] not in to_git]
    stream = bytearray()
    marks = {}
    for i, c in enumerate(new, 1):
        files = cr._commit_files(repo_id, c["id"])
        marks[c["id"]] = i
        when = _epoch(c.get("at") or "")
        who = (c.get("author") or "BluesandAI").replace("<", "").replace(">", "")
        stream += b"commit refs/bluesandai/import\n"
        stream += b"mark :%d\n" % i
        stream += f"author {who} <{who.lower().replace(' ', '.')}@bluesandai> {when} +0000\n".encode()
        stream += f"committer {who} <{who.lower().replace(' ', '.')}@bluesandai> {when} +0000\n".encode()
        stream += _data(c.get("message") or "(no message)")
        parents = [p for p in (c.get("parents") or []) if p in to_git or p in marks]
        for j, p in enumerate(parents):
            ref = f":{marks[p]}" if p in marks else to_git[p]
            stream += (b"from " if j == 0 else b"merge ") + ref.encode() + b"\n"
        stream += b"deleteall\n"
        for path in sorted(files):
            # gradlew (and other scripts starting with #!) are executable in the clone
            mode = "100755" if path == "gradlew" or files[path].startswith("#!/") else "100644"
            stream += f"M {mode} inline {path}\n".encode() + _data(files[path])
        stream += b"\n"
    if new:
        marks_file = bare / "import-marks"
        _git(bare, "fast-import", "--quiet", "--force", f"--export-marks={marks_file}", input=bytes(stream))
        by_mark = {}
        for line in marks_file.read_text("utf-8").splitlines():
            mk, sha = line.split()
            by_mark[int(mk[1:])] = sha
        for cid, i in marks.items():
            to_git[cid] = by_mark[i]
            m["to_repo"][by_mark[i]] = cid
        marks_file.unlink(missing_ok=True)
        _save_map(repo_id, m)
    # refs: every branch at its head, deleted branches removed
    have = {line.split()[1][len("refs/heads/"):]: line.split()[0] for line in _git(bare, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/").decode().splitlines()}
    for name, b in rec["branches"].items():
        if b.get("head") and to_git.get(b["head"]) and have.get(name) != to_git[b["head"]]:
            _git(bare, "update-ref", f"refs/heads/{name}", to_git[b["head"]])
    for name in set(have) - set(rec["branches"]):
        _git(bare, "update-ref", "-d", f"refs/heads/{name}")
    _git(bare, "symbolic-ref", "HEAD", f"refs/heads/{rec['default_branch']}")
    return bare


# --------------------------------------------------------------------------------------------
# Git → repository (after a push)
# --------------------------------------------------------------------------------------------


def _tree_files(bare: Path, sha: str) -> dict[str, str]:
    listing = _git(bare, "ls-tree", "-r", "-z", sha).split(b"\0")
    entries = []
    for e in listing:
        if not e:
            continue
        meta, _, path = e.partition(b"\t")
        mode, kind, obj = meta.split()
        if kind == b"blob":
            entries.append((path.decode("utf-8", "replace"), obj.decode()))
    if not entries:
        return {}
    out = _git(bare, "cat-file", "--batch", input=("\n".join(o for _, o in entries) + "\n").encode())
    files, pos = {}, 0
    for path, _obj in entries:
        nl = out.index(b"\n", pos)
        size = int(out[pos:nl].split()[2])
        files[path] = out[nl + 1: nl + 1 + size].decode("utf-8", "replace")
        pos = nl + 1 + size + 1
    return files


def import_push(repo_id: str, branches_before: dict[str, str]) -> list[str]:
    """Turn what a push changed into repository commits; returns a summary line per branch."""
    bare = _bare(repo_id)
    m = _map(repo_id)
    after = {line.split()[1][len("refs/heads/"):]: line.split()[0] for line in _git(bare, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/").decode().splitlines()}
    notes = []
    with cr._lock:
        rec = cr._repo(repo_id)
        for name in sorted(set(branches_before) - set(after)):
            if name in rec["branches"] and name != rec["default_branch"]:
                del rec["branches"][name]
                cr._save(rec)
                notes.append(f"{name}: deleted")
        for name, sha in after.items():
            if branches_before.get(name) == sha:
                continue
            mapped = set(m["to_repo"])
            revs = _git(bare, "rev-list", "--reverse", "--topo-order", "--parents", sha, *[f"^{x}" for x in mapped]).decode().split("\n")
            created = 0
            if name not in rec["branches"]:
                now = cr._now()
                rec["branches"][name] = {"name": name, "head": None, "files": {}, "created_at": now, "updated_at": now}
            for line in [x for x in revs if x.strip()]:
                parts = line.split()
                c_sha, parents = parts[0], parts[1:]
                message = _git(bare, "log", "-1", "--format=%B", c_sha).decode("utf-8", "replace").strip() or "(no message)"
                files = _tree_files(bare, c_sha)
                rparents = [m["to_repo"][p] for p in parents if p in m["to_repo"]]
                c = cr._commit(rec, name, message[:500], parents=rparents, files=files)
                m["to_repo"][c_sha] = c["id"]
                m["to_git"][c["id"]] = c_sha
                created += 1
            # the branch head is the pushed commit (also when it already existed, e.g. a fast-forward to a known commit)
            head = m["to_repo"].get(sha)
            if head and rec["branches"][name]["head"] != head:
                rec["branches"][name]["head"] = head
                rec["branches"][name]["files"] = cr._commit_files(repo_id, head)
                rec["branches"][name]["updated_at"] = cr._now()
                cr._save(rec)
            notes.append(f"{name}: {created} new commit{'s' if created != 1 else ''}")
        _save_map(repo_id, m)
    return notes


# --------------------------------------------------------------------------------------------
# smart HTTP (git http-backend)
# --------------------------------------------------------------------------------------------


def _pushed_refs(body: bytes) -> list[tuple[str, str, str]]:
    """(old, new, ref) commands at the start of a receive-pack request (pkt-lines)."""
    out, pos = [], 0
    while pos + 4 <= len(body):
        try:
            n = int(body[pos:pos + 4], 16)
        except ValueError:
            break
        if n == 0:
            break
        line = body[pos + 4: pos + n].split(b"\0", 1)[0].decode("utf-8", "replace").strip()
        parts = line.split()
        if len(parts) == 3:
            out.append((parts[0], parts[1], parts[2]))
        pos += n
    return out


async def _backend(request: Request, repo_id: str, path: str) -> Response:
    rec = cr._repo(repo_id)
    service = request.query_params.get("service") or ""
    pushing = path.endswith("git-receive-pack") or service == "git-receive-pack"
    # the repository's Project roles: Viewers clone and fetch, Editors push (and pushing is authoring code)
    auth.check_resource("code_repo", repo_id, "editor" if pushing else "viewer")
    if pushing:
        auth.require_code_author()
    body = await request.body()
    with _lock(repo_id):
        bare = export(repo_id)
        before = {line.split()[1][len("refs/heads/"):]: line.split()[0]
                  for line in _git(bare, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/").decode().splitlines()}
        if path.endswith("git-receive-pack"):
            data = body
            if request.headers.get("content-encoding") == "gzip":
                import gzip

                data = gzip.decompress(body)
            for old, new, ref in _pushed_refs(data):
                name = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else None
                if name is None:
                    raise HTTPException(403, f"only branches can be pushed ({ref})")
                if new == ZERO and name == rec["default_branch"]:
                    raise HTTPException(403, f"the default branch {name} cannot be deleted")
                b = rec["branches"].get(name)
                if b and new != ZERO:
                    try:
                        cr._editable(rec, b)
                    except HTTPException as e:
                        raise HTTPException(403, f"{name}: {e.detail} — push another branch and open a pull request") from None
        env = {"GIT_PROJECT_ROOT": str(bare.parent), "GIT_HTTP_EXPORT_ALL": "1", "PATH_INFO": f"/{bare.name}/{path}",
               "REQUEST_METHOD": request.method, "QUERY_STRING": request.url.query, "CONTENT_TYPE": request.headers.get("content-type", ""),
               "CONTENT_LENGTH": str(len(body)), "REMOTE_USER": (auth.current() or {}).get("username") or "local",
               "REMOTE_ADDR": request.client.host if request.client else "127.0.0.1"}
        if request.headers.get("content-encoding"):
            env["HTTP_CONTENT_ENCODING"] = request.headers["content-encoding"]
        if request.headers.get("git-protocol"):
            env["GIT_PROTOCOL"] = request.headers["git-protocol"]
        r = subprocess.run([_git_exe(), "http-backend"], input=body, capture_output=True, env={**os.environ, **env})
        if r.returncode != 0 and not r.stdout:
            raise HTTPException(500, f"git http-backend failed: {r.stderr.decode('utf-8', 'replace')[-500:]}")
        head, _, payload = r.stdout.partition(b"\r\n\r\n")
        if not _:
            head, _, payload = r.stdout.partition(b"\n\n")
        status, headers = 200, {}
        for line in head.decode("latin-1").splitlines():
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k.strip():
                headers[k.strip()] = v.strip()
        if pushing and path.endswith("git-receive-pack") and status == 200:
            try:
                notes = import_push(repo_id, before)
                log.info("git push to %s: %s", rec["name"], "; ".join(notes))
            except Exception:  # noqa: BLE001
                log.exception("git push to %s could not be imported", repo_id)
    media = headers.pop("Content-Type", None)
    return Response(payload, status_code=status, headers=headers, media_type=media)


@router.get("/{repo_git}/info/refs")
async def info_refs(repo_git: str, request: Request) -> Response:
    return await _backend(request, _repo_id(repo_git), "info/refs")


@router.post("/{repo_git}/git-upload-pack")
async def upload_pack(repo_git: str, request: Request) -> Response:
    return await _backend(request, _repo_id(repo_git), "git-upload-pack")


@router.post("/{repo_git}/git-receive-pack")
async def receive_pack(repo_git: str, request: Request) -> Response:
    return await _backend(request, _repo_id(repo_git), "git-receive-pack")


def _repo_id(repo_git: str) -> str:
    rid = repo_git[:-4] if repo_git.endswith(".git") else repo_git
    if not re.fullmatch(r"[A-Za-z0-9_-]+", rid):
        raise HTTPException(404, "no such repository")
    cr._repo(rid)
    return rid


@router.post("/{repo_id}/clone-token")
def clone_token(repo_id: str, request: Request) -> dict:
    """"Work locally": the clone URL and a personal API token that expires in 7 days."""
    rec = cr._repo(repo_id)
    auth.check_resource("code_repo", repo_id)
    base = str(request.base_url).rstrip("/")
    url = f"{base}/api/git/{repo_id}.git"
    if not auth.enabled():
        return {"url": url, "token": None, "expires_at": None, "clone": f"git clone {url} \"{rec['name']}\""}
    tok = auth.create_token(auth.TokenIn(name=f"Git: {rec['name']}", expires_days=7))
    user = (auth.current() or {}).get("username") or "user"
    scheme, rest = url.split("://", 1)
    return {"url": url, "token": tok["token"], "expires_at": tok["expires_at"], "username": user,
            "clone": f"git clone {scheme}://{user}:{tok['token']}@{rest} \"{rec['name']}\""}
