"""Code Repositories debugger and console (REPL) for Python transforms, like Foundry's Code Repositories debugger.

A session runs one transform of a branch's working copy in its own process (code_debug_worker.py), controlled over
JSON lines on its stdin / stdout, so a stuck transform or an infinite loop never blocks the API:

- mode "debug": the transform runs as a preview runs it (same inputs, nothing written) under a debugger. It stops at
  breakpoints (file + line, optional condition) — or at its first line when its file has none — and then shows the
  call stack and variables (DataFrames as tables: schema, row count, first rows), evaluates expressions or statements
  in the selected frame, and steps over / into / out, continues or stops. A running transform can be paused (an
  infinite loop shows where it spins) and breakpoints can change while it runs. An uncaught exception pauses where
  it was raised (post-mortem) before the session ends.
- mode "console": a Python console whose namespace keeps its state between commands: the transform module's globals
  (imports, helpers), the transform function itself, and its inputs preloaded under the transform's parameter names
  (DataFrames for @transform_df; TransformInput / TransformOutput objects for @transform). A command that runs too
  long can be interrupted without losing the namespace.

Sessions end when stopped, after IDLE_TIMEOUT without any request, or after RUN_TIMEOUT running without pausing; at
most MAX_SESSIONS processes run at once. Routes are included in code_repos.router (/api/code-repos/{repo}/debug/...).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import code_envs
import code_repos
import db
import drive

router = APIRouter()
WORKER = Path(__file__).with_name("code_debug_worker.py")
IDLE_TIMEOUT = 15 * 60
RUN_TIMEOUT = 300
MAX_SESSIONS = 4
OUTPUT_MAX = 200_000
EVALS_KEPT = 50
REAP_EVERY = 5
# the worker's limit per watch expression (code_debug_worker.WATCH_TIMEOUT), plus its overhead
WATCH_LIMIT = 3.5


def _watch_wait(n: int) -> float:
    """How long an answer waits for n watch expressions to be evaluated."""
    return min(60.0, 5 + WATCH_LIMIT * n)

_sessions: dict[str, "Session"] = {}
_slock = threading.Lock()
_reaper: dict[str, Optional[threading.Thread]] = {"thread": None}


class Session:
    def __init__(self, repo_id: str, branch: str, t: dict, mode: str, root: Path, breakpoints: list[dict]) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.repo_id = repo_id
        self.branch = branch
        self.transform = t["key"]
        self.file = t["file"]
        self.function = t["function"]
        self.inputs = dict(t.get("inputs") or {})
        self.mode = mode
        self.root = root
        self.proc: Optional[subprocess.Popen] = None
        self.cond = threading.Condition()
        self.version = 0
        self.status = "starting"
        self.reason: Optional[str] = None
        self.paused: Optional[dict] = None
        self.variables: list[dict] = []
        self.preloaded: list[str] = []
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.output = ""
        self.output_base = 0
        self.stderr = ""
        self.breakpoints = breakpoints
        # watch expressions with their values in the selected frame: [{expr, ok, value | error}]
        self.watches: list[dict] = []
        self.evals: dict[str, dict] = {}
        self.pending_eval: Optional[str] = None
        self.input_rows: dict = {}
        self.created_at = time.time()
        self.last_access = time.time()
        self.running_since: Optional[float] = None

    # -- process

    def start(self, spec_path: Path, python: Optional[str] = None) -> None:
        env = {k: v for k, v in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL", k)}
        env["PYTHONUNBUFFERED"] = "1"
        # the repository's environment (code_envs) when it has one
        self.proc = subprocess.Popen([python or sys.executable, str(WORKER), str(spec_path)], cwd=str(self.root), env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                                     bufsize=1, start_new_session=True)
        threading.Thread(target=self._read, daemon=True, name=f"debug-{self.id}").start()
        threading.Thread(target=self._read_stderr, daemon=True, name=f"debug-err-{self.id}").start()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def send(self, cmd: dict) -> None:
        if not self.alive():
            raise HTTPException(409, "the debug session has ended")
        try:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(json.dumps(cmd) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise HTTPException(409, "the debug session has ended") from None

    def kill(self, status: str = "stopped", error: Optional[str] = None) -> None:
        with self.cond:
            if self.status not in ("finished", "error", "stopped"):
                self.status = status
                if error:
                    self.error = error
            # nothing is paused any more (no call stack to select a frame of)
            self.paused = None
            self.reason = None
            self.pending_eval = None
            self.running_since = None
            self._bump()
        if self.proc and self.proc.poll() is None:
            _kill_tree(self.proc)
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(self.root, ignore_errors=True)

    def _bump(self) -> None:
        self.version += 1
        self.cond.notify_all()

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            self.stderr = (self.stderr + line)[-8000:]

    def _read(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            with self.cond:
                self._event(ev)
                self._bump()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            pass
        with self.cond:
            if self.status not in ("finished", "error", "stopped"):
                self.status = "error"
                self.error = self.error or ("the debug process stopped unexpectedly" + (f":\n{self.stderr[-3000:]}" if self.stderr.strip() else ""))
            self.paused = None
            self.reason = None
            self.pending_eval = None
            self.running_since = None
            self._bump()
        shutil.rmtree(self.root, ignore_errors=True)

    def _append_output(self, text: str) -> None:
        self.output += text
        if len(self.output) > OUTPUT_MAX:
            drop = len(self.output) - OUTPUT_MAX
            self.output = self.output[drop:]
            self.output_base += drop

    def _event(self, ev: dict) -> None:
        kind = ev.get("event")
        if kind == "output":
            self._append_output(ev.get("text") or "")
        elif kind == "running":
            self.status = "running"
            self.paused = None
            self.reason = None
            self.running_since = time.time()
            if ev.get("input_rows"):
                self.input_rows = ev["input_rows"]
        elif kind == "paused":
            self.status = "paused"
            self.reason = ev.get("reason")
            self.running_since = None
            self.paused = {k: ev.get(k) for k in ("file", "line", "function", "stack", "frame", "exception", "reason")}
            self.variables = ev.get("variables") or []
            self.watches = ev.get("watches") or []
        elif kind == "frame":
            if self.paused is not None:
                self.paused["frame"] = ev.get("frame", 0)
            self.variables = ev.get("variables") or []
            if "watches" in ev:
                self.watches = ev["watches"] or []
        elif kind == "watches":
            self.watches = ev.get("watches") or []
        elif kind == "ready":
            self.status = "ready"
            self.running_since = None
            self.variables = ev.get("variables") or []
            if "preloaded" in ev:
                self.preloaded = ev["preloaded"]
            if ev.get("input_rows"):
                self.input_rows = ev["input_rows"]
        elif kind == "eval":
            eid = str(ev.get("id"))
            self.evals[eid] = {k: ev.get(k) for k in ("id", "code", "ok", "value", "output", "error")}
            while len(self.evals) > EVALS_KEPT:
                self.evals.pop(next(iter(self.evals)))
            if self.pending_eval == eid:
                self.pending_eval = None
            if self.status in ("paused", "ready"):
                self.running_since = None
        elif kind == "breakpoints":
            self.breakpoints = ev.get("breakpoints") or []
        elif kind == "finished":
            self.status = "finished"
            self.result = ev.get("result")
            self.paused = None
            self.running_since = None
        elif kind == "error":
            self.status = "error"
            self.error = ev.get("error")
            self.paused = None
            self.running_since = None
        elif kind == "stopped":
            self.status = "stopped"
            self.paused = None

    # -- state

    def state(self, output_from: int = 0) -> dict:
        start = min(max(0, output_from - self.output_base), len(self.output))
        return {
            "id": self.id, "repo_id": self.repo_id, "branch": self.branch, "transform": self.transform, "file": self.file,
            "function": self.function, "mode": self.mode, "status": self.status, "reason": self.reason,
            "busy": self.pending_eval is not None, "paused": self.paused, "variables": self.variables,
            "preloaded": self.preloaded, "inputs": self.inputs, "input_rows": self.input_rows, "result": self.result,
            "error": self.error, "breakpoints": self.breakpoints, "watches": self.watches, "evals": self.evals,
            "output": self.output[start:], "output_from": self.output_base + start, "output_end": self.output_base + len(self.output),
            "version": self.version, "created_at": self.created_at, "idle_timeout_s": IDLE_TIMEOUT,
            "alive": self.alive(),
        }

    def wait_change(self, version: int, timeout: float) -> None:
        end = time.time() + timeout
        with self.cond:
            while self.version == version and time.time() < end:
                self.cond.wait(max(0.0, end - time.time()))


# ------------------------------------------------------------------------------------------------
# session lifecycle
# ------------------------------------------------------------------------------------------------


def _reap() -> None:
    while True:
        time.sleep(REAP_EVERY)
        now = time.time()
        with _slock:
            items = list(_sessions.items())
        for sid, s in items:
            try:
                if now - s.last_access > IDLE_TIMEOUT:
                    s.kill("stopped", f"the session ended after {IDLE_TIMEOUT // 60} minutes without activity")
                    with _slock:
                        _sessions.pop(sid, None)
                elif s.alive() and s.status == "running" and s.running_since and now - s.running_since > RUN_TIMEOUT:
                    s.kill("error", f"timed out: the transform ran {RUN_TIMEOUT} s without pausing")
                elif s.alive() and s.pending_eval and s.running_since and now - s.running_since > RUN_TIMEOUT:
                    s.kill("error", f"timed out: a command ran for {RUN_TIMEOUT} s")
            except Exception:  # noqa: BLE001
                pass


def _ensure_reaper() -> None:
    with _slock:
        t = _reaper["thread"]
        if t is None or not t.is_alive():
            _reaper["thread"] = threading.Thread(target=_reap, daemon=True, name="code-debug-reaper")
            _reaper["thread"].start()


def _session(repo_id: str, sid: str) -> Session:
    with _slock:
        s = _sessions.get(sid)
    if not s or s.repo_id != repo_id:
        raise HTTPException(404, "no such debug session (it may have expired)")
    s.last_access = time.time()
    return s


def shutdown() -> None:
    """Kill every session (tests / API shutdown)."""
    with _slock:
        items = list(_sessions.values())
        _sessions.clear()
    for s in items:
        s.kill()


def _kill_tree(proc: subprocess.Popen) -> None:
    """The worker and what it started (a Spark JVM, Python workers): its process group on POSIX, its process tree on
    Windows (no os.killpg there)."""
    if hasattr(os, "killpg"):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError):
            pass
    try:
        import psutil

        root = psutil.Process(proc.pid)
        for child in root.children(recursive=True):
            try:
                child.kill()
            except psutil.Error:
                pass
        root.kill()
    except Exception:  # noqa: BLE001 - psutil missing or the process is gone
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass


def _materialize(root: Path, files: dict[str, str], t: dict, items: dict[str, dict], extra: dict) -> dict:
    """The repository's files and the transform's inputs on disk, as code_repos._run lays them out for a preview."""
    for path, content in files.items():
        p = root / "repo" / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
    spec_in = code_repos._input_spec(t, items)
    inputs: dict[str, str] = {}
    for name, item_id in spec_in["input_items"].items():
        dest = root / "inputs" / f"{name}.parquet"
        dest.parent.mkdir(exist_ok=True)
        dest.write_bytes(drive.read_bytes(db.drive_get(item_id)))
        inputs[name] = str(dest)
    media: dict[str, dict] = {}
    total = 0
    for name, folder_id in spec_in["media_folders"].items():
        files_ = code_repos._media_files(folder_id)
        total += sum(int(f.get("size_bytes") or 0) for f in files_)
        if len(files_) > code_repos.MEDIA_MAX_ITEMS or total > code_repos.MEDIA_MAX_BYTES:
            raise HTTPException(413, f"media set {name} is too large to debug ({len(files_)} items)")
        d = root / "media" / name
        d.mkdir(parents=True)
        lst = []
        for i, f in enumerate(files_):
            dest = d / str(i)
            drive.copy_content(f, dest)
            lst.append({"id": f["id"], "path": f["name"], "file": str(dest), "size": f.get("size_bytes"),
                        "content_type": f.get("content_type"), "updated_at": str(f.get("updated_at")), "folder_id": folder_id})
        media[name] = {"items": lst}
    spec = {k: v for k, v in extra.items() if k not in ("previous_output_item", "previous_output_items")}
    prev = extra.get("previous_output_item")
    if prev:
        (root / "previous.parquet").write_bytes(drive.read_bytes(db.drive_get(prev)))
        spec["previous_output"] = str(root / "previous.parquet")
    prev_outputs = {}
    for i, (param, item_id) in enumerate((extra.get("previous_output_items") or {}).items()):
        # @transform.using outputs read in "previous" mode (incremental)
        dest = root / f"previous-{i}.parquet"
        dest.write_bytes(drive.read_bytes(db.drive_get(item_id)))
        prev_outputs[param] = str(dest)
    if prev_outputs:
        spec["previous_outputs"] = prev_outputs
    return {**spec, "repo": str(root / "repo"), "inputs": inputs, "media_inputs": media, "media_out": str(root / "media-out")}


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class BreakpointIn(BaseModel):
    file: str = Field(max_length=500)
    line: int = Field(ge=1)
    condition: Optional[str] = Field(default=None, max_length=2000)


class StartIn(BaseModel):
    branch: Optional[str] = None
    # "<file path>::<function name>"; or the first Python transform in `file`
    transform: Optional[str] = None
    file: Optional[str] = None
    mode: Literal["debug", "console"] = "debug"
    breakpoints: list[BreakpointIn] = []
    # watch expressions (debug mode): evaluated in the selected frame at each pause
    watches: list[str] = Field(default=[], max_length=30)
    # stop at the transform's first line (default: when its file has no breakpoint)
    stop_on_entry: Optional[bool] = None


class CommandIn(BaseModel):
    action: Literal["continue", "step", "next", "return", "pause", "stop"]
    # wait (seconds) for the session to change before answering
    wait: float = 3


class EvalIn(BaseModel):
    code: str = Field(max_length=50_000)
    frame: int = 0
    wait: float = 20


class FrameIn(BaseModel):
    frame: int = 0


class BreakpointsIn(BaseModel):
    breakpoints: list[BreakpointIn]


class WatchesIn(BaseModel):
    watches: list[str] = Field(max_length=30)


@router.get("/{repo_id}/debug/sessions")
def list_sessions(repo_id: str) -> list[dict]:
    code_repos._repo(repo_id)
    with _slock:
        items = [s for s in _sessions.values() if s.repo_id == repo_id]
    return [{k: v for k, v in s.state(1 << 62).items() if k not in ("variables", "evals", "output", "result")} for s in items]


@router.post("/{repo_id}/debug/sessions")
def start_session(repo_id: str, req: StartIn) -> dict:
    rec = code_repos._repo(repo_id)
    b = code_repos._branch(rec, req.branch)
    files = b["files"]
    listed = code_repos._run(files, {"mode": "list"}, rec)
    if not listed.get("ok"):
        raise HTTPException(400, listed.get("error") or "the repository does not load")
    key = req.transform
    if not key:
        py = [t for t in listed.get("transforms", []) if t.get("file") == req.file and t.get("language", "python") == "python"]
        if not py:
            err = next((e["error"] for e in listed.get("errors", []) if e.get("file") == req.file), None)
            raise HTTPException(400, err or "no Python transform in this file")
        key = py[0]["key"]
    t, items = code_repos._prepare_from(listed, key)
    if t.get("language", "python") != "python" or t.get("kind") not in ("df", "transform", "lightweight", "spark"):
        raise HTTPException(400, "the debugger and console run Python transforms (@transform_df / @transform / @transform.using / @transform.spark.using)")
    if t.get("blocked"):
        raise HTTPException(400, t["blocked"])
    with _slock:
        live = [s for s in _sessions.values() if s.alive()]
        if len(live) >= MAX_SESSIONS:
            raise HTTPException(429, f"{MAX_SESSIONS} debug sessions are running: stop one first")
    extra = code_repos._incremental_spec(rec, b["name"], t, False) if t.get("incremental") else {}
    bps = [bp.model_dump() for bp in req.breakpoints]
    root = Path(tempfile.mkdtemp(prefix="codedebug-"))
    try:
        spec = _materialize(root, files, t, items, extra)
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    # default: stop at the first line when the transform's own file has no breakpoint (breakpoints kept for other
    # transforms of the repository would otherwise let this one run to its end, or spin, without ever pausing)
    stop_on_entry = req.stop_on_entry if req.stop_on_entry is not None else not any(bp["file"] == t["file"] for bp in bps)
    if t.get("kind") in ("lightweight", "spark"):
        # parameters (repoSettings.json pythonParameters) and resources, as a build gets them
        spec.update({k: v for k, v in code_repos._python_spec(rec, t).items() if k != "timeout_s"})
    watches = [w[:2000] for w in req.watches if w.strip()]
    spec.update(mode=req.mode, transform=key, breakpoints=bps, stop_on_entry=stop_on_entry, watches=watches)
    (root / "spec.json").write_text(json.dumps(spec), "utf-8")
    s = Session(repo_id, b["name"], t, req.mode, root, [{**bp, "verified": None, "message": None} for bp in bps])
    s.watches = [{"expr": w, "ok": None} for w in watches] if req.mode == "debug" else []
    with _slock:
        _sessions[s.id] = s
    try:
        python = code_envs.python_for((code_repos._environment(files, rec) or {}).get("dedicated"))
    except code_envs.EnvError as e:
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(400, f"The repository environment could not be installed: {e}") from None
    s.start(root / "spec.json", python)
    _ensure_reaper()
    end = time.time() + 15
    while time.time() < end:
        with s.cond:
            if s.status != "starting":
                break
            v = s.version
        s.wait_change(v, end - time.time())
    with s.cond:
        return s.state()


@router.get("/{repo_id}/debug/sessions/{sid}")
def session_state(repo_id: str, sid: str, version: Optional[int] = None, wait: float = 0, output_from: int = 0) -> dict:
    """The session's state; with `version` and `wait`, waits (up to 25 s) until it changes."""
    s = _session(repo_id, sid)
    if version is not None and wait > 0:
        s.wait_change(version, min(wait, 25))
    with s.cond:
        return s.state(output_from)


@router.post("/{repo_id}/debug/sessions/{sid}/command")
def command(repo_id: str, sid: str, req: CommandIn) -> dict:
    s = _session(repo_id, sid)
    if req.action == "stop":
        if s.alive():
            s.kill("stopped")
        with s.cond:
            return s.state()
    with s.cond:
        status, busy, version = s.status, s.pending_eval is not None, s.version
    if req.action == "pause":
        if not (status == "running" or busy):
            raise HTTPException(409, "nothing is running")
    elif s.mode != "debug" or status != "paused":
        raise HTTPException(409, "the transform is not paused")
    elif busy:
        raise HTTPException(409, "an evaluation is still running: interrupt it first")
    s.send({"cmd": req.action})
    s.wait_change(version, max(0.0, min(req.wait, 10)))
    if req.action != "pause":
        # resuming emits "running" first; give a quick step the chance to pause again before answering
        with s.cond:
            v2, st = s.version, s.status
        if st == "running":
            s.wait_change(v2, max(0.0, min(req.wait, 10)))
    with s.cond:
        return s.state()


@router.post("/{repo_id}/debug/sessions/{sid}/eval")
def evaluate(repo_id: str, sid: str, req: EvalIn) -> dict:
    """Run an expression or statements in the paused frame (debug) or the console namespace. Answers with the result,
    or {pending: true} when it is still running after `wait` seconds (it then appears in the state's evals)."""
    s = _session(repo_id, sid)
    with s.cond:
        if s.pending_eval:
            raise HTTPException(409, "the previous command is still running")
        if s.mode == "debug" and s.status != "paused":
            raise HTTPException(409, "pause the transform (a breakpoint or Pause) to evaluate in it")
        if s.mode == "console" and s.status != "ready":
            raise HTTPException(409, "the console is not ready" if s.status in ("starting", "running") else "the console has ended")
        eid = uuid.uuid4().hex[:10]
        s.pending_eval = eid
        s.running_since = time.time()
        s._bump()
    try:
        s.send({"cmd": "eval", "id": eid, "code": req.code, "frame": req.frame})
    except HTTPException:
        with s.cond:
            s.pending_eval = None
        raise
    end = time.time() + max(0.0, min(req.wait, 60))
    with s.cond:
        while eid not in s.evals and s.alive() and time.time() < end:
            s.cond.wait(max(0.0, end - time.time()))
        res = s.evals.get(eid)
        return {"id": eid, "pending": res is None and s.pending_eval == eid, "result": res, "state": s.state(1 << 62) | {"output": ""}}


@router.post("/{repo_id}/debug/sessions/{sid}/frame")
def select_frame(repo_id: str, sid: str, req: FrameIn) -> dict:
    s = _session(repo_id, sid)
    with s.cond:
        if s.mode == "debug" and s.status != "paused":
            raise HTTPException(409, "the transform is not paused")
        if s.pending_eval:
            raise HTTPException(409, "a command is running")
        version = s.version
        n_watches = len(s.watches)
    s.send({"cmd": "frame", "frame": req.frame})
    # the frame's variables and watches come in one event, after its watches are evaluated
    end = time.time() + _watch_wait(n_watches)
    with s.cond:
        while time.time() < end and s.alive() and s.status == "paused":
            if s.version != version and (s.paused or {}).get("frame") == req.frame:
                break
            s.cond.wait(max(0.0, end - time.time()))
        return s.state(1 << 62)


@router.put("/{repo_id}/debug/sessions/{sid}/breakpoints")
def set_breakpoints(repo_id: str, sid: str, req: BreakpointsIn) -> dict:
    """Replace the breakpoints; applies to a running transform too."""
    s = _session(repo_id, sid)
    bps = [bp.model_dump() for bp in req.breakpoints]
    with s.cond:
        version = s.version
        if not s.alive() or s.mode != "debug":
            s.breakpoints = [{**bp, "verified": None, "message": None} for bp in bps]
            return s.state(1 << 62)
    s.send({"cmd": "breakpoints", "breakpoints": bps})
    s.wait_change(version, 3)
    with s.cond:
        return s.state(1 << 62)


@router.put("/{repo_id}/debug/sessions/{sid}/watches")
def set_watches(repo_id: str, sid: str, req: WatchesIn) -> dict:
    """Replace the watch expressions; their values come with the answer when the transform is paused (else at the next
    pause)."""
    s = _session(repo_id, sid)
    watches = [w[:2000] for w in req.watches if w.strip()]
    with s.cond:
        if s.mode != "debug":
            raise HTTPException(409, "watch expressions are for debug sessions")
        if s.pending_eval:
            raise HTTPException(409, "a command is running")
        if not s.alive():
            s.watches = [{"expr": w, "ok": None} for w in watches]
            return s.state(1 << 62)
    s.send({"cmd": "watches", "watches": watches})
    # answered once these watches are listed (and evaluated, when paused): each may take up to WATCH_TIMEOUT, and an
    # earlier request still being evaluated must not answer for this one
    end = time.time() + _watch_wait(len(watches))
    with s.cond:
        while time.time() < end and s.alive():
            if [w.get("expr") for w in s.watches] == watches and (s.status != "paused" or all(w.get("ok") is not None for w in s.watches)):
                break
            s.cond.wait(max(0.0, end - time.time()))
        return s.state(1 << 62)


@router.delete("/{repo_id}/debug/sessions/{sid}")
def delete_session(repo_id: str, sid: str) -> dict:
    s = _session(repo_id, sid)
    s.kill("stopped")
    with _slock:
        _sessions.pop(sid, None)
    return {"ok": True}
