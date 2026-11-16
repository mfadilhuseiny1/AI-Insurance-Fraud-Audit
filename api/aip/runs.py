"""AIP runs: one run of the AIP agents (a question, a mission task, a validation) in its own process on the ADK
runtime (.venv-adk, aip/adk_runtime), acting for the user who started it.

The run gets a job token (auth.issue_job_token) for that user: the runtime calls the platform's API with it, for its
tools and for the models (aip/gateway.py), so it sees exactly what the user may see and every model call passes the
spend guard. The token is revoked when the run ends. The runtime writes one JSON event per line on stdout (plan, tool
step with its receipt, agent text, verdict, ui spec, proposal, answer, error); they are kept in
<data>/aip/runs/<id>/events.jsonl and polled by the page. Tool results the dynamic UI binds to are kept as
results/<rid>.json, so tables of any size never pass through the model.

    POST /api/aip/ask                        {q, history?} → {run}
    GET  /api/aip/runs                       the caller's runs, newest first
    GET  /api/aip/runs/{id}?after=n          the run and its events from n on (poll)
    GET  /api/aip/runs/{id}/results/{rid}    a tool result's rows
    POST /api/aip/runs/{id}/cancel
    GET  /api/aip/agents                     the domain agents (aip/domains.py) and the model of each role
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip")

API_DIR = Path(__file__).resolve().parent.parent
ROOT = API_DIR.parent
ADK_PYTHON = Path(os.environ.get("BLUESANDAI_ADK_PYTHON") or (ROOT / ".venv-adk" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")))
log = logging.getLogger("aip.runs")
MAX_ACTIVE_PER_USER = 2
TOKEN_SECONDS = 7200
# a Blu 1.1 engagement: the clinical review of tens of thousands of claims (3–5 h) before the agents' hour; at two hours its token
# would expire halfway and every model and API call after it fail, the money spent (revoked when the run ends anyway)
TOKEN_SECONDS_LONG = 10 * 3600


def _token_seconds(rec_or_payload: dict) -> int:
    return TOKEN_SECONDS_LONG if str(rec_or_payload.get("versi") or "") == "1.1" else TOKEN_SECONDS
_lock = threading.Lock()
_live: dict[str, dict] = {}  # run id → {"rec", "events", "proc"}


class RunBudgetExceeded(RuntimeError):
    """A model call refused because the run (a mission) would pass its budget."""


def _dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write(path: Path, data: Any) -> None:
    """Atomic JSON write, as the platform's (ontology._write): a temp file of its own per write, renamed over the
    target, retried while Windows has the target open for a reader. A fixed temp name and one rename made a mission
    thread die when the page read tasks.json at that moment (2026-10-22, the end-to-end test)."""
    fd, name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=1, default=str))
        for attempt in range(40):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.005 if attempt < 4 else 0.05)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _settle(rec: dict) -> dict:
    """A run on disk still marked running that no live process follows (the API or the script that started it
    stopped) can never finish: mark it interrupted, so lists and missions stop waiting for it. Its runtime, if it
    still runs, is stopped: it holds the user's job token and nobody reads what it does."""
    import psutil

    if rec.get("status") != "running" or rec["id"] in _live:
        return rec
    host = rec.get("host_pid")
    if host and host != os.getpid() and psutil.pid_exists(host):
        return rec  # another process (a script) started it and follows it
    if rec.get("pid"):
        try:
            orphan = psutil.Process(rec["pid"])
            if "aip.adk_runtime" in " ".join(orphan.cmdline()):  # not a process that reused the pid
                orphan.kill()
        except psutil.Error:
            pass
    rec.update(status="interrupted", finished_at=rec.get("finished_at") or _now())
    try:
        _write(_dir() / rec["id"] / "run.json", rec)
    except OSError:
        pass
    return rec


def _rec(run_id: str) -> dict:
    live = _live.get(run_id)
    if live:
        return live["rec"]
    if not re.fullmatch(r"run-[0-9a-f]{12}", run_id):  # an id names a folder: nothing else reaches the filesystem
        raise HTTPException(404, "run not found")
    try:
        return _settle(json.loads((_dir() / run_id / "run.json").read_text("utf-8")))
    except (OSError, ValueError):
        raise HTTPException(404, "run not found") from None


def _events(run_id: str) -> list[dict]:
    live = _live.get(run_id)
    if live:
        return live["events"]
    if not re.fullmatch(r"run-[0-9a-f]{12}", run_id):
        return []
    try:
        return [json.loads(line) for line in (_dir() / run_id / "events.jsonl").read_text("utf-8").splitlines() if line.strip()]
    except OSError:
        return []


def _principal() -> dict:
    import auth

    p = auth.current()
    if p is None or p.get("service"):
        if not auth.enabled():
            return {"id": "local", "username": "local"}
        raise HTTPException(401, "sign in to run the AIP agents")
    return p


def check_access(run_id: str) -> dict:
    """The run, if the caller started it (the runtime calls with the same user's job token)."""
    import auth

    rec = _rec(run_id)
    p = _principal()
    if rec["user_id"] != p.get("id") and p.get("role") != "admin" and auth.enabled():
        raise HTTPException(404, "run not found")
    return rec


def engagement_of(run_id: str) -> str:
    """The engagement a run reports on: itself, or for a report rewrite the engagement it copies, followed back through a
    rewrite of a rewrite — only that first engagement keeps a box, tags and recommendations (2026-10-29: a rewrite of a line
    rerun found no box, and the report would have read today's live one)."""
    seen: set[str] = set()
    while run_id not in seen:
        seen.add(run_id)
        try:
            src = _rec(run_id).get("ulang_laporan")
        except HTTPException:
            break
        if not src:
            break
        run_id = src
    return run_id


def check_budget(run_id: str, need: float) -> None:
    rec = _rec(run_id)
    if rec.get("budget_usd") is not None and rec.get("spent_usd", 0.0) + need > rec["budget_usd"]:
        raise RunBudgetExceeded(f"run budget reached: ${rec.get('spent_usd', 0):.4f} spent, this call could cost ${need:.4f}, "
                                f"budget ${rec['budget_usd']:.2f}")


def book(run_id: str, agent: str, model: str, usage: Optional[dict], calls: int = 1) -> None:
    """One booking on the run's ledger: a call, or `calls` with their usage summed (Blu 1.3's Decisions batches)."""
    from aip import models as aip_models

    usd = aip_models.cost(model, usage)
    u = usage or {}
    line = {"t": _now(), "agent": agent, "model": model, "prompt": int(u.get("prompt_tokens") or 0),
            "cached": int(((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0), "output": int(u.get("completion_tokens") or 0), "usd": usd, **({"calls": calls} if calls != 1 else {})}
    with _lock:
        rec = _rec(run_id)
        rec["spent_usd"] = round(rec.get("spent_usd", 0.0) + usd, 8)
        a = rec.setdefault("agents_usage", {}).setdefault(agent or "?", {"calls": 0, "prompt": 0, "cached": 0, "output": 0, "usd": 0.0, "model": model})
        for k in ("prompt", "cached", "output"):
            a[k] += line[k]
        a["calls"] += calls
        a["usd"] = round(a["usd"] + usd, 8)
        d = _dir() / run_id
        with (d / "usage.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
        _write(d / "run.json", rec)


# ------------------------------------------------------------------------------------------------
# starting a run: the ADK runtime in its own process
# ------------------------------------------------------------------------------------------------


def _reader(run_id: str, proc: subprocess.Popen) -> None:
    """Keep the runtime's events as they come; at the end, whatever happened on the way, revoke the run's token and
    close the record (a reader that died would leave the token alive and the run 'running' for good)."""
    d = _dir() / run_id
    live = _live[run_id]
    rec = live["rec"]
    try:
        with (d / "events.jsonl").open("a", encoding="utf-8") as out:
            for raw in proc.stdout:  # type: ignore[union-attr]
                try:
                    _keep(d, live, rec, out, raw)
                except Exception:  # noqa: BLE001 - one event lost, not the run
                    log.exception("AIP run %s: an event could not be kept", run_id)
    finally:
        code = proc.wait()
        import auth

        try:
            auth.revoke_job_token(live.get("token"))
        finally:
            with _lock:
                if rec["status"] == "running":
                    ended = any(e.get("type") == "done" for e in live["events"])
                    # an engagement whose runtime was stopped from outside (killed before its API, the machine down) — no
                    # final error of its own — was cut, not failed: it continues where it stopped (resume)
                    last = live["events"][-1] if live["events"] else {}
                    cut = rec.get("kind") == "konsultan" and code != 0 and not ended and not (last.get("type") == "error" and not last.get("agent"))
                    rec["status"] = "succeeded" if code == 0 and ended else "interrupted" if cut else "failed"
                rec["finished_at"] = _now()
                rec["exit_code"] = code
                try:
                    _write(d / "run.json", rec)
                finally:
                    _live.pop(run_id, None)


def _keep(d: Path, live: dict, rec: dict, out: Any, raw: bytes) -> None:
    line = raw.decode("utf-8", "replace").strip()
    if not line.startswith("{"):
        return
    try:
        ev = json.loads(line)
    except ValueError:
        return
    if ev.get("type") == "result":  # rows for the dynamic UI: kept apart, the event keeps the shape only
        (d / "results").mkdir(exist_ok=True)
        _write(d / "results" / f"{ev['rid']}.json", {"columns": ev.get("columns"), "rows": ev.get("rows"), "types": ev.get("types") or {},
                                                    "title": ev.get("title"), "total": ev.get("total"), "object_type": ev.get("object_type")})
        ev = {k: v for k, v in ev.items() if k != "rows"} | {"n": len(ev.get("rows") or [])}
    ev.setdefault("t", _now())
    with _lock:
        ev["seq"] = len(live["events"])
        live["events"].append(ev)
        if ev.get("type") == "answer":
            rec["answer"] = ev.get("text")
        if ev.get("type") == "ui_spec":
            rec["ui_spec"] = ev.get("spec")
    out.write(json.dumps(ev, ensure_ascii=False) + "\n")
    out.flush()


def user_daily_usd() -> Optional[float]:
    """Each user's daily share of the questions' model spend (the Vertex daily cap is everyone's); "off": no share."""
    from mailer import env

    raw = (env("BLUESANDAI_AIP_USER_DAILY_USD") or "").strip().lower()
    if raw in ("off", "none", "no", "false"):
        return None
    try:
        return float(raw) if raw else 0.5
    except ValueError:
        return 0.5


def _spent_today(user_id: Optional[str]) -> float:
    today = datetime.now(timezone.utc).date().isoformat()
    total = 0.0
    for d in _dir().iterdir():
        try:
            rec = _live[d.name]["rec"] if d.name in _live else json.loads((d / "run.json").read_text("utf-8"))
        except (OSError, ValueError, KeyError):
            continue
        if rec.get("user_id") == user_id and not rec.get("mission_id") and str(rec.get("created_at", "")).startswith(today):
            total += float(rec.get("spent_usd") or 0)
    return total


def internal_api(request: Request) -> str:
    """Where the runtime reaches this API with the run's job token: BLUESANDAI_INTERNAL_API_URL, else the socket the
    request came in on. Never the Host header the client sent: a forged one would send the token to another server."""
    configured = os.environ.get("BLUESANDAI_INTERNAL_API_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    host, port = request.scope.get("server") or ("127.0.0.1", 8000)
    # loopback as "localhost": 127.0.0.1 is the Developer Console hosting origin (auth.hosting_url)
    host = "localhost" if host in ("", "0.0.0.0", "::", "127.0.0.1", "::1") else host
    return f"http://{'[' + host + ']' if ':' in host else host}:{port}"


def start(kind: str, payload: dict, request: Request, budget_usd: Optional[float] = None, mission_id: Optional[str] = None) -> dict:
    import auth

    p = _principal()
    if not ADK_PYTHON.is_file():
        raise HTTPException(503, f"the ADK runtime is not installed ({ADK_PYTHON}): uv venv .venv-adk && uv pip install google-adk litellm httpx")
    with _lock:
        # the operator's quick turns are counted apart: a running engagement does not hold the chat, and the operator's own
        # analisis_agen (a child "ask" run) is not refused by the turn that started it
        active = [r for r in _live.values() if r["rec"]["user_id"] == p.get("id") and (r["rec"].get("kind") == "operator") == (kind == "operator")]
        if len(active) >= MAX_ACTIVE_PER_USER:
            raise HTTPException(429, f"{len(active)} AIP runs are still running for you: wait for one to finish")
    if mission_id is None:  # a mission spends its own approved budget; questions share the day's
        limit = user_daily_usd()
        spent = _spent_today(p.get("id")) if limit is not None else 0.0
        if limit is not None and spent >= limit:
            raise HTTPException(429, f"your AIP questions today cost ${spent:.3f}, your daily share is ${limit:.2f}: "
                                     "continue tomorrow, or an administrator raises BLUESANDAI_AIP_USER_DAILY_USD")
    run_id = "run-" + uuid.uuid4().hex[:12]
    token = auth.issue_job_token(p.get("id") if p.get("id") != "local" else None, _token_seconds(payload), f"aip:{run_id}") or ""
    rec = {"id": run_id, "kind": kind, "mission_id": mission_id, "user_id": p.get("id"), "username": p.get("username"), "status": "running",
           "created_at": _now(), "finished_at": None, "q": payload.get("q"), "budget_usd": budget_usd, "spent_usd": 0.0, "agents_usage": {},
           "follow": payload.get("follow"),
           **({"nama": payload["nama"]} if payload.get("nama") else {}),  # an engagement's name from its form
           **({"proyek": payload["proyek"]} if payload.get("proyek") else {}),  # the AI Agent Swarm project it belongs to
           **({"versi": payload["versi"]} if payload.get("versi") else {}),  # the AI orchestration: Blu 1.0 or Blu 1.1 (aip/telaah.py)
           **({"telaah_mode": payload["telaah_mode"]} if payload.get("telaah_mode") else {}),  # a Blu 1.1 calibration-only run
           # a Konsultan report rewrite: the engagement it copies, and whether it writes outline first (aip/konsultan.py)
           **({"ulang_laporan": payload["ulang_laporan"], "kerangka": payload.get("kerangka", True)} if payload.get("ulang_laporan") else {})}
    d = _dir() / run_id
    d.mkdir(parents=True)
    _write(d / "run.json", rec)
    # its input (without the token), for continuing it after a cut (resume)
    _write(d / "input.json", {"kind": kind, **payload})
    _spawn(run_id, kind, rec, payload, getattr(request, "internal_api", None) or internal_api(request), token, [])
    return rec


def _spawn(run_id: str, kind: str, rec: dict, payload: dict, api: str, token: str, events: list[dict]) -> None:
    """The run's runtime process, its input on stdin, a reader keeping its events (after `events`, a continued run's)."""
    d = _dir() / run_id
    extra: dict = {}
    if kind == "operator":  # a runtime already past its imports, and the agents' catalogue from here (not a call back)
        proc = _operator_runtime()
        extra = {"catalogue": _catalogue()}
    else:
        log = (d / "runtime.log").open("ab")
        proc = subprocess.Popen([str(ADK_PYTHON), "-u", "-m", "aip.adk_runtime.main"], cwd=str(API_DIR), env=_runtime_env(),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
    rec["pid"], rec["host_pid"] = proc.pid, os.getpid()
    _live[run_id] = {"rec": rec, "events": events, "proc": proc, "token": token}
    _write(d / "run.json", rec)
    proc.stdin.write(json.dumps({"run_id": run_id, "kind": kind, "api": api, "token": token, **payload, **extra}).encode("utf-8"))  # type: ignore[union-attr]
    proc.stdin.close()  # type: ignore[union-attr]
    threading.Thread(target=_reader, args=(run_id, proc), name=f"aip-{run_id}", daemon=True).start()


def _runtime_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "LANG")}
    env.update({"PYTHONPATH": str(API_DIR), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
    return env


# The AIP Operator's turns are meant to be quick (a chat): a runtime is started ahead and waits on its stdin with its
# imports done (litellm and ADK: ~5 s of every turn, measured 2026-10-28), and the agents' catalogue (~2 s to build,
# the same for every caller) is kept a minute and sent with the input instead of being fetched back over HTTP.
_warm: Optional[subprocess.Popen] = None
_warm_lock = threading.Lock()
_cat: tuple[float, dict] = (0.0, {})
_cat_lock = threading.Lock()
CATALOGUE_TTL = 120


def _operator_start() -> subprocess.Popen:
    with (_dir().parent / "operator-runtime.log").open("ab") as err:  # the child keeps its own handle
        return subprocess.Popen([str(ADK_PYTHON), "-u", "-m", "aip.adk_runtime.operator"], cwd=str(API_DIR), env=_runtime_env(),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)


def _operator_runtime() -> subprocess.Popen:
    """The waiting runtime when there is one (else a new one), and the next one started for the turn after."""
    global _warm
    with _warm_lock:
        proc, _warm = _warm, None
    if proc is None or proc.poll() is not None:
        proc = _operator_start()
    threading.Thread(target=_prewarm, daemon=True, name="aip-operator-warm").start()
    return proc


def _prewarm() -> None:
    global _warm
    if not ADK_PYTHON.is_file():
        return
    with _warm_lock:
        if _warm is not None and _warm.poll() is None:
            return
    try:
        proc = _operator_start()
    except OSError:
        log.exception("AIP operator: the waiting runtime could not start")
        return
    with _warm_lock:
        if _warm is None or _warm.poll() is not None:
            _warm, proc = proc, None
    if proc is not None:  # another thread was quicker
        proc.kill()
    try:
        _catalogue()
    except Exception:  # noqa: BLE001 - built at the turn then
        log.exception("AIP operator: the catalogue could not be built ahead")


def _catalogue() -> dict:
    """The agents' catalogue: built once, then the kept one at once while a fresh one is built beside it (a turn never waits
    on the ontology's lock, which another long call may hold — 25 s seen on 2026-10-28)."""
    t, cat = _cat
    if not cat:
        return _build_catalogue()
    if time.time() - t > CATALOGUE_TTL and _cat_lock.acquire(blocking=False):
        def fresh() -> None:
            try:
                _build_catalogue()
            except Exception:  # noqa: BLE001 - the kept one serves until the next try
                log.exception("AIP operator: the catalogue could not be rebuilt")
            finally:
                _cat_lock.release()
        threading.Thread(target=fresh, daemon=True, name="aip-catalogue").start()
    return cat


def _build_catalogue() -> dict:
    global _cat
    from aip import domains

    cat = domains.catalogue()
    _cat = (time.time(), cat)
    return cat


@router.on_event("startup")
def _operator_ready() -> None:
    threading.Thread(target=_prewarm, daemon=True, name="aip-operator-warm").start()


# ------------------------------------------------------------------------------------------------
# continuing an AI Agent Swarm engagement that was cut short (an API restart, the machine going down)
# ------------------------------------------------------------------------------------------------

RESUME_WINDOW_H = 12  # an engagement cut longer ago than this is left as it is (continue it by hand)
RESUME_TRIES = 3  # continued at most this often: a runtime that dies every time is not restarted for good


def _trail(run_id: str) -> list[dict]:
    """The run's events as kept; a line the stop cut in half is left out."""
    out = []
    try:
        lines = (_dir() / run_id / "events.jsonl").read_text("utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        ev["seq"] = len(out)
        out.append(ev)
    return out


def resume(run_id: str, api: str) -> dict:
    """Continue an engagement of the AI Agent Swarm that was cut short, in the same run: a new runtime reads the run's own
    trail and goes on from it (adk_runtime/firm.py Firm.resume_state) — finished phases are not run again, finished agents
    keep their reports, cut agents go on from their steps. Its events, results and spend continue the run's."""
    import auth

    if not re.fullmatch(r"run-[0-9a-f]{12}", run_id):
        raise HTTPException(404, "run not found")
    with _lock:
        if run_id in _live:
            raise HTTPException(409, "the run is still running")
        rec = _settle(json.loads((_dir() / run_id / "run.json").read_text("utf-8")))  # an orphaned runtime is stopped first
        if rec.get("kind") != "konsultan" or rec.get("ulang_laporan"):
            raise HTTPException(409, "only an engagement of the AI Agent Swarm continues where it stopped")
        if rec.get("status") != "interrupted":
            raise HTTPException(409, f"the run is {rec.get('status')}: only an interrupted one continues")
        if not ADK_PYTHON.is_file():
            raise HTTPException(503, f"the ADK runtime is not installed ({ADK_PYTHON})")
        try:
            payload = json.loads((_dir() / run_id / "input.json").read_text("utf-8"))
            payload.pop("kind", None)
        except (OSError, ValueError):  # started before runs kept their input: rebuilt from the record and the trail
            from aip import konsultan

            payload = konsultan.resume_payload(rec, _trail(run_id))
        events = _trail(run_id)
        token = auth.issue_job_token(rec.get("user_id") if rec.get("user_id") != "local" else None, _token_seconds(rec), f"aip:{run_id}") or ""
        rec.pop("exit_code", None)
        rec.update(status="running", finished_at=None, lanjut=int(rec.get("lanjut") or 0) + 1, dilanjutkan_pada=_now())
        _spawn(run_id, "konsultan", rec, {**payload, "lanjut": True}, api, token, events)
    log.info("AIP run %s continued (attempt %s) from %s events", run_id, rec["lanjut"], len(events))
    return rec


def _resume_cut() -> None:
    """At API start: engagements the stop cut short go on by themselves, once this API answers (their runtime calls it)."""
    import urllib.request

    api = os.environ.get("BLUESANDAI_INTERNAL_API_URL", "").strip().rstrip("/") or "http://localhost:8000"
    for _ in range(120):
        try:
            with urllib.request.urlopen(f"{api}/api/auth/status", timeout=5):
                break
        except Exception:  # noqa: BLE001 - not listening yet
            time.sleep(2)
    else:
        log.warning("AIP: the API did not answer at %s; cut engagements are left to continue by hand", api)
        return
    now = time.time()
    for d in sorted(_dir().iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:60]:
        try:
            rec = json.loads((d / "run.json").read_text("utf-8"))
            last = max((d / f).stat().st_mtime for f in ("events.jsonl", "run.json") if (d / f).exists())
        except (OSError, ValueError):
            continue
        if (rec.get("kind") != "konsultan" or rec.get("ulang_laporan") or rec.get("status") not in ("running", "interrupted")
                or now - last > RESUME_WINDOW_H * 3600 or int(rec.get("lanjut") or 0) >= RESUME_TRIES):
            continue
        try:
            resume(d.name, api)
        except HTTPException as e:
            log.info("AIP run %s not continued: %s", d.name, e.detail)
        except Exception:  # noqa: BLE001 - the others still go on
            log.exception("AIP run %s could not be continued", d.name)


@router.on_event("startup")
def _continue_at_start() -> None:
    if os.environ.get("BLUESANDAI_AIP_RESUME", "on").lower() in ("off", "0", "false", "no"):
        return
    threading.Thread(target=_resume_cut, daemon=True, name="aip-resume").start()


# ------------------------------------------------------------------------------------------------
# routes
# ------------------------------------------------------------------------------------------------


class AskIn(BaseModel):
    q: str = Field(min_length=1, max_length=4000)
    history: list[dict] = []
    voice: bool = False  # asked by voice (aip/voice.py): the writer answers in a few spoken sentences
    follow: Optional[str] = None  # the run this question follows up: the conversation is that run's thread, read here


def _scope(run_id: str) -> str:
    """What a run's answer was read from: its domain agents' successful data reads (object type, filter, measure), so a
    follow-up's "-nya" / "itu" means that set of data, not the whole of it (2026-10-24: "berapa estimasi kerugiannya" after
    a question about O-6-10-I claims with extreme LOS was answered with the national loss of every facility)."""
    seen: list[str] = []
    for e in _events(run_id):
        a = e.get("args") or {}
        if e.get("type") == "tool" and e.get("ok") and e.get("tool") == "paket_audit":  # the audit route: its scope is the set
            seen.append("paket_audit (jalur audit) cakupan " + json.dumps(a, ensure_ascii=False))
            continue
        tipe = a.get("tipe") or ("Klaim Berisiko (BPJS)" if e.get("tool") == "estimasi_kerugian_klaim" else "")
        if e.get("type") != "tool" or not e.get("ok") or str(e.get("agent") or "").startswith("validator") or not tipe:
            continue
        bits = [str(tipe)] +([f"filter {a['filter_json']}"] if a.get("filter_json") else []) + \
            ([f"{a['metrik']}({a.get('properti') or '*'})" + (f" per {a['kelompok']}" if a.get("kelompok") else "")] if a.get("metrik") else [])
        line = f"{e.get('tool')}: " + " · ".join(bits)
        if line not in seen:
            seen.append(line)
    return "; ".join(seen[:6])[:1200]


def _thread(run_id: str, depth: int = 3) -> list[dict]:
    """The questions and answers of a run and the runs it followed up, oldest first (the caller's own runs only); each
    answer with the data it was read from (`data`)."""
    out: list[dict] = []
    while run_id and depth:
        rec = check_access(run_id)
        out[:0] = [{"role": "user", "text": str(rec.get("q") or "")[:2000]},
                   {"role": "assistant", "text": str(rec.get("answer") or "")[:2000], "data": _scope(run_id)}]
        run_id, depth = rec.get("follow") or "", depth - 1
    return [m for m in out if m["text"]]


@router.post("/ask")
def ask(body: AskIn, request: Request) -> dict:
    # the order of work (the user, 2026-10-24): the fraud consultancy analyses the data first, the chat reads its results —
    # code, not the prompt, holds a question until one engagement has finished
    from aip import paket

    if not paket._last_engagement()[0]:
        raise HTTPException(409, "Belum ada hasil analisis AI Agent Swarm: buat proyek dan mulai penugasan di tab AI Agent Swarm dulu, lalu tanyakan datanya.")
    if body.follow:  # a follow-up: the thread on the server, so it holds after a reload or from an older run
        hist = _thread(body.follow)
    else:
        hist = [{"role": m.get("role"), "text": str(m.get("text", ""))[:2000]} for m in body.history[-6:] if m.get("role") in ("user", "assistant")]
    return {"run": start("ask", {"q": body.q.strip(), "history": hist, "voice": body.voice, "follow": body.follow}, request)["id"]}


class OperatorIn(BaseModel):
    q: str = Field(min_length=1, max_length=4000)
    follow: Optional[str] = None  # the turn this one follows: the conversation is that turn's thread, read here
    tab: str = Field(default="agents", max_length=20)  # the tab the user has open: the operator's context


@router.post("/operator")
def operator(body: OperatorIn, request: Request) -> dict:
    """AIP Operator (adk_runtime/operator.py): one agent with a tool per app of AIP JKN, the Agen tab's chat. It needs no
    finished engagement: a question about the apps reads them; one about the engagement says there is none yet."""
    hist = _thread(body.follow, depth=6) if body.follow else []
    return {"run": start("operator", {"q": body.q.strip(), "history": hist, "follow": body.follow, "tab": body.tab}, request)["id"]}


@router.get("/runs")
def list_runs(limit: int = 30) -> list[dict]:
    p = _principal()
    out = []
    for d in sorted(_dir().iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            rec = _live[d.name]["rec"] if d.name in _live else _settle(json.loads((d / "run.json").read_text("utf-8")))
        except (OSError, ValueError, KeyError):
            continue
        if rec.get("user_id") == p.get("id"):
            out.append({k: rec.get(k) for k in ("id", "kind", "mission_id", "status", "created_at", "finished_at", "q", "spent_usd", "follow", "ulang_laporan", "nama",
                                                "budget_usd", "proyek", "versi", "telaah_mode",
                                                "kerangka")})
        if len(out) >= limit:
            break
    return out


@router.get("/runs/{run_id}")
def get_run(run_id: str, after: int = 0) -> dict:
    rec = check_access(run_id)
    ev = _events(run_id)
    return {"run": rec, "events": ev[max(0, after):], "next": len(ev)}


@router.get("/runs/{run_id}/results/{rid}")
def get_result(run_id: str, rid: str) -> dict:
    check_access(run_id)
    if not rid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400, "bad result id")
    try:
        return json.loads((_dir() / run_id / "results" / f"{rid}.json").read_text("utf-8"))
    except OSError:
        raise HTTPException(404, "result not found") from None


@router.post("/runs/{run_id}/lanjutkan")
def continue_run(run_id: str, request: Request) -> dict:
    """Continue an interrupted engagement of the AI Agent Swarm where it stopped (its owner, or an administrator)."""
    check_access(run_id)
    return resume(run_id, internal_api(request))


@router.post("/runs/{run_id}/cancel")
def cancel(run_id: str) -> dict:
    rec = check_access(run_id)
    live = _live.get(run_id)
    if live and live["proc"].poll() is None:
        rec["status"] = "cancelled"
        live["proc"].kill()
    return {"id": run_id, "status": rec["status"]}


@router.get("/agents")
def agents() -> dict:
    from aip import domains

    return domains.catalogue()


def wait(run_id: str, timeout: float = 600) -> dict:
    """For scripts and tests: block until the run ends."""
    t0 = time.time()
    while run_id in _live and time.time() - t0 < timeout:
        time.sleep(0.5)
    return _rec(run_id)
